/**
 * The project tuning: temperaments laid from the circle of fifths, Scala
 * scales, the MIDI Tuning Standard messages every synth and MIDI file gets,
 * and what SpessaSynth actually sounds from them. The last part renders the
 * bundled bank in node (spessasynth_core SpessaSynthProcessor) and measures
 * the pitch of what comes out: A = 415 against A = 440, a Werckmeister III C,
 * and a 19-note Scala step.
 *
 *   cd frontend && npx tsx src/lib/tuning.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SoundBankLoader, SpessaSynthProcessor } from 'spessasynth_core';
import {
  DEFAULT_TUNING,
  cleanTuning,
  isStandardTuning,
  keyCents,
  keyHz,
  masterFineTuning,
  octaveTuning,
  parseScala,
  referenceCents,
  setCurrentTuning,
  temperamentOffsets,
  tuningMessages,
  tuningPlan,
  tuningSignature,
  withSysexAtStart,
  type ProjectTuning,
} from './tuning.ts';
import { encodeMidi, parseMidi } from './midi.ts';

const near = (a: number, b: number, eps: number, msg: string) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);
const tuning = (over: Partial<ProjectTuning>): ProjectTuning => cleanTuning({ ...DEFAULT_TUNING, ...over });

// ── temperaments ───────────────────────────────────────────────────────────
{
  assert.deepEqual(temperamentOffsets('equal'), new Array(12).fill(0));
  // Werckmeister III against C (the published table: C 0, C♯ -9.8, D -7.8, E♭ -5.9, E -9.8, F -2.0,
  // F♯ -11.7, G -3.9, G♯ -7.8, A -11.7, B♭ -3.9, B -7.8), here moved so A is 0.
  const w = temperamentOffsets('werckmeister3');
  const table = [0, -9.8, -7.8, -5.9, -9.8, -2.0, -11.7, -3.9, -7.8, -11.7, -3.9, -7.8];
  for (let i = 0; i < 12; i += 1) near(w[i] - w[0], table[i], 0.06, `Werckmeister III pitch class ${i}`);
  near(w[9], 0, 1e-9, 'A sits at the reference');
  // Quarter-comma meantone: pure major thirds C-E (386.3 cents) and a wolf between G♯ and E♭.
  const m = temperamentOffsets('meantone');
  near(400 + m[4] - m[0], 386.31, 0.02, 'meantone C-E is a pure third');
  near(700 + m[7] - m[0], 696.58, 0.02, 'meantone fifth');
  // Kirnberger III: C-E is a pure third too; Vallotti: F-C, C-G, ... narrowed by 1/6 comma, B-F♯ pure.
  const k = temperamentOffsets('kirnberger3');
  near(400 + k[4] - k[0], 386.31, 0.02, 'Kirnberger III C-E is pure');
  const v = temperamentOffsets('vallotti');
  near(700 + v[6] - v[11], 701.96, 0.02, 'Vallotti B-F♯ is pure');
  near(700 + v[7] - v[0], 698.04, 0.02, 'Vallotti C-G is narrowed by a sixth of the Pythagorean comma');
  // Laid from another root, the pattern moves with it.
  const wg = temperamentOffsets('werckmeister3', 7);
  for (let i = 0; i < 12; i += 1) near(wg[(i + 7) % 12] - wg[7], w[i] - w[0], 1e-6, `Werckmeister III from G, class ${i}`);
}

// ── reference pitch and keys ───────────────────────────────────────────────
{
  assert.equal(isStandardTuning(DEFAULT_TUNING), true);
  const baroque = tuning({ referenceHz: 415 });
  near(referenceCents(baroque), -101.27, 0.01, 'A = 415 is 101.3 cents under 440');
  setCurrentTuning(baroque);
  near(keyHz(69), 415, 1e-9, 'A4 at 415');
  near(keyHz(57), 207.5, 1e-9, 'A3 an octave under');
  setCurrentTuning(DEFAULT_TUNING);
  near(keyHz(69), 440, 1e-9, 'back at 440');
  // Out of range reads as the nearest allowed pitch; an unknown temperament as equal.
  assert.equal(cleanTuning({ referenceHz: 1000 }).referenceHz, 480);
  assert.equal(cleanTuning({ temperament: 'nope' }).temperament, 'equal');
  assert.equal(cleanTuning({ temperament: 'scala' }).temperament, 'equal', 'a Scala temperament needs its scale');
  assert.equal(tuningSignature(DEFAULT_TUNING), '', 'standard tuning names nothing');
  assert.notEqual(tuningSignature(baroque), tuningSignature(tuning({ referenceHz: 430 })));
}

// ── Scala ──────────────────────────────────────────────────────────────────
{
  const et12 = parseScala(`! 12-tet.scl\n!\n12-tone equal temperament\n 12\n!\n${Array.from({ length: 11 }, (_, i) => `${(i + 1) * 100}.0`).join('\n')}\n 2/1\n`);
  assert.equal(et12.description, '12-tone equal temperament');
  assert.equal(et12.cents.length, 12);
  near(et12.cents[11], 1200, 1e-9, 'the ratio 2/1 is an octave');
  const as = tuning({ temperament: 'scala', scala: et12 });
  for (const c of keyCents(as)) near(c, 0, 1e-9, 'a 12-tone equal scale is equal temperament');
  // A just scale by ratios: its fifth above the tonic is pure.
  const just = parseScala('Just\n12\n16/15\n9/8\n6/5\n5/4\n4/3\n45/32\n3/2\n8/5\n5/3\n9/5\n15/8\n2\n');
  near(just.cents[6], 701.955, 0.001, 'the ratio 3/2');
  assert.equal(tuningPlan(tuning({ temperament: 'scala', scala: just })).mode, 'octave', 'twelve notes to the octave go as octave tuning');
  // 19 notes to the octave cannot be twelve pitch classes: it goes key by key.
  const edo19 = parseScala(`19-EDO\n19\n${Array.from({ length: 19 }, (_, i) => ((i + 1) * 1200 / 19).toFixed(5)).join('\n')}\n`);
  const plan19 = tuningPlan(tuning({ temperament: 'scala', scala: edo19 }));
  assert.equal(plan19.mode, 'keys');
  near(plan19.keys[70] + 100 - plan19.keys[69], 1200 / 19, 1e-4, 'one 19-EDO step from A');
  near(plan19.keys[69], 0, 1e-9, 'A stays at the reference');
  assert.throws(() => parseScala('Broken\n3\n100.0\n'), /1 of its 3 notes/);
  assert.throws(() => parseScala('x\nlots\n'), /not a number of notes/);
  assert.throws(() => parseScala('x\n1\nabc\n'), /not a pitch/);
}

// ── the messages ───────────────────────────────────────────────────────────
{
  assert.deepEqual(tuningMessages(DEFAULT_TUNING), [], 'standard tuning sends nothing');
  assert.deepEqual(masterFineTuning(0), [0xf0, 0x7f, 0x7f, 0x04, 0x03, 0x00, 0x40, 0xf7], 'centre 8192');
  assert.deepEqual(masterFineTuning(-100).slice(5, 7), [0, 0], 'the bottom of the range');
  const oct = octaveTuning(new Array(12).fill(0));
  assert.deepEqual(oct.slice(0, 8), [0xf0, 0x7f, 0x7f, 0x08, 0x09, 0x03, 0x7b, 0x7f], 'every channel but the drum channel (10)');
  assert.equal(oct.length, 8 + 24 + 1);
  // A = 415: -100 cents on the master, the other 1.3 in every pitch class.
  const msgs = tuningMessages(tuning({ referenceHz: 415 }));
  assert.equal(msgs.length, 2);
  const plan = tuningPlan(tuning({ referenceHz: 415 }));
  near(plan.masterCents, -100, 1e-9, 'master tuning takes 100 cents');
  for (const c of plan.octave) near(c, -1.27, 0.01, 'the rest per pitch class');
  // Key-by-key: two messages a program (127 keys at most each), for all 128 programs.
  const keyMsgs = tuningMessages(tuning({ temperament: 'scala', scala: parseScala(`19\n19\n${Array.from({ length: 19 }, (_, i) => ((i + 1) * 1200 / 19).toFixed(5)).join('\n')}\n`) }));
  assert.equal(keyMsgs.length, 2 + 128 * 2);
  assert.deepEqual(keyMsgs[2].slice(0, 7), [0xf0, 0x7f, 0x7f, 0x08, 0x02, 0, 127]);
}

// ── into a MIDI file ───────────────────────────────────────────────────────
{
  const file = encodeMidi({ ppq: 480, bpm: 120, tracks: [{ name: 'A', notes: [{ tick: 0, note: 69, velocity: 100, durationTicks: 480, channel: 0 }] }] });
  const msgs = tuningMessages(tuning({ referenceHz: 415, temperament: 'werckmeister3' }));
  const tuned = withSysexAtStart(file, msgs);
  assert.equal(tuned.length, file.length + msgs.reduce((n, m) => n + 3 + (m.length - 1), 0), 'each message: delta 0, F0, one length byte, its bytes');
  const back = parseMidi(tuned);
  assert.equal(back.tracks.flatMap((t) => t.notes).length, 1, 'the notes are untouched');
  assert.equal(back.tracks.flatMap((t) => t.notes)[0].tick, 0);
  assert.equal(withSysexAtStart(file, []), file, 'nothing to add: the same bytes');
}

// ── what SpessaSynth sounds ────────────────────────────────────────────────
const SR = 44100;
const gm = readFileSync(new URL('../../public/soundfonts/gm.sf3', import.meta.url));
const bank = SoundBankLoader.fromArrayBuffer(gm.buffer.slice(gm.byteOffset, gm.byteOffset + gm.byteLength) as ArrayBuffer);

/** Render `key` on `program` for `sec` with `t`'s messages first; the pitch of its middle stretch in Hz. */
async function pitchOf(t: ProjectTuning, key: number, program = 80, sec = 0.7): Promise<number> {
  const synth = new SpessaSynthProcessor(SR, { effectsEnabled: false, eventsEnabled: false });
  await synth.processorInitialized;
  synth.soundBankManager.addSoundBank(bank, 'main');
  for (const m of tuningMessages(t)) synth.systemExclusive(m.slice(1));
  synth.programChange(0, program);
  synth.noteOn(0, key, 100);
  const n = Math.ceil(SR * sec);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i += 128) synth.process(left, right, i, Math.min(128, n - i));
  // Autocorrelation over the last half, parabolic peak.
  const x = left.subarray(Math.floor(n / 2));
  const minLag = Math.floor(SR / 2000);
  const maxLag = Math.ceil(SR / 60);
  const ac = (lag: number) => {
    let s = 0;
    for (let i = 0; i + lag < x.length; i += 1) s += x[i] * x[i + lag];
    return s;
  };
  const vals = new Float64Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag + 1; lag += 1) vals[lag] = ac(lag);
  // The first lag whose correlation is close to the best: the fundamental, not a multiple.
  let best = minLag;
  for (let lag = minLag + 1; lag <= maxLag; lag += 1) if (vals[lag] > vals[best]) best = lag;
  let lag = best;
  for (let l = minLag + 1; l < best; l += 1) {
    if (vals[l] >= vals[l - 1] && vals[l] >= vals[l + 1] && vals[l] > 0.9 * vals[best]) {
      lag = l;
      break;
    }
  }
  const [a, b, c] = [vals[lag - 1], vals[lag], vals[lag + 1]];
  const shift = (a - c) / (2 * (a - 2 * b + c));
  return SR / (lag + (Number.isFinite(shift) ? shift : 0));
}

const cents = (f: number, g: number) => 1200 * Math.log2(f / g);

{
  const a440 = await pitchOf(DEFAULT_TUNING, 69);
  const a415 = await pitchOf(tuning({ referenceHz: 415 }), 69);
  near(cents(a415, a440), -101.27, 1.5, 'A = 415 sounds 101 cents under A = 440');
  const a442 = await pitchOf(tuning({ referenceHz: 442 }), 69);
  near(cents(a442, a440), 7.85, 1.5, 'A = 442 sounds 8 cents over');
  // Werckmeister III at A = 440: C is 11.7 cents over its equal-tempered pitch, A where it was.
  const cEt = await pitchOf(DEFAULT_TUNING, 60);
  const cW = await pitchOf(tuning({ temperament: 'werckmeister3' }), 60);
  near(cents(cW, cEt), 11.73, 1.5, 'Werckmeister III C');
  const aW = await pitchOf(tuning({ temperament: 'werckmeister3' }), 69);
  near(cents(aW, a440), 0, 1.5, 'Werckmeister III A stays at the reference');
  // A 19-note Scala scale, key by key: B♭4 is one 19-EDO step over A4.
  const edo19 = parseScala(`19\n19\n${Array.from({ length: 19 }, (_, i) => ((i + 1) * 1200 / 19).toFixed(5)).join('\n')}\n`);
  const t19 = tuning({ temperament: 'scala', scala: edo19 });
  const a19 = await pitchOf(t19, 69);
  const bb19 = await pitchOf(t19, 70);
  near(cents(bb19, a19), 1200 / 19, 2, 'one 19-EDO step');
  near(cents(a19, a440), 0, 1.5, '19-EDO A at the reference');
  console.log(`  A440 ${a440.toFixed(2)} Hz, A415 ${a415.toFixed(2)} Hz, Werckmeister C ${cents(cW, cEt).toFixed(2)} cents`);
}

console.log('tuning: ok');
