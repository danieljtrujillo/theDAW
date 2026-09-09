// Build a DENSE LOOM colony and shoot it. Growth alone off a single spore is
// too slow to look like anything, so this adds cells of every kind through the
// dish's own + buttons, lets the bar clock wire and ripen them, then shoots.
import { chromium } from 'playwright';
import { resolve } from 'node:path';

const OUT = process.env.SHOT_OUT || resolve(process.cwd(), '../docs/readme');
const BASE = process.env.SA3_BASE || 'http://localhost:5174';
const log = (...a) => console.log('[loom]', ...a);

const cells = async (page) => page.evaluate(() => {
  const m = document.body.innerText.match(/(\d+)\s+cells/);
  return m ? Number(m[1]) : -1;
});

const press = async (page, label, times) => {
  const b = page.getByRole('button', { name: label }).first();
  for (let i = 0; i < times; i++) {
    if (!(await b.isVisible().catch(() => false))) return i;
    await b.click({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(320);
  }
  return times;
};

const main = async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--use-angle=swiftshader'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('thedaw-onboarding', JSON.stringify({ state: { seen: true, neverShow: true }, version: 0 }));
      localStorage.setItem('thedaw-home-screen-v1', JSON.stringify({ state: { showAtStartup: false }, version: 0 }));
    } catch {}
  });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.locator('div.fixed.inset-0.z-200').first().waitFor({ state: 'hidden', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await page.locator('[data-tour="tab-loom"]').first().click({ timeout: 15000 });
  await page.waitForTimeout(2500);

  // Germinate the spore so the dish is live and the bar clock is running.
  const canvas = page.locator('canvas').first();
  const box = await canvas.boundingBox();
  for (const [fx, fy] of [[0.5, 0.37], [0.5, 0.45], [0.5, 0.3]]) {
    await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
    await page.waitForTimeout(700);
    if ((await cells(page)) > 1) break;
  }
  log('after germination:', await cells(page), 'cells');

  // Populate every cell kind, then wire and ripen them.
  for (const [label, n] of [[/\+\s*LOOP/i, 7], [/\+\s*RULE/i, 3], [/\+\s*GATE/i, 3], [/\+\s*MOD/i, 3], [/\+\s*COLONY/i, 2]]) {
    const done = await press(page, label, n);
    log(String(label), '->', done, 'clicks,', await cells(page), 'cells');
  }
  await press(page, /^\W*(GROW|BUD)\W*$/i, 18);
  log('after grow:', await cells(page), 'cells');

  // Let the bar clock wire, ripen and settle the new cells.
  await page.waitForTimeout(14000);
  log('after settle:', await cells(page), 'cells');

  // Deselect so the right pane shows the dish overview, not one cell's editor.
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(1500);

  await page.screenshot({ path: resolve(OUT, 'loom.png') });
  log('WROTE loom.png');
  await browser.close();
};

main().catch((e) => { console.error(e); process.exit(1); });
