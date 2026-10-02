// ---------------------------------------------------------------------------
// Minimal local-first storage (no libraries) + manual sync to the Apps Script
// Web App endpoint added to Code.gs. Entries always save locally first;
// "Sync now" pushes anything not yet synced.
// ---------------------------------------------------------------------------

const DB_NAME = 'expense-tracker';
const DB_VERSION = 1;
const STORE = 'entries';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const dbPromise = openDB();

async function withStore(mode) {
  const db = await dbPromise;
  return db.transaction(STORE, mode).objectStore(STORE);
}

async function dbAdd(entry) {
  const store = await withStore('readwrite');
  return new Promise((resolve, reject) => {
    const req = store.add(entry);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function dbGetAll() {
  const store = await withStore('readonly');
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbUpdate(id, patch) {
  const store = await withStore('readwrite');
  return new Promise((resolve, reject) => {
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const entry = getReq.result;
      if (!entry) return resolve();
      Object.assign(entry, patch);
      const putReq = store.put(entry);
      putReq.onsuccess = () => resolve();
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

// ---------------------------------------------------------------------- cfg

const CFG = { url: 'etk.webAppUrl', secret: 'etk.secret', categories: 'etk.categories' };

function getConfig() {
  return {
    webAppUrl: localStorage.getItem(CFG.url) || '',
    secret: localStorage.getItem(CFG.secret) || '',
  };
}

function setConfig(webAppUrl, secret) {
  localStorage.setItem(CFG.url, webAppUrl);
  localStorage.setItem(CFG.secret, secret);
}

const DEFAULT_CATEGORIES = {
  Expense: ['Groceries', 'Transport', 'Dining', 'Utilities', 'Rent', 'Shopping', 'Health', 'Entertainment', 'Other'],
  Income: ['Salary', 'Other'],
};

function getCategories() {
  try {
    const raw = localStorage.getItem(CFG.categories);
    if (!raw) return DEFAULT_CATEGORIES;
    const parsed = JSON.parse(raw);
    if (!parsed.Expense || !parsed.Income) return DEFAULT_CATEGORIES;
    return parsed;
  } catch {
    return DEFAULT_CATEGORIES;
  }
}

// today's calendar date in the phone's own timezone, not UTC
function todayStr() {
  const d = new Date();
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function fmtMoney(n) {
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// --------------------------------------------------------------------- dom

const el = (id) => document.getElementById(id);
let currentType = 'Expense';
let toastTimer;

function toast(msg) {
  const t = el('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

function openSettings() {
  const cfg = getConfig();
  el('webAppUrl').value = cfg.webAppUrl;
  el('secret').value = cfg.secret;
  el('settingsModal').classList.add('open');
}

function populateCategoryOptions() {
  const sel = el('category');
  const cats = getCategories()[currentType] || [];
  sel.innerHTML = '';
  for (const c of cats) {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    sel.appendChild(opt);
  }
}

async function renderEntries() {
  const all = await dbGetAll();
  all.sort((a, b) => b.createdAt - a.createdAt);

  const list = el('entryList');
  list.innerHTML = '';
  el('emptyState').style.display = all.length ? 'none' : 'block';

  for (const e of all.slice(0, 50)) {
    const li = document.createElement('li');

    const main = document.createElement('div');
    main.className = 'entry-main';

    const cat = document.createElement('div');
    cat.className = 'cat';
    const dot = document.createElement('span');
    dot.className = 'status-dot ' + (e.synced ? 'synced' : 'pending');
    cat.appendChild(dot);
    cat.appendChild(document.createTextNode(e.category));

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = e.date + (e.description ? ' · ' + e.description : '');

    main.appendChild(cat);
    main.appendChild(meta);

    const amt = document.createElement('div');
    amt.className = 'entry-amt ' + (e.type === 'Income' ? 'income' : 'expense');
    amt.textContent = (e.type === 'Income' ? '+ ' : '− ') + fmtMoney(e.amount);

    li.appendChild(main);
    li.appendChild(amt);
    list.appendChild(li);
  }

  el('pendingCount').textContent = String(all.filter((e) => !e.synced).length);
}

// ------------------------------------------------------------------- sync

async function refreshCategories() {
  const cfg = getConfig();
  if (!cfg.webAppUrl || !cfg.secret) {
    toast('Add your Web App URL + secret in Settings first.');
    openSettings();
    return;
  }
  try {
    const url = cfg.webAppUrl + '?secret=' + encodeURIComponent(cfg.secret);
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    localStorage.setItem(CFG.categories, JSON.stringify(data));
    populateCategoryOptions();
    toast('Categories refreshed.');
  } catch (err) {
    toast('Could not refresh categories (offline?).');
  }
}

async function syncNow() {
  const cfg = getConfig();
  if (!cfg.webAppUrl || !cfg.secret) {
    toast('Add your Web App URL + secret in Settings first.');
    openSettings();
    return;
  }
  const all = await dbGetAll();
  const pending = all.filter((e) => !e.synced);
  if (!pending.length) {
    toast('Nothing to sync.');
    return;
  }

  const syncBtn = el('syncBtn');
  syncBtn.disabled = true;
  syncBtn.textContent = 'Syncing…';

  try {
    const payload = {
      secret: cfg.secret,
      entries: pending.map((e) => ({
        clientId: e.id,
        type: e.type,
        date: e.date,
        category: e.category,
        amount: e.amount,
        description: e.description,
      })),
    };

    // Content-Type text/plain keeps this a CORS "simple request" — Apps Script
    // Web Apps don't handle the OPTIONS preflight that application/json would
    // trigger. doPost still reads e.postData.contents and JSON.parses it.
    const res = await fetch(cfg.webAppUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const byId = new Map((data.results || []).map((r) => [r.clientId, r]));

    let okCount = 0;
    for (const e of pending) {
      const r = byId.get(e.id);
      if (r && (r.status === 'ok' || r.status === 'duplicate')) {
        await dbUpdate(e.id, { synced: true, syncedAt: Date.now() });
        okCount++;
      }
    }
    await renderEntries();
    toast(okCount === pending.length ? 'Synced ' + okCount + ' entr' + (okCount === 1 ? 'y' : 'ies') + '.' : 'Synced ' + okCount + ' of ' + pending.length + ' — rest will retry next time.');
  } catch (err) {
    toast('Sync failed (offline?) — will retry later.');
  } finally {
    syncBtn.disabled = false;
    syncBtn.textContent = 'Sync now';
  }
}

// ------------------------------------------------------------------- wire

document.querySelectorAll('.type-toggle button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.type-toggle button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentType = btn.dataset.type;
    populateCategoryOptions();
  });
});

el('saveBtn').addEventListener('click', async () => {
  const amountInput = el('amount');
  const amount = parseFloat(amountInput.value);
  if (!amount || amount <= 0) {
    toast('Enter an amount.');
    amountInput.focus();
    return;
  }
  const category = el('category').value;
  if (!category) {
    toast('Pick a category.');
    return;
  }
  const description = el('description').value.trim();
  const date = el('date').value || todayStr();

  await dbAdd({
    id: crypto.randomUUID(),
    type: currentType,
    date,
    category,
    amount,
    description,
    createdAt: Date.now(),
    synced: false,
  });

  amountInput.value = '';
  el('description').value = '';
  await renderEntries();
  toast('Saved locally.');
});

el('syncBtn').addEventListener('click', syncNow);
el('refreshCatBtn').addEventListener('click', refreshCategories);

el('settingsBtn').addEventListener('click', openSettings);
el('closeSettingsBtn').addEventListener('click', () => el('settingsModal').classList.remove('open'));
el('saveSettingsBtn').addEventListener('click', () => {
  setConfig(el('webAppUrl').value.trim(), el('secret').value.trim());
  el('settingsModal').classList.remove('open');
  toast('Settings saved.');
});

// -------------------------------------------------------------------- init

(async function init() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  el('date').value = todayStr();
  populateCategoryOptions();
  await renderEntries();

  if (!getConfig().webAppUrl) {
    toast('Welcome! Open Settings to connect your Google Sheet.');
  }
})();
