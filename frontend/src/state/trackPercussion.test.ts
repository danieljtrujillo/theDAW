/**
 * Making a track a drum track (editorStore setTrackPercussion), replayed
 * against the real editor store.
 *
 * The sequence: the picker is on 49 Strings Ensemble (program 48), a .mid is
 * inserted into EDIT, which makes a new track and pins the picker's program on
 * it and on the clip, and then the track's drum key is pressed. At 8039b45 the
 * drum key cleared the track's program and left the clip's 48, which a drum
 * track reads as a kit number, so the part played the Orchestral kit and the
 * clip select showed "Orchestral kit", not the Standard kit the key promises.
 * Run from `frontend/`:
 *   npx tsx src/state/trackPercussion.test.ts
 */
import assert from 'node:assert/strict';
import { beginUndoStep, useEditorStore } from './editorStore.ts';
import { GM_STANDARD_KIT, clipRenderIsStale, clipVoice, type GlobalVoice } from '../lib/clipProgram.ts';

const ed = () => useEditorStore.getState();
const global: GlobalVoice = { useSoundfont: true, activeProgram: 48 };

function step(name: string, fn: () => void): void {
  fn();
  console.log(`  ok - ${name}`);
}

ed().loadProject({ tracks: [], clips: [] });
// What EDIT's MIDI insert does for a new track with the picker on 48.
const trackId = ed().addTrack({ name: 'groove.mid', instrumentProgram: 48 });
const clipId = ed().addClipToTrack({
  trackId,
  label: 'groove.mid',
  audioBlob: new Blob([new Uint8Array(8)], { type: 'audio/wav' }),
  mimeType: 'audio/wav',
  sourceDuration: 2,
  offsetIntoSource: 0,
  durationSec: 2,
  startSec: 0,
  color: '#a855f7',
  sourceKind: 'piano-roll',
  sourcePianoRoll: [{ id: 'k', note: 36, step: 0, length: 1, velocity: 100 }],
  sourceBpm: 120,
  sourceTotalSteps: 16,
  instrumentProgram: 48,
  renderedProgram: 48,
});
const track = () => ed().tracks.find((t) => t.id === trackId)!;
const clip = () => ed().clips.find((c) => c.id === clipId)!;

step('the drum key plays the part on the Standard kit', () => {
  beginUndoStep();
  const before = ed()._undo.length;
  ed().setTrackPercussion(trackId, true);
  assert.equal(track().isPercussion, true);
  assert.equal(track().instrumentProgram, undefined, 'the track starts on its default kit');
  assert.equal(clip().instrumentProgram, undefined, 'and so does its clip');
  assert.deepEqual(clipVoice(clip(), track(), global), { program: GM_STANDARD_KIT, percussion: true });
  assert.equal(clipRenderIsStale(clip(), track(), global), true, 'the melodic audio is re-rendered as drums');
  assert.equal(ed()._undo.length, before + 1, 'one undo step');
});

step('pressing it again when it is already set writes nothing', () => {
  const before = ed()._undo.length;
  const clips = ed().clips;
  ed().setTrackPercussion(trackId, true);
  assert.equal(ed()._undo.length, before);
  assert.equal(ed().clips, clips);
});

step('undo brings back the melodic track and both programs in one step', () => {
  ed().undo();
  assert.equal(track().isPercussion, undefined);
  assert.equal(track().instrumentProgram, 48);
  assert.equal(clip().instrumentProgram, 48);
});

step('making a drum track melodic clears a kit the clip held', () => {
  beginUndoStep();
  ed().setTrackPercussion(trackId, true);
  ed().updateClip(clipId, { instrumentProgram: 40 }); // the Brush kit
  beginUndoStep();
  ed().setTrackPercussion(trackId, false);
  assert.equal(track().isPercussion, undefined);
  assert.equal(clip().instrumentProgram, undefined, 'kit 40 is not read as program 40, a violin');
  assert.deepEqual(clipVoice(clip(), track(), global), { program: 48, percussion: false }, 'the clip follows the picker');
});

console.log('trackPercussion: ok');
