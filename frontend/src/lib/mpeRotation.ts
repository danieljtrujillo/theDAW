/**
 * mpeRotation — per-note expression played MPE-style: each note that carries
 * expression of its own (PianoNote `expr`: pressure, timbre, bend) gets a
 * channel of its own from a block of member channels, so its channel
 * pressure, CC 74 and pitch wheel move that note and no other. A channel is a
 * voice's whole world for those three messages, which is why MIDI Polyphonic
 * Expression rotates notes across channels.
 *
 * The rotation takes, for each expressive note in onset order, a member
 * channel that is free (its last note ended at or before this one starts),
 * the one that has been free longest, so a released note's tail keeps ringing
 * on its own channel as long as it can. With every member busy, the one whose
 * note ends first is shared.
 *
 * Pure, so node tests load it.
 */
import type { NoteExpression } from '../state/pianoRollStore';
import { bendValueToRaw } from './pitchBend';

/** Member channels an EDIT track rotates expressive notes across when it names no number (EditorTrack mpeChannels). */
export const MPE_DEFAULT_MEMBERS = 8;
/** The most member channels: an MPE zone's fifteen. */
export const MPE_MAX_MEMBERS = 15;
/** CC 74 (MPE's third dimension, "timbre" or "slide") at rest. */
export const TIMBRE_REST = 64;

/** A note's span in any one unit (steps, ticks or seconds). */
export interface Span {
  start: number;
  end: number;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** True when a note carries any expression of its own. */
export const hasExpression = (e: NoteExpression | undefined): e is NoteExpression =>
  !!e && (finite(e.pressure) || finite(e.timbre) || finite(e.pitchBend));

/** The member channel count a track asks for: its own number (0 turns rotation off), else MPE_DEFAULT_MEMBERS. */
export const trackMembers = (mpeChannels: number | undefined): number =>
  finite(mpeChannels) ? Math.max(0, Math.min(MPE_MAX_MEMBERS, Math.round(mpeChannels))) : MPE_DEFAULT_MEMBERS;

/** How many of `spans` sound at once at most. */
export function maxOverlap(spans: readonly Span[]): number {
  const edges: Array<[number, number]> = [];
  for (const s of spans) {
    edges.push([s.start, 1]);
    edges.push([Math.max(s.start, s.end), -1]);
  }
  // An end before a start at one time: a note that ends where the next starts does not overlap it.
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let now = 0;
  let most = 0;
  for (const [, d] of edges) {
    now += d;
    most = Math.max(most, now);
  }
  return most;
}

/** The member channels a clip needs: as many as its expressive notes overlap, at most `cap`. */
export const membersNeeded = (spans: readonly Span[], cap: number): number => Math.min(Math.max(0, cap), maxOverlap(spans));

/**
 * Each span's member channel, 0 to `members - 1` (-1 for every span when
 * there are no members), by the rotation described above.
 */
export function rotateMembers(spans: readonly Span[], members: number): number[] {
  const out = new Array<number>(spans.length).fill(-1);
  if (members <= 0) return out;
  const busyUntil = new Array<number>(members).fill(-Infinity);
  const order = spans.map((_, i) => i).sort((a, b) => spans[a].start - spans[b].start || a - b);
  for (const i of order) {
    const s = spans[i];
    let pick = -1;
    // Free members: the one free longest (its last note ended first); a fresh member counts as free longest of all.
    for (let m = 0; m < members; m += 1) {
      if (busyUntil[m] > s.start) continue;
      if (pick < 0 || busyUntil[m] < busyUntil[pick]) pick = m;
    }
    if (pick < 0) {
      // Every member sounds: share the one whose note ends first.
      pick = 0;
      for (let m = 1; m < members; m += 1) if (busyUntil[m] < busyUntil[pick]) pick = m;
    }
    out[i] = pick;
    busyUntil[pick] = Math.max(busyUntil[pick], s.end);
  }
  return out;
}

/**
 * What a note's own channel is set to just before it starts: the wheel (its
 * bend, -1..1 of the channel's range, as a 14-bit position), CC 74 (timbre
 * 0..1 as 0-127, at rest 64) and channel pressure (0..1 as 0-127).
 */
export function expressionMessages(e: NoteExpression): { wheel: number; timbre: number; pressure: number } {
  return {
    wheel: bendValueToRaw(finite(e.pitchBend) ? e.pitchBend : 0),
    timbre: finite(e.timbre) ? Math.max(0, Math.min(127, Math.round(e.timbre * 127))) : TIMBRE_REST,
    pressure: finite(e.pressure) ? Math.max(0, Math.min(127, Math.round(e.pressure * 127))) : 0,
  };
}
