import assert from 'node:assert/strict';
import { barAt, normalizeMeterMap, type MeterSegment } from './meterMap.ts';
import {
  applyGroove,
  builtinGrooves,
  fromVirtuosoTemplate,
  isSwingGrooveId,
  makeGroove,
  slotOf,
  swingToGroove,
  toVirtuosoTemplate,
  type GrooveTemplate,
} from './grooveTemplate.ts';

const close = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 1e-9, `${what}: ${a} vs ${b}`);

/**
 * The roll's swing exactly as `PianoRollFeel` applied it before groove
 * templates: each odd step counted from the bar start moves by `swingPct`% of
 * a step. Kept here as the parity reference the new path must reproduce.
 */
const oldSwing = <T extends { step: number; length: number }>(
  notes: readonly T[],
  swingPct: number,
  map: readonly MeterSegment[],
  pickupSteps = 0,
): T[] => {
  const swing = Math.max(-0.49, Math.min(0.49, swingPct / 100));
  return notes.map((note) => {
    let step = note.step;
    const gridStep = Math.round(step);
    const fromBar = Math.round(gridStep - barAt(map, gridStep, pickupSteps).start);
    if (fromBar % 2 === 1) step = Math.max(0, step + swing);
    return { ...note, step };
  });
};

const notesOver = (count: number): { step: number; length: number; note: number }[] =>
  new Array<number>(count).fill(0).map((_, i) => ({ step: i * 0.5, length: 2, note: 60 + (i % 12) }));

// ── swingToGroove reproduces the old scalar swing, bar by bar ────────────────
{
  const map44 = normalizeMeterMap([{ bar: 0, meter: { num: 4, den: 4, groups: [] } }]);
  const map716 = normalizeMeterMap([{ bar: 0, meter: { num: 7, den: 16, groups: [] } }]);
  const map516 = normalizeMeterMap([{ bar: 0, meter: { num: 5, den: 16, groups: [] } }]);
  const notes = notesOver(80);
  for (const map of [map44, map716, map516]) {
    for (const pct of [-50, -33, -1, 0, 1, 12, 33, 50]) {
      const want = oldSwing(notes, pct, map);
      const got = applyGroove(notes, swingToGroove(pct), 4, 1, (s) => barAt(map, s, 0).start);
      assert.equal(got.length, want.length);
      got.forEach((n, i) => {
        close(n.step, want[i].step, `swing ${pct} note ${i}`);
        assert.equal(n.length, want[i].length, 'length untouched');
        assert.equal(n.note, want[i].note, 'other fields carried through');
      });
    }
  }
  // A pickup shifts where the bar (and so the parity) starts.
  const withPickup = applyGroove(notes, swingToGroove(40), 4, 1, (s) => barAt(map44, s, 3).start);
  const wantPickup = oldSwing(notes, 40, map44, 3);
  withPickup.forEach((n, i) => close(n.step, wantPickup[i].step, `pickup note ${i}`));
  assert.ok(isSwingGrooveId(swingToGroove(12).id), 'swing ids are recognizable');
  assert.ok(!isSwingGrooveId('straight'), 'straight is not a swing id');
  assert.equal(swingToGroove(200).lateness[1], 0.49, 'swing is clamped like the slider');
  assert.equal(swingToGroove(Number.NaN).lateness[1], 0, 'a non-number swings not at all');
  // A fractional percent rounds, so the id stays the slider's integral one.
  assert.equal(swingToGroove(12.4).id, 'swing:12');
  assert.deepEqual(swingToGroove(12.4), swingToGroove(12), 'and is the same groove');
}

// ── Strength scales the whole template linearly ──────────────────────────────
{
  const g = makeGroove('t', 'T', 16, new Array<number>(16).fill(0).map((_, i) => (i % 2 === 1 ? 0.4 : 0)));
  const notes = [{ step: 0 }, { step: 1 }, { step: 3 }];
  close(applyGroove(notes, g, 4, 1)[1].step, 1.4, 'full strength');
  close(applyGroove(notes, g, 4, 0.5)[1].step, 1.2, 'half strength');
  close(applyGroove(notes, g, 4, 0)[1].step, 1, 'zero strength leaves the grid');
  close(applyGroove(notes, g, 4, 2)[2].step, 3.4, 'strength is clamped to 1');
  close(applyGroove(notes, g, 4, -1)[1].step, 1, 'negative strength is clamped to 0');
  close(applyGroove(notes, g, 4, 1)[0].step, 0, 'an even slot does not move');
  // Pure: the input array and its notes are untouched.
  const before = notes.map((n) => n.step);
  applyGroove(notes, g, 4, 1);
  assert.deepEqual(notes.map((n) => n.step), before, 'input is not mutated');
  // A step never goes negative.
  const early = makeGroove('e', 'E', 16, new Array<number>(16).fill(-1));
  assert.equal(applyGroove([{ step: 0.2 }], early, 4, 1)[0].step, 0, 'step floors at 0');
  // A short lateness array does not produce NaN steps.
  const stubby = { id: 's', name: 'S', slots: 16, lateness: [0.5] } as GrooveTemplate;
  close(applyGroove([{ step: 5 }], stubby, 4, 1)[0].step, 5, 'a missing slot means no lateness');
}

// ── maxStep keeps a deep groove inside the grid ──────────────────────────────
{
  const late = makeGroove('l', 'L', 16, new Array<number>(16).fill(1));
  const notes = [{ step: 10 }, { step: 63 }, { step: 63.5 }];
  const capped = applyGroove(notes, late, 4, 1, undefined, 63);
  close(capped[0].step, 11, 'a note well inside the grid still moves');
  close(capped[1].step, 63, 'the last step is the ceiling');
  close(capped[2].step, 63, 'and a note already past it is pulled back to it');
  close(applyGroove(notes, late, 4, 1)[1].step, 64, 'without a ceiling it runs past the end');
  close(applyGroove(notes, late, 4, 1, undefined, Number.NaN)[1].step, 64, 'a non-number is no ceiling');
  assert.equal(applyGroove([{ step: 4 }], late, 4, 1, undefined, -5)[0].step, 0, 'a negative ceiling floors at 0');
}

// ── Slots wrap past the cycle, and follow stepsPerBeat ───────────────────────
{
  const g = makeGroove('w', 'W', 4, [0, 0.25, 0.5, 0.75]); // 4 slots per bar = one per beat
  assert.equal(slotOf(g, 0, 4), 0);
  assert.equal(slotOf(g, 7, 4), 1, 'step 7 is still in beat 1');
  assert.equal(slotOf(g, 8, 4), 2);
  assert.equal(slotOf(g, 16, 4), 0, 'the cycle wraps at the bar');
  assert.equal(slotOf(g, 20, 4), 1, 'and keeps wrapping');
  assert.equal(slotOf(g, -1, 4), 3, 'before the start wraps backwards');
  close(applyGroove([{ step: 4 }], g, 4, 1)[0].step, 4 + 0.25 * 4, 'lateness is a proportion of a slot');
  // With 8 steps per beat a bar is 32 steps and each of the 4 slots spans 8.
  assert.equal(slotOf(g, 8, 8), 1);
  close(applyGroove([{ step: 8 }], g, 8, 1)[0].step, 8 + 0.25 * 8, 'slot width follows stepsPerBeat');
  // 16-slot templates wrap every bar without a bar resolver.
  const sw = swingToGroove(50);
  close(applyGroove([{ step: 17 }], sw, 4, 1)[0].step, 17.49, 'slot 1 of the second bar');
  close(applyGroove([{ step: 18 }], sw, 4, 1)[0].step, 18, 'slot 2 of the second bar');
}

// ── Adapters round-trip with Virtuoso's pocket ───────────────────────────────
{
  const timing = new Array<number>(16).fill(0).map((_, i) => (i % 3 === 0 ? 0.25 : -0.125));
  const pocket = { name: 'Reference', timing, accent: new Array<number>(16).fill(0.5) };
  const g = fromVirtuosoTemplate(pocket);
  assert.equal(g.slots, 16);
  assert.equal(g.name, 'Reference');
  assert.equal(g.id, 'midi:Reference');
  assert.deepEqual(g.lateness, timing, 'timing becomes lateness one for one');
  const back = toVirtuosoTemplate(g);
  assert.deepEqual(back.timing, timing, 'round-trips through the adapters');
  assert.equal(back.accent.length, 16);
  assert.deepEqual(fromVirtuosoTemplate(back, g.id), g, 'and back again');
  // Timing only: the pocket's emphasis is NOT carried, and lateness past what
  // Virtuoso's humanize reads (±0.5 of a step) is clamped on the way out.
  assert.deepEqual(back.accent, new Array<number>(16).fill(1), 'accent comes back flat, not 0.5');
  const deep = makeGroove('d', 'D', 16, new Array<number>(16).fill(0).map((_, i) => (i % 2 ? 1 : -1)));
  assert.deepEqual(
    toVirtuosoTemplate(deep).timing,
    new Array<number>(16).fill(0).map((_, i) => (i % 2 ? 0.5 : -0.5)),
    'lateness is clamped to ±0.5 step',
  );
  assert.notDeepEqual(fromVirtuosoTemplate(toVirtuosoTemplate(deep), 'd').lateness, deep.lateness,
    'so a deep groove does not survive the round-trip');
  // Out-of-range input is clamped, short input padded.
  const wild = fromVirtuosoTemplate({ name: 'Wild', timing: [4, -4], accent: [] });
  assert.deepEqual(wild.lateness, [1, -1, ...new Array<number>(14).fill(0)]);
  // A non-16 template is sampled at the sixteenth positions.
  const beats = makeGroove('b', 'B', 4, [0, 0.5, -0.5, 0.25]);
  assert.deepEqual(toVirtuosoTemplate(beats).timing, [
    0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5, -0.5, -0.5, -0.5, -0.5, 0.25, 0.25, 0.25, 0.25,
  ]);
}

// ── The built-in list ────────────────────────────────────────────────────────
{
  const list = builtinGrooves();
  assert.equal(list[0].id, 'straight', 'straight leads the list');
  assert.equal(new Set(list.map((g) => g.id)).size, list.length, 'ids are unique');
  for (const g of list) {
    assert.ok(g.name.length > 0, `${g.id} has a name`);
    assert.equal(g.lateness.length, g.slots, `${g.id} has one lateness per slot`);
    for (const v of g.lateness) assert.ok(v >= -1 && v <= 1, `${g.id} stays in range`);
  }
  const notes = notesOver(16);
  assert.deepEqual(applyGroove(notes, list[0], 4, 1), notes.map((n) => ({ ...n })), 'straight is identity');
  const s8 = list.find((g) => g.id === 'swing8:66') as GrooveTemplate;
  close(s8.lateness[2], (4 * 66) / 100 - 2, 'swung 8ths lag by the ratio');
  assert.equal(s8.lateness[1], 0, 'and the 16ths between them do not move');
  const s16 = list.find((g) => g.id === 'swing16:58') as GrooveTemplate;
  close(s16.lateness[1], (2 * 58) / 100 - 1, 'swung 16ths lag by the ratio');
  assert.equal(s16.lateness[2], 0, 'on-8ths stay put');
}

console.log('grooveTemplate: ok');
