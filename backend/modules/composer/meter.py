"""The piano roll's meter map as music21 time signatures and a tick grid.

The roll keeps its time signatures as a meter map (``frontend/src/lib/meterMap.ts``):
a list of ``{bar, meter: {num, den, groups}}`` segments, bar 0 first, each
holding until the next. ``groups`` are counts of the denominator's unit that
sum to the numerator (7/8 as 2+2+3 is ``[2, 2, 3]``); an empty list means the
bar has no grouping of its own. An optional pickup of ``pickup_steps``
sixteenths sits before bar 0 and is reported as bar -1.

Each bar's pulses follow ``meterMap.ts``'s ``pulseLines``: the group starts when
the bar has groups, the dotted beats of a compound meter (6/8 counts in two),
otherwise every beat of the denominator. Those pulses become the music21
``TimeSignature``'s beat sequence, and its accent sequence puts the full
weight on the downbeat and half on every other group start, so strong beats
come from the groups. A simple meter keeps music21's own accent hierarchy
(4/4 weighs beat 3 over beats 2 and 4).

Ticks are 960 to the quarter note, the roll's PPQ.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Iterable

from music21 import meter as m21meter

from .spec import PPQ

TICKS_PER_STEP = PPQ // 4  # a sixteenth
DENOMINATORS = (1, 2, 4, 8, 16, 32)


@dataclass(frozen=True)
class Meter:
    num: int
    den: int
    groups: tuple[int, ...] = ()

    @property
    def bar_ticks(self) -> int:
        return self.num * PPQ * 4 // self.den

    @property
    def unit_ticks(self) -> int:
        """Ticks in one unit of the denominator (an eighth in 7/8 is 480)."""
        return PPQ * 4 // self.den

    @property
    def label(self) -> str:
        head = "+".join(str(g) for g in self.groups) if self.groups else str(self.num)
        return f"{head}/{self.den}"


DEFAULT_METER = Meter(4, 4, ())


def is_compound(num: int, den: int) -> bool:
    """6/8, 9/8, 12/8, 15/16 and the like: counted in dotted beats."""
    return den >= 8 and num > 3 and num % 3 == 0


def sanitize_meter(raw: Any) -> Meter | None:
    """A Meter from the roll's ``{num, den, groups}``, or None when it is not
    one. Groups survive only when there are at least two and they sum to the
    numerator, as ``sanitizeMeter`` in meterMap.ts keeps them."""
    if raw is None:
        return None
    if isinstance(raw, Meter):
        return raw
    get = raw.get if isinstance(raw, dict) else lambda k, d=None: getattr(raw, k, d)
    try:
        num = int(get("num"))
        den = int(get("den"))
    except (TypeError, ValueError):
        return None
    if num < 1 or num > 64 or den not in DENOMINATORS:
        return None
    groups_raw = get("groups", None) or []
    try:
        groups = tuple(int(g) for g in groups_raw)
    except (TypeError, ValueError):
        groups = ()
    ok = len(groups) > 1 and all(g >= 1 for g in groups) and sum(groups) == num
    return Meter(num, den, groups if ok else ())


def pulse_units(m: Meter) -> tuple[int, ...]:
    """The bar's pulses in units of the denominator: its groups, the dotted
    beats of a compound meter, or one per beat."""
    if m.groups:
        return m.groups
    if is_compound(m.num, m.den):
        return (3,) * (m.num // 3)
    return (1,) * m.num


def accents_from_groups(m: Meter) -> bool:
    """True when the pulses are group starts (or dotted beats) rather than
    plain beats, so every pulse after the downbeat carries an accent."""
    return bool(m.groups) or is_compound(m.num, m.den)


@lru_cache(maxsize=256)
def time_signature(m: Meter) -> m21meter.TimeSignature:
    """A music21 TimeSignature whose beat sequence is the bar's pulses and
    whose accent sequence weighs the group starts. Cached: treat it as
    read-only."""
    ts = m21meter.TimeSignature(f"{m.num}/{m.den}")
    units = list(pulse_units(m))
    if len(units) > 1:
        ts.beatSequence.partition(units)
        if accents_from_groups(m):
            ts.accentSequence.partition(units)
            ts.setAccentWeight([1.0] + [0.5] * (len(units) - 1))
    return ts


@dataclass(frozen=True)
class Pulse:
    tick: int  # absolute
    ticks: int  # length
    beat: int  # 1-based within the bar
    accent: float


@dataclass(frozen=True)
class Bar:
    bar: int  # the meter map's bar index; -1 is the pickup
    tick: int
    ticks: int
    meter: Meter

    def pulses(self) -> list[Pulse]:
        if self.bar < 0:
            return [Pulse(self.tick, self.ticks, 1, 0.25)]
        ts = time_signature(self.meter)
        unit = self.meter.unit_ticks
        out: list[Pulse] = []
        at = self.tick
        for i, u in enumerate(pulse_units(self.meter)):
            ql = (at - self.tick) / PPQ
            out.append(Pulse(at, u * unit, i + 1, float(ts.getAccentWeight(ql))))
            at += u * unit
        return out


class MeterGrid:
    """Bars and pulses of a meter map, in ticks."""

    def __init__(
        self, meter_map: Iterable[Any] | None = None, pickup_steps: float = 0
    ) -> None:
        by_bar: dict[int, Meter] = {}
        for seg in meter_map or []:
            bar_raw = seg.get("bar") if isinstance(seg, dict) else seg.bar
            meter_raw = seg.get("meter") if isinstance(seg, dict) else seg.meter
            m = sanitize_meter(meter_raw)
            if m is None or bar_raw is None:
                continue
            by_bar[max(0, int(bar_raw))] = m
        segs = sorted(by_bar.items())
        if not segs:
            segs = [(0, DEFAULT_METER)]
        segs[0] = (0, segs[0][1])
        self.segments: list[tuple[int, Meter]] = segs
        self.pickup_ticks = max(0, round(float(pickup_steps or 0) * TICKS_PER_STEP))

    def meter_at(self, bar: int) -> Meter:
        m = self.segments[0][1]
        for b, seg_meter in self.segments:
            if b <= max(0, bar):
                m = seg_meter
            else:
                break
        return m

    def bar(self, index: int) -> Bar:
        if index < 0:
            return Bar(-1, 0, self.pickup_ticks, self.segments[0][1])
        tick = self.pickup_ticks
        for b in range(index):
            tick += self.meter_at(b).bar_ticks
        m = self.meter_at(index)
        return Bar(index, tick, m.bar_ticks, m)

    def bars(self, count: int) -> list[Bar]:
        out: list[Bar] = []
        tick = self.pickup_ticks
        for b in range(count):
            m = self.meter_at(b)
            out.append(Bar(b, tick, m.bar_ticks, m))
            tick += m.bar_ticks
        return out

    def bar_at(self, tick: int) -> Bar:
        if self.pickup_ticks and tick < self.pickup_ticks:
            return self.bar(-1)
        at = self.pickup_ticks
        b = 0
        while True:
            m = self.meter_at(b)
            if tick < at + m.bar_ticks:
                return Bar(b, at, m.bar_ticks, m)
            at += m.bar_ticks
            b += 1

    def locate(self, tick: int) -> tuple[int, int]:
        """(bar, beat) for a tick: the meter map's bar index and the 1-based
        pulse that holds the tick."""
        bar = self.bar_at(max(0, int(tick)))
        beat = 1
        for p in bar.pulses():
            if p.tick <= tick:
                beat = p.beat
        return bar.bar, beat

    def strong_ticks(self, count: int) -> list[int]:
        """The absolute ticks of every accented pulse (accent >= 0.5) in the
        first ``count`` bars."""
        return [p.tick for b in self.bars(count) for p in b.pulses() if p.accent >= 0.5]
