// Attach to the persistent test window (never relaunches, never reloads unless
// asked) and run one action. Usage:
//   node _probe.mjs perform   — import the DNB set into PERFORM, dump routing, shoot
//   node _probe.mjs shot NAME — screenshot current state to showcase/screenshots/NAME.png
import { chromium } from 'playwright';

const b = await chromium.connectOverCDP('http://localhost:9223');
const ctx = b.contexts()[0];
const p = ctx.pages().find((x) => x.url().includes('localhost:5173')) ?? ctx.pages()[0];
const cmd = process.argv[2] ?? 'perform';

if (cmd === 'perform') {
  const ALS = 'G:\\tmp\\swaytest\\Audima Labs The Sway Ableton Live 12 - DNB\\Audima Labs The Sway Ableton Live 12 - DNB.als';
  const r = await p.evaluate(async (als) => {
    const ui = (await import('/src/state/appUiStore.ts')).useAppUiStore;
    ui.getState().setCenterTab('session');
    const imp = (await import('/src/state/dawImportStore.ts')).useDawImportStore;
    if (imp.getState().project?.name !== 'Audima Labs The Sway Ableton Live 12 - DNB') {
      imp.getState().setSourcePath(als);
      await imp.getState().detectAndImport();
    }
    return imp.getState().error ?? 'imported';
  }, ALS);
  console.log('import:', r);
  await p.waitForTimeout(1200); // let React effects flush (auto-route runs in an effect)
  const routing = await p.evaluate(async () => {
    const pr = (await import('/src/state/performRouting.ts')).usePerformRoutingStore.getState();
    return { ccMods: pr.ccMods.map((m) => `${m.channel < 0 ? 'omni' : `ch${m.channel + 1}`} CC${m.number} -> ${m.label}`) };
  });
  console.log(JSON.stringify(routing, null, 1));
  await p.screenshot({ path: '../showcase/screenshots/perform-auto.png' });
  console.log('shot: perform-auto.png');
} else if (cmd === 'shot') {
  const name = process.argv[3] ?? 'probe';
  await p.screenshot({ path: `../showcase/screenshots/${name}.png` });
  console.log(`shot: ${name}.png`);
}
// connectOverCDP: closing our client does NOT close the remote browser.
await b.close();
