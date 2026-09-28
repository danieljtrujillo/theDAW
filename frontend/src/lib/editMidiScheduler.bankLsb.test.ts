/**
 * EDIT's live MIDI selects a roll part's whole bank: the MSB (CC 0) and, when
 * the part has one, the LSB (CC 32), the same bank select its MIDI export
 * writes (lib/arrangementMidi clipBankSelect). A file whose horn sits in bank
 * 1 / LSB 3 plays that preset live, and SpessaSynth reads both bytes when it
 * picks the preset (lib/soundfontEngine programSwitch).
 *
 * The sequence: a clip is added as a roll part lands in EDIT (its program and
 * bank on the clip, the part's bank LSB on its `sourceRollPart`), a pass is
 * planned the way play() plans it, and the scheduler is ticked; every
 * note-on hands the sink the part's LSB. Picking another instrument in EDIT
 * (which drops the clip's bank) plays it with no LSB. Then the synth side:
 * the controller messages the live synth gets before each program change:
 * CC 0 and CC 32 before every one.
 *
 *   cd frontend && npx tsx src/lib/editMidiScheduler.bankLsb.test.ts
 */
import assert from 'node:assert/strict';
import { useEditorStore } from '../state/editorStore.ts';
import { planLiveMidi } from '../state/liveMixer.ts';
import { EDIT_MIDI_TICK_MS, EditMidiScheduler, type EditMidiPass } from './editMidiScheduler.ts';
import { programSwitch } from './soundfontEngine.ts';
import type { GlobalVoice } from './clipProgram.ts';
import type { PianoNote } from '../state/pianoRollStore.ts';

const ed = () => useEditorStore.getState();
const SF: GlobalVoice = { useSoundfont: true, activeProgram: 0 };

interface On {
  ch: number;
  program: number;
  bank: number;
  bankLsb: number | undefined;
}

function play(): On[] {
  const clock = { t: 100 };
  const ons: On[] = [];
  const sched = new EditMidiScheduler({
    now: () => clock.t,
    sink: {
      noteOn: (ch, program, _midi, _vel, _t, bank, bankLsb) => ons.push({ ch, program, bank, bankLsb }),
      noteOff: () => undefined,
      wheel: () => undefined,
      wheelRange: () => undefined,
      control: () => undefined,
    },
    clips: () => ed().clips,
    tracks: () => ed().tracks,
    global: () => SF,
    projectBpm: () => ed().bpm,
  });
  const plan = planLiveMidi(ed().clips, ed().tracks, SF);
  const pass: EditMidiPass = { liveClipIds: plan.liveClipIds, channelsOf: plan.channels.channelsOf };
  sched.start(pass, 0, clock.t);
  const end = clock.t + 3;
  while (clock.t < end) {
    clock.t += EDIT_MIDI_TICK_MS / 1000;
    sched.tick();
  }
  sched.stop();
  return ons;
}

const note = (id: string, midi: number, step: number): PianoNote =>
  ({ id, note: midi, step, length: 4, velocity: 100 }) as PianoNote;

ed().loadProject({ tracks: [], clips: [] });
const trackId = ed().tracks[0].id;
const sourceRollPart = {
  doc: 'd',
  id: 'horn',
  order: 0,
  name: 'Horn',
  program: 60,
  bank: 1,
  bankLsb: 3,
  channel: 1,
  color: '#a855f7',
  mute: false,
  solo: false,
  controls: [],
};
const clipId = ed().addClipToTrack({
  trackId,
  label: 'Horn',
  audioBlob: new Blob([], { type: 'audio/wav' }),
  mimeType: 'audio/wav',
  sourceDuration: 60,
  offsetIntoSource: 0,
  durationSec: 2,
  startSec: 0,
  color: '#a855f7',
  sourceKind: 'piano-roll',
  sourcePianoRoll: [note('a', 60, 0), note('b', 64, 8)],
  sourceBpm: 120,
  sourceTotalSteps: 16,
  sourceRollPart,
});
ed().updateClip(clipId, { instrumentProgram: 60, instrumentBank: 1 });

// ── The part's program in the part's bank: MSB 1, LSB 3 on every note ──────
{
  const ons = play();
  assert.equal(ons.length, 2, 'both notes play');
  for (const on of ons) assert.deepEqual([on.program, on.bank, on.bankLsb], [60, 1, 3], 'the whole bank select');
}

// ── Another instrument picked in EDIT: bank 0 and no LSB ───────────────────
{
  ed().updateClip(clipId, { instrumentProgram: 56, instrumentBank: undefined });
  const ons = play();
  assert.equal(ons.length, 2);
  for (const on of ons) assert.deepEqual([on.program, on.bank, on.bankLsb], [56, 0, undefined], "not the part's LSB");
}

// ── The synth side: CC 0 then CC 32 before the program change ──────────────
{
  const first = programSwitch(undefined, 60, 1, 3);
  assert.deepEqual(first.controllers, [[0, 1], [32, 3]], 'MSB then LSB, as MIDI orders them');
  assert.equal(first.program, 60);
  const same = programSwitch(first.key, 60, 1, 3);
  assert.deepEqual([same.controllers, same.program], [[], null], 'a channel already there is sent nothing');
  const lsbOnly = programSwitch(first.key, 60, 1, 4);
  assert.deepEqual(lsbOnly.controllers, [[0, 1], [32, 4]], 'a new LSB selects the bank again');
  const cleared = programSwitch(first.key, 56, 0);
  assert.deepEqual(cleared.controllers, [[0, 0], [32, 0]], 'a part with no LSB clears the one the channel holds');
  // Every program change carries its whole bank select, so the preset never depends on what the channel was left with.
  const plain = programSwitch(undefined, 40, 0);
  assert.deepEqual([plain.controllers, plain.program], [[[0, 0], [32, 0]], 40], 'the General MIDI set: CC 0 and CC 32 at 0, then the program');
  const msbOnly = programSwitch(plain.key, 40, 2);
  assert.deepEqual(msbOnly.controllers, [[0, 2], [32, 0]], 'no LSB anywhere: CC 32 goes out as 0');
  const again = programSwitch(msbOnly.key, 41, 2);
  assert.deepEqual([again.controllers, again.program], [[[0, 2], [32, 0]], 41], 'a new program in the same bank still sends the bank select');
}

console.log('editMidiScheduler.bankLsb: ok');
