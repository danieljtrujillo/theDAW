// README extra captures the 40-scene run does not cover in the current UI:
// the compact library rail, the expanded Catalogue, the LEARN 2D genealogy and
// 3D galaxy in fullscreen, and the AUDIMATE node canvas with a staged pipeline.
//
// Run from frontend/ with backend :8600 and Vite :5173 up:
//   node _capture_readme_extra.mjs
// Output: ../docs/screenshots/extra-<name>.png
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';

const APP = 'http://localhost:5173/?nocinematic=1';
const OUT = path.resolve(process.cwd(), '..', 'docs', 'screenshots');
fs.mkdirSync(OUT, { recursive: true });
const HERO_ID = '68006988e370427d9108e5c5d724a9f5';
const HERO_TITLE = 'Et Tu Machina';

const log = (...a) => console.log('[extra]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForReady(page) {
  const overlay = page.locator('div.fixed.inset-0.z-200').first();
  try { await overlay.waitFor({ state: 'hidden', timeout: 25000 }); } catch { /* gone */ }
}

async function clickText(page, re) {
  return page.evaluate((src) => {
    const rx = new RegExp(src, 'i');
    const b = Array.from(document.querySelectorAll('button')).find((x) => rx.test(x.textContent || ''));
    if (b) { b.click(); return true; }
    return false;
  }, re.source);
}

async function clickTitle(page, re) {
  return page.evaluate((src) => {
    const rx = new RegExp(src, 'i');
    const b = Array.from(document.querySelectorAll('button')).find((x) => rx.test(x.title || x.getAttribute('aria-label') || ''));
    if (b) { b.click(); return true; }
    return false;
  }, re.source);
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, `extra-${name}.png`) });
  log(`ok extra-${name}.png`);
}

const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
await context.addInitScript(() => {
  try {
    localStorage.setItem('thedaw-onboarding', JSON.stringify({ state: { seen: true, neverShow: true }, version: 0 }));
    localStorage.setItem('thedaw-home-screen-v1', JSON.stringify({ state: { showAtStartup: false }, version: 0 }));
  } catch { /* noop */ }
});
const page = await context.newPage();
page.on('pageerror', (e) => log('PAGE ERROR:', e.message));

// ── library rail: expand, search the hero, select it ──
await page.goto(APP);
await waitForReady(page);
await sleep(800);
await page.locator('button[title="Expand library"]').first().click({ timeout: 8000 }).catch(() => log('warn: no Expand library button'));
const search = page.locator('input[name="library-search"]').first();
await search.waitFor({ state: 'visible', timeout: 8000 }).catch(() => log('warn: search input missing'));
await search.fill(HERO_TITLE).catch(() => {});
await sleep(600);
await page.locator(`[data-library-entry-id="${HERO_ID}"]`).first().click({ timeout: 5000 }).catch(() => log('warn: hero row click failed'));
await sleep(600);
await shot(page, 'library-rail');

// ── catalogue: expanded full-width view ──
await page.evaluate(async () => {
  const m = await import(/* @vite-ignore */ '/src/state/appUiStore.ts');
  m.useAppUiStore.getState().setLibraryExpanded(true);
});
await sleep(2500);
await shot(page, 'catalogue');
await page.evaluate(async () => {
  const m = await import(/* @vite-ignore */ '/src/state/appUiStore.ts');
  m.useAppUiStore.getState().setLibraryExpanded(false);
});
await sleep(400);

// ── LEARN 2D genealogy, fullscreen ──
await page.locator('[data-tour="tab-learn"]').first().click({ timeout: 5000 });
await sleep(800);
await clickText(page, /genealogy/i);
await page.waitForFunction(() => {
  let n = 0;
  for (const g of document.querySelectorAll('svg g')) {
    const r = g.getBoundingClientRect();
    if (r.width > 0 && r.width < 360 && r.height > 0 && r.height < 280) n++;
  }
  return n > 12;
}, { timeout: 18000 }).catch(() => log('warn: 2d nodes slow'));
await sleep(1200);
await clickTitle(page, /full screen/i);
await sleep(1500);
await shot(page, 'learn-2d');
await page.keyboard.press('Escape');
await sleep(600);

// ── LEARN 3D galaxy, fullscreen ──
await clickText(page, /3d\s*graph/i);
await page.waitForSelector('#lineage-graph-search', { timeout: 12000 }).catch(() => {});
await sleep(1200);
await clickTitle(page, /full screen/i);
await sleep(3500);
await shot(page, 'learn-3d');
await page.keyboard.press('Escape');
await sleep(600);

// ── AUDIMATE: stage a small pipeline and frame it ──
await page.locator('[data-tour="tab-audimate"]').first().click({ timeout: 5000 }).catch(async () => {
  await clickText(page, /audimate/i);
});
await sleep(1000);
const staged = await page.evaluate(async (heroId) => {
  const m = await import(/* @vite-ignore */ '/src/state/audimateStore.ts');
  const s = m.useAudimateStore.getState();
  for (const n of [...s.nodes]) s.removeNode(n.id);
  const st = () => m.useAudimateStore.getState();
  const a = st().addNode('input', 120, 300);
  const b = st().addNode('generate', 420, 180);
  const c = st().addNode('effect', 720, 300);
  const d = st().addNode('output', 1020, 220);
  try { st().updateParam(a, 'libraryId', heroId); } catch (e) { /* param name drift */ }
  const tryConnect = (f, fp, t, tp) => { try { st().connect(f, fp, t, tp); } catch (e) { /* port drift */ } };
  tryConnect(a, 'out', b, 'init');
  tryConnect(b, 'out', c, 'in');
  tryConnect(c, 'out', d, 'in');
  return { nodes: st().nodes.length, edges: st().edges.length };
}, HERO_ID);
log(`audimate staged nodes=${staged.nodes} edges=${staged.edges}`);
await sleep(1200);
await shot(page, 'audimate');

await browser.close();
log('done ->', OUT);
