"""F0 (fundamental pitch) statistics via librosa.pyin.

This is most meaningful on monophonic content (vocals, lead lines) but
runs harmlessly on polyphonic material — pyin reports NaN where it
can't track confidently, and we filter those out.

Returns mean / std / median in Hz. No MIDI conversion here; callers do
that themselves if they want it.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional

log = logging.getLogger(__name__)


def detect_pitch_stats(audio_path: Path) -> dict[str, Optional[float]]:
    out: dict[str, Optional[float]] = {
        "pitch_mean_hz": None,
        "pitch_std_hz": None,
        "pitch_median_hz": None,
        "voiced_ratio": None,
    }
    try:
        import librosa
        import numpy as np
    except ImportError:
        return out

    p = Path(audio_path)
    if not p.is_file():
        return out

    try:
        y, sr = librosa.load(str(p), sr=22050, mono=True)
    except Exception as e:
        log.info("analysis.pitch: load failed for %s: %s", p.name, e)
        return out
    if y.size == 0:
        return out

    try:
        # 65 Hz ≈ C2, 1047 Hz ≈ C6 — covers bass-to-soprano without
        # wasting compute on extreme ranges.
        f0, voiced_flag, _voiced_prob = librosa.pyin(
            y,
            fmin=65.0,
            fmax=1047.0,
            sr=sr,
            frame_length=2048,
        )
    except Exception as e:
        log.info("analysis.pitch: pyin failed for %s: %s", p.name, e)
        return out

    if f0 is None or len(f0) == 0:
        return out
    voiced = f0[~np.isnan(f0)]
    if voiced.size == 0:
        out["voiced_ratio"] = 0.0
        return out

    out["pitch_mean_hz"] = float(np.mean(voiced))
    out["pitch_std_hz"] = float(np.std(voiced))
    out["pitch_median_hz"] = float(np.median(voiced))
    out["voiced_ratio"] = float(voiced.size / max(1, f0.size))
    return out
