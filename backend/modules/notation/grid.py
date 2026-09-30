"""The beat grid a score's notes are put on before it is engraved.

A transcription's onsets fall between grid lines, and a sheet can only print
what a note value or a tuplet says. :func:`quantize_score` puts every note of
a score on a grid of the divisions of a quarter in :data:`DIVISORS`
(sixteenths, eighth triplets, quintuplets, sextuplets, septuplets,
thirty-seconds), chosen for each beat. A finer grid always fits at least as
well as a coarser one it contains, so a division later in the list replaces
the one kept only when it at least halves the error (:func:`best_divisor`).

Each bar first keeps the division that fits all its onsets and ends. Each of
its beats (each pulse group of a grouped meter such as ``7/8 2+2+3``; beats
shorter than a quarter, the eighths of an ungrouped ``5/8``, pair up) then
takes its own best division in place of the bar's only when that at least
halves the error the bar's grid leaves in it, the same rule one level down.
A bar of sixteenths with an eighth triplet on beat 2 prints both; a bar of
slightly uneven triplets stays on triplets throughout, since no one beat of
it fits sixteenths twice as well. The grid of a beat that took its own
division starts on the beat.

A source whose notes are already where they are meant to be is left alone:
theDAW's roll writes its notes at exact ticks, and :mod:`.midi_read` marks a
score read from one with :func:`mark_exact`.
"""

from __future__ import annotations

import bisect
import copy
import functools
from fractions import Fraction
from typing import Any, Iterable, Optional, Sequence

# Divisions of a quarter note tried per beat, simplest first.
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


def _snap(value: float, anchor: float, divisor: int) -> Any:
    """``value`` on the nearest line of a grid of ``divisor`` lines a quarter
    that runs from ``anchor``."""
    from music21 import common

    steps = round((float(value) - anchor) * divisor)
    return common.opFrac(
        Fraction(anchor).limit_denominator(10_000) + Fraction(steps, divisor)
    )


@functools.lru_cache(maxsize=None)
def _beat_lengths(spec: str) -> tuple[float, ...]:
    """The length in quarters of each stretch of a bar of ``spec`` that
    chooses its own grid: its beats, or its pulse groups when it is grouped.
    Beats shorter than a quarter (an ungrouped ``5/8`` counts eighths) are
    joined until each stretch holds at least a quarter, since a triplet of
    eighths spans one; a short remainder joins the stretch before it."""
    from .bar_lines import time_signature

    beats = [
        float(beat.duration.quarterLength) for beat in time_signature(spec).beatSequence
    ]
    out: list[float] = []
    run = 0.0
    for beat in beats:
        run += beat
        if run >= 1.0 - _EPS:
            out.append(run)
            run = 0.0
    if run > _EPS:
        if out:
            out[-1] += run
        else:
            out.append(run)
    return tuple(out)


def _beat_starts(spec: str, bar: float, until: float) -> list[float]:
    """The start of every stretch of a bar of ``spec`` beginning at ``bar``,
    up to ``until``."""
    out = [bar]
    for length in _beat_lengths(spec)[:-1]:
        out.append(out[-1] + length)
    return [start for start in out if start < until - _EPS] or [bar]


def _stretch(starts: Sequence[float], value: float) -> int:
    return max(0, bisect.bisect_right(starts, value + _EPS) - 1)


def _grids(
    starts: Sequence[float],
    bars: Sequence[float],
    spans: Iterable[tuple[float, float]],
) -> list[tuple[float, int]]:
    """``(anchor, divisor)`` of the grid each stretch beginning at ``starts``
    (in the bar beginning at ``bars[i]``) puts its notes on, from the onsets
    and ends of ``spans``: the bar's division on a grid from the bar line,
    or the stretch's own on a grid from its start when that at least halves
    the error the bar's leaves there."""
    by_bar: dict[float, list[float]] = {}
    in_stretch: dict[int, list[float]] = {}
    from_bar: dict[int, list[float]] = {}
    for onset, finish in spans:
        at = _stretch(starts, onset)
        # A note's end counts toward the bar it starts in, as it always did.
        by_bar.setdefault(bars[at], []).extend((onset - bars[at], finish - bars[at]))
        for value, index in ((onset, at), (finish, _stretch(starts, finish - 1e-6))):
            in_stretch.setdefault(index, []).append(value - starts[index])
            from_bar.setdefault(index, []).append(value - bars[index])
    bar_divisor = {bar: best_divisor(points) for bar, points in by_bar.items()}
    out: list[tuple[float, int]] = []
    for index, start in enumerate(starts):
        kept = bar_divisor.get(bars[index], DIVISORS[0])
        grid = (bars[index], kept)
        points = in_stretch.get(index)
        if points:
            own = best_divisor(points)
            if (
                own != kept
                and _grid_error(points, own)
                < _grid_error(from_bar[index], kept) * _GAIN - _MIN_GAIN
            ):
                grid = (start, own)
        out.append(grid)
    return out


def _placed(
    starts: Sequence[float],
    grids: Sequence[tuple[float, int]],
    onset: float,
    finish: float,
) -> tuple[Any, Any, int]:
    """``(onset, end, divisor at the onset)`` of a note put on the grids of the
    stretches it starts and ends in."""
    anchor, divisor = grids[_stretch(starts, onset)]
    new_onset = _snap(onset, anchor, divisor)
    # An end on a stretch line belongs to the stretch it closes.
    end_anchor, end_divisor = grids[_stretch(starts, finish - 1e-6)]
    new_end = _snap(finish, end_anchor, end_divisor)
    return new_onset, new_end, divisor


def _quantize_flat(part: Any) -> None:
    """Put every note and rest of the unbarred ``part`` on its beat's grid."""
    from music21 import common, meter

    from .bar_lines import bar_starts, snap_meters_to_bar_lines, spec_of

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
    bars = bar_starts(meters, end + 1.0)
    changes = snap_meters_to_bar_lines(meters)
    change_at = [offset for offset, _spec, _index in changes]
    starts: list[float] = []
    bar_of: list[float] = []
    for index, bar in enumerate(bars):
        spec = changes[max(0, bisect.bisect_right(change_at, bar + _EPS) - 1)][1]
        until = bars[index + 1] if index + 1 < len(bars) else float("inf")
        beats = _beat_starts(spec, bar, until)
        starts.extend(beats)
        bar_of.extend([bar] * len(beats))
    spans = [
        (
            float(el.getOffsetBySite(part)),
            float(el.getOffsetBySite(part)) + float(el.duration.quarterLength),
        )
        for el in elements
        if not el.isRest
    ]
    grids = _grids(starts, bar_of, spans)

    for el in elements:
        onset = float(el.getOffsetBySite(part))
        finish = onset + float(el.duration.quarterLength)
        new_onset, new_end, divisor = _placed(starts, grids, onset, finish)
        length = common.opFrac(new_end - new_onset)
        if length <= 0:
            length = common.opFrac(Fraction(1, divisor))
        part.setElementOffset(el, new_onset)
        el.duration.quarterLength = length


def _measure_spec(measure: Any) -> str:
    from music21 import meter

    from .bar_lines import DEFAULT_METER, spec_of

    ts = measure.timeSignature or measure.getContextByClass(meter.TimeSignature)
    return spec_of(ts) if ts is not None else DEFAULT_METER


def _quantize_mixed_measure(
    measure: Any,
    starts: Sequence[float],
    grids: Sequence[tuple[float, int]],
    padding: float,
) -> None:
    """Put each element of ``measure`` (and of its voices) on the grid of the
    beat it falls in; ``starts`` are the beats' starts from the bar line."""
    from music21 import common, note, stream

    for container in measure.recurse(streamsOnly=True, includeSelf=True):
        base = (
            0.0
            if container is measure
            else float(container.getOffsetInHierarchy(measure))
        ) + padding
        for el in list(container):
            if isinstance(el, stream.Stream):
                continue
            onset = float(container.elementOffset(el)) + base
            length = float(el.duration.quarterLength)
            sounding = isinstance(el, note.GeneralNote) and not el.duration.isGrace
            if not sounding or length <= 0:
                anchor, divisor = grids[_stretch(starts, onset)]
                new_onset = _snap(onset, anchor, divisor)
                container.setElementOffset(el, common.opFrac(new_onset - base))
                continue
            new_onset, new_end, divisor = _placed(starts, grids, onset, onset + length)
            new_length = common.opFrac(new_end - new_onset)
            if new_length <= 0:
                new_length = common.opFrac(Fraction(1, divisor))
            container.setElementOffset(el, common.opFrac(new_onset - base))
            el.duration.quarterLength = new_length


def _quantize_measures(measures: Iterable[Any]) -> None:
    """Put each measure's notes on the grid that fits each of its beats."""
    for measure in measures:
        padding = float(measure.paddingLeft or 0.0)
        spans: list[tuple[float, float]] = []
        for el in measure.recurse().notes:
            onset = float(el.getOffsetInHierarchy(measure)) + padding
            spans.append((onset, onset + float(el.duration.quarterLength)))
        if not spans:
            continue
        starts = _beat_starts(_measure_spec(measure), 0.0, float("inf"))
        grids = _grids(starts, [0.0] * len(starts), spans)
        if len(set(grids)) == 1:
            # One grid for the whole bar: music21's own quantizer, which also
            # fills a note up to the next onset it nearly reaches.
            measure.quantize(
                (grids[0][1],),
                processOffsets=True,
                processDurations=True,
                inPlace=True,
                recurse=True,
            )
        else:
            _quantize_mixed_measure(measure, starts, grids, padding)


def quantize_score(score: Any, *, exact: Optional[bool] = None) -> Any:
    """A copy of ``score`` with every note on the grid of its beat.

    ``exact`` (default: :func:`is_exact`) returns ``score`` itself untouched.
    A barred part is quantized measure by measure, beat by beat; an unbarred
    one (a MIDI read by :mod:`.midi_read`) along the beats of its time
    signatures.
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
        else "theDAW.grid per beat (" + "/".join(map(str, DIVISORS)) + ")"
    )
