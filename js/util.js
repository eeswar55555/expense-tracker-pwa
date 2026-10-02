// Small shared helpers: dates (always 'YYYY-MM-DD' strings internally, shown as
// DD/MM/YYYY), Indian-format money, DOM bits. No dependencies.

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Today's calendar date in the phone's own timezone (not UTC — a raw
 *  toISOString() shows yesterday for part of the evening in IST). */
export function todayStr() {
  return dateToStr(new Date());
}

/** Local Date -> 'YYYY-MM-DD'. */
export function dateToStr(d) {
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' -> local-midnight Date (or null). */
export function strToDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return isNaN(d.getTime()) ? null : d;
}

export function addDays(s, n) {
  const d = strToDate(s);
  d.setDate(d.getDate() + n);
  return dateToStr(d);
}

/** 'YYYY-MM-DD' -> 'DD/MM/YYYY' (Indian format). */
export function fmtDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(s || '');
}

/** 'YYYY-MM-DD' -> 'Thu, 02 Oct' (list headers). */
export function fmtDateLong(s) {
  const d = strToDate(s);
  if (!d) return String(s || '');
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
  return `${wd}, ${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** 'YYYY-MM-DD' -> 'YYYY-MM'. */
export const monthKey = (s) => String(s).slice(0, 7);

/** 'YYYY-MM' -> 'Oct 2026'. */
export function fmtMonth(mk) {
  const [y, m] = mk.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

/** Shift a 'YYYY-MM' key by n months. */
export function shiftMonth(mk, n) {
  let [y, m] = mk.split('-').map(Number);
  m += n;
  while (m > 12) { m -= 12; y++; }
  while (m < 1) { m += 12; y--; }
  return `${y}-${String(m).padStart(2, '0')}`;
}

export const daysInMonth = (mk) => {
  const [y, m] = mk.split('-').map(Number);
  return new Date(y, m, 0).getDate();
};

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const inr0 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

/** ₹1,23,456.00 */
export const fmtMoney = (n) => inr.format(Number(n) || 0);
/** ₹1,23,456 (no paise — for dashboard tiles/axes). */
export const fmtMoney0 = (n) => inr0.format(Math.round(Number(n) || 0));

/** Compact ₹ for chart axes: ₹950, ₹12.5K, ₹1.2L, ₹3.4Cr. */
export function fmtMoneyShort(n) {
  const v = Math.abs(Number(n) || 0), s = n < 0 ? '−' : '';
  if (v >= 1e7) return `${s}₹${+(v / 1e7).toFixed(1)}Cr`;
  if (v >= 1e5) return `${s}₹${+(v / 1e5).toFixed(1)}L`;
  if (v >= 1e3) return `${s}₹${+(v / 1e3).toFixed(1)}K`;
  return `${s}₹${Math.round(v)}`;
}

/** Validate a user-typed amount. Returns a number rounded to paise, or null.
 *  Zero, negative, non-numeric and absurd values are all rejected. */
export function parseAmount(raw) {
  const s = String(raw ?? '').replace(/[,₹\s]/g, '');
  if (!/^\d*\.?\d+$/.test(s)) return null;
  const n = Math.round(parseFloat(s) * 100) / 100;
  if (!isFinite(n) || n <= 0 || n > 1e9) return null;
  return n;
}

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2));
export const shortId = () => Math.random().toString(36).slice(2, 10);

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Escape for safe innerHTML interpolation. Category names and descriptions are
 *  user text that also round-trips through the sheet — always escape them. */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer;
/** Bottom toast. Optional action: { label, onClick } (e.g. Undo). */
export function toast(msg, action) {
  const t = document.getElementById('toast');
  t.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = msg;
  t.appendChild(span);
  if (action) {
    const b = document.createElement('button');
    b.className = 'toast-action';
    b.textContent = action.label;
    b.addEventListener('click', () => { t.classList.remove('show'); action.onClick(); });
    t.appendChild(b);
  }
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), action ? 5000 : 2800);
}
