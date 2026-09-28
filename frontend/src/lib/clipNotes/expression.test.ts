/**
 * Phrase expression (stage 4.2): lib/clipNotes/expression, and the roll's
 * EXPRESSION toggle on the composer's writes and Virtuoso's song build.
 *
 * The sequence each block replays:
 *   - a horn holds a whole note: CC 11 swells inside it, up to its crest and
 *     back, while a piano's whole note gets no swell;
 *   - a rising line and its fall: CC 1 grows to the phrase's peak and falls
 *     after it, and a rest of a beat starts a new phrase;
 *   - joined notes are a slur; a staccato breaks it;
 *   - a busy passage lifts CC 1 over a sparse one at the same arc;
 *   - attacks are seeded: the same seed plays the same, a legato leans early,
 *     a staccato stays tight;
 *   - EXPRESSION on, a plan written into the roll gives each SATB part CC 1
 *     and CC 11 and keeps its other controllers; off, the plan is written
 *     flat; a built song comes back with its curves.
 *
 *   cd frontend && npx tsx src/lib/clipNotes/expression.test.ts
 */
import assert from 'node:assert/strict';
import { buildExpression, inferHairpins, readPhrases, readSlurs, withExpressionControls } from './expression.ts';
import type { PianoNote, RollControl } from '../../state/pianoRollStore.ts';
import { rollTracksOf, usePianoRollStore } from '../../state/pianoRollStore.ts';
import type { ComposerNote, PlanResult } from '../composerClient.ts';
import { buildSong, ZERO_AMOUNTS } from '../virtuosoTransform.ts';

const pn = (id: string, note: number, tick: number, ticks = 960, velocity = 90, extra: Partial<PianoNote> = {}): PianoNote => ({
  id,
  note,
  tick,
  ticks,
  step: tick / 240,
  length: ticks / 240,
  velocity,
  ...extra,
});
const cc = (controls: readonly RollControl[], controller: number) => controls.filter((c) => c.controller === controller);
const valueAt = (list: readonly RollControl[], tick: number): number => {
  let v = -1;
  for (const c of list) if (c.tick <= tick) v = c.value;
  return v;
};

// ── A horn's held note swells inside itself ─────────────────────────────────
{
  const whole = [pn('h', 65, 0, 3840, 80)];
  const horn = buildExpression(whole, { instrument: { instrumentId: 'horn' }, attacks: false });
  const e = cc(horn.controls, 11);
  const start = valueAt(e, 0);
  const crest = valueAt(e, 0.4 * 3840);
  const end = valueAt(e, 3800);
  assert.ok(crest > start + 10, `the swell rises inside the note (${start} to ${crest})`);
  assert.ok(crest > end + 10, `and falls back before its end (${crest} to ${end})`);
  const piano = buildExpression(whole, { instrument: { instrumentId: 'piano' }, attacks: false });
  const pe = cc(piano.controls, 11);
  assert.ok(valueAt(pe, 0.4 * 3840) - valueAt(pe, 0) < 10, 'a piano does not swell inside a note');
}

// ── A phrase's arc, and a rest ending it ────────────────────────────────────
{
  const line = [60, 62, 64, 65, 67, 69, 71, 72].map((p, i) => pn(`a${i}`, p, i * 960, 960, 70 + i * 4));
  const fall = [71, 69, 67, 65].map((p, i) => pn(`b${i}`, p, (8 + i) * 960, 960, 80 - i * 6));
  const later = [pn('c0', 60, 14 * 960)];
  const notes = [...line, ...fall, ...later];
  const phrases = readPhrases(notes);
  assert.deepEqual(phrases.map((p) => [p.fromTick, p.toTick]), [[0, 12 * 960], [14 * 960, 15 * 960]], 'a two-beat rest ends the phrase');
  assert.deepEqual(readPhrases(notes, [4 * 960]).map((p) => p.fromTick), [0, 4 * 960, 14 * 960], 'a section boundary splits it again');
  const pins = inferHairpins(notes, phrases);
  assert.equal(pins[0].kind, 'cresc');
  assert.equal(pins[0].toTick, 7 * 960, 'the peak is the loudest, highest onset');
  assert.equal(pins[1].kind, 'dim');
  const r = buildExpression(notes, { attacks: false });
  const mod = cc(r.controls, 1);
  assert.ok(valueAt(mod, 7 * 960) > valueAt(mod, 0) + 25, 'CC 1 grows to the peak');
  assert.ok(valueAt(mod, 7 * 960) > valueAt(mod, 11.9 * 960) + 20, 'and falls after it');
  assert.ok(r.controls.every((c) => c.controller === 1 || c.controller === 11), 'it writes CC 1 and CC 11 only');
  for (let i = 1; i < r.controls.length; i += 1) assert.ok(r.controls[i].tick >= r.controls[i - 1].tick, 'sorted by tick');

  // A score's hairpin wins over the inferred arc.
  const given = buildExpression(line, { hairpins: [{ fromTick: 0, toTick: 8 * 960, kind: 'dim' }], attacks: false });
  assert.ok(valueAt(cc(given.controls, 1), 0) > valueAt(cc(given.controls, 1), 7 * 960), 'a printed diminuendo falls where the line rises');
}

// ── Slurs ───────────────────────────────────────────────────────────────────
{
  const joined = [pn('s0', 60, 0), pn('s1', 62, 960), pn('s2', 64, 1920), pn('s3', 65, 4000), pn('s4', 67, 4960, 960, 90, { articulation: 'staccato' })];
  assert.deepEqual(readSlurs(joined).map((s) => [s.fromTick, s.toTick]), [[0, 2880]], 'three joined notes are one slur; a gap and a staccato break it');
}

// ── Density lifts CC 1 ──────────────────────────────────────────────────────
{
  const sparse = [pn('x', 60, 0, 3840)];
  const busy = Array.from({ length: 16 }, (_, i) => pn(`y${i}`, 60 + (i % 3), i * 240, 240));
  const hp = [{ fromTick: 0, toTick: 3840, kind: 'cresc' as const }];
  const a = valueAt(cc(buildExpression(sparse, { hairpins: hp, attacks: false }).controls, 1), 1920);
  const b = valueAt(cc(buildExpression(busy, { hairpins: hp, attacks: false }).controls, 1), 1920);
  assert.ok(b > a + 5, `a busy passage drives harder (${a} vs ${b})`);
}

// ── Seeded attacks per articulation ─────────────────────────────────────────
{
  const many = (art?: PianoNote['articulation']) => Array.from({ length: 200 }, (_, i) => pn(`n${i}`, 60, 960 + i * 960, 960, 90, art ? { articulation: art } : {}));
  const one = buildExpression(many(), { seed: 3 }).notes.map((n) => n.tick);
  assert.deepEqual(buildExpression(many(), { seed: 3 }).notes.map((n) => n.tick), one, 'the same seed plays the same');
  assert.notDeepEqual(buildExpression(many(), { seed: 4 }).notes.map((n) => n.tick), one, 'another seed plays another take');
  const offsets = (art?: PianoNote['articulation']) => buildExpression(many(art), { seed: 5 }).notes.map((n, i) => (n.tick as number) - (960 + i * 960));
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  assert.ok(mean(offsets('legato')) < mean(offsets('staccato')) - 4, 'a legato speaks early');
  assert.ok(offsets('staccato').every((o) => Math.abs(o) <= 3), 'a staccato stays within 3 ticks');
  assert.ok(offsets().some((o) => o !== 0), 'an ordinario note moves too');
  const moved = buildExpression([pn('z', 60, 0)], { seed: 9 }).notes[0];
  assert.ok((moved.tick as number) >= 0, 'never before the roll');
  assert.equal(moved.step, (moved.tick as number) / 240, 'the step view follows the tick');
  assert.deepEqual(buildExpression(many(), { seed: 3, depth: 0 }).controls, [], 'depth 0 writes nothing');
}

// ── The part's other controllers stay ───────────────────────────────────────
{
  const out = withExpressionControls(
    [{ tick: 0, controller: 64, value: 127 }, { tick: 0, controller: 11, value: 3 }],
    [{ tick: 0, controller: 11, value: 99 }],
  );
  assert.deepEqual(out, [{ tick: 0, controller: 64, value: 127 }, { tick: 0, controller: 11, value: 99 }]);
}

// ── EXPRESSION on the composer's writes ─────────────────────────────────────
const cn = (note: number, tick: number, ticks = 960): ComposerNote => ({ note, tick, ticks });
const plan = {
  key: 'C major',
  final_key: 'C major',
  bars: 2,
  seed: 1,
  cadence: 'authentic_perfect',
  style: null,
  harmonic_rhythm: 'bar',
  ppq: 960,
  meter_map: [{ bar: 0, meter: { num: 4, den: 4, groups: [] } }],
  chords: [],
  parts: {
    soprano: [cn(72, 0, 1920), cn(74, 1920, 1920), cn(76, 3840, 3840)],
    alto: [cn(67, 0, 3840), cn(67, 3840, 3840)],
    tenor: [cn(64, 0, 3840), cn(62, 3840, 3840)],
    bass: [cn(48, 0, 3840), cn(43, 3840, 3840)],
  },
  flags: [],
} as unknown as PlanResult;
{
  // A storage for the setting to persist into (node has none).
  const kept = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) },
  });
  const roll = () => usePianoRollStore.getState();
  const fresh = () => roll().importParts([{ name: 'Soprano', notes: [], controls: [{ tick: 0, controller: 64, value: 127 }] }], 120);
  fresh();
  roll().setExpressionOn(false);
  roll().writePlanToRoll(plan);
  assert.ok(rollTracksOf(roll()).every((t) => !(t.controls ?? []).some((c) => c.controller === 1 || c.controller === 11)), 'off: the plan is written flat');

  fresh();
  roll().setExpressionOn(true);
  assert.equal(localStorage.getItem('thedaw.roll.expression.v1'), '1', 'the setting persists');
  roll().writePlanToRoll(plan);
  const parts = rollTracksOf(roll());
  for (const name of ['Soprano', 'Alto', 'Tenor', 'Bass']) {
    const t = parts.find((p) => p.name === name);
    assert.ok(t, name);
    assert.ok(cc(t.controls ?? [], 1).length > 2 && cc(t.controls ?? [], 11).length > 2, `${name} has phrase curves`);
  }
  const soprano = parts.find((p) => p.name === 'Soprano');
  assert.ok(soprano?.controls?.some((c) => c.controller === 64 && c.value === 127), 'the soprano keeps its pedal');
  assert.notDeepEqual(soprano?.notes.map((n) => n.tick), [0, 1920, 3840], 'its attacks are played, not gridded');
  roll().setExpressionOn(false);
}

// ── A built song comes back with its curves ─────────────────────────────────
{
  const source = [60, 62, 64, 65, 67, 65, 64, 62].map((p, i) => pn(`q${i}`, p, i * 960, 960));
  const opts = { key: 'C' as const, mode: 'major' as const, style: 'romantic' as const, amounts: { ...ZERO_AMOUNTS }, bpm: 100, meterMap: [], pickupSteps: 0 };
  const flat = buildSong(source, opts as never);
  assert.equal(flat.controls, undefined, 'off: no curves');
  const shaped = buildSong(source, { ...opts, expression: true } as never);
  assert.ok((shaped.controls ?? []).some((c) => c.controller === 1), 'on: CC 1');
  assert.ok((shaped.controls ?? []).some((c) => c.controller === 11), 'and CC 11');
  assert.equal(shaped.notes.length, flat.notes.length, 'the same notes, played');
}

console.log('expression: ok');
