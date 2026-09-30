/**
 * launchQueue — ONE pending launch intent per slot, fired on a shared-clock
 * grid line.
 *
 * PERFORM's session grid used to quantize launches itself: a component-local
 * `sessionStartRef` taken on the first launch, a bars-only `quantizeBars`, and
 * `nextLaunchTime()` returning `sessionStartRef + ceil(elapsed / barSec) * barSec`.
 * That anchor was invisible to the rest of the app (LOOM, the colony, the DJ
 * pads all had their own), it re-anchored itself whenever the grid ran out of
 * players — so a full stop silently moved the downbeat — and because it
 * multiplied `time_signature[0] * 60/bpm` by hand it could only ever mean
 * "bars, in 4/4, at one constant tempo".
 *
 * This module holds no clock and no anchor. It is handed `nextGrid` and `now`
 * (in practice `beatClock`'s, on the shared AudioContext) and does one thing:
 * remember what each slot has been asked to do next, and hand those intents
 * back once their grid line is within scheduling reach. Every `at` it produces
 * is `nextGrid(grid, now())` — a position on the app's one bar/beat grid, right
 * in 7/8 and across a meter change, and the same downbeat LOOM and the colony
 * are already launching against.
 *
 * ONE PENDING INTENT PER SLOT. A second `queue` for a slot REPLACES the first:
 * a re-press before the grid moves the intent, it does not stack up a second
 * launch behind it. `play` on a slot that is already playing is therefore a
 * retrigger at the next line, and `stop` is a stop at the next line.
 *
 * Design source: Tracktion Engine
 * `modules/tracktion_engine/model/clips/tracktion_LaunchHandle.h`
 * (GPL-3.0-or-later / commercial), whose handle keeps a single optional
 * "next state" (queued play or queued stop, plus the beat it is queued for)
 * that a later request overwrites, and consumes it from an `advance` call
 * driven by the audio clock. That description of its BEHAVIOUR is the whole of
 * what was taken: no line of it, or of any other copyleft reference under
 * `oss-refs/`, is in this file.
 */
import { CLOCK_LEAD_SEC, type ClockGrid } from './beatClock';

export type LaunchAction = 'play' | 'stop';

/** What a press asks for. */
export interface LaunchSpec {
  /** Which grid line to land on. `'now'` means the next `advance`. */
  grid: ClockGrid;
  action: LaunchAction;
  /** Seconds into the source to start at, carried through to the consumer. */
  offsetSec?: number;
  /**
   * The exact instant to land on, overriding `grid` when it is a finite number.
   *
   * Only a caller that already KNOWS the instant should pass this: a clip's
   * follow action fires at the boundary of the clip that is finishing, and
   * rounding that up to the next launch line would put a hole the length of the
   * quantization into the column it was meant to hand over seamlessly. A press
   * still leaves this out and gets the grid; a non-finite value falls back to
   * the grid too, so a miscomputed deadline can never poison the queue.
   */
  at?: number;
}

/** A queued intent, frozen so a consumer cannot rewrite the queue's state. */
export interface LaunchTicket {
  readonly slotId: string;
  /** AudioContext seconds. Always `nextGrid(grid, now())` as of the press. */
  readonly at: number;
  readonly state: 'queued';
  readonly action: LaunchAction;
  readonly grid: ClockGrid;
  readonly offsetSec: number | undefined;
}

/** The clock the queue is measured on — `beatClock` in the app. */
export interface LaunchQueueClock {
  nextGrid(grid: ClockGrid, from?: number): number;
  now(): number;
}

export interface LaunchQueueOptions extends LaunchQueueClock {
  /**
   * How far ahead of `at` a ticket is handed back, so the consumer has time to
   * schedule `source.start(at)` before `at` arrives. Must be at least the
   * period of whatever drives `advance`.
   */
  lead?: number;
}

export interface LaunchQueue {
  /** Queue (or REPLACE) `slotId`'s next intent. Returns the ticket it fires. */
  queue(slotId: string, spec: LaunchSpec): LaunchTicket;
  /** Drop `slotId`'s pending intent. True if there was one. */
  cancel(slotId: string): boolean;
  /** Drop every pending intent — what stopping the transport does. */
  clear(): void;
  /** Everything still queued, in `at` order. */
  pending(): LaunchTicket[];
  /**
   * Take every ticket whose `at` is within `lead` of `nowSec`, in `at` order.
   * A ticket is removed as it is returned, so it can never fire twice.
   */
  advance(nowSec: number): LaunchTicket[];
  readonly lead: number;
}

/**
 * The slot id for one mixer COLUMN, and the only place a slot id is made.
 *
 * A session grid has two index spaces that are equal in most sets and not in
 * all of them: a clip's `track_index` (its column in the source DAW, counting
 * tracks the mixer does not show) and its position in the mixer's own column
 * list. Deriving the id from whichever one a given call site happened to have
 * gave one column two ids, and replace-not-stack silently stopped holding
 * across the two launch paths. The mixer column is the one that matters here:
 * a column plays one clip, so a column holds one intent.
 */
export const launchSlotId = (mixIndex: number): string => `track:${mixIndex}`;

/** Ascending by `at`; `Array.sort` is stable, so ties keep queue order. */
const byAt = (a: LaunchTicket, b: LaunchTicket): number => a.at - b.at;

export const createLaunchQueue = (options: LaunchQueueOptions): LaunchQueue => {
  const { nextGrid, now } = options;
  const lead = options.lead ?? CLOCK_LEAD_SEC;
  /** slotId -> its one pending intent. Insertion-ordered, so ties are stable. */
  const slots = new Map<string, LaunchTicket>();

  return {
    lead,

    queue(slotId, spec) {
      // A clock that hands back NaN/Infinity would throw out of
      // `source.start()`, and worse, a non-finite `at` compares false against
      // EVERY deadline: the ticket would never fire and never be removed, so
      // the consumer's pump would spin on it forever. Both halves fall back to
      // a finite number, and `advance` then fires the ticket immediately.
      const reported = now();
      const from = Number.isFinite(reported) ? reported : 0;
      // An explicit finite `at` is the caller's own deadline and is taken as
      // given — the clock is not asked at all, so nothing rounds it up and no
      // cold-clock anchor is set from a launch that never asked for one.
      const line = spec.at !== undefined && Number.isFinite(spec.at)
        ? spec.at
        : nextGrid(spec.grid, from);
      const at = Number.isFinite(line) ? line : from;
      const ticket: LaunchTicket = Object.freeze({
        slotId,
        at,
        state: 'queued' as const,
        action: spec.action,
        grid: spec.grid,
        offsetSec: spec.offsetSec,
      });
      slots.set(slotId, ticket);
      return ticket;
    },

    cancel(slotId) {
      return slots.delete(slotId);
    },

    clear() {
      slots.clear();
    },

    pending() {
      return [...slots.values()].sort(byAt);
    },

    advance(nowSec) {
      const deadline = nowSec + lead;
      const due: LaunchTicket[] = [];
      for (const ticket of slots.values()) {
        if (ticket.at <= deadline) due.push(ticket);
      }
      if (due.length === 0) return due;
      due.sort(byAt);
      for (const ticket of due) slots.delete(ticket.slotId);
      return due;
    },
  };
};
