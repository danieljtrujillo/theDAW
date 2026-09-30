/**
 * clipFade — ONE clip fade envelope for the whole app.
 *
 * Before this module the same envelope was hand-written four times (the live
 * scheduler and three offline bounces), each with its own clamp and its own
 * idea of what happens when playback starts in the middle of a fade. This is
 * the single definition: a clamp rule, a scalar evaluator for drawing and for
 * offline sample loops, and a scheduler for anything that quacks like an
 * `AudioParam`. The evaluator and the scheduler are the same curve by
 * construction — `clipFade.test.ts` replays the scheduled events under the
 * AudioParam ramp rules and samples them against the evaluator.
 *
 * DESIGN SOURCES (read for their design only — NO code was copied from them):
 *   - ACE-Step-DAW `src/utils/clipFade.ts` (AGPL-3.0) — the shape of the API:
 *     a clamp helper, a duck-typed `AudioParamLike`, a scalar gain evaluator,
 *     and per-fade scheduling that resumes correctly from mid-fade.
 *   - Tracktion Engine `modules/tracktion_engine/model/clips/
 *     tracktion_AudioClipBase.h` (GPL-3.0 or commercial) — a fade belongs to
 *     ONE end of a clip, so each end carries its own length AND its own named
 *     shape (there `FadeBehaviour`, here `FadeCurve`).
 * Both are copyleft. Every line here was written from the described behaviour.
 */

/** The fade shapes a clip can use. `linear` is the app's historical behaviour
 *  and stays the default for clips that name no curve. */
export type FadeCurve = 'linear' | 'exponential' | 'equal-power';

/** Floor for the exponential curve. An exponential ramp cannot reach (or leave)
 *  zero, so the curve is linear-in-dB down to this floor — about -80 dB, below
 *  audibility — and a short linear tail carries it the rest of the way to true
 *  silence. */
export const FADE_EXP_FLOOR = 1e-4;

/** Fraction of an exponential fade spent on that linear tail. Expressed as a
 *  fraction rather than a number of seconds so the shape is identical for a
 *  10 ms fade and a 10 s one. */
export const FADE_EXP_TAIL = 0.02;

/** Samples used when a shape has to be rasterised into `setValueCurveAtTime`.
 *
 *  A value curve is played back as chords between its samples, so rasterising
 *  costs an error bounded by `h²·max|g''|/8` with `h = 1/(CURVE_SAMPLES - 1)`
 *  of the fade. For equal power (`max|g''| = (π/2)²`) that is about 2e-4 of
 *  full scale; for an exponential falling back to a curve
 *  (`max|g''| = (ln FADE_EXP_FLOOR)²`) about 6.5e-4, i.e. roughly -63 dB.
 *  Both are inaudible, and `clipFade.test.ts` holds the automation to those
 *  bounds against `fadeGainAt`. Raising this count shrinks the error with the
 *  square. */
const CURVE_SAMPLES = 129;

/** The part of a clip this module needs. `AudioClip` satisfies it structurally,
 *  which keeps `lib/` free of a `state/` import. */
export interface FadeClip {
  /** Length of the clip on the timeline, in seconds. When the decoded buffer
   *  cannot fill that, pass the playable length as `effectiveDurationSec`
   *  rather than editing this. */
  durationSec: number;
  fadeInSec?: number;
  fadeOutSec?: number;
  fadeInCurve?: FadeCurve;
  fadeOutCurve?: FadeCurve;
}

/** Anything that schedules like an `AudioParam`. The two ramp-free methods are
 *  required; the other two are optional so a plain recorder — or a canvas
 *  renderer — can stand in, and so this is testable without Web Audio. */
export interface AudioParamLike {
  setValueAtTime(value: number, startTime: number): unknown;
  linearRampToValueAtTime(value: number, endTime: number): unknown;
  exponentialRampToValueAtTime?(value: number, endTime: number): unknown;
  setValueCurveAtTime?(values: Float32Array, startTime: number, duration: number): unknown;
}

export interface ClipFades {
  fadeInSec: number;
  fadeOutSec: number;
}

export interface FadeAutomationOptions {
  /** Value the envelope rises to instead of unity — the clip's own gain, so
   *  clip gain lands before the track fader and its insert FX. Default 1. */
  peak?: number;
  /** How much of the clip can actually be played, when that is less than
   *  `durationSec` — every call site works this out as
   *  `min(clip.durationSec, buffer.duration - offsetIntoSource)` because a
   *  decoded buffer can run out early. Passing it moves the fade-out (and the
   *  clamp) to the effective end instead of fading past audio that is not
   *  there. A value of 0 means nothing can be played, which is silence. */
  effectiveDurationSec?: number;
}

/** Non-negative finite seconds, or 0. */
const sec = (v: number | undefined): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** A usable linear gain, or 0. Same shape as `sec` but it is not a duration. */
const peakGain = (v: number | undefined): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** Two scheduling times that differ only by float noise are the same instant.
 *  `ctxBase + (from / fadeSec) * fadeSec` and `whenSec + from` are equal in
 *  real arithmetic but can land an ULP apart in doubles, and an event emitted
 *  on that difference is at best redundant and at worst lands inside a value
 *  curve's window. */
const sameTime = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-12;

const clamp01 = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t);

/** Exponential fade-IN gain at normalised progress `t`: a linear tail out of
 *  silence up to the floor, then a straight line in dB up to unity. */
const expInGain = (t: number): number => {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  if (t <= FADE_EXP_TAIL) return (t / FADE_EXP_TAIL) * FADE_EXP_FLOOR;
  return Math.pow(FADE_EXP_FLOOR, 1 - (t - FADE_EXP_TAIL) / (1 - FADE_EXP_TAIL));
};

/** Normalised gain of one fade shape at progress `t` in [0, 1]. A fade-out is
 *  the mirror image of the fade-in of the same curve. */
const curveGain = (curve: FadeCurve, dir: 'in' | 'out', t: number): number => {
  const u = clamp01(dir === 'in' ? t : 1 - t);
  if (curve === 'equal-power') return Math.sin((u * Math.PI) / 2);
  if (curve === 'exponential') return expInGain(u);
  return u;
};

/**
 * Fit a clip's fades inside the clip.
 *
 * Each fade is clamped to `[0, durationSec]` on its own. Only when the two
 * together are longer than the clip does one give way, and it is the SMALLER
 * one that shrinks — so a 90 % in / 10 % out fade is legal, which the old
 * `durationSec / 2` cap made impossible. When they are the same length the
 * fade-in keeps its length and the fade-out gives way.
 */
export function clampClipFades(clip: Pick<FadeClip, 'durationSec' | 'fadeInSec' | 'fadeOutSec'>): ClipFades {
  const dur = sec(clip.durationSec);
  const fadeInSec = Math.min(sec(clip.fadeInSec), dur);
  const fadeOutSec = Math.min(sec(clip.fadeOutSec), dur);
  if (fadeInSec + fadeOutSec <= dur) return { fadeInSec, fadeOutSec };
  if (fadeInSec >= fadeOutSec) return { fadeInSec, fadeOutSec: Math.max(0, dur - fadeInSec) };
  return { fadeInSec: Math.max(0, dur - fadeOutSec), fadeOutSec };
}

/** The length the clip can actually be played for, and the fades that fit
 *  inside THAT. Both the evaluator and the scheduler read the envelope through
 *  this, which is what keeps them the same curve. */
const effectiveFades = (clip: FadeClip, effectiveDurationSec?: number): ClipFades & { dur: number } => {
  const nominal = sec(clip.durationSec);
  const dur = effectiveDurationSec === undefined ? nominal : Math.min(nominal, sec(effectiveDurationSec));
  return {
    dur,
    ...clampClipFades({ durationSec: dur, fadeInSec: clip.fadeInSec, fadeOutSec: clip.fadeOutSec }),
  };
};

/**
 * The clip's fade gain at `tSec` seconds into the clip (0 = the clip's head),
 * as in-gain × out-gain. Clip gain is NOT included — multiply by it if you
 * want the full envelope.
 *
 * `effectiveDurationSec` is the same option `applyFadeAutomation` takes: pass
 * it and the fade-out (and the clamp) move to the effective end, so a drawn
 * envelope matches a scheduled one on a clip whose audio runs out early.
 *
 * Outside `[0, duration]` there is no clip to hear, so the gain is 0 — and a
 * clip with no length at all is nothing but that outside.
 */
export function fadeGainAt(clip: FadeClip, tSec: number, effectiveDurationSec?: number): number {
  const { dur, fadeInSec, fadeOutSec } = effectiveFades(clip, effectiveDurationSec);
  if (dur <= 0) return 0;
  if (!(tSec >= 0) || tSec > dur) return 0;
  let gain = 1;
  if (fadeInSec > 0 && tSec < fadeInSec) {
    gain *= curveGain(clip.fadeInCurve ?? 'linear', 'in', tSec / fadeInSec);
  }
  const outStart = dur - fadeOutSec;
  if (fadeOutSec > 0 && tSec > outStart) {
    gain *= curveGain(clip.fadeOutCurve ?? 'linear', 'out', (tSec - outStart) / fadeOutSec);
  }
  return gain;
}

/** One fade still (partly) ahead of the scheduling moment. `t0` is where in the
 *  fade we are joining it; the fade always runs to its own end (`t = 1`). */
interface FadeSegment {
  dir: 'in' | 'out';
  curve: FadeCurve;
  /** Length of the whole fade in seconds. */
  fadeSec: number;
  /** Progress into the fade at which scheduling starts. */
  t0: number;
  /** Context time of the fade's own t = 0, so `ctxBase + t * fadeSec` is the
   *  context time of any progress within it. */
  ctxBase: number;
}

/**
 * Schedule a clip's fade envelope on `param`.
 *
 * `whenSec` is the param-timeline time of the clip's HEAD — it may be in the
 * past when playback started mid-clip. `fromSec` is how far into the clip
 * playback begins, so the scheduling moment is `whenSec + fromSec` and the
 * envelope is anchored there at the value it must already have. An offline
 * render passes `fromSec = 0` and `whenSec = clip.startSec`.
 *
 * `options.effectiveDurationSec` is the playable length when the decoded buffer
 * cannot fill the clip; the fade-out and the clamp move to that end instead.
 * `fadeGainAt` takes the same value, so a drawn envelope and a scheduled one
 * agree. Nothing playable — a zero peak or a zero length — parks the param at
 * silence and schedules no ramp at all.
 *
 * Exponential fades never ramp to or from zero: they ramp to `FADE_EXP_FLOOR`
 * and a linear tail covers the rest. When the param has no exponential ramp the
 * shape is rasterised through `setValueCurveAtTime`; with neither, each fade
 * degrades to a single linear ramp between its endpoints.
 */
export function applyFadeAutomation(
  param: AudioParamLike,
  clip: FadeClip,
  whenSec: number,
  fromSec = 0,
  options: FadeAutomationOptions = {},
): void {
  const rawPeak = options.peak;
  const peak = rawPeak === undefined ? 1 : peakGain(rawPeak);
  const { dur, fadeInSec, fadeOutSec } = effectiveFades(clip, options.effectiveDurationSec);
  const from = Math.min(Math.max(0, sec(fromSec)), dur);
  const nowSec = whenSec + from;

  // A silent clip, or one with nothing playable in it, has no envelope to draw
  // — and an exponential ramp towards a zero peak would be illegal anyway.
  if (peak <= 0 || dur <= 0) {
    param.setValueAtTime(0, nowSec);
    return;
  }

  const segments: FadeSegment[] = [];
  if (fadeInSec > 0 && from < fadeInSec) {
    segments.push({
      dir: 'in', curve: clip.fadeInCurve ?? 'linear', fadeSec: fadeInSec, t0: from / fadeInSec, ctxBase: whenSec,
    });
  }
  if (fadeOutSec > 0) {
    const outStart = dur - fadeOutSec;
    const segStart = Math.max(from, outStart);
    if (segStart < dur) {
      segments.push({
        dir: 'out', curve: clip.fadeOutCurve ?? 'linear', fadeSec: fadeOutSec,
        t0: (segStart - outStart) / fadeOutSec, ctxBase: whenSec + outStart,
      });
    }
  }

  // Anchor the envelope at the scheduling moment, unless the first fade already
  // starts exactly there and will set its own opening value.
  const firstStart = segments.length > 0 ? segments[0].ctxBase + segments[0].t0 * segments[0].fadeSec : NaN;
  if (segments.length === 0 || !sameTime(firstStart, nowSec)) {
    param.setValueAtTime(fadeGainAt(clip, from, options.effectiveDurationSec) * peak, nowSec);
  }

  // Time of the last rasterised curve's end, if any: an explicit event must not
  // land inside a `setValueCurveAtTime` window, and one exactly at its end is
  // redundant because the curve leaves the param at that value already.
  let curveEndsAt = NaN;
  for (const seg of segments) {
    const ctxOf = (t: number) => seg.ctxBase + t * seg.fadeSec;
    const ctx0 = ctxOf(seg.t0);
    const ctx1 = ctxOf(1);
    const startValue = curveGain(seg.curve, seg.dir, seg.t0) * peak;
    const endValue = curveGain(seg.curve, seg.dir, 1) * peak;
    const span = ctx1 - ctx0;
    if (span <= 0) {
      if (!sameTime(ctx0, curveEndsAt)) param.setValueAtTime(endValue, ctx0);
      curveEndsAt = NaN;
      continue;
    }

    const anchor = () => {
      if (!sameTime(ctx0, curveEndsAt)) param.setValueAtTime(startValue, ctx0);
      curveEndsAt = NaN;
    };

    if (seg.curve === 'exponential' && param.exponentialRampToValueAtTime) {
      anchor();
      if (seg.dir === 'in') {
        // Out of silence on a linear tail, then a straight line in dB.
        if (seg.t0 < FADE_EXP_TAIL) {
          param.linearRampToValueAtTime(FADE_EXP_FLOOR * peak, ctxOf(FADE_EXP_TAIL));
        }
        param.exponentialRampToValueAtTime(endValue, ctx1);
      } else {
        // Down in dB to the floor, then a linear tail into true silence.
        if (seg.t0 < 1 - FADE_EXP_TAIL) {
          param.exponentialRampToValueAtTime(FADE_EXP_FLOOR * peak, ctxOf(1 - FADE_EXP_TAIL));
        }
        param.linearRampToValueAtTime(endValue, ctx1);
      }
      continue;
    }

    const needsCurve = seg.curve === 'equal-power' || seg.curve === 'exponential';
    if (needsCurve && param.setValueCurveAtTime) {
      const values = new Float32Array(CURVE_SAMPLES);
      for (let i = 0; i < CURVE_SAMPLES; i += 1) {
        const t = seg.t0 + ((1 - seg.t0) * i) / (CURVE_SAMPLES - 1);
        values[i] = curveGain(seg.curve, seg.dir, t) * peak;
      }
      // The curve carries its own opening value, so no anchor event is emitted
      // — one at its start time would sit inside the curve's window.
      param.setValueCurveAtTime(values, ctx0, span);
      curveEndsAt = ctx1;
      continue;
    }

    // Linear, or a shaped fade on a param that can do nothing else.
    anchor();
    param.linearRampToValueAtTime(endValue, ctx1);
  }
}
