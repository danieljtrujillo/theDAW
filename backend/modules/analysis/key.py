"""Musical key detection via chroma + Krumhansl-Schmuckler profiles.

Pure librosa — no extra deps. Cheap enough to run on every imported /
generated track. Returns the most likely key (24 candidates: 12 major +
12 minor) and a correlation confidence in ``[0, 1]``.

Reference: Krumhansl, C. L. (1990). Cognitive Foundations of Musical
Pitch. The profiles below are the canonical major / minor key profiles
from that work.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional

log = logging.getLogger(__name__)


# Krumhansl-Schmuckler key profiles. Index 0 = C.
_MAJOR_PROFILE = (
    6.35,
    2.23,
    3.48,
    2.33,
    4.38,
    4.09,
    2.52,
    5.19,
    2.39,
    3.66,
    2.29,
    2.88,
)
_MINOR_PROFILE = (
    6.33,
    2.68,
    3.52,
    5.38,
    2.60,
    3.53,
    2.54,
    4.75,
    3.98,
    2.69,
    3.34,
    3.17,
)
_NOTE_NAMES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")


def _correlate(chroma_mean: list[float], profile: tuple[float, ...]) -> list[float]:
    """Compute Pearson correlation of the chroma vector against all 12
    rotations of ``profile``. Returns 12 correlations (one per tonic)."""
    import statistics

    chroma_mean = list(chroma_mean)
    if len(chroma_mean) != 12:
        return [0.0] * 12

    mean_x = statistics.fmean(chroma_mean)
    out: list[float] = []
    for rotation in range(12):
        rotated = profile[-rotation:] + profile[:-rotation]
        mean_y = statistics.fmean(rotated)
        num = sum((x - mean_x) * (y - mean_y) for x, y in zip(chroma_mean, rotated))
        denom_x = sum((x - mean_x) ** 2 for x in chroma_mean) ** 0.5
        denom_y = sum((y - mean_y) ** 2 for y in rotated) ** 0.5
        if denom_x == 0 or denom_y == 0:
            out.append(0.0)
        else:
            out.append(num / (denom_x * denom_y))
    return out


def detect_key(audio_path: Path) -> dict[str, Optional[float] | Optional[str]]:
    """Return ``{key, scale, confidence}`` for the audio file.

    On failure (no librosa, unreadable file, silent input) returns
    ``{"key": None, "scale": None, "confidence": None}``.
    """
    out: dict[str, Optional[float] | Optional[str]] = {
        "key": None,
        "scale": None,
        "confidence": None,
    }
    try:
        import librosa
    except ImportError:
        return out

    p = Path(audio_path)
    if not p.is_file():
        return out

    try:
        y, sr = librosa.load(str(p), sr=22050, mono=True)
    except Exception as e:
        log.info("analysis.key: librosa load failed for %s: %s", p.name, e)
        return out

    if y.size == 0:
        return out

    try:
        chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    except Exception as e:
        log.info("analysis.key: chroma_cqt failed for %s: %s", p.name, e)
        return out

    chroma_mean = [float(c) for c in chroma.mean(axis=1)]

    major_corr = _correlate(chroma_mean, _MAJOR_PROFILE)
    minor_corr = _correlate(chroma_mean, _MINOR_PROFILE)

    best_major_idx = max(range(12), key=lambda i: major_corr[i])
    best_minor_idx = max(range(12), key=lambda i: minor_corr[i])

    if major_corr[best_major_idx] >= minor_corr[best_minor_idx]:
        out["key"] = _NOTE_NAMES[best_major_idx]
        out["scale"] = "major"
        out["confidence"] = float(major_corr[best_major_idx])
    else:
        out["key"] = _NOTE_NAMES[best_minor_idx]
        out["scale"] = "minor"
        out["confidence"] = float(minor_corr[best_minor_idx])

    return out
