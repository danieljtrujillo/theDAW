/**
 * Groove extraction — turn a reference performance (a Library song's transcribed
 * MIDI, delivered as raw Standard MIDI File bytes) into a GrooveTemplate: the
 * per-16th-slot timing "pocket" and rhythmic-density emphasis that the virtuoso
 * humanizer applies in place of random jitter.
 *
 * Note: audio-to-MIDI transcription (basic-pitch) does not recover per-note
 * velocity, so the emphasis weights come from how often each slot is struck
 * (density), not from recorded dynamics. The timing pocket, however, is real —
 * it preserves each onset's deviation from the quantized grid.
 */
import { parseMidi } from './midi';
import type { GrooveTemplate } from './virtuosoTransform';

const SLOTS = 16;
const clampDev = (v: number): number => Math.max(-0.5, Math.min(0.5, v));

/**
 * Build a 16-slot groove from MIDI bytes. Returns null if the file has no notes
 * (nothing to learn a pocket from).
 */
export function buildGrooveFromMidiBytes(buf: ArrayBuffer | Uint8Array, name: string): GrooveTemplate | null {
  const data = parseMidi(buf);
  const stepTicks = Math.max(1, data.ppq / 4); // ticks per 16th note
  const devSum = new Array<number>(SLOTS).fill(0);
  const devCount = new Array<number>(SLOTS).fill(0);
  const hits = new Array<number>(SLOTS).fill(0);

  let total = 0;
  for (const track of data.tracks) {
    for (const n of track.notes) {
      const stepF = n.tick / stepTicks;
      const slot = ((Math.round(stepF) % SLOTS) + SLOTS) % SLOTS;
      const dev = clampDev(stepF - Math.round(stepF));
      devSum[slot] += dev;
      devCount[slot] += 1;
      hits[slot] += 1;
      total += 1;
    }
  }
  if (total === 0) return null;

  const timing = devSum.map((s, i) => (devCount[i] ? clampDev(s / devCount[i]) : 0));
  const maxHit = Math.max(1, ...hits);
  const accent = hits.map((h) => h / maxHit);
  return { name, timing, accent };
}
