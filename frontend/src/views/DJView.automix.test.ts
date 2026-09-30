/**
 * DJ automix fixes from the PR #207 review, replayed against the real engine
 * on a fake AudioContext (`djEngineTestRig`) where the engine is involved.
 *
 *   - A pause is not dead air: the plan holds a paused outgoing deck, and the
 *     DJ master transport's play resumes exactly the decks its pause stopped
 *     (it used to start every deck holding a track, including the one
 *     automix had staged).
 *   - A track that really ran out (the engine's `onended`) is still rescued.
 *   - Phase sync compares decks as heard: with the incoming deck key-locked
 *     before it plays, its insert's latency is part of the phase error.
 *   - Phrase lines and cue 1 count from the first detected beat.
 *   - At overview zoom a drifting track keeps every bar line.
 *   - The "Harmonic order" toggle is a labelled, pressed-state button, and
 *     its setting persists.
 *
 * Run: `npx tsx src/views/DJView.automix.test.ts` — `npm test` discovers it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// zustand's `persist` reads `window.localStorage` at module evaluation, so a
// DOM must exist while the persisted stores load; DJView.tsx's playerStore
// import then needs `window` gone again (see DJView.dj3.test.ts).
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.localStorage = dom.window.localStorage;
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { useDjAutomixPrefs } = await import('../state/djAutomixPrefsStore.ts');
delete g.window;

const {
  masterResumeDecks, heardTime, beatPhaseError, beatMarkPositions, HarmonicOrderToggle,
} = await import('./DJView.tsx');
const djEngine = await import('../state/djEngine.ts');
const { deckRun, planTransition } = await import('../lib/djAutomixPlan.ts');
const { buildBeatgrid } = await import('../lib/beatgrid.ts');
const { installDjEngineRig } = await import('../state/djEngineTestRig.ts');

const rig = installDjEngineRig(48000);

let passed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
  await fn();
  passed += 1;
  console.log(`  ok ${name}`);
};
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

await djEngine.loadDeck('A', rig.audioUrlOf('track-1'), 'Track 1');
await djEngine.loadDeck('B', rig.audioUrlOf('track-2'), 'Track 2');
await rig.settle();

/** The plan the automix interval computes this tick, from the live engine. */
const planNow = (cur: 'A' | 'B') => {
  const cs = djEngine.getStatus(cur);
  const ns = djEngine.getStatus(cur === 'A' ? 'B' : 'A');
  return planTransition({
    outgoing: {
      currentTime: cs.currentTime, duration: cs.duration, bpm: 128, gridAnchor: 0.5, beatLen: 60 / 128,
      playing: cs.playing, started: true, mixOut: null, downbeats: null, hasBuffer: cs.hasBuffer, decoding: cs.decoding,
    },
    incoming: { bpm: 126, hasBuffer: ns.hasBuffer, cueIn: 0 },
    fadeSec: 10, tailSec: 18, now: cs.ctxTime,
  });
};

/** The DJ master transport as DJView wires it: pause remembers, play resumes. */
let masterPaused: Array<'A' | 'B'> | null = null;
const masterToggle = (automix: { current: 'A' | 'B'; blending: boolean } | null) => {
  const aPlaying = djEngine.getStatus('A').playing;
  const bPlaying = djEngine.getStatus('B').playing;
  if (aPlaying || bPlaying) {
    const paused: Array<'A' | 'B'> = [];
    if (aPlaying) { djEngine.pauseDeck('A'); paused.push('A'); }
    if (bPlaying) { djEngine.pauseDeck('B'); paused.push('B'); }
    masterPaused = paused;
    return;
  }
  const resume = masterResumeDecks({ paused: masterPaused, holds: () => true, automix });
  masterPaused = null;
  if (resume) for (const d of resume) djEngine.playDeck(d);
  else { djEngine.playDeck('A'); djEngine.playDeck('B'); }
};

console.log('automix · pause');

await test('playing, master pause, 2 s, master play: the same track carries on', async () => {
  djEngine.playDeck('A');
  rig.advance(60);
  for (let i = 0; i < 4; i++) { rig.advance(0.5); assert.equal(planNow('A').start, false, 'nothing due mid-track'); }
  const pausedAt = djEngine.getStatus('A').currentTime;
  masterToggle({ current: 'A', blending: false });
  assert.equal(djEngine.getStatus('A').playing, false);
  for (let i = 0; i < 4; i++) {
    rig.advance(0.5);
    const p = planNow('A');
    assert.equal(p.start, false, 'THE BUG: a paused deck was rescued as dead air');
    assert.equal(p.reason, 'outgoing-paused');
  }
  assert.equal(djEngine.getStatus('B').playing, false, 'the staged track never started');
  masterToggle({ current: 'A', blending: false });
  assert.equal(djEngine.getStatus('A').playing, true, 'deck A plays again');
  assert.equal(djEngine.getStatus('B').playing, false, 'THE BUG: master play also started the staged deck');
  assert.ok(near(djEngine.getStatus('A').currentTime, pausedAt), 'from where it was paused');
  rig.advance(0.5);
  assert.equal(planNow('A').start, false);
  djEngine.pauseDeck('A');
});

await test('a pause pressed on the deck, then master play, resumes only the automix deck', async () => {
  djEngine.seekDeck('A', 30);
  djEngine.playDeck('A');
  rig.advance(2);
  djEngine.pauseDeck('A'); // the deck's own button: nothing remembered
  masterPaused = null;
  masterToggle({ current: 'A', blending: false });
  assert.equal(djEngine.getStatus('A').playing, true);
  assert.equal(djEngine.getStatus('B').playing, false, 'the staged deck stays silent');
  djEngine.pauseDeck('A');
  // Mid-blend, both decks resume.
  assert.deepEqual(masterResumeDecks({ paused: null, holds: () => true, automix: { current: 'A', blending: true } }), ['A', 'B']);
  // Without automix and without a remembered pause, the old behaviour stands.
  assert.equal(masterResumeDecks({ paused: null, holds: () => true, automix: null }), null);
  // A remembered deck that no longer holds a track is not resumed.
  assert.deepEqual(masterResumeDecks({ paused: ['A', 'B'], holds: (d) => d === 'B', automix: null }), ['B']);
});

await test('a track that reaches its end is still rescued', async () => {
  djEngine.seekDeck('A', 170);
  djEngine.playDeck('A');
  rig.advance(10);
  // The source's natural end, as the engine sees it.
  rig.sources[rig.sources.length - 1].onended?.();
  const st = djEngine.getStatus('A');
  assert.equal(st.playing, false);
  assert.equal(deckRun(st), 'ended', `parked at ${st.currentTime} of ${st.duration}`);
  const p = planNow('A');
  assert.equal(p.start, true);
  assert.equal(p.reason, 'outgoing-stopped');
  djEngine.seekDeck('A', 0);
});

console.log('automix · phase by ear');

await test('an incoming deck key-locked before it plays is synced by what is heard', async () => {
  djEngine.pauseDeck('A');
  djEngine.pauseDeck('B');
  djEngine.seekDeck('A', 20);
  djEngine.seekDeck('B', 20);
  djEngine.playDeck('A');
  rig.advance(1);
  // Automix's order: key-lock, then play, then sync.
  await djEngine.setDeckKeylock('B', true);
  djEngine.seekDeck('B', djEngine.getStatus('A').currentTime);
  djEngine.playDeck('B');
  const beats = Array.from({ length: 400 }, (_, i) => i * 0.5); // 120 BPM grid
  const a = djEngine.getStatus('A');
  const b = djEngine.getStatus('B');
  assert.ok(near(a.currentTime, b.currentTime), 'same source position');
  assert.ok(near(b.latencySec - a.latencySec, rig.stretch.latency), 'but B plays its insert latency late');
  // By source position they look aligned; by ear B is 0.08 s (0.16 beat) late.
  const err = beatPhaseError(a, b, beats, beats);
  assert.ok(near(err, rig.stretch.latency / 0.5, 1e-6), `THE BUG: the phase error ignored the latency (${err})`);
  // syncDeck nudges by err × beat length; afterwards the two line up by ear.
  djEngine.nudgePhase('B', err * 0.5);
  rig.advance(4.5); // past the longest bend window
  const a2 = djEngine.getStatus('A');
  const b2 = djEngine.getStatus('B');
  assert.ok(near(heardTime(a2), heardTime(b2), 1e-6), `heard ${heardTime(a2)} vs ${heardTime(b2)}`);
  djEngine.pauseDeck('A');
  djEngine.pauseDeck('B');
  await djEngine.setDeckKeylock('B', false);
});

console.log('automix · phrase lines and cue 1');

await test('phrase lines count from the first detected beat, not the grid line nearest 0:00', () => {
  // 120 BPM, first beat after a 3.2 s intro. The grid the deck builds starts
  // at 0.2 s — six beats before the music.
  const raw = Array.from({ length: 300 }, (_, i) => 3.2 + i * 0.5);
  const grid = buildBeatgrid({ bpm: 120, beats: raw, duration: 300 })!;
  assert.ok(near(grid.beats[0], 0.2), `grid starts at ${grid.beats[0]}`);
  const plan = (anchor: number) => planTransition({
    outgoing: { currentTime: 0, duration: 300, bpm: 120, gridAnchor: anchor, beatLen: 0.5, playing: true, started: true },
    incoming: { bpm: 120, hasBuffer: true },
    fadeSec: 10, tailSec: 18, now: 0,
  });
  // Phrase = 16 beats = 8 s. From the first beat: 3.2 + 8k ≤ 282 → 275.2.
  assert.ok(near(plan(raw[0]).startAt!, 275.2), `from the first beat: ${plan(raw[0]).startAt}`);
  assert.ok(!near(plan(grid.beats[0]).startAt!, 275.2), 'the grid line nearest 0:00 lands elsewhere');
  const src = readFileSync(fileURLToPath(new URL('./DJView.tsx', import.meta.url)), 'utf8');
  assert.ok(src.includes('const outAnchor = outCtl.firstBeat ?? (outGrid && outGrid.length > 0 ? outGrid[0] : null);'),
    'the automix interval anchors phrases on firstBeat');
  assert.ok(/computeSeedCues\(\{\s*beats: gridBeats,\s*firstBeat,/.test(src), 'the cue seed gets the first detected beat');
});

console.log('automix · beatgrid');

await test('at overview zoom a drifting track keeps every bar line once its downbeats land', () => {
  // 120 BPM constant grid; the real bars run 1 % slow, so by bar 20 the
  // detected downbeat is 0.4 s off the grid.
  const beats = Array.from({ length: 480 }, (_, i) => i * 0.5);
  const dur = 240;
  const view = { viewStart: 0, viewEnd: 1, visibleFrac: 1, widthPx: 300 };
  // Before the rhythm cache lands: the every-4th-beat guess.
  const before = beatMarkPositions({ beats, downbeats: null, dur, ...view })!;
  assert.equal(before.filter((m) => m.down).length, 120);
  // Then the downbeats land.
  const downbeats = Array.from({ length: 118 }, (_, k) => k * 2 * 1.01);
  const after = beatMarkPositions({ beats, downbeats, dur, ...view })!;
  const bars = after.filter((m) => m.down);
  assert.equal(bars.length, downbeats.length, `THE BUG: only ${bars.length} of ${downbeats.length} bar lines drawn`);
  for (let k = 0; k < downbeats.length; k++) {
    assert.ok(near((bars[k].left / 100) * dur, downbeats[k], 1e-9), `bar ${k} sits on its downbeat`);
  }
  assert.ok(after.every((m) => m.down), 'overview zoom: bar lines only');
  // Zoomed in, grid ticks come back between the bars, never on top of one.
  const zoomed = beatMarkPositions({ beats, downbeats, dur, viewStart: 0, viewEnd: 1 / 16, visibleFrac: 1 / 16, widthPx: 600 })!;
  assert.ok(zoomed.some((m) => !m.down), 'ticks when zoomed');
  const lefts = zoomed.map((m) => m.left);
  for (let i = 1; i < lefts.length; i++) assert.ok(lefts[i] >= lefts[i - 1] - 1e-9, 'marks stay in time order');
});

console.log('automix · harmonic order toggle');

await test('the toggle is a labelled pressed-state button at 12px, and its setting persists', () => {
  const on = renderToStaticMarkup(React.createElement(HarmonicOrderToggle, { on: true, onToggle: () => {} }));
  assert.match(on, /^<button type="button" aria-pressed="true"/);
  assert.match(on, />Harmonic order<\/button>$/);
  assert.match(on, /text-xs font-bold/);
  const off = renderToStaticMarkup(React.createElement(HarmonicOrderToggle, { on: false, onToggle: () => {} }));
  assert.match(off, /aria-pressed="false"/);
  assert.equal(useDjAutomixPrefs.getState().preferHarmonic, true, 'on by default');
  useDjAutomixPrefs.getState().setPreferHarmonic(false);
  const stored = JSON.parse(dom.window.localStorage.getItem('thedaw.dj.automix.v1') ?? '{}');
  assert.equal(stored.state?.preferHarmonic, false, 'written to storage');
  useDjAutomixPrefs.getState().setPreferHarmonic(true);
  const src = readFileSync(fileURLToPath(new URL('./DJView.tsx', import.meta.url)), 'utf8');
  assert.ok(src.includes('preferHarmonic: () => useDjAutomixPrefs.getState().preferHarmonic'), 'the sequencer reads the toggle');
  assert.ok(!src.includes('PREFER_HARMONIC'), 'no hard-wired constant left');
});

console.log(`DJView.automix: ${passed} passed`);
