/**
 * Which library entry describes an EDIT clip's audio and which holds it
 * (lib/clipAudioSource): Time/Pitch and beat match keep the clip's entry for
 * its readout and header menu, Split to stems separates the audio the clip
 * plays, and a saved result becomes the clip's entry.
 */
import assert from 'node:assert/strict';
import {
  entryBeatsFit,
  entryBpmForClip,
  entryKeyForClip,
  savedEntrySource,
  stemsEntryIdOf,
  stemsEntryPatch,
  timePitchSource,
  transposeKeyName,
  unsavedAudioSource,
  type ClipAudioSource,
} from './clipAudioSource';

// A clip dropped from the library: an entry analysed at 120 bpm in A minor.
const fromLibrary: ClipAudioSource = { libraryEntryId: 'take-1' };
const ANALYSED_BPM = 120;
const readout = (clip: ClipAudioSource) => [entryBpmForClip(clip, ANALYSED_BPM), entryKeyForClip(clip, 'A', 'minor')];

// Untouched, the clip is its entry: the analysis reads as is, the beats map
// onto it, and Split to stems separates the entry.
{
  assert.deepEqual(readout(fromLibrary), [120, 'Am']);
  assert.equal(entryBeatsFit(fromLibrary), true);
  assert.equal(stemsEntryIdOf(fromLibrary), 'take-1');
}

// Beat match to 128, tempo only. The clip keeps its entry, so the readout still
// has the key and the track header still finds the entry's style and lyrics.
{
  const patch = timePitchSource(fromLibrary, 128 / 120, 0);
  assert.equal('libraryEntryId' in patch, false, 'Time/Pitch never drops the entry');
  const matched = { ...fromLibrary, ...patch };
  assert.equal(matched.libraryEntryId, 'take-1');
  const [bpm, key] = readout(matched);
  assert.ok(Math.abs((bpm as number) - 128) < 1e-9);
  assert.equal(key, 'Am');
  // The render starts at the clip's window and runs at 128, so the entry's
  // beat list no longer maps onto it.
  assert.equal(entryBeatsFit(matched), false);
  // Split to stems has no entry holding this audio yet: it imports the render,
  // and records that entry beside the provenance entry.
  assert.equal(stemsEntryIdOf(matched), null);
  const imported = { ...matched, ...stemsEntryPatch(matched, 'render-1') };
  assert.equal(imported.libraryEntryId, 'take-1');
  assert.equal(stemsEntryIdOf(imported), 'render-1', 'a re-run hits the cache');
}

// A clip on no entry (a recording) records its import as its entry.
{
  assert.deepEqual(stemsEntryPatch({}, 'rec-1'), { libraryEntryId: 'rec-1' });
}

// Transpose: the key readout moves with the pitch, and repeated renders add up.
{
  const up2 = { ...fromLibrary, ...timePitchSource(fromLibrary, 1, 2) };
  assert.equal(entryKeyForClip(up2, 'A', 'minor'), 'Bm');
  const up5 = { ...up2, ...timePitchSource(up2, 1, 3) };
  assert.equal(up5.renderSemitones, 5);
  assert.equal(entryKeyForClip(up5, 'A', 'minor'), 'Dm');
  const down = { ...fromLibrary, ...timePitchSource(fromLibrary, 1, -1) };
  assert.equal(entryKeyForClip(down, 'C', 'major'), 'B');
}

// Stretches multiply: 1.25x then 0.8x is back at the source's tempo.
{
  const once = { ...fromLibrary, ...timePitchSource(fromLibrary, 1.25, 0) };
  const twice = { ...once, ...timePitchSource(once, 0.8, 0) };
  assert.ok(Math.abs((entryBpmForClip(twice, ANALYSED_BPM) as number) - 120) < 1e-9);
}

// A new render replaces the audio the stems entry was imported from.
{
  const rendered = { ...fromLibrary, ...timePitchSource(fromLibrary, 1, 2), stemsEntryId: 'render-1' };
  const again = { ...rendered, ...timePitchSource(rendered, 1.1, 0) };
  assert.equal(stemsEntryIdOf(again), null);
}

// An inpaint result no entry holds yet: the entry stays as provenance at the
// tempo and key the clip already had, and stems come from the result.
{
  const up2 = { ...fromLibrary, ...timePitchSource(fromLibrary, 1, 2), stemsEntryId: 'render-1' };
  const inpainted = { ...up2, ...unsavedAudioSource() };
  assert.equal(inpainted.libraryEntryId, 'take-1');
  assert.equal(entryKeyForClip(inpainted, 'A', 'minor'), 'Bm');
  assert.equal(stemsEntryIdOf(inpainted), null);
}

// Once the result is saved, its entry is the clip's entry and describes it exactly.
{
  const up2 = { ...fromLibrary, ...timePitchSource(fromLibrary, 1.1, 2), stemsEntryId: 'render-1' };
  const saved = { ...up2, ...savedEntrySource('result-1') };
  assert.equal(saved.libraryEntryId, 'result-1');
  assert.equal(stemsEntryIdOf(saved), 'result-1');
  assert.equal(entryBeatsFit(saved), true);
  assert.deepEqual(readout(saved), [120, 'Am']);
}

// Offsets on a clip that is not marked rendered are ignored.
{
  const stray: ClipAudioSource = { libraryEntryId: 'take-1', renderTempo: 2, renderSemitones: 3 };
  assert.deepEqual(readout(stray), [120, 'Am']);
}

// Nothing analysed: no readout.
{
  assert.equal(entryBpmForClip(fromLibrary, null), null);
  assert.equal(entryBpmForClip(fromLibrary, 0), null);
  assert.equal(entryKeyForClip(fromLibrary, null, 'minor'), null);
}

// Key names: the backend's sharp spelling, a flat input kept when unmoved.
{
  assert.equal(transposeKeyName('B', 1), 'C');
  assert.equal(transposeKeyName('C', -1), 'B');
  assert.equal(transposeKeyName('Bb', 2), 'C');
  assert.equal(transposeKeyName('Bb', 0), 'Bb');
  assert.equal(transposeKeyName('F#', 12), 'F#');
  assert.equal(transposeKeyName('E', -13), 'D#');
  assert.equal(transposeKeyName('H', 1), null);
}

console.log('clipAudioSource: all tests passed');
