// App shell: tab routing, the sync pill, the Settings sheet.
//
// View contract (js/views/*.js default export):
//   { title, mount(root, app), show(params), refresh() }
//   mount   — called once, the first time the tab is opened; build DOM in `root`
//   show    — called each time the tab is opened (params from app.navigate)
//   refresh — data changed (entries / setup / sync) while the tab is visible,
//             or the tab is being re-shown after a change
// app = { navigate(tab, params), syncNow() }

import { toast } from './util.js';
import { onChange, pendingCount, getKV } from './store.js';
import { syncNow, getConfig, setConfig, isConfigured } from './sync.js';
import addView from './views/add.js';
import historyView from './views/history.js';
import dashboardView from './views/dashboard.js';
import setupView from './views/setup.js';

const VIEWS = { add: addView, history: historyView, dashboard: dashboardView, setup: setupView };
const mounted = new Set();
const stale = new Set();
let current = null;

const app = { navigate, syncNow: runSync };

function navigate(tab, params = {}) {
  const view = VIEWS[tab];
  if (!view) return;
  const root = document.getElementById('view-' + tab);
  if (!mounted.has(tab)) { view.mount(root, app); mounted.add(tab); stale.delete(tab); }
  for (const t of Object.keys(VIEWS)) {
    document.getElementById('view-' + t).classList.toggle('active', t === tab);
    document.querySelector(`.tabbar [data-tab="${t}"]`).setAttribute('aria-selected', String(t === tab));
  }
  document.getElementById('viewTitle').textContent = view.title;
  current = tab;
  if (stale.delete(tab)) view.refresh?.();
  view.show?.(params);
  window.scrollTo(0, 0);
  try { sessionStorage.setItem('etk.tab', tab); } catch {}
}

onChange(() => {
  for (const t of mounted) {
    if (t === current) VIEWS[t].refresh?.();
    else stale.add(t);
  }
  updateSyncPill();
});

// -------------------------------------------------------------------- sync

const pill = document.getElementById('syncPill');
let busy = false;

async function updateSyncPill() {
  const n = await pendingCount();
  pill.classList.toggle('pending', n > 0);
  pill.classList.toggle('busy', busy);
  document.getElementById('syncLabel').textContent = busy ? 'Syncing…' : n > 0 ? `Sync · ${n}` : (isConfigured() ? 'Synced' : 'Offline only');
}

async function runSync() {
  if (!isConfigured()) { toast('Connect your Google Sheet first.'); openSettings(); return; }
  if (busy) return;
  busy = true; updateSyncPill();
  try {
    const r = await syncNow();
    toast(r.failed ? `Synced, but ${r.failed} item(s) were rejected — see History.` : r.pushed ? `Synced ${r.pushed} change(s).` : 'Up to date with the sheet.');
  } catch (err) {
    toast(err.message);
  } finally {
    busy = false; updateSyncPill();
  }
}

pill.addEventListener('click', runSync);

// ---------------------------------------------------------------- settings

const sheet = document.getElementById('settingsSheet');

async function openSettings() {
  const cfg = getConfig();
  document.getElementById('webAppUrl').value = cfg.webAppUrl;
  document.getElementById('secret').value = cfg.secret;
  const last = await getKV('lastSync');
  document.getElementById('lastSyncInfo').textContent = last ? 'Last synced ' + new Date(last).toLocaleString('en-IN') : 'Never synced from this phone.';
  sheet.classList.add('open');
}
const closeSettings = () => sheet.classList.remove('open');

document.getElementById('settingsBtn').addEventListener('click', openSettings);
sheet.addEventListener('click', (e) => { if (e.target === sheet || e.target.closest('[data-close]')) closeSettings(); });
document.getElementById('saveSettingsBtn').addEventListener('click', () => {
  const url = document.getElementById('webAppUrl').value.trim();
  const secret = document.getElementById('secret').value.trim();
  if (url && !/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) { toast('That doesn’t look like an Apps Script Web App URL.'); return; }
  setConfig(url, secret);
  closeSettings();
  if (url && secret) runSync();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSettings(); });

// -------------------------------------------------------------------- init

document.querySelectorAll('.tabbar [data-tab]').forEach((b) => b.addEventListener('click', () => navigate(b.dataset.tab)));

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

let startTab = location.hash.slice(1);
if (!VIEWS[startTab]) { try { startTab = sessionStorage.getItem('etk.tab'); } catch {} }
// dev-only demo data; never on a phone connected to the real sheet
if (/[?&]seed\b/.test(location.search) && !isConfigured()) await (await import('./dev-seed.js')).seedIfEmpty();
navigate(VIEWS[startTab] ? startTab : 'add');
updateSyncPill();
if (!isConfigured()) toast('Welcome! Tap ⚙ to connect your Google Sheet.');
