/**
 * clipRollSync — keep a roll clip's own notes (`sourceRollNotes`) in step with
 * an edit made to the notes it plays (`sourcePianoRoll`).
 *
 * EDIT and the assistant's note tools edit the played list: every note as it
 * sounds, each looping lane's repeats written out and lane ids dropped
 * (lib/rollClip playedRollNotes). "Edit in Piano Roll" loads the roll's own
 * list when the clip has one (clipRollLoad), so an edit written to the played
 * list alone vanished the next time the clip was opened. This works out the
 * roll list that unrolls to exactly the edited played list:
 *
 *   - Each played note keeps its roll note's id (a repeat is `id~k`), so the
 *     lane an edited note sits in is its roll note's lane. A new note (an id
 *     the roll never had) goes in no lane, which the roll reads as lane A.
 *   - When no lane loops, the roll list is the edited list with those lanes
 *     back on: unrolling it changes nothing.
 *   - When a lane loops and the edit left every note of that lane exactly as
 *     its loop wrote it, the lane keeps its loop and its roll notes.
 *   - When the edit changed a looping lane's notes, that lane's repeats become
 *     notes of their own and the lane stops looping (its bend is written out
 *     the same way), so it plays what the edit made of it.
 *
 * A clip bounced before the roll kept its own list (no `sourceRollNotes`) has
 * nothing to keep in step: it reopens from the played list, which already
 * holds the edit. An empty roll list (a new clip, or one whose notes were all
 * deleted) takes the edited notes, in no lane.
 *
 * Pure, so node tests load it.
 */
import type { AudioClip } from '../state/editorStore';
import { DEFAULT_LANES, sanitizeLanes, type PianoNote } from '../state/pianoRollStore';
import { laneLoop, unrollLanes, type PolyLane } from './meterMap';
import { playedRollBends, sanitizeBends, type LaneBend } from './pitchBend';

/** The clip fields the sync reads. */
export type RollSyncClip = Pick<AudioClip, 'sourcePianoRoll' | 'sourceRollNotes' | 'sourceLanes' | 'sourceBends' | 'sourceTotalSteps'>;

/** What an edit writes besides the played list. `sourceLanes` and `sourceBends` only when a lane stopped looping. */
export type RollSyncFields = Partial<Pick<AudioClip, 'sourceRollNotes' | 'sourceLanes' | 'sourceBends'>>;

/** A played note's roll note id: `a~3` is the fourth time `a` sounds. */
export const baseNoteId = (id: string): string => {
  const m = /^(.*)~\d+$/.exec(id);
  return m ? m[1] : id;
};

/** Seconds-grid equality of two 16th positions: the tolerance meterMap uses. */
const SAME_STEP = 1e-9;

/**
 * The same note, sounding the same. Timing is the step and length every note
 * carries; ticks are compared only when both notes carry them, because a note
 * tool that rebuilds notes from `{note, step, length, velocity}` (set_notes)
 * drops the ticks a step already implies, and that alone is no edit.
 */
const sameNote = (a: PianoNote, b: PianoNote): boolean =>
  a.id === b.id && a.note === b.note && a.velocity === b.velocity
  && Math.abs(a.step - b.step) <= SAME_STEP && Math.abs(a.length - b.length) <= SAME_STEP
  && (a.tick === undefined || b.tick === undefined || (a.tick === b.tick && a.ticks === b.ticks));

/**
 * The roll-side fields that make `edited` (a new played list) survive the
 * clip being reopened in the roll. `totalSteps` is the grid the edit ends
 * with. Returns {} for a clip with no roll list of its own.
 */
export function rollNotesAfterEdit(clip: RollSyncClip, edited: readonly PianoNote[], totalSteps: number): RollSyncFields {
  const own = clip.sourceRollNotes;
  if (!own) return {};
  const lanes = sanitizeLanes(clip.sourceLanes?.length ? clip.sourceLanes : DEFAULT_LANES);
  const laneOfId = new Map(own.map((n) => [n.id, n.lane]));
  const looping = new Set(lanes.filter((l) => laneLoop(l, totalSteps) !== null).map((l) => l.id));
  const laneOf = (n: PianoNote): number | undefined => laneOfId.get(baseNoteId(n.id));
  const withLane = (n: PianoNote, lane: number | undefined, id = n.id): PianoNote => {
    const { lane: _drop, ...rest } = n as PianoNote & { lane?: number };
    return lane === undefined ? { ...rest, id } : { ...rest, id, lane };
  };

  // No lane loops: the edited list, each note back in its lane.
  const loopingUsed = [...looping].filter((id) => own.some((n) => n.lane === id));
  if (loopingUsed.length === 0) return { sourceRollNotes: edited.map((n) => withLane(n, laneOf(n))) };

  // Which looping lanes the edit touched: their notes as the loop wrote them against what the edit left.
  const before = unrollLanes(own, lanes, totalSteps);
  const touched = new Set<number>();
  for (const laneId of loopingUsed) {
    const was = before.filter((n) => n.lane === laneId);
    const now = edited.filter((n) => laneOf(n) === laneId);
    const byId = new Map(now.map((n) => [n.id, n]));
    const same = was.length === now.length && was.every((w) => {
      const e = byId.get(w.id);
      return !!e && sameNote(withLane(w, undefined), withLane(e, undefined));
    });
    if (!same) touched.add(laneId);
  }

  const out: PianoNote[] = [];
  const usedIds = new Set<string>();
  const freshId = (base: string): string => {
    let id = base.replace(/~(\d+)$/, 'r$1');
    while (usedIds.has(id)) id = `${id}r`;
    return id;
  };
  // Untouched looping lanes keep their roll notes as they were.
  for (const n of own) {
    if (n.lane !== undefined && looping.has(n.lane) && !touched.has(n.lane)) { out.push({ ...n }); usedIds.add(n.id); }
  }
  for (const n of edited) {
    const lane = laneOf(n);
    if (lane !== undefined && looping.has(lane) && !touched.has(lane)) continue; // kept above, as the loop
    const id = usedIds.has(n.id) || /~\d+$/.test(n.id) ? freshId(n.id) : n.id;
    usedIds.add(id);
    out.push(withLane(n, lane, id));
  }
  out.sort((a, b) => a.step - b.step || a.note - b.note);
  if (touched.size === 0) return { sourceRollNotes: out };

  // A touched lane stops looping; its bend is written out across the clip the way it played.
  const frozen: PolyLane[] = lanes.map((l) => (touched.has(l.id) ? { ...l, cycleSteps: null, span: null } : { ...l }));
  const bends = sanitizeBends(clip.sourceBends ?? []);
  const played = playedRollBends(bends, lanes, totalSteps);
  const nextBends: LaneBend[] = bends.map((b) => (touched.has(b.lane) && played.has(b.lane)
    ? { lane: b.lane, range: b.range, points: (played.get(b.lane)?.points ?? []).map((p) => ({ ...p })) }
    : b));
  return { sourceRollNotes: out, sourceLanes: frozen, ...(clip.sourceBends ? { sourceBends: nextBends } : {}) };
}
