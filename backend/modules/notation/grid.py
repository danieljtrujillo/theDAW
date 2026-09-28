"""The beat grid a score's notes are put on before it is engraved.

A transcription's onsets fall between grid lines, and a sheet can only print
what a note value or a tuplet says. :func:`quantize_score` puts every note of
a score on a grid chosen bar by bar: each bar tries the divisions of a quarter
in :data:`DIVISORS` (sixteenths, eighth triplets, quintuplets, sextuplets,
septuplets, thirty-seconds) and keeps the one that fits its onsets and ends
with the least error. A finer grid always fits at least as well as a coarser
one it contains, so a division later in the list replaces the one kept only
when it at least halves the error (:func:`best_divisor`); a bar of plain
sixteenths stays on sixteenths and a bar of real triplets goes to triplets.

A source whose notes are already where they are meant to be is left alone:
theDAW's roll writes its notes at exact ticks, and :mod:`.midi_read` marks a
score read from one with :func:`mark_exact`.
"""

from __future__ import annotations

import bisect
import copy
from fractions import Fraction
from typing import Any, Iterable, Optional, Sequence

# Divisions of a quarter note tried per bar, simplest first.
DIVISORS: tuple[int, ...] = (4, 3, 5, 6, 7, 8)

# A division later in DIVISORS replaces the one kept only when its mean error
# is below this share of the kept one's, less _MIN_GAIN quarters.
_GAIN = 0.5
_MIN_GAIN = 0.002

# The key on a score's ``editorial`` that marks it exact.
_EXACT_KEY = "theDAWExactGrid"

_EPS = 1e-9


def mark_exact(score: Any) -> None:
    """Mark ``score`` as holding its notes exactly where they sound, so
    :func:`quantize_score` leaves it alone."""
    score.editorial[_EXACT_KEY] = True


def is_exact(score: Any) -> bool:
    """Whether ``score`` was marked by :func:`mark_exact`."""
    try:
        return bool(score.editorial.get(_EXACT_KEY, False))
    except AttributeError:
        return False


def _grid_error(points: Sequence[float], divisor: int) -> float:
    """The mean distance of ``points`` (quarters from the bar line) from the
    nearest line of a grid of ``divisor`` lines a quarter."""
    if not points:
        return 0.0
    total = 0.0
    for point in points:
        total += abs(point - round(point * divisor) / divisor)
    return total / len(points)


def best_divisor(points: Sequence[float], divisors: Sequence[int] = DIVISORS) -> int:
    """The division of a quarter that fits ``points`` (onsets and ends, in
    quarters from the bar line) best: the first of ``divisors`` unless a later
    one at least halves the error of the one kept so far."""
    kept = divisors[0]
    kept_error = _grid_error(points, kept)
    for divisor in divisors[1:]:
        error = _grid_error(points, divisor)
        if error < kept_error * _GAIN - _MIN_GAIN:
            kept, kept_error = divisor, error
    return kept


def _snap(value: float, bar: float, divisor: int) -> Any:
    from music21 import common

    steps = round((float(value) - bar) * divisor)
    return common.opFrac(
        Fraction(bar).limit_denominator(10_000) + Fraction(steps, divisor)
    )


def _bar_index(starts: Sequence[float], value: float) -> int:
    return max(0, bisect.bisect_right(starts, value + _EPS) - 1)


def _quantize_flat(part: Any) -> None:
    """Put every note and rest of the unbarred ``part`` on its bar's grid."""
    from music21 import common, meter

    from .bar_lines import bar_starts, spec_of

    elements = list(part.notesAndRests)
    if not elements:
        return
    meters = [
        (float(ts.getOffsetBySite(part)), spec_of(ts))
        for ts in part.getElementsByClass(meter.TimeSignature)
    ]
    end = max(
        float(el.getOffsetBySite(part)) + float(el.duration.quarterLength)
        for el in elements
    )
    starts = bar_starts(meters, end + 1.0)
    points: dict[int, list[float]] = {}
    for el in elements:
        if el.isRest:
            continue
        onset = float(el.getOffsetBySite(part))
        index = _bar_index(starts, onset)
        bar = starts[index]
        points.setdefault(index, []).append(onset - bar)
        points[index].append(onset + float(el.duration.quarterLength) - bar)
    divisors = {index: best_divisor(values) for index, values in points.items()}

    def divisor_at(index: int) -> int:
        return divisors.get(index, DIVISORS[0])

    for el in elements:
        onset = float(el.getOffsetBySite(part))
        finish = onset + float(el.duration.quarterLength)
        start_index = _bar_index(starts, onset)
        start_divisor = divisor_at(start_index)
        new_onset = _snap(onset, starts[start_index], start_divisor)
        # An end on a bar line belongs to the bar it closes.
        end_index = _bar_index(starts, finish - 1e-6)
        new_end = _snap(finish, starts[end_index], divisor_at(end_index))
        length = common.opFrac(new_end - new_onset)
        if length <= 0:
            length = common.opFrac(Fraction(1, start_divisor))
        part.setElementOffset(el, new_onset)
        el.duration.quarterLength = length


def _quantize_measures(measures: Iterable[Any]) -> None:
    """Put each measure's notes on the grid that fits that measure."""
    for measure in measures:
        padding = float(measure.paddingLeft or 0.0)
        points: list[float] = []
        for el in measure.recurse().notes:
            onset = float(el.getOffsetInHierarchy(measure)) + padding
            points += [onset, onset + float(el.duration.quarterLength)]
        if not points:
            continue
        divisor = best_divisor(points)
        measure.quantize(
            (divisor,),
            processOffsets=True,
            processDurations=True,
            inPlace=True,
            recurse=True,
        )


def quantize_score(score: Any, *, exact: Optional[bool] = None) -> Any:
    """A copy of ``score`` with every note on the grid of its bar.

    ``exact`` (default: :func:`is_exact`) returns ``score`` itself untouched.
    A barred part is quantized measure by measure; an unbarred one (a MIDI
    read by :mod:`.midi_read`) bar by bar along its time signatures.
    """
    from music21 import stream

    if exact is None:
        exact = is_exact(score)
    if exact:
        return score
    out = copy.deepcopy(score)
    parts = list(getattr(out, "parts", ())) or [out]
    for part in parts:
        measures = list(part.getElementsByClass(stream.Measure))
        if measures:
            _quantize_measures(measures)
        else:
            _quantize_flat(part)
    return out


def quantizer_label(exact: bool) -> str:
    """How a score was put on its grid, as a note chart records it."""
    return (
        "source"
        if exact
        else "theDAW.grid per bar (" + "/".join(map(str, DIVISORS)) + ")"
    )
