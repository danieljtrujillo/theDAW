/**
 * djEngine — phase bends, key-lock and the EQ floor, replayed against the
 * real engine on a fake AudioContext (`djEngineTestRig`).
 *
 * The bugs (PR #207 review):
 *   - `audiblePos` kept integrating a finished ramp at its AVERAGE rate until
 *     the timer that clears it fired, so a deck's position drifted after every
 *     phase bend and every vinyl spin-up whenever that timer ran late.
 *   - `nudgePhase` bent the full 8 % for any shift over 5 ms, and with
 *     key-lock on the insert corrected for the deck's own rate only, so the
 *     bend's pitch came through (1.3 semitones at 8 %).
 *   - A key-lock release that arrived while the stretcher was still loading
 *     for the first time was dropped, and the lock engaged with no owner.
 *   - Every key-lock engage or release re-balanced BOTH decks' delay lines,
 *     so automix locking the incoming deck swept the playing outgoing deck.
 *   - Automix cuts the bass `EQ_KILL_DB` below the DJ's own Lo setting, but
 *     `setDeckEq` clamped at −24 dB, so the kill never reached −26.
 *
 * Run: `npx tsx src/state/djEngine.transport.test.ts` — `npm test` discovers it.
 */
import assert from 'node:assert/strict';

const djEngine = await import('./djEngine.ts');
const { EQ_KILL_DB, eqSwap } = await import('../lib/djAutomixPlan.ts');
const { installDjEngineRig } = await import('./djEngineTestRig.ts');

const rig = installDjEngineRig(48000);

let passed = 0;
const test = async (name: string, fn: () => Promise<void>) => {
  await fn();
  passed += 1;
  console.log(`  ok ${name}`);
};
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

// Build deck A first, then B, so the rig's node lists are in deck order.
await djEngine.loadDeck('A', rig.audioUrlOf('track-a'), 'Track A');
await djEngine.loadDeck('B', rig.audioUrlOf('track-b'), 'Track B');
await rig.settle();
const delayA = rig.delays[0];
const delayB = rig.delays[1];
const lowA = rig.biquadGains[0];

const stopBoth = () => {
  djEngine.pauseDeck('A');
  djEngine.pauseDeck('B');
  djEngine.seekDeck('A', 0);
  djEngine.seekDeck('B', 0);
};

console.log('djEngine · transport');

await test('a finished phase bend stops integrating at its end', async () => {
  stopBoth();
  djEngine.playDeck('A');
  rig.advance(10);
  const delivered = djEngine.nudgePhase('A', 0.02);
  assert.ok(near(delivered, 0.02), `the nudge delivered ${delivered}`);
  // Three seconds on, with the timer that clears the ramp not yet run (a
  // throttled tab): the deck has played 3 s plus the 20 ms it was nudged.
  rig.advance(3);
  const pos = djEngine.getStatus('A').currentTime;
  assert.ok(near(pos, 13.02, 1e-6), `THE BUG: the deck reads ${pos.toFixed(4)} s, not 13.0200 s`);
});

await test('the bend is proportional to the phase error', async () => {
  stopBoth();
  await djEngine.setDeckKeylock('A', true);
  await rig.settle();
  djEngine.playDeck('A');
  rig.advance(5);
  const node = rig.stretch.nodes[0];
  assert.ok(node, 'deck A has a key-lock insert');
  node.schedules.length = 0;
  // 10 ms of phase: a 2 % bend across the 1 s window, not the full 8 %.
  const delivered = djEngine.nudgePhase('A', 0.01);
  assert.ok(near(delivered, 0.01), `delivered ${delivered}`);
  const semis = node.schedules.map((s) => s.semitones as number);
  assert.ok(semis.length > 2, 'THE BUG: key-lock was not told about the bend at all');
  const expectFirst = -12 * Math.log2(1.02);
  assert.ok(near(semis[0], expectFirst, 1e-3), `first correction ${semis[0]} should cancel a 2 % bend (${expectFirst})`);
  assert.ok(near(semis[semis.length - 1], 0, 1e-9), 'and the last one lands back on the deck\'s own rate');
  for (let i = 1; i < semis.length; i++) assert.ok(semis[i] >= semis[i - 1] - 1e-12, 'the correction follows the ramp down');
  // Each correction lands when the audio it corrects leaves the insert.
  const outs = node.schedules.map((s) => s.output as number);
  const now = djEngine.getStatus('A').ctxTime;
  assert.ok(near(outs[0], now + rig.stretch.latency, 1e-9), `first output time ${outs[0]}`);
  await djEngine.setDeckKeylock('A', false);
});

await test('a big phase error bends at the cap for longer, never harder', async () => {
  stopBoth();
  await djEngine.setDeckKeylock('A', true);
  djEngine.playDeck('A');
  const node = rig.stretch.nodes[0];
  node.schedules.length = 0;
  djEngine.nudgePhase('A', 0.1);
  const semis = node.schedules.map((s) => s.semitones as number);
  assert.ok(near(semis[0], -12 * Math.log2(1.08), 1e-3), `capped at 8 %: ${semis[0]}`);
  await djEngine.setDeckKeylock('A', false);
});

console.log('djEngine · key-lock');

await test('a release that lands while the stretcher first loads is honoured', async () => {
  stopBoth();
  rig.stretch.hold = true;
  const engage = djEngine.setDeckKeylock('B', true);
  await rig.settle();
  assert.equal(djEngine.getStatus('B').keylock, false, 'still loading');
  // The owner changes its mind before the load finishes (automix released
  // it, or a sync with a small pull did).
  await djEngine.setDeckKeylock('B', false);
  await rig.releaseStretch();
  await engage;
  await rig.settle();
  assert.equal(djEngine.getStatus('B').keylock, false, 'THE BUG: the lock engaged after it was released');
  // And a later engage still works.
  await djEngine.setDeckKeylock('B', true);
  assert.equal(djEngine.getStatus('B').keylock, true);
  await djEngine.setDeckKeylock('B', false);
});

await test('engaging key-lock on the waiting deck leaves the playing deck\'s delay alone', async () => {
  stopBoth();
  await djEngine.setDeckKeylock('A', false);
  await djEngine.setDeckKeylock('B', false);
  djEngine.playDeck('A');
  rig.advance(40);
  const aWrites = delayA.history.length;
  const aDelay = delayA.value;
  // Automix engages key-lock on the incoming deck before it starts it.
  await djEngine.setDeckKeylock('B', true);
  assert.equal(delayA.history.length, aWrites, `THE BUG: the playing deck's delay line was moved to ${delayA.value}`);
  assert.equal(delayA.value, aDelay);
  // The incoming deck plays its insert's latency late; the status says so,
  // so phase sync can line the two up by ear.
  assert.ok(near(djEngine.getStatus('B').latencySec, rig.stretch.latency), `B latency ${djEngine.getStatus('B').latencySec}`);
  assert.ok(near(djEngine.getStatus('A').latencySec, aDelay), 'A is unchanged');
  // B starts, the blend runs, then its lock is released with both playing.
  djEngine.playDeck('B');
  rig.advance(5);
  await djEngine.setDeckKeylock('B', false);
  assert.equal(delayA.history.length, aWrites, 'a release with both decks playing still leaves A alone');
  assert.ok(near(djEngine.getStatus('B').latencySec, djEngine.getStatus('A').latencySec), 'B lines up with A again');
  assert.ok(delayB.history.length > 0, 'B absorbed the changes');
});

await test('with nothing else playing both decks are re-balanced', async () => {
  stopBoth();
  await djEngine.setDeckKeylock('A', true);
  assert.ok(near(delayB.value, rig.stretch.latency), `B delayed to match A's insert: ${delayB.value}`);
  assert.ok(near(delayA.value, 0));
  assert.ok(near(djEngine.getStatus('A').latencySec, djEngine.getStatus('B').latencySec));
  await djEngine.setDeckKeylock('A', false);
  assert.ok(near(delayB.value, 0));
});

console.log('djEngine · EQ');

await test('the automix bass kill reaches EQ_KILL_DB below the lowest Lo setting', async () => {
  // The Lo knob goes to −12. The bass swap writes that plus the kill.
  const userLow = -12;
  djEngine.setDeckEq('A', 'low', userLow + eqSwap(1).outLowDb);
  assert.ok(near(lowA.value, userLow + EQ_KILL_DB), `THE BUG: the kill was clamped to ${lowA.value} dB`);
  djEngine.setDeckEq('A', 'low', 0 + eqSwap(1).outLowDb);
  assert.ok(near(lowA.value, EQ_KILL_DB), `a flat Lo gets the full kill, got ${lowA.value}`);
  // The user's boost range is unchanged.
  djEngine.setDeckEq('A', 'low', 24);
  assert.equal(lowA.value, 24);
  djEngine.setDeckEq('A', 'low', 30);
  assert.equal(lowA.value, 24, 'boost still stops at +24');
  djEngine.setDeckEq('A', 'low', 0);
});

console.log(`djEngine.transport: ${passed} passed`);
