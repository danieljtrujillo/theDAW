/**
 * EDIT's live MIDI channels, replayed from an orchestral arrangement built in
 * the editor store.
 *
 * At 8039b45 the scheduler gave tracks channels 0, 1, 2, ... in clip order on
 * the one preview synth: the tenth part landed on channel 9, which SpessaSynth
 * plays as a drum kit, parts past the sixteenth were skipped (live mode also
 * skipped their bounced audio, so they were silent), and the piano roll's lanes
 * and the arpeggiator shared those sixteen channels. Here the arrangement is
 * built with the store calls EDIT makes, and the pass is planned and scheduled
 * with the functions play() uses (planLiveMidi, liveMidiNotes). Run from
 * `frontend/`:
 *   npx tsx src/state/liveMixer.midiChannels.test.ts
 */
import assert from 'node:assert/strict';
import { useEditorStore } from './editorStore.ts';
import { liveMidiNotes, planLiveMidi, emptyLiveMidiPlan } from './liveMixer.ts';
import { DRUM_CHANNEL, EDIT_BANK_CHANNELS, bankOfChannel, localChannel } from '../lib/editChannels.ts';
import { GM_STANDARD_KIT, type GlobalVoice } from '../lib/clipProgram.ts';

function run(name: string, fn: () => void): void {
  fn();
  console.log(`  ok - ${name}`);
}

const ed = () => useEditorStore.getState();
const SOUNDFONT_ON: GlobalVoice = { useSoundfont: true, activeProgram: 1 };
const BASIC: GlobalVoice = { useSoundfont: false, activeProgram: 1 };

/** A one-bar MIDI clip on `trackId`, as EDIT's MIDI insert adds it. */
function addPart(trackId: string, note: number, instrumentProgram?: number): string {
  return ed().addClipToTrack({
    trackId,
    label: `part-${note}`,
    audioBlob: new Blob([], { type: 'audio/wav' }),
    mimeType: 'audio/wav',
    sourceDuration: 2,
    offsetIntoSource: 0,
    durationSec: 2,
    startSec: 0,
    color: '#a855f7',
    sourceKind: 'piano-roll',
    sourcePianoRoll: [{ id: `n${note}`, note, step: 0, length: 4, velocity: 100 }],
    sourceBpm: 120,
    sourceTotalSteps: 16,
    ...(instrumentProgram !== undefined ? { instrumentProgram } : {}),
  });
}

// ── The arrangement: seventeen melodic parts, each on its own track and GM
//    program (strings 40-56), and a percussion track added between them. ──────
ed().loadProject({ tracks: [], clips: [] });
const firstTrack = ed().tracks[0].id;
const melodic: Array<{ trackId: string; clipId: string; program: number }> = [];
for (let i = 0; i < 17; i += 1) {
  const trackId = i === 0 ? firstTrack : ed().addTrack({ name: `Part ${i + 1}` });
  ed().updateTrack(trackId, { instrumentProgram: 40 + i });
  melodic.push({ trackId, clipId: addPart(trackId, 60 + i), program: 40 + i });
  if (i === 4) {
    const drums = ed().addTrack({ name: 'Percussion' });
    // The drum key in the track header.
    ed().updateTrack(drums, { isPercussion: true });
    addPart(drums, 36);
  }
}
const drumsTrack = ed().tracks.find((t) => t.isPercussion)!;

const plan = planLiveMidi(ed().clips, ed().tracks, SOUNDFONT_ON);
const notes = liveMidiNotes(ed().clips, ed().tracks, plan, SOUNDFONT_ON, 0, ed().bpm);
const noteOf = (clipId: string) => {
  const n = notes.filter((x) => x.clipId === clipId);
  assert.equal(n.length, 1, `clip ${clipId} schedules its note`);
  return n[0];
};

run('the tenth melodic part plays its own instrument, not the drum channel', () => {
  const tenth = noteOf(melodic[9].clipId);
  assert.notEqual(localChannel(tenth.channel), DRUM_CHANNEL);
  assert.equal(tenth.program, melodic[9].program);
});

run('no melodic part is ever on a drum channel', () => {
  for (const m of melodic) assert.notEqual(localChannel(noteOf(m.clipId).channel), DRUM_CHANNEL, `part on track ${m.trackId}`);
});

run('parts past the sixteenth get channels on a second synth and schedule their notes', () => {
  assert.ok(plan.channels.banks >= 2, `${plan.channels.banks} banks`);
  for (const m of melodic.slice(15)) {
    const n = noteOf(m.clipId);
    assert.equal(bankOfChannel(n.channel), 1, 'on the second bank');
    assert.equal(n.program, m.program);
  }
  assert.deepEqual(plan.channels.dropped, []);
});

run('every track has a channel of its own', () => {
  const channels = [...plan.channels.channelOf.values()];
  assert.equal(new Set(channels).size, channels.length);
  assert.equal(channels.length, 18);
});

run('the percussion track plays on the drum channel with the Standard kit', () => {
  const clip = ed().clips.find((c) => c.trackId === drumsTrack.id)!;
  const n = noteOf(clip.id);
  assert.equal(localChannel(n.channel), DRUM_CHANNEL);
  assert.equal(n.program, GM_STANDARD_KIT);
  assert.equal(n.channel, DRUM_CHANNEL, 'the first percussion track takes bank 0');
});

run('with the picker on Basic, a clip with no program plays its bounce and a drum track still plays live', () => {
  const plain = ed().addTrack({ name: 'Basic part' });
  const plainClip = addPart(plain, 72);
  const basicPlan = planLiveMidi(ed().clips, ed().tracks, BASIC);
  assert.equal(basicPlan.liveClipIds.has(plainClip), false, 'no program: the bounced audio plays');
  assert.equal(basicPlan.channels.channelOf.has(plain), false, 'and it takes no channel');
  const drumClip = ed().clips.find((c) => c.trackId === drumsTrack.id)!;
  assert.equal(basicPlan.liveClipIds.has(drumClip.id), true);
  // With soundfonts on, the same clip follows the picker live.
  const onPlan = planLiveMidi(ed().clips, ed().tracks, SOUNDFONT_ON);
  assert.equal(onPlan.liveClipIds.has(plainClip), true);
  const n = liveMidiNotes(ed().clips, ed().tracks, onPlan, SOUNDFONT_ON, 0, ed().bpm).find((x) => x.clipId === plainClip)!;
  assert.equal(n.program, SOUNDFONT_ON.activeProgram);
});

run('a muted or soloed-out track schedules nothing, and a track mute keeps its channel', () => {
  ed().updateTrack(melodic[2].trackId, { mute: true });
  const p = planLiveMidi(ed().clips, ed().tracks, SOUNDFONT_ON);
  const n = liveMidiNotes(ed().clips, ed().tracks, p, SOUNDFONT_ON, 0, ed().bpm);
  assert.equal(n.some((x) => x.clipId === melodic[2].clipId), false);
  assert.equal(p.channels.channelOf.has(melodic[2].trackId), true);
  ed().updateTrack(melodic[2].trackId, { mute: false });
});

run('an empty plan plays nothing live', () => {
  const empty = emptyLiveMidiPlan();
  assert.equal(liveMidiNotes(ed().clips, ed().tracks, empty, SOUNDFONT_ON, 0, ed().bpm).length, 0);
  assert.equal(empty.channels.banks, 0);
});

run('bank channels are sixteen wide', () => {
  assert.equal(EDIT_BANK_CHANNELS, 16);
});

console.log('liveMixer.midiChannels: ok');
