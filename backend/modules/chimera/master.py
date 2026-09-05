"""Master bus for the Chimera v2 engine (mix_clips / v1 is untouched).

``finalize`` runs: mono the low band -> loudness normalise to ``TARGET_LUFS``
-> true-peak style limiter at ``CEILING_DB`` -> bar-synced equal-power fades
(1 beat in, 1 bar out) -> PCM_16 WAV.

The limiter defaults to the numpy engine: a 5 ms look-ahead peak hold,
gain reduction with an exponential release and a 1 ms attack, applied with
no latency (the look-ahead is a centred maximum filter, so sample positions
in the OUTPUT timeline are preserved). Spotify's ``pedalboard.Limiter`` can
be requested with ``engine='pedalboard'`` but it hard-clips at 0 dBFS
instead of the threshold and adds make-up gain, so it is not the default.
"""

from __future__ import annotations

import logging
import math
from pathlib import Path
from typing import Literal, TypedDict

import numpy as np
import soundfile as sf
from scipy import signal
from scipy.ndimage import maximum_filter1d

from .render import equal_power, measure_lufs, split_bands

log = logging.getLogger(__name__)


TARGET_LUFS = -16.0
CEILING_DB = -1.0
MONO_LOW_HZ = 120.0
LOOKAHEAD_MS = 5.0
ATTACK_MS = 1.0
RELEASE_MS = 120.0
NORMALIZE_CLAMP_DB = 20.0
HARD_CLIP = 0.999

LimiterEngine = Literal["numpy", "pedalboard"]


class MasterReport(TypedDict):
    lufs_integrated: float
    true_peak_db: float
    limiter_gr_db: float
    duration_sec: float


def _stereo(x: np.ndarray) -> np.ndarray:
    arr = np.asarray(x, dtype=np.float32)
    if arr.ndim == 1:
        arr = np.stack([arr, arr], axis=1)
    return np.ascontiguousarray(arr)


def mono_low(x: np.ndarray, sr: int, fc: float = MONO_LOW_HZ) -> np.ndarray:
    """Sum the < ``fc`` band to mono (both channels), keep the highs stereo."""
    low, high = split_bands(_stereo(x), sr, fc)
    mono = low.mean(axis=1, keepdims=True)
    return np.ascontiguousarray(high + mono, dtype=np.float32)


def loudness_normalize(
    x: np.ndarray, sr: int, target_lufs: float = TARGET_LUFS
) -> tuple[np.ndarray, float]:
    """Scale ``x`` so its integrated loudness hits ``target_lufs`` (gain
    clamped to +/- 20 dB). Returns ``(audio, gain_db)``."""
    arr = _stereo(x)
    measured = measure_lufs(arr, sr)
    gain_db = float(
        max(-NORMALIZE_CLAMP_DB, min(NORMALIZE_CLAMP_DB, target_lufs - measured))
    )
    out = arr * np.float32(10.0 ** (gain_db / 20.0))
    return np.ascontiguousarray(out, dtype=np.float32), gain_db


def _limit_numpy(
    x: np.ndarray,
    sr: int,
    ceiling_db: float,
    release_ms: float,
    attack_ms: float = ATTACK_MS,
    lookahead_ms: float = LOOKAHEAD_MS,
) -> tuple[np.ndarray, float]:
    arr = _stereo(x)
    n = arr.shape[0]
    if n == 0:
        return arr, 0.0
    ceiling = 10.0 ** (ceiling_db / 20.0)
    peak = np.max(np.abs(arr.astype(np.float64)), axis=1)
    la = max(1, int(round(lookahead_ms * 1e-3 * sr)))
    held = maximum_filter1d(peak, size=2 * la + 1, mode="nearest")
    gr = 20.0 * np.log10(np.maximum(held, ceiling) / ceiling)  # dB >= 0
    # exponential release of the reduction, vectorised in the log domain
    tau_r = max(release_ms * 1e-3 * sr, 1.0)
    idx = np.arange(n, dtype=np.float64)
    gr = np.exp(np.maximum.accumulate(np.log(gr + 1e-12) + idx / tau_r) - idx / tau_r)
    # attack smoothing (one pole) started from the first sample's reduction so
    # a hot first sample is caught too; the look-ahead plateau absorbs the lag
    a = 1.0 - math.exp(-1.0 / max(attack_ms * 1e-3 * sr, 1.0))
    zi = signal.lfiltic([a], [1.0, -(1.0 - a)], y=[gr[0]])
    gr, _ = signal.lfilter([a], [1.0, -(1.0 - a)], gr, zi=zi)
    gr = np.maximum(gr, 0.0)
    gain = (10.0 ** (-gr / 20.0)).astype(np.float32)
    out = arr * gain[:, None]
    gr_max = float(gr.max())
    if gr_max < 1e-6:  # the log-domain epsilon, not real reduction
        gr_max = 0.0
    return np.ascontiguousarray(out, dtype=np.float32), gr_max


def _limit_pedalboard(
    x: np.ndarray, sr: int, ceiling_db: float, release_ms: float
) -> tuple[np.ndarray, float]:
    """``pedalboard.Limiter`` pass. Raises ``ImportError`` without pedalboard."""
    from pedalboard import Limiter  # type: ignore[import-not-found]

    arr = _stereo(x)
    lim = Limiter(threshold_db=float(ceiling_db), release_ms=float(release_ms))
    out = lim(np.ascontiguousarray(arr.T, dtype=np.float32), int(sr)).T
    out = np.ascontiguousarray(out, dtype=np.float32)
    # estimate the reduction from 10 ms windowed peaks
    win = max(1, int(0.01 * sr))
    n = min(arr.shape[0], out.shape[0]) // win * win
    if n == 0:
        return out, 0.0
    pin = np.max(np.abs(arr[:n]).reshape(-1, win, arr.shape[1]), axis=(1, 2))
    pout = np.max(np.abs(out[:n]).reshape(-1, win, out.shape[1]), axis=(1, 2))
    mask = pin > 1e-4
    gr = 0.0
    if np.any(mask):
        gr = float(np.max(20.0 * np.log10(pin[mask] / np.maximum(pout[mask], 1e-9))))
    return out, max(0.0, gr)


def limit(
    x: np.ndarray,
    sr: int,
    ceiling_db: float = CEILING_DB,
    release_ms: float = RELEASE_MS,
    engine: LimiterEngine = "numpy",
) -> tuple[np.ndarray, float]:
    """Peak limiter. Returns ``(audio, max_gain_reduction_db)``; the output is
    additionally hard-clipped at +/- ``HARD_CLIP`` as a guard."""
    out: np.ndarray
    gr: float
    if engine == "pedalboard":
        try:
            out, gr = _limit_pedalboard(x, sr, ceiling_db, release_ms)
        except Exception as e:  # ImportError or a runtime failure
            log.warning("pedalboard limiter unavailable (%s); using numpy", e)
            out, gr = _limit_numpy(x, sr, ceiling_db, release_ms)
    else:
        out, gr = _limit_numpy(x, sr, ceiling_db, release_ms)
    np.clip(out, -HARD_CLIP, HARD_CLIP, out=out)
    return out, float(gr)


def master_fades(
    x: np.ndarray, sr: int, fade_in_sec: float, fade_out_sec: float
) -> np.ndarray:
    """Equal-power fade-in / fade-out applied in place (and returned)."""
    n = x.shape[0]
    k_in = min(n, max(0, int(round(fade_in_sec * sr))))
    k_out = min(n, max(0, int(round(fade_out_sec * sr))))
    if k_in > 0:
        env = equal_power(k_in, "in")
        x[:k_in] *= env[:, None] if x.ndim == 2 else env
    if k_out > 0:
        env = equal_power(k_out, "out")
        x[n - k_out :] *= env[:, None] if x.ndim == 2 else env
    return x


def true_peak_db(x: np.ndarray, sr: int, oversample: int = 4) -> float:
    """Inter-sample peak estimate (dBTP) via ``oversample`` x polyphase upsampling."""
    arr = np.asarray(x, dtype=np.float64)
    if arr.size == 0:
        return -120.0
    up = signal.resample_poly(arr, oversample, 1, axis=0) if oversample > 1 else arr
    peak = float(np.max(np.abs(up)))
    return 20.0 * math.log10(max(peak, 1e-6))


def finalize(
    x: np.ndarray,
    sr: int,
    beat_sec: float,
    bar_sec: float,
    out_path: Path,
    target_lufs: float = TARGET_LUFS,
    ceiling_db: float = CEILING_DB,
    engine: LimiterEngine = "numpy",
) -> MasterReport:
    """Master the rendered timeline and write it as PCM_16 WAV.

    Fades are 1 beat in and 1 bar out; the 1-beat fade-in keeps the endpoint
    test's 'first 10 ms is quieter than half the mid RMS' assertion.
    """
    sr = int(sr)
    y = mono_low(x, sr)
    y, norm_db = loudness_normalize(y, sr, target_lufs)
    y, gr_db = limit(y, sr, ceiling_db, engine=engine)
    y = master_fades(y, sr, max(0.0, float(beat_sec)), max(0.0, float(bar_sec)))
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(out_path), y, sr, subtype="PCM_16")
    report: MasterReport = {
        "lufs_integrated": float(measure_lufs(y, sr)),
        "true_peak_db": float(true_peak_db(y, sr)),
        "limiter_gr_db": float(gr_db),
        "duration_sec": float(y.shape[0]) / sr,
    }
    log.info(
        "master.finalize: %.2fs, normalise %+.1f dB, limiter GR %.2f dB, "
        "%.1f LUFS, %.2f dBTP -> %s",
        report["duration_sec"],
        norm_db,
        gr_db,
        report["lufs_integrated"],
        report["true_peak_db"],
        out_path,
    )
    return report
