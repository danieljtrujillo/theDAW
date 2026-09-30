/**
 * audioEditorModel — every number the Audio Editor drawer writes to a clip, and
 * every number it draws with.
 *
 * The drawer edits by ABSOLUTE value ("the clip starts at timeline second 5",
 * "the read head sits at source second 2.4") because that is what a numeric
 * field and a dragged handle both produce, while `lib/clipDragMath` — which
 * already owns the timeline's own trim and slip rules, including the minimum
 * clip length and the end-of-source clamp — works in DELTAS. This module is the
 * conversion, so the drawer and the timeline cannot drift into two different
 * ideas of what a legal trim is: each function turns an absolute target into a
 * delta, hands it to `clipDragMath`, and converts the one field that comes back
 * in timeline seconds (`offsetIntoSource`) back into source seconds.
 *
 * TIME DOMAINS. Three of them, and mixing them up is how a left-trim on a
 * stretched clip used to move the read head to the wrong place:
 *   - TIMELINE seconds — where the clip sits in the arrangement (`startSec`)
 *     and how long it plays for (`durationSec`).
 *   - SOURCE seconds — into the clip's own audio file (`offsetIntoSource`,
 *     `sourceDuration`). A clip at rate `r` eats `r` source seconds per
 *     timeline second.
 *   - CLIP seconds — from the clip's own head, which is what a fade length is.
 * Every parameter below says which one it is in. The drawer's numeric fields
 * carry the same words on screen.
 *
 * Pure: no DOM, no React, no store. Non-finite inputs throw `RangeError`
 * rather than being written into a clip, because a `NaN` duration is not a
 * mistake you can see — it is a clip that silently stops playing.
 *
 * NOTHING HERE TOUCHES THE SOURCE FILE. Every result is a set of clip fields;
 * the bytes are never read, rewritten or trimmed.
 */
import {
  MIN_CLIP_SEC,
  fromTimelineOffset,
  resizeLeft,
  resizeRight,
  slip,
  toTimelineView,
  type DragClip,
} from '../../lib/clipDragMath';

/* ── constants ────────────────────────────────────────────────────────────── */

/** Bottom of the clip-gain fader, in dB. Well below audibility, and still a
 *  real (tiny) gain rather than silence — the clip has its own mute for that. */
export const CLIP_GAIN_DB_MIN = -60;
/** Top of the clip-gain fader, in dB. Clip gain sits BEFORE the track fader and
 *  the insert rack, so headroom here is headroom the compressor downstream
 *  sees; +12 dB is as far as that stays a gain-staging move. */
export const CLIP_GAIN_DB_MAX = 12;

/** One arrow-key press on a handle or a field, in seconds. */
export const AUDIO_EDITOR_NUDGE_SEC = 0.01;
/** One Shift + arrow-key press, in seconds. */
export const AUDIO_EDITOR_NUDGE_COARSE_SEC = 0.1;

/* ── shapes ───────────────────────────────────────────────────────────────── */

/** The three clip fields a trim or a slip can change. Written straight through
 *  `editorStore.updateClip`. */
export interface ClipTrimEdit {
  /** TIMELINE seconds. */
  startSec: number;
  /** TIMELINE seconds. */
  durationSec: number;
  /** SOURCE seconds. */
  offsetIntoSource: number;
}

/** The two clip fields a fade edit can change, both in CLIP seconds. */
export interface ClipFadeEdit {
  fadeInSec: number;
  fadeOutSec: number;
}

/** The part of a clip a fade edit reads. `AudioClip` satisfies it structurally. */
export interface FadeTarget {
  /** TIMELINE seconds. */
  durationSec: number;
  /** CLIP seconds; absent means no fade. */
  fadeInSec?: number;
  /** CLIP seconds; absent means no fade. */
  fadeOutSec?: number;
}

/** The slice of the source the waveform view is currently drawing. */
export interface SourceWindow {
  /** SOURCE seconds at the left edge. */
  startSec: number;
  /** SOURCE seconds at the right edge. */
  endSec: number;
  /** `startSec` as a fraction of the whole source — what SemanticWave takes. */
  startFrac: number;
  /** `endSec` as a fraction of the whole source. */
  endFrac: number;
}

/* ── validation ───────────────────────────────────────────────────────────── */

const finite = (n: number, what: string): number => {
  if (!Number.isFinite(n)) throw new RangeError(`${what} must be a finite number, got ${n}`);
  return n;
};

const positive = (n: number, what: string): number => {
  if (!Number.isFinite(n) || n <= 0) throw new RangeError(`${what} must be a positive finite number, got ${n}`);
  return n;
};

/** Every field of the clip a trim reads, checked before any of it is used: a
 *  single `NaN` in here propagates into all three results. */
const checkedClip = (clip: DragClip): DragClip => ({
  startSec: finite(clip.startSec, 'clip.startSec'),
  durationSec: finite(clip.durationSec, 'clip.durationSec'),
  offsetIntoSource: finite(clip.offsetIntoSource, 'clip.offsetIntoSource'),
  sourceDuration: finite(clip.sourceDuration, 'clip.sourceDuration'),
});

/** `n` if it is a finite number, else `fallback`. The `typeof` guard does the
 *  work `Number.isFinite` cannot on its own: a field a damaged clip dropped
 *  entirely arrives here as `undefined`, not as a number to test. */
const finiteOr = (n: number | undefined, fallback: number): number =>
  typeof n === 'number' && Number.isFinite(n) ? n : fallback;

/** `n` if it is a finite number greater than zero, else `fallback`. */
const positiveOr = (n: number | undefined, fallback: number): number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : fallback;

/**
 * The BOUNDARY between a stored clip — which a damaged project file, a
 * half-finished import, or an in-flight edit can leave with a `NaN` or a
 * zero `sourceDuration` — and `checkedClip`'s callers above, which throw on
 * exactly that instead. `dragClipOf` never throws: every field the trim/slip
 * math reads is repaired instead of rejected, so a pointer handler reading a
 * damaged clip mid-gesture degrades instead of crashing out of it.
 *
 * `fallbackSourceDuration` is what a caller that knows the real source length
 * some other way (the decoded audio buffer, say) can offer in place of a
 * `sourceDuration` that did not survive; it is sanitised the same way a
 * stored field is, so a bad fallback cannot leak a `NaN` or a negative length
 * back out either.
 *
 * Like the rest of this module, this never touches the source file — only
 * the numbers a clip carries about it.
 */
export function dragClipOf(clip: Partial<DragClip>, fallbackSourceDuration = 0): DragClip {
  return {
    startSec: Math.max(0, finiteOr(clip.startSec, 0)),
    durationSec: positiveOr(clip.durationSec, MIN_CLIP_SEC),
    offsetIntoSource: Math.max(0, finiteOr(clip.offsetIntoSource, 0)),
    sourceDuration: positiveOr(clip.sourceDuration, Math.max(0, finiteOr(fallbackSourceDuration, 0))),
  };
}

/**
 * The same boundary as `dragClipOf`, for a fade edit's target. A damaged
 * `durationSec` reads as the shortest clip there is, rather than tripping
 * `setFadeIn` / `setFadeOut`'s `finite` check; a damaged fade length reads as
 * no fade at all rather than a negative or `NaN` one. Never throws.
 */
export function fadeTargetOf(clip: Partial<FadeTarget>): FadeTarget {
  return {
    durationSec: positiveOr(clip.durationSec, MIN_CLIP_SEC),
    fadeInSec: positiveOr(clip.fadeInSec, 0),
    fadeOutSec: positiveOr(clip.fadeOutSec, 0),
  };
}

/* ── trim / slip ──────────────────────────────────────────────────────────── */

/** A `clipDragMath` result, with its offset carried back to source seconds. */
const toSourceEdit = (
  r: { startSec: number; durationSec: number; offsetIntoSource: number },
  rate: number,
): ClipTrimEdit => ({
  startSec: r.startSec,
  durationSec: r.durationSec,
  offsetIntoSource: fromTimelineOffset(r.offsetIntoSource, rate),
});

/**
 * Move the clip's LEFT edge to TIMELINE second `timelineSec`. The audio under
 * the clip stays where it is: the read head moves by exactly what the clip
 * gained or lost, converted through the stretch rate.
 *
 * `null` means the edit is REFUSED and nothing should be written — the target
 * would leave the clip at or under `MIN_CLIP_SEC`, or would read from before
 * the head of the source. That is `clipDragMath.resizeLeft`'s rule, which is
 * the rule the timeline's own left-trim already follows.
 *
 * `rate` is the clip's stretch rate (`editorStore.clipStretchRate`).
 */
export function trimStartTo(clip: DragClip, rate: number, timelineSec: number): ClipTrimEdit | null {
  const c = checkedClip(clip);
  positive(rate, 'rate');
  finite(timelineSec, 'timelineSec');
  const next = resizeLeft(toTimelineView(c, rate), timelineSec - c.startSec);
  return next === null ? null : toSourceEdit(next, rate);
}

/**
 * Move the clip's RIGHT edge to TIMELINE second `timelineSec`, changing only
 * how long the clip plays for. Clamped rather than refused: the edge stops at
 * `MIN_CLIP_SEC` from the start and at whatever source is left after the read
 * head, so it can never be dragged past the end of the audio.
 */
export function trimEndTo(clip: DragClip, rate: number, timelineSec: number): ClipTrimEdit {
  const c = checkedClip(clip);
  positive(rate, 'rate');
  finite(timelineSec, 'timelineSec');
  const delta = timelineSec - (c.startSec + c.durationSec);
  return toSourceEdit(resizeRight(toTimelineView(c, rate), delta), rate);
}

/**
 * Slide the audio under the clip so the clip's head reads SOURCE second
 * `sourceSec`. The clip does not move and does not change length.
 *
 * Clamped to the slack the source has left (`sourceDuration` minus the source
 * the clip covers). A source no longer than the clip has no slack at all and is
 * left reading where it was, rather than being yanked back to zero.
 */
export function slipSourceTo(clip: DragClip, rate: number, sourceSec: number): ClipTrimEdit {
  const c = checkedClip(clip);
  positive(rate, 'rate');
  finite(sourceSec, 'sourceSec');
  // The gesture is measured in the timeline view, so the target offset has to
  // arrive there too: a source-second delta is `rate` timeline seconds.
  const deltaTimeline = (sourceSec - c.offsetIntoSource) / rate;
  return toSourceEdit(slip(toTimelineView(c, rate), deltaTimeline), rate);
}

/**
 * Untrim: the clip plays its whole source again, from the same place on the
 * timeline. At a stretch rate other than 1 the whole source needs a different
 * length of timeline, which is why this is not simply `durationSec =
 * sourceDuration`.
 *
 * A source shorter than `MIN_CLIP_SEC` still leaves a clip long enough to grab.
 */
export function resetTrims(clip: DragClip, rate: number): ClipTrimEdit {
  const c = checkedClip(clip);
  positive(rate, 'rate');
  return {
    startSec: c.startSec,
    durationSec: Math.max(MIN_CLIP_SEC, c.sourceDuration / rate),
    offsetIntoSource: 0,
  };
}

/* ── fades ────────────────────────────────────────────────────────────────── */

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

const fadeSec = (n: number | undefined): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0);

/**
 * Fit a pair of fades inside the clip with `edited` winning.
 *
 * `lib/clipFade.clampClipFades` shrinks whichever fade is SMALLER when the two
 * overlap, which is right for a clip whose length changed under fades nobody
 * touched. It is wrong here: the user just typed (or dragged) one of these, and
 * the number they entered must be the number they get. So the edited fade is
 * clamped to the clip and the OTHER one gives way. The result always satisfies
 * `clampClipFades` — the test pins that — so playback schedules the envelope
 * the drawer draws.
 */
const fitFades = (durationSec: number, edited: number, other: number): { edited: number; other: number } => {
  const dur = Math.max(0, durationSec);
  const kept = clamp(edited, 0, dur);
  return { edited: kept, other: clamp(other, 0, dur - kept) };
};

/** Set the fade-IN to `sec` CLIP seconds, shortening the fade-out if the two
 *  would otherwise overlap past the end of the clip. */
export function setFadeIn(clip: FadeTarget, sec: number): ClipFadeEdit {
  finite(clip.durationSec, 'clip.durationSec');
  finite(sec, 'sec');
  const fit = fitFades(clip.durationSec, sec, fadeSec(clip.fadeOutSec));
  return { fadeInSec: fit.edited, fadeOutSec: fit.other };
}

/** Set the fade-OUT to `sec` CLIP seconds, shortening the fade-in if the two
 *  would otherwise overlap past the end of the clip. */
export function setFadeOut(clip: FadeTarget, sec: number): ClipFadeEdit {
  finite(clip.durationSec, 'clip.durationSec');
  finite(sec, 'sec');
  const fit = fitFades(clip.durationSec, sec, fadeSec(clip.fadeInSec));
  return { fadeInSec: fit.other, fadeOutSec: fit.edited };
}

/* ── gain ─────────────────────────────────────────────────────────────────── */

/**
 * A linear clip gain as dB. Silence has no dB, so `0` returns `-Infinity`;
 * `clampGainDb` turns that into the bottom of the fader for display.
 *
 * Throws on a negative gain: a negative multiplier inverts the signal rather
 * than quietening it, and nothing in the app should ever store one.
 */
export function gainToDb(linear: number): number {
  finite(linear, 'linear');
  if (linear < 0) throw new RangeError(`gain must not be negative, got ${linear}`);
  return linear === 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(linear);
}

/**
 * Hold a dB value inside the fader's range.
 *
 * `±Infinity` is accepted (and lands on the corresponding end) because
 * `gainToDb(0)` legitimately produces `-Infinity`; only `NaN` — which is not a
 * point on the scale at all — throws.
 */
export function clampGainDb(db: number): number {
  if (Number.isNaN(db)) throw new RangeError(`db must be a number, got ${db}`);
  return clamp(db, CLIP_GAIN_DB_MIN, CLIP_GAIN_DB_MAX);
}

/** A dB value as the linear gain a clip stores. Clamped to the fader's range
 *  first, so a field typed full of nines cannot store a gain the mixer has to
 *  defend itself against. */
export function dbToGain(db: number): number {
  return Math.pow(10, clampGainDb(db) / 20);
}

/* ── fields ───────────────────────────────────────────────────────────────── */

/** What a numeric field is allowed to contain: an optional sign and a plain
 *  decimal. Deliberately narrower than `Number()`, which reads '0x10' as 16,
 *  ' ' as 0 and 'Infinity' as a length. */
const NUMBER_FIELD = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

/**
 * The number a numeric field holds, or `null` when it does not hold one yet —
 * which is the state a field is in while it is being typed into, and is not an
 * error. Callers write nothing to the clip until this returns a number.
 */
export function parseNumberField(text: string): number | null {
  const t = text.trim();
  if (!NUMBER_FIELD.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** A number of seconds as a field shows it. Fixed decimals, so the digits do
 *  not jump around under a dragging handle. */
export function formatSeconds(sec: number, decimals = 3): string {
  finite(sec, 'sec');
  finite(decimals, 'decimals');
  return sec.toFixed(clamp(Math.round(decimals), 0, 6));
}

/* ── the waveform view ────────────────────────────────────────────────────── */

/**
 * The slice of the source a view `widthPx` wide, at `zoomPxPerSec`, scrolled to
 * `scrollSec`, is showing.
 *
 * The window is always inside `[0, sourceDuration]`: scrolling past the tail
 * pins to the end rather than showing emptiness, and a zoom that would show
 * more than the whole source shows the whole source from its head. A width of
 * zero is the frame before the panel has measured itself, and reads as the
 * whole source; a source whose length is not known yet (0) has no window to
 * divide into, and reads as an empty one.
 *
 * `zoomPxPerSec` must be positive — at zero there is no window at all.
 */
export function sourceWindow(
  sourceDuration: number,
  scrollSec: number,
  zoomPxPerSec: number,
  widthPx: number,
): SourceWindow {
  finite(sourceDuration, 'sourceDuration');
  finite(scrollSec, 'scrollSec');
  positive(zoomPxPerSec, 'zoomPxPerSec');
  finite(widthPx, 'widthPx');

  if (!(sourceDuration > 0)) return { startSec: 0, endSec: 0, startFrac: 0, endFrac: 1 };
  if (!(widthPx > 0)) return { startSec: 0, endSec: sourceDuration, startFrac: 0, endFrac: 1 };

  const span = Math.min(sourceDuration, widthPx / zoomPxPerSec);
  const startSec = clamp(scrollSec, 0, sourceDuration - span);
  const endSec = startSec + span;
  return {
    startSec,
    endSec,
    startFrac: startSec / sourceDuration,
    endFrac: endSec / sourceDuration,
  };
}

/** The zoom, in px per source second, at which the whole source fits a view
 *  `widthPx` wide. Falls back to a usable zoom when either is unknown, so the
 *  caller never has to guard the divide. */
export function fitZoom(sourceDuration: number, widthPx: number): number {
  finite(sourceDuration, 'sourceDuration');
  finite(widthPx, 'widthPx');
  if (!(sourceDuration > 0) || !(widthPx > 0)) return 100;
  return widthPx / sourceDuration;
}

/** Where SOURCE second `sourceSec` sits across the view, as a percentage of its
 *  width. Pinned to `[0, 100]`, so a marker for something scrolled off screen
 *  rests against the edge it went off instead of being drawn outside the box. */
export function sourcePercentInWindow(win: SourceWindow, sourceSec: number): number {
  finite(sourceSec, 'sourceSec');
  const span = win.endSec - win.startSec;
  if (!(span > 0)) return 0;
  return clamp(((sourceSec - win.startSec) / span) * 100, 0, 100);
}

/** The SOURCE second at fraction `frac` across the view. Pinned to the window,
 *  so a pointer dragged outside the box reads the edge it left by rather than a
 *  time that is not on screen. */
export function sourceSecAtWindowFrac(win: SourceWindow, frac: number): number {
  finite(frac, 'frac');
  const span = win.endSec - win.startSec;
  if (!(span > 0)) return win.startSec;
  return win.startSec + clamp(frac, 0, 1) * span;
}
