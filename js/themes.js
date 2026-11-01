// Appearance styles — the ONLY place a style is registered in JS.
//
// To add a style:
//   1. add { id, label, tagline, fx } to STYLES below (picker order = array order);
//   2. create themes/<id>.css — a `[data-style="<id>"] { --token: value; }` block (copy the
//      closest style; the token contract is at the top of styles.css);
//   3. add './themes/<id>.css' to SHELL in sw.js and bump CACHE.
// The Settings picker (js/style-picker.js), its live preview, persistence and the status-bar
// colour all follow from this list. test/themes.test.cjs fails if any of the three steps is
// missing or a theme sets a token the contract does not have.
//
// fx: 'flat'    — no blur anywhere: the fastest, best for older phones;
//     'frosted' — the header and tab bar blur what scrolls under them (the only blur allowed).
//
// Startup: an inline script in index.html sets <html data-style> and links only the chosen
// style's CSS (render-blocking, so there is no flash). The other styles load only when the
// picker is shown, for its previews.

export const STYLES = Object.freeze([
  { id: 'classic',   label: 'Classic',   fx: 'flat',    builtIn: true,
    tagline: 'The original cream and ink. Follows your phone’s light / dark mode.' },
  { id: 'porcelain', label: 'Porcelain', fx: 'frosted',
    tagline: 'Soft white, frosted bars, serif titles. Calm Apple-style minimalism.' },
  { id: 'paper',     label: 'Paper',     fx: 'flat',
    tagline: 'Ink on paper: flat, high-contrast, sharp corners, serif title.' },
  { id: 'sage',      label: 'Sage',      fx: 'flat',
    tagline: 'Fresh white with calm forest-green accents.' },
  { id: 'midnight',  label: 'Midnight',  fx: 'flat',
    tagline: 'True black for OLED screens. Easy on the eyes and the battery.' },
  { id: 'bento',     label: 'Bento',     fx: 'frosted',
    tagline: 'Cream tiles on warm oat with a clay accent. Notion meets Apple Notes.' },
  { id: 'lumen',     label: 'Lumen',     fx: 'frosted',
    tagline: 'Pearl and graphite under a soft blue-violet glow, floating tab bar.' },
  { id: 'glass',     label: 'Glass',     fx: 'frosted',
    tagline: 'Frosted liquid glass over ambient violet light.' },
  { id: 'aurora',    label: 'Aurora',    fx: 'frosted',
    tagline: 'Matte black with electric blue, violet and cyan light.' },
  { id: 'gilded',    label: 'Gilded',    fx: 'frosted',
    tagline: 'Executive black, platinum and gold. Swiss precision.' },
  { id: 'teams',     label: 'Teams',     fx: 'flat',
    tagline: 'The dark Teams look from QuickNotes. Charcoal with Teams purple.' },
]);

export const DEFAULT_STYLE = 'classic';
const KEY = 'etk.style';
const COLOR_KEY = 'etk.styleColor';
const LOAD_TIMEOUT_MS = 10000;

const byId = new Map(STYLES.map((s) => [s.id, s]));
export const getStyle = (id) => byId.get(id) || null;
export const currentStyle = () => document.documentElement.getAttribute('data-style') || DEFAULT_STYLE;

const linkId = (id) => 'style-' + id;
const loads = new Map();   // id -> Promise<boolean> (dropped again on failure, so a retry re-fetches)

/** Make sure a style's stylesheet is in the page. Resolves true once its rules are usable,
 *  false if it could not be loaded (offline and never cached, or the file is missing). */
export function loadStyleSheet(id) {
  const s = byId.get(id);
  if (!s) return Promise.resolve(false);
  if (s.builtIn) return Promise.resolve(true);
  if (loads.has(id)) return loads.get(id);

  const p = new Promise((resolve) => {
    let link = document.getElementById(linkId(id));
    if (link && link.dataset.state === 'loaded') { resolve(true); return; }
    if (link && link.dataset.state === 'error') { link.remove(); link = null; }
    if (!link) {
      link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = `themes/${id}.css`;
      link.id = linkId(id);
      document.head.appendChild(link);       // last in <head>: after styles.css, as the cascade needs
    }
    const done = (ok) => {
      clearTimeout(timer);
      link.dataset.state = ok ? 'loaded' : 'error';
      if (!ok) { link.remove(); loads.delete(id); }
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), LOAD_TIMEOUT_MS);
    link.addEventListener('load', () => done(true), { once: true });
    link.addEventListener('error', () => done(false), { once: true });
  });
  loads.set(id, p);
  return p;
}

/** Load every style's CSS (for the picker's previews). Never blocks anything. */
export const loadAllStyleSheets = () => Promise.all(STYLES.map((s) => loadStyleSheet(s.id)));

let seq = 0;

/** Switch to a style. Its CSS is loaded first, so the switch is a single repaint.
 *  Resolves 'applied' | 'failed' (could not load; nothing changed) | 'superseded' (a newer
 *  choice was made while this one loaded) | 'unknown'. */
export async function applyStyle(id, { persist = true } = {}) {
  if (!byId.has(id)) return 'unknown';
  const mine = ++seq;
  const ok = await loadStyleSheet(id);
  if (mine !== seq) return 'superseded';
  if (!ok) return 'failed';
  document.documentElement.setAttribute('data-style', id);
  if (persist) { try { localStorage.setItem(KEY, id); } catch {} }
  syncThemeColor();
  return 'applied';
}

/** Point the phone's status bar at the style's --theme-color (and remember it for the next
 *  start, when the inline script in index.html sets it before anything else runs). */
export function syncThemeColor() {
  const c = getComputedStyle(document.documentElement).getPropertyValue('--theme-color').trim();
  if (!c) return;
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.setAttribute('content', c);
  try { localStorage.setItem(COLOR_KEY, c); } catch {}
}

/** Called once at startup, after the inline script in index.html has set data-style. */
export function initStyle() {
  const html = document.documentElement;
  const forced = new URLSearchParams(location.search).get('style');   // test hook: ?style=<id>, never saved
  if (forced && byId.has(forced)) {
    applyStyle(forced, { persist: false });
  } else {
    const id = html.getAttribute('data-style');
    if (!byId.has(id)) {
      // a style that no longer exists (or junk in storage): Classic, and forget it
      try { localStorage.removeItem(KEY); localStorage.removeItem(COLOR_KEY); } catch {}
      html.setAttribute('data-style', DEFAULT_STYLE);
      syncThemeColor();
    } else {
      // its CSS normally loaded before first paint; if it could not (offline and evicted),
      // show Classic for now but keep the choice, so the next start online restores it
      loadStyleSheet(id).then((ok) => {
        if (!ok && html.getAttribute('data-style') === id) html.setAttribute('data-style', DEFAULT_STYLE);
        syncThemeColor();
      });
    }
  }
  // Classic follows the phone's light/dark mode: keep the status bar in step with it
  try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncThemeColor); } catch {}
}
