import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const appPath = new URL("../app.js", import.meta.url);
const backupValidatorPath = fileURLToPath(new URL("./validate-wallet-backup.mjs", import.meta.url));
const source = fs.readFileSync(appPath, "utf8");
const cut = source.indexOf("  // Boot\n");
if (cut < 0) throw new Error("Could not locate the app boot marker");

const expose = `
  window.__financialTest = {
    defaultDB, migrate, validateDb, validDateString, localDateString, normalizedDecimal,
    holdingMetrics, frozenHoldingMetrics, positionAt, calcTax, invoiceTotalsForTaxYear, holdingPeriodClass,
    holdingFlows, dividendsInTaxYear, interestsInTaxYear, realizedInTaxYear, realizedYearSplit, monthTotal,
    benchmarkTrendValues, portfolioTWR,
    drpPairValidationErrors, upsertDividendReinvestment, removeDividendReinvestment, restoreDividendReinvestment, repropagateHolding,
    workbookContainsDrpRows,
    fyDateWindow, dateInTaxYear, missingBackupCurrencies, strictBackupDateErrors, strictBackupLedgerErrors, strictBackupPreflightErrors,
    rescaleFrozenSnapshots, recomputeSnapshot, snapshotForView, snapshotBucketsByCcy,
    retargetInvoiceFxRates, syncArchivedInvoiceSnapshot, applyTaxPreset, taxPresetForYear, upgradeManagedActiveTaxPreset,
    markTaxPresetManagement, expectedFYLabel, switchTaxCountryPreset, maybeAutoFreezeTaxYear, convertHoldingCurrencyValues,
    walletHasData, backupDue, backupOverdue, maybeAutoSnapshot, buildSnapshot, currentMonth, prevMonthStr,
    holdingHasOpenPosition, cellCurrencyFromFormat, debtEquity, linkedDebtsBase,
    applyStatementCategorizerRows, savingsRateForPeriod, withDbRollback,
    taxSettingsValidationErrors, applyTaxSettingsCandidate,
    setDb: function (value) { db = value; }, getDb: function () { return db; },
    setNetView: function (value) { state.netView = value; }
  };
})();
`;

const noop = () => {};
const dummy = {
  classList: { add: noop, remove: noop, toggle: noop, contains: () => false }, style: {}, dataset: {},
  innerHTML: "", value: "",
  addEventListener: noop, removeEventListener: noop, appendChild: noop, remove: noop, click: noop,
  focus: noop, querySelector: () => null, querySelectorAll: () => [], closest: () => null,
  getAttribute: () => null, setAttribute: noop,
};
const document = {
  documentElement: dummy, body: dummy, head: dummy, fonts: { load: () => Promise.resolve() },
  addEventListener: noop, removeEventListener: noop, getElementById: () => dummy,
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
function drpHolding(linkId = "drp-link-1", overrides = {}) {
  const date = overrides.date || "2025-08-15";
  const transaction = {
    ...tx("drp-buy-1", date, "buy", "3", String(100 / 3), 10, 0),
    origin: "drp", linkId,
    ...(overrides.transaction || {}),
  };
  const dividend = {
    id: "drp-dividend-1", date, month: date.slice(0, 7), amount: "100", origin: "drp", linkId,
    ...(overrides.dividend || {}),
  };
  return {
    id: overrides.id || "drp-holding-1", name: overrides.name || "DRP holding", currency: "EUR", price: 40,
    realizedSeed: 0, transactions: [transaction], dividends: [dividend],
  };
}
function runBackupValidator(value) {
  const file = path.join(os.tmpdir(), `valutio-validator-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify(value));
    return spawnSync(process.execPath, [backupValidatorPath, file], { encoding: "utf8" });
  } finally {
    fs.rmSync(file, { force: true });
  }
}
function close(actual, expected, epsilon = 1e-8) { assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`); }

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test("calendar dates reject impossible days", () => {
  assert.equal(q.validDateString("2026-02-31"), false);
  assert.equal(q.validDateString("2024-02-29"), true);
});

test("local date formatting keeps the calendar day around local midnight", () => {
  assert.equal(q.localDateString(new Date(2026, 7, 2, 0, 30)), "2026-08-02");
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

test("Australian managed presets follow the legislated income year without overwriting custom settings", () => {
  assert.equal(q.taxPresetForYear("AU", "2025/26").brackets[0].rate, 0.16);
  assert.equal(q.taxPresetForYear("AU", "2026/27").brackets[0].rate, 0.15);
  assert.equal(q.taxPresetForYear("AU", "2027/28").brackets[0].rate, 0.14);

  const managed = wallet("2026/27");
  managed.tax.brackets = [
    { upTo: 45000, rate: 0.16 }, { upTo: 135000, rate: 0.30 },
    { upTo: 190000, rate: 0.37 }, { upTo: null, rate: 0.45 },
  ];
  managed.tax.taxFreeThreshold = 18200; managed.tax.levyRate = 0.02; managed.tax.levyLabel = "Medicare Levy";
  delete managed.tax.presetManaged;
  q.upgradeManagedActiveTaxPreset(managed);
  assert.equal(managed.tax.brackets[0].rate, 0.15);
  assert.equal(managed.tax.presetManaged, true);
  assert.equal(managed.tax.presetVersion, "AU-2026/27");

  const custom = wallet("2026/27");
  custom.tax.brackets = [{ upTo: 50000, rate: 0.19 }, { upTo: null, rate: 0.41 }];
  delete custom.tax.presetManaged;
  q.upgradeManagedActiveTaxPreset(custom);
  assert.deepEqual(custom.tax.brackets, [{ upTo: 50000, rate: 0.19 }, { upTo: null, rate: 0.41 }]);
  assert.equal(custom.tax.presetManaged, false);

  const customCgt = JSON.parse(JSON.stringify(managed));
  customCgt.tax.capitalGainsDiscount = 0.4; delete customCgt.tax.presetManaged;
  q.upgradeManagedActiveTaxPreset(customCgt);
  assert.equal(customCgt.tax.capitalGainsDiscount, 0.4);
  assert.equal(customCgt.tax.presetManaged, false);
});

test("country preset switching labels before applying rates and blocks archived-year collisions", () => {
  const d = wallet("2025/26"); q.setDb(d);
  const switched = q.switchTaxCountryPreset("AU", true, new Date("2026-08-02T12:00:00Z"));
  assert.deepEqual({ ...switched }, { ok: true, year: "2026/27" });
  assert.equal(d.tax.year, "2026/27"); assert.equal(d.tax.brackets[0].rate, 0.15);

  const blocked = wallet("2025/26"); blocked.taxArchive = [{ year: "2026/27" }]; q.setDb(blocked);
  const before = JSON.stringify(blocked);
  const result = q.switchTaxCountryPreset("AU", true, new Date("2026-08-02T12:00:00Z"));
  assert.equal(result.ok, false); assert.equal(result.reason, "archive_collision");
  assert.equal(JSON.stringify(blocked), before);
});

test("annual tax inputs retain managed presets and rollover clears annual deductions", () => {
  const d = wallet("2025/26"); q.setDb(d); q.applyTaxPreset("AU", true);
  const candidate = JSON.parse(JSON.stringify(d.tax));
  candidate.employmentIncome = 123456; candidate.employmentTaxPaid = 20000; candidate.deductions = 750;
  assert.equal(q.markTaxPresetManagement(candidate), true);
  assert.equal(candidate.presetVersion, "AU-2025/26");
  assert.equal(q.applyTaxSettingsCandidate(d.tax, candidate).ok, true);
  assert.equal(d.tax.presetManaged, true);
  assert.equal(q.maybeAutoFreezeTaxYear(new Date("2026-07-01T12:00:00Z")), true);
  assert.equal(d.tax.year, "2026/27"); assert.equal(d.tax.brackets[0].rate, 0.15);
  assert.equal(d.tax.employmentIncome, 0); assert.equal(d.tax.employmentTaxPaid, 0); assert.equal(d.tax.deductions, 0);
  assert.equal(d.taxArchive[0].deductions, 750);
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

test("live and frozen holding Return percent use the same remaining-cost definition", () => {
  const d = wallet();
  const h = { id: "return-parity", currency: "EUR", price: 200, realizedSeed: 0,
    transactions: [tx("buy", "2025-01-01", "buy", 10, 100, 10), tx("sell", "2025-02-01", "sell", 5, 200, 20)] };
  d.holdings = [h]; q.setDb(d);
  const live = q.holdingMetrics(h);
  const frozen = q.frozenHoldingMetrics({ shares: 5, buyPrice: 100, fees: 0, contributionCost: 500, price: 200, realized: 500, currency: "EUR", rate: 1 });
  close(live.totalReturnPct, 2);
  close(frozen.retPct, 2);
});

test("multiple mortgages calculate one combined property equity", () => {
  const d = wallet();
  d.physicalAssets = [{ id: "home", name: "Home", value: 500000, currency: "EUR", includeInNetWorth: true }];
  d.debts = [
    { id: "first", type: "mortgage", propertyAssetId: "home", balance: 300000, currency: "EUR" },
    { id: "second", type: "mortgage", propertyAssetId: "home", balance: 100000, currency: "EUR" },
  ];
  q.setDb(d);
  close(q.linkedDebtsBase("home"), 400000);
  close(q.debtEquity(d.debts[0]).equity, 100000);
  close(q.debtEquity(d.debts[1]).equity, 100000);
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

test("closed cash flow and tax sources use the FX frozen for their month", () => {
  const d = wallet();
  d.currencies.find((c) => c.code === "USD").rate = 0.2;
  d.snapshots = [{
    month: "2025-08", rates: { EUR: 1, USD: 0.9 }, accounts: {}, holdings: {}, buckets: {},
    income: 0, expenses: 0, gross: 0, netWorth: 0,
  }];
  d.incomes = [{ id: "interest", month: "2025-08", category: "Interest", amount: 100, currency: "USD" }];
  d.expenses = [{ id: "joint-expense", month: "2025-08", category: "Other", amount: 100, currency: "USD", joint: true, share: 50 }];
  d.holdings = [{
    id: "frozen-fx", currency: "USD", price: 200, realizedSeed: 0,
    transactions: [tx("buy", "2025-07-01", "buy", 1, 100, 10), tx("sell", "2025-08-01", "sell", 1, 200, 20)],
    dividends: [{ id: "dividend", date: "2025-08-15", month: "2025-08", amount: 100 }],
  }];
  q.setDb(d); q.setNetView("mine");
  close(q.monthTotal(d.incomes, "2025-08"), 90);
  close(q.monthTotal(d.expenses, "2025-08"), 45);
  close(q.interestsInTaxYear("2025/26", false, "AU"), 90);
  close(q.dividendsInTaxYear("2025/26", false, "AU"), 90);
  close(q.realizedInTaxYear("2025/26", "AU"), 90);
  close(q.realizedYearSplit("2025/26", 0, "AU").longGains, 90);
  q.recomputeSnapshot(d.snapshots[0]);
  close(d.snapshots[0].income, 90); close(d.snapshots[0].expenses, 45);
  d.currencies.find((c) => c.code === "USD").rate = 0.05;
  close(q.monthTotal(d.incomes, "2025-08"), 90);
  d.currencies.push({ code: "AUD", symbol: "A$", rate: 0.1 }); d.snapshots[0].rates.AUD = 0.6; d.tax.currency = "AUD";
  close(q.calcTax(d.tax).interests, 150);
  close(q.calcTax(d.tax).dividends, 150);
  close(q.calcTax(d.tax).realizedGross, 150);
  d.currencies.find((c) => c.code === "AUD").rate = 0.01;
  close(q.calcTax(d.tax).interests, 150);
});

test("tax preset changes retarget existing dated invoice locks", () => {
  const d = wallet();
  d.currencies.push({ code: "AUD", symbol: "A$", rate: 0.61 });
  d.currencies.find((c) => c.code === "USD").rate = 0.92;
  d.tax.currency = "EUR";
  d.tax.invoices = [{ id: "locked", date: "2025-08-01", amount: 100, currency: "USD", fxRate: 0.92, fxDate: "2025-08-01" }];
  q.setDb(d); q.applyTaxPreset("AU", false);
  assert.equal(d.tax.currency, "AUD"); assert.equal(d.settings.baseCurrency, "AUD");
  close(d.tax.invoices[0].fxRate, 0.92 / 0.61);
  close(q.calcTax(d.tax).freelance, 100 * 0.92 / 0.61);
  d.currencies.find((c) => c.code === "USD").rate = 0.1;
  close(q.calcTax(d.tax).freelance, 100 * 0.92 / 0.61);
});

test("editing one archived invoice does not rebuild other invoice locks at live FX", () => {
  const d = wallet("2026/27");
  const archived = {
    ...wallet("2025/26").tax,
    invoices: [
      { id: "edited", date: "2025-08-01", amount: 200, currency: "USD", fxRate: 0.9, fxDate: "2025-08-01" },
      { id: "legacy", date: "2025-09-01", amount: 200, currency: "USD" },
    ],
    sourceSnapshot: { version: 1, taxCurrency: "EUR", invoiceAmounts: { edited: 90, legacy: 180 } },
  };
  d.taxArchive = [archived]; d.currencies.find((c) => c.code === "USD").rate = 0.2;
  q.setDb(d); q.syncArchivedInvoiceSnapshot(archived);
  close(archived.sourceSnapshot.invoiceAmounts.edited, 180);
  close(archived.sourceSnapshot.invoiceAmounts.legacy, 180);
  close(q.calcTax(archived).freelance, 360);
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

test("strict JSON preflight rejects invalid transaction metadata without normalizing it", () => {
  const d = wallet();
  const tomorrow = q.localDateString(new Date(Date.now() + 86400000));
  d.holdings = [{ id: "bad-ledger", name: "Bad ledger", currency: "EUR", price: 1, transactions: [
    { id: "bad", type: "selll", shares: "1", price: "1", fees: "n/a", date: "2025-08-02", month: "2025-07", sequence: 10 },
    { id: "future", type: "buy", shares: "1", price: "1", fees: "0", date: tomorrow, month: tomorrow.slice(0, 7), sequence: 20 },
  ] }];
  const before = JSON.stringify(d), errors = q.strictBackupPreflightErrors(d);
  assert.ok(errors.some((message) => /type must be buy or sell/.test(message)));
  assert.ok(errors.some((message) => /date and month disagree/.test(message)));
  assert.ok(errors.some((message) => /fees must be a valid finite number/.test(message)));
  assert.ok(errors.some((message) => /dated in the future/.test(message)));
  assert.equal(JSON.stringify(d), before);
});

test("strict validation rejects an exact sub-micro-share oversell", () => {
  const d = wallet(); d.holdings = [{ id: "micro", name: "Micro", currency: "EUR", price: 1, transactions: [
    tx("buy", "2025-07-01", "buy", "0.0000001", 1, 10),
    tx("sell", "2025-07-02", "sell", "0.0000002", 1, 20),
  ] }];
  const audit = q.validateDb(d, { repair: false, strict: true, source: "test" });
  assert.ok(audit.errors.some((message) => /sells more shares/.test(message)));
  const standalone = runBackupValidator(d);
  assert.notEqual(standalone.status, 0); assert.match(standalone.stderr, /sells more shares/);
});

test("strict validators allow negative account balances but reject malformed values", () => {
  const negative = wallet();
  negative.accounts = [{ id: "credit-card", name: "Credit card", currency: "EUR", balance: -125.5 }];
  const accepted = q.validateDb(negative, { repair: false, strict: true, source: "test" });
  assert.equal(accepted.errors.some((message) => /account row 1 balance/.test(message)), false);
  const standaloneAccepted = runBackupValidator(negative);
  assert.equal(standaloneAccepted.status, 0, standaloneAccepted.stderr);

  const d = wallet();
  d.accounts = [{ id: "account", name: "Account", currency: "EUR", balance: "bad" }];
  d.physicalAssets = [{ id: "asset", name: "Asset", currency: "EUR", value: "bad" }];
  d.goals = [{ id: "goal", name: "Goal", currency: "EUR", cost: 100, currentSavings: -1 }];
  d.recurring = [{ id: "rule", kind: "expense", currency: "EUR", amount: -1, since: "2025-07" }];
  d.debts = [{ id: "debt", name: "Debt", currency: "EUR", balance: 1, apr: -1, payment: 1 }];
  d.tax.employmentIncome = "not-a-number";
  const audit = q.validateDb(d, { repair: false, strict: true, source: "test" });
  ["Account", "Asset", "Goal", "Recurring", "Debt", "employment income"].forEach((term) => {
    assert.ok(audit.errors.some((message) => message.toLowerCase().includes(term.toLowerCase())), term);
  });
  const standalone = runBackupValidator(d);
  assert.notEqual(standalone.status, 0);
});

test("negative account balances reduce net worth without a debt record", () => {
  const d = wallet();
  d.accounts = [{ id: "credit-card", name: "Credit card", bucket: "Cash", currency: "EUR", balance: -125.5 }];
  q.setDb(d);
  const snapshot = q.buildSnapshot(q.currentMonth());
  close(snapshot.gross, -125.5);
  close(snapshot.netWorth, -125.5);
  assert.equal(snapshot.debtsTotal || 0, 0);
});

test("Excel preview rollback restores the wallet even when parsing throws", () => {
  const d = wallet(); d.accounts = [{ id: "original", name: "Original", currency: "EUR", balance: 10 }]; q.setDb(d);
  const before = JSON.stringify(d);
  assert.throws(() => q.withDbRollback(() => { q.getDb().accounts[0].balance = 999; throw new Error("parse failed"); }), /parse failed/);
  assert.equal(JSON.stringify(q.getDb()), before);
});

test("invalid Tax Settings candidates leave the saved record unchanged", () => {
  const d = wallet(), target = d.tax; q.setDb(d);
  target.invoices = [{ id: "invoice", date: "2025-08-01", amount: 10, currency: "USD", fxRate: 1.2 }];
  const before = JSON.stringify(target), candidate = JSON.parse(before);
  candidate.currency = "USD"; candidate.brackets = [{ upTo: 100, rate: 2 }, { upTo: null, rate: 0.2 }];
  const result = q.applyTaxSettingsCandidate(target, candidate);
  assert.equal(result.ok, false); assert.equal(JSON.stringify(target), before);
});

test("manual tax-currency changes retarget invoice locks instead of exposing them to live FX", () => {
  const d = wallet(), target = d.tax; q.setDb(d);
  target.invoices = [{ id: "invoice", date: "2025-08-01", amount: 100, currency: "USD", fxRate: 0.9, fxDate: "2025-08-01" }];
  const candidate = JSON.parse(JSON.stringify(target)); candidate.currency = "CHF";
  const result = q.applyTaxSettingsCandidate(target, candidate);
  assert.equal(result.ok, true); close(target.invoices[0].fxRate, 0.9 / 1.04);
  const locked = q.calcTax(target).freelance;
  d.currencies.find((c) => c.code === "USD").rate = 0.1;
  d.currencies.find((c) => c.code === "CHF").rate = 2;
  close(q.calcTax(target).freelance, locked);
});

test("strict validation accepts one complete DRP pair with a repeating-decimal issue price", () => {
  const d = wallet(); d.version = 3; d.holdings = [drpHolding()];
  const audit = q.validateDb(d, { repair: false, strict: true, source: "test" });
  assert.equal(audit.errors.filter((message) => /DRP link/.test(message)).length, 0);
});

test("v3 migration preserves linked DRP metadata and long decimal shares", () => {
  const d = wallet(); d.version = 2;
  const shares = "0.123456789012345678", linkId = "migration-drp";
  d.holdings = [{
    id: "migration-holding", name: "Migration DRP", currency: "EUR", price: 10, realizedSeed: 0,
    transactions: [{ ...tx("migration-buy", "2025-08-15", "buy", shares, String(1 / Number(shares)), 10, "0"), origin: "drp", linkId }],
    dividends: [{ id: "migration-dividend", date: "2025-08-15", month: "2025-08", amount: "1", origin: "drp", linkId }],
  }];
  const migrated = q.migrate(JSON.parse(JSON.stringify(d)));
  assert.equal(migrated.version, 3); assert.ok(migrated.meta.migrations.v3);
  assert.equal(migrated.holdings[0].transactions[0].shares, shares);
  assert.equal(migrated.holdings[0].transactions[0].linkId, linkId);
  assert.equal(migrated.holdings[0].dividends[0].amount, "1");
});

test("strict validation rejects orphaned, reused and mismatched DRP links", () => {
  const orphan = wallet(); orphan.version = 3; orphan.holdings = [drpHolding()]; orphan.holdings[0].dividends = [];
  assert.ok(q.validateDb(orphan, { repair: false, strict: true, source: "test" }).errors.some((message) => /DRP link/.test(message)));

  const reused = wallet(); reused.version = 3;
  reused.holdings = [drpHolding("shared-link"), drpHolding("shared-link", { id: "drp-holding-2", name: "Other DRP holding" })];
  assert.ok(q.validateDb(reused, { repair: false, strict: true, source: "test" }).errors.some((message) => /DRP link/.test(message)));

  const mismatched = wallet(); mismatched.version = 3;
  mismatched.holdings = [drpHolding("wrong-value", { dividend: { amount: "101" } })];
  assert.ok(q.validateDb(mismatched, { repair: false, strict: true, source: "test" }).errors.some((message) => /DRP link/.test(message)));

  const malformedFees = wallet(); malformedFees.version = 3;
  malformedFees.holdings = [drpHolding("invalid-fees", { transaction: { fees: "garbage" } })];
  assert.ok(q.validateDb(malformedFees, { repair: false, strict: true, source: "test" }).errors.some((message) => /cannot include fees/.test(message)));
});

test("JSON import preflight rejects a non-buy DRP transaction before migration can repair it", () => {
  const d = wallet(); d.version = 3;
  d.holdings = [drpHolding("invalid-type", { transaction: { type: "gift" } })];
  const before = JSON.stringify(d);
  assert.ok(q.strictBackupPreflightErrors(d).some((message) => /must use a buy transaction/.test(message)));
  assert.equal(JSON.stringify(d), before);
});

test("share reconciliation records one atomic DRP event without external contribution", () => {
  const d = wallet();
  const h = {
    id: "reconcile", name: "Reconcile Co", currency: "EUR", price: 20, realizedSeed: 0, dividends: [],
    transactions: [tx("initial", "2025-07-01", "buy", "10", "10", 10)],
  };
  d.holdings = [h]; q.setDb(d);
  const result = q.upsertDividendReinvestment(h, {
    totalShares: "13", date: "2025-08-15", amount: "36", note: "DRP statement 42",
  });
  assert.equal(result.ok, true, result.message);
  assert.equal(h.transactions.length, 2); assert.equal(h.dividends.length, 1);
  assert.equal(result.event.transaction.origin, "drp");
  assert.equal(result.event.transaction.linkId, result.event.dividend.linkId);
  assert.equal(result.event.transaction.date, "2025-08-15");
  assert.equal(result.event.dividend.date, "2025-08-15");
  close(q.holdingMetrics(h).shares, 13);
  close(q.holdingMetrics(h).cost, 136);
  close(q.holdingMetrics(h).contributionCost, 100);
  close(q.positionAt(h, "2025-08").contributionCost, 100);
  close(q.dividendsInTaxYear("2025/26", false, "AU"), 36);
  const day = Date.parse("2025-08-15T00:00:00Z");
  const sameDay = Array.from(q.holdingFlows(h).filter((flow) => flow.t === day).map((flow) => flow.v)).sort((a, b) => a - b);
  assert.deepEqual(sameDay, [-36, 36]);
});

test("share reconciliation rejects future allocation dates without mutating the holding", () => {
  const d = wallet();
  const h = {
    id: "future-drp", name: "Future DRP", currency: "EUR", price: 20, realizedSeed: 0, dividends: [],
    transactions: [tx("initial", "2025-07-01", "buy", "10", "10", 10)],
  };
  d.holdings = [h]; q.setDb(d);
  const before = JSON.stringify(h);
  const tomorrow = q.localDateString(new Date(Date.now() + 86400000));
  const result = q.upsertDividendReinvestment(h, { totalShares: "13", date: tomorrow, amount: "36" });
  assert.equal(result.ok, false); assert.equal(result.message, "Allocation date cannot be in the future");
  assert.equal(JSON.stringify(h), before);
});

test("editing and undoing a DRP preserve linked row identity", () => {
  const d = wallet();
  const h = {
    id: "edit-drp", name: "Edit DRP", currency: "EUR", price: 20, realizedSeed: 0, dividends: [],
    transactions: [tx("initial", "2025-07-01", "buy", "10", "10", 10)],
  };
  d.holdings = [h]; q.setDb(d);
  const created = q.upsertDividendReinvestment(h, { totalShares: "13", date: "2025-08-15", amount: "36", note: "first" });
  assert.equal(created.ok, true, created.message);
  const ids = {
    link: created.event.linkId, transaction: created.event.transaction.id,
    dividend: created.event.dividend.id, sequence: created.event.transaction.sequence,
  };
  const beforeInvalid = JSON.stringify(h);
  const invalid = q.upsertDividendReinvestment(h, { totalShares: "9", date: "2025-08-15", amount: "36" }, ids.link);
  assert.equal(invalid.ok, false); assert.equal(JSON.stringify(h), beforeInvalid);
  const edited = q.upsertDividendReinvestment(h, { totalShares: "14", date: "2025-08-20", amount: "48", note: "corrected" }, ids.link);
  assert.equal(edited.ok, true, edited.message);
  assert.equal(edited.event.linkId, ids.link); assert.equal(edited.event.transaction.id, ids.transaction);
  assert.equal(edited.event.dividend.id, ids.dividend); assert.equal(edited.event.transaction.sequence, ids.sequence);
  assert.equal(edited.event.transaction.shares, "4"); assert.equal(edited.event.transaction.date, "2025-08-20");
  const removed = q.removeDividendReinvestment(h, ids.link);
  assert.ok(removed); assert.equal(h.transactions.length, 1); assert.equal(h.dividends.length, 0);
  assert.equal(q.restoreDividendReinvestment(h, removed), true);
  assert.equal(h.transactions[1].id, ids.transaction); assert.equal(h.dividends[0].id, ids.dividend);
  assert.equal(q.drpPairValidationErrors(d).length, 0);
});

test("reconciliation can link an existing dividend without counting it twice", () => {
  const d = wallet();
  const h = {
    id: "linked-existing", name: "Linked Existing", currency: "EUR", price: 20, realizedSeed: 0,
    transactions: [tx("initial", "2025-07-01", "buy", "10", "10", 10)],
    dividends: [{ id: "manual-dividend", month: "2025-08", amount: "36", note: "Already logged" }],
  };
  d.holdings = [h]; q.setDb(d);
  const result = q.upsertDividendReinvestment(h, {
    totalShares: "13", date: "2025-08-15", amount: "36", existingDividendId: "manual-dividend", note: "Already logged",
  });
  assert.equal(result.ok, true, result.message); assert.equal(h.dividends.length, 1);
  assert.equal(h.dividends[0].id, "manual-dividend"); assert.equal(h.dividends[0].origin, "drp");
  close(q.dividendsInTaxYear("2025/26", false, "AU"), 36);
});

test("backdated reconciliation leaves closed snapshots and archived tax frozen", () => {
  const d = wallet();
  const h = {
    id: "frozen-drp", name: "Frozen DRP", currency: "EUR", price: 20, realizedSeed: 0, dividends: [],
    transactions: [tx("initial", "2025-07-01", "buy", "10", "10", 10)],
  };
  d.holdings = [h];
  d.snapshots = [{ month: "2025-08", invest: 100, cost: 100, contributionCost: 100, holdings: {
    "frozen-drp": { shares: 10, buyPrice: 10, fees: 0, contributionCost: 100, price: 10, realized: 0, type: "stock", currency: "EUR", rate: 1 },
  }, accounts: {}, buckets: { Investments: 100 }, income: 0, expenses: 0, gross: 100, netWorth: 100 }];
  d.taxArchive = [{ ...wallet("2025/26").tax, sourceSnapshot: { version: 1, dividends: 0 }, invoices: [] }];
  q.setDb(d);
  const snapshotBefore = JSON.stringify(d.snapshots[0]), archiveBefore = JSON.stringify(d.taxArchive);
  const result = q.upsertDividendReinvestment(h, { totalShares: "13", date: "2025-08-15", amount: "36" });
  assert.equal(result.ok, true, result.message); q.repropagateHolding(h);
  assert.equal(JSON.stringify(d.snapshots[0]), snapshotBefore);
  assert.equal(JSON.stringify(d.taxArchive), archiveBefore);
});

test("base-currency rescaling updates frozen external contribution totals", () => {
  const d = wallet();
  d.snapshots = [{
    month: "2020-01", netWorth: 240, gross: 240, invest: 200, cost: 160, contributionCost: 120,
    holdings: { fund: { contributionCost: 60, rate: 2, mvBase: 200, costBase: 160 } },
    buckets: { Investments: 200 }, accounts: {}, rates: { EUR: 2 },
  }];
  q.setDb(d); q.rescaleFrozenSnapshots(2);
  close(d.snapshots[0].cost, 80); close(d.snapshots[0].contributionCost, 60);
  close(d.snapshots[0].holdings.fund.contributionCost, 60);
  close(d.snapshots[0].holdings.fund.rate, 1);
});

test("holding currency conversion keeps every frozen holding field internally consistent", () => {
  const d = wallet(); d.currencies.find((c) => c.code === "USD").rate = 0.8;
  const h = {
    id: "redenom", currency: "USD", price: 12, realizedSeed: 8,
    transactions: [tx("buy", "2025-01-01", "buy", 4, 10, 10, 2)],
    dividends: [{ id: "div", month: "2025-02", amount: 4 }],
  };
  const frozen = { shares: 4, buyPrice: 10, fees: 2, contributionCost: 40, price: 12, realized: 4, type: "stock", currency: "EUR", rate: 1, mvBase: 48, costBase: 42 };
  d.holdings = [h]; d.snapshots = [{
    month: "2025-02", rates: { EUR: 1, USD: 0.75 }, holdings: { redenom: frozen }, accounts: {},
    buckets: { Investments: 48 }, invest: 48, cost: 42, contributionCost: 40, unrealized: 6, realized: 4, gross: 48, netWorth: 48,
  }];
  q.setDb(d); assert.equal(q.convertHoldingCurrencyValues(h, "EUR", "USD"), true);
  close(h.transactions[0].price, 12.5); close(h.transactions[0].fees, 2.5); close(h.dividends[0].amount, 5); close(h.price, 15); close(h.realizedSeed, 10);
  assert.equal(frozen.currency, "USD"); close(frozen.rate, 0.75);
  close(frozen.buyPrice, 10 / 0.75); close(frozen.fees, 2 / 0.75); close(frozen.contributionCost, 40 / 0.75);
  close(frozen.price, 12 / 0.75); close(frozen.realized, 4 / 0.75);
  close(frozen.mvBase, 48); close(frozen.costBase, 42);
  close(d.snapshots[0].invest, 48); close(d.snapshots[0].netWorth, 48);
});

test("frozen account ownership projects consistently without mutating snapshots", () => {
  const d = wallet(); d.accounts = [{ id: "joint", name: "Joint", bucket: "Cash", currency: "USD", balance: 1000, joint: true, share: 25 }];
  const frozen = {
    month: "2025-08", rates: { EUR: 1, USD: 0.9 },
    accounts: { joint: { name: "Joint", bucket: "Cash", currency: "USD", balance: 1000, balanceBase: 450, share: 50 } },
    holdings: {}, buckets: { Cash: 450 }, gross: 450, netWorth: 350, debtsTotal: 100,
  };
  d.snapshots = [frozen]; q.setDb(d);
  const before = JSON.stringify(frozen);
  const mine = q.snapshotForView(frozen, "mine"), household = q.snapshotForView(frozen, "household");
  close(mine.buckets.Cash, 225); close(mine.gross, 225); close(mine.netWorth, 125);
  close(household.buckets.Cash, 900); close(household.gross, 900); close(household.netWorth, 800);
  assert.equal(JSON.stringify(frozen), before);
  q.setNetView("mine"); close(q.snapshotBucketsByCcy(frozen).Cash.USD, 250);
  q.setNetView("household"); close(q.snapshotBucketsByCcy(frozen).Cash.USD, 1000);
  q.setNetView("mine");
});

test("non-account financial wallets receive snapshots and backup protection", () => {
  const prev = q.prevMonthStr(q.currentMonth());
  const cases = [
    ["asset", (d) => { d.physicalAssets = [{ id: "home", value: 100000, currency: "EUR", includeInNetWorth: true, nwMode: "full" }]; }],
    ["debt", (d) => { d.debts = [{ id: "loan", name: "Loan", balance: 1000, currency: "EUR", apr: 0, payment: 0, logMode: "interest" }]; }],
    ["goal", (d) => { d.goals = [{ id: "goal", name: "Goal", cost: 1000, currency: "EUR", currentSavings: 10 }]; }],
    ["recurring", (d) => { d.recurring = [{ id: "rent", kind: "expense", category: "Housing", amount: 10, currency: "EUR", since: prev }]; }],
    ["tax", (d) => { d.tax.employmentIncome = 100; }],
    ["retirement", (d) => { d.retirement.salary = 100; }],
  ];
  for (const [name, populate] of cases) {
    const d = q.defaultDB(); d.setupComplete = true; d.meta.firstMonth = prev; d.settings.autoBackup = "monthly";
    populate(d); q.setDb(d);
    assert.equal(q.walletHasData(), true, `${name} should count as wallet data`);
    assert.equal(q.backupDue(), true, `${name} should be due for automatic backup`);
    assert.equal(q.backupOverdue(), true, `${name} should show the overdue-backup warning`);
    assert.equal(q.maybeAutoSnapshot(), true, `${name} should receive a month snapshot`);
    assert.ok(d.snapshots.some((s) => s.month === prev), `${name} snapshot missing`);
  }
});

test("frozen snapshot totals honor an explicitly edited external contribution cost", () => {
  const d = wallet();
  const s = {
    month: "2020-02", accounts: {}, buckets: {}, rates: { EUR: 1 }, holdings: {
      fund: { shares: 5, buyPrice: 10, fees: 0, contributionCost: 30, price: 12, realized: 0, type: "stock", currency: "EUR", rate: 1 },
    },
  };
  d.snapshots = [s]; q.setDb(d); q.recomputeSnapshot(s, null, true);
  close(s.cost, 50); close(s.contributionCost, 30); close(s.invest, 60);
});

test("sales reduce tax cost and external contribution proportionally after a DRP", () => {
  const d = wallet(); const h = drpHolding();
  h.transactions.unshift(tx("external", "2025-07-01", "buy", "10", "10", 5));
  h.transactions.push(tx("half-sale", "2025-09-01", "sell", "6.5", "20", 20));
  d.holdings = [h]; q.setDb(d);
  const metrics = q.holdingMetrics(h);
  close(metrics.shares, 6.5); close(metrics.cost, 100); close(metrics.contributionCost, 50);
});

test("benchmark and TWR treat a reinvested dividend as return, not new cash", () => {
  const d = wallet();
  d.meta.benchmarkHist = { ticker: "ACWI", monthly: { "2025-07": 10, "2025-08": 10, "2025-09": 10 } };
  q.setDb(d);
  const points = [
    { x: "Jul", m: "2025-07", y: 100, cost: 100 },
    { x: "Aug", m: "2025-08", y: 136, cost: 100 },
    { x: "Sep", m: "2025-09", y: 140, cost: 100 },
  ];
  assert.deepEqual(Array.from(q.benchmarkTrendValues(points)), [100, 100, 100]);
  close(q.portfolioTWR(points), 0.4);
});

test("Excel restore blocks linked DRP rows instead of flattening them", () => {
  const XLSX = { utils: { sheet_to_json: (sheet) => sheet.rows } };
  const linked = { SheetNames: ["Finance"], Sheets: { Finance: { "!ref": "A1:M2", rows: [
    ["Date", "Asset", "Action", "Shares", "Price", "Origin", "Link ID"],
    ["2025-08-15", "Fund", "Buy", 3, 12, "drp", "link-1"],
  ] } } };
  const ordinary = { SheetNames: ["Finance"], Sheets: { Finance: { "!ref": "A1:E2", rows: [
    ["Date", "Asset", "Action", "Shares", "Price"], ["2025-08-15", "Fund", "Buy", 3, 12],
  ] } } };
  const delayedRows = Array.from({ length: 24 }, (_, i) => [i === 0 ? "Broker export" : null]);
  delayedRows.push(["Date", "Asset", "Action", "Shares", "Price", "Origin", "Link ID"]);
  delayedRows.push(["2025-08-15", "Fund", "Buy", 3, 12, "drp", "link-after-preamble"]);
  const delayed = { SheetNames: ["Finance"], Sheets: { Finance: { "!ref": "A1:G26", rows: delayedRows } } };
  assert.equal(q.workbookContainsDrpRows(XLSX, linked), true);
  assert.equal(q.workbookContainsDrpRows(XLSX, delayed), true);
  assert.equal(q.workbookContainsDrpRows(XLSX, ordinary), false);
});

test("standalone backup validation enforces complete DRP pairs", () => {
  const valid = wallet(); valid.version = 3; valid.holdings = [drpHolding()];
  const validResult = runBackupValidator(valid);
  assert.equal(validResult.status, 0, validResult.stderr || validResult.stdout);

  const orphan = wallet(); orphan.version = 3; orphan.holdings = [drpHolding()]; orphan.holdings[0].dividends = [];
  const orphanResult = runBackupValidator(orphan);
  assert.notEqual(orphanResult.status, 0);
  assert.match(orphanResult.stderr, /DRP link .*exactly one buy transaction and one dividend/);

  const reused = wallet(); reused.version = 3;
  reused.holdings = [drpHolding("shared-link"), drpHolding("shared-link", { id: "drp-holding-2", name: "Other DRP holding" })];
  const reusedResult = runBackupValidator(reused);
  assert.notEqual(reusedResult.status, 0);
  assert.match(reusedResult.stderr, /DRP link shared-link needs exactly one buy transaction and one dividend/);

  const mismatched = wallet(); mismatched.version = 3;
  mismatched.holdings = [drpHolding("wrong-value", { dividend: { amount: "101" } })];
  const mismatchResult = runBackupValidator(mismatched);
  assert.notEqual(mismatchResult.status, 0);
  assert.match(mismatchResult.stderr, /DRP link wrong-value transaction value must match its dividend amount/);

  const malformedFees = wallet(); malformedFees.version = 3;
  malformedFees.holdings = [drpHolding("invalid-fees", { transaction: { fees: "garbage" } })];
  const malformedFeesResult = runBackupValidator(malformedFees);
  assert.notEqual(malformedFeesResult.status, 0);
  assert.match(malformedFeesResult.stderr, /DRP link invalid-fees transaction fees must be zero/);
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
