# Valutio Maintainer Guide

Valutio was created and is maintained by **Salvatore Sorvillo**.

This is the technical source of truth for changing Valutio safely. Read it before editing application logic, stored data, financial calculations, imports, themes, translations, service-worker behavior, or release scripts.

The code and regression tests remain authoritative. If behavior changes, update this guide in the same change. If this guide disagrees with the code, investigate the discrepancy instead of choosing whichever behavior is more convenient.

## 1. Product Contract

Valutio is a free, open-source, local-first personal finance application. It tracks accounts, net worth, investments, cash flow, debts, assets, goals, history, retirement projections, and configurable tax estimates.

The community-app product contract is:

- No required account or subscription, cloud database, or bank connection.
- Wallet data is stored on the user's device.
- The app works offline after its shell has been cached.
- Network access is optional and used for FX, investment prices, benchmark data, and external links. Financial records are not sent to those providers.
- Plain JSON and encrypted JSON are the full-fidelity backup formats.
- Excel and CSV are review, migration, and ledger-interchange formats. They are not substitutes for an exact JSON backup.
- Tax and retirement figures are planning estimates, not tax, legal, or investment advice.
- English and Italian are supported display languages.
- Dark, light, and dim themes must remain functionally equivalent.

Do not add authentication, remote persistence, telemetry, analytics, advertising, bank connections, or background data upload without an explicit product decision and synchronized privacy, legal, English, and Italian copy updates. Optional services offered separately from the community app must not silently change its local-first data boundary.

## 2. Non-Negotiable Financial Invariants

These rules protect user balances and history:

1. Never reinterpret the FX convention. A rate is the number of base-currency units represented by one unit of the native currency.
2. Never calculate sold quantity, cost basis, or realized profit from array order. Always use canonical sorted transaction order.
3. Never allow a transaction ledger to sell more shares than it held at that point in time. Replay persisted share quantities with exact decimal arithmetic for this check; do not add a floating-point tolerance.
4. Preserve user-entered decimal strings in JSON. Crypto quantities may contain 18 decimal places.
5. Closed net-worth snapshots do not revalue at today's prices or FX.
6. An archived tax year uses its own country, currency, fiscal window, inputs, locked invoice conversions, and captured income sources.
7. Capital losses offset capital gains only. They must not reduce ordinary income.
8. Capital losses are applied before any long-term capital-gains discount.
9. New trades require valid exact dates. Legacy month-only trades retain month precision and conservative holding-period treatment.
10. Full JSON restore is replacement. Validate the untouched JSON payload before migration so malformed financial input cannot be silently normalized. Cash-flow CSV or Excel import is append-only, deduplicated, and must not replace unrelated wallet data.
11. Invalid or out-of-year invoices must not silently enter tax calculations.
12. Linked debt must not be subtracted twice from an equity-mode asset.
13. Fully sold holdings retain history but are excluded from live quote refresh.
14. Every app release must bump all cache identifiers described below.
15. A dividend-reinvestment reconciliation is one indivisible buy/dividend pair. Never save, import, edit, delete, or undo only one side, and never replace the ledger with a raw share-total override.

Any change touching these invariants needs a deterministic regression test before release.

## 3. Repository Map

The readable source folder is the only place to edit the application.

| Path | Responsibility |
| --- | --- |
| `index.html` | Static shell and versioned CSS/JS references |
| `app.js` | State, schema, migration, validation, calculations, rendering, actions, providers, imports, and exports |
| `app.i18n.js` | English-to-Italian dictionaries and dynamic patterns |
| `statement-categorizer.js` | Session-only statement parsing, automatic/manual categorisation, reports, and Cash Flow apply preparation |
| `app.css` | Layout, components, tables, responsive behavior, and theme tokens |
| `sw.js` | Offline shell, cache version, updates, and fetch strategy |
| `manifest.webmanifest` | PWA metadata |
| `LICENSE` | Unmodified GNU AGPL v3 license text for the application |
| `.github/PULL_REQUEST_TEMPLATE.md` | Pull-request checklist and explicit CLA acknowledgement |
| `Templates/` | Full workbook and cash-flow templates |
| `Icons/` | Brand and PWA icons |
| `Fonts/` | Self-hosted Hanken Grotesk and Material Symbols Rounded, with their third-party license notices |
| `Vendor/` | Vendored SheetJS and license |
| `Vendor/pdfjs/` | Pinned PDF.js runtime and Apache-2.0 license for offline statement text extraction |
| `Rules/statement-categorizer-defaults.json` | Default expense keywords, exclusions, and reversal terms |
| `Deploy/` | Files copied to the deploy root, including Netlify routing |
| `Scripts/test-financial-logic.mjs` | Deterministic financial regression suite |
| `Scripts/test-statement-categorizer.mjs` | Deterministic statement parsing and categorisation suite |
| `Scripts/validate-wallet-backup.mjs` | JSON-backup validator |
| `Scripts/generate-stress-wallet.mjs` | Large synthetic-wallet generator |
| `Scripts/build-deploy.py` | Minifies and copies the deployable application |
| `Scripts/publish-public.py` | Rebuilds the clean public source export and syncs website demo assets |
| `publish-public.ps1` | Normal Windows public-publishing wrapper |
| `Scripts/start-valutio-wallet.ps1` | Windows local server launcher with no-cache responses |
| `PUBLISHING.md` | Release commands and folder workflow |
| `Rules/` | Contribution, security, trademark, and CLA policies |
| `Docs/Screenshots/demo/` | Stable README presentation screenshots |

Generated folders outside this source tree:

- `../Valutio-public/github` is the clean GitHub-ready source export.
- `../valutio-deploy` is the Netlify deploy root; its `app/` folder is the built application.

Never make durable edits in generated folders. The next publish/build overwrites them. The separate marketing website is not part of this open-source app architecture.

## 4. Runtime Architecture

Valutio is framework-free plain HTML, CSS, and JavaScript. It has no runtime build step. `app.js` uses one private function scope.

Important runtime objects:

- `db`: synchronous in-memory wallet state.
- `state`: transient UI state such as route, selected month, tax year, and household view. It is not persisted wallet data.
- `defaultDB()`: canonical schema defaults.
- `migrate()`: upgrades and normalizes loaded data.
- `validateDb()`: repairs safe structural defects and reports unsafe financial defects.
- `save()`: serializes a point-in-time copy of `db` and persists it.
- `render()`: rebuilds the active page.

The app renders HTML strings and delegates actions through `data-act`. Follow the existing dispatcher and modal patterns. Do not add a second state framework for one feature.

### Boot sequence

1. Load IndexedDB.
2. Fall back to one-time localStorage migration if IndexedDB has no wallet.
3. Fall back to `defaultDB()` if neither store has valid data.
4. Run migration and validation.
5. Synchronize retirement inputs.
6. Request persistent browser storage where supported.
7. Set the viewing month and recompute the live snapshot.
8. Catch up automatic month snapshots.
9. Roll tax years when required.
10. Apply recurring cash-flow rows idempotently.
11. Show setup or render the app.
12. Schedule backups, reminders, rates, and service-worker behavior.

Do not render before asynchronous storage loading finishes. That can briefly show or save an empty wallet over real data.

## 5. Persistence, Recovery, and Migrations

- IndexedDB database: `valutio`
- Object store: `kv`
- Wallet key: `wallet_app_v1`
- Current schema: `3`
- localStorage uses the same key only for legacy migration or fallback.

`save()` captures `JSON.stringify(db)` synchronously, writes it to IndexedDB asynchronously, and falls back to localStorage if IndexedDB fails.

Unreadable persisted data is copied, when possible, to:

```text
wallet_app_v1_corrupt_<timestamp>
```

Preserve that quarantine behavior.

`migrate(d)` must be idempotent, additive, and deterministic. Migrations must preserve valid unknown fields, unused currencies, decimal strings, IDs, archived tax ownership, and retirement inputs. Add a marker under `meta.migrations`, validate afterward, and add regression fixtures for the prior schema.

Schema 3 adds optional dividend-reinvestment provenance and the snapshot contribution-cost split. Migration records `meta.migrations.v3`, leaves every pre-existing unlinked buy and dividend semantically unchanged, and treats a legacy snapshot without `contributionCost` as `cost` until that snapshot is intentionally rebuilt or edited.

The active tax record also carries managed-preset provenance. Migration may infer a missing `presetManaged` marker only when the saved threshold, brackets, levy label/rate, capital-gains rate/discount, and discount period exactly match a known preset variant. A customized record must remain customized; migration must never overwrite it merely because its country matches a built-in preset.

## 6. Canonical Wallet Schema

Root keys:

```text
version, setupComplete, meta, settings, currencies, accounts, holdings,
holdingTypes, physicalAssets, expenseCategories, incomeCategories, expenses,
incomes, goals, recurring, retirement, debts, snapshots, taxArchive, tax
```

### `meta`

Operational state includes:

- `lastBackup`, `backupSnooze`
- `customYears`, `customMonths`, `firstMonth`
- `lastNotifyMonth`
- `recurringApplied`
- `benchmarkHist`
- `migrations`
- `lastValidation`

### `settings`

Important fields:

- `name`, `icon`
- `baseCurrency`, `secondaryCurrency`
- `theme`: `dark`, `light`, or `dim`
- `language`: `en` or `it`
- `country`
- stock/crypto provider names and optional API keys
- `dashCards`, `invCards`: four KPI registry keys each
- `colors`: overrides by bucket, holding type, expense, income, asset, and debt
- `targetAlloc`
- optional `benchmark`, defaulting to `ACWI`
- notification and automatic-backup settings
- `statementCategorizer`: persisted matching rules and statement currency. Raw statement files and reviewed session rows are never persisted.

### `currencies`

```text
{ code, symbol, rate }
```

`rate` is base-currency units per one native-currency unit. The base currency must exist with rate 1. Codes are uppercase. Every referenced currency needs an entry.

### `accounts`

```text
{ id, name, bucket, balance, currency, joint?, share?, coOwner? }
```

`balance` is the full native statement balance. `share` is the user's ownership percentage, clamped to 0-100; missing means 100%. Default buckets are Cash, Savings, Pension, and Other.

### `holdings`

```text
{
  id, name, ticker, apiSymbol?, coingeckoId?, apiCurrency?,
  type, currency, price, transactions, dividends, realizedSeed?
}
```

`price` is current native market price. Transactions are authoritative for position/cost. `realizedSeed` preserves imported pre-ledger P/L. Zero-share holdings can remain for history.

Transaction:

```text
{
  id, type, shares, price, fees, date?, month, datePrecision, sequence, note?,
  origin?, linkId?
}
```

- Type is `buy` or `sell`.
- New UI records require `YYYY-MM-DD`.
- `month` is `YYYY-MM` and must agree with `date`.
- Legacy month-only records omit date and use month precision.
- `sequence` resolves same-day and legacy same-month order.
- Shares, price, and fees may be normalized decimal strings.
- `origin: "drp"` and `linkId` identify the acquisition half of a dividend-reinvestment pair. Other transactions omit both fields.

Dividend:

```text
{ id, date?, month, amount, note?, origin?, linkId? }
```

Its currency is the parent holding currency. New DRP dividends require an exact `date`; ordinary legacy dividends may remain month-only. `origin: "drp"` and the same `linkId` identify the income half of a dividend-reinvestment pair.

A DRP `linkId` is unique and must resolve, inside one holding, to exactly one positive buy and one positive dividend. Both rows require the same exact date and month. The buy has zero fees and its cost equals the linked dividend amount, subject only to preserved decimal representation and normal calculation precision.

### `physicalAssets`

```text
{ id, name, category, value, currency, includeInNetWorth, nwMode }
```

`equity` or missing counts `max(0, value - linked debt)`. `full` counts full value and subtracts linked debt separately.

### Cash-flow rows

```text
{
  id, month, category, amount, currency, note,
  joint?, share?, recurringId?, debtId?, auto?
}
```

Amounts are positive native magnitudes; the parent incomes/expenses array defines direction. Joint expense share is the user's percentage. Income currently does not use the joint-share lens.

### Goals

```text
{ id, name, cost, currency, targetMonth, currentSavings }
```

### Recurring

```text
{ id, kind, category, amount, currency, note, joint?, share?, since }
```

Kind is income or expense. Applying it creates a normal cash-flow row with `recurringId` and is idempotent per month.

### Retirement

```text
{ salary, employerExtra, voluntary }
```

Current pension/super balance is derived from matching accounts in the active region's native currency.

### Debts

```text
{
  id, name, type, balance, currency, apr, payment,
  propertyAssetId?, logMode, lastClose
}
```

`interest` logs interest as monthly expense. `full` logs actual payment, capped at balance plus interest in the final month. `lastClose` makes closure idempotent.

### Tax records

`tax` and every `taxArchive[]` record contain:

```text
{
  year, country, currency, taxFreeThreshold, brackets,
  levyRate, levyLabel, capitalGainsRate, capitalGainsDiscount,
  capitalGainsDiscountMonths, deductions, employmentIncome,
  employmentTaxPaid, otherIncome, capitalLossCarryIn,
  capitalLossCarryOut, sourceSnapshot, invoices, adjustments,
  presetManaged?, presetVersion?, paid?, paidAt?
}
```

`presetManaged: true` means the active record still follows Valutio's built-in planning preset. `presetVersion` identifies the country/year variant last applied. Saving annual user inputs such as employment income or tax paid does not clear a matching managed marker. Changing any preset-controlled threshold, bracket, levy, or capital-gains field sets `presetManaged` to false and removes `presetVersion`; explicitly choosing a country preset restores managed status. Archived records remain year-owned and are never automatically upgraded.

Bracket:

```text
{ upTo, rate }
```

`upTo` is an absolute income cap, not a band width. Final `upTo` is null. Rates are fractions.

Invoice:

```text
{ id, date, amount, currency, note, fxRate?, fxDate?, taxYear? }
```

Adjustment:

```text
{ id, name, type, mode, value }
```

Type is add/deduct. Mode follows existing fixed, percent-of-tax, or percent-of-income calculation options.

### Snapshots

Modern snapshots can include:

```text
{
  month, date, netWorth, gross, invest, cost, contributionCost,
  unrealized, realized,
  income, expenses, buckets, accounts, holdings, debts, debtsTotal,
  rates, physAssets, unmatched, unmatchedBase
}
```

Per-line native values and frozen rates are important. Holding lines also carry `contributionCost` when available. The frozen-holding editor exposes this value as External contribution cost so changing shares or average buy price cannot silently leave a stale performance input. Aggregate-only legacy snapshots remain supported and can be materialized into synthetic rows before an explicit frozen-row edit. A missing legacy `contributionCost` falls back to `cost`; migration must not retrospectively guess which historical buys were reinvestments.

## 7. Money, FX, and Ownership

Use shared helpers:

```text
toBase(amount, code)   = amount * currency.rate
fromBase(amount, code) = amount / currency.rate
convert(a, from, to)   = fromBase(toBase(a, from), to)
```

For past months, use `rateForMonth()`, `toBaseAtMonth()`, or `convertAtMonth()`. The last helper applies the same month's frozen source and target rates. Cash-flow totals and live tax derivations for historical interest, dividends, and realized gains must use the record month's frozen FX; never use current FX when a closed-month rate exists. Changing base currency must rebase the pool so the new base equals 1 while preserving cross-rates.

Do not round intermediate tax or investment calculations merely for display. Round at modeled posting boundaries, debt cent persistence, spreadsheet export, and formatting. Most arithmetic still uses JavaScript Number. Decimal strings protect JSON round trips and BigInt-backed decimal logic protects oversell validation, but not every calculation is arbitrary precision.

Accounts store full balances. My share multiplies joint records by share; Household multiplies by 1. Changing a live account share intentionally re-lenses matching historical account rows. `snapshotForView()` must project that ownership delta at render time across account rows, allocation buckets, gross assets, and net worth without mutating the frozen native balance, close-time ownership, FX, debt, or persisted aggregate.

Expense rows use the same view lens. Income does not currently apply a joint share. Changing that is a schema/product change.

## 8. Investments

### Canonical ordering

All consumers must use the shared sorter: month, exact date, sequence, then stable legacy ordering where needed. Never use raw array order for financial replay. Valutio-created ledgers are normally canonical already; the sorter checks that condition and skips the `O(n log n)` sort while still returning a copy. Imported or legacy out-of-order arrays take the deterministic sort path.

### Weighted-average cost

Buy:

```text
buy cost = shares * price + fees
new cost pool = prior cost pool + buy cost
average cost = new cost pool / shares held
```

Sell:

```text
proceeds = shares sold * price - fees
cost removed = shares sold * average cost before sale
realized P/L = proceeds - cost removed
remaining cost = prior cost pool - cost removed
```

A full close resets shares and cost so a later reopen starts a fresh average.

### Dividend reinvestment reconciliation

Reconcile Shares records broker-reported shares without overwriting the transaction ledger. The supported first version is full dividend reinvestment only:

1. Read the current Valutio share total and accept a greater broker total.
2. Derive `shares added = broker total - current total`; do not accept an arbitrary negative adjustment or direct total override.
3. Require the exact allocation date and the total dividend reinvested. A new dividend may be created, or an existing unlinked dividend may be selected so the income is not counted twice.
4. Derive `issue price = total dividend reinvested / shares added` and record a zero-fee buy.
5. Save the buy and dividend with `origin: "drp"` and one shared `linkId`.

Use this workflow only when the whole dividend bought the added shares. A statement with a cash remainder, brokerage fee, withholding, an extra cash contribution, or a taxable dividend different from the invested amount must be represented as a separate ordinary dividend and buy; do not approximate it as full DRP.

Create, edit, delete, and undo are atomic across both linked rows. Editing preserves the row IDs and `linkId`. Deleting from either the Transactions or Dividends view removes both rows, and undo restores both at their original positions. Validate the complete candidate ledger before committing; an invalid edit must leave the wallet unchanged.

The DRP buy increases the actual weighted-average tax cost pool and creates an exact-date acquisition lot. It does not increase `contributionCost`, which represents capital contributed from outside the holding for benchmark and time-weighted-return purposes. An ordinary sale reduces actual cost and contribution cost proportionally; a full close resets both.

### Holding period

Tax cost basis stays weighted average, but long/short eligibility attributes sold shares to acquisition lots in FIFO order. Exact dates use exact anniversary logic. For the Australian 12-month rule, the sale must be after the anniversary, not on it. Ambiguous month-only boundaries are unknown and treated conservatively.

Cost basis and holding-period attribution are separate algorithms.

### Prices and refresh

Current price is the saved live price. Previous price is prior-month data. Color reflects direction only. Fully sold holdings retain history but `holdingHasOpenPosition()` excludes them from refresh and provider failure counts.

### Returns

- Unrealized P/L: market value minus remaining cost basis.
- Realized P/L: ledger sale results plus legacy `realizedSeed`.
- Displayed all-time Return %: `(unrealized P/L + realized P/L) / remaining cost basis`. Live holding rows, frozen rows, portfolio totals, and the all-time KPI must use this same denominator. The separately labeled current-month return remains a period market-move measure.
- Annualized return: money-weighted XIRR over pooled buys, sells, dividends, and final market value.
- XIRR is unavailable under 90 days, without both cash-flow signs, or without a supported root.
- Time-weighted return chains period growth after removing changes in snapshot `contributionCost` and needs two valid periods. Full DRP pairs contribute zero, but sale withdrawals remain an approximation until snapshots store explicit period cash flows.

Month-only return flows use month-end, clamped to now for the open month. Historical flows use frozen monthly FX.

A full DRP contributes an equal negative buy flow and positive dividend flow on the same exact date, so it is not external cash in XIRR. Tax and market cost still use the acquisition price derived from the reinvested amount.

If the user accepts a holding-currency conversion, re-denominate the live price, legacy `realizedSeed`, transaction prices and fees, dividends, and every frozen holding's `buyPrice`, `fees`, `contributionCost`, `price`, and `realized` fields. Closed records use their month's frozen cross-rate and update their native currency/rate while preserving frozen base totals. A currency relabel without accepting conversion intentionally leaves numeric values unchanged.

### Benchmark

Default is `ACWI`; ticker is editable. The comparison invests changes in snapshot `contributionCost` at monthly benchmark closes, uses adjusted close where available, caches about ten years, needs two priced points, and uses latest close for Now. Investment snapshots and trend calculations use `contributionCost`, not tax `cost`, so a DRP does not appear as new cash supplied by the user. Sale withdrawals are only approximated by the proportional contribution-cost reduction; use XIRR when ledger-exact sale and dividend cash flows matter.

Benchmark/base-currency FX drift is deliberately not modeled. Stock splits, mergers, hard forks, wash sales, parcel elections, and other corporate actions are not automatic.

## 9. Net Worth, Assets, and Debts

Gross assets include owned-view accounts, holdings, and included physical assets. Headline net worth is gross assets minus effective debts. Allocation contains assets only.

Equity-mode asset:

```text
asset contribution = max(0, full value - sum of all linked debts)
```

Its linked debts are not subtracted again; only their combined underwater excess enters effective debt. Debt-page home equity is calculated once per linked property from the property value minus that same combined debt total, so first and second mortgages cannot duplicate or overstate the displayed equity.

Full-mode asset:

```text
asset contribution = full value
effective debt includes linked debt in full
```

Unlinked debts subtract in full.

Debt month close:

```text
interest = balance * (APR / 100) / 12
principal = payment - interest
new balance = max(0, balance - principal)
```

Payment below interest grows the balance. Interest mode logs only interest because principal converts cash to equity. Full mode logs actual payment and cannot over-log the final month. Closure runs before snapshot and deduplicates through `lastClose` and `debtId`.

## 10. Cash Flow and Recurring

`monthTotal()` filters exact month, converts to base, and applies joint share to expenses. Direction comes from the parent array, not a negative amount.

Recurring items create ordinary rows with `recurringId`; `meta.recurringApplied` and row checks keep application idempotent.

Cash-flow CSV/Excel import:

- accepts date/month, category, amount, currency, note, and joint share;
- supports row and categorized-summary layouts;
- splits Personal and Joint expense columns into separate rows;
- defaults a joint split to 50% without a valid share;
- preserves category, note, month, currency, and ownership;
- creates missing categories/currencies;
- skips duplicates by month, category, amount, currency, note, solo/joint, and share;
- previews before commit;
- appends only to the chosen ledger;
- never replaces accounts, investments, tax, snapshots, or the opposite ledger.

Templates in `Templates/` define supported interchange formats.

The Cash Flow Statement Categoriser:

- accepts PDF statements supported by the ING/Revolut parsers and generic CSV statements with date, description and debit/credit or amount columns;
- supports both ING's numeric-date transaction rows and interim statements using named dates with Deposit, Withdrawal and Balance columns;
- recognises common structured exports used by Australian, US, UK and multi-currency providers: signed Amount columns, separate Debit/Credit or Deposit/Withdrawal columns, headerless date/amount/description rows, and compact, ISO, month-first or day-first dates;
- detects comma, semicolon and tab delimiters and decodes UTF-8, UTF-16 and legacy Windows-1252 statement exports;
- falls back to a conservative PDF row parser for signed amounts and statement sections such as withdrawals, debits, deposits and credits; prefer CSV whenever a provider offers it because PDF text does not reliably preserve empty debit/credit columns;
- keeps uploaded files and parsed transactions in memory only for the active browser session;
- persists only keyword rules and statement currency;
- separates expenses/income and Personal/Joint rows, supports exclusions and reversals, and requires every `Needs review` row to be resolved before apply;
- labels the editable reversal terms as `Reversal keywords`; the persisted property remains `refundKeywords` for backup compatibility;
- supports manual multi-select moves, account/flow changes, delete, undo, filters and search; mixed expense/income selections cannot be moved into one category;
- exports Simple and Full Excel reports; reports are review formats, not full-fidelity backups;
- appends reviewed rows as individual Cash Flow transactions, preserving the statement description and Personal/Joint ownership;
- nets reversals against the nearest matching expense without combining unrelated purchases; a reversal larger than matching expenses returns to `Needs review` rather than being discarded;
- assigns filename-independent, occurrence-aware source keys so renamed and overlapping statements deduplicate while identical same-day lines within one statement remain separate;
- accepts the previous filename-based source key as a legacy alias so existing applied statements remain idempotent after migration;
- keeps a purchase source key stable when a later overlapping statement introduces a reversal; if the adjusted amount differs from an already-applied row, apply skips it and reports that manual Cash Flow review is required instead of duplicating or silently rewriting the ledger;
- keeps summary rows separated by native currency and reconciles against Cash Flow by exact month, flow, ownership, category and currency;
- applies joint expenses at the established 50% default share and records joint income provenance without changing income ownership calculations;
- stores a deterministic `statementSourceKey` on applied rows so applying the same reviewed session again is idempotent;
- appends only to Cash Flow, creates missing categories/currencies, and never replaces unrelated wallet data.

PDF.js 6.1.200 is pinned and cached locally. Do not replace it with a network-only parser.

## 11. Snapshots and History

The live month rebuilds from live accounts, holdings, debts, assets, prices, rates, and cash flow.

A closed month locks native records, positions, prices, base values, FX, debt totals, net worth, allocation, actual cost, contribution cost, and investment totals. General recalculation skips it. Adding or changing a current DRP must not rewrite a closed snapshot.

Intentional exceptions:

1. Past cash-flow edits update snapshot income/expense totals so History table and category views agree.
2. Explicit frozen-row account/holding edits retotal that month from stored per-line values without current-FX revaluation.
3. Live account ownership changes re-lens history through a non-mutating render-time projection.
4. Legacy snapshots lacking rates can receive one historical month-end FX backfill.

Automatic catch-up starts no earlier than `meta.firstMonth`, applies recurring rows, closes debts, writes each missing month, and stops at a 240-month guard. After a long closed period, balances/prices can only use values known when the app reopens; recurring and debt progression still advance month by month.

Closed snapshots without rates may fetch one month-end rate map from Frankfurter/ECB, stamp it, and remain frozen. Existing rates are never re-fetched.

`walletHasData()` is the shared eligibility check for automatic snapshots, scheduled backups, and overdue-backup warnings. It must recognize accounts, holdings, physical assets, debts, cash-flow rows, goals, recurring rules, existing snapshots, active or archived tax data, and non-zero retirement inputs. A wallet does not lose snapshot or backup protection merely because it has no account or holding.

## 12. Tax Engine

Every tax record owns its country. Derive fiscal boundaries from that record, never current settings.

- AU: 1 July to 30 June.
- NZ: 1 April to 31 March.
- GB: 6 April to 5 April.
- ZA: 1 March to leap-aware February end.
- Calendar regions: 1 January to 31 December.

Built-in planning presets are selected for the tax record's own year. Australia uses a 16% first taxable band for 2025/26, 15% for 2026/27, and 14% from 2027/28. Other countries continue to use their current undated table until a dated table is added. Automatic rollover upgrades only a managed active preset. Annual income, tax-paid, deduction, loss, or adjustment inputs do not customize the rate preset; changing a preset-controlled threshold, bracket, levy, or capital-gains field does and prevents later automatic replacement. A rollover archives the prior annual inputs, then starts the new active year with empty invoices and zero employment income, employment tax paid, other income, and deductions; capital-loss carry and reusable rate/adjustment configuration follow their documented rules.

Changing country aligns the active record to that country's current fiscal-year label without archiving or clearing annual user data. If that label already exists in `taxArchive`, block the country change instead of creating two records with the same year or applying a country to a mismatched label.

Tax Settings changes are atomic: build and validate a cloned candidate, including scalar fields, brackets, and adjustments, and copy it onto the record only after every check succeeds. An invalid submission must leave the live or archived record byte-for-byte unchanged.

`progressiveTax()` starts at threshold and applies each rate between the previous and absolute current cap. Validation requires 0-1 rates, increasing caps, and one final open-ended bracket.

Ordinary sources include employment, other income, freelance invoices, interest, dividends, and taxable realized gains. Deductions cannot make taxable income negative. Progressive tax plus levy receives configured fixed/percent adjustments. Estimated tax floors at zero.

Dividend tax-year selection prefers a valid exact dividend `date`. Month-only legacy dividends fall back to their stored `month`. A linked DRP dividend is ordinary dividend income exactly once; its paired buy must not create a second income source.

```text
balance to pay = estimated tax - employment tax paid
```

Freelance set-aside uses marginal rate plus levy as a planning reserve.

### Invoices

Invoices require exact valid dates and contribute only inside the record's fiscal window. Conversion order is matching currency, locked positive invoice `fxRate`, then live fallback only for legacy data without a lock.

When a country preset or manual Tax Settings change updates the active tax currency, retarget every dated invoice lock by composing its old invoice-to-tax rate with the old-tax-to-new-tax cross-rate. This preserves the locked economic conversion instead of reinterpreting the invoice at today's FX. If an archived invoice lacks its own modern lock, editing another invoice must retain that row's captured `sourceSnapshot.invoiceAmounts` value rather than rebuild it at live FX.

Migration moves an invoice to another known tax record when its date unambiguously belongs there. Otherwise it is flagged and excluded/warned, not silently taxed in the wrong year.

### Capital gains/losses

For each sale:

1. Calculate weighted-average gain/loss.
2. Attribute sold shares to lots for holding-period class.
3. Separate short, long, and unknown.
4. Add carry-in loss.
5. Offset short and unknown gains first.
6. Offset long gains next.
7. Apply discount only to remaining long gains.
8. Carry unused loss forward.

Capital losses never reduce ordinary income. `capitalGainsRate` is separate: it is the configurable reserve on unrealized gains.

### Archives

Archived `sourceSnapshot` locks interest, dividends, long/short/unknown gains and losses, converted invoices, and provenance. Later FX/ledger or DRP edits must not rewrite it. Legacy archives are reconstructed once with `legacy-reconstructed` provenance because deleted history cannot be recovered exactly.

Carry-out becomes the next chronological year's carry-in. Unpaid archived balances remain in dashboard tax totals until marked paid. Rendering/navigation must not alter paid state.

Tax presets are editable planning defaults, not filing-grade legal compliance.

## 13. Retirement

The retirement region follows `settings.country`, falling back to AU. Inputs are salary, extra employer contribution, voluntary contribution, and a balance derived from matching pension/super accounts in the region's native currency and owned share.

```text
mandatory employer = min(salary, contribution-base ceiling) * employer rate
concessional = mandatory employer + employer extra + voluntary
fund tax = min(concessional, cap) * contribution-tax rate
net annual contribution = concessional - fund tax
next balance = current balance * 1.07 + net annual contribution
```

Ten- and twenty-year projections use fixed nominal 7% annual return and year-end contributions. They do not model inflation, salary growth, fees, volatility, or legislative changes.

When changing country constants, update source comments, effective year, visible fiscal label, and tests/manual checks.

## 14. Live Providers

FX refresh updates the live currency pool. Closed months keep frozen rates.

Yahoo Finance is the keyless stock/ETF/bond/commodity default. Production uses the same-origin `/yq` Netlify proxy. Optional keyed providers remain local settings.

Yahoo can report native currency or minor units such as GBp/GBX, ZAc/ZAX, and ILA. Reconcile provider units and `apiCurrency` before saving a holding price. Reject unsafe conversions.

CoinGecko is default for crypto; Binance, CoinMarketCap, and CryptoCompare are supported. Prefer stored CoinGecko ID; ticker/name maps are fallbacks. Tickers are not globally unique.

Failures retain last saved price. Summaries distinguish successful/failed open holdings. Never clear prices because a provider is offline, limited, empty, or rejects one ticker.

Benchmark history also uses Yahoo `/yq`. Local proxy fallback may not preserve range parameters, so benchmark can be unavailable locally without breaking the app.

## 15. Import, Export, and Backup

`portableDb()` is a JSON clone of the complete database. Plain and encrypted JSON wrap the same payload.

Exact JSON round trip must preserve settings, every currency, ownership, ledgers, decimal strings, dividend dates, DRP `origin`/`linkId` pairs, realized seeds, assets, debts, goals, recurring, categories, retirement inputs, snapshots/rates including `contributionCost`, all tax records/source snapshots/invoice FX/paid state/carry, and idempotency metadata.

Adding a stored field requires default, migration, validation if financial, JSON round-trip coverage, an explicit Excel-parity decision, and a guide update.

Strict JSON restore:

- runs a non-mutating preflight on the untouched payload before migration can normalize legacy fields;
- rejects transaction types other than buy/sell, invalid months, malformed exact transaction/invoice dates, exact date/month disagreement, and exact trade dates in the future;
- rejects malformed or non-positive transaction shares/prices and malformed or negative fees;
- preserves valid legacy month-only trades and exact decimal strings;
- rejects missing currency references;
- runs migration and strict validation;
- blocks unsafe errors;
- replaces `db` only after success;
- never partially merges.

### Encrypted JSON

- PBKDF2-SHA-256
- 200,000 iterations stored in envelope
- 16-byte random salt
- AES-256-GCM
- 12-byte random IV
- Base64 salt, IV, ciphertext
- minimum UI password length 6
- no password recovery

Honor the envelope iteration count for compatibility. Browser storage itself is not encrypted by Valutio.

### Excel and CSV

Excel is human-readable and rounded for spreadsheet use, not exact backup. Sheets include Summary, Currencies, Accounts, Finance, Holdings, Dividends, Incomes, Expenses, Tax, Retirement, and History. Retirement export must include salary, employer extra, and voluntary contribution. DRP provenance columns may support review and migration, but the workbook is not a fidelity guarantee for linked records or decimal strings; recommend JSON before and after spreadsheet migration.

Full workbook import is a broad migration path after preview/validation. Its dry run executes under an unconditional rollback, clones the validated candidate for preview, and commits that candidate only after Apply. Cancelling, closing, or any parser/validation exception must leave the existing wallet unchanged. A linked DRP from Excel must either reconstruct one complete validated buy/dividend pair or be blocked in preview with guidance to use JSON. It must never silently import only one side, duplicate the dividend, or flatten the pair into an unlinked share correction. Cash-flow buttons use append-only import. Bare `$` formats derive AUD/USD from workbook context, not symbol alone.

SheetJS 0.20.3 and PDF.js 6.1.200 are vendored for offline use. Keep both licenses. SheetJS retains its CDN fallback; PDF statement parsing is local-only.

CSV uses a UTF-8 BOM and is report-oriented, not metadata-complete.

Folder backup writes only to the chosen directory after a successful folder operation. Without a folder/API, explicit backup uses browser download. Never perform both.

## 16. Validation Policy

Permissive load may repair missing arrays/defaults, missing/duplicate IDs, missing sequence, missing ledger arrays, clamped shares, safe legacy normalization, and missing currency records with a warning.

Strict import must block invalid transaction types/months/dates, exact date/month disagreement, exact future trade dates, non-positive or malformed shares/prices/cash flow/dividends/invoices, malformed or negative fees, negative current prices, oversells, duplicate/invalid currencies, bad FX, malformed brackets, out-of-year invoices, and missing required currencies. Oversell replay uses decimal strings and BigInt-backed exact addition; there is no sub-micro-share tolerance. Legacy month-only transactions remain valid.

Persisted financial validation also covers non-negative account balances and ownership shares, asset values, goal targets/savings, recurring amount/kind/start/share, debt balance/APR/payment, and tax thresholds, income, tax paid, deductions, carried losses, rates, discount months, bracket caps/rates, and adjustments. Apply the field's positive/non-negative rule explicitly rather than relying on HTML input constraints.

Strict validation must also block a DRP orphan, duplicate link, non-buy transaction half, missing or unequal exact dates/months, mismatched holding, non-positive linked values, non-zero fee, or acquisition cost that does not match the linked dividend.

Do not use `num()` as permission to silently turn malformed financial input into zero.

## 17. Localization

English strings in `app.js` are canonical. `app.i18n.js` translates rendered UI into Italian using exact static maps and capture patterns for values such as currency, month, year, count, rate, and amount.

For visible text:

1. Add clear canonical English.
2. Add exact Italian for static text.
3. Add a capture pattern for dynamic text.
4. Preserve variables semantically.
5. Test long symbols, amounts, names, and categories.
6. Test setup, every route, modal, empty state, toast, table, tooltip, and validation report.

A currency in a sentence is a variable, not a reason to leave the sentence English. Display translation must never mutate stored category names, keys, or routes.

## 18. Visual and Theme Rules

Use self-hosted Hanken Grotesk and Material Symbols Rounded. Use the icon helper. Do not add emoji.

Valutio accent is `#438cff`. Green means positive/income/success; red means negative/expense/tax/destructive; blue means navigation/focus/neutral primary/selection.

Red/green hover backgrounds belong only to semantic surfaces. Generic navigation, settings tabs, tables, and page actions stay neutral/blue.

- Light is the primary presentation.
- Dim is a carefully dimmed light theme, not an overlay.
- Dark is separate graphite.

Use shared tokens/classes before raw colors.

Tables must keep matching header/footer surfaces, normal body surfaces, consistent dark/high-contrast header text, aligned numeric columns, reserved actions, unbroken rounded wrappers, and no clipped right/bottom edges. Fixed-height tables scroll their body while keeping footer pinned.

Selects hide native duplicate arrows and show one app arrow. Menus remain themed/readable in all modes.

Every form control needs a programmatic accessible name. Prefer an explicit `for`/`id` association; the runtime label-association pass is a compatibility safety net for existing `.field > label` markup. Current route/section items expose `aria-current`, and segmented, language, theme, and chip controls expose `aria-pressed`. Keyboard focus must remain visible with a high-contrast focus ring, including hover-revealed row actions through `:focus-within`.

Standard, bare, and tutorial dialogs must have an accessible name, move focus to a useful initial control, trap Tab while open, close on Escape where safe, and return focus to the invoker. Destructive controls are semantic buttons. Material deletion (transactions, dividends, invoices, categories, holdings, accounts, goals, assets, debts, Cash Flow rows, recurring rules, and removable currencies) uses a danger-styled confirmation plus an accessible Undo action. Undo remains available until the user chooses Undo/Dismiss or another toast replaces it, restores the original collection position, and returns linked records such as a DRP pair together. Reset actions use danger styling. Respect `prefers-reduced-motion` by disabling nonessential shimmer and transitions, and keep text, controls, muted copy, semantic status text, and chart labels at WCAG AA contrast in all themes.

At 1024 CSS pixels and below, the application uses the responsive shell: a compact sticky summary header, horizontally scrollable utility and bottom route rails, single-column content where needed, and safe-area padding. Wide financial tables retain all columns inside their own horizontal scroll wrappers and must never widen or clip the document. Touch targets are at least 44px, and actions that are hover-revealed on desktop remain visible on coarse or non-hover pointers.

At narrow widths, text may wrap, ellipsize, or clip inside a deliberately constrained control, and dense tables/charts may scroll inside their own component; text must never overlap neighboring content or widen the document. Keep first/last chart labels inset from the plot edges so axis and period labels do not collide.

## 19. Privacy and Security

Wallet data is origin-sandboxed browser data but is readable by JavaScript on that origin.

- Avoid new third-party scripts.
- Keep SheetJS, fonts, and icons local.
- Escape user text with `esc()` before HTML insertion.
- Use `noopener` for external links.
- Never log wallet contents, API keys, backups, or decrypted payloads.
- Never commit provider keys in samples.
- Provider requests can disclose symbols/coin IDs/currencies, never balances, transactions, taxes, or notes.
- Service-worker caches contain assets, not wallet data.
- Preserve AGPL headers and third-party licenses.
- Deployed builds must include the root `LICENSE`, the font notices, and working Legal-panel links to the public source and license. Minification removes source comments, so headers alone are not sufficient for a distributed build.

Follow `Rules/SECURITY.md`; never request real backups in public issues.

## 20. Performance

Main risks are repeated transaction replay, nested snapshot scans, huge HTML tables, whole-wallet serialization on rapid input, unnecessary archive recalculation, main-thread spreadsheet parsing, and oversized charts.

The suite guards a 100,000-transaction metrics run. This is a warning threshold, not a universal device promise.

Canonical Valutio ledgers use an ordered-array fast path: verify adjacent canonical order and bypass sorting when already ordered. Keep the deterministic sort for imported or legacy arrays. `render()` may memoize sorted ledgers and current holding metrics only inside one synchronous render call, keyed by the holding object, and must discard every map in `finally`. Never reuse that cache in action, import, refresh, rebase, snapshot, or later-render calculations: holdings, nested rows, prices, realized seeds, currencies, and FX rates are intentionally mutated in place.

Optimize with explicit invalidation and result comparison. Never cache across ledger, FX, ownership, snapshot, or tax-source changes without invalidation. Prefer indexed maps over nested scans. Do not trade financial correctness for render speed.

## 21. Testing

Required checks:

```powershell
node --check .\app.js
node --check .\app.i18n.js
node --check .\statement-categorizer.js
node .\Scripts\test-financial-logic.mjs
node .\Scripts\test-statement-categorizer.mjs
$stressWallet = Join-Path $env:TEMP "valutio-stress-wallet.json"
node .\Scripts\generate-stress-wallet.mjs $stressWallet
node .\Scripts\validate-wallet-backup.mjs $stressWallet
```

Current financial coverage includes calendar validation, raw strict-import metadata/numeric checks, future trades, exact decimal oversells, invoice-date preflight, dollar-format context, fiscal boundaries, year-aware managed/custom tax presets, atomic Tax Settings and Excel rollback, same-day ordering, close/reopen basis, consistent all-time Return %, CGT anniversary, capital-loss isolation/order/five-year carry, frozen-month cash-flow/tax FX, out-of-year invoices, invoice-lock retargeting and archive preservation, full holding redenomination, non-mutating ownership projection, multi-mortgage equity, broad snapshot/backup eligibility, unused currency and 18-decimal preservation, retirement and statement-rule migration, statement apply idempotency, sold-out refresh exclusion, bracket validation, backup currency completeness, and a 100,000-transaction guard. DRP coverage must include v2-to-v3 migration, long-decimal JSON fidelity, pair validation, actual cost versus contribution cost, exact acquisition and tax dates, one dividend-income inclusion, equal-and-opposite XIRR flows, benchmark/TWR exclusion, ID/link preservation on edit, atomic delete/undo, no mutation after an invalid edit, frozen snapshot/archive stability, and safe Excel handling. The statement suite separately covers date/money parsing, debit/credit CSV direction, Personal/Joint ownership, exclusions, reversals, overlaps, encodings, keyword categories and per-transaction apply rows.

Manual matrix:

- setup in English/Italian;
- light/dim/dark;
- every route;
- current/frozen/custom/empty months;
- My share/Household;
- base/secondary currency change;
- CRUD for every entity;
- buy/sell/dividend/price/full close/reopen;
- DRP reconcile/create/edit/delete/undo, existing-dividend linking, validation errors, closed months, and full/partial-reinvestment guidance;
- provider success/partial failure/offline;
- active/archive tax, invoice CRUD, settings, paid state, rollover;
- retirement region/account binding;
- JSON and encrypted round trips;
- CSV/Excel imports including Personal/Joint;
- statement PDF/CSV import, rules, manual review, both Excel reports and repeat apply;
- full Excel preview/export;
- backup folder/download;
- reset/setup restart;
- update prompt/offline reload;
- narrow/wide tables and rightmost actions/footers;
- 320px mobile pages and dialogs with long English/Italian text, internal table scrolling, clipped/ellipsized content without overlap, and inset chart-edge labels;
- keyboard-only navigation, visible focus, dialog focus trap/return/Escape, selected-state announcements, destructive confirmation/Undo integrity, and reduced-motion mode.

Use synthetic data only.

## 22. Safe Change Playbooks

### Stored field

Default, migrate, validate, wire UI, test JSON/encryption, decide Excel parity, add tests, update guide.

### Investment math

Test buys, partial sell, fees, full close, reopen, same-day order, month-only legacy, decimal strings, oversell, and sold-out history. For DRP, test one atomic pair, actual versus contribution cost, exact date, dividend tax, returns, benchmark, edit/delete/undo, malformed restore, frozen state, JSON fidelity, and Excel safety. Confirm detail, totals, snapshots, tax, returns, and exports use the same ledger.

### Tax math

Test fiscal boundaries, year-aware managed presets versus manually customized records, atomic settings rejection, records with different countries, locked invoice FX and currency retargeting, gains/losses/unknown periods/discount order/carry, paid state, and source capture. Never mutate archives during render.

### FX

Test rate convention, rebase, cross-rates, current/frozen months, historical cash-flow and tax sources, invoice lock retargeting, full live/frozen holding redenomination, provider currency/minor units, and missing-currency import rejection.

### Snapshot

Test live rebuild, closed lock, past cash-flow edit, explicit frozen row edit, current price/FX change, non-mutating ownership projection in My share and Household, non-account wallet eligibility, and multi-month recurring/debt catch-up.

### Visible text

Add canonical English plus exact/pattern Italian. Test fixed-height setup, all themes, narrow width, accessible labels/focus/dialog behavior, reduced motion, and empty/error/success states.

### Table

Align one shared header/body/footer grid, reserve actions, test zero/one/many/overflow rows, scrollbar, and outer edges in all themes.

## 23. Release Workflow

Work only in `Valutio-source`.

One integer must match:

```text
sw.js CACHE = "valutio-vNNN"
sw.js asset query strings = ?v=NNN
index.html app.css/app.i18n.js/app.js query strings = ?v=NNN
```

The version when this guide was written is 482. Increment it for the next app release.

Normal release:

```powershell
node --check .\app.js
node --check .\app.i18n.js
node --check .\statement-categorizer.js
node .\Scripts\test-financial-logic.mjs
node .\Scripts\test-statement-categorizer.mjs
$stressWallet = Join-Path $env:TEMP "valutio-stress-wallet.json"
node .\Scripts\generate-stress-wallet.mjs $stressWallet
node .\Scripts\validate-wallet-backup.mjs $stressWallet
powershell -NoProfile -ExecutionPolicy Bypass -File .\publish-public.ps1
```

`publish-public.ps1` builds deploy unless `--skip-build`, mirrors the private website demo assets into `..\valutio-deploy\assets\demo`, empties the generated GitHub folder except `.git`, copies clean source, excludes private backups/env/logs/caches/local notes, and does not commit or push.

Then:

```powershell
Set-Location ..\Valutio-public\github
git status
git diff
git add .
git commit -m "Describe the update"
git push
```

Deploy `../valutio-deploy` to Netlify after review. The root needs proxy routing copied from `Deploy/`.

Documentation-only sync:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\publish-public.ps1 --skip-build
```

Build dependencies:

```powershell
py -m pip install rjsmin rcssmin
```

Never build from or hand-edit a generated folder.

## 24. Known Limitations

- Browser storage is local but not Valutio-encrypted.
- Encrypted backups have no password recovery.
- Most arithmetic uses JavaScript Number.
- Weighted average is not every jurisdiction's allowed tax method.
- Reconcile Shares models full dividend reinvestment only. Cash remainders, fees, withholding, extra contributions, and differing taxable/reinvested amounts require separate ordinary dividend and buy records.
- Wash sales, splits, mergers, hard forks, return of capital, and corporate actions are not automated.
- Tax presets are estimates, not complete returns.
- Retirement assumptions are fixed and region constants are dated.
- Benchmark ignores benchmark/base FX drift.
- Benchmark and time-weighted return approximate sale withdrawals from contribution-cost changes rather than exact sale proceeds; XIRR uses the exact ledger cash flows.
- Month-only trades cannot prove exact anniversaries.
- Closed-browser catch-up cannot reconstruct unknown historical balances/prices.
- Providers can be delayed, limited, wrong, or unavailable.
- Spreadsheet exports are not exact backups.
- No multi-device/profile synchronization or concurrent-edit reconciliation.

Do not hide limitations through copy changes.

## 25. Definition of Done

A change is complete when:

- It is made in source, not generated output.
- Existing data migrates without valid-data loss.
- Financial invariants remain true.
- Changed math has deterministic tests.
- JSON round-trip impact is considered.
- English/Italian and all themes are checked.
- Empty, normal, overflow, frozen, and error states are checked.
- Offline/provider failure is considered.
- Cache versions are bumped for app releases.
- Public/deploy outputs are rebuilt.
- Documentation matches shipped behavior.

When uncertain, make the financial rule explicit in a test before changing implementation.
