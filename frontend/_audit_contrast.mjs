// theDAW contrast audit — WCAG 2.1 text + control-border contrast across every
// theme x workspace tab.
//
// Headless Playwright (NEVER headed). Boots the running dev app once, then for
// each edit theme (lib/editThemes.ts) and each tab walks every visible text
// node's element, composites its computed `color` over the effective background
// (ancestor rgba backgrounds alpha-composited over the theme root, gradients
// averaged from their colour stops) and flags:
//   TEXT     < 4.5:1 for normal text, < 3:1 for large text (>= 24px, or >= 18.66px bold)
//   BORDER   an interactive control (button/input/select/textarea/[role=slider])
//            whose visible border AND fill are both < 3:1 against the surround
//   Text whose hit-test stack shows a canvas/video/img/svg between it and its
//   first opaque ancestor is reported separately as "over media" (not a failure
//   we can fix with tokens). Disabled controls are skipped (WCAG exempts them).
//
// Usage (from frontend/, dev servers already up on :5173 / :8600):
//   node _audit_contrast.mjs --out <dir> [--label before|after]
//   THEMES=midnight,porcelain TABS=make,settings SHOTS=0 node _audit_contrast.mjs
// Output: <out>/contrast-audit-<label>.md + .json, screenshots in <out>/contrast/.
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';

const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const APP = process.env.APP || 'http://localhost:5173';
const OUT = path.resolve(argOf('--out', './_audit-out'));
const LABEL = argOf('--label', 'run');
const SHOTS = process.env.SHOTS !== '0';
const THEMES = (process.env.THEMES || 'midnight,obsidian,graphite,silver-black,brushed-steel,titanium,porcelain,ash,paper,mint,lavender,peach,sky,aurora,sunset,deepsea').split(',');
// "settings" = MAKE tab with the Settings modal open (audit scoped to the modal).
const TABS = (process.env.TABS || 'make,edit,mix,dj,learn,settings').split(',');
// Screenshots: these tabs, for every theme.
const SHOT_TABS = (process.env.SHOT_TABS || 'make,settings').split(',');

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(path.join(OUT, 'contrast'), { recursive: true });

// ── in-page audit ────────────────────────────────────────────────────────────
function auditInPage({ scopeSel }) {
  const vw = window.innerWidth, vh = window.innerHeight;
  const scope = scopeSel ? document.querySelector(scopeSel) : null;
  const rootEl = scope || document.body;
  const csCache = new Map();
  const cs = (el) => { let v = csCache.get(el); if (!v) { v = getComputedStyle(el); csCache.set(el, v); } return v; };

  // ── colour maths ──
  const pct = (v) => (String(v).endsWith('%') ? parseFloat(v) / 100 : parseFloat(v));
  const parseColor = (s) => {
    if (!s) return null;
    s = s.trim();
    let m = s.match(/^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i);
    if (m) {
      let a = m[4] == null ? 1 : (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
      return [+m[1], +m[2], +m[3], a];
    }
    m = s.match(/^#([0-9a-f]{3,8})$/i);
    if (m) {
      let h = m[1];
      if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
      const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
      const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
      return [r, g, b, a];
    }
    if (s === 'transparent') return [0, 0, 0, 0];
    // color(srgb r g b / a) — Chromium emits this for some computed colours.
    m = s.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\)$/i);
    if (m) return [+m[1] * 255, +m[2] * 255, +m[3] * 255, m[4] == null ? 1 : pct(m[4])];
    // Tailwind v4's palette is oklch(); Chromium serialises computed colours as
    // oklch(L C H / a) or, with an opacity modifier, oklab(L a b / a).
    m = s.match(/^okl(ch|ab)\(\s*([\d.]+%?)\s+(-?[\d.]+%?)\s+(-?[\d.]+)(deg)?\s*(?:\/\s*([\d.]+%?))?\s*\)$/i);
    if (m) {
      const L = m[2].endsWith('%') ? parseFloat(m[2]) / 100 : parseFloat(m[2]);
      let a, b;
      if (m[1].toLowerCase() === 'ch') {
        const C = m[3].endsWith('%') ? parseFloat(m[3]) * 0.004 : parseFloat(m[3]);
        const H = parseFloat(m[4]) * Math.PI / 180;
        a = C * Math.cos(H); b = C * Math.sin(H);
      } else {
        a = m[3].endsWith('%') ? parseFloat(m[3]) * 0.004 : parseFloat(m[3]);
        b = parseFloat(m[4]);
      }
      const alpha = m[6] == null ? 1 : pct(m[6]);
      const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
      const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
      const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
      const l = l_ ** 3, mm = m_ ** 3, ss = s_ ** 3;
      const lin = [
        4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * ss,
        -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * ss,
        -0.0041960863 * l - 0.7034186147 * mm + 1.7076147010 * ss,
      ];
      const enc = (v) => { v = Math.min(1, Math.max(0, v)); return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055); };
      return [enc(lin[0]), enc(lin[1]), enc(lin[2]), alpha];
    }
    return null;
  };
  // Average of every colour literal in a gradient / image string (approximation).
  const gradientAvg = (img) => {
    const found = [];
    const re = /rgba?\([^)]*\)|#[0-9a-f]{3,8}\b/gi;
    let m;
    while ((m = re.exec(img))) { const c = parseColor(m[0]); if (c && c[3] > 0) found.push(c); }
    if (!found.length) return null;
    const n = found.length;
    const avg = [0, 0, 0, 0];
    for (const c of found) { avg[0] += c[0] / n; avg[1] += c[1] / n; avg[2] += c[2] / n; avg[3] += c[3] / n; }
    return avg;
  };
  const over = (fg, bg) => { // fg (with alpha) over opaque bg -> opaque
    const a = fg[3];
    return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1];
  };
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const ratio = (a, b) => { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
  const hex = (c) => '#' + [0, 1, 2].map((i) => Math.round(c[i]).toString(16).padStart(2, '0')).join('');

  // Body backdrop: the radial gradient / --bg — the final fallback.
  const bodyCs = cs(document.body);
  let bodyBg = parseColor(bodyCs.backgroundColor);
  if (bodyCs.backgroundImage && bodyCs.backgroundImage !== 'none') { const g = gradientAvg(bodyCs.backgroundImage); if (g) bodyBg = g; }
  if (!bodyBg || bodyBg[3] < 1) bodyBg = over(bodyBg || [0, 0, 0, 0], [7, 5, 10, 1]);

  // Effective background behind `el` (excluding el's own background when
  // includeSelf=false). Returns { color, approx, layers } where approx marks a
  // gradient/image approximation.
  const bgCache = new Map();
  const effectiveBg = (el, includeSelf) => {
    const key = includeSelf ? el : el.parentElement;
    if (!includeSelf && !el.parentElement) return { color: bodyBg, approx: false };
    const layers = [];
    let approx = false;
    let n = includeSelf ? el : el.parentElement;
    let opaque = null;
    while (n && n.nodeType === 1) {
      const s = cs(n);
      const bc = parseColor(s.backgroundColor);
      let img = null;
      if (s.backgroundImage && s.backgroundImage !== 'none') { img = gradientAvg(s.backgroundImage); if (img) approx = true; }
      // Layer order: image over colour.
      if (bc && bc[3] > 0) layers.push(bc);
      if (img && img[3] > 0) layers.push(img);
      const top = layers[layers.length - 1];
      if (top && top[3] >= 0.999) { opaque = true; break; }
      // Each layer's own opacity (group opacity) scales what we see of it, but the
      // parent chain below is unaffected; approximate by folding into the alpha.
      n = n.parentElement;
    }
    // composite from the bottom (last found) up
    let color = opaque ? null : bodyBg;
    for (let i = layers.length - 1; i >= 0; i--) {
      const L = layers[i];
      if (color == null) { color = [L[0], L[1], L[2], 1]; continue; }
      color = over(L, color);
    }
    if (!color) color = bodyBg;
    const res = { color, approx };
    bgCache.set(key, res);
    return res;
  };

  const cumOpacity = (el) => { let o = 1, n = el; while (n && n.nodeType === 1) { o *= parseFloat(cs(n).opacity || '1'); n = n.parentElement; } return o; };
  const isInvisible = (el) => {
    const s = cs(el);
    return s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) < 0.05;
  };
  const short = (s, n = 40) => { s = (s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '~' : s; };
  const colorClasses = (el) => {
    const c = typeof el.className === 'string' ? el.className : (el.getAttribute && el.getAttribute('class')) || '';
    return c.split(/\s+/).filter((k) => /^(text-|placeholder|border-|bg-|opacity-)/.test(k) && !/^(text-\[?\d|text-(xs|sm|base|lg|xl|\d)|text-(left|right|center|ellipsis)|text-(nowrap|wrap|balance|pretty)|border-(t|b|l|r|x|y|\d|solid|dashed|none|transparent)$|border$|border-(t|b|l|r|x|y)-\d|bg-(clip|linear|gradient|cover|center|no-repeat|contain|fixed))/.test(k));
  };
  // Nearest data-tour / aria-label / id anchor, for locating the offender.
  const anchor = (el) => {
    let n = el, d = 0;
    while (n && n.nodeType === 1 && d < 8) {
      const t = n.getAttribute && (n.getAttribute('data-tour') || n.getAttribute('aria-label') || n.getAttribute('title') || (n.id ? '#' + n.id : ''));
      if (t) return short(t, 36);
      n = n.parentElement; d++;
    }
    return '';
  };
  const region = (el, r) => {
    if (el.closest('[role="dialog"], [data-audit-scope]')) return 'modal';
    if (el.closest('header')) return 'header';
    if (el.closest('footer')) return 'footer';
    if (el.closest('aside')) return 'rail';
    // The bottom dock strip (28px) sits directly above the 56px footer.
    if (r.top >= vh - 56 - 30 && r.bottom <= vh - 56 + 2) return 'strip';
    return 'content';
  };
  const fontInfo = (s) => {
    const px = parseFloat(s.fontSize);
    const w = parseInt(s.fontWeight, 10) || (s.fontWeight === 'bold' ? 700 : 400);
    const large = px >= 24 || (px >= 18.66 && w >= 700);
    return { px, w, large };
  };
  const inMedia = (el, cx, cy) => {
    // Anything drawn between the text and its first opaque ancestor?
    const stack = document.elementsFromPoint(cx, cy);
    let started = false;
    for (const e of stack) {
      if (e === el || el.contains(e)) { started = true; continue; }
      if (!started) continue; // above us (overlay) — handled by the hit test below
      if (/^(CANVAS|VIDEO|IMG|SVG)$/.test(e.tagName) && !el.contains(e)) return e.tagName.toLowerCase();
      const s = cs(e);
      const bc = parseColor(s.backgroundColor);
      if ((bc && bc[3] >= 0.999) || (s.backgroundImage && s.backgroundImage !== 'none')) return null;
      if (e.contains(el)) { /* ancestor with transparent bg — keep walking */ }
    }
    return null;
  };

  const results = { text: [], border: [], media: [], counts: { textChecked: 0, textFail: 0, borderChecked: 0, borderFail: 0, overMedia: 0, covered: 0 }, skips: { walked: 0, dupEl: 0, invisible: 0, invisibleAnc: 0, disabled: 0, noRect: 0, offscreen: 0, noColor: 0, gradientText: 0 } };
  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const p = node.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      if (p.closest('script, style, noscript, canvas, iframe, svg, [data-boot-splash], [aria-hidden="true"], template')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const seenEl = new Set();
  let node;
  while ((node = walker.nextNode())) {
    const el = node.parentElement;
    results.skips.walked++;
    if (seenEl.has(el)) { results.skips.dupEl++; continue; }
    seenEl.add(el);
    if (isInvisible(el)) { results.skips.invisible++; continue; }
    let inv = false; for (let n = el.parentElement; n; n = n.parentElement) { if (n.nodeType !== 1) break; if (isInvisible(n)) { inv = true; break; } }
    if (inv) { results.skips.invisibleAnc++; continue; }
    const s = cs(el);
    // WCAG exempts inactive controls: skip text inside a disabled control too.
    if (el.closest(':disabled, [aria-disabled="true"], fieldset:disabled')) { results.skips.disabled++; continue; }
    const range = document.createRange(); range.selectNodeContents(node);
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
    if (!rects.length) { results.skips.noRect++; continue; }
    const r = rects[0];
    if (r.right < 0 || r.bottom < 0 || r.left > vw || r.top > vh) { results.skips.offscreen++; continue; }
    const cx = Math.min(vw - 1, Math.max(0, r.left + Math.min(r.width, 6) / 2));
    const cy = Math.min(vh - 1, Math.max(0, r.top + r.height / 2));
    // Hit test: something painting over the text means we cannot know its backdrop.
    const top = document.elementFromPoint(cx, cy);
    if (!top || !(top === el || el.contains(top) || top.contains(el))) { results.counts.covered++; continue; }
    if (scope && !scope.contains(top)) { results.counts.covered++; continue; }
    const fg0 = parseColor(s.color); if (!fg0) { results.skips.noColor++; continue; }
    if (s.webkitTextFillColor && s.webkitTextFillColor !== s.color) {
      const f2 = parseColor(s.webkitTextFillColor); if (f2 && f2[3] === 0) { results.skips.gradientText++; continue; } // gradient-clipped text: skip
    }
    const media = inMedia(el, cx, cy);
    const bgInfo = effectiveBg(el, true);
    const op = cumOpacity(el);
    const fg = over([fg0[0], fg0[1], fg0[2], fg0[3] * op], bgInfo.color);
    const rt = ratio(fg, bgInfo.color);
    const fi = fontInfo(s);
    const need = fi.large ? 3 : 4.5;
    const rec = {
      text: short(node.nodeValue), tag: el.tagName.toLowerCase(), classes: colorClasses(el).join(' '),
      fg: hex(fg), bg: hex(bgInfo.color), bgApprox: bgInfo.approx, ratio: +rt.toFixed(2), need, px: fi.px, weight: fi.w,
      opacity: +op.toFixed(2), region: region(el, r), anchor: anchor(el), y: Math.round(r.top),
    };
    if (media) { results.counts.overMedia++; if (rt < need) results.media.push({ ...rec, media }); continue; }
    results.counts.textChecked++;
    if (rt < need) { results.counts.textFail++; results.text.push(rec); }
  }

  // Placeholder text on empty inputs.
  for (const inp of rootEl.querySelectorAll('input[placeholder], textarea[placeholder]')) {
    if (inp.value || isInvisible(inp) || inp.closest(':disabled, [aria-disabled="true"], fieldset:disabled')) continue;
    const r = inp.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0 || r.bottom < 0 || r.top > vh) continue;
    const ps = getComputedStyle(inp, '::placeholder');
    const fg0 = parseColor(ps.color); if (!fg0) continue;
    const bgInfo = effectiveBg(inp, true);
    const op = cumOpacity(inp);
    const fg = over([fg0[0], fg0[1], fg0[2], fg0[3] * op], bgInfo.color);
    const rt = ratio(fg, bgInfo.color);
    results.counts.textChecked++;
    if (rt < 4.5) {
      results.counts.textFail++;
      results.text.push({ text: '(placeholder) ' + short(inp.placeholder), tag: inp.tagName.toLowerCase(), classes: colorClasses(inp).join(' '), fg: hex(fg), bg: hex(bgInfo.color), bgApprox: bgInfo.approx, ratio: +rt.toFixed(2), need: 4.5, px: parseFloat(ps.fontSize), weight: 400, opacity: +op.toFixed(2), region: region(inp, r), anchor: anchor(inp), y: Math.round(r.top) });
    }
  }

  // Interactive control borders.
  const CONTROLS = 'button, input, select, textarea, [role="slider"], [role="button"], [role="tab"], [role="switch"], [role="checkbox"]';
  for (const c of rootEl.querySelectorAll(CONTROLS)) {
    if (isInvisible(c) || c.matches(':disabled, [aria-disabled="true"]')) continue;
    const r = c.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0 || r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue;
    const s = cs(c);
    const bw = parseFloat(s.borderTopWidth) || 0;
    const bc = parseColor(s.borderTopColor);
    if (!(bw > 0 && s.borderTopStyle !== 'none' && bc && bc[3] > 0.02)) continue; // no visible border: not a boundary-identified control
    const top = document.elementFromPoint(Math.min(vw - 1, r.left + r.width / 2), Math.min(vh - 1, r.top + 1));
    if (!top || !(top === c || c.contains(top))) continue;
    const outside = effectiveBg(c, false).color;
    const op = cumOpacity(c);
    const border = over([bc[0], bc[1], bc[2], bc[3] * op], outside);
    const fillRaw = parseColor(s.backgroundColor) || [0, 0, 0, 0];
    const fill = over([fillRaw[0], fillRaw[1], fillRaw[2], fillRaw[3] * op], outside);
    const rb = ratio(border, outside), rf = ratio(fill, outside);
    results.counts.borderChecked++;
    if (rb < 3 && rf < 3) {
      results.counts.borderFail++;
      results.border.push({ text: short(c.getAttribute('aria-label') || c.getAttribute('title') || c.textContent || c.placeholder || c.tagName.toLowerCase(), 36), tag: c.tagName.toLowerCase(), classes: colorClasses(c).join(' '), border: hex(border), fill: hex(fill), bg: hex(outside), ratioBorder: +rb.toFixed(2), ratioFill: +rf.toFixed(2), region: region(c, r), anchor: anchor(c), y: Math.round(r.top) });
    }
  }
  return results;
}

// ── merge mode: MERGE=labelA,labelB node _audit_contrast.mjs --out <dir> --label <combined>
if (process.env.MERGE) {
  const byKey = new Map(); // later labels override the same theme|tab (partial re-runs)
  for (const l of process.env.MERGE.split(',')) for (const r of JSON.parse(fs.readFileSync(path.join(OUT, `contrast-audit-${l}.json`), 'utf8'))) byKey.set(r.theme + '|' + r.tab, r);
  writeReport([...byKey.values()]);
  process.exit(0);
}

// ── drive ────────────────────────────────────────────────────────────────────
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
await ctx.addInitScript(() => {
  const seed = (k, state) => { try { localStorage.setItem(k, JSON.stringify({ state, version: 0 })); } catch (e) {} };
  seed('thedaw-onboarding', { seen: true, neverShow: true });
  seed('thedaw-home-screen-v1', { showAtStartup: false });
});
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('  pageerror:', String(e.message || e).slice(0, 160)));
await page.goto(APP, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-boot-splash]', { state: 'attached', timeout: 15000 }).catch(() => {});
await page.waitForSelector('[data-boot-splash]', { state: 'detached', timeout: 240000 });
const settle = async (ms) => { await page.waitForTimeout(ms); await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {}); };
// Import the SAME module instance the app runs: after an HMR update Vite rewrites
// importers to `…?t=<stamp>`, and a bare `import('/src/state/x.ts')` would load a
// second copy whose zustand store the app never reads (the theme would silently
// not change). Resolve the URL the page actually fetched, then verify the theme
// really landed on the shell root.
const APP_IMPORT = `const __appImport = (p) => { const hit = performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes(p)).sort((a, b) => b.length - a.length)[0]; if (!hit) return import(p); const u = new URL(hit); return import(u.pathname + u.search); };`;
const { EDIT_THEMES: _THEMES, DEFAULT_ET_VARS: _DEF } = await import('./src/lib/editThemes.ts');
const expectedInk = (id) => ((_THEMES.find((t) => t.id === id) || { vars: {} }).vars['--et-ink'] || _DEF['--et-ink']).trim();
const setTheme = async (id) => {
  await page.evaluate(new Function('id', APP_IMPORT + " return __appImport('/src/state/editThemeStore.ts').then((m) => m.useEditThemeStore.getState().setTheme(id));"), id);
  await page.waitForTimeout(250);
  const got = await page.evaluate(() => getComputedStyle(document.querySelector('.edit-theme-scope')).getPropertyValue('--et-ink').trim());
  if (got !== expectedInk(id)) throw new Error(`theme ${id} did not apply: --et-ink is "${got}", expected "${expectedInk(id)}"`);
};
const setTab = (tab) => page.evaluate(new Function('tab', APP_IMPORT + " return __appImport('/src/state/appUiStore.ts').then((m) => m.useAppUiStore.getState().setCenterTab(tab));"), tab);
const openSettings = async () => {
  await page.evaluate(() => window.dispatchEvent(new Event('thedaw:open-settings')));
  await page.waitForSelector('[aria-label="Close settings"]', { timeout: 10000 }).catch(() => {});
  await settle(1200);
  return page.evaluate(() => { const b = document.querySelector('[aria-label="Close settings"]'); const root = b && b.closest('.fixed'); if (root) root.setAttribute('data-audit-scope', ''); return !!root; });
};
const closeSettings = async () => { await page.evaluate(() => { const b = document.querySelector('[aria-label="Close settings"]'); b && b.click(); }); await page.waitForTimeout(300); };
// Make sure the bottom dock strip + log are in their default (closed) state.
await page.evaluate(new Function(APP_IMPORT + " return __appImport('/src/state/bottomPanelStore.ts').then((m) => { const s = m.useBottomPanelStore.getState(); s.setOpen && s.setOpen(false); s.setLogOpen && s.setLogOpen(false); });"));

await settle(2500);
const results = [];
for (const theme of THEMES) {
  await setTheme(theme);
  await page.waitForTimeout(250);
  for (const tab of TABS) {
    const real = tab === 'settings' ? 'make' : tab;
    await setTab(real);
    await settle(tab === 'settings' ? 500 : 2200);
    let scopeSel = null;
    if (tab === 'settings') { const ok = await openSettings(); scopeSel = ok ? '[data-audit-scope]' : null; }
    const res = await page.evaluate(auditInPage, { scopeSel });
    const rec = { theme, tab, ...res };
    if (SHOTS && SHOT_TABS.includes(tab)) {
      const f = path.join(OUT, 'contrast', `${LABEL}_${theme}_${tab}.png`);
      await page.screenshot({ path: f }).catch(() => {});
      rec.shot = f;
    }
    results.push(rec);
    console.log(`  ${theme.padEnd(14)} ${tab.padEnd(9)} text ${String(res.counts.textFail).padStart(3)}/${String(res.counts.textChecked).padStart(4)}  border ${String(res.counts.borderFail).padStart(3)}/${String(res.counts.borderChecked).padStart(3)}  media ${res.counts.overMedia}  covered ${res.counts.covered}` + (process.env.DEBUG ? '  skips ' + JSON.stringify(res.skips) : ''));
    if (tab === 'settings') await closeSettings();
  }
}
await setTheme('obsidian');
await browser.close();

writeReport(results);

// ── report ───────────────────────────────────────────────────────────────────
function writeReport(results) {
fs.writeFileSync(path.join(OUT, `contrast-audit-${LABEL}.json`), JSON.stringify(results, null, 1));
const THEMES = [...new Set(results.map((r) => r.theme))];
const TABS = [...new Set(results.map((r) => r.tab))];
const lines = [];
lines.push(`# Contrast audit — ${LABEL} (${new Date().toISOString()})`, '');
lines.push(`App: ${APP}. Viewport 1600x900. Themes: ${THEMES.join(', ')}. Tabs: ${TABS.join(', ')} ("settings" = MAKE with the Settings modal open, audit scoped to the modal).`, '');
lines.push('Legend: text = visible text elements failing WCAG 2.1 AA (4.5:1 normal, 3:1 large); border = visibly-bordered interactive controls whose border AND fill are both < 3:1 vs the surround; media = text drawn over a canvas/video/image (backdrop unknown, listed separately, not counted as failures).', '');

lines.push('## Failures per theme x tab (text fails / text checked · border fails / border checked)', '');
lines.push('| theme | ' + TABS.join(' | ') + ' | TOTAL text | TOTAL border |', '|---|' + TABS.map(() => '---').join('|') + '|---|---|');
const perTheme = {};
for (const theme of THEMES) {
  const row = results.filter((r) => r.theme === theme);
  const cells = TABS.map((t) => { const r = row.find((x) => x.tab === t); return r ? `${r.counts.textFail}/${r.counts.textChecked} · ${r.counts.borderFail}/${r.counts.borderChecked}` : '-'; });
  const tt = row.reduce((a, r) => a + r.counts.textFail, 0), tb = row.reduce((a, r) => a + r.counts.borderFail, 0);
  perTheme[theme] = { text: tt, border: tb, checked: row.reduce((a, r) => a + r.counts.textChecked, 0) };
  lines.push(`| ${theme} | ${cells.join(' | ')} | ${tt} | ${tb} |`);
}
lines.push('');
lines.push('## Failures per region (all themes)', '');
const regAgg = {};
for (const r of results) for (const f of r.text) { regAgg[f.region] = (regAgg[f.region] || 0) + 1; }
lines.push('| region | text failures |', '|---|---|');
for (const [k, v] of Object.entries(regAgg).sort((a, b) => b[1] - a[1])) lines.push(`| ${k} | ${v} |`);
lines.push('');

lines.push('## Worst offender classes per theme (text)', '');
for (const theme of THEMES) {
  const agg = {};
  for (const r of results.filter((x) => x.theme === theme)) for (const f of r.text) {
    const key = f.classes || `(inherited ${f.fg})`;
    const a = (agg[key] = agg[key] || { n: 0, worst: 99, sample: f, tabs: new Set() });
    a.n++; a.tabs.add(r.tab); if (f.ratio < a.worst) { a.worst = f.ratio; a.sample = f; }
  }
  const top = Object.entries(agg).sort((a, b) => b[1].n - a[1].n).slice(0, 12);
  lines.push(`### ${theme} — ${perTheme[theme].text} text failures / ${perTheme[theme].checked} checked, ${perTheme[theme].border} border failures`, '');
  if (!top.length) { lines.push('_none_', ''); continue; }
  lines.push('| count | classes | worst | fg on bg | sample | region | tabs |', '|---|---|---|---|---|---|---|');
  for (const [k, a] of top) lines.push(`| ${a.n} | \`${k}\` | ${a.worst.toFixed(2)} (need ${a.sample.need}) | ${a.sample.fg} on ${a.sample.bg}${a.sample.bgApprox ? '~' : ''} | "${a.sample.text}" ${a.sample.px}px/${a.sample.weight} | ${a.sample.region} ${a.sample.anchor ? '(' + a.sample.anchor + ')' : ''} | ${[...a.tabs].join(',')} |`);
  lines.push('');
}

lines.push('## Border failures — offender classes (all themes)', '');
{
  const agg = {};
  for (const r of results) for (const f of r.border) { const key = f.classes || '(none)'; const a = (agg[key] = agg[key] || { n: 0, sample: f, themes: new Set() }); a.n++; a.themes.add(r.theme); if (f.ratioBorder < a.sample.ratioBorder) a.sample = f; }
  const top = Object.entries(agg).sort((a, b) => b[1].n - a[1].n).slice(0, 25);
  lines.push('| count | classes | border / fill vs bg | sample | themes |', '|---|---|---|---|---|');
  for (const [k, a] of top) lines.push(`| ${a.n} | \`${k}\` | ${a.sample.ratioBorder} / ${a.sample.ratioFill} (${a.sample.border} / ${a.sample.fill} on ${a.sample.bg}) | "${a.sample.text}" ${a.sample.region} | ${a.themes.size} |`);
  lines.push('');
}

lines.push('## Text over media (canvas / video / img) failing — informational', '');
{
  const agg = {};
  for (const r of results) for (const f of r.media) { const key = `${f.classes || '(inherited)'} over ${f.media}`; const a = (agg[key] = agg[key] || { n: 0, sample: f }); a.n++; }
  const top = Object.entries(agg).sort((a, b) => b[1].n - a[1].n).slice(0, 15);
  if (!top.length) lines.push('_none_');
  else { lines.push('| count | classes | sample |', '|---|---|---|'); for (const [k, a] of top) lines.push(`| ${a.n} | \`${k}\` | "${a.sample.text}" ${a.sample.region} ${a.sample.anchor} |`); }
  lines.push('');
}

lines.push('## Every remaining text failure (deduped by classes + text + region)', '');
{
  const seen = new Map();
  for (const r of results) for (const f of r.text) { const key = `${f.region}|${f.classes}|${f.text}`; const a = seen.get(key) || { n: 0, f, themes: new Set() }; a.n++; a.themes.add(r.theme); seen.set(key, a); }
  const list = [...seen.values()].sort((a, b) => b.n - a.n);
  lines.push(`${list.length} distinct.`, '');
  lines.push('| n | themes | region | classes | text | ratio | fg on bg |', '|---|---|---|---|---|---|---|');
  for (const a of list.slice(0, 400)) lines.push(`| ${a.n} | ${a.themes.size} | ${a.f.region} | \`${a.f.classes}\` | "${a.f.text}" ${a.f.px}px | ${a.f.ratio} | ${a.f.fg} on ${a.f.bg}${a.f.bgApprox ? '~' : ''} |`);
  lines.push('');
}

const shots = results.filter((r) => r.shot).map((r) => `- ${r.theme} / ${r.tab}: ${r.shot}`);
if (shots.length) lines.push('## Screenshots', '', ...shots, '');
fs.writeFileSync(path.join(OUT, `contrast-audit-${LABEL}.md`), lines.join('\n'));
console.log('wrote', path.join(OUT, `contrast-audit-${LABEL}.md`));
}
