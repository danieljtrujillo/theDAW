// Tight, unclipped shots of the bundled plugin faces for the READMEs.
//
// The MIX effect stage is smaller than Ares' natural design size, so shooting
// it in-app clips the face. The .gan runtime is served standalone, so loading
// it directly at a viewport matched to the design gives the whole plugin and
// nothing else. The Owl is a native React surface, so it is still shot in-app
// (its letterboxed artwork rect is already exactly the plugin).
//
// Runs against the user's ALREADY-RUNNING dev servers — their window is never
// touched.  Usage from frontend/:  node _shot_plugin_faces.mjs [--probe]
import { chromium } from 'playwright';
import { resolve } from 'node:path';

const OUT = process.env.SHOT_OUT || resolve(process.cwd(), '../docs/readme');
const BASE = process.env.SA3_BASE || 'http://localhost:5173';
const PROBE = process.argv.includes('--probe');
const log = (...a) => console.log('[faces]', ...a);

const prepCtx = async (browser, viewport) => {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('thedaw-onboarding', JSON.stringify({ state: { seen: true, neverShow: true }, version: 0 }));
      localStorage.setItem('thedaw-home-screen-v1', JSON.stringify({ state: { showAtStartup: false }, version: 0 }));
    } catch {}
  });
  return ctx;
};

const main = async () => {
  const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });

  // ── Ares: the .gan runtime, standalone ──────────────────────────────────
  // Probe the design size at a deliberately oversized viewport, then reshoot
  // at that exact size so the runtime lays out with no letterbox and no clip.
  {
    const ctx = await prepCtx(browser, { width: 2400, height: 1500 });
    const page = await ctx.newPage();
    const url = BASE + '/api/plugin/ares/runtime/index.html';
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);
    // The tight bound of the plugin is the UNION of every .gan-el, not the art
    // alone — controls can sit outside the background image.
    const geo = await page.evaluate(() => {
      const pick = (s) => { const el = document.querySelector(s); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
      const els = [...document.querySelectorAll('.gan-el')];
      // Some .gan-el live off-canvas (parked/hidden), so each rect is CLAMPED to
      // the canvas before unioning; otherwise the bound runs off to negative x.
      const cb = document.querySelector('#gan-canvas').getBoundingClientRect();
      let u = null;
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        const l = Math.max(r.left, cb.left), t = Math.max(r.top, cb.top);
        const rr = Math.min(r.right, cb.right), bb = Math.min(r.bottom, cb.bottom);
        if (rr - l < 2 || bb - t < 2) continue;
        u = u ? { l: Math.min(u.l, l), t: Math.min(u.t, t), r: Math.max(u.r, rr), b: Math.max(u.b, bb) } : { l, t, r: rr, b: bb };
      }
      return {
        stage: pick('#gan-stage'), canvas: pick('#gan-canvas'), art: pick('.gan-el.gan-image'), count: els.length,
        union: u ? { x: Math.round(u.l), y: Math.round(u.t), w: Math.round(u.r - u.l), h: Math.round(u.b - u.t) } : null,
      };
    });
    log('ares @2400x1500 ->', JSON.stringify(geo));
    await ctx.close();

    if (geo.union && !PROBE) {
      // Reshoot at a viewport that renders the union near TARGET_W, then clip
      // exactly to the union: the whole face, no chrome, no letterbox.
      const TARGET_W = 1240;
      const vw = Math.round(2400 * (TARGET_W / geo.union.w));
      const vh = Math.round(1500 * (TARGET_W / geo.union.w));
      const ctx2 = await prepCtx(browser, { width: vw, height: vh });
      const p2 = await ctx2.newPage();
      await p2.goto(url, { waitUntil: 'domcontentloaded' });
      await p2.waitForTimeout(4000);
      const u2 = await p2.evaluate(() => {
        const cb = document.querySelector('#gan-canvas').getBoundingClientRect();
        let u = null;
        for (const el of document.querySelectorAll('.gan-el')) {
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) continue;
          const l = Math.max(r.left, cb.left), t = Math.max(r.top, cb.top);
          const rr = Math.min(r.right, cb.right), bb = Math.min(r.bottom, cb.bottom);
          if (rr - l < 2 || bb - t < 2) continue;
          u = u ? { l: Math.min(u.l, l), t: Math.min(u.t, t), r: Math.max(u.r, rr), b: Math.max(u.b, bb) } : { l, t, r: rr, b: bb };
        }
        return u ? { x: u.l, y: u.t, width: u.r - u.l, height: u.b - u.t } : null;
      });
      log('ares reshoot union ->', JSON.stringify(u2), 'viewport', vw + 'x' + vh);
      await p2.screenshot({ path: resolve(OUT, 'ares.png'), clip: u2 });
      log('WROTE ares.png');
      await ctx2.close();
    }
  }

  // ── The Owl: native surface in the MIX stage ────────────────────────────
  {
    const ctx = await prepCtx(browser, { width: 1920, height: 1080 });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.locator('div.fixed.inset-0.z-200').first().waitFor({ state: 'hidden', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(500);
    await page.locator('[data-tour="tab-mix"]').first().click({ timeout: 10000 });
    await page.waitForTimeout(800);
    const err = await page.evaluate(async () => {
      try {
        const ec = (await import('/src/state/effectChainStore.ts')).useEffectChainStore;
        ec.getState().clearChain?.();
        ec.getState().addRackEffect('spatializer');
        return null;
      } catch (e) { return String((e && e.message) || e); }
    });
    if (err) log('owl store err:', err);
    await page.waitForTimeout(3000);
    const geo = await page.evaluate(() => {
      const cands = [...document.querySelectorAll('div')].filter((d) => d.style.aspectRatio && d.style.backgroundImage && d.style.backgroundImage !== 'none');
      if (!cands.length) return null;
      cands[0].setAttribute('data-shot', 'owl-face');
      const r = cands[0].getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    });
    log('owl face ->', JSON.stringify(geo));
    if (geo && !PROBE) {
      await page.locator('[data-shot="owl-face"]').screenshot({ path: resolve(OUT, 'owl.png') });
      log('WROTE owl.png');
    }
    await ctx.close();
  }

  await browser.close();
  log('done ->', OUT);
};

main().catch((e) => { console.error(e); process.exit(1); });
