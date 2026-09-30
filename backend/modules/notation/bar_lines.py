"""Put every meter change of a rebuilt part on a bar line.

music21's ``makeMeasures`` bars a part from offset 0, and at each bar line it
takes the time signature at or before that offset. A time signature stated
between two bar lines therefore changes the barring only from the next bar
line, while the writer still prints it in the bar it falls in, so that bar
declares a meter its contents do not fill. A MIDI can state a meter change
anywhere, and a band score's stems are laid out on a tempo grid their own
meter changes need not fall on. :func:`snap_meters_to_bar_lines` moves each
change to the bar line where ``makeMeasures`` applies it, so the printed meter
and the barring agree.

A meter here is a spec string: ``"n/d"``, or ``"n/d g+g+g"`` when the bar is
grouped (``"7/8 2+2+3"``, each group counted in units of ``d``, as theDAW's
roll writes it in its ``theDAW:groups=`` text). Two specs that differ only in
their grouping are two meters, so a change of grouping is a meter change.
:func:`time_signature` builds the music21 ``TimeSignature`` a spec names, its
beams, accents and beats partitioned by the groups.

:func:`bar_like_source` bars unbarred parts on these bar lines and, given a
pickup, opens every staff with it (``paddingLeft``), as the source is barred.
"""

from __future__ import annotations

from typing import Any, Optional, Sequence

# A meter change within this many quarters of a bar line is on it.
_EPS = 1e-6
# What music21 and a MIDI file assume before any stated meter.
DEFAULT_METER = "4/4"


def meter_spec(num: int, den: int, groups: Sequence[int] = ()) -> str:
    """The spec of a ``num``/``den`` bar grouped by ``groups``: ``"n/d"`` when
    there is no grouping (fewer than two groups, or groups that do not add up
    to ``num``), ``"n/d g+g+g"`` otherwise."""
    kept = [int(g) for g in groups]
    ratio = f"{int(num)}/{int(den)}"
    if len(kept) < 2 or sum(kept) != int(num) or any(g < 1 for g in kept):
        return ratio
    return f"{ratio} {'+'.join(str(g) for g in kept)}"


def spec_parts(spec: str) -> tuple[int, int, tuple[int, ...]]:
    """``(num, den, groups)`` of a meter spec (``groups`` empty without one)."""
    ratio, _, grouping = spec.strip().partition(" ")
    numerator, denominator = ratio.split("/")
    groups = tuple(int(g) for g in grouping.split("+")) if grouping else ()
    return int(numerator), int(denominator), groups


def bar_quarters(ratio: str) -> float:
    """The length of a bar of ``ratio`` (a spec, "n/d" or "n/d g+g") in
    quarter notes."""
    numerator, denominator, _groups = spec_parts(ratio)
    return numerator * 4.0 / denominator


def time_signature(spec: str) -> Any:
    """The music21 ``TimeSignature`` of ``spec``. A grouped spec partitions its
    beams, accents and beats by the groups: ``"7/8 2+2+3"`` beams and accents
    two, two and three eighths and counts three beats."""
    from music21 import meter

    num, den, groups = spec_parts(spec)
    ts = meter.TimeSignature(f"{num}/{den}")
    if groups:
        ts.beamSequence.partition(list(groups))
        ts.accentSequence.partition(list(groups))
        ts.beatSequence.partition(list(groups))
    return ts


def spec_of(ts: Any) -> str:
    """The spec of a music21 ``TimeSignature``: its ratio, grouped by its beam
    groups when every group is counted in its own denominator and not every
    group is one unit (4/4's beams are four quarters: no grouping)."""
    ratio = f"{int(ts.numerator)}/{int(ts.denominator)}"
    try:
        parts = list(ts.beamSequence)
        groups = []
        for part in parts:
            if int(part.denominator) != int(ts.denominator):
                return ratio
            groups.append(int(part.numerator))
    except (AttributeError, TypeError, ValueError):
        return ratio
    if all(g == 1 for g in groups):
        return ratio
    return meter_spec(ts.numerator, ts.denominator, groups)


def snap_meters_to_bar_lines(
    meters: Sequence[tuple[float, str]],
) -> list[tuple[float, str, Optional[int]]]:
    """``(offset, spec, index)`` for each meter change of ``meters`` at the bar
    line where ``makeMeasures`` puts it in force: the first bar line at or
    after its offset, counting bars of the meter in force before it.

    ``index`` is the position in ``meters`` of the change kept there, or None
    for a :data:`DEFAULT_METER` added at offset 0 when the first change is
    stated later (a part barred by ``makeMeasures`` needs a meter at 0, and a
    MIDI file is in 4/4 until it states another). Of two changes that land on
    one bar line the later stands; a change restating the meter in force is
    dropped.
    """
    order = sorted(range(len(meters)), key=lambda i: float(meters[i][0]))
    out: list[tuple[float, str, Optional[int]]] = []
    if not order or float(meters[order[0]][0]) > _EPS:
        out.append((0.0, DEFAULT_METER, None))
    bar_start = 0.0
    for index in order:
        offset, ratio = float(meters[index][0]), meters[index][1]
        bar = bar_quarters(out[-1][1]) if out else bar_quarters(ratio)
        while bar_start < offset - _EPS:
            bar_start += bar
        if out and abs(out[-1][0] - bar_start) < _EPS:
            out.pop()
        if not out or out[-1][1] != ratio:
            out.append((bar_start, ratio, index))
    return out


def bar_starts(meters: Sequence[tuple[float, str]], end: float) -> list[float]:
    """Every bar line from 0 to before ``end`` of a part barred by ``meters``
    (:func:`snap_meters_to_bar_lines`), 0 included."""
    snapped = snap_meters_to_bar_lines(meters)
    out: list[float] = []
    at = 0.0
    index = 0
    while at < end - _EPS or not out:
        while index + 1 < len(snapped) and snapped[index + 1][0] <= at + _EPS:
            index += 1
        out.append(at)
        at += bar_quarters(snapped[index][1])
    return out


def snap_part_meters(part: Any) -> None:
    """Move each time signature of the unbarred ``part`` to the bar line where
    ``makeMeasures`` puts it in force (:func:`snap_meters_to_bar_lines`), so no
    bar prints a meter its contents do not fill. A time signature kept keeps
    its grouping."""
    from music21 import meter

    stated = list(part.getElementsByClass(meter.TimeSignature))
    at = [(float(ts.getOffsetBySite(part)), spec_of(ts)) for ts in stated]
    for ts in stated:
        part.remove(ts)
    for offset, spec, index in snap_meters_to_bar_lines(at):
        part.insert(
            offset, stated[index] if index is not None else time_signature(spec)
        )


def pickup_bar_fits(part: Any, pickup: float) -> bool:
    """Whether the first bar of the barred ``part`` can become a pickup that
    starts ``pickup`` quarters in: it has no voices and nothing but rests
    starts before ``pickup``."""
    from music21 import stream

    first = part.getElementsByClass(stream.Measure).first()
    if first is None or first.hasVoices():
        return False
    return all(
        el.isRest
        for el in first.notesAndRests
        if el.getOffsetBySite(first) < pickup - _EPS
    )


def open_with_pickup(part: Any, pickup: float) -> None:
    """Turn the first bar of the barred ``part``, whose music starts ``pickup``
    quarters in, into a pickup bar (:func:`pickup_bar_fits` must hold): the
    rests before the music go, a rest reaching past ``pickup`` keeping its
    part after it, the rest of the bar moves back by ``pickup`` with
    ``paddingLeft`` set, and every later bar moves back and is numbered one
    lower, so the pickup is bar 0 as in the source."""
    from music21 import common, note, stream

    measures = list(part.getElementsByClass(stream.Measure))
    first = measures[0]
    for el in list(first.notesAndRests):
        offset = el.getOffsetBySite(first)
        if offset < pickup - _EPS:
            first.remove(el)
            end = offset + el.quarterLength
            if end > pickup + _EPS:
                first.insert(pickup, note.Rest(quarterLength=end - pickup))
    for el in list(first.elements):
        offset = el.getOffsetBySite(first)
        if offset >= pickup - _EPS:
            first.setElementOffset(el, common.opFrac(offset - pickup))
    first.paddingLeft = pickup
    first.number = 0
    for measure in measures[1:]:
        part.setElementOffset(
            measure, common.opFrac(measure.getOffsetBySite(part) - pickup)
        )
        measure.number = measure.number - 1


def shift_after_pickup(part: Any, pickup: float) -> None:
    """Move every note of the unbarred ``part``, and every other element after
    offset 0, ``pickup`` quarters later, so a bar line of the meter at 0 falls
    ``pickup`` quarters before the music starts."""
    from music21 import common, note

    for element in list(part.elements):
        offset = element.getOffsetBySite(part)
        if offset > 0 or isinstance(element, note.GeneralNote):
            part.setElementOffset(element, common.opFrac(offset + pickup))


def bar_like_source(score: Any, pickup: float) -> None:
    """Bar the unbarred parts of ``score`` as their source is barred.

    Each time signature moves to the bar line it takes effect on
    (:func:`snap_part_meters`). With a ``pickup`` (how far into its first bar
    the source's music starts: the first bar's ``paddingLeft``) every note and
    every mark after offset 0 moves ``pickup`` later
    (:func:`shift_after_pickup`), so the source's bar lines fall on the
    parts'; the parts are then barred and each first bar becomes the pickup
    (:func:`open_with_pickup`). Without one the writer bars the parts.
    """
    for part in score.parts:
        if pickup:
            shift_after_pickup(part, pickup)
        snap_part_meters(part)
    if pickup:
        # As music21's writer bars a score: every part to the end of the
        # longest, so a staff that falls silent keeps its bars.
        end = [0.0, float(score.highestTime)]
        for part in score.parts:
            part.makeNotation(refStreamOrTimeRange=end, inPlace=True)
        # Every staff opens with the pickup, or none does and each first bar
        # opens on rests, so the staves keep one bar grid.
        if all(pickup_bar_fits(part, pickup) for part in score.parts):
            for part in score.parts:
                open_with_pickup(part, pickup)
