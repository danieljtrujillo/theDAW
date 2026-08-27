// Load the real Sway DNB .als into PERFORM and screenshot the result:
// compact header, auto-opened routing strip, auto CC routes from the set.
import { chromium } from 'playwright';
const ALS = 'G:\\tmp\\swaytest\\Audima Labs The Sway Ableton Live 12 - DNB\\Audima Labs The Sway Ableton Live 12 - DNB.als';

const b = await chromium.launch({ headless: false, args: [
  '--autoplay-policy=no-user-gesture-required', '--window-position=0,-1080', '--window-size=1920,1080',
]});
const ctx = await b.newContext({ viewport: { width: 1920, height: 1080 } });
await ctx.addInitScript(() => {
  const seed = (k, s, v = 0) => { try { localStorage.setItem(k, JSON.stringify({ state: s, version: v })); } catch {} };
  seed('thedaw-onboarding', { seen: true, neverShow: true });
  seed('thedaw-home-screen-v1', { showAtStartup: false });
});
const p = await ctx.newPage();
p.on('pageerror', (e) => console.log('PAGE THROW:', String(e).slice(0, 300)));
await p.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => !document.querySelector('[data-boot-splash]'), { timeout: 60000 }).catch(() => {});
await p.waitForTimeout(1500);

const info = await p.evaluate(async (als) => {
  const ui = (await import('/src/state/appUiStore.ts')).useAppUiStore;
  ui.getState().setCenterTab('session');
  const imp = (await import('/src/state/dawImportStore.ts')).useDawImportStore;
  imp.getState().setSourcePath(als);
  await imp.getState().detectAndImport();
  const st = imp.getState();
  const routing = (await import('/src/state/performRouting.ts')).usePerformRoutingStore.getState();
  const sway = (await import('/src/state/swayBus.ts')).useSwayStore.getState();
  return {
    error: st.error,
    project: st.project ? {
      name: st.project.name,
      tracks: st.project.tracks.length,
      scenes: st.project.scenes.length,
      mappings: (st.project.controller_mappings ?? []).length,
      missing: st.project.missing_files.length,
    } : null,
    ccMods: routing.ccMods.map((m) => `${m.channel}/${m.number}->${m.label}`),
    kinds: (st.project?.controller_mappings ?? []).reduce((a, m) => {
      const k = `${m.target_kind}|note:${m.is_note}|macro:${m.is_macro}`;
      a[k] = (a[k] ?? 0) + 1;
      return a;
    }, {}),
    sample: (st.project?.controller_mappings ?? []).slice(0, 10).map((m) =>
      `${m.channel}/${m.number} ${m.is_note ? 'N' : 'CC'} ${m.target_kind} tk${m.track_index} "${m.track_name}" dev"${m.device_name}" par"${m.param_name}"`),
  };
}, ALS);
console.log(JSON.stringify(info, null, 1));
await p.waitForTimeout(2500);
await p.screenshot({ path: '../showcase/screenshots/perform-auto.png' });
console.log('shot saved');
await b.close();
