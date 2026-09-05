/**
 * Pure schedule math for the note highway: turns a `gantasmo.notechart` into a
 * time-sorted list of items whose position on the highway is a function of
 * song time only (`zForTime`). No three.js, no DOM, so it runs under node for
 * the tests and in the render loop without allocations.
 *
 * Skins:
 *   - 'notation'  every event of the visible parts (rests dimmed, graces
 *                 dropped); one lane per visible part, glyph = the chart's
 *                 SMuFL codepoint, y = staff step.
 *   - 'blocks'    exactly what the Beat Saber export contains: candidates with
 *                 `bsMinDifficulty` in [0, difficulty] from visible pitched
 *                 parts, on the 4x3 grid the fields describe.
 *   - 'drums'     Rock Band order, left to right: kick (a wide bar across all
 *                 lanes), snare, hi-hat, tom, crash/ride. Only unpitched
 *                 events of visible percussion parts with a `drumVoice`.
 */

import {
  isHitBearing,
  NOTEHEAD_BLACK_CODEPOINT,
  NOTEHEAD_CIRCLE_X_CODEPOINT,
  type ChartEvent,
  type NoteChart,
} from '../../../../lib/notechart';

export type HighwaySkin = 'notation' | 'blocks' | 'drums';

export interface HighwayLayout {
  /** World units between adjacent part lanes (notation skin). */
  laneSpacing: number;
  /** World units per staff step (notation skin). */
  stepHeight: number;
  /** Staff 2 of a grand staff sits this much lower. */
  staffDrop: number;
  /** Staff step a rest is drawn on. */
  restStep: number;
}

export const DEFAULT_LAYOUT: HighwayLayout = {
  laneSpacing: 1.2,
  stepHeight: 0.06,
  staffDrop: 0.6,
  restStep: 4,
};

/** Beat Saber grid geometry used by the blocks skin: 4 lines x 3 layers. */
export const BLOCK_PITCH = 0.6;

export type ItemColor = 0 | 1 | 2;

export interface DrumLane {
  lane: number;
  voice: string;
  label: string;
  /** CSS colour the scene paints this lane with. */
  color: string;
}

/** Rock Band order. Kick is lane 0 and spans the whole highway. */
export const DRUM_LANES: readonly DrumLane[] = [
  { lane: 0, voice: 'kick', label: 'KICK', color: '#ff8c1a' },
  { lane: 1, voice: 'snare', label: 'SNARE', color: '#ff2f4f' },
  { lane: 2, voice: 'hihat', label: 'HI-HAT', color: '#ffd21a' },
  { lane: 3, voice: 'tom', label: 'TOM', color: '#2f7fff' },
  { lane: 4, voice: 'crash', label: 'CYMBAL', color: '#34d399' },
];
export const DRUM_LANE_COUNT = DRUM_LANES.length;
/** Spacing of the four pad lanes (snare..cymbal); the kick bar spans them. */
export const DRUM_PAD_SPACING = 0.7;

/** Lane index for a `drumVoice`; -1 for '' or an unknown voice. Ride shares
 *  the cymbal lane with crash; the generic 'perc' fallback lands on the
 *  snare lane (a hand clap is played there). */
export function laneForVoice(voice: string): number {
  switch (voice) {
    case 'kick':
      return 0;
    case 'snare':
    case 'perc':
      return 1;
    case 'hihat':
      return 2;
    case 'tom':
      return 3;
    case 'crash':
    case 'ride':
      return 4;
    default:
      return -1;
  }
}

export interface ScheduleItem {
  /** Song time (seconds) at which the item reaches the hit line. */
  hitTime: number;
  x: number;
  y: number;
  /** SMuFL codepoint to draw (notation skin; the fallback notehead otherwise). */
  codepoint: number;
  /** 0 normal note, 1 rest (dimmed), 2 percussion. */
  color: ItemColor;
  judgeable: boolean;
  /** [partIndex, eventIndex] back into `chart.parts`. */
  eventRef: [number, number];
  /** Present in the blocks skin: the Beat Saber note this item stands for. */
  block?: { line: number; layer: number; color: number; cut: number };
  /** Present in the drums skin. `open` marks an open hi-hat (drawn hollow). */
  drum?: { voice: string; lane: number; open: boolean };
}

export interface Schedule {
  /** Sorted by hitTime ascending. */
  items: ScheduleItem[];
  /** `chart.measures[].timeSec`: bar-line times. */
  bars: number[];
  /** Number of judgeable items. */
  hitCount: number;
}

export interface BuildScheduleOptions {
  skin: HighwaySkin;
  /** Beat Saber difficulty 0 Easy .. 4 ExpertPlus (blocks skin only). */
  difficulty: number;
  layout?: Partial<HighwayLayout>;
}

/** Horizontal centre of lane `slot` when `count` lanes are centred on x = 0. */
export function laneX(slot: number, count: number, spacing: number): number {
  return (slot - (count - 1) / 2) * spacing;
}

/** Highway depth of an item: negative z is ahead of the player, 0 is the hit
 *  line, positive is already past. */
export function zForTime(hitTime: number, t: number, speed: number): number {
  return -(hitTime - t) * speed;
}

function lowerBound(items: readonly ScheduleItem[], time: number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (items[mid].hitTime < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(items: readonly ScheduleItem[], time: number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (items[mid].hitTime <= time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Half-open index range [from, to) of items with
 *  `t - pastSec <= hitTime <= t + lookaheadSec`. */
export function windowFor(schedule: Schedule, t: number, lookaheadSec: number, pastSec: number): [number, number] {
  const from = lowerBound(schedule.items, t - pastSec);
  const to = upperBound(schedule.items, t + lookaheadSec);
  return [from, Math.max(from, to)];
}

function rawHitTime(e: ChartEvent, rawIsQuantized: boolean): number {
  return rawIsQuantized ? e.onsetSec : e.onsetSecRaw;
}

function compareItems(a: ScheduleItem, b: ScheduleItem): number {
  if (a.hitTime !== b.hitTime) return a.hitTime - b.hitTime;
  if (a.eventRef[0] !== b.eventRef[0]) return a.eventRef[0] - b.eventRef[0];
  return a.eventRef[1] - b.eventRef[1];
}

function finish(items: ScheduleItem[], chart: NoteChart): Schedule {
  items.sort(compareItems);
  let hitCount = 0;
  for (const item of items) if (item.judgeable) hitCount += 1;
  return {
    items,
    bars: (chart.measures ?? []).map((m) => m.timeSec),
    hitCount,
  };
}

function isVisible(visibleParts: readonly boolean[], partIndex: number): boolean {
  // A missing entry means "visible": callers pass a shorter array when the
  // filter has not been initialised yet.
  return visibleParts[partIndex] !== false;
}

export function buildSchedule(chart: NoteChart, visibleParts: readonly boolean[], opts: BuildScheduleOptions): Schedule {
  const layout: HighwayLayout = { ...DEFAULT_LAYOUT, ...(opts.layout ?? {}) };
  const parts = chart.parts ?? [];
  const rawIsQuantized = chart.quantization?.rawIsQuantized !== false;
  const items: ScheduleItem[] = [];

  if (opts.skin === 'blocks') {
    const level = Math.max(0, Math.min(4, Math.floor(opts.difficulty)));
    for (const part of parts) {
      if (!isVisible(visibleParts, part.index) || part.isPercussion) continue;
      const events = part.events ?? [];
      for (let i = 0; i < events.length; i += 1) {
        const e = events[i];
        const minLevel = typeof e.bsMinDifficulty === 'number' ? e.bsMinDifficulty : -1;
        if (minLevel < 0 || minLevel > level) continue;
        const line = e.bsLine ?? 0;
        const layer = e.bsLayer ?? 0;
        items.push({
          hitTime: rawHitTime(e, rawIsQuantized),
          x: (line - 1.5) * BLOCK_PITCH,
          y: layer * BLOCK_PITCH,
          codepoint: e.noteheadCodepoint || NOTEHEAD_BLACK_CODEPOINT,
          color: 0,
          judgeable: isHitBearing(e),
          eventRef: [part.index, i],
          block: { line, layer, color: e.bsColor ?? 0, cut: e.bsCut ?? 8 },
        });
      }
    }
    return finish(items, chart);
  }

  if (opts.skin === 'drums') {
    for (const part of parts) {
      if (!isVisible(visibleParts, part.index) || !part.isPercussion) continue;
      const events = part.events ?? [];
      for (let i = 0; i < events.length; i += 1) {
        const e = events[i];
        if (e.isRest || e.isGrace) continue;
        const voice = e.drumVoice ?? '';
        const lane = laneForVoice(voice);
        if (lane < 0) continue;
        items.push({
          hitTime: rawHitTime(e, rawIsQuantized),
          // The kick bar spans the highway, so it sits at the centre; the four
          // pads are centred as a group.
          x: lane === 0 ? 0 : laneX(lane - 1, DRUM_LANE_COUNT - 1, DRUM_PAD_SPACING),
          y: 0,
          codepoint: e.noteheadCodepoint || NOTEHEAD_BLACK_CODEPOINT,
          color: 2,
          judgeable: isHitBearing(e),
          eventRef: [part.index, i],
          drum: {
            voice,
            lane,
            open: voice === 'hihat' && (e.midi === 46 || e.noteheadCodepoint === NOTEHEAD_CIRCLE_X_CODEPOINT),
          },
        });
      }
    }
    return finish(items, chart);
  }

  // notation skin
  const slots = new Map<number, number>();
  for (const part of parts) {
    if (isVisible(visibleParts, part.index)) slots.set(part.index, slots.size);
  }
  const laneCount = Math.max(1, slots.size);
  for (const part of parts) {
    const slot = slots.get(part.index);
    if (slot === undefined) continue;
    const x = laneX(slot, laneCount, layout.laneSpacing);
    const events = part.events ?? [];
    for (let i = 0; i < events.length; i += 1) {
      const e = events[i];
      if (e.isGrace) continue;
      const step = e.isRest ? layout.restStep : e.staffStep;
      const y = step * layout.stepHeight - (e.staff > 1 ? layout.staffDrop : 0);
      const color: ItemColor = e.isRest ? 1 : part.isPercussion ? 2 : 0;
      items.push({
        hitTime: e.onsetSec,
        x,
        y,
        codepoint: e.glyphCodepoint || e.noteheadCodepoint || NOTEHEAD_BLACK_CODEPOINT,
        color,
        judgeable: isHitBearing(e),
        eventRef: [part.index, i],
      });
    }
  }
  return finish(items, chart);
}

/** Distinct SMuFL codepoints a schedule draws (what the glyph atlas needs). */
export function codepointsOf(schedule: Schedule): Set<number> {
  const out = new Set<number>();
  for (const item of schedule.items) out.add(item.codepoint);
  return out;
}
