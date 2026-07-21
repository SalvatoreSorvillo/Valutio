/* ============================================================
   Valutio: local-first net worth / investment / expenses / tax tracker
   No framework, no build step. Data lives in IndexedDB (localStorage fallback).

   Copyright (C) 2026 Salvatore Sorvillo
   This program is free software: you can redistribute it and/or modify it under
   the terms of the GNU Affero General Public License as published by the Free
   Software Foundation, either version 3 of the License, or (at your option) any
   later version. It is distributed WITHOUT ANY WARRANTY; without even the implied
   warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
   AGPL for details <https://www.gnu.org/licenses/>, or the LICENSE file.
   ============================================================ */

(function () {

  // Reveal Material Symbol glyphs only once the icon font is ready, so they never
  // flash as ligature text on first paint (before the webfont registers). Safety
  // timeout reveals them anyway if the font stalls or the API is unavailable.
  (function () {
    var el = document.documentElement;
    function ready() { el.classList.add("fonts-ready"); }
    if (document.fonts && document.fonts.load) {
      document.fonts.load("500 24px 'Material Symbols Rounded'").then(ready, ready);
      setTimeout(ready, 4000);
    } else { ready(); }
  })();
  "use strict";

  // ----------------------------------------------------------
  // Storage
  // ----------------------------------------------------------
  var KEY = "wallet_app_v1";

  function defaultDB() {
    return {
      version: 2,
      setupComplete: false,
      meta: { lastBackup: 0, backupSnooze: 0, customYears: [], customMonths: [], lastNotifyMonth: "", recurringApplied: {} },
      settings: {
        name: "Valutio",
        icon: "",
        baseCurrency: "",
        secondaryCurrency: "", // None by default
        theme: "dark",
        language: "en", // en | it - display language only; saved separately from wallet data
        snapshotMode: "auto", // manual | auto (auto = month-end snapshot when app is open); Automatic by default
        country: "AU", // baseline country for tax presets (see TAX_PRESETS)
        stockProvider: "yahoo", // yahoo (keyless, default) | finnhub | twelvedata | alphavantage
        stockApiKey: "",
        cryptoProvider: "coingecko", // coingecko (keyless, default) | binance | coinmarketcap | cryptocompare
        cryptoApiKey: "",
        // Which metric each of the 4 header KPI slots shows (see DASH_REG / INV_REG). User-swappable via the corner caret.
        dashCards: ["accounts", "investments", "nwGrowth", "taxes"],
        invCards: ["costBasis", "costMonth", "totalReturn", "totalRealized"],
        // Per-entity color overrides (Settings → Colors). domain -> key -> swatch; empty = built-in default.
        colors: { bucket: {}, holdingType: {}, expense: {}, income: {}, asset: {}, debt: {} },
        // Rebalancing targets: holding-type key -> target % of portfolio market value (Investments page).
        targetAlloc: {},
        // Reminders + backups
        notifications: false,   // monthly local reminder via the Notification API (this device only)
        autoBackup: "off",      // off | weekly | monthly - silent backup to a chosen folder (File System Access)
        backupFolderName: "",   // display name of the chosen backup folder, if any
        // Statement categoriser preferences and matching rules. Raw imported files and
        // reviewed statement rows are session-only and are never stored in the wallet.
        statementCategorizer: { currency: "", rules: null },
      },
      // rate = how many BASE units 1 unit of this currency is worth.
      // Only the base currency by default (secondary display defaults to None).
      currencies: [],
      // bucket: Cash | Savings | Pension | Other
      accounts: [],
      // type references a holdingTypes key ; priceSource: manual | crypto
      holdings: [],
      holdingTypes: [
        { key: "stock", label: "Stock", color: "#438cff" },
        { key: "etf", label: "ETF", color: "#438cff" },
        { key: "bond", label: "Bond", color: "#54bd8f" },
        { key: "commodity", label: "Commodity", color: "oklch(0.68 0.14 255)" },
        { key: "crypto", label: "Crypto", color: "oklch(0.74 0.10 210)" },
        { key: "realestate", label: "Real Estate", color: "#56b6c2" },
      ],
      // physical / non-liquid assets (car, house, art...) tracked manually
      physicalAssets: [], // {id, name, category, value, currency, includeInNetWorth, nwMode:'equity'|'full'} - equity (default) counts value minus any linked loan
      expenseCategories: ["Rent", "Bills", "Subscriptions", "Groceries", "Dining out",
        "Transport", "Entertainment", "Travel", "Health", "Clothes", "Debt payments", "Other"],
      incomeCategories: ["Salary", "Freelancing", "Interests", "Cashback", "Other"],
      expenses: [], // {id, month, category, amount, currency, note}
      incomes: [],  // {id, month, category, amount, currency, note}
      goals: [],    // {id, name, cost, currency, targetMonth 'YYYY-MM'}
      recurring: [], // {id, kind:'expense'|'income', category, amount, currency, note, joint, share, since 'YYYY-MM'} - monthly auto-logged cash flow
      retirement: { salary: 0, employerExtra: 0, voluntary: 0 }, // saved inputs for the retirement projection; balance is derived from pension accounts
      debts: [],    // {id, name, type, balance, currency, apr, payment, propertyAssetId, logMode:'interest'|'full', lastClose} - liabilities; subtract from net worth, amortize + log on close
      snapshots: [], // {month, date, netWorth, gross, invest, cost, unrealized, realized, buckets, expenses, income}
      // archived (frozen) past tax years, each a full copy of the tax object below
      taxArchive: [],
      tax: {
        year: auFYLabel(),  // e.g. "2025/26" (AU financial year, Jul-Jun)
        country: "AU",      // the country whose fiscal-year window this record uses (archived years keep their own)
        currency: "",
        taxFreeThreshold: 18200,
        brackets: [
          { upTo: 45000, rate: 0.16 },
          { upTo: 135000, rate: 0.30 },
          { upTo: 190000, rate: 0.37 },
          { upTo: null, rate: 0.45 },
        ],
        levyRate: 0.02,
        levyLabel: "Levy",
        capitalGainsRate: 0.20, // reserve on unrealized investment gains (% set aside)
        capitalGainsDiscount: 0.50, // fraction of REALIZED gains excluded from taxable income (AU default)
        capitalGainsDiscountMonths: 12, // min holding period for that discount (AU: >12 months)
        deductions: 0,
        employmentIncome: 0,
        employmentTaxPaid: 0,
        otherIncome: 0,
        capitalLossCarryIn: 0,
        capitalLossCarryOut: 0,
        sourceSnapshot: null,
        invoices: [], // {id, date, amount, currency, note}
        // user-defined extra adjustments to the tax total
        // {id, name, type:'add'|'deduct', mode:'fixed'|'percent', value}
        adjustments: [],
      },
    };
  }

  // ---- Persistence: IndexedDB (durable, large, eviction-resistant) is the source of truth, with a one-time
  // localStorage migration and a localStorage fallback when IDB is unavailable (private mode / quota). The
  // in-memory `db` stays synchronous and so does save(); only the initial LOAD is async (see Boot at the
  // bottom), which keeps the rest of the app unchanged. ----
  var IDB_NAME = "valutio", IDB_STORE = "kv", _idbPromise = null;
  function idbOpen() {
    if (_idbPromise) return _idbPromise;
    _idbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore(IDB_STORE); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
      req.onblocked = function () { reject(new Error("idb blocked")); };
    });
    return _idbPromise;
  }
  function idbGet(key) {
    return idbOpen().then(function (d) {
      return new Promise(function (resolve, reject) {
        var r = d.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).get(key);
        r.onsuccess = function () { resolve(r.result); };
        r.onerror = function () { reject(r.error); };
      });
    });
  }
  function idbSet(key, val) {
    return idbOpen().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).put(val, key);
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error("idb abort")); };
      });
    });
  }
  // Synchronous in-memory db; the real persisted data is loaded into it from IndexedDB at boot.
  var db = defaultDB();
  var storageRecoveryNotice = "";
  function quarantineCorruptStore(source, raw) {
    try {
      var key = KEY + "_corrupt_" + Date.now();
      localStorage.setItem(key, typeof raw === "string" ? raw : JSON.stringify(raw));
      storageRecoveryNotice = source + " data looked damaged. A recovery copy was saved locally under " + key + ".";
    } catch (e) {
      storageRecoveryNotice = source + " data looked damaged and could not be opened. Restore from a JSON backup if the wallet looks empty.";
    }
  }
  // Always resolves: IndexedDB -> one-time localStorage migration -> fresh defaultDB.
  function loadAsync() {
    return idbGet(KEY).then(function (v) {
      if (v != null) { try { return migrate(typeof v === "string" ? JSON.parse(v) : v); } catch (e) { quarantineCorruptStore("IndexedDB", v); } }
      return migrateFromLocal();
    }).catch(function () { return migrateFromLocal(); });
  }
  function migrateFromLocal() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) {
        var d = migrate(JSON.parse(raw));
        idbSet(KEY, JSON.stringify(d)).catch(function () { });   // seed IDB so subsequent boots read from it
        return d;
      }
    } catch (e) { try { quarantineCorruptStore("localStorage", localStorage.getItem(KEY)); } catch (e2) { } }
    return defaultDB();
  }
  function migrate(d) {
    var def = defaultDB();
    for (var k in def) if (!(k in d)) d[k] = def[k];
    if (!d.tax) d.tax = def.tax;
    // Stock/ETF price provider: Yahoo Finance is the keyless default; an optional keyed provider may be set.
    if (d.settings.stockProvider === undefined) d.settings.stockProvider = "yahoo";
    if (d.settings.stockApiKey === undefined) d.settings.stockApiKey = "";
    if (d.settings.cryptoProvider === undefined) d.settings.cryptoProvider = "coingecko";
    if (d.settings.cryptoApiKey === undefined) d.settings.cryptoApiKey = "";
    if (!Array.isArray(d.settings.dashCards) || d.settings.dashCards.length !== 4) d.settings.dashCards = ["accounts", "investments", "nwGrowth", "taxes"];
    if (!Array.isArray(d.settings.invCards) || d.settings.invCards.length !== 4) d.settings.invCards = ["costBasis", "costMonth", "totalReturn", "totalRealized"];
    if (!d.settings.colors || typeof d.settings.colors !== "object") d.settings.colors = {};
    ["bucket", "holdingType", "expense", "income", "asset", "debt"].forEach(function (dm) { if (!d.settings.colors[dm]) d.settings.colors[dm] = {}; });
    var normalizeValutioAccent = function (c) {
      var key = String(c || "").trim().replace(/\s+/g, " ").toLowerCase();
      return ({
        "#818cf8": 1, "#a07fe0": 1, "#a78bfa": 1, "#8b5cf6": 1, "#7c3aed": 1,
        "#6366f1": 1, "#4f46e5": 1, "#6488f2": 1,
        "oklch(0.70 0.13 300)": 1,
        "oklch(0.74 0.13 330)": 1,
        "oklch(0.72 0.13 318)": 1,
      })[key] ? "#438cff" : ((key === "oklch(0.72 0.12 10)" || key === "oklch(0.70 0.13 28)") ? "oklch(0.68 0.14 18)" : c);
    };
    Object.keys(d.settings.colors).forEach(function (dm) {
      Object.keys(d.settings.colors[dm] || {}).forEach(function (key) {
        d.settings.colors[dm][key] = normalizeValutioAccent(d.settings.colors[dm][key]);
      });
    });
    if (!d.settings.targetAlloc || typeof d.settings.targetAlloc !== "object") d.settings.targetAlloc = {};
    if (d.settings.notifications === undefined) d.settings.notifications = false;
    if (d.settings.autoBackup === undefined) d.settings.autoBackup = "off";
    if (d.settings.backupFolderName === undefined) d.settings.backupFolderName = "";
    if (!d.settings.statementCategorizer || typeof d.settings.statementCategorizer !== "object") {
      d.settings.statementCategorizer = def.settings.statementCategorizer;
    }
    var statementPrefs = d.settings.statementCategorizer;
    d.settings.statementCategorizer = {
      currency: statementPrefs.currency === undefined ? (d.settings.baseCurrency || "") : statementPrefs.currency,
      rules: statementPrefs.rules === undefined ? null : statementPrefs.rules,
    };
    if (d.settings.theme === undefined) d.settings.theme = "dark";
    if (d.settings.language === undefined) d.settings.language = "en";
    if (d.settings.language !== "it") d.settings.language = "en";
    if (d.meta && d.meta.lastNotifyMonth === undefined) d.meta.lastNotifyMonth = "";
    if (d.settings.snapshotMode === undefined) d.settings.snapshotMode = "manual";
    if (d.settings.icon === undefined) d.settings.icon = "";
    if (d.settings.country === undefined) d.settings.country = "AU";
    if (d.tax && !d.tax.adjustments) d.tax.adjustments = [];
    if (d.tax && d.tax.capitalGainsRate === undefined) d.tax.capitalGainsRate = 0.20;
    if (d.tax && d.tax.capitalGainsDiscount === undefined) d.tax.capitalGainsDiscount = ({ AU: 0.50, CA: 0.50, NZ: 1, SG: 1, CH: 1 })[d.settings.country] || 0;
    if (d.tax && d.tax.capitalGainsDiscountMonths === undefined) d.tax.capitalGainsDiscountMonths = ({ AU: 12 })[d.settings.country] || 0;
    if (d.tax && d.tax.capitalLossCarryIn === undefined) d.tax.capitalLossCarryIn = 0;
    (d.holdings || []).forEach(function (h) { if (!h.dividends) h.dividends = []; });
    if (d.tax && !d.tax.year) d.tax.year = auFYLabel();
    // Fiscal-year window is resolved from the record's OWN country (so past years keep their country's FY
    // even after the user switches presets). Backfill the live year + any archived years with the current
    // country as a best guess for pre-existing data.
    if (d.tax && d.tax.country === undefined) d.tax.country = d.settings.country;
    if (!d.taxArchive) d.taxArchive = [];
    (d.taxArchive || []).forEach(function (a) { if (a && a.country === undefined) a.country = d.settings.country; });
    if (!d.goals) d.goals = [];
    if (!d.recurring) d.recurring = [];
    if (!d.retirement || typeof d.retirement !== "object") d.retirement = {};
    ["salary", "employerExtra", "voluntary"].forEach(function (k) { d.retirement[k] = num(d.retirement[k]); });
    (d.goals || []).forEach(function (g) { if (g.currentSavings === undefined) g.currentSavings = 0; });
    if (!d.physicalAssets) d.physicalAssets = [];
    if (!d.debts) d.debts = [];
    (d.debts || []).forEach(function (x) { if (x.logMode === undefined) x.logMode = "interest"; if (x.lastClose === undefined) x.lastClose = ""; });
    // Cash-flow category for auto-logged debt repayments (interest or full payment, per debt).
    if (Array.isArray(d.expenseCategories) && d.expenseCategories.indexOf("Debt payments") === -1) {
      var oi = d.expenseCategories.indexOf("Other");
      d.expenseCategories.splice(oi === -1 ? d.expenseCategories.length : oi, 0, "Debt payments");
    }
    if (!d.meta) d.meta = { lastBackup: 0, backupSnooze: 0, customYears: [] };
    if (!d.meta.customYears) d.meta.customYears = [];
    if (!d.meta.customMonths) d.meta.customMonths = [];
    if (!d.meta.recurringApplied) d.meta.recurringApplied = {};
    if (!d.holdingTypes) d.holdingTypes = [
      { key: "stock", label: "Stock", color: "#438cff" },
      { key: "etf", label: "ETF", color: "#438cff" },
      { key: "crypto", label: "Crypto", color: "oklch(0.74 0.10 210)" },
    ];
    if (d.holdingTypes && !d.holdingTypes.some(function (t) { return t.key === "realestate"; })) {
      d.holdingTypes.push({ key: "realestate", label: "Real Estate", color: "#56b6c2" });
    }
    if (d.holdingTypes && !d.holdingTypes.some(function (t) { return t.key === "bond"; })) {
      d.holdingTypes.push({ key: "bond", label: "Bond", color: "#54bd8f" });
    }
    if (d.holdingTypes && !d.holdingTypes.some(function (t) { return t.key === "commodity"; })) {
      d.holdingTypes.push({ key: "commodity", label: "Commodity", color: "oklch(0.68 0.14 255)" });
    }
    (d.holdingTypes || []).forEach(function (t) { if (t && t.color) t.color = normalizeValutioAccent(t.color); });
    // migrate flat holdings -> transaction ledger; inject ticker/apiSymbol cleanly (trim only,
    // never truncate) so imported symbols map straight into state.
    (d.holdings || []).forEach(function (h) {
      if (h.ticker != null) h.ticker = String(h.ticker).trim();
      if (h.apiSymbol != null) h.apiSymbol = String(h.apiSymbol).trim();
      if (!h.transactions) {
        h.transactions = [];
        if (num(h.shares) > 0) {
          h.transactions.push({ id: uid(), month: currentMonth(), type: "buy", shares: num(h.shares), price: num(h.buyPrice), fees: num(h.fees) });
        }
        h.realizedSeed = num(h.realized || 0);
      }
      normalizeTransactionHistory(h);
    });
    // Cash-flow ingestion: never keep the generic "Imported" placeholder. Preserve each record's
    // native category; only entries still tagged with the placeholder fall back to "Other". Drop
    // the placeholder from both category pickers.
    var scrubImported = function (records, cats) {
      (records || []).forEach(function (r) { if (r && r.category === "Imported") r.category = "Other"; });
      if (Array.isArray(cats)) {
        var i = cats.indexOf("Imported"); if (i !== -1) cats.splice(i, 1);
        if (cats.indexOf("Other") === -1) cats.push("Other");
      }
    };
    scrubImported(d.expenses, d.expenseCategories);
    scrubImported(d.incomes, d.incomeCategories);
    normalizeTaxHistory(d);
    d.version = 2;
    d.meta.migrations = d.meta.migrations || {};
    if (!d.meta.migrations.v2) d.meta.migrations.v2 = { at: new Date().toISOString(), note: "Added deterministic trade ordering and immutable archived tax inputs." };
    return validateDb(d, { repair: true, strict: false, source: "load" }).db;
  }
  function save() {
    var snapshot = JSON.stringify(db);                 // point-in-time snapshot taken synchronously
    idbSet(KEY, snapshot).catch(function () {
      try { localStorage.setItem(KEY, snapshot); } catch (e) { /* IDB + storage both unavailable */ }
    });
  }

  // Donations: Valutio is free and open source; a tip is entirely optional. Opens Ko-fi in a new tab.
  var KOFI = "https://ko-fi.com/salvatoresorvillo";
  function openDonate() {
    try {
      var a = document.createElement("a");
      a.href = KOFI; a.target = "_blank"; a.rel = "noopener";
      document.body.appendChild(a); a.click(); a.remove();
    } catch (e) { try { window.open(KOFI, "_blank", "noopener"); } catch (e2) { } }
  }

  // ----------------------------------------------------------
  // Small helpers
  // ----------------------------------------------------------
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var MONTHS_IT = ["Gen", "Feb", "Mar", "Apr", "Mag", "Giu", "Lug", "Ago", "Set", "Ott", "Nov", "Dic"];
  function monthName(i) { return languageMode() === "it" ? MONTHS_IT[i] : MONTHS[i]; }
  // Cohesive oklch data palette (matches the --d-* design tokens). Used for charts,
  // allocation segments, tags and entity badges - never for P/L (that is --pos/--neg).
  var D = {
    blue:   "oklch(0.68 0.14 255)",
    violet: "#438cff",
    teal:   "oklch(0.74 0.10 200)",
    green:  "oklch(0.74 0.12 155)",
    amber:  "oklch(0.74 0.10 210)",
    rose:   "oklch(0.68 0.14 255)",
  };
  var PALETTE = [D.blue, D.violet, D.teal, D.green, D.amber, D.rose];
  // Distinct, on-brand color for the i-th category. The first six reuse the data-palette tokens;
  // beyond that we synthesize OKLCH hues at the SAME lightness (.73) and chroma (.115) as the tokens
  // - golden-angle spacing (137.5°) keeps every generated hue well separated and on the dark theme.
  function paletteColor(i){ i = i | 0; return i < PALETTE.length ? PALETTE[i] : "oklch(0.73 0.115 " + ((i * 137.508) % 360).toFixed(1) + ")"; }
  // Fixed colors for the known holding types / account buckets so their badge and
  // tag always agree (custom types fall back to their stored color).
  var TYPE_COLOR = { stock: D.blue, etf: D.violet, crypto: D.amber, realestate: D.teal, bond: D.green, commodity: D.rose };

  // ----- User-customizable entity colors (Settings -> Colors) -----
  // Curated, on-brand swatch palette offered in the picker. Overrides live in db.settings.colors[domain][key];
  // every domain resolver below checks the override first, then its built-in default, so a color chosen in
  // Settings propagates to every place that entity is drawn (allocation, tags, charts, History, etc.).
  var SWATCHES = [
    "oklch(0.72 0.14 248)", "oklch(0.68 0.14 255)", "oklch(0.70 0.13 278)", "#438cff",
    "#2f75e8", "oklch(0.68 0.14 18)", "oklch(0.76 0.13 60)", "oklch(0.78 0.10 75)",
    "oklch(0.76 0.12 120)", "oklch(0.74 0.12 155)", "oklch(0.74 0.10 190)", "oklch(0.74 0.11 205)",
  ];
  var COINGECKO_IDS = {
    BTC: "bitcoin", XBT: "bitcoin", ETH: "ethereum", SOL: "solana", XRP: "ripple", BNB: "binancecoin",
    ADA: "cardano", DOGE: "dogecoin", TRX: "tron", TON: "the-open-network", DOT: "polkadot", AVAX: "avalanche-2",
    LINK: "chainlink", LTC: "litecoin", BCH: "bitcoin-cash", XLM: "stellar", ETC: "ethereum-classic",
    USDT: "tether", USDC: "usd-coin", DAI: "dai", WBTC: "wrapped-bitcoin", WETH: "weth",
    MATIC: "matic-network", POL: "polygon-ecosystem-token", UNI: "uniswap", ATOM: "cosmos", NEAR: "near",
    APT: "aptos", SUI: "sui", SEI: "sei-network", HBAR: "hedera-hashgraph", ICP: "internet-computer",
    FIL: "filecoin", ARB: "arbitrum", OP: "optimism", AAVE: "aave", MKR: "maker", LDO: "lido-dao",
    GRT: "the-graph", ALGO: "algorand", VET: "vechain", FTM: "fantom", INJ: "injective-protocol",
    RENDER: "render-token", RNDR: "render-token", TAO: "bittensor", PEPE: "pepe", SHIB: "shiba-inu",
    CRO: "crypto-com-chain", XMR: "monero", EOS: "eos", QNT: "quant-network", KAS: "kaspa", STX: "blockstack",
  };
  var COINGECKO_NAME_IDS = {
    bitcoin: "bitcoin", ethereum: "ethereum", solana: "solana", ripple: "ripple", cardano: "cardano",
    dogecoin: "dogecoin", litecoin: "litecoin", polkadot: "polkadot", chainlink: "chainlink", near: "near",
  };
  function coingeckoIdForHolding(h) {
    var id = String((h && h.coingeckoId) || "").trim().toLowerCase();
    if (id) return id;
    var sym = String((h && (h.ticker || h.apiSymbol)) || "").toUpperCase().split(/[-\/:]/)[0].replace(/[^A-Z0-9]/g, "");
    if (sym && COINGECKO_IDS[sym]) return COINGECKO_IDS[sym];
    var nm = String((h && h.name) || "").trim().toLowerCase();
    return COINGECKO_NAME_IDS[nm] || "";
  }
  function colorOverride(domain, key) {
    var c = db.settings && db.settings.colors;
    return (c && c[domain] && c[domain][key]) || null;
  }
  // Category palette deliberately excludes red and green hues so a category dot/tag never collides with the
  // red/green used for money out/in. Stable per category (by its list index, or a name hash for ad-hoc ones).
  var SAFE_CAT_COLORS = [
    "oklch(0.68 0.14 255)", "#438cff", "#438cff", "oklch(0.74 0.11 205)",
    "oklch(0.76 0.13 85)", "oklch(0.70 0.13 278)", "oklch(0.72 0.12 235)", "#438cff",
  ];
  function safeCatColor(c, idx) {
    c = String(c || "");
    if (idx < 0) { var h = 0; for (var k = 0; k < c.length; k++) h = (h * 31 + c.charCodeAt(k)) >>> 0; idx = h; }
    return SAFE_CAT_COLORS[idx % SAFE_CAT_COLORS.length];
  }
  function expenseColor(c) { return colorOverride("expense", c) || safeCatColor(c, (db.expenseCategories || []).indexOf(c)); }
  function incomeColor(c) { return colorOverride("income", c) || safeCatColor(c, (db.incomeCategories || []).indexOf(c)); }

  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function num(v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; }
  // Keep user-entered decimal quantities as strings in storage. Calculations may project them to Number,
  // but JSON backup/restore no longer destroys valid 18-decimal crypto quantities.
  function normalizedDecimal(v) {
    if (typeof v !== "string") return v;
    var s = v.trim();
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(s)) return v;
    var neg = s.charAt(0) === "-"; if (neg || s.charAt(0) === "+") s = s.slice(1);
    var p = s.split("."), whole = (p[0] || "0").replace(/^0+(?=\d)/, ""), frac = (p[1] || "").replace(/0+$/, "");
    return (neg ? "-" : "") + whole + (frac ? "." + frac : "");
  }
  function validMonthString(v) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(v || "")); }
  function validDateString(v) {
    var s = String(v || ""), m = /^(\d{4})-(0[1-9]|1[0-2])-([0-2][0-9]|3[0-1])$/.exec(s);
    if (!m) return false;
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
  }
  function finiteNumber(v) { var n = typeof v === "number" ? v : parseFloat(v); return isFinite(n) ? n : 0; }
  function normalizeTransactionHistory(h) {
    var list = (h && h.transactions) || [], needsSequence = list.some(function (t) { return !(finiteNumber(t.sequence) > 0); });
    list.forEach(function (t) {
      if (validDateString(t.date)) { t.month = t.date.slice(0, 7); t.datePrecision = "day"; }
      else { delete t.date; t.datePrecision = "month"; }
      t.shares = normalizedDecimal(t.shares); t.price = normalizedDecimal(t.price); t.fees = normalizedDecimal(t.fees);
    });
    if (!needsSequence) return;
    list.slice().sort(function (a, b) {
      if (String(a.month) !== String(b.month)) return String(a.month) < String(b.month) ? -1 : 1;
      return String(a.id) < String(b.id) ? -1 : 1;   // preserve the pre-v2 same-month replay order
    }).forEach(function (t, i) { t.sequence = (i + 1) * 10; });
  }
  function validationIssueHtml(items) {
    if (!items || !items.length) return "";
    return '<ul class="validation-list">' + items.slice(0, 8).map(function (m) { return "<li>" + esc(m) + "</li>"; }).join("") +
      (items.length > 8 ? "<li>" + esc("+" + (items.length - 8) + " more") + "</li>" : "") + "</ul>";
  }
  function validationReport(title, audit) {
    audit = audit || { errors: [], warnings: [] };
    openModal({
      title: title,
      sub: "Valutio found data that could produce unreliable financial totals.",
      body:
        (audit.errors.length ? '<div class="callout import-warn">' + icon("shield") + '<div><strong>Import blocked.</strong>' + validationIssueHtml(audit.errors) + "</div></div>" : "") +
        (audit.warnings.length ? '<div class="help-box" style="margin-top:12px"><strong>Repaired or reviewed:</strong>' + validationIssueHtml(audit.warnings) + "</div>" : "") +
        '<p class="hint" style="margin:12px 0 0">Export JSON is the full-fidelity backup format. Spreadsheet imports should be reviewed before replacing a wallet.</p>',
      submitLabel: "Close",
    });
  }
  function validateDb(d, opts) {
    opts = opts || {};
    var errors = [], warnings = [], repairs = 0, referencedCurrencies = {};
    var repair = opts.repair !== false;
    function warn(msg) { warnings.push(msg); }
    function err(msg) { errors.push(msg); }
    function arr(key) { if (!Array.isArray(d[key])) { if (repair) { d[key] = []; repairs++; } else err(key + " is not a list"); } return d[key] || []; }
    function cleanIdList(list, label) {
      var seen = {};
      (list || []).forEach(function (x, i) {
        if (!x || typeof x !== "object") return;
        var id = String(x.id || "").trim();
        if (!id || seen[id]) { x.id = uid(); repairs++; warn(label + " row " + (i + 1) + " had a missing or duplicate id; a new id was assigned."); }
        seen[String(x.id)] = 1;
      });
    }
    function cleanCurrency(x, field, label) {
      var c = String(x[field] || "").trim().toUpperCase();
      if (!c) { c = (d.settings && d.settings.baseCurrency) || (d.tax && d.tax.currency) || ""; repairs++; warn(label + " had no currency; base currency was used."); }
      x[field] = c; if (c) referencedCurrencies[c] = label;
    }
    function cleanMonth(x, field, label) {
      if (!validMonthString(x[field])) { x[field] = currentMonth(); repairs++; warn(label + " had an invalid month; current month was used."); }
    }
    function cleanDate(x, field, label) {
      if (!validDateString(x[field])) { x[field] = currentMonth() + "-15"; repairs++; warn(label + " had an invalid date; the middle of the current month was used."); }
    }
    function positive(v, label, allowZero) {
      var n = finiteNumber(v);
      if (allowZero ? n < 0 : n <= 0) err(label + " must be " + (allowZero ? "zero or higher" : "greater than zero") + ".");
      return n;
    }
    if (!d || typeof d !== "object") return { db: defaultDB(), errors: ["Backup root is not a Valutio wallet object."], warnings: [], repairs: 0 };
    if (!d.settings || typeof d.settings !== "object") d.settings = defaultDB().settings;
    if (!d.meta || typeof d.meta !== "object") d.meta = defaultDB().meta;
    ["accounts", "holdings", "physicalAssets", "expenses", "incomes", "goals", "recurring", "debts", "snapshots", "taxArchive", "currencies", "holdingTypes"].forEach(arr);
    cleanIdList(d.accounts, "Account"); cleanIdList(d.holdings, "Holding"); cleanIdList(d.physicalAssets, "Asset"); cleanIdList(d.expenses, "Expense"); cleanIdList(d.incomes, "Income"); cleanIdList(d.goals, "Goal"); cleanIdList(d.recurring, "Recurring"); cleanIdList(d.debts, "Debt");
    var seenCurrencies = {};
    d.currencies.forEach(function (c, i) { if (!c || typeof c !== "object") return; c.code = String(c.code || "").trim().toUpperCase(); c.rate = finiteNumber(c.rate); if (!c.code) err("Currency row " + (i + 1) + " has no code."); if (c.code && seenCurrencies[c.code]) err("Currency " + c.code + " is duplicated."); seenCurrencies[c.code] = 1; if (!(c.rate > 0)) err("Currency " + (c.code || i + 1) + " has an invalid FX rate."); });
    [d.expenses, d.incomes].forEach(function (list, li) {
      var label = li === 0 ? "Expense" : "Income";
      list.forEach(function (x, i) { cleanMonth(x, "month", label + " row " + (i + 1)); cleanCurrency(x, "currency", label + " row " + (i + 1)); x.amount = positive(x.amount, label + " row " + (i + 1) + " amount", false); if (x.share != null) x.share = Math.max(0, Math.min(100, finiteNumber(x.share))); });
    });
    d.holdings.forEach(function (h, hi) {
      var label = h.name || h.ticker || ("Holding " + (hi + 1));
      cleanCurrency(h, "currency", label);
      h.price = finiteNumber(h.price);
      if (h.price < 0) err(label + " has a negative current price.");
      if (!Array.isArray(h.transactions)) { h.transactions = []; repairs++; warn(label + " had no transaction list; an empty ledger was created."); }
      cleanIdList(h.transactions, label + " transaction");
      var shares = 0;
      sortTransactions(h.transactions).forEach(function (t, ti) {
        cleanMonth(t, "month", label + " transaction " + (ti + 1));
        if (t.date != null && !validDateString(t.date)) err(label + " transaction " + (ti + 1) + " has an invalid calendar date.");
        if (validDateString(t.date) && t.date.slice(0, 7) !== t.month) err(label + " transaction " + (ti + 1) + " date and month disagree.");
        if (!(finiteNumber(t.sequence) > 0)) { t.sequence = (ti + 1) * 10; repairs++; warn(label + " transaction " + (ti + 1) + " had no replay sequence; one was assigned."); }
        t.type = t.type === "sell" ? "sell" : "buy";
        var shareAmount = positive(t.shares, label + " transaction " + (ti + 1) + " shares", false);
        positive(t.price, label + " transaction " + (ti + 1) + " price", false);
        t.shares = normalizedDecimal(t.shares); t.price = normalizedDecimal(t.price); t.fees = normalizedDecimal(t.fees);
        if (t.fees < 0) err(label + " transaction " + (ti + 1) + " has negative fees.");
        if (t.type === "sell") { shares -= shareAmount; if (shares < -1e-6) err(label + " sells more shares than were held by " + t.month + "."); }
        else shares += shareAmount;
      });
      (h.dividends || []).forEach(function (dv, di) { cleanMonth(dv, "month", label + " dividend " + (di + 1)); dv.amount = positive(dv.amount, label + " dividend " + (di + 1) + " amount", false); });
    });
    function validateTaxRecord(t, label) {
      if (!t || typeof t !== "object") return;
      if (!Array.isArray(t.invoices)) t.invoices = [];
      cleanIdList(t.invoices, label + " invoice");
      t.invoices.forEach(function (iv, i) {
        cleanDate(iv, "date", label + " invoice " + (i + 1)); cleanCurrency(iv, "currency", label + " invoice " + (i + 1));
        iv.amount = positive(iv.amount, label + " invoice " + (i + 1) + " amount", false);
        if (iv.fxRate != null && !(finiteNumber(iv.fxRate) > 0)) err(label + " invoice " + (i + 1) + " has an invalid locked FX rate.");
        if (validDateString(iv.date) && !dateInTaxYear(iv.date, t)) {
          iv.legacyYearMismatch = true;
          (opts.strict ? err : warn)(label + " invoice " + (i + 1) + " is dated outside " + (t.year || "its tax year") + ".");
        }
      });
      if (!Array.isArray(t.brackets)) t.brackets = [];
      if (!t.brackets.length) err(label + " has no tax brackets.");
      var previousCap = finiteNumber(t.taxFreeThreshold), sawTop = false;
      t.brackets.forEach(function (b, i) {
        var rate = finiteNumber(b.rate);
        if (rate < 0 || rate > 1) err(label + " tax bracket " + (i + 1) + " rate must be between 0% and 100%.");
        if (b.upTo == null) { if (sawTop || i !== t.brackets.length - 1) err(label + " must have one open-ended top bracket, placed last."); sawTop = true; return; }
        var cap = finiteNumber(b.upTo);
        if (!(cap > previousCap)) err(label + " tax bracket " + (i + 1) + " cap must be greater than the preceding cap and tax-free threshold.");
        previousCap = cap;
      });
      if (t.brackets.length && !sawTop) err(label + " needs an open-ended top bracket.");
      ["employmentIncome", "employmentTaxPaid", "otherIncome", "deductions", "capitalLossCarryIn"].forEach(function (k) { t[k] = finiteNumber(t[k]); if (t[k] < 0) err(label + " " + k + " is negative."); });
      cleanCurrency(t, "currency", label);
    }
    validateTaxRecord(d.tax, "Active tax year");
    (d.taxArchive || []).forEach(function (t, i) { validateTaxRecord(t, "Archived tax year " + (t && t.year ? t.year : i + 1)); });
    [d.settings.baseCurrency, d.settings.secondaryCurrency].forEach(function (c) { if (c) referencedCurrencies[String(c).toUpperCase()] = "Settings"; });
    [d.accounts, d.physicalAssets, d.goals, d.recurring, d.debts].forEach(function (list) {
      (list || []).forEach(function (x) { if (x && x.currency) referencedCurrencies[String(x.currency).toUpperCase()] = x.name || "Wallet record"; });
    });
    Object.keys(referencedCurrencies).forEach(function (code) {
      if (seenCurrencies[code]) return;
      if (!repair) { err(referencedCurrencies[code] + " references missing currency " + code + "."); return; }
      var meta = (typeof CURRENCY_META !== "undefined" && CURRENCY_META[code]) || null;
      var bm = (typeof CURRENCY_META !== "undefined" && CURRENCY_META[d.settings.baseCurrency]) || null;
      var rate = meta ? finiteNumber(meta.rate) / (bm && finiteNumber(bm.rate) ? finiteNumber(bm.rate) : 1) : 1;
      d.currencies.push({ code: code, symbol: currencySymbol(code), rate: rate || 1 }); seenCurrencies[code] = 1; repairs++;
      warn("Missing currency " + code + " was restored" + (meta ? " from the built-in rate table." : " at 1:1; review its FX rate.") );
    });
    d.meta.lastValidation = { at: new Date().toISOString(), source: opts.source || "unknown", errors: errors.slice(0, 20), warnings: warnings.slice(0, 20), repairs: repairs };
    return { db: d, errors: errors, warnings: warnings, repairs: repairs };
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function val(id) { var e = document.getElementById(id); return e ? e.value : ""; }
  function checked(id) { var e = document.getElementById(id); return e ? e.checked : false; }

  // ----------------------------------------------------------
  // Material Symbols Rounded (Google) - the active icon set.
  // Each app glyph maps to a Material Symbols ligature; icon() renders it
  // inside an <svg><text> so the existing .ico width/height/currentColor CSS
  // keeps sizing and colouring every call site unchanged. Filled (FILL 1),
  // weight 500, optical size 24 - tuned to the Rounded style.
  // ----------------------------------------------------------
  var MAT = {
    dashboard: "dashboard", accounts: "account_balance", investments: "trending_up",
    assets: "home", expenses: "receipt_long", income: "savings", goals: "target",
    history: "history", retirement: "beach_access", tax: "percent", debt: "credit_card",
    settings: "tune", help: "help", camera: "photo_camera", refresh: "refresh",
    plus: "add", lock: "lock", arrowUp: "arrow_upward", arrowDown: "arrow_downward",
    wallet: "account_balance_wallet", chevron: "chevron_right", shield: "shield",
    mappin: "location_on", laptop: "laptop_mac", check: "check", close: "close",
    cap: "school", chevronDown: "expand_more", sheet: "table_chart", flag: "flag",
  };
  // icon(name, cls) -> sized icon. Every app glyph is in MAT, so this renders a
  // Material Symbols Rounded ligature (HTML span, sized via the .ico-symwrap box).
  // An unmapped name renders a harmless empty <svg> of the same footprint.
  function icon(name, cls) {
    var lig = MAT[name];
    if (lig) {
      return '<span class="ico ico-svg ico-symwrap ' + (cls || "") + '" aria-hidden="true"><span class="ico-symglyph">' + lig + "</span></span>";
    }
    return '<svg class="ico ico-svg ' + (cls || "") + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"></svg>';
  }
  // Pre-rendered convenience map kept for existing call sites.
  var ICON = {
    lock: icon("lock"), refresh: icon("refresh"), gear: icon("settings"),
    help: icon("help"), check: icon("check"), target: icon("goals"),
    close: icon("close"), plus: icon("plus"), chevron: icon("chevronDown"),
    cap: icon("cap"), inbox: icon("assets"), camera: icon("camera"),
    wallet: icon("wallet"), arrowUp: icon("arrowUp"), arrowDown: icon("arrowDown"),
  };

  function base() { return db.settings.baseCurrency; }
  function curByCode(code) {
    for (var i = 0; i < db.currencies.length; i++) if (db.currencies[i].code === code) return db.currencies[i];
    return null;
  }
  function toBase(amount, code) { var c = curByCode(code); return num(amount) * (c ? num(c.rate) || 1 : 1); }
  function fromBase(amount, code) { var c = curByCode(code); return num(amount) / (c ? num(c.rate) || 1 : 1); }
  function convert(amount, from, to) { return fromBase(toBase(amount, from), to); }
  // A snapshot of the current FX pool: { code: rate, ... }. Stamped onto a month while it is live and
  // frozen the instant it closes, so a closed month keeps the exchange rates that were in effect then
  // ("the true FX of that month before it closed") and its base figures never drift afterwards.
  function ratesNow() { var r = {}; (db.currencies || []).forEach(function (c) { r[c.code] = num(c.rate) || 1; }); return r; }
  // The FX rate (value of 1 unit of `ccy` in base) to use for a given month: a CLOSED month uses the rate
  // it froze with (its snapshot's `rates`), the live month uses the current pool rate. Lets every page that
  // converts native amounts for a selected past month do so at that month's true historical FX, not today's.
  function rateForMonth(ccy, month) {
    if (month && month !== currentMonth()) {
      var s = snapByMonth(month);
      if (s && s.rates && s.rates[ccy] != null) return num(s.rates[ccy]);
    }
    var c = curByCode(ccy); return c ? (num(c.rate) || 1) : 1;
  }
  function toBaseAtMonth(amount, ccy, month) { return num(amount) * rateForMonth(ccy, month); }

  // ----------------------------------------------------------
  // Country tax presets (baseline brackets; user can fine-tune later)
  // ----------------------------------------------------------
  // rate = approx value of 1 unit in EUR (the default base); used only if the currency is missing.
  var CURRENCY_META = {
    EUR: { symbol: "€", rate: 1 }, USD: { symbol: "$", rate: 0.92 }, AUD: { symbol: "A$", rate: 0.61 },
    GBP: { symbol: "£", rate: 1.17 }, CAD: { symbol: "C$", rate: 0.68 }, NZD: { symbol: "NZ$", rate: 0.56 },
    SGD: { symbol: "S$", rate: 0.68 }, JPY: { symbol: "¥", rate: 0.0061 }, CHF: { symbol: "CHF ", rate: 1.05 },
    ZAR: { symbol: "R", rate: 0.05 },
  };
  var POPULAR_CURRENCY_ORDER = ["AUD", "USD", "EUR", "GBP", "CAD", "NZD", "SGD", "JPY", "CHF", "ZAR"];
  var FALLBACK_CURRENCY_CODES = (
    "AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD " +
    "CAD CDF CHF CLP CNY COP CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD " +
    "GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KRW KWD KYD KZT LAK " +
    "LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD " +
    "OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN " +
    "SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD UYU UZS VES VND VUV WST XAF XCD XOF XPF YER " +
    "ZAR ZMW ZWL"
  ).split(" ");
  var currencyNameCache = {}, currencySymbolCache = {}, currencyCodesCache = null;
  function supportedCurrencyCodes() {
    if (currencyCodesCache) return currencyCodesCache.slice();
    var codes = [];
    try {
      if (typeof Intl !== "undefined" && typeof Intl.supportedValuesOf === "function") codes = Intl.supportedValuesOf("currency") || [];
    } catch (e) { codes = []; }
    if (!codes.length) codes = FALLBACK_CURRENCY_CODES.slice();
    FALLBACK_CURRENCY_CODES.forEach(function (c) { if (codes.indexOf(c) < 0) codes.push(c); });
    currencyCodesCache = codes.filter(function (c, i, a) { return /^[A-Z]{3}$/.test(c) && a.indexOf(c) === i; }).sort();
    return currencyCodesCache.slice();
  }
  function currencyName(code) {
    code = String(code || "").toUpperCase();
    if (currencyNameCache[code]) return currencyNameCache[code];
    var name = code;
    try {
      if (typeof Intl !== "undefined" && Intl.DisplayNames) name = new Intl.DisplayNames(["en"], { type: "currency" }).of(code) || code;
    } catch (e) { name = code; }
    currencyNameCache[code] = name;
    return name;
  }
  function currencySymbol(code) {
    code = String(code || "").toUpperCase();
    if ((CURRENCY_META[code] || {}).symbol) return CURRENCY_META[code].symbol;
    if (currencySymbolCache[code]) return currencySymbolCache[code];
    var sym = code + " ";
    try {
      if (typeof Intl === "undefined") throw new Error("no-intl");
      var parts = new Intl.NumberFormat("en", { style: "currency", currency: code, currencyDisplay: "narrowSymbol" }).formatToParts(0);
      var cur = parts.filter(function (p) { return p.type === "currency"; })[0];
      if (cur && cur.value) sym = cur.value;
    } catch (e) { sym = code + " "; }
    currencySymbolCache[code] = sym;
    return sym;
  }
  function currencyCatalogCodes() {
    var seen = {}, out = [];
    POPULAR_CURRENCY_ORDER.concat(supportedCurrencyCodes()).forEach(function (code) {
      if (!seen[code]) { seen[code] = 1; out.push(code); }
    });
    return out;
  }
  function currencyLabel(code) {
    var sym = String(currencySymbol(code) || "").trim();
    return code + " - " + currencyName(code) + (sym && sym !== code ? " (" + sym + ")" : "");
  }
  // ordered list for the dropdown
  var COUNTRY_ORDER = ["AU", "US", "GB", "CA", "DE", "FR", "IT", "ES", "NL", "IE", "NZ", "SG", "JP", "CH", "ZA"];
  // Statutory income-tax presets, verified against PwC Worldwide Tax Summaries + official sources for the
  // most recent published year (AU 2024/25, US 2025, GB 2025/26, CA 2026, DE 2025, FR 2025, IT 2025,
  // ES 2025, NL 2026, IE 2025/26, NZ from 31 Jul 2024, SG YA2025, JP 2025, CH federal 2026, ZA 2026/27).
  // `taxFreeThreshold` is the 0% band; `brackets[i].upTo` are absolute total-income bounds (progressiveTax
  // taxes income ABOVE the threshold). For systems whose allowance is a deduction or a credit rather than a
  // 0% band (US standard deduction; CA/ZA personal-amount/rebate credits), the bounds are expressed so the
  // model reproduces the real liability - e.g. US brackets are shifted up by the standard deduction, which
  // is also why no bracket bound ever sits at/below the threshold. DE/FR/CH are simplified band fits of a
  // continuous formula. Approximations for guidance only; users can fine-tune in Tax Settings.
  var TAX_PRESETS = {
    AU: { name: "Australia", currency: "AUD", taxFreeThreshold: 18200, levyLabel: "Medicare Levy", levyRate: 0.02, capitalGainsRate: 0.20,
      brackets: [{ upTo: 45000, rate: 0.16 }, { upTo: 135000, rate: 0.30 }, { upTo: 190000, rate: 0.37 }, { upTo: null, rate: 0.45 }] },
    // US: brackets are the 2025 single-filer bands shifted up by the $15,000 standard deduction so they apply
    // to TOTAL income (taxable income = total − deduction). e.g. 10% on the first $11,925 of taxable income
    // → $15,000-$26,925 of total income.
    US: { name: "United States", currency: "USD", taxFreeThreshold: 15000, levyLabel: "Levy", levyRate: 0, capitalGainsRate: 0.15,
      brackets: [{ upTo: 26925, rate: 0.10 }, { upTo: 63475, rate: 0.12 }, { upTo: 118350, rate: 0.22 }, { upTo: 212300, rate: 0.24 }, { upTo: 265525, rate: 0.32 }, { upTo: 641350, rate: 0.35 }, { upTo: null, rate: 0.37 }] },
    GB: { name: "United Kingdom", currency: "GBP", taxFreeThreshold: 12570, levyLabel: "Levy", levyRate: 0, capitalGainsRate: 0.24,
      brackets: [{ upTo: 50270, rate: 0.20 }, { upTo: 125140, rate: 0.40 }, { upTo: null, rate: 0.45 }] },
    CA: { name: "Canada", currency: "CAD", taxFreeThreshold: 16452, levyLabel: "Levy", levyRate: 0, capitalGainsRate: 0.25,
      brackets: [{ upTo: 58523, rate: 0.14 }, { upTo: 117045, rate: 0.205 }, { upTo: 181440, rate: 0.26 }, { upTo: 258482, rate: 0.29 }, { upTo: null, rate: 0.33 }] },
    DE: { name: "Germany", currency: "EUR", taxFreeThreshold: 12096, levyLabel: "Solidarity", levyRate: 0, capitalGainsRate: 0.26,
      brackets: [{ upTo: 17443, rate: 0.14 }, { upTo: 68429, rate: 0.24 }, { upTo: 277825, rate: 0.42 }, { upTo: null, rate: 0.45 }] },
    FR: { name: "France", currency: "EUR", taxFreeThreshold: 11497, levyLabel: "Levy", levyRate: 0, capitalGainsRate: 0.30,
      brackets: [{ upTo: 29315, rate: 0.11 }, { upTo: 83823, rate: 0.30 }, { upTo: 180294, rate: 0.41 }, { upTo: null, rate: 0.45 }] },
    IT: { name: "Italy", currency: "EUR", taxFreeThreshold: 8500, levyLabel: "Levy", levyRate: 0, capitalGainsRate: 0.26,
      brackets: [{ upTo: 28000, rate: 0.23 }, { upTo: 50000, rate: 0.35 }, { upTo: null, rate: 0.43 }] },
    ES: { name: "Spain", currency: "EUR", taxFreeThreshold: 5550, levyLabel: "Levy", levyRate: 0, capitalGainsRate: 0.21,
      brackets: [{ upTo: 12450, rate: 0.19 }, { upTo: 20200, rate: 0.24 }, { upTo: 35200, rate: 0.30 }, { upTo: 60000, rate: 0.37 }, { upTo: 300000, rate: 0.45 }, { upTo: null, rate: 0.47 }] },
    NL: { name: "Netherlands", currency: "EUR", taxFreeThreshold: 0, levyLabel: "Levy", levyRate: 0, capitalGainsRate: 0.31,
      brackets: [{ upTo: 38883, rate: 0.3575 }, { upTo: 78426, rate: 0.3756 }, { upTo: null, rate: 0.495 }] },
    IE: { name: "Ireland", currency: "EUR", taxFreeThreshold: 0, levyLabel: "USC", levyRate: 0, capitalGainsRate: 0.33,
      brackets: [{ upTo: 44000, rate: 0.20 }, { upTo: null, rate: 0.40 }] },
    NZ: { name: "New Zealand", currency: "NZD", taxFreeThreshold: 0, levyLabel: "Levy", levyRate: 0, capitalGainsRate: 0,
      brackets: [{ upTo: 15600, rate: 0.105 }, { upTo: 53500, rate: 0.175 }, { upTo: 78100, rate: 0.30 }, { upTo: 180000, rate: 0.33 }, { upTo: null, rate: 0.39 }] },
    SG: { name: "Singapore", currency: "SGD", taxFreeThreshold: 20000, levyLabel: "Levy", levyRate: 0, capitalGainsRate: 0,
      brackets: [{ upTo: 30000, rate: 0.02 }, { upTo: 40000, rate: 0.035 }, { upTo: 80000, rate: 0.07 }, { upTo: 120000, rate: 0.115 }, { upTo: 160000, rate: 0.15 }, { upTo: 200000, rate: 0.18 }, { upTo: 240000, rate: 0.19 }, { upTo: 280000, rate: 0.195 }, { upTo: 320000, rate: 0.20 }, { upTo: 500000, rate: 0.22 }, { upTo: 1000000, rate: 0.23 }, { upTo: null, rate: 0.24 }] },
    JP: { name: "Japan", currency: "JPY", taxFreeThreshold: 480000, levyLabel: "Levy", levyRate: 0, capitalGainsRate: 0.20,
      brackets: [{ upTo: 1950000, rate: 0.05 }, { upTo: 3300000, rate: 0.10 }, { upTo: 6950000, rate: 0.20 }, { upTo: 9000000, rate: 0.23 }, { upTo: 18000000, rate: 0.33 }, { upTo: 40000000, rate: 0.40 }, { upTo: null, rate: 0.45 }] },
    CH: { name: "Switzerland", currency: "CHF", taxFreeThreshold: 18500, levyLabel: "Levy", levyRate: 0, capitalGainsRate: 0,
      brackets: [{ upTo: 33200, rate: 0.02 }, { upTo: 100000, rate: 0.05 }, { upTo: 150000, rate: 0.08 }, { upTo: null, rate: 0.115 }] },
    ZA: { name: "South Africa", currency: "ZAR", taxFreeThreshold: 99000, levyLabel: "Levy", levyRate: 0, capitalGainsRate: 0.18,
      brackets: [{ upTo: 245100, rate: 0.18 }, { upTo: 383100, rate: 0.26 }, { upTo: 530200, rate: 0.31 }, { upTo: 695800, rate: 0.36 }, { upTo: 887000, rate: 0.39 }, { upTo: 1878600, rate: 0.41 }, { upTo: null, rate: 0.45 }] },
  };
  // Per-country default CGT "discount" = the fraction of a realized capital gain EXCLUDED from taxable
  // income. AU/CA give a 50% discount (CA = 50% inclusion rate); NZ/SG/CH have no individual CGT, so
  // realized gains are fully exempt (1.0); the flat-rate regimes default to 0 (full gain taxed as income -
  // a simplification the user can fine-tune in Tax Settings). Verified against PwC/official sources 2025.
  var CGT_DISCOUNT = { AU: 0.50, CA: 0.50, NZ: 1, SG: 1, CH: 1 };
  // Minimum holding period (months) for the discount to apply. AU's 50% needs >12 months held; CA's 50%
  // inclusion (and the no-CGT countries' exemption) apply regardless, so 0.
  var CGT_DISCOUNT_MONTHS = { AU: 12 };
  Object.keys(TAX_PRESETS).forEach(function (c) {
    TAX_PRESETS[c].cgtDiscount = CGT_DISCOUNT[c] || 0;
    TAX_PRESETS[c].cgtDiscountMonths = CGT_DISCOUNT_MONTHS[c] || 0;
  });
  function countryName(code) { return (TAX_PRESETS[code] || {}).name || ""; }
  function countryFlag(code) { return String(code || "").toUpperCase() || "Global"; }
  function countryOptions(selected) {
    return COUNTRY_ORDER.map(function (code) {
      return '<option value="' + code + '"' + (code === selected ? " selected" : "") + ">" + esc(TAX_PRESETS[code].name) + "</option>";
    }).join("");
  }
  function ensureCurrency(code) {
    if (curByCode(code)) return;
    var m = CURRENCY_META[code] || { symbol: currencySymbol(code), rate: 1 };
    db.currencies.push({ code: code, symbol: m.symbol, rate: m.rate });
  }
  // Approx value of 1 unit of `code` expressed in the user's current base currency.
  // CURRENCY_META rates are EUR-relative, so we rebase them onto the chosen base
  // (e.g. base USD -> the AUD rate becomes AUD-in-USD, not AUD-in-EUR).
  function metaRateInBase(code) {
    var m = CURRENCY_META[code]; if (!m) return "";
    if (code === base()) return 1;
    var b = CURRENCY_META[base()]; var br = b ? num(b.rate) : 1;
    if (!br) return num(m.rate);
    return +(num(m.rate) / br).toPrecision(6);
  }
  // Re-anchor the whole FX pool onto `newBase`, keeping every cross-rate correct. Captures the new base's
  // value in the CURRENT base first (an existing rate if we have one, else the static meta cross-rate), then
  // divides every rate by it so they all re-express against the new base (which lands on exactly 1.0). Works
  // even when the new base isn't in the pool yet - that was the gap that left other currencies stranded at
  // 1:1 after a base switch. Returns true if the base actually changed. Callers should prune + refresh FX.
  function rebaseCurrencyPool(newBase) {
    var oldBase = db.settings.baseCurrency;
    if (newBase !== oldBase) {
      var existingNew = curByCode(newBase);
      var oldRate = existingNew ? num(existingNew.rate) : num(metaRateInBase(newBase));   // new base's value in the OLD base
      if (!(oldRate > 0)) oldRate = 1;
      db.currencies.forEach(function (c) { c.rate = (num(c.rate) || 1) / oldRate; });
      rescaleFrozenSnapshots(oldRate);   // frozen months store base-currency amounts + locked rates - re-express them in the new base
      db.settings.baseCurrency = newBase;
    }
    ensureCurrency(newBase);
    var bc = curByCode(newBase); if (bc) bc.rate = 1;   // base is exactly 1 (guard FP drift)
    return newBase !== oldBase;
  }
  // When the base currency changes, every closed snapshot's stored base-currency figures (net worth,
  // buckets, per-line balanceBase/mvBase, debts, locked rates) are still expressed in the OLD base. They
  // never recompute (frozen), so re-express them here: dividing a base amount by oldRate (= the new base's
  // value in the old base) converts it to the new base exactly; the same transform re-anchors locked rates.
  function rescaleFrozenSnapshots(oldRate) {
    if (!(oldRate > 0) || oldRate === 1) return;
    var cm = currentMonth();
    (db.snapshots || []).forEach(function (s) {
      if (s.month === cm) return;   // live month rebuilds from live data at the new base - don't touch
      ["netWorth", "gross", "invest", "cost", "unrealized", "realized", "income", "expenses",
        "debtsTotal", "unmatchedBase", "physAssets"].forEach(function (k) {
        if (typeof s[k] === "number") s[k] = s[k] / oldRate;
      });
      ["buckets", "debts", "rates"].forEach(function (map) {
        if (s[map]) Object.keys(s[map]).forEach(function (k) { s[map][k] = num(s[map][k]) / oldRate; });
      });
      if (s.accounts) Object.keys(s.accounts).forEach(function (id) {
        var a = s.accounts[id]; if (typeof a.balanceBase === "number") a.balanceBase = a.balanceBase / oldRate;
      });
      if (s.holdings) Object.keys(s.holdings).forEach(function (id) {
        var h = s.holdings[id];
        ["mvBase", "costBase", "rate"].forEach(function (k) { if (typeof h[k] === "number") h[k] = h[k] / oldRate; });
      });
    });
  }
  // Keep the currency pool minimal: only the base, the secondary display (if set), and any
  // currency actually referenced by accounts/holdings/tax. Prevents the pool from accumulating
  // a currency for every country the user clicks through before finalizing a choice.
  function pruneCurrencies() {
    var keep = {};
    keep[db.settings.baseCurrency] = 1;
    if (db.settings.secondaryCurrency) keep[db.settings.secondaryCurrency] = 1;
    db.accounts.forEach(function (a) { keep[a.currency] = 1; });
    db.holdings.forEach(function (h) { keep[h.currency] = 1; });
    (db.expenses || []).forEach(function (x) { keep[x.currency] = 1; });
    (db.incomes || []).forEach(function (x) { keep[x.currency] = 1; });
    // Also any currency referenced by debts, physical assets, goals or recurring rules - otherwise a
    // USD-only mortgage/house/goal would have its currency pruned and silently re-value at 1:1.
    (db.debts || []).forEach(function (d) { if (d.currency) keep[d.currency] = 1; });
    (db.physicalAssets || []).forEach(function (a) { if (a.currency) keep[a.currency] = 1; });
    (db.goals || []).forEach(function (g) { if (g.currency) keep[g.currency] = 1; });
    (db.recurring || []).forEach(function (r) { if (r.currency) keep[r.currency] = 1; });
    if (db.tax) { if (db.tax.currency) keep[db.tax.currency] = 1; (db.tax.invoices || []).forEach(function (iv) { keep[iv.currency] = 1; }); }
    (db.taxArchive || []).forEach(function (a) { if (a.currency) keep[a.currency] = 1; (a.invoices || []).forEach(function (iv) { keep[iv.currency] = 1; }); });
    db.currencies = db.currencies.filter(function (c) { return keep[c.code]; });
  }
  // Initialize db.tax from a country preset (currency, threshold, brackets, levy, CGT rate).
  // The base reporting currency follows the country (updated in place); the currency pool is
  // pruned so switching countries never appends extra/secondary tracking records.
  // keepBase=true loads only the tax brackets/levy/CGT and leaves the user's chosen
  // base currency untouched (used in the setup wizard, where Base Currency is manual).
  function applyTaxPreset(code, keepBase) {
    var p = TAX_PRESETS[code]; if (!p) return;
    db.settings.country = code;
    var t = db.tax;
    t.country = code;   // this record's FY window follows the chosen country (archived years keep theirs)
    if (keepBase) {
      t.currency = db.settings.baseCurrency;          // tax figures stay in the user's base currency
    } else {
      rebaseCurrencyPool(p.currency);                 // align base reporting currency with the country, rates re-anchored
      t.currency = p.currency;
    }
    t.taxFreeThreshold = p.taxFreeThreshold;
    t.brackets = JSON.parse(JSON.stringify(p.brackets));
    t.levyRate = p.levyRate;
    t.levyLabel = p.levyLabel;
    t.capitalGainsRate = p.capitalGainsRate;
    t.capitalGainsDiscount = num(p.cgtDiscount);   // fraction of realized gains excluded from taxable income
    t.capitalGainsDiscountMonths = num(p.cgtDiscountMonths);   // min holding period (months) for that discount
    pruneCurrencies();   // only the base (+ secondary + in-use) stays in the pool
  }
  // Legal note shown under the country preset (wizard) and inside Tax Settings.
  var TAX_DISCLAIMER = '<p class="hint" style="font-style:italic;margin:8px 0 0">Tax laws and brackets can change and may differ from recent updates within that country.</p>';

  function fmt(v, code, decimals) {
    var c = curByCode(code || base());
    var sym = c ? c.symbol : "";
    var d = decimals == null ? 2 : decimals;
    var r = Math.round(num(v) * 100) / 100;
    var neg = r < 0;   // put the minus BEFORE the currency symbol ("-$147" not "$-147")
    var n = Math.abs(r).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
    return (neg ? "-" : "") + sym + n;
  }
  function fmtBase(v, decimals) { return fmt(v, base(), decimals); }
  function pct(v) { return (num(v) * 100).toFixed(1) + "%"; }
  function savingsRateForPeriod(income, expenses) {
    var totalIncome = num(income);
    return totalIncome > 0 ? (totalIncome - num(expenses)) / totalIncome : null;
  }
  function signClass(v) { return num(v) > 0 ? "up" : num(v) < 0 ? "down" : ""; }
  function signFmt(v, code) { return (num(v) > 0 ? "+" : "") + fmt(v, code); }
  // Split-pill status badge: a neutral period segment + a colored status segment.
  // kind: "live" | "frozen" | "neutral" (or ""). statusHtml may be "" for a single neutral pill.
  function statusBadge(leftHtml, statusHtml, kind) {
    return '<span class="title-badge ' + (kind || "") + '">' +
      '<span class="tb-date">' + leftHtml + '</span>' +
      (statusHtml ? '<span class="tb-status">' + statusHtml + '</span>' : '') + '</span>';
  }

  function currentMonth() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
  }
  function monthLabel(m) {
    if (!m) return "";
    var p = m.split("-");
    return monthName(+p[1] - 1) + " " + p[0];
  }
  function recentMonths(count) {
    var out = [], d = new Date();
    d.setDate(1);
    for (var i = 0; i < count; i++) {
      out.push(d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"));
      d.setMonth(d.getMonth() - 1);
    }
    return out;
  }
  // Australian-style financial year label for a date, e.g. "2025/26" (FY runs Jul -> Jun).
  function auFYLabel(d) {
    d = d || new Date();
    var start = (d.getMonth() + 1) >= 7 ? d.getFullYear() : d.getFullYear() - 1;
    return start + "/" + String((start + 1) % 100).padStart(2, "0");
  }
  // Next year's label after a "YYYY/YY" (or plain "YYYY") tax-year label.
  function nextFYLabel(label) {
    var m = /^(\d{4})\s*\/\s*\d{2,4}$/.exec(String(label || "").trim());
    if (m) { var s = +m[1] + 1; return s + "/" + String((s + 1) % 100).padStart(2, "0"); }
    var n = parseInt(label, 10);
    return isNaN(n) ? (label || "") + " (next)" : String(n + 1);
  }

  // ----------------------------------------------------------
  // Computations
  // ----------------------------------------------------------
  function typeColor(key) { return TYPE_COLOR[key] || null; }
  function typeMeta(key) {
    var t = (db.holdingTypes || []).filter(function (x) { return x.key === key; })[0];
    var color = colorOverride("holdingType", key) || typeColor(key) || (t && t.color) || D.teal;
    if (t) return { key: t.key, label: t.label, color: color };
    return { key: key, label: key ? key.charAt(0).toUpperCase() + key.slice(1) : "Other", color: color };
  }
  function typeTag(key) {
    var tm = typeMeta(key);
    return '<span class="tag" style="color:' + tm.color + ";background:color-mix(in oklch," + tm.color + ' 18%,transparent)">' + esc(tm.label) + "</span>";
  }

  function sortTransactions(list) {
    return (list || []).slice().sort(function (a, b) {
      var am = String(a.month || ""), bm = String(b.month || "");
      if (am !== bm) return am < bm ? -1 : 1;
      var ad = a.date && validDateString(a.date) ? a.date : "", bd = b.date && validDateString(b.date) ? b.date : "";
      if (ad && bd && ad !== bd) return ad < bd ? -1 : 1;
      var as = finiteNumber(a.sequence), bs = finiteNumber(b.sequence);
      if (as !== bs) return as - bs;
      return 0;   // modern Array.sort is stable, preserving imported row order when legacy fields tie
    });
  }
  function sortedTxns(h) { return sortTransactions((h && h.transactions) || []); }
  function nextTransactionSequence(h) {
    return (h && h.transactions || []).reduce(function (n, t) { return Math.max(n, finiteNumber(t.sequence)); }, 0) + 10;
  }
  function decimalParts(v) {
    var s = String(v == null ? "0" : v).trim();
    if (/e/i.test(s)) s = num(s).toFixed(20).replace(/0+$/, "").replace(/\.$/, "");
    var neg = s.charAt(0) === "-"; if (neg || s.charAt(0) === "+") s = s.slice(1);
    var p = s.split("."), frac = p[1] || "", digits = (p[0] || "0") + frac;
    return { n: BigInt((neg ? "-" : "") + (digits.replace(/^0+(?=\d)/, "") || "0")), scale: frac.length };
  }
  function decimalAdd(a, b, subtract) {
    var x = decimalParts(a), y = decimalParts(b), scale = Math.max(x.scale, y.scale);
    var xn = x.n * (10n ** BigInt(scale - x.scale)), yn = y.n * (10n ** BigInt(scale - y.scale));
    var n = xn + (subtract ? -yn : yn), neg = n < 0n; if (neg) n = -n;
    var s = n.toString().padStart(scale + 1, "0");
    if (scale) s = s.slice(0, -scale) + "." + s.slice(-scale).replace(/0+$/, "");
    s = s.replace(/\.$/, ""); return (neg ? "-" : "") + s;
  }
  // True if a proposed transaction list would ever sell more shares than are held at that point (running
  // position goes negative). Guards buy/sell entry+edit so a sell can't exceed the position at its OWN month
  // (a backdated sell, or an edit, can pass a "total shares now" check yet still be impossible mid-history).
  function txnsOversell(txns) {
    var shares = "0", bad = false;
    sortTransactions(txns).forEach(function (t) {
      shares = decimalAdd(shares, t.shares, t.type === "sell");
      if (shares.charAt(0) === "-") bad = true;
    });
    return bad;
  }
  // True if the holding was held at the end of month m, or was bought/sold during m.
  // Drives the "sold positions show through their sale month, then disappear" rule.
  function heldInMonth(h, m) {
    var shares = 0, traded = false;
    sortedTxns(h).forEach(function (t) {
      if (t.month > m) return;
      if (t.month === m) traded = true;
      shares += (t.type === "sell" ? -1 : 1) * num(t.shares);
      if (shares < 0) shares = 0;   // clamp: a sell never drives the position negative (matches holdingLedger)
    });
    return shares > 1e-9 || traded;
  }
  // Walk the buy/sell ledger with weighted-average cost. Returns per-transaction rows
  // with running shares/cost and (for sells) realized P/L.
  function holdingLedger(h) {
    var shares = 0, costBasis = 0;
    return sortedTxns(h).map(function (t) {
      var sh = num(t.shares), row = { t: t };
      if (t.type === "sell") {
        var soldSh = Math.min(sh, shares > 0 ? shares : 0);   // can't sell more than held: clamp so realized never books phantom shares
        var avg = shares > 0 ? costBasis / shares : 0;
        var costOut = avg * soldSh;
        var proceeds = soldSh * num(t.price) - num(t.fees);
        row.gross = soldSh * num(t.price);  // sold value (gross)
        row.realized = proceeds - costOut;  // realized P/L for this sale (on the clamped, actually-held quantity)
        shares -= soldSh; costBasis -= costOut;
        if (shares < 1e-9) { shares = 0; costBasis = 0; }
      } else {
        var c = sh * num(t.price) + num(t.fees);
        row.cost = c;                       // cost of this purchase
        row.realized = null;
        shares += sh; costBasis += c;
      }
      row.sharesAfter = shares;
      row.costAfter = costBasis;
      return row;
    });
  }
  // Cost basis & shares of a holding as of the end of a given month (weighted-average cost).
  function costBasisUpTo(h, month) {
    var shares = 0, cost = 0;
    sortedTxns(h).forEach(function (t) {
      if (t.month > month) return;
      var sh = num(t.shares);
      if (t.type === "sell") {
        var avg = shares > 0 ? cost / shares : 0;
        cost -= avg * sh; shares -= sh;
        if (shares < 1e-9) { shares = 0; cost = 0; }
      } else { cost += sh * num(t.price) + num(t.fees); shares += sh; }
    });
    return { cost: cost, shares: shares };
  }
  // Per-holding value/cost time series (base currency): cost from the ledger, value from snapshots + now.
  function holdingHistory(h) {
    var months = {};
    (h.transactions || []).forEach(function (t) { months[t.month] = 1; });
    db.snapshots.forEach(function (s) { if (s.holdings && s.holdings[h.id]) months[s.month] = 1; });
    months[currentMonth()] = 1;
    return Object.keys(months).sort().map(function (m) {
      var cb = costBasisUpTo(h, m);
      var value = null;
      var snap = db.snapshots.filter(function (s) { return s.month === m; })[0];
      if (snap && snap.holdings && snap.holdings[h.id]) value = snap.holdings[h.id].mvBase;
      if (m === currentMonth()) value = holdingMetrics(h).marketValueBase;
      return { x: shortMonth(m), cost: toBaseAtMonth(cb.cost, h.currency, m), value: value };   // cost at that month's frozen FX
    });
  }
  // Current aggregate metrics for a holding, all derived from its transactions.
  function holdingMetrics(h) {
    var price = num(h.price);
    var shares = 0, costBasis = 0, realized = num(h.realizedSeed || 0);
    var buyCostTotal = 0;
    sortedTxns(h).forEach(function (t) {
      var sh = num(t.shares);
      if (t.type === "sell") {
        var soldSh = Math.min(sh, shares > 0 ? shares : 0);   // clamp: never realize P/L on more than was held
        var avg = shares > 0 ? costBasis / shares : 0;
        var costOut = avg * soldSh;
        realized += (soldSh * num(t.price) - num(t.fees)) - costOut;
        shares -= soldSh; costBasis -= costOut;
        if (shares < 1e-9) { shares = 0; costBasis = 0; }
      } else {
        var c = sh * num(t.price) + num(t.fees);
        shares += sh; costBasis += c;
        buyCostTotal += c;
      }
    });
    var avgBuyPrice = shares > 0 ? costBasis / shares : 0;
    var marketValue = shares * price;
    var unrealized = marketValue - costBasis;
    var totalReturn = unrealized + realized;
    return {
      price: price, shares: shares, avgBuyPrice: avgBuyPrice,
      cost: costBasis, buyCostTotal: buyCostTotal, marketValue: marketValue,
      unrealized: unrealized, realized: realized, totalReturn: totalReturn,
      retPct: costBasis > 0 ? unrealized / costBasis : 0,
      totalReturnPct: buyCostTotal > 0 ? totalReturn / buyCostTotal : 0,
      marketValueBase: toBase(marketValue, h.currency),
      costBase: toBase(costBasis, h.currency),
      unrealizedBase: toBase(unrealized, h.currency),
      realizedBase: toBase(realized, h.currency),
      totalReturnBase: toBase(totalReturn, h.currency),
    };
  }
  // Metrics for a FROZEN per-holding record stored in a snapshot (values + locked FX rate).
  function frozenHoldingMetrics(fr) {
    var shares = num(fr.shares), buyPrice = num(fr.buyPrice), price = num(fr.price);
    var rate = num(fr.rate) || 1;
    var cost = shares * buyPrice + num(fr.fees);
    var mv = shares * price;
    var unreal = mv - cost;
    var realized = num(fr.realized);
    var totalReturn = unreal + realized;
    return {
      shares: shares, avgBuyPrice: buyPrice, price: price, cost: cost, marketValue: mv,
      unrealized: unreal, realized: realized, totalReturn: totalReturn,
      retPct: cost > 0 ? totalReturn / cost : 0,
      costBase: cost * rate, marketValueBase: mv * rate, unrealizedBase: unreal * rate, realizedBase: realized * rate,
      currency: fr.currency,
    };
  }
  // Display order for holdings: grouped by type, type groups ordered by their largest market value, and
  // within each group by market value (desc). e.g. VWCE (ETF 50k) -> WQTM (ETF 2k) -> AMD (Stock 5k).
  // Render-time only, so a restored (undone) holding always lands back in its correct place.
  function sortHoldingsByTypeMv(arr, mvFn) {
    var mv = {}, groupMax = {};
    arr.forEach(function (h) { var v = num(mvFn(h)); mv[h.id] = v; var k = h.type || "other"; if (groupMax[k] == null || v > groupMax[k]) groupMax[k] = v; });
    return arr.slice().sort(function (a, b) {
      var ka = a.type || "other", kb = b.type || "other";
      if (ka !== kb) return (groupMax[kb] - groupMax[ka]) || (ka < kb ? -1 : 1);
      return (mv[b.id] - mv[a.id]) || (a.id < b.id ? -1 : 1);
    });
  }
  // Recompute a snapshot's aggregate totals from its stored per-holding and per-account records,
  // re-projecting every base figure from the persisted NATIVE amounts (account balance, holding
  // shares/price) at the CURRENT FX rate. This is what lets a rate edit in Settings -> Currencies & FX
  // (or an Auto-update FX) flow through to a past month's Dashboard allocation, Investments and History,
  // not just the Accounts page. A currency pruned/closed out of the pool has no live rate, so its leg
  // keeps its frozen base (graceful degradation).
  function holdingsById() { var m = {}; (db.holdings || []).forEach(function (h) { m[h.id] = h; }); return m; }
  function recomputeSnapshot(s, byId, frozenEdit) {
    // A CLOSED month is a permanent, immutable snapshot. Once frozen it NEVER recomputes - not when FX
    // rates change, not when the live cash-flow ledger or a holding's buy/sell history is edited. Only the
    // live current month reprojects from live data, so "1000 AUD that was 600 EUR last May reads 600 EUR
    // forever." `frozenEdit` is the one exception: a deliberate manual edit to a single row of a past month
    // (frozenAccountEditModal / the frozen-holding editor) re-totals THAT month from its stored per-line
    // base values, but still does NOT reproject the rest of the month at current FX, so it stays locked.
    var live = (s.month === currentMonth());
    // Cash-flow income/expense totals track the live ledger even for a CLOSED month, so an edit / CSV import
    // into a past month stays consistent between History's monthly table (reads s.income/s.expenses) and its
    // category panels (read the live ledger). This does NOT reproject net worth or FX - those stay frozen.
    s.income = monthTotal(db.incomes, s.month);
    s.expenses = monthTotal(db.expenses, s.month);
    if (!live && !frozenEdit) return;
    if (live) {
      // The live month mirrors current data wholesale (accounts, holdings, debts, prices, FX) - including
      // entities added or removed since the snapshot was first written, which a re-projection of the frozen
      // records would miss - so History and the net-worth trend stay in lock-step with the live Dashboard.
      var fresh = buildSnapshot(s.month);
      for (var fk in fresh) s[fk] = fresh[fk];
      return;
    }
    byId = byId || holdingsById();   // O(1) live-holding lookup; recomputeAllSnapshots builds it once
    // One-time recovery for legacy snapshots built before native unmatched was stored: their untracked-
    // holding value was folded straight into s.invest. Freeze that residual as a base scalar so the
    // summation below doesn't silently drop it. (Fresh imports store s.unmatched natively.)
    if (s.unmatched == null && s.unmatchedBase == null && s.holdings) {
      var trackedMv = 0;
      Object.keys(s.holdings).forEach(function (id) { trackedMv += num(frozenHoldingMetrics(s.holdings[id]).marketValueBase); });
      var resid = num(s.invest) - trackedMv;
      s.unmatchedBase = resid > 0.005 ? resid : 0;
    }
    var invest = 0, cost = 0, unreal = 0, real = 0, buckets = {};
    Object.keys(s.accounts || {}).forEach(function (id) {
      var a = s.accounts[id];
      var frac = effShareFrac(id, a);   // your share (live share re-lenses history; household = 100%)
      if (live && curByCode(a.currency)) a.balanceBase = toBase(num(a.balance), a.currency) * frac;   // LIVE month only: native -> base at current FX
      buckets[a.bucket] = (buckets[a.bucket] || 0) + num(a.balanceBase);
    });
    Object.keys(s.holdings || {}).forEach(function (id) {
      var fr = s.holdings[id];
      if (live) {
        // LIVE month only: keep the record's currency in lock-step with the live holding and refresh its
        // locked FX to the current rate. (A closed month keeps the rate it froze with - see header.)
        var liveH = byId[id];
        if (liveH && liveH.currency) fr.currency = liveH.currency;
        var lc = curByCode(fr.currency);
        if (lc) fr.rate = num(lc.rate) || fr.rate;
      }
      var fm = frozenHoldingMetrics(fr);
      fr.mvBase = fm.marketValueBase; fr.costBase = fm.costBase;   // keep legacy fields fresh
      invest += fm.marketValueBase; cost += fm.costBase; unreal += fm.unrealizedBase; real += fm.realizedBase;
      var k = fr.type === "crypto" ? "Crypto" : "Investments";
      buckets[k] = (buckets[k] || 0) + fm.marketValueBase;
    });
    // Untracked holdings (present in the year sheets, no longer in db.holdings): the live month reprojects
    // each currency's native sum at current FX; a closed month uses the rate it froze with (s.rates),
    // falling back to the current pool rate only when no frozen rate was captured (legacy snapshots).
    if (s.unmatched && typeof s.unmatched === "object") {
      Object.keys(s.unmatched).forEach(function (ccy) {
        var cur = curByCode(ccy);
        var r = (!live && s.rates && s.rates[ccy] != null) ? num(s.rates[ccy]) : (cur ? num(cur.rate) : null);
        var v = (r != null) ? num(s.unmatched[ccy]) * r : num(s.unmatched[ccy]);
        invest += v; cost += v; buckets["Investments"] = (buckets["Investments"] || 0) + v;
      });
    } else if (num(s.unmatchedBase)) {
      invest += num(s.unmatchedBase); cost += num(s.unmatchedBase);
      buckets["Investments"] = (buckets["Investments"] || 0) + num(s.unmatchedBase);
    }
    if (num(s.physAssets)) buckets["Physical Assets"] = (buckets["Physical Assets"] || 0) + num(s.physAssets); // keep frozen physical assets
    s.invest = invest; s.cost = cost; s.unrealized = unreal; s.realized = real; s.buckets = buckets;
    s.gross = Object.keys(buckets).reduce(function (a, k) { return a + buckets[k]; }, 0);
    // LIVE month: re-freeze each debt's base balance at current FX. A frozenEdit (manual past-row edit)
    // keeps the month's already-frozen s.debts/s.debtsTotal untouched. netWorth = gross assets - debts.
    if (live) {
      var perDebt = {};
      (db.debts || []).forEach(function (d) { perDebt[d.id] = toBase(num(d.balance), d.currency); });
      s.debts = perDebt; s.debtsTotal = debtsTotalBase();
    }
    s.netWorth = s.gross - num(s.debtsTotal);
    if (live) {
      // LIVE month tracks the live cash-flow ledger and stamps the current FX. Those rates become the
      // permanent frozen rates the instant this month closes (rolls past currentMonth()).
      s.income = monthTotal(db.incomes, s.month);
      s.expenses = monthTotal(db.expenses, s.month);
      s.rates = ratesNow();
    }
  }
  // Refresh snapshots after an FX or data mutation. Closed months are immutable - recomputeSnapshot skips
  // any month != currentMonth() - so in practice this only recomputes the live current month; every past
  // month keeps the values, and the FX, that were locked in when it closed.
  function recomputeAllSnapshots() { var byId = holdingsById(); (db.snapshots || []).forEach(function (s) { recomputeSnapshot(s, byId); }); }
  // Re-derive ONE holding's per-month snapshot record from its (edited) buy/sell ledger, for the LIVE
  // month only. Closed months are immutable: correcting a buy/sell no longer rewrites a past month's
  // holdings (per the freeze rule), so historical snapshots keep exactly what they froze with. The
  // correction still flows through every live view (holding detail, current-month net worth) because those
  // compute from the ledger directly. Call after any transaction add/delete.
  function repropagateHolding(h) {
    if (!h) return;
    var cm = currentMonth();
    (db.snapshots || []).forEach(function (s) {
      if (s.month !== cm) return;   // FROZEN: never back-propagate a ledger edit into a closed month
      s.holdings = s.holdings || {};
      var pos = positionAt(h, s.month);
      if (pos.shares > 1e-9) {
        var prev = s.holdings[h.id];
        s.holdings[h.id] = {
          shares: pos.shares, buyPrice: pos.avgBuyPrice, fees: 0,
          price: prev && num(prev.price) > 0 ? num(prev.price) : pos.avgBuyPrice,
          realized: pos.realized, type: h.type, currency: h.currency,
          rate: (curByCode(h.currency) || {}).rate || (prev ? num(prev.rate) : 1) || 1,
        };
      } else if (s.holdings[h.id]) {
        delete s.holdings[h.id];   // corrected ledger holds no position this month
      }
    });
    recomputeAllSnapshots();   // refresh mvBase/costBase + buckets/netWorth from the rebuilt records
  }
  // ---- Historical-rate backfill: give every closed month its TRUE month-end FX ----
  // Last calendar day of a "YYYY-MM" month, as "YYYY-MM-DD" (the rate "before the month closed").
  function monthEndDate(m) {
    var p = m.split("-"), d = new Date(+p[0], +p[1], 0);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  // Real historical FX for a date - keyless ECB data via frankfurter.dev. Returns { code: valueInBase }
  // (incl. base = 1), inverting the API's base->ccy quotes to our ccy->base convention.
  function fetchMonthRates(date, baseCode, codes) {
    var syms = codes.filter(function (c) { return c !== baseCode; });
    if (!syms.length) { var o = {}; o[baseCode] = 1; return Promise.resolve(o); }
    var url = "https://api.frankfurter.dev/v1/" + date + "?base=" + baseCode + "&symbols=" + syms.join(",");
    return fetch(url).then(function (r) { if (!r.ok) throw 0; return r.json(); }).then(function (j) {
      var out = {}; out[baseCode] = 1;
      syms.forEach(function (c) { if (j.rates && j.rates[c]) out[c] = 1 / num(j.rates[c]); });
      return out;
    });
  }
  // Freeze ONE snapshot's base figures at a specific { code: valueInBase } rates map (the month's true
  // historical FX). Mirrors recomputeSnapshot's summation but uses the supplied rates and stamps s.rates,
  // so the month is permanently locked to those rates. Native amounts are never mutated.
  function applyFrozenRates(s, rates) {
    var rate = function (ccy) { return rates[ccy] != null ? num(rates[ccy]) : ((curByCode(ccy) || {}).rate || 1); };
    var invest = 0, cost = 0, unreal = 0, real = 0, buckets = {};
    Object.keys(s.accounts || {}).forEach(function (id) {
      var a = s.accounts[id];
      a.balanceBase = num(a.balance) * rate(a.currency) * shareFrac(a.share);   // owned base at the month's FX
      buckets[a.bucket] = (buckets[a.bucket] || 0) + num(a.balanceBase);
    });
    Object.keys(s.holdings || {}).forEach(function (id) {
      var fr = s.holdings[id];
      fr.rate = rate(fr.currency);
      var fm = frozenHoldingMetrics(fr);
      fr.mvBase = fm.marketValueBase; fr.costBase = fm.costBase;
      invest += fm.marketValueBase; cost += fm.costBase; unreal += fm.unrealizedBase; real += fm.realizedBase;
      var k = fr.type === "crypto" ? "Crypto" : "Investments";
      buckets[k] = (buckets[k] || 0) + fm.marketValueBase;
    });
    if (s.unmatched && typeof s.unmatched === "object") {
      Object.keys(s.unmatched).forEach(function (ccy) {
        var v = num(s.unmatched[ccy]) * rate(ccy);
        invest += v; cost += v; buckets["Investments"] = (buckets["Investments"] || 0) + v;
      });
    } else if (num(s.unmatchedBase)) {
      invest += num(s.unmatchedBase); cost += num(s.unmatchedBase);
      buckets["Investments"] = (buckets["Investments"] || 0) + num(s.unmatchedBase);
    }
    if (num(s.physAssets)) buckets["Physical Assets"] = (buckets["Physical Assets"] || 0) + num(s.physAssets);
    // cash-flow flows for the month, valued at the month's FX (joint expenses keep their share lens)
    s.income = (db.incomes || []).filter(function (x) { return x.month === s.month; })
      .reduce(function (t, x) { return t + num(x.amount) * rate(x.currency) * viewFrac(x); }, 0);
    s.expenses = (db.expenses || []).filter(function (x) { return x.month === s.month; })
      .reduce(function (t, x) { return t + num(x.amount) * rate(x.currency) * viewFrac(x); }, 0);
    s.invest = invest; s.cost = cost; s.unrealized = unreal; s.realized = real; s.buckets = buckets;
    s.gross = Object.keys(buckets).reduce(function (a, k) { return a + buckets[k]; }, 0);
    s.netWorth = s.gross - num(s.debtsTotal);   // keep any frozen debts (historical months have none -> 0)
    s.rates = {}; (db.currencies || []).forEach(function (c) { s.rates[c.code] = rate(c.code); });
  }
  // Self-healing, one-time-per-month backfill: any CLOSED snapshot with no stored `rates` (existing data or
  // a fresh Excel import) gets the REAL month-end FX fetched online, then is frozen at those rates so its
  // history reflects what things were actually worth that month - not today's. Runs once per boot when
  // online; months that already carry `rates` (e.g. auto-closed months) are never re-fetched or changed.
  var _histBackfillBusy = false;
  function backfillHistoricalRates() {
    if (_histBackfillBusy || !navigator.onLine) return;
    var cm = currentMonth();
    var todo = (db.snapshots || []).filter(function (s) { return s.month !== cm && !(s.rates && Object.keys(s.rates).length); });
    if (!todo.length) return;
    _histBackfillBusy = true;
    var codes = (db.currencies || []).map(function (c) { return c.code; });
    var i = 0, done = 0;
    var next = function () {
      if (i >= todo.length) {
        _histBackfillBusy = false;
        if (done) { save(); if (state.route) render(); toast("Locked " + done + " month" + (done === 1 ? "" : "s") + " to historical FX"); }
        return;
      }
      var s = todo[i++];
      fetchMonthRates(monthEndDate(s.month), base(), codes)
        .then(function (rates) { applyFrozenRates(s, rates); done++; })
        .catch(function () { /* offline / API miss: leave this month for the next boot */ })
        .then(next);
    };
    next();
  }
  function blankSnapshot(m) {
    return {
      month: m, date: new Date().toISOString(), netWorth: 0, gross: 0, invest: 0, cost: 0,
      unrealized: 0, realized: 0, buckets: {}, holdings: {}, accounts: {},
      income: monthTotal(db.incomes, m), expenses: monthTotal(db.expenses, m),
    };
  }
  function ensureSnapshot(m) {
    var s = snapByMonth(m);
    if (!s) { s = blankSnapshot(m); db.snapshots.push(s); db.snapshots.sort(function (a, b) { return a.month < b.month ? -1 : 1; }); }
    // Imported/sample snapshots may carry only aggregate buckets, not the per-line maps the frozen-edit /
    // frozen-add modals write into. Guarantee they exist so those writes never throw on undefined.
    if (!s.accounts) s.accounts = {};
    if (!s.holdings) s.holdings = {};
    if (!s.buckets) s.buckets = {};
    return s;
  }
  // Before a frozen per-line add/edit, reconstruct per-line records from an aggregate-only snapshot's
  // buckets. recomputeSnapshot(frozenEdit) rebuilds buckets purely from the per-line maps, so without this a
  // month that stored only totals (legacy/sample) would be wiped down to just the newly-added line. Each
  // synthetic record reproduces its bucket's base value exactly (currency = base, rate 1).
  function materializeSnapshotBuckets(s) {
    if (!s) return;
    var hasLines = Object.keys(s.accounts || {}).length || Object.keys(s.holdings || {}).length ||
      num(s.unmatchedBase) || (s.unmatched && Object.keys(s.unmatched).length) || num(s.physAssets);
    var bk = s.buckets || {};
    if (hasLines || !Object.keys(bk).length) return;   // already has per-line detail (or nothing to seed)
    s.accounts = s.accounts || {}; s.holdings = s.holdings || {};
    Object.keys(bk).forEach(function (k) {
      var v = num(bk[k]); if (!v) return;
      if (k === "Physical Assets") s.physAssets = num(s.physAssets) + v;
      else if (k === "Crypto") s.holdings[uid()] = { shares: 1, buyPrice: v, price: v, fees: 0, realized: 0, type: "crypto", currency: base(), rate: 1, synthetic: true };
      else if (k === "Investments") s.holdings[uid()] = { shares: 1, buyPrice: v, price: v, fees: 0, realized: 0, type: "stock", currency: base(), rate: 1, synthetic: true };
      else s.accounts[uid()] = { name: k, bucket: k, currency: base(), balance: v, balanceBase: v, share: 100, synthetic: true };
    });
  }
  function portfolioTotals() {
    var t = { mv: 0, cost: 0, unreal: 0, real: 0 };
    db.holdings.forEach(function (h) {
      var m = holdingMetrics(h);
      t.mv += m.marketValueBase; t.cost += m.costBase;
      t.unreal += m.unrealizedBase; t.real += m.realizedBase;
    });
    return t;
  }
  // Base-currency sum of the debts linked to one asset (a mortgage links via debt.propertyAssetId).
  function linkedDebtsBase(assetId) {
    if (!assetId) return 0;
    return (db.debts || []).reduce(function (s, d) {
      return s + (d.propertyAssetId === assetId ? toBase(num(d.balance), d.currency) : 0);
    }, 0);
  }
  // An asset's POSITIVE net-worth contribution (its Physical Assets bucket slice, always >= 0). `nwMode`:
  //   "full"   = count the whole value; a linked loan subtracts separately under Debts (classic double-entry).
  //   "equity" = count only the owned part (value - linked loans). DEFAULT (missing nwMode = equity).
  // Any underwater remainder (linked loan > value) is moved to the debts side by debtsTotalBase, so the
  // bucket never goes negative.
  function assetNetBase(a) {
    if (!a || !a.includeInNetWorth) return 0;
    var full = toBase(num(a.value), a.currency);
    if (a.nwMode === "full") return full;
    return Math.max(0, full - linkedDebtsBase(a.id));
  }
  // base-currency value of physical assets in net worth (owned/equity part unless an asset opts into "full")
  function physicalAssetsTotal() {
    return (db.physicalAssets || []).reduce(function (s, a) { return s + assetNetBase(a); }, 0);
  }
  // ---- Joint accounts: ownership share + "My share / Household" view lens ----
  // An account stores its FULL statement balance; `share` (0-100, default 100) is the slice YOU own.
  // `state.netView === "household"` lifts the lens to the full balance; otherwise only your share counts.
  function shareFrac(v) { var s = (v == null || v === "") ? 100 : num(v); return Math.max(0, Math.min(100, s)) / 100; }
  function ownedShare(a) { return shareFrac(a && a.share); }                          // your stake, always
  function viewFrac(a) { return state.netView === "household" ? 1 : ownedShare(a); }   // toggle-aware
  function ownedBalance(a) { return num(a.balance) * viewFrac(a); }                    // native, toggle-aware
  function isJoint(a) { return !!(a && (a.joint || (a.share != null && num(a.share) < 100))); }
  // Match a frozen snapshot's account record to its LIVE account - by id, else by name+currency (imported
  // history carries different ids than the seeded live accounts). Lets a live account's current share
  // re-lens its whole history so the net-worth trend stays smooth when you mark it joint.
  function liveAccountFor(id, fr) {
    var a = findAccount(id);
    if (a) return a;
    if (fr && fr.name) {
      for (var i = 0; i < db.accounts.length; i++) {
        var x = db.accounts[i];
        if (String(x.name).toLowerCase() === String(fr.name).toLowerCase() && x.currency === fr.currency) return x;
      }
    }
    return null;
  }
  // Frozen-month ownership fraction: the live account's current share (re-lenses history), else the share
  // frozen into that month for a since-deleted account. Household view lifts to the full balance.
  function effShareFrac(id, fr) {
    var liveA = liveAccountFor(id, fr);
    var s = (liveA && liveA.share != null) ? liveA.share : (fr && fr.share);
    return state.netView === "household" ? 1 : shareFrac(s);
  }
  // Shared "My share / Household" pill toggle (accent-filled active, white text - matches the Cash Flow
  // Quick-Add toggle). Shown on a page only when that page has joint items; flips the global state.netView.
  function netViewToggle(show) {
    if (!show) return "";
    var nv = state.netView === "household" ? "household" : "mine";
    return '<span class="range-chips lg" style="padding:2px">' +
      '<button type="button" class="rc-btn' + (nv === "mine" ? " on" : "") + '" data-act="set-netview" data-view="mine" style="padding:3px 11px;font-size:11.5px;min-width:78px;text-align:center;white-space:nowrap">My share</button>' +
      '<button type="button" class="rc-btn' + (nv === "household" ? " on" : "") + '" data-act="set-netview" data-view="household" style="padding:3px 11px;font-size:11.5px;min-width:78px;text-align:center;white-space:nowrap">Household</button>' +
      "</span>";
  }
  function netWorthBuckets() {
    var b = {};
    db.accounts.forEach(function (a) {
      var k = a.bucket || "Cash";
      b[k] = (b[k] || 0) + toBase(ownedBalance(a), a.currency);
    });
    db.holdings.forEach(function (h) {
      var k = h.type === "crypto" ? "Crypto" : "Investments";
      b[k] = (b[k] || 0) + holdingMetrics(h).marketValueBase;
    });
    var pa = physicalAssetsTotal();
    if (pa) b["Physical Assets"] = (b["Physical Assets"] || 0) + pa;
    return b;
  }
  function grossNetWorth() {
    var b = netWorthBuckets(), s = 0;
    for (var k in b) s += b[k];
    return s;
  }
  // Allocation native breakdown: bucket -> { ccy -> amount held natively in that currency }. Mirrors
  // netWorthBuckets() but keeps every item in its OWN currency (no base conversion), powering the
  // allocation "Only <ccy>" view - e.g. the EUR-native slice of savings, shown in EUR.
  function netWorthBucketsByCcy() {
    var out = {};
    function add(bucket, ccy, amt) {
      if (!ccy || !amt) return;
      if (!out[bucket]) out[bucket] = {};
      out[bucket][ccy] = (out[bucket][ccy] || 0) + amt;
    }
    db.accounts.forEach(function (a) { add(a.bucket || "Cash", a.currency, ownedBalance(a)); });
    db.holdings.forEach(function (h) { add(h.type === "crypto" ? "Crypto" : "Investments", h.currency, holdingMetrics(h).marketValue); });
    (db.physicalAssets || []).forEach(function (a) { add("Physical Assets", a.currency, fromBase(assetNetBase(a), a.currency)); });
    return out;
  }
  // Same shape as netWorthBucketsByCcy() but reconstructed from a FROZEN snapshot's per-line records, so the
  // allocation "Only <ccy>" view of a past month reflects that month, not live data. Physical assets aren't
  // stored per-currency in a snapshot, so they fold into the base currency.
  function snapshotBucketsByCcy(snap) {
    var out = {};
    function add(bucket, ccy, amt) { if (!ccy || !amt) return; if (!out[bucket]) out[bucket] = {}; out[bucket][ccy] = (out[bucket][ccy] || 0) + amt; }
    Object.keys((snap && snap.accounts) || {}).forEach(function (id) { var a = snap.accounts[id]; add(a.bucket || "Cash", a.currency, num(a.balance) * shareFrac(a.share)); });
    Object.keys((snap && snap.holdings) || {}).forEach(function (id) { var h = snap.holdings[id]; add(h.type === "crypto" ? "Crypto" : "Investments", h.currency, num(h.shares) * num(h.price)); });
    if (snap && num(snap.physAssets)) add("Physical Assets", base(), num(snap.physAssets));
    return out;
  }
  // Currencies the user actually holds across allocation entities, ordered base -> secondary -> the rest
  // by descending base value. Base is always offered even if nothing is held in it (it's the reporting ccy).
  function allocCurrencies() {
    var byCcy = netWorthBucketsByCcy(), totals = {};
    Object.keys(byCcy).forEach(function (bk) {
      Object.keys(byCcy[bk]).forEach(function (c) { totals[c] = (totals[c] || 0) + toBase(byCcy[bk][c], c); });
    });
    var b = base(), sec = db.settings.secondaryCurrency;
    var rest = Object.keys(totals).filter(function (c) { return c !== b && c !== sec; })
      .sort(function (x, y) { return totals[y] - totals[x]; });
    var ordered = [b];
    if (sec && sec !== b && totals[sec] != null) ordered.push(sec);
    rest.forEach(function (c) { ordered.push(c); });
    return ordered;
  }
  // ---- Debts (liabilities): subtract from net worth, but never from the allocation buckets ----
  function isEquityAsset(a) { return !!(a && a.includeInNetWorth && a.nwMode !== "full"); }   // owned-part mode (default)
  function assetForDebt(d) { return d && d.propertyAssetId ? (db.physicalAssets || []).filter(function (x) { return x.id === d.propertyAssetId; })[0] : null; }
  // The liability that actually lowers net worth, base currency at current FX. A debt linked to an
  // equity-mode asset is "absorbed" into that asset's equity (already netted there), so it is NOT
  // subtracted again here - only the part of such a loan that exceeds the asset's value still counts.
  function debtsTotalBase() {
    var total = 0;
    (db.debts || []).forEach(function (d) {
      if (!isEquityAsset(assetForDebt(d))) total += toBase(num(d.balance), d.currency);   // unlinked / full-mode -> subtract in full
    });
    (db.physicalAssets || []).forEach(function (a) {
      if (isEquityAsset(a)) total += Math.max(0, linkedDebtsBase(a.id) - toBase(num(a.value), a.currency));   // underwater remainder
    });
    return total;
  }
  // The headline "Net worth" everywhere = gross assets - debts (live month). Closed months read their frozen
  // net worth (`s.netWorth`, set to gross - s.debtsTotal at close) directly; only the live month recomputes.
  function netWorthAfterDebts() { return grossNetWorth() - debtsTotalBase(); }
  function monthTotal(arr, month) {
    // viewFrac applies the joint "my share" lens (1 for non-joint / household view) - only expenses carry a
    // share, so income totals (and the tax sums, which read income) are unaffected.
    return arr.filter(function (x) { return x.month === month; })
      .reduce(function (s, x) { return s + toBase(num(x.amount), x.currency) * viewFrac(x); }, 0);
  }

  function progressiveTax(income, threshold, brackets) {
    var tax = 0, prev = num(threshold);
    for (var i = 0; i < brackets.length; i++) {
      var cap = brackets[i].upTo == null ? Infinity : num(brackets[i].upTo);
      if (income > prev) {
        var portion = Math.min(income, cap) - prev;
        if (portion > 0) tax += portion * num(brackets[i].rate);
        prev = Math.max(prev, cap);   // never let an out-of-order / below-threshold cap lower the running floor (re-taxing exempt income)
      } else break;
    }
    return tax;
  }
  // Convert an invoice to the tax currency, using the rate stored on the day it was created when present.
  function invoiceInTax(iv, t) {
    t = t || db.tax;
    if (iv.currency === t.currency) return num(iv.amount);
    if (iv.fxRate) return num(iv.amount) * num(iv.fxRate);
    return convert(num(iv.amount), iv.currency, t.currency);
  }
  function invoiceValueForTaxYear(iv, t) {
    t = t || db.tax;
    if (!validDateString(iv.date) || !dateInTaxYear(iv.date, t)) return null;
    var locked = t !== db.tax && t.sourceSnapshot && t.sourceSnapshot.invoiceAmounts;
    return locked && locked[iv.id] != null ? num(locked[iv.id]) : invoiceInTax(iv, t);
  }
  function invoiceTotalsForTaxYear(t) {
    t = t || db.tax;
    var primaryCurrency = db.settings.baseCurrency;
    return (t.invoices || []).reduce(function (totals, iv) {
      var inTax = invoiceValueForTaxYear(iv, t);
      if (inTax == null) return totals;
      totals.tax += inTax;
      totals.primary += iv.currency === primaryCurrency
        ? num(iv.amount)
        : convert(inTax, t.currency, primaryCurrency);
      return totals;
    }, { primary: 0, tax: 0, primaryCurrency: primaryCurrency });
  }
  // Marginal rate that the last unit of income falls in.
  function marginalRateFor(income, threshold, brackets) {
    if (income <= num(threshold)) return 0;
    for (var i = 0; i < brackets.length; i++) {
      var cap = brackets[i].upTo == null ? Infinity : num(brackets[i].upTo);
      if (income <= cap) return num(brackets[i].rate);
    }
    return brackets.length ? num(brackets[brackets.length - 1].rate) : 0;
  }
  function deriveTaxSources(t) {
    var split = realizedYearSplit(t.year, num(t.capitalGainsDiscountMonths || 0), t.country);
    return {
      version: 1,
      interests: fromBase(interestsInTaxYear(t.year, t === db.tax, t.country), t.currency),
      dividends: fromBase(dividendsInTaxYear(t.year, t === db.tax, t.country), t.currency),
      longGains: fromBase(split.longGains, t.currency), longLosses: fromBase(split.longLosses, t.currency),
      shortGains: fromBase(split.shortGains, t.currency), shortLosses: fromBase(split.shortLosses, t.currency),
      unknownGains: fromBase(split.unknownGains, t.currency), unknownLosses: fromBase(split.unknownLosses, t.currency),
    };
  }
  function captureTaxSources(t, provenance) {
    var src = deriveTaxSources(t);
    src.invoiceAmounts = {};
    (t.invoices || []).forEach(function (iv) { if (validDateString(iv.date) && dateInTaxYear(iv.date, t)) src.invoiceAmounts[iv.id] = invoiceInTax(iv, t); });
    src.frozenAt = new Date().toISOString(); src.provenance = provenance || "year-rollover"; src.taxCurrency = t.currency;
    return src;
  }
  function syncArchivedInvoiceSnapshot(t) {
    if (!t || t === db.tax || !t.sourceSnapshot || t.sourceSnapshot.version !== 1) return;
    t.sourceSnapshot.invoiceAmounts = {};
    (t.invoices || []).forEach(function (iv) { if (validDateString(iv.date) && dateInTaxYear(iv.date, t)) t.sourceSnapshot.invoiceAmounts[iv.id] = invoiceInTax(iv, t); });
  }
  function taxSourcesFor(t) {
    return t !== db.tax && t.sourceSnapshot && t.sourceSnapshot.version === 1 ? t.sourceSnapshot : deriveTaxSources(t);
  }
  // Capital losses offset non-discountable gains first, then discountable gains. The discount applies
  // only after current and carried losses, and excess losses never reduce salary or other ordinary income.
  function calculateNetCapitalGain(src, t) {
    var longGains = Math.max(0, num(src.longGains)), shortGains = Math.max(0, num(src.shortGains));
    var unknownGains = Math.max(0, num(src.unknownGains));
    var currentLosses = Math.max(0, num(src.longLosses)) + Math.max(0, num(src.shortLosses)) + Math.max(0, num(src.unknownLosses));
    var carryIn = Math.max(0, num(t.capitalLossCarryIn)), pool = currentLosses + carryIn;
    var use = Math.min(shortGains, pool); shortGains -= use; pool -= use;
    use = Math.min(unknownGains, pool); unknownGains -= use; pool -= use;
    use = Math.min(longGains, pool); longGains -= use; pool -= use;
    var discount = Math.max(0, Math.min(1, num(t.capitalGainsDiscount)));
    return {
      taxable: Math.max(0, shortGains + unknownGains + longGains * (1 - discount)),
      carryIn: carryIn, currentLosses: currentLosses, carryOut: Math.max(0, pool),
      gross: num(src.longGains) + num(src.shortGains) + num(src.unknownGains) - currentLosses,
      longNet: num(src.longGains) - num(src.longLosses),
      shortNet: num(src.shortGains) + num(src.unknownGains) - num(src.shortLosses) - num(src.unknownLosses),
      discountedLongGain: longGains, nonDiscountedGain: shortGains + unknownGains,
    };
  }
  function calcTax(t) {
    t = t || db.tax;
    var freelance = invoiceTotalsForTaxYear(t).tax;
    var employment = num(t.employmentIncome);
    var other = num(t.otherIncome);
    var sources = taxSourcesFor(t), interests = num(sources.interests), dividends = num(sources.dividends);
    var cg = calculateNetCapitalGain(sources, t);
    var realizedLong = cg.longNet, realizedShort = cg.shortNet, realizedGross = cg.gross, realized = cg.taxable;
    var totalIncome = freelance + employment + other + interests + realized + dividends;
    // Deductions REDUCE taxable income (the standard meaning), so progressive brackets, the levy and the
    // marginal rate are all computed on income-after-deductions - not subtracted from the tax at the end.
    // (Tax offsets/rebates that reduce the tax itself are the user-defined "adjustments" below.)
    var deductions = num(t.deductions);
    var taxableIncome = Math.max(0, totalIncome - deductions);
    var incomeTax = progressiveTax(taxableIncome, t.taxFreeThreshold, t.brackets);
    var levy = Math.max(0, taxableIncome) * num(t.levyRate);
    var baseTax = incomeTax + levy;
    // user-defined adjustments (fixed amount or % of the base tax; addition or deduction)
    var adjItems = (t.adjustments || []).map(function (a) {
      var amt = a.mode === "percent" ? baseTax * (num(a.value) / 100)
        : a.mode === "percentincome" ? totalIncome * (num(a.value) / 100)
        : num(a.value);
      var signed = a.type === "deduct" ? -amt : amt;
      return { name: a.name, mode: a.mode, type: a.type, value: num(a.value), amount: signed };
    });
    var adjTotal = adjItems.reduce(function (s, a) { return s + a.amount; }, 0);
    var estimated = baseTax + adjTotal;
    if (estimated < 0) estimated = 0;
    var balance = estimated - num(t.employmentTaxPaid);
    // live preview of tax to set aside on freelance income, at the current marginal bracket
    var marginalRate = marginalRateFor(taxableIncome, t.taxFreeThreshold, t.brackets);
    var effRate = marginalRate + num(t.levyRate);
    var freelanceSetAside = freelance * effRate;
    return {
      freelance: freelance, employment: employment, other: other, interests: interests, dividends: dividends,
      realized: realized, realizedGross: realizedGross, realizedLong: realizedLong, realizedShort: realizedShort,
      capitalLossCarryIn: cg.carryIn, capitalLossesThisYear: cg.currentLosses, capitalLossCarryOut: cg.carryOut,
      discountedLongGain: cg.discountedLongGain, nonDiscountedGain: cg.nonDiscountedGain,
      totalIncome: totalIncome, deductions: deductions, taxableIncome: taxableIncome,
      incomeTax: incomeTax, levy: levy, estimated: estimated, balance: balance,
      marginalRate: marginalRate, effRate: effRate, freelanceSetAside: freelanceSetAside,
      adjItems: adjItems,
    };
  }
  // Capital-gains tax reserve: tax you'd owe on current UNREALIZED investment gains if you
  // sold today (base currency). Mirrors the sheet's "Capital Gains Taxes" = unrealized P/L x rate.
  // Losses net against gains; floored at 0 (no CGT owed when overall down).
  function capitalGainsReserve(unrealBase) {
    return Math.max(0, num(unrealBase)) * num(db.tax.capitalGainsRate || 0);
  }
  // Total income tax still OUTSTANDING (not yet paid/lodged) across every tax year, in base currency.
  // Covers the live year plus every frozen archive year; a year drops out the moment it's marked paid
  // (rec.paid). This is what avoids the rollover "overlap": a finished-but-unpaid bill keeps counting
  // until you settle it, and a year you've paid never lingers. Refund/settled years (balance <= 0)
  // contribute nothing. Mirrors the per-year Settlement "Balance to pay".
  function outstandingIncomeTaxBase() {
    var sum = 0;
    function add(rec) {
      if (!rec || rec.paid) return;
      sum += toBase(Math.max(0, calcTax(rec).balance), rec.currency);
    }
    add(db.tax);
    (db.taxArchive || []).forEach(add);
    return sum;
  }
  // How many tax years still carry an unpaid balance (for the dashboard sub-label).
  function unpaidTaxYearCount() {
    var n = 0;
    function chk(rec) { if (rec && !rec.paid && calcTax(rec).balance > 0) n++; }
    chk(db.tax);
    (db.taxArchive || []).forEach(chk);
    return n;
  }
  // Month the tax year STARTS for a country (1-based). AU Jul, NZ/GB Apr, ZA Mar, everyone else Jan.
  function fyStartMonth(code) {
    code = code || db.settings.country;
    return code === "AU" ? 7 : (code === "NZ" || code === "GB") ? 4 : code === "ZA" ? 3 : 1;
  }
  // Country-aware month window for a financial-year label. The label's leading year is the FY START year
  // for split years (AU "2025/26" -> Jul 2025-Jun 2026; NZ/GB Apr-Mar; ZA Mar-Feb); for calendar-year
  // countries the tax year is the single LATER calendar year (label "2025/26" -> Jan-Dec 2026, matching
  // expectedFYLabel, which sets the start year to "this year minus one" until the Dec-31 year-end).
  function fyWindow(label, code) {
    var m = /^(\d{4})/.exec(String(label || ""));
    var s = m ? +m[1] : new Date().getFullYear();
    var sm = fyStartMonth(code), p2 = function (n) { return String(n).padStart(2, "0"); };
    if (sm === 1) return { start: (s + 1) + "-01", end: (s + 1) + "-12" };
    return { start: s + "-" + p2(sm), end: (s + 1) + "-" + p2(sm - 1) };
  }
  function isoDateUTC(d) { return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0"); }
  function fyDateWindow(label, code) {
    var m = /^(\d{4})/.exec(String(label || "")), s = m ? +m[1] : new Date().getFullYear(), sm = fyStartMonth(code);
    if (sm === 1) return { start: (s + 1) + "-01-01", end: (s + 1) + "-12-31" };
    if (code === "GB") return { start: s + "-04-06", end: (s + 1) + "-04-05" };
    var start = new Date(Date.UTC(s, sm - 1, 1)), end = new Date(Date.UTC(s + 1, sm - 1, 0));
    return { start: isoDateUTC(start), end: isoDateUTC(end) };
  }
  function dateInTaxYear(date, t) {
    if (!validDateString(date) || !t) return false;
    var w = fyDateWindow(t.year, t.country); return date >= w.start && date <= w.end;
  }
  function transactionInTaxYear(t, label, code) {
    if (validDateString(t && t.date)) return dateInTaxYear(t.date, { year: label, country: code });
    var w = fyWindow(label, code), month = String((t && t.month) || ""); return month >= w.start && month <= w.end;
  }
  // Realized investment P/L from sells that settled within a tax year (base currency).
  function realizedInTaxYear(label, code) {
    var w = fyWindow(label, code), total = 0;
    (db.holdings || []).forEach(function (h) {
      holdingLedger(h).forEach(function (r) {
        if (r.realized != null && r.t.month >= w.start && r.t.month <= w.end) total += toBase(r.realized, h.currency);
      });
    });
    return total;
  }
  // Interest income earned within a tax year (base currency): sums every Cash-Flow income entry whose
  // category names "interest", over the tax-year window. `includeCurrent` also folds in the live current
  // month (the active year), so interest accruing in the open month is taxed even when the Jul-Jun window
  // doesn't span it (e.g. a calendar-year country mid-year).
  function interestsInTaxYear(label, includeCurrent, code) {
    var w = fyWindow(label, code), cm = currentMonth(), total = 0;
    (db.incomes || []).forEach(function (x) {
      if (!/interest/i.test(String(x.category || ""))) return;
      var inWin = x.month >= w.start && x.month <= w.end;
      if (inWin || (includeCurrent && x.month === cm)) total += toBase(num(x.amount), x.currency);
    });
    return total;
  }
  // Whole calendar months from m1 to m2 ("YYYY-MM" strings).
  function monthsBetween(m1, m2) { var a = String(m1).split("-"), b = String(m2).split("-"); return (+b[0] - +a[0]) * 12 + (+b[1] - +a[1]); }
  function holdingPeriodClass(lot, sale, thr) {
    thr = num(thr); if (thr <= 0) return "long";
    if (validDateString(lot.date) && validDateString(sale.date)) {
      var p = lot.date.split("-"), anniversary = new Date(Date.UTC(+p[0], +p[1] - 1 + thr, +p[2]));
      return new Date(sale.date + "T00:00:00Z") > anniversary ? "long" : "short";
    }
    var md = monthsBetween(lot.month, sale.month);
    if (md > thr) return "long";
    if (md < thr) return "short";
    return "unknown";   // month-only records at the boundary cannot prove the required extra day
  }
  // Split a tax year's realized P/L into long-term (held >= `thr` months) vs short-term (base currency).
  // Cost basis stays weighted-average (matching realizedInTaxYear); holding period is resolved per sale by
  // FIFO-matching the sold shares to the oldest remaining buy lots, then the sale's gain is apportioned by
  // the long/short share ratio. thr=0 makes everything long-term (no holding-period condition).
  function realizedYearSplit(label, thr, code) {
    var out = { long: 0, short: 0, unknown: 0, longGains: 0, longLosses: 0, shortGains: 0, shortLosses: 0, unknownGains: 0, unknownLosses: 0 };
    thr = num(thr);
    (db.holdings || []).forEach(function (h) {
      var rate = (curByCode(h.currency) || {}).rate || 1, lots = [], avgSh = 0, avgCost = 0;
      sortedTxns(h).forEach(function (t) {
        var sh = num(t.shares), pr = num(t.price), fee = num(t.fees);
        if (t.type === "sell") {
          var soldSh = Math.min(sh, avgSh > 0 ? avgSh : 0), avg = avgSh > 0 ? avgCost / avgSh : 0;
          var gain = soldSh * pr - fee - avg * soldSh, rem = soldSh, lng = 0, srt = 0, unk = 0;
          while (rem > 1e-9 && lots.length) {
            var lot = lots[0], take = Math.min(rem, lot.shares);
            var cls = holdingPeriodClass(lot, t, thr);
            if (cls === "long") lng += take; else if (cls === "unknown") unk += take; else srt += take;
            lot.shares -= take; rem -= take; if (lot.shares <= 1e-9) lots.shift();
          }
          if (rem > 1e-9) srt += rem;   // sold shares with no matching lot → treat as short-term
          var tot = lng + srt + unk;
          if (tot > 0 && transactionInTaxYear(t, label, code)) {
            [["long", lng], ["short", srt], ["unknown", unk]].forEach(function (part) {
              if (!(part[1] > 0)) return;
              var amount = gain * (part[1] / tot) * rate, key = part[0]; out[key] += amount;
              if (amount >= 0) out[key + "Gains"] += amount; else out[key + "Losses"] += -amount;
            });
          }
          avgCost -= avg * soldSh; avgSh -= soldSh; if (avgSh < 1e-9) { avgSh = 0; avgCost = 0; }
        } else { lots.push({ shares: sh, month: t.month, date: validDateString(t.date) ? t.date : null }); avgCost += sh * pr + fee; avgSh += sh; }
      });
    });
    return out;
  }
  // Split CURRENT unrealized P/L into long-term (remaining open lots held >= `thr` months) vs short-term
  // (base currency). Mirrors realizedYearSplit: FIFO open lots set the holding period, and each holding's
  // unrealized is apportioned by its long/short remaining-share ratio so the split sums to the live total.
  function unrealizedSplit(thr) {
    thr = num(thr); var long = 0, short = 0, cm = currentMonth();
    (db.holdings || []).forEach(function (h) {
      if (!heldInMonth(h, cm)) return;
      var lots = [];
      sortedTxns(h).forEach(function (t) {
        var sh = num(t.shares);
        if (t.type === "sell") {
          var rem = sh;
          while (rem > 1e-9 && lots.length) { var lot = lots[0], take = Math.min(rem, lot.shares); lot.shares -= take; rem -= take; if (lot.shares <= 1e-9) lots.shift(); }
        } else { lots.push({ shares: sh, month: t.month }); }
      });
      var lng = 0, srt = 0;
      lots.forEach(function (lot) { if (monthsBetween(lot.month, cm) >= thr) lng += lot.shares; else srt += lot.shares; });
      var tot = lng + srt; if (tot <= 1e-9) return;
      var ub = holdingMetrics(h).unrealizedBase;
      long += ub * (lng / tot); short += ub * (srt / tot);
    });
    return { long: long, short: short };
  }
  // Dividend income received within a tax year (base currency), summed across every holding's dividend log.
  function dividendsInTaxYear(label, includeCurrent, code) {
    var w = fyWindow(label, code), cm = currentMonth(), total = 0;
    (db.holdings || []).forEach(function (h) {
      (h.dividends || []).forEach(function (d) {
        var inWin = d.month >= w.start && d.month <= w.end;
        if (inWin || (includeCurrent && d.month === cm)) total += toBase(num(d.amount), h.currency);
      });
    });
    return total;
  }
  function normalizeTaxHistory(wallet) {
    if (!wallet || !wallet.tax) return;
    var wasV2 = num(wallet.version) >= 2, records = (wallet.taxArchive || []).concat([wallet.tax]);
    var moves = [];
    records.forEach(function (rec) {
      rec.invoices = Array.isArray(rec.invoices) ? rec.invoices : [];
      rec.invoices.forEach(function (iv) {
        if (!validDateString(iv.date)) return;
        var target = records.filter(function (candidate) { return dateInTaxYear(iv.date, candidate); })[0];
        if (target && target !== rec) moves.push({ from: rec, to: target, invoice: iv });
        else if (!target) iv.legacyYearMismatch = true;
        else { iv.taxYear = rec.year; delete iv.legacyYearMismatch; }
      });
    });
    moves.forEach(function (mv) {
      mv.from.invoices = mv.from.invoices.filter(function (iv) { return iv !== mv.invoice; });
      if (!mv.to.invoices.some(function (iv) { return iv.id === mv.invoice.id; })) mv.to.invoices.push(mv.invoice);
      mv.invoice.taxYear = mv.to.year; delete mv.invoice.legacyYearMismatch;
    });
    var previousDb = db; db = wallet;
    try {
      var carry = 0;
      (wallet.taxArchive || []).slice().sort(function (a, b) { return String(a.year) < String(b.year) ? -1 : 1; }).forEach(function (rec) {
        if (rec.capitalLossCarryIn == null || !wasV2) rec.capitalLossCarryIn = carry;
        if (!rec.sourceSnapshot || rec.sourceSnapshot.version !== 1) rec.sourceSnapshot = captureTaxSources(rec, "legacy-reconstructed");
        rec.capitalLossCarryOut = calcTax(rec).capitalLossCarryOut; carry = rec.capitalLossCarryOut;
      });
      if (wallet.tax.capitalLossCarryIn == null || !wasV2) wallet.tax.capitalLossCarryIn = carry;
      wallet.tax.capitalLossCarryOut = calcTax(wallet.tax).capitalLossCarryOut;
    } finally { db = previousDb; }
  }
  // All-time realized P/L (base currency): the latest frozen snapshot's cumulative realized (which keeps
  // frozen history, including holdings later removed) PLUS realized booked in months after that snapshot
  // (the current, not-yet-frozen month). Never less than the live ledger's own all-time sum.
  function totalRealizedAllTime() {
    var snaps = db.snapshots.slice().sort(function (a, b) { return a.month < b.month ? -1 : 1; });
    var last = snaps[snaps.length - 1];
    var byId = holdingsById();
    // Live holdings contribute their true, up-to-date all-time realized (ledger + any import seed) - so a
    // backdated edit (gain OR loss) is reflected, not masked by a stale frozen total.
    var liveAll = 0;
    (db.holdings || []).forEach(function (h) {
      liveAll += toBase(num(h.realizedSeed || 0), h.currency);
      holdingLedger(h).forEach(function (r) { if (r.realized != null) liveAll += toBase(r.realized, h.currency); });
    });
    // Add realized from holdings that existed at the last freeze but have since been deleted - their history
    // survives only in the snapshot (live holdings already counted above, so no double count).
    var deleted = 0;
    if (last && last.holdings) Object.keys(last.holdings).forEach(function (id) {
      if (!byId[id]) deleted += num(frozenHoldingMetrics(last.holdings[id]).realizedBase);
    });
    return liveAll + deleted;
  }
  // Cost (money invested via buys) booked in a given month, base currency.
  function costInMonth(month) {
    var total = 0;
    (db.holdings || []).forEach(function (h) {
      holdingLedger(h).forEach(function (r) {
        if (r.cost != null && r.t.month === month) total += toBase(r.cost, h.currency);
      });
    });
    return total;
  }
  // ---- Annualized (money-weighted) return: XIRR over the transaction ledger ----
  // One holding's dated cash flows in BASE currency: buys negative, sells + dividends positive.
  // Month-granular dates land on the month-end (matching monthMs), clamped to "now" for the open month;
  // past flows convert at that month's frozen FX where available (toBaseAtMonth), like the rest of the app.
  function holdingFlows(h) {
    var out = [], nowMs = Date.now();
    sortedTxns(h).forEach(function (t) {
      var gross = num(t.shares) * num(t.price), ms = Math.min(monthMs(t.month), nowMs);
      if (t.type === "sell") out.push({ t: ms, v: toBaseAtMonth(gross - num(t.fees), h.currency, t.month) });
      else out.push({ t: ms, v: -toBaseAtMonth(gross + num(t.fees), h.currency, t.month) });
    });
    (h.dividends || []).forEach(function (d) {
      out.push({ t: Math.min(monthMs(d.month), nowMs), v: toBaseAtMonth(num(d.amount), h.currency, d.month) });
    });
    return out;
  }
  // XIRR via bisection: the yearly rate r where the flows' net present value is zero. `finalValue` is the
  // live market value, appended as a positive flow today. Returns null when a meaningful annual figure
  // can't exist: under 90 days of history (annualizing weeks is noise), flows all one sign, or no root.
  function xirr(flows, finalValue) {
    var fs = flows.slice();
    if (num(finalValue) > 0) fs.push({ t: Date.now(), v: num(finalValue) });
    if (fs.length < 2) return null;
    fs.sort(function (a, b) { return a.t - b.t; });
    var t0 = fs[0].t, YR = 31557600000;   // 365.25 days in ms
    if ((fs[fs.length - 1].t - t0) < 90 * 86400000) return null;
    var neg = false, pos = false;
    fs.forEach(function (f) { if (f.v < 0) neg = true; if (f.v > 0) pos = true; });
    if (!neg || !pos) return null;
    var npv = function (r) {
      var s = 0;
      for (var i = 0; i < fs.length; i++) s += fs[i].v / Math.pow(1 + r, (fs[i].t - t0) / YR);
      return s;
    };
    var lo = -0.9999, hi = 10, flo = npv(lo), fhi = npv(hi);
    if (!isFinite(flo) || !isFinite(fhi) || flo * fhi > 0) return null;
    for (var i = 0; i < 120; i++) {
      var mid = (lo + hi) / 2, fm = npv(mid);
      if (!isFinite(fm)) return null;
      if (flo * fm <= 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
    }
    return (lo + hi) / 2;
  }
  // Whole-portfolio annualized return: every holding's flows pooled, closed with the live market value.
  function portfolioAnnualizedReturn() {
    var flows = [];
    (db.holdings || []).forEach(function (h) { flows = flows.concat(holdingFlows(h)); });
    return xirr(flows, portfolioTotals().mv);
  }

  // ---- Benchmark comparison + time-weighted return ------------------------------------------------
  // "What if I'd put the same money in an index instead?" Each month's net contribution (the change in
  // cost basis) buys the benchmark at that month's close; we then track that hypothetical portfolio's
  // value alongside the real one. The index's OWN-currency total return is used - FX drift between the
  // base currency and the index's currency is not modelled (a deliberate simplification for v1).
  var BENCHMARK_DEFAULT = "ACWI";   // iShares MSCI ACWI: a broad all-world equity default; user-overridable
  function benchmarkTicker() { return (db.settings.benchmark || "").trim() || BENCHMARK_DEFAULT; }
  function benchmarkHist() {
    var b = db.meta && db.meta.benchmarkHist;
    return (b && b.ticker === benchmarkTicker() && b.monthly) ? b : null;
  }
  function benchmarkClose(month) { var b = benchmarkHist(); return (b && b.monthly[month] > 0) ? b.monthly[month] : null; }
  function benchmarkLatestClose() {
    var b = benchmarkHist(); if (!b) return null;
    var ks = Object.keys(b.monthly).sort();
    return ks.length ? b.monthly[ks[ks.length - 1]] : null;
  }
  // Value of the "same contributions into the benchmark" portfolio, aligned index-for-index to `pts`
  // ([{m:"YYYY-MM"|null, cost, t}]). Null where a month's benchmark price is unknown; null overall when
  // fewer than two points can be priced (can't draw a line).
  function benchmarkTrendValues(pts) {
    var units = 0, prevCost = 0, out = [], covered = 0;
    for (var i = 0; i < pts.length; i++) {
      var flow = num(pts[i].cost) - prevCost; prevCost = num(pts[i].cost);
      var px = pts[i].m ? benchmarkClose(pts[i].m) : null;
      if (px == null && i === pts.length - 1 && pts[i].x === "Now") px = benchmarkLatestClose();   // live "Now" point → latest close
      if (px > 0) { units += flow / px; out.push(units * px); covered++; } else out.push(null);
    }
    return covered >= 2 ? out : null;
  }
  // Cumulative time-weighted return over a [{y:marketValue, cost}] sequence: chain each sub-period's growth
  // with that period's net flow removed, so deposit TIMING doesn't distort it (unlike money-weighted XIRR).
  // Returns a cumulative fraction (0.2 = +20% across the whole span), or null when not enough history.
  function portfolioTWR(pts) {
    var factor = 1, periods = 0;
    for (var i = 1; i < pts.length; i++) {
      var v0 = num(pts[i - 1].y);
      if (v0 <= 0) continue;
      var r = (num(pts[i].y) - (num(pts[i].cost) - num(pts[i - 1].cost))) / v0;   // flow assumed at period end
      if (!isFinite(r) || r <= 0) continue;
      factor *= r; periods++;
    }
    return periods >= 2 ? factor - 1 : null;
  }
  // Fetch ~10y of the benchmark's monthly closes via the same keyless Yahoo chart proxy; cache in db.meta.
  // Resolves true when history was stored, false otherwise. Never rejects. NOTE: the range/interval query
  // string only survives the same-origin "/yq" Netlify proxy (production) - the corsproxy fallback used on
  // localhost drops it, so the benchmark line may not draw in local dev. Degrades gracefully either way.
  function fetchBenchmarkHistory() {
    var ticker = benchmarkTicker();
    return yahooFetch("/v8/finance/chart/" + encodeURIComponent(normYahoo(ticker)) + "?range=10y&interval=1mo")
      .then(function (data) {
        var r = data && data.chart && data.chart.result && data.chart.result[0];
        if (!r || !r.timestamp || !r.timestamp.length) return false;
        var q = r.indicators || {};
        var series = (q.adjclose && q.adjclose[0] && q.adjclose[0].adjclose) || (q.quote && q.quote[0] && q.quote[0].close);
        if (!series) return false;
        var monthly = {};
        for (var i = 0; i < r.timestamp.length; i++) {
          var v = series[i]; if (!(v > 0)) continue;
          var d = new Date(r.timestamp[i] * 1000);
          monthly[d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0")] = v;
        }
        if (Object.keys(monthly).length < 2) return false;
        db.meta = db.meta || {};
        db.meta.benchmarkHist = { ticker: ticker, monthly: monthly, fetchedAt: Date.now() };
        return true;
      })
      .catch(function () { return false; });
  }
  function fetchFX() {
    return fetch("https://open.er-api.com/v6/latest/" + encodeURIComponent(base()))
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || j.result !== "success" || !j.rates) throw new Error("bad");
        db.currencies.forEach(function (c) {
          if (c.code === base()) c.rate = 1;
          else if (j.rates[c.code]) c.rate = 1 / j.rates[c.code];
        });
        return true;
      });
  }
  // A holding's display name for the "couldn't fetch" list (name, falling back to ticker).
  function fetchFailName(h) {
    var n = h.name || h.ticker || "Unnamed holding";
    return h.ticker && h.name ? n + " (" + h.ticker + ")" : n;
  }
  function holdingHasOpenPosition(h) {
    return positionAt(h, currentMonth()).shares > 1e-9;
  }
  // Crypto prices via the provider chosen in Settings: CoinGecko (keyless default) / Binance (keyless) /
  // CryptoCompare (keyless, optional key) / CoinMarketCap (key required). CoinMarketCap with no key falls
  // back to CoinGecko (mirrors the stock path). Non-CoinGecko providers fetch per-holding off the ticker.
  // Resolves { ok, total, fails } so refreshAll can report - by name - the holdings that did NOT get a price.
  function fetchCrypto() {
    var prov = db.settings.cryptoProvider || "coingecko";
    var key = (db.settings.cryptoApiKey || "").trim();
    if (prov === "coinmarketcap" && !key) prov = "coingecko";
    if (prov === "coingecko") return fetchCryptoCoinGecko();
    var cryptos = db.holdings.filter(function (h) { return h.type === "crypto" && holdingHasOpenPosition(h) && (h.ticker || h.apiSymbol); });
    if (!cryptos.length) return Promise.resolve({ ok: 0, total: 0, fails: [] });
    var updated = 0, fails = [];
    return cryptos.reduce(function (p, h) {
      return p.then(function () {
        return fetchCryptoPrice(h, prov, key)
          .then(function (res) { if (res && res.price > 0) { h.price = res.price; updated++; } else fails.push(fetchFailName(h)); })
          .catch(function () { fails.push(fetchFailName(h)); });
      });
    }, Promise.resolve()).then(function () { return { ok: updated, total: cryptos.length, fails: fails }; });
  }
  // CoinGecko (keyless default): batched by currency. Prefer each holding's CoinGecko id,
  // but resolve common ticker-only crypto holdings (BTC, ETH, SOL...) so imports do not stay stale.
  function fetchCryptoCoinGecko() {
    var all = db.holdings.filter(function (h) { return h.type === "crypto" && holdingHasOpenPosition(h); });
    if (!all.length) return Promise.resolve({ ok: 0, total: 0, fails: [] });
    var byCur = {}, fails = [];
    all.forEach(function (h) {
      var id = coingeckoIdForHolding(h);
      if (!id) { fails.push(fetchFailName(h)); return; }
      if (String(h.coingeckoId || "").trim().toLowerCase() !== id) h.coingeckoId = id;
      (byCur[h.currency] = byCur[h.currency] || []).push({ h: h, id: id });
    });
    var jobs = Object.keys(byCur).map(function (cur) {
      var ids = byCur[cur].map(function (r) { return r.id; });
      var uniq = ids.filter(function (v, i) { return ids.indexOf(v) === i; }).join(",");
      return fetch("https://api.coingecko.com/api/v3/simple/price?ids=" + encodeURIComponent(uniq) +
        "&vs_currencies=" + encodeURIComponent(cur.toLowerCase()))
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          var n = 0;
          byCur[cur].forEach(function (r) {
            var p = j && j[r.id] && j[r.id][cur.toLowerCase()];
            if (p) { r.h.price = p; n++; } else fails.push(fetchFailName(r.h));
          });
          return n;
        }).catch(function () { byCur[cur].forEach(function (r) { fails.push(fetchFailName(r.h)); }); return 0; });
    });
    return Promise.all(jobs).then(function (arr) {
      return { ok: arr.reduce(function (s, n) { return s + n; }, 0), total: all.length, fails: fails };
    });
  }
  // One crypto holding's price in its own currency, from a keyed/alternate provider. Coin symbol comes
  // from the ticker (e.g. "BTC-EUR" -> BTC). Returns {price} or null.
  function fetchCryptoPrice(h, prov, key) {
    var sym = String(h.ticker || h.apiSymbol || "").toUpperCase().split(/[-\/:]/)[0].replace(/[^A-Z0-9]/g, "");
    var fiat = String(h.currency || base()).toUpperCase();
    if (!sym) return Promise.resolve(null);
    if (prov === "cryptocompare") {
      return fetch("https://min-api.cryptocompare.com/data/price?fsym=" + encodeURIComponent(sym) + "&tsyms=" + encodeURIComponent(fiat) + (key ? "&api_key=" + encodeURIComponent(key) : ""))
        .then(function (r) { return r.json(); }).then(function (j) { var p = j && num(j[fiat]); return p > 0 ? { price: p } : null; });
    }
    if (prov === "binance") {
      return fetch("https://api.binance.com/api/v3/ticker/price?symbol=" + encodeURIComponent(sym + fiat))
        .then(function (r) { return r.json(); }).then(function (j) { var p = j && num(j.price); return p > 0 ? { price: p } : null; });
    }
    if (prov === "coinmarketcap") {
      return fetch("https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=" + encodeURIComponent(sym) + "&convert=" + encodeURIComponent(fiat), { headers: { "X-CMC_PRO_API_KEY": key } })
        .then(function (r) { return r.json(); }).then(function (j) { var q = j && j.data && j.data[sym] && j.data[sym].quote && j.data[sym].quote[fiat]; var p = q && num(q.price); return p > 0 ? { price: p } : null; });
    }
    return Promise.resolve(null);
  }
  // Exchange (MIC / common) code -> Yahoo Finance ticker suffix. "" = US markets (no suffix).
  var YH_SUFFIX = {
    XETR: "DE", XETRA: "DE", ETR: "DE", GER: "DE", IBIS: "DE", FRA: "F", FWB: "F", XFRA: "F", STU: "SG", BER: "BE", MUN: "MU", HAM: "HM", DUS: "DU",
    XLON: "L", LSE: "L", LON: "L",
    XPAR: "PA", PAR: "PA", EPA: "PA", XAMS: "AS", AMS: "AS", XBRU: "BR", BRU: "BR", XLIS: "LS", LIS: "LS",
    XMIL: "MI", MIL: "MI", BIT: "MI", XMAD: "MC", MAD: "MC", BME: "MC",
    XSWX: "SW", SWX: "SW", SIX: "SW", VTX: "SW", EBS: "SW",
    XVIE: "VI", VIE: "VI", XHEL: "HE", HEL: "HE", XSTO: "ST", STO: "ST", XCSE: "CO", CSE: "CO", XOSL: "OL", OSL: "OL",
    XTSE: "TO", TSE: "TO", TSX: "TO", TOR: "TO", XTSX: "V", TSXV: "V", NEO: "NE",
    XHKG: "HK", HKG: "HK", HKEX: "HK", XTKS: "T", TYO: "T", JPX: "T", TSEJ: "T",
    XASX: "AX", ASX: "AX", XNZE: "NZ", NZX: "NZ", XSES: "SI", SGX: "SI", SES: "SI",
    XJSE: "JO", JSE: "JO", XBOM: "BO", BSE: "BO", XNSE: "NS", NSE: "NS", XKRX: "KS", KRX: "KS", XSHG: "SS", SSE: "SS", XSHE: "SZ", SZSE: "SZ", XTAI: "TW", TAI: "TW",
    XNAS: "", NASDAQ: "", NMS: "", NGM: "", XNYS: "", NYSE: "", NYQ: "", PCX: "", ARCA: "", BATS: "", AMEX: "", ASE: "",
  };
  // Normalize an input ticker to a Yahoo Finance symbol. Colon notation (TICKER:EXCHANGE,
  // e.g. AMD:XETR) maps the exchange to the Yahoo dot-suffix (AMD.DE). Plain/dotted symbols pass through.
  function normYahoo(sym) {
    sym = String(sym || "").trim();
    if (!sym || sym.indexOf(":") < 0) return sym;
    var parts = sym.split(":"), t = parts[0].trim().toUpperCase(), ex = (parts[1] || "").trim().toUpperCase();
    var suf = YH_SUFFIX.hasOwnProperty(ex) ? YH_SUFFIX[ex] : ex; // unknown exchange -> use the code verbatim
    return suf ? t + "." + suf : t;
  }
  // Keyless Yahoo Finance endpoints need a CORS bypass. Deployed, the site is now the proxy:
  // Netlify routes /yq/* through the bundled server-side function, which tries both Yahoo quote hosts.
  // This same-origin path is independent of public browser proxies. corsproxy.io - the old sole route - started
  // 403-ing every non-localhost origin (July 2026), which silently froze all deployed stock prices;
  // it still allows localhost, so it stays as the fallback for the source-folder / local launchers,
  // where /yq doesn't exist. Order flips accordingly; every call still tries both before giving up.
  var YQ_PROXIES = ["/yq", "https://corsproxy.io/?https://query1.finance.yahoo.com"];
  if (location.protocol === "file:" || /^(localhost|127\.|10\.|192\.168\.|0\.0\.0\.0|\[::1\])/.test(location.hostname)) YQ_PROXIES.reverse();
  var _yqLive = null;   // the proxy that answered last - tried first on the next call
  // GET a Yahoo Finance path (e.g. "/v8/finance/chart/AAPL") through the first proxy that returns
  // parseable JSON. Resolves null when every route fails; never rejects.
  function yahooFetch(path) {
    var order = _yqLive ? [_yqLive].concat(YQ_PROXIES.filter(function (p) { return p !== _yqLive; })) : YQ_PROXIES;
    return order.reduce(function (p, prox) {
      return p.then(function (found) {
        if (found) return found;
        return fetch(prox + path)
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (j) { if (j) _yqLive = prox; return j; })
          .catch(function () { return null; });
      });
    }, Promise.resolve(null));
  }

  // Stocks & ETFs via keyless Yahoo Finance (proxy chain above). Price + native currency come
  // straight from the chart payload metadata. Sequential to stay gentle on the proxy.
  // Fetch one holding's latest price from the active provider. Returns {price, currency?} or null.
  function fetchStockPrice(h, prov, key) {
    var sym = h.apiSymbol || h.ticker;
    if (prov === "finnhub") {
      return fetch("https://finnhub.io/api/v1/quote?symbol=" + encodeURIComponent(sym) + "&token=" + encodeURIComponent(key))
        .then(function (r) { return r.json(); }).then(function (j) { var p = j && num(j.c); return p > 0 ? { price: p } : null; });
    }
    if (prov === "twelvedata") {
      return fetch("https://api.twelvedata.com/price?symbol=" + encodeURIComponent(sym) + "&apikey=" + encodeURIComponent(key))
        .then(function (r) { return r.json(); }).then(function (j) { var p = j && num(j.price); return p > 0 ? { price: p } : null; });
    }
    if (prov === "alphavantage") {
      return fetch("https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=" + encodeURIComponent(sym) + "&apikey=" + encodeURIComponent(key))
        .then(function (r) { return r.json(); }).then(function (j) { var gq = j && j["Global Quote"]; var p = gq && num(gq["05. price"]); return p > 0 ? { price: p } : null; });
    }
    // Yahoo Finance (keyless default) via the proxy chain - native currency comes from the payload.
    return yahooFetch("/v8/finance/chart/" + encodeURIComponent(normYahoo(sym))).then(function (data) {
      var meta = data && data.chart && data.chart.result && data.chart.result[0] && data.chart.result[0].meta;
      if (!meta) return null;
      var price = num(meta.regularMarketPrice);
      return price > 0 ? { price: price, currency: meta.currency } : null;
    });
  }
  // Reconcile a fetched quote to the holding's OWN currency. Yahoo returns the exchange's native currency,
  // which may be (a) a minor unit - London quotes in GBp (pence), JSE in ZAc (cents), TASE in ILA (agorot) -
  // or (b) a different currency than the user set on the holding (e.g. a USD quote on a holding tracked in
  // EUR). Without this the raw number was stored as-is: a £-holding read 100x high, a USD quote counted as
  // EUR. Converts the price into h.currency (via the FX pool, falling back to static cross-rates).
  function reconcileQuoteCurrency(res, h) {
    if (!res || !(res.price > 0) || !res.currency) return res;   // no currency (keyed providers) → assume already in h.currency
    var q = res.currency, price = res.price;
    if (q === "GBp" || q === "GBX") { price /= 100; q = "GBP"; }        // pence → pounds
    else if (q === "ZAc" || q === "ZAX") { price /= 100; q = "ZAR"; }   // cents → rand
    else if (q === "ILA") { price /= 100; q = "ILS"; }                  // agorot → shekel
    if (q !== h.currency) {
      var qRateInBase = (curByCode(q) || {}).rate;
      if (!(qRateInBase > 0)) qRateInBase = num(metaRateInBase(q));   // not in the pool → static cross-rate
      if (!(qRateInBase > 0) || !curByCode(h.currency)) return null;
      price = fromBase(price * qRateInBase, h.currency);
    }
    return { price: price, currency: res.currency };   // keep the ORIGINAL quote currency for h.apiCurrency (informational)
  }
  // Stocks & ETFs: use the provider chosen in Settings (Yahoo keyless by default; Finnhub / Twelve Data /
  // Alpha Vantage with the saved API key). A keyed provider with no key falls back to Yahoo. Sequential.
  // Resolves { ok, total, fails } so refreshAll can report - by name - the holdings that did NOT get a price.
  function fetchStocks() {
    var stocks = db.holdings.filter(function (h) {
      return (h.type === "stock" || h.type === "etf" || h.type === "bond" || h.type === "commodity") && holdingHasOpenPosition(h) && (h.apiSymbol || h.ticker);
    });
    if (!stocks.length) return Promise.resolve({ ok: 0, total: 0, fails: [] });
    var prov = db.settings.stockProvider || "yahoo";
    var key = (db.settings.stockApiKey || "").trim();
    if (prov !== "yahoo" && !key) prov = "yahoo";
    var updated = 0, fails = [];
    return stocks.reduce(function (p, h) {
      return p.then(function () {
        return fetchStockPrice(h, prov, key).then(function (res) {
          res = reconcileQuoteCurrency(res, h);
          if (res && res.price > 0) { h.price = res.price; if (res.currency) h.apiCurrency = res.currency; updated++; }
          else fails.push(fetchFailName(h));
        }).catch(function () { fails.push(fetchFailName(h)); });
      });
    }, Promise.resolve()).then(function () { return { ok: updated, total: stocks.length, fails: fails }; });
  }

  function refreshAll() {
    toast("Refreshing rates…");
    Promise.all([fetchFX().catch(function () { return false; }), fetchCrypto(), fetchStocks(), fetchBenchmarkHistory()])
      .then(function (res) {
        recomputeAllSnapshots();   // new FX -> recompute the live month (closed months keep their frozen rates) before persisting
        if (res[0]) { db.meta = db.meta || {}; db.meta.lastRateRefresh = Date.now(); }   // throttle auto-refresh (only on a successful online fetch)
        save();
        var bits = [], miss = [];
        if (res[1].ok) bits.push(res[1].ok + " crypto");
        if (res[2].ok) bits.push(res[2].ok + " stock");
        if (res[1].total - res[1].ok > 0) miss.push((res[1].total - res[1].ok) + " crypto");
        if (res[2].total - res[2].ok > 0) miss.push((res[2].total - res[2].ok) + " stock");
        var msg = res[0] ? "Rates updated" : "Offline, couldn't fetch FX";
        if (bits.length) msg = (res[0] ? "Updated FX - " : "Updated ") + bits.join(" - ");
        // Never report a clean "updated" when some prices silently kept their old value - a stale
        // price reads exactly like a frozen month (the corsproxy.io outage hid behind this toast).
        // With failures the toast carries "View more", listing exactly which holdings didn't fetch.
        if (miss.length) fetchFailToast(msg + " - couldn't fetch " + miss.join(" - "), res[1].fails.concat(res[2].fails));
        else toast(msg);
        render();
      });
  }
  // Auto-refresh live prices + FX on app open, at most once an hour (so the net worth you see on open is
  // current without tapping Refresh - the 12h throttle used to leave a stale figure between opens). Skips
  // when there's nothing priced; offline failures don't count (lastRateRefresh is only stamped on success).
  function maybeAutoRefreshRates() {
    if (!db.setupComplete) return;
    if (!(db.holdings.length || db.currencies.length > 1)) return;   // nothing to fetch
    var last = (db.meta && db.meta.lastRateRefresh) || 0;
    if (Date.now() - last < 60 * 60 * 1000) return;   // ~1h throttle (was 12h)
    refreshAll();   // async: re-renders + persists when done
  }

  // ----------------------------------------------------------
  // Charts (inline SVG)
  // ----------------------------------------------------------
  function donutSVG(segments, size, stroke, fmtV) {
    size = size || 180; stroke = stroke || 24;
    fmtV = fmtV || function (v) { return fmtBase(v, 0); };   // tooltip formatter (dashboard allocation passes its own currency)
    var r = (size - stroke) / 2, cx = size / 2, cy = size / 2;
    segments = segments.filter(function (s) { return s.value > 0; });
    var total = segments.reduce(function (s, x) { return s + x.value; }, 0) || 1;
    var open = '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '">';
    if (!segments.length) return open + "</svg>";
    if (segments.length === 1) {
      return open + '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' +
        segments[0].color + '" stroke-width="' + stroke + '"><title>' + esc(segments[0].label || "") + " - " + fmtV(segments[0].value) + " - 100%</title></circle></svg>";
    }
    // Draw each slice as an arc path (butt caps abut cleanly, no dash-seam artifacts). A <title> on each
    // arc gives a native hover tooltip (holding name - value - share).
    var ang = -Math.PI / 2, parts = "";
    segments.forEach(function (seg) {
      var frac = seg.value / total, a2 = ang + frac * 2 * Math.PI;
      var x1 = cx + r * Math.cos(ang), y1 = cy + r * Math.sin(ang);
      var x2 = cx + r * Math.cos(a2), y2 = cy + r * Math.sin(a2);
      var large = frac > 0.5 ? 1 : 0;
      parts += '<path d="M ' + x1.toFixed(2) + " " + y1.toFixed(2) + " A " + r + " " + r + " 0 " + large + " 1 " +
        x2.toFixed(2) + " " + y2.toFixed(2) + '" fill="none" stroke="' + seg.color + '" stroke-width="' + stroke + '"><title>' + esc(seg.label || "") + " - " + fmtV(seg.value) + " - " + pct(frac) + "</title></path>";
      ang = a2;
    });
    return open + parts + "</svg>";
  }
  function lineChartSVG(points, fmtY) {
    if (points.length < 2)
      return '<div class="chart-empty">Two months of history are needed to see your net-worth trend - snapshots are frozen automatically at each month-end.</div>';
    // wider left gutter to seat the Y-axis value labels (e.g. $663K, $669K)
    var w = 760, h = 230, pad = { l: 54, r: 12, t: 16, b: 26 };
    var vals = points.map(function (p) { return p.y; });
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    var range = (max - min) || 1; min -= range * 0.1; max += range * 0.1; range = max - min;
    var iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
    var X = function (i) { return pad.l + (i / (points.length - 1)) * iw; };
    var Y = function (v) { return pad.t + ih - ((v - min) / range) * ih; };
    // The SVG stretches to fill the box, but every stroke uses non-scaling-stroke and dots + axis text
    // live in an HTML overlay at fixed pixel size. Resizing the chart can change the data aspect, but it
    // must never make strokes thicker/thinner or dots oval.
    var px = function (sx) { return (sx / w * 100).toFixed(3); };
    var py = function (sy) { return (sy / h * 100).toFixed(3); };
    var i;
    // Y-axis gridlines (svg) + explicit value labels (overlay - clean Monarch-style numbering)
    var grid = "", yLabels = "", STEPS = 4;
    for (var g = 0; g <= STEPS; g++) {
      var gv = min + (range / STEPS) * g, gy = Y(gv);
      grid += '<line x1="' + pad.l + '" y1="' + gy.toFixed(1) + '" x2="' + (w - pad.r) + '" y2="' + gy.toFixed(1) +
        '" stroke="var(--chart-grid)" stroke-width="1" vector-effect="non-scaling-stroke"/>';
      yLabels += '<span class="chart-lbl chart-lbl-y" style="left:' + px(pad.l - 8) + '%;top:' + py(gy) + '%">' + esc((fmtY || fmtCompact)(gv)) + "</span>";
    }
    var d = "";
    for (i = 0; i < points.length; i++) d += (i ? "L" : "M") + X(i).toFixed(1) + " " + Y(points[i].y).toFixed(1) + " ";
    var area = d + "L " + X(points.length - 1).toFixed(1) + " " + (pad.t + ih) + " L " + X(0).toFixed(1) + " " + (pad.t + ih) + " Z";
    var dots = "", labels = "";
    for (i = 0; i < points.length; i++) {
      dots += '<span class="chart-dot" style="left:' + px(X(i)) + '%;top:' + py(Y(points[i].y)) + '%;background:#34d399"></span>';
      if (points.length <= 14 || i % Math.ceil(points.length / 12) === 0)
        labels += '<span class="chart-lbl chart-lbl-x" style="left:' + px(X(i)) + '%;top:' + py(h - 8) + '%">' + esc(points[i].x) + "</span>";
    }
    return '<div class="chart-wrap"><svg class="chart" viewBox="0 0 ' + w + " " + h + '" preserveAspectRatio="none" style="position:absolute;inset:0;width:100%;height:100%;display:block">' +
      '<defs><linearGradient id="lg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#34d399" stop-opacity="0.28"/><stop offset="1" stop-color="#34d399" stop-opacity="0"/></linearGradient></defs>' +
      grid +
      '<path d="' + area + '" fill="url(#lg)"/><path d="' + d + '" fill="none" stroke="#34d399" stroke-width="2.5" vector-effect="non-scaling-stroke"/>' +
      '</svg><div class="chart-ovl">' + yLabels + dots + labels + "</div></div>";
  }
  // ----- Trend range selector (Dashboard net worth + Investments) -----
  // Fixed range set: 1M / 3M / 6M / 1Y / All (full history). Monthly snapshots make finer ranges moot.
  // A monthly snapshot represents the MONTH-END value, so timestamp it at the last day of the month (not the
  // first) - otherwise a range like "1Y" would exclude a snapshot whose month-end is still inside the window.
  function monthMs(m) { var p = String(m).split("-"); return new Date(+p[0], (+p[1] || 1), 0).getTime(); }
  function trendRanges() {
    return [{ d: 30, l: "1M" }, { d: 91, l: "3M" }, { d: 182, l: "6M" }, { d: 365, l: "1Y" }, { d: Infinity, l: "All" }];
  }
  function trendRangeBar(chartKey, spanDays, current, noAll) {
    current = current || "all";
    var ranges = trendRanges(spanDays);
    if (noAll) ranges = ranges.filter(function (o) { return o.d !== Infinity; });   // Free History: no "All" (can't trend past 12 months)
    return '<span class="range-chips">' + ranges.map(function (o) {
      var v = o.d === Infinity ? "all" : String(o.d);
      return '<button type="button" class="rc-btn' + (v === current ? " on" : "") + '" data-act="set-trend-range" data-chart="' + chartKey + '" data-range="' + v + '">' + o.l + '</button>';
    }).join("") + '</span>';
  }
  function filterTrend(points, rangeVal) {
    if (!rangeVal || rangeVal === "all") return points;
    var cut = Date.now() - (+rangeVal) * 86400000;
    var f = points.filter(function (p) { return p.t >= cut; });
    return f.length >= 2 ? f : points.slice(-2);
  }
  // Multi-series line chart. points: [{x, <key>:value|null,...}], series: [{key,color,label}].
  function multiLineChartSVG(points, series, emptyMsg, wide, noLegend) {
    var hasData = points.length >= 2 && points.some(function (p) {
      return series.some(function (s) { return p[s.key] != null; });
    });
    if (!hasData) return '<div class="chart-empty">' + (emptyMsg || "Not enough data yet.") + "</div>";
    var w = wide ? 1080 : 760, h = wide ? 248 : 230, pad = { l: 54, r: 12, t: 16, b: 26 };
    // Holding "Value Over Time" (non-wide) gets compact axis/value type and a finer trend line.
    var compact = !wide;
    var axisFs = compact ? 8.5 : 10, lineW = compact ? 1.6 : 2;
    var dotR = compact
      ? (points.length <= 6 ? 2.9 : points.length <= 14 ? 2.5 : points.length <= 24 ? 2.0 : 1.6)
      : (points.length <= 14 ? 2.8 : 2.3);
    var allVals = [];
    points.forEach(function (p) { series.forEach(function (s) { if (p[s.key] != null) allVals.push(p[s.key]); }); });
    var min = Math.min.apply(null, allVals), max = Math.max.apply(null, allVals);
    min = Math.min(min, 0);
    var range = (max - min) || 1; max += range * 0.1; range = max - min;
    var iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
    var X = function (i) { return pad.l + (i / (points.length - 1)) * iw; };
    var Y = function (v) { return pad.t + ih - ((v - min) / range) * ih; };
    // SVG (line/area/grid) stretches to fill the box; strokes use non-scaling-stroke, while dots + axis
    // text are a fixed-px HTML overlay positioned by percentage, so they never distort on resize.
    var px = function (sx) { return (sx / w * 100).toFixed(3); };
    var py = function (sy) { return (sy / h * 100).toFixed(3); };
    var dotPx = (dotR * 2).toFixed(1);
    // Y-axis gridlines (svg) + gutter value labels (overlay - match the reference trend chart)
    var grid = "", yLabels = "", STEPS = 4;
    for (var gi = 0; gi <= STEPS; gi++) {
      var gv = min + (range / STEPS) * gi, gy = Y(gv);
      grid += '<line x1="' + pad.l + '" y1="' + gy.toFixed(1) + '" x2="' + (w - pad.r) + '" y2="' + gy.toFixed(1) +
        '" stroke="var(--chart-grid)" stroke-width="1" vector-effect="non-scaling-stroke"/>';
      yLabels += '<span class="chart-lbl chart-lbl-y" style="left:' + px(pad.l - 8) + '%;top:' + py(gy) + '%;font-size:' + axisFs + 'px">' + esc(fmtCompact(gv)) + "</span>";
    }
    var paths = "", dots = "";
    series.forEach(function (s, si) {
      var d = "", started = false, firstX = null, lastX = null;
      points.forEach(function (p, i) {
        if (p[s.key] == null) { started = false; return; }
        if (firstX == null) firstX = X(i);
        lastX = X(i);
        d += (started ? "L" : "M") + X(i).toFixed(1) + " " + Y(p[s.key]).toFixed(1) + " "; started = true;
      });
      if (si === 0 && firstX != null && lastX != null) {
        paths += '<path d="' + d + 'L ' + lastX.toFixed(1) + ' ' + (pad.t + ih) + ' L ' + firstX.toFixed(1) + ' ' + (pad.t + ih) + ' Z" fill="url(#mlg)"/>';
      }
      paths += '<path d="' + d + '" fill="none" stroke="' + s.color + '" stroke-width="' + lineW + '" vector-effect="non-scaling-stroke"/>';
      points.forEach(function (p, i) {
        if (p[s.key] != null) dots += '<span class="chart-dot" style="left:' + px(X(i)) + '%;top:' + py(Y(p[s.key])) + '%;width:' + dotPx + 'px;height:' + dotPx + 'px;background:' + s.color + '"></span>';
      });
    });
    var labels = "";
    points.forEach(function (p, i) {
      if (points.length <= 14 || i % Math.ceil(points.length / 12) === 0)
        labels += '<span class="chart-lbl chart-lbl-x" style="left:' + px(X(i)) + '%;top:' + py(h - 8) + '%;font-size:' + axisFs + 'px">' + esc(p.x) + "</span>";
    });
    var legend = series.map(function (s) {
      return '<span style="margin-right:16px;font-size:12px;color:var(--text-dim)"><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:' +
        s.color + ';margin-right:6px;vertical-align:middle"></span>' + (s.labelHtml || esc(s.label)) + "</span>";
    }).join("");
    return (noLegend ? "" : '<div style="margin-bottom:6px">' + legend + '</div>') + '<div class="chart-wrap"><svg class="chart" viewBox="0 0 ' + w + " " + h +
      '" preserveAspectRatio="none" style="position:absolute;inset:0;width:100%;height:100%;display:block">' +
      '<defs><linearGradient id="mlg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + (series[0] ? series[0].color : "#34d399") + '" stop-opacity="0.22"/><stop offset="1" stop-color="' + (series[0] ? series[0].color : "#34d399") + '" stop-opacity="0"/></linearGradient></defs>' +
      grid + paths + '</svg><div class="chart-ovl">' + yLabels + dots + labels + "</div></div>";
  }
  // Compact money formatter for chart axes/labels (e.g. €1.2k, €12k, €1.3M).
  function fmtCompact(v) {
    var c = curByCode(base()), sym = c ? c.symbol : "", a = Math.abs(num(v)), sign = num(v) < 0 ? "-" : "";
    if (a >= 1e6) return sign + sym + (a / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    if (a >= 1e3) return sign + sym + (a / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
    return sign + sym + Math.round(a);
  }
  // Grouped bar chart with a value (Y) axis and per-bar value labels.
  // points: [{x, <key>:value,...}], series: [{key,color,label}].
  function barChartSVG(points, series, emptyMsg) {
    var hasData = points.length && points.some(function (p) { return series.some(function (s) { return num(p[s.key]) > 0; }); });
    if (!hasData) return '<div class="chart-empty">' + (emptyMsg || "No data yet.") + "</div>";
    var w = 1080, h = 300, pad = { l: 56, r: 12, t: 20, b: 28 };
    var max = 0;
    points.forEach(function (p) { series.forEach(function (s) { max = Math.max(max, num(p[s.key])); }); });
    max = (max || 1) * 1.12;
    var iw = w - pad.l - pad.r, ih = h - pad.t - pad.b, n = points.length, groupW = iw / n;
    var barW = Math.min(groupW / (series.length + 1), 26);
    var Y = function (v) { return pad.t + ih - (v / max) * ih; };

    // Y-axis gridlines + value labels
    var grid = "", STEPS = 4;
    for (var g = 0; g <= STEPS; g++) {
      var gv = (max / STEPS) * g, gy = Y(gv);
      grid += '<line x1="' + pad.l + '" y1="' + gy.toFixed(1) + '" x2="' + (w - pad.r) + '" y2="' + gy.toFixed(1) +
        '" stroke="' + (g === 0 ? "var(--chart-grid-strong)" : "var(--chart-grid)") + '" stroke-width="1" vector-effect="non-scaling-stroke"/>' +
        '<text x="' + (pad.l - 6) + '" y="' + (gy + 3).toFixed(1) + '" text-anchor="end" font-size="9.5" fill="#6b7280">' + fmtCompact(gv) + "</text>";
    }

    var bars = "", labels = "", vals = "";
    points.forEach(function (p, i) {
      var gx = pad.l + i * groupW + groupW / 2, totalW = barW * series.length;
      series.forEach(function (s, si) {
        var v = num(p[s.key]), bh = (v / max) * ih, x = gx - totalW / 2 + si * barW, y = pad.t + ih - bh;
        bars += '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + Math.max(1, barW - 2).toFixed(1) +
          '" height="' + Math.max(0, bh).toFixed(1) + '" rx="2" fill="' + s.color + '"/>';
        if (v > 0) vals += '<text x="' + (x + (barW - 2) / 2).toFixed(1) + '" y="' + (y - 3).toFixed(1) +
          '" text-anchor="middle" font-size="8.5" fill="' + s.color + '">' + fmtCompact(v) + "</text>";
      });
      labels += '<text x="' + gx.toFixed(1) + '" y="' + (h - 8) + '" text-anchor="middle" font-size="10" fill="#6b7280">' + esc(p.x) + "</text>";
    });
    var legend = series.map(function (s) {
      return '<span style="margin-right:16px;font-size:12px;color:var(--text-dim)"><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:' +
        s.color + ';margin-right:6px;vertical-align:middle"></span>' + esc(s.label) + "</span>";
    }).join("");
    return '<div style="margin-bottom:6px">' + legend + '</div><svg class="chart" viewBox="0 0 ' + w + " " + h +
      '" style="width:100%;height:auto;display:block">' + grid + bars + vals + labels + "</svg>";
  }

  // ----------------------------------------------------------
  // UI state
  // ----------------------------------------------------------
  var state = { route: "dashboard", month: currentMonth(), histScope: "last12" };   // histScope: ytd | last12 | everything (History page scope toggle)
  function themeMode() {
    var t = db.settings.theme;
    return (t === "light" || t === "dim") ? t : "dark";
  }
  function languageMode() {
    return db.settings && db.settings.language === "it" ? "it" : "en";
  }
  function applyLanguageUI(root) {
    if (window.ValutioI18N && window.ValutioI18N.apply) {
      window.ValutioI18N.apply(root || document, languageMode());
    } else {
      try { document.documentElement.lang = languageMode(); } catch (e) { }
    }
  }
  function trUI(text) {
    return (window.ValutioI18N && window.ValutioI18N.translate) ? window.ValutioI18N.translate(text, languageMode()) : text;
  }
  function applyThemeChrome() {
    var t = themeMode();
    document.documentElement.classList.toggle("theme-light", t === "light");
    document.documentElement.classList.toggle("theme-dim", t === "dim");
    document.documentElement.classList.toggle("theme-dark", t === "dark");
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", t === "light" ? "#f4f5f7" : t === "dim" ? "#cdd3de" : "#121212");
    try { document.documentElement.lang = languageMode(); } catch (e) { }
  }
  // Retirement tracker working inputs. Editable values are persisted in db.retirement;
  // balance remains derived from live pension/super accounts.
  var retireState = { salary: 0, balance: 0, employerExtra: 0, voluntary: 0 };
  function syncRetireStateFromDb() {
    var r = db.retirement || {};
    retireState.salary = num(r.salary);
    retireState.employerExtra = num(r.employerExtra);
    retireState.voluntary = num(r.voluntary);
  }
  function saveRetireInput(key, value) {
    if (["salary", "employerExtra", "voluntary"].indexOf(key) === -1) return;
    if (!db.retirement || typeof db.retirement !== "object") db.retirement = {};
    db.retirement[key] = num(value);
    save();
  }
  var deferredInstall = null; // captured beforeinstallprompt event (Chromium)
  var INSTALL_DISMISS_KEY = "valutio_install_dismissed"; // "1" once the user clicks "Not now" on the first-run install popup

  // ----------------------------------------------------------
  // First-run interactive tutorial
  // ----------------------------------------------------------
  // Separate localStorage flag so it survives data import/reset and is independent of db.
  var TUTORIAL_KEY = "wallet_tutorial_v1";
  // A page-by-page walkthrough: each step switches the active view to orient the user, then shows a
  // dead-centered card. The final step is the month-end Freeze checkpoint call to action.
  var TUTORIAL_STEPS = [
    { route: "dashboard", ico: "dashboard", title: "Dashboard",
      body: "Your home base: net worth, what changed this month, allocation and your trend line at a glance." },
    { route: "dashboard", ico: "dashboard", title: "Make the cards yours",
      body: "Each summary card just below the header on the <strong>Dashboard</strong> and <strong>Investments</strong> has a small selector in its corner - open it to swap that slot for whichever figure matters most to you. Your choices are saved." },
    { route: "accounts", ico: "accounts", title: "Accounts",
      body: "List your bank, savings and cash accounts.<br>On the <strong>last day of the month</strong>, set each balance to the exact amount you hold that day - accurate closing balances are the backbone of your history." },
    { route: "investments", ico: "investments", title: "Investments",
      body: "Track Stocks, ETFs, Bonds, Commodities and Crypto with live prices and profit/loss. Hit <strong>Refresh Rates</strong> near month-end so the snapshot captures current values." },
    { route: "assets", ico: "assets", title: "Assets",
      body: "Log physical, non-liquid things you own - a car, property, art, watches. Tick <strong>Include in Net Worth</strong> to fold an asset into your net worth, allocation and frozen history; leave it off to simply keep track of it." },
    { route: "cashflow", ico: "expenses", title: "Cash Flow",
      body: "Money in and out for the month: net cash flow up top, income and expenses by category, and one combined ledger. This feeds your savings rate and how fast your net worth grows." },
    { route: "goals", ico: "flag", title: "Goals",
      body: "Set savings targets with a cost and a target date.<br>Each goal tracks your contributions, shows a progress bar and the <strong>monthly saving</strong> to get there on time." },
    { route: "history", ico: "history", title: "History",
      body: "Every month, year by year: net worth, investments, income and savings over time.<br>Switch month/year on the left and figures recalculate live - the current month stays real-time, past months read their frozen snapshot." },
    { route: "retirement", ico: "retirement", title: "Retirement",
      body: "Projects your retirement: it sums your pension accounts as a starting balance, then compounds your contributions to a retirement-age estimate using your country's statutory rates and caps." },
    { route: "tax", ico: "tax", title: "Tax",
      body: "A simple estimator: your brackets, invoices and employment income roll up into estimated tax and what you owe. Tune it under Tax Settings to match your country." },
    { route: "settings", ico: "settings", title: "Settings",
      body: "Currencies and FX, accounts, categories, colors, market data, backups and this tour. Everything stays on this PC; export a backup here to move it to another machine." },
  ];
  function tutorialPending() {
    try { return localStorage.getItem(TUTORIAL_KEY) !== "done"; } catch (e) { return false; }
  }
  function startTutorial() { state.tutorial = { step: 0 }; render(); }
  function finishTutorial() {
    state.tutorial = null;
    try { localStorage.setItem(TUTORIAL_KEY, "done"); } catch (e) { /* ignore */ }
    closeModal();
    state.route = "dashboard";
    render();
  }
  function renderTutorial() {
    if (!state.tutorial) return; // leave modal-root alone so real modals aren't clobbered
    var i = state.tutorial.step, s = TUTORIAL_STEPS[i], last = i === TUTORIAL_STEPS.length - 1;
    // clickable progress dots: jump to any step (bi-directional navigation)
    var dots = TUTORIAL_STEPS.map(function (_, k) {
      return '<button type="button" class="tut-dot' + (k === i ? " on" : (k < i ? " done" : "")) +
        '" data-act="tutorial-dot" data-step="' + k + '" title="Step ' + (k + 1) + '"></button>';
    }).join("");
    var modalRoot = document.getElementById("modal-root");
    modalRoot.innerHTML =
      '<div class="tut-blocker dim"></div>' +
      '<div class="tut-card">' +
      '<div class="tut-progress"><div class="tut-progress-fill" style="width:' + Math.round((i + 1) / TUTORIAL_STEPS.length * 100) + '%"></div></div>' +
      '<div class="tut-ico">' + icon(s.ico) + "</div>" +
      '<div class="tut-step">Step ' + (i + 1) + " of " + TUTORIAL_STEPS.length + "</div>" +
      "<h3>" + s.title + "</h3>" +
      '<p class="tut-body">' + s.body + "</p>" +
      '<div class="tut-dots">' + dots + "</div>" +
      '<div class="tut-foot">' +
      '<button type="button" class="btn ghost" data-act="tutorial-skip">Skip tour</button>' +
      '<div class="tut-foot-nav">' +
      (i > 0 ? '<button type="button" class="btn" data-act="tutorial-back">Back</button>' : "") +
      '<button type="button" class="btn primary" data-act="tutorial-next">' + (last ? "Got it" : "Next") + "</button>" +
      "</div></div></div>";
    applyLanguageUI(modalRoot);
  }

  // ----------------------------------------------------------
  // Toast + Modal
  // ----------------------------------------------------------
  var toastTimer;
  function toast(msg) {
    var root = document.getElementById("toast-root");
    root.innerHTML = '<div class="toast">' + esc(msg) + "</div>";
    applyLanguageUI(root);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { root.innerHTML = ""; }, 2600);
  }
  // Toast with an Undo button. `undoFn` runs if the user clicks Undo within the grace window.
  var pendingUndo = null;
  function toastUndo(msg, undoFn) {
    pendingUndo = undoFn;
    var root = document.getElementById("toast-root");
    root.innerHTML = '<div class="toast toast-action"><span>' + esc(msg) + '</span>' +
      '<button type="button" class="toast-undo" data-act="undo-delete">' + icon("refresh") + ' Undo</button></div>';
    applyLanguageUI(root);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { root.innerHTML = ""; pendingUndo = null; }, 6500);
  }
  function runUndo() {
    var u = pendingUndo; pendingUndo = null; clearTimeout(toastTimer);
    var root = document.getElementById("toast-root"); if (root) root.innerHTML = "";
    if (u) u();
  }
  // Refresh summary with failures: same action-toast shell as Undo, but the button opens a modal
  // listing exactly WHICH holdings kept their old price. The list lives only until the next
  // refresh overwrites it - informational, never persisted.
  var lastFetchFails = [];
  function fetchFailToast(msg, fails) {
    lastFetchFails = fails || [];
    var root = document.getElementById("toast-root");
    root.innerHTML = '<div class="toast toast-action"><span>' + esc(msg) + '</span>' +
      '<button type="button" class="toast-undo" data-act="show-fetch-fails">' + icon("chevron") + ' View more</button></div>';
    applyLanguageUI(root);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { root.innerHTML = ""; }, 8000);
  }
  function fetchFailModal() {
    if (!lastFetchFails.length) return;
    var rows = lastFetchFails.map(function (n) { return "<li>" + esc(n) + "</li>"; }).join("");
    openModal({
      title: "Prices not updated",
      sub: "These holdings kept their last saved price - the data provider didn't return a quote for them.",
      body: '<div class="help-box" style="margin:0 0 12px"><ul style="margin:0;padding-left:18px">' + rows + "</ul></div>" +
        '<p class="hint" style="margin:0">Usually a wrong or delisted ticker, or a briefly rate-limited provider. Check the symbol on the holding, hit Refresh again in a minute, or set a keyed provider in Settings → Data Providers.</p>',
      submitLabel: "Got it",
      onSubmit: function () { },
    });
  }
  // Sticky "update available" toast (no auto-dismiss): tapping Refresh applies a downloaded app update.
  var pendingUpdate = null;
  function updateToast(applyFn) {
    pendingUpdate = applyFn;
    var root = document.getElementById("toast-root"); if (!root) return;
    root.innerHTML = '<div class="toast toast-action"><span>A new version is available.</span>' +
      '<button type="button" class="toast-undo" data-act="apply-update">' + icon("refresh") + ' Refresh</button></div>';
    applyLanguageUI(root);
    clearTimeout(toastTimer);   // stays until the user acts (don't auto-dismiss an update prompt)
  }
  function applyUpdate() {
    var u = pendingUpdate; pendingUpdate = null;
    var root = document.getElementById("toast-root"); if (root) root.innerHTML = "";
    if (u) u();
  }
  // ----- Recurring cash flow: auto-log each active rule once per current month -----
  // Generates the CURRENT month's entry for every rule (idempotent via recurringId), from the month the
  // rule was created forward. Past months are never back-filled (they may already be frozen in History).
  function applyRecurring(month) {
    var cm = month || currentMonth(), added = 0;
    db.meta.recurringApplied = db.meta.recurringApplied || {};
    (db.recurring || []).forEach(function (r) {
      if (r.since && r.since > cm) return;
      // Once a rule's occurrence has been auto-logged for a month it's marked applied - so deleting that
      // occurrence (a rent-free month) doesn't cause it to resurrect on the next app open.
      var key = r.id + "|" + cm;
      if (db.meta.recurringApplied[key]) return;
      var list = r.kind === "income" ? db.incomes : db.expenses;
      var exists = list.some(function (x) { return x.recurringId === r.id && x.month === cm; });
      db.meta.recurringApplied[key] = 1;
      if (exists) return;
      var obj = { id: uid(), month: cm, category: r.category, amount: num(r.amount), currency: r.currency, note: r.note || "", recurringId: r.id };
      if (r.kind === "expense" && r.joint) { obj.joint = true; obj.share = num(r.share); }
      list.push(obj); added++;
    });
    return added;
  }
  function openModal(opts) {
    var root = document.getElementById("modal-root");
    if (opts.bare) {
      root.innerHTML =
        '<div class="modal-bg" data-modal-bg><div class="modal m-bare ' + (opts.cls ? opts.cls : "") + '">' +
        (opts.body || "") + "</div></div>";
      if (!opts.noBgClose) root.querySelector("[data-modal-bg]").addEventListener("mousedown", function (e) {
        if (e.target.hasAttribute("data-modal-bg")) closeModal();
      });
      applyLanguageUI(root);
      return;
    }
    root.innerHTML =
      '<div class="modal-bg" data-modal-bg><div class="modal m-banded ' + (opts.wide ? "wide" : "") + (opts.cls ? " " + opts.cls : "") + '">' +
      '<div class="m-hd"><h3>' + esc(opts.title) + '</h3>' +
      '<button type="button" class="m-x" data-act="close-modal" aria-label="Close">' + icon("close") + '</button></div>' +
      '<form id="modal-form"><div class="m-bd">' +
      (opts.sub ? '<div class="modal-sub">' + opts.sub + "</div>" : "") +
      (opts.body || "") + '</div>' +
      '<div class="modal-foot"><button type="button" class="btn ghost" data-act="close-modal">Cancel</button>' +
      '<button type="submit" class="btn ' + (opts.danger ? "danger" : "primary") + '">' + esc(opts.submitLabel || "Save") + "</button></div></form></div></div>";
    var form = document.getElementById("modal-form");
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (opts.onSubmit() !== false) closeModal();
    });
    if (!opts.noBgClose) root.querySelector("[data-modal-bg]").addEventListener("mousedown", function (e) {
      if (e.target.hasAttribute("data-modal-bg")) closeModal();
    });
    applyLanguageUI(root);
    var f = form.querySelector("input,select,textarea");
    if (f && !opts.noAutoFocus) f.focus();
  }
  function closeModal() { document.getElementById("modal-root").innerHTML = ""; }
  // Styled danger-confirm modal (replaces native window.confirm so every delete uses the same UI).
  function confirmDelete(title, sub, onConfirm, submitLabel) {
    openModal({ title: title, sub: sub, danger: true, submitLabel: submitLabel || "Delete", onSubmit: onConfirm });
  }

  function currencyOptions(selected) {
    var rows = db.currencies.slice();
    if (selected && !rows.some(function (c) { return c.code === selected; })) rows.push({ code: selected, symbol: currencySymbol(selected), rate: 1 });
    return rows.map(function (c) {
      return '<option value="' + c.code + '"' + (c.code === selected ? " selected" : "") + ">" +
        c.code + " (" + c.symbol + ")</option>";
    }).join("");
  }
  function currencyCatalogOptions(selected) {
    return currencyCatalogCodes().map(function (code) {
      return '<option value="' + code + '"' + (code === selected ? " selected" : "") + ">" + esc(currencyLabel(code)) + "</option>";
    }).join("");
  }
  function resolveCatalogCurrency(value) {
    var s = String(value || "").trim(), u = s.toUpperCase();
    if (/^[A-Z]{3}$/.test(u) && supportedCurrencyCodes().indexOf(u) >= 0) return u;
    var hit = currencyCatalogCodes().filter(function (code) {
      return currencyName(code).toLowerCase() === s.toLowerCase() || currencyLabel(code).toLowerCase() === s.toLowerCase();
    })[0];
    return hit || "";
  }
  // Full catalog for choosing primary/secondary currencies; the wallet still tracks only currencies in use.
  function presetCurrencyOptions(selected) {
    return currencyCatalogOptions(selected);
  }
  function currencySuggestionList(query) {
    var q = String(query || "").trim().toLowerCase();
    var codes = currencyCatalogCodes().filter(function (code) {
      if (!q) return true;
      return code.toLowerCase().indexOf(q) >= 0 ||
        currencyName(code).toLowerCase().indexOf(q) >= 0 ||
        String(currencySymbol(code) || "").toLowerCase().indexOf(q) >= 0;
    });
    return codes.slice(0, q ? 80 : codes.length);
  }
  function currencySuggestionHTML(query) {
    var codes = currencySuggestionList(query);
    if (!codes.length) return '<div class="currency-empty">No matching currency</div>';
    return codes.map(function (code) {
      var sym = String(currencySymbol(code) || "").trim();
      return '<button type="button" class="currency-option" data-act="pick-currency" data-code="' + esc(code) + '">' +
        '<span class="currency-code">' + esc(code) + '</span>' +
        '<span class="currency-name">' + esc(currencyName(code)) + '</span>' +
        (sym && sym !== code ? '<span class="currency-symbol">' + esc(sym) + '</span>' : "") +
      "</button>";
    }).join("");
  }
  function setCurrencyPickerCode(code) {
    code = String(code || "").toUpperCase();
    if (!code) return;
    var pm = CURRENCY_META[code] || { symbol: currencySymbol(code) };
    var preset = document.getElementById("c-preset");
    if (preset) { preset.value = currencyLabel(code); preset.setAttribute("data-picked-code", code); }
    var cc = document.getElementById("c-code"); if (cc) cc.value = code;
    var csym = document.getElementById("c-sym"); if (csym) csym.value = (pm.symbol || "").trim();
    var crate = document.getElementById("c-rate"); if (crate && !crate.value) crate.value = metaRateInBase(code) || "";
  }
  function refreshCurrencySuggestions(query) {
    var box = document.getElementById("currency-suggestions");
    if (box) box.innerHTML = currencySuggestionHTML(query);
  }
  function positionCurrencySuggestions() {
    var box = document.getElementById("currency-suggestions");
    var modal = document.querySelector(".modal.currency-modal");
    if (!box || !modal) return;
    var mr = modal.getBoundingClientRect();
    var gap = 14, pad = 20;
    var rightSpace = window.innerWidth - mr.right - gap - pad;
    var leftSpace = mr.left - gap - pad;
    var openRight = rightSpace >= leftSpace;
    var available = Math.max(openRight ? rightSpace : leftSpace, Math.max(rightSpace, leftSpace));
    var w = Math.min(460, Math.max(280, available));
    var h = Math.min(Math.max(300, mr.height), window.innerHeight - pad * 2);
    var left = openRight ? mr.right + gap : mr.left - w - gap;
    if (left + w > window.innerWidth - pad) left = window.innerWidth - w - pad;
    if (left < pad) left = Math.max(pad, window.innerWidth - w - pad);
    var top = Math.min(Math.max(pad, mr.top), window.innerHeight - h - pad);
    box.style.setProperty("--currency-panel-left", left + "px");
    box.style.setProperty("--currency-panel-top", top + "px");
    box.style.setProperty("--currency-panel-width", w + "px");
    box.style.setProperty("--currency-panel-height", h + "px");
  }
  function openCurrencySuggestions(input, queryOverride) {
    var q = queryOverride != null ? queryOverride : (input ? input.value : "");
    refreshCurrencySuggestions(q);
    var box = document.getElementById("currency-suggestions");
    if (box) { box.classList.add("open"); positionCurrencySuggestions(); }
    if (input) input.setAttribute("aria-expanded", "true");
  }
  function closeCurrencySuggestions() {
    var cp = document.getElementById("c-preset"), box = document.getElementById("currency-suggestions");
    if (cp) cp.setAttribute("aria-expanded", "false");
    if (box) box.classList.remove("open");
  }
  function selectOptions(list, selected) {
    return list.map(function (x) {
      return '<option value="' + esc(x) + '"' + (x === selected ? " selected" : "") + ">" + esc(x) + "</option>";
    }).join("");
  }
  function monthSelect(id, selected) {
    var months = recentMonths(24);
    // If the edited entry's own month predates the 24-month window, keep it as an option (newest position)
    // so editing an old row doesn't silently re-date it to the current month (the browser would otherwise
    // pick the first option when `selected` matches none).
    if (selected && months.indexOf(selected) < 0) months.unshift(selected);
    return '<select id="' + id + '">' + months.map(function (m) {
      return '<option value="' + m + '"' + (m === selected ? " selected" : "") + ">" + monthLabel(m) + "</option>";
    }).join("") + "</select>";
  }

  // ----------------------------------------------------------
  // Sidebar
  // ----------------------------------------------------------
  var NAV = [
    { id: "dashboard", icon: "dashboard", label: "Dashboard" },
    { id: "investments", icon: "investments", label: "Investments" },
    { id: "accounts", icon: "accounts", label: "Accounts" },
    { id: "assets", icon: "assets", label: "Assets" },
    { id: "debts", icon: "debt", label: "Debts" },
    { id: "cashflow", icon: "expenses", label: "Cash Flow" },
    { id: "goals", icon: "flag", label: "Goals" },
    { id: "history", icon: "history", label: "History" },
    { id: "retirement", icon: "retirement", label: "Retirement" },
    { id: "tax", icon: "tax", label: "Tax" },
    { id: "settings", icon: "settings", label: "Settings" },
  ];
  function periodYears() {
    var cy = new Date().getFullYear(), ys = {};
    ys[cy] = 1;                                                            // default: current year only
    ys[+state.month.slice(0, 4)] = 1;                                      // always keep the selected year
    db.snapshots.forEach(function (s) { ys[+s.month.slice(0, 4)] = 1; });  // expand to any year that has history
    (db.meta.customYears || []).forEach(function (y) { ys[+y] = 1; });     // user-added years (+ Add Year)
    return Object.keys(ys).map(Number).sort(function (a, b) { return b - a; });
  }
  function sidebar() {
    var curY = new Date().getFullYear(), curMo = new Date().getMonth() + 1;
    var monthFrozen = !!snapByMonth(state.month) && state.month !== currentMonth();
    // "Viewing period": a Year selector scopes the Month dropdown to that year, so the month list stays
    // short (max 12) however many years accumulate.
    var selYear = +state.month.slice(0, 4);
    var yearOpts = periodYears().map(function (y) {
      return '<option value="' + y + '"' + (y === selYear ? " selected" : "") + ">" + y + "</option>";
    }).join("") + '<option value="__add_year__">+ Add Year\u2026</option>';
    // Months shown for the selected year: the current month, any month that has a snapshot, user-added
    // months (+ Add Month), and the currently-selected month - newest first. Not every month of the year.
    var yStr = String(selYear), cmStr = currentMonth(), monthSet = {};
    if (cmStr.slice(0, 4) === yStr) monthSet[+cmStr.slice(5)] = 1;
    db.snapshots.forEach(function (s) { if (s.month.slice(0, 4) === yStr) monthSet[+s.month.slice(5)] = 1; });
    (db.meta.customMonths || []).forEach(function (m) { if (m.slice(0, 4) === yStr) monthSet[+m.slice(5)] = 1; });
    if (state.month.slice(0, 4) === yStr) monthSet[+state.month.slice(5)] = 1;
    var monthOpts = Object.keys(monthSet).map(Number).sort(function (a, b) { return b - a; }).map(function (mn) {
      var mm = selYear + "-" + String(mn).padStart(2, "0");
      var cur = mm === cmStr, frozen = !!snapByMonth(mm) && !cur;
      return '<option value="' + mm + '"' + (frozen ? ' class="opt-frozen"' : "") +
        (mm === state.month ? " selected" : "") + ">" + monthName(mn - 1) + (cur ? " (now)" : "") + "</option>";
    }).join("") + '<option value="__add_month__">+ Add Month…</option>';
    var period = '<div class="side-period"><span class="period-label">Viewing period</span>' +
      '<div class="period-row">' +
        '<select data-act="set-year" class="period-year">' + yearOpts + '</select>' +
        '<select data-act="set-month" class="period-month ' + (monthFrozen ? "frozen-sel" : "") + '">' + monthOpts + '</select>' +
      '</div></div>';
    // Net-worth headline change line: net worth (assets - debts) vs the most recent prior snapshot.
    var nwNow = netWorthAfterDebts();
    var priorSnap = null;
    db.snapshots.slice().sort(function (a, b) { return a.month < b.month ? -1 : 1; })
      .forEach(function (s) { if (s.month < currentMonth()) priorSnap = s; });
    var chgHTML = "";
    if (priorSnap) {
      var d = nwNow - priorSnap.netWorth, dp = priorSnap.netWorth ? d / Math.abs(priorSnap.netWorth) : 0;
      chgHTML = '<div class="chg ' + signClass(d) + '">' + icon(d >= 0 ? "arrowUp" : "arrowDown") +
        signFmt(d, base()) + " (" + (d >= 0 ? "+" : "") + pct(dp) + ")</div>";
    }
    return '<div class="sidebar"><div class="brand">' +
      '<span class="mark"><img src="Icons/VAL-03.png" alt="Valutio"></span>' +
      '<button class="name" data-act="rename-wallet" title="Click to rename">' + esc(db.settings.name || "Valutio") +
      '<span class="sub">Net worth tracker</span></button>' +
      "</div>" +
      '<div class="side-networth"><span class="nw-label">Net worth</span><strong class="nw-value">' +
      fmtBase(nwNow, 0) + "</strong>" + chgHTML + "</div>" +
      period +
      '<div class="nav-sep"></div>' +
      '<nav class="nav">' +
      NAV.map(function (n) {
        return '<button class="nav-item ' + (state.route === n.id ? "active" : "") + '" data-act="nav" data-id="' + n.id + '">' +
          icon(n.icon) + "<span>" + n.label + "</span></button>";
      }).join("") +
      "</nav>" +
      '<div class="side-foot">' +
      '<button class="side-action" data-act="refresh-prices">' + icon("refresh") + "<span>Refresh Rates</span></button>" +
      '<div class="nav-sep"></div>' +
      '<button class="side-donate" data-act="donate"><span class="donate-txt">Donate - free &amp; open source</span></button>' +
      '<button class="side-help" data-act="help-support">' + icon("help") + "<span>Help &amp; Support</span></button>" +
      '<button class="side-help" data-act="contact-support">' + MAIL_ICON + "<span>Contact</span></button>" +
      "</div>" +
      "</div>";
  }
  // Inline envelope glyph for the sidebar Contact button (the self-hosted icon font is a fixed subset that
  // has no mail glyph, so this ships the SVG directly, sized by the shared .ico rule).
  var MAIL_ICON = '<svg class="ico ico-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>';
  // Magnifying-glass glyph for the Add-Holding search button (the icon-font subset has no search glyph);
  // same inline-SVG style as MAIL_ICON so it reads as one of the app's icons, not an emoji.
  var SEARCH_ICON = '<svg class="ico ico-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/></svg>';

  // ----------------------------------------------------------
  // Pages
  // ----------------------------------------------------------
  // Pages that carry the privacy "hide values" eye toggle (financial figures shown). Goals, Retirement
  // and Settings are intentionally excluded.
  var EYE_ROUTES = { dashboard: 1, investments: 1, accounts: 1, assets: 1, debts: 1, cashflow: 1, history: 1, tax: 1 };
  var EYE_ON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>';
  var EYE_OFF = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
  function eyeToggleBtn() {
    var hidden = !!db.settings.hideValues;
    return '<button class="btn icon-only eye-toggle' + (hidden ? " on" : "") + '" data-act="toggle-hide-values" aria-pressed="' + hidden +
      '" title="' + (hidden ? "Show values" : "Hide values") + '">' + (hidden ? EYE_OFF : EYE_ON) + "</button>";
  }
  function pageHead(title, sub, actions, badge) {
    var eye = EYE_ROUTES[state.route] ? eyeToggleBtn() : "";
    return '<div class="page-head"><div><h1>' + esc(title) + (badge ? " " + badge : "") + "</h1>" +
      (sub ? '<div class="sub">' + sub + "</div>" : "") + "</div>" +
      '<div class="head-actions">' + eye + (actions || "") + "</div></div>";
  }

  // ----- Dashboard -----
  function snapByMonth(m) { return db.snapshots.filter(function (s) { return s.month === m; })[0]; }

  function dashboardPage() {
    var m = state.month;
    var snaps = db.snapshots.slice().sort(function (a, b) { return a.month < b.month ? -1 : 1; });
    var snap = snapByMonth(m);
    var isCurrent = (m === currentMonth());
    var useSnap = !isCurrent && !!snap;   // viewing a frozen past month

    var view, mode;
    if (useSnap) {
      view = {
        netWorth: snap.netWorth, gross: num(snap.gross != null ? snap.gross : snap.netWorth),
        invest: snap.invest, cost: snap.cost,
        unreal: snap.unrealized, real: snap.realized, buckets: snap.buckets || {},
        income: num(snap.income), expenses: num(snap.expenses),
      };
      mode = "snapshot";
    } else {
      var pf = portfolioTotals();
      view = {
        netWorth: netWorthAfterDebts(), gross: grossNetWorth(),
        invest: pf.mv, cost: pf.cost, unreal: pf.unreal, real: pf.real,
        buckets: netWorthBuckets(), income: monthTotal(db.incomes, m), expenses: monthTotal(db.expenses, m),
      };
      mode = isCurrent ? "live" : "nosnap";
    }
    var savingsRate = view.income > 0 ? (view.income - view.expenses) / view.income : 0;

    // reference month for change %
    var refSnap = null;
    snaps.forEach(function (s) { if (s.month < (useSnap ? m : currentMonth())) refSnap = s; });
    var changeHTML;
    if (refSnap) {
      var ch = view.netWorth - refSnap.netWorth, chPct = refSnap.netWorth ? ch / Math.abs(refSnap.netWorth) : 0;
      changeHTML = '<div class="delta ' + signClass(ch) + '">' + signFmt(ch) + " (" + (ch >= 0 ? "+" : "") + pct(chPct) + ')</div><div class="sub">This month</div>';
    } else {
      changeHTML = '<div class="sub">No prior snapshot to compare.</div>';
    }

    // Convert a base amount into a display currency using the FROZEN month's rate when viewing a past month
    // (so a frozen figure shown in another currency doesn't drift with today's FX), else the live rate.
    var dispFromBase = function (baseAmt, ccy) {
      var r = (useSnap && snap && snap.rates && snap.rates[ccy] != null) ? num(snap.rates[ccy]) : (curByCode(ccy) || {}).rate || 1;
      return r ? num(baseAmt) / r : num(baseAmt);
    };
    var secCur = db.settings.secondaryCurrency;
    var secLine = secCur && curByCode(secCur) ?
      '<div class="sub">' + fmt(dispFromBase(view.netWorth, secCur), secCur, 0) + " " + secCur + "</div>" : "";

    // Top-row figures: accounts = everything that isn't a holding or a physical asset; taxes from the estimator.
    // calcTax() works in the tax currency, so convert the owed balance into the base currency,
    // then add the capital-gains reserve on unrealized investment gains (already base currency).
    var physVal = useSnap ? num(snap.physAssets) : physicalAssetsTotal();
    var accountsTotal = view.gross - view.invest - physVal;   // gross assets, before debts (cash/savings/pension)
    // Income tax is an annual, live estimate - it can't be attributed to a frozen historical month-end,
    // so only fold it in for the current/live month. We sum the OUTSTANDING balance of every tax year not
    // yet marked paid (live + archived), so a just-ended year you still owe doesn't vanish at rollover and
    // a paid year never double-counts. The capital-gains reserve IS month-specific (computed from THAT
    // month's unrealized gains), so it always applies to the active view.
    var incomeTaxOwed = isCurrent ? outstandingIncomeTaxBase() : 0;
    var unpaidYears = isCurrent ? unpaidTaxYearCount() : 0;
    var cgtReserve = capitalGainsReserve(view.unreal);
    var taxOwed = incomeTaxOwed + cgtReserve;
    var netAfterTax = view.netWorth - taxOwed;

    // "What Changed" figures
    var totalCh = refSnap ? (view.netWorth - refSnap.netWorth) : null;
    var unrealCh = refSnap ? (view.unreal - num(refSnap.unrealized)) : null;
    var savedAmt = view.income - view.expenses;

    // allocation (from the active view's buckets)
    var buckets = view.buckets;
    // Allocation currency view (dropdown by the heading). Two families, one entry per currency held:
    //   total:<ccy> - the WHOLE portfolio converted into <ccy> (proportions unchanged)
    //   only:<ccy>  - only the slice actually HELD natively in <ccy>, shown in <ccy>
    // Falls back to total:<base> if the stored choice points at a currency no longer held.
    var allocCurs = allocCurrencies();
    var _asp = String(db.settings.allocCurrency || "").split(":");
    var allocKind = _asp[0] === "only" ? "only" : "total", allocCcy = _asp[1] || base();
    if (allocCurs.indexOf(allocCcy) < 0) { allocKind = "total"; allocCcy = base(); }
    var allocSel = allocKind + ":" + allocCcy;
    var aFmt = function (v) { return fmt(v, allocCcy, 0); };
    var allocSegs, allocGross;
    if (allocKind === "only") {
      // Native slice per currency. For a frozen month reconstruct it from THAT month's per-line records, not
      // live data (which would show today's holdings under a past-month label).
      var nativeBk = useSnap ? snapshotBucketsByCcy(snap) : netWorthBucketsByCcy();
      allocSegs = Object.keys(nativeBk)
        .map(function (k) { return { label: k, value: num(nativeBk[k][allocCcy]), color: bucketColor(k) }; })
        .filter(function (s) { return s.value > 0; })
        .sort(function (a, b) { return b.value - a.value; });
      allocGross = allocSegs.reduce(function (t, s) { return t + s.value; }, 0);
    } else {
      allocSegs = Object.keys(buckets).filter(function (k) { return buckets[k] > 0; })
        .sort(function (a, b) { return buckets[b] - buckets[a]; })
        .map(function (k) { return { label: k, value: dispFromBase(buckets[k], allocCcy), color: bucketColor(k) }; });
      // Total of the POSITIVE buckets shown (matches the donut) - so a negative bucket can't push a legend
      // share past 100% or make the legend disagree with the ring.
      allocGross = allocSegs.reduce(function (t, s) { return t + s.value; }, 0);
    }
    var segs = allocSegs;
    var allocRows = allocSegs.map(function (s) {
      var p = allocGross ? s.value / allocGross : 0;   // share of GROSS (buckets stay positive)
      return '<div class="alloc-row"><span class="dot" style="background:' + s.color + '"></span>' +
        '<div class="alloc-txt"><div class="alloc-name">' + esc(s.label) + '</div>' +
        '<div class="alloc-meta"><b>' + aFmt(s.value) + "</b> \u00b7 " + pct(p) + "</div></div></div>";
    }).join("");
    var allocLegend = allocRows
      ? '<div class="alloc-legend">' + allocRows + "</div>"
      : '<div class="alloc-legend"><div class="muted">' + (allocKind === "only" ? "Nothing held in " + esc(allocCcy) + "." : "Add accounts or holdings to see your allocation.") + "</div></div>";

    var trendPts = snaps.map(function (s) { return { x: monthLabel(s.month).slice(0, 3), y: s.netWorth, t: monthMs(s.month) }; });
    if (isCurrent) trendPts.push({ x: "Now", y: netWorthAfterDebts(), t: Date.now() });
    var dashSpan = trendPts.length >= 2 ? (trendPts[trendPts.length - 1].t - trendPts[0].t) / 86400000 : 0;
    var dashShown = filterTrend(trendPts, state.dashRange);
    var trendPill = "";
    if (dashShown.length >= 2 && dashShown[0].y) {
      var _tpc = (dashShown[dashShown.length - 1].y - dashShown[0].y) / Math.abs(dashShown[0].y);
      trendPill = '<span class="' + (_tpc >= 0 ? "pill-up" : "pill-down") + '">' + (_tpc >= 0 ? "+" : "") + pct(_tpc) + "</span>";
    }

    var badge = mode === "snapshot" ? statusBadge(esc(monthLabel(m)), icon("lock") + "Frozen", "frozen")
      : mode === "nosnap" ? statusBadge(esc(monthLabel(m)), "Live - no snapshot", "neutral")
        : statusBadge(esc(monthLabel(m)), "Live", "live");

    var heroChPct = (refSnap && refSnap.netWorth) ? totalCh / Math.abs(refSnap.netWorth) : 0;   // abs base so a negative prior NW doesn't flip the % sign
    var heroDelta = (totalCh == null)
      ? '<div class="sub" style="margin-top:12px">No prior snapshot to compare.</div>'
      : '<div class="hero-delta ' + signClass(totalCh) + '">' + icon(totalCh >= 0 ? "arrowUp" : "arrowDown") +
        '<span>' + fmt(Math.abs(totalCh)) + " (" + pct(Math.abs(heroChPct)) + ") this month</span></div>";

    // Year-to-date growth: net worth now vs the last snapshot before this calendar year.
    var yrPrefix = (useSnap ? m : currentMonth()).slice(0, 4) + "-01";
    var yrStart = null;
    snaps.forEach(function (s) { if (s.month < yrPrefix) yrStart = s; });
    var ytd = yrStart ? view.netWorth - yrStart.netWorth : null;
    var ytdHTML = (ytd == null) ? '<span class="muted">-</span>'
      : '<span class="' + signClass(ytd) + '">' + signFmt(ytd) + "</span>";

    // Trend date range label for the hero chart head.
    var trendRange = snaps.length ? shortMonth(snaps[0].month) + " \u2192 " + shortMonth(isCurrent ? currentMonth() : m) : "";

    // What Changed: split the net-worth move into market performance vs money added (income \u2212 expenses).
    var market = (totalCh == null) ? null : (totalCh - savedAmt);
    var savingsPctW = Math.max(0, Math.min(100, savingsRate * 100));
    // Total saved this year = sum of (income - expenses) across every month of the active year.
    var savedYearPrefix = (useSnap ? m : currentMonth()).slice(0, 4);
    var savedYear = 0;
    for (var smo = 1; smo <= 12; smo++) {
      var smm = savedYearPrefix + "-" + String(smo).padStart(2, "0");
      savedYear += monthTotal(db.incomes, smm) - monthTotal(db.expenses, smm);
    }

    // ---- Focal hero: net worth + after-tax + YTD, fused with the detailed trend chart ----
    var hero =
      '<div class="hero accent mb">' +
        '<div class="hero-figs">' +
          '<div class="hero-label">Net Worth</div>' +
          '<div class="hero-value">' + fmtBase(view.netWorth, 0) + '</div>' +
          (secCur && curByCode(secCur) ? '<div class="sub" style="margin-top:4px">' + fmt(fromBase(view.netWorth, secCur), secCur, 0) + ' ' + esc(secCur) + '</div>' : '') +
          heroDelta +
          '<div class="hero-subs">' +
            '<div class="hero-subcol">' +
              '<div><div class="lbl">After-Tax Net Worth</div><div class="val">' + fmtBase(netAfterTax, 0) + '</div></div>' +
              '<div><div class="lbl">Total Saved \u00b7 ' + esc(savedYearPrefix) + '</div><div class="val ' + signClass(savedYear) + '">' + signFmt(savedYear) + '</div></div>' +
            '</div>' +
            '<div><div class="lbl">Year To Date Growth</div><div class="val">' + ytdHTML + '</div></div>' +
          '</div>' +
        '</div>' +
        '<div class="hero-side">' +
          (dashShown.length >= 2 ? '<div class="hero-head"><span class="t">Net Worth Trend</span><span class="r">' + (trendPill ? trendPill + '&nbsp;&nbsp;' : '') + trendRangeBar("dash", dashSpan, state.dashRange) + '</span></div>' : '') +
          lineChartSVG(dashShown) +
        '</div>' +
      '</div>';

    // ---- Compact KPI rail: the supporting figures (each slot user-swappable) ----
    var ytdPct = (yrStart && yrStart.netWorth) ? ytd / Math.abs(yrStart.netWorth) : null;
    var ytdYear = (useSnap ? m : currentMonth()).slice(0, 4);
    var debtsTotal = Math.max(0, view.gross - view.netWorth);   // gross assets minus net worth = liabilities
    var moLbl = esc(monthLabel(m));
    var DASH_REG = {
      accounts:    { label: "Accounts",           cell: kpiCell("Accounts", fmtBase(accountsTotal, 0), "Cash \u00b7 Savings \u00b7 Pension") },
      investments: { label: "Investments",        cell: kpiCell("Investments", fmtBase(view.invest, 0), signFmt(view.unreal) + " Unrealized", "", signClass(view.unreal)) },
      nwGrowth:    { label: "Net Worth Growth",    cell: kpiCell("Net Worth Growth", (ytdPct != null ? (ytdPct >= 0 ? "+" : "") + pct(ytdPct) : "\u2013"), esc(ytdYear) + " YTD", ytd == null ? "" : signClass(ytd)) },
      taxes:       { label: "Total Taxes",         cell: kpiCell(isCurrent ? "Total Current Taxes" : "Capital Gains Reserve", fmtBase(taxOwed, 0),
                       isCurrent ? (fmtBase(incomeTaxOwed, 0) + " Income" + (unpaidYears > 1 ? " (" + unpaidYears + " yrs)" : "") + " \u00b7 " + fmtBase(cgtReserve, 0) + " CGT")
                         : ("On " + signFmt(view.unreal) + " Unrealized \u00b7 " + moLbl), "down") },
      netAfterTax: { label: "After-Tax Net Worth", cell: kpiCell("After-Tax Net Worth", fmtBase(netAfterTax, 0), "Net worth less taxes") },
      gross:       { label: "Gross Assets",        cell: kpiCell("Gross Assets", fmtBase(view.gross, 0), "Before debts") },
      debts:       { label: "Total Debts",         cell: kpiCell("Total Debts", fmtBase(debtsTotal, 0), "Loans \u00b7 liabilities", "down") },
      unrealized:  { label: "Unrealized P/L",      cell: kpiCell("Unrealized P/L", signFmt(view.unreal), "On investments", signClass(view.unreal)) },
      physical:    { label: "Physical Assets",     cell: kpiCell("Physical Assets", fmtBase(physVal, 0), "Property, vehicles, etc.") },
      savingsRate: { label: "Savings Rate",        cell: kpiCell("Savings Rate", pct(savingsRate), "Saved \u00b7 " + moLbl, "", signClass(savingsRate)) },
      saved:       { label: "You Saved",           cell: kpiCell("You Saved", signFmt(savedAmt), "Income \u2212 expenses \u00b7 " + moLbl, signClass(savedAmt)) },
      netMove:     { label: "Net-Worth Move",      cell: kpiCell("Net-Worth Move", totalCh == null ? "\u2013" : signFmt(totalCh), "This month", totalCh == null ? "" : signClass(totalCh)) },
      market:      { label: "Market Performance",  cell: kpiCell("Market Performance", market == null ? "\u2013" : signFmt(market), "This month", market == null ? "" : signClass(market)) },
      income:      { label: "Income",              cell: kpiCell("Income", fmtBase(view.income, 0), moLbl, "up") },
      expenses:    { label: "Expenses",            cell: kpiCell("Expenses", fmtBase(view.expenses, 0), moLbl, "down") },
    };
    var rail = kpiRail(DASH_REG, db.settings.dashCards, DASH_CARDS_DEFAULT, "set-dash-card");

    // ---- Allocation + What Changed two-up ----
    // Currency selector by the heading - only shown once more than one currency is held. "Total (X)"
    // converts the whole portfolio into X; "Only (X)" shows just the slice held natively in X.
    var allocCurSel = allocCurs.length > 1
      ? '<select class="alloc-cur-sel" data-act="set-alloc-currency" title="Show allocation values in...">' +
          '<optgroup label="Total">' +
            allocCurs.map(function (c) { return '<option value="total:' + esc(c) + '"' + (allocSel === "total:" + c ? " selected" : "") + ">Total (" + esc(c) + ")</option>"; }).join("") +
          "</optgroup>" +
          '<optgroup label="Only">' +
            allocCurs.map(function (c) { return '<option value="only:' + esc(c) + '"' + (allocSel === "only:" + c ? " selected" : "") + ">Only (" + esc(c) + ")</option>"; }).join("") +
          "</optgroup>" +
        "</select>"
      : "";
    var allocation =
      '<div class="panel"><div class="alloc-head"><h2>Allocation</h2>' + allocCurSel + "</div>" +
      '<p class="hint">' + (allocKind === "only" ? "Only what you hold natively in " + esc(allocCcy) : "How your net worth is split across buckets") + (useSnap ? " (" + esc(monthLabel(m)) + ")" : "") + ".</p>" +
      '<div class="donut-wrap"><div class="donut">' + donutSVG(segs, null, null, aFmt) +
      (allocGross > 0 ? '<div class="center"><div class="t">' + (allocKind === "only" ? esc(allocCcy) : "Gross") + '</div><div class="v">' + aFmt(allocGross) + "</div></div>" : "") + "</div>" +
      allocLegend + "</div></div>";

    var netMove = (totalCh == null) ? savedAmt : totalCh;
    var srFrac = Math.max(0, Math.min(1, savingsRate));
    // savings-rate ring (Option C): green progress arc with the % in the middle
    var srR = 49, srC = 2 * Math.PI * srR, srLen = srC * srFrac;
    var srRing =
      '<div class="wc-ring"><svg viewBox="0 0 116 116" width="116" height="116">' +
        '<circle cx="58" cy="58" r="' + srR + '" fill="none" stroke="var(--surface-3)" stroke-width="9"/>' +
        '<circle cx="58" cy="58" r="' + srR + '" fill="none" stroke="var(--pos)" stroke-width="9" stroke-linecap="round" ' +
        'stroke-dasharray="' + srLen.toFixed(1) + ' ' + (srC - srLen).toFixed(1) + '" transform="rotate(-90 58 58)"/></svg>' +
        '<div class="wc-ring-c"><div class="p">' + Math.round(srFrac * 100) + '%</div><div class="l">Saved</div></div></div>';
    var whatChanged =
      '<div class="panel whatchanged"><h2>What Changed' + (refSnap ? " Since " + esc(monthLabel(refSnap.month)) : "") + '</h2>' +
      '<p class="hint">Your net-worth move: market performance vs. money you added.</p>' +
      '<div class="wc-flex"><div class="wc-left">' +
        '<div class="wc-totlbl">Net-worth move</div>' +
        '<div class="wc-total ' + signClass(netMove) + '">' + signFmt(netMove) + '</div>' +
        '<div class="wc-rows">' +
          '<div class="wc-row"><div class="wc-ic wc-ic-mkt"><svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12 L12 4 M6 4 L12 4 L12 10"/></svg></div>' +
            '<div class="wc-rn">Market performance<small>Investments &amp; FX</small></div>' +
            '<div class="wc-rv ' + (market == null ? "" : signClass(market)) + '">' + (market == null ? "\u2014" : signFmt(market)) + '</div></div>' +
          '<div class="wc-row"><div class="wc-ic wc-ic-sav"><svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 3 L8 13 M3 8 L13 8"/></svg></div>' +
            '<div class="wc-rn">You saved<small>Added to accounts</small></div>' +
            '<div class="wc-rv ' + signClass(savedAmt) + '">' + signFmt(savedAmt) + '</div></div>' +
        '</div></div>' +
        srRing +
      '</div></div>';

    return pageHead("Dashboard", "Your complete financial picture in " + esc(base()) + ".", "", badge) +
      hero + rail +
      '<div class="grid cols-2 dash-twoup">' + allocation + whatChanged + "</div>";
  }
  // Compact KPI cell used in the dashboard rail (label, value, optional sub, optional value/sub color class).
  function kpiCell(lbl, val, sub, valCls, subCls) {
    return '<div class="kpi"><div class="kpi-lbl">' + esc(lbl) + '</div>' +
      '<div class="kpi-val ' + (valCls || "") + '">' + val + '</div>' +
      '<div class="kpi-sub ' + (subCls || "") + '">' + (sub || "&nbsp;") + '</div></div>';
  }
  // ----- Selectable KPI slots (Dashboard + Investments header rails) -----
  // Each slot shows one metric from a registry and carries a corner caret to swap it. Choices persist
  // in db.settings.dashCards / invCards.
  var DASH_CARDS_DEFAULT = ["accounts", "investments", "nwGrowth", "taxes"];
  var INV_CARDS_DEFAULT = ["costBasis", "totalReturn", "twReturn", "totalRealized"];
  function slotKeys(saved, fallback) {
    return (Array.isArray(saved) && saved.length === fallback.length) ? saved.slice() : fallback.slice();
  }
  var KPI_CARET = '<svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5 L6 7.5 L9 4.5"/></svg>';
  // Render one selectable KPI slot: the chosen metric's cell + a corner dropdown of every metric.
  // reg: {key:{label, cell}} ; keys: ordered option keys ; idx: slot index ; cur: selected key ; act: change-action.
  function kpiSlot(reg, keys, idx, cur, act) {
    var def = reg[cur] || reg[keys[idx]] || reg[keys[0]];
    var opts = keys.map(function (k) {
      return '<option value="' + k + '"' + (k === cur ? " selected" : "") + ">" + esc(reg[k].label) + "</option>";
    }).join("");
    var pick = '<select class="kpi-pick" data-act="' + act + '" data-idx="' + idx + '" title="Change metric">' + opts +
      '</select><span class="kpi-caret">' + KPI_CARET + "</span>";
    return def.cell.replace('<div class="kpi">', '<div class="kpi has-pick">' + pick);
  }
  // Build the 4-slot rail HTML for a registry, honouring the saved per-slot selection.
  function kpiRail(reg, saved, fallback, act) {
    var keys = Object.keys(reg), sel = slotKeys(saved, fallback);
    return '<div class="kpi-strip dash-rail mb">' +
      sel.map(function (k, i) { return kpiSlot(reg, keys, i, reg[k] ? k : fallback[i], act); }).join("") +
      "</div>";
  }

  // ----- Accounts -----
  // Fixed, semantic color per net-worth bucket - shared by the Accounts page AND the Dashboard Allocation
  // so a bucket reads in the SAME color everywhere (Cash always azure, Savings always green, etc.).
  var BUCKET_COLOR = { Cash: "oklch(0.72 0.14 248)", Savings: D.green, Investments: D.blue, Pension: D.violet, Crypto: D.amber, Other: D.teal }; // Cash = azure (keep in sync with --d-cash)
  function bucketColor(b) { return colorOverride("bucket", b) || BUCKET_COLOR[b] || D.teal; }

  // Horizontal stacked bar + reused allocation legend, for page heroes (e.g. Accounts "by bucket").
  function stackBar(segs, total) {
    total = total || 1;
    var inner = segs.filter(function (s) { return s.value > 0; }).map(function (s) {
      return '<div style="width:' + (s.value / total * 100).toFixed(2) + '%;background:' + s.color + '"></div>';
    }).join("");
    return '<div class="stack-bar">' + inner + '</div>';
  }

  // Compact "minimal line" page header (Option B): label + total left, inline legend/stats right.
  function inlineLegend(segs) {
    return '<div class="legend-inline">' + segs.map(function (s) {
      return '<span class="li"><span class="d" style="background:' + s.color + '"></span>' + esc(s.label) + ' <span class="v">' + fmtBase(s.value, 0) + '</span></span>';
    }).join("") + "</div>";
  }
  // Header D: label (+optional extra) + big total + stacked category bar + inline legend.
  function barHeader(label, valueHtml, segs, total, extra) {
    total = total || 1;
    var stack = '<div class="stack-bar">' + segs.filter(function (g) { return g.value > 0; }).map(function (g) {
      return '<div style="width:' + (g.value / total * 100).toFixed(2) + '%;background:' + g.color + '"></div>';
    }).join("") + '</div>';
    return '<div class="bhead">' + (extra ? '<div class="bhead-extra">' + extra + '</div>' : "") +
      '<div class="mhead-lbl">' + label + '</div>' +
      '<div class="bhead-val">' + valueHtml + '</div>' + stack + inlineLegend(segs) + '</div>';
  }
  // Data-bar rows: a faint share-of-total fill behind each row (dot, name, meta, value, %, actions).
  function dataBarList(rows, grand) {
    return '<div class="dblist">' + rows.map(function (r) {
      var pc = grand > 0 ? Math.max(0, r.base / grand * 100) : 0;
      return '<div class="dbar"><span class="dbar-fill" style="width:' + pc.toFixed(1) + '%;background:' + r.color + '"></span>' +
        '<span class="dbar-dot" style="background:' + r.color + '"></span>' +
        '<div class="dbar-main"><div class="dbar-nm">' + r.name + '</div>' + (r.meta ? '<div class="dbar-meta">' + r.meta + '</div>' : "") + '</div>' +
        '<div class="dbar-right"><div class="dbar-v">' + r.valueHtml + '</div><div class="dbar-pc">' + pc.toFixed(0) + '%</div></div>' +
        '<span class="dbar-act">' + (r.actions || "") + '</span></div>';
    }).join("") + '</div>';
  }
  function accountsPage() {
    var m = state.month;
    var snap = snapByMonth(m);
    var isCurrent = (m === currentMonth());

    var list;
    if (isCurrent) {
      list = db.accounts.map(function (a) {
        return { id: a.id, name: a.name, bucket: a.bucket, currency: a.currency, balance: num(a.balance), base: toBase(ownedBalance(a), a.currency), hist: false, joint: isJoint(a), share: a.share == null ? 100 : num(a.share), coOwner: a.coOwner || "" };
      });
    } else {
      // Render the roster that existed THAT month (accounts come and go over time), reading the
      // snapshot's own per-account map with its rolled-forward closing balances.
      var amap = (snap && snap.accounts) || {};
      var ord = { Cash: 0, Savings: 1, Pension: 2, Other: 3 };
      list = Object.keys(amap).map(function (id) {
        var fr = amap[id];
        var frac = effShareFrac(id, fr);   // live share re-lenses history; household lifts to 100%
        // FROZEN month: value this account at the FX locked when the month closed, never at the live rate.
        // Prefer the rate captured at close (snap.rates); else recover the full base from the stored
        // owned-base (balanceBase was frozen at close); else fall back to a live conversion (no data).
        var ownedAtClose = shareFrac(fr.share) || 1;   // the share applied when balanceBase was frozen
        var fullFrozen = (snap && snap.rates && snap.rates[fr.currency] != null)
          ? num(fr.balance) * num(snap.rates[fr.currency])
          : (fr.balanceBase != null ? num(fr.balanceBase) / ownedAtClose
            : (curByCode(fr.currency) ? toBase(num(fr.balance), fr.currency) : num(fr.balance)));
        var baseV = fullFrozen * frac;   // re-lens to your current share / the household toggle (FX stays frozen)
        var liveA = liveAccountFor(id, fr);
        var shr = (liveA && liveA.share != null) ? num(liveA.share) : (fr.share == null ? 100 : num(fr.share));
        return { id: id, name: fr.name, bucket: fr.bucket, currency: fr.currency, balance: num(fr.balance), base: baseV, hist: true, joint: shr < 100 || !!(liveA && liveA.joint), share: shr, coOwner: (liveA && liveA.coOwner) || fr.coOwner || "" };
      }).sort(function (a, b) {
        var d = (ord[a.bucket] == null ? 3 : ord[a.bucket]) - (ord[b.bucket] == null ? 3 : ord[b.bucket]);
        return d || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      });
    }

    var byBucket = {};
    list.forEach(function (a) { byBucket[a.bucket] = (byBucket[a.bucket] || 0) + a.base; });

    // (accounts render below as a grouped proportion list)
    var total = list.reduce(function (s, a) { return s + a.base; }, 0);

    var barSegs = ["Cash", "Savings", "Pension", "Other"].filter(function (k) { return byBucket[k]; })
      .map(function (k) { return { label: k, value: byBucket[k], color: bucketColor(k) }; });
    var liquid = (byBucket.Cash || 0) + (byBucket.Savings || 0);
    var pension = byBucket.Pension || 0;
    // "My share / Household" lens toggle (right of the "Total Balance" label) - only when a joint account exists.
    var netToggle = netViewToggle(db.accounts.some(isJoint));
    var accHero = barHeader("Total Balance", fmtBase(total, 0), barSegs, total, netToggle);
    var accRows = list.slice().sort(function (a, b) { return b.base - a.base; }).map(function (a) {
      var col = bucketColor(a.bucket);
      var parts = [a.bucket];
      if (a.joint) parts.push(a.share + "%");
      if (a.currency !== base()) parts.push(fmt(a.balance, a.currency));
      var actions = a.hist
        ? '<button class="btn sm ghost" data-act="edit-frozen-account" data-id="' + a.id + '">Edit</button> <button class="btn sm ghost" data-act="del-frozen-account" data-id="' + a.id + '">\u2715</button>'
        : '<button class="btn sm ghost" data-act="edit-account" data-id="' + a.id + '">Edit</button> <button class="btn sm ghost" data-act="del-account" data-id="' + a.id + '">\u2715</button>';
      return { color: col, name: esc(a.name), meta: parts.join(" \u00b7 "), valueHtml: fmtBase(a.base), base: a.base, actions: actions };
    });
    var body = list.length ? accHero + dataBarList(accRows, total)
      : emptyState("accounts", "No accounts yet", "Add your bank accounts, savings and pension.");

    var badge = isCurrent ? statusBadge(esc(monthLabel(m)), "Live", "live")
      : (snap ? statusBadge(esc(monthLabel(m)), icon("lock") + "Frozen", "frozen")
        : statusBadge(esc(monthLabel(m)), "Empty", "neutral"));

    // Live month adds to the roster; a frozen month (has a snapshot) can also get an account it was
    // missing (forgot to add it before close) - that add lands in the snapshot only. An Empty month
    // (no snapshot, not current) has nothing to add to.
    var addBtn = isCurrent
      ? (db.accounts.length || (db.physicalAssets || []).length || (db.debts || []).length
          ? '<button class="btn" data-act="update-balances" title="Update every account, asset and debt in one pass">' + ICON.refresh + ' Update Balances</button>' : "") +
        '<button class="btn primary" data-act="add-account">+ Add Account</button>'
      : (snap ? '<button class="btn primary" data-act="add-frozen-account">+ Add Account</button>' : "");
    return pageHead("Accounts", "Bank, savings, pension and other cash balances.", addBtn, badge) + body;
  }

  // ----- Investments -----
  var INV_HEAD = '<thead><tr><th>Holding</th><th>Type</th><th class="num">Current Price</th><th class="num">Prev. Price</th><th class="num">Mo. Change %</th><th class="num">Shares</th><th class="num">Mkt Value</th>' +
    '<th class="num">Cost</th><th class="num">Avg Buy</th><th class="num">Unreal P/L</th><th class="num">Return %</th><th class="num">Realized</th><th></th></tr></thead>';
  var INV_COLS = '<colgroup><col class="c-name"><col class="c-type"><col class="c-px"><col class="c-prev"><col class="c-mchg"><col class="c-sh"><col class="c-val"><col class="c-cost"><col class="c-avg"><col class="c-unr"><col class="c-ret"><col class="c-real"><col class="c-acts"></colgroup>';
  function previousFrozenHoldingMetrics(month, id) {
    var prev = null;
    db.snapshots.forEach(function (s) {
      if (s.month < month && s.holdings && s.holdings[id] && (!prev || s.month > prev.month)) prev = s;
    });
    return prev ? frozenHoldingMetrics(prev.holdings[id]) : null;
  }
  function invPrevPriceCell(prev, cur) {
    return '<td class="num">' + (prev && num(prev.price) > 0 ? fmt(prev.price, cur) : "-") + "</td>";
  }
  function invCurrentPriceCell(price, prev, cur) {
    var cls = prev && num(prev.price) > 0 ? signClass(num(price) - num(prev.price)) : "";
    return '<td class="num ' + cls + '">' + fmt(price, cur) + ' <span class="badge-curr">' + esc(cur) + "</span></td>";
  }
  function invMonthlyPriceChangeCell(price, prev) {
    if (!prev || num(prev.price) <= 0) return '<td class="num muted">-</td>';
    var ch = (num(price) - num(prev.price)) / num(prev.price);
    return '<td class="num ' + signClass(ch) + '">' + (ch >= 0 ? "+" : "") + pct(ch) + "</td>";
  }
  var INV_HELP = '<div class="help-box inv-help">Click a holding name to view its full transaction ledger. Stock, ETF, bond, commodity, crypto and currency rates update live via Yahoo Finance. Hit <strong>Refresh Rates</strong> to pull current prices.</div>';
  // Within a single holding type, fan the holdings across a lightness gradient of the type's base
  // color so individual holdings are distinguishable while still reading as the same family. Largest
  // holding keeps the vivid base color; smaller ones step progressively toward white.
  function shadeColor(base, t) {
    // t in 0..1 -> 0%..55% mixed toward white (in oklch, matching the app's color model)
    var wp = Math.round(Math.max(0, Math.min(1, t)) * 55);
    if (!wp) return base;
    return "color-mix(in oklch, " + base + " " + (100 - wp) + "%, white)";
  }
  function shadeHoldingSegs(segs) {
    var byType = {};
    segs.forEach(function (s) { (byType[s.type] = byType[s.type] || []).push(s); });
    Object.keys(byType).forEach(function (k) {
      var grp = byType[k].slice().sort(function (a, b) { return b.value - a.value; });
      var n = grp.length;
      grp.forEach(function (s, i) {
        s.color = shadeColor(s.baseColor, n <= 1 ? 0 : i / (n - 1)); // vivid -> lighter as holdings shrink
      });
    });
    return segs;
  }
  function portfolioMixPanel(typeSegs, holdSegs, totalMv) {
    // ONE donut for the whole portfolio, with a By type / By holding toggle. The legend area is a
    // FIXED-height scroll box so the donut never shifts when the view (and its row count) changes.
    // View choice persists in settings.
    var view = db.settings.mixView === "holding" ? "holding" : "type";
    var segs = (view === "holding" ? holdSegs : typeSegs).slice().sort(function (a, b) { return b.value - a.value; });
    var toggle = '<span class="range-chips lg mix-toggle" style="white-space:nowrap;align-self:flex-start">' +
      '<button type="button" class="rc-btn' + (view === "type" ? " on" : "") + '" data-act="set-mixview" data-view="type">By Type</button>' +
      '<button type="button" class="rc-btn' + (view === "holding" ? " on" : "") + '" data-act="set-mixview" data-view="holding">By Holding</button>' +
      "</span>";
    var legend = segs.length ?
      segs.map(function (s) {
        var p = totalMv ? s.value / totalMv : 0;
        return '<div class="alloc-row"><span class="alloc-dot" style="background:' + s.color + '"></span>' +
          '<span class="alloc-label">' + esc(s.label) + '</span><span class="alloc-bar"><div style="width:' +
          (p * 100).toFixed(1) + "%;background:" + s.color + '"></div></span><span class="alloc-pct">' + pct(p) + "</span></div>";
      }).join("") :
      '<div class="muted">No holdings this month.</div>';
    var body = segs.length === 0
      ? '<div class="chart-empty">Add an investment to see how your portfolio is split across holdings and types.</div>'
      : '<div class="donut-wrap"><div class="donut lg">' + donutSVG(segs, 220) +
      '<div class="center"><div class="t">Value</div><div class="v">' + fmtBase(totalMv, 0) + "</div></div></div>" +
      "<div style='flex:1;min-width:220px;display:flex;flex-direction:column;gap:12px;margin-top:-10px'>" + toggle +
      "<div style='height:248px;overflow-y:auto;padding-right:10px'>" + legend + "</div></div></div>";
    return "<div class='mt'><div class='panel'>" +
      '<div style="margin-bottom:14px">' +
        '<h2 style="margin:0 0 4px">Portfolio Mix</h2><p class="hint" style="margin:0">Your investments by ' +
        (view === "holding" ? "individual holding" : "holding type") + ".</p></div>" +
      body + "</div></div>";
  }
  // ---- Target Allocation / rebalancing: target % per holding type vs the live mix ----
  function targetAllocModal() {
    var cm = currentMonth(), held = {};
    db.holdings.forEach(function (h) { if (heldInMonth(h, cm)) held[h.type || "other"] = 1; });
    var tgt = db.settings.targetAlloc || {};
    Object.keys(tgt).forEach(function (k) { held[k] = 1; });
    var keys = Object.keys(held);
    if (!keys.length) { toast("Add a holding first"); return; }
    var rows = keys.map(function (k) {
      var tm = typeMeta(k);
      return '<div class="row"><div class="field" style="flex:2"><label><span style="display:inline-block;width:9px;height:9px;border-radius:3px;background:' + tm.color + ';margin-right:6px;vertical-align:middle"></span>' + esc(tm.label) + '</label>' +
        '<input id="ta-' + esc(k) + '" type="number" step="any" min="0" max="100" placeholder="No target" value="' + (num(tgt[k]) > 0 ? num(tgt[k]) : "") + '"></div></div>';
    }).join("");
    openModal({
      title: "Target Allocation",
      sub: "Your ideal portfolio split, as a % of market value per holding type. Leave a type blank for no target. Aim for a total of 100%.",
      body: rows,
      submitLabel: "Save Targets",
      onSubmit: function () {
        var out = {}, sum = 0;
        keys.forEach(function (k) {
          var v = num(val("ta-" + k));
          if (v > 0) { out[k] = Math.min(100, v); sum += out[k]; }
        });
        db.settings.targetAlloc = out;
        save(); render();
        toast(!sum ? "Targets cleared" : (Math.abs(sum - 100) > 0.5 ? "Saved - heads up: targets sum to " + (+sum.toFixed(1)) + "%" : "Targets saved"));
      },
    });
  }
  function rebalancePanel(byTypeMv, totalMv) {
    var tgt = db.settings.targetAlloc || {}, keys = {};
    Object.keys(byTypeMv).forEach(function (k) { keys[k] = 1; });
    Object.keys(tgt).forEach(function (k) { if (num(tgt[k]) > 0) keys[k] = 1; });
    var ks = Object.keys(keys);
    var hasTargets = ks.some(function (k) { return num(tgt[k]) > 0; });
    var btn = '<button class="btn sm" data-act="edit-alloc-targets">' + icon("settings") + ' Set Targets</button>';
    if (!hasTargets) {
      return '<div class="mt"><div class="panel"><div class="flex between center">' +
        '<h2 style="margin:0">Target Allocation</h2>' + btn + '</div>' +
        '<p class="hint" style="margin:8px 0 0">Set a target % per holding type to see how far your portfolio has drifted - and what to buy or sell to rebalance.</p></div></div>';
    }
    var sumT = ks.reduce(function (s, k) { return s + num(tgt[k] || 0); }, 0);
    var rows = ks.map(function (k) {
      var tm = typeMeta(k), cur = num(byTypeMv[k] || 0);
      var curPct = totalMv > 0 ? cur / totalMv * 100 : 0;
      var t = num(tgt[k] || 0);
      var valueHtml;
      if (t <= 0) valueHtml = '<span class="muted">No target</span>';
      else {
        var driftVal = (curPct - t) / 100 * totalMv;
        valueHtml = Math.abs(curPct - t) < 1 ? '<span class="up">On target</span>'
          : driftVal > 0 ? '<span style="color:var(--d-amber);font-weight:700">Sell ≈ ' + fmtBase(driftVal, 0) + '</span>'
          : '<span style="color:var(--accent);font-weight:700">Buy ≈ ' + fmtBase(-driftVal, 0) + '</span>';
      }
      return {
        color: tm.color, name: esc(tm.label),
        meta: "now " + curPct.toFixed(1) + "%" + (t > 0 ? " - target " + (+t.toFixed(1)) + "%" : ""),
        valueHtml: valueHtml, base: cur, actions: "", _cur: cur,
      };
    }).sort(function (a, b) { return b._cur - a._cur; });
    var sumHint = Math.abs(sumT - 100) > 0.5 ? '<p class="hint" style="margin:10px 0 0">Targets sum to ' + (+sumT.toFixed(1)) + '% - aim for 100% so the buy/sell amounts balance out.</p>' : "";
    return '<div class="mt"><div class="panel"><div class="flex between center" style="margin-bottom:10px">' +
      '<div><h2 style="margin:0 0 4px">Target Allocation</h2><p class="hint" style="margin:0">Current mix vs your targets - and ≈ what to buy or sell to rebalance.</p></div>' + btn + '</div>' +
      dataBarList(rows, totalMv) + sumHint + '</div></div>';
  }
  // Capital-gains reserve panel (lives at the bottom of the Investments page). Tax to set aside
  // on unrealized gains, at the rate from Tax Settings; also tracked in the Tax page Calculation.
  function cgrPanel(unrealBase, live) {
    var rate = num(db.tax.capitalGainsRate), res = capitalGainsReserve(unrealBase);
    var fyLbl = db.tax.year || auFYLabel(), thrMo = num(db.tax.capitalGainsDiscountMonths || 0), disc = num(db.tax.capitalGainsDiscount || 0);
    var discPct = (+(disc * 100).toFixed(0)), gainsBase = Math.max(0, unrealBase);
    // Long/short split only carries meaning where a holding-period rule exists (thrMo > 0, e.g. AU).
    var us = (live && thrMo > 0) ? unrealizedSplit(thrMo) : null;
    var tile = function (tl, tv, ts, isResult) {
      return '<div class="cgr-tile' + (isResult ? " result" : "") + '"><div class="tl">' + tl + '</div><div class="tv">' + tv + "</div>" +
        (ts ? '<div class="ts">' + ts + "</div>" : "") + "</div>";
    };
    var equation = function (gainsLbl, gainsVal, gainsSub, resultLbl, resultVal, resultSub) {
      return '<div class="cgr-eq">' + tile(gainsLbl, gainsVal, gainsSub) +
        '<div class="cgr-op">\u00d7</div>' + tile("CGT rate", pct(rate), "From your Tax Settings") +
        '<div class="cgr-op">=</div>' + tile(resultLbl, resultVal, resultSub, true) + "</div>";
    };
    // --- Reserve on UNREALIZED (paper) gains: gains \u00d7 rate. ---
    var unrealSub = us ? (fmtBase(us.long, 0) + " long-term + " + fmtBase(us.short, 0) + " short-term") : "";
    var unrealBlock =
      '<div class="cgr-block"><div class="hero-label" style="margin-bottom:12px">If you sold today \u00b7 unrealized</div>' +
      equation("Taxable gains", fmtBase(gainsBase, 2), unrealSub, "Reserve to set aside", fmtBase(res, 0), "Park this against a future sale") + "</div>";
    // --- Tax on gains already REALIZED this tax year: taxable \u00d7 rate. ---
    var rs = realizedYearSplit(fyLbl, thrMo);
    var taxCalc = calcTax(db.tax), taxable = toBase(taxCalc.realized, db.tax.currency);
    var hasRealized = Math.abs(taxCalc.realizedGross) > 0.005 || taxCalc.capitalLossesThisYear > 0;
    var realizedGross = rs.long + rs.short + rs.unknown, realizedCGT = Math.max(0, taxable) * rate;
    var realizedSub = disc >= 1 ? "Gains exempt from CGT in your country"
      : (disc > 0 && thrMo > 0) ? (fmtBase(rs.long, 0) + " long-term, " + fmtBase(rs.short + rs.unknown, 0) + " other, losses applied first")
      : disc > 0 ? (fmtBase(realizedGross, 0) + " gains less " + discPct + "% discount") : "";
    var realizedBlock = !hasRealized ? "" :
      '<div class="cgr-block"><div class="hero-label" style="margin-bottom:12px">Booked this year \u00b7 realized FY ' + esc(fyLbl) + "</div>" +
      equation("Taxable realized", fmtBase(taxable, 2), realizedSub, "Capital gains tax", fmtBase(realizedCGT, 0), "Feeds your Tax estimate") + "</div>";
    // intro note adapts to the country's CGT treatment
    var note = disc >= 1 ? " Realized gains are CGT-exempt in your country."
      : (disc > 0 && thrMo > 0) ? (" Long-term realized gains (held &gt;" + thrMo + "months) take the " + discPct + "% discount.")
      : disc > 0 ? (" Realized gains take a " + discPct + "% discount.") : "";
    return '<div class="mt"><div class="panel"><h2>Capital Gains Reserve</h2>' +
      '<p class="hint">How each figure is derived - your taxable gains times the <strong>' + pct(rate) + "</strong> rate from your Tax Settings." + note + "</p>" +
      unrealBlock + realizedBlock + "</div></div>";
  }
  // Month-over-month investment performance vs the prior snapshot. Change in unrealized P/L is the
  // pure market move on holdings (cost-basis change = contributions cancels out); realized is booked-this-month.
  function monthInvData(curUnreal, curReal, prev) {
    if (!prev) return null;
    var prevMv = num(prev.invest), unrealCh = curUnreal - num(prev.unrealized);
    // Realized THIS month is the P/L on sells actually dated this month - computed straight from the ledger,
    // not (all-time now − frozen all-time), which would report FX drift on old realized, or a deleted holding,
    // as this-month activity.
    var cm = currentMonth(), realizedMo = 0;
    (db.holdings || []).forEach(function (h) {
      holdingLedger(h).forEach(function (r) { if (r.realized != null && r.t.month === cm) realizedMo += toBase(r.realized, h.currency); });
    });
    return { unrealCh: unrealCh, retPct: prevMv ? unrealCh / prevMv : 0, realizedMo: realizedMo };
  }
  // Investments focal hero: Market Value + total-unrealized chip, fused with the value-over-time trend,
  // then a "this month" performance rail (unrealized move, market return %, realized booked) + cost basis.
  function investHero(tot, count, trendPts, trendRange, md, ytdUnreal, rangeBar, totRealized, winPct, ext) {
    var unrealPct = tot.cost > 0 ? tot.unreal / tot.cost : 0;
    // Chart: overlay the benchmark ("same contributions into an index") as a second line when we have
    // its history; otherwise the plain single-line value trend.
    var benchOn = ext && ext.benchShown && ext.benchShown.filter(function (v) { return v != null; }).length >= 2;
    var invChart;
    if (benchOn) {
      var mpts = trendPts.map(function (p, i) { return { x: p.x, inv: p.y, bench: ext.benchShown[i] }; });
      var benchLabel = ext.benchLabel;
      var benchLabelHtml = esc(benchLabel);
      if (ext.benchEnd != null) {
        var vsB = ext.mv - ext.benchEnd;
        benchLabel += " - " + (vsB >= 0 ? "+" : "−") + fmtBase(Math.abs(vsB), 0);
        benchLabelHtml += ' - <span class="' + signClass(vsB) + '">' + (vsB >= 0 ? "+" : "−") + fmtBase(Math.abs(vsB), 0) + "</span>";
      }
      invChart = multiLineChartSVG(mpts, [{ key: "inv", color: "#34d399", label: "Your investments" }, { key: "bench", color: "#8ab4ff", label: benchLabel, labelHtml: benchLabelHtml }], "", false, false);
    } else {
      invChart = lineChartSVG(trendPts);
    }
    var cgRes = capitalGainsReserve(tot.unreal);
    var afterCGT = tot.mv - cgRes;
    var fallbackPct = (trendPts.length >= 2 && trendPts[0].y) ? (trendPts[trendPts.length - 1].y - trendPts[0].y) / trendPts[0].y : null;
    var pillPct = (winPct !== undefined) ? winPct : fallbackPct;
    var invPill = pillPct == null ? "" : '<span class="' + (pillPct >= 0 ? "pill-up" : "pill-down") + '">' + (pillPct >= 0 ? "+" : "") + pct(pillPct) + '</span>';
    var invHeadR = rangeBar ? (invPill ? invPill + '&nbsp;&nbsp;' : '') + rangeBar : esc(trendRange) + (invPill ? '&nbsp;&nbsp;' + invPill : "");
    var secCur = db.settings.secondaryCurrency;
    var convLine = (secCur && curByCode(secCur)) ? fmt(fromBase(tot.mv, secCur), secCur, 0) + " " + esc(secCur) + " \u00b7 " : "";
    var hero = '<div class="hero accent mb">' +
      '<div class="hero-figs">' +
        '<div class="hero-label">Market Value</div>' +
        '<div class="hero-value">' + fmtBase(tot.mv, 0) + '</div>' +
        '<div class="sub" style="margin-top:4px">' + convLine + count + ' holding' + (count === 1 ? "" : "s") + '</div>' +
        (md ? '<div class="hero-delta ' + signClass(md.unrealCh) + '">' + icon(md.unrealCh >= 0 ? "arrowUp" : "arrowDown") + '<span>' + fmt(Math.abs(md.unrealCh)) + " (" + pct(Math.abs(md.retPct)) + ") this month</span></div>" : "") +
        '<div class="hero-subs">' +
          '<div class="hero-subcol">' +
            '<div><div class="lbl">After Capital Gains Tax</div><div class="val">' + fmtBase(afterCGT, 0) + '</div></div>' +
            '<div><div class="lbl">Capital Gains Taxes</div><div class="val down">' + fmtBase(cgRes, 0) + '</div></div>' +
          '</div>' +
          '<div><div class="lbl">Total Unrealized P/L</div><div class="val ' + signClass(tot.unreal) + '">' + signFmt(tot.unreal) + '</div></div>' +
        '</div>' +
      '</div>' +
      '<div class="hero-side">' +
        (trendPts.length >= 2 ? '<div class="hero-head"><span class="t">Investments Over Time</span><span class="r">' + invHeadR + '</span></div>' : '') +
        invChart +
      '</div>' +
    '</div>';
    var moLbl = esc(monthLabel(state.month));
    var realizedVal = (totRealized != null ? totRealized : tot.real);
    var annRet = portfolioAnnualizedReturn();   // all-time money-weighted yearly rate (live ledger)
    var INV_REG = {
      costBasis:     { label: "Cost Basis",            cell: kpiCell("Cost Basis", fmtBase(tot.cost, 0), "Total invested", "down") },
      costMonth:     { label: "Cost This Month",       cell: kpiCell("Cost This Month", fmtBase(costInMonth(state.month), 0), "Invested in " + moLbl, "down") },
      totalReturn:   { label: "Total Return %",        cell: kpiCell("Total Return %", (unrealPct >= 0 ? "+" : "") + pct(unrealPct), "Unrealized on cost", signClass(unrealPct)) },
      annualReturn:  { label: "Annualized Return",     cell: kpiCell("Annualized Return", annRet == null ? "-" : (annRet >= 0 ? "+" : "") + pct(annRet), annRet == null ? "Needs 3+ months of history" : "Money-weighted - per year", annRet == null ? "" : signClass(annRet)) },
      twReturn:      { label: "Time-Weighted Return",  cell: kpiCell("Time-Weighted Return", (ext && ext.twr != null) ? ((ext.twr >= 0 ? "+" : "") + pct(ext.twr)) : "-", (ext && ext.twr != null) ? "Cumulative - timing-neutral" : "Needs 3+ months of history", (ext && ext.twr != null) ? signClass(ext.twr) : "") },
      vsBenchmark:   { label: "vs Benchmark",          cell: (ext && ext.benchEnd != null) ? kpiCell("vs Benchmark", ((ext.mv - ext.benchEnd) >= 0 ? "+" : "−") + fmtBase(Math.abs(ext.mv - ext.benchEnd), 0), benchmarkTicker() + " - same contributions", signClass(ext.mv - ext.benchEnd)) : kpiCell("vs Benchmark", "-", "Refresh to load " + benchmarkTicker(), "") },
      totalRealized: { label: "Total Realized",        cell: kpiCell("Total Realized", signFmt(realizedVal), totRealized != null ? "incl. this month" : "", signClass(realizedVal)) },
      marketValue:   { label: "Market Value",          cell: kpiCell("Market Value", fmtBase(tot.mv, 0), count + " holding" + (count === 1 ? "" : "s")) },
      unrealized:    { label: "Unrealized P/L",        cell: kpiCell("Unrealized P/L", signFmt(tot.unreal), "Market value − cost", signClass(tot.unreal)) },
      afterCGT:      { label: "After Capital Gains Tax", cell: kpiCell("After Capital Gains Tax", fmtBase(afterCGT, 0), "Market value − reserve") },
      cgtReserve:    { label: "Capital Gains Reserve", cell: kpiCell("Capital Gains Reserve", fmtBase(cgRes, 0), "Set aside on gains", "down") },
      ytdUnreal:     { label: "YTD Unrealized",        cell: kpiCell("YTD Unrealized", ytdUnreal == null ? "-" : signFmt(ytdUnreal), "This year", ytdUnreal == null ? "" : signClass(ytdUnreal)) },
      monthMove:     { label: "Unrealized This Month", cell: kpiCell("Unrealized This Month", md ? signFmt(md.unrealCh) : "-", "Market move", md ? signClass(md.unrealCh) : "") },
      monthReturn:   { label: "Return % This Month",   cell: kpiCell("Return % This Month", md ? (md.retPct >= 0 ? "+" : "") + pct(md.retPct) : "-", "Market move", md ? signClass(md.retPct) : "") },
      monthRealized: { label: "Realized This Month",   cell: kpiCell("Realized This Month", md ? signFmt(md.realizedMo) : "-", "Booked in " + moLbl, md ? signClass(md.realizedMo) : "") },
      holdings:      { label: "Holdings",              cell: kpiCell("Holdings", String(count), "Positions held") },
    };
    var rail = kpiRail(INV_REG, db.settings.invCards, INV_CARDS_DEFAULT, "set-inv-card");
    return hero + rail;
  }
  function investmentsPage() {
    var m = state.month;
    var snap = snapByMonth(m);
    var isCurrent = (m === currentMonth());
    var snaps = db.snapshots.slice().sort(function (a, b) { return a.month < b.month ? -1 : 1; });

    // ----- Past month: list only the holdings actually held (or sold) that month -----
    if (!isCurrent) {
      var snapH = (snap && snap.holdings) ? snap.holdings : {};
      // aggregate totals come from the snapshot (cumulative realized survives sold-off positions)
      var tot = { cost: num(snap && snap.cost), mv: num(snap && snap.invest), unreal: num(snap && snap.unrealized), real: num(snap && snap.realized) };
      var heldP = sortHoldingsByTypeMv(db.holdings.filter(function (h) { return snapH[h.id]; }), function (h) { return frozenHoldingMetrics(snapH[h.id]).marketValueBase; });
      var rowsP = heldP.map(function (h) {
        var fm = frozenHoldingMetrics(snapH[h.id]);
        var prevFm = previousFrozenHoldingMetrics(m, h.id);
        return '<tr><td class="hold-cell"><span class="hold-inner">' +
          (h.ticker ? '<span class="inv-tkr" data-act="open-holding" data-id="' + h.id + '">' + esc(h.ticker) + "</span>" : "") +
          '<button class="link-name inv-name" title="' + esc(h.name) + '" style="color:' + typeMeta(h.type).color + ';font-weight:600" data-act="open-holding" data-id="' + h.id + '">' + esc(h.name) + "</button></span></td><td>" + typeTag(h.type) + "</td>" +
          invCurrentPriceCell(fm.price, prevFm, h.currency) +
          invPrevPriceCell(prevFm, h.currency) +
          invMonthlyPriceChangeCell(fm.price, prevFm) +
          '<td class="num">' + (+fm.shares.toFixed(6)) + "</td>" +
          '<td class="num">' + fmtBase(fm.marketValueBase) + "</td>" +
          '<td class="num cost">' + fmtBase(fm.costBase) + "</td>" +
          '<td class="num">' + (fm.avgBuyPrice ? fmt(fm.avgBuyPrice, h.currency) : "-") + "</td>" +
          '<td class="num ' + signClass(fm.unrealizedBase) + '">' + signFmt(fm.unrealizedBase) + "</td>" +
          '<td class="num ' + signClass(fm.retPct) + '">' + ((fm.retPct >= 0 ? "+" : "") + pct(fm.retPct)) +
          '</td><td class="num ' + signClass(fm.realizedBase) + '">' + signFmt(fm.realizedBase) + "</td>" +
          '<td class="act-cell"><div class="hold-acts"><button class="btn sm ghost" data-act="edit-frozen-holding" data-id="' + h.id + '">Edit</button></div></td></tr>';
      }).join("");
      var byTypeP = {};
      heldP.forEach(function (h) { var k = h.type || "other"; byTypeP[k] = (byTypeP[k] || 0) + frozenHoldingMetrics(snapH[h.id]).marketValueBase; });
      var segsP = Object.keys(byTypeP).map(function (k) { var tm = typeMeta(k); return { label: tm.label, value: byTypeP[k], color: tm.color }; });
      var holdSegsP = heldP.map(function (h) { var k = h.type || "other"; var bc = typeMeta(k).color; return { label: h.name || h.ticker || "Holding", value: frozenHoldingMetrics(snapH[h.id]).marketValueBase, type: k, baseColor: bc, color: bc }; });
      shadeHoldingSegs(holdSegsP);;
      var tableP = heldP.length ?
        '<div class="inv-section-title">Holdings</div><div class="inv-table-card"><div class="table-wrap"><table class="inv-table">' + INV_COLS + INV_HEAD + "<tbody>" + rowsP + "</tbody><tfoot><tr><td colspan='6'>Total</td>" +
        '<td class="num">' + fmtBase(tot.mv) + '</td><td class="num cost">' + fmtBase(tot.cost) + "</td><td></td>" +
        '<td class="num ' + signClass(tot.unreal) + '">' + signFmt(tot.unreal) + "</td>" +
        '<td class="num ' + signClass(tot.unreal + tot.real) + '">' + (tot.cost > 0 ? (tot.unreal + tot.real >= 0 ? "+" : "") + pct((tot.unreal + tot.real) / tot.cost) : "-") + "</td>" +
        '<td class="num ' + signClass(tot.real) + '">' + signFmt(tot.real) + "</td><td></td></tr></tfoot></table></div></div>" :
        emptyState("investments", "No holdings this month", "No investments were held in " + esc(monthLabel(m)) + ".");
      var badge = snap ? statusBadge(esc(monthLabel(m)), icon("lock") + "Frozen", "frozen")
        : statusBadge(esc(monthLabel(m)), "Empty", "neutral");
      var invSnapsP = snaps.filter(function (s) { return s.month <= m; });
      var invTrendPtsP = invSnapsP.map(function (s) { return { x: monthLabel(s.month).slice(0, 3), y: num(s.invest), t: monthMs(s.month), m: s.month, cost: num(s.cost) }; });
      var invRangeP = invSnapsP.length ? shortMonth(invSnapsP[0].month) + " \u2192 " + shortMonth(m) : "";
      var prevInvP = null; snaps.forEach(function (s) { if (s.month < m) prevInvP = s; });
      var invYrStartP = null, cyP = m.slice(0, 4) + "-01"; snaps.forEach(function (s) { if (s.month < cyP) invYrStartP = s; });
      var invYtdP = invYrStartP ? tot.unreal - num(invYrStartP.unrealized) : null;
      var benchFullP = benchmarkTrendValues(invTrendPtsP), benchEndP = null;
      if (benchFullP) {
        for (var bpi = benchFullP.length - 1; bpi >= 0; bpi--) { if (benchFullP[bpi] != null) { benchEndP = benchFullP[bpi]; break; } }
      }
      var invExtP = { benchShown: benchFullP, benchLabel: "Benchmark - " + benchmarkTicker(), benchEnd: benchEndP, twr: portfolioTWR(invTrendPtsP), mv: tot.mv };
      return pageHead("Investments", "Click Edit on a row to adjust frozen values.", "", badge) +
        investHero(tot, heldP.length, invTrendPtsP, invRangeP, monthInvData(tot.unreal, tot.real, prevInvP), invYtdP, null, null, null, null, invExtP) +
        portfolioMixPanel(segsP, holdSegsP, tot.mv) + INV_HELP + tableP + cgrPanel(tot.unreal, false);
    }

    // ----- Current month: live view (hide positions fully sold in an earlier month) -----
    var pf = portfolioTotals();
    var liveHoldings = sortHoldingsByTypeMv(db.holdings.filter(function (h) { return heldInMonth(h, m); }), function (h) { return holdingMetrics(h).marketValueBase; });
    var liveMonth = currentMonth();
    var rows = liveHoldings.map(function (h) {
      var m = holdingMetrics(h);
      var prevFm = previousFrozenHoldingMetrics(liveMonth, h.id);
      var nTx = (h.transactions || []).length;
      return '<tr><td class="hold-cell"><span class="hold-inner">' +
        (h.ticker ? '<span class="inv-tkr" data-act="open-holding" data-id="' + h.id + '">' + esc(h.ticker) + "</span>" : "") +
        '<button class="link-name inv-name" title="' + esc(h.name) + '" style="color:' + typeMeta(h.type).color + '" data-act="open-holding" data-id="' + h.id + '">' + esc(h.name) + "</button>" +
        "</span></td><td>" + typeTag(h.type) + "</td>" +
        invCurrentPriceCell(m.price, prevFm, h.currency) +
        invPrevPriceCell(prevFm, h.currency) +
        invMonthlyPriceChangeCell(m.price, prevFm) +
        '<td class="num">' + (+m.shares.toFixed(6)) + "</td>" +
        '<td class="num">' + fmtBase(m.marketValueBase) + "</td>" +
        '<td class="num cost">' + fmtBase(m.costBase) + "</td>" +
        '<td class="num">' + (m.avgBuyPrice ? fmt(m.avgBuyPrice, h.currency) : "-") + "</td>" +
        '<td class="num ' + signClass(m.unrealizedBase) + '">' + signFmt(m.unrealizedBase) + "</td>" +
        '<td class="num ' + signClass(m.totalReturnPct) + '">' + (nTx ? (m.totalReturnPct >= 0 ? "+" : "") + pct(m.totalReturnPct) : "-") +
        '</td><td class="num ' + signClass(m.realizedBase) + '">' + signFmt(m.realizedBase) + "</td>" +
        '<td class="act-cell">' +
        '<div class="hold-acts"><button class="btn sm ghost" data-act="add-txn" data-id="' + h.id + '" data-type="buy" title="Add buy">+ Buy</button>' +
        '<button class="btn sm ghost" data-act="add-txn" data-id="' + h.id + '" data-type="sell" title="Record a sale">Sell</button>' +
        '<button class="btn sm ghost" data-act="price-holding" data-id="' + h.id + '" title="Update price">' + ICON.refresh + "</button>" +
        '<button class="btn sm ghost" data-act="del-holding" data-id="' + h.id + '" title="Delete holding">×</button></div></td></tr>';
    }).join("");

    var table = liveHoldings.length ?
      '<div class="inv-section-title">Holdings</div><div class="inv-table-card"><div class="table-wrap"><table class="inv-table">' + INV_COLS + INV_HEAD + "<tbody>" +
      rows + "</tbody><tfoot><tr><td colspan='6'>Total</td>" +
      '<td class="num">' + fmtBase(pf.mv) + '</td><td class="num cost">' + fmtBase(pf.cost) + "</td><td></td>" +
      '<td class="num ' + signClass(pf.unreal) + '">' + signFmt(pf.unreal) + "</td>" +
      '<td class="num ' + signClass(pf.unreal + pf.real) + '">' + (pf.cost > 0 ? (pf.unreal + pf.real >= 0 ? "+" : "") + pct((pf.unreal + pf.real) / pf.cost) : "-") + "</td>" +
      '<td class="num ' + signClass(pf.real) + '">' + signFmt(pf.real) + "</td><td></td></tr></tfoot></table></div></div>" :
      emptyState("investments", "No holdings yet", "Add a stock, ETF, crypto, bond or commodity to start tracking P/L.");

    // per-type allocation (currently-held positions grouped by holding type, with each type's colour)
    var byTypeMv = {};
    liveHoldings.forEach(function (h) { var k = h.type || "other"; byTypeMv[k] = (byTypeMv[k] || 0) + holdingMetrics(h).marketValueBase; });
    var segs = Object.keys(byTypeMv).map(function (k) { var tm = typeMeta(k); return { label: tm.label, value: byTypeMv[k], color: tm.color }; });
    var holdSegs = liveHoldings.map(function (h) { var k = h.type || "other"; var bc = typeMeta(k).color; return { label: h.name || h.ticker || "Holding", value: holdingMetrics(h).marketValueBase, type: k, baseColor: bc, color: bc }; });
    shadeHoldingSegs(holdSegs);

    var invSnaps = snaps.filter(function (s) { return s.month <= currentMonth(); });
    var invTrendPts = invSnaps.map(function (s) { return { x: monthLabel(s.month).slice(0, 3), y: num(s.invest), t: monthMs(s.month), m: s.month, cost: num(s.cost) }; });
    invTrendPts.push({ x: "Now", y: pf.mv, t: Date.now(), m: currentMonth(), cost: pf.cost });
    var invSpan = invTrendPts.length >= 2 ? (invTrendPts[invTrendPts.length - 1].t - invTrendPts[0].t) / 86400000 : 0;
    var invShown = filterTrend(invTrendPts, state.invRange);
    // Benchmark overlay ("same contributions into an index") + time-weighted return, aligned to the chart.
    var benchFull = benchmarkTrendValues(invTrendPts), benchShown = null, benchEnd = null;
    if (benchFull) {
      var benchByT = {}; invTrendPts.forEach(function (p, i) { benchByT[p.t] = benchFull[i]; });
      benchShown = invShown.map(function (p) { return (p.t in benchByT) ? benchByT[p.t] : null; });
      for (var bi = benchFull.length - 1; bi >= 0; bi--) { if (benchFull[bi] != null) { benchEnd = benchFull[bi]; break; } }
    }
    var invExt = { benchShown: benchShown, benchLabel: "Benchmark - " + benchmarkTicker(), benchEnd: benchEnd, twr: portfolioTWR(invTrendPts), mv: pf.mv };
    var invBar = trendRangeBar("inv", invSpan, state.invRange);
    // Pill %: the unrealized P/L actually earned over the selected period, as a share of invested cost.
    // ALL = total unrealized return ((MV-Cost)/Cost); a window = (unrealized now - unrealized at the
    // period's start) / cost, i.e. the price gain booked during that window. Cost-anchored so a near-zero
    // opening value can't explode it.
    var invAll = !state.invRange || state.invRange === "all";
    var invWinPct;
    if (pf.cost <= 0) {
      invWinPct = null;
    } else if (invAll) {
      invWinPct = pf.unreal / pf.cost;
    } else {
      // Anchor on the same window-start the chart shows (filterTrend's first kept snapshot) so the
      // line chart and this pill % always describe the identical period. Still cost-anchored so a
      // near-zero opening value can't blow the percentage up.
      var invStartT = invShown[0].t;
      var invStartSnap = null;
      invSnaps.forEach(function (s) { if (monthMs(s.month) === invStartT) invStartSnap = s; });
      invWinPct = (pf.unreal - (invStartSnap ? num(invStartSnap.unrealized) : 0)) / pf.cost;
    }
    var invRange = invSnaps.length ? shortMonth(invSnaps[0].month) + " \u2192 " + shortMonth(currentMonth()) : "";
    var prevInv = null; snaps.forEach(function (s) { if (s.month < currentMonth()) prevInv = s; });
    var invYrStart = null, cy = currentMonth().slice(0, 4) + "-01"; snaps.forEach(function (s) { if (s.month < cy) invYrStart = s; });
    var invYtd = invYrStart ? pf.unreal - num(invYrStart.unrealized) : null;

    var invHead = pageHead("Investments", "Stocks, ETFs, crypto, bonds and commodities with live P/L.",
      '<button class="btn" data-act="export-csv" data-kind="holdings" title="Download the holdings table as a spreadsheet-ready CSV">' + icon("sheet") + " CSV</button>" +
      '<button class="btn" data-act="refresh-prices">' + ICON.refresh + " Refresh Prices</button>" +
      '<button class="btn primary" data-act="add-holding">+ Add Holding</button>',
      statusBadge(esc(monthLabel(m)), "Live", "live"));
    // Empty app: a clean Accounts-style empty state rather than a hero + portfolio + table full of zeros.
    if (!liveHoldings.length)
      return invHead + emptyState("investments", "No investments yet", "Add a stock, ETF, crypto, bond or commodity to start tracking P/L.");
    return invHead +
      investHero(pf, liveHoldings.length, invShown, invRange, monthInvData(pf.unreal, pf.real, prevInv), invYtd, invBar, totalRealizedAllTime(), invWinPct, invExt) +
      portfolioMixPanel(segs, holdSegs, pf.mv) + rebalancePanel(byTypeMv, pf.mv) + INV_HELP + table + cgrPanel(pf.unreal, true);
  }

  // ----- Holding detail (month-by-month transaction ledger) -----
  function holdingDetailPage() {
    var h = findHolding(state.holdingId);
    if (!h) { state.route = "investments"; return investmentsPage(); }
    var m = holdingMetrics(h);
    var ledger = holdingLedger(h);
    var cur = h.currency;
    var totalFees = (h.transactions || []).reduce(function (s, t) { return s + num(t.fees); }, 0);
    var txTotals = ledger.reduce(function (acc, r) {
      var t = r.t, sh = num(t.shares), price = num(t.price), isBuy = t.type === "buy";
      acc.buyCount += isBuy ? 1 : 0;
      acc.sellCount += isBuy ? 0 : 1;
      acc.signedShares += isBuy ? sh : -sh;
      acc.tradedShares += sh;
      acc.priceWeight += sh * price;
      acc.tradeValue += isBuy ? num(r.cost) : num(r.gross);
      acc.fees += num(t.fees);
      acc.endingShares = num(r.sharesAfter);
      if (r.realized != null) acc.realized += num(r.realized);
      return acc;
    }, { buyCount: 0, sellCount: 0, signedShares: 0, tradedShares: 0, priceWeight: 0, tradeValue: 0, fees: 0, endingShares: 0, realized: 0 });
    var txAvgPrice = txTotals.tradedShares > 0 ? txTotals.priceWeight / txTotals.tradedShares : 0;
    var txFooter = '<tfoot><tr><td><strong>Total</strong></td>' +
      '<td class="nowrap">' + txTotals.buyCount + " buy" + (txTotals.buyCount === 1 ? "" : "s") + " / " + txTotals.sellCount + " sell" + (txTotals.sellCount === 1 ? "" : "s") + "</td>" +
      '<td class="num">' + (+txTotals.signedShares.toFixed(6)) + "</td>" +
      '<td class="num">' + (txAvgPrice ? fmt(txAvgPrice, cur) : "-") + "</td>" +
      '<td class="num">' + fmt(txTotals.tradeValue, cur) + "</td>" +
      '<td class="num" style="color:var(--neg)">' + fmt(txTotals.fees, cur) + "</td>" +
      '<td class="num">' + (+txTotals.endingShares.toFixed(6)) + "</td>" +
      '<td class="num ' + signClass(txTotals.realized) + '">' + signFmt(txTotals.realized, cur) + "</td><td></td></tr></tfoot>";
    // Dividends (manual log): total, trailing-12-month sum and yield (vs current market value).
    var divs = (h.dividends || []).slice().sort(function (a, b) { return a.month < b.month ? -1 : 1; });
    var divTotal = divs.reduce(function (s, d) { return s + num(d.amount); }, 0);
    var cmNow = currentMonth();
    var div12 = divs.reduce(function (s, d) { var mb = monthsBetween(d.month, cmNow); return (mb >= 0 && mb < 12) ? s + num(d.amount) : s; }, 0);
    var divYield = m.marketValue > 0 ? div12 / m.marketValue : 0;
    var hAnn = xirr(holdingFlows(h), m.marketValueBase);   // this holding's money-weighted yearly rate

    var txRows = ledger.slice().reverse().map(function (r) {
      var t = r.t, isBuy = t.type === "buy";
      return "<tr><td><strong>" + esc(monthLabel(t.month)) + "</strong></td>" +
        '<td><span class="tag" style="color:' + (isBuy ? "var(--pos)" : "var(--neg)") + ";background:color-mix(in oklch," + (isBuy ? "var(--pos)" : "var(--neg)") + ' 18%,transparent)">' + (isBuy ? "BUY" : "SELL") + "</span></td>" +
        '<td class="num">' + (isBuy ? "" : "−") + (+num(t.shares).toFixed(6)) + "</td>" +
        '<td class="num">' + fmt(t.price, cur) + "</td>" +
        '<td class="num">' + (isBuy ? fmt(r.cost, cur) : fmt(r.gross, cur)) + "</td>" +
        '<td class="num">' + fmt(t.fees, cur) + "</td>" +
        '<td class="num">' + (+r.sharesAfter.toFixed(6)) + "</td>" +
        '<td class="num ' + (r.realized == null ? "" : signClass(r.realized)) + '">' + (r.realized == null ? "-" : signFmt(r.realized, cur)) + "</td>" +
        '<td class="right nowrap"><div class="txn-actions"><button class="btn sm ghost" data-act="edit-txn" data-id="' + t.id + '" data-hold="' + h.id + '">Edit</button> <button class="btn sm ghost" data-act="del-txn" data-id="' + t.id + '" data-hold="' + h.id + '">×</button></div></td></tr>';
    }).join("");

    var ledgerTable = (h.transactions || []).length ?
      '<div class="table-wrap txn-scroll"><table class="txn-table"><colgroup><col style="width:11%"><col style="width:11%"><col style="width:10%"><col style="width:11%"><col style="width:13%"><col style="width:9%"><col style="width:10%"><col style="width:12%"><col style="width:13%"></colgroup><thead><tr><th>Month</th><th>Action</th><th class="num">Shares</th><th class="num">Price</th>' +
      '<th class="num">Cost / Sold Value</th><th class="num">Fees</th><th class="num">Total Shares</th><th class="num">Realized P/L</th><th></th></tr></thead><tbody>' +
      txRows + "</tbody>" + txFooter + "</table></div>" :
      emptyState("expenses", "No transactions yet", "Add your first buy to start tracking this holding.");

    var priceSrc = h.type === "crypto" ? (h.coingeckoId ? "Auto - CoinGecko" : "Manual") :
      ((h.apiSymbol || h.ticker) ? "Auto - Yahoo Finance" : "Manual");

    return pageHead(h.name,
      typeTag(h.type) +
      (h.ticker ? ' <span class="badge-curr">' + esc(h.ticker) + "</span>" : "") +
      " - Priced in " + esc(cur) + " - " + esc(priceSrc),
      '<button class="btn ghost" data-act="nav" data-id="investments">Back</button>' +
      '<button class="btn" data-act="edit-holding" data-id="' + h.id + '">' + icon("settings") + " Edit</button>" +
      '<button class="btn" data-act="add-txn" data-id="' + h.id + '" data-type="sell">Sell</button>' +
      '<button class="btn" data-act="add-dividend" data-id="' + h.id + '">+ Dividend</button>' +
      '<button class="btn primary" data-act="add-txn" data-id="' + h.id + '" data-type="buy">+ Buy</button>') +

      '<div class="grid hd-grid mb">' +
        '<div class="panel hd-position">' +
          '<div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-3)">Market Value</div>' +
          '<div class="hd-mv">' + fmt(m.marketValue, cur) + '</div>' +
          (m.cost > 0 ? '<div class="hero-delta ' + signClass(m.totalReturn) + '" style="margin-top:10px"><span>' + (m.totalReturnPct >= 0 ? "+" : "") + pct(m.totalReturnPct) + ' all time</span></div>' : '') +
          '<div class="hd-rows">' +
            '<div class="hd-row"><span class="hd-k">Unrealized P/L</span><span class="hd-v ' + signClass(m.unrealized) + '">' + signFmt(m.unrealized, cur) + '</span></div>' +
            '<div class="hd-row"><span class="hd-k">Current Price</span><span class="hd-v hd-v-price"><button class="btn sm ghost" data-act="price-holding" data-id="' + h.id + '" title="Update price">' + ICON.refresh + '</button>' + fmt(m.price, cur) + '</span></div>' +
            '<div class="hd-row"><span class="hd-k">Total Shares</span><span class="hd-v">' + (+m.shares.toFixed(6)) + '</span></div>' +
            '<div class="hd-row"><span class="hd-k">Cost Basis</span><span class="hd-v" style="color:var(--neg)">' + fmt(m.cost, cur) + '</span></div>' +
            '<div class="hd-row"><span class="hd-k">Total Fees</span><span class="hd-v" style="color:var(--neg)">' + fmt(totalFees, cur) + '</span></div>' +
            '<div class="hd-row"><span class="hd-k">Avg Buy Price</span><span class="hd-v">' + (m.avgBuyPrice ? fmt(m.avgBuyPrice, cur) : "-") + '</span></div>' +
            '<div class="hd-row"><span class="hd-k">Realized P/L</span><span class="hd-v ' + signClass(m.realized) + '">' + signFmt(m.realized, cur) + '</span></div>' +
            (hAnn != null ? '<div class="hd-row"><span class="hd-k">Annualized Return</span><span class="hd-v ' + signClass(hAnn) + '">' + (hAnn >= 0 ? "+" : "") + pct(hAnn) + '/yr</span></div>' : "") +
            (divs.length ? '<div class="hd-row"><span class="hd-k">Dividends (Total)</span><span class="hd-v up">' + fmt(divTotal, cur) + '</span></div>' +
              '<div class="hd-row"><span class="hd-k">Dividend Yield (12mo)</span><span class="hd-v">' + (m.marketValue > 0 ? pct(divYield) : "-") + '</span></div>' : "") +
          '</div>' +
        '</div>' +
        '<div class="panel"><h2>Value Over Time</h2><p class="hint">Market value vs. money invested, in ' + esc(base()) +
        ". Invested comes from your transactions; market value fills in as you close months.</p>" +
        multiLineChartSVG(holdingHistory(h),
          [{ key: "value", color: "#34d399", label: "Market value" }, { key: "cost", color: "var(--neg)", label: "Invested (cost)" }],
          "Add transactions across different months (and close months) to build this holding's history.") + "</div>" +
      "</div>" +
      '<div class="help-box">Each row is one month\'s transaction. <strong>Cost</strong> = shares × price + fees (buys). <strong>Sold Value</strong> = shares × price (sells). <strong>Total Shares</strong>, average price and <strong>Realized P/L</strong> (weighted-average cost) update automatically.</div>' +
      '<div class="panel"><h2>Transactions</h2><p class="hint">Buys and sells, oldest computed first.</p>' + ledgerTable + "</div>" +
      '<div class="panel mt div-panel"><h2>Dividends</h2><p class="hint">Cash distributions you received, in ' + esc(cur) +
      ". Accumulating funds reinvest internally - leave this empty for them." +
      (divs.length ? " Total " + fmt(divTotal, cur) + " - trailing-12-month yield " + pct(divYield) + "." : "") + "</p>" +
      (divs.length ?
        '<div class="table-wrap div-scroll"><table><thead><tr><th>Month</th><th class="num">Amount</th><th>Note</th><th></th></tr></thead><tbody>' +
        divs.slice().reverse().map(function (d) {
          return "<tr><td><strong>" + esc(monthLabel(d.month)) + "</strong></td>" +
            '<td class="num up">' + fmt(d.amount, cur) + "</td><td>" + esc(d.note || "") + "</td>" +
            '<td class="right nowrap"><button class="btn sm ghost" data-act="edit-dividend" data-id="' + d.id + '" data-hold="' + h.id + '">Edit</button> <button class="btn sm ghost" data-act="del-dividend" data-id="' + d.id + '" data-hold="' + h.id + '">×</button></td></tr>';
        }).join("") + "</tbody></table></div>" :
        emptyState("income", "No dividends logged", "Use “+ Dividend” (top right) to record distributions you received.")) + "</div>";
  }

  // ----- History (multi-year, from monthly snapshots) -----
  function shortMonth(m) { var p = m.split("-"); return monthName(+p[1] - 1) + " '" + p[0].slice(2); }
  // History: one "<Income|Spending> by Category" panel - a monthly trend of the year's top categories beside
  // a ranked list of EVERY category's total for the year. records = db.incomes / db.expenses; colorFn keeps
  // the category colors consistent with Cash Flow and Settings -> Colors. Figures come straight from the live
  // ledger (so edits show immediately), at each month's frozen FX, with the joint "my share" lens on expenses.
  // History "Income/Spending by Category" panel. Default view is a donut + ranked legend; a small chip
  // switcher (mirroring the Dashboard/Investments trend chips) lets the user pick Treemap, a stacked share
  // bar, or a compact quiet-bar list. Figures come straight from the live ledger at each month's frozen FX,
  // with the joint "my share" lens on expenses. Each panel (income / expense) keeps its own chosen view.
  // History "Income vs Expenses" panel - a switchable view (Grouped bars / Diverging / Net savings),
  // each showing per-month figures. Choice persists in db.settings.ieView. barPts = [{x, inc, exp}].
  function ieViewChips(cur) {
    var opts = [["grouped", "Grouped"], ["diverging", "Diverging"], ["area", "Area"]];
    return '<span class="range-chips">' + opts.map(function (o) {
      return '<button type="button" class="rc-btn' + (o[0] === cur ? " on" : "") + '" data-act="set-ieview" data-view="' + o[0] + '">' + o[1] + "</button>";
    }).join("") + "</span>";
  }
  // Income / Expenses legend, identical markup to the one barChartSVG (Grouped) renders, so all three
  // variants carry the same legend and the chart areas line up.
  function ieLegendHTML() {
    return '<div style="margin-bottom:6px">' + [["Income", "var(--hist-income-chart)"], ["Expenses", "var(--neg)"]].map(function (s) {
      return '<span style="margin-right:16px;font-size:12px;color:var(--text-dim)"><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:' + s[1] + ';margin-right:6px;vertical-align:middle"></span>' + s[0] + "</span>";
    }).join("") + "</div>";
  }
  // Diverging bars: income up / expense down from a centre zero line, with gridlines, a value axis
  // (like Grouped) and per-bar figures.
  function ieDivergingSVG(pts) {
    var w = 1080, h = 300, pad = { l: 56, r: 12, t: 22, b: 28 };
    var iw = w - pad.l - pad.r, ih = h - pad.t - pad.b, nn = pts.length, gw = iw / nn;
    var maxSide = 0; pts.forEach(function (p) { maxSide = Math.max(maxSide, num(p.inc), num(p.exp)); });
    maxSide = (maxSide || 1) * 1.16;
    var mid = pad.t + ih / 2, half = ih / 2, bw = Math.min(gw / 2, 26);
    // Symmetric gridlines + value labels above (income) and below (expenses) the centre zero line.
    var grid = "", S = 3;
    for (var k = 0; k <= S; k++) {
      var off = (k / S) * half, gv = maxSide * (k / S);
      var yUp = mid - off, yDn = mid + off;
      grid += '<line x1="' + pad.l + '" y1="' + yUp.toFixed(1) + '" x2="' + (w - pad.r) + '" y2="' + yUp.toFixed(1) + '" stroke="' + (k === 0 ? "var(--chart-grid-strong)" : "var(--chart-grid)") + '" vector-effect="non-scaling-stroke"/>' +
        '<text x="' + (pad.l - 6) + '" y="' + (yUp + 3).toFixed(1) + '" text-anchor="end" font-size="9.5" fill="#6b7280">' + fmtCompact(gv) + "</text>";
      if (k > 0) grid += '<line x1="' + pad.l + '" y1="' + yDn.toFixed(1) + '" x2="' + (w - pad.r) + '" y2="' + yDn.toFixed(1) + '" stroke="var(--chart-grid)" vector-effect="non-scaling-stroke"/>' +
        '<text x="' + (pad.l - 6) + '" y="' + (yDn + 3).toFixed(1) + '" text-anchor="end" font-size="9.5" fill="#6b7280">' + fmtCompact(gv) + "</text>";
    }
    var inner = grid;
    pts.forEach(function (p, i) {
      var g = pad.l + (i + 0.5) * gw, inc = num(p.inc), exp = num(p.exp);
      var iH = inc / maxSide * half, eH = exp / maxSide * half;
      if (inc > 0) {
        inner += '<rect x="' + (g - bw / 2).toFixed(1) + '" y="' + (mid - iH).toFixed(1) + '" width="' + bw + '" height="' + iH.toFixed(1) + '" rx="3" fill="var(--hist-income-chart)"/>' +
          '<text x="' + g.toFixed(1) + '" y="' + (mid - iH - 5).toFixed(1) + '" text-anchor="middle" font-size="9.5" fill="var(--hist-income-chart)">' + fmtCompact(inc) + "</text>";
      }
      if (exp > 0) {
        inner += '<rect x="' + (g - bw / 2).toFixed(1) + '" y="' + mid.toFixed(1) + '" width="' + bw + '" height="' + eH.toFixed(1) + '" rx="3" fill="var(--neg)"/>' +
          '<text x="' + g.toFixed(1) + '" y="' + (mid + eH + 12).toFixed(1) + '" text-anchor="middle" font-size="9.5" fill="var(--neg)">' + fmtCompact(exp) + "</text>";
      }
      inner += '<text x="' + g.toFixed(1) + '" y="' + (h - 8) + '" text-anchor="middle" font-size="10" fill="#6b7280">' + esc(p.x) + "</text>";
    });
    return ieLegendHTML() + '<svg class="chart" viewBox="0 0 ' + w + " " + h + '" style="width:100%;height:auto;display:block">' + inner + "</svg>";
  }
  // Dual area: income & expense each as a soft filled area from zero, with lines + a value axis (like Grouped).
  function ieAreaSVG(pts) {
    var w = 1080, h = 300, pad = { l: 56, r: 12, t: 22, b: 28 };
    var iw = w - pad.l - pad.r, ih = h - pad.t - pad.b, nn = pts.length;
    var max = 0; pts.forEach(function (p) { max = Math.max(max, num(p.inc), num(p.exp)); }); max = (max || 1) * 1.12;
    var X = function (i) { return pad.l + (i + 0.5) / nn * iw; };
    var Y = function (v) { return pad.t + ih - (v / max) * ih; };
    var grid = "", S = 4;
    for (var k = 0; k <= S; k++) {
      var gv = max / S * k, gy = Y(gv);
      grid += '<line x1="' + pad.l + '" y1="' + gy.toFixed(1) + '" x2="' + (w - pad.r) + '" y2="' + gy.toFixed(1) + '" stroke="' + (k === 0 ? "var(--chart-grid-strong)" : "var(--chart-grid)") + '" vector-effect="non-scaling-stroke"/>' +
        '<text x="' + (pad.l - 6) + '" y="' + (gy + 3).toFixed(1) + '" text-anchor="end" font-size="9.5" fill="#6b7280">' + fmtCompact(gv) + "</text>";
    }
    var lineOf = function (key) { return pts.map(function (p, i) { return (i ? "L" : "M") + X(i).toFixed(1) + " " + Y(num(p[key])).toFixed(1); }).join(" "); };
    var areaOf = function (key) { return lineOf(key) + " L" + X(nn - 1).toFixed(1) + " " + (pad.t + ih) + " L" + X(0).toFixed(1) + " " + (pad.t + ih) + " Z"; };
    var dotsOf = function (key, c) { return pts.map(function (p, i) { return '<circle cx="' + X(i).toFixed(1) + '" cy="' + Y(num(p[key])).toFixed(1) + '" r="3" fill="' + c + '"/>'; }).join(""); };
    var labels = pts.map(function (p, i) { return '<text x="' + X(i).toFixed(1) + '" y="' + (h - 8) + '" text-anchor="middle" font-size="10" fill="#6b7280">' + esc(p.x) + "</text>"; }).join("");
    return ieLegendHTML() + '<svg class="chart" viewBox="0 0 ' + w + " " + h + '" style="width:100%;height:auto;display:block">' +
      grid +
      '<path d="' + areaOf("exp") + '" fill="var(--neg)" fill-opacity="0.14"/>' +
      '<path d="' + areaOf("inc") + '" fill="var(--hist-income-chart)" fill-opacity="0.14"/>' +
      '<path d="' + lineOf("exp") + '" fill="none" stroke="var(--neg)" stroke-width="2.4" vector-effect="non-scaling-stroke"/>' +
      '<path d="' + lineOf("inc") + '" fill="none" stroke="var(--hist-income-chart)" stroke-width="2.4" vector-effect="non-scaling-stroke"/>' +
      dotsOf("exp", "var(--neg)") + dotsOf("inc", "var(--hist-income-chart)") + labels + "</svg>";
  }
  function incExpPanel(barPts, label, perLabel) {
    var view = (db.settings && db.settings.ieView) || "grouped";
    var head = '<div class="cat-head"><h2>Income vs Expenses | ' + esc(label) + "</h2>" + ieViewChips(view) + "</div>";
    var hint = '<p class="hint">Per ' + esc(perLabel || "frozen month") + ', in ' + esc(base()) + ".</p>";
    var hasData = barPts.some(function (p) { return num(p.inc) > 0 || num(p.exp) > 0; });
    var body;
    if (!hasData) body = '<div class="chart-empty">No income/expense data recorded for ' + esc(label) + ".</div>";
    else if (view === "diverging") body = ieDivergingSVG(barPts);
    else if (view === "area") body = ieAreaSVG(barPts);
    else body = barChartSVG(barPts, [{ key: "inc", color: "var(--hist-income-chart)", label: "Income" }, { key: "exp", color: "var(--neg)", label: "Expenses" }], "No income/expense data recorded for " + label + ".");
    return '<div class="panel mb">' + head + hint + body + "</div>";
  }
  function catViewChips(noun, cur) {
    var opts = [["intensity", "Intensity"], ["legend", "Legend"]];
    return '<span class="range-chips">' + opts.map(function (o) {
      return '<button type="button" class="rc-btn' + (o[0] === cur ? " on" : "") + '" data-act="set-catview" data-noun="' + noun + '" data-view="' + o[0] + '">' + o[1] + "</button>";
    }).join("") + "</span>";
  }
  // Binary-split treemap: fills a rectangle with tiles whose area is proportional to value. out collects
  // {s, x, y, w, h}. Used by the category panel's monochrome (single-hue, intensity-graded) treemap view.
  function catTreemap(items, x, y, w, h, out) {
    if (items.length === 1) { out.push({ s: items[0], x: x, y: y, w: w, h: h }); return; }
    var total = items.reduce(function (s, it) { return s + it.value; }, 0) || 1;
    var half = total / 2, acc = 0, i = 0;
    for (; i < items.length - 1; i++) { if (acc + items[i].value > half && i > 0) break; acc += items[i].value; }
    if (i === 0) i = 1;
    var a = items.slice(0, i), b = items.slice(i);
    var frac = a.reduce(function (s, it) { return s + it.value; }, 0) / total;
    if (w >= h) { var aw = w * frac; catTreemap(a, x, y, aw, h, out); catTreemap(b, x + aw, y, w - aw, h, out); }
    else { var ah = h * frac; catTreemap(a, x, y, w, ah, out); catTreemap(b, x, y + ah, w, h - ah, out); }
  }
  // History "Income/Spending by Category": a single-tone panel (Income = green, Spending = red) with a
  // view switcher (Intensity / Legend / Treemap). All monochrome - they encode size by bar length, dot
  // intensity and tile area + intensity, so one hue suffices. Choice persists per panel in db.settings.catView.
  function categoryYearPanel(title, noun, records, colorFn, scope) {
    var label = scope.label, inScope = scope.inScope;   // scope: { label, inScope(record)->bool } - drives which months/years are summed
    var scopedRecords = (records || []).filter(function (x) { return inScope(x); });
    // Spending can be viewed like Cash Flow: all expenses at the user's share, or only joint expenses.
    // This is a breakdown lens only; History's financial totals stay full-month totals so saved/trend rows remain coherent.
    var hasJointExpense = noun === "expense" && scopedRecords.some(isJoint);
    var expViewJoint = hasJointExpense && state.histExpView === "joint";
    var shownRecords = expViewJoint ? scopedRecords.filter(isJoint) : scopedRecords;
    var expLens = hasJointExpense ?
      '<span class="range-chips lg" style="padding:2px">' +
        '<button type="button" class="rc-btn' + (!expViewJoint ? " on" : "") + '" data-act="set-hist-expview" data-view="mine" style="padding:3px 11px;font-size:11.5px;min-width:78px;text-align:center;white-space:nowrap">My share</button>' +
        '<button type="button" class="rc-btn' + (expViewJoint ? " on" : "") + '" data-act="set-hist-expview" data-view="joint" style="padding:3px 11px;font-size:11.5px;min-width:78px;text-align:center;white-space:nowrap">Joint share</button>' +
      '</span>' : "";
    var cat = {};
    shownRecords.forEach(function (x) {
      cat[x.category] = (cat[x.category] || 0) + toBaseAtMonth(num(x.amount), x.currency, x.month) * viewFrac(x);
    });
    var allCats = Object.keys(cat).sort(function (a, b) { return cat[b] - cat[a]; });
    var total = allCats.reduce(function (s, c) { return s + cat[c]; }, 0);
    var maxV = allCats.length ? cat[allCats[0]] : 0;
    var toneHex = noun === "income" ? "#34d399" : "var(--neg)";
    var soft = function (p) { return "color-mix(in oklch, " + toneHex + " " + p + "%, transparent)"; };
    var view = (db.settings && db.settings.catView && db.settings.catView[noun]) || "intensity";
    var controls = '<span style="display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end">' + expLens + catViewChips(noun, view) + '</span>';
    var head = '<div class="cat-head"><h2>' + esc(title) + " · " + esc(label) + "</h2>" + controls + "</div>";

    if (!allCats.length) {
      return '<div class="panel mb hist-cat-panel">' + head +
        '<div class="hist-cat-scroll"><div class="muted" style="padding:10px 2px">No ' + noun + " recorded for " + esc(label) + ".</div></div></div>";
    }

    var body;
    if (view === "legend") {
      // Two-column legend; each square is the panel hue, opacity graded by the category's share.
      var rowsN = Math.ceil(allCats.length / 2);
      body = '<div class="cat-lg" style="grid-template-rows:repeat(' + rowsN + ',auto)">' + allCats.map(function (c) {
        var v = cat[c], p = total ? v / total : 0, r = maxV ? v / maxV : 0;
        return '<div class="cat-lg-row"><span class="cat-lg-dot" style="background:' + soft(Math.round(28 + 67 * r)) + '"></span>' +
          '<span class="nm">' + esc(c) + '</span><span class="vl">' + fmtBase(v, 0) + '</span><span class="pc">' + pct(p) + "</span></div>";
      }).join("") + "</div>";
    } else {
      // Intensity - a relative-size fill bar per row (like the loading list), with the fill colour graded
      // by the category's share (darker = larger).
      body = '<div class="cat-int">' + allCats.map(function (c) {
        var v = cat[c], p = total ? v / total : 0, r = maxV ? v / maxV : 0;
        return '<div class="cat-int-row"><span class="cat-int-fill" style="width:' + (r * 100) + "%;background:" + soft(Math.round(14 + 64 * r)) + '"></span>' +
          '<span class="nm">' + esc(c) + '</span><span class="vl">' + fmtBase(v, 0) + '</span><span class="pc">' + pct(p) + "</span></div>";
      }).join("") + "</div>";
    }

    return '<div class="panel mb hist-cat-panel">' + head +
      '<p class="hint">Each category\u2019s ' + esc(label) + " total, in " + esc(base()) + '.</p><div class="hist-cat-scroll">' + body + "</div></div>";
  }
  // History scope toggle (top of the page): Year to Date | Last 12 Months | Everything.
  function histScopeToggle(scope) {
    var opts = [["ytd", "Year to Date"], ["last12", "Last 12 Months"], ["everything", "Everything"]];
    return '<span class="range-chips lg hist-scope">' + opts.map(function (o) {
      return '<button type="button" class="rc-btn' + (o[0] === scope ? " on" : "") +
        '" data-act="set-hist-scope" data-scope="' + o[0] + '">' + o[1] + "</button>";
    }).join("") + "</span>";
  }

  function historyPage() {
    var allSnaps = db.snapshots.slice().sort(function (a, b) { return a.month < b.month ? -1 : 1; });
    var nowYear = String(new Date().getFullYear());
    var curYear = state.month.slice(0, 4);
    var scope = state.histScope || "last12";
    var toggle = histScopeToggle(scope);

    if (!allSnaps.length) {
      return pageHead("History", "Your closed-month snapshots.", toggle) +
        emptyState("history", "No history yet", "Snapshots freeze automatically at month-end, year by year.");
    }

    // Include the CURRENT (live, not-yet-frozen) month so History stays in lock-step with the live
    // Investments / Dashboard figures - above all Realized P/L, which the frozen snapshots only carry
    // through the last closed month. Its cumulative realized uses the SAME canonical all-time figure
    // the Investments page shows (totalRealizedAllTime). Non-destructive: this is a render-only row.
    var cm = currentMonth();
    var lpf = portfolioTotals();
    var liveRow = {
      month: cm, live: true, netWorth: netWorthAfterDebts(), invest: lpf.mv, cost: lpf.cost,
      unrealized: lpf.unreal, realized: totalRealizedAllTime(),
      income: monthTotal(db.incomes, cm), expenses: monthTotal(db.expenses, cm),
    };
    var _cmIdx = -1;
    for (var _i = 0; _i < allSnaps.length; _i++) { if (allSnaps[_i].month === cm) { _cmIdx = _i; break; } }
    if (_cmIdx >= 0) allSnaps[_cmIdx] = liveRow; else allSnaps.push(liveRow);
    allSnaps.sort(function (a, b) { return a.month < b.month ? -1 : 1; });

    // Build enriched rows (change / saved / realized-per-period) from any sorted snapshot slice.
    // `realized` is stored CUMULATIVELY, so the per-period figure is the delta vs the previous row.
    function mkRows(arr) {
      return arr.map(function (s, i) {
        var prev = i > 0 ? arr[i - 1].netWorth : null;
        var change = prev == null ? null : s.netWorth - prev;
        var prevInv = i > 0 ? num(arr[i - 1].invest) : null;
        var investChange = prevInv == null ? null : num(s.invest) - prevInv;
        var saved = num(s.income) - num(s.expenses);
        return {
          s: s, change: change, changePct: prev ? change / Math.abs(prev) : null,
          investChange: investChange, investChangePct: prevInv ? investChange / prevInv : null,
          saved: saved, realizedMo: num(s.realized) - (i > 0 ? num(arr[i - 1].realized) : 0),
          savingsRate: savingsRateForPeriod(s.income, s.expenses),
        };
      });
    }

    // ---- Header trend (independent of the scope toggle): the full frozen history. ----
    var trendSnaps = allSnaps;
    var trendPts = mkRows(trendSnaps).map(function (r) { return { x: shortMonth(r.s.month), nw: num(r.s.netWorth), inv: num(r.s.invest), t: monthMs(r.s.month) }; });
    var histRange = state.histRange || "all";
    var histSpan = trendPts.length >= 2 ? (trendPts[trendPts.length - 1].t - trendPts[0].t) / 86400000 : 0;
    var histShown = filterTrend(trendPts, histRange);
    var histDelta = (histShown.length >= 2 && histShown[0].nw) ? (histShown[histShown.length - 1].nw - histShown[0].nw) / histShown[0].nw : null;
    var histPill = histDelta == null ? "" : '<span class="' + (histDelta >= 0 ? "pill-up" : "pill-down") + '">' + (histDelta >= 0 ? "+" : "") + pct(histDelta) + "</span>";

    // hero headline = the selected month's net worth (live for the current month, frozen otherwise)
    var selM = state.month, selSnap = snapByMonth(selM), selIsCur = (selM === currentMonth());
    var selView, selSub;
    if (selIsCur) { var spf = portfolioTotals(); selView = { nw: netWorthAfterDebts(), has: true }; selSub = "Live - " + esc(monthLabel(selM)); }
    else if (selSnap) { selView = { nw: num(selSnap.netWorth), has: true }; selSub = "Frozen - " + esc(monthLabel(selM)); }
    else { selView = { nw: num(trendSnaps[trendSnaps.length - 1].netWorth), has: true }; selSub = "Latest snapshot"; }

    // ===== per-scope figures, bars, category filter, and detail table =====
    var scopeLabel, subtitle, perLabel, tableTitle, tableHint, table, barPts, catScope, has;
    var growth, growthPct, totalSaved, avgRate, hEndNW, hIncome, hExpenses, hInvestPL;

    if (scope === "everything") {
      // group every snapshot by calendar year, then aggregate
      var ymap = {};
      allSnaps.forEach(function (s) { (ymap[s.month.slice(0, 4)] = ymap[s.month.slice(0, 4)] || []).push(s); });
      var years = Object.keys(ymap).sort();
      var agg = years.map(function (y) {
        var ys = ymap[y], last = ys[ys.length - 1];
        var income = ys.reduce(function (s, x) { return s + num(x.income); }, 0);
        var expenses = ys.reduce(function (s, x) { return s + num(x.expenses); }, 0);
        return { y: y, endNW: num(last.netWorth), endInv: num(last.invest), endReal: num(last.realized), income: income, expenses: expenses, saved: income - expenses };
      });
      agg.forEach(function (a, i) {
        var p = i > 0 ? agg[i - 1] : null;
        a.nwChange = p ? a.endNW - p.endNW : null;
        a.nwChangePct = (p && p.endNW) ? a.nwChange / Math.abs(p.endNW) : null;
        a.realYear = a.endReal - (p ? p.endReal : 0);
        a.savingsRate = savingsRateForPeriod(a.income, a.expenses);
      });
      var baseNW = num(allSnaps[0].netWorth), lastA = agg[agg.length - 1];
      var allIncome = agg.reduce(function (s, a) { return s + a.income; }, 0);
      var allExpenses = agg.reduce(function (s, a) { return s + a.expenses; }, 0);
      has = agg.length > 0; scopeLabel = "All Time"; perLabel = "year";
      subtitle = "Every year since you started."; tableTitle = "All Years"; tableHint = "Each column is a full calendar year.";
      growth = (lastA ? lastA.endNW : 0) - baseNW; growthPct = baseNW ? growth / Math.abs(baseNW) : 0;
      totalSaved = allIncome - allExpenses; avgRate = savingsRateForPeriod(allIncome, allExpenses);
      hEndNW = lastA ? num(lastA.endNW) : 0; hIncome = allIncome; hExpenses = allExpenses; hInvestPL = lastA ? num(lastA.endReal) : 0;
      barPts = agg.map(function (a) { return { x: a.y, inc: a.income, exp: a.expenses }; });
      catScope = { label: "All Time", inScope: function () { return true; } };

      var yDefs = [
        { label: "Net Worth", cell: function (a) { return '<td class="num">' + fmtBase(a.endNW) + "</td>"; }, tot: '<td class="num">' + fmtBase(lastA ? lastA.endNW : 0) + "</td>" },
        { label: "Change", cell: function (a) { return '<td class="num ' + (a.nwChange == null ? "" : signClass(a.nwChange)) + '">' + (a.nwChange == null ? "-" : signFmt(a.nwChange)) + "</td>"; }, tot: '<td class="num ' + signClass(growth) + '">' + signFmt(growth) + "</td>" },
        { label: "Change %", cell: function (a) { return '<td class="num ' + (a.nwChangePct == null ? "" : signClass(a.nwChangePct)) + '">' + (a.nwChangePct == null ? "-" : (a.nwChangePct >= 0 ? "+" : "") + pct(a.nwChangePct)) + "</td>"; }, tot: '<td class="num ' + signClass(growthPct) + '">' + (growth >= 0 ? "+" : "") + pct(growthPct) + "</td>" },
        { label: "Investments", cell: function (a) { return '<td class="num">' + fmtBase(a.endInv) + "</td>"; }, tot: '<td class="num">' + fmtBase(lastA ? lastA.endInv : 0) + "</td>" },
        { label: "Realized P/L", cell: function (a) { return '<td class="num ' + signClass(a.realYear) + '">' + signFmt(a.realYear) + "</td>"; }, tot: '<td class="num ' + signClass(lastA ? lastA.endReal : 0) + '">' + signFmt(lastA ? lastA.endReal : 0) + "</td>" },
        { label: "Income", cell: function (a) { return '<td class="num up">' + fmtBase(a.income) + "</td>"; }, tot: '<td class="num up">' + fmtBase(allIncome) + "</td>" },
        { label: "Expenses", cell: function (a) { return '<td class="num down">' + fmtBase(a.expenses) + "</td>"; }, tot: '<td class="num down">' + fmtBase(allExpenses) + "</td>" },
        { label: "Saved", cell: function (a) { return '<td class="num ' + signClass(a.saved) + '">' + signFmt(a.saved) + "</td>"; }, tot: '<td class="num ' + signClass(totalSaved) + '">' + signFmt(totalSaved) + "</td>" },
        { label: "Save %", cell: function (a) { return '<td class="num ' + (a.savingsRate == null ? "" : signClass(a.savingsRate)) + '">' + (a.savingsRate == null ? "-" : pct(a.savingsRate)) + "</td>"; }, tot: '<td class="num ' + (avgRate == null ? "" : signClass(avgRate)) + '">' + (avgRate == null ? "-" : pct(avgRate)) + "</td>" },
      ];
      var yHead = agg.map(function (a) { return '<th class="num">' + esc(a.y) + "</th>"; }).join("");
      var yBody = yDefs.map(function (m) { return "<tr><td><strong>" + m.label + "</strong></td>" + agg.map(m.cell).join("") + m.tot + "</tr>"; }).join("");
      table = has ?
        '<div class="table-wrap"><table class="month-detail"><thead><tr><th>Metric</th>' + yHead +
        '<th class="num">All</th></tr></thead><tbody>' + yBody + "</tbody></table></div>" :
        emptyState("history", "No history yet", "Freeze a month to see it here.");
    } else {
      // ----- month-based scope: Last 12 Months or Year to Date -----
      var scopeSnaps;
      if (scope === "last12") { scopeSnaps = allSnaps.slice(-12); scopeLabel = "Last 12 Months"; subtitle = "Your last 12 frozen months."; }
      else {
        scopeSnaps = allSnaps.filter(function (s) { return s.month.slice(0, 4) === curYear; });
        scopeLabel = (curYear === nowYear) ? "Year to Date" : curYear;
        subtitle = (curYear === nowYear) ? "This year so far, month by month." : "Frozen months in " + esc(curYear) + ".";
      }
      perLabel = "frozen month"; tableTitle = scopeLabel + " - Monthly Detail"; tableHint = "Each column is a month-end snapshot; the current month is live.";
      // Enrich over the FULL timeline, then keep the scope's months - so each month's change / realized is
      // the true delta vs the prior month (not a slice artifact) and period totals are correct flow sums.
      var scopeMonthsSet = {}; scopeSnaps.forEach(function (s) { scopeMonthsSet[s.month] = 1; });
      var sr = mkRows(allSnaps).filter(function (r) { return scopeMonthsSet[r.s.month]; });
      has = sr.length > 0;
      var first = has ? sr[0] : null, lastR = has ? sr[sr.length - 1] : null;
      var startVal = has ? (first.change != null ? first.s.netWorth - first.change : first.s.netWorth) : 0;
      var endVal = has ? lastR.s.netWorth : 0;
      growth = endVal - startVal; growthPct = startVal ? growth / Math.abs(startVal) : 0;
      totalSaved = sr.reduce(function (s, r) { return s + r.saved; }, 0);
      var pIncome = sr.reduce(function (s, r) { return s + num(r.s.income); }, 0);
      var pExpenses = sr.reduce(function (s, r) { return s + num(r.s.expenses); }, 0);
      avgRate = savingsRateForPeriod(pIncome, pExpenses);
      var endInvest = has ? num(lastR.s.invest) : 0;
      var startInvest = has ? (first.investChange != null ? num(first.s.invest) - first.investChange : num(first.s.invest)) : 0;
      var growthInvest = endInvest - startInvest, growthInvestPct = startInvest ? growthInvest / startInvest : 0;
      var pRealized = sr.reduce(function (s, r) { return s + r.realizedMo; }, 0);
      hEndNW = endVal; hIncome = pIncome; hExpenses = pExpenses; hInvestPL = growthInvest;

      var spanYears = scopeSnaps.length ? (scopeSnaps[0].month.slice(0, 4) !== scopeSnaps[scopeSnaps.length - 1].month.slice(0, 4)) : false;
      var mHead = function (m) { var p = m.split("-"); return monthName((+p[1]) - 1) + (spanYears ? " '" + p[0].slice(2) : ""); };
      var scopeSet = {}; scopeSnaps.forEach(function (s) { scopeSet[s.month] = 1; });
      catScope = { label: scopeLabel, inScope: function (rec) { return !!scopeSet[rec.month]; } };
      barPts = scopeSnaps.map(function (s) { return { x: mHead(s.month), inc: num(s.income), exp: num(s.expenses) }; });

      var totHead = scope === "last12" ? "12-mo" : (curYear === nowYear ? "YTD" : esc(curYear));
      var mDefs = [
        { label: "Net Worth", cell: function (r) { return '<td class="num">' + fmtBase(r.s.netWorth) + "</td>"; }, tot: '<td class="num">' + fmtBase(endVal) + "</td>" },
        { label: "Change", cell: function (r) { return '<td class="num ' + (r.change == null ? "" : signClass(r.change)) + '">' + (r.change == null ? "-" : signFmt(r.change)) + "</td>"; }, tot: '<td class="num ' + signClass(growth) + '">' + signFmt(growth) + "</td>" },
        { label: "Change %", cell: function (r) { return '<td class="num ' + (r.changePct == null ? "" : signClass(r.changePct)) + '">' + (r.changePct == null ? "-" : (r.changePct >= 0 ? "+" : "") + pct(r.changePct)) + "</td>"; }, tot: '<td class="num ' + signClass(growthPct) + '">' + (growth >= 0 ? "+" : "") + pct(growthPct) + "</td>" },
        { label: "Investments", cell: function (r) { return '<td class="num">' + fmtBase(r.s.invest) + "</td>"; }, tot: '<td class="num">' + fmtBase(endInvest) + "</td>" },
        { label: "Change", cell: function (r) { return '<td class="num ' + (r.investChange == null ? "" : signClass(r.investChange)) + '">' + (r.investChange == null ? "-" : signFmt(r.investChange)) + "</td>"; }, tot: '<td class="num ' + signClass(growthInvest) + '">' + signFmt(growthInvest) + "</td>" },
        { label: "Realized P/L", cell: function (r) { return '<td class="num ' + signClass(r.realizedMo) + '">' + signFmt(r.realizedMo) + "</td>"; }, tot: '<td class="num ' + signClass(pRealized) + '">' + signFmt(pRealized) + "</td>" },
        { label: "Income", cell: function (r) { return '<td class="num up">' + fmtBase(r.s.income) + "</td>"; }, tot: '<td class="num up">' + fmtBase(pIncome) + "</td>" },
        { label: "Expenses", cell: function (r) { return '<td class="num down">' + fmtBase(r.s.expenses) + "</td>"; }, tot: '<td class="num down">' + fmtBase(pExpenses) + "</td>" },
        { label: "Saved", cell: function (r) { return '<td class="num ' + signClass(r.saved) + '">' + signFmt(r.saved) + "</td>"; }, tot: '<td class="num ' + signClass(totalSaved) + '">' + signFmt(totalSaved) + "</td>" },
        { label: "Save %", cell: function (r) { return '<td class="num ' + (r.savingsRate == null ? "" : signClass(r.savingsRate)) + '">' + (r.savingsRate == null ? "-" : pct(r.savingsRate)) + "</td>"; }, tot: '<td class="num ' + (avgRate == null ? "" : signClass(avgRate)) + '">' + (avgRate == null ? "-" : pct(avgRate)) + "</td>" },
      ];
      var mHeadCols = sr.map(function (r) { return '<th class="num">' + mHead(r.s.month) + "</th>"; }).join("");
      var mBody = mDefs.map(function (m) { return "<tr><td><strong>" + m.label + "</strong></td>" + sr.map(m.cell).join("") + m.tot + "</tr>"; }).join("");
      table = has ?
        '<div class="table-wrap"><table class="month-detail"><thead><tr><th>Metric</th>' + mHeadCols +
        '<th class="num">' + totHead + "</th></tr></thead><tbody>" + mBody + "</tbody></table></div>" :
        emptyState("history", "No snapshots for " + esc(scopeLabel), "Freeze a month to see it here.");
    }

    // ---- summary strip + 2-up charts (shared across scopes) ----
    var hsCell = function (lbl, val, cls) { return '<div class="hs-cell"><div class="hs-lbl">' + lbl + '</div><div class="hs-val ' + (cls || "") + '">' + val + '</div></div>'; };
    var histStrip = has ? '<div class="hist-strip">' +
      hsCell("End Net Worth", fmtBase(hEndNW, 0), "") +
      hsCell("Total Income", fmtBase(hIncome, 0), "up") +
      hsCell("Total Expenses", fmtBase(hExpenses, 0), "down") +
      hsCell("Net Saved", signFmt(totalSaved), signClass(totalSaved)) +
      hsCell("Investment P/L", signFmt(hInvestPL), signClass(hInvestPL)) +
      hsCell("Savings Rate", avgRate == null ? "-" : pct(avgRate), avgRate == null ? "" : signClass(avgRate)) +
      '</div>' : "";
    var nwLegend = '<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#34d399;margin-right:5px;vertical-align:middle"></span>Net Worth' +
      '<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#438cff;margin:0 5px 0 14px;vertical-align:middle"></span>Investments';
    var histCharts =
      '<div class="panel mb"><div class="hero-head" style="margin-bottom:12px"><span class="t">' + nwLegend + '</span><span class="r">' + (histPill ? histPill + '&nbsp;&nbsp;' : '') + trendRangeBar("hist", histSpan, histRange) + '</span></div>' +
      multiLineChartSVG(histShown, [{ key: "nw", color: "#34d399", label: "Net Worth" }, { key: "inv", color: "#438cff", label: "Investments" }], "Two auto-frozen months are needed to see the trend.", false, true) +
      '</div>' +
      incExpPanel(barPts, scopeLabel, perLabel);

    return pageHead("History", subtitle, toggle +
      '<button class="btn" data-act="export-csv" data-kind="history" title="Download the monthly history as a spreadsheet-ready CSV">' + icon("sheet") + " CSV</button>") +
      histStrip +
      histCharts +
      '<div class="hist-2up">' +
      categoryYearPanel("Income by Category", "income", db.incomes, incomeColor, catScope) +
      categoryYearPanel("Spending by Category", "expense", db.expenses, expenseColor, catScope) +
      '</div>' +
      '<div class="panel"><h2>' + esc(tableTitle) + '</h2><p class="hint">' + tableHint + '</p>' + table + "</div>";
  }

  // ----- Cash Flow (merged Income + Expenses) -----
  // Which kind the transaction drawer is currently adding on the Cash Flow page.
  function cfAddKind() { return state.cashflowAddKind === "income" ? "income" : "expense"; }
  function cfDrawerKind(kind) { return kind === "income" ? "income" : "expense"; }
  function cfDraftFromForm() {
    return {
      amount: val("q-amt"),
      currency: val("q-cur") || base(),
      category: val("q-cat"),
      note: val("q-note"),
      joint: checked("q-joint"),
      share: val("q-share") || "50",
      recur: checked("q-recur"),
    };
  }
  function resetQuickLedgerForNext() {
    var amt = document.getElementById("q-amt");
    var note = document.getElementById("q-note");
    var recur = document.getElementById("q-recur");
    if (amt) amt.value = "";
    if (note) note.value = "";
    if (recur) recur.checked = false;
    if (amt) amt.focus();
  }
  function cfQuickFields(kind, draft) {
    kind = cfDrawerKind(kind);
    draft = draft || {};
    var cats = kind === "income" ? db.incomeCategories : db.expenseCategories;
    var isExp = kind === "expense";
    var flowSign = isExp ? "\u2212" : "+", flowColor = isExp ? "var(--neg)" : "var(--pos)";
    var selectedCat = draft.category || cats[0] || "";
    var selectedCur = draft.currency || base();
    var btn = function (k, label) {
      var on = kind === k, c = k === "expense" ? "var(--neg)" : "var(--pos)", soft = k === "expense" ? "var(--neg-soft)" : "var(--pos-soft)";
      return '<button type="button" class="rc-btn" data-act="set-cf-addkind" data-kind="' + k + '" ' +
        'style="font-size:12.5px;padding:5px 14px;font-weight:700;border:1px solid ' + (on ? "color-mix(in oklch, " + c + " 42%, transparent)" : "transparent") + ";" +
        "color:" + (on ? c : "var(--text)") + ";background:" + (on ? soft : "transparent") + '">' + label + "</button>";
    };
    return '<div class="txn-kind"><span class="range-chips" style="padding:3px;gap:3px">' + btn("expense", "Expense") + btn("income", "Income") + "</span></div>" +
      '<form id="quick-ledger" class="qa-cmd txn-form">' +
        '<div class="field"><label>Amount</label><div class="qa-amt"><span class="qa-sign" style="color:' + flowColor + '">' + flowSign + '</span>' +
          '<input id="q-amt" type="number" step="0.01" min="0.01" placeholder="0.00" value="' + esc(draft.amount || "") + '" required autofocus></div></div>' +
        '<div class="field"><label>Currency</label><select id="q-cur" class="qa-cur">' + currencyOptions(selectedCur) + '<option value="__newcur__">+ Add currency\u2026</option></select></div>' +
        '<div class="field"><label>' + (isExp ? "Category" : "Source") + '</label><select id="q-cat" class="qa-cat">' + selectOptions(cats, selectedCat) + '<option value="__newcat__">+ New ' + (isExp ? "category" : "source") + '\u2026</option></select></div>' +
        '<div class="field"><label>Note</label><input id="q-note" class="qa-note" placeholder="Optional" value="' + esc(draft.note || "") + '"></div>' +
        (isExp ? '<div class="txn-inline">' +
          '<label class="check-row qa-joint"><input type="checkbox" id="q-joint"' + (draft.joint ? " checked" : "") + '> Joint</label>' +
          '<div class="qa-share" id="q-joint-wrap" style="' + (draft.joint ? "" : "display:none") + '"><span>Your</span><input id="q-share" type="number" step="1" min="0" max="100" value="' + esc(draft.share || "50") + '"><span>%</span></div>' +
        '</div>' : "") +
        '<label class="check-row qa-recur"><input type="checkbox" id="q-recur"' + (draft.recur ? " checked" : "") + '> ' + icon("refresh") + ' Monthly</label>' +
        '<div class="txn-actions"><button type="button" class="btn ghost" data-act="close-modal">Close</button><button class="btn primary qa-add" type="submit">Add Transaction</button></div>' +
      '</form>';
  }
  function openTransactionDrawer(kind, draft) {
    kind = cfDrawerKind(kind || (state.cfView === "income" ? "income" : state.cfView === "expenses" ? "expense" : cfAddKind()));
    state.cashflowAddKind = kind;
    openModal({
      bare: true,
      cls: "txn-drawer",
      body:
        '<div class="txn-drawer-shell">' +
          '<div class="txn-drawer-head"><div><h2>Add Transaction</h2><p>' + esc(monthLabel(state.month)) + '</p></div>' +
          '<button type="button" class="m-x" data-act="close-modal" aria-label="Close">' + icon("close") + '</button></div>' +
          cfQuickFields(kind, draft) +
        '</div>',
    });
  }
  function cashflowPage() {
    var m = state.month;
    var incCats = db.incomeCategories, expCats = db.expenseCategories;
    // Category colors resolve through the shared, override-aware resolvers (Settings -> Colors), so the
    // Cash Flow tags match the History "Spending by Category" chart and anywhere else a category is drawn.
    var incColor = incomeColor, expColor = expenseColor;

    var bToBase = function (x) { return toBaseAtMonth(num(x.amount), x.currency, m) * viewFrac(x); };   // at the selected month's frozen FX; joint "my share" lens (expenses)
    var incItems = db.incomes.filter(function (x) { return x.month === m; });
    var expItems = db.expenses.filter(function (x) { return x.month === m; });
    var incTotal = incItems.reduce(function (s, x) { return s + bToBase(x); }, 0);
    var expTotal = expItems.reduce(function (s, x) { return s + bToBase(x); }, 0);
    var net = incTotal - expTotal;
    var savedRate = incTotal > 0 ? net / incTotal : 0;
    var hasAny = incItems.length || expItems.length;

    function byCat(items) { var o = {}; items.forEach(function (x) { o[x.category] = (o[x.category] || 0) + bToBase(x); }); return o; }
    var incBy = byCat(incItems), expBy = byCat(expItems);
    // Expenses card view: "My share" (all my expenses) vs "Joint share" (only the joint expenses).
    var jointExpItems = expItems.filter(isJoint);
    var hasJointExp = jointExpItems.length > 0;
    var expViewJoint = hasJointExp && state.cfExpView === "joint";
    var expByShown = expViewJoint ? byCat(jointExpItems) : expBy;
    var expTotalShown = expViewJoint ? jointExpItems.reduce(function (s, x) { return s + bToBase(x); }, 0) : expTotal;
    var expToggle = hasJointExp ?
      '<span class="range-chips lg cf-share-toggle" style="margin-left:auto;padding:2px">' +
        '<button type="button" class="rc-btn' + (!expViewJoint ? " on" : "") + '" data-act="set-cf-expview" data-view="mine" style="padding:3px 11px;font-size:11.5px;min-width:78px;text-align:center;white-space:nowrap">My share</button>' +
        '<button type="button" class="rc-btn' + (expViewJoint ? " on" : "") + '" data-act="set-cf-expview" data-view="joint" style="padding:3px 11px;font-size:11.5px;min-width:78px;text-align:center;white-space:nowrap">Joint share</button>' +
      "</span>" : "";
    var maxIO = Math.max(incTotal, expTotal, 1);
    var netStr = (net >= 0 ? "+" : "\u2212") + fmtBase(Math.abs(net), 0);
    var netFoot = (net >= 0 ? "+" : "\u2212") + fmtBase(Math.abs(net), 2);

    var cfView = (state.cfView === "expenses" || state.cfView === "income" || state.cfView === "categorizer") ? state.cfView : "dashboard";
    var cfTabs = '<div class="cf-tabs">' +
      '<button type="button" class="cf-tab' + (cfView === "dashboard" ? " on" : "") + '" data-act="set-cf-view" data-view="dashboard">Dashboard</button>' +
      '<button type="button" class="cf-tab' + (cfView === "expenses" ? " on" : "") + '" data-act="set-cf-view" data-view="expenses">Expenses</button>' +
      '<button type="button" class="cf-tab' + (cfView === "income" ? " on" : "") + '" data-act="set-cf-view" data-view="income">Income</button>' +
      '<button type="button" class="cf-tab' + (cfView === "categorizer" ? " on" : "") + '" data-act="set-cf-view" data-view="categorizer">Categoriser</button>' +
      '</div>';
    var topCats = function (by, totalAmt, colorFn, limit) {
      var keys = Object.keys(by).sort(function (a, b) { return by[b] - by[a]; }).slice(0, limit || 5);
      return keys.map(function (c) { return { name: c, value: by[c], pct: totalAmt ? by[c] / totalAmt : 0, color: colorFn(c) }; });
    };
    var stacked = function (items, totalAmt) {
      return items.length ? '<div class="stack-bar" style="height:10px;margin-top:14px">' + items.map(function (r) {
        return '<div style="width:' + (totalAmt ? r.value / totalAmt * 100 : 0).toFixed(2) + '%;background:' + r.color + '"></div>';
      }).join("") + '</div>' : '<div class="stack-bar" style="height:10px;margin-top:14px"></div>';
    };
    var miniRows = function (rows, totalAmt, signed, extraClass) {
      return '<div class="cf-mini' + (extraClass ? " " + extraClass : "") + '">' + (rows.length ? rows.map(function (r) {
        return '<div class="cf-mini-row"><span title="' + esc(r.name) + '">' + esc(r.name) + '</span><strong>' + (signed ? signFmt(r.value) : fmtBase(r.value, 0)) + '</strong>' +
          '<div class="cf-track"><span style="width:' + (totalAmt ? Math.min(100, r.value / totalAmt * 100) : 0).toFixed(1) + '%;background:' + r.color + '"></span></div></div>';
      }).join("") : '<div class="hint" style="margin:0">Nothing logged for ' + esc(monthLabel(m)) + '.</div>') + '</div>';
    };
    var signalRows = function (rows) {
      return '<div class="cf-signal-list">' + rows.map(function (r) {
        return '<div class="cf-signal-row"><span>' + esc(r.label) + '</span><strong class="' + (r.cls || "") + '">' + r.value + '</strong></div>';
      }).join("") + '</div>';
    };
    var listRows = function (rows, empty) {
      return '<div class="cf-list">' + (rows.length ? rows.map(function (r) {
        return '<div class="cf-list-row"><span class="cf-dot" style="background:' + r.color + '"></span><span class="cf-name">' + esc(r.name) + '</span><span class="cf-amt">' + fmtBase(r.value, 0) + '</span></div>';
      }).join("") : '<div class="hint" style="margin:0">' + empty + '</div>') + '</div>';
    };
    var prevM = prevMonthStr(m);
    var prevExp = db.expenses.filter(function (x) { return x.month === prevM; }).reduce(function (s, x) { return s + toBaseAtMonth(num(x.amount), x.currency, prevM) * viewFrac(x); }, 0);
    var expDelta = prevExp ? (expTotalShown - prevExp) / prevExp : null;
    var expTop = topCats(expByShown, expTotalShown, expColor, 99);
    var incTop = topCats(incBy, incTotal, incColor, 99);
    var cfSummaryCards =
      '<div class="cf-grid cf-top-grid cf-dashboard-top two">' +
        '<div class="cf-card cf-sticky-list-card cf-dashboard-income-card"><div class="cf-sticky-list-head"><div class="cf-card-head"><div class="cf-label">Income This Month</div></div>' +
          '<div class="cf-value up">' + fmtBase(incTotal, 0) + '</div>' + stacked(incTop, incTotal) + '</div>' + miniRows(incTop, incTotal, false, "cf-category-scroll") + '</div>' +
        '<div class="cf-card cf-sticky-list-card cf-dashboard-spent-card"><div class="cf-sticky-list-head"><div class="cf-card-head"><div class="cf-label">Spent This Month</div>' +
          expToggle + (expDelta == null ? "" : '<span class="' + (expDelta <= 0 ? "pill-up" : "pill-down") + '">' + (expDelta > 0 ? "+" : "") + pct(expDelta) + '</span>') + '</div>' +
          '<div class="cf-value down">' + fmtBase(expTotalShown, 0) + '</div>' + stacked(expTop, expTotalShown) + '</div>' + miniRows(expTop, expTotalShown, false, "cf-category-scroll") + '</div>' +
      '</div>';

    var cfSort = state.cfSort || "recent";
    var cfDir = state.cfSortDir === "asc" ? -1 : 1;   // default descending / "down"; the icon flips it
    var byId = function (a, b) { return a.x.id < b.x.id ? 1 : a.x.id > b.x.id ? -1 : 0; };   // most-recent first (uid is time-prefixed)
    function cfCmp(a, b) {
      if (cfSort === "amount") return b.b - a.b || byId(a, b);
      if (cfSort === "category") { var ca = a.x.category.toLowerCase(), cb = b.x.category.toLowerCase(); return ca < cb ? -1 : ca > cb ? 1 : byId(a, b); }
      if (cfSort === "currency") return a.x.currency < b.x.currency ? -1 : a.x.currency > b.x.currency ? 1 : byId(a, b);
      if (cfSort === "flow") return (a.kind === b.kind) ? byId(a, b) : (a.kind === "income" ? -1 : 1);
      return byId(a, b);   // "recent"
    }
    var all = incItems.map(function (x) { return { x: x, kind: "income", c: incColor(x.category), b: bToBase(x) }; })
      .concat(expItems.map(function (x) { return { x: x, kind: "expense", c: expColor(x.category), b: bToBase(x) }; }))
      .sort(function (a, b) { return cfCmp(a, b) * cfDir; });
    var expenseRows = all.filter(function (r) { return r.kind === "expense" && (!expViewJoint || isJoint(r.x)); });
    var incomeRows = all.filter(function (r) { return r.kind === "income"; });
    function ledgerRows(rows) {
      return rows.map(function (r) {
      var inc = r.kind === "income";
      var col = inc ? "var(--pos)" : "var(--neg)";
      var rowTitle = r.x.category + (r.x.note ? " - " + r.x.note : "") + " - " + fmt(r.x.amount, r.x.currency);
      return '<tr class="cf-ledger-row ' + (inc ? "cf-income-row" : "cf-expense-row") + '" data-flow="' + (inc ? "income" : "expense") + '" title="' + esc(rowTitle) + '">' +
        '<td><span style="font-size:11px;font-weight:700;color:' + col + '">' + (inc ? "\u25B2 In" : "\u25BC Out") + '</span></td>' +
        '<td><span class="cf-ledger-category" title="' + esc(r.x.category) + '">' + esc(r.x.category) + '</span>' +
          (r.x.recurringId ? ' <span class="tag recur-tag" title="Auto-logged monthly">' + icon("refresh") + '</span>' : "") +
          (isJoint(r.x) ? ' <span class="tag"' + (r.x.coOwner ? ' title="Shared with ' + esc(r.x.coOwner) + '"' : "") + ">Joint - " + (r.x.share == null ? 100 : r.x.share) + "%</span>" : "") + "</td>" +
        '<td>' + esc(r.x.note || "") + '</td>' +
        '<td class="num" style="color:' + col + '">' + (inc ? "+" : "\u2212") + fmtBase(r.b, 2) + '</td>' +
        '<td class="num">' + fmt(r.x.amount, r.x.currency) + ' <span class="badge-curr">' + esc(r.x.currency) + '</span></td>' +
        '<td class="right"><button class="btn sm ghost" data-act="edit-ledger" data-id="' + r.x.id + '" data-kind="' + r.kind + '">Edit</button> ' +
        '<button class="btn sm ghost" data-act="del-ledger" data-id="' + r.x.id + '" data-kind="' + r.kind + '">\u2715</button></td></tr>';
      }).join("");
    }
    var EXPENSE_TABLE_H = 464; // header + 8 compact rows + footer - body scrolls, footer stays pinned
    var INCOME_TABLE_H = 370;  // header + 6 compact rows + footer
    function ledgerTable(rows, empty, footLabel, footValue, footColor, flowKind) {
      var flow = flowKind === "expense" ? "expense" : "income";
      var tableH = flow === "expense" ? EXPENSE_TABLE_H : INCOME_TABLE_H;
      var bodyRows = ledgerRows(rows) || '<tr class="cf-ledger-empty" data-flow="' + flow + '"><td colspan="6" style="text-align:center;color:var(--text-3);padding:46px 0">' + esc(empty) + '</td></tr>';
      return '<div class="table-wrap cf-ledger" data-flow="' + flow + '" style="height:' + tableH + 'px;overflow:hidden"><table><thead><tr><th>Flow</th><th>Category</th><th>Note</th><th class="num">In ' + esc(base()) + '</th><th class="num">Amount</th><th></th></tr></thead><tbody>' + bodyRows + '</tbody>' +
        '<tfoot><tr><td colspan="3">' + esc(footLabel) + '</td><td class="num" style="color:' + footColor + '">' + footValue + '</td><td colspan="2"></td></tr></tfoot></table></div>';
    }

    var lBadge = (m === currentMonth()) ? statusBadge(esc(monthLabel(m)), "Live", "live")
      : (snapByMonth(m) ? statusBadge(esc(monthLabel(m)), icon("lock") + "Frozen", "frozen")
        : statusBadge(esc(monthLabel(m)), "", "neutral"));
    var addDefaultKind = cfView === "income" ? "income" : (cfView === "expenses" ? "expense" : cfAddKind());
    var head = pageHead("Cash Flow", "Income and spending for the month, side by side.",
      '<button class="btn primary" data-act="open-cf-drawer" data-kind="' + addDefaultKind + '">' + ICON.plus + ' Add Transaction</button>' +
      '<button class="btn" data-act="import-cashflow" data-kind="income" title="CSV or Excel: date/month, category, amount, currency, note">' + icon("arrowUp") + ' Import Income</button>' +
      '<button class="btn" data-act="import-cashflow" data-kind="expense" title="CSV or Excel: date/month, category, amount, currency, note. Also supports Category, Personal, Joint, Total summaries.">' + icon("arrowUp") + ' Import Expenses</button>' +
      '<button class="btn" data-act="export-cashflow-csv" title="Download income &amp; expenses (this month or all) as a spreadsheet-ready CSV">' + icon("sheet") + ' CSV</button>',
      lBadge);
    // Empty app: a clean empty state with a CTA into the drawer.
    if (!hasAny && !state.cfStarted && cfView !== "categorizer")
      return head + cfTabs + emptyState("expenses", "No income or expenses yet", "Track what comes in and goes out each month, by category.") +
        '<div style="text-align:center;margin-top:18px"><button class="btn primary" data-act="cf-start" data-kind="' + addDefaultKind + '">' + ICON.plus + ' Add Transaction</button></div>';

    // Live filter for the visible ledger (matches Flow / Category / Note / amount); filters rows in the
    // DOM on input, so it needs no re-render and keeps focus.
    var cfDirIcon = state.cfSortDir === "asc" ? "arrowUp" : "arrowDown";
    var cfDirTitle = state.cfSortDir === "asc" ? "Ascending - click for descending" : "Descending - click for ascending";
    var cfSortSel = '<select id="cf-sort" style="flex:0 0 auto;width:148px;padding:8px 30px 8px 12px;border-radius:9px;border:1px solid var(--line-2);color:var(--text);font-size:13px;font-family:inherit;color-scheme:inherit">' +
      [["recent", "Most Recent"], ["amount", "Amount"], ["category", "Category"], ["currency", "Currency"], ["flow", "Flow"]]
        .map(function (o) { return '<option value="' + o[0] + '"' + (cfSort === o[0] ? " selected" : "") + ">" + o[1] + "</option>"; }).join("") + "</select>";
    var cfDirBtn = '<button type="button" class="btn sm ghost" data-act="toggle-cf-sortdir" title="' + cfDirTitle + '" style="flex:0 0 auto;padding:7px 9px">' + icon(cfDirIcon) + "</button>";
    var searchBar = function (placeholder) {
      return '<div style="display:flex;justify-content:flex-start;align-items:center;gap:8px;margin-bottom:10px">' +
        '<span style="font-size:12px;font-weight:600;color:var(--text-3);white-space:nowrap">Sort by</span>' + cfSortSel + cfDirBtn +
        '<input id="cf-search" type="search" autocomplete="off" placeholder="' + esc(placeholder) + '" ' +
        'style="flex:0 0 190px;width:190px;padding:8px 12px;border-radius:9px;border:1px solid var(--line-2);color:var(--text);font-size:13px;font-family:inherit"></div>';
    };

    function recurringPanel(kind) {
      var isIncome = kind === "income";
      var recurList = (db.recurring || []).filter(function (r) { return r.kind === (isIncome ? "income" : "expense"); });
      var title = isIncome ? "Recurring Income" : "Recurring Expenses";
      var empty = isIncome ? "No recurring income yet." : "No recurring expenses yet.";
      var chips = recurList.length ? recurList.map(function (r) {
        var sign = isIncome ? "+" : "−";
        return '<span class="chip recur-chip">' +
          esc(r.category) + " - " + sign + fmt(r.amount, r.currency) + (r.note ? " - " + esc(r.note) : "") +
          '<span class="x" data-act="del-recurring" data-id="' + r.id + '" title="Stop repeating">×</span></span>';
      }).join("") : '<span class="muted">' + empty + '</span>';
      return '<div class="panel mb cf-recurring-card">' +
        '<div class="flex between center mb"><h2 style="margin:0;display:inline-flex;align-items:center;gap:8px">' + icon("refresh") + esc(title) + '</h2>' +
        '<span class="hint" style="margin:0">Auto-logged at the start of each month</span></div>' +
        '<div class="flex gap wrap">' + chips + "</div></div>";
    }

    var largestExpense = expenseRows.slice().sort(function (a, b) { return b.b - a.b || byId(a, b); })[0];
    var jointTotalShown = jointExpItems.reduce(function (s, x) { return s + bToBase(x); }, 0);
    var avgExpense = expenseRows.length ? expTotalShown / expenseRows.length : 0;
    var topShare = expTop[0] && expTotalShown ? expTop[0].value / expTotalShown : 0;
    var expenseSignals = signalRows([
      { label: "Largest expense", value: largestExpense ? fmtBase(largestExpense.b, 0) : "None", cls: largestExpense ? "down" : "" },
      { label: "Largest category", value: expTop[0] ? esc(expTop[0].name) + " " + pct(topShare) : "None" },
      { label: "Joint share", value: expTotalShown ? pct(jointTotalShown / expTotalShown) : "0%" },
      { label: "Average expense", value: expenseRows.length ? fmtBase(avgExpense, 0) : "None" }
    ]);
    var largestIncome = incomeRows.slice().sort(function (a, b) { return b.b - a.b || byId(a, b); })[0];
    var avgIncome = incomeRows.length ? incTotal / incomeRows.length : 0;
    var incomeTopShare = incTop[0] && incTotal ? incTop[0].value / incTotal : 0;
    var incomeSignals = signalRows([
      { label: "Largest income", value: largestIncome ? fmtBase(largestIncome.b, 0) : "None", cls: largestIncome ? "up" : "" },
      { label: "Largest source", value: incTop[0] ? esc(incTop[0].name) + " " + pct(incomeTopShare) : "None" },
      { label: "Income entries", value: String(incomeRows.length) },
      { label: "Average income", value: incomeRows.length ? fmtBase(avgIncome, 0) : "None" }
    ]);
    var expenseCards = '<div class="cf-grid cf-top-grid cf-flow-top cf-expense-top two">' +
      '<div class="cf-card cf-sticky-list-card cf-spent-card"><div class="cf-sticky-list-head"><div class="cf-card-head"><div class="cf-label">Spent This Month</div>' + expToggle + '</div><div class="cf-value down">' + fmtBase(expTotalShown, 0) + '</div>' + stacked(expTop, expTotalShown) + '</div>' + miniRows(expTop, expTotalShown, false, "cf-category-scroll") + '</div>' +
      '<div class="cf-side-stack"><div class="cf-card cf-signal-card"><div class="cf-card-head"><div class="cf-label">Spending Signals</div><strong>' + expenseRows.length + '</strong></div>' + expenseSignals + '</div>' + recurringPanel("expense") + '</div>' +
      '</div>';
    var incomeCards = '<div class="cf-grid cf-top-grid cf-flow-top cf-income-top two">' +
      '<div class="cf-card cf-sticky-list-card cf-income-card"><div class="cf-sticky-list-head"><div class="cf-card-head"><div class="cf-label">Income This Month</div></div><div class="cf-value up">' + fmtBase(incTotal, 0) + '</div>' + stacked(incTop, incTotal) + '</div>' + miniRows(incTop, incTotal, false, "cf-category-scroll") + '</div>' +
      '<div class="cf-side-stack"><div class="cf-card cf-signal-card"><div class="cf-card-head"><div class="cf-label">Income Signals</div><strong>' + incomeRows.length + '</strong></div>' + incomeSignals + '</div>' + recurringPanel("income") + '</div>' +
      '</div>';
    var topIncome = incTop[0] ? incTop[0].name : "None";
    var topExpense = expTop[0] ? expTop[0].name : "None";
    var balancePanel =
      '<div class="cf-card cf-balance-panel"><div class="cf-card-head"><div class="cf-label">Cash Flow Balance</div><span class="hint" style="margin:0">' + esc(monthLabel(m)) + '</span></div>' +
        '<div class="cf-balance-body">' +
          '<div class="cf-balance-net"><div class="cf-label">Net Cash Flow</div><div class="cf-balance-value ' + (net >= 0 ? "up" : "down") + '">' + netStr + '</div></div>' +
          '<div class="cf-balance-bars">' +
            '<div class="cf-balance-row"><span>Income</span><div class="cf-balance-track"><span style="width:' + (incTotal / maxIO * 100).toFixed(1) + '%;background:var(--pos)"></span></div><strong class="up">+' + fmtBase(incTotal, 0) + '</strong></div>' +
            '<div class="cf-balance-row"><span>Spent</span><div class="cf-balance-track"><span style="width:' + (expTotal / maxIO * 100).toFixed(1) + '%;background:var(--neg)"></span></div><strong class="down">-' + fmtBase(expTotal, 0) + '</strong></div>' +
          '</div>' +
          '<div class="cf-balance-metrics">' +
            '<div><span>Saved</span><strong>' + pct(savedRate) + '</strong></div>' +
            '<div><span>Spent / Income</span><strong>' + pct(incTotal ? expTotal / incTotal : 0) + '</strong></div>' +
            '<div><span>Top expense</span><strong>' + esc(topExpense) + '</strong></div>' +
            '<div><span>Top income</span><strong>' + esc(topIncome) + '</strong></div>' +
          '</div>' +
        '</div>' +
      '</div>';
    var dashboardView =
      cfTabs +
      cfSummaryCards +
      balancePanel;
    var expensesView =
      cfTabs +
      expenseCards +
      '<div class="cf-section-title">Expense Ledger</div>' +
      searchBar("Search expenses...") +
      ledgerTable(expenseRows, "No expenses logged for " + monthLabel(m) + ".", "Spent " + monthLabel(m), "\u2212" + fmtBase(expTotalShown, 2), "var(--neg)", "expense");
    var incomeView =
      cfTabs +
      incomeCards +
      '<div class="cf-section-title">Income Ledger</div>' +
      searchBar("Search income...") +
      ledgerTable(incomeRows, "No income logged for " + monthLabel(m) + ".", "Income " + monthLabel(m), "+" + fmtBase(incTotal, 2), "var(--pos)", "income");
    var categorizerView = cfTabs + (window.ValutioStatementCategorizer
      ? window.ValutioStatementCategorizer.render()
      : '<div class="panel"><h2>Statement Categoriser</h2><p class="hint">The categoriser could not be loaded. Refresh the app and try again.</p></div>');

    return head + (cfView === "categorizer" ? categorizerView : (cfView === "income" ? incomeView : (cfView === "expenses" ? expensesView : dashboardView)));
  }

  // ----- Goals -----
  // whole months from the current month to a 'YYYY-MM' target (negative if in the past)
  function monthsUntil(ym) {
    var c = currentMonth().split("-"), t = (ym || "").split("-");
    if (t.length < 2) return 0;
    return (+t[0] - +c[0]) * 12 + (+t[1] - +c[1]);
  }
  function futureMonthOptions(selected) {
    var out = [], seen = {}, d = new Date(); d.setDate(1);
    for (var i = 0; i < 72; i++) {
      var m = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
      seen[m] = 1;
      out.push('<option value="' + m + '"' + (m === selected ? " selected" : "") + ">" + monthLabel(m) + "</option>");
      d.setMonth(d.getMonth() + 1);
    }
    // Keep an already-passed target month (editing an old goal) as an option so saving doesn't snap its date
    // to the current month.
    if (selected && /^\d{4}-\d{2}$/.test(selected) && !seen[selected]) out.unshift('<option value="' + selected + '" selected>' + monthLabel(selected) + "</option>");
    return out.join("");
  }
  function goalModal(existing) {
    var g = existing || { name: "", cost: "", currency: base(), targetMonth: "", currentSavings: 0 };
    var defMonth = g.targetMonth;
    if (!defMonth) { var d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + 12); defMonth = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); }
    openModal({
      title: existing ? "Edit Goal" : "Add Goal",
      sub: "Set a target cost and date; the per-month saving needed is worked out for you.",
      body:
        '<div class="field"><label>Goal name</label><input id="g-name" value="' + esc(g.name) + '" placeholder="e.g. Trip, Bike, Car, Telescope" required></div>' +
        '<div class="row"><div class="field"><label>Target cost</label><input id="g-cost" type="number" step="any" value="' + esc(g.cost) + '" placeholder="0.00" required></div>' +
        '<div class="field"><label>Currency</label><select id="g-cur">' + currencyOptions(g.currency) + "</select></div></div>" +
        '<div class="field"><label>Target date (month / year)</label><select id="g-month">' + futureMonthOptions(defMonth) + "</select></div>" +
        (existing ? '<div class="field"><label>Saved so far</label><input id="g-saved" type="number" step="any" value="' + esc(g.currentSavings || 0) + '"></div>' : ""),
      onSubmit: function () {
        var name = val("g-name").trim(); if (!name) return false;
        var cost = num(val("g-cost")); if (!(cost > 0)) { toast("Enter a target cost"); return false; }
        var saved = existing ? num(val("g-saved")) : 0;
        var obj = { id: existing ? existing.id : uid(), name: name, cost: cost, currency: val("g-cur"), targetMonth: val("g-month"), currentSavings: saved };
        if (existing) { var i = db.goals.findIndex(function (x) { return x.id === existing.id; }); db.goals[i] = obj; }
        else db.goals.push(obj);
        save(); render(); toast("Goal saved");
      },
    });
  }
  function contributionModal(goal) {
    if (!goal) return;
    openModal({
      title: "Add Contribution",
      sub: "Log money you saved toward <strong>" + esc(goal.name) + "</strong>. Added to your total; lowers the monthly amount still needed.",
      body: '<div class="field"><label>Contribution amount (' + esc(goal.currency) + ")</label>" +
        '<input id="g-contrib" type="number" step="any" placeholder="0.00" required></div>',
      submitLabel: "Add Contribution",
      onSubmit: function () {
        var amt = num(val("g-contrib")); if (!(amt > 0)) { toast("Enter an amount"); return false; }
        goal.currentSavings = num(goal.currentSavings) + amt;   // append onto the running total
        save(); render(); toast("Added " + fmt(amt, goal.currency) + " to " + goal.name);
      },
    });
  }
  function goalsPage() {
    var goals = db.goals || [];
    var head = pageHead("Goals", "Set a target cost and date; we work out what to save each month.",
      '<button class="btn primary" data-act="add-goal">+ Add Goal</button>');
    if (!goals.length) {
      return head + emptyState("flag", "No goals yet", "Add a savings goal (a trip, a bike, a telescope) with a target cost and date.");
    }
    var remainingOf = function (g) { return Math.max(0, num(g.cost) - num(g.currentSavings)); };
    var totalTarget = goals.reduce(function (s, g) { return s + toBase(num(g.cost), g.currency); }, 0);
    // Cap each goal's saved-toward-target at its own cost so over-saving on one goal can't offset another's
    // shortfall (which made "Still to save" read €0 while a goal still needed money, and over-filled the bar).
    var totalSaved = goals.reduce(function (s, g) { return s + toBase(Math.min(num(g.currentSavings), num(g.cost)), g.currency); }, 0);
    var stillToSave = goals.reduce(function (s, g) { return s + toBase(remainingOf(g), g.currency); }, 0);
    var goalsHero = barHeader("Saved Toward Goals", fmtBase(totalSaved, 0),
      [{ label: "Saved", value: totalSaved, color: "var(--pos)" }, { label: "Still to save", value: stillToSave, color: "var(--d-amber)" }], totalTarget || 1);
    var gcStat = function (k, v) { return '<div class="dc-st"><div class="dc-k">' + k + '</div><div class="dc-v">' + v + '</div></div>'; };
    var cards = '<div class="dcards">' + goals.map(function (g, gi) {
      var months = monthsUntil(g.targetMonth);
      var saved = num(g.currentSavings), cost = num(g.cost), remaining = remainingOf(g);
      var perMonth = months > 0 ? remaining / months : remaining;
      var pct0 = cost > 0 ? Math.min(100, Math.round(saved / cost * 100)) : 0;
      var done = remaining <= 0;
      var col = paletteColor(gi), accent = done ? "var(--pos)" : col;
      return '<div class="dcard"><span class="dcard-fill" style="width:' + pct0 + '%;background:' + accent + '"></span>' +
        '<div class="dcard-top"><span class="dcard-dot" style="background:' + accent + '"></span>' +
          '<span class="dcard-nm">' + esc(g.name) + '</span>' +
          '<span class="tag">Target ' + esc(monthLabel(g.targetMonth)) + '</span>' +
          '<span class="dcard-bal">' + fmt(saved, g.currency, 0) + '<span style="color:var(--text-3);font-weight:600"> / ' + fmt(cost, g.currency, 0) + '</span></span>' +
          '<span class="dcard-act">' + (done ? "" : '<button class="btn sm primary" data-act="add-contribution" data-id="' + g.id + '">Contribute</button> ') +
            '<button class="btn sm ghost" data-act="edit-goal" data-id="' + g.id + '">Edit</button> <button class="btn sm ghost" data-act="del-goal" data-id="' + g.id + '">\u2715</button></span>' +
        '</div>' +
        '<div class="dcard-grid">' +
          gcStat("Progress", pct0 + "%") +
          gcStat("Per month", done ? "-" : fmt(perMonth, g.currency, 0)) +
          gcStat("Remaining", done ? "Reached" : fmt(remaining, g.currency, 0)) +
          gcStat("Months left", done ? "-" : String(Math.max(0, months))) +
        '</div></div>';
    }).join("") + '</div>';
    return head + goalsHero + cards;
  }

  // ----- Assets (physical / non-liquid) -----
  var ASSET_CATEGORIES = ["Vehicle", "Property", "Art", "Jewelry", "Watches", "Collectibles", "Electronics", "Other"];
  function assetCatColor(c) { return colorOverride("asset", c) || safeCatColor(c, ASSET_CATEGORIES.indexOf(c)); }
  function assetModal(existing) {
    var a = existing || { name: "", category: "Vehicle", value: "", currency: base(), includeInNetWorth: true, nwMode: "equity" };
    openModal({
      title: existing ? "Edit Asset" : "Add Asset",
      sub: "Track a physical asset and whether it counts toward net worth.",
      body:
        '<div class="field"><label>Asset name</label><input id="as-name" value="' + esc(a.name) + '" placeholder="e.g. Car, House, Fine Art, Watches, Collectibles" required></div>' +
        '<div class="row"><div class="field"><label>Category</label><select id="as-cat">' + selectOptions(ASSET_CATEGORIES, a.category) + "</select></div>" +
        '<div class="field"><label>Currency</label><select id="as-cur">' + currencyOptions(a.currency) + "</select></div></div>" +
        '<div class="field"><label>Estimated current market value</label><input id="as-value" type="number" step="any" value="' + esc(a.value) + '" placeholder="0.00" required></div>' +
        '<div class="field"><label>Net worth value</label><select id="as-mode">' +
          '<option value="equity"' + (a.nwMode === "full" ? "" : " selected") + '>Owned equity (value − linked loan)</option>' +
          '<option value="full"' + (a.nwMode === "full" ? " selected" : "") + '>Full value (track loan separately)</option>' +
          '</select><div class="field-note">Owned equity nets linked loans. Full value counts the asset and subtracts the loan separately.</div></div>' +
        '<div class="field"><label class="check-row"><input type="checkbox" id="as-include"' + (a.includeInNetWorth ? " checked" : "") + "> Include in Net Worth Calculations</label></div>",
      onSubmit: function () {
        var name = val("as-name").trim(); if (!name) return false;
        var obj = { id: existing ? existing.id : uid(), name: name, category: val("as-cat"), value: num(val("as-value")), currency: val("as-cur"), includeInNetWorth: checked("as-include"), nwMode: val("as-mode") === "full" ? "full" : "equity" };
        if (existing) { var i = db.physicalAssets.findIndex(function (x) { return x.id === existing.id; }); db.physicalAssets[i] = obj; }
        else db.physicalAssets.push(obj);
        save(); render(); toast("Asset saved");
      },
    });
  }
  function assetsPage() {
    var assets = db.physicalAssets || [];
    var head = pageHead("Assets", "Physical and non-liquid assets (car, property, art, watches).",
      '<button class="btn primary" data-act="add-asset">+ Add Asset</button>');
    if (!assets.length) {
      return head + emptyState("assets", "No assets yet", "Add a car, property, art or any valuable, and choose whether it counts toward your net worth.");
    }
    // Each asset is shown at the value it adds to net worth: its OWNED part (value - linked loan) unless it
    // opts into "full". Excluded assets show their full value (they just don't count toward net worth).
    var dispVal = function (a) { return a.includeInNetWorth ? assetNetBase(a) : toBase(num(a.value), a.currency); };
    var inNW = assets.filter(function (a) { return a.includeInNetWorth; }).reduce(function (s, a) { return s + assetNetBase(a); }, 0);
    var outNW = assets.filter(function (a) { return !a.includeInNetWorth; }).reduce(function (s, a) { return s + toBase(num(a.value), a.currency); }, 0);
    var total = inNW + outNW;
    var byCat = {};
    assets.forEach(function (a) { byCat[a.category] = (byCat[a.category] || 0) + dispVal(a); });
    var catSegs = Object.keys(byCat).sort(function (a, b) { return byCat[b] - byCat[a]; })
      .map(function (c) { return { label: c, value: byCat[c], color: assetCatColor(c) }; });
    var assetsHero = barHeader("Owned Asset Value", fmtBase(total, 0), catSegs, total);
    var assetRows = assets.slice().sort(function (x, y) { return toBase(num(y.value), y.currency) - toBase(num(x.value), x.currency); }).map(function (a) {
      var full = toBase(num(a.value), a.currency), linked = linkedDebtsBase(a.id), aBase = dispVal(a);
      var equityMode = a.nwMode !== "full";
      var status = !a.includeInNetWorth ? "Excluded" : (equityMode && linked > 0 ? "Equity in net worth" : "In net worth");
      var parts = [a.category, status];
      if (a.includeInNetWorth && equityMode && linked > 0) parts.push(fmtBase(full, 0) + " \u2212 " + fmtBase(linked, 0) + " loan");
      else if (a.currency !== base()) parts.push(fmt(num(a.value), a.currency));
      var actions = '<button class="btn sm ghost" data-act="edit-asset" data-id="' + a.id + '">Edit</button> <button class="btn sm ghost" data-act="del-asset" data-id="' + a.id + '">\u2715</button>';
      return { color: assetCatColor(a.category), name: esc(a.name), meta: parts.join(" \u00b7 "), valueHtml: fmtBase(aBase), base: aBase, actions: actions };
    });
    return head + assetsHero + dataBarList(assetRows, total);
  }

  // ----- Debts (liabilities) -----
  // General debts/liabilities: mortgage, auto, card, student, personal. Each subtracts from net worth
  // (netWorthAfterDebts) everywhere; balances freeze per closed month (s.debts/s.debtsTotal), auto-amortize
  // on close (closeDebtsForMonth) and log interest/full payment into Cash Flow per the debt's logMode.
  // This page manages the records, amortizes the payoff date, and surfaces equity for a linked property.
  var DEBT_TYPES = [
    { key: "mortgage", label: "Mortgage",      color: "var(--d-violet)", tag: "pension" },
    { key: "auto",     label: "Vehicle loan",  color: "var(--d-blue)",   tag: "" },
    { key: "card",     label: "Credit card",   color: "var(--d-amber)",  tag: "crypto" },
    { key: "student",  label: "Student loan",  color: "var(--d-green)",  tag: "savings" },
    { key: "personal", label: "Personal loan", color: "var(--d-cash)",   tag: "other" },
    { key: "other",    label: "Other",         color: "var(--d-teal)",   tag: "" },
  ];
  function debtType(k) { for (var i = 0; i < DEBT_TYPES.length; i++) if (DEBT_TYPES[i].key === k) return DEBT_TYPES[i]; return DEBT_TYPES[DEBT_TYPES.length - 1]; }
  function debtColor(k) { return colorOverride("debt", k) || debtType(k).color; }
  // Months to amortize a balance to zero at APR% with a fixed monthly payment (Infinity if it can't cover interest).
  function debtPayoffMonths(balance, apr, payment) {
    balance = num(balance); payment = num(payment); var r = num(apr) / 100 / 12;
    if (balance <= 0) return 0;
    if (payment <= 0) return Infinity;
    if (r <= 0) return Math.ceil(balance / payment);
    if (payment <= balance * r) return Infinity;
    return Math.ceil(-Math.log(1 - (r * balance) / payment) / Math.log(1 + r));
  }
  // Equity for a mortgage linked to a property Asset: asset value - outstanding balance (base currency).
  function debtEquity(d) {
    if (d.type !== "mortgage" || !d.propertyAssetId) return null;
    var a = (db.physicalAssets || []).filter(function (x) { return x.id === d.propertyAssetId; })[0];
    if (!a) return null;
    return { equity: toBase(num(a.value), a.currency) - toBase(num(d.balance), d.currency), propBase: toBase(num(a.value), a.currency), asset: a };
  }
  function debtModal(existing) {
    var d = existing || { name: "", type: "mortgage", balance: "", currency: base(), apr: "", payment: "", propertyAssetId: "", logMode: "interest" };
    var assetOpts = '<option value="">None</option>' + (db.physicalAssets || []).map(function (a) {
      return '<option value="' + a.id + '"' + (d.propertyAssetId === a.id ? " selected" : "") + ">" + esc(a.name) + "</option>";
    }).join("");
    openModal({
      title: existing ? "Edit Debt" : "Add Debt",
      sub: "What you owe - it lowers your net worth. The balance amortizes from the rate and monthly payment.",
      body:
        '<div class="field"><label>Name</label><input id="d-name" value="' + esc(d.name) + '" placeholder="e.g. Home Loan, Car Loan, Visa" required></div>' +
        '<div class="row"><div class="field"><label>Type</label><select id="d-type">' +
          DEBT_TYPES.map(function (t) { return '<option value="' + t.key + '"' + (d.type === t.key ? " selected" : "") + ">" + t.label + "</option>"; }).join("") + "</select></div>" +
        '<div class="field"><label>Currency</label><select id="d-cur">' + currencyOptions(d.currency) + "</select></div></div>" +
        '<div class="row"><div class="field"><label>Current balance</label><input id="d-balance" type="number" step="any" value="' + esc(d.balance) + '" placeholder="0.00" required></div>' +
        '<div class="field"><label>Interest rate (APR %)</label><input id="d-apr" type="number" step="any" value="' + esc(d.apr) + '" placeholder="0.0"></div></div>' +
        '<div class="field"><label>Monthly payment</label><input id="d-payment" type="number" step="any" value="' + esc(d.payment) + '" placeholder="0.00"></div>' +
        '<div class="field"><label>Log to Cash Flow</label><select id="d-log">' +
          '<option value="interest"' + (d.logMode === "full" ? "" : " selected") + '>Interest only</option>' +
          '<option value="full"' + (d.logMode === "full" ? " selected" : "") + '>Full payment as expense</option>' +
          '</select><div class="field-note">On month close, log interest only or the full payment as an expense.</div></div>' +
        '<div class="field"><label>Linked property <span class="muted">(mortgage equity)</span></label><select id="d-asset">' + assetOpts + "</select>" +
        '<div class="field-note">Shows property equity: asset value minus debt balance.</div></div>',
      submitLabel: existing ? "Save" : "Add Debt",
      onSubmit: function () {
        var name = val("d-name").trim(); if (!name) return false;
        var type = val("d-type");
        var obj = { id: existing ? existing.id : uid(), name: name, type: type, balance: num(val("d-balance")), currency: val("d-cur"), apr: num(val("d-apr")), payment: num(val("d-payment")), propertyAssetId: type === "mortgage" ? val("d-asset") : "", logMode: val("d-log") === "full" ? "full" : "interest", lastClose: existing ? (existing.lastClose || "") : "" };
        db.debts = db.debts || [];
        if (existing) { var i = db.debts.findIndex(function (x) { return x.id === existing.id; }); db.debts[i] = obj; }
        else db.debts.push(obj);
        save(); render(); toast("Debt saved");
      },
    });
  }
  function debtsPage() {
    var debts = db.debts || [];
    var head = pageHead("Debts", "What you owe - subtracted from your net worth.",
      '<button class="btn primary" data-act="add-debt">+ Add Debt</button>');
    if (!debts.length) {
      return head + emptyState("debt", "No debts yet", "Add a mortgage, loan or credit card to track what you owe and your true net worth.");
    }
    var totalOwed = debts.reduce(function (s, d) { return s + toBase(num(d.balance), d.currency); }, 0);
    var monthly = debts.reduce(function (s, d) { return s + toBase(num(d.payment), d.currency); }, 0);
    var homeEquity = 0;
    debts.forEach(function (d) { var e = debtEquity(d); if (e) homeEquity += e.equity; });
    var gross = grossNetWorth(), debtsNW = debtsTotalBase(), netAfter = netWorthAfterDebts();
    var debtSegs = [];
    DEBT_TYPES.forEach(function (t) {
      var sub = debts.filter(function (d) { return (d.type || "other") === t.key; }).reduce(function (s, d) { return s + toBase(num(d.balance), d.currency); }, 0);
      if (sub > 0) debtSegs.push({ label: t.label, value: sub, color: debtColor(t.key) });
    });
    var hero = barHeader("Total Owed", fmtBase(totalOwed, 0), debtSegs, totalOwed);
    // Net-worth check: gross assets - the debt that lowers net worth = net worth (reconciles by construction).
    // `debtsNW` can be less than Total Owed: a loan netted into an equity-mode asset shows under that asset.
    var nwStrip =
      '<div class="kpi-strip mb">' +
        kpiCell("Gross Assets", fmtBase(gross, 0), "Owned, before debts") +
        kpiCell("Debt in Net Worth", fmtBase(debtsNW, 0), monthly ? fmtBase(monthly, 0) + " / mo payments" : "Reduces net worth") +
        kpiCell("Net Worth", fmtBase(netAfter, 0), "After debts" + (homeEquity ? " - " + fmtBase(homeEquity, 0) + " home equity" : "")) +
      '</div>';
    var payoffYear = function (d) {
      var n = debtPayoffMonths(d.balance, d.apr, d.payment);
      if (n === 0) return "Paid";
      if (!isFinite(n)) return "-";
      var dt = new Date(); dt.setMonth(dt.getMonth() + n); return String(dt.getFullYear());
    };
    var dcStat = function (k, v) { return '<div class="dc-st"><div class="dc-k">' + k + '</div><div class="dc-v">' + v + '</div></div>'; };
    var debtCards = debts.slice().sort(function (x, y) { return toBase(num(y.balance), y.currency) - toBase(num(x.balance), x.currency); }).map(function (d) {
      var t = debtType(d.type), e = debtEquity(d), dBase = toBase(num(d.balance), d.currency), tc = debtColor(d.type);
      var pcW = totalOwed > 0 ? Math.max(0, dBase / totalOwed * 100) : 0;
      return '<div class="dcard"><span class="dcard-fill" style="width:' + pcW.toFixed(1) + '%;background:' + tc + '"></span>' +
        '<div class="dcard-top"><span class="dcard-dot" style="background:' + tc + '"></span>' +
          '<span class="dcard-nm">' + esc(d.name) + '</span>' +
          '<span class="tag ' + t.tag + '">' + esc(t.label) + (e ? " \u00b7 " + esc(e.asset.name) + (isEquityAsset(e.asset) ? " equity" : "") : "") + '</span>' +
          '<span class="dcard-bal">' + fmtBase(dBase) + '</span>' +
          '<span class="dcard-act"><button class="btn sm ghost" data-act="edit-debt" data-id="' + d.id + '">Edit</button> <button class="btn sm ghost" data-act="del-debt" data-id="' + d.id + '">\u2715</button></span>' +
        '</div>' +
        '<div class="dcard-grid">' +
          dcStat("APR", num(d.apr) ? num(d.apr).toFixed(2) + "%" : "-") +
          dcStat("Monthly", num(d.payment) ? fmtBase(toBase(num(d.payment), d.currency), 0) : "-") +
          dcStat("Payoff", payoffYear(d)) +
          dcStat("Equity", e ? fmtBase(e.equity, 0) : "-") +
        '</div></div>';
    }).join("");
    return head + hero + nwStrip + '<div class="dcards">' + debtCards + '</div>';
  }

  // ----- Tax -----
  // ----- Retirement (pension) tracker -----
  // Decoupled, multi-country localization registry. Each system-supported country pre-loads its
  // legislative rule set, string labels, caps and rates, so the calc/view layers stay abstracted
  // from raw locale data. The active entry follows the Tax Settings country (db.settings.country).
  // Figures are the current published statutory values (2025-2026 fiscal years, looked up per
  // country - see each row). sgRate = mandatory employer contribution into the relevant retirement
  // vehicle (0 where no statutory employer mandate exists; use the Extra Employer field instead).
  // Caps of 0 mean "no statutory cap" and are treated as unbounded by the calc layer.
  var RETIRE_DATA = {
    // AU 2026/27: SG 12%, concessional $32,500, non-concessional $130,000, max base $270,830, 15% fund tax (ATO).
    AU: { label: "Australia",      system: "Superannuation",       fy: "2026/27",   currency: "AUD", locale: "en-AU", employerLabel: "Employer SG",            capLabel: "Concessional Cap",        rules: { sgRate: 0.12,   concessionalCap: 32500,   nonConcessionalCap: 130000, maxContributionBase: 270830,  contributionsTaxRate: 0.15 } },
    // US 2026: 401(k) elective deferral $24,500, §415(c) total $72,000, comp limit $360,000; no employer mandate (IRS).
    US: { label: "United States",  system: "401(k)",               fy: "2026",      currency: "USD", locale: "en-US", employerLabel: "Employer Match",         capLabel: "Elective Deferral Cap",   rules: { sgRate: 0,      concessionalCap: 24500,   nonConcessionalCap: 72000,  maxContributionBase: 360000,  contributionsTaxRate: 0 } },
    // GB 2025/26: auto-enrolment employer min 3%, annual allowance £60,000, qualifying earnings upper £50,270, lump-sum allowance £268,275.
    GB: { label: "United Kingdom", system: "Workplace Pension",    fy: "2025/26",   currency: "GBP", locale: "en-GB", employerLabel: "Employer Contribution",  capLabel: "Annual Allowance",        rules: { sgRate: 0.03,   concessionalCap: 60000,   nonConcessionalCap: 268275, maxContributionBase: 50270,   contributionsTaxRate: 0 } },
    // CA 2026: CPP employer 5.95%, RRSP dollar limit $33,810 (18% of earned income up to ~$187,833), TFSA $7,000 (CRA).
    CA: { label: "Canada",         system: "RRSP",                 fy: "2026",      currency: "CAD", locale: "en-CA", employerLabel: "Employer CPP",           capLabel: "RRSP Deduction Limit",    rules: { sgRate: 0.0595, concessionalCap: 33810,   nonConcessionalCap: 7000,   maxContributionBase: 187833,  contributionsTaxRate: 0 } },
    // DE 2026: statutory pension employer half 9.3%, tax-free Betriebsrente €604/mo (€7,248/yr), BBG €101,400 (DRV).
    DE: { label: "Germany",        system: "Altersvorsorge",       fy: "2026",      currency: "EUR", locale: "de-DE", employerLabel: "Arbeitgeberanteil",      capLabel: "Steuerfreier Höchstbetrag", rules: { sgRate: 0.093, concessionalCap: 7248,    nonConcessionalCap: 3624,   maxContributionBase: 101400,  contributionsTaxRate: 0 } },
    // FR 2025: régime général employer ~8.55%, PER deduction 10% of income capped €37,094, ceiling 8×PASS €376,800.
    FR: { label: "France",         system: "Retraite (PER)",       fy: "2025",      currency: "EUR", locale: "fr-FR", employerLabel: "Cotisation employeur",   capLabel: "Plafond PER",             rules: { sgRate: 0.0855, concessionalCap: 37094,  nonConcessionalCap: 0,      maxContributionBase: 376800,  contributionsTaxRate: 0 } },
    // IT 2026: TFR set-aside 6.91%, complementary-pension deduction €5,300, INPS massimale €120,607.
    IT: { label: "Italy",          system: "Previdenza",           fy: "2026",      currency: "EUR", locale: "it-IT", employerLabel: "Contributo TFR",         capLabel: "Limite Deducibile",       rules: { sgRate: 0.0691,concessionalCap: 5300,    nonConcessionalCap: 0,      maxContributionBase: 120607,  contributionsTaxRate: 0 } },
    // ES 2025: no employer mandate into a fund; employment-plan top-up €8,500, individual €1,500, SS base €59,060.
    ES: { label: "Spain",          system: "Plan de Pensiones",    fy: "2025",      currency: "EUR", locale: "es-ES", employerLabel: "Aportación empresa",     capLabel: "Límite Anual",            rules: { sgRate: 0,      concessionalCap: 8500,    nonConcessionalCap: 1500,   maxContributionBase: 59060,   contributionsTaxRate: 0 } },
    // NL 2025/26: occupational employer ~15%, jaarruimte ~€35,798, pensioengevend salaris €137,800 (frozen).
    NL: { label: "Netherlands",    system: "Pensioen",             fy: "2025/26",   currency: "EUR", locale: "nl-NL", employerLabel: "Werkgeversbijdrage",     capLabel: "Jaarruimte",              rules: { sgRate: 0.15,   concessionalCap: 35798,   nonConcessionalCap: 0,      maxContributionBase: 137800,  contributionsTaxRate: 0 } },
    // IE 2025/26: auto-enrolment employer 1.5%, age-related relief (≈25% mid-band) on earnings cap €115,000.
    IE: { label: "Ireland",        system: "Occupational Pension", fy: "2025/26",   currency: "EUR", locale: "en-IE", employerLabel: "Employer (Auto-enrol)",  capLabel: "Age-related Limit",       rules: { sgRate: 0.015,  concessionalCap: 28750,   nonConcessionalCap: 0,      maxContributionBase: 115000,  contributionsTaxRate: 0 } },
    // NZ from 1 Apr 2026: KiwiSaver employer min 3.5% (rising to 4% in 2028); no statutory contribution cap (IRD).
    NZ: { label: "New Zealand",    system: "KiwiSaver",            fy: "2026",      currency: "NZD", locale: "en-NZ", employerLabel: "Employer Contribution",  capLabel: "Contribution",            rules: { sgRate: 0.035,  concessionalCap: 0,       nonConcessionalCap: 0,      maxContributionBase: 0,       contributionsTaxRate: 0 } },
    // SG 2026: CPF employer 17% (≤55), CPF Annual Limit $37,740, OW ceiling $8,000/mo → annual ceiling $102,000.
    SG: { label: "Singapore",      system: "CPF",                  fy: "2026",      currency: "SGD", locale: "en-SG", employerLabel: "Employer CPF",           capLabel: "CPF Annual Limit",        rules: { sgRate: 0.17,   concessionalCap: 37740,   nonConcessionalCap: 0,      maxContributionBase: 102000,  contributionsTaxRate: 0 } },
    // JP 2025/26: Employees' Pension Insurance employer half 9.15%, iDeCo employee ¥276,000/yr, std remuneration ceiling ¥620k/mo.
    JP: { label: "Japan",          system: "Pension (iDeCo)",      fy: "2025/26",   currency: "JPY", locale: "ja-JP", employerLabel: "Employer Contribution",  capLabel: "iDeCo Annual Cap",        rules: { sgRate: 0.0915, concessionalCap: 276000, nonConcessionalCap: 0,      maxContributionBase: 7440000, contributionsTaxRate: 0 } },
    // CH 2026: BVG employer ≥ half of credits (~8%), Pillar 3a max CHF 7,258 (with fund), BVG coordinated salary upper CHF 88,200.
    CH: { label: "Switzerland",    system: "Pension (3a)",         fy: "2026",      currency: "CHF", locale: "de-CH", employerLabel: "Employer (BVG)",         capLabel: "Pillar 3a Cap",           rules: { sgRate: 0.08,   concessionalCap: 7258,    nonConcessionalCap: 0,      maxContributionBase: 88200,   contributionsTaxRate: 0 } },
    // ZA 2025/26: retirement-fund deduction 27.5% of remuneration capped R350,000/yr (→ base R1,272,727); employer rate fund-specific.
    ZA: { label: "South Africa",   system: "Retirement Fund",      fy: "2025/26",   currency: "ZAR", locale: "en-ZA", employerLabel: "Employer Contribution",  capLabel: "Deduction Cap",           rules: { sgRate: 0.075,  concessionalCap: 350000,  nonConcessionalCap: 0,      maxContributionBase: 1272727, contributionsTaxRate: 0 } },
  };
  var RETIRE_REGISTRY = {};
  Object.keys(RETIRE_DATA).forEach(function (code) {
    var d = RETIRE_DATA[code];
    RETIRE_REGISTRY[code] = {
      label: d.label, system: d.system, fy: d.fy, currency: d.currency, locale: d.locale,
      employerLabel: d.employerLabel, capLabel: d.capLabel, rules: d.rules,
      money: new Intl.NumberFormat(d.locale, { style: "currency", currency: d.currency, maximumFractionDigits: 0 }),
      percent: new Intl.NumberFormat(d.locale, { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 }),
    };
  });
  // Active region follows the Tax Settings country selection (falls back to AU).
  function retireRegion() { return RETIRE_REGISTRY[db.settings.country] || RETIRE_REGISTRY.AU; }

  // Live "Current Pension Balance" = sum of every Pension account (incl. legacy/imported "Super"
  // labels, still matched for back-compat) whose currency matches the active country's NATIVE
  // currency (e.g. AU -> AUD only, ignore EUR). Re-summed on each render, so editing those balances
  // on the Accounts page flows straight in.
  function superBalanceTotal() {
    var natCur = retireRegion().currency;
    return (db.accounts || []).reduce(function (sum, a) {
      var hit = /super|superannuation|pension/i.test(String(a.bucket || "")) ||
                /super|superannuation|pension/i.test(String(a.name || ""));
      return (hit && a.currency === natCur) ? sum + num(a.balance) * ownedShare(a) : sum;
    }, 0);
  }

  // Abstracted calculation layer - pure function over the working inputs + active region rules.
  function retireCalc(input) {
    var reg = retireRegion(), R = reg.rules, RATE = 0.07; // 7% p.a. nominal projection
    var cap = R.concessionalCap > 0 ? R.concessionalCap : Infinity;       // 0 => no statutory cap
    var baseCeil = R.maxContributionBase > 0 ? R.maxContributionBase : Infinity;
    var salary = Math.max(0, num(input.salary)), balance = Math.max(0, num(input.balance));
    var employerExtra = Math.max(0, num(input.employerExtra)), voluntary = Math.max(0, num(input.voluntary));
    var sgBase = Math.min(salary, baseCeil);
    var sg = sgBase * R.sgRate;
    var concessional = sg + employerExtra + voluntary;
    var overCap = Math.max(0, concessional - cap);
    var capRoom = isFinite(cap) ? Math.max(0, cap - concessional) : Infinity;
    var taxed = Math.min(concessional, cap);
    var contributionsTax = taxed * R.contributionsTaxRate;
    var netToFund = concessional - contributionsTax;
    var capUsedPct = (isFinite(cap) && cap > 0) ? Math.min(1, concessional / cap) : 0;
    var compound = function (yrs) { var b = balance; for (var i = 0; i < yrs; i++) b = b * (1 + RATE) + netToFund; return b; };
    return {
      reg: reg, rules: R, rate: RATE, cap: cap, baseCeil: baseCeil, salary: salary, balance: balance, sgBase: sgBase, sg: sg,
      employerExtra: employerExtra, voluntary: voluntary, concessional: concessional, overCap: overCap,
      capRoom: capRoom, contributionsTax: contributionsTax, netToFund: netToFund, capUsedPct: capUsedPct,
      eoyBalance: balance + netToFund, proj10: compound(10), proj20: compound(20),
    };
  }

  // Results region only - re-rendered in place on every keystroke so input focus is preserved.
  function retireResultsHTML(c) {
    var money = function (v) { return c.reg.money.format(Math.round(v)); };
    var pct1 = function (v) { return c.reg.percent.format(v); };
    var reg = c.reg, hasCap = isFinite(c.cap);
    var capMoney = function (v, hint) { return isFinite(v) ? money(v) : (hint || "No statutory cap"); };
    var over = c.overCap > 0;
    var capColor = over ? "var(--d-rose)" : "var(--d-green)";
    var capPill = !hasCap
      ? '<span class="rt-pill" style="background:color-mix(in oklch,var(--d-teal) 16%,transparent);color:var(--d-teal)">' + icon("check") + " No statutory cap</span>"
      : over
        ? '<span class="rt-pill" style="background:color-mix(in oklch,var(--d-rose) 16%,transparent);color:var(--d-rose)">' + icon("cap") + " Over cap by " + money(c.overCap) + "</span>"
        : '<span class="rt-pill" style="background:color-mix(in oklch,var(--d-green) 16%,transparent);color:var(--d-green)">' + icon("check") + " " + money(c.capRoom) + " cap remaining</span>";
    var rtTraj = [{ x: "Now", y: c.balance }];
    var rtB = c.balance;
    for (var rtYr = 1; rtYr <= 20; rtYr++) { rtB = rtB * (1 + c.rate) + c.netToFund; rtTraj.push({ x: rtYr + "y", y: rtB }); }
    var rtFmtY = function (v) { var a = Math.abs(v); return a >= 1e6 ? (v / 1e6).toFixed(2).replace(/\.?0+$/, "") + "M" : a >= 1e3 ? Math.round(v / 1e3) + "k" : Math.round(v) + ""; };
    var rtHero =
      '<div class="hero mb">' +
        '<div class="hero-figs">' +
          '<div class="hero-label">Projected in 20 Years</div>' +
          '<div class="hero-value">' + money(c.proj20) + '</div>' +
          '<div class="sub" style="margin-top:4px">At ' + pct1(c.rate) + ' p.a. \u00b7 ' + esc(reg.label) + ' ' + esc(reg.system) + '</div>' +
          '<div class="hero-delta flat"><span>From ' + money(c.balance) + ' today</span></div>' +
          '<div class="hero-subs">' +
            '<div><div class="lbl">Current Balance</div><div class="val">' + money(c.balance) + '</div></div>' +
            '<div><div class="lbl">Net Into Fund / yr</div><div class="val">' + money(c.netToFund) + '</div></div>' +
          '</div>' +
        '</div>' +
        '<div class="hero-side">' +
          '<div class="hero-head"><span class="t">Projected Growth</span><span class="r">Now \u2192 20 yrs \u00b7 ' + esc(reg.currency) + '</span></div>' +
          lineChartSVG(rtTraj, rtFmtY) +
        '</div>' +
      '</div>';
    var rtRail =
      '<div class="kpi-strip dash-rail mb">' +
        kpiCell(reg.employerLabel + " (" + pct1(c.rules.sgRate) + ")", money(c.sg), "On " + money(c.sgBase) + " earnings") +
        kpiCell("Total Pre-tax", money(c.concessional), "Employer + extra + voluntary") +
        kpiCell("Contributions Tax (" + pct1(c.rules.contributionsTaxRate) + ")", money(c.contributionsTax), c.rules.contributionsTaxRate ? "Levied up to the cap" : "No fund-level tax") +
        kpiCell("Net Into Fund", money(c.netToFund), "After fund tax") +
      '</div>';
    var rtMs = function (label, val, fin) {
      return '<div class="rt-ms' + (fin ? " fin" : "") + '"><span class="rt-ms-dot"></span>' +
        '<div class="rt-ms-y">' + label + '</div><div class="rt-ms-v rt-metric">' + money(val) + "</div></div>";
    };
    var rtTimeline =
      '<div class="panel mb"><h2>Your Compounding Path</h2>' +
      '<p class="hint">Reinvesting ' + money(c.netToFund) + " net each year at " + pct1(c.rate) + " p.a.</p>" +
      '<div class="rt-mstone">' +
        rtMs("Now", rtTraj[0].y) + rtMs("5 yrs", rtTraj[5].y) + rtMs("10 yrs", rtTraj[10].y) +
        rtMs("15 yrs", rtTraj[15].y) + rtMs("20 yrs", rtTraj[20].y, true) +
      "</div></div>";
    return rtHero + rtRail + rtTimeline +
      '<div class="panel"><h2>' + esc(reg.capLabel) + '</h2><p class="hint">' + capMoney(c.cap, "Uncapped system") + (hasCap ? " annual cap - " : " - ") + capPill + "</p>" +
      '<div class="alloc-bar" style="height:8px;margin:4px 0 6px"><div style="width:' + (c.capUsedPct * 100).toFixed(1) + "%;background:" + capColor + '"></div></div>' +
      '<div class="rt-rows">' +
      '<div class="rt-line"><span>Used</span><strong class="rt-metric">' + money(c.concessional) + (hasCap ? " - " + pct1(c.capUsedPct) : "") + "</strong></div>" +
      '<div class="rt-line"><span>After-tax cap</span><strong class="rt-metric">' + (c.rules.nonConcessionalCap > 0 ? money(c.rules.nonConcessionalCap) : "-") + "</strong></div>" +
      '<div class="rt-line"><span>Max contribution base</span><strong class="rt-metric">' + capMoney(c.baseCeil, "No ceiling") + "</strong></div>" +
      "</div></div>";
  }

  function retirementTracker() {
    // Australians call their retirement fund "Super"; everyone else gets the universal "Pension".
    // (The page heading/badge use the region's own localized term via reg.system - e.g. AU
    // "Superannuation", US "401(k)", NZ "KiwiSaver".)
    var fundNoun = db.settings.country === "AU" ? "Super" : "Pension";
    syncRetireStateFromDb();
    retireState.balance = superBalanceTotal();   // auto-bind to live Pension accounts (native currency)
    var reg = retireRegion(), cur = reg.currency;
    var c = retireCalc(retireState);
    var badge = statusBadge(countryFlag(db.settings.country) + " " + esc(reg.label), esc(reg.system) + " - FY" + esc(reg.fy), "neutral");
    var field = function (id, key, label, hint, ro) {
      // ro = read-only display (no data-rt, so it isn't editable). Used for the auto-summed Super/Pension balance,
      // which is derived from the Accounts page - letting it be typed in only to be wiped on the next
      // render was misleading, so it's shown locked instead.
      return '<div class="field"><label>' + esc(label) + ' (' + esc(cur) + ')</label>' +
        '<input id="' + id + '"' + (ro ? '' : ' data-rt="' + key + '"') + ' type="number" min="0" step="100" inputmode="decimal" value="' + esc(String(retireState[key])) + '"' + (ro ? ' readonly aria-readonly="true" tabindex="-1"' : '') + (hint ? ' title="' + esc(hint) + '"' : '') + '></div>';
    };
    return pageHead("Retirement", "Project your " + esc(reg.system) + " against the " + esc(reg.label) + " " + esc(reg.fy) + " rules (set in Tax Settings).", "", badge) +
      '<div class="panel mb rt-inputs"><h2>Your Inputs</h2><p class="hint">Figures update live as you type. Caps and rates follow your selected Tax Settings country.</p>' +
      '<div class="grid cols-4">' +
      field("rt-salary", "salary", "Annual Salary", "Gross earnings") +
      field("rt-balance", "balance", "Current " + fundNoun + " Balance", "Auto-summed from " + cur + " " + fundNoun + " accounts - edit those on the Accounts page", true) +
      field("rt-employer", "employerExtra", "Extra Employer Contribution", "Above the mandatory rate") +
      field("rt-voluntary", "voluntary", "Voluntary Contribution", "Pre-tax / salary sacrifice") +
      "</div></div>" +
      '<div id="rt-results">' + retireResultsHTML(c) + "</div>";
  }

  // The tax object currently being VIEWED: the live db.tax, or a frozen archived year when a past
  // year is selected. All editing (Tax Settings, invoices, tax-paid) targets THIS object, so updating
  // a past tax year stays scoped to that frozen year only and never bleeds into the live year.
  function viewedTax() {
    var activeYear = db.tax.year || auFYLabel();
    var vy = state.taxYear || activeYear;
    if (vy === activeYear) return db.tax;
    return (db.taxArchive || []).filter(function (a) { return a.year === vy; })[0] || db.tax;
  }

  function taxPage() {
    var activeYear = db.tax.year || auFYLabel();
    var viewYear = state.taxYear || activeYear;
    var isActive = (viewYear === activeYear);
    var arch = isActive ? null : (db.taxArchive || []).filter(function (a) { return a.year === viewYear; })[0];
    if (!isActive && !arch) { isActive = true; viewYear = activeYear; }
    var t = isActive ? db.tax : arch;
    var c = calcTax(t);
    var owe = c.balance >= 0;

    // Taxable realized investment P/L within THIS tax year (in the tax currency) - the after-CGT-discount
    // value calcTax folds into total income, so the displayed cell and the taxed amount always agree.
    var realizedTax = c.realized;
    var cgtDisc = num(t.capitalGainsDiscount || 0), cgtMo = num(t.capitalGainsDiscountMonths || 0);
    var rplLabel = "Capital Gains" + (cgtDisc >= 1 ? " - exempt" : cgtDisc > 0 ? ((cgtMo > 0 ? " >" + cgtMo + "mo" : "") + " - " + (+(cgtDisc * 100).toFixed(0)) + "%") : "");

    function calcCell(label, value, cls) {
      return '<div class="calc-cell ' + (cls || "") + '"><div class="cl">' + label + '</div><div class="cv">' + value + "</div></div>";
    }

    // ----- year switcher + actions -----
    var archYears = (db.taxArchive || []).map(function (a) { return a.year; }).slice().reverse();
    var ySelect = '<select class="tax-year-sel" data-act="set-tax-year"><option value="' + esc(activeYear) + '"' + (isActive ? " selected" : "") + ">" + esc(activeYear) + " (Current)</option>" +
      archYears.map(function (y) { return '<option value="' + esc(y) + '"' + (!isActive && y === viewYear ? " selected" : "") + ">" + esc(y) + " (Frozen)</option>"; }).join("") + "</select>";
    // Header actions, left→right: [auto-width Year select] → [Tax Settings] → [Add Invoice].
    // The fiscal year now freezes automatically at the country's tax-year-end, so there's no button.
    // Year switcher + the same actions on every year - a frozen past year stays fully editable
    // (the edits persist only in that archived year), exactly like editing a frozen month elsewhere.
    // The viewed year's settlement control ("… still owing / Mark as paid") lives up in the page header,
    // between the eye toggle and the year selector, so it's visible without scrolling to the Settlement
    // panel. Same markup as before - just relocated. toggle-tax-paid targets the viewed year.
    var settleCtrl = (c.balance > 0)
      ? (t.paid
          // Once paid, keep the confirmation well (green, with the date) next to the "Mark unpaid" toggle.
          ? '<div class="settle-paid settle-hd on">' +
              '<span class="settle-paid-msg">Marked paid' + (t.paidAt ? " - " + esc(String(t.paidAt).slice(0, 10)) : "") + ".</span>" +
              '<button class="btn sm ghost" data-act="toggle-tax-paid">Mark unpaid</button>' +
            "</div>"
          // Unpaid: a plain header button, styled exactly like the "Tax Settings" button beside it.
          : '<button class="btn" data-act="toggle-tax-paid">' + ICON.check + " Mark taxes as paid</button>")
      : "";
    var actions =
      settleCtrl +
      '<div class="tax-actions">' +
        ySelect +
        '<button class="btn" data-act="edit-tax-config">' + ICON.gear + " Tax Settings</button>" +
        '<button class="btn" data-act="tax-report" title="Printable tax-year &amp; net-worth report">' + icon("sheet") + " Report</button>" +
        '<button class="btn primary" data-act="add-invoice">' + ICON.plus + " Add Invoice</button>" +
      "</div>";
    var badge = isActive
      ? statusBadge(esc(activeYear), "Active", "live")
      : statusBadge(esc(viewYear), ICON.lock + "Frozen", "frozen");

    // ----- invoices -----
    var invoiceTotals = invoiceTotalsForTaxYear(t);
    var yearInvoices = t.invoices.filter(function (iv) { return invoiceValueForTaxYear(iv, t) != null; });
    var invRows = yearInvoices.slice().reverse().map(function (iv) {
      var inTax = invoiceValueForTaxYear(iv, t);
      var rateBadge = (iv.currency !== t.currency && iv.fxRate)
        ? ' <span class="badge-curr" title="exchange rate on ' + esc(iv.date || "") + '">@' + num(iv.fxRate).toFixed(4) + "</span>" : "";
      return "<tr><td>" + esc(iv.date || "") + "</td><td>" + esc(iv.note || "") + "</td>" +
        '<td class="num">' + fmt(iv.amount, iv.currency) + ' <span class="badge-curr">' + esc(iv.currency) + "</span></td>" +
        '<td class="num">' + fmt(inTax, t.currency) + rateBadge + "</td>" +
        '<td class="num">' + fmt(inTax * c.effRate, t.currency) + "</td>" +
        '<td class="right nowrap"><button class="btn sm ghost" data-act="edit-invoice" data-id="' + iv.id + '">Edit</button> <button class="btn sm ghost" data-act="del-invoice" data-id="' + iv.id + '">×</button></td>' + "</tr>";
    }).join("");
    var invTable = yearInvoices.length ?
      '<div class="table-wrap inv-scroll"><table class="tax-invoice-table"><thead><tr><th>Date</th><th>Note</th><th class="num">Amount</th><th class="num">In ' + esc(t.currency) +
      '</th><th class="num">Set aside ≈' + pct(c.effRate) + '</th><th></th></tr></thead><tbody>' + invRows + "</tbody>" +
      '<tfoot><tr><td colspan="2">Total freelance</td><td class="num">' + fmt(invoiceTotals.primary, invoiceTotals.primaryCurrency) +
      '</td><td class="num">' + fmt(invoiceTotals.tax, t.currency) +
      '</td><td class="num">' + fmt(invoiceTotals.tax * c.effRate, t.currency) + "</td><td></td></tr></tfoot></table></div>" :
      // Empty state still occupies the fixed 5-row height so the card never shrinks.
      '<div class="table-wrap inv-scroll inv-empty"><div class="muted">No invoices ' + (isActive ? "yet. Add each one as you send it." : "for " + esc(viewYear) + ".") + "</div></div>";

    // ----- bracket squares -----
    var bracketCards = '<div class="bk-card"><div class="bk-rate">0%</div><div class="bk-range">0 to ' + fmt(t.taxFreeThreshold, t.currency, 0) + "</div></div>";
    t.brackets.forEach(function (b, i) {
      var lo = i === 0 ? num(t.taxFreeThreshold) : num(t.brackets[i - 1].upTo);
      var hi = b.upTo == null ? "∞" : fmt(b.upTo, t.currency, 0);
      var active = c.marginalRate === num(b.rate) && c.taxableIncome > lo;
      bracketCards += '<div class="bk-card' + (active ? " active" : "") + '"><div class="bk-rate">' + pct(b.rate) +
        '</div><div class="bk-range">' + fmt(lo, t.currency, 0) + " to " + hi + "</div>" + (active ? '<div class="bk-you">YOU</div>' : "") + "</div>";
    });

    // ----- calculation (horizontal, grouped) -----
    var adjCells = c.adjItems.map(function (a) {
      return calcCell(esc(a.name) + (a.mode === "percent" ? " (" + a.value + "% of tax)" : a.mode === "percentincome" ? " (" + a.value + "% of income)" : ""), (a.amount >= 0 ? "+" : "−") + fmt(Math.abs(a.amount), t.currency));
    }).join("");
    var calcPanel =
      '<div class="calc-panel tax-calc-panel"><h2>Calculation</h2><p class="hint">How the ' + esc(t.currency) + " year estimate is built.</p>" +
      // Group 1: incomes - Capital Gains → Interests → Other income, then the Total.
      '<div class="calc-group"><div class="calc-group-title">Incomes</div><div class="calc-strip">' +
      calcCell("Employment", fmt(c.employment, t.currency)) + calcCell("Freelance", fmt(c.freelance, t.currency)) +
      calcCell(rplLabel, signFmt(realizedTax, t.currency), "rpl") +
      (c.capitalLossCarryOut > 0 ? calcCell("Capital losses carried forward", fmt(c.capitalLossCarryOut, t.currency)) : "") +
      calcCell("Interests", fmt(c.interests, t.currency)) +
      calcCell("Dividends", fmt(c.dividends, t.currency)) +
      calcCell("Other income", fmt(c.other, t.currency)) +
      calcCell("Total income", fmt(c.totalIncome, t.currency), "total up") + "</div></div>" +
      // Group 2: taxes
      '<div class="calc-group"><div class="calc-group-title">Taxes</div><div class="calc-strip">' +
      (num(t.deductions) ? calcCell("Deductions", "−" + fmt(c.deductions, t.currency)) + calcCell("Taxable income", fmt(c.taxableIncome, t.currency)) : "") +
      calcCell("Income tax", fmt(c.incomeTax, t.currency)) +
      calcCell(esc(t.levyLabel || "Levy") + " (" + pct(t.levyRate) + ")", fmt(c.levy, t.currency)) +
      adjCells +
      calcCell("Estimated tax", fmt(c.estimated, t.currency), "total down") + "</div></div>" +
      // Group 3: settlement - tax already paid + balance, as a titled well like Incomes / Taxes
      '<div class="calc-group settlement"><div class="calc-group-title">Settlement</div><div class="calc-strip settle-strip">' +
      calcCell("Tax already paid", "−" + fmt(t.employmentTaxPaid, t.currency)) +
      calcCell(owe ? "Balance to pay" : "Estimated refund", fmt(Math.abs(c.balance), t.currency), "total " + (owe ? "down" : "up")) + "</div>" +
      // The Mark-as-paid toggle now lives in the page header (see settleCtrl) so it's visible without
      // scrolling; the Settlement group keeps the numeric Balance-to-pay cell above.
      "</div>";

    var takeHome = c.totalIncome - c.estimated;
    var effOverall = c.totalIncome ? c.estimated / c.totalIncome : 0;
    var taxSegs = [
      { label: "Estimated Tax", value: Math.max(0, c.estimated), color: "var(--neg)" },
      { label: "Take Home", value: Math.max(0, takeHome), color: "var(--pos)" }
    ];
    var taxLegendHTML = '<div class="tax-split-legend">' + taxSegs.map(function (s) {
      var p = c.totalIncome ? s.value / c.totalIncome : 0;
      return '<div class="tax-split-row"><span class="dot" style="background:' + s.color + '"></span><span class="tax-split-name">' + esc(s.label) + '</span><span class="tax-split-value">' + fmt(s.value, t.currency, 0) + '</span><span class="tax-split-pct">' + pct(p) + '</span></div>';
    }).join("") + '</div>';
    var taxCountry = t.country || db.settings.country;
    var ctryLabel = countryName(taxCountry);
    var taxContext = (ctryLabel ? countryFlag(taxCountry) + " " + esc(ctryLabel) + " - " : "") + esc(viewYear);
    var taxOverview =
      '<div class="cf-card tax-position-panel">' +
        '<div class="cf-card-head tax-position-top"><div><div class="cf-label tax-position-title">Tax Position</div><div class="tax-position-sub">' + taxContext + '</div></div></div>' +
        '<div class="tax-position-body">' +
          '<div class="tax-position-main">' +
            '<div class="cf-label">' + (owe ? "Balance to Pay" : "Estimated Refund") + '</div>' +
            '<div class="tax-position-value ' + (owe ? "down" : "up") + '">' + fmt(Math.abs(c.balance), t.currency, 0) + '</div>' +
            '<div class="tax-position-note">' + (owe ? "Due at tax time" : "Back to you") + ' - ' + pct(effOverall) + ' effective rate</div>' +
          '</div>' +
          '<div class="tax-position-side">' +
            '<div class="hero-head tax-position-head"><span class="t">Where Income Goes</span><span class="r">' + esc(t.currency) + '</span></div>' +
            stackBar(taxSegs, c.totalIncome) +
            taxLegendHTML +
          '</div>' +
          '<div class="tax-position-metrics">' +
            '<div><span>Total Income</span><strong>' + fmt(c.totalIncome, t.currency, 0) + '</strong></div>' +
            '<div><span>Estimated Tax</span><strong class="down">' + fmt(c.estimated, t.currency, 0) + '</strong></div>' +
            '<div><span>Tax Paid</span><strong>' + fmt(t.employmentTaxPaid, t.currency, 0) + '</strong></div>' +
            '<div><span>Freelance Set Aside</span><strong>' + fmt(c.freelanceSetAside, t.currency, 0) + '</strong></div>' +
          '</div>' +
        '</div>' +
      '</div>';
    // After an automatic tax-year rollover the live year starts blank (last year is archived). Reassure the
    // user nothing was lost and nudge them to enter the new year's income - only while it's still untouched.
    var freshRollover = isActive && (db.taxArchive || []).length > 0 &&
      num(db.tax.employmentIncome) === 0 && num(db.tax.employmentTaxPaid) === 0 && !(db.tax.invoices || []).length;
    var prevYear = archYears[0] || "";
    var rolloverHint = (freshRollover && !state.dismiss_taxRollover) ?
      '<div class="backup-banner"><div class="bb-msg">' + icon("tax") +
        '<span><strong>' + esc(activeYear) + ' tax year has started.</strong> Enter this year’s income in Tax Settings to see your estimate - last year' +
        (prevYear ? " (" + esc(prevYear) + ")" : "") + ' is saved and still selectable in the Year dropdown above.</span></div>' +
        '<button class="btn sm primary" data-act="edit-tax-config">Open Tax Settings</button>' +
        '<button class="bb-x" data-act="dismiss-banner" data-key="taxRollover" title="Dismiss" aria-label="Dismiss">' + icon("close") + '</button></div>' : "";
    // Any FINISHED (archived) tax year that's unpaid and still owes tax keeps counting in the dashboard
    // "Total Current Taxes" until it's marked paid - so a just-ended year isn't silently carried. This
    // reminder is deliberately NOT gated on freshRollover: it must persist even after the user starts
    // entering the new year's income (unlike the reassurance banner above, which is only for the blank year).
    // Only shown on the active year, with a top-of-page "Mark paid" that targets the OWING year specifically.
    var unpaidPrior = (db.taxArchive || []).filter(function (a) { return a && !a.paid && calcTax(a).balance > 0; });
    var owingBanner = "";
    if (isActive && unpaidPrior.length && !state.dismiss_taxOwing) {
      var oweRec = unpaidPrior[unpaidPrior.length - 1];   // most recently archived owing year (the just-ended one)
      var oweBal = calcTax(oweRec).balance;
      var moreYears = unpaidPrior.length - 1;
      owingBanner =
        '<div class="backup-banner"><div class="bb-msg">' + icon("tax") +
          '<span><strong>' + esc(oweRec.year) + ' tax isn’t marked paid.</strong> You still owe ' +
          fmt(oweBal, oweRec.currency, 0) + ' for ' + esc(oweRec.year) +
          ' - it keeps counting in your dashboard <strong>Total Current Taxes</strong> until you mark it paid' +
          (moreYears ? ' (and ' + moreYears + ' earlier year' + (moreYears > 1 ? 's' : '') + ' too - pick them in the Year dropdown)' : '') +
          '. Already settled it? Mark it paid to drop it from the total.</span></div>' +
          '<button class="btn sm primary" data-act="mark-tax-paid" data-year="' + esc(oweRec.year) + '">Mark ' + esc(oweRec.year) + ' paid</button>' +
          '<button class="bb-x" data-act="dismiss-banner" data-key="taxOwing" title="Dismiss for now" aria-label="Dismiss">' + icon("close") + '</button></div>';
    }
    return pageHead("Tax Estimator", "Income tax from invoices and employment, against your own brackets." +
      (ctryLabel ? " - " + countryFlag(taxCountry) + " " + esc(ctryLabel) : ""), actions, badge) +
      (owingBanner || rolloverHint ? '<div class="tax-banners">' + owingBanner + rolloverHint + '</div>' : "") +
      taxOverview +

      // Share the SAME 4-column grid as the summary above: Brackets sits in column 1 (exactly under /
      // as wide as "Total Income"); Invoices spans columns 2-4 (its left edge lines up under the
      // "Estimated Tax (Year)" card). Both cards carry the same fixed 5-row height.
      '<div class="grid cols-4 mb tax-row">' +
      '<div class="panel tax-brackets-card tax-work-card" style="margin:0"><h2>Tax Brackets (' + esc(t.currency) + ')</h2><p class="hint">Tax-free up to ' +
      fmt(t.taxFreeThreshold, t.currency, 0) + ". Your marginal bracket is highlighted.</p><div class=\"bk-grid bk-scroll\">" + bracketCards + "</div></div>" +
      '<div class="panel tax-invoices-card tax-work-card" style="margin:0"><h2>Invoices (Freelance)</h2><p class="hint">Converted to ' + esc(t.currency) + " at the rate on each invoice's date.</p>" + invTable + "</div>" +
      "</div>" +
      calcPanel;
  }
  // Official tax-year END date per country (month is 1-based). AU/NZ/GB run a non-calendar fiscal
  // year; everyone else is treated as a calendar year ending Dec 31.
  function countryFYEnd(code, year) {
    var febEnd = new Date(Date.UTC(year || new Date().getFullYear(), 2, 0)).getUTCDate();
    var FY = { AU: { m: 6, d: 30 }, NZ: { m: 3, d: 31 }, GB: { m: 4, d: 5 }, ZA: { m: 2, d: febEnd } };
    return FY[code] || { m: 12, d: 31 };
  }
  // The FY label ("YYYY/YY") that should be ACTIVE today for the selected country, flipping exactly on
  // that country's tax-year-end date (e.g. AU → 1 July, the day after 30 June). Kept in the app's
  // canonical Jul/26-style "YYYY/YY" format so it lines up with stored db.tax.year labels.
  function expectedFYLabel(d) {
    d = d || new Date();
    var fe = countryFYEnd(db.settings.country, d.getFullYear()), mo = d.getMonth() + 1, day = d.getDate();
    var past = (mo > fe.m) || (mo === fe.m && day > fe.d);   // strictly AFTER the FY-end date → new FY (the end date itself is still the old year)
    var start = past ? d.getFullYear() : d.getFullYear() - 1;
    return start + "/" + String((start + 1) % 100).padStart(2, "0");
  }
  function fyStartYear(label) { var m = /^(\d{4})/.exec(String(label || "")); return m ? +m[1] : 0; }
  // Behind-the-scenes fiscal-year freeze: when today's date has crossed the country's official
  // tax-year-end, archive the active year and roll forward (catching up multiple boundaries) using the
  // same freeze execution as the old manual button - no UI, no prompt.
  function maybeAutoFreezeTaxYear() {
    if (!db.tax) return false;
    if (!db.tax.year) { db.tax.year = expectedFYLabel(); return false; }
    var expected = expectedFYLabel(), cur = db.tax, did = false, guard = 0, archivedRealYear = false, skippedEmptyYears = 0;
    while (cur.year !== expected && fyStartYear(cur.year) < fyStartYear(expected) && guard++ < 12) {
      db.taxArchive = db.taxArchive || [];
      if (!archivedRealYear) {
        cur.sourceSnapshot = captureTaxSources(cur, "year-rollover");
        cur.capitalLossCarryOut = calcTax(cur).capitalLossCarryOut;
        db.taxArchive.push(JSON.parse(JSON.stringify(cur)));   // archive the real active year once
        archivedRealYear = true;
      } else {
        skippedEmptyYears++;
      }
      cur.year = nextFYLabel(cur.year);
      cur.invoices = [];
      cur.employmentIncome = 0; cur.employmentTaxPaid = 0; cur.otherIncome = 0;
      cur.capitalLossCarryIn = num(cur.capitalLossCarryOut); cur.capitalLossCarryOut = num(cur.capitalLossCarryIn);
      cur.sourceSnapshot = null;
      cur.paid = false; cur.paidAt = null;   // the new live year starts unsettled (the archived copy keeps its own paid status)
      did = true;
    }
    if (did) {
      if (skippedEmptyYears) {
        db.meta = db.meta || {};
        db.meta.lastTaxRolloverSkippedEmptyYears = { at: new Date().toISOString(), count: skippedEmptyYears, activeYear: cur.year };
      }
      save();
      // If a just-archived year still owes tax (and isn't marked paid), nudge the user once - it keeps
      // counting in the dashboard total until settled. Defer past the current boot chain with setTimeout
      // so openModal mounts onto the rendered page (this runs before the first render() at boot).
      var owing = (db.taxArchive || []).filter(function (a) { return a && !a.paid && calcTax(a).balance > 0; });
      if (owing.length) setTimeout(function () { taxRolloverPaidNudge(owing[owing.length - 1], owing.length); }, 0);
      else toast("Auto-froze tax year, now tracking " + cur.year);
    }
    return did;
  }
  // One-time popup fired the moment a tax year auto-freezes with an unpaid balance still owing. The
  // persistent top-of-page owing banner is the durable reminder; this is just the nudge. Its primary
  // action settles that specific year; "Cancel" leaves it (they can mark it paid later from the Tax page).
  function taxRolloverPaidNudge(rec, count) {
    if (!rec) return;
    var bal = calcTax(rec).balance;
    var extra = (count || 1) - 1;
    openModal({
      title: "Don’t forget last year’s tax",
      sub: "The " + esc(rec.year) + " tax year has closed and been archived - this year now starts fresh.",
      body:
        '<p style="margin:0 0 10px">You still owe <strong>' + fmt(bal, rec.currency, 0) + '</strong> for <strong>' + esc(rec.year) +
        '</strong>. Until it’s marked paid it keeps counting in your dashboard <strong>Total Current Taxes</strong>' +
        (extra ? ' (along with ' + extra + ' earlier unpaid year' + (extra > 1 ? 's' : '') + ')' : '') + '.</p>' +
        '<p class="hint" style="margin:0">Already settled it? Mark it paid to drop it from the total. Not yet? Leave it - you can mark it paid any time from the Tax page.</p>',
      submitLabel: "Mark " + rec.year + " paid",
      onSubmit: function () {
        var r = (db.taxArchive || []).filter(function (a) { return a.year === rec.year; })[0];
        if (r) { r.paid = true; r.paidAt = new Date().toISOString(); save(); render(); toast("Marked " + esc(rec.year) + " tax as paid"); }
      },
    });
  }

  // ----- Settings -----
  // ----- Settings -> Colors: per-entity swatch picker (writes db.settings.colors[domain][key]) -----
  function colorRow(domain, key, label, resolved, ov) {
    var swatches = SWATCHES.map(function (sw) {
      var on = ov === sw;
      return '<button type="button" class="swatch' + (on ? " on" : "") + '" data-act="set-color" data-domain="' + domain +
        '" data-key="' + esc(key) + '" data-color="' + sw + '" style="background:' + sw + '" title="' + esc(label) + '"' + (on ? ' aria-current="true"' : "") + "></button>";
    }).join("");
    var auto = '<button type="button" class="swatch-auto" data-act="auto-color" data-domain="' + domain +
      '" data-key="' + esc(key) + '" data-current="' + esc(ov || resolved) + '" title="Pick a random color">Auto</button>';
    return '<div class="color-row"><span class="color-name"><span class="color-dot" style="background:' + resolved + '"></span>' +
      esc(label) + '</span><div class="color-swatches">' + auto + swatches + "</div></div>";
  }
  function colorGroup(title, hint, domain, items, resolve) {
    // Rows are wrapped as a named group so the color picker layout does not depend on child position.
    return '<div class="panel mb"><div class="flex between center"><h2>' + esc(title) + '</h2>' +
      '<button class="btn sm ghost" data-act="reset-colors" data-domain="' + domain + '">Reset</button></div>' +
      (hint ? '<p class="hint">' + esc(hint) + "</p>" : "") +
      '<div class="color-rows">' +
      items.map(function (it) { return colorRow(domain, it.key, it.label, resolve(it.key), colorOverride(domain, it.key)); }).join("") +
      "</div></div>";
  }
  function uniqueCategoryItems(list, records) {
    var seen = {}, out = [];
    function add(c) {
      c = String(c || "").trim();
      if (!c || seen[c]) return;
      seen[c] = true; out.push({ key: c, label: c });
    }
    (list || []).forEach(add);
    (records || []).forEach(function (r) { add(r && r.category); });
    return out;
  }
  function cashFlowColorGroup() {
    var expItems = uniqueCategoryItems(db.expenseCategories, db.expenses);
    var incItems = uniqueCategoryItems(db.incomeCategories, db.incomes);
    var rows = function (domain, items, resolve) {
      return items.length ? items.map(function (it) { return colorRow(domain, it.key, it.label, resolve(it.key), colorOverride(domain, it.key)); }).join("") : '<p class="hint">No categories yet.</p>';
    };
    return '<div class="panel mb cashflow-color-card"><div class="flex between center"><h2>Cash Flow Categories</h2>' +
      '<button class="btn sm ghost" data-act="reset-colors" data-domain="cashflow">Reset</button></div>' +
      '<p class="hint">Shown in Cash Flow and History category charts.</p>' +
      '<div class="cashflow-color-stack">' +
        '<div class="subcard"><div class="section-title">Expense categories</div><div class="color-rows">' + rows("expense", expItems, expenseColor) + '</div></div>' +
        '<div class="subcard"><div class="section-title">Income categories</div><div class="color-rows">' + rows("income", incItems, incomeColor) + '</div></div>' +
      '</div></div>';
  }
  function colorSettings() {
    var map = function (arr, kf, lf) { return arr.map(function (x) { return { key: kf(x), label: lf(x) }; }); };
    var ident = function (x) { return x; };
    return '<p class="hint colors-intro">Pick a color for account buckets, investment types, cash-flow categories, assets and debts. Your choice shows everywhere that item appears - Dashboard allocation, Portfolio Mix, Cash Flow, History, badges and charts. Use <strong>Auto</strong> to pick a random color for a row; use <strong>Reset</strong> to return a section to its built-in defaults.</p>' +
      colorGroup("Account buckets", "Shown in Dashboard Allocation and on the Accounts page.", "bucket",
        Object.keys(BUCKET_COLOR).map(function (b) { return { key: b, label: b }; }), bucketColor) +
      colorGroup("Investment types", "Holding badges and names on the Investments page.", "holdingType",
        map(db.holdingTypes || [], function (t) { return t.key; }, function (t) { return t.label; }), function (k) { return typeMeta(k).color; }) +
      cashFlowColorGroup() +
      colorGroup("Asset categories", "Physical / non-liquid assets on the Assets page.", "asset",
        map(ASSET_CATEGORIES, ident, ident), assetCatColor) +
      colorGroup("Debt types", "Mortgage, loans and cards on the Debts page.", "debt",
        map(DEBT_TYPES, function (t) { return t.key; }, function (t) { return t.label; }), debtColor);
  }
  function themeControls() {
    var t = themeMode();
    var btn = function (mode, label, sub) {
      return '<button type="button" class="seg-btn theme-btn' + (t === mode ? " active" : "") +
        '" data-act="set-theme" data-theme="' + mode + '">' +
        '<span>' + esc(label) + '</span><span class="seg-sub">' + esc(sub) + '</span></button>';
    };
    return '<div class="seg theme-choice">' +
      btn("dark", "Dark", "Low-glare graphite interface.") +
      btn("dim", "Dim", "Muted light workspace with less glare.") +
      btn("light", "Light", "Bright workspace for daytime use.") +
      "</div>";
  }
  function languageControls() {
    var lang = languageMode();
    var btn = function (code, label, sub) {
      return '<button type="button" class="seg-btn language-btn' + (lang === code ? " active" : "") +
        '" data-act="set-language" data-lang="' + code + '">' +
        '<span>' + esc(label) + '</span><span class="seg-sub">' + esc(sub) + '</span></button>';
    };
    return '<div class="seg language-choice">' +
      btn("en", "English", "English interface.") +
      btn("it", "Italiano", "Italian interface.") +
      "</div>";
  }
  function settingsPage() {
    return pageHead("Settings", "Manage your wallet, data, providers and preferences.") + configSections(false);
  }

  function configSections(isWizard, wizardStep) {
    var s = db.settings;
    // profile
    var profile =
      '<div class="panel mb"><h2>Profile</h2><p class="hint">Names and your base (reporting) currency.</p>' +
      '<form id="profile-form"><div class="row"><div class="field"><label>Wallet name</label><input id="set-name" value="' + esc(s.name) + '"></div>' +
      '<div class="field"><label>Base currency</label><select id="set-base"><option value="" disabled' + (s.baseCurrency ? "" : " selected") + '>Select primary currency</option>' + presetCurrencyOptions(s.baseCurrency) +
      '<option value="__add__">+ Add a currency</option></select></div>' +
      '<div class="field"><label>Secondary display</label><select id="set-sec"><option value=""' + (s.secondaryCurrency ? "" : " selected") + ">(None)</option>" +
      presetCurrencyOptions(s.secondaryCurrency) +
      '<option value="__add__">+ Add a currency</option></select></div></div>' +
      (isWizard ? "" : '<button class="btn primary" type="submit">Save Profile</button>') + '</form></div>';

    var appearance =
      '<div class="panel mb"><h2>Appearance</h2><p class="hint">Choose how Valutio looks on this device.</p>' +
      '<div class="subcard mb"><div class="section-title">Interface language</div>' + languageControls() + "</div>" +
      '<div class="subcard"><div class="section-title">Theme</div>' + themeControls() + "</div>" +
      "</div>";

    // currencies
    var curRows = db.currencies.map(function (c) {
      return "<tr><td><strong>" + esc(c.code) + "</strong></td><td>" + esc(c.symbol) + "</td>" +
        '<td class="num">' + (c.code === base() ? "1.0000 (base)" : num(c.rate).toFixed(4)) + "</td>" +
        '<td class="right">' + (c.code === base() ? "" :
          '<button class="btn sm ghost" data-act="edit-currency" data-id="' + c.code + '">Edit</button>' +
          '<button class="btn sm ghost" data-act="del-currency" data-id="' + c.code + '">×</button>') + "</td></tr>";
    }).join("");
    var currencies =
      '<div class="panel mb"><div class="flex between center mb"><div><h2>Currencies & FX</h2><p class="hint">Choose from the full currency catalog. This table only shows currencies currently used by your wallet.</p></div>' +
      '<div class="flex gap"><button class="btn" data-act="refresh-prices">' + ICON.refresh + " Auto-update FX</button>" +
      '<button class="btn primary" data-act="add-currency">+ Currency</button></div></div>' +
      '<div class="table-wrap"><table class="fx-table"><thead><tr><th>Code</th><th>Symbol</th><th class="num">Rate → ' + esc(base()) +
      "</th><th></th></tr></thead><tbody>" + curRows + "</tbody></table></div></div>";

    // categories
    var catChips = function (list, kind) {
      var dot = kind === "expense" ? "var(--d-rose)" : "var(--d-green)";
      // Chips live in a height-capped, clipped box (max ~10 rows) so a narrow window can't stretch the
      // card endlessly - extra rows are sliced off (like the dashboard allocation). The "+ Add" button
      // sits OUTSIDE the box so it stays reachable even when the chips clip.
      return '<div class="cat-chips">' + list.map(function (c) {
        return '<span class="chip"><span class="chip-dot" style="background:' + dot + '"></span>' + esc(c) + '<span class="x" data-act="del-category" data-kind="' + kind + '" data-id="' + esc(c) + '">×</span></span>';
      }).join("") + "</div>" +
        '<button class="btn sm" data-act="add-category" data-kind="' + kind + '">+ Add</button>';
    };
    // single master Categories card; Expense and Income live in two distinct nested sub-cards
    var categories =
      '<div class="panel mb"><h2>Categories</h2><p class="hint">Used in Expenses and Income.</p>' +
      '<div class="grid cols-2">' +
      '<div class="subcard"><div class="section-title">Expense categories</div><div>' + catChips(db.expenseCategories, "expense") + "</div></div>" +
      '<div class="subcard"><div class="section-title">Income categories</div><div>' + catChips(db.incomeCategories, "income") + "</div></div>" +
      "</div></div>";

    // country / region (preloads tax brackets) - shown in the setup wizard
    var country =
      '<div class="panel mb country-panel"><h2>Country / Region</h2><p class="hint">Choose your country to preload tax brackets and settings.</p>' +
      '<div class="field country-field" style="max-width:360px"><label>Country</label><select data-act="set-country">' + countryOptions(s.country) + "</select>" +
      '<p class="hint" style="margin-top:8px">This assists with configuring your localized tax brackets and criteria (you can modify or fine-tune this later in the app settings).</p>' +
      "</div></div>";

    // accounts + holdings quick managers (handy during setup)
    var accountsMini =
      '<div class="panel mb"><div class="flex between center mb"><h2>Accounts</h2>' +
      '<button class="btn primary" data-act="add-account">+ Add Account</button></div>' +
      (db.accounts.length ? db.accounts.map(function (a) {
        return '<span class="chip">' + esc(a.name) + " - " + esc(a.bucket) + " - " + fmt(a.balance, a.currency) +
          '<span class="x" data-act="del-account" data-id="' + a.id + '">×</span></span>';
      }).join("") : '<div class="muted">No accounts yet.</div>') + "</div>";
    var holdingsMini =
      '<div class="panel mb"><div class="flex between center mb"><h2>Holdings</h2>' +
      '<button class="btn primary" data-act="add-holding">+ Add Holding</button></div>' +
      (db.holdings.length ? sortHoldingsByTypeMv(db.holdings, function (h) { return holdingMetrics(h).marketValueBase; }).map(function (h) {
        return '<span class="chip">' + esc(h.name) + " - " + esc(typeMeta(h.type).label) +
          '<span class="x" data-act="del-holding" data-id="' + h.id + '">×</span></span>';
      }).join("") : '<div class="muted">No holdings yet.</div>') + "</div>";

    // market data (keyless live prices)
    var prov = s.stockProvider || "yahoo";
    var provList = [["yahoo", "Yahoo Finance - Automatic (No key)"], ["alphavantage", "Alpha Vantage"], ["twelvedata", "Twelve Data"], ["finnhub", "Finnhub"]];
    var provOpts = provList.map(function (p) { return '<option value="' + p[0] + '"' + (prov === p[0] ? " selected" : "") + ">" + esc(p[1]) + "</option>"; }).join("");
    var cprov = s.cryptoProvider || "coingecko";
    var cprovList = [["coingecko", "CoinGecko - Automatic (No key)"], ["binance", "Binance (No key)"], ["coinmarketcap", "CoinMarketCap"], ["cryptocompare", "CryptoCompare"]];
    var cprovOpts = cprovList.map(function (p) { return '<option value="' + p[0] + '"' + (cprov === p[0] ? " selected" : "") + ">" + esc(p[1]) + "</option>"; }).join("");
    var cryptoKeyless = (cprov === "coingecko" || cprov === "binance");
    var marketData =
      '<div class="panel mb"><h2>Stock Price Provider</h2>' +
      '<p class="hint mb">By default, Stock, ETF, Bond &amp; Commodity prices update automatically via Yahoo Finance - no key required. Prefer your own data source? Choose a provider and paste its API key.</p>' +
      '<form id="provider-form"><div class="row" style="align-items:flex-end">' +
      '<div class="field" style="flex:1"><label>Provider</label><select id="set-provider">' + provOpts + '</select></div>' +
      '<div class="field" id="apikey-field" style="flex:1.6;' + (prov === "yahoo" ? "display:none" : "") + '"><label>API Key</label><input id="set-apikey" type="text" value="' + esc(s.stockApiKey || "") + '" placeholder="Paste your API key"></div>' +
      '</div>' +
      '<button class="btn primary" type="submit">Save Provider</button></form>' +
      '<p class="hint" style="margin:12px 0 0">Get a free key: <a href="https://finnhub.io/" target="_blank" rel="noopener">Finnhub</a>, <a href="https://twelvedata.com/" target="_blank" rel="noopener">Twelve Data</a> or <a href="https://www.alphavantage.co/" target="_blank" rel="noopener">Alpha Vantage</a>.</p></div>' +
      '<div class="panel mb"><h2>Crypto Price Provider</h2>' +
      '<p class="hint mb">Crypto prices update automatically via CoinGecko - no key required. Prefer another source? Choose a provider and paste its API key.</p>' +
      '<form id="crypto-provider-form"><div class="row" style="align-items:flex-end">' +
      '<div class="field" style="flex:1"><label>Provider</label><select id="set-crypto-provider">' + cprovOpts + '</select></div>' +
      '<div class="field" id="crypto-apikey-field" style="flex:1.6;' + (cryptoKeyless ? "display:none" : "") + '"><label>API Key</label><input id="set-crypto-apikey" type="text" value="' + esc(s.cryptoApiKey || "") + '" placeholder="Paste your API key"></div>' +
      '</div>' +
      '<button class="btn primary" type="submit">Save Provider</button></form>' +
      '<p class="hint" style="margin:12px 0 0">Get a free key: <a href="https://coinmarketcap.com/api/" target="_blank" rel="noopener">CoinMarketCap</a> or <a href="https://www.cryptocompare.com/cryptopian/api-keys" target="_blank" rel="noopener">CryptoCompare</a>.</p></div>' +
      '<div class="panel mb"><h2>Investment Benchmark</h2>' +
      '<p class="hint mb">The index your portfolio is compared against on the Investments page - a &ldquo;same contributions into this index&rdquo; line on the value chart, plus a Time-Weighted Return. Use a Yahoo Finance symbol, e.g. <strong>ACWI</strong> (all-world), <strong>SPY</strong> (S&amp;P&nbsp;500), <strong>URTH</strong> (MSCI World), or <strong>EUNL.DE</strong> (world, priced in EUR).</p>' +
      '<form id="benchmark-form"><div class="row" style="align-items:flex-end">' +
      '<div class="field" style="flex:1;max-width:260px"><label>Benchmark symbol</label><input id="set-benchmark" type="text" value="' + esc(s.benchmark || "") + '" placeholder="' + BENCHMARK_DEFAULT + ' (default)"></div>' +
      '</div>' +
      '<button class="btn primary" type="submit">Save Benchmark</button></form>' +
      '<p class="hint" style="margin:12px 0 0">Leave blank to use the default (' + BENCHMARK_DEFAULT + '). The comparison uses the index&rsquo;s own-currency return; hit <strong>Refresh Rates</strong> after changing it to pull its history.</p></div>';

    // Monthly snapshots are now fully automatic (frozen behind the scenes at each month boundary),
    // so the manual/automatic toggle is gone - nothing to render here.
    var snapshot = "";

    // install as a desktop app
    var standalone = window.matchMedia && window.matchMedia("(display-mode: standalone)").matches;
    var pwaInstalled = standalone || localStorage.getItem("pwaInstalled") === "true";
    var install = pwaInstalled
      // installed (standalone window or captured appinstalled flag): hide all install/address rows
      ? '<div class="panel mb"><h2>Install as a Desktop App</h2>' +
        '<div class="help-box" style="margin:18px 0 0">The App is already installed.</div></div>'
      : '<div class="panel mb"><h2>Install as a Desktop App</h2>' +
        '<p class="hint">Get a Valutio icon and its own window. Works fully offline; all data stays on this PC.</p>' +
        (deferredInstall
          ? '<button class="btn primary" data-act="install-app">' + icon("arrowDown") + ' Install Valutio</button>'
          : '<div class="help-box" style="margin:0">Your browser didn’t offer a one-click install here. In <strong>Chrome</strong> or <strong>Edge</strong>, click the <strong>install icon</strong> in the address bar (or menu → <em>Install Valutio…</em> / <em>Apps → Install this site as an app</em>). On <strong>iPhone/iPad Safari</strong>, tap <strong>Share → Add to Home Screen</strong>.</div>') +
        "</div>";

    // onboarding / help
    var helpTop =
      '<div class="panel mb" id="help-onboarding"><h2>Help &amp; Onboarding</h2><p class="hint mb">New here, or want a refresher on the month-end workflow?</p>' +
      '<div class="flex gap wrap"><button class="btn" data-act="replay-tutorial">' + icon("help") + ' Replay Tutorial</button>' +
      '<button class="btn" data-act="preview-wizard">' + icon("wallet") + ' Preview Setup Screen</button></div></div>';
    // FAQ - how the app works + what it intentionally can't do. cat slugs match the filter chips.
    var faqCats = [
      ["plans", "Free & open source"], ["start", "Getting started"], ["data", "Data & privacy"], ["snap", "Snapshots & history"],
      ["prices", "Prices & currencies"], ["tax", "Investments & tax"], ["limits", "Limitations"],
    ];
    // Ordered by category so the in-list dividers stay contiguous. (Draft set - trim later.)
    var faqData = [
      ["plans", "Is Valutio really free?", "Yes - completely. Valutio is <strong>free and open source</strong>: every feature is unlocked for everyone, with no accounts, no subscriptions, no ads and nothing locked away. Track your whole net worth, investments, cash flow, tax and more, with no entry caps."],
      ["plans", "Does it cost anything? Is there a catch?", "No cost and no catch. There\u2019s nothing to buy and nothing to unlock. If Valutio is useful to you and you\u2019d like to support its development, you can leave a small tip on <a href=\"https://ko-fi.com/salvatoresorvillo\" target=\"_blank\" rel=\"noopener\">Ko-fi</a> - entirely optional, and everything stays free either way."],
      ["plans", "Will it ever expire, add limits or start charging?", "No. Valutio isn\u2019t a trial and won\u2019t start charging later - there are no time limits and no entry caps, and every past month you track is kept."],
      ["plans", "Do I get future updates?", "Yes - <strong>every update is free, for everyone</strong>. The app updates itself: when a new version ships you\u2019ll see a small \u201cnew version available - Refresh\u201d prompt (or it applies automatically the next time you open the app). No reinstall, no app store, nothing to download."],
      ["plans", "Who is Valutio for?", "Investors, freelancers and anyone living across currencies - if you want auto-refreshing stock, ETF, bond, commodity &amp; crypto prices, tax estimates, rebalancing against a target allocation, a secondary currency with live FX, retirement projections, or full month-by-month history, Valutio is for you."],
      ["start", "How do I add my first account or holding?", "On Accounts or Investments, press <strong>+ Add</strong> and fill the short form. Every total recalculates automatically - no rows to insert or formulas to patch."],
      ["start", "Is there a quick way to update all my balances at month-end?", "Yes - on <strong>Accounts</strong>, hit <strong>Update Balances</strong>: one form lists every account, asset and debt with its current figure prefilled. Tab through, type the new statement values, and save once."],
      ["start", "How do I view a past month?", "Pick a Year and Month in the sidebar. Past months show their frozen snapshot; the current month stays live and recalculates in real time."],
      ["start", "What\u2019s the difference between the live month and a frozen one?", "The current month is computed live from your accounts and the latest prices; once closed, a month becomes an immutable snapshot so your history never shifts beneath you."],
      ["start", "Can I edit a past month\u2019s figures?", "Yes - open that month on Accounts or Investments and click Edit on a row to adjust the frozen values for that snapshot."],
      ["start", "Can I rename my wallet or change my base currency later?", "Yes - Settings \u2192 Profile lets you rename the wallet and change the base (reporting) currency at any time."],
      ["start", "Do I have to be online to use it?", "No. Everything works offline; only live prices and FX need an internet connection."],
      ["start", "Can I change the colors used for my categories?", "Yes - Settings → Colors lets you pick a color for each account bucket, investment type, cash-flow category, asset category and debt type. The choice applies everywhere that item appears, including allocation, Portfolio Mix, Cash Flow, History, badges and charts."],
      ["start", "Can I choose which figures show on the Dashboard and Investments cards?", "Yes - each summary card just below the header has a small selector in its corner; open it to swap that slot for a different metric. Your choices are saved."],
      ["start", "How do joint accounts and expenses work?", "Mark an account or expense as joint and set your share %. Only your share counts toward net worth, and a My share / Household toggle re-lenses the figures."],
      ["data", "Where is my data stored? Is it private?", "Everything lives only in this browser, on this PC. There\u2019s no account and no cloud - nothing you enter ever leaves your computer. It’s stored in your browser on this device, and Valutio asks the browser to keep it so it isn’t cleared automatically to free up space."],
      ["data", "How do I back it up or move to another computer?", "Settings \u2192 Your Data \u2192 <strong>Export JSON</strong> saves a backup file; <strong>Import JSON</strong> restores it on any browser or machine. Your data travels with the file - import it on the new machine and everything comes right back. Because the data lives only here, export every couple of weeks."],
      ["data", "Will clearing my browser data delete my wallet?", "Yes. Valutio asks your browser to keep the data durable, so it isn’t wiped automatically to free up space - but deliberately clearing this site’s data, or switching to another browser or device, still removes the only copy. Keep an exported backup before doing any of that."],
      ["data", "Can I import or export an Excel workbook?", "Yes. Settings \u2192 Your Data \u2192 <strong>Import Full Workbook</strong> reads a .xlsx/.xls profile after preview and can replace accounts, holdings, cash flow, tax invoices, retirement inputs and currencies. Use JSON for a full-fidelity backup or restore. For append-only cash-flow uploads, use <strong>Import Income</strong> or <strong>Import Expenses</strong>. <strong>Export Excel</strong> writes a spreadsheet-friendly workbook, and <strong>Download Template</strong> gives you the layout Valutio can read back in."],
      ["data", "Can I export my data as CSV for a spreadsheet?", "Yes - <strong>Investments</strong>, <strong>History</strong> and <strong>Cash Flow</strong> each have a <strong>CSV</strong> button in their header that downloads that table as a spreadsheet-ready file. Export JSON (Settings \u2192 Your Data) remains the full backup format."],
      ["data", "Is my data encrypted?", "Your live data sits unencrypted in this browser\u2019s storage on your own machine, so keep your computer secured. For backups, <strong>Settings \u2192 Your Data \u2192 Export Encrypted</strong> password-protects the file with AES-256 - useful before storing it in the cloud or on a shared device. There\u2019s no password recovery, so keep that password safe."],
      ["data", "How do I reset everything and start over?", "Settings \u2192 Your Data \u2192 <strong>Reset everything</strong> wipes the wallet clean. Export a backup first if there\u2019s any chance you\u2019ll want it back."],
      ["snap", "What exactly is saved in a snapshot?", "That month\u2019s net worth, allocation by bucket, every holding\u2019s value and P/L, and your income and expenses - enough to redraw the month exactly later."],
      ["snap", "Does editing an exchange rate affect the old months?", "No. Closed months are fully frozen: each one locks its values - including the exchange rates in effect when it closed - the moment it closes. Editing a rate only re-projects your live, current month; past months never move, even if FX rates or your live data change later."],
      ["snap", "What\u2019s the difference between History and the Dashboard?", "The Dashboard is your current snapshot plus what changed this month; History is the month-by-month, year-over-year view built from your frozen snapshots."],
      ["prices", "How do live prices work?", "FX and crypto (CoinGecko) update with no key; stocks, ETFs, bonds and commodities use the provider you pick in Settings \u2192 Market Data (Yahoo by default, or Finnhub / Twelve Data / Alpha Vantage with a free key). Hit <strong>Refresh Rates</strong>. You can also set any holding\u2019s price yourself from its page if you prefer."],
      ["prices", "Why isn\u2019t my stock price updating?", "Set the holding\u2019s API symbol and provider in Settings \u2192 Market Data. Without a working provider or internet that holding stays manual - set its price yourself from the holding\u2019s page."],
      ["prices", "What currencies are supported?", "Valutio supports multi-currency: add a secondary currency with live FX, and have cash flow and holdings each in a different currency, all converted to your base."],
      ["prices", "How do I set a crypto holding\u2019s price source?", "Give the holding its CoinGecko id (e.g. <strong>bitcoin</strong>) on the holding form; crypto then updates automatically with no key."],
      ["prices", "How often do prices refresh?", "Press <strong>Refresh Rates</strong> any time. The app also auto-refreshes FX and prices roughly twice a day when you open it online."],
      ["prices", "Do I need an API key for prices?", "No - the default Yahoo (stocks), CoinGecko (crypto) and open.er-api (FX) work without keys. A key is only needed if you switch to Finnhub, Twelve Data or Alpha Vantage."],
      ["tax", "How accurate is the tax estimate?", "The Tax Estimator is a tool for planning. It\u2019s a simplified, fully editable estimate using your country\u2019s brackets, levy and capital-gains rules - great for planning and \u201cset aside\u201d guidance, but not a substitute for professional advice."],
      ["tax", "Can I track my freelance invoices?", "Yes - on the <strong>Tax</strong> page, add each invoice as you send it. Valutio totals your freelance income, locks in the exchange rate on the invoice\u2019s date when it\u2019s in another currency, and rolls it into your estimated tax and \u201cset aside\u201d figure. Each tax year\u2019s invoices are archived when the year freezes."],
      ["tax", "What\u2019s the Capital Gains Reserve?", "An estimate of the tax to set aside on your current <em>unrealized</em> gains if you sold today - separate from the tax on gains you\u2019ve actually realized this tax year."],
      ["tax", "How does the app work out a holding\u2019s profit/loss?", "It walks your buy/sell ledger with a weighted-average cost basis: P/L is current market value minus cost, plus any gains realized on sales."],
      ["tax", "What is the Annualized Return figure?", "A money-weighted yearly rate (XIRR): it accounts for <em>when</em> each buy, sell and dividend happened and compresses your whole investing history into one % per year - comparable to a fund\u2019s published return. Swap it into an Investments summary card via the card\u2019s corner selector; each holding\u2019s page shows its own."],
      ["tax", "What is Time-Weighted Return, and how is it different?", "<strong>Time-Weighted Return (TWR)</strong> chains together each period\u2019s growth with your deposits and withdrawals removed, so it measures how your <em>choices</em> performed regardless of <em>when</em> you added money - it\u2019s the standard \u201cfund manager\u201d figure. <strong>Annualized Return (money-weighted / XIRR)</strong> instead reflects your actual euro outcome, including timing. Both live on the Investments cards; seeing them side by side tells you whether your picks or your timing drove the result."],
      ["tax", "How does the benchmark comparison work?", "On the Investments value chart, Valutio draws a second line showing what your portfolio would be worth if you\u2019d put the <strong>same contributions, on the same dates, into a benchmark index</strong> instead - so you can see at a glance whether you\u2019re beating the market. Choose the index in <strong>Settings \u2192 Market Data \u2192 Investment Benchmark</strong> (any Yahoo symbol, e.g. ACWI, SPY, URTH); it defaults to a broad all-world index. Note: the comparison uses the index\u2019s own-currency return and doesn\u2019t model exchange-rate moves between it and your base currency."],
      ["tax", "How does Target Allocation / rebalancing work?", "On <strong>Investments \u2192 Target Allocation</strong>, set a target % per holding type. Valutio shows each type\u2019s current share vs the target and the \u2248 amount to buy or sell to get back on plan."],
      ["tax", "What\u2019s the difference between realized and unrealized gains?", "Unrealized gains are on paper - holdings you still own. Realized gains are locked in when you sell. The tax engine treats the two differently."],
      ["tax", "How do I log dividends?", "Open a holding\u2019s detail page and add a dividend; the total and a trailing-12-month yield show there, and dividends feed your tax estimate."],
      ["tax", "How does the Retirement projection work?", "It sums your pension accounts as a starting balance, then compounds salary, employer and voluntary contributions to a retirement-age estimate using your country\u2019s statutory rates and caps."],
      ["tax", "Can I change my country\u2019s tax brackets?", "Yes - Tax Settings lets you edit the currency, thresholds, brackets, levy, CGT rate and discount per country; the presets are only a starting point."],
      ["limits", "Can it connect to my bank automatically?", "No. There\u2019s no bank linking or automatic transaction feed. Add entries manually, or bulk-import a spreadsheet through Cash Flow or Settings."],
      ["limits", "Is this financial or tax advice?", "No. Every figure is an estimate to help you track and plan - always confirm important decisions with a qualified professional."],
      ["limits", "Is there an account or login?", "No account, no password, no server - which is also why there\u2019s no password recovery. Your exported backup file is your safety net."],
      ["limits", "Can I share or collaborate with someone online?", "No - there\u2019s no online sharing or multi-user mode. You can hand someone an exported JSON file (it carries your data), but their edits won\u2019t sync back."],
      ["limits", "Will it auto-categorize my transactions?", "Yes. Cash Flow includes a statement categoriser for PDF and CSV bank statements. It uses editable keyword rules and manual review before you apply the result to Expenses and Income."],
      ["limits", "Can it generate official tax forms?", "No - it produces estimates and set-aside guidance to help you plan, not filing-ready tax documents."],
    ];
    var faqChips = '<button type="button" class="fchip on" data-faq-cat="all">' + esc(trUI("All")) + '</button>' +
      faqCats.map(function (c) { return '<button type="button" class="fchip" data-faq-cat="' + c[0] + '">' + esc(trUI(c[1])) + "</button>"; }).join("");
    var catLabel = {}; faqCats.forEach(function (c) { catLabel[c[0]] = trUI(c[1]); });
    var lastCat = null;
    var faqItems = faqData.map(function (f, i) {
      // a category divider is emitted whenever the category changes - a visual grouping cue, not real grouping
      var divr = "", question = trUI(f[1]), answer = trUI(f[2]);
      if (f[0] !== lastCat) { lastCat = f[0]; divr = '<div class="faq-cat-div" data-cat="' + f[0] + '">' + esc(catLabel[f[0]] || "") + "</div>"; }
      var plain = (question + " " + answer).replace(/<[^>]+>/g, "").toLowerCase();
      return divr + '<details class="faq-item"' + (i === 0 ? " open" : "") + ' data-cat="' + f[0] + '" data-text="' + esc(plain) + '">' +
        "<summary><span>" + esc(question) + '</span><span class="chev"></span></summary>' +
        '<div class="a">' + answer + "</div></details>";
    }).join("");
    // Contact block - the sidebar "Contact" button scrolls here. The email is a clickable mailto.
    var contactBlock =
      '<div class="panel mb" id="help-contact"><h2>Contact</h2>' +
      '<p class="hint mb">Questions, feedback, or a bug to report? We’d love to hear from you.</p>' +
      '<p style="margin:0">Email us at <a href="mailto:support@valutio.app" data-act="copy-email" style="color:var(--accent);font-weight:600;text-decoration:underline">support@valutio.app</a> and we’ll get back to you.</p></div>';
    var help = helpTop + contactBlock +
      '<div class="panel"><h2>Frequently Asked Questions</h2>' +
      '<p class="hint mb">How Valutio works - and what it intentionally doesn\u2019t do. Search, or filter by topic.</p>' +
      '<div class="faq-search"><input id="help-faq-search" type="search" autocomplete="off" placeholder="Search questions\u2026 (e.g. backup, prices, sync)"></div>' +
      '<div class="fchips" id="help-faq-chips">' + faqChips + "</div>" +
      '<div class="faq" id="help-faq-list">' + faqItems +
      '<div class="faq-empty" id="help-faq-empty" style="display:none">No questions match - try another keyword or clear the search.</div></div></div>';

    // data management (full set in Settings)
    var data =
      '<div class="panel"><h2>Your Data</h2><p class="hint mb">All data is stored only on this PC, in this browser. Back it up here.</p>' +
      '<div class="data-groups">' +
        '<div class="data-group"><div class="data-group-head"><div class="section-title">JSON Backup</div><p class="hint">Full-fidelity wallet backup and restore.</p></div>' +
          '<div class="flex gap wrap"><button class="btn" data-act="import-data">' + icon("arrowUp") + ' Import JSON</button>' +
          '<button class="btn" data-act="export-data">' + icon("arrowDown") + ' Export JSON</button>' +
          '<button class="btn" data-act="export-data-enc">' + icon("lock") + ' Export Encrypted</button></div></div>' +
        '<div class="data-group"><div class="data-group-head"><div class="section-title">Excel Workbook</div><p class="hint">Spreadsheet-friendly import/export for review, editing and migration. Use JSON for full-fidelity backup and restore.</p></div>' +
          '<div class="flex gap wrap"><button class="btn" data-act="download-excel-template">' + icon("sheet") + ' Download Template</button>' +
          '<button class="btn" data-act="import-excel">' + icon("arrowUp") + ' Import Full Workbook</button>' +
          '<button class="btn" data-act="export-excel">' + icon("arrowDown") + ' Export Excel</button></div></div>' +
        '<div class="data-group"><div class="data-group-head"><div class="section-title">Cash Flow Imports</div><p class="hint">Append only income or expenses from CSV/XLSX without touching the rest of the app.</p></div>' +
          '<div class="flex gap wrap"><button class="btn" data-act="download-cashflow-template">' + icon("sheet") + ' Download Template</button>' +
          '<button class="btn" data-act="import-cashflow" data-kind="income">' + icon("arrowUp") + ' Import Income</button>' +
          '<button class="btn" data-act="import-cashflow" data-kind="expense">' + icon("arrowUp") + ' Import Expenses</button></div></div>' +
        '<div class="data-group"><div class="data-group-head"><div class="section-title">Utilities</div><p class="hint">Try the app with demo data, or start over.</p></div>' +
          '<div class="flex gap wrap"><button class="btn" data-act="load-sample">' + icon("wallet") + ' Load Sample Data</button>' +
          '<button class="btn danger" data-act="reset-data">Reset everything</button></div></div>' +
      '</div>' +
      '<p class="hint" style="margin:12px 0 0">Import Full Workbook replaces major wallet sections after preview. Cash Flow Imports only append income or expenses to the selected ledger.</p></div>';
    // Backups + monthly reminders
    var bkFreq = db.settings.autoBackup || "off";
    var bkLast = db.meta.lastBackup ? new Date(db.meta.lastBackup).toLocaleString() : "never";
    var bkAgeDays = db.meta.lastBackup ? Math.floor((Date.now() - db.meta.lastBackup) / 86400000) : null;
    var bkFresh = bkAgeDays !== null && bkAgeDays <= 14;
    var bkFreshText = bkAgeDays === null ? "No backup yet" : (bkAgeDays === 0 ? "Backed up today" : (bkAgeDays === 1 ? "Backed up yesterday" : "Backed up " + bkAgeDays + " days ago"));
    var bkDestination = db.settings.backupFolderName ? db.settings.backupFolderName : "Downloads fallback";
    var bkSchedule = bkFreq === "off" ? "Manual only" : (bkFreq === "weekly" ? "Weekly" : "Monthly");
    var backupHealth =
      '<div class="backup-health">' +
        '<div class="bh-item"><div class="bh-label">Backup health</div><div class="bh-value ' + (bkFresh ? "good" : "warn") + '">' + esc(bkFreshText) + '</div></div>' +
        '<div class="bh-item"><div class="bh-label">Destination</div><div class="bh-value note">' + esc(bkDestination) + '</div></div>' +
        '<div class="bh-item"><div class="bh-label">Schedule</div><div class="bh-value">' + esc(bkSchedule) + '</div></div>' +
      "</div>";
    var bkFs = !!window.showDirectoryPicker;
    var freqOpts = [["off", "Off"], ["weekly", "Weekly"], ["monthly", "Monthly"]].map(function (f) {
      return '<option value="' + f[0] + '"' + (f[0] === bkFreq ? " selected" : "") + ">" + f[1] + "</option>";
    }).join("");
    var notifBlocked = (typeof Notification !== "undefined" && Notification.permission === "denied");
    var backups =
      '<div class="panel mb"><h2>Backups</h2>' +
      '<p class="hint mb">Your wallet lives only in this browser. Keep a copy somewhere safe so a cleared cache never costs you your history.</p>' +
      backupHealth +
      '<div class="hint" style="margin:0 0 14px">Last backup: <strong>' + esc(bkLast) + "</strong></div>" +
      '<div class="row" style="align-items:flex-end;max-width:540px">' +
        '<div class="field" style="max-width:190px"><label>Automatic backup</label><select data-act="set-autobackup">' + freqOpts + "</select></div>" +
        (bkFs ? '<div class="field" style="flex:0 0 auto"><label>&nbsp;</label><button class="btn" data-act="choose-backup-folder">' + icon("assets") + " Choose folder</button></div>" : "") +
        '<div class="field" style="flex:0 0 auto"><label>&nbsp;</label><button class="btn primary" data-act="backup-now">' + icon("arrowDown") + " Back up now</button></div>" +
      "</div>" +
      (bkFs
        ? '<p class="hint" style="margin:12px 0 0">Pick a folder once and Valutio writes a fresh JSON backup there automatically on your schedule - no clicks needed. Everything stays on this device; nothing is uploaded.</p>'
        : '<p class="hint" style="margin:12px 0 0">Automatic folder backups need Chrome or Edge. Here, use <strong>Back up now</strong> (or turn on reminders below) to keep a copy.</p>') +
      "</div>" +
      '<div class="panel"><h2>Reminders</h2>' +
      '<p class="hint mb">A gentle nudge at the start of each month to review last month and keep a backup. Stays on this device - nothing leaves your browser.</p>' +
      '<label class="check-row"><input type="checkbox"' + (db.settings.notifications ? " checked" : "") + ' data-act="toggle-notifications"> Enable monthly reminders</label>' +
      (notifBlocked ? '<p class="hint" style="color:var(--d-amber);margin:10px 0 0">Notifications are blocked for this site in your browser settings - re-allow them there to use reminders.</p>' : "") +
      "</div>";

    var donateSection = '<div class="panel mb"><h2>Donate</h2>' +
      '<p class="hint mb">Valutio is <strong>free and open source</strong> - every feature is unlocked for everyone, with no accounts, subscriptions or ads. If it helps you, a small tip keeps it going. Entirely optional, and thank you.</p>' +
      '<div class="flex center gap wrap">' +
        '<button class="btn primary" data-act="donate">' + icon("wallet") + ' Donate on Ko-fi</button>' +
      '</div>' +
      '<p class="hint" style="margin:12px 0 0">No pressure - Valutio stays completely free whether or not you ever tip.</p></div>';
    var legal =
      '<div class="panel mb legal-doc"><h2>Legal &amp; Disclaimer</h2>' +
      '<p class="hint mb">Please read this before relying on anything Valutio shows you.</p>' +
      '<div class="help-box" style="margin:0 0 14px"><strong>Not financial advice.</strong> Valutio is a personal tracking and estimation tool. Nothing in the app is financial, investment, accounting or tax advice, or a recommendation to buy or sell any asset. Always consult a qualified professional before making financial decisions.</div>' +
      '<div class="help-box" style="margin:0 0 14px"><strong>Estimates &amp; accuracy.</strong> Prices, exchange rates, valuations and tax figures may be delayed, incomplete or inaccurate, and tax results are rough estimates based on the settings you enter - not an official assessment. Verify anything important against your own records and official sources.</div>' +
      '<div class="help-box" style="margin:0 0 14px"><strong>Provided &quot;as is&quot;.</strong> Valutio is provided without warranties of any kind, express or implied, and you use it at your own risk. To the maximum extent permitted by law, the maker of Valutio is not liable for any loss or damage - including financial loss, lost profits, or lost or corrupted data - arising from your use of, or inability to use, the app.</div>' +
      '<div class="help-box" style="margin:0 0 14px"><strong>Your data is yours.</strong> Everything you enter is stored locally on this device and is never collected or sent to us; the only network requests fetch live market prices and exchange rates. You are responsible for your own backups - clearing your browser data or uninstalling will erase your records, so use Settings &rarr; Backups to keep copies.</div>' +
      '<div class="help-box" style="margin:0"><strong>Free &amp; open source.</strong> Valutio is free and open source - there are no purchases, subscriptions or accounts. If it is useful to you, tips are welcome via <a href="https://ko-fi.com/salvatoresorvillo" target="_blank" rel="noopener">Ko-fi</a> (entirely optional). See our <a href="https://valutio.app/terms" target="_blank" rel="noopener">Terms</a> and <a href="https://valutio.app/privacy" target="_blank" rel="noopener">Privacy Policy</a>.</div>' +
      '</div>';
    // Settings groups Profile + Currencies & FX into one top row; the wizard keeps them stacked.
    if (isWizard) {
      if (wizardStep === 2) return profile;
      if (wizardStep === 3) return currencies;
      if (wizardStep === 4) return country;
      return "";
    }
    // Settings: section sidebar - a sub-nav lists the sections; the selected one renders full-width.
    var sections = [
      { id: "profile", group: "Preferences", label: "Profile", desc: "Your wallet name and the currencies you report in.", html: profile },
      { id: "appearance", group: "Preferences", label: "Appearance", desc: "Switch between dark and light mode.", html: appearance },
      { id: "colors", group: "Preferences", label: "Colors", desc: "Pick the colours used for buckets, asset types, badges and charts.", html: colorSettings() },
      { id: "currencies", group: "Finance", label: "Currencies & FX", desc: "The currencies you track and their exchange rates to your base.", html: currencies },
      { id: "categories", group: "Finance", label: "Categories", desc: "The expense and income categories used across Cash Flow.", html: categories },
      { id: "market", group: "Finance", label: "Market Data", desc: "Live price sources for stocks, crypto and FX, and your investment benchmark.", html: marketData },
      { id: "data", group: "Data", label: "Your Data", desc: "Export, import or reset your wallet. Everything stays on this device.", html: data },
      { id: "backups", group: "Data", label: "Backups & Reminders", desc: "Keep a safe copy of your data, with optional monthly reminders.", html: backups },
      { id: "install", group: "App", label: "Install", desc: "Install Valutio as an app for offline, one-click access.", html: install },
      { id: "donate", group: "App", label: "Donate", desc: "Valutio is free and open source - donations keep it going.", html: donateSection },
      { id: "help", group: "App", label: "Help & Onboarding", desc: "Guides, the setup walkthrough, and answers to common questions.", html: help },
      { id: "legal", group: "App", label: "Legal", desc: "Disclaimer, and how your data is handled.", html: legal },
    ];
    var active = state.settingsSection || "profile";
    var cur = sections.filter(function (x) { return x.id === active; })[0] || sections[0];
    active = cur.id;
    var nav = '<div class="settings-nav">', _lastGrp = null;
    sections.forEach(function (x) {
      if (x.group !== _lastGrp) { _lastGrp = x.group; nav += '<div class="settings-nav-group">' + esc(x.group) + '</div>'; }
      nav += '<button class="settings-nav-item' + (x.id === active ? " active" : "") + '" data-act="set-settings-section" data-section="' + x.id + '">' + esc(x.label) + '</button>';
    });
    nav += '</div>';
    // De-dupe: the section header now carries the title, so drop a leading panel <h2> that just repeats it.
    var body = cur.html.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/, function (full, inner) {
      var t = inner.replace(/&amp;/g, "&").replace(/<[^>]+>/g, "").trim();
      return t === cur.label ? "" : full;
    });
    var head = '<div class="settings-head"><h2>' + esc(cur.label) + '</h2><p>' + esc(cur.desc) + '</p></div>';
    return '<div class="settings-shell">' + nav + '<div class="settings-content">' + head + body + '</div></div>';
  }

  function emptyState(name, title, sub) {
    return '<div class="empty"><div class="emblem">' + icon(name, "stub-ico") + "</div><div style='font-weight:600;font-size:16px;color:var(--text)'>" +
      esc(title) + "</div><div class='mt'>" + esc(sub) + "</div></div>";
  }

  // ----- Wizard -----
  function wizardPage() {
    var steps = ["Language", "Theme", "Profile", "Currencies", "Tax region"];
    var step = Math.max(0, Math.min(steps.length - 1, state.wizardStep || 0));
    var stepper = '<div class="wiz-steps">' + steps.map(function (label, i) {
      return '<span class="wiz-step' + (i === step ? " on" : (i < step ? " done" : "")) + '">' + esc(label) + "</span>";
    }).join("") + "</div>";
    var last = step === steps.length - 1;
    return '<div class="main"><div class="wizard wizard-step-' + step + '">' + stepper +
      '<div class="wlc-hero">' +
      '<h1 class="wlc-title"><span class="wlc-eyebrow">Welcome to</span><img class="wlc-wordmark" width="245" height="44" decoding="async" alt="Valutio" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAA9kAAACxCAYAAADQ+35AAAAACXBIWXMAAAsSAAALEgHS3X78AAAf3UlEQVR4nO3dT2hk65nf8W8PHZK5G+mSjWMmSDczEAKBlhfeedJ1F4HsWnfVDAS6mniRjbndu0wYaDUhTLIIV31hIAvHtwQhscnCarKabG6JMSZcApbIIpsJLkGCCSS4tPLGpLN46kTV1fpXqnPO+5xzvh8Q8m23qh5J1fW+v/d9znsevHv3DkmSNBhZBv7XwEHpIiRJqtvvlC5AkiRJkqS+MGRLkiRJklQTQ7YkSZIkSTUxZEuSJEmSVBNDtiRJkiRJNTFkS5IkSZJUE0O2JEmSJEk1MWRLkiRJklQTQ7YkSZIkSTUxZEuSJEmSVBNDtiRJkiRJNTFkS5IkSZJUE0O2JEmSJEk1MWRLkiRJklQTQ7YkSZIkSTUxZEuSJEmSVJOHwEHpIlo2AWaFa+izHeAlMC9dyAamiw9JkiRJWstD4FXpIlo2xZDdlO8BPwG+XbqQGkxLFyBJkiSpe2wXV12eAn9OPwK2JEmSJN2LIVt1eAr8CPiodCGSJEmSVJIhW5syYEuSJEnSgiFbmzBgS5IkSdISQ7buy4AtSZIkSSsM2bqPP8GALUmSJEkfeFi6AHXOl8APShchSZIkSRm5k611GLAlSZIk6QaGbN2VAVuSJEmSbmHI1l0YsCVJkiTpDgzZuo0BW5IkSZLuyIPPdJNvgO+WLkKSJEmSusKdbF3HgC1JkiRJazJk6yoGbEmSJEm6B0O2VhmwJUmSJOmeDNlaZsCWJEmSpA0YsgWwA/xXDNiSJEmStBFPF9cO8HPg26ULkSRJkqSucyd72AzYkiRJklQjQ/ZwGbAlSZIkqWaG7GEyYEuSJElSA7wme3gM2MOwDcyArcJ1LPsYmJcuogFj4KvSRSx5C+yXLmJDI2B38bFHvJ63gUdrPMY58W8AYLr0ebb05+q3d6ULWDghXtMZvAC+KF3EwkvgcMPHmAKPNy9FV3hQw2P4bzCnalwdLf67+rxL5IR1nHE5t5su/vcp/R1r94g51u7iv2fE93u8+hcN2cPyFPgz4K+XLkSNmxP/4J+VLmTJPjApXUQDsgXaD97ok9sjBvjq87oD/HV2lh6rmoS/Wny+IAbF6dKHJEl9s8f74+w6i9V3sfx4Vy14nXA53lbhu4v2iEXBx1wu4s+JOeCrxZ+9YGkOZsgejqfAj4CPShei1hiym7cNPCldxJILuhGy9xcfI+oL1evYIgbKx1wG7xPiZ3dMdycBkqRh2+ZyfN2nfEdjNdZ+vvjvc2KcndKN+QpcdiyeAJ/y4cL8LhHAfwq8IcK2IXsgDNjDdEyErtJvsJUnxJt/n1rGM+5iZ/35joiBKsOgf5VqIvAF0f42wcAtScqvCtb75Fr4v8oOEbg/53JjoPrIaI8I2EdEeK66AipTYp6wz2UYPwUmHnzWfwbsYZuULmBFtlC6qWzfT7ZBapsYlGbA10RnRcaAveoREbZ/SfxMR0WrkSTpQyNinvdrItxlD9irtoh5wU+JDYJDLq91zuKQ2MEeEwH765WPd0TQ3iZ+F28WX7NtyO43A7YmpQtYkS2UbsJW8ettAwdEuP6CMi3hdXlCDKQzYpCVJKmkMe8vXvfBFrG7/UsitGaYL+4RHW4vVv78iGgbf0l0vj3mcr59sPg8NmT31wsM2IqWlfPSRSwZlS6gRhkGgGUZAvZyuH5FN3at72qH2CmYYdiWJLWrGl/nxFjU5cXr2zwmdrdnlB1v94kQfbry5zNiIeCQmNdecDm/rQ4e3jdk99OXxO6RAVuQI3xVtsgXTu8r2/ex6a1wNlW1hfctXK+qwvYp/Vo0kiTlNGYY4+uq5cXtUYHn3+PDgL1qmw9/JzNsF++lL4EflC5CqZQOX6uyhdP7yNYqfs7tA0FTRovn/oJhDf6PiFa9Y+L1IElSnUZEYPuKYY2vq3aI8XZKu9dsX3dY74joKphwedL4ZPVrDdn9YsDWVWZEu0sWfQjZ2b6HEt0K28QCztfUf9/NLnlC/BtbvWZLkqT72CbG9a/pd1v4uh4T12wf0M7i9pTYzb6qjlfE9fA7wFvenwNsAzNDdn8YsHWTSekClvShZTxb/W13K+wRg8/nt/y9odgidvLd1ZYkbWJMLNxm6pbL5hXtXLJ1SgTq1XH9NfAA+A6X12Mv/5194NSQ3Q8GbN0m03XZ0O1rWbO1ip/R7r2cx0TAHvLu9XWqXe1R2TIkSR1T7V4PvTX8rqoW8oMGn+OYCNHXPcfp4v/b4nIza7yo7dCQ3X3/CQO2bjcj2lmyyLYTvI5stU9afi4nADfbIgZ+28clSXdRHbCVaQG/K6pd7d2GHn9MdO2Nibn0ay6vw4boJHy5qOEPF//9BtvFO+8b4O+XLkKdkWk3e4err3Ppgmwhu43f6zYxqPTlfpxt+IJcl2lIkvJ5AfwCr73exCOaax8/Ju6L/RURtA94P2RDBOsZ8B8Xnw8ADNnd9Q3w3dJFqFMyhWzo5r2Gs7WKv6X5VvEqYD9u+Hn66Bkx8HudtiRp1YRYkNXmqi6ycQOPPSZ2q6tblR4u/mxMBOoZEcInRNCfgyG7qwzYuo85sRqXRbYd4bsYlS5gRdMLJ1XA9vrr+3tE/AwN2pIksDusSVXYrdsh0YG5/PkrYl54DHxChPD/f8svQ3b3GLC1iUy72V1sGc+2MNDk79OAXR+DtiQJ7A5rwzOaCdozIlyPiN/jg8X/rna432PI7hYDtjZVnZSYRbbQeptM9R6xtGLagCkG7DoZtCVp2Fy8bs8zCt9W05DdDTvA/8SArXpk2s3OFFpvs0+uU7Wb/D1OcBLQBIO2JA2TAbt9Tyg45hqy89sBfg58u3Qh6o3D0gUseURzt12oW6YFgQuaC9ljvE6sSY/w1HFJGhIDdjmPKDTvNWTnZsBWE06B89JFLMkUXm+Sqc6mAvYecZCHmvWExS0+JEm9ZsAur6lrtG9kyM7LgK0mZWoZH5cu4A6ytYpPOva4+tAr8p1WL0mq1zEG7Aye0fLitiE7JwO2mjYpXcCSLrSMZ9rFPidWxet2gBOBtk3w+mxJ6qtDPEU8k1e0uLFjyM7nKfAXGLDVrFPgrHQRS0alC7hFppDdRBfCLjH4qF072DYuSX00Bj4vXYQ+UN3nunGG7FyeAj8C/mbpQjQIk9IFLMkUYlcNoVW8icfU3XxO/kUmSdLd7ZHrkFld2qKlLjJDdh5VwP6odCEajEzXZT8hb9tspgWAM6ILoU4jbGcr7aB0AZKk2kzItTiv97Vy4rghOwcDtkqYASeli1iSKcwuy1TXpIHHPGjgMbWex7ibLUl9cIDnm3TBMxqe3xmyyzNgq6RJ6QKWZAqzlWyt4nV3H+zhLnYWB6ULkCRtZA/PN+mSCQ12URqyyzJgq7RsLePZZAr+J0T3QZ1e1Px4ur/HtHQYiySpEV6H3S1bNLjAbcgu50vgxxiwVdYceFu6iCWZQi3kqmdS8+NtE+1SXXZOLD5UH+dly9mYix7SekbAgxY+Ml1a1cb3+6C176Y/xtgZ1kWf09AC98MmHlS3+hL4QekipIUJeXaR98mzu973VvFMCwh3Ud0f/Jg4/G12w9/dJgbNEfF9duX6uK79TiRJMeb0YRf7nBhbp4v/nl7xd6rxtfq8R6650n0c0sC5KIbs9hmwlc0xcEGON8lMISNTLW+JroM6TYGXxMCSZZHlKifEALjOIsOc+P6mRCvYLrHL8IIcr/PrbJFroUmSdLvsY8t1LojxZrr4fNd5xuoYtcvlonbm+cR1qsNHp3U+qO3i7TJgK6ssk/oqZGSQpQ5o5oC6GRFe94GPgefAETHoZnAOfEoMfJu+Pmdchu3XGz5W00alC5Ak3dk23bvU54QY87eJBegJmy3kzxaPUc0nXtK9y7cO6n5AQ3Z7DNjKbFK6gCUZwm2mVvFqpblJc+I1MCYG3c+AN5QbJN8QgXha8+POiYH0O8Q9xzMalS5AknRnY/LMF25zwuXi9aSh55gTC/i7RJDvStiu/Vaahux2/DsM2MptSp43wiwhO4sSXQbHxMr8LhFIX9NeKH1O87sCp8RgmunQv0pXrh+XJHVjF/ucWDwfUf/i9U0mXHaQZemSu8m4zgczZDfvG+CPShch3UGmlvHStzIaeshedkrs/u4BnxBtYE2F0+e011UxJ37PGYP2qHQBkqRb7QM7pYu4xRExfpecSxwsasjaQVZ5RiwK1MKQ3axvgO+WLkK6o0npApaMCz53plbxc8qH7GUzmruO+w1lXoNj8g3826ULkCTdaly6gFs8J2qs++DU+5gRQftN4TpuM67rgQzZzTFgq2tOsWW89HOvyhSwV9V5HfcZ5Vru5gWf+zqlOzkkSTfbJu9J2hfEpV6TwnVc5QUR/rMa1/VAhuxmGLDVVVnu87hDuaCRKWRPShewhk2u4y4dcqfEgTCSJN3FuHQB17ggLjk6LVzHTSbkDdq1zT8N2fUzYKvLMu2cjgs8Z7ZW8cyD5E3WuY77jHYPYrnOpHQBkqTOyLQgX+lCwK5MyBu0x3U8iCG7PjvAX2LAVrfNyHN96qjAc2YaNLN0FWxqxs3XcU+KVPWhLkxKJEnlbRO3fMpmn26NZRNiET6bUR0PYsiuxw7wc+D3Sxci1SBLuHtEjac83lGmkJ2pq6AuV13HneX77NLERJJUzqh0AVd4SY6usHUdku8uH7XMPw3Zm6sC9rdLFyLVJEvogXZDb6ZW8TNiB7jvjhnG9ylJ6o9R6QJWnJBng+Q+xuS7j/Zo0wcwZG/GgK0+mpNnVXHc4nNl2sXu8mCZ2R4xcL4grhk/Jlb+Z8C7QjVJkrplVLqAFePSBWxoTr7vYbTpAzysoYihMmCrz47JcWuKqmVn1sJzZQrZmboJumSPaEO/6nOWLgVJUrc9Kl3Aktf0oyPsmNiRz3Kt+8YnjBuy7+d7wE8wYKu/JsRuaoZgsk/zO7uZWsXfEqu6+pAhWpJU0qh0AUsu6Ffn2wHwdekiFjZeSDFkr+8p8CPgo9KFSA07Bp6VLoIY0NoI2VkMeRd7tPLZEC1JyqSWeyjX5Jh+LcpPiTNpsnQKjNjgMDlD9noM2BqSLCH7CRG0mhxIsoTsC/Lc0qpJu8REpbpGepe4BEeSpMx2SxewpE+72JVD4KvSRSzsbvLFhuy7M2BraI6Bc3KEn32aC5+ZWsX7uou9TfycR4uPDK8pSZLWlWUn+5x+3nrymJ6EbE8XvxsDtoYqS+hrcqc5yy425Pl512GbOC30GPg1MWg+w4AtSequ7dIFLPRpvrBsTrSMZ7C7yRcbsm9nwNaQTUoXsFC1jDchS8i+oB+D5oh43VTBOsMp9ZIk1SHL9cLT0gU0KMtcaHeTLzZk3+xPMGBr2E6JlqQMmgjDmVrFJ6UL2NCIGPS/Jse1/JIk9dW0dAEN6kUbvCH7el8C/wwDtpTlYI1RA4+ZZRcbuhuyR1yG6yz3t5QkqW5Zrse+oF+niq/KErI3mtMYsq/2JfCD0kWoiDPyhMossrTtNLWTnUEXDzDZJV4bhmtJ0hBkuR67a/OFdc1KF1AHQ/aHDNjDdUbsyvV5dfA+ZuQ4hGKLekOxreL3NyYGea+3liRJdbsoXcCmDNnvM2AP1xHRBmTAvtqkdAELdYfsLCalC7ijbS5vr5FlgUKSpCHp+0429OB7NGRfMmAP1xGxM6frTUoXsNDHkH1GN1qj9ohrr929liSpHDeEOsCQHb7BgD1UBuy7mQNvSxdB7J6OangcW8XXUwXsLLcukSRJSsuQHQH7u6WLUBEG7PX06QC0LLvYkD9kVwE7y6KEJElSakMP2Qbs4XqJAXtdx+Q4iKJPIfstudu+DNiSJOUyKl1AC3ZLF7CpIYdsA/ZwPcfbdN3HnBy72Ttsdq/KTK3iGX6e1zFgS5KkEnZKF7CpoYZsA/ZwPSd/e25mWULheIOvzbKLfUGen+eq6hRxA7YkSSFL59lu6QIatlu6gDoMMWRPMGAPlQF7c31oGc8Sso/JM2CvmtCDVWRJkmqU5bZSO8RieF/tli5g4WyTL/4d4MHAPpw4Ds8F8CkG7LpMShdA/DvevcfX2Sp+uxd4my5JkjLb5LK57EalC1jYaCNkiDvZGpYL4h/rtGwZvTIpXcDCfXaks+xiZ20V3wYOShchSVJS56ULWBiVLqBBo9IFLBiypWtUATtLe09fnJJjkBnf42uyhOyMARviQMAsO/2SJGUzK13AQpb5TN22gceli1jYKD8YstVXBuxmTUoXADxivZbxTK3iGU+33wWelS5C6qG/XboASbWZlS5gYd05UFdkWjyYbfLFhmz10RlxrYoBuzmT0gUsrPNmnOWN+5ycr82D0gVIPfXXShewJMv7oNRVs9IFLHlRuoAGjEsXsGS2yRcbstU3Z8QO9qxsGb03Y8NTF2syXuPvZplcZmwV32WYu9hnwAlwBLwuXIv666+WLkBSbaalC1gypl+njO+Rp1UcNvxdP6ypCCmDKmBnvS1S30yALwrX8IgYYG77ndsqfrNx6QIacrL4PF18PiVeK9XnVa9aqEnD87ulC1jye6ULkDouUyfaFrGbfVC4jroclC5gycZnDxmy1RcG7PYdUz5kQwToyR3+TgZn5OyyGJcu4B7OiZ/lcmiuJj/TMiVJ13pBjgU2b2MqbWZOjD9Z/i1V7y1dn/+OyHX70OmmD2DIVh+8JUJC199gumZG/OxLvyl2KWRPShdwhT3yTBauckEMdqeLzzOaWajoU8ud8nlG+ZD9FOd9Uh2m5LnEaouYW2SZ59zXpHQBKzbuWPCabHXdEfHGYsAuI8P1xU+4OSBlahXP8PNalXVgfgt8Rvxu94k2sinNdQLsNfS4EsDfLV0A8M9LFyD1xLR0ASue0M2OtMoh+Rb7N56vGbLVZUd0+02lD7KExpuCYpYQ+ZacreKj0gWsOAM+JX5vbb6+DNlq0kPKngT8PeBvFXx+qU+mpQu4wiHdHMfGwOeli1hRXY62EUO2usqAncOc+F2U1oWQnWVBYlWmQbk6W2Fa4LlHBZ5Tw1LyYL3/ADwo+PxSn8zIcYeVZVvEPKNLlz7tUf4ymqvUMl8zZKuLXmPAziRDeBxd8+e2it9slzw/n3PKHV64S/mzBdR/28BPCzzvD4FvFXheqc8mpQu4wg6xSN2FoL1H1JplDrJsWseDGLLVNc/JdcS/IjxeFK5hi6t3rLPsYh+R89yA3dIFLDmg3M/ooNDzanieEAeQteUp8I9afD5pKDIunEPc2nRKri61VSPyBuxz3MnWAD0n58qhcgw2mUN2hp/PVTINwtNCz7tHnlNiVa93pQu4wgPg39LOIT9PgX/fwvNIQzQDTkoXcY0qaI/KlnGlMfA1OQM21DhfM2SrKwzYuWW4pmY1UGdpFb8gb8jO1FI2K/Cc2+T93WhzpTtsrvMQ+G80u6P9Q+DHeB221KRJ6QJusEWE2YPCdVS2iZ/XV4XruE1t81lDtrK7wIDdBadEi01Jqy3j7mJ3S9uBf5tY6c922xANw+8Su8x/WvPj7gB/iS3iUhsm5F3Mq7yifPv4iJgnZu8aO6HGBX9DtjK7IP5hTsqWoTvKECZHS/87S8ielC6gI0YtPlcVsB+1+Jxq36x0Abd4APwT4FfELbY29UPgl8Dv1/BYku4mQyffbR4DvyDmI7stPu8uMdZ+TTcWtGv9XRqylVUVsE8L16G7yzDQ7C99ztAqfk7O+2lm1NaiyB7xvmLA7r/sO0yVbwF/QYTtP2W9yehTYvL8f4nda9vDpXYd0p33mmfEQtyEZne2R8Tc55dEwO+C2g48qxiylZEBu5tmlL9v5A4xcGTZxc6wu98Vz2h2N3ubuDbtF3RjRV2b69q/v28RO9sz4NfEa3W6+HhB7FRX//1rIlj/mHjPM1xLZczJscmwjmfE+8sp8d5SR+AeET+HGbFz3ZVwXTmo+wEf1v2A0obOiYBkwO6mCfBF4RrG5AnZk9IFdMwx8bub1viY24vHPMBwPTQ/pfz70X1t8/7Et2sTVmlIDomwmqGDbh2PuHyPvCDm3lMiKM8Wf778v/e4PD9lj2gH36P7709nNDBfM2QrkzNiJSzj/YR1N8eUn9R+Xvj5K2e4WLSu6jTUIyIUzzZ4rP2lj65NfFSPc+C3ONeR1KxqN/tV6UI2sEWE5a4H5vt40cSDOvAoCwN2P8yI0xmH+Ca9alK6gA57tvg4I1bVT4nX1pwPFy5Gi8+7i48Rvv506X8TbdiS1KQDopPOjqlueUtDZ+cYspWBAbtfJhhyoBvXg2bfaX+EB5RpM/+ZPJePSOq3MdGNpW64oKFdbPDgM5VnwO6fLoTLptV6r8UG+e9OffevShcgaTCmxM6ouuGABudqhmyVdEQcmOBEv1/mOMhMShdwR9PSBUgN+xnwm9JFSBqMMXEehHI7oeFT4Q3ZKuWIeCNSP01KF1BYl3bznQyo7/68dAGSBmOO89vsLmjhMiJDtkowYPffMfEmNkRv6VZ3xrR0AVLDbBmX1KYp8Lp0EbrWPi3M0wzZapsBezi6tJtbp0npAtY0LV2A1LCf0a2FL0ndd4CXzmX0mpbmPYZstek5BuwhmZQuoIALure40LV6pfv416ULkDQ4Y+KAX+VwRCx+tMKQrbY8Z5iha8imDO963y4GVg+q0xD8MfDb0kVIGpQ5cQedoV4+l8kZLW/0GbLVBgP2cE1KF9CyRk+qbFAXFwekdR2VLkDS4Bi0y6tuF9wqQ7aaZsAetknpAlp0ApyWLuKeJjgBUP99H2/nJal9pxi0S6kCduvnchiy1ZQL4FOGFbL0oRnD2T06KF3Ahrq6Cy+t45+WLkDSIBm021csYIMhW824IF7U07JlKImD0gW04ITuv94PcfBX/x3S3Y4TSd1m0G5P0YANhmzVrwrYTmJUmdH/3ewXpQuowZx+fB/31ffXqC7t4yFokso4Bfbw1PEmvaVwwAZDtuplwNZ1XtDflds39Oc1P2GYA/8Zw15gGJpz4B+WLkLSYM2I+fIQx9umHRELqUUDNhiyVZ8zYmWuL2FD9ZrTz7bxc/r3fY3p74LIVS6I77n4gKxW/QRP1ZdUzpyYN9tFVZ/ntHybrpsYslWH6rqHWdkylNwh/bsf85j+hbNThrWrO8LFwaH6DPjvpYto2bvSBUh6z5gIh0Na3K7bOfAdkh22bMjWpoofLKBOGRNvhn3wku4fdnadCcNYXX+OAXvo/oDhBO3fAP+ydBGSPjDB9vH7ekvSTlpDtjZhwNa65sS1Ml1fsT2i/7e8GhOnpvfVc5KtequYIQTt3wB/B/hfpQuRdKXqQLTXpQvpiAtisyPF9ddXMWTrvlKc3KdO6votLE5IdM1Pw/bp58q6AVur+hy0q4Ddly4iqc8OiNbnPo69dal2r1NvdhiydR9pTu5TZ53SzQO2zojX/lDMiQWRvuxoXwCfYsDW1f6AhC2HG5pjwJa6ptrVfkn35klNOifO0tinA+dAGbK1riOGs4unZh3TrR3tI4bZvVEF7a5fo11d3jItW4aS+w7wb+jHAWGnwMcYsKWuOgR2iVuFDtkF0Ua/S4fuCmHI1joM2Kpb1TqevS3qDf08SXwdY2JVvYuqBZK+7VKqGd8H/ohos+6id8C/IBYMJHXbnLjjxyd0f7F7Xcvh+qBoJfdgyNZdvcaArWZUQTvj7b0uiOt3h3RLq5scEhP3ruyMXRCtZWOGvUCi9f0E+IjuXSoxB/4e8MelC5FUqxkxln1CLPx3pQvwPs55P1x3cvw2ZOsuntPBFSR1SnXq+GfkGThOiGuiJoXryKYrJ6Ae0bHWMqU0Av6Q/JO83xK71x8DPytci6TmzIiF/11ifp69E3AdJ8T3tEuHw3XFkK3beAqv2nRMvLmWbIk6J173IzpwsEYhc2IAzNi+dkLsto/p+ACtNH5GhNeX5HtNvSNe838Fd6+lIZkT8/M9Ysx7Q3e6zJadEe+tnxDzrknJYupkyNZNDNgqYc5lS1SbAa669sfd67ubUeZ3dZUjYqIxwmuv1YxDLsN26dt9/ZY4oK2amEoarlMud7erwJ15h/uEy2Bd3YprVrKgJhiydZXqOsZJ4To0bDMuA9xrmluhPSMWlLbpQXtSITPid1UFkLYG92oF/OPF8xuu1YZD4nZfu0T3TVvvGe+IcP+S2Ln+Pt3cuZLUnCpw7xFj42dE6C51vsTF4rlfE7fQfEAsDPYyWC97WLoApXOBO0HKZUaE3wNi0NgnXqOPN3jMt8StnI7p+Zt8y+bEwFnddmS09LFTw+OfEe9NU9oNN9JVqnu2Qry+/zHwD4jX/nZNzzEnXvfHxL8rSbqrOfHesXw2yR7xHlV93iXerx5t+FxViD9dPO+UmF/NNnzczjJka5kBW9md8v7rc8T7g8TeFV8zXfraGb6+2zIjumEmS3824v3f0x5Xh5E5l7+n5QG7aVlOkp41/PhD+T7bdE5cE718XfRT4G8QC4MAW8R71VX+D/A/Fv/7GPgvNHOA2a/Iszj1q9IFrMFx436yvNf4+7tUzaOuOxT0urnUVaZ1FNRXD969e1e6hrYN7hu+IwO2JEmSJG3Ia7IFsQI/woAtSZIkSRuxXVxnRMDO0j4mSZIkSZ3lTvawGbAlSZIkqUaG7OEyYEuSJElSzQzZw3SCAVuSJEmSamfIHp4jDNiSJEmS1AhD9rAcAePSRUiSJElSXxmyh8OALUmSJEkNM2QPgwFbkiRJklpgyO6/5xiwJUmSJKkVhux+ew5MShchSZIkSUNhyO4vA7YkSZIktcyQ3U8GbEmSJEkq4GHpAlSrC+Ie2KeF65AkSZKkQXInuz8M2JIkSZJUmCG7HwzYkiRJkpSAIbv7DNiSJEmSlIQhu9vOgD0M2JIkSZKUggefddcZsYM9L1yHJEmSJGnBnexuMmBLkiRJUkJD3Ml+Q/fD6SHd/x4kSZIkqXf+H6LM3zem4rMaAAAAAElFTkSuQmCC"></h1>' +
      '<p class="lede">Your private net worth, investments, expenses and tax - tracked entirely on this PC. Set the basics below; everything is editable later in Settings.</p>' +
      '<div class="wlc-props">' +
      '<span class="wlc-prop">' + icon("shield") + "100% private</span>" +
      '<span class="wlc-prop">' + icon("check") + "Works offline</span>" +
      '<span class="wlc-prop">' + icon("lock") + "No account, no cloud</span>" +
      "</div></div>" +
      '<div class="wizard-language-step"><div class="panel mb"><h2>Choose your language</h2><p class="hint">Choose the interface language. You can change it later in Settings.</p>' + languageControls() + "</div></div>" +
      '<div class="wizard-theme-step"><div class="panel mb"><h2>Theme</h2><p class="hint">Choose the interface style you want to start with. You can change it later in Settings.</p>' + themeControls() + "</div></div>" +
      configSections(true, step) +
      '<div class="finishbar"><div class="fb-txt">' + (last ? "Finish setup now. Imports and backups live in Settings &gt; Your Data." : "You only need a <strong>base currency</strong> to begin. Change anything later in Settings.") + '</div>' +
      '<div class="wiz-nav">' + (step > 0 ? '<button class="btn" data-act="wizard-back">Back</button>' : "") +
      '<button class="btn primary wiz-go" data-act="' + (last ? "finish-setup" : "wizard-next") + '">' + (last ? "Finish Setup" : "Next") + "</button></div></div>" +
      "</div></div>";
  }

  function captureProfileForm(requireBase) {
    if (!document.getElementById("set-base")) return true;
    var nextBase = val("set-base");
    if (requireBase && !nextBase) { toast("Choose a primary currency"); return false; }
    db.settings.name = val("set-name").trim() || "Valutio";
    if (nextBase && nextBase !== "__add__") {
      var oldBase = db.settings.baseCurrency;
      var baseChanged = rebaseCurrencyPool(nextBase);
      if (db.tax && (!db.tax.currency || !db.setupComplete || db.tax.currency === oldBase)) {
        db.tax.currency = db.settings.baseCurrency;
      }
      if (baseChanged && navigator.onLine) {
        fetchFX().then(function (ok) { if (ok) { recomputeAllSnapshots(); save(); render(); } }).catch(function () { });
      }
    }
    var sec = val("set-sec");
    if (sec !== "__add__") {
      db.settings.secondaryCurrency = sec;
      if (sec) {
        ensureCurrency(sec);
        var sc = curByCode(sec);
        if (sc && sec !== base()) { var sr = metaRateInBase(sec); if (sr) sc.rate = num(sr); }
        if (navigator.onLine) {
          fetchFX().then(function (ok) { if (ok) { recomputeAllSnapshots(); save(); render(); } }).catch(function () { });
        }
      }
    }
    pruneCurrencies();
    recomputeAllSnapshots();
    save();
    return true;
  }

  // ----------------------------------------------------------
  // Modals: entity forms
  // ----------------------------------------------------------
  function renameWalletModal() {
    openModal({
      title: "Wallet Name",
      sub: "Shown in the top-left, next to the brand mark.",
      body:
        '<div class="field"><label>Wallet name</label><input id="w-name" value="' + esc(db.settings.name || "") + '" placeholder="e.g. My Wallet" required></div>',
      submitLabel: "Save",
      onSubmit: function () {
        var n = val("w-name").trim(); if (!n) return false;
        db.settings.name = n;
        save(); render(); toast("Saved");
      },
    });
  }

  // Month-end "update everything" flow: ONE modal listing every live account, asset and debt with its
  // current figure prefilled - tab through, type the new statement values, one Save. Native-currency
  // amounts (joint accounts take the FULL statement balance, same as their own edit modal).
  function updateBalancesModal() {
    if (!db.accounts.length && !(db.physicalAssets || []).length && !(db.debts || []).length) { toast("Nothing to update yet"); return; }
    var row = function (pfx, id, name, meta, cur, v) {
      return '<div class="ub-row"><div class="ub-info"><div class="ub-name">' + esc(name) + '</div><div class="ub-meta">' + esc(meta) + '</div></div>' +
        '<div class="ub-in"><input id="' + pfx + id + '" type="number" step="0.01" value="' + esc(v) + '"><span class="ub-cur">' + esc(cur) + '</span></div></div>';
    };
    var accs = db.accounts.map(function (a) {
      return row("ub-a-", a.id, a.name, (a.bucket || "Cash") + (isJoint(a) ? " - joint - full balance" : ""), a.currency, num(a.balance));
    }).join("");
    var assets = (db.physicalAssets || []).map(function (a) {
      return row("ub-p-", a.id, a.name, a.category || "Asset", a.currency, num(a.value));
    }).join("");
    var debts = (db.debts || []).map(function (d) {
      return row("ub-d-", d.id, d.name, debtType(d.type).label, d.currency, num(d.balance));
    }).join("");
    var sec = function (t, h) { return h ? '<div class="section-title">' + t + '</div>' + h : ""; };
    openModal({
      title: "Update Balances",
      wide: true,
      sub: "Type each current value straight from your statements - Tab jumps to the next field, one Save applies everything.",
      body: '<div class="ub-list">' + sec("Accounts", accs) + sec("Assets", assets) + sec("Debts", debts) + "</div>",
      submitLabel: "Save All",
      onSubmit: function () {
        var changed = 0;
        var apply = function (list, pfx, key) {
          (list || []).forEach(function (x) {
            var e = document.getElementById(pfx + x.id); if (!e) return;
            var v = num(e.value);
            if (v !== num(x[key])) { x[key] = v; changed++; }
          });
        };
        apply(db.accounts, "ub-a-", "balance");
        apply(db.physicalAssets, "ub-p-", "value");
        apply(db.debts, "ub-d-", "balance");
        recomputeAllSnapshots(); save(); render();
        toast(changed ? "Updated " + changed + " balance" + (changed === 1 ? "" : "s") : "No changes");
      },
    });
  }
  function accountModal(existing) {
    var a = existing || { name: "", currency: base(), bucket: "Cash", balance: "", joint: false, share: "", coOwner: "" };
    var standardBuckets = ["Cash", "Savings", "Pension", "Other"];
    var isCustom = a.bucket && standardBuckets.indexOf(a.bucket) < 0; // editing an account with a custom type
    var bucketSel = isCustom ? "Other" : a.bucket;
    openModal({
      title: existing ? "Edit Account" : "Add Account",
      body:
        '<div class="field"><label>Name</label><input id="a-name" value="' + esc(a.name) + '" placeholder="e.g. Revolut, ING Savings" required></div>' +
        '<div class="row"><div class="field"><label>Type</label><select id="a-bucket">' +
        selectOptions(standardBuckets, bucketSel) + "</select></div>" +
        '<div class="field"><label>Currency</label><select id="a-cur">' + currencyOptions(a.currency) + "</select></div></div>" +
        '<div class="field" id="a-bucket-other-wrap" style="' + (bucketSel === "Other" ? "" : "display:none") + '">' +
        '<label>Custom type label</label><input id="a-bucket-other" value="' + (isCustom ? esc(a.bucket) : "") + '" placeholder="e.g. Property, Vehicle, Crypto wallet"></div>' +
        '<div class="field"><label>Current balance</label><input id="a-bal" type="number" step="0.01" value="' + esc(a.balance) + '" placeholder="0.00" required></div>' +
        '<div class="field"><label class="check-row"><input type="checkbox" id="a-joint"' + (a.joint ? " checked" : "") + "> Joint account (shared with someone else)</label></div>" +
        '<div id="a-joint-wrap" style="' + (a.joint ? "" : "display:none") + '">' +
          '<div class="row">' +
            '<div class="field"><label>Your share (%)</label><input id="a-share" type="number" step="1" min="0" max="100" value="' + esc(a.share === "" || a.share == null ? 50 : a.share) + '" placeholder="50"></div>' +
            '<div class="field"><label>Co-owner (optional)</label><input id="a-coowner" value="' + esc(a.coOwner || "") + '" placeholder="e.g. Partner"></div>' +
          '</div>' +
          '<p class="hint" style="margin-top:2px">Enter the full account balance above - only your share counts toward your net worth.</p>' +
        '</div>',
      onSubmit: function () {
        var name = val("a-name").trim(); if (!name) return false;
        var bucket = val("a-bucket");
        if (bucket === "Other") { var custom = val("a-bucket-other").trim(); if (custom) bucket = custom; }
        var joint = checked("a-joint");
        var sv = val("a-share");
        var share = joint ? (sv === "" ? 50 : Math.max(0, Math.min(100, num(sv)))) : 100;
        var obj = { id: existing ? existing.id : uid(), name: name, bucket: bucket, currency: val("a-cur"), balance: num(val("a-bal")), joint: joint, share: share, coOwner: joint ? val("a-coowner").trim() : "" };
        if (existing) { var i = db.accounts.findIndex(function (x) { return x.id === existing.id; }); db.accounts[i] = obj; }
        else db.accounts.push(obj);
        recomputeAllSnapshots();   // re-lens the live month for a changed joint share (closed months stay frozen)
        save(); render(); toast("Account saved");
      },
    });
  }

  function holdingModal(existing) {
    var h = existing || { name: "", ticker: "", type: "stock", currency: base(), price: "", coingeckoId: "", apiSymbol: "" };
    var holdToday = new Date().toISOString().slice(0, 10), holdDate = holdToday.slice(0, 7) === state.month ? holdToday : state.month + "-15";
    var initial = !existing ?
      '<div class="section-title" style="margin-top:18px">Initial position</div>' +
      '<div class="row"><div class="field"><label id="h-qty-label">Shares</label><input id="h-shares" type="number" step="any" min="0" placeholder="0" required></div>' +
      '<div class="field"><label id="h-buy-label">Buy price</label><input id="h-buy" type="number" step="any" min="0" placeholder="0.00" required></div>' +
      '<div class="field"><label>Fees</label><input id="h-fees" type="number" step="any" min="0" placeholder="0"></div>' +
      '<div class="field"><label>Trade date</label><input id="h-date" type="date" value="' + holdDate + '" required></div></div>' : "";
    openModal({
      title: existing ? "Edit Holding" : "Add Holding",
      wide: true,
      body:
        '<p class="hint" id="h-form-desc" style="margin:8px 0 18px">Set the Type, then search by name or ticker to auto-fill - live prices from (Yahoo Finance &amp; CoinGecko).</p>' +
        '<div class="row" style="gap:8px">' +
        '<div class="field" style="flex:0 0 150px"><label>Type</label><select id="h-type">' +
        db.holdingTypes.slice().sort(function (a, b) { var ord = { stock: 0, etf: 1, bond: 2, commodity: 3, crypto: 4, realestate: 5 }; return (ord[a.key] == null ? 99 : ord[a.key]) - (ord[b.key] == null ? 99 : ord[b.key]); }).map(function (tt) { return '<option value="' + esc(tt.key) + '"' + (tt.key === h.type ? " selected" : "") + ">" + esc(tt.label) + "</option>"; }).join("") +
        '<option value="__add__">+ Add a type</option></select></div>' +
        '<div class="field" id="h-search-field" style="flex:1"><label>Search to auto-fill</label><input id="h-search" placeholder="Search a name or ticker: Apple, VWCE, Bitcoin…" autocomplete="off"></div>' +
        '<div class="field" id="h-searchbtn-field" style="flex:0 0 auto"><label>&nbsp;</label><button type="button" class="btn" data-act="holding-search">' + SEARCH_ICON + ' Search</button></div></div>' +
        '<div id="h-search-results" class="search-results"></div>' +
        '<p class="hint" id="h-search-hint" style="margin:8px 0 18px">If auto-search fails to fetch the exact API symbol, please look up for the correct symbol/ticker on <a href="https://finance.yahoo.com/" target="_blank" rel="noopener">https://finance.yahoo.com/</a>.</p>' +
        '<div class="row"><div class="field"><label>Name</label><input id="h-name" value="' + esc(h.name) + '" placeholder="e.g. Apple, VWCE, Bitcoin" required></div>' +
        '<div class="field" id="h-ticker-field"><label>Ticker (optional)</label><input id="h-ticker" value="' + esc(h.ticker) + '" placeholder="AAPL"></div>' +
        '<div class="field"><label>Currency</label><select id="h-cur">' + currencyOptions(h.currency) + "</select></div></div>" +
        '<div class="row"><div class="field"><label id="h-price-label">Current price</label><input id="h-price" type="number" step="any" min="0" value="' + esc(h.price) + '" placeholder="0.00"></div>' +
        '<div class="field" id="h-api-field"><label>API symbol</label><input id="h-api" value="' + esc(h.apiSymbol) + '" placeholder="AAPL, AMD…"></div>' +
        '<div class="field" id="h-cg-field"><label>CoinGecko id</label><input id="h-cg" value="' + esc(h.coingeckoId) + '" placeholder="bitcoin, ethereum…"></div></div>' +
        initial,
      onSubmit: function () {
        var name = val("h-name").trim(); if (!name) return false;
        var curPrice = num(val("h-price"));
        if (curPrice < 0) { toast("Current price cannot be negative"); return false; }
        if (existing) {
          var oldCur = existing.currency, newCur = val("h-cur");
          existing.name = name; existing.ticker = val("h-ticker").trim();
          existing.type = val("h-type"); existing.currency = newCur;
          existing.price = curPrice; existing.apiSymbol = val("h-api").trim();
          existing.coingeckoId = val("h-cg").trim();
          if (oldCur && newCur && oldCur !== newCur && curByCode(oldCur) && curByCode(newCur))
            setTimeout(function () { currencyChangePrompt(existing, oldCur, newCur); }, 0);   // offer convert vs relabel after this modal closes
        } else {
          var shRaw = normalizedDecimal(val("h-shares")), buyRaw = normalizedDecimal(val("h-buy")), feeRaw = normalizedDecimal(val("h-fees"));
          var sh = num(shRaw), buy = num(buyRaw), fees = num(feeRaw), tradeDate = val("h-date");
          if (!validDateString(tradeDate)) { toast("Enter a valid trade date"); return false; }
          if (!(sh > 0)) { toast("Enter the initial position"); return false; }
          if (!(buy > 0)) { toast("Enter a buy price greater than zero"); return false; }
          if (fees < 0) { toast("Fees cannot be negative"); return false; }
          var obj = {
            id: uid(), name: name, ticker: val("h-ticker").trim(), type: val("h-type"),
            currency: val("h-cur"), price: curPrice, apiSymbol: val("h-api").trim(),
            coingeckoId: val("h-cg").trim(), transactions: [], realizedSeed: 0,
          };
          obj.transactions.push({ id: uid(), month: tradeDate.slice(0, 7), date: tradeDate, datePrecision: "day", sequence: 10, type: "buy", shares: shRaw, price: buyRaw, fees: feeRaw });
          db.holdings.push(obj);
        }
        recomputeAllSnapshots();   // a currency/type change re-syncs the live month at once (closed months stay frozen)
        save(); render(); toast("Holding saved");
      },
    });
    // Type-aware form: show/hide fields and relabel quantity/price for the selected type.
    function holdingTypeUI() {
      var sel = document.getElementById("h-type"); if (!sel) return;
      var t = sel.value; if (t === "__add__") return;
      var crypto = t === "crypto", manual = t === "realestate", market = !manual;
      var show = function (id, on) { var e = document.getElementById(id); if (e) e.style.display = on ? "" : "none"; };
      var label = function (id, txt) { var e = document.getElementById(id); if (e) e.textContent = txt; };
      show("h-search-field", market); show("h-searchbtn-field", market); show("h-search-hint", market);
      show("h-ticker-field", market); show("h-api-field", market); show("h-cg-field", crypto);
      if (!market) { var rb = document.getElementById("h-search-results"); if (rb) rb.innerHTML = ""; }
      label("h-qty-label", (t === "stock" || t === "etf") ? "Shares" : "Units");
      label("h-price-label", manual ? "Current value" : "Current price");
      label("h-buy-label", manual ? "Purchase price" : "Buy price");
      var d = document.getElementById("h-form-desc");
      if (d) d.innerHTML = manual
        ? "Real Estate is tracked manually - enter its name, value and units below (no live price)."
        : "Set the Type, then search by name or ticker to auto-fill - live prices from (Yahoo Finance &amp; CoinGecko).";
      applyLanguageUI(document.getElementById("modal-root"));
    }
    var hts = document.getElementById("h-type");
    if (hts) hts.addEventListener("change", holdingTypeUI);
    holdingTypeUI();
  }
  // After a holding's currency is changed in the editor, its numbers are kept as-is (just relabelled).
  // Offer to genuinely re-denominate every price/fee - and its frozen history - into the new currency at
  // the current rate. Cancel keeps the relabelled values.
  function currencyChangePrompt(h, from, to) {
    openModal({
      title: "Currency changed to " + esc(to),
      sub: esc(h.name) + "'s prices are kept as-is and simply relabelled " + esc(from) + " → " + esc(to) + ".",
      body: '<div class="help-box" style="margin:0">If those figures were actually in <strong>' + esc(from) + "</strong>, convert every buy/sell price &amp; fee (and this holding's frozen history) into <strong>" + esc(to) + "</strong> at the current rate. Otherwise keep them as-is.</div>",
      submitLabel: "Convert to " + esc(to),
      onSubmit: function () {
        var f = convert(1, from, to);
        (h.transactions || []).forEach(function (t) { t.price = num(t.price) * f; t.fees = num(t.fees) * f; });
        h.price = num(h.price) * f;
        (db.snapshots || []).forEach(function (s) { var fr = s.holdings && s.holdings[h.id]; if (fr) fr.price = num(fr.price) * f; });
        repropagateHolding(h); save(); render();
        toast("Converted " + h.name + " to " + to);
      },
    });
  }

  // ----- Holding search (auto-fill the Add/Edit Holding form) -----
  // Crypto: CoinGecko search (free, no key). Stocks/ETFs: the configured provider's symbol search.
  function renderHoldingResults(box, items, emptyMsg) {
    if (!items.length) { box.innerHTML = '<div class="muted" style="padding:8px 2px">' + esc(emptyMsg) + "</div>"; return; }
    box.innerHTML = items.map(function (it) {
      return '<button type="button" class="search-result" data-act="pick-search-result"' +
        ' data-name="' + esc(it.name || "") + '" data-ticker="' + esc(it.ticker || "") + '"' +
        ' data-api="' + esc(it.apiSymbol || "") + '" data-cg="' + esc(it.coingeckoId || "") + '">' +
        '<span class="sr-name">' + esc(it.name || it.ticker || "?") + "</span>" +
        '<span class="sr-meta">' + esc((it.ticker || "") + (it.sub ? " - " + it.sub : "")) + "</span></button>";
    }).join("");
  }
  function holdingSearchRun() {
    var box = document.getElementById("h-search-results");
    if (!box) return;
    var q = (val("h-search") || "").trim();
    if (!q) { box.innerHTML = ""; return; }
    box.innerHTML = '<div class="muted" style="padding:8px 2px">Searching…</div>';
    if (val("h-type") === "crypto") {
      fetch("https://api.coingecko.com/api/v3/search?query=" + encodeURIComponent(q))
        .then(function (r) { return r.json(); })
        .then(function (j) {
          renderHoldingResults(box, ((j && j.coins) || []).slice(0, 12).map(function (c) {
            return { name: c.name, ticker: (c.symbol || "").toUpperCase(), coingeckoId: c.id, sub: "id: " + c.id };
          }), "No coins matched. Try another name.");
        })
        .catch(function () { box.innerHTML = '<div class="muted" style="padding:8px 2px">Couldn\'t reach CoinGecko. Check your connection.</div>'; });
      return;
    }
    // Stocks & ETFs: keyless Yahoo Finance symbol search through the same proxy chain as quotes.
    yahooFetch("/v1/finance/search?q=" + encodeURIComponent(q)).then(function (j) {
      if (!j) throw 0;   // every proxy route failed -> the catch's "Search failed" message
      var rows = ((j && j.quotes) || []).filter(function (r) { return r.symbol && r.quoteType !== "CRYPTOCURRENCY"; }).map(function (r) {
        return { name: r.shortname || r.longname || r.symbol, ticker: r.symbol, apiSymbol: r.symbol, sub: [r.exchDisp || r.exchange, r.typeDisp || r.quoteType].filter(Boolean).join(" - ") };
      });
      renderHoldingResults(box, rows.slice(0, 12), "No matches. Try the ticker, or enter it by hand.");
    }).catch(function () { box.innerHTML = '<div class="muted" style="padding:8px 2px">Search failed. Check your connection, or enter the symbol by hand.</div>'; });
  }

  function priceModal(h) {
    openModal({
      title: "Update Price: " + h.name,
      sub: "Enter the current market price in " + esc(h.currency) + ".",
      body: '<div class="field"><label>Current price (' + esc(h.currency) + ')</label><input id="p-price" type="number" step="any" min="0" value="' + esc(h.price) + '" required></div>',
      submitLabel: "Update",
      onSubmit: function () {
        var p = num(val("p-price")); if (p < 0) { toast("Price cannot be negative"); return false; }
        h.price = p; recomputeAllSnapshots(); save(); render(); toast("Price updated");
      },
    });
  }

  // Add a buy or sell transaction to a holding (the per-month entry, like the sheet)
  function transactionModal(h, type) {
    type = type === "sell" ? "sell" : "buy";
    var m = holdingMetrics(h);
    var isSell = type === "sell";
    var today = new Date().toISOString().slice(0, 10), defaultDate = today.slice(0, 7) === state.month ? today : state.month + "-15";
    openModal({
      title: (isSell ? "Sell: " : "Buy: ") + h.name,
      sub: isSell
        ? "You currently hold " + (+m.shares.toFixed(6)) + " @ avg cost " + fmt(m.cost / (m.shares || 1), h.currency) + ". Realized P/L is computed automatically."
        : "Record a purchase. Cost = shares × price + fees is computed automatically.",
      body:
        '<div class="row"><div class="field"><label>Trade date</label><input id="tx-date" type="date" value="' + defaultDate + '" required></div>' +
        '<div class="field"><label>' + (isSell ? "Shares to sell" : "Shares bought") + '</label><input id="tx-sh" type="number" step="any" min="0" value="' + (isSell ? (+m.shares.toFixed(6)) : "") + '" placeholder="0" required></div></div>' +
        '<div class="row"><div class="field"><label>' + (isSell ? "Sale price" : "Buy price") + " (" + esc(h.currency) + ')</label><input id="tx-pr" type="number" step="any" min="0" value="' + (m.price || "") + '" placeholder="0.00" required></div>' +
        '<div class="field"><label>Fees (' + esc(h.currency) + ')</label><input id="tx-fee" type="number" step="any" min="0" value="0"></div></div>',
      submitLabel: isSell ? "Record Sale" : "Record Buy",
      onSubmit: function () {
        var shRaw = normalizedDecimal(val("tx-sh")), prRaw = normalizedDecimal(val("tx-pr")), feeRaw = normalizedDecimal(val("tx-fee"));
        var sh = num(shRaw), pr = num(prRaw), fee = num(feeRaw), date = val("tx-date");
        if (!validDateString(date)) { toast("Enter a valid trade date"); return false; }
        if (sh <= 0) { toast("Enter a share amount"); return false; }
        if (pr <= 0) { toast("Enter a price greater than zero"); return false; }
        if (fee < 0) { toast("Fees cannot be negative"); return false; }
        var newTxn = { id: uid(), month: date.slice(0, 7), date: date, datePrecision: "day", sequence: nextTransactionSequence(h), type: type, shares: shRaw, price: prRaw, fees: feeRaw };
        // Reject a sell that exceeds the position held AT ITS MONTH (a backdated sell can pass a "shares now"
        // check yet be impossible mid-history).
        if (isSell && txnsOversell((h.transactions || []).concat([newTxn]))) { toast("That sell exceeds the shares held that month"); return false; }
        h.transactions = h.transactions || [];
        h.transactions.push(newTxn);
        repropagateHolding(h); save(); render();
        toast(isSell ? "Sale recorded" : "Purchase recorded");
      },
    });
  }
  // Edit an existing buy/sell in place. Correcting the action, month, shares, price or fees re-derives
  // this holding's per-month snapshot records (back-propagation) so historical averages stay in sync.
  function transactionEditModal(h, t) {
    if (!h || !t) return;
    openModal({
      title: "Edit transaction - " + h.name,
      sub: "Correcting a buy/sell re-derives this holding's averages across every month it spans.",
      body:
        '<div class="row"><div class="field"><label>Action</label><select id="tx-type"><option value="buy"' + (t.type !== "sell" ? " selected" : "") + ">Buy</option><option value=\"sell\"" + (t.type === "sell" ? " selected" : "") + ">Sell</option></select></div>" +
        '<div class="field"><label>Trade date</label><input id="tx-date" type="date" value="' + esc(validDateString(t.date) ? t.date : t.month + "-15") + '" required></div></div>' +
        '<div class="row"><div class="field"><label>Shares</label><input id="tx-sh" type="number" step="any" min="0" value="' + esc(t.shares) + '" required></div>' +
        '<div class="field"><label>Price (' + esc(h.currency) + ')</label><input id="tx-pr" type="number" step="any" min="0" value="' + esc(t.price) + '" required></div></div>' +
        '<div class="field"><label>Fees (' + esc(h.currency) + ')</label><input id="tx-fee" type="number" step="any" min="0" value="' + esc(num(t.fees)) + '"></div>',
      submitLabel: "Save Changes",
      onSubmit: function () {
        var shRaw = normalizedDecimal(val("tx-sh")), prRaw = normalizedDecimal(val("tx-pr")), feeRaw = normalizedDecimal(val("tx-fee"));
        var sh = num(shRaw), pr = num(prRaw), fee = num(feeRaw), date = val("tx-date");
        if (!validDateString(date)) { toast("Enter a valid trade date"); return false; }
        if (sh <= 0) { toast("Enter a share amount"); return false; }
        if (pr <= 0) { toast("Enter a price greater than zero"); return false; }
        if (fee < 0) { toast("Fees cannot be negative"); return false; }
        var edited = { id: t.id, type: val("tx-type") === "sell" ? "sell" : "buy", month: date.slice(0, 7), date: date, datePrecision: "day", sequence: finiteNumber(t.sequence) || nextTransactionSequence(h), shares: shRaw, price: prRaw, fees: feeRaw };
        // Simulate the ledger with this edit applied; reject if it would sell more than held at any point.
        if (txnsOversell((h.transactions || []).map(function (x) { return x === t ? edited : x; }))) { toast("That edit would sell more shares than were held at that date"); return false; }
        t.type = edited.type; t.month = edited.month; t.date = date; t.datePrecision = "day"; t.sequence = edited.sequence;
        t.shares = shRaw; t.price = prRaw; t.fees = feeRaw;
        repropagateHolding(h); save(); render();
        toast("Transaction updated");
      },
    });
  }
  // Log / edit a cash dividend received from a holding (its own currency). Manual - the price providers
  // return prices only, not payouts. Feeds the holding's yield + the tax estimate (dividendsInTaxYear).
  function dividendModal(h, existing) {
    if (!h) return;
    var d = existing || { month: state.month, amount: "", note: "" };
    openModal({
      title: (existing ? "Edit Dividend - " : "Add Dividend - ") + h.name,
      sub: "A cash distribution received from " + esc(h.name) + ", in " + esc(h.currency) + ". (Accumulating funds reinvest internally - skip them.)",
      body:
        '<div class="row"><div class="field"><label>Month</label>' + monthSelect("dv-month", d.month || state.month) + "</div>" +
        '<div class="field"><label>Amount (' + esc(h.currency) + ')</label><input id="dv-amt" type="number" step="any" value="' + esc(existing ? d.amount : "") + '" placeholder="0.00" required></div></div>' +
        '<div class="field"><label>Note (optional)</label><input id="dv-note" value="' + esc(d.note || "") + '" placeholder="e.g. Q2 distribution"></div>',
      submitLabel: existing ? "Save Changes" : "Add Dividend",
      onSubmit: function () {
        var amt = num(val("dv-amt")); if (!(amt > 0)) { toast("Enter an amount"); return false; }
        h.dividends = h.dividends || [];
        if (existing) { existing.month = val("dv-month"); existing.amount = amt; existing.note = val("dv-note").trim(); }
        else h.dividends.push({ id: uid(), month: val("dv-month"), amount: amt, note: val("dv-note").trim() });
        save(); render(); toast(existing ? "Dividend updated" : "Dividend added");
      },
    });
  }

  function ledgerEditModal(kind, id) {
    var isExp = kind === "expense";
    var arr = isExp ? db.expenses : db.incomes;
    var entry = arr.filter(function (x) { return x.id === id; })[0];
    if (!entry) return;
    var cats = isExp ? db.expenseCategories : db.incomeCategories;
    openModal({
      title: "Edit " + (isExp ? "Expense" : "Income"),
      body:
        '<div class="field"><label>Month</label>' + monthSelect("le-month", entry.month) + "</div>" +
        '<div class="row"><div class="field"><label>Category</label><select id="le-cat">' + selectOptions(cats, entry.category) + "</select></div>" +
        '<div class="field"><label>Currency</label><select id="le-cur">' + currencyOptions(entry.currency) + "</select></div></div>" +
        '<div class="field"><label>Amount</label><input id="le-amt" type="number" step="0.01" min="0.01" value="' + esc(entry.amount) + '" required></div>' +
        '<div class="field"><label>Note</label><input id="le-note" value="' + esc(entry.note || "") + '"></div>' +
        (isExp ?
          '<div class="field"><label class="check-row"><input type="checkbox" id="le-joint"' + (isJoint(entry) ? " checked" : "") + "> Joint expense (shared with someone else)</label></div>" +
          '<div id="le-joint-wrap" style="' + (isJoint(entry) ? "" : "display:none") + '">' +
            '<div class="row">' +
              '<div class="field"><label>Your share (%)</label><input id="le-share" type="number" step="1" min="0" max="100" value="' + esc(entry.share == null ? 50 : entry.share) + '"></div>' +
              '<div class="field"><label>Co-owner (optional)</label><input id="le-coowner" value="' + esc(entry.coOwner || "") + '" placeholder="e.g. Partner"></div>' +
            "</div>" +
            '<p class="hint" style="margin-top:2px">Enter the full amount above - only your share counts in your totals.</p>' +
          "</div>"
          : ""),
      onSubmit: function () {
        var amt = num(val("le-amt"));
        if (amt <= 0) { toast("Enter an amount greater than zero"); return false; }
        entry.month = val("le-month"); entry.category = val("le-cat"); entry.amount = amt;
        entry.currency = val("le-cur"); entry.note = val("le-note").trim();
        if (isExp) {
          var lj = checked("le-joint"), lsv = val("le-share");
          entry.joint = lj; entry.share = lj ? (lsv === "" ? 50 : Math.max(0, Math.min(100, num(lsv)))) : 100;
          entry.coOwner = lj ? val("le-coowner").trim() : "";
        }
        recomputeAllSnapshots(); save(); render(); toast("Updated");
      },
    });
  }
  // Edit a holding's frozen values for a past month (Note 7).
  function frozenHoldingEditModal(h, m) {
    if (!h) return;
    var s = snapByMonth(m);
    var fr = (s && s.holdings) ? s.holdings[h.id] : null;
    var v = fr || { shares: "", buyPrice: "", fees: "", price: "", realized: "" };
    openModal({
      title: "Edit " + h.name + " - " + monthLabel(m),
      sub: "Frozen values for " + esc(monthLabel(m)) + ", in " + esc(h.currency) + ". These don't change with live prices.",
      wide: true,
      body:
        '<div class="row"><div class="field"><label>Shares</label><input id="fh-sh" type="number" step="any" value="' + esc(v.shares) + '"></div>' +
        '<div class="field"><label>Avg buy price</label><input id="fh-bp" type="number" step="any" value="' + esc(v.buyPrice) + '"></div></div>' +
        '<div class="row"><div class="field"><label>Fees</label><input id="fh-fee" type="number" step="any" value="' + esc(v.fees) + '"></div>' +
        '<div class="field"><label>Price</label><input id="fh-pr" type="number" step="any" value="' + esc(v.price) + '"></div>' +
        '<div class="field"><label>Realized P/L</label><input id="fh-rl" type="number" step="any" value="' + esc(v.realized) + '"></div></div>' +
        '<div class="help-box" style="margin:6px 0 0">Cost = shares × avg buy + fees; Value = shares × price. Leave blank/0 if you didn\'t hold this in ' + esc(monthLabel(m)) + ".</div>",
      onSubmit: function () {
        var snap2 = ensureSnapshot(m);
        materializeSnapshotBuckets(snap2);   // don't let the re-total wipe an aggregate-only month
        var rec = snap2.holdings[h.id] || {};
        rec.shares = num(val("fh-sh")); rec.buyPrice = num(val("fh-bp")); rec.fees = num(val("fh-fee"));
        rec.price = num(val("fh-pr")); rec.realized = num(val("fh-rl"));
        rec.type = h.type; rec.currency = h.currency;
        // Re-anchor the locked rate to the CURRENT currency's frozen rate (a since-changed holding currency
        // must not keep the old currency's rate). Fall back to the live rate, then any existing rate.
        rec.rate = (snap2.rates && snap2.rates[h.currency] != null) ? num(snap2.rates[h.currency]) : ((curByCode(h.currency) || {}).rate || num(rec.rate) || 1);
        snap2.holdings[h.id] = rec;
        recomputeSnapshot(snap2, null, true); save(); render(); toast("Saved " + monthLabel(m));   // frozenEdit: re-total this month only, no FX reprojection
      },
    });
  }
  // Edit an account's frozen balance for a past month (Note 7).
  function frozenAccountEditModal(a, m) {
    if (!a) return;
    var s = snapByMonth(m);
    var fr = (s && s.accounts) ? s.accounts[a.id] : null;
    openModal({
      title: "Edit " + a.name + " - " + monthLabel(m),
      sub: "Frozen balance for " + esc(monthLabel(m)) + ", in " + esc(a.currency) + ".",
      body: '<div class="field"><label>Balance (' + esc(a.currency) + ")</label><input id=\"fa-bal\" type=\"number\" step=\"0.01\" value=\"" + esc(fr ? fr.balance : "") + '" required></div>',
      submitLabel: "Save",
      onSubmit: function () {
        var snap2 = ensureSnapshot(m);
        materializeSnapshotBuckets(snap2);   // don't let the re-total wipe an aggregate-only month
        // Convert the manually-entered balance at the rate this month froze with, so the month stays
        // anchored to its own FX; fall back to the current rate only for legacy months with no stored rate.
        var rate = (snap2.rates && snap2.rates[a.currency] != null) ? num(snap2.rates[a.currency]) : (curByCode(a.currency) || {}).rate || 1;
        var bal = num(val("fa-bal"));
        // balanceBase must be the OWNED base (share applied) to match buildSnapshot; the frozen re-total
        // sums it raw, so a joint account (share < 100) would over-count net worth without shareFrac here.
        snap2.accounts[a.id] = { name: a.name, bucket: a.bucket, currency: a.currency, balance: bal, balanceBase: bal * rate * shareFrac(a.share), share: a.share == null ? 100 : num(a.share) };
        recomputeSnapshot(snap2, null, true); save(); render(); toast("Saved " + monthLabel(m));   // frozenEdit: re-total this month only, no FX reprojection
      },
    });
  }

  // Add an account to a single FROZEN month (someone forgot to add it before the month closed). This
  // writes ONLY into that month's snapshot - it never touches db.accounts (the live roster) or any other
  // month. Same fields as accountModal, but the entry lives in snap.accounts and the month re-totals via
  // the frozenEdit path (no FX reprojection - the month keeps its locked rates).
  function frozenAccountAddModal(m) {
    var standardBuckets = ["Cash", "Savings", "Pension", "Other"];
    openModal({
      title: "Add Account - " + monthLabel(m),
      sub: "Adds an account to " + esc(monthLabel(m)) + " only - this frozen month, not your live accounts.",
      body:
        '<div class="field"><label>Name</label><input id="a-name" placeholder="e.g. Revolut, ING Savings" required></div>' +
        '<div class="row"><div class="field"><label>Type</label><select id="a-bucket">' +
        selectOptions(standardBuckets, "Cash") + "</select></div>" +
        '<div class="field"><label>Currency</label><select id="a-cur">' + currencyOptions(base()) + "</select></div></div>" +
        '<div class="field" id="a-bucket-other-wrap" style="display:none">' +
        '<label>Custom type label</label><input id="a-bucket-other" placeholder="e.g. Property, Vehicle, Crypto wallet"></div>' +
        '<div class="field"><label>Balance</label><input id="a-bal" type="number" step="0.01" placeholder="0.00" required></div>' +
        '<div class="field"><label class="check-row"><input type="checkbox" id="a-joint"> Joint account (shared with someone else)</label></div>' +
        '<div id="a-joint-wrap" style="display:none">' +
          '<div class="row">' +
            '<div class="field"><label>Your share (%)</label><input id="a-share" type="number" step="1" min="0" max="100" value="50" placeholder="50"></div>' +
            '<div class="field"><label>Co-owner (optional)</label><input id="a-coowner" placeholder="e.g. Partner"></div>' +
          '</div>' +
          '<p class="hint" style="margin-top:2px">Enter the full account balance above - only your share counts toward your net worth.</p>' +
        '</div>',
      submitLabel: "Add",
      onSubmit: function () {
        var name = val("a-name").trim(); if (!name) return false;
        var bucket = val("a-bucket");
        if (bucket === "Other") { var custom = val("a-bucket-other").trim(); if (custom) bucket = custom; }
        var joint = checked("a-joint");
        var sv = val("a-share");
        var share = joint ? (sv === "" ? 50 : Math.max(0, Math.min(100, num(sv)))) : 100;
        var cur = val("a-cur");
        var bal = num(val("a-bal"));
        var snap = ensureSnapshot(m);
        materializeSnapshotBuckets(snap);   // don't let the re-total wipe an aggregate-only month
        // Value at the rate this month froze with (never the live rate); fall back to the current pool
        // rate only for a currency with no stored frozen rate. Store OWNED base (share applied) to match
        // buildSnapshot, since the frozen re-total sums balanceBase raw.
        var rate = (snap.rates && snap.rates[cur] != null) ? num(snap.rates[cur]) : (curByCode(cur) || {}).rate || 1;
        snap.accounts[uid()] = { name: name, bucket: bucket, currency: cur, balance: bal, balanceBase: bal * rate * shareFrac(share), share: share };
        recomputeSnapshot(snap, null, true); save(); render(); toast("Added to " + monthLabel(m));
      },
    });
  }

  // Historical FX on a given date. Free, no key, CORS-friendly. Returns rate from->to, or null.
  // Primary: jsDelivr currency-api (daily history). Fallbacks: its mirror, then frankfurter (ECB).
  function fetchHistoricalRate(from, to, date) {
    if (from === to) return Promise.resolve(1);
    var f = from.toLowerCase(), tt = to.toLowerCase();
    var urls = [
      "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@" + date + "/v1/currencies/" + f + ".json",
      "https://" + date + ".currency-api.pages.dev/v1/currencies/" + f + ".json",
      "https://api.frankfurter.app/" + date + "?from=" + from + "&to=" + to,
    ];
    var tryUrl = function (i) {
      if (i >= urls.length) return Promise.resolve(null);
      return fetch(urls[i]).then(function (r) { if (!r.ok) throw 0; return r.json(); }).then(function (j) {
        var rate = null;
        if (j[f] && j[f][tt] != null) rate = num(j[f][tt]);          // currency-api shape
        else if (j.rates && j.rates[to] != null) rate = num(j.rates[to]); // frankfurter shape
        return rate || tryUrl(i + 1);
      }).catch(function () { return tryUrl(i + 1); });
    };
    return tryUrl(0);
  }
  function invoiceModal(existing) {
    var iv0 = existing || {};
    var t = viewedTax();   // add/edit invoices on the year being viewed (live or a frozen archived year)
    var dateWindow = fyDateWindow(t.year, t.country);
    var invoiceToday = new Date().toISOString().slice(0, 10), invoiceDefault = dateInTaxYear(invoiceToday, t) ? invoiceToday : dateWindow.end;
    openModal({
      title: existing ? "Edit Invoice" : "Add Invoice",
      sub: "Each freelance invoice you send, counted toward your taxable income.",
      body:
        '<div class="row"><div class="field"><label>Date</label><input id="iv-date" type="date" min="' + dateWindow.start + '" max="' + dateWindow.end + '" value="' + esc(iv0.date || invoiceDefault) + '"></div>' +
        '<div class="field"><label>Currency</label><select id="iv-cur">' + currencyOptions(iv0.currency || t.currency) + "</select></div></div>" +
        '<div class="field"><label>Amount (gross)</label><input id="iv-amt" type="number" step="0.01" min="0.01" value="' + esc(existing ? iv0.amount : "") + '" required></div>' +
        '<div class="field"><label>Note (client / invoice #)</label><input id="iv-note" value="' + esc(iv0.note || "") + '" placeholder="Invoice 01, Client"></div>' +
        '<div class="help-box" style="margin:6px 0 0">If the invoice currency differs from your tax currency (' + esc(t.currency) + "), the exchange rate <strong>on the invoice date</strong> is looked up and locked in.</div>",
      onSubmit: function () {
        var date = val("iv-date"), cur = val("iv-cur"), amount = num(val("iv-amt")), note = val("iv-note").trim();
        if (!validDateString(date)) { toast("Enter a valid invoice date"); return false; }
        if (!dateInTaxYear(date, t)) { toast("Invoice date must be inside " + t.year + " (" + dateWindow.start + " to " + dateWindow.end + ")"); return false; }
        if (amount <= 0) { toast("Invoice amount must be greater than zero"); return false; }
        var taxCur = t.currency;
        var inv = existing || { id: uid() };
        var keepRate = !!(existing && inv.fxRate && inv.currency === cur && inv.date === date); // FX inputs unchanged -> keep locked rate
        inv.date = date; inv.taxYear = t.year; delete inv.legacyYearMismatch; inv.amount = amount; inv.currency = cur; inv.note = note;
        if (cur === taxCur) {
          delete inv.fxRate; delete inv.fxDate;
          if (!existing) t.invoices.push(inv);
          syncArchivedInvoiceSnapshot(t);
          save(); render(); toast(existing ? "Invoice updated" : "Invoice added");
          return; // handler closes the modal
        }
        if (keepRate) { syncArchivedInvoiceSnapshot(t); save(); render(); toast("Invoice updated"); return; }
        // different (or changed) currency/date: look up the dated rate, then save (modal closes immediately)
        toast("Looking up exchange rate…");
        fetchHistoricalRate(cur, taxCur, date).then(function (rate) {
          if (rate) { inv.fxRate = rate; inv.fxDate = date; }
          else { inv.fxRate = convert(1, cur, taxCur); } // fallback to today's rate
          if (!existing) t.invoices.push(inv);
          syncArchivedInvoiceSnapshot(t);
          save(); render();
          toast(rate ? "Invoice " + (existing ? "updated" : "added") + " at " + rate.toFixed(4) + " " + cur + "/" + taxCur : "Invoice " + (existing ? "updated" : "added") + " (today's rate, history unavailable)");
        });
      },
    });
  }

  function taxConfigModal() {
    var t = viewedTax(), frozen = (t !== db.tax);
    var bracketRow = function (upTo, rate) {
      return '<div class="row" data-bracket><div class="field"><label>Up to (' + esc(t.currency) + ')</label>' +
        '<input class="bk-upto" type="number" step="any" value="' + (upTo == null ? "" : upTo) + '" placeholder="∞ (top)"></div>' +
        '<div class="field"><label>Rate %</label><input class="bk-rate" type="number" step="any" value="' + rate + '"></div>' +
        '<button type="button" class="btn ghost bk-del" data-act="remove-bracket" title="Remove bracket">×</button></div>';
    };
    var adjustmentRow = function (name, type, mode, value) {
      return '<div class="row" data-adj><div class="field" style="flex:1.5"><label>Name</label>' +
        '<input class="adj-name" value="' + esc(name || "") + '" placeholder="e.g. Surcharge"></div>' +
        '<div class="field"><label>Effect</label><select class="adj-type">' +
        '<option value="add"' + (type !== "deduct" ? " selected" : "") + ">Add</option>" +
        '<option value="deduct"' + (type === "deduct" ? " selected" : "") + ">Deduct</option></select></div>" +
        '<div class="field"><label>Kind</label><select class="adj-mode">' +
        '<option value="fixed"' + (mode !== "percent" && mode !== "percentincome" ? " selected" : "") + ">Fixed</option>" +
        '<option value="percent"' + (mode === "percent" ? " selected" : "") + ">% of tax</option>" +
        '<option value="percentincome"' + (mode === "percentincome" ? " selected" : "") + ">% of total income</option></select></div>" +
        '<div class="field"><label>Value</label><input class="adj-value" type="number" step="any" value="' + esc(value == null ? "" : value) + '"></div>' +
        '<button type="button" class="btn ghost bk-del" data-act="remove-adjustment" title="Remove">×</button></div>';
    };
    var bracketFields = t.brackets.map(function (b) { return bracketRow(b.upTo, num(b.rate) * 100); }).join("");
    var adjFields = (t.adjustments || []).map(function (a) { return adjustmentRow(a.name, a.type, a.mode, a.value); }).join("");
    openModal({
      title: "Tax Settings",
      wide: true,
      sub: "Configure for your country. Brackets are progressive on total income above the tax-free threshold.",
      body:
        (frozen
          ? '<div class="field"><label>Country preset</label><div class="help-box" style="margin:0">You’re editing the frozen <strong>' + esc(t.year || "") + '</strong> year. The country preset is locked here - adjust the figures and brackets below, and the changes stay in this year only.</div></div>'
          : '<div class="field"><label>Country preset</label><select id="t-country" data-act="set-country">' + countryOptions(db.settings.country) + "</select>" +
            '<p class="hint" style="margin:6px 0 0">Switching country reloads the currency, threshold, brackets and levy below. You can still fine-tune everything by hand.</p>' +
            TAX_DISCLAIMER + "</div>") +
        '<div class="row"><div class="field"><label>Tax currency</label><select id="t-cur"' + (frozen ? " disabled" : "") + '>' + currencyOptions(t.currency) + "</select></div>" +
        '<div class="field"><label>Tax-free threshold</label><input id="t-thr" type="number" step="any" value="' + esc(t.taxFreeThreshold) + '"></div></div>' +
        '<div class="row"><div class="field"><label>Employment income (year)</label><input id="t-emp" type="number" step="any" value="' + esc(t.employmentIncome) + '"></div>' +
        '<div class="field"><label>Tax already paid</label><input id="t-paid" type="number" step="any" value="' + esc(t.employmentTaxPaid) + '"></div></div>' +
        '<div class="row"><div class="field"><label>Other income</label><input id="t-other" type="number" step="any" value="' + esc(t.otherIncome) + '"></div>' +
        '<div class="field"><label>Deductions / offsets</label><input id="t-ded" type="number" step="any" value="' + esc(t.deductions) + '"></div>' +
        '<div class="field"><label>Capital losses carried in</label><input id="t-loss-carry" type="number" min="0" step="any" value="' + esc(num(t.capitalLossCarryIn)) + '"></div></div>' +
        '<div class="row"><div class="field"><label>Levy label</label><input id="t-llabel" value="' + esc(t.levyLabel || "Levy") + '"></div>' +
        '<div class="field"><label>Levy rate %</label><input id="t-levy" type="number" step="any" value="' + (num(t.levyRate) * 100) + '"></div>' +
        '<div class="field"><label>Capital gains rate %</label><input id="t-cgt" type="number" step="any" value="' + (num(t.capitalGainsRate) * 100) + '"></div>' +
        '<div class="field"><label>CGT discount on realized %</label><input id="t-cgtdisc" type="number" step="any" value="' + (num(t.capitalGainsDiscount) * 100) + '"></div>' +
        '<div class="field"><label>Discount min. holding (months)</label><input id="t-cgtmonths" type="number" step="1" min="0" value="' + num(t.capitalGainsDiscountMonths) + '"></div></div>' +
        '<div class="section-title">Brackets</div><div id="bk-list">' + bracketFields + "</div>" +
        '<button type="button" class="btn sm" data-act="add-bracket">+ Add bracket</button>' +
        '<div class="section-title">Extra adjustments</div>' +
        '<p class="hint" style="margin:-6px 0 10px">Anything else applied to the tax total. A fixed amount or a % of the calculated tax, either added or deducted (e.g. a 3% surcharge, or a tax offset).</p>' +
        '<div id="adj-list">' + adjFields + "</div>" +
        '<button type="button" class="btn sm" data-act="add-adjustment">+ Add adjustment</button>',
      submitLabel: "Save Tax Settings",
      onSubmit: function () {
        var prevCur = t.currency;
        t.currency = val("t-cur"); t.taxFreeThreshold = num(val("t-thr"));
        if (t.taxFreeThreshold < 0) { toast("Tax-free threshold cannot be negative"); return false; }
        // Tax currency changed: any invoice's locked fxRate targeted the OLD tax currency, so it's now
        // wrong. Drop it (and the dated flag) so invoiceInTax re-derives the conversion at current FX.
        if (t.currency !== prevCur) (t.invoices || []).forEach(function (iv) { if (iv.currency !== t.currency) { delete iv.fxRate; delete iv.fxDate; } });
        t.employmentIncome = num(val("t-emp")); t.employmentTaxPaid = num(val("t-paid"));
        t.otherIncome = num(val("t-other")); t.deductions = num(val("t-ded")); t.capitalLossCarryIn = num(val("t-loss-carry"));
        if (t.capitalLossCarryIn < 0) { toast("Capital losses carried in cannot be negative"); return false; }
        var levyPct = num(val("t-levy")), cgtPct = num(val("t-cgt")), discPct = num(val("t-cgtdisc"));
        if (levyPct < 0 || levyPct > 100 || cgtPct < 0 || cgtPct > 100 || discPct < 0 || discPct > 100) { toast("Tax rates and CGT values must be between 0% and 100%"); return false; }
        t.levyLabel = val("t-llabel"); t.levyRate = levyPct / 100;
        t.capitalGainsRate = cgtPct / 100;
        t.capitalGainsDiscount = discPct / 100;
        t.capitalGainsDiscountMonths = num(val("t-cgtmonths"));
        var bkList = document.getElementById("bk-list");
        var uptos = bkList.querySelectorAll(".bk-upto"), rates = bkList.querySelectorAll(".bk-rate");
        var brackets = [];
        for (var i = 0; i < uptos.length; i++) {
          var up = uptos[i].value.trim();
          var cap = up === "" ? null : num(up), ratePct = num(rates[i].value);
          if ((cap != null && cap < 0) || ratePct < 0 || ratePct > 100) { toast("Tax bracket rates must be between 0% and 100%"); return false; }
          brackets.push({ upTo: cap, rate: ratePct / 100 });
        }
        // Sort ascending by cap (null = top/∞ last) so a user who enters brackets out of order still gets a
        // valid progressive chain - progressiveTax assumes non-decreasing caps.
        if (brackets.length) {
          brackets.sort(function (a, b) { return (a.upTo == null ? Infinity : num(a.upTo)) - (b.upTo == null ? Infinity : num(b.upTo)); });
          var topCount = brackets.filter(function (b) { return b.upTo == null; }).length, prevCap = num(t.taxFreeThreshold), invalidOrder = false;
          brackets.forEach(function (b, i) { if (b.upTo == null) { if (i !== brackets.length - 1) invalidOrder = true; } else { if (!(num(b.upTo) > prevCap)) invalidOrder = true; prevCap = num(b.upTo); } });
          if (topCount !== 1 || invalidOrder) { toast("Use increasing bracket caps above the tax-free threshold and one open-ended top bracket"); return false; }
          t.brackets = brackets;
        } else { toast("Add at least one tax bracket"); return false; }
        var an = document.querySelectorAll(".adj-name"), at = document.querySelectorAll(".adj-type"),
          am = document.querySelectorAll(".adj-mode"), av = document.querySelectorAll(".adj-value");
        var adjs = [];
        for (var k = 0; k < an.length; k++) {
          var nm = an[k].value.trim(); if (!nm) continue;
          adjs.push({ id: uid(), name: nm, type: at[k].value, mode: am[k].value, value: num(av[k].value) });
        }
        t.adjustments = adjs;
        save(); render(); toast("Tax settings saved");
      },
    });
  }

  function currencyModal(existing, onSaved) {
    var c = existing || { code: "", symbol: "", rate: "" };
    var quickPick = existing ? "" :
      '<div class="field currency-field"><label>Find currency</label><div class="currency-combo">' +
      '<input id="c-preset" placeholder="Type a code or name, e.g. CHF or franc" autocomplete="off" aria-controls="currency-suggestions" aria-expanded="false">' +
      '<span class="currency-combo-caret" aria-hidden="true"></span>' +
      '<div id="currency-suggestions" class="currency-suggestions" role="listbox">' + currencySuggestionHTML("") + '</div>' +
      '</div></div>';
    openModal({
      title: existing ? "Edit Currency" : "Add Currency",
      cls: "currency-modal",
      noAutoFocus: !existing,
      body:
        quickPick +
        '<div class="row"><div class="field"><label>Code</label><input id="c-code" value="' + esc(c.code) + '" placeholder="USD" maxlength="4"' + (existing ? " readonly" : "") + " required></div>" +
        '<div class="field"><label>Symbol</label><input id="c-sym" value="' + esc(c.symbol) + '" placeholder="$" required></div></div>' +
        '<div class="field"><label>Rate (value of 1 unit in ' + esc(base()) + ')</label><input id="c-rate" type="number" step="any" value="' + esc(c.rate) + '" placeholder="e.g. 1.00"></div>' +
        '<div class="help-box" style="margin:6px 0 0">Tip: use <strong>Auto-update FX</strong> to fill rates automatically.</div>',
      onSubmit: function () {
        var code = val("c-code").trim().toUpperCase(); if (!code) return false;
        if (!/^[A-Z]{3}$/.test(code)) { toast("Use a 3-letter currency code"); return false; }
        if (!existing && curByCode(code)) { toast("Currency already exists"); return false; }
        var obj = { code: code, symbol: val("c-sym").trim() || code, rate: code === base() ? 1 : num(val("c-rate")) || 1 };
        if (existing) { var i = db.currencies.findIndex(function (x) { return x.code === existing.code; }); db.currencies[i] = obj; }
        else db.currencies.push(obj);
        recomputeAllSnapshots();   // a rate edit reprojects the live month; closed months keep the FX they froze with
        save();
        if (onSaved) onSaved(obj.code); else render();
        if (!existing && navigator.onLine && code !== base()) {
          fetchFX().then(function (ok) { if (ok) { recomputeAllSnapshots(); save(); render(); } }).catch(function () { });
        }
        toast("Currency saved");
      },
    });
  }

  function categoryModal(kind) {
    openModal({
      title: "Add " + (kind === "expense" ? "Expense" : "Income") + " Category",
      body: '<div class="field"><label>Category name</label><input id="cat-name" required></div>',
      onSubmit: function () {
        var name = val("cat-name").trim(); if (!name) return false;
        var list = kind === "expense" ? db.expenseCategories : db.incomeCategories;
        if (list.indexOf(name) === -1) list.push(name);
        save(); render(); toast("Category added");
      },
    });
  }

  // ----------------------------------------------------------
  // Actions: Close Month (snapshot+freeze), the CopyandPaste macro
  // ----------------------------------------------------------
  function buildSnapshot(m) {
    // Snapshots are stored in the CANONICAL "my share" lens, never the current Household toggle - otherwise
    // freezing a month while Household is on (e.g. the last-day auto-snapshot) would bake 100%-share balances
    // in permanently. Household stays a render-time view lens. Force "mine" for the duration of the build.
    var savedView = state.netView;
    state.netView = "mine";
    try {
      var perHolding = {};
      db.holdings.forEach(function (h) {
        var hm = holdingMetrics(h);
        var rate = (curByCode(h.currency) || {}).rate || 1;
        perHolding[h.id] = {
          shares: hm.shares, buyPrice: hm.avgBuyPrice,
          fees: hm.cost - hm.shares * hm.avgBuyPrice,   // so cost reconstructs exactly
          price: hm.price, realized: hm.realized, type: h.type, currency: h.currency, rate: rate,
          mvBase: hm.marketValueBase, costBase: hm.costBase,
        };
      });
      var perAccount = {};
      db.accounts.forEach(function (a) {
        perAccount[a.id] = { name: a.name, bucket: a.bucket, currency: a.currency, balance: num(a.balance), balanceBase: toBase(ownedBalance(a), a.currency), share: a.share == null ? 100 : num(a.share) };
      });
      var perDebt = {};
      (db.debts || []).forEach(function (d) { perDebt[d.id] = toBase(num(d.balance), d.currency); });   // base at close FX
      var pf = portfolioTotals();
      var gross = grossNetWorth(), debtsTotal = debtsTotalBase();
      return {
        month: m, date: new Date().toISOString(),
        netWorth: gross - debtsTotal, gross: gross,
        invest: pf.mv, cost: pf.cost, unrealized: pf.unreal, realized: pf.real,
        buckets: netWorthBuckets(), holdings: perHolding, accounts: perAccount,
        debts: perDebt, debtsTotal: debtsTotal,   // frozen liabilities (immutable once the month closes)
        physAssets: physicalAssetsTotal(),   // frozen physical-asset value (feeds historical net worth)
        expenses: monthTotal(db.expenses, m), income: monthTotal(db.incomes, m),
        rates: ratesNow(),   // the FX in effect at close - kept forever so this month's base figures never drift
      };
    } finally {
      state.netView = savedView;
    }
  }
  function writeSnapshot(m) {
    var snap = buildSnapshot(m);
    var i = db.snapshots.findIndex(function (s) { return s.month === m; });
    if (i >= 0) db.snapshots[i] = snap; else db.snapshots.push(snap);
    db.snapshots.sort(function (a, b) { return a.month < b.month ? -1 : 1; });
    save();
    return snap;
  }
  function hasSnapshot(m) { return db.snapshots.some(function (s) { return s.month === m; }); }

  // Add a year to the viewing timeline (from the "+ Add Year..." option in the sidebar Year select).
  function addYearModal(selEl) {
    if (selEl) selEl.value = state.month.slice(0, 4);   // reset the select so a cancel isn't left stuck
    openModal({
      title: "Add a year",
      sub: "Add a year to your viewing timeline so you can browse and freeze its months.",
      body: '<div class="field"><label>Year</label><input id="add-year-input" type="number" step="1" min="1900" max="2200" placeholder="e.g. 2019" value="' +
        (new Date().getFullYear() - 3) + '"></div>',
      submitLabel: "Add year",
      onSubmit: function () {
        var y = parseInt((val("add-year-input") || "").replace(/[^0-9]/g, ""), 10);
        if (!y || y < 1900 || y > 2200) { toast("Enter a valid year"); return false; }
        db.meta.customYears = db.meta.customYears || [];
        if (db.meta.customYears.indexOf(y) < 0) db.meta.customYears.push(y);
        state.month = y + "-" + state.month.slice(5);   // jump to the newly added year
        save(); render(); toast("Added " + y);
      },
    });
  }
  function addMonthModal(selEl) {
    if (selEl) selEl.value = state.month;   // reset the select so a cancel isn't left stuck
    var yr = state.month.slice(0, 4);
    openModal({
      title: "Add a month",
      sub: "Add a month to " + yr + " so you can browse or log data for it.",
      body: '<div class="field"><label>Month</label><select id="add-month-input">' +
        MONTHS.map(function (_, i) { var mn = monthName(i), v = String(i + 1).padStart(2, "0"); return '<option value="' + v + '"' + (i + 1 === +state.month.slice(5) ? " selected" : "") + ">" + mn + " " + yr + "</option>"; }).join("") +
        "</select></div>",
      submitLabel: "Add month",
      onSubmit: function () {
        var mm = yr + "-" + val("add-month-input");
        db.meta.customMonths = db.meta.customMonths || [];
        if (db.meta.customMonths.indexOf(mm) < 0) db.meta.customMonths.push(mm);
        state.month = mm; save(); render(); toast("Added " + monthLabel(mm));
      },
    });
  }

  // Automatic month-end snapshot - always on (manual mode removed). Local apps can't run while closed,
  // so this fires on app open + hourly: it freezes the previous month the instant a calendar-month
  // boundary rolls over, and also captures the current month on/after its last day.
  function lastDayOfMonth(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); }
  function prevMonthStr(m) {
    var p = m.split("-"), d = new Date(+p[0], +p[1] - 1, 1);
    d.setMonth(d.getMonth() - 1);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
  }
  function nextMonthStr(m) {
    var p = m.split("-"), d = new Date(+p[0], +p[1] - 1, 1);
    d.setMonth(d.getMonth() + 1);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
  }
  // On month close, advance each live debt one month and log the repayment into Cash Flow. Idempotent per
  // debt per month via `d.lastClose` (months are sortable "YYYY-MM" strings). Amortization:
  //   interest  = balance * (apr/100) / 12
  //   principal = payment - interest      (negative when payment < interest -> a revolving balance GROWS)
  //   balance   = max(0, balance - principal)   (floors at 0 once paid off)
  // Cash-flow logging respects each debt's `logMode`: "full" logs the whole payment, else just the interest
  // (so principal - which only moves net worth from cash into debt payoff - never dents the savings rate).
  // Must run BEFORE writeSnapshot(m) so the snapshot freezes the post-payment balance AND the logged expense.
  function closeDebtsForMonth(m) {
    (db.debts || []).forEach(function (d) {
      if (d.lastClose && d.lastClose >= m) return;   // already advanced for this (or a later) month
      var bal = num(d.balance), apr = num(d.apr), pay = num(d.payment);
      var interest = bal * (apr / 100) / 12;
      var newBal = Math.max(0, bal - (pay - interest));
      // On a debt's final month the actual outflow is only what's still owed (balance + its interest), not the
      // whole configured payment - so "full" mode never logs an over-payment that overstates that month's expenses.
      var logAmt = (d.logMode === "full") ? Math.max(0, Math.min(pay, bal + interest)) : Math.max(0, interest);
      var already = (db.expenses || []).some(function (x) { return x.debtId === d.id && x.month === m; });
      if (logAmt > 0.005 && !already) {
        db.expenses.push({
          id: uid(), month: m, category: "Debt payments",
          amount: Math.round(logAmt * 100) / 100, currency: d.currency,
          note: d.name + (d.logMode === "full" ? " payment" : " interest"),
          debtId: d.id, auto: "debt",
        });
      }
      d.balance = Math.round(newBal * 100) / 100;
      d.lastClose = m;
    });
  }
  function maybeAutoSnapshot() {
    if (!db.accounts.length && !db.holdings.length) return false; // nothing to record yet
    var today = new Date(), cm = currentMonth(), did = null;
    var prev = prevMonthStr(cm);
    // Only backfill months the wallet was already active for - never fabricate history before setup.
    // firstMonth is stamped at setup / sample-load.
    var fm = db.meta && db.meta.firstMonth;
    // Catch-up across a MULTI-month absence (browser closed for several months): walk every missing month
    // from just after the latest snapshot up to the previous month, running recurring cash flow + debt
    // amortization per month before freezing it - so no month is skipped (which would silently span the MoM
    // "Change" and drop months of interest/rent). Balances/prices are today's (a closed app can't know the
    // true past), but debt balances and recurring flows advance correctly month by month.
    var lastSnap = "";
    (db.snapshots || []).forEach(function (s) { if (s.month < cm && s.month > lastSnap) lastSnap = s.month; });
    var m = lastSnap ? nextMonthStr(lastSnap) : (fm || prev), guard = 0;
    while (m <= prev && guard++ < 240) {
      if ((!fm || m >= fm) && !hasSnapshot(m)) { applyRecurring(m); closeDebtsForMonth(m); writeSnapshot(m); did = m; }
      m = nextMonthStr(m);
    }
    // on/after the last day of the current month, capture it too
    if (today.getDate() >= lastDayOfMonth(today) && !hasSnapshot(cm)) { applyRecurring(cm); closeDebtsForMonth(cm); writeSnapshot(cm); did = cm; }
    if (did) toast("Auto-snapshot saved for " + monthLabel(did));
    return !!did;
  }

  // ----------------------------------------------------------
  // Data export / import / reset
  // ----------------------------------------------------------
  // A portable copy of the database for sharing/backup.
  function portableDb() {
    return JSON.parse(JSON.stringify(db));
  }
  function exportData() {
    var blob = new Blob([JSON.stringify(portableDb(), null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = "wallet-backup-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click(); URL.revokeObjectURL(url);
    db.meta.lastBackup = Date.now(); db.meta.backupSnooze = 0; save();
    if (state.route) render();
    toast("Backup downloaded");
  }
  // ---- CSV export (spreadsheet-friendly tables; the JSON backup remains the full-fidelity format) ----
  function csvCell(v) {
    v = v == null ? "" : String(v);
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  function downloadCSV(name, rows) {
    // UTF-8 BOM so Excel opens the file correctly (currency codes, accents, notes survive intact)
    var text = String.fromCharCode(65279) + rows.map(function (r) { return r.map(csvCell).join(","); }).join("\r\n");
    var blob = new Blob([text], { type: "text/csv" }), url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = name + "-" + new Date().toISOString().slice(0, 10) + ".csv";
    a.click(); URL.revokeObjectURL(url);
    toast("CSV downloaded");
  }
  function exportCSV(kind, scope) {
    var b = base(), n2 = function (v) { return (Math.round(num(v) * 100) / 100).toFixed(2); };
    if (kind === "holdings") {
      // Every holding with any history (sold-out positions keep their realized P/L on record).
      var hs = (db.holdings || []).filter(function (h) { return (h.transactions || []).length || num(h.price); });
      if (!hs.length) { toast("No holdings to export"); return; }
      var rows = [["Name", "Ticker", "Type", "Currency", "Shares", "Avg Buy Price", "Current Price",
        "Cost (" + b + ")", "Market Value (" + b + ")", "Unrealized P/L (" + b + ")", "Realized P/L (" + b + ")", "Dividends (" + b + ")"]];
      hs.forEach(function (h) {
        var m = holdingMetrics(h);
        var divB = (h.dividends || []).reduce(function (s, d) { return s + toBase(num(d.amount), h.currency); }, 0);
        rows.push([h.name || "", h.ticker || "", typeMeta(h.type).label, h.currency, +m.shares.toFixed(6), n2(m.avgBuyPrice), n2(m.price),
          n2(m.costBase), n2(m.marketValueBase), n2(m.unrealizedBase), n2(m.realizedBase), n2(divB)]);
      });
      downloadCSV("valutio-holdings", rows);
      return;
    }
    if (kind === "history") {
      var snaps = (db.snapshots || []).slice().sort(function (a, b2) { return a.month < b2.month ? -1 : 1; });
      var cm = currentMonth();
      // Append the live current month (same figures History shows) unless it's already frozen.
      if (!snaps.some(function (s) { return s.month === cm; })) {
        var lp = portfolioTotals();
        snaps.push({ month: cm, netWorth: netWorthAfterDebts(), gross: grossNetWorth(), invest: lp.mv, cost: lp.cost,
          unrealized: lp.unreal, realized: totalRealizedAllTime(), income: monthTotal(db.incomes, cm), expenses: monthTotal(db.expenses, cm), debtsTotal: debtsTotalBase() });
      }
      if (!snaps.length) { toast("No history to export"); return; }
      var rows2 = [["Month", "Net Worth (" + b + ")", "Gross Assets (" + b + ")", "Debts (" + b + ")", "Investments (" + b + ")",
        "Invested Cost (" + b + ")", "Unrealized P/L (" + b + ")", "Realized P/L cumulative (" + b + ")", "Income (" + b + ")", "Expenses (" + b + ")", "Saved (" + b + ")"]];
      snaps.forEach(function (s) {
        rows2.push([s.month, n2(s.netWorth), n2(s.gross != null ? s.gross : s.netWorth), n2(s.debtsTotal), n2(s.invest),
          n2(s.cost), n2(s.unrealized), n2(s.realized), n2(s.income), n2(s.expenses), n2(num(s.income) - num(s.expenses))]);
      });
      downloadCSV("valutio-history", rows2);
      return;
    }
    if (kind === "cashflow") {
      // Income + expenses interleaved, base value at each month's frozen FX. scope "month" = the viewed
      // month only; anything else = the FULL ledger (every month).
      var only = (scope === "month") ? state.month : null;
      var all = [];
      (db.incomes || []).forEach(function (x) { if (!only || x.month === only) all.push({ x: x, kind: "Income" }); });
      (db.expenses || []).forEach(function (x) { if (!only || x.month === only) all.push({ x: x, kind: "Expense" }); });
      if (!all.length) { toast(only ? "No cash flow for " + monthLabel(only) : "No cash flow to export"); return; }
      all.sort(function (p, q) { return p.x.month < q.x.month ? -1 : p.x.month > q.x.month ? 1 : (p.kind < q.kind ? -1 : 1); });
      var rows3 = [["Month", "Type", "Category", "Note", "Amount", "Currency", "Amount (" + b + ")", "Joint Share %"]];
      all.forEach(function (r) {
        rows3.push([r.x.month, r.kind, r.x.category || "", r.x.note || "", n2(r.x.amount), r.x.currency,
          n2(toBaseAtMonth(num(r.x.amount), r.x.currency, r.x.month)), isJoint(r.x) ? num(r.x.share) : ""]);
      });
      downloadCSV(only ? "valutio-cashflow-" + only : "valutio-cashflow", rows3);
      return;
    }
  }
  function exportExcel() {
    if (!(db.accounts.length || db.holdings.length || db.expenses.length || db.incomes.length || (db.snapshots || []).length)) {
      toast("No data to export");
      return;
    }
    toast("Preparing Excel workbook…");
    loadSheetJS().then(function (XLSX) {
      var b = base();
      var n2 = function (v) { return Math.round(num(v) * 100) / 100; };
      var dateFromMonth = function (m) { return String(m || currentMonth()) + "-15"; };
      var sheet = function (name, rows, widths) {
        var ws = XLSX.utils.aoa_to_sheet(rows);
        if (widths) ws["!cols"] = widths.map(function (w) { return { wch: w }; });
        XLSX.utils.book_append_sheet(wb, ws, name);
      };
      var wb = XLSX.utils.book_new();
      var pf = portfolioTotals();
      sheet("Summary", [
        ["Wallet", db.settings.name || "Valutio"],
        ["Exported", new Date().toISOString()],
        ["Base currency", b],
        ["Net worth (" + b + ")", n2(netWorthAfterDebts())],
        ["Accounts", db.accounts.length],
        ["Holdings", db.holdings.length],
        ["Income rows", db.incomes.length],
        ["Expense rows", db.expenses.length],
        ["Snapshots", (db.snapshots || []).length],
        ["Investment market value (" + b + ")", n2(pf.mv)],
        ["Investment cost (" + b + ")", n2(pf.cost)],
      ], [28, 28]);
      sheet("Currencies", [["Code", "Symbol", "Rate to " + b]].concat((db.currencies || []).map(function (c) {
        return [c.code, c.symbol, num(c.rate)];
      })), [12, 12, 16]);
      sheet("Accounts", [["Name", "Bucket", "Balance", "Currency", "Joint", "Share %", "Co-owner"]].concat((db.accounts || []).map(function (a) {
        return [a.name || "", a.bucket || "", n2(a.balance), a.currency || b, isJoint(a) ? "Yes" : "", isJoint(a) ? num(a.share) : "", a.coOwner || ""];
      })), [26, 18, 14, 12, 10, 10, 18]);
      sheet("Finance", [["Date", "Asset", "Ticker", "Type", "Action", "Shares", "Price", "Total Cost", "Fees", "Currency", "Note"]].concat((db.holdings || []).flatMap(function (h) {
        return (h.transactions || []).map(function (t) {
          var fees = num(t.fees);
          var gross = num(t.shares) * num(t.price);
          return [validDateString(t.date) ? t.date : dateFromMonth(t.month), h.name || "", h.ticker || "", typeMeta(h.type).label, t.type === "sell" ? "Sell" : "Buy",
            num(t.shares), n2(t.price), n2(gross + fees), n2(fees), h.currency || b, t.note || ""];
        });
      })), [13, 28, 14, 14, 10, 12, 14, 14, 10, 12, 24]);
      sheet("Holdings", [["Name", "Ticker", "Type", "Currency", "Shares", "Avg Buy Price", "Current Price", "Cost (" + b + ")", "Market Value (" + b + ")", "Unrealized P/L (" + b + ")", "Realized P/L (" + b + ")"]].concat((db.holdings || []).map(function (h) {
        var m = holdingMetrics(h);
        return [h.name || "", h.ticker || "", typeMeta(h.type).label, h.currency || b, +m.shares.toFixed(6), n2(m.avgBuyPrice), n2(m.price), n2(m.costBase), n2(m.marketValueBase), n2(m.unrealizedBase), n2(m.realizedBase)];
      })), [28, 14, 14, 12, 12, 16, 16, 16, 18, 18, 18]);
      sheet("Dividends", [["Date", "Asset", "Ticker", "Amount", "Currency", "Note"]].concat((db.holdings || []).flatMap(function (h) {
        return (h.dividends || []).map(function (d) { return [dateFromMonth(d.month), h.name || "", h.ticker || "", n2(d.amount), h.currency || b, d.note || ""]; });
      })), [13, 28, 14, 14, 12, 24]);
      sheet("Incomes", [["Date", "Category", "Amount", "Currency", "Note", "Joint Share %", "Recurring"]].concat((db.incomes || []).map(function (x) {
        return [dateFromMonth(x.month), x.category || "", n2(x.amount), x.currency || b, x.note || "", isJoint(x) ? num(x.share) : "", x.recurringId ? "Yes" : ""];
      })), [13, 20, 14, 12, 28, 12, 10]);
      sheet("Expenses", [["Date", "Category", "Amount", "Currency", "Note", "Joint Share %", "Recurring"]].concat((db.expenses || []).map(function (x) {
        return [dateFromMonth(x.month), x.category || "", n2(x.amount), x.currency || b, x.note || "", isJoint(x) ? num(x.share) : "", x.recurringId ? "Yes" : ""];
      })), [13, 20, 14, 12, 28, 12, 10]);
      var taxRows = [
        ["Employment Income", n2(db.tax.employmentIncome)],
        ["Tax Paid", n2(db.tax.employmentTaxPaid)],
        ["Other Income", n2(db.tax.otherIncome)],
        [],
        ["Date", "Amount", "Currency", "Note"],
      ].concat((db.tax.invoices || []).map(function (iv) {
        return [iv.date || dateFromMonth(iv.month), n2(iv.amount), iv.currency || db.tax.currency || b, iv.note || ""];
      }));
      sheet("Tax", taxRows, [18, 16, 12, 28]);
      var rt = db.retirement || {};
      sheet("Retirement", [
        ["Annual Salary", n2(rt.salary)],
        ["Extra Employer Contribution", n2(rt.employerExtra)],
        ["Voluntary Contribution", n2(rt.voluntary)],
      ], [28, 16]);
      var snaps = (db.snapshots || []).slice().sort(function (a, z) { return a.month < z.month ? -1 : 1; });
      sheet("History", [["Month", "Net Worth (" + b + ")", "Gross Assets (" + b + ")", "Debts (" + b + ")", "Investments (" + b + ")", "Cost (" + b + ")", "Unrealized P/L (" + b + ")", "Realized P/L (" + b + ")", "Income (" + b + ")", "Expenses (" + b + ")"]].concat(snaps.map(function (s) {
        return [s.month, n2(s.netWorth), n2(s.gross != null ? s.gross : s.netWorth), n2(s.debtsTotal), n2(s.invest), n2(s.cost), n2(s.unrealized), n2(s.realized), n2(s.income), n2(s.expenses)];
      })), [12, 18, 18, 16, 18, 16, 18, 18, 16, 16]);
      var out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
      var blob = new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url; a.download = "valutio-export-" + new Date().toISOString().slice(0, 10) + ".xlsx";
      a.click(); URL.revokeObjectURL(url);
      db.meta.lastBackup = Date.now(); db.meta.backupSnooze = 0; save();
      if (state.route) render();
      toast("Excel workbook downloaded");
    }).catch(function (e) { toast(e && e.message ? e.message : "Excel export unavailable"); });
  }
  // Cash Flow CSV offers a scope choice (the viewed month, or every month).
  function cashflowExportModal() {
    openModal({
      title: "Export Cash Flow",
      sub: "Download your income and expenses as a spreadsheet-ready CSV.",
      body: '<div class="field"><label>Include</label><select id="cf-export-scope">' +
        '<option value="month">This month only (' + esc(monthLabel(state.month)) + ')</option>' +
        '<option value="all" selected>All months</option></select></div>',
      submitLabel: "Download CSV",
      onSubmit: function () { exportCSV("cashflow", val("cf-export-scope")); },
    });
  }
  var DAY = 86400000;
  // ----- Effortless backups: silent writes to a user-chosen folder (Chromium File System Access) on a
  // schedule; everywhere else, "Back up now" + the overdue banner do the job (no surprise downloads). -----
  function backupJSON() { return JSON.stringify(portableDb(), null, 2); }
  function writeBackupToDir(dir) {
    var name = "valutio-backup-" + new Date().toISOString().slice(0, 10) + ".json";
    return dir.getFileHandle(name, { create: true })
      .then(function (fh) { return fh.createWritable(); })
      .then(function (w) { return Promise.resolve(w.write(backupJSON())).then(function () { return w.close(); }); })
      .then(function () { return true; }).catch(function () { return false; });
  }
  function chooseBackupFolder() {
    if (!window.showDirectoryPicker) { toast("Folder backup needs Chrome or Edge"); return; }
    window.showDirectoryPicker({ id: "valutio-backups", mode: "readwrite" }).then(function (dir) {
      return idbSet("backup_dir_handle", dir).then(function () {
        return writeBackupToDir(dir).then(function (ok) {
          db.settings.backupFolderName = dir.name || "folder";
          if (db.settings.autoBackup === "off") db.settings.autoBackup = "monthly";
          if (ok) { db.meta.lastBackup = Date.now(); db.meta.backupSnooze = 0; }
          save(); render(); toast(ok ? "Backup folder set - saved a copy" : "Backup folder set");
        });
      });
    }).catch(function (e) { if (e && e.name !== "AbortError") toast("I couldn't set that backup folder. Try choosing it again."); });
  }
  function backupNow() {
    if (!window.showDirectoryPicker || !db.settings.backupFolderName) { exportData(); return; }
    idbGet("backup_dir_handle").then(function (dir) {
      if (!dir || !dir.queryPermission) { exportData(); return; }
      return dir.queryPermission({ mode: "readwrite" }).then(function (p) {
        if (p !== "granted" && dir.requestPermission) return dir.requestPermission({ mode: "readwrite" });
        return p;
      }).then(function (p2) {
        if (p2 !== "granted") { toast("Valutio needs permission to write to that backup folder."); return; }
        return writeBackupToDir(dir).then(function (ok) {
          if (!ok) { toast("I couldn't write to that backup folder. Try choosing it again."); return; }
          db.meta.lastBackup = Date.now(); db.meta.backupSnooze = 0; save(); render(); toast("Backup saved to " + (db.settings.backupFolderName || "folder"));
        });
      });
    }).catch(function () { toast("I couldn't access the backup folder. Use Choose folder to reconnect it."); });
  }
  function backupDue() {
    var fr = db.settings.autoBackup;
    if (fr === "off" || !db.setupComplete) return false;
    if (!(db.accounts.length || db.holdings.length || db.expenses.length || db.incomes.length)) return false;
    var span = fr === "weekly" ? 7 * DAY : 30 * DAY;
    return Date.now() - (db.meta.lastBackup || 0) >= span;
  }
  function maybeAutoBackup() {
    if (!backupDue() || !window.showDirectoryPicker) return;
    idbGet("backup_dir_handle").then(function (dir) {
      if (!dir || !dir.queryPermission) return;   // no folder chosen: the overdue banner nudges instead
      dir.queryPermission({ mode: "readwrite" }).then(function (p) {
        if (p !== "granted") return;   // permission lapsed: user re-grants in Settings -> Backups
        writeBackupToDir(dir).then(function (ok) { if (ok) { db.meta.lastBackup = Date.now(); db.meta.backupSnooze = 0; save(); } });
      });
    }).catch(function () { });
  }
  // ----- Monthly reminder (local Notification API; this device only, fires when the app is opened) -----
  function notifyOn() { return db.settings.notifications && typeof Notification !== "undefined" && Notification.permission === "granted"; }
  function maybeNotify() {
    if (!db.setupComplete || !notifyOn()) return;
    var cm = currentMonth();
    if (db.meta.lastNotifyMonth === cm) return;   // at most once per new month
    db.meta.lastNotifyMonth = cm; save();
    var prev = prevMonthStr(cm);
    var body = "New month - review " + monthLabel(prev) + (backupOverdue() ? " and back up your data." : " and log this month's cash flow.");
    try { new Notification(db.settings.name || "Valutio", { body: body, icon: "Icons/icon-192.png", tag: "valutio-month" }); } catch (e) { }
  }
  // ----- Printable tax-year + net-worth report - prints via the browser (Save as PDF) -----
  function printTaxReport() {
    var t = viewedTax(), c = calcTax(t), cur = t.currency;
    var taxCountry = t.country || db.settings.country;
    var m = function (v) { return fmt(v, cur); };
    var pf = portfolioTotals(), nw = netWorthAfterDebts();
    var rows = function (pairs) { return pairs.map(function (p) { return "<tr><td>" + p[0] + '</td><td class="r">' + p[1] + "</td></tr>"; }).join(""); };
    var reportInvoices = (t.invoices || []).filter(function (iv) { return invoiceValueForTaxYear(iv, t) != null; });
    var invRows = reportInvoices.length
      ? reportInvoices.slice().reverse().map(function (iv) { return "<tr><td>" + esc(iv.date || "") + "</td><td>" + esc(iv.note || "") + '</td><td class="r">' + fmt(invoiceValueForTaxYear(iv, t), cur) + "</td></tr>"; }).join("")
      : '<tr><td colspan="3" class="muted">No invoices recorded.</td></tr>';
    var html = '<div class="report">' +
      '<div class="rep-head"><div><div class="rep-name">' + esc(db.settings.name || "Valutio") + "</div>" +
        '<div class="rep-sub">Tax &amp; net-worth report - ' + esc(t.year) + " - " + esc(countryName(taxCountry) || taxCountry) + "</div></div>" +
        '<div class="rep-date">' + new Date().toLocaleDateString() + "</div></div>" +
      "<h3>Net worth</h3><table>" + rows([
        ["Net worth (today)", fmtBase(nw)], ["Investments (market value)", fmtBase(pf.mv)],
        ["Unrealized P/L", fmtBase(pf.unreal)], ["Realized P/L (all-time)", fmtBase(totalRealizedAllTime())],
      ]) + "</table>" +
      "<h3>Income - " + esc(t.year) + "</h3><table>" + rows([
        ["Employment", m(c.employment)], ["Freelance (invoices)", m(c.freelance)],
        ["Realized capital gains (taxable)", m(c.realized)], ["Interests", m(c.interests)], ["Dividends", m(c.dividends)],
        ["Other income", m(c.other)], ["<strong>Total income</strong>", "<strong>" + m(c.totalIncome) + "</strong>"],
      ].concat(num(t.deductions) ? [["Deductions", "&minus;" + m(c.deductions)], ["<strong>Taxable income</strong>", "<strong>" + m(c.taxableIncome) + "</strong>"]] : [])) + "</table>" +
      "<h3>Estimated tax</h3><table>" + rows([
        ["Income tax", m(c.incomeTax)], [esc(t.levyLabel || "Levy"), m(c.levy)],
        ["<strong>Estimated tax</strong>", "<strong>" + m(c.estimated) + "</strong>"],
        ["Tax already paid", m(num(t.employmentTaxPaid))],
        ["<strong>" + (c.balance >= 0 ? "Still to set aside" : "Estimated refund") + "</strong>", "<strong>" + m(Math.abs(c.balance)) + "</strong>"],
      ]) + "</table>" +
      '<h3>Invoices</h3><table><thead><tr><th>Date</th><th>Note</th><th class="r">In ' + esc(cur) + "</th></tr></thead><tbody>" + invRows + "</tbody></table>" +
      '<div class="rep-foot">Estimate only - not tax advice. Generated by Valutio on ' + new Date().toLocaleString() + ".</div>" +
      "</div>";
    var portal = document.getElementById("print-portal") || (function () { var d = document.createElement("div"); d.id = "print-portal"; document.body.appendChild(d); return d; })();
    portal.innerHTML = html;
    document.body.classList.add("printing");
    function done() { document.body.classList.remove("printing"); portal.innerHTML = ""; window.removeEventListener("afterprint", done); }
    window.addEventListener("afterprint", done);
    setTimeout(function () { window.print(); }, 30);
  }
  function backupOverdue() {
    if (!db.setupComplete) return false;
    if (!(db.accounts.length || db.holdings.length || db.expenses.length || db.incomes.length)) return false;
    var now = Date.now();
    if (now < (db.meta.backupSnooze || 0)) return false;
    return now - (db.meta.lastBackup || 0) > 14 * DAY;
  }
  function backupBanner() {
    if (!backupOverdue()) return "";
    var never = !db.meta.lastBackup;
    return '<div class="backup-banner"><div class="bb-msg">' + icon("shield") + '<span>' +
      (never ? "Your data lives only in this browser. Export a backup to keep it safe." :
        "It's been a while since your last backup. Export one to stay safe.") +
      '</span></div><button class="btn sm primary" data-act="backup-now">Back up now</button>' +
      '<button class="btn sm ghost" data-act="snooze-backup">Later</button></div>';
  }
  // Minimal CSV parser (handles quoted fields, escaped quotes, embedded newlines).
  function parseCSV(text) {
    text = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    var rows = [], row = [], cur = "", q = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ",") { row.push(cur); cur = ""; }
      else if (ch === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
      else cur += ch;
    }
    if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (c) { return String(c).trim() !== ""; }); });
  }
  // Parse a money string that may be US ("1,234.56") or European ("1.234,56" / "12,50") formatted. The LAST
  // separator is the decimal point; earlier separators are thousands. Without this, replacing only commas
  // turned "12,50" into 1250 (100x) and "1.234,56" into 1.23456.
  function parseAmount(s) {
    s = String(s).replace(/[^0-9.,\-]/g, "").trim();
    if (!s) return NaN;
    var lastComma = s.lastIndexOf(","), lastDot = s.lastIndexOf(".");
    if (lastComma > -1 && lastDot > -1) {
      if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");   // EU: dots are thousands, comma is decimal
      else s = s.replace(/,/g, "");                                          // US: commas are thousands, dot is decimal
    } else if (lastComma > -1) {
      var afterC = s.length - lastComma - 1, commaCount = (s.match(/,/g) || []).length;
      if (commaCount === 1 && afterC > 0 && afterC <= 2) s = s.replace(",", ".");   // 12,50 -> decimal
      else s = s.replace(/,/g, "");                                                 // 1,234 / 1,234,567 -> thousands
    } else if (lastDot > -1 && (s.match(/\./g) || []).length > 1) {
      s = s.replace(/\./g, "");   // 1.234.567 -> thousands (multiple dots can't be decimals)
    }
    return parseFloat(s);
  }
  function cashFlowImportKind(kind) { return kind === "income" ? "income" : "expense"; }
  function cashFlowImportCurrency(v) {
    var s = String(v == null ? "" : v).trim().toUpperCase();
    if (!s) return base();
    if (s === "$") return base();
    if (s === "€") return "EUR";
    if (s === "£") return "GBP";
    if (s === "¥") return "JPY";
    var m = /[A-Z]{3}/.exec(s);
    return m ? m[0] : base();
  }
  function cashFlowImportAmount(v) {
    if (typeof v === "number") return v;
    return parseAmount(v);
  }
  function cashFlowImportColumns(row) {
    var c = { month: -1, date: -1, cat: -1, amt: -1, cur: -1, note: -1, personal: -1, joint: -1, total: -1, share: -1 };
    (row || []).forEach(function (cell, i) {
      var h = String(cell == null ? "" : cell).trim().toLowerCase();
      if (!h) return;
      if (c.month < 0 && /\b(month|period)\b/.test(h)) c.month = i;
      if (c.date < 0 && /\bdate\b/.test(h)) c.date = i;
      if (c.cat < 0 && IMPORT_VOCAB.cat.test(h)) c.cat = i;
      if (c.amt < 0 && /\b(amount|value)\b/.test(h)) c.amt = i;
      if (c.cur < 0 && /\b(currency|ccy|curr)\b/.test(h)) c.cur = i;
      if (c.note < 0 && /\b(note|notes|description|desc|memo)\b/.test(h)) c.note = i;
      if (c.share < 0 && /\b(share|split|ownership)\b/.test(h) && (/\bjoint\b/.test(h) || /%/.test(h))) c.share = i;
      if (c.personal < 0 && /\bpersonal\b/.test(h) && !/\bshare\b/.test(h)) c.personal = i;
      if (c.joint < 0 && /\bjoint\b/.test(h) && !/\bshare\b/.test(h) && !/%/.test(h)) c.joint = i;
      if (c.total < 0 && /^total$/.test(h)) c.total = i;
    });
    if (c.amt < 0 && c.total >= 0 && c.personal < 0 && c.joint < 0) c.amt = c.total;
    return c;
  }
  function cashFlowImportHeaderScore(cols) {
    if (cols.cat >= 0 && (cols.amt >= 0 || cols.total >= 0 || cols.personal >= 0 || cols.joint >= 0)) return 3;
    if ((cols.date >= 0 || cols.month >= 0) && cols.amt >= 0) return 2;
    return 0;
  }
  function cashFlowImportColumnName(i) {
    if (!(i >= 0)) return "";
    var n = i + 1, s = "";
    while (n > 0) {
      var m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }
  function cashFlowImportPill(text) {
    return '<span class="kw-pill">' + esc(text) + "</span>";
  }
  function cashFlowImportMapping(cols) {
    cols = cols || {};
    var defs = [
      ["Date", cols.date], ["Month", cols.month], ["Category", cols.cat], ["Amount", cols.amt],
      ["Currency", cols.cur], ["Note", cols.note], ["Personal", cols.personal], ["Joint", cols.joint], ["Total", cols.total], ["Share", cols.share],
    ];
    var pills = defs.filter(function (d) { return d[1] >= 0; }).map(function (d) {
      return cashFlowImportPill(d[0] + " " + cashFlowImportColumnName(d[1]));
    });
    return pills.length ? pills.join("") : '<span class="kw-muted">Standard order: Date, Category, Amount, Currency, Note</span>';
  }
  function cashFlowImportMetaHtml(kind, rows) {
    var meta = rows && rows._importMeta ? rows._importMeta : {};
    var sheetMeta = meta.sheets && meta.sheets.length ? meta.sheets : [{
      name: meta.sourceName || "File",
      rows: rows.length,
      sourceRows: meta.sourceRows || rows.length,
      headerRow: meta.headerRow,
      columns: meta.columns,
    }];
    var useful = sheetMeta.filter(function (s) { return s.rows > 0; });
    var first = useful[0] || sheetMeta[0] || {};
    var sheetList = sheetMeta.map(function (s) {
      var label = s.name ? s.name + ": " : "";
      return cashFlowImportPill(label + s.rows + " row" + (s.rows === 1 ? "" : "s"));
    }).join("");
    var sourceRows = meta.sourceRows || sheetMeta.reduce(function (sum, s) { return sum + num(s.sourceRows); }, 0);
    var headerText = first.headerRow ? ("Row " + first.headerRow) : (first.standardOrder ? "Standard column order" : "Detected automatically");
    return '<div class="kw-rows" style="margin-top:14px">' +
      '<div class="kw-row"><span class="kw-label">Source rows</span><span class="kw-list">' + cashFlowImportPill(sourceRows || rows.length) + '</span></div>' +
      '<div class="kw-row"><span class="kw-label">Sheets</span><span class="kw-list">' + (sheetList || cashFlowImportPill("File: " + rows.length + " rows")) + '</span></div>' +
      '<div class="kw-row"><span class="kw-label">Header</span><span class="kw-list">' + cashFlowImportPill(headerText) + '</span></div>' +
      '<div class="kw-row"><span class="kw-label">Columns</span><span class="kw-list">' + cashFlowImportMapping(first.columns) + '</span></div>' +
      '<div class="kw-row"><span class="kw-label">Will add</span><span class="kw-list">' + cashFlowImportPill(rows.length + " " + (kind === "income" ? "income" : "expense") + " row" + (rows.length === 1 ? "" : "s")) + '</span></div>' +
      '<div class="kw-row"><span class="kw-label">Will overwrite</span><span class="kw-list"><span class="kw-muted">Nothing. This import only appends to this Cash Flow ledger.</span></span></div>' +
    "</div>";
  }
  function cashFlowRowsFromTable(rows, kind, currencyAt, sourceName) {
    kind = cashFlowImportKind(kind);
    rows = rows || [];
    var hdr = -1, cols = null;
    for (var r = 0; r < Math.min(rows.length, 8); r++) {
      var cc = cashFlowImportColumns(rows[r] || []);
      if (cashFlowImportHeaderScore(cc)) { hdr = r; cols = cc; break; }
    }
    if (!cols) cols = { month: -1, date: 0, cat: 1, amt: 2, cur: 3, note: 4, personal: -1, joint: -1, total: -1, share: -1 };
    var out = [], start = hdr >= 0 ? hdr + 1 : 0;
    var summaryMode = hdr >= 0 && cols.cat >= 0 && cols.amt < 0 && (cols.total >= 0 || cols.personal >= 0 || cols.joint >= 0);
    rows.slice(start).forEach(function (row, offset) {
      row = row || [];
      var rowIdx = start + offset;
      var get = function (i) { return (i >= 0 && i < row.length) ? row[i] : ""; };
      var category = String(get(cols.cat) == null ? "" : get(cols.cat)).trim();
      if (!category) category = kind === "income" ? "Income" : "Other";
      if (/^(grand\s*)?total$/i.test(category) || /^(total|exch)$/i.test(category)) return;

      var month = (cols.month >= 0 ? cellMonth(get(cols.month)) : null) ||
        (cols.date >= 0 ? cellMonth(get(cols.date)) : null) ||
        state.month || currentMonth();
      var note = String(get(cols.note) == null ? "" : get(cols.note)).trim();
      var rowShareRaw = cols.share >= 0 ? String(get(cols.share) == null ? "" : get(cols.share)).trim() : "";
      var rowShare = rowShareRaw ? cashFlowImportAmount(rowShareRaw) : NaN;
      var cleanShare = !isNaN(rowShare) ? Math.max(0, Math.min(100, num(rowShare))) : 50;

      function addImportedRow(amount, amountCol, jointExpense) {
        if (isNaN(amount) || amount === 0) return false;
        var cur = cashFlowImportCurrency(get(cols.cur) || (currencyAt && amountCol >= 0 ? currencyAt(rowIdx, amountCol) : ""));
        var obj = { month: month, category: category, amount: Math.abs(amount), currency: cur, note: note };
        if (kind === "expense" && jointExpense) { obj.joint = true; obj.share = cleanShare; }
        out.push(obj);
        return true;
      }

      if (summaryMode && kind === "expense") {
        var personalSplit = cashFlowImportAmount(get(cols.personal));
        var jointSplit = cashFlowImportAmount(get(cols.joint));
        var addedSplit = false;
        if (cols.personal >= 0 && !isNaN(personalSplit) && personalSplit !== 0) addedSplit = addImportedRow(personalSplit, cols.personal, false) || addedSplit;
        if (cols.joint >= 0 && !isNaN(jointSplit) && jointSplit !== 0) addedSplit = addImportedRow(jointSplit, cols.joint, true) || addedSplit;
        if (addedSplit) return;
      }

      var amount, amountCol = cols.amt;
      if (summaryMode) {
        var total = cashFlowImportAmount(get(cols.total));
        var personal = cashFlowImportAmount(get(cols.personal));
        var joint = cashFlowImportAmount(get(cols.joint));
        amount = !isNaN(total) && total !== 0 ? total : 0;
        if (!amount) {
          if (!isNaN(personal) && personal > 0) amount += personal;
          if (!isNaN(joint) && joint > 0) amount += joint;
        }
        amountCol = cols.total >= 0 ? cols.total : (cols.personal >= 0 ? cols.personal : cols.joint);
      } else {
        amount = cashFlowImportAmount(get(cols.amt));
      }
      addImportedRow(amount, amountCol, kind === "expense" && !!rowShareRaw && !isNaN(rowShare));
    });
    out._importMeta = {
      sourceName: sourceName || "",
      sourceRows: rows.length,
      headerRow: hdr >= 0 ? hdr + 1 : 0,
      columns: cols,
      summaryMode: summaryMode,
      standardOrder: hdr < 0,
    };
    return out;
  }
  function cashFlowRowsFromCSV(text, kind) {
    var rows = parseCSV(text);
    return rows.length ? cashFlowRowsFromTable(rows, kind, null, "CSV") : [];
  }
  function cashFlowRowsFromWorkbook(XLSX, wb, kind) {
    var sheets = wb.SheetNames || [];
    var want = cashFlowImportKind(kind);
    var named = sheets.filter(function (s) {
      return want === "income" ? /^(income|incomes|earnings)$/i.test(String(s).trim()) : /^(expense|expenses|spending)$/i.test(String(s).trim());
    });
    var candidates = named.length ? named : sheets;
    var wbDollar = workbookDollarCcy(XLSX, wb);
    var out = [];
    var meta = { workbook: true, sourceRows: 0, sheets: [] };
    for (var i = 0; i < candidates.length; i++) {
      var sname = candidates[i], ws = wb.Sheets[sname];
      if (!ws || !ws["!ref"]) continue;
      var aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
      meta.sourceRows += aoa.length;
      var rows = cashFlowRowsFromTable(aoa, want, function (r, c) { return cellCurrencyFromFormat(ws, XLSX, r, c, wbDollar); }, sname);
      if (rows.length || rows._importMeta.headerRow) {
        meta.sheets.push({
          name: sname,
          rows: rows.length,
          sourceRows: aoa.length,
          headerRow: rows._importMeta.headerRow,
          columns: rows._importMeta.columns,
          summaryMode: rows._importMeta.summaryMode,
          standardOrder: rows._importMeta.standardOrder,
        });
      }
      if (rows.length) {
        Array.prototype.push.apply(out, rows);
        if (!named.length) break;
      }
    }
    out._importMeta = meta;
    return out;
  }
  function cashFlowImportKey(r) {
    return [r.month, r.category, Math.round(num(r.amount) * 10000) / 10000, r.currency, r.note || "", isJoint(r) ? "joint" : "solo", isJoint(r) ? Math.round(num(r.share)) : ""].join("|");
  }
  function cashFlowImportPreview(kind, fileName, rows) {
    kind = cashFlowImportKind(kind);
    if (!rows.length) { toast("I couldn't find rows with date/month, category and amount. Check the template columns."); return; }
    var label = kind === "income" ? "income" : "expenses";
    var arr = kind === "income" ? db.incomes : db.expenses;
    var cats = kind === "income" ? db.incomeCategories : db.expenseCategories;
    var existingKeys = {};
    arr.forEach(function (x) { existingKeys[cashFlowImportKey(x)] = 1; });
    var duplicateCount = rows.filter(function (r) { return existingKeys[cashFlowImportKey(r)]; }).length;
    var months = [], currencies = {}, totalBase = 0, totalNative = 0, oneCurrency = rows[0].currency;
    rows.forEach(function (r) {
      if (months.indexOf(r.month) === -1) months.push(r.month);
      currencies[r.currency] = 1;
      if (r.currency !== oneCurrency) oneCurrency = "";
      totalNative += num(r.amount);
      totalBase += toBase(num(r.amount), r.currency);
    });
    months.sort();
    var monthText = months.length === 1 ? monthLabel(months[0]) : (months.length + " months");
    var totalText = oneCurrency ? fmt(totalNative, oneCurrency) : fmtBase(totalBase);
    var sample = rows.slice(0, 8).map(function (r) {
      var joint = (kind === "expense" && isJoint(r)) ? ((r.share == null ? 100 : r.share) + "%") : "";
      return '<tr><td>' + esc(r.month) + '</td><td>' + esc(r.category) + '</td><td class="num">' + fmt(r.amount, r.currency) + '</td><td>' + esc(joint) + '</td><td>' + esc(r.note || "") + "</td></tr>";
    }).join("");
    openModal({
      title: "Import " + (kind === "income" ? "income" : "expenses") + "?",
      sub: "Parsed " + esc(fileName) + ". This appends to Cash Flow only.",
      wide: true,
      body:
        '<div class="callout import-warn">' + icon("shield") +
        "<div><strong>Nothing else will be changed.</strong> This will add " + rows.length + " " + label + " row" + (rows.length === 1 ? "" : "s") + " to Cash Flow. It will not replace accounts, investments, tax, snapshots, or the other cash-flow ledger.</div></div>" +
        '<div class="kw-rows" style="margin-top:14px">' +
          '<div class="kw-row"><span class="kw-label">Month</span><span class="kw-list">' + esc(monthText) + '</span></div>' +
          '<div class="kw-row"><span class="kw-label">Total</span><span class="kw-list">' + esc(totalText) + '</span></div>' +
          '<div class="kw-row"><span class="kw-label">Currencies</span><span class="kw-list">' + esc(Object.keys(currencies).join(", ")) + '</span></div>' +
          (duplicateCount ? '<div class="kw-row"><span class="kw-label">Duplicates</span><span class="kw-list">' + esc(duplicateCount + " already in this ledger and will be skipped") + '</span></div>' : "") +
        "</div>" +
        cashFlowImportMetaHtml(kind, rows) +
        '<div class="table-wrap" style="max-height:260px;overflow:auto;margin-top:14px"><table><thead><tr><th>Month</th><th>Category</th><th class="num">Amount</th><th>Joint</th><th>Note</th></tr></thead><tbody>' + sample +
        (rows.length > 8 ? '<tr><td colspan="5" style="text-align:center;color:var(--text-3);padding:12px">+' + (rows.length - 8) + " more rows</td></tr>" : "") +
        "</tbody></table></div>",
      submitLabel: "Add " + rows.length + " " + (kind === "income" ? "Income" : "Expenses"),
      onSubmit: function () {
        var seen = {};
        arr.forEach(function (x) { seen[cashFlowImportKey(x)] = 1; });
        var added = 0, skipped = 0;
        rows.forEach(function (r) {
          var key = cashFlowImportKey(r);
          if (seen[key]) { skipped++; return; }
          seen[key] = 1;
          if (cats.indexOf(r.category) === -1) cats.push(r.category);
          ensureCurrency(r.currency);
          var obj = { id: uid(), month: r.month, category: r.category, amount: Math.abs(num(r.amount)), currency: r.currency, note: r.note || "" };
          if (kind === "expense" && isJoint(r)) { obj.joint = true; obj.share = r.share == null ? 50 : Math.max(0, Math.min(100, num(r.share))); }
          arr.push(obj);
          added++;
        });
        recomputeAllSnapshots(); save(); render();
        toast("Imported " + added + " " + label + " row" + (added === 1 ? "" : "s") + (skipped ? " - skipped " + skipped + " duplicate" + (skipped === 1 ? "" : "s") : ""));
      },
    });
  }
  function importCashFlowFile(kind) {
    kind = cashFlowImportKind(kind);
    var input = document.createElement("input");
    input.type = "file";
    input.accept = ".csv,text/csv,.xlsx,.xls,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    input.onchange = function () {
      var file = input.files && input.files[0]; if (!file) return;
      var name = file.name || "cash-flow import";
      var isExcel = /\.(xlsx|xls)$/i.test(name) || /spreadsheet|excel/i.test(file.type || "");
      var reader = new FileReader();
      if (isExcel) {
        toast("Reading " + name + "...");
        loadSheetJS().then(function (XLSX) {
          reader.onload = function () {
            try {
              var wb = XLSX.read(new Uint8Array(reader.result), { type: "array", cellNF: true, cellDates: true });
              cashFlowImportPreview(kind, name, cashFlowRowsFromWorkbook(XLSX, wb, kind));
            } catch (e) { toast("I couldn't read that Excel file. Try the Valutio .xlsx template layout."); }
          };
          reader.readAsArrayBuffer(file);
        }).catch(function (e) { toast(e && e.message ? e.message : "Spreadsheet parser unavailable"); });
      } else {
        reader.onload = function () {
          try { cashFlowImportPreview(kind, name, cashFlowRowsFromCSV(reader.result, kind)); }
          catch (e) { toast("I couldn't read that CSV. Check it has date/month, category and amount columns."); }
        };
        reader.readAsText(file);
      }
    };
    input.click();
  }
  function importCSV(kind) { importCashFlowFile(kind); }
  // ---- Encrypted backups (optional): Web Crypto PBKDF2 -> AES-GCM. Wraps the same portableDb() payload
  // in a password-protected envelope. The plain Export JSON still works; this is just an extra option.
  // No password recovery - lose the password and the file can't be opened. ----
  var ENC_ITER = 200000;
  function cryptoOK() { return !!(window.crypto && crypto.subtle && window.TextEncoder); }
  function _b64(buf) { var b = new Uint8Array(buf), s = ""; for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); }
  function _unb64(str) { var s = atob(str), b = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b.buffer; }
  function _deriveKey(password, salt, iter) {
    iter = iter > 0 ? iter : ENC_ITER;
    return crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"])
      .then(function (km) {
        return crypto.subtle.deriveKey({ name: "PBKDF2", salt: salt, iterations: iter, hash: "SHA-256" },
          km, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      });
  }
  function encryptBackup(plaintext, password) {
    var salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    return _deriveKey(password, salt).then(function (key) {
      return crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, new TextEncoder().encode(plaintext));
    }).then(function (ct) {
      return JSON.stringify({ valutio_enc: 1, kdf: "PBKDF2", iter: ENC_ITER, salt: _b64(salt), iv: _b64(iv), ct: _b64(ct) });
    });
  }
  function decryptBackup(env, password) {
    // Honor the envelope's stored iteration count so backups made with a different ENC_ITER still open.
    return _deriveKey(password, new Uint8Array(_unb64(env.salt)), +env.iter).then(function (key) {
      return crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(_unb64(env.iv)) }, key, _unb64(env.ct));
    }).then(function (pt) { return new TextDecoder().decode(pt); });
  }
  function exportEncrypted() {
    if (!cryptoOK()) { toast("Encryption isn’t available in this browser"); return; }
    openModal({
      title: "Export encrypted backup",
      sub: "Protect your backup with a password. You’ll need the same password to import it.",
      body: '<div class="field"><label>Password</label><input id="enc-pw" type="password" autocomplete="new-password" placeholder="At least 6 characters"></div>' +
        '<div class="field"><label>Confirm password</label><input id="enc-pw2" type="password" autocomplete="new-password"></div>' +
        '<div class="help-box" style="margin:6px 0 0">No password recovery: if you lose this password the backup can’t be opened. Store it somewhere safe.</div>',
      submitLabel: "Encrypt & Download",
      onSubmit: function () {
        var pw = val("enc-pw"), pw2 = val("enc-pw2");
        if (!pw || pw.length < 6) { toast("Use a password of at least 6 characters"); return false; }
        if (pw !== pw2) { toast("Passwords don’t match"); return false; }
        encryptBackup(JSON.stringify(portableDb()), pw).then(function (env) {
          var blob = new Blob([env], { type: "application/json" }), url = URL.createObjectURL(blob);
          var a = document.createElement("a"); a.href = url;
          a.download = "wallet-backup-" + new Date().toISOString().slice(0, 10) + "-encrypted.json";
          a.click(); URL.revokeObjectURL(url);
          db.meta.lastBackup = Date.now(); db.meta.backupSnooze = 0; save(); if (state.route) render();
          toast("Encrypted backup downloaded");
        }).catch(function () { toast("Couldn’t encrypt the backup"); });
        return true;
      }
    });
  }

  // Commit a decoded backup string (plain JSON, or the decrypted payload of an encrypted one).
  function missingBackupCurrencies(d) {
    var have = {}, need = {};
    (d.currencies || []).forEach(function (c) { if (c && c.code) have[String(c.code).toUpperCase()] = 1; });
    function add(c) { c = String(c || "").toUpperCase(); if (c) need[c] = 1; }
    if (d.settings) { add(d.settings.baseCurrency); add(d.settings.secondaryCurrency); }
    [d.accounts, d.holdings, d.physicalAssets, d.expenses, d.incomes, d.goals, d.recurring, d.debts].forEach(function (list) { (list || []).forEach(function (x) { add(x && x.currency); }); });
    [d.tax].concat(d.taxArchive || []).forEach(function (t) { if (!t) return; add(t.currency); (t.invoices || []).forEach(function (iv) { add(iv.currency); }); });
    return Object.keys(need).filter(function (c) { return !have[c]; });
  }
  function strictBackupDateErrors(d) {
    var errors = [];
    (d.holdings || []).forEach(function (h, hi) {
      (h.transactions || []).forEach(function (t, ti) {
        if (t.date != null && t.date !== "" && !validDateString(t.date)) errors.push((h.name || h.ticker || "Holding " + (hi + 1)) + " transaction " + (ti + 1) + " has an invalid date.");
      });
    });
    [d.tax].concat(d.taxArchive || []).forEach(function (tax, yi) {
      if (!tax) return;
      (tax.invoices || []).forEach(function (iv, ii) {
        if (!validDateString(iv.date)) errors.push((tax.year || (yi ? "Archived tax year " + yi : "Active tax year")) + " invoice " + (ii + 1) + " has an invalid date.");
      });
    });
    return errors;
  }
  function applyImportedJSON(raw) {
    try {
      var parsed = JSON.parse(raw);
      if (!parsed.settings || !parsed.currencies) throw new Error("bad");
      var dateErrors = strictBackupDateErrors(parsed);
      if (dateErrors.length) { validationReport("JSON import needs attention", { errors: dateErrors, warnings: [] }); return; }
      var missing = missingBackupCurrencies(parsed);
      if (missing.length) { toast("Backup is missing FX records for: " + missing.join(", ") + ". Add them to the backup or restore a complete JSON export."); return; }
      var audit = validateDb(migrate(parsed), { repair: true, strict: true, source: "json-import" });
      if (audit.errors.length) { validationReport("JSON import needs attention", audit); return; }
      db = audit.db;
      syncRetireStateFromDb();
      save(); render(); toast("Data imported");
      if (audit.warnings.length) setTimeout(function () { toast("Imported with " + audit.warnings.length + " repaired data issue" + (audit.warnings.length === 1 ? "" : "s")); }, 350);
    } catch (e) { toast("That file doesn't look like a Valutio JSON backup."); }
  }
  function promptDecryptImport(env) {
    openModal({
      title: "Encrypted backup",
      sub: "This backup is password-protected. Enter its password to import.",
      body: '<div class="field"><label>Password</label><input id="dec-pw" type="password" autocomplete="off"></div>',
      submitLabel: "Decrypt & Import",
      onSubmit: function () {
        var pw = val("dec-pw"); if (!pw) { toast("Enter the password"); return false; }
        decryptBackup(env, pw).then(function (plain) { closeModal(); applyImportedJSON(plain); })
          .catch(function () { toast("Wrong password, or the file is damaged"); });
        return false;   // keep the modal open until decrypt resolves
      }
    });
  }
  function importData() {
    var input = document.createElement("input");
    input.type = "file"; input.accept = "application/json";
    input.onchange = function () {
      var file = input.files[0]; if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        var raw = reader.result, env = null;
        try { var maybe = JSON.parse(raw); if (maybe && maybe.valutio_enc) env = maybe; } catch (e) { /* not parseable yet - treat as plain */ }
        if (env) { promptDecryptImport(env); return; }   // password-protected backup -> ask for password
        applyImportedJSON(raw);
      };
      reader.readAsText(file);
    };
    input.click();
  }

  // Exact lookup vocabulary advertised in the pre-import guidance modal. The fuzzy matrices below
  // target these case-insensitive strings when identifying structural sheets, category descriptors,
  // asset mappings and numeric entries.
  var IMPORT_VOCAB = {
    sheets: /^(expenses|incomes?|finance|real[\s.]*time[\s.]*prices?)$/i,
    cat: /\b(category|type)\b/i,
    asset: /\b(ticker|symbol|asset|holding)\b/i,
    amt: /\b(amount|quantity|shares|value|total\s*cost)\b/i,
    date: /\b(date|month|period)\b/i,
    action: /\b(action|side|buy\s*\/?\s*sell|transaction|direction)\b/i,
  };
  // First sheet name in the workbook matching a regex (case-insensitive), else null.
  function findSheetName(wb, re) {
    return (wb.SheetNames || []).filter(function (s) { return re.test(String(s).trim()); })[0] || null;
  }

  // ---- Local "Wallet Excel.xlsx" ingestion via SheetJS ----
  var XLSX_LOCAL = "./Vendor/xlsx.full.min.js";
  var XLSX_CDN = "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js";
  function loadSheetJS() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    function loadScript(src) { return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = src;
      s.onload = function () { window.XLSX ? resolve(window.XLSX) : reject(new Error("Parser failed to initialize.")); };
      s.onerror = function () { reject(new Error("Couldn't load the spreadsheet parser.")); };
      document.head.appendChild(s);
    }); }
    return loadScript(XLSX_LOCAL).catch(function () { return loadScript(XLSX_CDN); });
  }
  // Pre-import guidance: a warning + a scannable mini-tutorial of the keyword mappings the parser
  // looks for, so the user can audit their layout. "Proceed" opens the real file picker; "Cancel"
  // leaves all current app state untouched.
  function importExcel() {
    var kwRow = function (label, kws) {
      return '<div class="kw-row"><span class="kw-label">' + esc(label) + '</span><span class="kw-list">' +
        kws.map(function (k) { return "<code>" + esc(k) + "</code>"; }).join("") + "</span></div>";
    };
    openModal({
      title: "Import Full Workbook",
      sub: "Read a .xlsx/.xls Valutio workbook. Nothing is saved until you review the preview.",
      body:
        '<div class="callout import-warn">' + icon("shield") +
        "<div><strong>Importing replaces major wallet sections.</strong> This is a spreadsheet migration path, not the full-fidelity backup. Use JSON when you want an exact restore.</div></div>" +
        '<p class="hint" style="margin:14px 0 0">Works best with the <strong>starter template</strong>: one sheet per year (accounts &amp; monthly balances), a <strong>Finance</strong> Buy/Sell ledger for investments, <strong>Incomes</strong>/<strong>Expenses</strong> registers, and a <strong>Tax</strong> sheet. Headers are case-insensitive and order-independent, and most other layouts still parse. New to this? Grab <strong>Download Template</strong> in Settings → Your Data.</p>',
      submitLabel: "Proceed to Upload",
      onSubmit: function () { runExcelImport(); },   // runs in the click gesture, then the modal closes
    });
  }
  // Universal Excel import: a standard file picker (works in sandboxed browser / installed PWA),
  // no hardcoded paths. The chosen .xlsx/.xls workbook is read in-browser and ingested unchanged
  // through the existing dynamic column search, float parsing, snapshot sync and validation summary.
  function runExcelImport() {
    var input = document.createElement("input");
    input.type = "file"; input.accept = ".xlsx,.xls";
    input.onchange = function () {
      var file = input.files && input.files[0]; if (!file) return;
      toast("Reading " + file.name + "…");
      loadSheetJS().then(function (XLSX) {
        var reader = new FileReader();
        reader.onload = function () {
          try {
            // cellNF preserves each cell's number-format string (.z) so the currency sniffer can read
            // the format mask when a row has no explicit currency column.
            var wb = XLSX.read(new Uint8Array(reader.result), { type: "array", cellNF: true });
            // DRY-RUN: ingest into the live db, snapshot the result, then ROLL BACK so nothing is
            // committed until the user reviews the parse summary and clicks Apply. Cancelling/closing
            // the preview leaves the existing data completely untouched.
            var backup = JSON.parse(JSON.stringify(db));
            var res = ingestExcelWorkbook(XLSX, wb);
            var imported = JSON.parse(JSON.stringify(db));
            var audit = validateDb(imported, { repair: true, strict: true, source: "excel-import" });
            imported = audit.db;
            db = backup;   // restore immediately; Apply re-commits `imported`
            var curList = (imported.currencies || []).map(function (c) { return c.code; }).join(", ") || "-";
            var fb = (res.tickers && res.tickers.fallback) || [];
            var parsedAnything = (res.holdings + res.accounts + res.income + res.expense + (res.invoices || 0) + (res.retirement || 0)) > 0;
            var blocked = audit.errors.length > 0;
            var sheetNames = (wb.SheetNames || []).join(", ") || "-";
            var matchedSections = [
              res.accounts ? "Accounts/history" : "",
              res.holdings ? "Investments" : "",
              res.income ? "Income" : "",
              res.expense ? "Expenses" : "",
              (res.invoices || 0) ? "Tax invoices" : "",
              (res.retirement || 0) ? "Retirement" : "",
              (imported.currencies || []).length ? "Currencies" : "",
            ].filter(Boolean).join(", ") || "None";
            var sumRow = function (label, v) { return '<div class="kw-row"><span class="kw-label">' + label + '</span><span class="kw-list">' + v + "</span></div>"; };
            openModal({
              title: "Import preview - review before applying",
              sub: "Parsed " + esc(file.name) + ". Nothing is saved to your wallet until you apply.",
              body:
                '<div class="kw-rows">' +
                sumRow("Sheets detected", esc(sheetNames)) +
                sumRow("Sections matched", esc(matchedSections)) +
                sumRow("Holdings", res.holdings) +
                sumRow("Accounts", res.accounts) +
                sumRow("Monthly snapshots", res.snapshots) +
                sumRow("Cash-flow rows", (res.income + res.expense) + " (" + res.income + " income / " + res.expense + " expense)") +
                sumRow("Tax invoices", (res.invoices || 0)) +
                sumRow("Retirement inputs", (res.retirement || 0)) +
                sumRow("Currencies detected", esc(curList)) +
                sumRow("Tickers on US fallback", fb.length) +
                sumRow("Will overwrite", "Accounts, investments, snapshots, cash flow, tax invoices, retirement inputs and currencies") +
                "</div>" +
                (blocked ? '<div class="callout import-warn" style="margin-top:14px">' + icon("shield") + '<div><strong>Import blocked until these are fixed:</strong>' + validationIssueHtml(audit.errors) + "</div></div>" : "") +
                (!blocked && audit.warnings.length ? '<div class="help-box" style="margin-top:14px"><strong>Repaired while reading:</strong>' + validationIssueHtml(audit.warnings) + "</div>" : "") +
                (parsedAnything ? "" : '<div class="callout import-warn" style="margin-top:14px">' + icon("shield") + "<div>Nothing recognizable was parsed - this workbook may use an unsupported layout. Cancel and check it against the template.</div></div>") +
                '<p class="hint" style="margin:14px 0 0">Applying replaces your current accounts, holdings, snapshots and cash flow with the above. JSON remains the full-fidelity backup and restore format.</p>',
              submitLabel: blocked ? "Import Blocked" : (parsedAnything ? "Apply Import" : "Apply Anyway"),
              onSubmit: function () {
                if (blocked) { toast("Fix the validation issues before importing this workbook"); return false; }
                db = imported; save(); render();
                toast("Imported " + res.holdings + " holdings - " + res.accounts + " accounts - " + res.snapshots + " months - " + (res.income + res.expense) + " cash-flow rows");
                setTimeout(function () { tickerReportModal(res.tickers, function () { refreshAll(); }); }, 0);   // ticker summary -> live price sync
              },
            });
          } catch (e) { toast("I couldn't read that workbook. Check it is an .xlsx/.xls file using the Valutio template layout."); }
        };
        reader.onerror = function () { toast("I couldn't read that file. Try exporting it again, then re-import it."); };
        reader.readAsArrayBuffer(file);
      }).catch(function (e) { toast(e && e.message ? e.message : "Spreadsheet parser unavailable"); });
    };
    input.click();
  }
  // Starter workbook download. Ships the curated, pre-styled Wallet_Template.xlsx (a year/Accounts
  // matrix sheet → accounts + history, a Finance Buy/Sell ledger → investments, Incomes/Expenses
  // registers → cash flow, and a Tax invoice sheet) verbatim, so the download keeps its formatting and
  // matches exactly what ingestExcelWorkbook reads back in.
  function downloadExcelTemplate() {
    // Serve the curated, pre-styled starter workbook (coloured headers, bold labels, sized columns) as a
    // direct download, so what users get is exactly the layout the importer reads. Precached by the
    // service worker for offline use.
    toast("Downloading template…");
    fetch("./Templates/Wallet_Template.xlsx").then(function (r) { if (!r.ok) throw new Error("missing"); return r.blob(); })
      .then(function (blob) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a"); a.href = url; a.download = "Wallet_Template.xlsx"; a.click();
        URL.revokeObjectURL(url);
        toast("Template downloaded - Wallet_Template.xlsx");
      }).catch(function () { toast("Couldn't fetch the template (need to be online once)"); });
  }
  function downloadCashFlowTemplate() {
    toast("Downloading template...");
    fetch("./Templates/expenses_template_valutio.xlsx").then(function (r) { if (!r.ok) throw new Error("missing"); return r.blob(); })
      .then(function (blob) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a"); a.href = url; a.download = "expenses_template_valutio.xlsx"; a.click();
        URL.revokeObjectURL(url);
        toast("Template downloaded - expenses_template_valutio.xlsx");
      }).catch(function () { toast("Couldn't fetch the template (need to be online once)"); });
  }
  // The "Expenses" sheet is a category matrix: Column A = native category name, columns C..N =
  // Jan..Dec for the active year block, column O = row total. "Earnings"/"Expenses" rows switch
  // section; bare year numbers in Column A switch the year. We emit one record per (category,
  // month) with a non-zero value, keeping the true Column-A names (never "Other"/"Imported").
  function ingestExcelWorkbook(XLSX, wb) {
    var income = 0, expense = 0;
    var wbDollar = workbookDollarCcy(XLSX, wb);   // what a bare "$" means in this workbook (AUD vs USD)
    db.expenses = []; db.incomes = [];   // the workbook is the source of truth for cash flow
    // Cash-flow ledgers: any sheet named Expenses / Incomes (case-insensitive). Each is a category
    // matrix: Column A = native category, columns C..N = Jan..Dec, "Earnings"/"Expenses" rows switch
    // section and bare year numbers switch the year.
    var cashSheets = (wb.SheetNames || []).filter(function (s) { return /^(expenses|incomes?)$/i.test(String(s).trim()); });
    cashSheets.forEach(function (sname) {
      var ws = wb.Sheets[sname]; if (!ws) return;
      var defaultSection = /^(incomes?|earnings)$/i.test(String(sname).trim()) ? "income" : "expense";
      var aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
      // GOLD-STANDARD register layout (what the downloadable template produces): a header row with
      // Date + Category/Type + Amount, then one transaction per row. Detected first; falls back to the
      // legacy category×month matrix when no such header exists, so arbitrary real workbooks still load.
      var hdr = -1, cols = null;
      for (var r = 0; r < Math.min(aoa.length, 8); r++) {
        var cc = mapHeaderColumns(aoa[r] || []);
        if ((cc.category >= 0 || cc.date >= 0) && (cc.amount >= 0 || cc.value >= 0)) { hdr = r; cols = cc; break; }
      }
      if (hdr >= 0) {
        var arrH = (defaultSection === "income") ? db.incomes : db.expenses;
        var catsH = (defaultSection === "income") ? db.incomeCategories : db.expenseCategories;
        for (var i = hdr + 1; i < aoa.length; i++) {
          var dr = aoa[i] || [];
          var amt = num(cols.amount >= 0 ? dr[cols.amount] : dr[cols.value]);
          if (!(amt > 0)) continue;
          var cat = cols.category >= 0 ? String(dr[cols.category] == null ? "" : dr[cols.category]).trim() : "";
          if (!cat) cat = defaultSection === "income" ? "Income" : "Expense";
          var monthH = (cols.date >= 0 ? cellMonth(dr[cols.date]) : null) || currentMonth();
          // Currency: explicit column → sniff the amount cell's own format mask → base currency.
          var ccyH = (cols.currency >= 0 && dr[cols.currency]) ? String(dr[cols.currency]).trim().toUpperCase()
            : (cellCurrencyFromFormat(ws, XLSX, i, cols.amount >= 0 ? cols.amount : cols.value, wbDollar) || base());
          var noteH = cols.note >= 0 ? String(dr[cols.note] == null ? "" : dr[cols.note]).trim() : "";
          if (catsH.indexOf(cat) === -1) catsH.push(cat);
          ensureCurrency(ccyH);
          arrH.push({ id: uid(), month: monthH, category: cat, amount: amt, currency: ccyH, note: noteH });
          if (defaultSection === "income") income++; else expense++;
        }
        return;   // sheet fully handled by the register parser
      }
      // Legacy category × month matrix: Column A = native category, C..N = Jan..Dec, "Earnings"/
      // "Expenses" rows switch section, bare year numbers switch the year.
      var year = null, section = null;
      var isYear = function (v) { return typeof v === "number" && v >= 2000 && v <= 2100; };
      aoa.forEach(function (row, R) {
        if (!row) return;
        var a = row[0];
        if (isYear(a)) { year = Math.round(a); return; }
        var label = (a == null) ? "" : String(a).trim();
        if (!label) return;
        if (/^earnings$/i.test(label) || /^incomes?$/i.test(label)) { section = "income"; return; }
        if (/^expenses$/i.test(label) || label === "Joint Account") { section = "expense"; return; }
        if (/^(total|exch)/i.test(label)) return;            // skip total / FX helper rows
        if (!section || !year) return;
        var arr = (section === "income") ? db.incomes : db.expenses;
        var cats = (section === "income") ? db.incomeCategories : db.expenseCategories;
        if (cats.indexOf(label) === -1) cats.push(label);    // preserve the native category name
        for (var j = 2; j <= 13; j++) {                      // C..N => Jan..Dec
          var v = row[j];
          if (typeof v === "number" && v > 0) {
            // No currency text column in a matrix sheet - sniff each value cell's own number-format
            // mask (e.g. [$£], [$€], accounting $ glyphs) so amounts map to their real currency
            // instead of blindly defaulting to EUR. Falls back to the base currency when unmarked.
            var mc = cellCurrencyFromFormat(ws, XLSX, R, j, wbDollar) || base();
            ensureCurrency(mc);
            arr.push({ id: uid(), month: year + "-" + String(j - 1).padStart(2, "0"), category: label, amount: v, currency: mc, note: "" });
            if (section === "income") income++; else expense++;
          }
        }
      });
    });
    // Independent seeding: create accounts + holdings from the workbook, THEN map tickers onto them.
    // Gold-standard FIRST - a Finance sheet laid out as a dated Buy/Sell transaction ledger (the
    // template schema) ingests cleanly into per-holding txn histories; otherwise fall back to the
    // multi-year Finance-block matrix parser used for arbitrary/real workbooks.
    var portfolio = seedPortfolioFromLedger(XLSX, wb) || seedPortfolioFromWorkbook(XLSX, wb);
    // Layout-agnostic fallback: if no structured portfolio was found, ingest holdings from ANY sheet
    // that carries Asset + Numeric headers (Ticker/Symbol/Asset/Holding × Amount/Quantity/Shares/Value/Total Cost).
    if (portfolio.holdings === 0) { seedHoldingsFromHeaders(XLSX, wb); portfolio.holdings = db.holdings.length; }
    // Accounts live in the year sheets' Liquidity / Savings / Super sections. The gold-standard ledger
    // path (seedPortfolioFromLedger) only builds holdings, so when it ran - or any path left accounts
    // empty - seed the live Accounts list from the latest year sheet here. Otherwise a clean ledger-style
    // template would leave the Accounts page (and the current-month dashboard) empty.
    if (!db.accounts.length) {
      var psAcc = parsePortfolioSheet(XLSX, wb).accounts;
      if (psAcc.length) {
        db.accounts = psAcc.map(function (a) { ensureCurrency(a.currency); return { id: uid(), name: a.name, bucket: a.bucket, currency: a.currency, balance: num(a.balance) }; });
        portfolio.accounts = db.accounts.length;
      }
    }
    // Align each holding's CURRENT price to the latest year-sheet market value (value ÷ live shares),
    // so the live current-month valuation matches the imported monthly trend even before a price refresh.
    // (The ledger path otherwise leaves the price at the last transaction's price.)
    var psH = parsePortfolioSheet(XLSX, wb).holdings;
    if (psH.length && db.holdings.length) {
      var valByName = {}; psH.forEach(function (p) { valByName[String(p.name).toLowerCase()] = num(p.value); });
      db.holdings.forEach(function (h) {
        var v = valByName[String(h.name).toLowerCase()];
        if (!(v > 0)) return;
        var sh = positionAt(h, currentMonth()).shares;
        if (sh > 1e-9) h.price = v / sh;
      });
    }
    // Tax: import freelance invoices (+ employment figures) from a "Tax" sheet, if present.
    var taxRes = ingestTax(XLSX, wb);
    var retirementRes = ingestRetirement(XLSX, wb);
    // Timeline parity: rebuild the monthly snapshot history that feeds History + dashboard charts.
    db.snapshots = buildHistoricalSnapshots(XLSX, wb);
    recomputeAllSnapshots();   // recompute the live month; imported closed months keep their stored frozen base
    // Re-base every currency rate (incl. ones only used by invoices/accounts seeded above) onto the base.
    db.currencies.forEach(function (c) { if (c.code === base()) { c.rate = 1; return; } var rr = metaRateInBase(c.code); if (rr) c.rate = num(rr); });
    // Strict scoping: keep only the currencies actually present in the imported data (+ base).
    pruneCurrencies();
    return { income: income, expense: expense, accounts: portfolio.accounts, holdings: portfolio.holdings, snapshots: db.snapshots.length, invoices: taxRes.invoices, retirement: retirementRes, tickers: portfolio.report };
  }
  // Import the Retirement page's editable projection inputs from a "Retirement" sheet.
  function ingestRetirement(XLSX, wb) {
    var fn = findSheetName(wb, /^retirement$/i);
    var ws = fn && wb.Sheets[fn]; if (!ws || !ws["!ref"]) return 0;
    var aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
    if (!db.retirement || typeof db.retirement !== "object") db.retirement = {};
    var n = 0;
    var setIf = function (re, key) {
      aoa.forEach(function (row) {
        if (!row || typeof row[0] !== "string" || !re.test(row[0].trim())) return;
        for (var j = 1; j < row.length; j++) {
          if (row[j] !== null && row[j] !== "") { db.retirement[key] = num(row[j]); n++; break; }
        }
      });
    };
    setIf(/^annual\s*salary/i, "salary");
    setIf(/^extra\s*employer/i, "employerExtra");
    setIf(/^voluntary/i, "voluntary");
    syncRetireStateFromDb();
    return n;
  }
  // Import the Tax page's data from a "Tax"/"Taxes" sheet: freelance invoices (a Date + Amount register,
  // optional Currency/Note) plus optional labelled employment figures (Employment Income, Tax Paid, Other
  // Income). Invoices land in the ACTIVE tax year; brackets/year/currency stay as configured in-app.
  function ingestTax(XLSX, wb) {
    var fn = findSheetName(wb, /^tax(es)?$/i);
    var ws = fn && wb.Sheets[fn]; if (!ws || !ws["!ref"]) return { invoices: 0 };
    var aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
    var setIf = function (re, set) {
      aoa.forEach(function (row) {
        if (!row || typeof row[0] !== "string" || !re.test(row[0].trim())) return;
        for (var j = 1; j < row.length; j++) { if (typeof row[j] === "number") { set(row[j]); break; } }
      });
    };
    setIf(/^employment\s*income/i, function (v) { db.tax.employmentIncome = v; });
    setIf(/^(employment\s*)?tax\s*paid/i, function (v) { db.tax.employmentTaxPaid = v; });
    setIf(/^other\s*income/i, function (v) { db.tax.otherIncome = v; });
    // Invoice register: first row carrying both a Date and an Amount header, then one invoice per row.
    var hdr = -1, cols = null;
    for (var r = 0; r < Math.min(aoa.length, 12); r++) {
      var cc = mapHeaderColumns(aoa[r] || []);
      if (cc.date >= 0 && (cc.amount >= 0 || cc.value >= 0)) { hdr = r; cols = cc; break; }
    }
    if (hdr < 0) return { invoices: 0 };
    db.tax.invoices = [];   // the workbook is the source of truth for invoices
    var n = 0;
    for (var i = hdr + 1; i < aoa.length; i++) {
      var dr = aoa[i] || [];
      var amt = num(cols.amount >= 0 ? dr[cols.amount] : dr[cols.value]);
      if (!(amt > 0)) continue;
      var dateInfo = cols.date >= 0 ? cellDateInfo(dr[cols.date]) : null; if (!dateInfo) continue;
      var invoiceDate = dateInfo.date || dateInfo.month + "-15";
      if (!dateInTaxYear(invoiceDate, db.tax)) continue;
      var ccy = (cols.currency >= 0 && dr[cols.currency]) ? String(dr[cols.currency]).trim().toUpperCase() : (db.tax.currency || base());
      var note = cols.note >= 0 ? String(dr[cols.note] == null ? "" : dr[cols.note]).trim() : "";
      ensureCurrency(ccy);
      db.tax.invoices.push({ id: uid(), date: invoiceDate, taxYear: db.tax.year, amount: amt, currency: ccy, note: note });
      n++;
    }
    return { invoices: n };
  }

  // ---- ticker -> native currency (from the exchange prefix / suffix) ----
  var EXCH_CCY = {
    ETR: "EUR", XETR: "EUR", FRA: "EUR", XFRA: "EUR", VIE: "EUR", EPA: "EUR", XPAR: "EUR", AMS: "EUR", XAMS: "EUR", MIL: "EUR", XMIL: "EUR", MAD: "EUR", BME: "EUR", LIS: "EUR", BRU: "EUR", HEL: "EUR", STU: "EUR", MUN: "EUR", BER: "EUR", DUS: "EUR", HAM: "EUR", IBIS: "EUR",
    SWX: "CHF", EBS: "CHF", VTX: "CHF", LON: "GBP", LSE: "GBP", XLON: "GBP",
    NASDAQ: "USD", NAS: "USD", NMS: "USD", NYSE: "USD", NYQ: "USD", ARCA: "USD", BATS: "USD", AMEX: "USD", PCX: "USD",
    ASX: "AUD", XASX: "AUD", TSE: "CAD", TSX: "CAD", HKG: "HKD", XHKG: "HKD", TYO: "JPY", JPX: "JPY", SGX: "SGD", JSE: "ZAR", NZX: "NZD",
  };
  var DOT_CCY = { DE: "EUR", F: "EUR", PA: "EUR", AS: "EUR", MI: "EUR", MC: "EUR", VI: "EUR", BR: "EUR", LS: "EUR", L: "GBP", SW: "CHF", AX: "AUD", TO: "CAD", V: "CAD", HK: "HKD", T: "JPY", SI: "SGD", JO: "ZAR", NZ: "NZD", NS: "INR", BO: "INR" };
  function tickerCurrency(t, fb) {
    t = String(t || "").toUpperCase();
    if (t.indexOf(":") >= 0) { var ex = t.split(":")[0]; if (EXCH_CCY[ex]) return EXCH_CCY[ex]; }
    if (t.indexOf("-") >= 0) { var c = t.split("-").pop(); if (/^[A-Z]{3}$/.test(c)) return c; }   // BTC-AUD
    if (t.indexOf(".") >= 0) { var sf = t.split(".").pop(); if (DOT_CCY[sf]) return DOT_CCY[sf]; }
    return fb || "USD";
  }
  function isQualifiedTicker(t) { return /[:.\-]/.test(String(t || "")); }
  // value pickers across a year matrix row (C..O = 2..14, Q = 16 is the year total)
  function lastNum(row) { var v = null; for (var j = 2; j <= 14; j++) { if (typeof row[j] === "number" && !isNaN(row[j])) v = row[j]; } return v; }
  function firstNum(row) { for (var j = 2; j <= 14; j++) { if (typeof row[j] === "number" && row[j] !== 0) return row[j]; } return null; }
  function totalNum(row) { return (typeof row[16] === "number") ? row[16] : lastNum(row); }

  // Read the latest "Finance YYYY" section's per-holding blocks. Each block header (Column A) is a
  // holding identifier; sub-rows carry Total Shares / Buy Price / Real Time Price / Realized P/L,
  // and the Real Time Price row holds a =GOOGLEFINANCE("ETR:AMD"…) formula -> the regional ticker.
  function parseFinanceBlocks(XLSX, wb) {
    var fn = findSheetName(wb, /^(finance|real[\s.]*time[\s.]*prices?)$/i);
    var ws = fn && wb.Sheets[fn]; if (!ws || !ws["!ref"]) return [];
    var aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
    var LBL = /^(total shares|monthly buy shares|buy price|fees|cost|real time price|market value|growth|profit|change %|unrealized p\/l|sold shares|sale price|sold value|realized p\/l|total return|total return %|shares|purchase)$/i;
    // map row index -> GOOGLEFINANCE ticker, read from cell formulas
    var gfByRow = {};
    Object.keys(ws).forEach(function (addr) {
      if (addr.charAt(0) === "!") return;
      var f = ws[addr] && ws[addr].f; if (!f) return;
      var m = /GOOGLEFINANCE\(\s*"+\s*([A-Z0-9:.\-]+)/i.exec(String(f).replace(/""/g, '"'));
      if (!m || /^CURRENCY/i.test(m[1])) return;
      gfByRow[XLSX.utils.decode_cell(addr).r] = m[1];
    });
    // Parse EVERY "finance YYYY" block group top-to-bottom (not just the latest year) so the full
    // multi-year ledger - every buy and sell back to the earliest sheet - is captured. Each holding
    // section is tagged with the year of the group it belongs to; transactions are stitched per
    // holding across years downstream (seedPortfolioFromWorkbook), with only the earliest year's
    // opening lot kept so carried balances aren't double-counted.
    var blocks = [], cur = null, curYear = -1, inGroup = false;
    for (var R = 0; R < aoa.length; R++) {
      var row = aoa[R] || [], a = row[0];
      if (typeof a !== "string") continue;
      var label = a.trim(); if (!label) continue;
      var ym = /^finance\s+(\d{4})/i.exec(label);
      if (ym) { curYear = +ym[1]; cur = null; inGroup = true; continue; }   // enter a new year's block group
      if (!inGroup) continue;                                                // skip anything before the first group
      if (!LBL.test(label) && !/^(capital gains|total|amount|value|sell|exch|monthly)/i.test(label)) {
        cur = { header: label, year: curYear, shares: null, buy: null, cost: null, price: null, realized: null, gfTicker: null,
          totalSharesRow: null, monthlyBuy: null, buyPriceRow: null, feesRow: null, soldRow: null, saleRow: null, amountRow: null, costRow: null };
        blocks.push(cur); continue;
      }
      if (!cur) continue;
      var ll = label.toLowerCase();
      // Capture the full per-month rows so individual purchases/sales become distinct dated entries.
      // Two layouts coexist across years: the current one splits "Total Shares" (cumulative) from
      // "Monthly Buy Shares" (per-month purchases); the legacy 2024/2025 layout has only "Shares",
      // which IS the per-month buy series - so it must seed monthlyBuy, not just the cumulative total,
      // or every legacy buy is silently dropped (the truncation that hid all pre-2026 history).
      if (ll === "total shares") { cur.shares = lastNum(row); cur.totalSharesRow = row; }
      else if (ll === "shares") {
        cur.shares = lastNum(row);
        if (!cur.totalSharesRow) cur.totalSharesRow = row;   // col C still carries any opening position
        if (!cur.monthlyBuy) cur.monthlyBuy = row;           // the row itself is the monthly-buy series
      }
      else if (ll === "amount") { cur.shares = lastNum(row); cur.amountRow = row; }   // fractional crypto qty (cumulative)
      else if (ll === "monthly buy shares") cur.monthlyBuy = row;
      else if (ll === "buy price" || ll === "purchase") { if (cur.buy == null) cur.buy = firstNum(row); cur.buyPriceRow = row; }
      else if (ll === "fees") cur.feesRow = row;
      else if (ll === "cost") { cur.cost = totalNum(row); cur.costRow = row; }
      else if (ll === "sold shares") cur.soldRow = row;
      else if (ll === "sale price") cur.saleRow = row;
      else if (ll === "real time price") { cur.price = lastNum(row); if (gfByRow[R]) cur.gfTicker = gfByRow[R]; }
      else if (ll === "realized p/l") cur.realized = totalNum(row);
    }
    return blocks;
  }
  // Build a holding's distinct transaction ledger from a Finance block: an opening lot (position
  // carried into the year, col C = Dec of the prior year) plus every monthly buy and sell as its
  // own dated entry. Cost basis falls out natively as the sum of these un-aggregated parts.
  function financeBlockTransactions(blk, opts) {
    if (!blk || !blk.year) return [];
    var y = blk.year, txns = [], skipOpening = !!(opts && opts.skipOpening);
    var monthForCol = function (j) { return j === 2 ? (y - 1) + "-12" : y + "-" + String(j - 2).padStart(2, "0"); };
    var openRow = blk.totalSharesRow || blk.amountRow;
    // The opening lot (col C = balance carried in from the prior year) is only emitted for a holding's
    // EARLIEST year; later years inherit that balance from the preceding year's stitched transactions,
    // so emitting it again would double-count the carried position.
    if (openRow && !skipOpening) {
      var open = num(openRow[2]);   // col C = position carried in from the prior year
      if (open > 0) {
        var op = (blk.buy != null && blk.buy > 0) ? blk.buy : (blk.cost > 0 && blk.shares > 0 ? blk.cost / blk.shares : (blk.price || 0));
        txns.push({ id: uid(), month: monthForCol(2), type: "buy", shares: open, price: op, fees: 0 });
      }
    }
    for (var j = 3; j <= 14; j++) {
      var month = monthForCol(j);
      if (blk.monthlyBuy && num(blk.monthlyBuy[j]) > 0) {            // explicit monthly buy (stocks/ETFs)
        txns.push({ id: uid(), month: month, type: "buy", shares: num(blk.monthlyBuy[j]),
          price: blk.buyPriceRow ? num(blk.buyPriceRow[j]) : (blk.price || 0), fees: blk.feesRow ? num(blk.feesRow[j]) : 0 });
      } else if (!blk.monthlyBuy && blk.amountRow) {                 // crypto: derive buys from cumulative-amount deltas
        var d = num(blk.amountRow[j]) - num(blk.amountRow[j - 1]);
        if (d > 1e-12) {
          var c = blk.costRow ? num(blk.costRow[j]) : 0;
          txns.push({ id: uid(), month: month, type: "buy", shares: d, price: c > 0 ? c / d : (blk.price || 0), fees: 0 });
        }
      }
      if (blk.soldRow && num(blk.soldRow[j]) > 0) {                  // sells
        txns.push({ id: uid(), month: month, type: "sell", shares: num(blk.soldRow[j]),
          price: blk.saleRow ? num(blk.saleRow[j]) : (blk.price || 0), fees: 0 });
      }
    }
    return txns;
  }
  // Stitch a single holding's transactions across EVERY year block it appears in (Finance 2024,
  // 2025, 2026, …) into one continuous, chronologically-ordered ledger. Only the earliest year keeps
  // its opening lot; subsequent years contribute just their monthly buys/sells so the running balance
  // carries over month-by-month and year-by-year without gaps or double-counting.
  function financeBlockTransactionsAcrossYears(list) {
    var sorted = (list || []).slice().sort(function (a, b) { return (a.year || 0) - (b.year || 0); });
    var out = [];
    sorted.forEach(function (blk, i) { out = out.concat(financeBlockTransactions(blk, { skipOpening: i > 0 })); });
    return out;
  }
  // Cross-year identity key for a Finance block. Legacy year blocks (2024/2025) head each holding
  // with its raw exchange ticker (e.g. "ETR:AMD"); the current block heads it with the display name
  // ("AMD") but carries the same ticker in its GOOGLEFINANCE formula. Keying on ticker-or-header
  // (uppercased) lets the same instrument be stitched together across every year it appears.
  function blockTickerKey(blk) { return String((blk && (blk.gfTicker || blk.header)) || "").trim().toUpperCase(); }

  // Which dollar does a bare "$" mean in this workbook? Decide from context: scan every string cell
  // for explicit AUD vs USD markers (A$, US$, "AUD", "USD"). AUD wins when present (and is implied by
  // markers like "AUD $" / "Exch AUD to EUR"); otherwise USD. Never blindly assumes USD without scan.
  function workbookDollarCcy(XLSX, wb) {
    var aud = 0, usd = 0;
    (wb.SheetNames || []).forEach(function (sn) {
      var ws = wb.Sheets[sn]; if (!ws) return;
      Object.keys(ws).forEach(function (addr) {
        if (addr.charAt(0) === "!") return;
        var v = ws[addr] && ws[addr].v;
        if (typeof v !== "string") return;
        if (/A\$|\bAUD\b/i.test(v)) aud++;
        if (/US\$|\bUSD\b/i.test(v)) usd++;
      });
    });
    return (aud > 0 && aud >= usd) ? "AUD" : (usd > 0 ? "USD" : "USD");
  }
  // Resolve a labelled account/balance to a currency from its symbols & text. "$" defers to the
  // workbook's detected dollar currency so AUD-denominated accounts ("ING Savings $") map to AUD.
  function accountCurrency(label, dollarCcy) {
    var s = String(label || "");
    if (/A\$/.test(s) || /\bAUD\b/i.test(s)) return "AUD";
    if (/US\$/.test(s) || /\bUSD\b/i.test(s)) return "USD";
    if (/£/.test(s) || /\bGBP\b/i.test(s)) return "GBP";
    if (/€/.test(s) || /\bEUR\b/i.test(s)) return "EUR";
    if (/\bCHF\b/i.test(s)) return "CHF";
    if (/\$/.test(s)) return dollarCcy || "USD";
    return null;
  }

  // Read the latest year sheet (e.g. "2026"): ordered holdings (ETF/Stocks/Crypto sections) and
  // accounts (Liquidity->Cash, Savings->Savings, Super->Pension), with the current value/balance.
  // ---- Flexible accounts/holdings "matrix" sheet detection ----
  // A matrix sheet lists accounts + holdings as rows under single-word section headers (Column A) with a
  // month value series across the columns. It may be named by year ("2026"), by anything else
  // ("Accounts & Holdings"), and the month series may start in any column. These helpers locate it,
  // its year, and where Jan begins so the same parser reads the legacy and the curated-template layouts.
  var MATRIX_SECT = /^(liquidity|savings|super|pension|etf|stocks|crypto)$/i;
  function isMatrixSheet(aoa) {
    for (var r = 0; r < aoa.length; r++) { var a = aoa[r] && aoa[r][0]; if (typeof a === "string" && MATRIX_SECT.test(a.trim())) return true; }
    return false;
  }
  // Column index where the Jan..Dec series begins (scan the top rows for a "Jan" header). Falls back to
  // 3 - the legacy "A | B | Dec-prior | Jan..Dec" layout where Jan sits in column D.
  function matrixMonthStart(aoa) {
    for (var r = 0; r < Math.min(aoa.length, 6); r++) {
      var row = aoa[r] || [];
      for (var c = 0; c < row.length; c++) { if (typeof row[c] === "string" && /^jan(uary)?$/i.test(row[c].trim())) return c; }
    }
    return 3;
  }
  // The calendar year a matrix sheet represents: a 4-digit sheet name, else a 20xx year in its title
  // cells, else the current year.
  function matrixYear(sheetName, aoa) {
    if (/^\d{4}$/.test(String(sheetName).trim())) return +String(sheetName).trim();
    for (var r = 0; r < Math.min(aoa.length, 3); r++) {
      var row = aoa[r] || [];
      for (var c = 0; c < Math.min(row.length, 4); c++) { if (row[c] != null) { var m = /(20\d{2})/.exec(String(row[c])); if (m) return +m[1]; } }
    }
    return new Date().getFullYear();
  }
  // Every matrix sheet in the workbook: 4-digit year tabs OR any tab carrying matrix section headers.
  function matrixSheetNames(XLSX, wb) {
    return (wb.SheetNames || []).filter(function (sn) {
      if (/^\d{4}$/.test(String(sn).trim())) return true;
      var ws = wb.Sheets[sn]; if (!ws || !ws["!ref"]) return false;
      return isMatrixSheet(XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null }));
    });
  }
  // Last numeric value within a column window [a..b] of a row.
  function lastNumIn(row, a, b) { var v = null; for (var j = a; j <= b; j++) { if (typeof row[j] === "number" && !isNaN(row[j])) v = row[j]; } return v; }

  function parsePortfolioSheet(XLSX, wb) {
    var holdings = [], accounts = [];
    var names = matrixSheetNames(XLSX, wb);
    if (!names.length) return { holdings: holdings, accounts: accounts };
    // Pick the latest year's matrix sheet (live balances/values come from the most recent one).
    var best = null, bestY = -1;
    names.forEach(function (sn) {
      var ws = wb.Sheets[sn]; if (!ws) return;
      var aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
      var y = matrixYear(sn, aoa);
      if (y >= bestY) { bestY = y; best = aoa; }
    });
    if (!best) return { holdings: holdings, accounts: accounts };
    var janCol = matrixMonthStart(best);
    var SECT = { liquidity: "acc-cash", savings: "acc-savings", "super": "acc-pension", pension: "acc-pension", etf: "etf", stocks: "stock", crypto: "crypto" };
    var dollarCcy = workbookDollarCcy(XLSX, wb);   // disambiguate "$" -> AUD vs USD from sheet context
    var section = null;
    best.forEach(function (row) {
      var a = row && row[0]; if (a == null) return;
      var label = String(a).trim(); if (!label) return;
      var key = label.toLowerCase();
      if (key === "finance") { section = null; return; }
      if (SECT[key] !== undefined) { section = SECT[key]; return; }
      if (!section || /^(capital gains|exch|pending|gross|total|wallet)/i.test(label)) return;
      var val = lastNumIn(row, janCol, janCol + 11);
      if (section.indexOf("acc-") === 0) {
        var bucket = section === "acc-cash" ? "Cash" : section === "acc-savings" ? "Savings" : "Pension";
        var ccy = accountCurrency(label, dollarCcy) || (bucket === "Pension" ? ((TAX_PRESETS[db.settings.country] || {}).currency || dollarCcy) : dollarCcy);
        var nm = label.replace(/[€£$‎‎\s]+$/, "").trim();
        accounts.push({ name: nm, bucket: bucket, currency: ccy, balance: val || 0 });
      } else {
        holdings.push({ name: label, type: section, value: val || 0 });
      }
    });
    return { holdings: holdings, accounts: accounts };
  }

  // Independent data source: build accounts + holdings as NEW records straight from the workbook
  // (works even on a reset/empty app), pairing each holding with its Finance block (same order) to
  // pull shares/price/realized + the exact regional ticker & currency. Returns the mapping report.
  function seedPortfolioFromWorkbook(XLSX, wb) {
    // Currencies are instantiated per-item below (only those a holding/account actually uses);
    // ingestExcelWorkbook then prunes the pool to exactly the data's currencies.
    var ps = parsePortfolioSheet(XLSX, wb), allBlocks = parseFinanceBlocks(XLSX, wb);
    // The latest year's blocks define the live holding list (identity, ticker, current price/shares);
    // group every year's blocks by holding header so each holding's full multi-year ledger is stitched.
    var latestYear = allBlocks.reduce(function (m, b) { return Math.max(m, b.year || 0); }, 0);
    var blocks = allBlocks.filter(function (b) { return b.year === latestYear; });
    var blocksByKey = {};
    allBlocks.forEach(function (b) {
      var k = blockTickerKey(b); if (!k) return;
      (blocksByKey[k] || (blocksByKey[k] = [])).push(b);
    });
    var verified = [], fallback = [];
    db.accounts = []; db.holdings = [];   // the workbook is the source of truth (enables the header fallback)
    if (ps.accounts.length) {
      db.accounts = ps.accounts.map(function (a) { ensureCurrency(a.currency); return { id: uid(), name: a.name, bucket: a.bucket, currency: a.currency, balance: num(a.balance) }; });
    }
    // The Finance blocks are the authoritative holding list; cap to them so summary/allocation rows
    // beneath the year sheet's Crypto section are never mistaken for holdings.
    var holdRows = blocks.length ? ps.holdings.slice(0, blocks.length) : ps.holdings;
    if (holdRows.length) {
      db.holdings = holdRows.map(function (h, i) {
        var blk = blocks[i] || {};
        var rawTk = blk.gfTicker || (isQualifiedTicker(blk.header) ? blk.header : null);
        var resolved = !!(blk.gfTicker || isQualifiedTicker(blk.header));   // came from the real-time-price blueprint
        var ticker = rawTk || h.name;
        var ccy = resolved ? tickerCurrency(rawTk, h.type === "etf" ? "EUR" : "USD") : (h.type === "etf" ? "EUR" : h.type === "crypto" ? "EUR" : "USD");
        ensureCurrency(ccy);
        // High-precision: keep exact fractional quantities (e.g. 0.03715 BTC); never coerce to 1/round.
        var shares = (blk.shares != null) ? blk.shares : null;
        var price = (blk.price != null && blk.price > 0) ? blk.price : null;
        if (shares == null && price && h.value > 0) shares = h.value / price;
        if (price == null && shares) price = h.value / shares;
        if (shares == null) shares = 0;
        if (price == null) price = 0;
        var buy = (blk.buy != null && blk.buy > 0) ? blk.buy
          : (blk.cost > 0 && shares > 0 ? blk.cost / shares : price);
        // Granular ledger: preserve each distinct purchase/sale; only fall back to a single
        // aggregate lot when the block carries no per-month detail. Realized P/L then derives from
        // the explicit sells, so it isn't double-counted via realizedSeed.
        var keyTk = blockTickerKey(blk);
        var txns = financeBlockTransactionsAcrossYears(blocksByKey[keyTk] || [blk]);
        var obj = {
          id: uid(), name: h.name, ticker: ticker, type: h.type, currency: ccy, price: price,
          apiSymbol: (h.type === "crypto" ? "" : ticker), coingeckoId: "",
          realizedSeed: txns.length ? 0 : (num(blk.realized) || 0), transactions: txns,
        };
        if (!txns.length && shares > 0) obj.transactions.push({ id: uid(), month: currentMonth(), type: "buy", shares: shares, price: buy, fees: 0 });
        if (h.type !== "crypto") {
          if (resolved) verified.push({ name: h.name, ticker: ticker, currency: ccy });
          else fallback.push({ name: h.name, ticker: ticker, currency: ccy });
        }
        return obj;
      });
    }
    // FX parity: express every imported currency relative to the active base so US (USD) and other
    // foreign holdings convert correctly for valuation + performance on the investments/dashboard.
    db.currencies.forEach(function (c) {
      if (c.code === base()) { c.rate = 1; return; }
      var r = metaRateInBase(c.code);
      if (r) c.rate = num(r);
    });
    return { accounts: db.accounts.length, holdings: db.holdings.length, report: { verified: verified, fallback: fallback, updated: verified.length } };
  }

  // Layout-agnostic header mapper: scan a row for the exact asset/numeric vocabulary (case-insensitive)
  // and return the matched column indices. Works on arbitrary spreadsheet layouts.
  function mapHeaderColumns(row) {
    var c = { asset: -1, ticker: -1, shares: -1, value: -1, cost: -1, price: -1, category: -1, amount: -1, date: -1, action: -1, note: -1, currency: -1 };
    (row || []).forEach(function (cell, i) {
      if (typeof cell !== "string") return;
      var h = cell.trim().toLowerCase();
      if (c.ticker < 0 && /\b(ticker|symbol)\b/.test(h)) c.ticker = i;
      if (c.action < 0 && IMPORT_VOCAB.action.test(h)) c.action = i;
      if (c.asset < 0 && IMPORT_VOCAB.asset.test(h)) c.asset = i;
      if (c.shares < 0 && /\b(quantity|shares|units)\b/.test(h)) c.shares = i;
      if (c.cost < 0 && /total\s*cost/.test(h)) c.cost = i;
      if (c.value < 0 && /\bvalue\b/.test(h)) c.value = i;
      if (c.amount < 0 && /\bamount\b/.test(h)) c.amount = i;
      if (c.price < 0 && /\bprice\b/.test(h)) c.price = i;
      if (c.date < 0 && IMPORT_VOCAB.date.test(h)) c.date = i;
      if (c.note < 0 && /\b(note|notes|description|memo)\b/.test(h)) c.note = i;
      if (c.currency < 0 && /\b(currency|ccy|curr)\b/.test(h)) c.currency = i;
      if (c.category < 0 && IMPORT_VOCAB.cat.test(h)) c.category = i;
    });
    if (c.asset < 0 && c.ticker >= 0) c.asset = c.ticker;
    return c;
  }
  function cellDateInfo(v) {
    if (v == null || v === "") return null;
    var d = null;
    if (v instanceof Date && !isNaN(v)) d = new Date(Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate()));
    else if (typeof v === "number") d = new Date(Math.round((v - 25569) * 86400 * 1000));
    else {
      var s = String(v).trim(), exact = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/.exec(s);
      if (exact) {
        var iso = exact[1] + "-" + String(+exact[2]).padStart(2, "0") + "-" + String(+exact[3]).padStart(2, "0");
        return validDateString(iso) ? { date: iso, month: iso.slice(0, 7), precision: "day" } : null;
      }
      var monthOnly = /^(\d{4})[-\/.](\d{1,2})$/.exec(s);
      if (monthOnly) { var mo = monthOnly[1] + "-" + String(+monthOnly[2]).padStart(2, "0"); return validMonthString(mo) ? { date: null, month: mo, precision: "month" } : null; }
      d = new Date(s);
    }
    if (!d || isNaN(d)) return null;
    var out = isoDateUTC(d); return validDateString(out) ? { date: out, month: out.slice(0, 7), precision: "day" } : null;
  }
  // Normalize any date-ish cell to a monthly period key for account and cash-flow imports.
  function cellMonth(v) {
    var info = cellDateInfo(v); return info ? info.month : null;
  }
  // Currency-from-formatting sniffer. When a row carries no explicit currency text column, the
  // numeric cell's own format mask usually still encodes one - a glyph (€ £ $ ¥), an ISO code, or an
  // Excel locale tag like [$£-809] / [$€-x-euro2]. Inspect that string and infer the currency. A bare
  // "$" stays ambiguous (returns null) so the caller can disambiguate against the workbook context.
  function currencyFromMask(s) {
    if (!s) return null;
    if (/A\$|AU\$|\bAUD\b/i.test(s)) return "AUD";
    if (/US\$|\bUSD\b/i.test(s)) return "USD";
    if (/€|\bEUR\b|euro/i.test(s)) return "EUR";
    if (/£|\bGBP\b/i.test(s)) return "GBP";
    if (/\bCHF\b|SFr/i.test(s)) return "CHF";
    if (/¥|\bJPY\b/i.test(s)) return "JPY";
    if (/\bCNY\b|\bRMB\b/i.test(s)) return "CNY";
    if (/C\$|\bCAD\b/i.test(s)) return "CAD";
    if (/NZ\$|\bNZD\b/i.test(s)) return "NZD";
    if (/HK\$|\bHKD\b/i.test(s)) return "HKD";
    if (/S\$|\bSGD\b/i.test(s)) return "SGD";
    // Excel locale currency tag: [$<symbol>-<lcid>] - pull a bare ISO code if present.
    var m = /\[\$\s*([A-Za-z]{3})\b/.exec(s); if (m) return m[1].toUpperCase();
    return null;
  }
  // Read a worksheet cell's number-format ('.z') + cached formatted text ('.w') and sniff its
  // currency, addressing the cell by (row, column) so it works alongside a raw sheet_to_json pass.
  function cellCurrencyFromFormat(ws, XLSX, rowIdx, colIdx, dollarCcy) {
    if (!ws || colIdx == null || colIdx < 0) return null;
    var cell = ws[XLSX.utils.encode_cell({ r: rowIdx, c: colIdx })];
    if (!cell) return null;
    var s = String(cell.z || "") + " " + String(cell.w || "");
    var c = currencyFromMask(s);
    if (c) return c;
    // A bare "$" mask (no country letter, e.g. Google Sheets' [$$]) is ambiguous on its own; resolve it
    // to the workbook's detected dollar currency (AUD vs USD) so $-denominated cells aren't lost to the
    // base-currency fallback. Without that context, leave it unresolved.
    if (dollarCcy && /\$/.test(s)) return dollarCcy;
    return null;
  }
  // GOLD-STANDARD asset-ledger parser. Reads a Finance sheet laid out as a dated transaction register
  // (header row: Date - Asset - Ticker - Action - Shares - Price - Total Cost - Currency) and folds the
  // rows into per-holding transaction histories - each Buy/Sell becomes a discrete dated lot, so cost
  // basis, realized P/L and multi-period positions (positionAt) reconstruct natively. Returns null when
  // the Finance sheet isn't a ledger (no Asset+Shares/Price+Action/Date header), letting the legacy
  // multi-year Finance-block matrix parser take over for arbitrary/real workbooks.
  function seedPortfolioFromLedger(XLSX, wb) {
    var fn = findSheetName(wb, /^(finance|portfolio|holdings|investments|trades?|transactions?)$/i);
    var ws = fn && wb.Sheets[fn]; if (!ws || !ws["!ref"]) return null;
    var aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
    var wbDollar = workbookDollarCcy(XLSX, wb);
    var hdr = -1, cols = null;
    for (var r = 0; r < Math.min(aoa.length, 12); r++) {
      var cc = mapHeaderColumns(aoa[r] || []);
      if (cc.asset >= 0 && (cc.shares >= 0 || cc.price >= 0) && (cc.action >= 0 || cc.date >= 0)) { hdr = r; cols = cc; break; }
    }
    if (hdr < 0) return null;
    var map = {}, order = [];
    for (var i = hdr + 1; i < aoa.length; i++) {
      var dr = aoa[i] || [];
      var nameRaw = cols.asset >= 0 ? dr[cols.asset] : (cols.ticker >= 0 ? dr[cols.ticker] : null);
      var name = String(nameRaw == null ? "" : nameRaw).trim(); if (!name) continue;
      var shares = cols.shares >= 0 ? num(dr[cols.shares]) : 0;
      var price = cols.price >= 0 ? num(dr[cols.price]) : 0;
      var totalCost = cols.cost >= 0 ? num(dr[cols.cost]) : 0;
      if (price <= 0 && shares > 0 && totalCost > 0) price = totalCost / shares;
      if (shares <= 0 && totalCost > 0 && price > 0) shares = totalCost / price;
      if (!(shares > 0)) continue;
      var actStr = cols.action >= 0 ? String(dr[cols.action] == null ? "" : dr[cols.action]).trim().toLowerCase() : "";
      var ttype = /sell|sold|dispos/.test(actStr) ? "sell" : "buy";
      var dateInfo = cols.date >= 0 ? cellDateInfo(dr[cols.date]) : null;
      var month = (dateInfo && dateInfo.month) || currentMonth();
      var tickerRaw = (cols.ticker >= 0 && dr[cols.ticker]) ? String(dr[cols.ticker]).trim() : name;
      var key = tickerRaw.toUpperCase();
      var assetClass = "";
      if (cols.category >= 0 && dr[cols.category]) {
        var tc = String(dr[cols.category]).trim().toLowerCase();
        assetClass = /crypto|coin/.test(tc) ? "crypto" : /etf|fund|index/.test(tc) ? "etf" : /stock|share|equity/.test(tc) ? "stock" : "";
      }
      if (!assetClass) assetClass = /\b(btc|eth|sol|ada|xrp|doge|usdt|usdc|bnb|crypto)\b/i.test(key + " " + name) ? "crypto" : "stock";
      // Currency: explicit column → cell-format sniff (price, then total cost) → ticker-derived default.
      var ccy = (cols.currency >= 0 && dr[cols.currency]) ? String(dr[cols.currency]).trim().toUpperCase()
        : (cellCurrencyFromFormat(ws, XLSX, i, cols.price, wbDollar) || cellCurrencyFromFormat(ws, XLSX, i, cols.cost, wbDollar) || tickerCurrency(tickerRaw, base()));
      var h = map[key];
      if (!h) { h = map[key] = { name: name, ticker: tickerRaw, type: assetClass, currency: ccy, price: price, lastMonth: month, txns: [] }; order.push(key); }
      h.txns.push({ id: uid(), month: month, date: dateInfo && dateInfo.date, datePrecision: dateInfo ? dateInfo.precision : "month", sequence: (h.txns.length + 1) * 10, type: ttype, shares: normalizedDecimal(String(dr[cols.shares] == null ? shares : dr[cols.shares])), price: price, fees: 0 });
      if (month >= h.lastMonth) { h.lastMonth = month; if (price > 0) h.price = price; }
      if (cols.currency >= 0 && dr[cols.currency]) h.currency = ccy;
    }
    if (!order.length) return null;
    db.accounts = []; db.holdings = [];   // the workbook is the source of truth
    var verified = [], fallback = [];
    db.holdings = order.map(function (key) {
      var h = map[key];
      ensureCurrency(h.currency);
      (isQualifiedTicker(h.ticker) ? verified : fallback).push({ name: h.name, ticker: h.ticker, currency: h.currency });
      return {
        id: uid(), name: h.name, ticker: h.ticker, type: h.type, currency: h.currency, price: h.price,
        apiSymbol: (h.type === "crypto" ? "" : h.ticker), coingeckoId: "", realizedSeed: 0, transactions: h.txns,
      };
    });
    // FX parity: express every imported currency relative to the active base (mirrors the block path).
    db.currencies.forEach(function (c) { if (c.code === base()) { c.rate = 1; return; } var rr = metaRateInBase(c.code); if (rr) c.rate = num(rr); });
    return { accounts: 0, holdings: db.holdings.length, report: { verified: verified, fallback: fallback, updated: verified.length } };
  }
  // Universal holdings importer: find the first sheet whose header row carries an Asset header plus a
  // numeric metric, then ingest each data row as a holding (ticker, shares, price/value preserved).
  function seedHoldingsFromHeaders(XLSX, wb) {
    var created = 0;
    var wbDollar = workbookDollarCcy(XLSX, wb);
    (wb.SheetNames || []).some(function (sn) {
      var ws = wb.Sheets[sn]; if (!ws) return false;
      var aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
      var hdr = -1, cols = null;
      for (var r = 0; r < Math.min(aoa.length, 40); r++) {
        var cc = mapHeaderColumns(aoa[r] || []);
        if (cc.asset >= 0 && (cc.shares >= 0 || cc.value >= 0 || cc.cost >= 0 || cc.amount >= 0)) { hdr = r; cols = cc; break; }
      }
      if (hdr < 0) return false;
      for (var i = hdr + 1; i < aoa.length; i++) {
        var dr = aoa[i] || [], cell = dr[cols.asset];
        if (cell == null || String(cell).trim() === "") continue;
        var nm = String(cell).trim();
        var shares = cols.shares >= 0 ? num(dr[cols.shares]) : (cols.amount >= 0 ? num(dr[cols.amount]) : 0);
        var value = cols.value >= 0 ? num(dr[cols.value]) : 0;
        var totalCost = cols.cost >= 0 ? num(dr[cols.cost]) : 0;
        var price = cols.price >= 0 ? num(dr[cols.price]) : (shares > 0 ? (value > 0 ? value / shares : totalCost / shares) : 0);
        if (!(shares > 0 || value > 0)) continue;
        if (shares <= 0 && value > 0) { shares = 1; price = value; }
        var ticker = (cols.ticker >= 0 && dr[cols.ticker]) ? String(dr[cols.ticker]).trim() : nm;
        // Currency: explicit column → cell-format sniff (value/price/cost) → ticker-derived default.
        var ccy = (cols.currency >= 0 && dr[cols.currency]) ? String(dr[cols.currency]).trim().toUpperCase()
          : (cellCurrencyFromFormat(ws, XLSX, i, cols.value, wbDollar) || cellCurrencyFromFormat(ws, XLSX, i, cols.price, wbDollar) ||
             cellCurrencyFromFormat(ws, XLSX, i, cols.cost, wbDollar) || tickerCurrency(ticker, base()));
        ensureCurrency(ccy);
        var buy = (totalCost > 0 && shares > 0) ? totalCost / shares : price;
        db.holdings.push({
          id: uid(), name: nm, ticker: ticker, type: "stock", currency: ccy, price: price,
          apiSymbol: ticker, coingeckoId: "", realizedSeed: 0,
          transactions: shares > 0 ? [{ id: uid(), month: currentMonth(), type: "buy", shares: shares, price: buy, fees: 0 }] : [],
        });
        created++;
      }
      return created > 0;   // stop after the first holdings-bearing sheet
    });
    return created;
  }

  // A holding's position as of (and including) a cutoff month, replaying its dated transactions:
  // shares held, weighted-average cost basis and realized P/L up to that point.
  function positionAt(h, cutoff) {
    var txns = sortedTxns(h);
    var shares = 0, cost = 0, realized = 0;
    txns.forEach(function (t) {
      if (String(t.month) > cutoff) return;
      var sh = num(t.shares), pr = num(t.price), fee = num(t.fees);
      if (t.type === "sell") {
        var avg = shares > 0 ? cost / shares : 0, s = Math.min(sh, shares);
        realized += s * (pr - avg) - fee; cost -= avg * s; shares -= s;
        if (shares < 1e-9) { shares = 0; cost = 0; }
      } else { shares += sh; cost += sh * pr + fee; }
    });
    return { shares: shares, costBasis: cost, avgBuyPrice: shares > 0 ? cost / shares : 0, realized: realized };
  }
  // Timeline parity + per-holding hydration: synthesize a monthly snapshot for every period of the
  // year sheets. Each snapshot carries its per-account buckets AND a per-holding map (keyed by the
  // live holding id) of shares/price/cost/realized - so the investments list, overview cards and
  // charts all read the SAME historical month array.
  function buildHistoricalSnapshots(XLSX, wb) {
    var byNameH = {}, byIdH = {};
    db.holdings.forEach(function (h) { byNameH[String(h.name).toLowerCase()] = h; byIdH[h.id] = h; });
    // Reuse the LIVE account id when a historical row is the same account (stripped name + currency),
    // so frozen-balance edits and current↔past continuity line up; otherwise mint a stable synthetic
    // id. The account roster changes over time (banks/countries differ across years), so each snapshot
    // must carry its own roster rather than assuming today's accounts existed back then.
    var byNameA = {};
    db.accounts.forEach(function (a) { byNameA[String(a.name).toLowerCase() + "|" + a.currency] = a; });
    var stripAcct = function (label) { return String(label || "").replace(/[€£$‎\s]+$/, "").trim(); };
    var SECT = { liquidity: "cash", savings: "savings", "super": "pension", pension: "pension", etf: "etf", stocks: "stock", crypto: "crypto" };
    var BUCKET = { cash: "Cash", savings: "Savings", pension: "Pension" };
    var SKIP = /^(capital gains|exch|pending|gross|total|wallet|allocation|investments|pension$|change|savings %|contributes|taxes|net|avg|monthly|m\.)/i;
    var dollarCcy = workbookDollarCcy(XLSX, wb);   // same "$"-disambiguation as the live accounts
    var bins = {}, acctSeries = {};
    var blankBin = function () { return { holdVal: {}, unmatched: {}, accounts: {} }; };   // unmatched = native sum per ccy
    matrixSheetNames(XLSX, wb).forEach(function (sn) {
      var ws = wb.Sheets[sn]; if (!ws) return;
      var aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
      var year = matrixYear(sn, aoa), janCol = matrixMonthStart(aoa), section = null, stop = false;
      aoa.forEach(function (row) {
        if (stop) return;   // ignore everything below the per-holding "Finance" detail block (see below)
        var a = row && row[0]; if (a == null) return;
        var label = String(a).trim(); if (!label) return;
        var key = label.toLowerCase();
        // The year sheets restate each holding's market value under a lower "Finance" detail block
        // (Holding -> Market Value / Growth / Profit / Cost / Value rows). Those detail rows carry no
        // section header of their own, so they stay under the still-active section and get ingested as
        // phantom "unmatched" holdings - double-counting the ENTIRE portfolio (e.g. 2025-12 invest was
        // ~2x true value). The canonical allocation matrix - including any genuinely untracked holdings
        // - sits ABOVE this block, so stop ingesting the sheet once the Finance detail block starts.
        if (key === "finance") { stop = true; return; }
        if (SECT[key] !== undefined) { section = SECT[key]; return; }
        if (!section || SKIP.test(label)) return;
        var isAcct = (section === "cash" || section === "savings" || section === "pension");
        var hRef = isAcct ? null : byNameH[key];
        var ccy = (section === "cash" || section === "savings") ? (accountCurrency(label, dollarCcy) || dollarCcy)
          : section === "pension" ? (accountCurrency(label, dollarCcy) || (TAX_PRESETS[db.settings.country] || {}).currency || dollarCcy)
            : (hRef ? hRef.currency : (section === "etf" ? "EUR" : "USD"));
        var ser = null;
        if (isAcct) {
          var nm = stripAcct(label), akey = nm.toLowerCase() + "|" + ccy + "|" + section;
          ser = acctSeries[akey] || (acctSeries[akey] = {
            id: (byNameA[nm.toLowerCase() + "|" + ccy] || {}).id || ("hacc:" + nm.toLowerCase() + "|" + ccy),
            name: nm, bucket: BUCKET[section], currency: ccy, months: {},
          });
        }
        for (var j = janCol; j <= janCol + 11; j++) {   // Jan..Dec of `year` (column offset is auto-detected)
          var v = row[j];
          if (typeof v !== "number") continue;
          var month = year + "-" + String(j - janCol + 1).padStart(2, "0");
          if (isAcct) { ser.months[month] = v; bins[month] = bins[month] || blankBin(); }   // record incl. 0 (closure marker)
          else if (v === 0) continue;
          else {
            var b = bins[month] || (bins[month] = blankBin());
            if (hRef) b.holdVal[hRef.id] = (b.holdVal[hRef.id] || 0) + v;   // native market value
            else b.unmatched[ccy] = (b.unmatched[ccy] || 0) + v;           // holding no longer tracked (native, by ccy)
          }
        }
      });
    });
    // Roll each account's closing balance forward month-by-month (and year-to-year) across its active
    // span [first..last recorded month], filling gaps with the most recent known balance so balances
    // compound chronologically instead of zeroing out. An explicit 0 marks closure (drops the account
    // from the roster from then on); months past the last recorded balance are left absent.
    var allMonths = Object.keys(bins).sort();
    Object.keys(acctSeries).forEach(function (akey) {
      var ser = acctSeries[akey], rec = Object.keys(ser.months).sort();
      if (!rec.length) return;
      var firstM = rec[0], lastM = rec[rec.length - 1], lastVal = null;
      allMonths.forEach(function (month) {
        if (month < firstM || month > lastM) return;
        if (ser.months[month] !== undefined) lastVal = ser.months[month];
        if (lastVal == null || lastVal === 0) return;
        bins[month].accounts[ser.id] = {
          name: ser.name, bucket: ser.bucket, currency: ser.currency,
          balance: lastVal, balanceBase: toBase(lastVal, ser.currency),
        };
      });
    });
    var cm = currentMonth();
    return Object.keys(bins).sort().map(function (m) {
      var b = bins[m], snapHoldings = {}, invest = 0, cost = 0, unreal = 0, real = 0, bkStock = 0, bkCrypto = 0;
      var bkCash = 0, bkSav = 0, bkPen = 0, accountsOut = {};
      Object.keys(b.accounts).forEach(function (id) {
        var ac = b.accounts[id]; accountsOut[id] = ac; var ab = num(ac.balanceBase);
        if (ac.bucket === "Cash") bkCash += ab; else if (ac.bucket === "Savings") bkSav += ab; else if (ac.bucket === "Pension") bkPen += ab;
      });
      Object.keys(b.holdVal).forEach(function (id) {
        var h = byIdH[id]; if (!h) return;
        var value = b.holdVal[id], pos = positionAt(h, m), rate = (curByCode(h.currency) || {}).rate || 1, fr;
        if (pos.shares > 1e-9) {
          fr = { shares: pos.shares, buyPrice: pos.avgBuyPrice, fees: 0, price: value > 0 ? value / pos.shares : pos.avgBuyPrice, realized: pos.realized, type: h.type, currency: h.currency, rate: rate };
        } else if ((h.transactions || []).length) {
          // Ledger-backed holding with no position at month m: per the transaction log it wasn't held
          // yet (or was fully exited). Ignore the year-sheet value - it predates the first acquisition
          // and would otherwise fabricate a cost/value that doesn't reconcile with buys minus sells.
          return;
        } else {   // value-only holding (no transaction ledger at all): list it at its sheet value
          fr = { shares: 1, buyPrice: value, fees: 0, price: value, realized: 0, type: h.type, currency: h.currency, rate: rate };
        }
        var fm = frozenHoldingMetrics(fr);
        // Persist the base-currency market value + cost on the frozen record so the holding's
        // "Value Over Time" chart (holdingHistory → mvBase) renders the blue Market-value line across
        // EVERY backfilled month, not just the live current month.
        fr.mvBase = fm.marketValueBase; fr.costBase = fm.costBase;
        snapHoldings[id] = fr;
        invest += fm.marketValueBase; cost += fm.costBase; unreal += fm.unrealizedBase; real += fm.realizedBase;
        if (h.type === "crypto") bkCrypto += fm.marketValueBase; else bkStock += fm.marketValueBase;
      });
      var umBase = 0; Object.keys(b.unmatched).forEach(function (ccy) { umBase += toBase(b.unmatched[ccy], ccy); });
      invest += umBase; cost += umBase; bkStock += umBase;
      var nw = bkCash + bkSav + bkPen + invest;
      return {
        month: m, date: new Date().toISOString(), netWorth: nw, gross: nw,
        invest: invest, cost: cost, unrealized: unreal, realized: real,
        buckets: { Cash: bkCash, Savings: bkSav, Pension: bkPen, Investments: bkStock, Crypto: bkCrypto },
        holdings: snapHoldings, accounts: accountsOut, unmatched: b.unmatched, physAssets: 0,
        expenses: monthTotal(db.expenses, m), income: monthTotal(db.incomes, m),
      };
    }).filter(function (s) { return s.netWorth > 0 && s.month !== cm; });   // keep current month live
  }
  // Post-import validation popup (custom modal, --surface + standard buttons): which tickers were
  // verified to a regional variant vs which fell back to the default American USD symbol.
  function tickerReportModal(report, onDone) {
    var v = (report && report.verified) || [], f = (report && report.fallback) || [];
    var line = function (x, color) {
      return '<div class="rt-line"><span><span class="inv-tkr" style="color:' + color + '">' + esc(x.ticker || "-") + '</span> ' + esc(x.name) +
        "</span><strong class=\"rt-metric\">" + esc(x.currency || "") + "</strong></div>";
    };
    var block = function (title, arr, color) {
      return '<div class="section-title" style="margin-top:8px">' + esc(title) + " (" + arr.length + ")</div>" +
        '<div class="rt-rows">' + (arr.length ? arr.map(function (x) { return line(x, color); }).join("") : '<div class="hint" style="margin:0">None.</div>') + "</div>";
    };
    openModal({
      title: "Import Complete",
      sub: "Ticker mapping summary - " + v.length + " verified, " + f.length + " on default US symbol.",
      body: block("Verified regional tickers", v, "var(--d-green)") + block("Default US (USD) fallback", f, "var(--text-3)"),
      submitLabel: "Done",
      onSubmit: function () { if (typeof onDone === "function") onDone(); },   // dismissal -> trigger live price refresh
    });
  }
  function resetData() {
    openModal({
      title: "Reset everything?",
      sub: "This permanently deletes all accounts, holdings, expenses, income, tax data and snapshots from this browser. Export a backup first if unsure.",
      submitLabel: "Delete all data",
      onSubmit: function () {
        db = defaultDB();
        try { localStorage.removeItem(KEY); } catch (e) { /* clear the legacy pre-IDB copy so a wipe can't be resurrected from it */ }
        idbSet("backup_dir_handle", null).catch(function () { });   // forget any previously-granted backup folder
        save();
        // Snap the global active period back to the real-world current month/year so a wipe never
        // leaves the sidebar filters locked to a stale historical month.
        state.route = "dashboard"; state.month = currentMonth(); state.wizardStep = 0; state.wizardSeen = false; state.previewWizard = false;
        render(); toast("All data reset");
      },
    });
  }
  // Load a realistic demo wallet so people can explore before entering their own data. Months are
  // anchored to "now", so it always looks current. Replaces the current data (with a confirm if any).
  function loadSampleData() {
    var apply = function () {
      function mo(back) { var d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - back); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); }
      var nd = defaultDB();
      nd.setupComplete = true;
      nd.settings.name = "Valutio Demo"; nd.settings.baseCurrency = "EUR";
      nd.currencies = [{ code: "EUR", symbol: "€", rate: 1 }];
      nd.tax.currency = "EUR";
      nd.accounts = [
        { id: uid(), name: "Checking", bucket: "Cash", currency: "EUR", balance: 3200, joint: false, share: 100, coOwner: "" },
        { id: uid(), name: "Emergency Savings", bucket: "Savings", currency: "EUR", balance: 8000, joint: false, share: 100, coOwner: "" },
        { id: uid(), name: "Pension Fund", bucket: "Pension", currency: "EUR", balance: 15000, joint: false, share: 100, coOwner: "" },
      ];
      nd.holdings = [
        { id: uid(), name: "Vanguard FTSE All-World", ticker: "VWCE", type: "etf", currency: "EUR", price: 112, apiSymbol: "VWCE.DE", coingeckoId: "", realizedSeed: 0, dividends: [],
          transactions: [{ id: uid(), month: mo(1), type: "buy", shares: 20, price: 100, fees: 0 }, { id: uid(), month: mo(0), type: "buy", shares: 10, price: 108, fees: 0 }] },
        { id: uid(), name: "Bitcoin", ticker: "BTC", type: "crypto", currency: "EUR", price: 60000, apiSymbol: "", coingeckoId: "bitcoin", realizedSeed: 0, dividends: [],
          transactions: [{ id: uid(), month: mo(1), type: "buy", shares: 0.05, price: 50000, fees: 0 }, { id: uid(), month: mo(0), type: "sell", shares: 0.02, price: 58000, fees: 0 }] },
      ];
      nd.physicalAssets = [{ id: uid(), name: "Car", category: "Vehicle", value: 12000, currency: "EUR", includeInNetWorth: true, nwMode: "equity" }];
      nd.debts = [{ id: uid(), name: "Car Loan", type: "auto", balance: 5000, currency: "EUR", apr: 6, payment: 250, logMode: "interest", lastClose: "" }];
      nd.goals = [{ id: uid(), name: "New Laptop", cost: 2000, currency: "EUR", targetMonth: mo(-6), currentSavings: 600 }];
      var pm = mo(1), c0 = mo(0);
      var rentRule = { id: uid(), kind: "expense", category: "Rent", amount: 1200, currency: "EUR", note: "", since: pm };
      var salaryRule = { id: uid(), kind: "income", category: "Salary", amount: 3500, currency: "EUR", note: "", since: pm };
      nd.recurring = [rentRule, salaryRule];
      // Only two months of data - the previous month and the current month - with a clear jump between them.
      nd.incomes = [
        { id: uid(), month: pm, category: "Salary", amount: 3500, currency: "EUR", note: "", recurringId: salaryRule.id },
        { id: uid(), month: c0, category: "Salary", amount: 3500, currency: "EUR", note: "", recurringId: salaryRule.id },
        { id: uid(), month: c0, category: "Freelancing", amount: 800, currency: "EUR", note: "Side project" },
      ];
      nd.expenses = [
        { id: uid(), month: pm, category: "Rent", amount: 1200, currency: "EUR", note: "", recurringId: rentRule.id },
        { id: uid(), month: pm, category: "Groceries", amount: 600, currency: "EUR", note: "" },
        { id: uid(), month: pm, category: "Subscriptions", amount: 55, currency: "EUR", note: "Streaming + apps" },
        { id: uid(), month: pm, category: "Transport", amount: 200, currency: "EUR", note: "" },
        { id: uid(), month: pm, category: "Travel", amount: 900, currency: "EUR", note: "Weekend trip" },
        { id: uid(), month: c0, category: "Rent", amount: 1200, currency: "EUR", note: "", recurringId: rentRule.id },
        { id: uid(), month: c0, category: "Groceries", amount: 380, currency: "EUR", note: "" },
        { id: uid(), month: c0, category: "Subscriptions", amount: 55, currency: "EUR", note: "Streaming + apps" },
        { id: uid(), month: c0, category: "Transport", amount: 140, currency: "EUR", note: "" },
      ];
      // One frozen snapshot for the previous month, set clearly lower than today's live net worth (~€38k)
      // so the month-over-month change is obvious. The current month is computed live from the data above.
      // Stored with full per-line account/holding records + physAssets (not just aggregate buckets) so the
      // frozen month's Accounts page lists its accounts, the "Accounts" KPI excludes the car, and frozen
      // add/edit re-totals faithfully.
      var snapAcc = {};
      snapAcc[nd.accounts[0].id] = { name: "Checking", bucket: "Cash", currency: "EUR", balance: 1200, balanceBase: 1200, share: 100 };
      snapAcc[nd.accounts[1].id] = { name: "Emergency Savings", bucket: "Savings", currency: "EUR", balance: 4000, balanceBase: 4000, share: 100 };
      snapAcc[nd.accounts[2].id] = { name: "Pension Fund", bucket: "Pension", currency: "EUR", balance: 8000, balanceBase: 8000, share: 100 };
      var snapHold = {};
      snapHold[nd.holdings[0].id] = { shares: 15, buyPrice: 100, fees: 0, price: 100, realized: 0, type: "etf", currency: "EUR", rate: 1, mvBase: 1500, costBase: 1500 };
      snapHold[nd.holdings[1].id] = { shares: 0.02, buyPrice: 45000, fees: 0, price: 45000, realized: 0, type: "crypto", currency: "EUR", rate: 1, mvBase: 900, costBase: 900 };
      nd.snapshots = [{
        month: pm, date: pm + "-28", netWorth: 19600, gross: 27600, invest: 2400, cost: 2400, unrealized: 0, realized: 0,
        buckets: { Cash: 1200, Savings: 4000, Pension: 8000, Investments: 1500, Crypto: 900, "Physical Assets": 12000 },
        accounts: snapAcc, holdings: snapHold, physAssets: 12000,
        income: 3500, expenses: 2955, debtsTotal: 8000, debts: {}, rates: { EUR: 1 },
      }];
      nd.meta.firstMonth = pm;   // demo wallet starts last month
      db = nd; applyRecurring(); recomputeAllSnapshots(); save();
      state.route = "dashboard"; state.month = currentMonth();
      state.previewWizard = false; render(); toast("Sample data loaded");
    };
    var hasData = db.setupComplete && (db.accounts.length || db.holdings.length || (db.snapshots || []).length);
    if (hasData) openModal({ title: "Load sample data?", sub: "This replaces your current wallet with a demo dataset. Export a backup first if you want to keep your data.", danger: true, submitLabel: "Load sample data", onSubmit: apply });
    else apply();
  }
  // ----------------------------------------------------------
  // Router / render
  // ----------------------------------------------------------
  function page() {
    switch (state.route) {
      case "dashboard": return dashboardPage();
      case "accounts": return accountsPage();
      case "investments": return investmentsPage();
      case "assets": return assetsPage();
      case "debts": return debtsPage();
      case "holding": return holdingDetailPage();
      case "history": return historyPage();
      case "cashflow": return cashflowPage();
      case "expenses": case "income": state.route = "cashflow"; return cashflowPage();
      case "goals": return goalsPage();
      case "retirement": return retirementTracker();
      case "tax": return taxPage();
      case "settings": return settingsPage();
      default: return dashboardPage();
    }
  }
  var _lastViewKey = null;   // tracks route (+ settings sub-section) so a page change can jump back to the top
  function render() {
    var app = document.getElementById("app");
    applyThemeChrome();
    if (!db.setupComplete || state.previewWizard) {
      // Setup opens from the top on first paint, but re-renders triggered by toggling
      // category tags / country keep the scroll position locked (no jump-to-top).
      var sy = window.scrollY;
      app.className = "full" + (db.settings.hideValues ? " values-hidden" : "");
      app.innerHTML = wizardPage();
      applyLanguageUI(app);
      if (state.wizardSeen) window.scrollTo(0, sy); else { window.scrollTo(0, 0); state.wizardSeen = true; }
      return;
    }
    // privacy toggle: blur monetary values app-wide (see the eye button in pageHead). The class drives the
    // CSS blur; values stay in the DOM (layout unchanged) but are unreadable until toggled back.
    app.className = db.settings.hideValues ? "values-hidden" : "";
    // during the tutorial, keep the page behind the card on the step's relevant view
    if (state.tutorial) state.route = TUTORIAL_STEPS[state.tutorial.step].route;
    // Changing page (or Settings sub-section) starts at the top; same-view re-renders - chip toggles, data
    // edits, month/year switches, color picks - keep the current scroll position.
    var viewKey = state.route + "|" + (state.settingsSection || "");
    var viewChanged = viewKey !== _lastViewKey;
    _lastViewKey = viewKey;
    app.innerHTML = sidebar() + '<div class="main">' + backupBanner() + page() + "</div>";
    renderTutorial();
    applyLanguageUI(document);
    if (viewChanged) window.scrollTo(0, 0);
  }

  function preserveCashflowColorScroll(fromEl) {
    var stack = fromEl && fromEl.closest && fromEl.closest(".cashflow-color-stack");
    if (!stack) return function () { };
    var y = stack.scrollTop;
    return function () {
      var next = document.querySelector(".cashflow-color-stack");
      if (next) next.scrollTop = y;
    };
  }

  // ----------------------------------------------------------
  // Event handling (delegation)
  // ----------------------------------------------------------
  function findHolding(id) { return db.holdings.filter(function (h) { return h.id === id; })[0]; }
  function findAccount(id) { return db.accounts.filter(function (a) { return a.id === id; })[0]; }

  document.addEventListener("click", function (e) {
    var el = e.target.closest("[data-act]");
    if (!el) return;
    var act = el.getAttribute("data-act");
    var id = el.getAttribute("data-id");
    var kind = el.getAttribute("data-kind");

    switch (act) {
      case "nav": state.route = id; render(); break;
      case "toggle-hide-values": db.settings.hideValues = !db.settings.hideValues; save(); render(); break;
      case "set-cf-addkind":
        state.cashflowAddKind = cfDrawerKind(el.getAttribute("data-kind"));
        if (el.closest(".txn-drawer")) openTransactionDrawer(state.cashflowAddKind, cfDraftFromForm());
        else render();
        break;
      case "set-cf-view": {
        var cv = el.getAttribute("data-view");
        state.cfView = (cv === "expenses" || cv === "income" || cv === "categorizer") ? cv : "dashboard";
        render(); break;
      }
      case "open-cf-drawer": openTransactionDrawer(kind || (state.cfView === "income" ? "income" : state.cfView === "expenses" ? "expense" : cfAddKind())); break;
      case "cf-start": state.cfStarted = true; openTransactionDrawer(kind || (state.cfView === "income" ? "income" : state.cfView === "expenses" ? "expense" : cfAddKind())); break;
      case "update-balances": updateBalancesModal(); break;
      case "export-csv": exportCSV(el.getAttribute("data-kind")); break;
      case "export-cashflow-csv": cashflowExportModal(); break;
      case "edit-alloc-targets": targetAllocModal(); break;
      case "set-cf-expview": state.cfExpView = el.getAttribute("data-view") === "joint" ? "joint" : "mine"; render(); break;
      case "set-hist-expview": state.histExpView = el.getAttribute("data-view") === "joint" ? "joint" : "mine"; render(); break;
      case "toggle-cf-sortdir": state.cfSortDir = state.cfSortDir === "asc" ? "desc" : "asc"; render(); break;
      case "set-settings-section": state.settingsSection = el.getAttribute("data-section"); render(); break;
      case "set-color": {
        var restoreColorScroll = preserveCashflowColorScroll(el);
        var cDom = el.getAttribute("data-domain"), cKey = el.getAttribute("data-key"), cVal = el.getAttribute("data-color");
        if (!db.settings.colors) db.settings.colors = {};
        if (!db.settings.colors[cDom]) db.settings.colors[cDom] = {};
        if (cVal) db.settings.colors[cDom][cKey] = cVal; else delete db.settings.colors[cDom][cKey];
        save(); render(); restoreColorScroll(); break;
      }
      case "auto-color": {
        var restoreAutoColorScroll = preserveCashflowColorScroll(el);
        var aDom = el.getAttribute("data-domain"), aKey = el.getAttribute("data-key"), curCol = el.getAttribute("data-current") || "";
        var choices = SWATCHES.filter(function (sw) { return sw !== curCol; });
        var pick = choices[Math.floor(Math.random() * choices.length)] || SWATCHES[0];
        if (!db.settings.colors) db.settings.colors = {};
        if (!db.settings.colors[aDom]) db.settings.colors[aDom] = {};
        db.settings.colors[aDom][aKey] = pick;
        save(); render(); restoreAutoColorScroll(); break;
      }
      case "reset-colors": {
        var rDom = el.getAttribute("data-domain");
        if (db.settings.colors) {
          if (rDom === "cashflow") { db.settings.colors.expense = {}; db.settings.colors.income = {}; }
          else db.settings.colors[rDom] = {};
        }
        save(); render(); break;
      }
      case "set-trend-range": {
        var trv = el.getAttribute("data-range");
        var tck = el.getAttribute("data-chart");
        if (tck === "inv") state.invRange = trv; else if (tck === "hist") state.histRange = trv; else state.dashRange = trv;
        render(); break;
      }
      case "set-hist-scope": {
        var hsc = el.getAttribute("data-scope");
        state.histScope = hsc; render(); break;
      }
      case "set-catview": {
        if (!db.settings.catView) db.settings.catView = {};
        db.settings.catView[el.getAttribute("data-noun")] = el.getAttribute("data-view");
        save(); render(); break;
      }
      case "set-ieview": {
        db.settings.ieView = el.getAttribute("data-view");
        save(); render(); break;
      }
      case "set-mixview": {
        db.settings.mixView = el.getAttribute("data-view") === "holding" ? "holding" : "type";
        save(); render(); break;
      }
      case "set-netview":
        // "My share / Household" lens. Re-lens every frozen snapshot too so History + the net-worth trend
        // stay consistent with the toggle (boot recompute resets to "my share" on next load).
        state.netView = el.getAttribute("data-view") === "household" ? "household" : "mine";
        recomputeAllSnapshots(); save(); render(); break;
      case "help-support": {
        // Settings is a section-sidebar layout; only the active section's panel is in the DOM. Select the
        // Help & Onboarding section before rendering, or its panel (and the scroll/flash target) won't
        // exist and the click would silently land on the default Profile section instead.
        closeModal(); state.route = "settings"; state.settingsSection = "help"; render();
        var ho = document.getElementById("help-onboarding");
        if (ho) { ho.scrollIntoView({ behavior: "smooth", block: "center" }); ho.classList.add("flash"); }
        break;
      }
      case "contact-support": {
        // Same Help & Onboarding section, but scroll to (and flash) the Contact block with the email.
        closeModal(); state.route = "settings"; state.settingsSection = "help"; render();
        var hc = document.getElementById("help-contact");
        if (hc) { hc.scrollIntoView({ behavior: "smooth", block: "center" }); hc.classList.add("flash"); }
        break;
      }
      case "copy-email": {
        // Also copy the address so the user still has it even if no mail app is configured. NOT preventDefault:
        // the anchor's mailto: still opens the default mail client where one exists.
        var _email = "support@valutio.app";
        var _copied = function () { toast("Copied " + _email); };
        // Legacy fallback used when the async Clipboard API is missing OR rejects (blocked permission).
        var _fallback = function () {
          try {
            var _ta = document.createElement("textarea");
            _ta.value = _email; _ta.style.position = "fixed"; _ta.style.opacity = "0"; _ta.style.pointerEvents = "none";
            document.body.appendChild(_ta); _ta.focus(); _ta.select();
            var ok = document.execCommand("copy"); document.body.removeChild(_ta);
            ok ? _copied() : toast(_email);
          } catch (err) { toast(_email); }
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(_email).then(_copied).catch(_fallback);
        } else {
          _fallback();
        }
        break;
      }
      case "set-month": break; // handled by change
      case "close-modal": closeModal(); break;
      case "donate": openDonate(); break;   // opens Ko-fi in a new tab
      case "pick-currency": {
        setCurrencyPickerCode(el.getAttribute("data-code"));
        closeCurrencySuggestions();
        break;
      }
      case "rename-wallet": renameWalletModal(); break;

      case "add-account": accountModal(); break;
      case "edit-account": accountModal(findAccount(id)); break;
      case "del-account": {
        var dacc = findAccount(id);
        confirmDelete("Delete " + (dacc ? dacc.name : "account") + "?",
          "Removes the account from your net worth. You can undo this right after.",
          function () { db.accounts = db.accounts.filter(function (a) { return a.id !== id; }); recomputeAllSnapshots(); save(); render();
            toastUndo("Account deleted", function () { if (dacc) db.accounts.push(dacc); recomputeAllSnapshots(); save(); render(); }); });
        break;
      }

      case "add-goal": goalModal(); break;
      case "edit-goal": goalModal((db.goals || []).filter(function (g) { return g.id === id; })[0]); break;
      case "add-contribution": contributionModal((db.goals || []).filter(function (g) { return g.id === id; })[0]); break;
      case "del-goal": {
        var dgoal = (db.goals || []).filter(function (g) { return g.id === id; })[0];
        confirmDelete("Delete " + (dgoal ? dgoal.name : "goal") + "?",
          "Removes the goal and its saved progress. You can undo this right after.",
          function () { db.goals = (db.goals || []).filter(function (g) { return g.id !== id; }); save(); render();
            toastUndo("Goal deleted", function () { if (dgoal) db.goals.push(dgoal); save(); render(); }); });
        break;
      }

      case "add-asset": assetModal(); break;
      case "edit-asset": assetModal((db.physicalAssets || []).filter(function (a) { return a.id === id; })[0]); break;
      case "del-asset": {
        var dasset = (db.physicalAssets || []).filter(function (a) { return a.id === id; })[0];
        confirmDelete("Delete " + (dasset ? dasset.name : "asset") + "?",
          "Removes the asset from your net worth. You can undo this right after.",
          function () { db.physicalAssets = (db.physicalAssets || []).filter(function (a) { return a.id !== id; }); recomputeAllSnapshots(); save(); render();
            toastUndo("Asset deleted", function () { if (dasset) db.physicalAssets.push(dasset); recomputeAllSnapshots(); save(); render(); }); });
        break;
      }

      case "add-debt": debtModal(); break;
      case "edit-debt": debtModal((db.debts || []).filter(function (a) { return a.id === id; })[0]); break;
      case "del-debt": {
        var ddebt = (db.debts || []).filter(function (a) { return a.id === id; })[0];
        confirmDelete("Delete " + (ddebt ? ddebt.name : "debt") + "?",
          "Removes the debt from your net worth. You can undo this right after.",
          function () { db.debts = (db.debts || []).filter(function (a) { return a.id !== id; }); recomputeAllSnapshots(); save(); render();
            toastUndo("Debt deleted", function () { if (ddebt) db.debts.push(ddebt); recomputeAllSnapshots(); save(); render(); }); });
        break;
      }

      case "add-holding": holdingModal(); break;
      case "edit-holding": holdingModal(findHolding(id)); break;
      case "holding-search": holdingSearchRun(); break;
      case "pick-search-result": {
        var setv = function (idd, v) { var e = document.getElementById(idd); if (e && v) e.value = v; };
        setv("h-name", el.getAttribute("data-name"));
        setv("h-ticker", el.getAttribute("data-ticker"));
        setv("h-api", el.getAttribute("data-api"));
        setv("h-cg", el.getAttribute("data-cg"));
        var rb = document.getElementById("h-search-results"); if (rb) rb.innerHTML = "";
        var sb = document.getElementById("h-search"); if (sb) sb.value = "";
        break;
      }
      case "price-holding": priceModal(findHolding(id)); break;
      case "open-holding": state.holdingId = id; state.route = "holding"; render(); break;
      case "add-txn": transactionModal(findHolding(id), el.getAttribute("data-type")); break;
      case "edit-txn": {
        var eh = findHolding(el.getAttribute("data-hold"));
        var et = eh && (eh.transactions || []).filter(function (t) { return t.id === id; })[0];
        if (eh && et) transactionEditModal(eh, et);
        break;
      }
      case "edit-frozen-holding": frozenHoldingEditModal(findHolding(id), state.month); break;
      case "edit-frozen-account": {
        var facc = findAccount(id);
        if (!facc) {   // historical-only account (no longer in the live roster): rebuild from the snapshot
          var fsnap = snapByMonth(state.month), ffr = fsnap && fsnap.accounts && fsnap.accounts[id];
          if (ffr) facc = { id: id, name: ffr.name, bucket: ffr.bucket, currency: ffr.currency };
        }
        frozenAccountEditModal(facc, state.month); break;
      }
      case "add-frozen-account": frozenAccountAddModal(state.month); break;
      case "del-frozen-account": {
        var fdSnap = snapByMonth(state.month);
        var fdAcc = fdSnap && fdSnap.accounts && fdSnap.accounts[id];
        if (!fdAcc) break;
        var fdMonth = state.month, fdName = fdAcc.name || "account";
        confirmDelete("Delete " + fdName + " from " + monthLabel(fdMonth) + "?",
          "Removes this account from this frozen month only - your live accounts and every other month stay untouched. You can undo this right after.",
          function () {
            var s = snapByMonth(fdMonth); if (!s || !s.accounts) return;
            var removed = s.accounts[id]; if (!removed) return;
            delete s.accounts[id]; recomputeSnapshot(s, null, true); save(); render();
            toastUndo("Account removed from " + monthLabel(fdMonth), function () {
              var s2 = snapByMonth(fdMonth);
              if (s2 && s2.accounts) { s2.accounts[id] = removed; recomputeSnapshot(s2, null, true); save(); render(); }
            });
          });
        break;
      }
      case "del-txn": {
        var hold = findHolding(el.getAttribute("data-hold"));
        if (hold) { hold.transactions = hold.transactions.filter(function (t) { return t.id !== id; }); repropagateHolding(hold); save(); render(); }
        break;
      }
      case "add-dividend": dividendModal(findHolding(id)); break;
      case "edit-dividend": {
        var divH = findHolding(el.getAttribute("data-hold"));
        var divD = divH && (divH.dividends || []).filter(function (x) { return x.id === id; })[0];
        if (divH && divD) dividendModal(divH, divD);
        break;
      }
      case "del-dividend": {
        var dvHold = findHolding(el.getAttribute("data-hold"));
        if (dvHold) { dvHold.dividends = (dvHold.dividends || []).filter(function (x) { return x.id !== id; }); save(); render(); }
        break;
      }
      case "del-holding": {
        var dh = findHolding(id);
        var dhIdx = db.holdings.indexOf(dh);
        confirmDelete("Delete " + (dh ? dh.name : "holding") + "?",
          "Removes the holding and its entire buy/sell history. You can undo this right after.",
          function () {
            db.holdings = db.holdings.filter(function (h) { return h.id !== id; });
            if (state.route === "holding") state.route = "investments";
            recomputeAllSnapshots(); save(); render();
            toastUndo("Holding deleted", function () { if (dh) db.holdings.splice(Math.max(0, Math.min(dhIdx, db.holdings.length)), 0, dh); recomputeAllSnapshots(); save(); render(); });
          }, "Delete holding");
        break;
      }

      case "edit-ledger": ledgerEditModal(kind, id); break;
      case "del-ledger": {
        var lk = kind === "expense" ? "expenses" : "incomes";
        var delLedg = db[lk].filter(function (x) { return x.id === id; })[0];
        db[lk] = db[lk].filter(function (x) { return x.id !== id; });
        recomputeAllSnapshots(); save(); render();
        toastUndo((kind === "expense" ? "Expense" : "Income") + " deleted", function () { if (delLedg) db[lk].push(delLedg); recomputeAllSnapshots(); save(); render(); });
        break;
      }

      case "add-invoice": invoiceModal(); break;
      case "edit-invoice": invoiceModal(viewedTax().invoices.filter(function (x) { return x.id === id; })[0]); break;
      case "del-invoice": {
        var vt = viewedTax();
        var delIv = vt.invoices.filter(function (x) { return x.id === id; })[0];
        confirmDelete("Delete invoice?",
          "This permanently removes the invoice" + (delIv ? " (" + fmt(delIv.amount, delIv.currency) + (delIv.note ? " - " + esc(delIv.note) : "") + ")" : "") + " from your freelance income. This can't be undone.",
          function () { vt.invoices = vt.invoices.filter(function (x) { return x.id !== id; }); syncArchivedInvoiceSnapshot(vt); save(); render();
            toastUndo("Invoice deleted", function () { if (delIv) vt.invoices.push(delIv); syncArchivedInvoiceSnapshot(vt); save(); render(); }); },
          "Delete invoice");
        break;
      }
      case "toggle-tax-paid": {
        var vtp = viewedTax();
        vtp.paid = !vtp.paid;
        vtp.paidAt = vtp.paid ? new Date().toISOString() : null;
        save(); render();
        toast(vtp.paid ? ("Marked " + esc(vtp.year) + " tax as paid") : ("Marked " + esc(vtp.year) + " tax unpaid"));
        break;
      }
      case "mark-tax-paid": {
        // Year-scoped mark-paid (from the top-of-page owing banner / rollover nudge). Unlike
        // toggle-tax-paid, this settles a SPECIFIC year (usually the just-ended one) regardless of which
        // year is currently on screen, so it drops out of the dashboard "Total Current Taxes".
        var mpy = el.getAttribute("data-year");
        var mpRec = (db.tax.year === mpy) ? db.tax : (db.taxArchive || []).filter(function (a) { return a.year === mpy; })[0];
        if (mpRec) { mpRec.paid = true; mpRec.paidAt = new Date().toISOString(); save(); render(); toast("Marked " + esc(mpy) + " tax as paid"); }
        break;
      }
      case "dismiss-banner": {
        // Session-only dismiss (state, not saved) - the banner returns on next launch so a "still owing"
        // reminder is never lost for good, just cleared for now.
        var dbk = el.getAttribute("data-key");
        if (dbk) state["dismiss_" + dbk] = true;
        render();
        break;
      }
      case "edit-tax-config": taxConfigModal(); break;
      case "add-bracket": {
        var list = document.getElementById("bk-list");
        var div = document.createElement("div");
        div.innerHTML = '<div class="row" data-bracket><div class="field"><label>Up to</label><input class="bk-upto" type="number" step="any" placeholder="∞ (top)"></div>' +
          '<div class="field"><label>Rate %</label><input class="bk-rate" type="number" step="any" value="0"></div>' +
          '<button type="button" class="btn ghost bk-del" data-act="remove-bracket" title="Remove bracket">×</button></div>';
        list.appendChild(div.firstChild);
        applyLanguageUI(list);
        break;
      }
      case "remove-bracket": { var br = el.closest("[data-bracket]"); if (br) br.remove(); break; }
      case "add-adjustment": {
        var alist = document.getElementById("adj-list");
        var adiv = document.createElement("div");
        adiv.innerHTML = '<div class="row" data-adj><div class="field" style="flex:1.5"><label>Name</label><input class="adj-name" placeholder="e.g. Surcharge"></div>' +
          '<div class="field"><label>Effect</label><select class="adj-type"><option value="add" selected>Add</option><option value="deduct">Deduct</option></select></div>' +
          '<div class="field"><label>Kind</label><select class="adj-mode"><option value="fixed" selected>Fixed</option><option value="percent">% of tax</option><option value="percentincome">% of total income</option></select></div>' +
          '<div class="field"><label>Value</label><input class="adj-value" type="number" step="any"></div>' +
          '<button type="button" class="btn ghost bk-del" data-act="remove-adjustment" title="Remove">×</button></div>';
        alist.appendChild(adiv.firstChild);
        applyLanguageUI(alist);
        break;
      }
      case "remove-adjustment": { var ad = el.closest("[data-adj]"); if (ad) ad.remove(); break; }

      case "add-currency": currencyModal(); break;
      case "edit-currency": currencyModal(curByCode(id)); break;
      case "del-currency": {
        // A currency is "in use" if ANY record references it - not just accounts/holdings. Deleting a
        // currency still referenced by an expense/income/invoice (or the base/secondary/tax currency)
        // would leave those entries dangling and silently revalue them at FX rate 1. Block all of those.
        var curInUse = db.holdings.concat(db.accounts).some(function (x) { return x.currency === id; }) ||
          (db.expenses || []).some(function (x) { return x.currency === id; }) ||
          (db.incomes || []).some(function (x) { return x.currency === id; }) ||
          (db.tax && (db.tax.currency === id || (db.tax.invoices || []).some(function (iv) { return iv.currency === id; }))) ||
          (db.taxArchive || []).some(function (a) { return a.currency === id || (a.invoices || []).some(function (iv) { return iv.currency === id; }); }) ||
          db.settings.baseCurrency === id || db.settings.secondaryCurrency === id;
        if (curInUse) { toast("Currency is in use"); break; }
        db.currencies = db.currencies.filter(function (c) { return c.code !== id; }); save(); render(); break;
      }

      case "add-category": categoryModal(kind); break;
      case "del-category": {
        var catKey = kind === "expense" ? "expenseCategories" : "incomeCategories";
        var catIdx = db[catKey].indexOf(id);
        confirmDelete("Delete category?",
          "Remove the “" + esc(id) + "” " + (kind === "expense" ? "expense" : "income") + " category? Existing entries keep their label.",
          function () { db[catKey] = db[catKey].filter(function (c) { return c !== id; }); save(); render();
            toastUndo("Category deleted", function () { if (catIdx >= 0) db[catKey].splice(catIdx, 0, id); else db[catKey].push(id); save(); render(); }); });
        break;
      }

      case "refresh-prices": refreshAll(); break;

      case "install-app":
        if (deferredInstall) {
          deferredInstall.prompt();
          deferredInstall.userChoice.then(function () { deferredInstall = null; render(); });
        } else { toast("Use your browser's install icon in the address bar"); }
        break;

      case "install-now":   // first-run popup: fire the native install dialog, then close the card
        closeModal();
        if (deferredInstall) {
          deferredInstall.prompt();
          deferredInstall.userChoice.then(function () { deferredInstall = null; render(); });
        } else { toast("Use your browser's install icon in the address bar"); }
        break;

      case "dismiss-install":   // first-run popup: "Not now" - remember so it doesn't nag again (Settings -> Install still works)
        try { localStorage.setItem(INSTALL_DISMISS_KEY, "1"); } catch (e) { /* ignore */ }
        closeModal();
        break;

      case "snooze-backup": db.meta.backupSnooze = Date.now() + 7 * DAY; save(); render(); break;
      case "undo-delete": runUndo(); break;
      case "apply-update": applyUpdate(); break;
      case "show-fetch-fails": fetchFailModal(); break;
      case "del-recurring": {
        db.recurring = (db.recurring || []).filter(function (r) { return r.id !== id; });   // stop future months; past entries stay
        save(); render(); toast("Recurring stopped");
        break;
      }
      case "load-sample": loadSampleData(); break;
      case "tax-report": printTaxReport(); break;   // printable tax-year + net-worth report
      case "choose-backup-folder": chooseBackupFolder(); break;
      case "import-csv": importCSV(kind); break;
      case "import-cashflow": importCashFlowFile(kind); break;
      case "download-cashflow-template": downloadCashFlowTemplate(); break;
      case "backup-now": backupNow(); break;
      case "export-data": exportData(); break;
      case "export-data-enc": exportEncrypted(); break;
      case "export-excel": exportExcel(); break;
      case "import-data": importData(); break;
      case "import-excel": importExcel(); break;
      case "download-excel-template": downloadExcelTemplate(); break;
      case "reset-data": resetData(); break;
      case "preview-wizard": state.previewWizard = true; state.wizardStep = 0; window.scrollTo(0, 0); render(); break;
      case "set-theme": {
        var nextTheme = el.getAttribute("data-theme");
        db.settings.theme = (nextTheme === "light" || nextTheme === "dim") ? nextTheme : "dark";
        save(); render(); break;
      }
      case "set-language": {
        var nextLang = el.getAttribute("data-lang") === "it" ? "it" : "en";
        db.settings.language = nextLang;
        save(); render(); toast(nextLang === "it" ? "Language set to Italian" : "Language set to English");
        break;
      }
      case "wizard-next": {
        var ws = state.wizardStep || 0;
        if (ws === 2 && !captureProfileForm(true)) break;
        state.wizardStep = Math.min(4, ws + 1);
        window.scrollTo(0, 0); render(); break;
      }
      case "wizard-back": {
        state.wizardStep = Math.max(0, (state.wizardStep || 0) - 1);
        window.scrollTo(0, 0); render(); break;
      }

      case "finish-setup":
        if (state.previewWizard) { state.previewWizard = false; state.route = "settings"; window.scrollTo(0, 0); render(); break; }
        // Capture the Profile inputs even if the user never clicked "Save Profile" - finishing should never
        // silently discard a typed name or chosen base currency. Mirrors the profile-form submit handler.
        if (!captureProfileForm(true)) break;
        if (!db.settings.baseCurrency) { state.wizardStep = 2; toast("Choose a primary currency"); render(); break; }
        if (db.tax && !db.tax.currency) db.tax.currency = db.settings.baseCurrency;
        if (!db.currencies.length) { toast("Add at least one currency"); break; }
        db.setupComplete = true;
        if (!db.meta.firstMonth) db.meta.firstMonth = currentMonth();   // wallet starts now: no phantom prior-month history
        state.wizardStep = 0; state.wizardSeen = false;
        save(); state.route = "dashboard"; toast("All set! ");
        if (tutorialPending()) startTutorial(); else render();
        break;

      case "tutorial-next":
        if (state.tutorial && state.tutorial.step < TUTORIAL_STEPS.length - 1) { state.tutorial.step++; render(); }
        else finishTutorial();
        break;
      case "tutorial-back":
        if (state.tutorial && state.tutorial.step > 0) { state.tutorial.step--; render(); }
        break;
      case "tutorial-dot": {
        var ds = parseInt(el.getAttribute("data-step"), 10);
        if (state.tutorial && ds >= 0 && ds < TUTORIAL_STEPS.length) { state.tutorial.step = ds; render(); }
        break;
      }
      case "tutorial-skip": finishTutorial(); break;
      case "replay-tutorial":
        try { localStorage.removeItem(TUTORIAL_KEY); } catch (e) { /* ignore */ }
        startTutorial();
        break;
    }
  });

  document.addEventListener("input", function (e) {
    if (e.target.id !== "c-preset") return;
    e.target.removeAttribute("data-picked-code");
    openCurrencySuggestions(e.target);
    var pcode = resolveCatalogCurrency(e.target.value);
    if (!pcode) return;
    setCurrencyPickerCode(pcode);
  });
  document.addEventListener("focusin", function (e) {
    if (e.target.id !== "c-preset") return;
    openCurrencySuggestions(e.target, e.target.getAttribute("data-picked-code") ? "" : null);
  });
  document.addEventListener("click", function (e) {
    if (e.target.id !== "c-preset") return;
    openCurrencySuggestions(e.target, e.target.getAttribute("data-picked-code") ? "" : null);
  });
  document.addEventListener("mousedown", function (e) {
    if (e.target.closest(".currency-combo") || e.target.closest("#currency-suggestions")) return;
    closeCurrencySuggestions();
  });
  document.addEventListener("keydown", function (e) {
    if (e.target.id !== "c-preset") return;
    if (e.key === "Escape") {
      closeCurrencySuggestions();
      return;
    }
    if (e.key !== "Enter") return;
    var first = document.querySelector("#currency-suggestions .currency-option");
    if (!first) return;
    e.preventDefault();
    setCurrencyPickerCode(first.getAttribute("data-code"));
    closeCurrencySuggestions();
  });
  window.addEventListener("resize", function () {
    var box = document.getElementById("currency-suggestions");
    if (box && box.classList.contains("open")) positionCurrencySuggestions();
  });

  // change events (selects, quick-add form)
  document.addEventListener("change", function (e) {
    var el = e.target.closest("[data-act]");
    if (el && el.getAttribute("data-act") === "set-month") {
      if (el.value === "__add_year__") { addYearModal(el); return; }
      if (el.value === "__add_month__") { addMonthModal(el); return; }
      state.month = el.value; render();
    }
    if (el && el.getAttribute("data-act") === "set-year") {
      if (el.value === "__add_year__") { addYearModal(el); return; }
      state.month = el.value + "-" + state.month.slice(5); render();
    }
    if (el && el.getAttribute("data-act") === "set-tax-year") { state.taxYear = el.value; render(); }
    if (el && el.getAttribute("data-act") === "set-alloc-currency") { db.settings.allocCurrency = el.value; save(); render(); }
    if (el && el.getAttribute("data-act") === "set-autobackup") {
      db.settings.autoBackup = el.value;
      // Turning auto-backup off forgets the chosen folder, so it can't silently keep writing to a stale
      // handle if it's later re-enabled (or after a reset).
      if (el.value === "off") { db.settings.backupFolderName = ""; idbSet("backup_dir_handle", null).catch(function () { }); }
      save();
      toast(el.value === "off" ? "Auto-backup off" : (window.showDirectoryPicker ? "Auto-backup " + el.value + " - choose a folder to write to" : "Reminder set - use Back up now to download"));
      render(); return;
    }
    if (el && el.getAttribute("data-act") === "toggle-notifications") {
      if (!el.checked) { db.settings.notifications = false; save(); render(); toast("Reminders off"); return; }
      if (typeof Notification === "undefined") { el.checked = false; toast("Notifications aren't supported here"); return; }
      Notification.requestPermission().then(function (perm) {
        if (perm === "granted") {
          db.settings.notifications = true; db.meta.lastNotifyMonth = currentMonth(); save();
          try { new Notification(db.settings.name || "Valutio", { body: "Reminders are on - we'll nudge you at the start of each month.", icon: "Icons/icon-192.png" }); } catch (e) { }
          toast("Reminders on");
        } else { db.settings.notifications = false; save(); toast("Notifications were blocked"); }
        render();
      });
      return;
    }
    if (el && (el.getAttribute("data-act") === "set-dash-card" || el.getAttribute("data-act") === "set-inv-card")) {
      var isInv = el.getAttribute("data-act") === "set-inv-card";
      var key = isInv ? "invCards" : "dashCards", fb = isInv ? INV_CARDS_DEFAULT : DASH_CARDS_DEFAULT;
      var arr = slotKeys(db.settings[key], fb), kIdx = +el.getAttribute("data-idx");
      var dup = arr.indexOf(el.value);
      if (dup >= 0 && dup !== kIdx) arr[dup] = arr[kIdx];   // swap so the same metric never shows in two slots
      arr[kIdx] = el.value; db.settings[key] = arr; save(); render(); return;
    }
    if (el && el.getAttribute("data-act") === "set-country") {
      var inModal = !!el.closest(".modal");
      // In the setup wizard the country never overrides the manually chosen Base Currency;
      // only the Tax Settings modal still aligns the reporting currency with the country.
      applyTaxPreset(el.value, !inModal);
      // Switching a country preset is a settings change, NOT a year rollover. Align the tracked tax-year
      // LABEL to the new country's current fiscal year, but never archive/reset - the user's invoices,
      // employment income and tax-paid must survive a preset switch. (Real time-based freezing still runs
      // on boot via maybeAutoFreezeTaxYear; aligning the label here also stops that boot pass from then
      // treating the relabelled year as a missed rollover and wiping the data on next launch.)
      // Relabel the live year to the new country's current FY - but NOT if that label already exists in the
      // archive (switching between a split-FY and a calendar-FY country can produce a colliding label right
      // after a rollover). On collision keep the current label so the two years stay distinct and reachable.
      if (db.tax) {
        var newLabel = expectedFYLabel();
        var collides = (db.taxArchive || []).some(function (a) { return a && a.year === newLabel; });
        if (!collides) { db.tax.year = newLabel; if (state.taxYear) state.taxYear = db.tax.year; }
      }
      save();
      if (inModal) taxConfigModal();   // re-open the Tax Settings modal with the preset values loaded
      else render();                   // wizard / page behind: refresh the selected country
      toast("Loaded " + (countryName(el.value) || el.value) + " tax preset");
      // A base-currency switch (Tax Settings) rebased FX onto static cross-rates; refine to LIVE rates when
      // online so non-base balances are exact, not just close. Closed months keep their frozen FX.
      if (inModal && navigator.onLine) {   // refine the static cross-rates to LIVE FX when online
        fetchFX().then(function (ok) { if (ok) { recomputeAllSnapshots(); save(); render(); } }).catch(function () { });
      }
      return;
    }
    if (e.target.id === "set-provider") {
      var kf = document.getElementById("apikey-field");
      if (kf) kf.style.display = (e.target.value === "yahoo") ? "none" : "";
    }
    if (e.target.id === "set-crypto-provider") {
      var ckf = document.getElementById("crypto-apikey-field");
      if (ckf) ckf.style.display = (e.target.value === "coingecko" || e.target.value === "binance") ? "none" : "";
    }
    if (e.target.id === "set-base" && e.target.value && e.target.value !== "__add__") {
      // During the stepped setup, persist the primary currency as soon as it is picked. Otherwise a
      // later secondary-currency change re-renders the page before Finish/Next captures the base select.
      if (!db.setupComplete || state.previewWizard) {
        var liveOldBase = db.settings.baseCurrency;
        var liveBaseChanged = rebaseCurrencyPool(e.target.value);
        if (db.tax && (!db.tax.currency || db.tax.currency === liveOldBase)) db.tax.currency = db.settings.baseCurrency;
        pruneCurrencies();
        if (liveBaseChanged && navigator.onLine) {
          fetchFX().then(function (ok) { if (ok) { recomputeAllSnapshots(); save(); render(); } }).catch(function () { });
        }
        save(); render(); return;
      }
    }
    if (e.target.id === "set-sec") {
      if (e.target.value === "__add__") {
        e.target.value = db.settings.secondaryCurrency || "";   // reset so a cancel isn't stuck
        currencyModal(null, function (code) { db.settings.secondaryCurrency = code; ensureCurrency(code); save(); render(); });
        return;
      }
      // Picking a preset secondary registers it straight into the Currencies & FX state/table below.
      var scCode = e.target.value;
      db.settings.secondaryCurrency = scCode;
      if (scCode) {
        ensureCurrency(scCode);
        var scRec = curByCode(scCode);
        if (scRec && scCode !== base()) { var scR = metaRateInBase(scCode); if (scR) scRec.rate = num(scR); }
        if (navigator.onLine) {
          fetchFX().then(function (ok) { if (ok) { recomputeAllSnapshots(); save(); render(); } }).catch(function () { });
        }
      }
      save(); render();
      return;
    }
    if (e.target.id === "h-type" && e.target.value === "__add__") {
      var hsel = e.target, fb = (db.holdingTypes[0] || {}).key || "stock";
      var nm = (window.prompt("Name for the new asset type (e.g. Bond, REIT, Commodity):") || "").trim();
      if (!nm) { hsel.value = fb; return; }
      var key = nm.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || ("type" + Date.now().toString(36));
      if (!db.holdingTypes.some(function (t) { return t.key === key; })) {
        var used = db.holdingTypes.map(function (t) { return t.color; });
        var color = PALETTE.filter(function (c) { return used.indexOf(c) < 0; })[0] || paletteColor(db.holdingTypes.length);
        db.holdingTypes.push({ key: key, label: nm, color: color });
        save();
      }
      var addOpt = hsel.querySelector('option[value="__add__"]');
      if (!hsel.querySelector('option[value="' + key + '"]')) {
        var opt = document.createElement("option"); opt.value = key; opt.textContent = nm;
        hsel.insertBefore(opt, addOpt);
      }
      hsel.value = key;
    }
    if (e.target.id === "q-cur" && e.target.value === "__newcur__") {
      if (e.target.closest(".txn-drawer")) {
        var dcur = cfDraftFromForm(), dkcur = cfAddKind();
        dcur.currency = base();
        currencyModal(null, function (code) {
          dcur.currency = code;
          setTimeout(function () { openTransactionDrawer(dkcur, dcur); }, 0);
        });
        return;
      }
      var csel = e.target;
      csel.value = base();   // reset now so cancelling never leaves the picker on the action row
      currencyModal(null, function (code) {
        var addOpt = csel.querySelector('option[value="__newcur__"]');
        var exists = [].some.call(csel.options, function (o) { return o.value === code; });
        if (!exists) {
          var o = document.createElement("option");
          o.value = code; o.textContent = code + " (" + ((curByCode(code) || {}).symbol || code) + ")";
          csel.insertBefore(o, addOpt);
        }
        csel.value = code;   // select the new currency in the quick-add picker
      });
    }
    if (e.target.id === "q-cat" && e.target.value === "__newcat__") {
      if (e.target.closest(".txn-drawer")) {
        var dcat = cfDraftFromForm(), dkcat = cfAddKind(), dkey = dkcat === "expense" ? "expenseCategories" : "incomeCategories";
        dcat.category = db[dkey][0] || "";
        openModal({
          title: "New " + (dkey === "expenseCategories" ? "Expense" : "Income") + " Category",
          body: '<div class="field"><label>Category name</label><input id="newcat-name" placeholder="e.g. Gifts" required></div>',
          submitLabel: "OK",
          onSubmit: function () {
            var nm = (val("newcat-name") || "").trim();
            if (!nm) { toast("Enter a category name"); return false; }
            if (db[dkey].indexOf(nm) === -1) { db[dkey].push(nm); save(); toast("Category added"); }
            dcat.category = nm;
            setTimeout(function () { openTransactionDrawer(dkcat, dcat); }, 0);
          },
        });
        return;
      }
      var qsel = e.target, qaddk = (state.route === "cashflow") ? cfAddKind() : state.route, qkey = (qaddk === "expense" || qaddk === "expenses") ? "expenseCategories" : "incomeCategories";
      qsel.value = (db[qkey][0] || "");   // reset now so cancelling never leaves the picker on the action row
      openModal({
        title: "New " + (qkey === "expenseCategories" ? "Expense" : "Income") + " Category",
        body: '<div class="field"><label>Category name</label><input id="newcat-name" placeholder="e.g. Gifts" required></div>',
        submitLabel: "OK",
        onSubmit: function () {
          var nm = (val("newcat-name") || "").trim();
          if (!nm) { toast("Enter a category name"); return false; }
          if (db[qkey].indexOf(nm) === -1) {
            db[qkey].push(nm); save();
            var addOpt = qsel.querySelector('option[value="__newcat__"]');
            var exists = [].some.call(qsel.options, function (o) { return o.value === nm; });
            if (!exists) { var o = document.createElement("option"); o.value = nm; o.textContent = nm; qsel.insertBefore(o, addOpt); }
            toast("Category added");
          }
          qsel.value = nm;   // select the new (or existing) category in the quick-add picker
        },
      });
      return;
    }
    if (e.target.id === "a-bucket") {
      var ow = document.getElementById("a-bucket-other-wrap");
      if (ow) { ow.style.display = (e.target.value === "Other") ? "" : "none"; }
    }
    if (e.target.id === "a-joint") {
      var jw = document.getElementById("a-joint-wrap");
      if (jw) { jw.style.display = e.target.checked ? "" : "none"; }
    }
    if (e.target.id === "q-joint") {
      var qjw = document.getElementById("q-joint-wrap");
      if (qjw) { qjw.style.display = e.target.checked ? "" : "none"; }
    }
    if (e.target.id === "le-joint") {
      var ljw = document.getElementById("le-joint-wrap");
      if (ljw) { ljw.style.display = e.target.checked ? "" : "none"; }
    }
    if (e.target.id === "cf-sort") { state.cfSort = e.target.value; render(); }
    if (e.target.id === "c-preset" && e.target.value) {
      var pcode = resolveCatalogCurrency(e.target.value);
      if (!pcode) return;
      var pm = CURRENCY_META[pcode] || { symbol: currencySymbol(pcode) };
      var cc = document.getElementById("c-code"); if (cc) cc.value = pcode;
      var csym = document.getElementById("c-sym"); if (csym) csym.value = (pm.symbol || "").trim();
      // rate is relative to the user's chosen base currency, not hardcoded EUR
      var crate = document.getElementById("c-rate"); if (crate && !crate.value) crate.value = metaRateInBase(pcode) || "";
    }
    if (e.target.id === "set-base" && e.target.value === "__add__") {
      e.target.value = db.settings.baseCurrency;              // reset so a cancel isn't stuck
      currencyModal(null, function (code) {
        var oldBase = db.settings.baseCurrency;
        rebaseCurrencyPool(code);
        if (db.tax && (!db.tax.currency || !db.setupComplete || db.tax.currency === oldBase)) db.tax.currency = db.settings.baseCurrency;
        pruneCurrencies();
        save(); render(); toast("Base set to " + code + ", re-check FX rates");
      });
    }
  });
  document.addEventListener("submit", function (e) {
    if (e.target.id === "quick-ledger") {
      e.preventDefault();
      var inTxnDrawer = !!e.target.closest(".txn-drawer");
      var addKind = (state.route === "cashflow") ? cfAddKind() : state.route;
      var isExpense = (addKind === "expense" || addKind === "expenses");
      var recur = checked("q-recur");
        var qAmt = num(val("q-amt"));
        if (qAmt <= 0) { toast("Enter an amount greater than zero"); return; }
        var obj = { id: uid(), month: state.month, category: val("q-cat"), amount: qAmt, currency: val("q-cur"), note: val("q-note").trim() };
      if (isExpense && checked("q-joint")) {
        var qsv = val("q-share"); obj.joint = true; obj.share = qsv === "" ? 50 : Math.max(0, Math.min(100, num(qsv)));
      }
      if (recur) {
        // Create a monthly rule; tag THIS entry as the current month's occurrence so applyRecurring won't dupe it.
        var rule = { id: uid(), kind: isExpense ? "expense" : "income", category: obj.category, amount: obj.amount, currency: obj.currency, note: obj.note, since: currentMonth() };
        if (obj.joint) { rule.joint = true; rule.share = obj.share; }
        db.recurring.push(rule);
        if (obj.month === currentMonth()) obj.recurringId = rule.id;
      }
      if (isExpense) db.expenses.push(obj); else db.incomes.push(obj);
      recomputeAllSnapshots(); save(); render();   // refresh frozen months' cash-flow flows for History
      if (inTxnDrawer) resetQuickLedgerForNext();
      toast(inTxnDrawer ? (recur ? "Added - repeats monthly - ready for next" : "Added - ready for next") : (recur ? "Added - repeats monthly" : "Added"));
    }
    if (e.target.id === "profile-form") {
      e.preventDefault();
      var oldProfileBase = db.settings.baseCurrency;
      if (!captureProfileForm(true)) return;
      toast(oldProfileBase !== db.settings.baseCurrency ? "Base currency changed to " + db.settings.baseCurrency : "Profile saved");
      render();
    }
    if (e.target.id === "provider-form") {
      e.preventDefault();
      db.settings.stockProvider = val("set-provider");
      db.settings.stockApiKey = val("set-apikey").trim();
      save(); render(); toast("Price provider saved");
    }
    if (e.target.id === "crypto-provider-form") {
      e.preventDefault();
      db.settings.cryptoProvider = val("set-crypto-provider");
      db.settings.cryptoApiKey = val("set-crypto-apikey").trim();
      save(); render(); toast("Crypto provider saved");
    }
    if (e.target.id === "benchmark-form") {
      e.preventDefault();
      var newBench = val("set-benchmark").trim();
      var benchChanged = newBench !== (db.settings.benchmark || "");
      db.settings.benchmark = newBench;
      if (benchChanged && db.meta) db.meta.benchmarkHist = null;   // drop stale history for the old symbol
      save(); render(); toast("Benchmark saved");
      if (navigator.onLine) fetchBenchmarkHistory().then(function (ok) { if (ok) { save(); render(); } });
    }
  });

  // Enter in the holding-search box runs the search instead of submitting the form
  document.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && e.target && e.target.id === "h-search") {
      e.preventDefault();
      holdingSearchRun();
    }
  });

  // Retirement tracker: mutate the working input on each keystroke and patch ONLY the
  // results region, leaving the focused field untouched (no full re-render, no focus loss).
  document.addEventListener("input", function (e) {
    // Cash Flow ledger live filter (no re-render → keeps focus): show/hide rows by text match.
    if (e.target && e.target.id === "cf-search") {
      var q = e.target.value.trim().toLowerCase();
      document.querySelectorAll(".cf-ledger tbody tr").forEach(function (tr) {
        tr.style.display = (!q || tr.textContent.toLowerCase().indexOf(q) >= 0) ? "" : "none";
      });
      return;
    }
    // Help FAQ live search (no re-render → keeps focus + open accordions).
    if (e.target && e.target.id === "help-faq-search") { filterHelpFaq(); return; }
    var key = e.target && e.target.getAttribute && e.target.getAttribute("data-rt");
    if (!key) return;
    retireState[key] = num(e.target.value);
    saveRetireInput(key, retireState[key]);
    var box = document.getElementById("rt-results");
    if (box) box.innerHTML = retireResultsHTML(retireCalc(retireState));
  });

  // Help FAQ filter: show/hide questions by the search text AND the active category chip (DOM only).
  function filterHelpFaq() {
    var list = document.getElementById("help-faq-list");
    if (!list) return;
    var inp = document.getElementById("help-faq-search");
    var q = inp ? inp.value.trim().toLowerCase() : "";
    var chips = document.getElementById("help-faq-chips");
    var on = chips ? chips.querySelector(".fchip.on") : null;
    var cat = on ? on.getAttribute("data-faq-cat") : "all";
    // category dividers are a browsing aid only - show them on the unfiltered "All" view, hide while filtering
    var browsing = (cat === "all" && !q);
    list.querySelectorAll(".faq-cat-div").forEach(function (d) { d.style.display = browsing ? "" : "none"; });
    var shown = 0;
    list.querySelectorAll(".faq-item").forEach(function (d) {
      var okCat = cat === "all" || d.getAttribute("data-cat") === cat;
      var okText = !q || (d.getAttribute("data-text") || "").indexOf(q) !== -1;
      var show = okCat && okText;
      d.style.display = show ? "" : "none";
      if (show) shown++;
    });
    var empty = document.getElementById("help-faq-empty");
    if (empty) empty.style.display = shown ? "none" : "";
  }
  // Category chips: set active + re-filter (separate from the main data-act dispatch; chips carry none).
  document.addEventListener("click", function (e) {
    var chip = e.target && e.target.closest ? e.target.closest("#help-faq-chips .fchip") : null;
    if (!chip) return;
    var box = document.getElementById("help-faq-chips");
    box.querySelectorAll(".fchip").forEach(function (c) { c.classList.remove("on"); });
    chip.classList.add("on");
    filterHelpFaq();
  });
  // Single-open accordion: close any other open question BEFORE the clicked one expands.
  // Using click-capture (fires before the native <details> toggle) avoids a one-frame "both open"
  // state - the cause of the brief downward shift when switching questions.
  document.addEventListener("click", function (e) {
    var sum = e.target && e.target.closest ? e.target.closest("#help-faq-list .faq-item > summary") : null;
    if (!sum) return;
    var me = sum.parentElement;
    var list = document.getElementById("help-faq-list");
    if (!list) return;
    list.querySelectorAll(".faq-item[open]").forEach(function (d) { if (d !== me) d.removeAttribute("open"); });
  }, true);

  // ----------------------------------------------------------
  // Install (PWA) prompt handling
  // ----------------------------------------------------------
  // First-run popup nudging desktop install. Shows only when the browser can actually
  // install (Chromium fired beforeinstallprompt), the app is not already installed, and the
  // user hasn't dismissed it before. The native OS dialog needs a user gesture, so this is a
  // styled in-app card whose Install button triggers the real prompt. Safari/Firefox never
  // fire beforeinstallprompt, so they just see the Settings -> Install instructions instead.
  function maybeShowInstallPrompt() {
    try {
      if (!deferredInstall) return;                                              // browser can't install (or already used)
      var standalone = window.matchMedia && window.matchMedia("(display-mode: standalone)").matches;
      if (standalone || localStorage.getItem("pwaInstalled") === "true") return; // already installed
      if (localStorage.getItem(INSTALL_DISMISS_KEY) === "1") return;             // user chose "Not now" before
      if (state.tutorial) return;                                                // don't collide with the first-run tour
      var root = document.getElementById("modal-root");
      if (root && root.innerHTML) return;                                        // don't clobber an open modal
    } catch (e) { return; }
    openModal({
      cls: "install-modal",
      bare: true,
      body:
        '<button class="modal-x" data-act="dismiss-install" title="Close">×</button>' +
        '<div class="install-card">' +
          '<img class="install-icon" src="Icons/icon-192.png" alt="Valutio">' +
          '<h2>Install Valutio on your desktop?</h2>' +
          '<p>Add Valutio to your computer so it opens in its own window, launches from your taskbar or dock, and works offline. It’s free and takes a second.</p>' +
          '<div class="install-acts">' +
            '<button class="btn primary" data-act="install-now">' + icon("arrowDown") + ' Install Valutio</button>' +
            '<button class="btn ghost" data-act="dismiss-install">Not now</button>' +
          '</div>' +
        '</div>',
    });
  }

  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault(); deferredInstall = e;
    if (state.route === "settings") render();
    setTimeout(maybeShowInstallPrompt, 1200);   // nudge once the page has settled
  });
  window.addEventListener("appinstalled", function () {
    deferredInstall = null;
    try { localStorage.setItem("pwaInstalled", "true"); } catch (e) { /* ignore */ }
    render();   // re-render so the Settings install section flips to "already installed"
    toast("Installed! Find Valutio in your apps.");
  });

  // ----------------------------------------------------------
  // Service worker: offline cache + in-app "update available" prompt.
  // A new deploy (bumped CACHE in sw.js) is fetched in the background; we then surface a
  // Refresh toast so the user applies it when convenient. If they ignore it, the update
  // activates on its own the next time the app is fully reopened. Bump CACHE every deploy.
  // ----------------------------------------------------------
  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    if (location.protocol !== "https:" && location.hostname !== "localhost") return;
    var refreshing = false;
    navigator.serviceWorker.addEventListener("controllerchange", function () {
      if (!refreshing) return;          // ignore the first-install claim; reload only after the user accepts
      window.location.reload();
    });
    navigator.serviceWorker.register("sw.js").then(function (reg) {
      function offerUpdate(worker) {
        if (!worker) return;
        updateToast(function () { refreshing = true; worker.postMessage("SKIP_WAITING"); });
      }
      if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);   // already waiting at load
      reg.addEventListener("updatefound", function () {
        var nw = reg.installing;
        if (!nw) return;
        nw.addEventListener("statechange", function () {
          // "installed" WITH an existing controller => a real update (not the first install)
          if (nw.state === "installed" && navigator.serviceWorker.controller) offerUpdate(reg.waiting || nw);
        });
      });
      var check = function () { try { reg.update(); } catch (e) { } };
      check();                                                       // check on load
      document.addEventListener("visibilitychange", function () {   // and whenever the app regains focus
        if (document.visibilityState !== "visible") return;
        check();
        if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);   // re-surface if dismissed
      });
      setInterval(check, 30 * 60 * 1000);                           // and periodically for long-open apps
    }).catch(function () { /* ignore */ });
  }

  function applyStatementCategorizerRows(rows) {
    var added = 0, skipped = 0, changed = 0;
    (rows || []).forEach(function (row) {
      var target = row.kind === "income" ? db.incomes : db.expenses;
      var existing = target.filter(function (x) {
        return x.statementSourceKey && (x.statementSourceKey === row.sourceKey || x.statementSourceKey === row.legacySourceKey || x.statementSourceKey === row.legacyBaseSourceKey);
      })[0];
      if (existing) { skipped++; if (Math.abs(num(existing.amount) - Math.abs(num(row.amount))) > 0.005) changed++; return; }
      var categoryList = row.kind === "income" ? db.incomeCategories : db.expenseCategories;
      if (categoryList.indexOf(row.category) === -1) categoryList.push(row.category);
      ensureCurrency(row.currency);
      var obj = {
        id: uid(), month: row.month, category: row.category, amount: Math.abs(num(row.amount)),
        currency: row.currency, note: row.note || "Statement categoriser", statementSourceKey: row.sourceKey,
      };
      if (row.kind === "expense" && row.accountType === "Joint") { obj.joint = true; obj.share = 50; }
      if (row.kind === "income" && row.accountType === "Joint") obj.statementAccountType = "Joint";
      target.push(obj); added++;
    });
    if (added) { recomputeAllSnapshots(); save(); }
    var result = { added: added, skipped: skipped };
    if (changed) result.changed = changed;
    return result;
  }
  function connectStatementCategorizer() {
    if (!window.ValutioStatementCategorizer) return;
    window.ValutioStatementCategorizer.connect({
      context: function () {
        var rows = (db.expenses || []).map(function (x) {
          return { kind: "expense", accountType: isJoint(x) ? "Joint" : "Personal", category: x.category, amount: num(x.amount), month: x.month, currency: x.currency };
        }).concat((db.incomes || []).map(function (x) {
          return { kind: "income", accountType: x.statementAccountType || "Personal", category: x.category, amount: num(x.amount), month: x.month, currency: x.currency };
        }));
        return {
          baseCurrency: base(), country: db.settings.country, currencies: (db.currencies || []).map(function (c) { return c.code; }),
          expenseCategories: (db.expenseCategories || []).slice(), incomeCategories: (db.incomeCategories || []).slice(),
          cashFlowRows: rows,
        };
      },
      preferences: function () { return db.settings.statementCategorizer; },
      savePreferences: function (value) { db.settings.statementCategorizer = value; save(); },
      convertCurrency: function (amount, fromCurrency, toCurrency) { return convert(num(amount), fromCurrency, toCurrency); },
      rerender: function () { if (state.route === "cashflow" && state.cfView === "categorizer") render(); },
      toast: toast, openModal: openModal, loadSheetJS: loadSheetJS,
      applyRows: applyStatementCategorizerRows,
    });
  }

  // ----------------------------------------------------------
  // Boot
  // ----------------------------------------------------------
  // Initialization enforcer: always mount on the real-world current month/year, never a stale period
  // left over from a prior session's in-memory state.
  // Load persisted data from IndexedDB (with one-time localStorage migration) BEFORE first paint, then boot.
  // loadAsync always resolves, so the app never hangs on a storage failure - worst case it boots fresh.
  loadAsync().then(function (loaded) {
    db = loaded;
    connectStatementCategorizer();
    syncRetireStateFromDb();
    // Ask the browser to keep our data durable (resist eviction under storage pressure). Best-effort.
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () { }); } catch (e) { }
    state.month = currentMonth();
    recomputeAllSnapshots();                       // recompute the live month only; closed months are immutable (keep their frozen FX)
    if ((db.snapshots || []).length) save();       // persist the reprojected history
    maybeAutoSnapshot();
    maybeAutoFreezeTaxYear();   // lock the fiscal year automatically once its country tax-year-end passes
    if (db.setupComplete && applyRecurring()) { recomputeAllSnapshots(); save(); }   // auto-log this month's recurring cash flow
    // first-run tour: only once setup is done and the tutorial flag is still missing
    if (db.setupComplete && tutorialPending()) startTutorial();
    else render();   // first-time users land directly on the setup screen (its own welcome hero greets them)
    if (storageRecoveryNotice) setTimeout(function () { toast(storageRecoveryNotice); }, 450);
    maybeAutoRefreshRates();   // keep live prices + FX current on open (throttled to ~once/12h)
    backfillHistoricalRates(); // lock any closed month with no stored FX to its TRUE month-end historical rate
    maybeAutoBackup();         // silent backup to the chosen folder if one is set and a backup is due
    maybeNotify();             // monthly reminder (if enabled + permitted)
    setTimeout(maybeShowInstallPrompt, 1500);   // first-run desktop-install nudge (no-op if already installed/dismissed, or event hasn't fired)
    // re-check hourly so an open tab captures month-end snapshots and fiscal-year freezes automatically
    setInterval(function () { var a = maybeAutoSnapshot(), b = maybeAutoFreezeTaxYear(); if (a || b) render(); }, 1000 * 60 * 60);
    window.__walletRender = render;
    registerServiceWorker();   // offline cache + in-app update prompt (replaces the old inline registration)
  });

})();
