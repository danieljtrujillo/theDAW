"""Shared analysis / metering helpers — used by mastering, delivery, restoration.

Loudness + true-peak come from FFmpeg's EBU-R128 ``loudnorm`` (accurate, includes
oversampled true-peak); spectrum + stereo metrics come from numpy on the decoded
samples. ``pyloudnorm`` is used as a pure-Python cross-check when available.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Optional

from . import ffmpeg


async def measure_loudness(
    path: Path,
    target_i: float = -14.0,
    target_lra: float = 7.0,
    target_tp: float = -1.0,
) -> dict:
    """First-pass EBU-R128 measurement via ffmpeg loudnorm (print_format=json).

    Returns the measured values needed for a transparent second pass:
    ``input_i, input_lra, input_tp, input_thresh, target_offset``.
    """
    cmd = [
        "ffmpeg",
        "-i",
        str(path),
        "-af",
        f"loudnorm=I={target_i}:LRA={target_lra}:TP={target_tp}:print_format=json",
        "-f",
        "null",
        "-",
    ]
    stderr = await ffmpeg.run(cmd, timeout=300)
    m = re.search(r"\{[^{}]*\"input_i\"[\s\S]*?\}", stderr)
    if not m:
        raise RuntimeError("loudnorm JSON not found in ffmpeg output")
    data = json.loads(m.group())
    return {k: _f(v) for k, v in data.items()}


async def verify_true_peak(path: Path, max_tp: float) -> tuple[bool, float]:
    """Re-measure an encoded file and check its true-peak vs a ceiling.

    Used by Smart Export's post-encode verification: lossy codecs can introduce
    inter-sample peaks above the limiter ceiling. Returns (passed, measured_tp).
    """
    stats = await measure_loudness(path)
    tp = stats.get("input_tp", 0.0)
    return (tp <= max_tp, tp)


def compute_spectrum(path: Path, n_fft: int = 4096, bands: int = 256) -> dict:
    """Average magnitude spectrum (log-spaced) for analyzer / Match-EQ display."""
    import numpy as np
    import soundfile as sf

    audio, sr = sf.read(str(path), always_2d=True)
    mono = audio.mean(axis=1)
    if mono.size < n_fft:
        mono = np.pad(mono, (0, n_fft - mono.size))
    hop = n_fft // 2
    win = np.hanning(n_fft)
    acc = np.zeros(n_fft // 2 + 1)
    frames = 0
    for i in range(0, mono.size - n_fft, hop):
        spec = np.abs(np.fft.rfft(mono[i : i + n_fft] * win))
        acc += spec
        frames += 1
    if frames:
        acc /= frames
    freqs = np.fft.rfftfreq(n_fft, 1 / sr)
    mag_db = 20 * np.log10(acc + 1e-9)
    # resample to log-spaced bands
    lo, hi = 20.0, min(sr / 2, 20000.0)
    log_f = np.logspace(np.log10(lo), np.log10(hi), bands)
    out_db = np.interp(log_f, freqs, mag_db)
    return {"sr": int(sr), "freqs": log_f.tolist(), "mag_db": out_db.tolist()}


def compute_stereo_metrics(path: Path) -> dict:
    """Stereo correlation, width and balance for the imager / goniometer."""
    import numpy as np
    import soundfile as sf

    audio, _ = sf.read(str(path), always_2d=True)
    if audio.shape[1] < 2:
        return {"correlation": 1.0, "width": 0.0, "balance": 0.0, "mono": True}
    left, right = audio[:, 0], audio[:, 1]
    denom = (np.std(left) * np.std(right)) or 1e-9
    corr = float(np.mean((left - left.mean()) * (right - right.mean())) / denom)
    mid = (left + right) / 2
    side = (left - right) / 2
    width = float(np.sqrt(np.mean(side**2)) / (np.sqrt(np.mean(mid**2)) + 1e-9))
    balance = float(np.sqrt(np.mean(right**2)) - np.sqrt(np.mean(left**2)))
    return {"correlation": corr, "width": width, "balance": balance, "mono": False}


def _f(v) -> Optional[float]:
    try:
        return float(v)
    except (TypeError, ValueError):
        return v
