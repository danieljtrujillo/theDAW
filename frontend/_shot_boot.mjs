// Screenshot the boot cinematic at intervals, then the app once it clears, so
// the goo / credit order / orb changes can be eyeballed without a manual launch.
import { chromium } from 'playwright';
const OUT = '../showcase/screenshots';
const b = await chromium.launch({ headless: false, args: [
  '--autoplay-policy=no-user-gesture-required', '--window-position=0,-1080', '--window-size=1920,1080',
]});
const ctx = await b.newContext({ viewport: { width: 1920, height: 1080 } });
const p = await ctx.newPage();
p.on('console', (m) => { if (m.type() === 'error') console.log('PAGE ERROR:', m.text().slice(0, 200)); });
p.on('pageerror', (e) => console.log('PAGE THROW:', String(e).slice(0, 200)));

await p.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' });
// Nudge the pointer so the goo ripple is visible in the shots.
for (const [t, name] of [[1200, 'boot-1'], [2600, 'boot-2'], [4200, 'boot-3'], [6200, 'boot-4'], [8200, 'boot-5']]) {
  await p.waitForTimeout(t === 1200 ? 1200 : 1400);
  await p.mouse.move(700 + Math.random() * 500, 400 + Math.random() * 200);
  await p.screenshot({ path: `${OUT}/${name}.png` });
  console.log('shot', name, 'splash?', !!(await p.$('[data-boot-splash]')));
}
await p.waitForFunction(() => !document.querySelector('[data-boot-splash]'), { timeout: 60000 }).catch(() => {});
await p.waitForTimeout(4000);
await p.screenshot({ path: `${OUT}/boot-app.png` });
console.log('app shot done');
await b.close();
