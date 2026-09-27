/**
 * lib/editChannels: the live channel pool EDIT's tracks take, and the preview
 * synth's channels beside it (lib/pitchBend). Run from `frontend/`:
 *   npx tsx src/lib/editChannels.test.ts
 */
import assert from 'node:assert/strict';
import {
  DRUM_CHANNEL,
  MAX_EDIT_BANKS,
  MELODIC_BANK_CHANNELS,
  bankOfChannel,
  localChannel,
  planEditChannels,
} from './editChannels.ts';
import {
  ARP_LIVE_CHANNEL,
  DRAW_LIVE_CHANNELS,
  KEYBOARD_LIVE_CHANNEL,
  LIVE_ROLL_CHANNELS,
  PREVIEW_CHANNEL_COUNT,
  drawStrokeChannel,
} from './pitchBend.ts';

function run(name: string, fn: () => void): void {
  fn();
  console.log(`  ok - ${name}`);
}

const tracks = (n: number, drumsAt: readonly number[] = []) =>
  Array.from({ length: n }, (_, i) => ({ id: `t${i}`, percussion: drumsAt.includes(i) }));

run('melodic tracks take the fifteen non-drum channels of each bank in order', () => {
  assert.equal(MELODIC_BANK_CHANNELS.length, 15);
  assert.equal(MELODIC_BANK_CHANNELS.includes(DRUM_CHANNEL), false);
  const plan = planEditChannels(tracks(16));
  assert.deepEqual([...plan.channelOf.values()].slice(0, 10), [0, 1, 2, 3, 4, 5, 6, 7, 8, 10]);
  assert.equal(plan.channelOf.get('t15'), 16, 'the sixteenth melodic track opens bank 1');
  assert.equal(plan.banks, 2);
});

run('the n-th percussion track takes the drum channel of bank n', () => {
  const plan = planEditChannels(tracks(4, [1, 3]));
  assert.equal(plan.channelOf.get('t1'), DRUM_CHANNEL);
  assert.equal(plan.channelOf.get('t3'), 16 + DRUM_CHANNEL);
  assert.equal(plan.channelOf.get('t0'), 0);
  assert.equal(plan.channelOf.get('t2'), 1);
});

run('a track seen twice keeps its first channel', () => {
  const plan = planEditChannels([{ id: 'a', percussion: false }, { id: 'a', percussion: true }]);
  assert.equal(plan.channelOf.size, 1);
  assert.equal(plan.channelOf.get('a'), 0);
});

run('tracks past the last bank get no channel and are listed', () => {
  const plan = planEditChannels(tracks(17), 1);
  assert.equal(plan.channelOf.size, 15);
  assert.deepEqual(plan.dropped, ['t15', 't16']);
  assert.equal(planEditChannels(tracks(MAX_EDIT_BANKS * 15)).dropped.length, 0);
});

run('global channels split into bank and local channel', () => {
  assert.equal(bankOfChannel(25), 1);
  assert.equal(localChannel(25), 9);
});

run('the preview synth keeps the roll lanes, the arpeggiator and the keyboard on channels no lane shares', () => {
  assert.equal(LIVE_ROLL_CHANNELS.includes(ARP_LIVE_CHANNEL), false);
  assert.equal(LIVE_ROLL_CHANNELS.includes(DRUM_CHANNEL), false);
  assert.equal(KEYBOARD_LIVE_CHANNEL % 16 === DRUM_CHANNEL, false, 'the keyboard channel is melodic');
  assert.equal(LIVE_ROLL_CHANNELS.includes(KEYBOARD_LIVE_CHANNEL), false);
});

run('DRAW strokes one after another never play on a drum channel or a lane, arpeggiator or keyboard channel', () => {
  // At 8039b45 DRAW cycled (seq % 15) + 1 over the preview synth: the ninth
  // stroke took channel 9 and played a drum kit, and the cycle crossed the
  // roll's lanes and the arpeggiator's 15.
  const taken = new Set([...LIVE_ROLL_CHANNELS, ARP_LIVE_CHANNEL, KEYBOARD_LIVE_CHANNEL]);
  const strokes = Array.from({ length: 40 }, (_, i) => drawStrokeChannel(i));
  for (const [i, ch] of strokes.entries()) {
    assert.notEqual(ch % 16, DRUM_CHANNEL, `stroke ${i + 1} is melodic (channel ${ch})`);
    assert.equal(taken.has(ch), false, `stroke ${i + 1} has a channel of its own (channel ${ch})`);
    assert.ok(ch < PREVIEW_CHANNEL_COUNT, 'the preview synth has the channel');
  }
  assert.equal(new Set(strokes.slice(0, DRAW_LIVE_CHANNELS.length)).size, DRAW_LIVE_CHANNELS.length, 'consecutive strokes take different channels');
});

console.log('editChannels: ok');
