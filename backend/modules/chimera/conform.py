"""Per-run conform for Chimera v2: tempo + pitch in one ffmpeg rubberband
pass over the run's SOURCE span, then a gentle grid lock.

numpy + :mod:`stretch` only. Nothing here touches the router.

Timebases (see ``types.py``):

* ``SOURCE``    — seconds in the normalized clip before any conform.
                  ``render_run``'s ``src_start_sec/src_end_sec/margin_sec``
                  and ``conform_run``'s ``kept_beats_src`` live here.
* ``CONFORMED`` — ``SOURCE / ratio``. ``render_run`` returns ``t0_conformed``
                  (the CONFORMED time of ``audio[0]``) and
                  ``beats_stretched`` reports CONFORMED seconds.
* ``ARRAY``     — seconds from ``audio[0]`` (= CONFORMED - t0_conformed).
                  ``lock_to_grid`` works entirely in this frame: both
                  ``beats_conformed`` and ``origin_sec`` are ARRAY seconds.
* ``OUTPUT``    — the mashup timeline. ``RunAudio.t0_sec`` lives here.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Mapping, Optional

import numpy as np

from backend.modules.chimera.stretch import (
    RATIO_MAX,
    RATIO_MIN,
    StretchResult,
    read_stretched,
    stretch_audio,
)
from backend.modules.chimera.tempo import BEATS_PER_BAR, choose_octave
from backend.modules.chimera.types import ClipAnalysis, ConformPlan, Run, RunAudio

__all__ = [
    "MARGIN_BARS",
    "PRESETS",
    "beats_stretched",
    "conform_run",
    "lock_to_grid",
    "plan_conform",
    "render_run",
]

log = logging.getLogger(__name__)

# Pre/post-roll rendered around every run so the renderer has audio for its
# crossfade tails. In TARGET bars (converted to SOURCE seconds via the ratio).
MARGIN_BARS = 1.0

# Rubberband option presets keyed by ``ConformPlan.preset``. Values are the
# ffmpeg enum names (validated by ``stretch.RB_OPTION_VALUES``).
PRESETS: dict[str, dict[str, str]] = {
    "percussive": {"transients": "crisp", "detector": "percussive", "window": "short"},
    "tonal": {
        "transients": "smooth",
        "detector": "soft",
        "window": "long",
        "smoothing": "on",
    },
    "default": {"transients": "mixed", "detector": "compound"},
}

_PERCUSSIVE_MIN = 0.6
_TONAL_MAX = 0.3
_LOCK_MIN_CONFIDENCE = 0.5
_LOCK_MIN_BEATS = 8
_ON_GRID_SEC = 0.003  # max |residual| below this = already on grid
_SMOOTH_KERNEL = np.array([1.0, 2.0, 2.0, 2.0, 1.0]) / 8.0  # centred, 4 beats wide
_RESAMPLE_CHUNK = 1 << 20  # output frames per vectorised Hermite pass


# --------------------------------------------------------------------------
# planning
# --------------------------------------------------------------------------


def plan_conform(
    a: ClipAnalysis | Mapping[str, Any],
    target_bpm: float,
    semitones: int,
    is_layer_source: bool = False,
    grid_lock: str = "auto",
) -> ConformPlan:
    """Decide ratio / octave / rubberband preset / grid-lock for one clip.

    * ``bpm None`` -> ratio 1, multiplier 1, note ``'no BPM; not stretched'``.
    * Otherwise ``(m, ratio) = tempo.choose_octave(bpm, target_bpm)``; the
      ratio is clamped to ``[0.5, 2.0]`` (with a note) so it matches what
      ``stretch_audio`` will actually run.
    * Preset from ``percussive_ratio``: ``> 0.6`` percussive, ``< 0.3``
      tonal, else default. ``formant=preserved`` is added only when a pitch
      shift is requested AND this render feeds the stem "layer" role.
    * ``lock`` = ``grid_lock != 'off'`` and the fitted grid is confident
      (``>= 0.5``) and steady.
    """
    bpm = a.get("bpm")
    notes: list[str] = []
    if bpm is None or float(bpm) <= 0 or target_bpm <= 0:
        multiplier, ratio = 1.0, 1.0
        notes.append("no BPM; not stretched")
    else:
        multiplier, ratio = choose_octave(float(bpm), float(target_bpm))
        if ratio < RATIO_MIN or ratio > RATIO_MAX:
            ratio = min(RATIO_MAX, max(RATIO_MIN, ratio))
            notes.append(f"stretch ratio clamped to [{RATIO_MIN}, {RATIO_MAX}]")

    perc = a.get("percussive_ratio")
    perc = 0.5 if perc is None else float(perc)
    if perc > _PERCUSSIVE_MIN:
        preset = "percussive"
    elif perc < _TONAL_MAX:
        preset = "tonal"
    else:
        preset = "default"
    rb_options = dict(PRESETS[preset])
    semitones = int(semitones)
    if semitones != 0 and is_layer_source:
        rb_options["formant"] = "preserved"

    grid = a.get("grid")
    lock = bool(
        grid_lock != "off"
        and grid is not None
        and float(grid.get("confidence", 0.0)) >= _LOCK_MIN_CONFIDENCE
        and bool(grid.get("steady", False))
    )
    plan: ConformPlan = {
        "ratio": float(ratio),
        "tempo_multiplier": float(multiplier),
        "semitones": semitones,
        "rb_options": rb_options,
        "preset": preset,  # type: ignore[typeddict-item]
        "lock": lock,
        "note": "; ".join(notes) if notes else None,
    }
    log.debug(
        "plan_conform: bpm=%s target=%.3f -> m=%.1f ratio=%.4f preset=%s st=%d lock=%s",
        bpm,
        float(target_bpm),
        multiplier,
        ratio,
        preset,
        semitones,
        lock,
    )
    return plan


# --------------------------------------------------------------------------
# rendering
# --------------------------------------------------------------------------


def _ensure_stereo(audio: np.ndarray) -> np.ndarray:
    arr = np.asarray(audio, dtype=np.float32)
    if arr.ndim == 1:
        arr = np.stack([arr, arr], axis=1)
    elif arr.shape[1] == 1:
        arr = np.repeat(arr, 2, axis=1)
    elif arr.shape[1] > 2:
        arr = arr[:, :2]
    return np.ascontiguousarray(arr, dtype=np.float32)


def _render_span(
    norm_path: Path | str,
    out_path: Path | str,
    plan: ConformPlan,
    src_start_sec: float,
    src_end_sec: float,
    margin_sec: float,
    timeout_sec: float,
) -> tuple[np.ndarray, float, StretchResult, int]:
    """``render_run`` plus the sample rate ffmpeg actually wrote."""
    span = (
        max(0.0, float(src_start_sec) - float(margin_sec)),
        float(src_end_sec) + float(margin_sec),
    )
    result = stretch_audio(
        norm_path,
        out_path,
        float(plan["ratio"]),
        timeout_sec=timeout_sec,
        pitch_semitones=float(plan["semitones"]),
        rb_options=plan["rb_options"],
        span=span,
    )
    audio, read_sr = read_stretched(result["output_path"])
    ratio_used = float(result["ratio_used"]) or 1.0
    span_used = result["span_used"] or span
    t0_conformed = float(span_used[0]) / ratio_used
    return _ensure_stereo(audio), t0_conformed, result, int(read_sr)


def render_run(
    norm_path: Path | str,
    out_path: Path | str,
    plan: ConformPlan,
    src_start_sec: float,
    src_end_sec: float,
    margin_sec: float,
    timeout_sec: float = 180.0,
) -> tuple[np.ndarray, float, StretchResult]:
    """Stretch (and pitch-shift) the SOURCE span
    ``[src_start - margin, src_end + margin]`` of ``norm_path`` in one ffmpeg
    pass.

    ``src_start_sec``, ``src_end_sec`` and ``margin_sec`` are all SOURCE
    seconds. The span start is clamped at 0; ffmpeg clips the end at EOF.

    Returns ``(audio [N, 2] float32, t0_conformed, result)`` where
    ``t0_conformed = span_start / ratio_used`` is the CONFORMED time of
    ``audio[0]``. The audio is at whatever rate the input file has (the
    router normalizes to ``out_sr`` first; ``conform_run`` re-checks).
    """
    audio, t0_conformed, result, _sr = _render_span(
        norm_path, out_path, plan, src_start_sec, src_end_sec, margin_sec, timeout_sec
    )
    return audio, t0_conformed, result


# --------------------------------------------------------------------------
# grid lock
# --------------------------------------------------------------------------


def _smooth_residuals(r: np.ndarray) -> np.ndarray:
    """Centred moving average spanning 4 beats (kernel ``[1,2,2,2,1]/8``),
    edge-padded so the ends are not pulled toward zero. A symmetric kernel
    keeps a smoothly drifting residual unbiased (an even-length causal
    window would shift it by half a beat's slope)."""
    if r.size < 3:
        return r.copy()
    half = (_SMOOTH_KERNEL.size - 1) // 2
    padded = np.pad(r, (half, half), mode="edge")
    return np.convolve(padded, _SMOOTH_KERNEL, mode="valid")


def _hermite_resample(audio: np.ndarray, in_pos: np.ndarray) -> np.ndarray:
    """Vectorised 4-point cubic Hermite (Catmull-Rom) resampler.

    ``in_pos[n]`` is the fractional INPUT sample position of OUTPUT sample
    ``n``. Positions outside the input read as silence. Processed in chunks
    so the four gathered taps never exceed a few hundred MB.
    """
    n_in, n_ch = audio.shape
    pad = np.zeros((2, n_ch), dtype=np.float32)
    x = np.concatenate([pad, audio.astype(np.float32, copy=False), pad], axis=0)
    last = x.shape[0] - 1
    n_out = in_pos.shape[0]
    out = np.empty((n_out, n_ch), dtype=np.float32)
    for start in range(0, n_out, _RESAMPLE_CHUNK):
        p = in_pos[start : start + _RESAMPLE_CHUNK]
        i0 = np.floor(p)
        t = (p - i0).astype(np.float32)[:, None]
        base = i0.astype(np.int64) + 2  # padded index of the p1 tap
        p0 = np.take(x, np.clip(base - 1, 0, last), axis=0)
        p1 = np.take(x, np.clip(base, 0, last), axis=0)
        p2 = np.take(x, np.clip(base + 1, 0, last), axis=0)
        p3 = np.take(x, np.clip(base + 2, 0, last), axis=0)
        c1 = 0.5 * (p2 - p0)
        c2 = p0 - 2.5 * p1 + 2.0 * p2 - 0.5 * p3
        c3 = 0.5 * (p3 - p0) + 1.5 * (p1 - p2)
        out[start : start + p.shape[0]] = p1 + t * (c1 + t * (c2 + t * c3))
    return out


def lock_to_grid(
    audio: np.ndarray,
    sr: int,
    beats_conformed: list[float],
    beat_sec: float,
    origin_sec: float,
    max_rate_dev: float = 0.015,
    max_median_residual_ms: float = 60.0,
) -> tuple[np.ndarray, dict]:
    """Warp ``audio`` so its detected beats land on ``origin + k * beat_sec``.

    ``beats_conformed`` and ``origin_sec`` are ARRAY seconds (CONFORMED
    time minus the CONFORMED time of ``audio[0]``). For each beat the
    residual ``r_k = dst_k - src_k`` to the nearest grid line is computed,
    smoothed with a centred 4-beat moving average (beat-tracker noise must
    not become rate wobble), turned into per-interval rates
    ``1 + dr/dsrc`` clipped to ``[1 - dev, 1 + dev]``, and integrated
    outward from the beat nearest ``origin_sec`` (so the phrase start is
    exact and any clipping error accumulates toward the tails) into a
    monotone piecewise-linear OUTPUT -> INPUT sample map; outside the beats
    the map continues at rate 1. Audio is resampled with a 4-point cubic
    Hermite.

    Returns ``(audio, report)``. The input array is returned untouched
    (``applied: False`` with a ``reason``) when there are fewer than 8
    beats, when ``max |r| < 3 ms`` (``'already on grid'``) or when the
    median |r| exceeds ``max_median_residual_ms`` (the beats and the grid
    disagree; warping would make things worse).
    """
    n_in = int(audio.shape[0])
    dur = n_in / float(sr) if sr > 0 else 0.0
    beats = np.unique(np.asarray(beats_conformed, dtype=np.float64))
    beats = beats[(beats >= 0.0) & (beats <= dur)]
    n = int(beats.size)
    report: dict[str, Any] = {"applied": False, "n_beats": n}
    if n < _LOCK_MIN_BEATS or beat_sec <= 0 or sr <= 0:
        report["reason"] = f"too few beats ({n} < {_LOCK_MIN_BEATS})"
        return audio, report

    k = np.round((beats - origin_sec) / beat_sec)
    dst = origin_sec + k * beat_sec
    r = dst - beats
    abs_r = np.abs(r)
    median_ms = float(np.median(abs_r) * 1000.0)
    max_ms = float(abs_r.max() * 1000.0)
    report["median_residual_ms"] = median_ms
    report["max_residual_ms"] = max_ms
    if max_ms < _ON_GRID_SEC * 1000.0:
        report["reason"] = "already on grid"
        return audio, report
    if median_ms > max_median_residual_ms:
        report["reason"] = (
            f"median residual {median_ms:.1f} ms > {max_median_residual_ms:.0f} ms"
        )
        return audio, report

    r_s = _smooth_residuals(r)
    d_in = np.diff(beats)
    rate = 1.0 + np.diff(r_s) / d_in
    rate_clipped = np.clip(rate, 1.0 - max_rate_dev, 1.0 + max_rate_dev)
    n_clipped = int(np.count_nonzero(rate_clipped != rate))

    k0 = int(np.argmin(np.abs(beats - origin_sec)))
    out = np.empty(n, dtype=np.float64)
    out[k0] = beats[k0] + r_s[k0]
    step = rate_clipped * d_in
    if k0 + 1 < n:
        out[k0 + 1 :] = out[k0] + np.cumsum(step[k0:])
    if k0 > 0:
        out[:k0] = out[k0] - np.cumsum(step[:k0][::-1])[::-1]

    # Extend both ends at rate 1 so the pre/post-roll is shifted, not warped.
    big = dur + 10.0
    in_anchor = np.concatenate(([beats[0] - big], beats, [beats[-1] + big])) * sr
    out_anchor = np.concatenate(([out[0] - big], out, [out[-1] + big])) * sr
    n_out = int(round(float(np.interp(n_in, in_anchor, out_anchor))))
    n_out = max(1, n_out)
    in_pos = np.interp(np.arange(n_out, dtype=np.float64), out_anchor, in_anchor)
    locked = _hermite_resample(audio, in_pos)

    report.update(
        {
            "applied": True,
            "max_rate_dev_used": float(np.max(np.abs(rate_clipped - 1.0))),
            "intervals_clipped": n_clipped,
            "length_delta_ms": (n_out - n_in) / sr * 1000.0,
        }
    )
    log.debug(
        "lock_to_grid: n=%d median=%.1fms max=%.1fms rate_dev=%.3f%% clipped=%d "
        "len=%d->%d",
        n,
        median_ms,
        max_ms,
        report["max_rate_dev_used"] * 100.0,
        n_clipped,
        n_in,
        n_out,
    )
    return locked, report


# --------------------------------------------------------------------------
# per-run driver
# --------------------------------------------------------------------------


def conform_run(
    norm_path: Path | str,
    work_dir: Path | str,
    plan: ConformPlan,
    run: Run | Mapping[str, Any],
    beat_sec: float,
    grid_origin_conformed: Optional[float],
    kept_beats_src: list[float],
    sr: int,
    kind: str = "full",
    timeout_sec: float = 180.0,
    margin_bars: float = MARGIN_BARS,
) -> RunAudio:
    """Render one run: ``render_run`` over the run's SOURCE span (plus
    ``margin_bars`` target bars of margin each side, default one), then
    ``lock_to_grid`` on the beats inside that span when ``plan['lock']``.

    * ``beat_sec`` is the TARGET beat length (OUTPUT/CONFORMED seconds).
    * ``margin_bars`` must cover the longest crossfade tail the renderer
      will ask for (the router passes the schedule's largest fade).
    * ``grid_origin_conformed`` is the CONFORMED time that must land on an
      integer beat; ``None`` -> ``run.src_start_sec / ratio`` (the phrase
      start IS a downbeat by construction).
    * ``kept_beats_src`` are SOURCE seconds (the fitted grid's kept beats,
      or the octave-rebuilt beats).
    * ``sr`` is the sample rate the normalized file is at; a mismatching
      render is resampled to it.

    ``RunAudio.t0_sec`` (OUTPUT) ``= run.output_start_sec -
    (run.src_start_sec / ratio - t0_conformed)``, i.e. the run's nominal
    start minus the conformed pre-roll actually rendered.
    ``lock_report['stretch']`` carries the stretch engine / pitch actually
    used (``engine``, ``pitch_semitones_used``, ``filter``, ``note``,
    ``ratio_used``, ``span_used``).
    """
    work = Path(work_dir)
    work.mkdir(parents=True, exist_ok=True)
    run_id = int(run["run_id"])
    ratio = float(plan["ratio"]) or 1.0
    src_start = float(run["src_start_sec"])
    src_end = float(run["src_end_sec"])
    margin_src = max(0.0, float(margin_bars)) * BEATS_PER_BAR * float(beat_sec) * ratio
    out_path = work / f"run{run_id:03d}_{kind}.wav"

    audio, t0_conformed, result, read_sr = _render_span(
        norm_path, out_path, plan, src_start, src_end, margin_src, timeout_sec
    )
    ratio_used = float(result["ratio_used"]) or ratio
    if ratio_used != ratio:
        log.warning(
            "conform_run %d: stretch ratio %.4f differs from plan %.4f",
            run_id,
            ratio_used,
            ratio,
        )
        ratio = ratio_used

    if read_sr != int(sr) and read_sr > 0 and audio.shape[0] > 1:
        # The router normalizes to out_sr before conforming, so this only
        # fires on an odd ffmpeg build; a constant-rate Hermite pass fixes it.
        log.warning(
            "conform_run %d: render is %d Hz, resampling to %d Hz", run_id, read_sr, sr
        )
        n_out = int(round(audio.shape[0] * float(sr) / read_sr))
        in_pos = np.arange(n_out, dtype=np.float64) * (read_sr / float(sr))
        audio = _hermite_resample(audio, in_pos)

    origin_conformed = (
        src_start / ratio
        if grid_origin_conformed is None
        else float(grid_origin_conformed)
    )
    origin_arr = origin_conformed - t0_conformed
    span_used = result["span_used"] or (
        max(0.0, src_start - margin_src),
        src_end + margin_src,
    )
    beats_src = np.asarray(kept_beats_src, dtype=np.float64)
    inside = beats_src[(beats_src >= span_used[0]) & (beats_src <= span_used[1])]
    beats_arr = [float(b / ratio - t0_conformed) for b in inside]

    report: dict[str, Any]
    if plan["lock"]:
        audio, report = lock_to_grid(audio, sr, beats_arr, float(beat_sec), origin_arr)
    else:
        report = {
            "applied": False,
            "reason": "lock disabled by plan",
            "n_beats": len(beats_arr),
        }
    report["origin_sec"] = origin_arr
    report["stretch"] = {
        "engine": result["engine"],
        "pitch_semitones_used": float(result["pitch_semitones_used"]),
        "filter": result["filter"],
        "note": result["note"],
        "ratio_used": ratio_used,
        "span_used": [float(span_used[0]), float(span_used[1])],
    }

    t0_sec = float(run["output_start_sec"]) - (src_start / ratio - t0_conformed)
    log.debug(
        "conform_run %d (%s): span=%.3f-%.3f ratio=%.4f engine=%s len=%.3fs t0=%.3f locked=%s",
        run_id,
        kind,
        span_used[0],
        span_used[1],
        ratio,
        result["engine"],
        audio.shape[0] / float(sr),
        t0_sec,
        report["applied"],
    )
    return {
        "run_id": run_id,
        "kind": kind,  # type: ignore[typeddict-item]
        "audio": audio,
        "t0_sec": t0_sec,
        "locked": bool(report["applied"]),
        "lock_report": report,
    }


def beats_stretched(
    a: ClipAnalysis | Mapping[str, Any],
    plan: ConformPlan,
    tl_beat_sec: float,
    beats: Optional[list[float]] = None,
) -> list[float]:
    """CONFORMED beat times for the response: the kept beats (or ``beats``
    when given, e.g. the octave-rebuilt list) divided by the ratio, snapped
    to the nearest ``k * tl_beat_sec`` when the plan locks to the grid."""
    if beats is None:
        grid = a.get("grid")
        src = (
            grid["kept_beats"]
            if grid and grid.get("kept_beats")
            else a.get("beats", [])
        )
    else:
        src = beats
    ratio = float(plan["ratio"]) or 1.0
    arr = np.asarray(src, dtype=np.float64) / ratio
    if plan["lock"] and tl_beat_sec > 0 and arr.size:
        arr = np.round(arr / tl_beat_sec) * tl_beat_sec
    return [float(t) for t in arr]
