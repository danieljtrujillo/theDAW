/**
 * djAutomixPlan — the DJ Automix transition brain, tested outside React.
 *
 * Every branch of the five pure functions the automix interval now leans on:
 *
 *   planTransition — when the blend starts, quantised DOWN to a 16-beat
 *     phrase boundary; refuses to start into an unanalysed/undecoded incoming
 *     track until the outgoing one is nearly gone; and rescues dead air when
 *     the outgoing track already ended.
 *   fadeStep      — the crossfader position during a fade; MUST land exactly
 *     on `to` (a fade that stops short parks the fader mid-blend).
 *   eqSwap        — the bass swap across the middle third of the fade.
 *   tempoMatch    — never claims a beatmatch the pitch range cannot deliver.
 *   chooseNextIndex — harmonic next-track preference (Camelot).
 *   deckRun / blendTick — a pause holds the plan and the blend; a track that
 *     ran out is rescued, and the rescue's fade runs its whole length.
 *   createAutomixQueue — a harmonic choice keeps every track it plays ahead
 *     of, is made once per track, and never reorders a prepared set.
 *
 * Run: `npx tsx src/lib/djAutomixPlan.test.ts` — `npm test` discovers it.
 */
import assert from 'node:assert/strict';
import {
  automixCamelot,
  blendTick,
  chooseNextIndex,
  createAutomixQueue,
  deckRun,
  EQ_KILL_DB,
  eqSwap,
  fadeStep,
  KEY_CONFIDENCE_MIN,
  planTransition,
  residualNudge,
  startBlend,
  tempoMatch,
  type AutomixIncoming,
  type AutomixOutgoing,
} from './djAutomixPlan';
import { camelotCodesCompatible as camelotCompatible } from './camelot';

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

/* ═════════════════════════════ planTransition ═════════════════════════════ */
{
  // 128 BPM: beat = 0.46875 s, a 16-beat phrase = 7.5 s, grid anchored at 0.5.
  const beatLen = 60 / 128;
  const out = (over: Partial<AutomixOutgoing> = {}): AutomixOutgoing => ({
    currentTime: 0, duration: 300, bpm: 128, gridAnchor: 0.5, beatLen,
    playing: true, started: true, mixOut: null, downbeats: null, ...over,
  });
  const inc = (over: Partial<AutomixIncoming> = {}): AutomixIncoming => ({
    bpm: 124, hasBuffer: true, cueIn: null, ...over,
  });
  const plan = (o: Partial<AutomixOutgoing>, i: Partial<AutomixIncoming> = {}, extra: { forced?: boolean } = {}) =>
    planTransition({ outgoing: out(o), incoming: inc(i), fadeSec: 10, tailSec: 18, now: 1000, ...extra });

  // ── phrase quantisation ──────────────────────────────────────────────────
  // Tail rule puts the raw mix-out at 300 - 18 = 282 s. Phrase lines sit at
  // 0.5 + k·7.5 → 278 is the last one at or before 282, so THAT is the start
  // (a DJ starts a blend on a phrase, not 4 s into one).
  const p0 = plan({ currentTime: 200 });
  assert.ok(near(p0.startAt!, 278), `phrase-quantised start, got ${p0.startAt}`);
  assert.equal(p0.phraseAligned, true, 'a known grid gives a phrase-aligned start');
  assert.equal(p0.start, false, 'not started 80 s early');
  assert.equal(p0.reason, 'not-due');

  assert.equal(plan({ currentTime: 277.9 }).start, false, 'a hair before the phrase line: still waiting');
  const p1 = plan({ currentTime: 278.1 });
  assert.equal(p1.start, true, 'at/after the phrase line: blend starts');
  assert.equal(p1.reason, 'phrase');
  assert.equal(p1.matched, true, 'both BPMs known → the plan claims a beatmatch');
  assert.equal(p1.startedAt, 1000, 'the fade clock starts at the `now` handed in (audio clock, not performance.now)');
  assert.equal(p1.fadeSec, 10);

  // A prepared set's exact mixOut point replaces the tail rule, and is phrase
  // quantised the same way: 0.5 + 7.5k ≤ 120 → 113.
  const pm = plan({ currentTime: 0, mixOut: 120 });
  assert.ok(near(pm.startAt!, 113), `mixOut quantised down to a phrase, got ${pm.startAt}`);

  // No grid (analysis never landed for the OUTGOING deck) → no quantisation,
  // and the plan says so rather than pretending.
  const pn = plan({ currentTime: 0, beatLen: null, gridAnchor: null, bpm: null });
  assert.ok(near(pn.startAt!, 282), 'without a grid the raw tail point is the start');
  assert.equal(pn.phraseAligned, false);
  assert.equal(plan({ currentTime: 283, beatLen: null, gridAnchor: null, bpm: null }).matched, false,
    'outgoing BPM unknown → not a matched mix');

  // Unknown duration and no mixOut: nothing to aim at, never due on its own.
  const pu = plan({ currentTime: 10, duration: 0 });
  assert.equal(pu.startAt, null);
  assert.equal(pu.start, false, 'unknown duration: the tail rule is inert');

  // ── downbeats beat the raw grid ──────────────────────────────────────────
  // Downbeats every 4 beats from 1.0; a 16-beat multiple of the FIRST one is
  // 1.0 + 7.5·k → 278.5 is the last such downbeat at or before 282.
  const db: number[] = [];
  for (let k = 0; k < 200; k++) db.push(1 + k * 4 * beatLen);
  const pd = plan({ currentTime: 200, downbeats: db });
  assert.ok(near(pd.startAt!, 278.5), `downbeat on a 16-beat multiple, got ${pd.startAt}`);
  assert.equal(pd.phraseAligned, true);
  assert.ok(pd.startAt !== 278, 'the downbeat list wins over the bare grid anchor');
  // Downbeats that are all past the mix-out point fall back to the grid.
  assert.ok(near(plan({ currentTime: 200, downbeats: [290, 297.5] }).startAt!, 278),
    'no usable downbeat before the mix-out → grid quantisation');

  // ── incoming not ready ───────────────────────────────────────────────────
  // Buffer decoded but BPM still unknown: refuse, we would be mixing blind.
  const pb = plan({ currentTime: 285 }, { bpm: null });
  assert.equal(pb.start, false, 'incoming BPM unknown and plenty of track left: wait');
  assert.equal(pb.reason, 'incoming-not-ready');
  // …until the outgoing track is inside tailSec/2 (9 s) of the end. Then a
  // messy mix beats dead air — but the plan admits it is unmatched.
  const pb2 = plan({ currentTime: 292 }, { bpm: null });
  assert.equal(pb2.start, true, 'less than tailSec/2 left: start anyway rather than run to silence');
  assert.equal(pb2.matched, false, 'and it is honestly reported as unmatched');
  assert.equal(pb2.reason, 'incoming-not-ready');
  // No decoded buffer at all: there is nothing to start, ever.
  assert.equal(plan({ currentTime: 299 }, { hasBuffer: false }).start, false, 'no incoming buffer: cannot start');
  assert.equal(plan({ currentTime: 299 }, { hasBuffer: false }).reason, 'incoming-not-ready');

  // ── dead air (fix 6): the outgoing deck already ran out ──────────────────
  const pdead = plan({ currentTime: 300, playing: false });
  assert.equal(pdead.start, true, 'outgoing deck stopped: start the incoming one NOW');
  assert.equal(pdead.immediate, true);
  assert.equal(pdead.reason, 'outgoing-stopped');
  assert.equal(pdead.phraseAligned, false, 'no phrase to align to once the music stopped');
  // Even an unanalysed incoming track is better than silence, as long as it
  // has audio to play.
  assert.equal(plan({ currentTime: 300, playing: false }, { bpm: null }).start, true,
    'silence beaten by an unmatched start');
  assert.equal(plan({ currentTime: 300, playing: false }, { hasBuffer: false }).start, false,
    'nothing decoded to play: stay put');
  assert.equal(plan({ currentTime: 300, playing: false }, { hasBuffer: false }).reason, 'no-incoming');
  // A PAUSED deck is not dead air (PR #207 review). This line used to pin the
  // opposite ("a stopped deck mid-track is still dead air"), and that is the
  // bug: the DJ pressed pause and the next track started within 500 ms.
  const ppause = plan({ currentTime: 12, playing: false });
  assert.equal(ppause.start, false, 'a deck paused mid-track holds the plan');
  assert.equal(ppause.immediate, false);
  assert.equal(ppause.reason, 'outgoing-paused');
  assert.equal(plan({ currentTime: 285, playing: false }).start, false,
    'paused inside the mix-out window: still held, the blend waits for play');
  // A deck that was ejected holds nothing to resume: that is dead air.
  assert.equal(plan({ currentTime: 0, duration: 0, playing: false, hasBuffer: false }).reason, 'outgoing-stopped',
    'an ejected outgoing deck moves the set on');
  // A new track decoding onto the outgoing deck is waited for.
  assert.equal(plan({ currentTime: 0, duration: 0, playing: false, hasBuffer: false, decoding: true }).reason, 'outgoing-paused');

  // ── DJ-5: a deck that NEVER started is not dead air ──────────────────────
  // THE BUG, seen in the live app on a bundled 18-track set: Deck A was
  // loaded (title + BPM on screen) but still decoding when the first 500 ms
  // tick ran. `playing` was false, so the dead-air branch fired, the incoming
  // deck was started and became `current` — its own buffer was not decoded
  // either — and the next tick fired the same branch again. A new track was
  // loaded every 3-5 s, nothing ever played, the footer stayed PAUSED and
  // both deck clocks sat at 0:00.0. "Stopped" means a deck that ran and then
  // ran out; a deck that has not played yet is a deck to WAIT for.
  const pnever = plan({ currentTime: 0, playing: false, started: false });
  assert.equal(pnever.start, false, 'a deck that never started is not rescued as dead air');
  assert.equal(pnever.immediate, false, 'and nothing is punched in immediately');
  assert.equal(pnever.startAt, null, 'there is no position to aim at on a deck that never ran');
  assert.equal(pnever.matched, false, 'nothing is matched before the set has begun');
  assert.equal(pnever.reason, 'outgoing-not-started');
  // Mid-track, still never started: same answer — the position is irrelevant.
  assert.equal(plan({ currentTime: 12, playing: false, started: false }).start, false,
    'a non-zero position on a deck that never played changes nothing');
  // Once the deck HAS played and run out, the dead-air rescue is as before.
  const pran = plan({ currentTime: 300, playing: false, started: true });
  assert.equal(pran.start, true, 'a deck that played and stopped is still rescued');
  assert.equal(pran.immediate, true);
  assert.equal(pran.reason, 'outgoing-stopped');
  // Nothing decoded on the incoming deck still wins over both.
  assert.equal(plan({ currentTime: 0, playing: false, started: false }, { hasBuffer: false }).reason, 'no-incoming',
    'no incoming buffer is reported ahead of the outgoing deck never starting');

  // ── the assistant's "transition NOW" ─────────────────────────────────────
  const pf = plan({ currentTime: 10 }, {}, { forced: true });
  assert.equal(pf.start, true, 'forced: start regardless of position');
  assert.equal(pf.reason, 'forced');
  assert.ok(near(pf.startAt!, 10), 'a forced blend starts where the track is, not at the far-off phrase line');
  assert.equal(plan({ currentTime: 10 }, { hasBuffer: false }, { forced: true }).start, false,
    'even forced needs something decoded on the incoming deck');
  assert.equal(plan({ currentTime: 10 }, { bpm: null }, { forced: true }).start, true,
    'forced overrides the not-ready wait');
  assert.equal(plan({ currentTime: 10 }, { bpm: null }, { forced: true }).matched, false,
    'and is still honest about being unmatched');

  // cueIn is carried through untouched; 0 is a real cue-in, not "unset".
  assert.equal(plan({ currentTime: 285 }, { cueIn: 12.5 }).cueIn, 12.5);
  assert.equal(plan({ currentTime: 285 }, { cueIn: 0 }).cueIn, 0);
  assert.equal(plan({ currentTime: 285 }, { cueIn: null }).cueIn, 0, 'no cue-in point → start of the track');
}

/* ══════════════════ short tracks: the blend cannot start at 0 ═════════════ */
{
  const beatLen = 60 / 128;
  const short = (duration: number, currentTime: number): AutomixOutgoing => ({
    currentTime, duration, bpm: 128, gridAnchor: 0.5, beatLen,
    playing: true, started: true, mixOut: null, downbeats: null,
  });
  const p = (duration: number, currentTime: number) => planTransition({
    outgoing: short(duration, currentTime),
    incoming: { bpm: 124, hasBuffer: true, cueIn: null },
    fadeSec: 10, tailSec: 18, now: 0,
  });

  // THE BUG: `duration - tailSec` is -6 for a 12 s track, `phraseStart` hands
  // the negative straight back, and `currentTime >= startAt` is true at t=0 —
  // the track blended out the instant it started. Never before half of it has
  // played.
  assert.equal(p(12, 0).start, false, 'a 12 s track does not blend out at t=0');
  assert.ok(p(12, 0).startAt! >= 6, `12 s track: blend no earlier than half way, got ${p(12, 0).startAt}`);
  assert.equal(p(12, 5.9).start, false, 'still playing at 5.9 s');
  assert.equal(p(12, 6.1).start, true, 'past half way: due');
  // The phrase grid must not drag it back under the floor either: quantising
  // 6 s down to the 0.5 s phrase line would reintroduce the same bug.
  assert.equal(p(12, 0).phraseAligned, false, 'no phrase line above the floor → honest about not being aligned');

  // 30 s at tail 18 → 12 s raw, which is under half; the floor wins at 15 s,
  // and the phrase line below it (8.0 s) must not be used.
  assert.ok(near(p(30, 0).startAt!, 15), `30 s track: blend at half way, got ${p(30, 0).startAt}`);
  assert.equal(p(30, 14.9).start, false);
  assert.equal(p(30, 15.1).start, true);

  // A normal-length track is untouched by the floor and stays phrase-aligned.
  assert.ok(near(p(300, 0).startAt!, 278), 'long track unchanged');
  assert.equal(p(300, 0).phraseAligned, true);

  // A prepared set's explicit mix-out point is the DJ's call: an early one is
  // honoured (only a negative one is nonsense), and one past the end never
  // fires.
  const prepared = (mixOut: number, currentTime: number) => planTransition({
    outgoing: { ...short(300, currentTime), mixOut },
    incoming: { bpm: 124, hasBuffer: true, cueIn: null },
    fadeSec: 10, tailSec: 18, now: 0,
  });
  assert.equal(prepared(20, 21).start, true, 'an early prepared mix-out is allowed');
  assert.equal(prepared(400, 299).start, false, 'a mix-out past the end never fires');
  assert.ok(prepared(-5, 0).startAt! >= 0, 'a negative prepared mix-out clamps to 0');
}

/* ════════════════════════════ residualNudge ═══════════════════════════════ */
{
  // `nudgePhase` can only bend the platter so far in one window, so it returns
  // what it actually delivered. Whatever is left has to be re-applied, or the
  // decks sit permanently out of phase by the shortfall.
  assert.ok(near(residualNudge(0.2, 0.16, 0.008), 0.04), 'the shortfall is carried over');
  assert.ok(near(residualNudge(-0.2, -0.16, 0.008), -0.04), 'and keeps its sign when holding back');
  assert.equal(residualNudge(0.2, 0.2, 0.008), 0, 'fully delivered: nothing left');
  assert.equal(residualNudge(0.2, 0.195, 0.008), 0, 'inside the deadband: do not chase it');
  assert.equal(residualNudge(0.2, 0.192, 0.008), 0, 'exactly the deadband is still inside it');
  assert.ok(near(residualNudge(0.2, 0.19, 0.008), 0.01), 'just outside the deadband: carried');
  assert.equal(residualNudge(0.2, 0, 0.008), 0.2, 'nothing delivered at all: the whole nudge is still owed');
  // A nudge that overshot must be pulled back, not ignored.
  assert.ok(near(residualNudge(0.05, 0.2, 0.008), -0.15), 'an overshoot is corrected in the other direction');
  // Junk in, zero out — never schedule a NaN bend.
  assert.equal(residualNudge(Number.NaN, 0.1, 0.008), 0);
  assert.equal(residualNudge(0.2, Number.NaN, 0.008), 0);
}

/* ═══════════════════════════════ fadeStep ═════════════════════════════════ */
{
  assert.equal(fadeStep(100, 100, 10, -1, 1), -1, 'at t0 the fader has not moved');
  assert.equal(fadeStep(100, 105, 10, -1, 1), 0, 'halfway');
  assert.equal(fadeStep(100, 110, 10, -1, 1), 1, 'at the end: EXACTLY the destination');
  assert.equal(fadeStep(100, 1e6, 10, -1, 1), 1, 'long past the end: still exactly the destination, never overshoot');
  assert.equal(fadeStep(100, 99, 10, -1, 1), -1, 'a clock that went backwards does not pull the fader past the start');
  // THE BUG (fix 7): a fade whose length is 0/negative/NaN used to divide and
  // park the fader wherever the partial write left it. It must land on `to`.
  assert.equal(fadeStep(100, 100, 0, -1, 1), 1, 'zero-length fade: snap to the destination');
  assert.equal(fadeStep(100, 100, -5, -1, 1), 1, 'negative fade length: snap to the destination');
  assert.equal(fadeStep(100, Number.NaN, 10, -1, 1), 1, 'a NaN clock snaps home rather than parking mid-fade');
  assert.equal(fadeStep(100, 103, 10, 1, -1), 0.4, 'B→A direction');
}

/* ════════════════════════════════ eqSwap ══════════════════════════════════ */
{
  const start = eqSwap(0);
  assert.equal(start.outLowDb, 0, 'fade start: the outgoing bass is untouched');
  assert.ok(start.inLowDb < -20, 'fade start: the incoming bass is killed (no two basslines at once)');
  assert.deepEqual(eqSwap(1 / 3), start, 'nothing happens for the first third');
  const mid = eqSwap(0.5);
  assert.ok(near(mid.outLowDb, mid.inLowDb), 'mid-swap both sit at the crossover');
  assert.ok(mid.outLowDb < -5 && mid.outLowDb > -21, `mid-swap is a crossover, not a jump: ${mid.outLowDb}`);
  const end = eqSwap(2 / 3);
  assert.ok(end.outLowDb < -20, 'by the last third the outgoing bass is gone');
  assert.equal(end.inLowDb, 0, 'and the incoming bass is fully in');
  assert.deepEqual(eqSwap(1), end, 'the last third holds');
  assert.deepEqual(eqSwap(5), end, 'progress past 1 clamps');
  assert.deepEqual(eqSwap(-2), start, 'progress below 0 clamps');
  // Monotonic: the outgoing low never comes back up mid-fade.
  let prev = 1;
  for (let p = 0; p <= 1.0001; p += 0.05) {
    const v = eqSwap(p).outLowDb;
    assert.ok(v <= prev + 1e-9, `outgoing low must only ever fall (at ${p})`);
    prev = v;
  }
}

/* ══════════════════════════════ tempoMatch ════════════════════════════════ */
{
  const m = tempoMatch(128, 124, 10);
  assert.ok(near(m.pct, (128 / 124 - 1) * 100), 'plain 3.2% pull-up');
  assert.equal(m.matched, true);
  assert.equal(m.folded, false);

  // Double-time: 140 against 70 is a legitimate half/double match at 0%.
  const dbl = tempoMatch(140, 70, 10);
  assert.ok(near(dbl.pct, 0), `octave-folded to 0%, got ${dbl.pct}`);
  assert.equal(dbl.matched, true);
  assert.equal(dbl.folded, true, 'the fold is reported, not hidden');

  // THE BUG (fix 4): 140 → 95 needs -26%; ±10% cannot do it. The old code
  // clamped silently and still flashed "BPM Sync … matched".
  const lie = tempoMatch(140, 95, 10);
  assert.equal(lie.matched, false, 'a clamped rate is NOT a match');
  assert.ok(Math.abs(lie.pct) <= 10 + 1e-9, 'the pitch still stays inside the fader range');
  assert.ok(lie.folded, '140/95 folds an octave first');
  assert.equal(tempoMatch(140, 95, 30).matched, true, 'a wider range makes the same pair matchable');

  // Unknown tempo is never a match (and never moves the pitch fader).
  for (const args of [[null, 124], [128, null], [0, 124], [128, 0], [Number.NaN, 124]] as const) {
    const r = tempoMatch(args[0] as number | null, args[1] as number | null, 10);
    assert.equal(r.matched, false, `unknown BPM ${JSON.stringify(args)} is not a match`);
    assert.equal(r.pct, 0, 'and leaves the pitch alone');
  }
  // The returned rate is the one the clamped pitch actually produces.
  assert.ok(near(tempoMatch(140, 95, 10).rate, 0.9), 'rate mirrors the CLAMPED pct, not the wish');

  // ── DJ-5: an unreachable match pulls NOTHING ─────────────────────────────
  // THE BUG, seen in the live app: a bogus 36.6 BPM detection on the incoming
  // deck. `matched` was already false and the flash already said "NOT
  // beatmatched" — but syncDeck applied `.pct`, the CLAMPED value, anyway.
  // Deck A went to +10 %, Deck B to −10 %, both parked at the rail, both
  // playing at the wrong speed for no benefit whatsoever. `appliedPct` is the
  // single number a caller may put on the fader: `pct` still reports what the
  // clamp produced, `appliedPct` is 0 unless the match is real.
  const bogus = tempoMatch(120, 36.6, 10);
  assert.equal(bogus.matched, false, '120 against 36.6 BPM is not reachable inside ±10%');
  assert.equal(bogus.appliedPct, 0, 'an unreachable match moves the pitch fader by nothing');
  assert.ok(Math.abs(bogus.pct) > 9.9, `pct still reports the clamp itself, got ${bogus.pct}`);
  // A reachable match applies exactly the pitch it computed.
  const reach = tempoMatch(128, 124, 10);
  assert.equal(reach.appliedPct, reach.pct, 'a real match applies the pitch it asked for');
  assert.equal(tempoMatch(140, 70, 10).appliedPct, 0, 'a half/double match needs no pitch at all');
  assert.equal(tempoMatch(140, 95, 10).appliedPct, 0, 'the ±10% clamp case applies nothing either');
  assert.equal(tempoMatch(140, 95, 30).appliedPct, tempoMatch(140, 95, 30).pct,
    'a wider range makes the same pair reachable, so the pitch is applied');
  assert.equal(tempoMatch(null, 124, 10).appliedPct, 0, 'unknown tempo applies nothing');
}

/* ═══════════════════════════ camelot / next track ═════════════════════════ */
{
  assert.equal(camelotCompatible('8A', '8A'), true, 'same key');
  assert.equal(camelotCompatible('8A', '9A'), true, '+1 on the ring');
  assert.equal(camelotCompatible('8A', '7A'), true, '-1 on the ring');
  assert.equal(camelotCompatible('8A', '8B'), true, 'relative major');
  assert.equal(camelotCompatible('12A', '1A'), true, 'the ring wraps 12 → 1');
  assert.equal(camelotCompatible('1A', '12A'), true, 'and back');
  assert.equal(camelotCompatible('8A', '3A'), false, 'across the wheel: clash');
  assert.equal(camelotCompatible('8A', '9B'), false, 'diagonal is not a Camelot move');
  assert.equal(camelotCompatible(null, '8A'), false, 'unknown key is never "compatible"');
  assert.equal(camelotCompatible('8A', 'nonsense'), false);

  const set = (codes: Array<string | null>) => codes.map((camelot) => ({ camelot }));
  const pick = (args: Parameters<typeof chooseNextIndex>[0]) => chooseNextIndex(args);

  // Immediate next clashes; a compatible track sits later in the set.
  assert.equal(pick({
    fromIndex: 0, candidates: set(['8A', '3A', '9A', '5A']), currentCamelot: '8A', preferHarmonic: true,
  }), 2, 'skips the clashing 3A for the harmonic 9A');
  // Immediate next already works: never reorder for its own sake.
  assert.equal(pick({
    fromIndex: 0, candidates: set(['8A', '9A', '3A', '5A']), currentCamelot: '8A', preferHarmonic: true,
  }), 1, 'a compatible next track is left exactly where the DJ put it');
  // Flag off → strict set order, always.
  assert.equal(pick({
    fromIndex: 0, candidates: set(['8A', '3A', '9A', '5A']), currentCamelot: '8A', preferHarmonic: false,
  }), 1, 'preferHarmonic off: strict order');
  // Fewer than 3 tracks left: not enough room to be choosy.
  assert.equal(pick({
    fromIndex: 1, candidates: set(['8A', '8A', '3A', '9A']), currentCamelot: '8A', preferHarmonic: true,
  }), 2, 'only 2 left: take the next one');
  // Nothing compatible anywhere ahead → strict order rather than no track.
  assert.equal(pick({
    fromIndex: 0, candidates: set(['8A', '3A', '2A', '3B']), currentCamelot: '8A', preferHarmonic: true,
  }), 1, 'no harmonic option: fall back to the set order');
  // Unknown keys never reorder anything.
  assert.equal(pick({
    fromIndex: 0, candidates: set(['8A', null, '9A']), currentCamelot: '8A', preferHarmonic: true,
  }), 1, 'an unanalysed next track is not skipped over');
  assert.equal(pick({
    fromIndex: 0, candidates: set(['8A', '3A', '9A', '5A']), currentCamelot: null, preferHarmonic: true,
  }), 1, 'unknown outgoing key: strict order');
  // End of set.
  assert.equal(pick({
    fromIndex: 2, candidates: set(['8A', '3A', '9A']), currentCamelot: '9A', preferHarmonic: true,
  }), null, 'last track: nothing follows');
  // Unknown outgoing position (track not in the set) starts from the top.
  assert.equal(pick({
    fromIndex: -1, candidates: set(['8A', '3A']), currentCamelot: null, preferHarmonic: true,
  }), 0, 'not in the set: start at the first track');
}

/* ═════════════════════════════ deckRun ═══════════════════════════════════ */
{
  assert.equal(deckRun({ playing: true, currentTime: 12, duration: 300 }), 'playing');
  assert.equal(deckRun({ playing: false, currentTime: 12, duration: 300 }), 'paused', 'mid-track and stopped: a pause');
  assert.equal(deckRun({ playing: false, currentTime: 300, duration: 300 }), 'ended', 'parked on its duration: ran out');
  assert.equal(deckRun({ playing: false, currentTime: 299.97, duration: 300 }), 'ended', 'inside the end epsilon');
  assert.equal(deckRun({ playing: false, currentTime: 0, duration: 300 }), 'paused', 'cued at the top: not ended');
  assert.equal(deckRun({ playing: false, currentTime: 0, duration: 0, hasBuffer: false }), 'ended', 'empty deck');
  assert.equal(deckRun({ playing: false, currentTime: 0, duration: 0, hasBuffer: false, decoding: true }), 'paused', 'decoding');
}

/* ════════════════════ the automix tick, replayed over time ════════════════ */
{
  // The interval's two decisions, run tick by tick the way DJView runs them:
  // planTransition while no blend runs, blendTick while one does. Deck A plays
  // track 1 (300 s, 128 BPM), deck B holds track 2 decoded and waiting.
  const beatLen = 60 / 128;
  type Deck = { playing: boolean; t: number; dur: number };
  const A: Deck = { playing: true, t: 200, dur: 300 };
  const B: Deck = { playing: false, t: 0, dur: 280 };
  let clock = 1000;
  let blend: ReturnType<typeof startBlend> | null = null;
  let current: 'A' | 'B' = 'A';
  let fader = -1;
  let incomingReady = true;
  const faderWrites: number[] = [];
  const log: string[] = [];
  const tick = (sec: number) => {
    for (let i = 0; i < Math.round(sec / 0.5); i++) {
      // Half a second passes for whatever is playing; a deck that reaches
      // its end parks there, as the engine does.
      clock += 0.5;
      for (const d of [A, B]) if (d.playing) d.t = Math.min(d.dur, d.t + 0.5);
      for (const d of [A, B]) if (d.playing && d.t >= d.dur) d.playing = false;
      const out = current === 'A' ? A : B;
      const inc = current === 'A' ? B : A;
      if (!blend) {
        const p = planTransition({
          outgoing: {
            currentTime: out.t, duration: out.dur, bpm: 128, gridAnchor: 0.5, beatLen,
            playing: out.playing, started: true, mixOut: null, downbeats: null, hasBuffer: true,
          },
          incoming: { bpm: 126, hasBuffer: incomingReady, cueIn: 0 },
          fadeSec: 10, tailSec: 18, now: clock,
        });
        if (p.start) {
          inc.t = p.cueIn; inc.playing = true;
          blend = startBlend(clock, p.immediate ? 1 : p.fadeSec, fader, current === 'A' ? 1 : -1, p.immediate);
          log.push(`${current}->${current === 'A' ? 'B' : 'A'} ${p.reason}`);
        }
      } else {
        const outRun = deckRun({ playing: out.playing, currentTime: out.t, duration: out.dur });
        const inRun = deckRun({ playing: inc.playing, currentTime: inc.t, duration: inc.dur });
        const st = blendTick(blend, clock, outRun, inRun, 1);
        blend = st.state;
        if (st.action === 'hold') continue;
        fader = st.fader;
        faderWrites.push(fader);
        if (st.action === 'finish') {
          fader = blend.fadeTo;
          faderWrites.push(fader);
          out.playing = false;
          current = current === 'A' ? 'B' : 'A';
          blend = null;
          log.push(`now ${current}`);
        }
      }
    }
  };

  // ── playing → pause → 2 s → resume continues the same track ─────────────
  tick(5);
  assert.deepEqual(log, [], 'nothing due at 205 s');
  A.playing = false; // the DJ presses pause (deck or master)
  const pausedAt = A.t;
  tick(2);
  assert.deepEqual(log, [], 'THE BUG: a pause started the next track');
  assert.equal(B.playing, false, 'the waiting deck stays silent through the pause');
  assert.equal(A.t, pausedAt, 'and deck A stays where it was paused');
  A.playing = true; // resume
  tick(2);
  assert.equal(current, 'A', 'the same track carries on');
  assert.ok(A.t > pausedAt && A.t <= pausedAt + 2 + 1e-9, `deck A resumed from ${pausedAt}, now ${A.t}`);
  assert.deepEqual(log, []);

  // ── a pause mid-blend holds the blend and never skips a track ───────────
  tick(278.5 - A.t); // the phrase line at 278 s: the blend starts
  assert.deepEqual(log, ['A->B phrase']);
  tick(3);
  const midFader = fader;
  assert.ok(midFader > -1 && midFader < 1, `mid-fade ${midFader}`);
  A.playing = false; B.playing = false; // master pause
  tick(4);
  assert.equal(fader, midFader, 'THE BUG: the fader moved while both decks were paused');
  assert.deepEqual(log, ['A->B phrase'], 'THE BUG: the paused blend was handed over');
  A.playing = true; B.playing = true; // master play resumes both
  tick(8);
  assert.deepEqual(log, ['A->B phrase', 'now B'], 'the blend finishes once, into track 2');
  assert.equal(B.playing, true, 'track 2 is playing, not skipped');
  assert.equal(fader, 1);

  // ── the rescue's fade runs its whole length, with no jump ───────────────
  // Track 2 runs out while the next track is still decoding; once it lands,
  // the rescue starts it with a 1 s fade, which the very next tick used to
  // cut off at halfway.
  A.t = 0; A.playing = false; A.dur = 300;
  B.t = 279; incomingReady = false;
  tick(1); // B reaches 280 and ends
  assert.equal(B.playing, false);
  incomingReady = true;
  faderWrites.length = 0;
  tick(0.5);
  assert.deepEqual(log.slice(-1), ['B->A outgoing-stopped'], 'dead air: the rescue starts');
  tick(0.5);
  assert.equal(current, 'B', 'THE BUG: the rescue fade was handed over at halfway');
  assert.ok(Math.abs(fader - 0) < 1e-9, `fader halfway: ${fader}`);
  tick(0.5);
  assert.equal(current, 'A', 'handed over once the fade has run');
  assert.equal(fader, -1);
  let prev = 1;
  for (const w of faderWrites) {
    assert.ok(Math.abs(w - prev) <= 1 + 1e-9, `no jump bigger than half the travel: ${faderWrites.join(', ')}`);
    prev = w;
  }
}

/* ═════════════════════════════ blendTick ═════════════════════════════════ */
{
  // The outgoing track runs out 2 s into a 10 s fade: the rest is cut over to
  // the 1 s rescue from where the fader is, and the bass swap carries on.
  const b0 = startBlend(0, 10, -1, 1, false);
  const s1 = blendTick(b0, 2, 'playing', 'playing', 1);
  assert.equal(s1.action, 'fade');
  assert.ok(Math.abs(s1.fader - -0.6) < 1e-9, `2 s in: ${s1.fader}`);
  const s2 = blendTick(s1.state, 2.5, 'ended', 'playing', 1);
  assert.equal(s2.state.rescue, true, 'cut over to the rescue');
  assert.ok(Math.abs(s2.state.fadeFrom - -0.5) < 1e-9, 'from the position the fader had reached');
  assert.ok(s2.progress >= s1.progress, 'the bass swap does not go backwards');
  const s3 = blendTick(s2.state, 3.5, 'ended', 'playing', 1);
  assert.equal(s3.action, 'finish');
  assert.equal(s3.fader, 1);
  // A paused incoming deck holds the blend, whatever the outgoing one does.
  const h = blendTick(s1.state, 5, 'playing', 'paused', 1);
  assert.equal(h.action, 'hold');
  assert.ok(Math.abs(h.state.fadeStart - 3) < 1e-9, 'the fade clock moved on by the held time');
  assert.ok(Math.abs(blendTick(h.state, 6, 'playing', 'playing', 1).fader - -0.4) < 1e-9, 'and resumes where it stopped');
  assert.equal(blendTick(s1.state, 5, 'paused', 'paused', 1).action, 'hold', 'both paused (master transport): held');
  // The DJ pauses the OUTGOING deck while the incoming one plays: a cut to
  // the new track. It finishes over the rescue length from where the fader
  // is; nothing is skipped (the incoming track is the one that stays).
  const cut = blendTick(s1.state, 2.5, 'paused', 'playing', 1);
  assert.equal(cut.state.rescue, true);
  assert.equal(cut.action, 'fade');
  assert.equal(blendTick(cut.state, 3.5, 'paused', 'playing', 1).action, 'finish');
}

/* ═══════════════════════ EQ kill vs the engine floor ══════════════════════ */
{
  // djEngine clamps EQ at DECK_EQ_FLOOR_DB (−40). The swap writes the Lo
  // knob's setting (down to −12) plus EQ_KILL_DB, so that sum must fit.
  assert.ok(EQ_KILL_DB - 12 >= -40, 'the kill below the lowest Lo setting is inside the engine floor');
  assert.equal(eqSwap(1).outLowDb, EQ_KILL_DB);
}

/* ═════════════════════ harmonic queue, replayed ═══════════════════════════ */
{
  // t1 (10A) clashes with t0 (8A) but mixes with t2 (9A), so once t2 has
  // played ahead of it, t1 is the natural next track.
  const keys: Record<string, string> = { t0: '8A', t1: '10A', t2: '9A', t3: '5A', t4: '8B', t5: '3A' };
  const set = ['t0', 't1', 't2', 't3', 't4', 't5'];
  const q = createAutomixQueue({
    order: () => set.slice(),
    camelotOf: (id) => keys[id] ?? null,
    preferHarmonic: () => true,
    prepared: () => false,
  });
  // t0 (8A) with a clash (3A) straight ahead: 9A plays next...
  assert.equal(q.nextAfter('t0'), 't2', 'the compatible track plays ahead of the clash');
  // ...and asked again on every tick, the answer does not change.
  assert.equal(q.nextAfter('t0'), 't2');
  // After t2, the track it played ahead of is still in the queue.
  assert.equal(q.nextAfter('t2'), 't1', 'THE BUG: the jumped-over track was dropped');
  assert.deepEqual(q.order(), ['t0', 't2', 't1', 't3', 't4', 't5'], 'every track still plays exactly once');
}
{
  // Computed once per track: a key that lands after the idle deck was loaded
  // does not swap it.
  const keys: Record<string, string> = { t0: '8A', t1: '3A', t2: '9A', t3: '5A' };
  const known = new Set<string>(['t0']);
  const q = createAutomixQueue({
    order: () => ['t0', 't1', 't2', 't3'],
    camelotOf: (id) => (known.has(id) ? keys[id] : null),
    preferHarmonic: () => true,
    prepared: () => false,
  });
  assert.equal(q.nextAfter('t0'), 't1', 'unknown key ahead: set order');
  known.add('t1'); known.add('t2'); known.add('t3');
  assert.equal(q.nextAfter('t0'), 't1', 'THE BUG: a key landing later swapped the track already loaded');
}
{
  // A prepared set plays as prepared; the toggle off plays in order.
  const keys: Record<string, string> = { t0: '8A', t1: '3A', t2: '9A', t3: '5A' };
  const mk = (prefer: boolean, prepared: boolean) => createAutomixQueue({
    order: () => ['t0', 't1', 't2', 't3'],
    camelotOf: (id) => keys[id],
    preferHarmonic: () => prefer,
    prepared: () => prepared,
  });
  assert.equal(mk(true, true).nextAfter('t0'), 't1', 'THE BUG: a prepared set was reordered');
  assert.equal(mk(false, false).nextAfter('t0'), 't1', 'toggle off: strict order');
  assert.equal(mk(true, false).nextAfter('t0'), 't2', 'toggle on: harmonic choice');
}
{
  // A mid-show reorder still wins over an earlier choice.
  let order = ['t0', 't1', 't2', 't3'];
  const keys: Record<string, string> = { t0: '8A', t1: '3A', t2: '9A', t3: '5A' };
  const q = createAutomixQueue({ order: () => order, camelotOf: (id) => keys[id], preferHarmonic: () => true, prepared: () => false });
  assert.equal(q.nextAfter('t0'), 't2');
  order = ['t0', 't3', 't1', 't2'];
  assert.equal(q.nextAfter('t0'), 't3', 'the DJ moved t3 up: it plays next');
}
{
  // key_confidence: a weak key never reorders.
  assert.equal(automixCamelot({ key: 'A', scale: 'minor', key_confidence: 0.8 }), '8A');
  assert.equal(automixCamelot({ key: 'A', scale: 'minor', key_confidence: KEY_CONFIDENCE_MIN - 0.01 }), null,
    'THE BUG: a low-confidence key was trusted');
  assert.equal(automixCamelot({ key: 'A', scale: 'minor', key_confidence: null }), null, 'no confidence reported: not trusted');
  assert.equal(automixCamelot({ key: null, scale: null, key_confidence: 0.9 }), null);
  assert.equal(automixCamelot(null), null);
}

console.log('djAutomixPlan: ok');
