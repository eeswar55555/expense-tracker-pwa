# Expense Tracker — phone app (PWA)

A dependency-free, installable, **offline-first** app for the **Personal Finance & Expense
Tracker** Google Sheet. The phone keeps a full copy of your ledger and Setup, so everything —
adding, editing, the dashboards — works with zero signal. One tap on the sync pill reconciles
the phone with the sheet in both directions, via the Web App in
[`../google-sheets-mcp/apps-script/Code.gs`](../google-sheets-mcp/apps-script/Code.gs).

Personal project, hosted on a personal GitHub Pages account — nothing GEP-related.

## Tabs

| Tab | What it does |
|---|---|
| **Add** | Expense / Income toggle, date (defaults to today, shown DD/MM/YYYY, tap for the calendar, Today/Yesterday chips), category dropdown from Setup, amount (zero, negative and garbage are rejected), optional description. Shows "N recurring due · Review", this month's spend vs budget, and your 5 most recent entries. |
| **History** | Every entry, by month or all time, filterable by type / category / text. Tap any entry — including ones typed on the PC — to **edit** any field or **delete** it (with Undo). Amber "Pending" = not synced yet; red = the sheet rejected it (with the reason). |
| **Dashboard** | Month or Year view: income / expenses / net / savings rate vs the previous period, **budget vs actual** per category (with pace for the current month), spending by group, **category breakdown**, income vs target, top expenses, a 12-month trend, **year-over-year** (monthly lines + YTD + per category), and a 6-month **multi-month comparison** table. Tap a category to jump to its entries. |
| **Setup** | Expense categories (group + monthly budget), income sources (monthly target), groups (read-only), and **recurring transactions**. Mirrors the sheet's Setup tab. Renaming a category renames it on every past entry too. |

## Recurring transactions

Add a rule in **Setup → Recurring** (type, category, amount, Monthly / Fortnightly / Weekly /
Quarterly / Yearly, day, start date, optional end date). When occurrences come due, the app
shows **"N due · Review"**: tick what to post, untick what to skip (skipped items are never
offered again). A start date in the past back-fills missed occurrences.

Optional: also let the sheet post them itself every morning (Apps Script → Triggers → add
`postRecurring`, time-driven, day timer). Both paths give each occurrence the same id
(`rec-<rule>-<date>`), so an item can never be posted twice.

## Sync — what wins

- Tap the pill in the header (it shows how many changes are waiting). Safe to tap any time,
  repeatedly, or mid-way through a bad connection.
- The **sheet is the source of truth**: after pushing your changes, the phone's copy is
  replaced with what the sheet holds — so edits made on the PC show up on the phone.
- An entry edited on both sides before syncing: the phone's version wins (last write).
- Setup is merged, not overwritten: a category or rule added on the sheet since your last
  sync is kept; one you deleted on the phone is removed.

## One-time setup

1. **Backend** — paste the latest `Code.gs` into the sheet's Apps Script editor and re-deploy
   (see [`../google-sheets-mcp/apps-script/README.md`](../google-sheets-mcp/apps-script/README.md) §4).
   Use **Manage deployments → Edit → New version** so the Web App URL stays the same.
2. **Host** — this folder is the GitHub Pages site: `https://eeswar55555.github.io/expense-tracker-pwa/`.
3. **Phone** — open that URL in Chrome → ⚙ → paste the Web App URL + secret → **Save & sync**.
   Then Chrome menu → *Add to Home screen*.

Updating from the first version: your existing entries and settings carry over automatically.
After an update is pushed, open the app once while online, then close and reopen it to pick up
the new version.

## Files

| Path | Purpose |
|---|---|
| `index.html`, `styles.css` | App shell, tab bar, Settings sheet, shared design tokens (light + dark) |
| `js/app.js` | Router, sync pill, Settings |
| `js/store.js` | IndexedDB store (entries + Setup), change events, v1 → v2 migration |
| `js/sync.js` | Two-way sync with `Code.gs` (contract documented at the top) |
| `js/recurring.js` | Rule → due dates (mirrors `occurrences_()` in Code.gs) |
| `js/analytics.js`, `js/charts.js` | Dashboard aggregation (pure) and hand-written SVG charts |
| `js/util.js` | Dates (DD/MM/YYYY), ₹ formatting, amount validation, escaping |
| `js/views/*.js`, `css/*.css` | One module + stylesheet per tab; `entry-form.js` is the shared editor, `due.js` the recurring review |
| `js/dev-seed.js` | Dev only: `index.html?seed` fills an empty, unconnected app with demo data |
| `sw.js` | Offline app shell (network-first with cache fallback); never touches sync calls |

## Testing (on the PC)

```
python -m http.server 8765                                         # from pwa/
node ../tools/shot.mjs "http://localhost:8765/index.html?seed#dashboard" C:/tmp/d.png --full [--dark] [--offline]
cd ../google-sheets-mcp/apps-script/test && TZ=Asia/Kolkata node --test        # Code.gs unit tests
TZ=Asia/Kolkata node e2e-server.cjs                                # fake Web App on :8766 running the real Code.gs
node ../tools/shot.mjs "http://localhost:8765/index.html#history" C:/tmp/e.png --eval "$(cat ../tools/e2e-sync.js)"
```
