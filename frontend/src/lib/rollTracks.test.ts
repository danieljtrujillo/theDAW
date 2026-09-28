/**
 * lib/rollTracks: the pure rules of the roll's parts: cleaning, which parts
 * sound, the live channel of every part and bent lane, the file channel of
 * every part, and the voice a part plays.
 *
 *   cd frontend && npx tsx src/lib/rollTracks.test.ts
 */
import assert from 'node:assert/strict';
import {
  MAX_ROLL_PARTS,
  audiblePartIds,
  makeRollTrack,
  nextPartName,
  partComposeInstrument,
  partFileChannels,
  partVoice,
  rollLiveChannels,
  sanitizeRollTracks,
} from './rollTracks.ts';
import { LIVE_ROLL_CHANNELS, MAX_PREVIEW_CHANNELS, liveLaneChannels, type LaneBend } from './pitchBend.ts';
import { isDrumChannel } from './pianoTrigger.ts';
import type { PolyLane } from './meterMap.ts';

const lanes: PolyLane[] = [
  { id: 0, name: 'A', cycleSteps: null },
  { id: 1, name: 'B', cycleSteps: null },
  { id: 2, name: 'C', cycleSteps: null },
];
const bends: LaneBend[] = [{ lane: 1, range: 2, points: [{ id: 'p', step: 0, value: 0.5, shape: 'linear' }] }];
const part = (id: string, channel: number | null = null) => makeRollTrack({ id, channel }, 0);

// Cleaning: a part from junk has every field in range, ids stay unique, and the list is capped.
{
  const t = makeRollTrack({ name: '   ', program: 300 as number, bank: -4, channel: 0, color: 'blue' }, 2);
  assert.deepEqual([t.name, t.program, t.bank, t.channel, t.color], ['Part 3', 127, 0, 1, '#f59e0b']);
  const list = sanitizeRollTracks([{ id: 'x' }, { id: 'x' }, {}]);
  assert.equal(list.length, 3);
  assert.equal(new Set(list.map((p) => p.id)).size, 3, 'a repeated id gets a new one');
  assert.equal(sanitizeRollTracks([]).length, 1, 'there is always one part');
  assert.equal(sanitizeRollTracks(Array.from({ length: 80 }, () => ({}))).length, MAX_ROLL_PARTS);
  assert.equal(nextPartName([{ name: 'Part 1' }, { name: 'Part 3' }]), 'Part 4', 'the next name no part has');
}

// Mute and solo.
{
  const ps = [
    { id: 'a', mute: false, solo: false },
    { id: 'b', mute: true, solo: false },
    { id: 'c', mute: false, solo: false },
  ];
  assert.deepEqual([...audiblePartIds(ps)], ['a', 'c'], 'a muted part is silent');
  assert.deepEqual([...audiblePartIds([{ ...ps[0], solo: true }, ps[1], ps[2]])], ['a'], 'a solo silences the rest');
  assert.deepEqual([...audiblePartIds([ps[0], { ...ps[1], solo: true }, ps[2]])], ['b'], 'a soloed part sounds even when muted');
}

// Live channels: the first part plays as the roll always has; every later part
// has channels of its own from 25, never a drum channel unless it is drums.
{
  const plan = rollLiveChannels([part('a'), part('b'), part('drums', 10), part('c')], lanes, bends);
  const a = plan.get('a')!;
  assert.deepEqual([...a.lanes], [...liveLaneChannels(lanes, bends)], "the first part's lanes are the roll's lane channels");
  assert.equal(a.base, LIVE_ROLL_CHANNELS[0]);
  assert.deepEqual([...a.bent], [1], "the first part's bent lane has its own channel");
  const b = plan.get('b')!;
  assert.equal(b.base, 26, 'the second part takes 26 (25 is a drum channel)');
  assert.equal(b.lanes.get(0), 26);
  assert.equal(b.lanes.get(1), 27, "its bent lane takes a channel of its own");
  assert.deepEqual([...b.bent], [1]);
  const drums = plan.get('drums')!;
  assert.equal(drums.base, 25, 'a percussion part takes a drum channel');
  assert.ok(isDrumChannel(drums.base));
  const c = plan.get('c')!;
  assert.equal(c.base, 28);
  const all = [...plan.values()].flatMap((p) => [p.base, ...p.lanes.values()]);
  assert.ok(all.every((ch) => ch < MAX_PREVIEW_CHANNELS));
  // 40 parts and a bent lane each: every melodic channel differs and none is a drum channel.
  const forty = rollLiveChannels(Array.from({ length: 40 }, (_, i) => part(`p${i}`)), lanes, bends);
  const bases = [...forty.values()].slice(1).map((p) => p.base);
  assert.equal(new Set(bases).size, 39, '39 parts after the first, 39 channels');
  assert.ok(bases.every((ch) => ch % 16 !== 9), 'none on a drum channel');
}

// File channels: a named channel is kept, a percussion part is on 9, the rest
// take free channels but 9, and past fifteen melodic parts they share.
{
  const { channels, shared } = partFileChannels([part('a'), part('b', 1), part('d', 10), part('c')]);
  assert.deepEqual([channels.get('a'), channels.get('b'), channels.get('d'), channels.get('c')], [1, 0, 9, 2]);
  assert.equal(shared.length, 0);
  const many = partFileChannels(Array.from({ length: 17 }, (_, i) => part(`p${i}`)));
  assert.ok([...many.channels.values()].every((ch) => ch !== 9), 'no melodic part on channel 10');
  assert.deepEqual(many.shared, ['p0', 'p1', 'p15', 'p16'], 'the parts past fifteen share with the first two');
}

// A part's voice: its own program, else its linked clip's, else the roll's or the picker's.
{
  const clips = [{ id: 'c1', trackId: 't1', instrumentProgram: undefined }];
  const tracks = [{ id: 't1', instrumentProgram: 33, isPercussion: undefined }];
  const global = { useSoundfont: true, activeProgram: 5 };
  assert.deepEqual(partVoice({ program: 40, channel: null }, 'c1', clips, tracks, global), { program: 40, percussion: false }, 'its own program wins');
  assert.deepEqual(partVoice({ program: null, channel: null }, 'c1', clips, tracks, global), { program: 33, percussion: false }, "its clip's track");
  assert.deepEqual(partVoice({ program: null, channel: null }, null, clips, tracks, global, 70), { program: 70, percussion: false }, "the roll's own voice");
  assert.deepEqual(partVoice({ program: null, channel: null }, null, clips, tracks, global), { program: 5, percussion: false }, "the picker's");
  assert.deepEqual(partVoice({ program: null, channel: 10 }, null, clips, tracks, global), { program: 0, percussion: true }, 'a drum part with no kit plays the Standard kit');
  assert.deepEqual(partVoice({ program: 48, channel: 10 }, null, clips, tracks, global), { program: 48, percussion: true });
  assert.deepEqual(partVoice({ program: null, channel: null }, null, clips, tracks, { useSoundfont: false, activeProgram: 5 }), { program: undefined, percussion: false }, 'on Basic, the built-in voice');
}

// What AI COMPOSE writes a part for.
{
  assert.deepEqual(partComposeInstrument({ program: null, bank: 0, channel: null, instrumentId: 'viola' }), { name: 'Viola', rangeLow: 48, rangeHigh: 88, grandStaff: false, percussion: false });
  assert.equal(partComposeInstrument({ program: 42, bank: 0, channel: null })?.name, 'Violoncello', 'a program names the registry instrument');
  assert.equal(partComposeInstrument({ program: 0, bank: 0, channel: null })?.grandStaff, true, 'the piano reads a grand staff');
  assert.equal(partComposeInstrument({ program: 0, bank: 0, channel: 10 })?.percussion, true);
  assert.equal(partComposeInstrument({ program: null, bank: 0, channel: null }), undefined, 'a part with no sound of its own writes the piano part');
}

console.log('rollTracks: ok');
