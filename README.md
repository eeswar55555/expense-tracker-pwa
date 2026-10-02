# Expense Tracker — phone quick-entry PWA

A small, dependency-free installable web app for logging expenses/income on Android, offline
first. Entries save to the phone (IndexedDB) the instant you hit Save, online or not. Tapping
**Sync now** pushes anything not yet synced to the **Personal Finance & Expense Tracker** Google
Sheet, via the `doGet`/`doPost` endpoint added to `../google-sheets-mcp/apps-script/Code.gs`.

Nothing here is GEP-related — this is a personal, static site meant to be hosted on your own
GitHub Pages, under your personal GitHub account.

## One-time setup

1. **Deploy the backend** — follow [`../google-sheets-mcp/apps-script/README.md`](../google-sheets-mcp/apps-script/README.md#4-phone-quick-entry-api-for-the-pwa-app)
   section 4. You'll end up with a Web App URL and a secret.
2. **Host this folder** — push this `pwa/` folder to a public GitHub repo on your personal
   account and turn on GitHub Pages (Settings → Pages → Deploy from branch → `main` / root).
3. **Open the Pages URL on your phone** in Chrome, tap the gear icon (Settings), paste in the
   Web App URL and secret from step 1, Save.
4. **Install it** — Chrome menu → *Add to Home screen* (or Chrome will offer *Install app*
   automatically once it detects the manifest + service worker). It now opens full-screen like
   any other app.

## Day to day

- Open the app, pick Expense/Income, category, amount, optional note, Save. That's it — saved
  locally immediately, works with zero signal.
- Whenever you have a connection, tap **Sync now**. Safe to tap repeatedly or after a dropped
  connection — already-synced rows are never duplicated (each entry carries a unique id that
  the sheet checks before appending).
- **Refresh categories** re-reads the category dropdown from the sheet itself (so if you add a
  new category in Setup/the sheet's data validation, tap this once to pull it down).
- Entries are view-only after they sync — make corrections directly in the sheet, same as
  before. The phone app is for fast capture, not editing.

## Files

| File | Purpose |
|---|---|
| `index.html` | App shell / markup |
| `app.js` | IndexedDB storage, sync logic, all UI wiring — no external libraries |
| `sw.js` | Service worker: caches the app shell for offline load; never caches sync/category calls |
| `manifest.json` | Install metadata (name, icons, standalone display) |
| `styles.css` | Mobile-first styling |
| `icons/` | App icons (192px, 512px) |
