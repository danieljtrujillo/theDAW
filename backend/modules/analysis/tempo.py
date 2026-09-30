"""The song tempo read from an entry's analysis row, checked before anything
is written with it.

The row's ``bpm`` is aubio's closing tempo estimate (``chimera.detect``),
which a fade or a long tail can drag anywhere: entries in a real library read
40.69 BPM while their beat lists keep 95 to 152 BPM. A tempo outside
``SANE_BPM_MIN``-``SANE_BPM_MAX`` is a failed estimate. The beat list's own
tempo (60 over the median gap between beats) replaces it when that is inside
the range; when neither is, there is no tempo and the beats are not used.

The MIDI runner stamps this tempo on an entry's MIDI files and the notation
routes lay a score's bars out at it, so both read one number.
"""

from __future__ import annotations

import json
import math
import statistics
from typing import Any, Mapping, NamedTuple, Optional

SANE_BPM_MIN = 50.0
SANE_BPM_MAX = 220.0


class AnalysisTempo(NamedTuple):
    """``bpm``: the tempo to use, or ``None``. ``beats``: the beat list
    (seconds), empty when no tempo is usable. ``rejected_bpm``: the row's own
    BPM when it was outside the range, else ``None``."""

    bpm: Optional[float]
    beats: list[float]
    rejected_bpm: Optional[float]


def is_sane_bpm(bpm: Optional[float]) -> bool:
    return bpm is not None and SANE_BPM_MIN <= bpm <= SANE_BPM_MAX


def bpm_from_beats(beats: list[float]) -> Optional[float]:
    """The tempo the beat list itself keeps: 60 over the median gap between
    beats. ``None`` for fewer than three beats or no forward gap."""
    ordered = sorted(beats)
    gaps = [b - a for a, b in zip(ordered, ordered[1:]) if b > a]
    if len(gaps) < 2:
        return None
    return 60.0 / statistics.median(gaps)


def _row_bpm(row: Mapping[str, Any]) -> Optional[float]:
    try:
        raw = row.get("bpm")
        if raw is not None and float(raw) > 0.0:
            return float(raw)
    except (TypeError, ValueError):
        pass
    return None


def _row_beats(row: Mapping[str, Any]) -> list[float]:
    try:
        parsed = json.loads(row.get("beats_json") or "[]")
        beats = [float(b) for b in parsed if b is not None]
    except (TypeError, ValueError):
        return []
    return [b for b in beats if math.isfinite(b)]


def analysis_tempo(row: Optional[Mapping[str, Any]]) -> AnalysisTempo:
    """The checked tempo of an analysis row (see the module docstring)."""
    if not row:
        return AnalysisTempo(None, [], None)
    bpm = _row_bpm(row)
    beats = _row_beats(row)
    if is_sane_bpm(bpm):
        return AnalysisTempo(bpm, beats, None)
    rejected = bpm
    from_beats = bpm_from_beats(beats)
    if is_sane_bpm(from_beats):
        return AnalysisTempo(from_beats, beats, rejected)
    return AnalysisTempo(None, [], rejected)
