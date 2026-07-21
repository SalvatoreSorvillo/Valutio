import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { performance } from "node:perf_hooks";

const appPath = new URL("../app.js", import.meta.url);
const source = fs.readFileSync(appPath, "utf8");
const cut = source.indexOf("  // Boot\n");
if (cut < 0) throw new Error("Could not locate the app boot marker");

const expose = `
  window.__financialTest = {
    defaultDB, migrate, validateDb, validDateString, normalizedDecimal,
    holdingMetrics, positionAt, calcTax, invoiceTotalsForTaxYear, holdingPeriodClass,
    fyDateWindow, dateInTaxYear, missingBackupCurrencies, strictBackupDateErrors,
    holdingHasOpenPosition, cellCurrencyFromFormat,
    applyStatementCategorizerRows, savingsRateForPeriod,
    setDb: function (value) { db = value; }, getDb: function () { return db; }
  };
})();
`;

const noop = () => {};
const dummy = {
  classList: { add: noop, remove: noop, toggle: noop, contains: () => false }, style: {}, dataset: {},
  addEventListener: noop, removeEventListener: noop, appendChild: noop, remove: noop, click: noop,
  focus: noop, querySelector: () => null, querySelectorAll: () => [], closest: () => null,
  getAttribute: () => null, setAttribute: noop,
};
const document = {
  documentElement: dummy, body: dummy, head: dummy, fonts: { load: () => Promise.resolve() },
  addEventListener: noop, removeEventListener: noop, getElementById: () => null,
  querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ ...dummy }),
};
const sandbox = {
  console, document, navigator: { onLine: false, serviceWorker: null },
  location: { protocol: "http:", hostname: "localhost" },
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop }, indexedDB: { open: () => ({}) },
  setTimeout: noop, clearTimeout: noop, setInterval: noop, clearInterval: noop,
  fetch: () => Promise.reject(new Error("network disabled")), Blob, URL, TextEncoder, TextDecoder,
  Uint8Array, ArrayBuffer, Date, Math, JSON, Promise, Intl, BigInt,
  parseFloat, parseInt, isFinite, isNaN, addEventListener: noop, removeEventListener: noop,
  matchMedia: () => ({ matches: false, addEventListener: noop }),
};
sandbox.window = sandbox; sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(source.slice(0, cut) + expose, sandbox, { filename: appPath.pathname });
const q = sandbox.__financialTest;

function wallet(year = "2025/26") {
  const d = q.defaultDB();
  d.setupComplete = true;
  d.settings.baseCurrency = "EUR"; d.settings.country = "AU";
  d.currencies = [
    { code: "EUR", symbol: "€", rate: 1 },
    { code: "USD", symbol: "$", rate: 0.9 },
    { code: "CHF", symbol: "CHF ", rate: 1.04 },
  ];
  d.holdings = []; d.incomes = []; d.expenses = []; d.snapshots = []; d.taxArchive = [];
  d.tax = {
    year, country: "AU", currency: "EUR", taxFreeThreshold: 0,
    brackets: [{ upTo: null, rate: 0.2 }], levyRate: 0, levyLabel: "Levy",
    capitalGainsRate: 0.2, capitalGainsDiscount: 0.5, capitalGainsDiscountMonths: 12,
    capitalLossCarryIn: 0, capitalLossCarryOut: 0, sourceSnapshot: null,
    deductions: 0, employmentIncome: 10000, employmentTaxPaid: 0, otherIncome: 0,
    invoices: [], adjustments: [],
  };
  return d;
}
function tx(id, date, type, shares, price, sequence, fees = 0) {
  return { id, date, month: date.slice(0, 7), datePrecision: "day", sequence, type, shares, price, fees };
}
function close(actual, expected, epsilon = 1e-8) { assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`); }

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test("calendar dates reject impossible days", () => {
  assert.equal(q.validDateString("2026-02-31"), false);
  assert.equal(q.validDateString("2024-02-29"), true);
});

test("strict JSON preflight rejects malformed invoice dates", () => {
  const d = wallet(); d.tax.invoices = [{ id: "bad", date: "2026-02-31", amount: 100, currency: "EUR" }];
  assert.equal(q.strictBackupDateErrors(d).length, 1);
});

test("bare dollar Excel masks use the workbook currency", () => {
  const XLSX = { utils: { encode_cell: ({ r, c }) => `${r}:${c}` } };
  const ws = { "2:4": { z: "$#,##0.00", w: "$42.00" } };
  assert.equal(q.cellCurrencyFromFormat(ws, XLSX, 2, 4, "AUD"), "AUD");
  assert.equal(q.cellCurrencyFromFormat(ws, XLSX, 2, 4, "USD"), "USD");
});

test("period savings rate uses total income and expenses instead of averaging monthly rates", () => {
  const months = [
    { income: 89.74, expenses: 1283.74 },
    { income: 3000, expenses: 1000 },
  ];
  const income = months.reduce((sum, month) => sum + month.income, 0);
  const expenses = months.reduce((sum, month) => sum + month.expenses, 0);
  const expected = (income - expenses) / income;
  const simpleMonthlyAverage = months.reduce((sum, month) => sum + (month.income - month.expenses) / month.income, 0) / months.length;
  assert.ok(Math.abs(q.savingsRateForPeriod(income, expenses) - expected) < 1e-12);
  assert.ok(Math.abs(q.savingsRateForPeriod(income, expenses) - simpleMonthlyAverage) > 1);
  assert.equal(q.savingsRateForPeriod(0, 100), null);
});

test("fiscal date windows include exact AU and UK boundaries", () => {
  assert.deepEqual({ ...q.fyDateWindow("2025/26", "AU") }, { start: "2025-07-01", end: "2026-06-30" });
  assert.deepEqual({ ...q.fyDateWindow("2025/26", "GB") }, { start: "2025-04-06", end: "2026-04-05" });
});

test("same-day transactions replay by sequence everywhere", () => {
  const d = wallet();
  const h = { id: "same", currency: "EUR", price: 20, realizedSeed: 0,
    transactions: [tx("sell", "2025-07-10", "sell", 5, 20, 20), tx("buy", "2025-07-10", "buy", 10, 10, 10)] };
  d.holdings = [h]; q.setDb(d);
  assert.equal(q.holdingMetrics(h).shares, 5); assert.equal(q.positionAt(h, "2025-07").shares, 5);
});

test("average buy resets after a full close and reopen", () => {
  const d = wallet();
  const h = { id: "reopen", currency: "EUR", price: 300, realizedSeed: 0,
    transactions: [tx("a", "2025-01-01", "buy", 10, 100, 10), tx("b", "2025-02-01", "sell", 10, 110, 20), tx("c", "2025-03-01", "buy", 10, 300, 30)] };
  d.holdings = [h]; q.setDb(d); close(q.holdingMetrics(h).avgBuyPrice, 300);
});

test("CGT discount begins after the acquisition anniversary", () => {
  assert.equal(q.holdingPeriodClass({ date: "2024-02-02", month: "2024-02" }, { date: "2025-02-02", month: "2025-02" }, 12), "short");
  assert.equal(q.holdingPeriodClass({ date: "2024-02-02", month: "2024-02" }, { date: "2025-02-03", month: "2025-02" }, 12), "long");
  assert.equal(q.holdingPeriodClass({ month: "2024-02" }, { month: "2025-02" }, 12), "unknown");
});

test("capital losses cannot reduce ordinary income", () => {
  const d = wallet();
  d.holdings = [
    { id: "gain", currency: "EUR", price: 200, realizedSeed: 0, transactions: [tx("a", "2024-07-01", "buy", 10, 100, 10), tx("b", "2025-08-02", "sell", 10, 200, 20)] },
    { id: "loss", currency: "EUR", price: 100, realizedSeed: 0, transactions: [tx("c", "2025-07-01", "buy", 10, 200, 10), tx("d", "2025-08-02", "sell", 10, 100, 20)] },
  ];
  q.setDb(d); const result = q.calcTax(d.tax);
  close(result.realized, 0); close(result.taxableIncome, 10000); close(result.estimated, 2000);
});

test("capital losses are applied before the long-term discount", () => {
  const d = wallet();
  d.holdings = [
    { id: "long-gain", currency: "EUR", price: 200, realizedSeed: 0, transactions: [tx("a", "2024-07-01", "buy", 10, 100, 10), tx("b", "2025-08-02", "sell", 10, 200, 20)] },
    { id: "short-loss", currency: "EUR", price: 80, realizedSeed: 0, transactions: [tx("c", "2025-07-01", "buy", 10, 100, 10), tx("d", "2025-08-02", "sell", 10, 80, 20)] },
  ];
  q.setDb(d); const result = q.calcTax(d.tax);
  close(result.realizedGross, 800); close(result.realized, 400); close(result.taxableIncome, 10400);
});

test("excess capital losses carry forward", () => {
  const d = wallet(); d.tax.capitalLossCarryIn = 20;
  d.holdings = [{ id: "loss", currency: "EUR", price: 100, realizedSeed: 0,
    transactions: [tx("a", "2025-07-01", "buy", 1, 180, 10), tx("b", "2025-08-01", "sell", 1, 100, 20)] }];
  q.setDb(d); const result = q.calcTax(d.tax);
  close(result.realized, 0); close(result.capitalLossCarryOut, 100); close(result.taxableIncome, 10000);
});

test("capital losses carry correctly across five tax years", () => {
  const d = wallet("2029/30"); d.version = 1; d.tax.employmentIncome = 0;
  d.taxArchive = ["2025/26", "2026/27", "2027/28", "2028/29"].map((year) => ({ ...wallet(year).tax, employmentIncome: 0 }));
  d.holdings = [{ id: "carry", currency: "EUR", price: 100, realizedSeed: 0, transactions: [
    tx("a1", "2025-07-01", "buy", 1, 200, 10), tx("a2", "2025-08-01", "sell", 1, 100, 20),
    tx("b1", "2026-07-01", "buy", 1, 100, 30), tx("b2", "2026-08-01", "sell", 1, 140, 40),
    tx("d1", "2028-07-01", "buy", 1, 100, 50), tx("d2", "2028-08-01", "sell", 1, 200, 60),
  ] }];
  const migrated = q.migrate(JSON.parse(JSON.stringify(d))); q.setDb(migrated);
  assert.deepEqual(migrated.taxArchive.map((record) => record.capitalLossCarryOut), [100, 60, 60, 0]);
  close(q.calcTax(migrated.taxArchive[1]).realized, 0);
  close(q.calcTax(migrated.taxArchive[3]).realized, 40);
  close(migrated.tax.capitalLossCarryIn, 0);
});

test("out-of-year invoices are excluded", () => {
  const d = wallet(); d.tax.invoices = [{ id: "old", date: "2020-01-15", amount: 1000, currency: "EUR" }];
  q.setDb(d); close(q.calcTax(d.tax).freelance, 0);
});

test("invoice footer totals match displayed year values in both currencies", () => {
  const d = wallet();
  d.currencies.push({ code: "AUD", symbol: "A$", rate: 0.6 });
  d.tax.currency = "AUD";
  d.tax.invoices = [
    { id: "a", date: "2025-07-08", amount: 1600, currency: "EUR", fxRate: 1.8 },
    { id: "b", date: "2026-02-15", amount: 825, currency: "EUR", fxRate: 1.67 },
    { id: "outside", date: "2024-05-01", amount: 999, currency: "EUR", fxRate: 1.5 },
  ];
  q.setDb(d);
  const totals = q.invoiceTotalsForTaxYear(d.tax);
  close(totals.primary, 2425);
  close(totals.tax, 1600 * 1.8 + 825 * 1.67);
  close(q.calcTax(d.tax).freelance, totals.tax);
});

test("v1 migration freezes archived tax inputs", () => {
  const d = wallet("2026/27"); d.version = 1; d.tax.employmentIncome = 0;
  const archived = { ...wallet().tax, employmentIncome: 0 };
  d.taxArchive = [archived];
  d.holdings = [{ id: "fx", currency: "USD", price: 200, realizedSeed: 0,
    transactions: [tx("a", "2024-07-01", "buy", 10, 100, 10), tx("b", "2025-08-02", "sell", 10, 200, 20)] }];
  const migrated = q.migrate(JSON.parse(JSON.stringify(d))); q.setDb(migrated);
  const rec = migrated.taxArchive[0], before = q.calcTax(rec).realizedGross;
  migrated.currencies.find((c) => c.code === "USD").rate = 0.5; close(q.calcTax(rec).realizedGross, before);
  migrated.holdings = []; close(q.calcTax(rec).realizedGross, before);
});

test("v1 migration locks archived invoice currency conversion", () => {
  const d = wallet("2026/27"); d.version = 1; d.tax.employmentIncome = 0;
  const archived = { ...wallet().tax, employmentIncome: 0, invoices: [{ id: "invoice", date: "2025-08-01", amount: 1000, currency: "USD" }] };
  d.taxArchive = [archived];
  const migrated = q.migrate(JSON.parse(JSON.stringify(d))); q.setDb(migrated);
  const rec = migrated.taxArchive[0], before = q.calcTax(rec).freelance;
  migrated.currencies.find((c) => c.code === "USD").rate = 0.5;
  close(before, 900); close(q.calcTax(rec).freelance, before);
});

test("migration preserves unused currencies and exact decimal strings", () => {
  const d = wallet(); d.version = 1;
  d.holdings = [{ id: "crypto", name: "Token", type: "crypto", currency: "EUR", price: 1, realizedSeed: 0,
    transactions: [{ id: "a", month: "2025-07", type: "buy", shares: "0.123456789012345678", price: "1", fees: "0" }] }];
  const migrated = q.migrate(JSON.parse(JSON.stringify(d)));
  assert.deepEqual(migrated.currencies.map((c) => c.code), ["EUR", "USD", "CHF"]);
  assert.equal(migrated.holdings[0].transactions[0].shares, "0.123456789012345678");
});

test("migration preserves retirement inputs", () => {
  const d = wallet(); d.version = 1; d.retirement = { salary: 98765.43, employerExtra: 1200, voluntary: 3400 };
  const migrated = q.migrate(JSON.parse(JSON.stringify(d)));
  assert.deepEqual({ ...migrated.retirement }, d.retirement);
});

test("migration preserves statement categoriser rules and preferences", () => {
  const d = wallet(); d.version = 1;
  d.settings.statementCategorizer = {
    currency: "AUD",
    rules: { excludeKeywords: ["transfer"], refundKeywords: ["refund"], expenseRules: { Groceries: ["market"] }, incomeRules: { Salary: ["payroll"] } },
  };
  const migrated = q.migrate(JSON.parse(JSON.stringify(d)));
  assert.deepEqual({ ...migrated.settings.statementCategorizer }, d.settings.statementCategorizer);
});

test("migration removes obsolete statement categoriser preferences", () => {
  const d = wallet(); d.version = 1;
  d.settings.statementCategorizer = { currency: "AUD", rules: null, legacyOption: true };
  const migrated = q.migrate(JSON.parse(JSON.stringify(d)));
  assert.deepEqual(Object.keys(migrated.settings.statementCategorizer).sort(), ["currency", "rules"]);
});

test("statement categoriser applies personal, joint and income rows once", () => {
  const d = wallet(); q.setDb(d);
  const rows = [
    { kind: "expense", month: "2026-05", category: "Groceries", accountType: "Personal", currency: "EUR", amount: 42, sourceKey: "statement:a", note: "Statement categoriser" },
    { kind: "expense", month: "2026-05", category: "Dining out", accountType: "Joint", currency: "EUR", amount: 80, sourceKey: "statement:b", note: "Statement categoriser" },
    { kind: "income", month: "2026-05", category: "Salary", accountType: "Joint", currency: "EUR", amount: 1000, sourceKey: "statement:c", note: "Statement categoriser" },
  ];
  assert.deepEqual({ ...q.applyStatementCategorizerRows(rows) }, { added: 3, skipped: 0 });
  assert.equal(d.expenses.length, 2); assert.equal(d.incomes.length, 1);
  assert.equal(d.expenses[1].joint, true); assert.equal(d.expenses[1].share, 50);
  assert.equal(d.incomes[0].statementAccountType, "Joint");
  assert.deepEqual({ ...q.applyStatementCategorizerRows(rows) }, { added: 0, skipped: 3 });
  assert.equal(d.expenses.length, 2); assert.equal(d.incomes.length, 1);
});

test("statement categoriser recognises source keys written by the previous release", () => {
  const d = wallet();
  d.expenses = [{ id: "old", month: "2026-05", category: "Other", amount: 5, currency: "EUR", note: "Coffee", statementSourceKey: "statement:legacy" }];
  q.setDb(d);
  const rows = [{ kind: "expense", month: "2026-05", category: "Other", accountType: "Personal", currency: "EUR", amount: 5, sourceKey: "statement:canonical", legacySourceKey: "statement:legacy", note: "Coffee" }];
  assert.deepEqual({ ...q.applyStatementCategorizerRows(rows) }, { added: 0, skipped: 1 });
  assert.equal(d.expenses.length, 1);
});

test("statement categoriser flags a changed overlapping amount without duplicating it", () => {
  const d = wallet();
  d.expenses = [{ id: "existing", month: "2026-05", category: "Groceries", amount: 10, currency: "EUR", note: "Market", statementSourceKey: "statement:stable" }];
  q.setDb(d);
  const rows = [{ kind: "expense", month: "2026-05", category: "Groceries", accountType: "Personal", currency: "EUR", amount: 5, sourceKey: "statement:stable", note: "Market" }];
  assert.deepEqual({ ...q.applyStatementCategorizerRows(rows) }, { added: 0, skipped: 1, changed: 1 });
  assert.equal(d.expenses.length, 1); assert.equal(d.expenses[0].amount, 10);
});

test("fully sold holdings are excluded from live quote refresh", () => {
  const d = wallet();
  const h = { id: "sold", currency: "EUR", price: 120, realizedSeed: 0,
    transactions: [tx("a", "2025-07-01", "buy", 10, 100, 10), tx("b", "2025-08-01", "sell", 10, 120, 20)] };
  d.holdings = [h]; q.setDb(d); assert.equal(q.holdingHasOpenPosition(h), false);
});

test("strict validation rejects malformed brackets", () => {
  const d = wallet(); d.tax.brackets = [{ upTo: 100000, rate: 0.2 }, { upTo: 50000, rate: 0.3 }, { upTo: null, rate: 1.2 }];
  const audit = q.validateDb(d, { repair: false, strict: true, source: "test" });
  assert.ok(audit.errors.some((message) => /bracket/.test(message)));
});

test("strict validation catches oversells when shares are decimal strings", () => {
  const d = wallet(); d.holdings = [{ id: "string-shares", name: "String shares", currency: "EUR", price: 1, transactions: [
    tx("a", "2025-07-01", "buy", "1.1", 1, 10), tx("b", "2025-07-02", "buy", "2.2", 1, 20), tx("c", "2025-07-03", "sell", "4", 1, 30),
  ] }];
  const audit = q.validateDb(d, { repair: false, strict: true, source: "test" });
  assert.ok(audit.errors.some((message) => /sells more shares/.test(message)));
});

test("backup currency references are complete", () => {
  const d = wallet(); d.accounts = [{ id: "a", name: "Yen", currency: "JPY", balance: 1 }];
  assert.deepEqual(Array.from(q.missingBackupCurrencies(d)), ["JPY"]);
});

test("100,000 transactions remain responsive", () => {
  const d = wallet(), transactions = [];
  for (let i = 0; i < 100000; i++) transactions.push({ id: String(i), month: `2025-${String((i % 12) + 1).padStart(2, "0")}`, sequence: i + 1, type: "buy", shares: "0.000001", price: 50, fees: 0 });
  const h = { id: "stress", currency: "EUR", price: 100, realizedSeed: 0, transactions }; d.holdings = [h]; q.setDb(d);
  const start = performance.now(); q.holdingMetrics(h); assert.ok(performance.now() - start < 500);
});

let failed = 0;
for (const item of tests) {
  try { await item.fn(); console.log("PASS", item.name); }
  catch (error) { failed++; console.error("FAIL", item.name, "-", error.message); }
}
console.log(`${tests.length - failed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
