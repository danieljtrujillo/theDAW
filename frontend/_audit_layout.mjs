// theDAW layout audit — overlap / visibility sweep across viewports and tabs.
//
// Headless Playwright (NEVER headed). Boots the running dev app once, then for
// every viewport x center tab x dock state walks each interactive element
// (button / input / select / textarea / a[href] / role=slider|button|tab|...) and
// flags:
//   COVERED  the topmost element at the centre of its visible box is neither
//            itself, a descendant, nor an ancestor (something paints over it)
//   HIDDEN   its rect is clipped to < 60% of its area by the viewport or by an
//            overflow-hidden/clip ancestor that actually clips it (absolute /
//            fixed containing-block rules respected)
//   OVERLAP  two in-flow siblings of a nowrap flex row whose rects intersect
//            (> 3px in both axes); counted separately when neither side holds
//            an interactive element ("decor")
//   HSCROLL  the document (or the .dense-layout root) is wider than the viewport
//   (elements scrolled out of an overflow auto/scroll ancestor's scrollport are
//   reachable and are counted as "scrollable", never as hidden/covered)
//
// Usage (from frontend/, dev servers already up on :5173 / :8600):
//   node _audit_layout.mjs --out <dir> [--label before|after]
//   VIEWPORTS=1366x768,1920x1080 TABS=make,edit STATES=closed,dock node _audit_layout.mjs
//   ZOOM=1 node _audit_layout.mjs ...    force the shell zoom to 1 (design-size probing)
//   EXTRAS= SHOTS=0                      skip the MAKE-tab extras / screenshots
// Output: <out>/layout-audit-<label>.md + .json, worst-case screenshots in
// <out>/layout/ (flagged elements outlined red = covered, orange = hidden,
// yellow = overlapping siblings).
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';

const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const APP = process.env.APP || 'http://localhost:5173';
const OUT = path.resolve(argOf('--out', './_audit-out'));
const LABEL = argOf('--label', 'run');
const SHOTS = process.env.SHOTS !== '0';
const FORCE_ZOOM = process.env.ZOOM ? parseFloat(process.env.ZOOM) : null;
const VIEWPORTS = (process.env.VIEWPORTS || '1280x720,1366x768,1440x900,1536x864,1600x900,1920x1080,2560x1080,2560x1440')
  .split(',').map((s) => { const [w, h] = s.split('x').map(Number); return { w, h }; });
const TABS = (process.env.TABS || 'make,edit,mix,session,dj,vj,sway,foundry,underfit,audimate,learn,tour').split(',');
// closed = dock collapsed; dock = bottom multi-tab panel open. Extra per-viewport
// probes on the MAKE tab: log (LOG overlay open), library (right rail open),
// settings (Settings modal, audit scoped to the modal itself).
const STATES = (process.env.STATES || 'closed,dock').split(',');
const EXTRAS = (process.env.EXTRAS ?? 'log,library,settings').split(',').filter(Boolean);

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(path.join(OUT, 'layout'), { recursive: true });

// ── in-page audit ────────────────────────────────────────────────────────────
function auditInPage({ scopeSel, limit }) {
  const vw = window.innerWidth, vh = window.innerHeight;
  const INTERACTIVE = 'button, input, select, textarea, a[href], [role="slider"], [role="button"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="switch"], [role="option"], summary';
  const scope = scopeSel ? document.querySelector(scopeSel) : null;
  const rootEl = scope || document;
  const all = Array.from(rootEl.querySelectorAll(INTERACTIVE));
  const csCache = new Map();
  const cs = (el) => { let v = csCache.get(el); if (!v) { v = getComputedStyle(el); csCache.set(el, v); } return v; };
  const rectCache = new Map();
  const rect = (el) => { let v = rectCache.get(el); if (!v) { v = el.getBoundingClientRect(); rectCache.set(el, v); } return v; };
  const short = (s, n = 34) => { s = (s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '~' : s; };
  const desc = (el) => {
    if (!el || el.nodeType !== 1) return String(el);
    const t = el.tagName.toLowerCase();
    const id = el.id ? '#' + el.id : '';
    const hook = el.getAttribute('data-tour') ? `[data-tour=${el.getAttribute('data-tour')}]` : (el.getAttribute('data-testid') ? `[data-testid=${el.getAttribute('data-testid')}]` : '');
    const role = el.getAttribute('role') ? `[role=${el.getAttribute('role')}]` : '';
    const label = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('name') || '';
    const txt = label ? `"${short(label)}"` : (t === 'input' || t === 'select' || t === 'textarea' ? '' : (el.textContent ? `"${short(el.textContent)}"` : ''));
    return `${t}${id}${hook}${role}${txt}`;
  };
  const pathOf = (el) => {
    const parts = [];
    let n = el, depth = 0;
    while (n && n.nodeType === 1 && depth < 5 && n !== document.body) {
      const d = desc(n);
      const cls = (n.className && typeof n.className === 'string') ? n.className.split(/\s+/).filter((c) => /^(fixed|absolute|sticky|flex|grid|dense-layout|z-\d+|shrink-0|truncate|overflow-\w+)$/.test(c)).slice(0, 4).join('.') : '';
      parts.unshift(d + (cls ? '.' + cls : ''));
      n = n.parentElement; depth++;
    }
    return parts.join(' > ');
  };
  const R = (r) => [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
  const isInvisible = (el) => {
    for (let a = el; a && a !== document.documentElement; a = a.parentElement) {
      const s = cs(a);
      if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return true;
    }
    return false;
  };
  // Visible box after the viewport and every ancestor that really clips this
  // element (overflow hidden/clip AND on the containing-block chain).
  const visibleBox = (el) => {
    const r = rect(el);
    const v = { l: Math.max(0, r.left), t: Math.max(0, r.top), r: Math.min(vw, r.right), b: Math.min(vh, r.bottom) };
    let clipper = null;
    let scrollClipped = false; // area lost to an overflow auto/scroll ancestor (reachable by scrolling)
    let pos = cs(el).position;
    let a = el.parentElement;
    while (a && a !== document.documentElement) {
      const s = cs(a);
      if (pos === 'fixed') break; // viewport is the containing block; nothing below clips
      if (pos === 'absolute' && s.position === 'static') { a = a.parentElement; continue; }
      if (pos === 'absolute') pos = s.position; // reached the containing block; it (and above) may clip
      const sx = s.overflowX === 'auto' || s.overflowX === 'scroll';
      const sy = s.overflowY === 'auto' || s.overflowY === 'scroll';
      const cx = s.overflowX === 'hidden' || s.overflowX === 'clip' || sx;
      const cy = s.overflowY === 'hidden' || s.overflowY === 'clip' || sy;
      if (cx || cy) {
        const ar = rect(a);
        const before = (v.r - v.l) * (v.b - v.t);
        if (cx) { v.l = Math.max(v.l, ar.left); v.r = Math.min(v.r, ar.right); }
        if (cy) { v.t = Math.max(v.t, ar.top); v.b = Math.min(v.b, ar.bottom); }
        const after = Math.max(0, v.r - v.l) * Math.max(0, v.b - v.t);
        if (after < before - 1 && !clipper) { clipper = a; if (sx || sy) scrollClipped = true; }
      }
      if (s.position !== 'static') pos = s.position;
      if (s.position === 'fixed') break;
      a = a.parentElement;
    }
    return { v, clipper, scrollClipped };
  };

  const out = { total: 0, covered: [], hidden: [], scrollable: 0, overlap: [], overlapDecor: [], hscroll: null, zoom: null, shell: null };
  const shell = document.querySelector('.dense-layout');
  if (shell) {
    const s = cs(shell);
    const sr = rect(shell);
    out.zoom = parseFloat(s.zoom) || 1;
    out.shell = { rect: R(sr), overflowBottom: Math.round(sr.bottom - (vh - 80)), scrollW: shell.scrollWidth, clientW: shell.clientWidth };
  }
  const de = document.documentElement;
  out.hscroll = { docScrollW: de.scrollWidth, bodyScrollW: document.body.scrollWidth, vw, over: Math.max(de.scrollWidth, document.body.scrollWidth) - vw };

  const flagged = [];
  for (const el of all) {
    if (el.tagName === 'OPTION') continue;
    if (el.closest('[data-boot-splash], [aria-hidden="true"]')) continue;
    if (isInvisible(el)) continue;
    const r = rect(el);
    if (r.width < 1 || r.height < 1) continue;
    out.total++;
    const { v, clipper, scrollClipped } = visibleBox(el);
    const area = r.width * r.height;
    const visArea = Math.max(0, v.r - v.l) * Math.max(0, v.b - v.t);
    if (visArea < 0.6 * area && scrollClipped) { out.scrollable++; continue; } // out of a scrollport: reachable, not hidden
    if (visArea < 0.6 * area) {
      out.hidden.push({ path: pathOf(el), rect: R(r), visible: Math.round(100 * visArea / area), by: clipper ? pathOf(clipper) : 'viewport', byRect: clipper ? R(rect(clipper)) : [0, 0, vw, vh] });
      flagged.push([el, 'hidden']);
      continue;
    }
    const cx = (v.l + v.r) / 2, cy = (v.t + v.b) / 2;
    const top = document.elementFromPoint(cx, cy);
    if (top && top !== el && !el.contains(top) && !top.contains(el)) {
      out.covered.push({ path: pathOf(el), rect: R(r), coverer: pathOf(top), covererRect: R(rect(top)), at: [Math.round(cx), Math.round(cy)] });
      flagged.push([el, 'covered']);
    }
  }
  // (d) nowrap flex rows whose in-flow children intersect
  const rows = Array.from(rootEl.querySelectorAll('*')).filter((el) => {
    const s = cs(el);
    return (s.display === 'flex' || s.display === 'inline-flex') && /^row/.test(s.flexDirection) && s.flexWrap === 'nowrap' && el.children.length > 1;
  });
  for (const row of rows) {
    if (row.closest('[data-boot-splash]') || isInvisible(row)) continue;
    const kids = Array.from(row.children).filter((k) => { const s = cs(k); return s.display !== 'none' && s.position !== 'absolute' && s.position !== 'fixed'; });
    for (let i = 0; i < kids.length; i++) {
      for (let j = i + 1; j < kids.length; j++) {
        const a = rect(kids[i]), b = rect(kids[j]);
        if (a.width < 1 || a.height < 1 || b.width < 1 || b.height < 1) continue;
        const iw = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const ih = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (iw > 3 && ih > 3) {
          const interactive = kids[i].matches(INTERACTIVE) || kids[j].matches(INTERACTIVE) || kids[i].querySelector(INTERACTIVE) || kids[j].querySelector(INTERACTIVE);
          const rec = { row: pathOf(row), a: desc(kids[i]), aRect: R(a), b: desc(kids[j]), bRect: R(b), overlap: [Math.round(iw), Math.round(ih)] };
          (interactive ? out.overlap : out.overlapDecor).push(rec);
          if (interactive) flagged.push([kids[i], 'overlap'], [kids[j], 'overlap']);
        }
      }
    }
  }
  // outline flagged elements for the screenshot (caller removes via __auditClear)
  window.__auditClear = () => { for (const [el] of flagged) { el.style.outline = ''; el.style.outlineOffset = ''; } };
  for (const [el, kind] of flagged) {
    el.style.outline = `2px solid ${kind === 'covered' ? '#ff2d55' : kind === 'hidden' ? '#ff9f0a' : '#ffd60a'}`;
    el.style.outlineOffset = '-1px';
  }
  const cap = (arr) => arr.length > limit ? arr.slice(0, limit) : arr;
  return { ...out, covered: cap(out.covered), hidden: cap(out.hidden), overlap: cap(out.overlap), overlapDecor: cap(out.overlapDecor),
    counts: { total: out.total, covered: out.covered.length, hidden: out.hidden.length, scrollable: out.scrollable, overlap: out.overlap.length, overlapDecor: out.overlapDecor.length, hscroll: out.hscroll.over > 1 ? 1 : 0 } };
}

// ── driver ───────────────────────────────────────────────────────────────────
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
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
if (FORCE_ZOOM) {
  await page.addStyleTag({ content: `.dense-layout{zoom:${FORCE_ZOOM} !important;--layout-zoom:${FORCE_ZOOM} !important}` });
}
const settle = async (ms) => { await page.waitForTimeout(ms); await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {}); };
const appUi = (fn) => page.evaluate(async (src) => { const m = await import('/src/state/appUiStore.ts'); (new Function('s', 'return (' + src + ')(s)'))(m.useAppUiStore.getState()); }, fn.toString());
const dock = (fn) => page.evaluate(async (src) => { const m = await import('/src/state/bottomPanelStore.ts'); (new Function('s', 'return (' + src + ')(s)'))(m.useBottomPanelStore.getState()); }, fn.toString());

const results = [];
let shotN = 0;
async function runAudit(vp, tab, state, scopeSel = null) {
  const res = await page.evaluate(auditInPage, { scopeSel, limit: 60 });
  const rec = { viewport: `${vp.w}x${vp.h}`, tab, state, ...res };
  results.push(rec);
  const bad = res.counts.covered + res.counts.hidden;
  console.log(`  ${vp.w}x${vp.h} ${tab.padEnd(8)} ${state.padEnd(8)} zoom=${res.zoom} total=${res.counts.total} covered=${res.counts.covered} hidden=${res.counts.hidden} scrollable=${res.counts.scrollable} overlap=${res.counts.overlap} decor=${res.counts.overlapDecor} hscroll=${res.hscroll.over > 1 ? res.hscroll.over : 0} shellOver=${res.shell?.overflowBottom}`);
  if (SHOTS && (bad > 0 || res.counts.overlap > 0 || res.hscroll.over > 1)) {
    const f = path.join(OUT, 'layout', `${LABEL}_${vp.w}x${vp.h}_${tab}_${state}.png`);
    await page.screenshot({ path: f }).catch(() => {});
    rec.shot = f; shotN++;
  }
  await page.evaluate(() => window.__auditClear && window.__auditClear()).catch(() => {});
  return rec;
}

for (const vp of VIEWPORTS) {
  await page.setViewportSize({ width: vp.w, height: vp.h });
  await page.waitForTimeout(400);
  for (const tab of TABS) {
    await page.evaluate(async (tab) => { const m = await import('/src/state/appUiStore.ts'); m.useAppUiStore.getState().setCenterTab(tab); }, tab);
    await settle(1400);
    for (const state of STATES) {
      if (state === 'dock') { await dock((s) => s.setOpen(true)); await settle(600); }
      await runAudit(vp, tab, state);
      if (state === 'dock') { await dock((s) => s.setOpen(false)); await page.waitForTimeout(200); }
    }
  }
  if (EXTRAS.length) {
    await appUi((s) => s.setCenterTab('make'));
    await settle(800);
    if (EXTRAS.includes('log')) {
      await dock((s) => s.setLogOpen(true)); await settle(500);
      await runAudit(vp, 'make', 'log');
      await dock((s) => s.setLogOpen(false));
    }
    if (EXTRAS.includes('library')) {
      await appUi((s) => s.setRightPanelOpen(true)); await settle(800);
      await runAudit(vp, 'make', 'library');
      await appUi((s) => s.setRightPanelOpen(false));
    }
    if (EXTRAS.includes('settings')) {
      await page.evaluate(() => window.dispatchEvent(new Event('thedaw:open-settings')));
      await settle(900);
      const ok = await page.evaluate(() => { const b = document.querySelector('[aria-label="Close settings"]'); const root = b && b.closest('.fixed'); if (root) root.setAttribute('data-audit-scope', ''); return !!root; });
      await runAudit(vp, 'make', 'settings', ok ? '[data-audit-scope]' : null);
      await page.evaluate(() => { const b = document.querySelector('[aria-label="Close settings"]'); b && b.click(); });
      await page.waitForTimeout(300);
    }
  }
}
await browser.close();

// ── report ───────────────────────────────────────────────────────────────────
fs.writeFileSync(path.join(OUT, `layout-audit-${LABEL}.json`), JSON.stringify(results, null, 1));
const lines = [];
lines.push(`# Layout audit — ${LABEL} (${new Date().toISOString()})`, '');
lines.push(`App: ${APP}. Viewports: ${VIEWPORTS.map((v) => v.w + 'x' + v.h).join(', ')}. Tabs: ${TABS.join(', ')}. States: ${STATES.join(', ')} + ${EXTRAS.join(', ')} (MAKE).${FORCE_ZOOM ? ` FORCED ZOOM ${FORCE_ZOOM}.` : ''}`, '');
lines.push('Legend: covered = topmost element at the control centre is a stranger; hidden = < 60% visible after viewport/overflow-hidden clipping; overlap = intersecting in-flow siblings of a nowrap flex row holding a control; hscroll = document wider than the viewport (px over).', '');
lines.push('## Totals per viewport', '', '| viewport | zoom | controls | covered | hidden | overlap | decor-overlap | hscroll states | shell overflow (px below footer, max) |', '|---|---|---|---|---|---|---|---|---|');
for (const vp of VIEWPORTS) {
  const rs = results.filter((r) => r.viewport === `${vp.w}x${vp.h}`);
  const sum = (k) => rs.reduce((a, r) => a + r.counts[k], 0);
  const zooms = [...new Set(rs.map((r) => r.zoom))].join('/');
  const over = Math.max(...rs.map((r) => r.shell?.overflowBottom ?? 0));
  lines.push(`| ${vp.w}x${vp.h} | ${zooms} | ${sum('total')} | ${sum('covered')} | ${sum('hidden')} | ${sum('overlap')} | ${sum('overlapDecor')} | ${rs.filter((r) => r.hscroll.over > 1).length} | ${over} |`);
}
lines.push('', '## Per viewport x tab x state (covered / hidden / overlap / hscroll-over)', '');
const cols = [...new Set(results.map((r) => `${r.tab}:${r.state}`))];
lines.push('| viewport | ' + cols.join(' | ') + ' |', '|---|' + cols.map(() => '---').join('|') + '|');
for (const vp of VIEWPORTS) {
  const cells = cols.map((c) => { const [tab, state] = c.split(':'); const r = results.find((x) => x.viewport === `${vp.w}x${vp.h}` && x.tab === tab && x.state === state); if (!r) return '-'; const s = `${r.counts.covered}/${r.counts.hidden}/${r.counts.overlap}/${r.hscroll.over > 1 ? r.hscroll.over : 0}`; return (r.counts.covered + r.counts.hidden) ? `**${s}**` : s; });
  lines.push(`| ${vp.w}x${vp.h} | ${cells.join(' | ')} |`);
}
const agg = (kind, keyOf, fmt) => {
  const m = new Map();
  for (const r of results) for (const it of r[kind]) { const k = keyOf(it); const e = m.get(k) || { n: 0, where: new Set(), it }; e.n++; e.where.add(`${r.viewport}/${r.tab}/${r.state}`); m.set(k, e); }
  return [...m.values()].sort((a, b) => b.n - a.n).slice(0, 45).map((e) => `- (${e.n}x) ${fmt(e.it)}  \n  where: ${[...e.where].slice(0, 6).join(', ')}${e.where.size > 6 ? ` ... +${e.where.size - 6}` : ''}`);
};
lines.push('', '## Worst offenders — COVERED', '', ...agg('covered', (i) => i.path + '||' + i.coverer, (i) => `\`${i.path}\` rect ${JSON.stringify(i.rect)} covered by \`${i.coverer}\` ${JSON.stringify(i.covererRect)}`));
lines.push('', '## Worst offenders — HIDDEN', '', ...agg('hidden', (i) => i.path + '||' + i.by, (i) => `\`${i.path}\` rect ${JSON.stringify(i.rect)} ${i.visible}% visible, clipped by \`${i.by}\` ${JSON.stringify(i.byRect)}`));
lines.push('', '## Worst offenders — OVERLAP (interactive)', '', ...agg('overlap', (i) => i.row + '||' + i.a + '||' + i.b, (i) => `row \`${i.row}\`: \`${i.a}\` ${JSON.stringify(i.aRect)} + \`${i.b}\` ${JSON.stringify(i.bRect)} intersect ${JSON.stringify(i.overlap)}`));
lines.push('', '## Horizontal overflow', '', ...results.filter((r) => r.hscroll.over > 1).map((r) => `- ${r.viewport}/${r.tab}/${r.state}: doc ${r.hscroll.docScrollW}px vs viewport ${r.hscroll.vw}px (+${r.hscroll.over})`));
lines.push('', '## Shell root overflow (root bottom vs footer top)', '', ...results.filter((r) => (r.shell?.overflowBottom ?? 0) > 1).map((r) => `- ${r.viewport}/${r.tab}/${r.state}: +${r.shell.overflowBottom}px`));
lines.push('', `## Screenshots (${shotN})`, '', ...results.filter((r) => r.shot).map((r) => `- ${r.viewport}/${r.tab}/${r.state}: ${r.shot}`));
fs.writeFileSync(path.join(OUT, `layout-audit-${LABEL}.md`), lines.join('\n') + '\n');
console.log('wrote', path.join(OUT, `layout-audit-${LABEL}.md`));
