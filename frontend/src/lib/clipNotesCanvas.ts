/**
 * An EDIT MIDI clip's notes drawn on a canvas the size of the part of the clip
 * in view (components/audio/WaveformEditor MidiClipNotes).
 *
 * `clipNoteLayout` turns a clip's notes into spans in seconds from the clip's
 * left edge (lib/rollClip clipNoteSpan, on the clip's own tempo map) and puts
 * them in an interval index (lib/noteIndex), once per note list and clock.
 * `paintClipNotes` then asks the index for the notes inside the visible
 * seconds only and draws each as one rect, so a forty-minute part draws the
 * few hundred notes on screen and a clip scrolled out of view draws none.
 */
import type { PianoNote } from '../state/pianoRollStore';
import { buildNoteIndex, type NoteIndex } from './noteIndex';
import { clipNoteSpan } from './rollClip';
import type { StepClock } from './rollTempo';
import type { Paint2D } from './rollCanvas';

/** A note as the clip draws it: `step` and `length` in seconds from the clip's left edge. */
export interface ClipNoteSpan {
  id: string;
  step: number;
  length: number;
  note: number;
  velocity: number;
}

export interface ClipNoteLayout {
  index: NoteIndex<ClipNoteSpan>;
  /** The pitch rows: one per semitone from `lo` to `hi`, a semitone of headroom on each side. */
  lo: number;
  hi: number;
}

const layoutCache = new WeakMap<readonly PianoNote[], { key: StepClock | number; offset: number; layout: ClipNoteLayout }>();

/** The clip's notes as spans in seconds and their pitch rows; null for a clip with no notes. Kept per note list, clock and trim. */
export function clipNoteLayout(notes: readonly PianoNote[] | undefined, timing: StepClock | number, offsetSec: number): ClipNoteLayout | null {
  if (!notes || notes.length === 0) return null;
  const hit = layoutCache.get(notes);
  if (hit && hit.key === timing && hit.offset === offsetSec) return hit.layout;
  let lo = Infinity;
  let hi = -Infinity;
  const spans: ClipNoteSpan[] = notes.map((n) => {
    const { relStart, relEnd } = clipNoteSpan(n, timing, offsetSec);
    if (n.note < lo) lo = n.note;
    if (n.note > hi) hi = n.note;
    return { id: n.id, step: relStart, length: Math.max(0, relEnd - relStart), note: n.note, velocity: n.velocity };
  });
  if (!Number.isFinite(lo)) return null;
  const layout = { index: buildNoteIndex(spans), lo: lo - 1, hi: hi + 1 };
  layoutCache.set(notes, { key: timing, offset: offsetSec, layout });
  return layout;
}

/**
 * Draws the notes of `layout` that sound between `fromPx` and `toPx` (clip px,
 * from the clip's left edge) onto a canvas covering exactly that span and
 * `height` px, in `color`, each note's strength by its velocity. The clip plays
 * `clipDur` seconds, so a note trimmed at either end draws only its played part.
 * `scale` is the backing store's device pixels per clip px (the device pixel
 * ratio times the shell's CSS zoom). Returns the notes drawn.
 */
export function paintClipNotes(
  ctx: Paint2D,
  layout: ClipNoteLayout,
  o: { zoom: number; clipDur: number; fromPx: number; toPx: number; height: number; color: string; selected: boolean; scale?: number },
): number {
  const scale = o.scale ?? 1;
  const width = Math.max(0, o.toPx - o.fromPx);
  ctx.setTransform(scale, 0, 0, scale, -o.fromPx * scale, 0);
  ctx.clearRect(o.fromPx, 0, width, o.height);
  if (!(o.zoom > 0) || width <= 0 || o.height <= 0) return 0;
  const from = Math.max(0, o.fromPx / o.zoom);
  const to = Math.min(o.clipDur, o.toPx / o.zoom);
  if (!(to > from)) return 0;
  const rows = Math.max(1, layout.hi - layout.lo);
  const rowPx = o.height / (rows + 1);
  const hPx = Math.max(rowPx - 0.005 * o.height, 0.02 * o.height);
  const base = o.selected ? 0.6 : 0.42;
  ctx.fillStyle = o.color;
  let drawn = 0;
  // A note drawn narrower than 1.5px is widened to it, so reach that far left.
  for (const n of layout.index.query(from - 1.5 / o.zoom, to)) {
    const relEnd = n.step + n.length;
    if (relEnd <= 0 || n.step >= o.clipDur) continue;
    const vStart = Math.max(0, n.step);
    const vEnd = Math.min(o.clipDur, relEnd);
    const vel = Math.max(1, Math.min(127, n.velocity));
    ctx.globalAlpha = Math.min(1, base + (vel / 127) * 0.4);
    ctx.fillRect(vStart * o.zoom, (layout.hi - n.note) * rowPx, Math.max(1.5, (vEnd - vStart) * o.zoom), hPx);
    drawn += 1;
  }
  ctx.globalAlpha = 1;
  return drawn;
}
