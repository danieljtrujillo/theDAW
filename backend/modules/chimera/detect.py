"""BPM and beat detection using the aubio Python wheel.

Public API:
    detect_tempo_and_beats(path) -> DetectionResult

Returns None for `bpm` when the file is too short or aubio can't lock on a
tempo (silence, very sparse onsets). The caller decides how to handle that:
the Chimera mashup treats a None-BPM clip as "do not stretch, include as-is."
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional, TypedDict

log = logging.getLogger(__name__)


_WIN_S = 1024
_HOP_S = 512
_MIN_DURATION_SEC = 1.5


class DetectionResult(TypedDict):
    bpm: Optional[float]
    beats: list[float]
    confidence: float
    samplerate: int
    duration_sec: float


def detect_tempo_and_beats(path: str | Path) -> DetectionResult:
    import aubio

    src = aubio.source(str(path), samplerate=0, hop_size=_HOP_S)
    sr = src.samplerate
    tempo_o = aubio.tempo("default", _WIN_S, _HOP_S, sr)

    beats: list[float] = []
    confidences: list[float] = []
    total_frames = 0

    while True:
        samples, read = src()
        is_beat = tempo_o(samples)
        total_frames += read
        if is_beat:
            beats.append(float(tempo_o.get_last_s()))
            confidences.append(float(tempo_o.get_confidence()))
        if read < _HOP_S:
            break

    try:
        src.close()
    except Exception:
        pass

    duration_sec = total_frames / float(sr) if sr > 0 else 0.0
    bpm_raw = float(tempo_o.get_bpm())

    bpm: Optional[float]
    if duration_sec < _MIN_DURATION_SEC or bpm_raw <= 0 or not beats:
        bpm = None
    else:
        bpm = bpm_raw

    confidence = sum(confidences) / len(confidences) if confidences else 0.0

    log.debug(
        "chimera detect: path=%s sr=%d dur=%.2f bpm=%s beats=%d conf=%.3f",
        path,
        sr,
        duration_sec,
        bpm,
        len(beats),
        confidence,
    )

    return {
        "bpm": bpm,
        "beats": beats,
        "confidence": confidence,
        "samplerate": int(sr),
        "duration_sec": duration_sec,
    }
