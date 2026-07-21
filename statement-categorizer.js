/* Valutio statement categoriser.
   Raw statement files and reviewed rows stay in memory for the current session.
   Only rules and statement preferences are persisted in the wallet. */
(function () {
  "use strict";

  var bridge = null;
  var defaults = null;
  var REVIEW = "Needs review";
  var ALL_CATEGORIES = "__all_categories__";
  var session = {
    files: [], transactions: [], selected: {}, undo: [],
    view: "summary", fromCategory: REVIEW, toCategory: "",
    accountFilter: "all", directionFilter: "all", transactionFilter: "all",
    search: "", status: "Add bank statement PDFs or CSVs, then categorise them.",
    busy: false,
  };

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (char) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char];
    });
  }
  function id() { return "sc_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function roundMoney(value) { return Math.round((Number(value) || 0) * 100) / 100; }
  function stableHash(value) {
    var hash = 2166136261;
    value = String(value || "");
    for (var i = 0; i < value.length; i++) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 16777619); }
    return (hash >>> 0).toString(36);
  }
  function titleCase(value) { return String(value || "").replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }
  function normalize(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
  function lower(value) { return normalize(value).toLowerCase(); }
  function currentContext() { return bridge ? bridge.context() : {}; }
  function prefs() {
    var p = bridge ? bridge.preferences() : {};
    if (!p.rules) p.rules = buildRules();
    if (!p.currency) p.currency = currentContext().baseCurrency || "EUR";
    return p;
  }
  function savePrefs(next) { if (bridge) bridge.savePreferences(next); }
  function rerender() { if (bridge) bridge.rerender(); }
  function toast(message) { if (bridge) bridge.toast(message); }

  function categoryAlias(category, available, kind) {
    var aliases = kind === "income" ? {} : {
      "Subscription": "Subscriptions", "Health care": "Health",
      "Transportation": "Transport", "Others": "Other",
    };
    if (available.indexOf(category) >= 0) return category;
    if (aliases[category] && available.indexOf(aliases[category]) >= 0) return aliases[category];
    var singular = category.replace(/s$/i, "");
    for (var i = 0; i < available.length; i++) {
      if (available[i].replace(/s$/i, "").toLowerCase() === singular.toLowerCase()) return available[i];
    }
    return category;
  }
  function buildRules() {
    var ctx = currentContext();
    var expenseCats = (ctx.expenseCategories || []).slice();
    var incomeCats = (ctx.incomeCategories || []).slice();
    var expense = {};
    var source = defaults && defaults.category_rules ? defaults.category_rules : {};
    Object.keys(source).forEach(function (category) {
      expense[categoryAlias(category, expenseCats, "expense")] = (expense[categoryAlias(category, expenseCats, "expense")] || []).concat(source[category]);
    });
    expenseCats.forEach(function (category) { if (!expense[category]) expense[category] = []; });
    var income = {};
    incomeCats.forEach(function (category) { income[category] = []; });
    function seedIncome(names, words) {
      var hit = incomeCats.filter(function (category) { return names.indexOf(category.toLowerCase()) >= 0; })[0];
      if (hit) income[hit] = words.slice();
    }
    seedIncome(["salary", "wages"], ["salary", "payroll", "wages", "pay deposit"]);
    seedIncome(["freelancing", "freelance"], ["invoice", "freelance", "client payment"]);
    seedIncome(["interests", "interest"], ["interest paid", "interest credit"]);
    seedIncome(["cashback", "rewards"], ["cashback", "cash back", "reward"]);
    return {
      excludeKeywords: (defaults && defaults.exclude_keywords ? defaults.exclude_keywords : []).slice(),
      refundKeywords: (defaults && defaults.refund_keywords ? defaults.refund_keywords : ["refund", "reversal", "reverted"]).slice(),
      expenseRules: expense,
      incomeRules: income,
    };
  }
  function mergeCategories(rules) {
    var ctx = currentContext();
    var changed = false;
    (ctx.expenseCategories || []).forEach(function (category) {
      if (!Object.prototype.hasOwnProperty.call(rules.expenseRules, category)) { rules.expenseRules[category] = []; changed = true; }
    });
    (ctx.incomeCategories || []).forEach(function (category) {
      if (!Object.prototype.hasOwnProperty.call(rules.incomeRules, category)) { rules.incomeRules[category] = []; changed = true; }
    });
    return changed;
  }

  function parseDate(value, numericOrder) {
    var raw = normalize(value);
    if (!raw) return "";
    var iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:T\S+|\s+\d{1,2}:\d{2}(?::\d{2})?.*)?$/);
    var compact = raw.match(/^(\d{8})$/);
    var dmy = raw.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2}|\d{4})(?:\s+.*)?$/);
    var named = raw.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
    var namedFirst = raw.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
    var year, month, day;
    if (iso) { year = +iso[1]; month = +iso[2]; day = +iso[3]; }
    else if (compact) {
      if (/^(?:19|20)/.test(compact[1])) { year = +compact[1].slice(0, 4); month = +compact[1].slice(4, 6); day = +compact[1].slice(6, 8); }
      else { day = +compact[1].slice(0, 2); month = +compact[1].slice(2, 4); year = +compact[1].slice(4, 8); }
    }
    else if (dmy) {
      var first = +dmy[1], second = +dmy[2];
      var monthFirst = numericOrder === "mdy" || (first <= 12 && second > 12);
      day = monthFirst ? second : first; month = monthFirst ? first : second;
      year = +dmy[3] < 100 ? 2000 + +dmy[3] : +dmy[3];
    }
    else if (named) {
      var names = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
      day = +named[1]; month = names.indexOf(named[2].slice(0, 3).toLowerCase()) + 1; year = +named[3];
    } else if (namedFirst) {
      var monthNames = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
      day = +namedFirst[2]; month = monthNames.indexOf(namedFirst[1].slice(0, 3).toLowerCase()) + 1; year = +namedFirst[3];
    } else return "";
    if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31)) return "";
    var check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return "";
    return year + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0");
  }
  function money(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
    var raw = String(value == null ? "" : value).trim();
    if (!raw) return NaN;
    var negative = /^\s*\(/.test(raw) || /[-\u2212]/.test(raw);
    var cleaned = raw.replace(/[A-Za-z$\u20ac\u00a3\u00a5\s()\u2212-]/g, "");
    var lastComma = cleaned.lastIndexOf(","), lastDot = cleaned.lastIndexOf(".");
    if (lastComma > lastDot) cleaned = cleaned.replace(/\./g, "").replace(",", ".");
    else cleaned = cleaned.replace(/,/g, "");
    var parsed = Number(cleaned);
    return Number.isFinite(parsed) ? (negative ? -Math.abs(parsed) : parsed) : NaN;
  }
  function csvDelimiter(text) {
    var counts = { ",": 0, ";": 0, "\t": 0 }, quoted = false;
    var line = String(text || "").split(/\r?\n/).filter(function (value) { return value.trim(); })[0] || "";
    for (var i = 0; i < line.length; i++) {
      if (line[i] === '"') quoted = !quoted;
      else if (!quoted && Object.prototype.hasOwnProperty.call(counts, line[i])) counts[line[i]]++;
    }
    return Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; })[0];
  }
  function csvRows(text) {
    var rows = [], row = [], cell = "", quoted = false;
    text = String(text || "").replace(/^\uFEFF/, "");
    var delimiter = csvDelimiter(text);
    for (var i = 0; i < text.length; i++) {
      var c = text[i], n = text[i + 1];
      if (c === '"' && quoted && n === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = !quoted;
      else if (!quoted && c === delimiter) { row.push(cell); cell = ""; }
      else if (!quoted && (c === "\n" || c === "\r")) {
        if (c === "\r" && n === "\n") i++;
        row.push(cell); if (row.some(function (v) { return String(v).trim(); })) rows.push(row); row = []; cell = "";
      } else cell += c;
    }
    row.push(cell); if (row.some(function (v) { return String(v).trim(); })) rows.push(row);
    return rows;
  }
  function findColumn(headers, names) {
    var normalized = headers.map(lower);
    for (var exact = 0; exact < names.length; exact++) {
      for (var at = 0; at < normalized.length; at++) if (normalized[at] === names[exact]) return at;
    }
    for (var n = 0; n < names.length; n++) {
      for (var i = 0; i < normalized.length; i++) if (normalized[i].indexOf(names[n]) >= 0) return i;
    }
    return -1;
  }
  function findColumns(headers, names) {
    var found = [];
    headers.forEach(function (header, index) {
      var value = lower(header);
      if (names.some(function (name) { return value === name || value.indexOf(name) >= 0; })) found.push(index);
    });
    return found;
  }
  function inferNumericDateOrder(rows, dateCol) {
    var mdy = 0, dmy = 0;
    rows.slice(0, 60).forEach(function (row) {
      var hit = normalize(row[dateCol]).match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-]\d{2,4}/);
      if (!hit) return;
      if (+hit[1] > 12) dmy++;
      if (+hit[2] > 12) mdy++;
    });
    if (mdy !== dmy) return mdy > dmy ? "mdy" : "dmy";
    return currentContext().country === "US" ? "mdy" : "dmy";
  }
  function currencyFromValue(value, fallback) {
    var raw = String(value || "").toUpperCase();
    if (/AU\$|\bAUD\b/.test(raw)) return "AUD";
    if (/\u20ac|\bEUR\b/.test(raw)) return "EUR";
    if (/\u00a3|\bGBP\b/.test(raw)) return "GBP";
    if (/\bUSD\b|US\$/.test(raw)) return "USD";
    var code = raw.match(/\b[A-Z]{3}\b/);
    return code ? code[0] : fallback;
  }
  function cleanMerchant(description) {
    var value = String(description || "")
      .replace(/Visa Purchase.*?\s/i, "").replace(/Receipt\s+\d+/i, "")
      .replace(/Date\s+\d{1,2}\/\d{1,2}\/\d{2,4}.*/i, "").replace(/Card\s+\d+/i, "")
      .replace(/\s+/g, " ").replace(/^\s*-|\s*-\s*$/g, "").trim();
    return (value || String(description || "")).slice(0, 80);
  }
  function sourceTransaction(fileEntry, data) {
    var description = normalize(data.description);
    var date = parseDate(data.date);
    var amount = roundMoney(Math.abs(Number(data.amount) || 0));
    var kind = data.kind === "income" ? "income" : "expense";
    var currency = data.currency || prefs().currency;
    var fingerprint = [date, description, amount.toFixed(2), kind, fileEntry.accountType, currency].join("|").toLowerCase();
    var legacyFingerprint = [fileEntry.name, date, description, amount.toFixed(2), kind, fileEntry.accountType].join("|").toLowerCase();
    fileEntry._statementOccurrences = fileEntry._statementOccurrences || {};
    var occurrence = fileEntry._statementOccurrences[fingerprint] || 0;
    fileEntry._statementOccurrences[fingerprint] = occurrence + 1;
    return {
      id: id(), fingerprint: fingerprint, legacyFingerprint: legacyFingerprint, occurrence: occurrence,
      date: date, month: date.slice(0, 7),
      merchant: cleanMerchant(data.merchant || description), description: description,
      amount: amount, kind: kind, accountType: fileEntry.accountType,
      sourceId: fileEntry.id, sourceFile: fileEntry.name, category: REVIEW,
      notes: "", excluded: false, currency: currency,
    };
  }
  function resetStatementOccurrences(fileEntry) { fileEntry._statementOccurrences = {}; }
  function parseStatementCsv(text, fileEntry) {
    resetStatementOccurrences(fileEntry);
    var rows = csvRows(text); if (!rows.length) return [];
    var header = rows[0], dataRows = rows.slice(1);
    var dateCol = findColumn(header, ["transaction date", "posting date", "posted date", "booking date", "completed date", "settled date", "value date", "date", "posted"]);
    var descCols = findColumns(header, ["description", "details", "merchant", "narrative", "memo", "particulars", "other party", "payee", "counterparty", "reference"]).filter(function (column) {
      return !/^account\s+(?:description|name)$/i.test(normalize(header[column]));
    });
    var debitCol = findColumn(header, ["money out", "debit", "debits", "withdrawal", "withdrawals", "paid out"]);
    var creditCol = findColumn(header, ["money in", "credit", "credits", "deposit", "deposits", "paid in"]);
    var amountCol = findColumn(header, ["amount", "transaction value", "transaction amount", "net amount", "value"]);
    var typeCol = findColumn(header, ["type", "direction", "flow", "credit/debit", "debit/credit"]);
    var currencyCol = findColumn(header, ["currency", "ccy"]);
    if (dateCol < 0 && rows[0].length >= 3 && parseDate(rows[0][0]) && Number.isFinite(money(rows[0][1]))) {
      dateCol = 0; amountCol = 1; descCols = [2]; debitCol = -1; creditCol = -1; typeCol = -1; currencyCol = -1; dataRows = rows;
    }
    if (dateCol < 0 || (debitCol < 0 && creditCol < 0 && amountCol < 0)) return [];
    var dateOrder = inferNumericDateOrder(dataRows, dateCol);
    var out = [];
    dataRows.forEach(function (row) {
      var date = parseDate(row[dateCol], dateOrder); if (!date) return;
      var description = normalize(descCols.map(function (column) { return row[column] || ""; }).filter(Boolean).join(" "));
      var debit = debitCol >= 0 ? money(row[debitCol]) : NaN;
      var credit = creditCol >= 0 ? money(row[creditCol]) : NaN;
      var amount = amountCol >= 0 ? money(row[amountCol]) : NaN;
      var kind = "expense", value = NaN;
      if (Number.isFinite(debit) && debit !== 0) { value = Math.abs(debit); kind = "expense"; }
      else if (Number.isFinite(credit) && credit !== 0) { value = Math.abs(credit); kind = "income"; }
      else if (Number.isFinite(amount) && amount !== 0) {
        value = Math.abs(amount);
        var type = typeCol >= 0 ? lower(row[typeCol]) : "";
        var amountText = String(row[amountCol] || "");
        kind = /income|credit|deposit|\bcr\b|\bin\b/.test(type) || /^(?:c|cr)$/.test(type) || /\bCR\b/i.test(amountText) ? "income"
          : (/expense|debit|withdraw|\bdr\b|\bout\b/.test(type) || /^(?:d|dr)$/.test(type) || /\bDR\b/i.test(amountText) ? "expense" : (amount < 0 ? "expense" : "income"));
      }
      if (!Number.isFinite(value) || value === 0) return;
      var currencySource = currencyCol >= 0 ? row[currencyCol] : (amountCol >= 0 ? row[amountCol] : (debitCol >= 0 ? row[debitCol] : row[creditCol]));
      out.push(sourceTransaction(fileEntry, { date: date, description: description, amount: value, kind: kind, currency: currencyFromValue(currencySource, prefs().currency) }));
    });
    return out;
  }

  function parseGenericPdfText(text, fileEntry) {
    resetStatementOccurrences(fileEntry);
    var lines = String(text || "").split(/\r?\n/).map(normalize).filter(Boolean), out = [], section = "";
    var dateStart = /^(\d{4}-\d{1,2}-\d{1,2}(?:T\S+|\s+\d{1,2}:\d{2}(?::\d{2})?)?|\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|\d{1,2}\s+[A-Za-z]+\s+\d{4}|[A-Za-z]+\s+\d{1,2},?\s+\d{4})\s+(.+)$/;
    var amountPattern = /\(?[-+]?\s*(?:(?:AUD|USD|EUR|GBP|CAD|NZD|CHF|SGD|JPY)\s*)?(?:AU\$|US\$|NZ\$|CA\$|S\$|\$|€|£|¥)?\s*\d[\d,.]*[.,]\d{2}(?:\s*(?:CR|DR))?\)?/gi;
    lines.forEach(function (line) {
      var heading = lower(line);
      if (/withdrawals|payments and other debits|money out|debit transactions|purchases/.test(heading)) section = "expense";
      else if (/deposits|credits and deposits|money in|credit transactions|payments received/.test(heading)) section = "income";
      var match = line.match(dateStart); if (!match) return;
      var date = parseDate(match[1]); if (!date) return;
      var remainder = match[2], amounts = [], amountMatch;
      amountPattern.lastIndex = 0;
      while ((amountMatch = amountPattern.exec(remainder))) amounts.push({ raw: amountMatch[0], index: amountMatch.index });
      if (!amounts.length) return;
      var posted = amounts[0].raw, value = money(posted); if (!Number.isFinite(value) || value === 0) return;
      var kind = /[-\u2212]|\bDR\b/i.test(posted) ? "expense" : (/\+|\bCR\b/i.test(posted) ? "income" : (section || "income"));
      var description = normalize(remainder.slice(0, amounts[0].index).replace(/[|:;-]+$/, ""));
      if (!description) return;
      out.push(sourceTransaction(fileEntry, { date: date, description: description, amount: Math.abs(value), kind: kind, currency: currencyFromValue(posted, prefs().currency) }));
    });
    return out;
  }
  function linesFromPdfItems(items) {
    var lines = [];
    (items || []).filter(function (item) { return item && item.str; }).forEach(function (item) {
      var y = Math.round((item.transform && item.transform[5] || 0) * 2) / 2;
      var line = lines.filter(function (candidate) { return Math.abs(candidate.y - y) <= 2; })[0];
      if (!line) { line = { y: y, items: [] }; lines.push(line); }
      line.items.push({ x: item.transform && item.transform[4] || 0, text: item.str });
    });
    return lines.sort(function (a, b) { return b.y - a.y; }).map(function (line) {
      return normalize(line.items.sort(function (a, b) { return a.x - b.x; }).map(function (item) { return item.text; }).join(" "));
    }).filter(Boolean);
  }
  async function extractPdfText(file) {
    var pdfjs = await import("./Vendor/pdfjs/pdf.min.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = "./Vendor/pdfjs/pdf.worker.min.mjs";
    var bytes = new Uint8Array(await file.arrayBuffer());
    var pdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
    var pages = [];
    for (var pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
      var page = await pdf.getPage(pageNo), content = await page.getTextContent();
      pages.push(linesFromPdfItems(content.items).join("\n"));
    }
    return pages.join("\n");
  }
  function parseIngText(text, fileEntry) {
    resetStatementOccurrences(fileEntry);
    var lines = String(text || "").split(/\r?\n/).map(normalize).filter(Boolean), out = [];
    var pattern = /^(\d{2}\/\d{2}\/\d{4})\s+(.*?)\s+(-?\d[\d,]*\.\d{2})\s+(?:(\d[\d,]*\.\d{2})\s+)?(\d[\d,]*\.\d{2})$/;
    for (var i = 0; i < lines.length; i++) {
      var match = lines[i].match(pattern), date, details, moneyOut, moneyIn, namedLayout = false;
      if (match) {
        date = parseDate(match[1]); details = match[2];
        moneyOut = money(match[3]); moneyIn = match[4] ? money(match[4]) : NaN;
      } else {
        var named = lines[i].match(/^(\d{1,2}\s+[A-Za-z]+\s+\d{4})\s+(.+)$/);
        if (!named) continue;
        namedLayout = true;
        var remainder = named[2], amounts = [], amountPattern = /-?\s*\$\s*\d[\d,]*\.\d{2}/g, amountMatch;
        while ((amountMatch = amountPattern.exec(remainder))) amounts.push({ raw: amountMatch[0], index: amountMatch.index });
        if (amounts.length < 2) continue;
        date = parseDate(named[1]); details = normalize(remainder.slice(0, amounts[0].index));
        var posted = money(amounts[0].raw);
        moneyOut = posted < 0 ? posted : NaN;
        moneyIn = posted > 0 ? posted : NaN;
      }
      if (!date || !details) continue;
      var kind, amount;
      if (Number.isFinite(moneyOut) && moneyOut < 0) { kind = "expense"; amount = Math.abs(moneyOut); }
      else if (Number.isFinite(moneyIn) && moneyIn > 0) { kind = "income"; amount = moneyIn; }
      else continue;
      var extra = [];
      for (var j = i + 1; !namedLayout && j < lines.length && !/^(?:\d{2}\/\d{2}\/\d{4}|\d{1,2}\s+[A-Za-z]+\s+\d{4})\s+/.test(lines[j]) && extra.length < 3; j++) extra.push(lines[j]);
      var description = normalize([details].concat(extra).join(" "));
      out.push(sourceTransaction(fileEntry, { date: date, description: description, amount: amount, kind: kind, currency: prefs().currency }));
    }
    return out;
  }
  function parseRevolutText(text, fileEntry) {
    resetStatementOccurrences(fileEntry);
    var lines = String(text || "").split(/\r?\n/).map(normalize).filter(Boolean), out = [];
    var pattern = /^(\d{1,2}\s+[A-Za-z]+\s+\d{4})\s+(.+?)\s+([A-Z]{0,3}\$|\u20ac|\u00a3)?(\d[\d,]*\.\d{2})\s+(?:[A-Z]{0,3}\$|\u20ac|\u00a3)?\d[\d,]*\.\d{2}$/;
    lines.forEach(function (line, index) {
      var match = line.match(pattern); if (!match) return;
      var date = parseDate(match[1]), amount = money(match[4]); if (!date || !Number.isFinite(amount)) return;
      var description = match[2], extra = [];
      for (var j = index + 1; j < Math.min(index + 4, lines.length); j++) {
        if (/^\d{1,2}\s+[A-Za-z]+\s+\d{4}\s+/.test(lines[j])) break;
        extra.push(lines[j]);
      }
      out.push(sourceTransaction(fileEntry, { date: date, description: normalize([description].concat(extra).join(" ")), amount: amount, kind: "expense", currency: currencyFromValue(match[3], prefs().currency) }));
    });
    return out;
  }
  async function readStatementText(file) {
    if (!file.arrayBuffer || typeof TextDecoder === "undefined") return file.text();
    var bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch (error) { return new TextDecoder("windows-1252").decode(bytes); }
  }
  async function parseFile(entry) {
    if (/\.csv$/i.test(entry.name) || /csv/i.test(entry.file.type || "")) return parseStatementCsv(await readStatementText(entry.file), entry);
    if (/\.pdf$/i.test(entry.name) || /pdf/i.test(entry.file.type || "")) {
      var text = await extractPdfText(entry.file);
      var specific = /Revolut/i.test(text) ? parseRevolutText(text, entry) : parseIngText(text, entry);
      var generic = parseGenericPdfText(text, entry);
      return generic.length > specific.length ? generic : specific;
    }
    return [];
  }

  function categoryFor(tx, rules) {
    var text = lower(tx.merchant + " " + tx.description);
    var table = tx.kind === "income" ? rules.incomeRules : rules.expenseRules;
    var category = REVIEW;
    Object.keys(table || {}).some(function (name) {
      if ((table[name] || []).some(function (keyword) { return keyword && text.indexOf(lower(keyword)) >= 0; })) { category = name; return true; }
      return false;
    });
    return category;
  }
  function deduplicateTransactions(transactions) {
    var seen = {}, fallbackOccurrences = {};
    return transactions.filter(function (tx) {
      var sourceKey = (tx.sourceId || tx.sourceFile || "source") + "|" + tx.fingerprint;
      var occurrence = Number.isInteger(tx.occurrence) ? tx.occurrence : (fallbackOccurrences[sourceKey] || 0);
      fallbackOccurrences[sourceKey] = occurrence + 1;
      var identity = tx.fingerprint + "|" + occurrence;
      if (seen[identity]) return false;
      seen[identity] = true; return true;
    });
  }
  function flagUnmatchedReversals(transactions) {
    var groups = {};
    transactions.forEach(function (tx) {
      if (tx.kind !== "expense" || tx.category === REVIEW) return;
      var key = [tx.month, tx.category, tx.accountType, tx.currency].join("|");
      if (!groups[key]) groups[key] = { positive: 0, reversal: 0, reversals: [] };
      if (tx.amount < 0) { groups[key].reversal += Math.abs(tx.amount); groups[key].reversals.push(tx); }
      else groups[key].positive += tx.amount;
    });
    Object.keys(groups).forEach(function (key) {
      var group = groups[key];
      if (roundMoney(group.reversal) <= roundMoney(group.positive)) return;
      group.reversals.forEach(function (tx) { tx.category = REVIEW; tx.notes = "Reversal exceeds matching expenses"; });
    });
    return transactions;
  }
  function classify(transactions, start, end) {
    var rules = prefs().rules;
    var exclude = (rules.excludeKeywords || []).map(lower).filter(Boolean);
    var refunds = (rules.refundKeywords || []).map(lower).filter(Boolean);
    var classified = transactions.filter(function (tx) { return tx.date >= start && tx.date <= end; }).filter(function (tx) {
      var text = lower(tx.merchant + " " + tx.description);
      if (exclude.some(function (word) { return text.indexOf(word) >= 0; })) { tx.excluded = true; return false; }
      if (tx.kind === "expense" && refunds.some(function (word) { return text.indexOf(word) >= 0; })) {
        tx.amount = -Math.abs(tx.amount); tx.notes = "Reversal or credit";
      }
      tx.category = categoryFor(tx, rules); return true;
    });
    return flagUnmatchedReversals(deduplicateTransactions(classified));
  }
  async function categoriseFiles() {
    if (!session.files.length) { toast("Add at least one PDF or CSV statement first."); return; }
    var startEl = document.getElementById("sc-start"), endEl = document.getElementById("sc-end");
    var start = parseDate(startEl && startEl.value), end = parseDate(endEl && endEl.value);
    if (!start || !end || start > end) { toast("Choose a valid statement date range."); return; }
    session.start = start; session.end = end;
    session.busy = true; session.status = "Reading statements..."; rerender();
    var parsed = [], failures = [];
    for (var i = 0; i < session.files.length; i++) {
      var entry = session.files[i]; entry.status = "reading";
      try {
        var rows = await parseFile(entry); entry.status = rows.length ? rows.length + " rows" : "no rows";
        if (!rows.length) failures.push(entry.name); parsed = parsed.concat(rows);
      } catch (error) { entry.status = "error"; failures.push(entry.name); }
    }
    session.transactions = classify(parsed, start, end); session.selected = {}; session.undo = [];
    session.busy = false;
    var review = session.transactions.filter(function (tx) { return tx.category === REVIEW; }).length;
    session.status = "Categorised " + session.transactions.length + " transactions" + (review ? ". " + review + " need review." : ". Ready to apply.");
    if (failures.length) session.status += " Could not read: " + failures.join(", ") + ".";
    rerender();
  }

  function dateRangeDefaults() {
    var now = new Date(), first = new Date(now.getFullYear(), now.getMonth() - 1, 1), last = new Date(now.getFullYear(), now.getMonth(), 0);
    function iso(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
    return { start: iso(first), end: iso(last) };
  }
  var initialDates = dateRangeDefaults();
  function moneyText(value, currency) {
    try { return new Intl.NumberFormat(undefined, { style: "currency", currency: currency || prefs().currency, maximumFractionDigits: 2 }).format(value); }
    catch (e) { return (currency || "") + " " + Number(value || 0).toFixed(2); }
  }
  function categoryOptions(kind, selected, includeReview) {
    var ctx = currentContext(), list = (kind === "income" ? ctx.incomeCategories : ctx.expenseCategories || []).slice();
    Object.keys(kind === "income" ? prefs().rules.incomeRules : prefs().rules.expenseRules).forEach(function (category) { if (list.indexOf(category) < 0) list.push(category); });
    if (includeReview) list.unshift(REVIEW);
    return list.map(function (category) { return '<option value="' + esc(category) + '"' + (selected === category ? " selected" : "") + '>' + esc(category) + '</option>'; }).join("");
  }
  function defaultCategoryForKind(kind) {
    var ctx = currentContext(), list = (kind === "income" ? ctx.incomeCategories : ctx.expenseCategories || []).slice();
    var rules = kind === "income" ? prefs().rules.incomeRules : prefs().rules.expenseRules;
    Object.keys(rules || {}).forEach(function (category) { if (list.indexOf(category) < 0) list.push(category); });
    return list.indexOf("Other") >= 0 ? "Other" : (list[0] || "Other");
  }
  function sourceCategoryOptions(selected) {
    var kinds = session.directionFilter === "all" ? ["expense", "income"] : [session.directionFilter];
    var options = '<option value="' + ALL_CATEGORIES + '"' + (selected === ALL_CATEGORIES ? " selected" : "") + '>All</option>' +
      '<option value="' + esc(REVIEW) + '"' + (selected === REVIEW ? " selected" : "") + '>' + esc(REVIEW) + '</option>';
    var seen = {};
    kinds.forEach(function (kind) {
      var ctx = currentContext(), list = (kind === "income" ? ctx.incomeCategories : ctx.expenseCategories || []).slice();
      Object.keys(kind === "income" ? prefs().rules.incomeRules : prefs().rules.expenseRules).forEach(function (category) { if (list.indexOf(category) < 0) list.push(category); });
      list.forEach(function (category) {
        if (seen[category]) return; seen[category] = true;
        options += '<option value="' + esc(category) + '"' + (selected === category ? " selected" : "") + '>' + esc(category) + '</option>';
      });
    });
    return options;
  }
  function filteredTransactions(scope) {
    var rows = session.transactions.slice();
    if (scope === "manual") {
      if (session.fromCategory !== ALL_CATEGORIES) rows = rows.filter(function (tx) { return tx.category === session.fromCategory; });
      if (session.accountFilter !== "all") rows = rows.filter(function (tx) { return tx.accountType.toLowerCase() === session.accountFilter; });
      if (session.directionFilter !== "all") rows = rows.filter(function (tx) { return tx.kind === session.directionFilter; });
    } else if (session.transactionFilter !== "all") rows = rows.filter(function (tx) { return tx.kind === session.transactionFilter; });
    var query = lower(session.search);
    if (query) rows = rows.filter(function (tx) { return lower([tx.date, tx.merchant, tx.description, tx.category, tx.accountType, tx.kind, tx.amount].join(" ")).indexOf(query) >= 0; });
    return rows.sort(function (a, b) { return a.date === b.date ? a.merchant.localeCompare(b.merchant) : a.date.localeCompare(b.date); });
  }
  function totals() {
    var result = { expense: 0, income: 0, personal: 0, joint: 0, review: 0 };
    session.transactions.forEach(function (tx) {
      var amount = bridge && bridge.convertCurrency ? bridge.convertCurrency(tx.amount, tx.currency, prefs().currency) : tx.amount;
      if (tx.kind === "income") result.income += amount; else result.expense += amount;
      result[tx.accountType.toLowerCase()] += tx.kind === "expense" ? amount : 0;
      if (tx.category === REVIEW) result.review++;
    });
    return result;
  }
  function summaryRows() {
    var groups = {};
    session.transactions.forEach(function (tx) {
      var key = tx.kind + "|" + tx.category + "|" + tx.currency;
      if (!groups[key]) groups[key] = { kind: tx.kind, category: tx.category, currency: tx.currency, personal: 0, joint: 0, count: 0 };
      groups[key][tx.accountType.toLowerCase()] += tx.amount; groups[key].count++;
    });
    return Object.keys(groups).map(function (key) { var row = groups[key]; row.total = row.personal + row.joint; return row; })
      .sort(function (a, b) { return a.kind === b.kind ? b.total - a.total : (a.kind === "expense" ? -1 : 1); });
  }
  function metric(label, value, cls) {
    return '<div class="sc-metric"><span>' + esc(label) + '</span><strong class="' + (cls || "") + '">' + value + '</strong></div>';
  }
  function fileRows() {
    if (!session.files.length) return '<div class="sc-file-empty">No statements added.</div>';
    return session.files.map(function (entry) {
      return '<div class="sc-file-row"><div class="sc-file-name"><strong title="' + esc(entry.name) + '">' + esc(entry.name) + '</strong><span>' + esc(entry.status || "Ready") + '</span></div>' +
        '<select data-sc-change="file-account" data-id="' + entry.id + '"><option value="Personal"' + (entry.accountType === "Personal" ? " selected" : "") + '>Personal</option><option value="Joint"' + (entry.accountType === "Joint" ? " selected" : "") + '>Joint</option></select>' +
        '<button type="button" class="btn sm ghost" data-sc-act="remove-file" data-id="' + entry.id + '" title="Remove statement">x</button></div>';
    }).join("");
  }
  function summaryTable() {
    var rows = summaryRows();
    return '<div class="table-wrap sc-table"><table><thead><tr><th>Flow</th><th>Category</th><th>Currency</th><th class="num">Personal</th><th class="num">Joint</th><th class="num">Total</th><th class="num">Rows</th></tr></thead><tbody>' +
      (rows.length ? rows.map(function (row) {
        return '<tr><td>' + titleCase(row.kind) + '</td><td><strong>' + esc(row.category) + '</strong></td><td>' + esc(row.currency) + '</td><td class="num">' + moneyText(row.personal, row.currency) + '</td><td class="num">' + moneyText(row.joint, row.currency) + '</td><td class="num">' + moneyText(row.total, row.currency) + '</td><td class="num">' + row.count + '</td></tr>';
      }).join("") : '<tr><td colspan="7" class="sc-empty-cell">Categorised totals will appear here.</td></tr>') + '</tbody></table></div>';
  }
  function transactionRows(scope) {
    var rows = filteredTransactions(scope);
    return rows.map(function (tx) {
      var selected = !!session.selected[tx.id], signed = tx.kind === "income" ? tx.amount : -tx.amount;
      return '<tr data-sc-row="' + tx.id + '" aria-selected="' + (selected ? "true" : "false") + '" class="sc-selectable-row ' + (selected ? "sc-selected" : "") + '">' +
        '<td><input type="checkbox" data-sc-select="' + tx.id + '"' + (selected ? " checked" : "") + '></td><td>' + esc(tx.date) + '</td><td><span class="sc-flow ' + tx.kind + '">' + titleCase(tx.kind) + '</span></td>' +
        '<td>' + esc(tx.accountType) + '</td><td><strong title="' + esc(tx.description) + '">' + esc(tx.merchant) + '</strong><span class="sc-cell-sub">' + esc(tx.sourceFile) + '</span></td>' +
        '<td title="' + esc(tx.description) + '">' + esc(tx.description) + '</td><td>' + esc(tx.category) + '</td><td class="num ' + (signed >= 0 ? "up" : "down") + '">' + moneyText(Math.abs(tx.amount), tx.currency) + '</td></tr>';
    }).join("");
  }
  function transactionsTable(scope) {
    var rows = transactionRows(scope);
    return '<div class="table-wrap sc-table sc-transactions"><table><thead><tr><th></th><th>Date</th><th>Flow</th><th>Account</th><th>Merchant</th><th>Description</th><th>Category</th><th class="num">Amount</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="8" class="sc-empty-cell">No transactions match this view.</td></tr>') + '</tbody></table></div>';
  }
  function manualView() {
    var kindForDestination = session.directionFilter === "income" ? "income" : "expense";
    if (!session.toCategory) session.toCategory = defaultCategoryForKind(kindForDestination);
    return '<div class="sc-manual-controls panel"><div class="field"><label>From category</label><select data-sc-change="from-category">' + sourceCategoryOptions(session.fromCategory) + '</select></div>' +
      '<div class="field"><label>Account view</label><select data-sc-change="account-filter"><option value="all">All</option><option value="personal"' + (session.accountFilter === "personal" ? " selected" : "") + '>Personal</option><option value="joint"' + (session.accountFilter === "joint" ? " selected" : "") + '>Joint</option></select></div>' +
      '<div class="field"><label>Flow</label><select data-sc-change="direction-filter"><option value="all">All</option><option value="expense"' + (session.directionFilter === "expense" ? " selected" : "") + '>Expenses</option><option value="income"' + (session.directionFilter === "income" ? " selected" : "") + '>Income</option></select></div>' +
      '<div class="field"><label>To category</label><select data-sc-change="to-category">' + categoryOptions(kindForDestination, session.toCategory, false) + '</select></div>' +
      '<button type="button" class="btn primary" data-sc-act="move-selected">Move selected</button><button type="button" class="btn" data-sc-act="undo"' + (session.undo.length ? "" : " disabled") + '>Undo</button></div>' +
      '<div class="sc-bulkbar"><span><strong id="sc-selected-count">' + Object.keys(session.selected).length + '</strong> selected</span><button type="button" class="btn sm" data-sc-act="set-account" data-value="Personal">Set Personal</button><button type="button" class="btn sm" data-sc-act="set-account" data-value="Joint">Set Joint</button><button type="button" class="btn sm" data-sc-act="set-kind" data-value="expense">Set Expense</button><button type="button" class="btn sm" data-sc-act="set-kind" data-value="income">Set Income</button><button type="button" class="btn sm" data-sc-act="delete-selected">Delete</button></div>' +
      '<div class="sc-table-toolbar"><input id="sc-search" type="search" placeholder="Search transactions" value="' + esc(session.search) + '"><span>Select rows, choose a destination category, then use Move selected.</span></div>' + transactionsTable("manual");
  }
  function allView() {
    return '<div class="sc-table-toolbar"><div class="range-chips"><button type="button" class="rc-btn' + (session.transactionFilter === "all" ? " on" : "") + '" data-sc-act="transaction-filter" data-value="all">All</button><button type="button" class="rc-btn' + (session.transactionFilter === "expense" ? " on" : "") + '" data-sc-act="transaction-filter" data-value="expense">Expenses</button><button type="button" class="rc-btn' + (session.transactionFilter === "income" ? " on" : "") + '" data-sc-act="transaction-filter" data-value="income">Income</button></div><input id="sc-search" type="search" placeholder="Search transactions" value="' + esc(session.search) + '"></div>' + transactionsTable("all");
  }
  function render() {
    if (!defaults) return '<div class="panel sc-loading"><h2>Statement Categoriser</h2><p class="hint">Loading categorisation rules...</p></div>';
    var p = prefs(); if (mergeCategories(p.rules)) savePrefs(p);
    var t = totals();
    var body = session.view === "manual" ? manualView() : (session.view === "transactions" ? allView() : summaryTable());
    return '<div class="sc-workspace">' +
      '<div class="panel sc-import"><div class="sc-import-head"><div><h2>Statement Categoriser</h2><p class="hint">Import bank statements, review every match, then apply the clean result to Cash Flow.</p></div><div class="sc-actions"><button type="button" class="btn" data-sc-act="edit-rules">Edit rules</button><button type="button" class="btn" data-sc-act="export-simple">Simple Excel</button><button type="button" class="btn" data-sc-act="export-full">Full Excel</button><button type="button" class="btn primary" data-sc-act="apply">Apply to Cash Flow</button></div></div>' +
      '<div class="sc-import-grid"><div class="sc-files"><div class="sc-field-label">Statement files</div>' + fileRows() + '</div><div class="field"><label>From</label><input id="sc-start" type="date" value="' + esc(session.start || initialDates.start) + '"></div><div class="field"><label>To</label><input id="sc-end" type="date" value="' + esc(session.end || initialDates.end) + '"></div><div class="field"><label>Statement currency</label><select data-sc-change="currency">' + (currentContext().currencies || []).map(function (currency) { return '<option value="' + esc(currency) + '"' + (p.currency === currency ? " selected" : "") + '>' + esc(currency) + '</option>'; }).join("") + '</select></div><div class="sc-import-buttons"><button type="button" class="btn" data-sc-act="last-month">Last month</button><button type="button" class="btn" data-sc-act="add-files">Add statements</button><button type="button" class="btn primary" data-sc-act="categorise"' + (session.busy ? " disabled" : "") + '>' + (session.busy ? "Reading..." : "Categorise") + '</button></div></div></div>' +
      '<div class="sc-metrics">' + metric("Expenses", moneyText(t.expense, p.currency), "down") + metric("Income", moneyText(t.income, p.currency), "up") + metric("Personal spend", moneyText(t.personal, p.currency)) + metric("Joint spend", moneyText(t.joint, p.currency)) + metric("Needs review", String(t.review), t.review ? "down" : "") + '</div>' +
      '<div class="sc-viewbar"><div class="cf-tabs"><button type="button" class="cf-tab' + (session.view === "summary" ? " on" : "") + '" data-sc-act="set-view" data-value="summary">Summary</button><button type="button" class="cf-tab' + (session.view === "manual" ? " on" : "") + '" data-sc-act="set-view" data-value="manual">Manual categoriser</button><button type="button" class="cf-tab' + (session.view === "transactions" ? " on" : "") + '" data-sc-act="set-view" data-value="transactions">All transactions</button></div><span>' + esc(session.status) + '</span></div>' + body + '</div>';
  }

  function pickFiles() {
    var input = document.createElement("input"); input.type = "file"; input.multiple = true; input.accept = ".pdf,.csv,application/pdf,text/csv";
    input.onchange = function () {
      Array.prototype.forEach.call(input.files || [], function (file) {
        var name = file.name || "statement", account = /joint/i.test(name) ? "Joint" : "Personal";
        session.files.push({ id: id(), file: file, name: name, accountType: account, status: "Ready" });
      });
      rerender();
    };
    input.click();
  }
  function selectedTransactions() { return session.transactions.filter(function (tx) { return session.selected[tx.id]; }); }
  function snapshotForUndo(label) { session.undo.push({ label: label, transactions: JSON.stringify(session.transactions) }); if (session.undo.length > 20) session.undo.shift(); }
  function applyToSelected(mutator, label) {
    var rows = selectedTransactions(); if (!rows.length) { toast("Select at least one transaction."); return; }
    snapshotForUndo(label); rows.forEach(mutator); session.selected = {}; rerender();
  }
  function setKindForSelected(kind) {
    applyToSelected(function (tx) { tx.kind = kind; tx.category = defaultCategoryForKind(kind); }, "Change flow");
  }
  function toggleSelected(id, row) {
    if (session.selected[id]) delete session.selected[id]; else session.selected[id] = true;
    if (row) {
      var selected = !!session.selected[id];
      row.classList.toggle("sc-selected", selected);
      row.setAttribute("aria-selected", selected ? "true" : "false");
      var checkbox = row.querySelector("[data-sc-select]");
      if (checkbox) checkbox.checked = selected;
    }
    updateSelectedCount();
  }
  function moveSelected(category) {
    var rows = selectedTransactions();
    if (!rows.length) { toast("Select at least one transaction."); return; }
    var kinds = rows.map(function (tx) { return tx.kind; }).filter(function (kind, index, all) { return all.indexOf(kind) === index; });
    if (kinds.length !== 1) { toast("Move expenses and income separately."); return; }
    var kind = kinds[0], ctx = currentContext();
    var allowed = (kind === "income" ? ctx.incomeCategories : ctx.expenseCategories || []).slice();
    Object.keys(kind === "income" ? prefs().rules.incomeRules : prefs().rules.expenseRules).forEach(function (name) { if (allowed.indexOf(name) < 0) allowed.push(name); });
    if (allowed.indexOf(category) < 0) { toast("Choose the matching Flow before moving these transactions."); return; }
    applyToSelected(function (tx) { tx.category = category; }, "Move category");
  }
  function openRules() {
    var p = prefs(), rules = p.rules;
    function rowsFor(kind, table) {
      return Object.keys(table).map(function (category) { return '<div class="sc-rule-row"><label>' + esc(category) + '</label><textarea data-sc-rule="' + kind + '" data-category="' + esc(category) + '" rows="2">' + esc((table[category] || []).join(", ")) + '</textarea></div>'; }).join("");
    }
    bridge.openModal({
      title: "Categorisation rules", sub: "Keywords are matched case-insensitively against merchant and statement description.", wide: true,
      body: '<div class="sc-rule-global"><div class="field"><label>Exclude transfers and non-transactions</label><textarea id="sc-rule-exclude" rows="3">' + esc((rules.excludeKeywords || []).join(", ")) + '</textarea></div><div class="field"><label>Reversal keywords</label><textarea id="sc-rule-refund" rows="2">' + esc((rules.refundKeywords || []).join(", ")) + '</textarea></div></div><div class="sc-rule-columns"><div><h4>Expense categories</h4>' + rowsFor("expense", rules.expenseRules) + '</div><div><h4>Income categories</h4>' + rowsFor("income", rules.incomeRules) + '</div></div>',
      submitLabel: "Save rules", onSubmit: function () {
        function words(value) { return String(value || "").split(/[,\n]/).map(normalize).filter(Boolean); }
        rules.excludeKeywords = words(document.getElementById("sc-rule-exclude").value);
        rules.refundKeywords = words(document.getElementById("sc-rule-refund").value);
        Array.prototype.forEach.call(document.querySelectorAll("[data-sc-rule]"), function (field) {
          var table = field.getAttribute("data-sc-rule") === "income" ? rules.incomeRules : rules.expenseRules;
          table[field.getAttribute("data-category")] = words(field.value);
        });
        p.rules = rules; savePrefs(p); toast("Categorisation rules saved");
      },
    });
  }
  function worksheetRows(mode) {
    var byAccount = function (account) { return session.transactions.filter(function (tx) { return tx.accountType === account; }).sort(function (a, b) { return a.category.localeCompare(b.category) || a.date.localeCompare(b.date); }); };
    var summary = [["Category", "Flow", "Currency", "Personal", "Joint", "Total"]].concat(summaryRows().map(function (row) { return [row.category, titleCase(row.kind), row.currency, row.personal, row.joint, row.total]; }));
    if (mode === "simple") return { Summary: summary };
    function detail(account) { return [["Date", "Flow", "Account", "Merchant", "Description", "Category", "Amount", "Currency", "Notes", "Source File"]].concat(byAccount(account).map(function (tx) { return [tx.date, titleCase(tx.kind), tx.accountType, tx.merchant, tx.description, tx.category, tx.amount, tx.currency, tx.notes, tx.sourceFile]; })); }
    var ctx = currentContext(), reconciliation = [["Month", "Flow", "Account", "Category", "Currency", "Categorised Total", "Cash Flow Total", "Difference"]], recGroups = {};
    session.transactions.forEach(function (tx) {
      var key = [tx.month, tx.kind, tx.accountType, tx.category, tx.currency].join("|");
      if (!recGroups[key]) recGroups[key] = { month: tx.month, kind: tx.kind, accountType: tx.accountType, category: tx.category, currency: tx.currency, amount: 0 };
      recGroups[key].amount += tx.amount;
    });
    Object.keys(recGroups).sort().forEach(function (key) {
      var row = recGroups[key];
      var existing = (ctx.cashFlowRows || []).filter(function (item) {
        return item.month === row.month && item.kind === row.kind && item.accountType === row.accountType && item.category === row.category && item.currency === row.currency;
      }).reduce(function (sum, item) { return sum + item.amount; }, 0);
      reconciliation.push([row.month, titleCase(row.kind), row.accountType, row.category, row.currency, row.amount, existing, row.amount - existing]);
    });
    var ruleRows = [["Flow", "Category", "Keywords"]];
    [["Expense", prefs().rules.expenseRules], ["Income", prefs().rules.incomeRules]].forEach(function (pair) { Object.keys(pair[1]).forEach(function (category) { ruleRows.push([pair[0], category, pair[1][category].join(", ")]); }); });
    return { "Personal Transactions": detail("Personal"), "Joint Transactions": detail("Joint"), Summary: summary, Reconciliation: reconciliation, Rules: ruleRows };
  }
  async function exportExcel(mode) {
    if (!session.transactions.length) { toast("Categorise statements before exporting."); return; }
    try {
      var XLSX = await bridge.loadSheetJS(), wb = XLSX.utils.book_new(), sheets = worksheetRows(mode);
      Object.keys(sheets).forEach(function (name) {
        var ws = XLSX.utils.aoa_to_sheet(sheets[name]); ws["!cols"] = sheets[name][0].map(function (_, i) { return { wch: i === 4 ? 52 : (i === 3 || i === 5 ? 26 : 16) }; });
        XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
      });
      XLSX.writeFile(wb, "Valutio_Statement_Report_" + new Date().toISOString().slice(0, 10) + ".xlsx");
    } catch (error) { toast("The Excel report could not be created."); }
  }
  function buildApplyRows() {
    var groups = {}, occurrences = {}, seenTransactions = {};
    session.transactions.forEach(function (tx) {
      if (tx.category === REVIEW) return;
      var key = [tx.kind, tx.month, tx.category, tx.accountType, tx.currency].join("|");
      var occurrence = Number.isInteger(tx.occurrence) ? tx.occurrence : (occurrences[tx.fingerprint] || 0);
      occurrences[tx.fingerprint] = Math.max(occurrences[tx.fingerprint] || 0, occurrence + 1);
      var identity = tx.fingerprint + "|" + occurrence;
      if (seenTransactions[identity]) return;
      seenTransactions[identity] = true;
      if (!groups[key]) groups[key] = [];
      groups[key].push({ tx: tx, occurrence: occurrence });
    });
    var rows = [];
    Object.keys(groups).forEach(function (key) {
      var entries = groups[key];
      var positives = entries.filter(function (entry) { return entry.tx.amount > 0; }).map(function (entry) {
        return { entry: entry, amount: entry.tx.amount, legacyRefundFingerprints: [] };
      });
      entries.filter(function (entry) { return entry.tx.amount < 0; }).forEach(function (refund) {
        var remaining = Math.abs(refund.tx.amount);
        var candidates = positives.filter(function (item) { return item.amount > 0 && item.entry.tx.date <= refund.tx.date; }).reverse()
          .concat(positives.filter(function (item) { return item.amount > 0 && item.entry.tx.date > refund.tx.date; }).reverse());
        candidates.some(function (item) {
          var used = Math.min(item.amount, remaining);
          if (used <= 0) return false;
          item.amount = roundMoney(item.amount - used);
          remaining = roundMoney(remaining - used);
          item.legacyRefundFingerprints.push(refund.tx.legacyFingerprint || refund.tx.fingerprint);
          return remaining <= 0;
        });
      });
      positives.forEach(function (item) {
        if (item.amount <= 0) return;
        var tx = item.entry.tx;
        var legacySeed = tx.legacyFingerprint || tx.fingerprint;
        rows.push({
          kind: tx.kind, month: tx.month, category: tx.category, accountType: tx.accountType,
          currency: tx.currency, amount: roundMoney(item.amount),
          note: tx.description || tx.merchant || "Statement categoriser",
          sourceKey: "statement:" + stableHash([tx.fingerprint, item.entry.occurrence].join("||")),
          legacySourceKey: "statement:" + stableHash([legacySeed, item.entry.occurrence].concat(item.legacyRefundFingerprints.sort()).join("||")),
          legacyBaseSourceKey: "statement:" + stableHash([legacySeed, item.entry.occurrence].join("||")),
        });
      });
    });
    var seen = {};
    return rows.filter(function (row) { if (seen[row.sourceKey]) return false; seen[row.sourceKey] = true; return true; });
  }
  function previewApply() {
    if (!session.transactions.length) { toast("Categorise statements before applying them."); return; }
    var review = session.transactions.filter(function (tx) { return tx.category === REVIEW; }).length;
    if (review) { toast("Review or categorise every transaction before applying it."); session.view = "manual"; session.fromCategory = REVIEW; rerender(); return; }
    var rows = buildApplyRows(); if (!rows.length) { toast("There are no positive totals to apply."); return; }
    var expense = rows.filter(function (row) { return row.kind === "expense"; }), income = rows.filter(function (row) { return row.kind === "income"; });
    function previewRow(row) { return '<tr><td>' + esc(row.month) + '</td><td>' + titleCase(row.kind) + '</td><td>' + esc(row.category) + '</td><td>' + esc(row.accountType) + '</td><td class="num">' + moneyText(row.amount, row.currency) + '</td></tr>'; }
    var sample = rows.slice(0, 10).map(previewRow).join(""), remaining = rows.slice(10).map(previewRow).join("");
    var extra = rows.length > 10
      ? '<tbody id="sc-apply-more-rows" hidden>' + remaining + '</tbody><tfoot><tr><td colspan="5" class="sc-apply-more-cell"><button type="button" class="btn sm ghost sc-apply-more" data-sc-preview-more="1" data-more-count="' + (rows.length - 10) + '" aria-expanded="false">' + (rows.length - 10) + ' more rows</button></td></tr></tfoot>'
      : '';
    bridge.openModal({
      title: "Apply to Cash Flow?", sub: "Reviewed statement transactions will be appended individually. Existing wallet sections stay unchanged.", wide: true,
      body: '<div class="callout"><div><strong>' + expense.length + ' expense rows and ' + income.length + ' income rows</strong><br>Exact matches already applied from this session will be skipped.</div></div><div class="table-wrap sc-apply-preview" style="max-height:320px;overflow:auto;margin-top:14px"><table><thead><tr><th>Month</th><th>Flow</th><th>Category</th><th>Account</th><th class="num">Amount</th></tr></thead><tbody>' + sample + '</tbody>' + extra + '</table></div>',
      submitLabel: "Apply to Cash Flow", onSubmit: function () {
        var result = bridge.applyRows(rows); session.status = "Applied " + result.added + " rows to Cash Flow" + (result.skipped ? ". Skipped " + result.skipped + " duplicates." : ".");
        if (result.changed) session.status += " " + result.changed + " previously applied rows have changed amounts; review them in Cash Flow.";
        toast(session.status); rerender();
      },
    });
  }
  function handleClick(element) {
    var action = element.getAttribute("data-sc-act"); if (!action) return;
    if (action === "add-files") pickFiles();
    else if (action === "remove-file") { var sourceId = element.getAttribute("data-id"); session.files = session.files.filter(function (file) { return file.id !== sourceId; }); session.transactions = session.transactions.filter(function (tx) { return tx.sourceId !== sourceId; }); rerender(); }
    else if (action === "last-month") { var range = dateRangeDefaults(); session.start = range.start; session.end = range.end; rerender(); }
    else if (action === "categorise") categoriseFiles();
    else if (action === "set-view") { session.view = element.getAttribute("data-value"); rerender(); }
    else if (action === "transaction-filter") { session.transactionFilter = element.getAttribute("data-value"); rerender(); }
    else if (action === "move-selected") moveSelected(session.toCategory);
    else if (action === "set-account") applyToSelected(function (tx) { tx.accountType = element.getAttribute("data-value"); }, "Change account");
    else if (action === "set-kind") setKindForSelected(element.getAttribute("data-value"));
    else if (action === "delete-selected") {
      applyToSelected(function (tx) { tx._delete = true; }, "Delete rows");
      session.transactions = session.transactions.filter(function (tx) { return !tx._delete; });
      rerender();
    }
    else if (action === "undo") { var previous = session.undo.pop(); if (previous) { session.transactions = JSON.parse(previous.transactions); session.selected = {}; rerender(); } }
    else if (action === "edit-rules") openRules();
    else if (action === "export-simple") exportExcel("simple");
    else if (action === "export-full") exportExcel("full");
    else if (action === "apply") previewApply();
  }
  function handleChange(element) {
    var change = element.getAttribute("data-sc-change");
    if (change === "file-account") {
      var entry = session.files.filter(function (file) { return file.id === element.getAttribute("data-id"); })[0];
      if (entry) { entry.accountType = element.value; session.transactions.filter(function (tx) { return tx.sourceId === entry.id; }).forEach(function (tx) { tx.accountType = entry.accountType; }); }
    } else if (change === "currency") { var p = prefs(); p.currency = element.value; savePrefs(p); }
    else if (change === "from-category") session.fromCategory = element.value;
    else if (change === "to-category") session.toCategory = element.value;
    else if (change === "account-filter") session.accountFilter = element.value;
    else if (change === "direction-filter") { session.directionFilter = element.value; session.fromCategory = ALL_CATEGORIES; session.toCategory = ""; }
    else if (change === "start") session.start = element.value;
    else if (change === "end") session.end = element.value;
    rerender();
  }
  function updateSelectedCount() { var element = document.getElementById("sc-selected-count"); if (element) element.textContent = Object.keys(session.selected).length; }
  function filterVisibleRows(value) {
    session.search = value; var query = lower(value), table = document.querySelector(".sc-transactions tbody"); if (!table) return;
    Array.prototype.forEach.call(table.querySelectorAll("tr[data-sc-row]"), function (row) { row.style.display = !query || lower(row.textContent).indexOf(query) >= 0 ? "" : "none"; });
  }

  document.addEventListener("click", function (event) {
    var more = event.target.closest("[data-sc-preview-more]");
    if (more) {
      var extra = document.getElementById("sc-apply-more-rows");
      if (extra) {
        var expanded = extra.hidden;
        extra.hidden = !expanded;
        more.setAttribute("aria-expanded", expanded ? "true" : "false");
        var count = more.getAttribute("data-more-count");
        var italian = document.documentElement && document.documentElement.lang === "it";
        more.textContent = expanded ? (italian ? "Mostra meno righe" : "Show fewer rows") : (italian ? count + " righe in piu" : count + " more rows");
      }
      return;
    }
    var row = event.target.closest("tr[data-sc-row]");
    if (row && !event.target.closest("input,button,select,textarea,a,label")) { toggleSelected(row.getAttribute("data-sc-row"), row); return; }
    var element = event.target.closest("[data-sc-act]"); if (element) handleClick(element);
  });
  document.addEventListener("change", function (event) {
    var element = event.target;
    if (element.matches("[data-sc-select]")) { var row = element.closest("tr"); var selected = element.checked; if (selected) session.selected[element.getAttribute("data-sc-select")] = true; else delete session.selected[element.getAttribute("data-sc-select")]; if (row) { row.classList.toggle("sc-selected", selected); row.setAttribute("aria-selected", selected ? "true" : "false"); } updateSelectedCount(); return; }
    if (element.matches("[data-sc-change]")) handleChange(element);
    if (element.id === "sc-start") { session.start = element.value; }
    if (element.id === "sc-end") { session.end = element.value; }
  });
  document.addEventListener("input", function (event) { if (event.target.id === "sc-search") filterVisibleRows(event.target.value); });

  async function connect(nextBridge) {
    bridge = nextBridge;
    try {
      var response = await fetch("./Rules/statement-categorizer-defaults.json");
      if (!response.ok) throw new Error("rules unavailable"); defaults = await response.json();
    } catch (error) { defaults = { exclude_keywords: [], refund_keywords: ["refund", "reversal"], category_rules: {} }; }
    var p = bridge.preferences(); if (!p.rules) { p.rules = buildRules(); bridge.savePreferences(p); }
    rerender();
  }

  window.ValutioStatementCategorizer = {
    connect: connect, render: render,
    test: {
      parseDate: parseDate, money: money, csvRows: csvRows, parseStatementCsv: parseStatementCsv,
      parseIngText: parseIngText, parseGenericPdfText: parseGenericPdfText, parseFile: parseFile, classify: classify, buildApplyRows: buildApplyRows,
      deduplicateTransactions: deduplicateTransactions,
      flagUnmatchedReversals: flagUnmatchedReversals,
      totals: totals, summaryRows: summaryRows, worksheetRows: worksheetRows, filteredTransactions: filteredTransactions,
      sourceCategoryOptions: sourceCategoryOptions, allCategoriesValue: ALL_CATEGORIES,
      setTransactions: function (rows) { session.transactions = rows; },
      setSelected: function (ids) { session.selected = {}; ids.forEach(function (txId) { session.selected[txId] = true; }); },
      defaultCategoryForKind: defaultCategoryForKind,
      setKindForSelected: setKindForSelected,
      toggleSelected: function (txId) { toggleSelected(txId); },
      moveSelected: moveSelected,
      setManualFilters: function (values) {
        if (values.fromCategory != null) session.fromCategory = values.fromCategory;
        if (values.accountFilter != null) session.accountFilter = values.accountFilter;
        if (values.directionFilter != null) session.directionFilter = values.directionFilter;
        if (values.search != null) session.search = values.search;
      },
      getTransactions: function () { return session.transactions; },
    },
  };
})();
