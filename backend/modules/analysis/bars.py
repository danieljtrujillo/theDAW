"""Estimate the number of musical bars in a track.

We use the chimera tempo detector's beat list and assume a 4/4 time
signature. Bars = floor(len(beats) / 4). This is a coarse estimate;
swing / 3/4 / 6/8 material will be wrong by a constant factor, but
that's acceptable for first-pass cataloguing.
"""

from __future__ import annotations

from typing import Optional


def estimate_bars(beats: list[float], time_sig_numerator: int = 4) -> Optional[float]:
    if not beats:
        return None
    n = max(1, int(time_sig_numerator))
    return float(len(beats)) / float(n)


def estimate_rms_db(audio_path) -> Optional[float]:
    """Rough loudness proxy: 20*log10(RMS). No actual LUFS — that
    requires the pyloudnorm dep; we'll add it later if needed."""
    try:
        import librosa
        import numpy as np
    except ImportError:
        return None
    from pathlib import Path

    p = Path(audio_path)
    if not p.is_file():
        return None
    try:
        y, _sr = librosa.load(str(p), sr=22050, mono=True)
    except Exception:
        return None
    if y.size == 0:
        return None
    rms = float(np.sqrt(np.mean(y * y)))
    if rms <= 1e-9:
        return -90.0
    return float(20.0 * np.log10(rms))
