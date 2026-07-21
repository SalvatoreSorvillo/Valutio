#!/usr/bin/env node
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
    if (!(n(row.amount) > 0)) errors.push(`${label} row ${i + 1} amount must be greater than zero`);
    if (!row.currency) errors.push(`${label} row ${i + 1} has no currency`);
    if (row.share != null && (n(row.share) < 0 || n(row.share) > 100)) errors.push(`${label} row ${i + 1} share must be 0-100`);
  });
}

function checkHolding(holding, index) {
  const label = holding.name || holding.ticker || `holding ${index + 1}`;
  if (n(holding.price) < 0) errors.push(`${label} has negative current price`);
  const txns = Array.isArray(holding.transactions) ? holding.transactions : [];
  checkIds(txns, `${label} transaction`);
  let shares = 0;
  txns.slice().sort((a, b) => String(a.month).localeCompare(String(b.month)) || (a.date && b.date ? String(a.date).localeCompare(String(b.date)) : 0) || n(a.sequence) - n(b.sequence)).forEach((txn, i) => {
    if (!validMonth(txn.month)) errors.push(`${label} transaction ${i + 1} has invalid month`);
    if (txn.date != null && !validDate(txn.date)) errors.push(`${label} transaction ${i + 1} has invalid date`);
    if (validDate(txn.date) && txn.date.slice(0, 7) !== txn.month) errors.push(`${label} transaction ${i + 1} date and month disagree`);
    if (n(db.version) >= 2 && !(n(txn.sequence) > 0)) errors.push(`${label} transaction ${i + 1} has no replay sequence`);
    if (!(n(txn.shares) > 0)) errors.push(`${label} transaction ${i + 1} shares must be greater than zero`);
    if (!(n(txn.price) > 0)) errors.push(`${label} transaction ${i + 1} price must be greater than zero`);
    if (n(txn.fees) < 0) errors.push(`${label} transaction ${i + 1} fees cannot be negative`);
    if (txn.type === "sell") {
      shares -= n(txn.shares);
      if (shares < -1e-6) errors.push(`${label} sells more shares than held by ${txn.month}`);
    } else {
      shares += n(txn.shares);
    }
  });
}

function checkTaxRecord(tax, label) {
  if (!tax) return;
  const window = fyDateWindow(tax.year, tax.country || db.settings?.country);
  (tax.invoices || []).forEach((invoice, i) => {
    if (!invoice.id) errors.push(`${label} invoice ${i + 1} is missing id`);
    if (!validDate(invoice.date)) errors.push(`${label} invoice ${i + 1} has invalid date`);
    else if (invoice.date < window.start || invoice.date > window.end) errors.push(`${label} invoice ${i + 1} is outside ${tax.year}`);
    if (!(n(invoice.amount) > 0)) errors.push(`${label} invoice ${i + 1} amount must be greater than zero`);
    if (!invoice.currency) errors.push(`${label} invoice ${i + 1} has no currency`);
    if (invoice.fxRate != null && !(n(invoice.fxRate) > 0)) errors.push(`${label} invoice ${i + 1} has invalid fxRate`);
  });
  const brackets = tax.brackets || [];
  if (!brackets.length) errors.push(`${label} has no brackets`);
  let previous = n(tax.taxFreeThreshold), top = 0;
  brackets.forEach((bracket, i) => {
    if (n(bracket.rate) < 0 || n(bracket.rate) > 1) errors.push(`${label} bracket ${i + 1} rate must be 0-100%`);
    if (bracket.upTo == null) { top++; if (i !== brackets.length - 1) errors.push(`${label} open-ended bracket must be last`); }
    else if (!(n(bracket.upTo) > previous)) errors.push(`${label} bracket ${i + 1} cap is not strictly increasing`);
    else previous = n(bracket.upTo);
  });
  if (brackets.length && top !== 1) errors.push(`${label} needs exactly one open-ended bracket`);
  if (n(tax.capitalLossCarryIn) < 0) errors.push(`${label} capital loss carry-in cannot be negative`);
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

checkIds(list("accounts"), "account");
checkMoneyRows(list("expenses"), "expense");
checkMoneyRows(list("incomes"), "income");
list("holdings").forEach(checkHolding);
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
