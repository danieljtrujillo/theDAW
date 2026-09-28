/**
 * soundbankLevels: the loudness probe scripts/build_orchestra_sf3.py levels
 * its bank with, run here on the bundled gm.sf3 strings (programs 40-43),
 * which are the reference the orchestra's strings are levelled against.
 *
 * Run: `npx tsx src/lib/soundbankLevels.test.ts`
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEVEL_SAMPLE_RATE, loadBank, maxWindowRmsDb, measureLevel } from './soundbankLevels.ts';

// A full-scale sine on both channels reads -3.01 dB; a 100 ms burst in
// silence reads the burst, not the silence around it.
{
  const n = LEVEL_SAMPLE_RATE;
  const sine = new Float32Array(n).map((_, i) => Math.sin((2 * Math.PI * 441 * i) / LEVEL_SAMPLE_RATE));
  assert.ok(Math.abs(maxWindowRmsDb(sine, sine) + 3.0103) < 0.01, `${maxWindowRmsDb(sine, sine)}`);
  const burst = new Float32Array(n);
  for (let i = 0; i < 0.12 * n; i += 1) burst[i] = 0.5 * Math.sin((2 * Math.PI * 441 * i) / LEVEL_SAMPLE_RATE);
  assert.ok(Math.abs(maxWindowRmsDb(burst, burst) - (20 * Math.log10(0.5) - 3.0103)) < 0.1);
}

const here = dirname(fileURLToPath(import.meta.url));
const buf = readFileSync(join(here, '..', '..', 'public', 'soundfonts', 'gm.sf3'));
const gm = loadBank(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);

// The strings the orchestra is levelled against: each program resolves to
// itself, reads a finite level well inside full scale, and louder with velocity.
for (const program of [40, 41, 42, 43]) {
  const soft = await measureLevel(gm, { bank: 0, program, note: 60, velocity: 64, cc1: 127, seconds: 1 });
  const hard = await measureLevel(gm, { bank: 0, program, note: 60, velocity: 127, cc1: 127, seconds: 1 });
  assert.equal(hard.presetProgram, program, `program ${program} played ${hard.preset}`);
  assert.equal(hard.presetBank, 0);
  assert.ok(Number.isFinite(hard.rmsDb) && hard.rmsDb < -6 && hard.rmsDb > -60, `${program}: ${hard.rmsDb}`);
  assert.ok(hard.peak > 0 && hard.peak < 1, `${program}: peak ${hard.peak}`);
  assert.ok(hard.rmsDb > soft.rmsDb + 3, `${program}: velocity 127 ${hard.rmsDb} vs 64 ${soft.rmsDb}`);
  // Rendering is deterministic, so a level measured twice is the same level.
  const again = await measureLevel(gm, { bank: 0, program, note: 60, velocity: 127, cc1: 127, seconds: 1 });
  assert.equal(again.rmsDb, hard.rmsDb);
}

// Bank 128 plays the drum channel: the kit reference resolves to a kit.
{
  const kit = await measureLevel(gm, { bank: 128, program: 48, note: 38, velocity: 100, cc1: 0, seconds: 1 });
  assert.equal(kit.presetBank, 128, `kit played ${kit.preset}`);
  assert.ok(Number.isFinite(kit.rmsDb));
}

console.log('soundbankLevels: ok');
