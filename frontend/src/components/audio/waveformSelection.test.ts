// Run with: npx tsx src/components/audio/waveformSelection.test.ts
import assert from 'node:assert/strict';
import {
  ctrlDragClickModifiers,
  mergeSelection,
  pruneSelection,
  rangeSelection,
  toggleSelection,
} from './waveformSelection.ts';
import { useEditorStore } from '../../state/editorStore.ts';

// ── pruneSelection ─────────────────────────────────────────────────────────
{
  const selected = ['a', 'b', 'c'];
  assert.deepEqual(
    pruneSelection(selected, ['a', 'c']),
    ['a', 'c'],
    'drops ids whose clip is gone, keeping the survivors in order',
  );
}

{
  const selected = ['a', 'b'];
  assert.equal(
    pruneSelection(selected, ['a', 'b', 'c']),
    selected,
    'returns the SAME array when nothing was dropped — the pruning effect writes '
      + 'to the store only when the identity changes, so a fresh array here would loop',
  );
}

{
  assert.deepEqual(pruneSelection(['a'], []), [], 'everything gone clears the selection');
  assert.deepEqual(pruneSelection([], ['a']), [], 'an empty selection stays empty');
  assert.deepEqual(
    pruneSelection(['a', 'b'], new Set(['b'])),
    ['b'],
    'accepts a Set of live ids as well as an array',
  );
}

// ── toggleSelection (Ctrl/Cmd-click) ───────────────────────────────────────
{
  assert.deepEqual(
    toggleSelection(['a', 'b'], 'c'),
    ['c', 'a', 'b'],
    'adds the clicked clip FIRST so the store keeps it as selectedClipId (the '
      + 'anchor for the next shift-click), matching the old setSelected(clipId)',
  );
  assert.deepEqual(
    toggleSelection(['a', 'b', 'c'], 'b'),
    ['a', 'c'],
    'ctrl-clicking a selected clip removes it and leaves the rest in order',
  );
  assert.deepEqual(toggleSelection([], 'a'), ['a'], 'toggling into an empty selection');
  assert.deepEqual(toggleSelection(['a'], 'a'), [], 'toggling the last clip off clears it');
}

// ── rangeSelection (Shift-click) ───────────────────────────────────────────
const ordered = ['c1', 'c2', 'c3', 'c4'];

{
  assert.deepEqual(
    rangeSelection(ordered, 'c2', 'c4'),
    ['c4', 'c2', 'c3'],
    'anchor before target: the whole span, with the clicked clip leading',
  );
  assert.deepEqual(
    rangeSelection(ordered, 'c4', 'c2'),
    ['c2', 'c3', 'c4'],
    'anchor after target: the span is the same regardless of direction',
  );
  assert.deepEqual(
    rangeSelection(ordered, 'c3', 'c3'),
    ['c3'],
    'shift-clicking the anchor itself selects just that clip',
  );
  assert.equal(
    rangeSelection(ordered, 'gone', 'c2'),
    null,
    'an anchor that is no longer on the timeline means "no range" — the caller '
      + 'falls back to a plain single-clip selection',
  );
  assert.equal(rangeSelection(ordered, 'c2', 'gone'), null, 'same for an unknown target');
}

// ── mergeSelection (Shift+Ctrl-click) ──────────────────────────────────────
{
  assert.deepEqual(
    mergeSelection(['a', 'b'], ['c', 'd']),
    ['c', 'd', 'a', 'b'],
    'the new range leads so its clicked clip stays the anchor',
  );
  assert.deepEqual(
    mergeSelection(['a', 'b'], ['b', 'c']),
    ['b', 'c', 'a'],
    'ids already selected collapse instead of duplicating',
  );
  assert.deepEqual(mergeSelection([], ['a']), ['a'], 'merging into an empty selection');
  assert.deepEqual(mergeSelection(['a'], []), ['a'], 'merging nothing keeps the selection');
}

// ── ctrlDragClickModifiers (Ctrl-click that never became a drag) ──────────
{
  assert.deepEqual(
    ctrlDragClickModifiers({ shiftKey: true }),
    { ctrlKey: true, shiftKey: true },
    'Shift+Ctrl-click survives the ctrl-drag-pending detour, so the additive '
      + 'range (mergeSelection) is reachable by mouse',
  );
  assert.deepEqual(
    ctrlDragClickModifiers({ shiftKey: false }),
    { ctrlKey: true, shiftKey: false },
    'a plain Ctrl-click stays a plain toggle',
  );
  assert.deepEqual(
    ctrlDragClickModifiers({}),
    { ctrlKey: true, shiftKey: false },
    'an op recorded without the flag reads as no Shift',
  );
}

// ── through the REAL store, the way WaveformEditor composes them ───────────
// The store pins `selectedClipId` to `selectedClipIds[0]`, and `selectedClipId`
// is the anchor a shift-click ranges from. These assertions are what stops a
// future "tidy the ordering up" from silently moving the anchor to the earliest
// clip in the range — which is not where the user last clicked.
{
  const store = useEditorStore;
  const trackId = store.getState().tracks[0]!.id;
  // A clip's bytes are irrelevant here — selection maths never touches them.
  const silence = new Blob([new Uint8Array(0)], { type: 'audio/wav' });
  const mk = (label: string, startSec: number): string =>
    store.getState().addClipToTrack({
      trackId, label, startSec,
      audioBlob: silence, mimeType: 'audio/wav', sourceDuration: 1,
      offsetIntoSource: 0, durationSec: 1, color: '#888888',
    });

  const c1 = mk('one', 0);
  const c2 = mk('two', 1);
  const c3 = mk('three', 2);
  const c4 = mk('four', 3);
  const ordered = [c1, c2, c3, c4];
  const setSelectedClips = store.getState().setSelectedClips;

  // Click c2, then shift-click c4.
  setSelectedClips([c2]);
  const anchor = store.getState().selectedClipId!;
  assert.equal(anchor, c2, 'a single click makes that clip the anchor');

  setSelectedClips(rangeSelection(ordered, anchor, c4)!);
  assert.deepEqual(
    [...store.getState().selectedClipIds].sort(),
    [c2, c3, c4].sort(),
    'shift-click selects the whole span',
  );
  assert.equal(
    store.getState().selectedClipId,
    c4,
    'and the SHIFT-CLICKED clip is the new anchor, not the earliest of the span',
  );

  // Shift-click back to c1 from that anchor: the span walks left from c4.
  setSelectedClips(rangeSelection(ordered, store.getState().selectedClipId!, c1)!);
  assert.deepEqual(
    [...store.getState().selectedClipIds].sort(),
    [c1, c2, c3, c4].sort(),
    'ranging back from the moved anchor covers the clips in between',
  );
  assert.equal(store.getState().selectedClipId, c1, 'anchor follows the click again');

  // Ctrl-click c3 off, then back on.
  setSelectedClips(toggleSelection(store.getState().selectedClipIds, c3));
  assert.equal(
    store.getState().selectedClipIds.includes(c3),
    false,
    'ctrl-clicking a selected clip drops it from the selection',
  );
  setSelectedClips(toggleSelection(store.getState().selectedClipIds, c3));
  assert.equal(
    store.getState().selectedClipId,
    c3,
    'ctrl-clicking it back on makes it the anchor',
  );

  // Removing a clip out from under the selection: the store prunes it, and the
  // component's pruning pass then finds nothing left to do (same array back).
  store.getState().removeClip(c3);
  const survivors = store.getState().selectedClipIds;
  assert.equal(survivors.includes(c3), false, 'the store drops a removed clip from the selection');
  assert.equal(
    pruneSelection(survivors, store.getState().clips.map((c) => c.id)),
    survivors,
    'so the pruning effect sees the same array and does not write the store again',
  );
}

console.log('waveformSelection.test.ts: all assertions passed');
