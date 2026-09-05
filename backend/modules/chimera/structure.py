"""Structure analysis for Chimera v2: downbeat phase, bar feature table,
phrase phase and the phrase table, all on the SOURCE beat grid (pre-conform,
22.05 kHz mono).

Pipeline (``analyze_structure`` orchestrates it and never raises):

1. ``beat_frames_from_grid``  -- exact beat times from the fitted grid
2. ``beat_features``          -- one STFT, per-beat onset / rms / chroma /
                                 mfcc / centroid tables
3. ``estimate_downbeat_phase``-- which beat index (mod 4) is the downbeat
4. ``bar_features``           -- 4-beat groups from the downbeat phase
5. ``estimate_phrase_phase``  -- which bar index (mod P) starts phrases
6. ``build_phrases``          -- P-bar phrase table with loudness + labels

librosa + numpy + pyloudnorm only; no hpss / pyin. Every time in seconds
returned by this module is SOURCE time.
"""

from __future__ import annotations

import logging
import math
from typing import Optional, TypedDict

import numpy as np

from backend.modules.chimera.types import BarFeature, BeatGrid, Phrase
from backend.modules.chimera.weave import BEATS_PER_BAR

__all__ = [
    "BeatFeatures",
    "StructureResult",
    "analyze_structure",
    "bar_features",
    "beat_features",
    "beat_frames_from_grid",
    "build_phrases",
    "estimate_downbeat_phase",
    "estimate_phrase_phase",
]

log = logging.getLogger(__name__)

_HOP = 512
_N_FFT = 2048
_N_MELS = 64
_CHROMA_HOP = 2048  # chroma_cqt hop; a multiple of 2**(n_octaves - 1)
_CHROMA_OCTAVES = 6  # C2 .. C8: keeps kick / sub fundamentals out of chroma
_BAND_EDGES = (0, 8, 24, 64)  # mel bins: low ~<260 Hz, mid ~260-1100, high
_MIN_GRID_CONF = 0.3  # below this the noisy kept_beats are used as-is
_MIN_PHRASE_BARS = 4
_LUFS_MIN_SEC = 3.0  # pyloudnorm needs a few 400 ms blocks to gate
_EPS = 1e-9
_DB_FLOOR = -120.0


class BeatFeatures(TypedDict):
    """Per-beat feature tables (B beats). Onset envelopes are the MAX over
    the beat span, everything else the MEAN."""

    low: np.ndarray  # [B] onset strength, mel bins 0-8
    mid: np.ndarray  # [B] onset strength, mel bins 8-24
    high: np.ndarray  # [B] onset strength, mel bins 24-64
    broad: np.ndarray  # [B] onset strength, all 64 mel bins
    low_level: np.ndarray  # [B] peak low-band (mel 0-8) power over the beat, dB
    broad_level: np.ndarray  # [B] peak full-band power over the beat, dB
    rms: np.ndarray  # [B] linear RMS
    chroma: np.ndarray  # [12, B]
    mfcc: np.ndarray  # [13, B]
    centroid: np.ndarray  # [B] Hz
    bounds: np.ndarray  # [B + 1] frame boundaries of each beat (hop frames)
    broad_env: np.ndarray  # [T] frame-level broad onset envelope
    hop: int
    sr: int


class StructureResult(TypedDict):
    downbeat_phase: int
    downbeat_confidence: float
    phrase_phase: int
    phrase_confidence: float
    bars: list[BarFeature]
    beat_times: list[float]  # SOURCE seconds; the grid the bars were built on


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------


def _mono(y: np.ndarray) -> np.ndarray:
    a = np.asarray(y, dtype=np.float32)
    if a.ndim == 2:
        a = a.mean(axis=1).astype(np.float32)
    return np.ascontiguousarray(a)


def _zscore(x: np.ndarray) -> np.ndarray:
    x = np.asarray(x, dtype=np.float64)
    if x.size == 0:
        return x
    sd = float(x.std())
    if not np.isfinite(sd) or sd <= 1e-12:
        return np.zeros_like(x)
    return (x - x.mean()) / sd


def _cos_dist(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Column-wise cosine distance between ``a`` and ``b`` ([D, N] each).
    A zero vector on either side reads as distance 0 (no change)."""
    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    na = np.linalg.norm(a, axis=0)
    nb = np.linalg.norm(b, axis=0)
    dot = np.sum(a * b, axis=0)
    denom = na * nb
    ok = denom > _EPS
    out = np.zeros(a.shape[1], dtype=np.float64)
    out[ok] = 1.0 - dot[ok] / denom[ok]
    return np.clip(out, 0.0, 2.0)


def _sync(x: np.ndarray, bounds: np.ndarray, mode: str) -> np.ndarray:
    """Aggregate frame features ``x`` ([T] or [C, T]) into beat bins
    ``[bounds[i], bounds[i+1])`` (``bounds[-1] == T``). Uses reduceat so an
    empty bin (duplicate boundary) yields that frame instead of raising."""
    x2 = np.atleast_2d(np.asarray(x, dtype=np.float64))
    starts = bounds[:-1]
    if starts.size == 0:
        out = np.zeros((x2.shape[0], 0), dtype=np.float64)
    elif mode == "max":
        out = np.maximum.reduceat(x2, starts, axis=-1)
    else:
        sums = np.add.reduceat(x2, starts, axis=-1)
        counts = np.maximum(1, np.diff(bounds)).astype(np.float64)
        out = sums / counts
    return out[0] if np.ndim(x) == 1 else out


def _match_frames(x: np.ndarray, n_frames: int) -> np.ndarray:
    """Trim / edge-pad the last axis of ``x`` to exactly ``n_frames``."""
    t = x.shape[-1]
    if t == n_frames:
        return x
    if t > n_frames:
        return x[..., :n_frames]
    pad = [(0, 0)] * (x.ndim - 1) + [(0, n_frames - t)]
    return (
        np.pad(x, pad, mode="edge") if t > 0 else np.zeros(x.shape[:-1] + (n_frames,))
    )


def _empty_features(hop: int, sr: int, n_frames: int) -> BeatFeatures:
    z = np.zeros(0, dtype=np.float64)
    return {
        "low": z,
        "mid": z.copy(),
        "high": z.copy(),
        "broad": z.copy(),
        "low_level": z.copy(),
        "broad_level": z.copy(),
        "rms": z.copy(),
        "chroma": np.zeros((12, 0), dtype=np.float64),
        "mfcc": np.zeros((13, 0), dtype=np.float64),
        "centroid": z.copy(),
        "bounds": np.asarray([n_frames], dtype=np.int64),
        "broad_env": np.zeros(n_frames, dtype=np.float64),
        "hop": int(hop),
        "sr": int(sr),
    }


# --------------------------------------------------------------------------
# 1. beat grid -> beat times / frames
# --------------------------------------------------------------------------


def beat_frames_from_grid(
    grid: BeatGrid,
    n_samples: int,
    sr: int,
    hop: int = _HOP,
) -> tuple[np.ndarray, np.ndarray]:
    """Beat times (SOURCE seconds) and their hop-frame indices.

    With a confident grid (``confidence >= 0.3``) the beats are synthesised
    on the fitted line ``t_k = phase + k * period`` for ``k >= 0`` while
    ``t_k < duration`` (the exact grid, not the noisy detections). Otherwise
    ``kept_beats`` are used as-is (clipped to the clip).
    """
    duration = float(n_samples) / float(sr) if sr > 0 else 0.0
    period = float(grid.get("period_sec") or 0.0)
    conf = float(grid.get("confidence") or 0.0)
    if conf >= _MIN_GRID_CONF and period > 0 and duration > 0:
        phase = float(grid.get("phase_sec") or 0.0)
        k0 = 0 if phase >= 0 else int(math.ceil(-phase / period))
        k1 = int(math.floor((duration - phase) / period))  # inclusive upper
        if k1 >= k0:
            times = phase + period * np.arange(k0, k1 + 1, dtype=np.float64)
            times = times[times < duration]
        else:
            times = np.zeros(0, dtype=np.float64)
    else:
        raw = np.asarray(list(grid.get("kept_beats") or []), dtype=np.float64)
        raw = np.sort(raw)
        times = raw[(raw >= 0.0) & (raw < duration)] if raw.size else raw
    frames = (
        np.floor(times * sr / hop).astype(np.int64)
        if times.size
        else (np.zeros(0, dtype=np.int64))
    )
    return times, frames


# --------------------------------------------------------------------------
# 2. per-beat features
# --------------------------------------------------------------------------


def beat_features(
    y: np.ndarray,
    sr: int,
    beat_frames: np.ndarray,
    hop: int = _HOP,
) -> BeatFeatures:
    """Per-beat feature tables from one STFT of ``y`` (mono, ``sr``).

    Onset envelopes come from ``librosa.onset.onset_strength_multi`` over a
    64-mel log spectrogram split at mel bins ``[0, 8, 24, 64]`` plus a broad
    channel, aggregated with MAX per beat; rms / chroma / mfcc / centroid
    are MEANs. Chroma is ``chroma_cqt`` at hop 2048 repeated to hop frames.

    ``low_level`` / ``broad_level`` are the peak linear mel power (dB) over
    the beat in the low band / all bands. They carry the accent information
    for the downbeat estimate: the spectral-flux onset strength at hop 512
    has ~20 % per-beat alignment jitter for short kicks (a 93 ms window vs a
    23 ms hop), which drowns a 6 dB accent, while the peak level is nearly
    alignment-free and also reads an added sub thump that raises no extra
    flux.
    """
    import librosa

    y = _mono(y)
    n = int(y.size)
    n_frames = 1 + n // hop
    frames = np.asarray(beat_frames, dtype=np.int64)
    if n == 0 or frames.size == 0:
        return _empty_features(hop, sr, n_frames)

    S = np.abs(librosa.stft(y, n_fft=_N_FFT, hop_length=hop))  # [F, T]
    n_frames = int(S.shape[1])
    mel = librosa.feature.melspectrogram(S=S**2, sr=sr, n_mels=_N_MELS)
    mel_db = librosa.power_to_db(mel)
    channels = [
        slice(_BAND_EDGES[0], _BAND_EDGES[1]),
        slice(_BAND_EDGES[1], _BAND_EDGES[2]),
        slice(_BAND_EDGES[2], _BAND_EDGES[3]),
        slice(_BAND_EDGES[0], _BAND_EDGES[3]),
    ]
    env = librosa.onset.onset_strength_multi(
        S=mel_db,
        sr=sr,
        hop_length=hop,
        n_fft=_N_FFT,
        channels=channels,
        aggregate=np.mean,
    )
    env = _match_frames(np.nan_to_num(np.asarray(env, dtype=np.float64)), n_frames)
    low_pow = mel[_BAND_EDGES[0] : _BAND_EDGES[1]].sum(axis=0).astype(np.float64)
    broad_pow = mel.sum(axis=0).astype(np.float64)
    rms = librosa.feature.rms(S=S, frame_length=_N_FFT, hop_length=hop)[0]
    centroid = librosa.feature.spectral_centroid(
        S=S, sr=sr, n_fft=_N_FFT, hop_length=hop
    )[0]
    mfcc = librosa.feature.mfcc(S=mel_db, n_mfcc=13)
    chroma_c = librosa.feature.chroma_cqt(
        y=y,
        sr=sr,
        hop_length=_CHROMA_HOP,
        fmin=librosa.note_to_hz("C2"),
        n_octaves=_CHROMA_OCTAVES,
    )
    chroma = np.repeat(
        np.nan_to_num(np.asarray(chroma_c, dtype=np.float64)),
        max(1, _CHROMA_HOP // hop),
        axis=1,
    )
    chroma = _match_frames(chroma, n_frames)

    frames = np.clip(frames, 0, n_frames - 1)
    frames = np.maximum.accumulate(frames)  # keep boundaries non-decreasing
    bounds = np.concatenate([frames, [n_frames]]).astype(np.int64)

    feats: BeatFeatures = {
        "low": _sync(env[0], bounds, "max"),
        "mid": _sync(env[1], bounds, "max"),
        "high": _sync(env[2], bounds, "max"),
        "broad": _sync(env[3], bounds, "max"),
        "low_level": 10.0 * np.log10(_sync(low_pow, bounds, "max") + 1e-10),
        "broad_level": 10.0 * np.log10(_sync(broad_pow, bounds, "max") + 1e-10),
        "rms": _sync(np.nan_to_num(rms.astype(np.float64)), bounds, "mean"),
        "chroma": _sync(chroma, bounds, "mean"),
        "mfcc": _sync(np.nan_to_num(mfcc.astype(np.float64)), bounds, "mean"),
        "centroid": _sync(np.nan_to_num(centroid.astype(np.float64)), bounds, "mean"),
        "bounds": bounds,
        "broad_env": env[3],
        "hop": int(hop),
        "sr": int(sr),
    }
    return feats


# --------------------------------------------------------------------------
# 3. downbeat phase
# --------------------------------------------------------------------------


def _group_max_indicator(low: np.ndarray, beats_per_bar: int) -> np.ndarray:
    """1.0 where ``low[j]`` is the maximum of the ``beats_per_bar``-beat
    window starting at ``j`` (the window is truncated at the clip end)."""
    b = low.size
    if b == 0:
        return np.zeros(0, dtype=np.float64)
    padded = np.concatenate([low, np.full(beats_per_bar - 1, -np.inf)])
    win = np.lib.stride_tricks.sliding_window_view(padded, beats_per_bar)
    return (low >= win.max(axis=1) - 1e-12).astype(np.float64)


def _margin_confidence(scores: np.ndarray) -> float:
    """``(D1 - D2) / (|D1| + |D2| + eps)`` over the two best scores."""
    if scores.size < 2:
        return 0.0
    top = np.sort(scores)[::-1]
    d1, d2 = float(top[0]), float(top[1])
    return float((d1 - d2) / (abs(d1) + abs(d2) + _EPS))


def _phase_effect_size(score: np.ndarray, modulus: int) -> float:
    """Bias-corrected fraction of the per-item score variance explained by
    the phase grouping (epsilon-squared: ``(SS_between - (k-1) MS_within) /
    SS_total``, clamped to [0, 1]). ~1 when the phase structure is real and
    ~0 for noise — the raw eta-squared would read ``(k-1)/(n-1)`` on pure
    noise, which for 80 beats is already 0.04."""
    n = score.size
    k = modulus
    if n <= k or n < 2 * k:
        return 0.0
    total = float(np.sum((score - score.mean()) ** 2))
    if total <= 1e-12:
        return 0.0
    between = 0.0
    for p in range(k):
        grp = score[p::k]
        if grp.size:
            between += grp.size * float((grp.mean() - score.mean()) ** 2)
    within = max(0.0, total - between)
    ms_within = within / float(n - k)
    eps_sq = (between - (k - 1) * ms_within) / total
    return float(max(0.0, min(1.0, eps_sq)))


def estimate_downbeat_phase(
    f: BeatFeatures,
    beats_per_bar: int = BEATS_PER_BAR,
) -> tuple[int, float]:
    """Return ``(phase, confidence)``: the beat index (mod ``beats_per_bar``)
    that best explains low-band accents, broad accents, chroma novelty and
    "loudest low of its bar" — the CALLER gates on the confidence.

    Per beat ``s_j = z(low_j) + 0.5 z(broad_j) + z(c_j) + 0.5 [low_j is the
    max of the bar starting at j]`` where ``low`` / ``broad`` are the peak
    band LEVELS (``low_level`` / ``broad_level``, see :func:`beat_features`)
    and ``c_j = 1 - cos(chroma_j, chroma_{j-1})``; ``D(p) = mean of s_j
    over j == p (mod 4)``. Confidence is the top-two margin ``(D1 - D2) /
    (|D1| + |D2|)`` scaled by the bias-corrected fraction of ``s_j`` variance
    the phase grouping explains (epsilon-squared), so a flat track — where
    the per-phase means differ only by noise — reads ~0 even when the margin
    ratio is accidentally large.
    """
    low = np.asarray(f["low_level"], dtype=np.float64)
    b = low.size
    if beats_per_bar <= 0 or b < 2 * beats_per_bar:
        return 0, 0.0
    chroma = np.asarray(f["chroma"], dtype=np.float64)
    c = np.zeros(b, dtype=np.float64)
    if chroma.shape[1] == b and b > 1:
        c[1:] = _cos_dist(chroma[:, 1:], chroma[:, :-1])
    score = (
        _zscore(low)
        + 0.5 * _zscore(np.asarray(f["broad_level"], dtype=np.float64))
        + _zscore(c)
        + 0.5 * _group_max_indicator(low, beats_per_bar)
    )
    d = np.asarray([score[p::beats_per_bar].mean() for p in range(beats_per_bar)])
    phase = int(np.argmax(d))
    conf = _margin_confidence(d) * _phase_effect_size(score, beats_per_bar)
    log.debug(
        "downbeat phase: D=%s -> p=%d conf=%.3f", np.round(d, 3).tolist(), phase, conf
    )
    return phase, float(max(0.0, min(1.0, conf)))


# --------------------------------------------------------------------------
# 4. bar table
# --------------------------------------------------------------------------


def bar_features(
    y: np.ndarray,
    sr: int,
    f: BeatFeatures,
    beat_times: np.ndarray,
    downbeat_phase: int,
) -> list[BarFeature]:
    """Group beats into bars of ``BEATS_PER_BAR`` starting at beat index
    ``downbeat_phase`` (a partial bar before it and a partial bar at the end
    are dropped). ``y`` / ``sr`` are accepted for signature parity; every
    value comes from the beat tables in ``f``."""
    times = np.asarray(beat_times, dtype=np.float64)
    nb = int(times.size)
    p = int(downbeat_phase) % BEATS_PER_BAR if nb else 0
    n_bars = (nb - p) // BEATS_PER_BAR if nb > p else 0
    if n_bars <= 0:
        return []
    sl = slice(p, p + n_bars * BEATS_PER_BAR)
    shape = (n_bars, BEATS_PER_BAR)

    def _grp(x: np.ndarray) -> np.ndarray:
        return np.asarray(x, dtype=np.float64)[sl].reshape(shape)

    rms = _grp(f["rms"]).mean(axis=1)
    low = _grp(f["low"]).mean(axis=1)
    mid = _grp(f["mid"]).mean(axis=1)
    high = _grp(f["high"]).mean(axis=1)
    low_frac = low / (low + mid + high + _EPS)
    centroid = _grp(f["centroid"]).mean(axis=1)
    chroma = np.asarray(f["chroma"], dtype=np.float64)[:, sl]
    chroma = chroma.reshape(12, n_bars, BEATS_PER_BAR).mean(axis=2)  # [12, n_bars]
    mfcc = np.asarray(f["mfcc"], dtype=np.float64)[:, sl]
    mfcc = mfcc.reshape(mfcc.shape[0], n_bars, BEATS_PER_BAR).mean(axis=2)

    # onset density: broad-envelope local peaks above mean + std, per beat
    env = np.asarray(f["broad_env"], dtype=np.float64)
    bounds = np.asarray(f["bounds"], dtype=np.int64)
    peaks = np.zeros(env.size, dtype=np.float64)
    if env.size >= 3:
        thr = float(env.mean() + env.std())
        inner = env[1:-1]
        is_peak = (inner > env[:-2]) & (inner >= env[2:]) & (inner > thr)
        peaks[1:-1] = is_peak.astype(np.float64)
    cum = np.concatenate([[0.0], np.cumsum(peaks)])
    starts = bounds[p : p + n_bars * BEATS_PER_BAR : BEATS_PER_BAR]
    ends = bounds[p + BEATS_PER_BAR : p + (n_bars + 1) * BEATS_PER_BAR : BEATS_PER_BAR]
    ends = np.minimum(ends, env.size)
    starts = np.minimum(starts, env.size)
    density = (cum[ends] - cum[starts]) / float(BEATS_PER_BAR)

    starts_sec = times[p : p + n_bars * BEATS_PER_BAR : BEATS_PER_BAR]
    rms_db = 20.0 * np.log10(np.maximum(rms, 1e-6))
    bars: list[BarFeature] = []
    for i in range(n_bars):
        bars.append(
            {
                "bar": i,
                "start_sec": float(starts_sec[i]),
                "rms_db": float(max(_DB_FLOOR, rms_db[i])),
                "low_frac": float(low_frac[i]),
                "onset_density": float(density[i]),
                "centroid_hz": float(centroid[i]),
                "chroma": [float(v) for v in chroma[:, i]],
                "mfcc": [float(v) for v in mfcc[:, i]],
            }
        )
    return bars


# --------------------------------------------------------------------------
# 5. phrase phase
# --------------------------------------------------------------------------


def _bar_novelty(bars: list[BarFeature]) -> np.ndarray:
    """``n_b`` for ``b >= 1``: chroma cosine distance + |delta rms_db| / 6 +
    mfcc cosine distance against the previous bar. Length ``len(bars) - 1``."""
    chroma = np.asarray([b["chroma"] for b in bars], dtype=np.float64).T  # [12, n]
    mfcc = np.asarray([b["mfcc"] for b in bars], dtype=np.float64).T
    rms = np.asarray([b["rms_db"] for b in bars], dtype=np.float64)
    return (
        _cos_dist(chroma[:, 1:], chroma[:, :-1])
        + np.abs(np.diff(rms)) / 6.0
        + _cos_dist(mfcc[:, 1:], mfcc[:, :-1])
    )


def estimate_phrase_phase(
    bars: list[BarFeature],
    phrase_bars: int,
) -> tuple[int, float]:
    """Return ``(phase, confidence)``: the bar index (mod ``phrase_bars``)
    at which bar-to-bar novelty (chroma, loudness, timbre) peaks — where
    phrases start. Fewer than ``2 * phrase_bars`` bars -> ``(0, 0.0)``.

    ``Q(q)`` is the MEAN novelty over bars ``b == q (mod P)``, ``b >= 1``
    (a sum would bias against ``q = 0``, which has one fewer term).
    """
    n = len(bars)
    P = int(phrase_bars)
    if P <= 0 or n < 2 * P:
        return 0, 0.0
    nov = _bar_novelty(bars)
    b_idx = np.arange(1, n)
    q_scores = np.zeros(P, dtype=np.float64)
    for q in range(P):
        sel = nov[(b_idx % P) == q]
        q_scores[q] = sel.mean() if sel.size else 0.0
    phase = int(np.argmax(q_scores))
    conf = _margin_confidence(q_scores)
    log.debug(
        "phrase phase: Q=%s -> q=%d conf=%.3f",
        np.round(q_scores, 3).tolist(),
        phase,
        conf,
    )
    return phase, float(max(0.0, min(1.0, conf)))


# --------------------------------------------------------------------------
# 6. phrase table
# --------------------------------------------------------------------------


def _bar_length_sec(bars: list[BarFeature], fallback: float) -> float:
    if len(bars) >= 2:
        d = np.diff([b["start_sec"] for b in bars])
        d = d[d > 0]
        if d.size:
            return float(np.median(d))
    return float(fallback)


def _phrase_spans(
    n_bars: int, phrase_phase: int, phrase_bars: int
) -> list[tuple[int, int]]:
    """``(start_bar, n)`` spans: consecutive ``P``-bar phrases from bar ``q``;
    a leading remainder of >= 4 bars becomes phrase 0 and a trailing
    remainder of >= 4 bars is kept. Shorter remainders are dropped. A clip
    that would otherwise have no phrase gets a single one over all bars."""
    P = max(1, int(phrase_bars))
    q = int(phrase_phase) % P if n_bars else 0
    spans: list[tuple[int, int]] = []
    if q >= _MIN_PHRASE_BARS:
        spans.append((0, q))
    b = q
    while b + P <= n_bars:
        spans.append((b, P))
        b += P
    rest = n_bars - b
    if rest >= _MIN_PHRASE_BARS:
        spans.append((b, rest))
    if not spans and n_bars > 0:
        spans.append((0, n_bars))
    return spans


def _integrated_lufs(y: np.ndarray, sr: int) -> Optional[float]:
    import warnings

    import pyloudnorm as pyln

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            v = float(
                pyln.Meter(int(sr)).integrated_loudness(np.asarray(y, np.float32))
            )
    except Exception as e:  # pragma: no cover - defensive
        log.debug("pyloudnorm failed: %s", e)
        return None
    return v if np.isfinite(v) else None


def _section_labels(lufs: list[float]) -> list[str]:
    n = len(lufs)
    if n == 0:
        return []
    if n == 1:
        return ["body"]
    median = float(np.median(lufs))
    peak = int(np.argmax(lufs))
    labels: list[str] = []
    for i, v in enumerate(lufs):
        if i == peak:
            labels.append("peak")
        elif i == 0 and v < median - 3.0:
            labels.append("intro")
        elif i == n - 1 and v < median - 3.0:
            labels.append("outro")
        elif v > median:
            labels.append("build")
        else:
            labels.append("body")
    return labels


def build_phrases(
    bars: list[BarFeature],
    phrase_phase: int,
    phrase_bars: int,
    y: Optional[np.ndarray] = None,
    sr: Optional[int] = None,
    *,
    bar_sec: Optional[float] = None,
) -> list[Phrase]:
    """Phrase table (SOURCE seconds) from the bar table.

    ``lufs`` is pyloudnorm integrated loudness of ``y[phrase]`` when ``y`` /
    ``sr`` are given and the span is >= 3 s, else the mean bar ``rms_db``.
    ``energy`` is a 0.0 placeholder (``arrange.normalize_energy`` fills it
    across the stack). ``bar_sec`` overrides the bar length used for the end
    of the last bar (default: median bar spacing of the table).
    """
    n = len(bars)
    if n == 0:
        return []
    bar_len = _bar_length_sec(bars, bar_sec if bar_sec else 2.0)
    yy = _mono(y) if y is not None and sr else None
    phrases: list[Phrase] = []
    lufs_vals: list[float] = []
    for idx, (b0, cnt) in enumerate(_phrase_spans(n, phrase_phase, phrase_bars)):
        chunk = bars[b0 : b0 + cnt]
        start = float(chunk[0]["start_sec"])
        end = float(chunk[-1]["start_sec"] + bar_len)
        rms_mean = float(np.mean([b["rms_db"] for b in chunk]))
        lufs: Optional[float] = None
        if yy is not None and sr and (end - start) >= _LUFS_MIN_SEC:
            s0 = max(0, int(round(start * sr)))
            s1 = min(yy.size, int(round(end * sr)))
            if s1 - s0 >= int(_LUFS_MIN_SEC * sr):
                lufs = _integrated_lufs(yy[s0:s1], int(sr))
        if lufs is None:
            lufs = max(_DB_FLOOR, rms_mean)
        lufs_vals.append(lufs)
        phrases.append(
            {
                "idx": idx,
                "start_bar": int(b0),
                "bars": int(cnt),
                "start_sec": start,
                "end_sec": end,
                "lufs": float(lufs),
                "energy": 0.0,
                "low_frac": float(np.mean([b["low_frac"] for b in chunk])),
                "onset_density": float(np.mean([b["onset_density"] for b in chunk])),
                "centroid_hz": float(np.mean([b["centroid_hz"] for b in chunk])),
                "section_label": "body",
            }
        )
    for ph, label in zip(phrases, _section_labels(lufs_vals)):
        ph["section_label"] = label  # type: ignore[typeddict-item]
    return phrases


# --------------------------------------------------------------------------
# orchestration
# --------------------------------------------------------------------------


def _plain_bars(y: np.ndarray, sr: int, beat_times: np.ndarray) -> list[BarFeature]:
    """Fallback bar table: plain 4-beat grouping from beat 0 with rms only."""
    times = np.asarray(beat_times, dtype=np.float64)
    n_bars = int(times.size) // BEATS_PER_BAR
    yy = _mono(y)
    bars: list[BarFeature] = []
    for i in range(n_bars):
        t0 = float(times[i * BEATS_PER_BAR])
        j = (i + 1) * BEATS_PER_BAR
        t1 = float(times[j]) if j < times.size else (yy.size / float(sr) if sr else t0)
        s0 = max(0, int(t0 * sr))
        s1 = max(s0 + 1, min(yy.size, int(t1 * sr)))
        seg = yy[s0:s1].astype(np.float64)
        rms = float(np.sqrt(np.mean(seg * seg))) if seg.size else 0.0
        bars.append(
            {
                "bar": i,
                "start_sec": t0,
                "rms_db": float(max(_DB_FLOOR, 20.0 * math.log10(max(rms, 1e-6)))),
                "low_frac": 0.0,
                "onset_density": 0.0,
                "centroid_hz": 0.0,
                "chroma": [0.0] * 12,
                "mfcc": [0.0] * 13,
            }
        )
    return bars


def analyze_structure(
    y: np.ndarray,
    sr: int,
    grid: BeatGrid,
    phrase_bars: int,
    min_downbeat_conf: float = 0.15,
) -> StructureResult:
    """Downbeat phase, bar table and phrase phase for ``y`` (mono, ``sr``)
    on the fitted beat ``grid``. Never raises: on any failure the result has
    phase 0 / confidence 0 and bars from a plain 4-beat grouping.

    A downbeat estimate below ``min_downbeat_conf`` is gated to phase 0 (the
    reported confidence is kept so callers can flag it).
    """
    beat_times = np.zeros(0, dtype=np.float64)
    try:
        yy = _mono(y)
        beat_times, frames = beat_frames_from_grid(grid, int(yy.size), int(sr))
        feats = beat_features(yy, int(sr), frames)
        phase, conf = estimate_downbeat_phase(feats)
        if conf < min_downbeat_conf:
            log.info(
                "structure: downbeat confidence %.3f < %.2f, using phase 0 (was %d)",
                conf,
                min_downbeat_conf,
                phase,
            )
            phase = 0
        bars = bar_features(yy, int(sr), feats, beat_times, phase)
        q, q_conf = estimate_phrase_phase(bars, int(phrase_bars))
        log.debug(
            "structure: beats=%d bars=%d downbeat=%d (%.2f) phrase=%d (%.2f)",
            beat_times.size,
            len(bars),
            phase,
            conf,
            q,
            q_conf,
        )
        return {
            "downbeat_phase": int(phase),
            "downbeat_confidence": float(conf),
            "phrase_phase": int(q),
            "phrase_confidence": float(q_conf),
            "bars": bars,
            "beat_times": [float(t) for t in beat_times],
        }
    except Exception as e:
        log.warning("structure analysis failed (%s); using plain bars", e)
        plain: list[BarFeature] = []
        try:
            yy = _mono(y)
            if beat_times.size == 0:
                beat_times, _ = beat_frames_from_grid(grid, int(yy.size), int(sr))
            plain = _plain_bars(yy, int(sr), beat_times)
        except Exception as e2:  # pragma: no cover - defensive
            log.warning("structure fallback failed too (%s)", e2)
        return {
            "downbeat_phase": 0,
            "downbeat_confidence": 0.0,
            "phrase_phase": 0,
            "phrase_confidence": 0.0,
            "bars": plain,
            "beat_times": [float(t) for t in beat_times],
        }
