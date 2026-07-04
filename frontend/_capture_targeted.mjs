// Focused captures for the Owl (HRTF spatializer surface), the Ares .gan
// plugin, and the DRAW bottom-panel tab. Plain .mjs (run with node) so no
// esbuild/tsx transform injects the __name helper into page-side functions.
//
// Prereqs: backend on :8600 and frontend on :5173 (theDAW.bat / the two dev
// servers), and the Ares plugin packaged (POST /api/plugin/package-ares).
//
// Usage (from the frontend dir so node resolves playwright):
//   node ../scripts/screenshots/_capture_targeted.mjs
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../docs/screenshots');
const BASE = process.env.SA3_BASE || 'http://localhost:5173';
const VIEWPORT = { width: 1920, height: 1080 };
const log = (...a) => console.log('[targeted]', ...a);

async function waitReady(page) {
  const overlay = page.locator('div.fixed.inset-0.z-200').first();
  await overlay.waitFor({ state: 'hidden', timeout: 30000 }).catch(async () => {
    const skip = page.getByRole('button', { name: /continue|skip/i }).first();
    if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => {});
  });
  await page.waitForTimeout(400);
}

async function clickTab(page, id) {
  await page.locator(`[data-tour="tab-${id}"]`).first().click({ timeout: 8000 });
  await page.waitForTimeout(600);
}

const main = async () => {
  const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: VIEWPORT });
  // Suppress the first-run onboarding + HOME overlays so they don't cover the UI.
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('thedaw-onboarding', JSON.stringify({ state: { seen: true, neverShow: true }, version: 0 }));
      localStorage.setItem('thedaw-home-screen-v1', JSON.stringify({ state: { showAtStartup: false }, version: 0 }));
    } catch {}
  });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') log('console.error:', m.text()); });

  log('loading', BASE);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await waitReady(page);

  // ── The Owl (HRTF spatializer surface) ──────────────────────────────────
  // A chain holding only the spatializer auto-selects (selectedEntry falls back
  // to chain[0]), so MixView renders <TheOwl> in the effect stage.
  try {
    await clickTab(page, 'mix');
    const owlErr = await page.evaluate(async () => {
      try {
        const ec = (await import('/src/state/effectChainStore.ts')).useEffectChainStore;
        ec.getState().clearChain?.();
        ec.getState().addRackEffect('spatializer');
        return null;
      } catch (e) { return String(e && e.message || e); }
    });
    if (owlErr) log('owl store err:', owlErr);
    await page.waitForTimeout(1800);
    await page.screenshot({ path: resolve(OUT, 'owl-surface.png') });
    log('ok owl-surface.png');
  } catch (e) { log('owl FAILED:', e.message); }

  // ── Ares (.gan web plugin) ──────────────────────────────────────────────
  try {
    const aresErr = await page.evaluate(async () => {
      try {
        const gs = (await import('/src/state/ganStore.ts')).useGanStore;
        await gs.getState().openById('ares');
        return gs.getState().activeUrl || 'no-active-url';
      } catch (e) { return String(e && e.message || e); }
    });
    log('ares open ->', aresErr);
    // Give the composed-HTML iframe time to mount and paint the background.
    await page.locator('#gan-stage-frame').first().waitFor({ state: 'visible', timeout: 12000 }).catch(() => {});
    await page.waitForTimeout(2200);
    await page.screenshot({ path: resolve(OUT, 'ares-surface.png') });
    log('ok ares-surface.png');
  } catch (e) { log('ares FAILED:', e.message); }

  // ── DRAW bottom-panel tab ───────────────────────────────────────────────
  try {
    await clickTab(page, 'make');
    await page.evaluate(async () => {
      try {
        const bp = (await import('/src/state/bottomPanelStore.ts')).useBottomPanelStore;
        bp.getState().showTab('draw');
      } catch (e) {}
    });
    await page.waitForTimeout(1600);
    await page.screenshot({ path: resolve(OUT, 'draw-tab.png') });
    log('ok draw-tab.png');
  } catch (e) { log('draw FAILED:', e.message); }

  await browser.close();
  log('done');
};

main().catch((e) => { console.error(e); process.exit(1); });
