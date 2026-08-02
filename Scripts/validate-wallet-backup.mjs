import fs from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node Scripts/validate-wallet-backup.mjs path/to/wallet-backup.json");
  process.exit(2);
}

const text = fs.readFileSync(file, "utf8");
const db = JSON.parse(text);
const errors = [];
const warnings = [];
const seenCurrencies = new Set();
const referencedCurrencies = new Map();
const drpLinks = new Map();

const n = (v) => {
  const x = Number.parseFloat(v);
  return Number.isFinite(x) ? x : 0;
};
const validMonth = (v) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(v || ""));
const validDate = (v) => {
  const m = /^(\d{4})-(0[1-9]|1[0-2])-([0-2][0-9]|3[0-1])$/.exec(String(v || ""));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
};
const decimalNumber = (v) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const value = String(v == null ? "" : v).trim();
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const decimalParts = (v) => {
  const value = String(v == null ? "0" : v).trim();
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(value);
  if (!match || !(match[2] || match[3])) throw new Error("Invalid decimal value");
  const fraction = match[3] || "";
  const exponent = Number.parseInt(match[4] || "0", 10);
  let digits = `${match[2] || "0"}${fraction}`.replace(/^0+(?=\d)/, "") || "0";
  let scale = fraction.length - exponent;
  if (scale < 0) { digits += "0".repeat(-scale); scale = 0; }
  return { value: BigInt(`${match[1] === "-" ? "-" : ""}${digits}`), scale };
};
const decimalAdd = (left, right, subtract = false) => {
  const a = decimalParts(left), b = decimalParts(right), scale = Math.max(a.scale, b.scale);
  const av = a.value * (10n ** BigInt(scale - a.scale));
  const bv = b.value * (10n ** BigInt(scale - b.scale));
  let value = av + (subtract ? -bv : bv);
  const negative = value < 0n;
  if (negative) value = -value;
  let result = value.toString().padStart(scale + 1, "0");
  if (scale) result = `${result.slice(0, -scale)}.${result.slice(-scale).replace(/0+$/, "")}`.replace(/\.$/, "");
  return `${negative ? "-" : ""}${result}`;
};
const drpAmountMatches = (shares, price, amount) => {
  const shareValue = decimalNumber(shares), priceValue = decimalNumber(price), amountValue = decimalNumber(amount);
  if (shareValue == null || priceValue == null || amountValue == null) return false;
  const tolerance = Math.max(1e-8, Math.abs(amountValue) * 1e-10);
  return Math.abs(shareValue * priceValue - amountValue) <= tolerance;
};
const fyStartMonth = (code) => code === "AU" ? 7 : (code === "NZ" || code === "GB") ? 4 : code === "ZA" ? 3 : 1;
const iso = (d) => d.toISOString().slice(0, 10);
function fyDateWindow(label, code) {
  const m = /^(\d{4})/.exec(String(label || ""));
  const startYear = m ? +m[1] : new Date().getFullYear();
  const startMonth = fyStartMonth(code);
  if (startMonth === 1) return { start: `${startYear + 1}-01-01`, end: `${startYear + 1}-12-31` };
  if (code === "GB") return { start: `${startYear}-04-06`, end: `${startYear + 1}-04-05` };
  return {
    start: iso(new Date(Date.UTC(startYear, startMonth - 1, 1))),
    end: iso(new Date(Date.UTC(startYear + 1, startMonth - 1, 0))),
  };
}

function list(name) {
  const value = db[name];
  if (!Array.isArray(value)) {
    errors.push(`${name} must be an array`);
    return [];
  }
  return value;
}

function checkIds(rows, label) {
  const seen = new Set();
  rows.forEach((row, i) => {
    if (!row || typeof row !== "object") {
      errors.push(`${label} row ${i + 1} is not an object`);
      return;
    }
    if (!row.id) errors.push(`${label} row ${i + 1} is missing id`);
    if (row.id && seen.has(row.id)) errors.push(`${label} id duplicated: ${row.id}`);
    if (row.id) seen.add(row.id);
  });
}

function checkMoneyRows(rows, label) {
  checkIds(rows, label);
  rows.forEach((row, i) => {
    if (!validMonth(row.month)) errors.push(`${label} row ${i + 1} has invalid month`);
    if (!(decimalNumber(row.amount) > 0)) errors.push(`${label} row ${i + 1} amount must be greater than zero`);
    if (!row.currency) errors.push(`${label} row ${i + 1} has no currency`);
    const share = row.share == null ? null : decimalNumber(row.share);
    if (row.share != null && (share == null || share < 0 || share > 100)) errors.push(`${label} row ${i + 1} share must be 0-100`);
  });
}

function checkNonNegative(value, label, allowZero = true) {
  const parsed = decimalNumber(value);
  if (parsed == null || (allowZero ? parsed < 0 : parsed <= 0)) {
    errors.push(`${label} must be ${allowZero ? "zero or higher" : "greater than zero"}`);
  }
  return parsed;
}

function checkPersistedNumericRows() {
  const accounts = list("accounts");
  checkIds(accounts, "account");
  accounts.forEach((account, i) => {
    checkNonNegative(account.balance, `account row ${i + 1} balance`);
    const share = account.share == null ? null : decimalNumber(account.share);
    if (account.share != null && (share == null || share < 0 || share > 100)) errors.push(`account row ${i + 1} share must be 0-100`);
  });

  const assets = list("physicalAssets");
  checkIds(assets, "asset");
  assets.forEach((asset, i) => checkNonNegative(asset.value, `asset row ${i + 1} value`));

  const goals = list("goals");
  checkIds(goals, "goal");
  goals.forEach((goal, i) => {
    checkNonNegative(goal.cost, `goal row ${i + 1} target cost`, false);
    checkNonNegative(goal.currentSavings == null ? 0 : goal.currentSavings, `goal row ${i + 1} saved amount`);
  });

  const recurring = list("recurring");
  checkIds(recurring, "recurring");
  recurring.forEach((rule, i) => {
    checkNonNegative(rule.amount, `recurring row ${i + 1} amount`, false);
    if (rule.kind !== "income" && rule.kind !== "expense") errors.push(`recurring row ${i + 1} kind must be income or expense`);
    if (!validMonth(rule.since)) errors.push(`recurring row ${i + 1} has invalid start month`);
    const share = rule.share == null ? null : decimalNumber(rule.share);
    if (rule.share != null && (share == null || share < 0 || share > 100)) errors.push(`recurring row ${i + 1} share must be 0-100`);
  });

  const debts = list("debts");
  checkIds(debts, "debt");
  debts.forEach((debt, i) => {
    checkNonNegative(debt.balance, `debt row ${i + 1} balance`);
    checkNonNegative(debt.apr == null || debt.apr === "" ? 0 : debt.apr, `debt row ${i + 1} APR`);
    checkNonNegative(debt.payment == null || debt.payment === "" ? 0 : debt.payment, `debt row ${i + 1} payment`);
  });
}

function collectDrpRow(kind, row, holdingKey, label) {
  const origin = String(row?.origin || "").trim();
  const hasLinkField = row && Object.prototype.hasOwnProperty.call(row, "linkId");
  if (origin !== "drp" && !hasLinkField) return;
  const linkId = String(row?.linkId || "").trim();
  if (origin !== "drp") errors.push(`${label} has a DRP link but origin is not drp`);
  if (!linkId) {
    errors.push(`${label} has no DRP link id`);
    return;
  }
  if (!drpLinks.has(linkId)) drpLinks.set(linkId, { transactions: [], dividends: [] });
  drpLinks.get(linkId)[kind].push({ row, holdingKey, label });
}

function checkDrpLinks() {
  drpLinks.forEach((link, linkId) => {
    if (link.transactions.length !== 1 || link.dividends.length !== 1) {
      errors.push(`DRP link ${linkId} needs exactly one buy transaction and one dividend`);
      return;
    }
    const transactionRef = link.transactions[0], dividendRef = link.dividends[0];
    const transaction = transactionRef.row, dividend = dividendRef.row;
    if (transactionRef.holdingKey !== dividendRef.holdingKey) errors.push(`DRP link ${linkId} crosses holdings`);
    if (String(transaction.origin || "").trim() !== "drp" || String(dividend.origin || "").trim() !== "drp") {
      errors.push(`DRP link ${linkId} must mark both records with origin drp`);
    }
    if (transaction.type !== "buy") errors.push(`DRP link ${linkId} transaction must be a buy`);
    const shares = decimalNumber(transaction.shares), price = decimalNumber(transaction.price);
    const fees = decimalNumber(transaction.fees), amount = decimalNumber(dividend.amount);
    if (!(shares > 0)) errors.push(`DRP link ${linkId} transaction shares must be greater than zero`);
    if (!(price > 0)) errors.push(`DRP link ${linkId} transaction price must be greater than zero`);
    if (fees !== 0) errors.push(`DRP link ${linkId} transaction fees must be zero`);
    if (!(amount > 0)) errors.push(`DRP link ${linkId} dividend amount must be greater than zero`);
    if (!validDate(transaction.date)) errors.push(`DRP link ${linkId} transaction needs an exact date`);
    if (!validDate(dividend.date)) errors.push(`DRP link ${linkId} dividend needs an exact date`);
    if (transaction.date !== dividend.date || transaction.month !== dividend.month) errors.push(`DRP link ${linkId} records must share the same date and month`);
    if (!drpAmountMatches(transaction.shares, transaction.price, dividend.amount)) {
      errors.push(`DRP link ${linkId} transaction value must match its dividend amount`);
    }
  });
}

function checkHolding(holding, index) {
  const label = holding.name || holding.ticker || `holding ${index + 1}`;
  const holdingKey = String(holding.id || `holding-index-${index}`);
  const currentPrice = decimalNumber(holding.price == null || holding.price === "" ? 0 : holding.price);
  if (currentPrice == null) errors.push(`${label} current price must be a valid finite number`);
  else if (currentPrice < 0) errors.push(`${label} has negative current price`);
  const txns = Array.isArray(holding.transactions) ? holding.transactions : [];
  checkIds(txns, `${label} transaction`);
  let shares = "0";
  let ledgerCanReplay = true;
  txns.slice().sort((a, b) => String(a.month).localeCompare(String(b.month)) || (a.date && b.date ? String(a.date).localeCompare(String(b.date)) : 0) || n(a.sequence) - n(b.sequence)).forEach((txn, i) => {
    if (!validMonth(txn.month)) errors.push(`${label} transaction ${i + 1} has invalid month`);
    if (txn.date != null && !validDate(txn.date)) errors.push(`${label} transaction ${i + 1} has invalid date`);
    if (validDate(txn.date) && txn.date.slice(0, 7) !== txn.month) errors.push(`${label} transaction ${i + 1} date and month disagree`);
    if (n(db.version) >= 2 && !(n(txn.sequence) > 0)) errors.push(`${label} transaction ${i + 1} has no replay sequence`);
    if (txn.type !== "buy" && txn.type !== "sell") { errors.push(`${label} transaction ${i + 1} type must be buy or sell`); ledgerCanReplay = false; }
    const shareAmount = decimalNumber(txn.shares), price = decimalNumber(txn.price);
    if (!(shareAmount > 0)) { errors.push(`${label} transaction ${i + 1} shares must be greater than zero`); ledgerCanReplay = false; }
    if (!(price > 0)) errors.push(`${label} transaction ${i + 1} price must be greater than zero`);
    if (txn.fees != null && txn.fees !== "") {
      const fees = decimalNumber(txn.fees);
      if (fees == null) errors.push(`${label} transaction ${i + 1} fees must be a valid finite number`);
      else if (fees < 0) errors.push(`${label} transaction ${i + 1} fees cannot be negative`);
    }
    if (ledgerCanReplay && (txn.type === "buy" || txn.type === "sell")) {
      shares = decimalAdd(shares, txn.shares, txn.type === "sell");
      if (shares.startsWith("-")) { errors.push(`${label} sells more shares than held by ${txn.month}`); ledgerCanReplay = false; }
    }
    collectDrpRow("transactions", txn, holdingKey, `${label} transaction ${i + 1}`);
  });
  const dividends = Array.isArray(holding.dividends) ? holding.dividends : [];
  checkIds(dividends, `${label} dividend`);
  dividends.forEach((dividend, i) => {
    if (!validMonth(dividend.month)) errors.push(`${label} dividend ${i + 1} has invalid month`);
    if (dividend.date != null && !validDate(dividend.date)) errors.push(`${label} dividend ${i + 1} has invalid date`);
    if (validDate(dividend.date) && dividend.date.slice(0, 7) !== dividend.month) errors.push(`${label} dividend ${i + 1} date and month disagree`);
    if (!(decimalNumber(dividend.amount) > 0)) errors.push(`${label} dividend ${i + 1} amount must be greater than zero`);
    collectDrpRow("dividends", dividend, holdingKey, `${label} dividend ${i + 1}`);
  });
}

function checkTaxRecord(tax, label) {
  if (!tax) return;
  const window = fyDateWindow(tax.year, tax.country || db.settings?.country);
  (tax.invoices || []).forEach((invoice, i) => {
    if (!invoice.id) errors.push(`${label} invoice ${i + 1} is missing id`);
    if (!validDate(invoice.date)) errors.push(`${label} invoice ${i + 1} has invalid date`);
    else if (invoice.date < window.start || invoice.date > window.end) errors.push(`${label} invoice ${i + 1} is outside ${tax.year}`);
    if (!(decimalNumber(invoice.amount) > 0)) errors.push(`${label} invoice ${i + 1} amount must be greater than zero`);
    if (!invoice.currency) errors.push(`${label} invoice ${i + 1} has no currency`);
    if (invoice.fxRate != null && !(decimalNumber(invoice.fxRate) > 0)) errors.push(`${label} invoice ${i + 1} has invalid fxRate`);
  });
  const brackets = tax.brackets || [];
  if (!brackets.length) errors.push(`${label} has no brackets`);
  const threshold = checkNonNegative(tax.taxFreeThreshold, `${label} tax-free threshold`);
  [
    ["employmentIncome", "employment income"], ["employmentTaxPaid", "tax already paid"],
    ["otherIncome", "other income"], ["deductions", "deductions"],
    ["capitalLossCarryIn", "capital loss carry-in"],
  ].forEach(([key, description]) => checkNonNegative(tax[key], `${label} ${description}`));
  [
    ["levyRate", "levy rate"], ["capitalGainsRate", "capital gains rate"],
    ["capitalGainsDiscount", "capital gains discount"],
  ].forEach(([key, description]) => {
    const value = decimalNumber(tax[key]);
    if (value == null || value < 0 || value > 1) errors.push(`${label} ${description} must be 0-100%`);
  });
  const holdingMonths = checkNonNegative(tax.capitalGainsDiscountMonths, `${label} discount holding period`);
  if (holdingMonths != null && !Number.isInteger(holdingMonths)) errors.push(`${label} discount holding period must be a whole number`);
  let previous = threshold == null ? 0 : threshold, top = 0;
  brackets.forEach((bracket, i) => {
    const rate = decimalNumber(bracket.rate);
    if (rate == null || rate < 0 || rate > 1) errors.push(`${label} bracket ${i + 1} rate must be 0-100%`);
    if (bracket.upTo == null) { top++; if (i !== brackets.length - 1) errors.push(`${label} open-ended bracket must be last`); }
    else {
      const cap = decimalNumber(bracket.upTo);
      if (cap == null || !(cap > previous)) errors.push(`${label} bracket ${i + 1} cap is not strictly increasing`);
      else previous = cap;
    }
  });
  if (brackets.length && top !== 1) errors.push(`${label} needs exactly one open-ended bracket`);
  (Array.isArray(tax.adjustments) ? tax.adjustments : []).forEach((adjustment, i) => {
    checkNonNegative(adjustment?.value, `${label} adjustment ${i + 1} value`);
  });
  if (n(db.version) >= 2 && label.startsWith("archived") && (!tax.sourceSnapshot || tax.sourceSnapshot.version !== 1)) errors.push(`${label} has no immutable source snapshot`);
}

if (!db || typeof db !== "object") errors.push("Backup root must be an object");
if (!db.settings || typeof db.settings !== "object") errors.push("settings object is missing");
if (!Array.isArray(db.currencies) || !db.currencies.length) warnings.push("No currencies found; setup may be incomplete");
else {
  db.currencies.forEach((currency, i) => {
    const code = String(currency?.code || "").trim().toUpperCase();
    if (!code) errors.push(`currency row ${i + 1} has no code`);
    if (code && seenCurrencies.has(code)) errors.push(`currency ${code} is duplicated`);
    if (code) seenCurrencies.add(code);
    if (!(n(currency?.rate) > 0)) errors.push(`currency ${code || i + 1} has invalid FX rate`);
  });
}

function requireCurrency(value, label) {
  const code = String(value || "").trim().toUpperCase();
  if (!code) errors.push(`${label} has no currency`);
  else referencedCurrencies.set(code, label);
}

requireCurrency(db.settings?.baseCurrency, "settings base currency");
if (db.settings?.secondaryCurrency) requireCurrency(db.settings.secondaryCurrency, "settings secondary currency");
[
  [db.accounts, "account"], [db.holdings, "holding"], [db.physicalAssets, "asset"],
  [db.expenses, "expense"], [db.incomes, "income"], [db.goals, "goal"],
  [db.recurring, "recurring entry"], [db.debts, "debt"],
].forEach(([rows, label]) => (Array.isArray(rows) ? rows : []).forEach((row, i) => requireCurrency(row?.currency, `${label} ${i + 1}`)));
[db.tax, ...(Array.isArray(db.taxArchive) ? db.taxArchive : [])].forEach((tax, i) => {
  if (!tax) return;
  requireCurrency(tax.currency, i ? `archived tax year ${tax.year || i}` : "active tax year");
  (tax.invoices || []).forEach((invoice, ii) => requireCurrency(invoice?.currency, `${tax.year || "tax year"} invoice ${ii + 1}`));
});
referencedCurrencies.forEach((label, code) => {
  if (!seenCurrencies.has(code)) errors.push(`${label} references missing currency ${code}`);
});

checkPersistedNumericRows();
checkMoneyRows(list("expenses"), "expense");
checkMoneyRows(list("incomes"), "income");
list("holdings").forEach(checkHolding);
checkDrpLinks();
checkTaxRecord(db.tax, "active tax year");
(Array.isArray(db.taxArchive) ? db.taxArchive : []).forEach((tax, i) => checkTaxRecord(tax, `archived tax year ${tax?.year || i + 1}`));

if (warnings.length) {
  console.log("Warnings:");
  warnings.forEach((msg) => console.log(`- ${msg}`));
}
if (errors.length) {
  console.error("Validation failed:");
  errors.forEach((msg) => console.error(`- ${msg}`));
  process.exit(1);
}

console.log("Validation passed");
