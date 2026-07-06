// Theme-banner capture for the README "Layout and themes" section.
//
// Boots the app once, stages the Et Tu Machina stem arrangement on the EDIT
// timeline (same plan as scripts/screenshots/capture.ts buildStems), then
// walks a fixed list of themes, restyling live through editThemeStore and
// screenshotting each into docs/readme/themes/<id>.png.
//
// Run from frontend/ with backend :8600 and Vite :5173 up:
//   node _capture_themes.mjs
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';

const APP = 'http://localhost:5173/?nocinematic=1';
const OUT = path.resolve(process.cwd(), '..', 'docs', 'readme', 'themes');
fs.mkdirSync(OUT, { recursive: true });

const THEMES = ['obsidian', 'graphite', 'porcelain', 'paper', 'aurora', 'sunset'];
const HERO = {
  heroUrl: '/api/library/audio/68006988e370427d9108e5c5d724a9f5',
  stems: ['drums', 'bass', 'vocals', 'other'].map((n) => ({
    name: n,
    url: `/api/library/stems/68006988e370427d9108e5c5d724a9f5__${n}/audio`,
  })),
};

const log = (...a) => console.log('[themes]', ...a);

async function waitForReady(page) {
  const overlay = page.locator('div.fixed.inset-0.z-200').first();
  try {
    await overlay.waitFor({ state: 'hidden', timeout: 25000 });
  } catch {
    /* overlay never mounted or already gone */
  }
}

const browser = await chromium.launch({
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
await context.addInitScript(() => {
  try {
    localStorage.setItem(
      'thedaw-onboarding',
      JSON.stringify({ state: { seen: true, neverShow: true }, version: 0 }),
    );
    localStorage.setItem(
      'thedaw-home-screen-v1',
      JSON.stringify({ state: { showAtStartup: false }, version: 0 }),
    );
  } catch {
    /* localStorage unavailable */
  }
});
const page = await context.newPage();
page.on('pageerror', (e) => log('PAGE ERROR:', e.message));

await page.goto(APP);
await waitForReady(page);
await page.waitForTimeout(400);

// Stage the stem arrangement on the EDIT timeline.
const staged = await page.evaluate(async (spec) => {
  const out = [];
  const imp = (p) => import(/* @vite-ignore */ p);
  const fetchBlob = async (u) => {
    const r = await fetch(u);
    if (!r.ok) throw new Error(`${u} -> ${r.status}`);
    return new Blob([await r.arrayBuffer()], { type: 'audio/wav' });
  };
  const edMod = await imp('/src/state/editorStore.ts');
  const editor = edMod.useEditorStore;
  const computePeaks = edMod.computePeaks;
  const palette = ['#06b6d4', '#f97316', '#ec4899', '#a855f7'];
  const plan = { drums: [0, 22, 30], bass: [0, 22, 30], vocals: [6, 16, 40], other: [3, 19, 35] };
  let idx = 0;
  const firstIds = [];
  for (const s of spec.stems) {
    try {
      const blob = await fetchBlob(s.url);
      const { peaks, duration } = await computePeaks(blob, 240);
      const [st, dur, off] = plan[s.name] || [idx * 2, 18, 30];
      const tracks = editor.getState().tracks;
      let trackId;
      if (idx === 0 && tracks.length && editor.getState().clips.filter((c) => c.trackId === tracks[0].id).length === 0) trackId = tracks[0].id;
      else trackId = editor.getState().addTrack({ name: s.name, color: palette[idx % palette.length] });
      editor.getState().updateTrack(trackId, { name: s.name });
      const clipId = editor.getState().addClipToTrack({
        trackId, label: s.name, audioBlob: blob, mimeType: 'audio/wav',
        sourceDuration: duration, offsetIntoSource: Math.min(off, Math.max(0, duration - dur - 1)),
        durationSec: Math.min(dur, duration), startSec: st, color: palette[idx % palette.length],
      });
      editor.getState().cachePeaks(clipId, peaks);
      firstIds.push(clipId);
    } catch (e) {
      out.push(`stem ${s.name} ${e.message}`);
    }
    idx++;
  }
  try {
    if (firstIds[0]) { editor.getState().splitClipAt(firstIds[0], 8); editor.getState().updateClip(firstIds[0], { fadeInSec: 0.8 }); }
    if (firstIds[3]) editor.getState().updateClip(firstIds[3], { fadeInSec: 1.5 });
    editor.getState().setBpm(124); editor.getState().setSnap('1/8'); editor.getState().setZoom(34); editor.getState().setScrollSec(0);
  } catch (e) {
    out.push(`arrange ${e.message}`);
  }
  return { clips: editor.getState().clips.length, log: out };
}, HERO);
log(`staged clips=${staged.clips}${staged.log.length ? ` warn=[${staged.log.join(' | ')}]` : ''}`);

await page.locator('[data-tour="tab-edit"]').first().click({ timeout: 5000 });
await page.waitForTimeout(1200);

for (const id of THEMES) {
  await page.evaluate(async (themeId) => {
    const imp = (p) => import(/* @vite-ignore */ p);
    const store = (await imp('/src/state/editThemeStore.ts')).useEditThemeStore;
    store.getState().setTheme(themeId);
  }, id);
  await page.waitForTimeout(700);
  const file = path.join(OUT, `${id}.png`);
  await page.screenshot({ path: file });
  log(`ok ${id}.png`);
}

await browser.close();
log('done ->', OUT);
