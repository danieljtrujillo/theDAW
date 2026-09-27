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
"""

from __future__ import annotations

from typing import Optional, Sequence

# A meter change within this many quarters of a bar line is on it.
_EPS = 1e-6
# What music21 and a MIDI file assume before any stated meter.
DEFAULT_METER = "4/4"


def bar_quarters(ratio: str) -> float:
    """The length of a bar of ``ratio`` ("n/d") in quarter notes."""
    numerator, denominator = ratio.split("/")
    return int(numerator) * 4.0 / int(denominator)


def snap_meters_to_bar_lines(
    meters: Sequence[tuple[float, str]],
) -> list[tuple[float, str, Optional[int]]]:
    """``(offset, "n/d", index)`` for each meter change of ``meters`` at the bar
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
