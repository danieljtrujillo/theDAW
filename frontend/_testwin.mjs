// ONE persistent test window. Launched once (background), kept alive across
// every probe; probes attach over CDP (_probe.mjs) instead of relaunching.
// Persistent profile dir -> permission grants stick; midi granted up front.
import { chromium } from 'playwright';
const profile = 'C:/Users/Cyboman/AppData/Local/Temp/claude-thedaw-testprofile';
const ctx = await chromium.launchPersistentContext(profile, {
  headless: false,
  viewport: { width: 1920, height: 1080 },
  args: [
    '--autoplay-policy=no-user-gesture-required',
    '--window-position=0,-1080', '--window-size=1920,1080',
    '--remote-debugging-port=9223',
  ],
});
await ctx.grantPermissions(['midi', 'midi-sysex'], { origin: 'http://localhost:5173' }).catch(() => {});
const p = ctx.pages()[0] ?? await ctx.newPage();
await p.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' });
console.log('test window up on :9223 — leave running');
// Keep the process alive until killed.
await new Promise(() => {});
