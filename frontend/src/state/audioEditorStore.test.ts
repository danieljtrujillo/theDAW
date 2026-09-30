/**
 * node:assert cover for the Audio Editor's clip binding. Run from `frontend/`:
 *   npx tsx src/state/audioEditorStore.test.ts
 *
 * Runs under plain node (no DOM, no localStorage): the binding is session
 * state, so the store must construct and work with nothing around it.
 */
import assert from 'node:assert/strict';

import {
  AUDIO_EDITOR_VIEW_ZOOM_DEFAULT,
  AUDIO_EDITOR_VIEW_ZOOM_MAX,
  AUDIO_EDITOR_VIEW_ZOOM_MIN,
  selectEditedClip,
  useAudioEditorStore,
} from './audioEditorStore.ts';

const ae = () => useAudioEditorStore.getState();

/* -------------------------------- defaults -------------------------------- */
{
  const s = ae();
  assert.equal(s.clipId, null, 'nothing is being edited until something opens');
  assert.equal(s.viewZoom, AUDIO_EDITOR_VIEW_ZOOM_DEFAULT);
  assert.equal(s.viewScrollSec, 0);
  assert.ok(AUDIO_EDITOR_VIEW_ZOOM_MIN > 0, 'a zoom of zero would divide by zero');
  assert.ok(AUDIO_EDITOR_VIEW_ZOOM_MAX > AUDIO_EDITOR_VIEW_ZOOM_MIN);
}

/* ------------------------------ open / close ------------------------------ */
{
  ae().openForClip('clip-a');
  assert.equal(ae().clipId, 'clip-a');

  ae().close();
  assert.equal(ae().clipId, null, 'close unbinds');

  // Closing is not destructive to the view, so reopening the same clip puts you
  // back where you were looking.
  ae().openForClip('clip-a');
  ae().setViewZoom(400);
  ae().setViewScrollSec(12);
  ae().close();
  assert.equal(ae().viewClipId, 'clip-a', 'the view still belongs to the clip it was measured against');
  ae().openForClip('clip-a');
  assert.equal(ae().viewZoom, 400, 'reopening the same clip keeps the zoom');
  assert.equal(ae().viewScrollSec, 12, 'reopening the same clip keeps the scroll');

  // A DIFFERENT clip is a different source: a scroll measured in the old one's
  // seconds means nothing in the new one.
  ae().openForClip('clip-b');
  assert.equal(ae().clipId, 'clip-b');
  assert.equal(ae().viewScrollSec, 0, 'a new clip starts at the head of its source');
  assert.equal(ae().viewZoom, AUDIO_EDITOR_VIEW_ZOOM_DEFAULT, 'a new clip starts at the default zoom');
}

/* ------------------------------ bad clip ids ------------------------------ */
{
  ae().openForClip('clip-a');
  ae().openForClip('');
  assert.equal(ae().clipId, 'clip-a', 'an empty id is not a clip and is ignored');
  ae().openForClip('   ');
  assert.equal(ae().clipId, 'clip-a', 'a blank id is ignored too');
  ae().close();
}

/* --------------------------------- zoom ----------------------------------- */
{
  ae().setViewZoom(250);
  assert.equal(ae().viewZoom, 250);

  ae().setViewZoom(AUDIO_EDITOR_VIEW_ZOOM_MAX * 10);
  assert.equal(ae().viewZoom, AUDIO_EDITOR_VIEW_ZOOM_MAX, 'zoom clamps at the top');
  ae().setViewZoom(0);
  assert.equal(ae().viewZoom, AUDIO_EDITOR_VIEW_ZOOM_MIN, 'zoom clamps at the bottom');
  ae().setViewZoom(-40);
  assert.equal(ae().viewZoom, AUDIO_EDITOR_VIEW_ZOOM_MIN, 'a negative zoom clamps, it does not flip');

  ae().setViewZoom(300);
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    ae().setViewZoom(bad);
    assert.equal(ae().viewZoom, 300, `${bad} leaves the zoom alone`);
  }
}

/* -------------------------------- scroll ---------------------------------- */
{
  ae().setViewScrollSec(3.5);
  assert.equal(ae().viewScrollSec, 3.5);
  ae().setViewScrollSec(-2);
  assert.equal(ae().viewScrollSec, 0, 'there is no source before second zero');
  ae().setViewScrollSec(7);
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
    ae().setViewScrollSec(bad);
    assert.equal(ae().viewScrollSec, 7, `${bad} leaves the scroll alone`);
  }
}

/* ------------------------- resolving the live clip ------------------------ */
{
  const clips = [{ id: 'clip-a', label: 'Vox' }, { id: 'clip-b', label: 'Drums' }];

  assert.equal(selectEditedClip(clips, null), null, 'nothing open resolves to nothing');
  assert.equal(selectEditedClip(clips, 'clip-b')?.label, 'Drums', 'an open clip resolves live');
  // The panel's "Clip no longer exists" state: the binding outlives the clip,
  // because deleting a clip is an editorStore concern that knows nothing about
  // this drawer.
  assert.equal(selectEditedClip(clips, 'clip-gone'), null, 'a deleted clip resolves to nothing');
  assert.equal(selectEditedClip([], 'clip-a'), null, 'an empty project resolves to nothing');

  // The resolved object is the live one, not a copy: the panel re-renders off
  // editorStore's own identity checks.
  assert.equal(selectEditedClip(clips, 'clip-a'), clips[0], 'the live clip is returned by reference');
}

console.log('audioEditorStore: ok');
