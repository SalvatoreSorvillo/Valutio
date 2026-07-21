import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../statement-categorizer.js", import.meta.url), "utf8");
const defaults = JSON.parse(fs.readFileSync(new URL("../Rules/statement-categorizer-defaults.json", import.meta.url), "utf8"));
const noop = () => {};
const document = {
  addEventListener: noop, createElement: () => ({}), getElementById: () => null,
  querySelector: () => null, querySelectorAll: () => [],
};
const preferences = {
  currency: "AUD",
  rules: {
    excludeKeywords: ["internal transfer"], refundKeywords: ["refund"],
    expenseRules: { Groceries: ["woolworths"], Other: [] },
    incomeRules: { Salary: ["payroll"], Other: [] },
  },
};
const sandbox = {
  console, document, Intl, Date, Math, JSON, Promise, Number, String, Object, Array,
  TextDecoder, Uint8Array, ArrayBuffer,
  setTimeout: noop, clearTimeout: noop,
  fetch: async () => ({ ok: true, json: async () => defaults }),
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: "statement-categorizer.js" });
let cashFlowRows = [];
await sandbox.ValutioStatementCategorizer.connect({
  context: () => ({
    baseCurrency: "AUD", country: "AU", currencies: ["AUD", "EUR"],
    expenseCategories: ["Groceries", "Other"], incomeCategories: ["Salary", "Other"], cashFlowRows,
  }),
  convertCurrency: (amount, from, to) => from === to ? amount : (from === "EUR" && to === "AUD" ? amount * 2 : amount / 2),
  preferences: () => preferences, savePreferences: noop, rerender: noop, toast: noop,
});
const q = sandbox.ValutioStatementCategorizer.test;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test("calendar date parser rejects impossible dates", () => {
  assert.equal(q.parseDate("31/02/2026"), "");
  assert.equal(q.parseDate("9 May 2026"), "2026-05-09");
  assert.equal(q.parseDate("2026-05-09"), "2026-05-09");
  assert.equal(q.parseDate("07/16/2026"), "2026-07-16");
  assert.equal(q.parseDate("Jul 16, 2026"), "2026-07-16");
  assert.equal(q.parseDate("16072026"), "2026-07-16");
  assert.equal(q.parseDate("20260716"), "2026-07-16");
  assert.equal(q.parseDate("2026-07-16T09:30:00Z"), "2026-07-16");
});

test("Westpac-style debit and credit CSV preserves compact dates", () => {
  const csv = "Account description,Account number,Currency,Date,Description of transaction,Debits,Credits,Balance\nEveryday,123,AUD,15072026,Coffee,12.50,,987.50\nEveryday,123,AUD,16072026,Payroll,,2000.00,2987.50\n";
  const rows = q.parseStatementCsv(csv, { id: "westpac", name: "westpac.csv", accountType: "Personal" });
  assert.deepEqual(Array.from(rows, (r) => [r.date, r.kind, r.amount, r.description]), [
    ["2026-07-15", "expense", 12.5, "Coffee"],
    ["2026-07-16", "income", 2000, "Payroll"],
  ]);
});

test("signed headerless CSV and US dates are inferred safely", () => {
  const csv = "07/15/2026,-12.50,Coffee,987.50\n07/16/2026,2000.00,Payroll,2987.50\n";
  const rows = q.parseStatementCsv(csv, { id: "signed", name: "activity.csv", accountType: "Personal" });
  assert.deepEqual(Array.from(rows, (r) => [r.date, r.kind, r.amount]), [
    ["2026-07-15", "expense", 12.5], ["2026-07-16", "income", 2000],
  ]);
});

test("US account activity CSV uses month-first dates and flow labels", () => {
  const csv = "Posting Date,Description,Amount,Type,Currency\n07/15/2026,Coffee shop,12.50,Debit,USD\n07/16/2026,Payroll,2000.00,Credit,USD\n";
  const rows = q.parseStatementCsv(csv, { id: "us", name: "activity.csv", accountType: "Personal" });
  assert.deepEqual(Array.from(rows, (r) => [r.date, r.kind, r.amount, r.currency]), [
    ["2026-07-15", "expense", 12.5, "USD"], ["2026-07-16", "income", 2000, "USD"],
  ]);
});

test("UK transaction CSV recognises debit and credit amount columns", () => {
  const csv = "Transaction Date,Transaction Description,Debit Amount,Credit Amount,Balance\n15/07/2026,Coffee shop,12.50,,987.50\n16/07/2026,Payroll,,2000.00,2987.50\n";
  const rows = q.parseStatementCsv(csv, { id: "uk", name: "transactions.csv", accountType: "Joint" });
  assert.deepEqual(Array.from(rows, (r) => [r.date, r.kind, r.amount, r.accountType]), [
    ["2026-07-15", "expense", 12.5, "Joint"], ["2026-07-16", "income", 2000, "Joint"],
  ]);
});

test("multi-currency CSV accepts ISO timestamps and signed amounts", () => {
  const csv = "Completed Date,Type,Description,Amount,Currency\n2026-07-15T09:30:00Z,CARD_PAYMENT,Coffee shop,-12.50,EUR\n2026-07-16T10:00:00Z,TRANSFER,Client payment,2000.00,EUR\n";
  const rows = q.parseStatementCsv(csv, { id: "multi", name: "statement.csv", accountType: "Personal" });
  assert.deepEqual(Array.from(rows, (r) => [r.date, r.kind, r.amount, r.currency]), [
    ["2026-07-15", "expense", 12.5, "EUR"], ["2026-07-16", "income", 2000, "EUR"],
  ]);
});

test("European semicolon CSV keeps decimal commas inside amount fields", () => {
  const csv = "Date;Description;Debit;Credit;Currency\n15.07.2026;Caffe Roma;12,50;;EUR\n16.07.2026;Stipendio;;2.000,00;EUR\n";
  const rows = q.parseStatementCsv(csv, { id: "eu", name: "conto.csv", accountType: "Personal" });
  assert.deepEqual(Array.from(rows, (r) => [r.date, r.kind, r.amount, r.description]), [
    ["2026-07-15", "expense", 12.5, "Caffe Roma"], ["2026-07-16", "income", 2000, "Stipendio"],
  ]);
});

test("generic PDF fallback recognises signed and sectioned statement rows", () => {
  const text = [
    "Payments and other debits",
    "07/15/2026 Coffee shop 12.50 987.50",
    "Credits and deposits",
    "07/16/2026 Payroll 2,000.00 2,987.50",
    "2026-07-17 Card purchase -45.25 2,942.25",
  ].join("\n");
  const rows = q.parseGenericPdfText(text, { id: "generic", name: "statement.pdf", accountType: "Personal" });
  assert.deepEqual(Array.from(rows, (r) => [r.date, r.kind, r.amount, r.description]), [
    ["2026-07-15", "expense", 12.5, "Coffee shop"],
    ["2026-07-16", "income", 2000, "Payroll"],
    ["2026-07-17", "expense", 45.25, "Card purchase"],
  ]);
});

test("money parser handles decimal comma and accounting negatives", () => {
  assert.equal(q.money("A$1,234.56"), 1234.56);
  assert.equal(q.money("(1.234,56 EUR)"), -1234.56);
});

test("CSV parser preserves debit, credit and joint ownership", () => {
  const csv = "Date,Description,Money Out,Money In,Currency\n09/05/2026,Woolworths,45.50,,AUD\n10/05/2026,Payroll,,3100,AUD\n";
  const rows = q.parseStatementCsv(csv, { id: "file", name: "joint.csv", accountType: "Joint" });
  assert.equal(rows.length, 2);
  assert.deepEqual(Array.from(rows, (r) => r.kind), ["expense", "income"]);
  assert.ok(rows.every((r) => r.accountType === "Joint" && r.currency === "AUD"));
});

test("ING interim PDF rows preserve withdrawals and deposits", () => {
  const text = [
    "01 Jul 2026 UBER *EATS HELP.UBER.COM -$27.78 $10,369.72",
    "03 Jul 2026 ACCOUNT CREDIT $161.09 $252.80",
    "14 Jul 2026 SALARY CREDIT $5,124.47 $5,140.62",
  ].join("\n");
  const rows = q.parseIngText(text, { id: "pdf", name: "ing.pdf", accountType: "Personal" });
  assert.equal(rows.length, 3);
  assert.deepEqual(Array.from(rows, (r) => [r.date, r.kind, r.amount]), [
    ["2026-07-01", "expense", 27.78],
    ["2026-07-03", "income", 161.09],
    ["2026-07-14", "income", 5124.47],
  ]);
  assert.deepEqual(Array.from(rows, (r) => r.description), [
    "UBER *EATS HELP.UBER.COM", "ACCOUNT CREDIT", "SALARY CREDIT",
  ]);
});

test("rule categorisation excludes transfers and marks refunds", () => {
  const file = { id: "file", name: "personal.csv", accountType: "Personal" };
  const csv = "Date,Description,Money Out,Money In\n09/05/2026,Woolworths,45.50,\n10/05/2026,Internal transfer,100,\n11/05/2026,Woolworths refund,5,\n12/05/2026,Payroll,,3100\n";
  const rows = q.classify(q.parseStatementCsv(csv, file), "2026-05-01", "2026-05-31");
  assert.equal(rows.length, 3);
  assert.equal(rows[0].category, "Groceries");
  assert.equal(rows[1].amount, -5); assert.equal(rows[1].category, "Groceries");
  assert.equal(rows[2].category, "Salary");
});

test("apply rows preserve transactions while netting a matching refund", () => {
  const file = { id: "file", name: "joint.csv", accountType: "Joint" };
  const csv = "Date,Description,Money Out,Money In\n09/05/2026,Woolworths,45.50,\n10/05/2026,Woolworths,20.00,\n11/05/2026,Woolworths refund,5,\n12/05/2026,Payroll,,3100\n";
  const rows = q.classify(q.parseStatementCsv(csv, file), "2026-05-01", "2026-05-31");
  q.setTransactions(rows);
  const applied = q.buildApplyRows();
  assert.equal(applied.length, 3);
  const expenses = applied.filter((row) => row.kind === "expense"), income = applied.find((row) => row.kind === "income");
  assert.deepEqual(Array.from(expenses, (row) => row.amount), [45.5, 15]);
  assert.ok(expenses.every((row) => row.accountType === "Joint" && row.note === "Woolworths"));
  assert.equal(income.amount, 3100);
  assert.equal(new Set(applied.map((row) => row.sourceKey)).size, 3);
  assert.ok(applied.every((row) => /^statement:/.test(row.sourceKey)));
});

test("identical statement lines receive distinct stable apply keys", () => {
  const file = { id: "file", name: "personal.csv", accountType: "Personal" };
  const csv = "Date,Description,Money Out,Money In\n09/05/2026,Coffee,5.00,\n09/05/2026,Coffee,5.00,\n";
  const rows = q.parseStatementCsv(csv, file);
  rows.forEach((row) => { row.category = "Other"; });
  q.setTransactions(rows);
  const applied = q.buildApplyRows();
  assert.equal(applied.length, 2);
  assert.notEqual(applied[0].sourceKey, applied[1].sourceKey);
});

test("manual All category includes every flow and category", () => {
  const file = { id: "filters", name: "filters.csv", accountType: "Personal" };
  const rows = q.parseStatementCsv("Date,Description,Money Out,Money In\n09/05/2026,Woolworths,10,\n10/05/2026,Payroll,,100\n", file);
  rows[0].category = "Groceries"; rows[1].category = "Salary";
  q.setTransactions(rows);
  q.setManualFilters({ fromCategory: q.allCategoriesValue, accountFilter: "all", directionFilter: "all", search: "" });
  assert.equal(q.filteredTransactions("manual").length, 2);
  assert.match(q.sourceCategoryOptions(q.allCategoriesValue), />All<\/option>/);
});

test("manual move cannot assign one category to mixed flows", () => {
  const file = { id: "mixed", name: "mixed.csv", accountType: "Personal" };
  const rows = q.parseStatementCsv("Date,Description,Money Out,Money In\n09/05/2026,Woolworths,10,\n10/05/2026,Payroll,,100\n", file);
  rows[0].category = "Groceries"; rows[1].category = "Salary";
  q.setTransactions(rows); q.setSelected(rows.map((row) => row.id)); q.moveSelected("Other");
  assert.deepEqual(Array.from(rows, (row) => row.category), ["Groceries", "Salary"]);
});

test("Set Income clears Needs review with a valid income category", () => {
  const file = { id: "set-income", name: "set-income.csv", accountType: "Personal" };
  const rows = q.parseStatementCsv("Date,Description,Money Out,Money In\n09/05/2026,Client payment,,100\n", file);
  rows[0].category = "Needs review";
  q.setTransactions(rows); q.setSelected([rows[0].id]); q.setKindForSelected("income");
  assert.equal(rows[0].kind, "income");
  assert.equal(rows[0].category, "Other");
  assert.notEqual(rows[0].category, "Needs review");
});

test("click-style row selection toggles the same state used by the checkbox", () => {
  const file = { id: "row-select", name: "row-select.csv", accountType: "Personal" };
  const rows = q.parseStatementCsv("Date,Description,Money Out,Money In\n09/05/2026,Coffee,5,\n", file);
  rows[0].category = "Other";
  q.setTransactions(rows); q.setSelected([]); q.toggleSelected(rows[0].id);
  q.setKindForSelected("income");
  assert.equal(rows[0].kind, "income");
  q.setSelected([]); q.toggleSelected(rows[0].id);
  q.setKindForSelected("expense");
  assert.equal(rows[0].kind, "expense");
  q.setSelected([]); q.toggleSelected(rows[0].id); q.toggleSelected(rows[0].id);
  q.setKindForSelected("income");
  assert.equal(rows[0].kind, "expense");
});

test("quoted delimiters and CR DR markers preserve descriptions and direction", () => {
  const csv = 'Date,Description,Amount,Type,Currency\n15/07/2026,"Cafe, lunch",12.50,DR,AUD\n16/07/2026,"Client; payment",200.00,CR,AUD\n';
  const rows = q.parseStatementCsv(csv, { id: "quoted", name: "quoted.csv", accountType: "Personal" });
  assert.deepEqual(Array.from(rows, (row) => [row.description, row.kind]), [["Cafe, lunch", "expense"], ["Client; payment", "income"]]);
});

test("UTF-16 and Windows-1252 CSV files decode locally", async () => {
  function fileFromBytes(name, bytes) {
    return { name, type: "text/csv", arrayBuffer: async () => Uint8Array.from(bytes).buffer };
  }
  const base = "Date,Description,Money Out,Money In\n15/07/2026,Cafe,12.50,\n";
  const utf16 = Buffer.from("\ufeff" + base, "utf16le");
  const utfRows = await q.parseFile({ id: "utf16", name: "utf16.csv", accountType: "Personal", file: fileFromBytes("utf16.csv", utf16) });
  assert.equal(utfRows.length, 1); assert.equal(utfRows[0].amount, 12.5);
  const cpText = "Date,Description,Money Out,Money In\n15/07/2026,Caf\u00e9,12.50,\n";
  const cpBytes = Buffer.from(cpText, "latin1");
  const cpRows = await q.parseFile({ id: "cp", name: "cp.csv", accountType: "Personal", file: fileFromBytes("cp.csv", cpBytes) });
  assert.equal(cpRows[0].description, "Caf\u00e9");
});

test("PDF page furniture is not merged into named-date ING transactions", () => {
  const text = [
    "01 Jul 2026 COFFEE SHOP -$5.00 $995.00", "Page 1 of 2", "Statement continued over",
    "02 Jul 2026 GROCERY STORE -$20.00 $975.00",
  ].join("\n");
  const rows = q.parseIngText(text, { id: "pages", name: "pages.pdf", accountType: "Personal" });
  assert.deepEqual(Array.from(rows, (row) => row.description), ["COFFEE SHOP", "GROCERY STORE"]);
});

test("reversals can span purchases without combining surviving rows", () => {
  const file = { id: "reversal", name: "reversal.csv", accountType: "Personal" };
  const csv = "Date,Description,Money Out,Money In\n09/05/2026,Woolworths,10,\n10/05/2026,Woolworths,10,\n11/05/2026,Woolworths refund,15,\n";
  const rows = q.classify(q.parseStatementCsv(csv, file), "2026-05-01", "2026-05-31");
  q.setTransactions(rows);
  assert.deepEqual(Array.from(q.buildApplyRows(), (row) => row.amount), [5]);
});

test("a reversal larger than matching purchases is forced back to review", () => {
  const file = { id: "large-reversal", name: "large-reversal.csv", accountType: "Personal" };
  const csv = "Date,Description,Money Out,Money In\n09/05/2026,Woolworths,10,\n11/05/2026,Woolworths refund,15,\n";
  const rows = q.classify(q.parseStatementCsv(csv, file), "2026-05-01", "2026-05-31");
  assert.equal(rows[1].category, "Needs review");
  assert.equal(rows[1].notes, "Reversal exceeds matching expenses");
  q.setTransactions(rows);
  assert.deepEqual(Array.from(q.buildApplyRows(), (row) => row.amount), [10]);
});

test("renamed and overlapping statements produce one apply row", () => {
  const csv = "Date,Description,Money Out,Money In\n09/05/2026,Coffee,5.00,\n";
  const first = q.parseStatementCsv(csv, { id: "one", name: "may.csv", accountType: "Personal" });
  const second = q.parseStatementCsv(csv, { id: "two", name: "renamed.csv", accountType: "Personal" });
  first.concat(second).forEach((row) => { row.category = "Other"; });
  q.setTransactions(first.concat(second));
  assert.equal(q.buildApplyRows().length, 1);
});

test("overlapping statements do not apply a reversal twice", () => {
  const csv = "Date,Description,Money Out,Money In\n09/05/2026,Woolworths,10.00,\n10/05/2026,Woolworths refund,5.00,\n";
  const first = q.parseStatementCsv(csv, { id: "overlap-a", name: "first.csv", accountType: "Personal" });
  const second = q.parseStatementCsv(csv, { id: "overlap-b", name: "second.csv", accountType: "Personal" });
  const rows = q.classify(first.concat(second), "2026-05-01", "2026-05-31");
  assert.equal(rows.length, 2);
  q.setTransactions(rows);
  assert.deepEqual(Array.from(q.buildApplyRows(), (row) => row.amount), [5]);
});

test("a later overlapping reversal keeps the original transaction source key", () => {
  const purchaseCsv = "Date,Description,Money Out,Money In\n09/05/2026,Woolworths,10.00,\n";
  const revisedCsv = purchaseCsv + "10/05/2026,Woolworths refund,5.00,\n";
  const first = q.classify(q.parseStatementCsv(purchaseCsv, { id: "early", name: "early.csv", accountType: "Personal" }), "2026-05-01", "2026-05-31");
  q.setTransactions(first); const original = q.buildApplyRows()[0];
  const revised = q.classify(q.parseStatementCsv(revisedCsv, { id: "later", name: "later.csv", accountType: "Personal" }), "2026-05-01", "2026-05-31");
  q.setTransactions(revised); const adjusted = q.buildApplyRows()[0];
  assert.equal(original.sourceKey, adjusted.sourceKey);
  assert.equal(original.amount, 10); assert.equal(adjusted.amount, 5);
});

test("summary and reconciliation never add different currencies or months together", () => {
  const aud = q.parseStatementCsv("Date,Description,Money Out,Money In,Currency\n09/05/2026,Coffee,10,,AUD\n", { id: "aud", name: "aud.csv", accountType: "Personal" })[0];
  const eur = q.parseStatementCsv("Date,Description,Money Out,Money In,Currency\n09/06/2026,Coffee,10,,EUR\n", { id: "eur", name: "eur.csv", accountType: "Personal" })[0];
  aud.category = eur.category = "Other";
  q.setTransactions([aud, eur]);
  assert.equal(q.summaryRows().length, 2);
  assert.equal(q.totals().expense, 30);
  cashFlowRows = [{ kind: "expense", accountType: "Personal", category: "Other", amount: 10, month: "2026-05", currency: "AUD" }];
  const reconciliation = q.worksheetRows("full").Reconciliation;
  assert.equal(reconciliation.length, 3);
  assert.deepEqual(Array.from(reconciliation[1].slice(5)), [10, 10, 0]);
  assert.deepEqual(Array.from(reconciliation[2].slice(5)), [10, 0, 10]);
  cashFlowRows = [];
});

test("invalid rows are rejected and 10,000 valid rows remain separate", () => {
  const bad = q.parseStatementCsv("Date,Description,Amount\n31/02/2026,Bad date,-10\n15/07/2026,Bad amount,nope\n", { id: "bad", name: "bad.csv", accountType: "Personal" });
  assert.equal(bad.length, 0);
  const lines = ["Date,Description,Money Out,Money In"];
  for (let i = 0; i < 10000; i++) lines.push(`15/07/2026,Purchase ${i},1.00,`);
  const rows = q.parseStatementCsv(lines.join("\n"), { id: "large", name: "large.csv", accountType: "Personal" });
  rows.forEach((row) => { row.category = "Other"; });
  q.setTransactions(rows);
  assert.equal(rows.length, 10000);
  assert.equal(q.buildApplyRows().length, 10000);
});

let failed = 0;
for (const item of tests) {
  try { await item.fn(); console.log("PASS", item.name); }
  catch (error) { failed++; console.error("FAIL", item.name, "-", error.message); }
}
console.log(`${tests.length - failed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
