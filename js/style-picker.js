// Settings > Appearance: one card per entry in STYLES (js/themes.js). Each card carries
// data-style="<id>", so its miniature of the app resolves THAT style's tokens — a new style
// needs no change here or in css/appearance.css. Tap applies instantly and is saved.

import { STYLES, currentStyle, applyStyle, loadAllStyleSheets } from './themes.js';
import { esc, toast } from './util.js';

const FX = { flat: 'Flat · fastest', frosted: 'Frosted bars' };

// A tiny phone: header, an entry card (toggle, field, chips, button), a list card, the tab bar.
// Built at real size and shrunk with `zoom`, so radii / borders / shadows scale with it.
const MINI = `<span class="mp" aria-hidden="true"><span class="mp-page"></span>
  <span class="mp-head"><span class="mp-title">Add</span><span class="mp-pill"></span></span>
  <span class="mp-body">
    <span class="mp-card">
      <span class="mp-seg"><span class="mp-seg-on"></span><span class="mp-seg-off"></span></span>
      <span class="mp-field"></span>
      <span class="mp-chips"><span class="mp-chip on"></span><span class="mp-chip"></span><span class="mp-chip"></span></span>
      <span class="mp-btn"></span>
    </span>
    <span class="mp-card">
      <span class="mp-ctitle"></span>
      <span class="mp-row"><span class="mp-label"></span><span class="mp-amt exp"></span></span>
      <span class="mp-row"><span class="mp-label short"></span><span class="mp-amt inc"></span></span>
      <span class="mp-row"><span class="mp-label"></span><span class="mp-amt exp"></span></span>
    </span>
  </span>
  <span class="mp-tabs"><span class="mp-tab on"></span><span class="mp-tab"></span><span class="mp-tab"></span><span class="mp-tab"></span></span>
</span>`;

let root = null;

export function mountStylePicker(el) {
  root = el;
  root.innerHTML = STYLES.map((s) => `
    <button type="button" class="style-card" role="radio" aria-checked="false" tabindex="-1"
            data-style="${esc(s.id)}" aria-label="${esc(`${s.label}. ${s.tagline} ${FX[s.fx] || ''}`)}">
      ${MINI}
      <span class="sc-meta">
        <span class="sc-name">${esc(s.label)}</span>
        <span class="sc-fx">${esc(FX[s.fx] || '')}</span>
        <span class="sc-tag">${esc(s.tagline)}</span>
      </span>
      <span class="sc-badge" aria-hidden="true">✓</span>
    </button>`).join('');

  root.addEventListener('click', (e) => {
    const card = e.target.closest('.style-card');
    if (card) choose(card.dataset.style);
  });
  root.addEventListener('keydown', (e) => {                     // radiogroup keys
    const cards = [...root.querySelectorAll('.style-card')];
    const i = cards.indexOf(e.target.closest('.style-card'));
    if (i < 0) return;
    const n = cards.length;
    const j = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: n - 1 }[e.key];
    if (j === undefined) return;
    e.preventDefault();
    cards[(j + n) % n].focus();
  });
  sync();
}

/** Called each time Settings opens: mark the current style, show it, load the previews. */
export function refreshStylePicker() {
  if (!root) return;
  sync();
  loadAllStyleSheets();
  const on = root.querySelector('.style-card[aria-checked="true"]');
  if (on) root.scrollLeft = Math.max(0, on.offsetLeft - (root.clientWidth - on.offsetWidth) / 2);
}

function sync() {
  const cur = currentStyle();
  let any = false;
  for (const c of root.querySelectorAll('.style-card')) {
    const on = c.dataset.style === cur;
    any = any || on;
    c.setAttribute('aria-checked', String(on));
    c.tabIndex = on ? 0 : -1;
  }
  if (!any && root.firstElementChild) root.firstElementChild.tabIndex = 0;
}

async function choose(id) {
  const s = STYLES.find((x) => x.id === id);
  if (!s || id === currentStyle()) return;
  const r = await applyStyle(id);
  if (r === 'superseded') return;                                // a later tap won
  sync();
  toast(r === 'applied' ? `Style: ${s.label}` : 'Couldn’t load that style — check your connection and try again.');
}
