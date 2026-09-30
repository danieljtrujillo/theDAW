/**
 * THROWAWAY runner for the T11b A/B bounce. Starts Vite on an OS-assigned free
 * port (never 3000), opens `scripts/ab-bounce/index.html` in the locally
 * installed headless Chromium (playwright's binary — nothing is downloaded),
 * waits for `window.__AB__`, prints the per-case deltas and exits non-zero if
 * any case exceeds the ticket's 1e-4 gate.
 *
 * Run from `frontend/`:  node scripts/ab-bounce/run.mjs
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import net from 'node:net';

const GATE = 1e-4;
const TIGHT = 1e-6;

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => res(port));
  });
});

const port = await freePort();
const server = await createServer({
  root: process.cwd(),
  configFile: 'vite.config.ts',
  server: { port, strictPort: true, host: '127.0.0.1' },
  logLevel: 'warn',
});
await server.listen();
console.log(`[ab] vite on http://127.0.0.1:${port}`);

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('[page:error]', m.text()); });
page.on('pageerror', (e) => console.log('[page:throw]', e.message));

let failed = false;
const shapeFailures = [];
try {
  await page.goto(`http://127.0.0.1:${port}/scripts/ab-bounce/index.html`, { waitUntil: 'load' });
  await page.waitForFunction('window.__AB__ || window.__AB_ERR__', null, { timeout: 300000 });
  const err = await page.evaluate('window.__AB_ERR__');
  if (err) { console.error('[ab] harness threw:\n' + err); process.exitCode = 1; failed = true; }
  const results = await page.evaluate('window.__AB__');
  for (const r of results ?? []) {
    if (r.error) {
      console.log(`\n${r.renderer} · ${r.name}\n  ERROR: ${r.error}`);
      failed = true;
      continue;
    }
    const worst = Math.max(0, ...r.deltas.map((d) => d.maxAbs));
    const worstF = Math.max(0, ...(r.floatDeltas ?? []).map((d) => d.maxAbs));
    const grade = (w) => (w === 0 ? 'BIT-IDENTICAL' : w <= TIGHT ? '<=1e-6' : w <= GATE ? '<=1e-4' : 'OVER GATE');
    const mismatches = r.mismatches ?? [];
    console.log(`\n${r.renderer} · ${r.name}`);
    if (r.extra) console.log(`  ${r.extra}`);
    for (const d of r.deltas) {
      console.log(`  wav   ch${d.channel}: max|Δ|=${d.maxAbs.toExponential(3)}  rmsΔ=${d.rms.toExponential(3)}  n=${d.samples}`);
    }
    for (const d of r.floatDeltas ?? []) {
      console.log(`  float ch${d.channel}: max|Δ|=${d.maxAbs.toExponential(3)}  rmsΔ=${d.rms.toExponential(3)}  n=${d.samples}`);
    }
    // A shape disagreement is a FAILURE, not a note: the deltas above only
    // cover the overlap, so they say nothing about the samples one side is
    // missing, and a small number there would read as a pass.
    for (const m of mismatches) {
      console.log(`  FAIL: ${m}`);
      shapeFailures.push(`${r.renderer} · ${r.name} — ${m}`);
    }
    console.log(`  => wav ${grade(worst)} | render ${grade(worstF)}${mismatches.length ? ' | SHAPE MISMATCH' : ''}`);
    if (worst > GATE || worstF > GATE || mismatches.length > 0) failed = true;
  }
} finally {
  await browser.close();
  await server.close();
}

if (shapeFailures.length > 0) {
  console.log(`\n[ab] shape mismatches (${shapeFailures.length}) — a render of the wrong LENGTH is the wrong render:`);
  for (const m of shapeFailures) console.log(`  - ${m}`);
}
console.log(`\n[ab] ${failed
  ? 'FAIL — a case is over 1e-4, shape-mismatched, or errored'
  : 'PASS — every case within 1e-4, every shape equal'}`);
process.exit(failed ? 1 : 0);
