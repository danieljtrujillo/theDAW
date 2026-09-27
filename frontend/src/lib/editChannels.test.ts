/**
 * lib/editChannels: the live channel pool EDIT's tracks take. Run from `frontend/`:
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
import { ARP_LIVE_CHANNEL, KEYBOARD_LIVE_CHANNEL, LIVE_ROLL_CHANNELS } from './pitchBend.ts';

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

console.log('editChannels: ok');
