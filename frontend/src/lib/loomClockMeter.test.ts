// The LOOM engines hand the beat clock their true meter when they start and
// when a queued score swaps in: the colony's root meter (7/8 is 3.5 quarters,
// groups kept) and a lane score's `meter` directive. Driven under plain node
// with a stand-in AudioContext in place of the browser's.
import assert from 'node:assert/strict';
import { beatClock } from './beatClock.ts';
import { ColonyEngine } from './colonyEngine.ts';
import { LoomEngine } from './loomEngine.ts';
import { parseColony } from './colony.ts';
import { parseLoom } from './loomScore.ts';

class FakeNode {
  gain = { value: 1 };
  connect(): this { return this; }
  disconnect(): void { /* nothing to undo */ }
}
class FakeCtx {
  currentTime = 0;
  state = 'running';
  destination = {};
  sampleRate = 48000;
  createGain(): FakeNode { return new FakeNode(); }
  createAnalyser(): FakeNode & { fftSize: number; smoothingTimeConstant: number } {
    return Object.assign(new FakeNode(), { fftSize: 0, smoothingTimeConstant: 0 });
  }
  createMediaElementSource(): FakeNode { return new FakeNode(); }
  resume(): Promise<void> { return Promise.resolve(); }
}
class FakeAudio {
  crossOrigin = '';
  preload = '';
  addEventListener(): void { /* no media plays here */ }
}
// The modules load with no window, as under node; the engine graph is built on
// the first start, so the stand-ins go in after the imports.
const g = globalThis as unknown as Record<string, unknown>;
g.window = { AudioContext: FakeCtx, addEventListener: () => {}, removeEventListener: () => {} };
g.Audio = FakeAudio;


const hooks = { resolve: () => null, semitonesFor: () => 0 };

// A colony in 7/8 2+2+3: the clock counts 3.5 quarters a bar with the colony's
// groups, where rounding the bar to whole quarters counted 4/4.
{
  beatClock.setMeterMap([{ bar: 0, meter: { num: 4, den: 4, groups: [] } }]);
  const { score, errors } = parseColony('bpm 120\nmeter 7/8 2+2+3\n');
  assert.deepEqual(errors, []);
  const eng = new ColonyEngine(hooks);
  eng.setScore(score, { immediate: true });
  eng.start();
  try {
    assert.equal(beatClock.beatsPerBarAt(0), 3.5, 'a 7/8 bar is 3.5 quarters on the clock');
    assert.deepEqual(beatClock.meterMap, [{ bar: 0, meter: { num: 7, den: 8, groups: [2, 2, 3] } }]);
    assert.equal(beatClock.barSec(0), 1.75, 'at 120 a 7/8 bar lasts 1.75 s');
  } finally {
    eng.stop();
  }
  // 11/16 counts 2.75 quarters; 5/4 counts 5.
  for (const [text, beats] of [['meter 11/16', 2.75], ['meter 5/4', 5]] as const) {
    const e2 = new ColonyEngine(hooks);
    e2.setScore(parseColony(`bpm 100\n${text}\n`).score, { immediate: true });
    e2.start();
    try {
      assert.equal(beatClock.beatsPerBarAt(0), beats, text);
    } finally {
      e2.stop();
    }
  }
}

// A lane score with `meter 7/8 2+2+3` sets the clock's bar when it starts; one
// without the directive leaves the clock's meter alone.
{
  beatClock.setMeterMap([{ bar: 0, meter: { num: 4, den: 4, groups: [] } }]);
  const withMeter = parseLoom('bpm 120\nmeter 7/8 2+2+3\nlane d 1/16 x14\n  k . . . s . . . k . . . s .\n').score;
  const eng = new LoomEngine(hooks);
  eng.setScore(withMeter, { immediate: true });
  eng.start();
  try {
    assert.deepEqual(beatClock.meterMap, [{ bar: 0, meter: { num: 7, den: 8, groups: [2, 2, 3] } }]);
  } finally {
    eng.stop();
  }
  beatClock.setMeterMap([{ bar: 0, meter: { num: 5, den: 4, groups: [] } }]);
  const plain = parseLoom('bpm 120\nlane d 1/12 x12\n  k . . s . . k . . s . .\n').score;
  const e2 = new LoomEngine(hooks);
  e2.setScore(plain, { immediate: true });
  e2.start();
  try {
    assert.equal(beatClock.beatsPerBarAt(0), 5, 'no directive, the clock keeps its meter');
  } finally {
    e2.stop();
  }
}

console.log('loomClockMeter: ok');
