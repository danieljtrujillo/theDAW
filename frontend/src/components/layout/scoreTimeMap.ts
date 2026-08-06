import type { Cursor, OpenSheetMusicDisplay } from 'opensheetmusicdisplay';
import { ensureEngine } from '../../state/playerStore';

/** Follow-along timing for the SCORE tab, kept out of the view so it can be
 *  reasoned about on its own: the notated time map the cursor steps through,
 *  the audio clock that drives it, and the driver that walks the cursor to a
 *  step without paying a DOM pass per step. No React, no JSX. */

/**
 * basic-pitch / pretty_midi write REAL AUDIO SECONDS and encode them at a
 * hardcoded 120 BPM (`initial_tempo=120`; the piano route's
 * `beats_per_second = 2`). So on this pipeline 120 is a unit-conversion
 * constant, not a musical tempo, and one whole note is exactly 2.0 s of audio.
 * The analyzer's detected BPM for the same file is a different quantity
 * entirely (99.4 where this is 120 on the reference track) and substituting it
 * would put the cursor 20 percent out within the first minute.
 */
export const PIPELINE_BPM = 120;

/**
 * `MusicSheet`'s constructor seeds `userStartTempoInBPM` with 100
 * unconditionally, and the reader's `userStartTempoInBPM || DefaultStartTempoInBpm`
 * can never override a truthy 100. The iterator seeds `currentBpm` from it, so
 * a `CurrentBpm` of exactly 100 carries no information: it means "no tempo
 * instruction has been activated yet", which is the permanent state of a score
 * that states no tempo (every arrangement this app emits). Reading it as a
 * tempo times those scores at 2.4 s per whole note instead of 2.0.
 */
const OSMD_UNSET_BPM = 100;

/** OSMD Fractions count WHOLE notes; a BPM counts quarter notes per minute. */
const secondsPerWholeNote = (bpm: number): number => 240 / bpm;

/** Runaway guard. A dense ten-minute score stays two orders under this. */
const MAX_STEPS = 200_000;

export interface CursorStep {
  /** Seconds of notated time from the start of the score. */
  seconds: number;
  /** Enrolled (playback-order) position in whole notes; 1 = one whole note. */
  wholeNotes: number;
  /** 0-based source measure index the cursor sits in at this step. */
  measureIndex: number;
}

export interface ScoreTimeMap {
  /** One entry per cursor position, in the order `Cursor.next()` visits them. */
  steps: CursorStep[];
  /** Notated seconds from the score start to the end of the last measure. */
  totalSeconds: number;
  /** The tempo the map was integrated at where the document stated none. */
  bpmUsed: number;
  /** True when the MusicXML itself carried a tempo. */
  statedTempo: boolean;
  /** True when the walk hit the runaway guard, so the map is incomplete. */
  truncated: boolean;
}

export interface BuildTimeMapOptions {
  /** Tempo for a score that states none. Defaults to the pipeline's 120. */
  fallbackBpm?: number;
  /** Must match the cursor's own setting, or map indices address the wrong
   *  positions. Both OSMD constructors default it to true. */
  skipInvisibleNotes?: boolean;
}

/**
 * Walk a throwaway iterator over the whole score and record, for every position
 * the cursor can occupy, how many seconds of notated music precede it.
 *
 * The walk uses `moveToNextVisibleVoiceEntry(false)` because that is exactly
 * what `Cursor.next()` calls; stepping with `moveToNext()` instead would build
 * a map whose indices do not address cursor positions one for one. It reads
 * `CurrentEnrolledTimestamp` rather than `currentTimeStamp` because enrolled
 * time is the playback timeline, monotonic through repeats, which is the axis
 * the audio follows. Seconds accumulate segment by segment with the tempo read
 * BEFORE each move, so a mid-score tempo change rescales only the music after
 * it instead of the whole piece.
 *
 * Touches no DOM and never disturbs the visible cursor, so it can (and must) be
 * built after `load()` and before the first `render()`.
 */
export function buildTimeMap(
  osmd: OpenSheetMusicDisplay,
  opts: BuildTimeMapOptions = {},
): ScoreTimeMap {
  const fallbackBpm =
    typeof opts.fallbackBpm === 'number' && opts.fallbackBpm > 0 ? opts.fallbackBpm : PIPELINE_BPM;
  const sheet = osmd?.Sheet;
  const manager = sheet?.MusicPartManager;
  const measures = sheet?.SourceMeasures ?? [];
  const empty: ScoreTimeMap = {
    steps: [],
    totalSeconds: 0,
    bpmUsed: fallbackBpm,
    statedTempo: false,
    truncated: false,
  };
  if (!manager || measures.length === 0) return empty;

  const statedTempo = sheet.HasBPMInfo === true && sheet.DefaultStartTempoInBpm > 0;
  // The document's own start tempo, which is what OSMD's iterator reports only
  // after it has activated the first tempo instruction.
  const docBpm = statedTempo ? sheet.DefaultStartTempoInBpm : fallbackBpm;

  // End of the last measure in whole notes, for the closing segment: once the
  // iterator runs off the end it parks its timestamp at the sentinel
  // Fraction(99999, 1), which would add roughly 27 hours to the map.
  const last = measures[measures.length - 1];
  const sheetEndWholes = last.AbsoluteTimestamp.RealValue + last.Duration.RealValue;

  const it = manager.getIterator();
  it.SkipInvisibleNotes = opts.skipInvisibleNotes ?? true;

  const steps: CursorStep[] = [];
  let seconds = 0;
  let guard = 0;
  // Until the iterator reports something other than its 100 placeholder there
  // is no evidence it is tracking the document, so the document's own tempo
  // wins. Once it does report a real instruction, following it is what keeps a
  // mid-score tempo change honest.
  let iteratorHasTempo = false;

  while (!it.EndReached && guard < MAX_STEPS) {
    guard += 1;
    const enrolledBefore = it.CurrentEnrolledTimestamp.RealValue;
    const sourceBefore = it.CurrentSourceTimestamp.RealValue;
    const reported = it.CurrentBpm;
    if (reported > 0 && Math.abs(reported - OSMD_UNSET_BPM) > 1e-6) iteratorHasTempo = true;
    const bpm = iteratorHasTempo && reported > 0 ? reported : docBpm;

    steps.push({
      seconds,
      wholeNotes: enrolledBefore,
      measureIndex: it.CurrentMeasureIndex,
    });

    it.moveToNextVisibleVoiceEntry(false);

    if (it.EndReached) {
      // A remaining DURATION, so the source clock gives the same answer the
      // enrolled clock would: measuring it against the sentinel would not.
      seconds += Math.max(0, sheetEndWholes - sourceBefore) * secondsPerWholeNote(bpm);
      break;
    }

    let deltaWholes = it.CurrentEnrolledTimestamp.RealValue - enrolledBefore;
    if (deltaWholes <= 0) {
      // Defensive: a malformed repeat structure that fails to advance the
      // enrolled clock still advances the source clock.
      deltaWholes = Math.max(0, it.CurrentSourceTimestamp.RealValue - sourceBefore);
    }
    seconds += deltaWholes * secondsPerWholeNote(bpm);
  }

  return {
    steps,
    totalSeconds: seconds,
    bpmUsed: docBpm,
    statedTempo,
    truncated: guard >= MAX_STEPS,
  };
}

/** Last step at or before `sec`. 0 before the first step, -1 for an empty map. */
export function findStepIndexBySeconds(steps: CursorStep[], sec: number): number {
  if (steps.length === 0) return -1;
  if (sec <= steps[0].seconds) return 0;
  let lo = 0;
  let hi = steps.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (steps[mid].seconds <= sec) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** Last step at or before `wholeNotes`. Re-derives a step index from a live
 *  iterator, which is the only trustworthy source after a re-render. */
export function findStepIndexByTimestamp(steps: CursorStep[], wholeNotes: number): number {
  if (steps.length === 0) return -1;
  let lo = 0;
  let hi = steps.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (steps[mid].wholeNotes <= wholeNotes + 1e-9) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

export interface ScoreClock {
  /** Audible playback position in seconds, latency-compensated. */
  read: () => number;
  reset: () => void;
}

/** Cap on how far ahead of the media element the clock may extrapolate. Without
 *  it a stalled element (buffering, a seek in flight, a suspended context) lets
 *  the clock run away and then snap backwards when it catches up, which reads
 *  as a large backward seek to the driver. */
const MAX_EXTRAPOLATION_SEC = 0.25;

/**
 * The audio position, read straight off the one engine element rather than off
 * `playerStore.currentTime`, which only updates on `timeupdate` (roughly every
 * 250 ms, two sixteenth notes at 120 BPM). Between media-pipeline updates the
 * position is extrapolated along the AudioContext clock, which advances every
 * render quantum, and shifted back by the output latency so the cursor lines up
 * with what leaves the speakers rather than with what has been decoded.
 */
export function createScoreClock(): ScoreClock {
  const { ctx, audioEl } = ensureEngine();
  let lastMedia = -1;
  let lastCtx = 0;

  const latency = (): number => {
    // outputLatency is missing from some TS DOM lib versions.
    const withLatency = ctx as AudioContext & { outputLatency?: number };
    const out = withLatency.outputLatency;
    if (typeof out === 'number' && Number.isFinite(out) && out > 0) return out;
    return Number.isFinite(ctx.baseLatency) ? ctx.baseLatency : 0;
  };

  return {
    read: () => {
      const media = audioEl.currentTime;
      const now = ctx.currentTime;
      if (media !== lastMedia) {
        lastMedia = media;
        lastCtx = now;
        return Math.max(0, media - latency());
      }
      if (audioEl.paused) return Math.max(0, media - latency());
      const elapsed = Math.max(0, now - lastCtx) * (audioEl.playbackRate || 1);
      return Math.max(0, media + Math.min(MAX_EXTRAPOLATION_SEC, elapsed) - latency());
    },
    reset: () => {
      lastMedia = -1;
      lastCtx = 0;
    },
  };
}

/** Milliseconds of iterator stepping allowed per frame during a catch-up. */
const STEP_BUDGET_MS = 6;
/** Iterator steps between clock readings. `moveToNextVisibleVoiceEntry` can
 *  traverse arbitrarily many empty containers per call, so the budget is only
 *  as tight as this chunk is small. */
const CHUNK = 16;
/** Backward deltas up to this many steps walk the iterator back; beyond it,
 *  reset and replay forward. */
const BACKWARD_STEP_LIMIT = 24;

export interface CursorDriver {
  /** Ask the cursor to sit on step `next`. A cheap no-op when already there. */
  goTo: (next: number) => void;
  /** Re-derive the index from the live iterator. Required after every render. */
  resync: (map: ScoreTimeMap) => void;
  index: () => number;
  cancel: () => void;
}

/**
 * `Cursor.update()` walks graphical measures, writes DOM, reparents the cursor
 * image into the page it now belongs to, and re-encodes a PNG. `Cursor.next()`
 * pays all of that per step, so servicing a seek back to bar 1 through it would
 * be thousands of layout passes. This drives `cursor.iterator` directly and
 * calls `update()` once, when the cursor lands.
 *
 * `getCursor` is a callback rather than a captured reference because `render()`
 * throws the Cursor away and builds a new one every time. It is also where the
 * caller enforces its OSMD generation, so a driver left over from a discarded
 * StrictMode mount can never write into the live mount's DOM.
 */
export function createCursorDriver(getCursor: () => Cursor | null): CursorDriver {
  let index = 0;
  let target = 0;
  let raf = 0;
  let atEnd = false;

  const pump = (): void => {
    raf = 0;
    const cursor = getCursor();
    if (!cursor) return;
    let it = cursor.iterator;
    if (!it) return;
    const started = performance.now();
    let moved = false;

    if (target < index) {
      if (!atEnd && index - target <= BACKWARD_STEP_LIMIT) {
        while (index > target) {
          it.moveToPreviousVisibleVoiceEntry(false);
          index -= 1;
        }
      } else {
        // resetIterator() REPLACES cursor.iterator rather than repositioning
        // it, so the rest of this frame has to step the new object; the old one
        // would climb while the cursor stayed parked at bar 1. It does no DOM
        // work, which is why update() can still be deferred to one call below.
        cursor.resetIterator();
        it = cursor.iterator;
        index = 0;
        atEnd = false;
      }
      moved = true;
    }

    while (index < target) {
      let took = 0;
      let ended = false;
      while (took < CHUNK && index + took < target) {
        it.moveToNextVisibleVoiceEntry(false);
        if (it.EndReached) {
          ended = true;
          break;
        }
        took += 1;
      }
      index += took;
      moved = moved || took > 0;
      if (ended) {
        // The iterator is the truth about where the cursor is, so the target
        // gives way rather than the index being fabricated to match it.
        atEnd = true;
        target = index;
        break;
      }
      if (performance.now() - started >= STEP_BUDGET_MS) break;
    }

    if (moved) {
      try {
        // One DOM pass for every step this frame covered. A no-op while the
        // cursor is hidden, which is fine: show() runs update() itself, so the
        // position is picked up the moment it becomes visible.
        cursor.update();
        settleCursorStyle(cursor);
      } catch {
        /* the page div the cursor lives in was replaced mid-render */
      }
    }
    if (index < target) raf = requestAnimationFrame(pump);
  };

  return {
    goTo: (next) => {
      const want = Math.max(0, next);
      if (want === target && want === index) return;
      // The iterator is spent; asking it to go further forward every frame
      // would cost a pointless move per frame for the rest of the track.
      if (atEnd && want >= index) return;
      target = want;
      if (!raf) pump();
    },
    resync: (map) => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      atEnd = false;
      const cursor = getCursor();
      const stamp = cursor?.iterator?.CurrentEnrolledTimestamp?.RealValue;
      const derived =
        typeof stamp === 'number' ? findStepIndexByTimestamp(map.steps, stamp) : -1;
      index = derived < 0 ? 0 : derived;
      target = index;
    },
    index: () => index,
    cancel: () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    },
  };
}

/**
 * `updateWidthAndStyle()` re-runs `updateStyle()` whenever `cursorOptionsRendered`
 * is not the SAME OBJECT as `cursorOptions`, and `updateStyle()` ends by
 * assigning a fresh spread of it, so the check never settles and every single
 * `update()` allocates a canvas, synchronously `toDataURL()`s a PNG and forces
 * an image decode. Pointing both fields at one object settles it. The image
 * depends only on type, colour, alpha and width, none of which change until the
 * next `render()` hands out a brand-new Cursor, so nothing visual is lost.
 */
const settleCursorStyle = (cursor: Cursor): void => {
  const priv = cursor as unknown as {
    cursorOptions?: unknown;
    cursorOptionsRendered?: unknown;
  };
  if (priv.cursorOptions) priv.cursorOptionsRendered = priv.cursorOptions;
};
