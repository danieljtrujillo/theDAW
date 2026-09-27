/**
 * The editor store, driven as the real zustand store.
 *
 * Two suites live here, because both sides of the branch merge wrote a file
 * with this name:
 *
 *  1. The DOCUMENT rules — how a split carries fades and stretch, what a
 *     crossfade is allowed to do, and the undo model every action obeys
 *     (`beginUndoStep` cuts the burst, a refused edit records nothing).
 *  2. The TOOL-FACING extensions — the surface `editorTools` is an imperative
 *     facade over: a multi-clip selection that keeps the single-select field
 *     usable, a time signature that is document state (it rides undo, and a
 *     load replaces it), reorder/duplicate going through the store rather than
 *     being re-implemented per caller, and NAMED snapshots sitting OUTSIDE undo
 *     — a snapshot is a bookmark you take before an experiment, and having it
 *     eat an undo step would defeat the point of taking one.
 *
 * Run: `npx tsx src/state/editorStore.test.ts`
 */
import assert from 'node:assert/strict';
import { SNAP_DIVISIONS, beginUndoStep, clipSourceSpanSec, freezeSignature, snapDivisionLabel, useEditorStore, type AudioClip, type EditorTrack } from './editorStore.ts';
import type { ChainEntry } from './effectChainStore.ts';

const st = () => useEditorStore.getState();

// A minimal clip: only the fields the operations under test read. The cast
// keeps the fixture from drifting every time an optional field is added.
const clip = (over: Partial<AudioClip> = {}): AudioClip =>
  ({
    id: 'c1',
    trackId: 't1',
    label: 'take',
    audioBlob: new Blob(),
    mimeType: 'audio/wav',
    sourceDuration: 10,
    offsetIntoSource: 0,
    durationSec: 10,
    startSec: 0,
    color: '#fff',
    fadeInSec: 0,
    fadeOutSec: 0,
    gain: 1,
    muted: false,
    ...over,
  }) as AudioClip;

// Undo reaches the master VST rack. A track's VST inserts ride inside `tracks`
// and were always undoable; the master rack lives in its own slice and used to
// be the one rack edit history could not take back.
{
  // The setup write is itself a document change, so the recorder logs it and
  // would coalesce the edit under test into the same 300 ms step. undo() pops
  // that setup step and resets the coalescing clock, so the edit under test
  // starts a fresh step.
  useEditorStore.setState({ masterVstChain: [], _undo: [], _redo: [] });
  st().undo();
  const before = st()._undo.length;
  const entry: ChainEntry = { id: 'v1', effect: 'vst3', params: {}, enabled: true };
  useEditorStore.setState({ masterVstChain: [entry] });
  assert.equal(st()._undo.length, before + 1, 'a master VST edit records an undo step');
  st().undo();
  assert.deepEqual(st().masterVstChain, [], 'undo restores the master VST rack');
  st().redo();
  assert.deepEqual(st().masterVstChain, [entry], 'redo re-applies it');
  st().undo(); // leaves lastDocChangeAt reset, so the next edit is a fresh step
}

// A split keeps each fade on the end it belongs to. The fade-in stays on the
// left half and the fade-out moves to the right half — neither half inherits
// the other's fade — and each half's fades are fitted by clampClipFades, the
// one rule that governs fades everywhere. A 3 s fade-in on a 4 s half survives
// whole, because 3 ≤ 4: the old `half / 2` cap is gone.
{
  useEditorStore.setState({ clips: [clip({ fadeInSec: 3, fadeOutSec: 3 })], selectedClipId: null });
  const rightId = st().splitClipAt('c1', 4);
  assert.ok(rightId, 'split succeeds away from the edges');
  const [left, right] = st().clips;
  assert.equal(left.id, 'c1');
  assert.equal(left.durationSec, 4);
  assert.equal(left.fadeInSec, 3, 'fade-in kept whole — it fits inside the 4 s half');
  assert.equal(left.fadeOutSec, 0, 'left half does not inherit the fade-out');
  assert.equal(right.id, rightId);
  assert.equal(right.startSec, 4);
  assert.equal(right.offsetIntoSource, 4);
  assert.equal(right.durationSec, 6);
  assert.equal(right.fadeInSec, 0, 'right half does not inherit the fade-in');
  assert.equal(right.fadeOutSec, 3, 'fade-out kept whole — it fits inside the 6 s half');
  assert.equal(st().selectedClipId, rightId);
}

// A fade LONGER than the half it lands on is cut down to that half's length —
// the clamp still bites, it just bites at the clip's edge instead of halfway.
{
  useEditorStore.setState({ clips: [clip({ fadeInSec: 8, fadeOutSec: 9 })] });
  const rightId = st().splitClipAt('c1', 3);
  assert.ok(rightId);
  const [left, right] = st().clips;
  assert.equal(left.fadeInSec, 3, 'an 8 s fade-in on a 3 s half is cut to 3 s');
  assert.equal(right.fadeOutSec, 7, 'a 9 s fade-out on a 7 s half is cut to 7 s');
}

// Splitting too close to an edge is refused and leaves the clip alone.
{
  useEditorStore.setState({ clips: [clip()] });
  assert.equal(st().splitClipAt('c1', 0.01), null);
  assert.equal(st().splitClipAt('c1', 9.99), null);
  assert.equal(st().clips.length, 1);
}

// A clip with no fades splits into two halves with no fades — never NaN.
// fadeInSec / fadeOutSec are optional on AudioClip, and Math.min(undefined, x)
// is NaN; the first version of the split-fade fix tripped on exactly that.
{
  useEditorStore.setState({ clips: [clip({ fadeInSec: undefined, fadeOutSec: undefined })] });
  const rightId = st().splitClipAt('c1', 4);
  assert.ok(rightId);
  const [left, right] = st().clips;
  for (const [name, v] of [['left.fadeInSec', left.fadeInSec], ['left.fadeOutSec', left.fadeOutSec], ['right.fadeInSec', right.fadeInSec], ['right.fadeOutSec', right.fadeOutSec]] as const) {
    assert.equal(v, 0, `${name} is 0, not NaN`);
  }
}

// A STRETCHED clip splits at a timeline point, but `offsetIntoSource` is in
// SOURCE seconds — so the seam converts through the rate. Both halves keep the
// rate, and together they still cover exactly the source the whole clip did.
{
  useEditorStore.setState({
    clips: [clip({ durationSec: 10, sourceDuration: 40, offsetIntoSource: 5, timeStretchRate: 2 })],
  });
  const wholeSpan = 20; // 10 s of timeline at rate 2
  const rightId = st().splitClipAt('c1', 4);
  assert.ok(rightId);
  const [left, right] = st().clips;
  assert.equal(left.timeStretchRate, 2, 'the left half plays at the same rate');
  assert.equal(right.timeStretchRate, 2, 'and so does the right');
  assert.equal(right.offsetIntoSource, 13, '4 s of timeline at rate 2 is 8 s of source past the 5 s offset');
  assert.equal(
    clipSourceSpanSec(left) + clipSourceSpanSec(right), wholeSpan,
    'the halves cover the whole clip, no source lost or repeated',
  );
  assert.equal(
    right.offsetIntoSource, left.offsetIntoSource + clipSourceSpanSec(left),
    'the right half starts reading where the left half stopped',
  );
}

// ── beginUndoStep ────────────────────────────────────────────────────────────
// A gesture is one undo step because the recorder coalesces changes closer than
// 300 ms — but that same rule would fold a gesture into whatever edit happened
// just before it. beginUndoStep cuts the burst so the next change starts fresh.
//
// The "within the coalescing window" half of this used to rely on the two
// `setState` calls below actually landing inside 300 ms of REAL wall-clock
// time — true on every ordinary run, but a GC pause or a loaded CI box can
// stretch a few synchronous statements past 300 ms, and the coalescing
// subscriber reads `performance.now()` directly (`editorStore.ts`'s write
// tracker), so that would flip the "records nothing new" assertion (audit
// MINOR #5 — flaked 1/15 in the batch-12 audit run). `performance.now` is
// mocked to a FROZEN instant for this block instead, so the two writes are
// unconditionally 0 ms apart and `beginUndoStep`'s own reset to `-Infinity`
// (not the clock) is what proves the boundary — no real elapsed time is load
// -bearing anywhere in this block.
{
  const realNow = performance.now.bind(performance);
  performance.now = () => 1000; // frozen: every read in this block is identical
  try {
    useEditorStore.setState({ clips: [clip()] });
    const base = st()._undo.length;
    useEditorStore.setState({ clips: [clip({ startSec: 1 })] });
    assert.equal(st()._undo.length, base, 'a change within the coalescing window records nothing new');
    beginUndoStep();
    useEditorStore.setState({ clips: [clip({ startSec: 2 })] });
    assert.equal(st()._undo.length, base + 1, 'beginUndoStep forces the next change to start a step');
  } finally {
    performance.now = realNow;
  }
}

/** Seat a fixture and report the undo depth it left behind. It deliberately
 *  does NOT cut the undo burst: each of the actions below begins its own step,
 *  so a menu action is undoable on its own however close it lands to the last
 *  edit. Anything that needed a `beginUndoStep()` here to look like one step
 *  would not be one step in the app either. */
const seat = (clips: AudioClip[]): number => {
  useEditorStore.setState({ clips, selectedClipId: null });
  return st()._undo.length;
};

// ── createCrossfade ──────────────────────────────────────────────────────────
// Two overlapping clips on one track: the earlier one fades out across the
// overlap, the later one fades in across it, both equal power, one undo step.
{
  const a = clip({ id: 'a', startSec: 0, durationSec: 10 });
  const b = clip({ id: 'b', startSec: 8, durationSec: 10 });
  const before = seat([a, b]);
  assert.equal(st().createCrossfade('a', 'b'), true, 'an overlapping pair crossfades');
  const [ca, cb] = st().clips;
  assert.equal(ca.fadeOutSec, 2, 'the earlier clip fades out across the 2 s overlap');
  assert.equal(ca.fadeOutCurve, 'equal-power');
  assert.equal(ca.fadeInSec, 0, 'its own fade-in is left alone');
  assert.equal(cb.fadeInSec, 2, 'the later clip fades in across the same 2 s');
  assert.equal(cb.fadeInCurve, 'equal-power');
  assert.equal(cb.fadeOutSec, 0, 'its own fade-out is left alone');
  assert.equal(st()._undo.length, before + 1, 'one undo step');
  st().undo();
  assert.equal(st().clips[0].fadeOutSec, 0, 'undo takes the whole crossfade back');
  assert.equal(st().clips[1].fadeInSec, 0);
}

// Each menu action begins its own undo step, so the 300 ms coalescer cannot
// swallow one into the last edit: two crossfades back to back are two steps,
// with nothing cutting the burst from outside.
{
  const before = seat([
    clip({ id: 'a', startSec: 0, durationSec: 10 }),
    clip({ id: 'b', startSec: 8, durationSec: 10 }),
  ]);
  assert.equal(st().createCrossfade('a', 'b'), true);
  assert.equal(st().createCrossfade('a', 'b'), true);
  assert.equal(st()._undo.length, before + 2, 'two actions inside 300 ms are two undo steps');
}

// The argument order is the selection's, not the timeline's: which clip fades
// out is decided by which one starts earlier.
{
  const a = clip({ id: 'a', startSec: 0, durationSec: 10 });
  const b = clip({ id: 'b', startSec: 8, durationSec: 10 });
  seat([a, b]);
  assert.equal(st().createCrossfade('b', 'a'), true);
  assert.equal(st().clips[0].fadeOutSec, 2, 'the earlier clip still fades OUT');
  assert.equal(st().clips[1].fadeInSec, 2, 'the later clip still fades IN');
}

// Clips that only touch are not a crossfade, and nothing is written.
{
  const before = seat([
    clip({ id: 'a', startSec: 0, durationSec: 8 }),
    clip({ id: 'b', startSec: 8, durationSec: 8 }),
  ]);
  assert.equal(st().createCrossfade('a', 'b'), false, 'touching clips do not overlap');
  assert.equal(st().clips[0].fadeOutSec, 0);
  assert.equal(st().clips[1].fadeInSec, 0);
  assert.equal(st()._undo.length, before, 'a refused crossfade records no undo step');
}

// Overlapping in time but on different tracks is two clips playing together,
// not a crossfade.
{
  seat([
    clip({ id: 'a', trackId: 't1', startSec: 0, durationSec: 10 }),
    clip({ id: 'b', trackId: 't2', startSec: 8, durationSec: 10 }),
  ]);
  assert.equal(st().createCrossfade('a', 'b'), false, 'different tracks never crossfade');
  assert.equal(st().clips[0].fadeOutSec, 0);
}

// A missing clip, or a clip with itself, is refused rather than throwing.
{
  seat([clip({ id: 'a', startSec: 0, durationSec: 10 })]);
  assert.equal(st().createCrossfade('a', 'gone'), false);
  assert.equal(st().createCrossfade('a', 'a'), false);
}

// The crossfade is fitted by the same clamp as every other fade: a clip already
// faded in over most of its length has no room left for a long fade-out.
{
  seat([
    clip({ id: 'a', startSec: 0, durationSec: 10, fadeInSec: 9 }),
    clip({ id: 'b', startSec: 4, durationSec: 10 }),
  ]);
  assert.equal(st().createCrossfade('a', 'b'), true);
  const [ca, cb] = st().clips;
  assert.equal(ca.fadeInSec, 9, 'the longer fade keeps its length');
  assert.equal(ca.fadeOutSec, 1, 'the 6 s crossfade is cut to the 1 s that is left');
  assert.equal(cb.fadeInSec, 6, 'the incoming clip has room for the whole overlap');
}

// ── stretchClipToFit / resetClipStretch ──────────────────────────────────────
// Dragging the edge stores a ratio; the audio is untouched and the clip's
// length on the timeline follows, because every renderer sizes itself from
// startSec + durationSec.
{
  const before = seat([clip({ id: 'a', durationSec: 10, sourceDuration: 10 })]);
  st().stretchClipToFit('a', 5);
  const c = st().clips[0];
  assert.equal(c.durationSec, 5, 'the clip now lasts 5 s');
  assert.equal(c.timeStretchRate, 2, '10 s of source into 5 s is double speed');
  assert.equal(c.stretchMode, 'repitch', 'the drag gesture is the live path');
  assert.equal(c.audioBlob, st().clips[0].audioBlob, 'nothing is re-rendered');
  assert.equal(st()._undo.length, before + 1, 'one undo step');
}

// Stretching an already-stretched clip measures against the SOURCE it covers,
// not against its current length, so the ratio never compounds.
{
  seat([clip({ id: 'a', durationSec: 5, sourceDuration: 10, timeStretchRate: 2 })]);
  st().stretchClipToFit('a', 20);
  const c = st().clips[0];
  assert.equal(c.durationSec, 20);
  assert.equal(c.timeStretchRate, 0.5, 'the same 10 s of source, now over 20 s');
}

// An 'offline' stretch is already baked into the blob, so that blob is the
// source the new ratio is measured against.
{
  seat([clip({ id: 'a', durationSec: 8, sourceDuration: 8, timeStretchRate: 3, stretchMode: 'offline' })]);
  st().stretchClipToFit('a', 4);
  assert.equal(st().clips[0].timeStretchRate, 2, 'baked audio counts as rate 1');
  assert.equal(st().clips[0].stretchMode, 'repitch');
}

// The left edge can stretch too: the clip's end stays put while its head moves.
{
  seat([clip({ id: 'a', startSec: 4, durationSec: 6, sourceDuration: 6 })]);
  st().stretchClipToFit('a', 2, 8);
  const c = st().clips[0];
  assert.equal(c.startSec, 8);
  assert.equal(c.durationSec, 2);
  assert.equal(c.timeStretchRate, 3, '6 s of source into 2 s');
  assert.equal(c.offsetIntoSource, 0, 'the clip still reads the same stretch of source');
}

// A stretch DRAG is still ONE undo step: it calls this on every pointer move,
// so it says `coalesce` and the pointer-down's single `beginUndoStep()` covers
// the whole gesture. Without it, every frame of a drag would be undoable.
{
  const before = seat([clip({ id: 'a', durationSec: 10, sourceDuration: 10 })]);
  beginUndoStep();
  st().stretchClipToFit('a', 9, undefined, { coalesce: true });
  st().stretchClipToFit('a', 8, undefined, { coalesce: true });
  st().stretchClipToFit('a', 7, undefined, { coalesce: true });
  assert.equal(st().clips[0].durationSec, 7);
  assert.equal(st()._undo.length, before + 1, 'the whole drag is one undo step');
}

// Nonsense lengths are refused instead of writing a NaN rate.
{
  seat([clip({ id: 'a', durationSec: 10, sourceDuration: 10 })]);
  st().stretchClipToFit('a', Number.NaN);
  st().stretchClipToFit('a', 0);
  st().stretchClipToFit('gone', 5);
  const c = st().clips[0];
  assert.equal(c.durationSec, 10, 'the clip is left exactly as it was');
  assert.equal(c.timeStretchRate, undefined);
}

// Reset clears the ratio AND restores the length it implied, or the clip would
// keep playing a different stretch of source at the original speed.
{
  const before = seat([clip({ id: 'a', durationSec: 5, sourceDuration: 10, timeStretchRate: 2 })]);
  st().resetClipStretch('a');
  const c = st().clips[0];
  assert.equal(c.timeStretchRate, undefined, 'the ratio is cleared');
  assert.equal(c.stretchMode, undefined, 'and the mode with it');
  assert.equal(c.durationSec, 10, 'back to the 10 s the audio actually takes');
  assert.equal(st()._undo.length, before + 1, 'one undo step of its own');
}

// Reset never claims timeline the source cannot fill.
{
  seat([clip({ id: 'a', durationSec: 9, sourceDuration: 10, offsetIntoSource: 6, timeStretchRate: 2 })]);
  st().resetClipStretch('a');
  assert.equal(st().clips[0].durationSec, 4, 'only the 4 s of source after the offset is left');
}

// ── setClipFadeCurve ─────────────────────────────────────────────────────────
{
  const before = seat([clip({ id: 'a', fadeInSec: 1, fadeOutSec: 1 })]);
  st().setClipFadeCurve('a', 'in', 'equal-power');
  assert.equal(st().clips[0].fadeInCurve, 'equal-power');
  assert.equal(st().clips[0].fadeOutCurve, undefined, 'the other end is untouched');
  assert.equal(st()._undo.length, before + 1, 'one undo step');
  st().setClipFadeCurve('a', 'out', 'exponential');
  assert.equal(st()._undo.length, before + 2, 'and the next choice is a step of its own');
  assert.equal(st().clips[0].fadeOutCurve, 'exponential');
  assert.equal(st().clips[0].fadeInCurve, 'equal-power', 'the first choice survives');
  st().setClipFadeCurve('gone', 'in', 'linear'); // no such clip: a no-op, not a throw
}

// ── freezeSignature ──────────────────────────────────────────────────────────
// The frozen master is stale as soon as anything that reaches the render
// changes. Every field the renderers read must move the signature — the ones
// T07b taught them to read (curves, stretch, warp) as much as the old ones.
{
  const track: EditorTrack = {
    id: 't1', name: 'T', nameAutoGenerated: false, volume: 1, pan: 0, mute: false, solo: false, color: '#fff',
  };
  const doc = (over: Partial<AudioClip> = {}) => ({
    clips: [clip({ ...over })],
    tracks: [track],
    masterFxChain: [] as ChainEntry[],
    masterVstChain: [] as ChainEntry[],
    bpm: 120,
  });
  const base = freezeSignature(doc());
  assert.equal(freezeSignature(doc()), base, 'the same document signs the same');

  const moved: Array<[string, Partial<AudioClip>]> = [
    ['startSec', { startSec: 1 }],
    ['durationSec', { durationSec: 9 }],
    ['offsetIntoSource', { offsetIntoSource: 1 }],
    ['fadeInSec', { fadeInSec: 1 }],
    ['fadeOutSec', { fadeOutSec: 1 }],
    ['muted', { muted: true }],
    ['gain', { gain: 0.5 }],
    ['fadeInCurve', { fadeInCurve: 'equal-power' }],
    ['fadeOutCurve', { fadeOutCurve: 'exponential' }],
    ['timeStretchRate', { timeStretchRate: 1.5 }],
    ['stretchMode', { stretchMode: 'offline' }],
    ['warpMarkers', { warpMarkers: [{ sourceSec: 1, targetSec: 2 }] }],
  ];
  for (const [name, over] of moved) {
    assert.notEqual(freezeSignature(doc(over)), base, `${name} changes the signature`);
  }
  // Derived data does not: peaks are recomputed from the audio, never rendered.
  assert.equal(freezeSignature(doc({ peaks: new Float32Array([1, 2]) })), base, 'peaks are not part of the render');
}

console.log('editorStore: ok');

/* ═══ The tool-facing extensions ═════════════════════════════════════════════
 *
 * Everything below drives the surface `editorTools` is a facade over. The
 * fixtures are its own — a seeded three-track document rather than the bare
 * `clips` array the blocks above set — so they are named apart from the ones
 * above rather than sharing them.
 */

const blob = () => new Blob(['pcm'], { type: 'audio/wav' });

/** Longer than the store's HISTORY_COALESCE_MS, so the next edit opens a new
 *  undo step instead of folding into the previous one. */
const settle = () => new Promise((r) => setTimeout(r, 340));

const seedTrack = (id: string, over: Partial<EditorTrack> = {}): EditorTrack => ({
  id,
  name: id,
  nameAutoGenerated: false,
  volume: 0.8,
  pan: 0,
  mute: false,
  solo: false,
  color: '#8b5cf6',
  ...over,
});

const seedClip = (id: string, trackId: string, over: Partial<AudioClip> = {}): AudioClip => ({
  id,
  trackId,
  label: id,
  audioBlob: blob(),
  mimeType: 'audio/wav',
  sourceDuration: 4,
  offsetIntoSource: 0,
  durationSec: 4,
  startSec: 0,
  color: '#8b5cf6',
  ...over,
});

/** A fresh three-track / three-clip document. `loadProject` resets history, so
 *  every block below starts from a known undo depth of zero. */
const seed = () => {
  useEditorStore.getState().loadProject({
    tracks: [seedTrack('t1'), seedTrack('t2'), seedTrack('t3')],
    clips: [seedClip('c1', 't1'), seedClip('c2', 't1', { startSec: 8 }), seedClip('c3', 't2')],
    bpm: 120,
  });
};

/* ── multi-select mirrors the single-select field (Unify F4) ─────────────────
 * `setSelectedClips` and `setSelectedClipIds` used to be two setters for the
 * same field, one of which forgot to filter unknown ids and the other of
 * which forgot to move the focus — exactly the kind of drift the comment on
 * `selectedClipIds` warned about. There is now one: `setSelectedClipIds`,
 * with `{ focus: true }` for the "and move the anchor" case the assistant's
 * `editor_select_clips` and `editor_select_range` need.                     */
{
  seed();
  const api = useEditorStore.getState();
  api.setSelectedClipIds(['c2', 'c3', 'c2'], { focus: true });

  const after = useEditorStore.getState();
  assert.deepEqual(after.selectedClipIds, ['c2', 'c3'], 'duplicates collapse');
  assert.equal(after.selectedClipId, 'c2', 'the first id stays readable by single-select consumers');

  after.setSelectedClipIds([], { focus: true });
  assert.deepEqual(useEditorStore.getState().selectedClipIds, []);
  assert.equal(useEditorStore.getState().selectedClipId, null, 'an empty selection clears, not strands');

  // Unknown ids are dropped, same as every other plain `setSelectedClipIds`
  // call — the old `setSelectedClips` never filtered these, which is the
  // other half of the drift this unification closes.
  useEditorStore.getState().setSelectedClipIds(['c1', 'nope'], { focus: true });
  assert.deepEqual(useEditorStore.getState().selectedClipIds, ['c1'], 'an unknown id is dropped even with focus');
  assert.equal(useEditorStore.getState().selectedClipId, 'c1');

  // `setSelected` moves the FOCUS (the marquee's anchor) and nothing else: the
  // timeline sets the whole set with plain `setSelectedClipIds` and THEN names
  // the anchor inside it, so a `setSelected` that narrowed the set would
  // collapse every marquee to one clip — which is why the default (no `focus`
  // option) leaves `selectedClipId` alone.
  useEditorStore.getState().setSelectedClipIds(['c1', 'c2']);
  useEditorStore.getState().setSelected('c2');
  assert.deepEqual(useEditorStore.getState().selectedClipIds, ['c1', 'c2'], 'the anchor does not narrow the set');
  assert.equal(useEditorStore.getState().selectedClipId, 'c2');

  useEditorStore.getState().setSelectedClipIds(['c1'], { focus: true });
  assert.deepEqual(useEditorStore.getState().selectedClipIds, ['c1']);
  assert.equal(useEditorStore.getState().selectedClipId, 'c1');
  useEditorStore.getState().setSelectedClipIds([], { focus: true });
  assert.deepEqual(useEditorStore.getState().selectedClipIds, []);
  useEditorStore.getState().setSelected(null);
  assert.equal(useEditorStore.getState().selectedClipId, null);
}

/* ── time signature: document state, validated ───────────────────────────── */
{
  seed();
  assert.deepEqual(useEditorStore.getState().timeSignature, { num: 4, den: 4 }, 'defaults to 4/4');

  useEditorStore.getState().setTimeSignature(7, 8);
  assert.deepEqual(useEditorStore.getState().timeSignature, { num: 7, den: 8 });

  // Nonsense is refused outright rather than clamped into something the caller
  // never asked for — a silently substituted meter would re-bar the whole song.
  for (const [num, den] of [[0, 4], [4, 5], [4, 0], [NaN, 4], [4.5, 4], [33, 4]] as const) {
    useEditorStore.getState().setTimeSignature(num, den);
    assert.deepEqual(
      useEditorStore.getState().timeSignature,
      { num: 7, den: 8 },
      `${num}/${den} should have been refused`,
    );
  }

  // It rides undo with the rest of the document.
  useEditorStore.getState().undo();
  assert.deepEqual(useEditorStore.getState().timeSignature, { num: 4, den: 4 });
  useEditorStore.getState().redo();
  assert.deepEqual(useEditorStore.getState().timeSignature, { num: 7, den: 8 });

  // A load carries it; a load without one keeps what is set, exactly as bpm does.
  useEditorStore.getState().loadProject({ tracks: [seedTrack('t1')], clips: [], bpm: 90, timeSignature: { num: 3, den: 4 } });
  assert.deepEqual(useEditorStore.getState().timeSignature, { num: 3, den: 4 });
  useEditorStore.getState().loadProject({ tracks: [seedTrack('t1')], clips: [] });
  assert.deepEqual(useEditorStore.getState().timeSignature, { num: 3, den: 4 });
}

/* ── reorderTracks ───────────────────────────────────────────────────────── */
{
  seed();
  useEditorStore.getState().reorderTracks(['t3', 't1', 't2']);
  assert.deepEqual(useEditorStore.getState().tracks.map((t) => t.id), ['t3', 't1', 't2']);

  // A partial list is a "move these to the front"; the rest keep their order,
  // so "put the drums on top" does not have to enumerate the whole session.
  useEditorStore.getState().reorderTracks(['t2']);
  assert.deepEqual(useEditorStore.getState().tracks.map((t) => t.id), ['t2', 't3', 't1']);

  // Unknown ids are ignored rather than dropping tracks out of the document.
  useEditorStore.getState().reorderTracks(['nope', 't1']);
  assert.deepEqual(useEditorStore.getState().tracks.map((t) => t.id), ['t1', 't2', 't3']);
  assert.equal(useEditorStore.getState().tracks.length, 3);
}

/* ── duplicateTrack deep-copies the clips ────────────────────────────────── */
{
  seed();
  const newId = useEditorStore.getState().duplicateTrack('t1');
  assert.ok(newId, 'returns the new track id');

  const api = useEditorStore.getState();
  assert.equal(api.tracks.length, 4);
  assert.equal(api.tracks[1].id, newId, 'the copy lands directly under the original');
  assert.equal(api.tracks[1].name, 't1 copy');

  const copies = api.clips.filter((c) => c.trackId === newId);
  assert.equal(copies.length, 2, 'both of t1s clips came along');
  assert.equal(copies.filter((c) => c.id === 'c1' || c.id === 'c2').length, 0, 'the copies get fresh ids');
  assert.equal(copies[0].startSec, 0);
  assert.equal(copies[1].startSec, 8, 'timeline positions are preserved');
  assert.equal(copies[0].audioBlob, api.clips[0].audioBlob, 'the audio is shared, not re-encoded');

  // A track missing from the routing graph is a SILENT track: liveMixer places
  // nodes by walking it. The copy is routed from the moment it exists, exactly
  // as `insertTrack` routes a new lane.
  assert.ok(api.routing.nodes.some((n) => n.id === newId), 'the copy has a routing node');

  // Editing a copy must not reach back into the original.
  useEditorStore.getState().updateClip(copies[0].id, { label: 'moved' });
  assert.equal(useEditorStore.getState().clips.find((c) => c.id === 'c1').label, 'c1');

  assert.equal(useEditorStore.getState().duplicateTrack('ghost'), null);
}

/* ── named snapshots sit outside undo history ────────────────────────────── */
{
  seed();
  useEditorStore.getState().takeSnapshot('before');
  assert.deepEqual(useEditorStore.getState().listSnapshots(), ['before']);
  assert.equal(useEditorStore.getState()._undo.length, 0, 'taking a snapshot is not an edit');

  useEditorStore.getState().removeClip('c1');
  useEditorStore.getState().setBpm(140);
  assert.equal(useEditorStore.getState().clips.length, 2);

  // The store folds document changes made within HISTORY_COALESCE_MS into ONE
  // undo step (so a clip drag is one step, not sixty). A test that runs in a
  // millisecond therefore has to wait if it wants two separate steps.
  await settle();

  assert.equal(useEditorStore.getState().restoreSnapshot('before'), true);
  const restored = useEditorStore.getState();
  assert.equal(restored.clips.length, 3, 'the deleted clip is back');
  assert.equal(restored.bpm, 120, 'and so is the tempo it was taken at');

  // A restore IS an edit, so it can itself be undone back to where the user was
  // standing when they asked for it.
  assert.ok(useEditorStore.getState()._undo.length > 0);
  useEditorStore.getState().undo();
  assert.equal(useEditorStore.getState().clips.length, 2);
  assert.equal(useEditorStore.getState().bpm, 140);

  assert.equal(useEditorStore.getState().restoreSnapshot('nope'), false);

  // Snapshots reference the tracks and clips of the project they were taken in,
  // so a different project must not be able to restore into them.
  useEditorStore.getState().loadProject({ tracks: [seedTrack('t1')], clips: [] });
  assert.deepEqual(useEditorStore.getState().listSnapshots(), []);
}

/* ── undo groups: one step per group, independent of the coalescing window ── */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const depth = () => useEditorStore.getState()._undo.length;
const label = (id: string) => useEditorStore.getState().clips.find((c) => c.id === id)?.label;

{
  // A user edit 50 ms before a grouped write is well inside HISTORY_COALESCE_MS,
  // so without a forced boundary the two would fold into ONE step and undoing
  // the tool would silently take the user's edit with it.
  seed();
  useEditorStore.getState().updateClip('c1', { label: 'user edit' });
  assert.equal(depth(), 1);
  await wait(50);

  const api = useEditorStore.getState();
  api.beginUndoGroup();
  api.updateClip('c2', { label: 'tool edit' });
  api.endUndoGroup();

  assert.equal(depth(), 2, 'the group opened its own step instead of joining the user edit');
  useEditorStore.getState().undo();
  assert.equal(label('c2'), 'c2', 'undo reverted the grouped write');
  assert.equal(label('c1'), 'user edit', 'and left the user edit alone');
}

{
  // A slow group — 400 ms between writes, longer than the coalescing window —
  // is still one step.
  seed();
  const api = useEditorStore.getState();
  api.beginUndoGroup();
  api.updateClip('c1', { label: 'first' });
  await wait(400);
  useEditorStore.getState().updateClip('c2', { label: 'second' });
  useEditorStore.getState().endUndoGroup();

  assert.equal(depth(), 1, 'two writes 400 ms apart, one step');
  useEditorStore.getState().undo();
  assert.equal(label('c1'), 'c1');
  assert.equal(label('c2'), 'c2', 'one undo reverted both writes');
}

{
  // The boundary is on BOTH sides: an edit 50 ms after the group ends is its own
  // step, not folded into the group's.
  seed();
  useEditorStore.getState().undoGroup(() => {
    useEditorStore.getState().updateClip('c1', { label: 'tool' });
  });
  await wait(50);
  useEditorStore.getState().updateClip('c2', { label: 'user after' });
  assert.equal(depth(), 2);
  useEditorStore.getState().undo();
  assert.equal(label('c2'), 'c2');
  assert.equal(label('c1'), 'tool', 'the group survived undoing the later edit');
}

{
  // undoGroup returns what its function returns, and nested groups are one step.
  seed();
  const out = useEditorStore.getState().undoGroup(() => {
    useEditorStore.getState().updateClip('c1', { label: 'outer' });
    return useEditorStore.getState().undoGroup(() => {
      useEditorStore.getState().updateClip('c2', { label: 'inner' });
      return 42;
    });
  });
  assert.equal(out, 42);
  assert.equal(depth(), 1, 'a nested group does not open a second step');

  // An async function keeps the group open until it settles.
  seed();
  await useEditorStore.getState().undoGroup(async () => {
    useEditorStore.getState().updateClip('c1', { label: 'a' });
    await wait(400);
    useEditorStore.getState().updateClip('c2', { label: 'b' });
  });
  assert.equal(depth(), 1, 'an awaited 400 ms gap inside an async group is still one step');
}

{
  // A throwing group still closes: afterwards edits 400 ms apart are separate
  // steps again (a group left open would have swallowed them into one).
  seed();
  assert.throws(() =>
    useEditorStore.getState().undoGroup(() => {
      useEditorStore.getState().updateClip('c1', { label: 'partial' });
      throw new Error('boom');
    }),
  /boom/);
  await wait(400);
  useEditorStore.getState().updateClip('c2', { label: 'x' });
  await wait(400);
  useEditorStore.getState().updateClip('c3', { label: 'y' });
  assert.equal(depth(), 3, 'the partial group, then two independent edits');

  // An unmatched end is a no-op rather than driving the depth negative.
  useEditorStore.getState().endUndoGroup();
  useEditorStore.getState().endUndoGroup();
  await wait(400);
  useEditorStore.getState().updateClip('c1', { label: 'z' });
  assert.equal(depth(), 4);

  // A group that writes nothing records nothing.
  useEditorStore.getState().undoGroup(() => undefined);
  assert.equal(depth(), 4);
}

// ── Structural ids are collision-safe under a synchronous burst ─────────────
// `insertTrack`, `duplicateTrack`, `addFolderFromSelectedTracks` and `addBus`
// used to build ids as `track-${Date.now()}-${random 0..999}` — two of them in
// the SAME millisecond (explode-to-stems, "insert all N stems") only had 1000
// buckets to avoid colliding in, and 300 bursts of 7 collided about 2% of the
// time. They now use the store's `uid()` (crypto.randomUUID, or a Math.random
// fallback with far more entropy than 1000 buckets).
{
  useEditorStore.setState({ tracks: [], clips: [], buses: [], _undo: [], _redo: [] });
  const ids = new Set<string>();
  for (let i = 0; i < 1000; i += 1) {
    ids.add(useEditorStore.getState().insertTrack(0));
  }
  assert.equal(ids.size, 1000, '1000 synchronous insertTrack calls produce 1000 distinct ids');
  assert.equal(useEditorStore.getState().tracks.length, 1000);

  useEditorStore.setState({ tracks: [], clips: [], buses: [], _undo: [], _redo: [] });
  const seedId = useEditorStore.getState().insertTrack(0);
  const dupIds = new Set<string>();
  for (let i = 0; i < 1000; i += 1) {
    const id = useEditorStore.getState().duplicateTrack(seedId);
    assert.ok(id, 'duplicateTrack succeeded');
    dupIds.add(id!);
  }
  assert.equal(dupIds.size, 1000, '1000 synchronous duplicateTrack calls produce 1000 distinct ids');

  useEditorStore.setState({ tracks: [], clips: [], buses: [], _undo: [], _redo: [] });
  const t1 = useEditorStore.getState().insertTrack(0);
  const folderIds = new Set<string>();
  for (let i = 0; i < 1000; i += 1) {
    const id = useEditorStore.getState().addFolderFromSelectedTracks([t1], `f${i}`);
    assert.ok(id, 'addFolderFromSelectedTracks succeeded');
    folderIds.add(id!);
  }
  assert.equal(folderIds.size, 1000, '1000 synchronous addFolderFromSelectedTracks calls produce 1000 distinct ids');

  useEditorStore.setState({ tracks: [], clips: [], buses: [], _undo: [], _redo: [] });
  const busIds = new Set<string>();
  for (let i = 0; i < 1000; i += 1) {
    busIds.add(useEditorStore.getState().addBus(`b${i}`));
  }
  assert.equal(busIds.size, 1000, '1000 synchronous addBus calls produce 1000 distinct ids');
}

// The EDIT snap menu words every division; none shows a raw id such as 1/16Q.
{
  assert.deepEqual(SNAP_DIVISIONS.map(snapDivisionLabel), [
    'Snap off',
    'Bar', '1/2', '1/4', '1/8', '1/16', '1/32', '1/64',
    '1/4 triplet', '1/8 triplet', '1/16 triplet', '1/32 triplet',
    'Quintuplet 1/16', 'Septuplet 1/16',
    'Dotted 1/4', 'Dotted 1/8', 'Dotted 1/16',
  ]);
}

console.log('editorStore extensions: ok');
