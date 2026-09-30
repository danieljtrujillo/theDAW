/**
 * Groove extraction — turn a reference performance (a Library song's transcribed
 * MIDI, delivered as raw Standard MIDI File bytes) into a GrooveTemplate: the
 * per-slot timing "pocket" and rhythmic-density emphasis that the virtuoso
 * humanizer applies in place of random jitter.
 *
 * Note: audio-to-MIDI transcription (basic-pitch) does not recover per-note
 * velocity, so the emphasis weights come from how often each slot is struck
 * (density), not from recorded dynamics. The timing pocket, however, is real —
 * it preserves each onset's deviation from the quantized grid.
 */
import { parseMidi } from './midi';
import { barAt, midiEventsToMeterMap, stepsPerBar } from './meterMap';
import type { GrooveTemplate } from './virtuosoTransform';

const clampDev = (v: number): number => Math.max(-0.5, Math.min(0.5, v));
const EPS = 1e-9;

/**
 * Build a groove from MIDI bytes, sized to the reference bar: the file's first
 * bar after any pickup, in its time signature (4/4 when the file has none).
 * The pocket has one slot per 16th of that bar (14 for 7/8, 24 for 12/8), or
 * one per 32nd when the bar ends on a half step (7/32), and says so in
 * `slotSteps`.
 *
 * An onset's slot is its place inside its OWN bar, measured from that bar's
 * line (a pickup counts back from bar 1), rounded to the nearest slot; its
 * deviation is the distance to that slot, so a half-step pickup or a /32 bar
 * reads its onsets from its own bar lines. An onset that rounds onto the next
 * bar line is that bar's slot 0, and a slot past the reference bar (a longer bar
 * later in the file) wraps. Returns null if the file has no notes.
 */
export function buildGrooveFromMidiBytes(buf: ArrayBuffer | Uint8Array, name: string): GrooveTemplate | null {
  const data = parseMidi(buf);
  const stepTicks = Math.max(1, data.ppq / 4); // ticks per 16th note
  const { map, pickupSteps } = midiEventsToMeterMap(data.timeSignatures ?? [], data.ppq);
  const barLen = stepsPerBar(map[0].meter);
  const slotSteps = Number.isInteger(barLen) ? 1 : 0.5;
  const slots = Math.max(1, Math.round(barLen / slotSteps));
  const devSum = new Array<number>(slots).fill(0);
  const devCount = new Array<number>(slots).fill(0);
  const hits = new Array<number>(slots).fill(0);

  let total = 0;
  for (const track of data.tracks) {
    for (const n of track.notes) {
      const stepF = n.tick / stepTicks;
      const bar = barAt(map, stepF, pickupSteps);
      const full = stepsPerBar(bar.meter);
      const pos = stepF - bar.start + (bar.bar < 0 ? full - bar.len : 0);
      const on = Math.round(pos / slotSteps);
      const index = on * slotSteps >= full - EPS ? 0 : on;
      const slot = ((index % slots) + slots) % slots;
      const dev = clampDev(pos - on * slotSteps);
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
  return { name, timing, accent, slotSteps };
}
