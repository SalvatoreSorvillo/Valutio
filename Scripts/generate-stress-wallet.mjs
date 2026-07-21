#!/usr/bin/env node
import fs from "node:fs";

const out = process.argv[2] || "Docs/stress-wallet.json";
const now = new Date().toISOString();
const id = (prefix, n) => `${prefix}-${String(n).padStart(4, "0")}`;
const months = [];
for (let y = 2022; y <= 2026; y++) {
  for (let m = 1; m <= 12; m++) months.push(`${y}-${String(m).padStart(2, "0")}`);
}

const currencies = [
  { code: "EUR", symbol: "EUR", rate: 1 },
  { code: "AUD", symbol: "A$", rate: 0.61 },
  { code: "USD", symbol: "$", rate: 0.92 },
  { code: "GBP", symbol: "GBP", rate: 1.17 },
];

const incomes = [];
const expenses = [];
months.forEach((month, i) => {
  incomes.push({ id: id("inc", i), month, category: "Salary", amount: 4200 + (i % 7) * 80, currency: "EUR", note: "Stress salary" });
  incomes.push({ id: id("inc-freelance", i), month, category: "Freelancing", amount: 300 + (i % 5) * 110, currency: i % 2 ? "AUD" : "EUR", note: "Stress invoice income" });
  ["Rent", "Groceries", "Transport", "Health", "Dining out", "Subscriptions"].forEach((cat, c) => {
    expenses.push({ id: id(`exp-${c}`, i), month, category: cat, amount: 45 + c * 70 + (i % 4) * 11, currency: c % 2 ? "AUD" : "EUR", note: "Stress expense", joint: c === 0, share: c === 0 ? 50 : 100 });
  });
});

const holdings = [
  { id: "hold-vwce", name: "VWCE", ticker: "VWCE.DE", apiSymbol: "VWCE.DE", type: "etf", currency: "EUR", price: 166, transactions: [], dividends: [], realizedSeed: 0 },
  { id: "hold-aapl", name: "Apple", ticker: "AAPL", apiSymbol: "AAPL", type: "stock", currency: "USD", price: 230, transactions: [], dividends: [], realizedSeed: 0 },
  { id: "hold-btc", name: "Bitcoin", ticker: "BTC", coingeckoId: "bitcoin", type: "crypto", currency: "EUR", price: 58000, transactions: [], dividends: [], realizedSeed: 0 },
];
months.forEach((month, i) => {
  const date = `${month}-15`, sequence = (i + 1) * 100;
  holdings[0].transactions.push({ id: id("vwce-buy", i), month, date, datePrecision: "day", sequence, type: "buy", shares: 2 + (i % 3), price: 90 + i * 0.7, fees: 1 });
  if (i % 9 === 8) holdings[0].transactions.push({ id: id("vwce-sell", i), month, date, datePrecision: "day", sequence: sequence + 10, type: "sell", shares: 3, price: 100 + i, fees: 1 });
  if (i % 2 === 0) holdings[1].transactions.push({ id: id("aapl-buy", i), month, date, datePrecision: "day", sequence, type: "buy", shares: 1, price: 130 + i * 0.9, fees: 0.5 });
  if (i % 6 === 0) holdings[2].transactions.push({ id: id("btc-buy", i), month, date, datePrecision: "day", sequence, type: "buy", shares: "0.015", price: 25000 + i * 400, fees: 2 });
});

const invoices = months.filter((month, i) => i % 3 === 0 && month >= "2025-07" && month <= "2026-06").map((month, i) => ({
  id: id("invoice", i),
  date: `${month}-15`,
  taxYear: "2025/26",
  amount: 900 + i * 30,
  currency: i % 2 ? "AUD" : "EUR",
  note: `Stress invoice ${i + 1}`,
}));

const db = {
  version: 2,
  setupComplete: true,
  meta: { lastBackup: Date.now(), backupSnooze: 0, customYears: [], customMonths: [], lastNotifyMonth: "", recurringApplied: {} },
  settings: {
    name: "Stress Wallet", baseCurrency: "EUR", secondaryCurrency: "AUD", theme: "light", language: "en", snapshotMode: "auto", country: "AU",
    stockProvider: "yahoo", stockApiKey: "", cryptoProvider: "coingecko", cryptoApiKey: "",
    dashCards: ["accounts", "investments", "nwGrowth", "taxes"], invCards: ["costBasis", "costMonth", "totalReturn", "totalRealized"],
    colors: { bucket: {}, holdingType: {}, expense: {}, income: {}, asset: {}, debt: {} }, targetAlloc: {}, notifications: false, autoBackup: "off", backupFolderName: "",
  },
  currencies,
  accounts: [
    { id: "acc-cash", name: "Checking", bucket: "Cash", balance: 12000, currency: "EUR" },
    { id: "acc-save", name: "Savings", bucket: "Savings", balance: 18000, currency: "AUD", joint: true, share: 50 },
  ],
  holdings,
  holdingTypes: [
    { key: "stock", label: "Stock", color: "#438cff" },
    { key: "etf", label: "ETF", color: "#438cff" },
    { key: "bond", label: "Bond", color: "#54bd8f" },
    { key: "commodity", label: "Commodity", color: "oklch(0.68 0.14 255)" },
    { key: "crypto", label: "Crypto", color: "oklch(0.74 0.10 210)" },
  ],
  physicalAssets: [],
  expenseCategories: ["Rent", "Bills", "Subscriptions", "Groceries", "Dining out", "Transport", "Entertainment", "Travel", "Health", "Clothes", "Debt payments", "Other"],
  incomeCategories: ["Salary", "Freelancing", "Interests", "Cashback", "Other"],
  expenses,
  incomes,
  goals: [{ id: "goal-japan", name: "Trip to Japan", cost: 8000, currency: "EUR", targetMonth: "2027-06", currentSavings: 1600 }],
  recurring: [],
  retirement: { salary: 85000, employerExtra: 0, voluntary: 350 },
  debts: [{ id: "debt-card", name: "Credit Card", type: "card", balance: 2600, currency: "EUR", apr: 18, payment: 300, logMode: "interest", lastClose: "" }],
  snapshots: [],
  taxArchive: [],
  tax: {
    year: "2025/26", country: "AU", currency: "AUD", taxFreeThreshold: 18200,
    brackets: [{ upTo: 45000, rate: 0.16 }, { upTo: 135000, rate: 0.30 }, { upTo: 190000, rate: 0.37 }, { upTo: null, rate: 0.45 }],
    levyRate: 0.02, levyLabel: "Levy", capitalGainsRate: 0.20, capitalGainsDiscount: 0.50, capitalGainsDiscountMonths: 12,
    capitalLossCarryIn: 0, capitalLossCarryOut: 0, sourceSnapshot: null,
    deductions: 0, employmentIncome: 85000, employmentTaxPaid: 18000, otherIncome: 0, invoices, adjustments: [],
  },
  generatedAt: now,
};

fs.mkdirSync(new URL("../Docs/", import.meta.url), { recursive: true });
fs.writeFileSync(out, JSON.stringify(db, null, 2));
console.log(`Wrote ${out}`);
