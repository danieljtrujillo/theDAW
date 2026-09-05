"""Tempo arithmetic for Chimera v2: octave folding, beat-grid fitting and
target-BPM resolution.

Pure functions over floats/lists; numpy + statistics only. Nothing here
touches audio. All beat times are SOURCE seconds (pre-conform).
"""

from __future__ import annotations

import logging
import math
from collections.abc import Callable
from typing import Optional

import numpy as np

from backend.modules.chimera.types import BeatGrid
from backend.modules.chimera.weave import BEATS_PER_BAR, bar_duration_sec

__all__ = [
    "BEATS_PER_BAR",
    "bar_duration_sec",
    "choose_octave",
    "fit_beat_grid",
    "fit_tempo_to_duration",
    "fold_bpm",
    "rebuild_beats",
    "resolve_target_bpm_v2",
]

log = logging.getLogger(__name__)

_MIN_GRID_BEATS = 8
_OUTLIER_FRAC = 0.15  # residual cut floor (fraction of a period)
_OUTLIER_FRAC_MAX = 0.25  # residual cut ceiling (fraction of a period)
_STEADY_CV = 0.08
_MIN_WEIGHT = 0.05
_FALLBACK_BPM = 120.0
_OCTAVE_MULTIPLIERS = (1.0, 0.5, 2.0)  # 1.0 first so ties prefer no octave change


def fold_bpm(bpm: float, lo: float = 80.0, hi: float = 160.0) -> float:
    """Fold ``bpm`` into ``[lo, hi)`` by doubling / halving."""
    b = float(bpm)
    if b <= 0 or not math.isfinite(b):
        return b
    while b < lo:
        b *= 2.0
    while b >= hi:
        b /= 2.0
    return b


def choose_octave(bpm: float, target: float) -> tuple[float, float]:
    """Pick the octave multiplier ``m`` in (0.5, 1, 2) that brings ``m * bpm``
    closest (in log distance) to ``target``.

    Returns ``(m, ratio)`` with ``ratio = target / (m * bpm)``. Ties prefer
    ``m = 1.0``. Examples: (70, 140) -> (2.0, 1.0); (200, 100) -> (0.5, 1.0);
    (100, 128) -> (1.0, 1.28).
    """
    if bpm <= 0 or target <= 0:
        raise ValueError("bpm and target must be positive")
    best_m = 1.0
    best_d = math.inf
    for m in _OCTAVE_MULTIPLIERS:
        d = abs(math.log(target / (m * bpm)))
        if d < best_d - 1e-12:
            best_d = d
            best_m = m
    return best_m, target / (best_m * bpm)


def rebuild_beats(
    beats: list[float],
    multiplier: float,
    low_onset_at: Optional[Callable[[float], float]] = None,
) -> list[float]:
    """Re-express a beat list at an octave multiplier.

    * ``1.0`` -> copy.
    * ``2.0`` -> midpoints inserted between consecutive beats, plus one after
      the last beat using the last interval (beats at double time).
    * ``0.5`` -> every other beat, ``beats[p::2]`` where ``p`` in {0, 1}
      maximises ``sum(low_onset_at(t))`` (``p = 0`` when no callable).
    """
    src = [float(b) for b in beats]
    if multiplier == 1.0:
        return src
    if multiplier == 2.0:
        if len(src) < 2:
            return src
        arr = np.asarray(src, dtype=np.float64)
        mids = (arr[:-1] + arr[1:]) / 2.0
        out = np.empty(2 * len(arr), dtype=np.float64)
        out[0::2] = arr
        out[1:-1:2] = mids
        out[-1] = arr[-1] + (arr[-1] - arr[-2]) / 2.0
        return [float(t) for t in out]
    if multiplier == 0.5:
        if len(src) < 2:
            return src
        p = 0
        if low_onset_at is not None:
            s0 = sum(float(low_onset_at(t)) for t in src[0::2])
            s1 = sum(float(low_onset_at(t)) for t in src[1::2])
            p = 1 if s1 > s0 else 0
        return src[p::2]
    raise ValueError(f"unsupported tempo multiplier {multiplier!r}")


def _weighted_median(values: list[float], weights: list[float]) -> float:
    order = sorted(range(len(values)), key=lambda i: values[i])
    vals = [values[i] for i in order]
    wts = [weights[i] for i in order]
    total = sum(wts)
    half = total / 2.0
    cum = 0.0
    for i, (v, w) in enumerate(zip(vals, wts)):
        cum += w
        if cum > half + 1e-12:
            return v
        if abs(cum - half) <= 1e-12 and i + 1 < len(vals):
            # exact split (e.g. two equal weights): average the neighbours,
            # matching statistics.median for equal weights
            return (v + vals[i + 1]) / 2.0
    return vals[-1]


def resolve_target_bpm_v2(
    user_target: Optional[float],
    base_index: Optional[int],
    detected: list[Optional[float]],
    weights: list[float],
) -> tuple[float, str]:
    """Resolve the mashup target BPM.

    Priority: ``base_index`` (that clip's RAW detected BPM, source
    ``'base_clip'``; ``ValueError`` when it has none) > ``user_target``
    (``'user'``) > weighted median of ``fold_bpm(b)`` over clips with a BPM
    (weights clamped >= 0.05, ``'median'``) > ``(120.0, 'fallback')``.
    """
    if base_index is not None:
        if base_index < 0 or base_index >= len(detected):
            raise ValueError(
                f"base_index {base_index} out of range [0, {len(detected)})"
            )
        b = detected[base_index]
        if b is None:
            raise ValueError("base clip has no detected BPM")
        return float(b), "base_clip"
    if user_target is not None:
        return float(user_target), "user"
    vals: list[float] = []
    wts: list[float] = []
    for i, b in enumerate(detected):
        if b is None or b <= 0:
            continue
        w = float(weights[i]) if i < len(weights) else 1.0
        vals.append(fold_bpm(float(b)))
        wts.append(max(_MIN_WEIGHT, w))
    if vals:
        return float(_weighted_median(vals, wts)), "median"
    return _FALLBACK_BPM, "fallback"


def _ls_line(idx: np.ndarray, t: np.ndarray) -> tuple[float, float]:
    """Least-squares line ``t = slope * idx + intercept``."""
    if idx.size < 2:
        return 0.0, float(t[0]) if t.size else 0.0
    x = idx.astype(np.float64)
    y = t.astype(np.float64)
    xm = float(x.mean())
    var = float(np.sum((x - xm) ** 2))
    if var <= 0:
        return 0.0, float(y.mean())
    slope = float(np.sum((x - xm) * (y - y.mean())) / var)
    intercept = float(y.mean() - slope * xm)
    return slope, intercept


def _residual_threshold(resid: np.ndarray, period: float) -> float:
    """Outlier cut for one fit pass: 3.5 x the MAD-scaled residual spread,
    never below ``0.15 * period`` (so a clean list still rejects spurious
    onsets 0.3-0.4 of a beat off) and never above ``0.25 * period`` (beyond
    that a beat is indistinguishable from a spurious one). A jittery but
    real list therefore keeps all its beats instead of a self-consistent
    subset that would read as steady."""
    med = float(np.median(resid))
    mad = float(np.median(np.abs(resid - med))) * 1.4826
    return float(
        min(_OUTLIER_FRAC_MAX * period, max(_OUTLIER_FRAC * period, 3.5 * mad))
    )


def _dedup_indices(ik: np.ndarray, resid: np.ndarray, keep: np.ndarray) -> np.ndarray:
    """Among kept beats sharing one grid index keep only the closest one."""
    out = keep.copy()
    kept_pos = np.flatnonzero(keep)
    if kept_pos.size < 2:
        return out
    order = kept_pos[np.lexsort((np.abs(resid[kept_pos]), ik[kept_pos]))]
    _, first = np.unique(ik[order], return_index=True)
    out[:] = False
    out[order[first]] = True
    return out


def fit_beat_grid(
    beats: list[float],
    bpm: Optional[float],
    max_pairs: int = 200,
) -> BeatGrid:
    """Fit a constant-tempo line through a detected beat list (SOURCE time).

    Beat numbering is CUMULATIVE: every inter-beat interval is rounded to a
    whole number of periods (median interval) on its own, so a dropped beat
    (step 2) or a spurious onset (step 0) never shifts the numbering of the
    beats after it and a biased initial period cannot mis-number the far
    end. A least-squares line through (number, time) then gives the period
    and phase — the AVERAGE tempo of the list. (Beat trackers run at their
    own tempo estimate and periodically re-sync to the real onsets, so a
    median of pairwise slopes locks onto that estimate — 1-2 % off — and
    throws two thirds of the beats away as "outliers"; the mean interval
    is exact.) Three passes re-number every beat against the fitted line,
    drop |residual| > 0.15 * period (spurious onsets; duplicates of one
    grid index keep the closest beat) and refit on the survivors.

    ``cv`` is the coefficient of variation of the kept inter-beat
    intervals, each normalised by the integer number of grid steps it spans
    (a single dropped beat must not read as a tempo wobble). Fewer than 8
    beats -> confidence 0, ``steady`` False. ``max_pairs`` is accepted for
    backwards compatibility and ignored.
    """
    src = [float(b) for b in beats]
    nominal = (60.0 / float(bpm)) if bpm else None
    if len(src) < _MIN_GRID_BEATS:
        return {
            "period_sec": nominal if nominal else 0.5,
            "phase_sec": src[0] if src else 0.0,
            "drift_pct": 0.0,
            "cv": 1.0,
            "confidence": 0.0,
            "kept_beats": src,
            "steady": False,
        }

    t = np.asarray(sorted(src), dtype=np.float64)
    diffs = np.diff(t)
    period0 = (
        float(np.median(diffs[diffs > 0])) if np.any(diffs > 0) else (nominal or 0.5)
    )
    if period0 <= 0:
        period0 = nominal or 0.5
    steps = np.maximum(0, np.floor(diffs / period0 + 0.5)).astype(np.int64)
    idx = np.concatenate(([0], np.cumsum(steps))).astype(np.float64)

    slope, intercept = _ls_line(idx, t)
    if not np.isfinite(slope) or slope <= 0:
        slope, intercept = period0, float(t[0])
    keep = np.ones(t.size, dtype=bool)
    for _ in range(3):
        ik = np.round((t - intercept) / slope)
        resid = t - (slope * ik + intercept)
        keep = np.abs(resid) <= _residual_threshold(resid, slope)
        if keep.sum() < 2:
            keep = np.ones_like(keep, dtype=bool)
        keep = _dedup_indices(ik, resid, keep)
        s2, i2 = _ls_line(ik[keep], t[keep])
        if np.isfinite(s2) and s2 > 0:
            slope, intercept = s2, i2
    tk = t[keep]
    # nanosecond rounding: an exact input grid comes back exact (no 1e-14
    # float noise deciding whether a beat sits before or after the clip end)
    slope2 = round(float(slope), 9)
    intercept2 = round(float(intercept), 9)

    kd = np.diff(tk)
    steps = np.maximum(1.0, np.round(kd / slope2))
    norm = kd / steps
    norm = norm[norm > 0]
    if norm.size >= 2 and float(norm.mean()) > 0:
        cv = float(norm.std() / norm.mean())
    else:
        cv = 1.0
    drift_pct = abs(slope2 / nominal - 1.0) * 100.0 if nominal else 0.0
    confidence = max(0.0, min(1.0, 1.0 - cv))
    log.debug(
        "fit_beat_grid: n=%d kept=%d period=%.5f phase=%.4f cv=%.4f drift=%.2f%%",
        len(t),
        len(tk),
        slope2,
        intercept2,
        cv,
        drift_pct,
    )
    return {
        "period_sec": float(slope2),
        "phase_sec": float(intercept2),
        "drift_pct": float(drift_pct),
        "cv": cv,
        "confidence": confidence,
        "kept_beats": [float(x) for x in tk],
        "steady": cv <= _STEADY_CV,
    }


def fit_tempo_to_duration(
    target_bpm: float,
    duration_sec: float,
    max_pct: float = 3.0,
) -> tuple[float, int, float]:
    """Nudge ``target_bpm`` (<= ``max_pct`` percent) so an integer number of
    bars lands exactly on ``duration_sec``.

    Returns ``(bpm, total_bars, pct)``. When the nudge would exceed
    ``max_pct`` the tempo is kept and the bar count floors instead
    (``pct = 0``). ``total_bars`` is never below 4.
    """
    if target_bpm <= 0 or duration_sec <= 0:
        raise ValueError("target_bpm and duration_sec must be positive")
    bar_sec = 240.0 / target_bpm
    total_bars = max(4, int(math.floor(duration_sec / bar_sec + 0.5)))
    bpm2 = total_bars * 240.0 / duration_sec
    pct = (bpm2 / target_bpm - 1.0) * 100.0
    if abs(pct) <= max_pct:
        return float(bpm2), total_bars, float(pct)
    return float(target_bpm), max(4, int(math.floor(duration_sec / bar_sec))), 0.0
