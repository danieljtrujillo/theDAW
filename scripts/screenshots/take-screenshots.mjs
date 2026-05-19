// Playwright screenshot script for the StableDAW UI.
// Used by scripts/regenerate-docs.{sh,ps1} when Playwright + the dev server are both available.
//
// Outputs go to docs/UI/screenshots/. Each tab and modal gets its own PNG.

import { chromium } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, '../../docs/UI/screenshots');
mkdirSync(outDir, { recursive: true });

const BASE = process.env.SONICFORGE_BASE || 'http://localhost:5173';
const VIEWPORT = { width: 1600, height: 1000 };

const log = (...a) => console.log('[shot]', ...a);

const tabs = [
  { id: 'create', file: '01-create-tab.png', label: 'CREATE tab' },
  { id: 'edit', file: '02-edit-tab.png', label: 'EDIT tab' },
  { id: 'train', file: '03-train-tab.png', label: 'TRAIN tab' },
  { id: 'library', file: '04-library-tab.png', label: 'LIBRARY tab' },
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 });
    const page = await ctx.newPage();

    log(`Loading ${BASE}`);
    await page.goto(BASE, { waitUntil: 'networkidle', timeout: 15000 });
    // Wait for the StableDAW logo to appear so we know the React tree is mounted.
    await page.waitForSelector('text=STABLEDAW', { timeout: 10000 });

    for (const t of tabs) {
      log(`Capturing ${t.label}`);
      // Tab buttons are styled <button> elements with the label text inside.
      await page.locator(`button:has-text("${t.label.split(' ')[0]}")`).first().click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: resolve(outDir, t.file), fullPage: false });
    }

    // Docs modal.
    log('Capturing Docs modal');
    await page.locator('button[title="Open documentation"]').click();
    await page.waitForSelector('text=StableDAW Docs', { timeout: 5000 });
    await page.waitForTimeout(800); // let the TOC render
    await page.screenshot({ path: resolve(outDir, '05-docs-modal.png'), fullPage: false });

    // Sequencer.
    log('Switching to Step Sequencer + capturing');
    await page.keyboard.press('Escape'); // close docs
    await page.locator('button:has-text("Step Sequencer")').first().click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: resolve(outDir, '06-step-sequencer.png'), fullPage: false });

    log(`Done — ${tabs.length + 2} screenshots written to ${outDir}`);
  } catch (e) {
    console.error('[shot] FAILED:', e);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
