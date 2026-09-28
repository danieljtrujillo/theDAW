"""Form plans: sonata, rondo, theme and variations, minuet and trio, scherzo
and a four-movement symphony, each a list of sections with a role, a length
in bars, a key, a tempo, a meter and a harmonic plan from the harmony planner
(harmony.py).

``plan_form`` lays the sections out; ``realize_form`` also voices every chord
in soprano, alto, tenor and bass and runs the voice-leading checker.

The forms
---------

* ``sonata``: an exposition (first group in the tonic; a transition that
  modulates and stops on a half cadence in the new key; the second group in
  the dominant, or the relative major in a minor key; a closing section), a
  development that walks through a closely related key and a remote one and
  ends on the tonic's dominant, a recapitulation with the second group in the
  tonic, and a coda.
* ``rondo``: ``ABACA`` or ``ABACABA``. The refrain is in the tonic, B in the
  dominant (relative major), C in the relative minor or the subdominant
  (the subdominant or the submediant in minor); a retransition leads back to
  each refrain on the tonic's dominant, and the last B of ``ABACABA`` is in
  the tonic.
* ``theme_and_variations``: a theme, variations on the same harmonic plan
  (the one before the last in the parallel mode, the minore or maggiore), and
  a coda.
* ``minuet_and_trio`` and ``scherzo``: a rounded binary minuet (the first
  reprise closes in the dominant or relative major, the second returns home),
  a trio in the subdominant (relative major in minor), a link back, and the
  minuet da capo. A scherzo runs faster and longer.
* ``symphony``: I Allegro in the tonic in 4/4 (sonata); II Andante in the
  subdominant (relative major in minor) in 2/4 or 3/8 (theme and variations);
  III Menuetto in 3/4 or Scherzo in 3/4 (tonic); IV Allegro molto or Presto
  finale in the tonic in 2/4 or 6/8 (rondo), at least as fast as I.

Keys and modulation
-------------------

Where a section's key differs from the key the music is in when it starts,
the harmony gets there through pivot chords: each hop between closely related
keys is one phrase that the planner writes with ``modulate_to`` (a chord
diatonic in both keys, then V7 - I in the new key). A move to a remote key is
a chain of such hops, the shortest path through closely related keys. The
only joins without a pivot are a movement's start and the parallel-mode
switch of a minore (or maggiore) variation, which starts in its mode at the
double bar.

Sections are cut into phrases of about four bars (eight when the harmonic
rhythm is one chord a bar and the section runs to sixteen bars or more). A
phrase that needs more chords than its bars hold at one a bar takes one a
pulse; a section too short for its phrases grows.
Inner phrases close on half or imperfect cadences, the last on the section's
cadence (a perfect authentic one, or a half cadence for a section that leads
on). A theme that comes back (a recapitulation, a refrain, a variation, the
minuet da capo) is planned from the same seeds, so its harmony returns too.

Voicing
-------

``realize_form`` voices one section at a time with harmony.py's Viterbi
search and checker loop. Each section after the first is searched from the
section before's last voicing, so the join between them is checked too; when
no voicing passes that join, the section is voiced on its own. Every
section's flags are reported; the planner's search leaves them empty.

Ticks are 960 to the quarter note; each movement's ticks start at 0 and carry
its own meter map (``[{bar, meter: {num, den, groups}}]``) and tempo map
(``[{beat, bpm, curve, bar, tick, marking}]``, quarter notes a minute).
"""

from __future__ import annotations

import random
from collections import deque
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any, Mapping, Sequence

import numpy as np
from music21 import key as m21key

from .harmony import (
    CADENCE_UNITS,
    PlanError,
    PlannedChord,
    Slot,
    build_progression,
    candidates,
    closely_related,
    find_pivot,
    range_list,
    search_voicings,
)
from .meter import Meter, MeterGrid, pulse_units, sanitize_meter
from .spec import FORMS, PPQ, SATB
from .voiceleading import key_label, name_of, parse_key

__all__ = ["FORMS", "PlanError", "plan_form", "realize_form"]

VELOCITY = 80

DEFAULT_BARS = {
    "sonata": 96,
    "rondo": 72,
    "theme_and_variations": 56,
    "minuet_and_trio": 56,
    "scherzo": 96,
}
MIN_BARS = 16

HARMONIC_RHYTHMS = ("bar", "pulse")


# ---------------------------------------------------------------------------
# keys
# ---------------------------------------------------------------------------


def _kid(k: m21key.Key) -> tuple[int, str]:
    return (k.tonic.pitchClass, k.mode)


def same_key(a: m21key.Key, b: m21key.Key) -> bool:
    return _kid(a) == _kid(b)


@lru_cache(maxsize=512)
def _key_from(sharps: int, mode: str) -> m21key.Key:
    return m21key.KeySignature(sharps).asKey(mode)


def _k(sharps: int, mode: str) -> m21key.Key:
    return _key_from(sharps, mode)


def dominant_or_relative(t: m21key.Key) -> m21key.Key:
    """The second group's key: the dominant of a major key, the relative major of a minor one."""
    if t.mode == "major":
        return _k(t.sharps + 1, "major")
    return _k(t.sharps, "major")


def subdominant_or_relative(t: m21key.Key) -> m21key.Key:
    """A slow movement's or a trio's key: the subdominant of a major key, the relative major of a minor one."""
    if t.mode == "major":
        return _k(t.sharps - 1, "major")
    return _k(t.sharps, "major")


def parallel(t: m21key.Key) -> m21key.Key:
    return m21key.Key(t.tonic.name, "minor" if t.mode == "major" else "major")


@lru_cache(maxsize=4096)
def _has_pivot(a: tuple[int, str], b: tuple[int, str]) -> bool:
    try:
        find_pivot(_k(*a), _k(*b))
    except PlanError:
        return False
    return True


def key_path(
    a: m21key.Key,
    b: m21key.Key,
    rng: random.Random,
    avoid: Sequence[m21key.Key] = (),
) -> list[m21key.Key]:
    """The keys after ``a`` on a shortest walk to ``b`` through closely related
    keys that share a pivot chord, passing through none of ``avoid`` (a
    development keeps clear of the tonic until it goes home); empty when ``a``
    is ``b``."""
    if same_key(a, b):
        return []
    start = (a.sharps, a.mode)
    goal = _kid(b)
    blocked = {_kid(k) for k in avoid} - {goal}
    prev: dict[tuple[int, str], tuple[int, str] | None] = {start: None}
    queue = deque([start])
    found: tuple[int, str] | None = None
    while queue and found is None:
        s, mode = queue.popleft()
        here = _k(s, mode)
        nbrs = [(s + d, m) for d in (-1, 0, 1) for m in ("major", "minor")]
        # Toward the goal first; the seed breaks ties.
        rng.shuffle(nbrs)
        nbrs.sort(key=lambda x: abs(x[0] - b.sharps))
        for n in nbrs:
            if n in prev or abs(n[0]) > 9:
                continue
            nk = _k(*n)
            if _kid(nk) in blocked:
                continue
            if not closely_related(here, nk) or not _has_pivot((s, mode), n):
                continue
            prev[n] = (s, mode)
            if _kid(nk) == goal:
                found = n
                break
            queue.append(n)
    if found is None:
        raise PlanError(
            f"no path of pivot chords from {key_label(a)} to {key_label(b)}"
        )
    path: list[tuple[int, str]] = []
    cur: tuple[int, str] | None = found
    while cur is not None and cur != start:
        path.append(cur)
        cur = prev[cur]
    path.reverse()
    # The last step lands on the caller's own spelling of the goal.
    return [_k(*p) for p in path[:-1]] + [b]


# ---------------------------------------------------------------------------
# the plan's parts
# ---------------------------------------------------------------------------


@dataclass
class Phrase:
    bars: int
    key: m21key.Key
    to: m21key.Key | None
    cadence: str
    seed: int
    harmonic_rhythm: str = "bar"
    start_bar: int = 0
    chords: list[PlannedChord] = field(default_factory=list)
    slots: list[Slot] = field(default_factory=list)


@dataclass
class SectionSpec:
    role: str
    label: str
    bars: int
    key: m21key.Key
    # A section that leads on passes through these keys and ends in the last.
    waypoints: list[m21key.Key] | None = None
    end_cadence: str | None = None
    theme: str | None = None
    part: str | None = None
    join: str = "pivot"
    # Keys its modulations pass by (a development's tonic).
    avoid: list[m21key.Key] = field(default_factory=list)
    bpm: float | None = None
    marking: str | None = None


@dataclass
class Section:
    spec: SectionSpec
    index: int
    enter: m21key.Key
    join: str
    phrases: list[Phrase]
    bpm: float
    marking: str
    start_bar: int = 0

    @property
    def bars(self) -> int:
        return sum(p.bars for p in self.phrases)

    @property
    def end_key(self) -> m21key.Key:
        last = self.phrases[-1]
        return last.to or last.key


@dataclass
class Movement:
    index: int
    title: str
    form: str
    key: m21key.Key
    bpm: float
    marking: str
    meter: Meter
    sections: list[Section]
    grid: MeterGrid

    @property
    def bars(self) -> int:
        return sum(s.bars for s in self.sections)


def _cadence_len(cadence: str, mode: str) -> int:
    return len(CADENCE_UNITS[mode][cadence])


def _chords_needed(cadence: str, final_mode: str, modulates: bool) -> int:
    return 1 + _cadence_len(cadence, final_mode) + (3 if modulates else 0)


def _slot_count(bars: int, per_bar: int) -> int:
    return (bars - 1) * per_bar + 1


def _min_bars(needed: int, per_bar: int) -> int:
    return max(2, -(-(needed - 1) // per_bar) + 1)


def _phrase_seed(seed: int, movement: int, source: str, i: int) -> int:
    return random.Random(f"{seed}:{movement}:{source}:{i}").randrange(2**31)


def _plan_phrases(
    spec: SectionSpec,
    enter: m21key.Key,
    join: str,
    meter: Meter,
    harmonic_rhythm: str,
    seed: int,
    movement: int,
    index: int,
    final: bool,
) -> list[Phrase]:
    source = spec.theme or f"section{index}"
    rng = random.Random(f"{seed}:{movement}:{source}:path")
    moving = spec.waypoints is not None
    targets = list(spec.waypoints) if moving else [spec.key]
    cur = targets[0] if join == "direct" else enter
    # items: ("hop", from, to) or ("stay", key, count)
    items: list[list[Any]] = []
    for w in targets:
        for nxt in key_path(cur, w, rng, spec.avoid):
            items.append(["hop", cur, nxt])
            cur = nxt
        items.append(["stay", w, 0])
    if moving and len(targets) == 1 and items[0][0] == "hop":
        # A retransition lingers in the key it leaves before it heads home.
        items.insert(0, ["stay", items[0][1], 0])
    hops = sum(1 for it in items if it[0] == "hop")
    stays = [it for it in items if it[0] == "stay"]
    last_stay = stays[-1]
    hopped_in = len(items) >= 2 and items[-2][0] == "hop"
    if not moving or not hopped_in:
        last_stay[2] = 1
    target_len = 8 if harmonic_rhythm == "bar" and spec.bars >= 16 else 4
    want = max(1, round(spec.bars / target_len))
    have = hops + sum(it[2] for it in stays)
    extra = max(0, want - have)
    pool = stays[:-1] if moving and len(stays) > 1 else [last_stay]
    i = 0
    while extra > 0:
        pool[i % len(pool)][2] += 1
        extra -= 1
        i += 1

    # The phrases in order, with their cadences.
    flat: list[tuple[m21key.Key, m21key.Key | None]] = []
    for it in items:
        if it[0] == "hop":
            flat.append((it[1], it[2]))
        else:
            flat.extend((it[1], None) for _ in range(it[2]))
    end_cadence = spec.end_cadence or ("half" if moving else "authentic_perfect")
    if final:
        end_cadence = "authentic_perfect"
    cadences: list[str] = []
    inner = 0
    for j, (_, to) in enumerate(flat):
        if j == len(flat) - 1:
            cadences.append(end_cadence)
        elif to is not None and moving:
            # On the way through: the new key, touched without closing.
            cadences.append("authentic_imperfect")
        elif to is not None:
            cadences.append(rng.choice(["authentic_imperfect", "authentic_perfect"]))
        elif flat[j + 1][1] is not None:
            cadences.append(rng.choice(["half", "authentic_imperfect"]))
        else:
            cadences.append("half" if inner % 2 == 0 else "authentic_imperfect")
            inner += 1

    # Bars: as even as the section allows, and never fewer than a phrase needs.
    n = len(flat)
    per_bar = len(pulse_units(meter))
    base, rem = divmod(max(spec.bars, n * 2), n)
    out: list[Phrase] = []
    for j, ((k, to), cad) in enumerate(zip(flat, cadences)):
        bars = base + (1 if j < rem else 0)
        final_mode = (to or k).mode
        needed = _chords_needed(cad, final_mode, to is not None)
        hr = harmonic_rhythm
        if hr == "bar" and bars < needed:
            hr = "pulse"
        if hr == "pulse" and _slot_count(bars, per_bar) < needed:
            bars = _min_bars(needed, per_bar)
        out.append(
            Phrase(
                bars=bars,
                key=k,
                to=to,
                cadence=cad,
                seed=_phrase_seed(seed, movement, source, j),
                harmonic_rhythm=hr,
            )
        )
    return out


def _phrase_slots(grid: MeterGrid, start_bar: int, bars: int, hr: str) -> list[Slot]:
    out: list[Slot] = []
    span = grid.bars(start_bar + bars)[start_bar:]
    for b in span[:-1]:
        if hr == "bar":
            out.append(Slot(b.bar, 1, b.tick, b.ticks, 1.0))
        else:
            for p in b.pulses():
                out.append(Slot(b.bar, p.beat, p.tick, p.ticks, p.accent))
    last = span[-1]
    out.append(Slot(last.bar, 1, last.tick, last.ticks, 1.0))
    return out


def _build_movement(
    index: int,
    title: str,
    form: str,
    tonic: m21key.Key,
    bpm: float,
    marking: str,
    meter: Meter,
    specs: Sequence[SectionSpec],
    harmonic_rhythm: str,
    seed: int,
) -> Movement:
    sections: list[Section] = []
    enter = specs[0].key
    for i, spec in enumerate(specs):
        # "pivot": the section starts somewhere else and its first phrase
        # modulates to its key; "direct": a parallel-mode switch at the double
        # bar; "continue": it starts in the key the music is in.
        join = "start" if i == 0 else spec.join
        if join != "direct" and not same_key(enter, spec.key):
            join = "pivot"
        elif join == "pivot":
            join = "continue"
        phrases = _plan_phrases(
            spec,
            enter,
            "direct" if join in ("direct", "start") else "pivot",
            meter,
            harmonic_rhythm,
            seed,
            index,
            i,
            final=i == len(specs) - 1,
        )
        sec = Section(
            spec=spec,
            index=i,
            enter=enter,
            join=join,
            phrases=phrases,
            bpm=spec.bpm or bpm,
            marking=spec.marking or marking,
        )
        sections.append(sec)
        enter = sec.end_key
    grid = MeterGrid([{"bar": 0, "meter": meter}])
    bar = 0
    for sec in sections:
        sec.start_bar = bar
        for ph in sec.phrases:
            ph.start_bar = bar
            ph.slots = _phrase_slots(grid, bar, ph.bars, ph.harmonic_rhythm)
            ph.chords = build_progression(
                ph.key,
                ph.slots,
                seed=ph.seed,
                cadence=ph.cadence,
                include=(),
                modulate_to=ph.to,
            )
            bar += ph.bars
    return Movement(index, title, form, tonic, bpm, marking, meter, sections, grid)


# ---------------------------------------------------------------------------
# the forms
# ---------------------------------------------------------------------------


def _even(x: float, lo: int = 4) -> int:
    """Bars rounded to an even count, at least ``lo``."""
    return max(lo, 2 * round(x / 2))


def sonata_specs(t: m21key.Key, bars: int, rng: random.Random) -> list[SectionSpec]:
    s = dominant_or_relative(t)
    u = bars / 100
    fg, tr, sg, cl = _even(11 * u), _even(8 * u), _even(13 * u), _even(6 * u)
    dev, rtr, coda = _even(22 * u, 8), _even(4 * u), _even(bars * 0.07)
    # The development: a closely related minor key, then a remote one, then home.
    if t.mode == "major":
        near = [
            _k(t.sharps, "minor"),
            _k(t.sharps - 1, "minor"),
            _k(t.sharps + 1, "minor"),
        ]
    else:
        near = [_k(t.sharps - 1, "minor"), _k(t.sharps + 1, "minor")]
    near = [k for k in near if not same_key(k, s)]
    remote = [
        _k(t.sharps + d, m)
        for d in (-3, -2, 2, 3)
        for m in ("major", "minor")
        if not same_key(_k(t.sharps + d, m), parallel(t))
    ]
    via = [rng.choice(near), rng.choice(remote)]
    return [
        SectionSpec(
            "first_group", "First group", fg, t, theme="first", part="exposition"
        ),
        SectionSpec(
            "transition",
            "Transition",
            tr,
            t,
            waypoints=[t, s],
            theme="transition",
            part="exposition",
        ),
        SectionSpec(
            "second_group", "Second group", sg, s, theme="second", part="exposition"
        ),
        SectionSpec("closing", "Closing", cl, s, theme="closing", part="exposition"),
        SectionSpec(
            "development",
            "Development",
            dev,
            s,
            waypoints=[*via, t],
            theme="development",
            part="development",
            avoid=[t],
        ),
        SectionSpec(
            "first_group", "First group", fg, t, theme="first", part="recapitulation"
        ),
        SectionSpec(
            "transition",
            "Transition",
            rtr,
            t,
            waypoints=[t],
            theme="transition_recap",
            part="recapitulation",
        ),
        SectionSpec(
            "second_group", "Second group", sg, t, theme="second", part="recapitulation"
        ),
        SectionSpec(
            "closing", "Closing", cl, t, theme="closing", part="recapitulation"
        ),
        SectionSpec("coda", "Coda", coda, t, theme="coda", part="coda"),
    ]


def rondo_specs(
    t: m21key.Key, bars: int, pattern: str, rng: random.Random
) -> list[SectionSpec]:
    if pattern not in ("ABACA", "ABACABA"):
        raise PlanError("a rondo is ABACA or ABACABA")
    b_key = dominant_or_relative(t)
    if t.mode == "major":
        c_key = rng.choice([_k(t.sharps, "minor"), _k(t.sharps - 1, "major")])
    else:
        c_key = rng.choice([_k(t.sharps - 1, "minor"), _k(t.sharps - 1, "major")])
    letters = len(pattern)
    retrans = pattern.count("A") - 1 - (1 if pattern == "ABACABA" else 0)
    unit = bars / (letters + 0.5 * retrans)
    a = _even(unit)
    ep = _even(unit)
    link = _even(unit / 2)
    out: list[SectionSpec] = []
    episode = {"B": b_key, "C": c_key}
    for i, ch in enumerate(pattern):
        if ch == "A":
            out.append(SectionSpec("refrain", "A", a, t, theme="A"))
            continue
        last_b = pattern == "ABACABA" and i == 5
        k = t if last_b else episode[ch]
        out.append(
            SectionSpec("episode", ch, ep, k, theme=ch if not last_b else "B_tonic")
        )
        if not same_key(k, t):
            out.append(
                SectionSpec(
                    "retransition",
                    "Retransition",
                    link,
                    k,
                    waypoints=[t],
                    theme=f"R{ch}",
                )
            )
    return out


def variation_specs(t: m21key.Key, bars: int, count: int | None) -> list[SectionSpec]:
    theme_bars = 16 if bars >= 64 else 8
    coda = max(4, theme_bars // 2)
    n = count if count is not None else max(1, round((bars - coda) / theme_bars) - 1)
    out = [SectionSpec("theme", "Theme", theme_bars, t, theme="theme")]
    minore = n - 1 if n >= 3 else None
    for v in range(1, n + 1):
        if v == minore:
            label = "Minore" if t.mode == "major" else "Maggiore"
            out.append(
                SectionSpec(
                    "variation",
                    f"Variation {v} ({label})",
                    theme_bars,
                    parallel(t),
                    theme="theme",
                    join="direct",
                )
            )
        else:
            join = "direct" if minore is not None and v == minore + 1 else "pivot"
            out.append(
                SectionSpec(
                    "variation",
                    f"Variation {v}",
                    theme_bars,
                    t,
                    theme="theme",
                    join=join,
                )
            )
    out.append(SectionSpec("coda", "Coda", coda, t, theme="coda"))
    return out


def minuet_specs(t: m21key.Key, bars: int, kind: str) -> list[SectionSpec]:
    s = dominant_or_relative(t)
    trio_key = subdominant_or_relative(t)
    name = "Minuet" if kind == "minuet" else "Scherzo"
    u = bars / 56
    a, b, trio, link = _even(8 * u), _even(12 * u), _even(16 * u), _even(4 * u)
    return [
        SectionSpec(
            "minuet",
            f"{name}, first reprise",
            a,
            t,
            waypoints=[t, s],
            end_cadence="authentic_perfect",
            theme="a",
        ),
        SectionSpec("minuet", f"{name}, second reprise", b, t, theme="b"),
        SectionSpec("trio", "Trio", trio, trio_key, theme="trio"),
        SectionSpec(
            "retransition", "Link", link, trio_key, waypoints=[t], theme="link"
        ),
        SectionSpec(
            "minuet_da_capo",
            f"{name} da capo, first reprise",
            a,
            t,
            waypoints=[t, s],
            end_cadence="authentic_perfect",
            theme="a",
        ),
        SectionSpec(
            "minuet_da_capo", f"{name} da capo, second reprise", b, t, theme="b"
        ),
    ]


def _meter(num: int, den: int, groups: Sequence[int] = ()) -> Meter:
    m = sanitize_meter({"num": num, "den": den, "groups": list(groups)})
    assert m is not None
    return m


# Standalone defaults: (tempo in quarter notes a minute, marking, meter).
FORM_DEFAULTS: dict[str, tuple[float, str, Meter]] = {
    "sonata": (132.0, "Allegro", _meter(4, 4)),
    "rondo": (138.0, "Allegro", _meter(2, 4)),
    "theme_and_variations": (80.0, "Andante", _meter(2, 4)),
    "minuet_and_trio": (126.0, "Menuetto: Allegretto", _meter(3, 4)),
    "scherzo": (216.0, "Scherzo: Allegro molto", _meter(3, 4)),
}


def _specs_for(
    form: str,
    t: m21key.Key,
    bars: int,
    rng: random.Random,
    rondo: str,
    variations: int | None,
) -> list[SectionSpec]:
    if form == "sonata":
        return sonata_specs(t, bars, rng)
    if form == "rondo":
        return rondo_specs(t, bars, rondo, rng)
    if form == "theme_and_variations":
        return variation_specs(t, bars, variations)
    if form == "minuet_and_trio":
        return minuet_specs(t, bars, "minuet")
    if form == "scherzo":
        return minuet_specs(t, bars, "scherzo")
    raise PlanError(f"form must be one of {', '.join(FORMS)}")


def symphony_movements(
    t: m21key.Key, bars: int | None, rng: random.Random
) -> list[tuple[str, str, m21key.Key, float, str, Meter, int]]:
    """(title, form, key, bpm, marking, meter, bars) for each of the four movements."""
    total = bars or 320
    slow_meter = rng.choice([_meter(2, 4), _meter(3, 8)])
    slow_bpm = 76.0 if slow_meter.den == 4 else 60.0
    if rng.random() < 0.5:
        third = ("Menuetto", "minuet_and_trio", 126.0, "Menuetto: Allegretto")
    else:
        third = ("Scherzo", "scherzo", 208.0, "Scherzo: Allegro molto")
    finale_bpm, finale_marking = rng.choice(
        [(152.0, "Allegro molto"), (176.0, "Presto")]
    )
    finale_meter = rng.choice([_meter(2, 4), _meter(6, 8)])
    return [
        (
            "I. Allegro",
            "sonata",
            t,
            132.0,
            "Allegro",
            _meter(4, 4),
            max(48, round(total * 0.38)),
        ),
        (
            "II. Andante",
            "theme_and_variations",
            subdominant_or_relative(t),
            slow_bpm,
            "Andante",
            slow_meter,
            max(32, round(total * 0.18)),
        ),
        (
            f"III. {third[0]}",
            third[1],
            t,
            third[2],
            third[3],
            _meter(3, 4),
            max(40, round(total * 0.18)),
        ),
        (
            f"IV. {finale_marking}",
            "rondo",
            t,
            finale_bpm,
            finale_marking,
            finale_meter,
            max(48, round(total * 0.26)),
        ),
    ]


def build_form(
    form: str,
    tonic: str,
    mode: str | None = None,
    *,
    seed: int = 0,
    bars: int | None = None,
    meter: Any = None,
    tempo: float | None = None,
    rondo: str = "ABACA",
    variations: int | None = None,
    harmonic_rhythm: str = "bar",
) -> list[Movement]:
    if form not in FORMS:
        raise PlanError(f"form must be one of {', '.join(FORMS)}")
    if harmonic_rhythm not in HARMONIC_RHYTHMS:
        raise PlanError(f"harmonic_rhythm must be one of {', '.join(HARMONIC_RHYTHMS)}")
    if bars is not None and bars < MIN_BARS:
        raise PlanError(f"a form needs at least {MIN_BARS} bars")
    t = parse_key(tonic, mode)
    rng = random.Random(f"{seed}:form")
    if form == "symphony":
        out = []
        for i, (title, f, k, bpm, marking, m, b) in enumerate(
            symphony_movements(t, bars, rng)
        ):
            specs = _specs_for(
                f, k, b, rng, "ABACABA", 3 if f == "theme_and_variations" else None
            )
            out.append(
                _build_movement(
                    i, title, f, k, bpm, marking, m, specs, harmonic_rhythm, seed
                )
            )
        return out
    d_bpm, marking, d_meter = FORM_DEFAULTS[form]
    m = sanitize_meter(meter) if meter is not None else d_meter
    if m is None:
        raise PlanError("meter must be {num, den, groups} with a denominator of 1-32")
    specs = _specs_for(form, t, bars or DEFAULT_BARS[form], rng, rondo, variations)
    title = form.replace("_", " ").capitalize()
    return [
        _build_movement(
            0,
            title,
            form,
            t,
            float(tempo or d_bpm),
            marking,
            m,
            specs,
            harmonic_rhythm,
            seed,
        )
    ]


# ---------------------------------------------------------------------------
# payloads
# ---------------------------------------------------------------------------


def _meter_dict(m: Meter) -> dict[str, Any]:
    return {"num": m.num, "den": m.den, "groups": list(m.groups)}


def _chord_dict(sec: Section, pi: int, slot: Slot, c: PlannedChord) -> dict[str, Any]:
    return {
        "section": sec.index,
        "phrase": pi,
        "bar": slot.bar,
        "beat": slot.beat,
        "tick": slot.tick,
        "ticks": slot.ticks,
        "accent": slot.accent,
        "figure": c.figure,
        "key": key_label(c.key),
        "kind": c.kind,
        "pivot": (
            {"figure": c.pivot[0], "key": key_label(c.pivot[1])} if c.pivot else None
        ),
    }


def _tempo_map(mv: Movement) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for sec in mv.sections:
        if out and out[-1]["bpm"] == sec.bpm and out[-1]["marking"] == sec.marking:
            continue
        tick = mv.grid.bar(sec.start_bar).tick
        out.append(
            {
                "beat": tick / PPQ,
                "bpm": sec.bpm,
                "curve": "step",
                "bar": sec.start_bar,
                "tick": tick,
                "marking": sec.marking,
            }
        )
    return out


def _section_dict(mv: Movement, sec: Section) -> dict[str, Any]:
    start = mv.grid.bar(sec.start_bar).tick
    end = mv.grid.bar(sec.start_bar + sec.bars).tick
    chords = [
        _chord_dict(sec, pi, s, c)
        for pi, ph in enumerate(sec.phrases)
        for s, c in zip(ph.slots, ph.chords)
    ]
    return {
        "index": sec.index,
        "role": sec.spec.role,
        "label": sec.spec.label,
        "part": sec.spec.part,
        "theme": sec.spec.theme,
        "bars": sec.bars,
        "start_bar": sec.start_bar,
        "start_tick": start,
        "ticks": end - start,
        "key": key_label(sec.spec.key),
        "enter_key": key_label(sec.enter),
        "end_key": key_label(sec.end_key),
        "join": sec.join,
        "tempo": {"bpm": sec.bpm, "marking": sec.marking},
        "meter": _meter_dict(mv.meter),
        "phrases": [
            {
                "bars": ph.bars,
                "start_bar": ph.start_bar,
                "key": key_label(ph.key),
                "modulate_to": key_label(ph.to) if ph.to else None,
                "cadence": ph.cadence,
                "harmonic_rhythm": ph.harmonic_rhythm,
                "seed": ph.seed,
            }
            for ph in sec.phrases
        ],
        "chords": chords,
    }


def _movement_dict(mv: Movement) -> dict[str, Any]:
    return {
        "index": mv.index,
        "title": mv.title,
        "form": mv.form,
        "key": key_label(mv.key),
        "tempo": {"bpm": mv.bpm, "marking": mv.marking},
        "meter": _meter_dict(mv.meter),
        "bars": mv.bars,
        "ticks": mv.grid.bar(mv.bars).tick,
        "meter_map": [{"bar": 0, "meter": _meter_dict(mv.meter)}],
        "tempo_map": _tempo_map(mv),
        "sections": [_section_dict(mv, s) for s in mv.sections],
    }


def _payload(
    form: str, movements: Sequence[Movement], seed: int, hr: str
) -> dict[str, Any]:
    return {
        "form": form,
        "key": key_label(movements[0].key),
        "seed": seed,
        "ppq": PPQ,
        "harmonic_rhythm": hr,
        "bars": sum(m.bars for m in movements),
        "movements": [_movement_dict(m) for m in movements],
    }


def plan_form(
    form: str, tonic: str, mode: str | None = None, **opts: Any
) -> dict[str, Any]:
    """The form's movements and sections with their harmonic plans, unvoiced."""
    movements = build_form(form, tonic, mode, **opts)
    return _payload(
        form, movements, int(opts.get("seed", 0)), opts.get("harmonic_rhythm", "bar")
    )


# ---------------------------------------------------------------------------
# voicing
# ---------------------------------------------------------------------------


SOPRANO_AT_CADENCE = {"authentic_perfect": "tonic", "authentic_imperfect": "not_tonic"}


def _voice_section(
    sec: Section,
    grid: MeterGrid,
    rl: list[tuple[int, int]],
    anchor: tuple[PlannedChord, int, tuple[int, ...]] | None,
) -> tuple[list[tuple[int, ...]], list[Any]]:
    chords: list[PlannedChord] = []
    ticks: list[int] = []
    sop: list[str | None] = []
    for ph in sec.phrases:
        for j, (s, c) in enumerate(zip(ph.slots, ph.chords)):
            chords.append(c)
            ticks.append(s.tick)
            sop.append(
                SOPRANO_AT_CADENCE.get(ph.cadence) if j == len(ph.chords) - 1 else None
            )
    cands = [candidates(c, rl, sp) for c, sp in zip(chords, sop)]
    ranges = dict(zip(SATB, rl))
    harmonies = [c.harmony for c in chords]
    if anchor is not None:
        a_chord, a_tick, a_voicing = anchor
        a_cands = candidates(a_chord, rl, None)
        keep = np.all(a_cands.voicings == np.array(a_voicing), axis=1)
        if keep.any():
            a_cands.voicings = a_cands.voicings[keep]
            a_cands.unary = a_cands.unary[keep] * 0
            a_cands.letters = a_cands.letters[keep]
            try:
                voicings, flags = search_voicings(
                    [a_cands, *cands],
                    [a_chord.harmony, *harmonies],
                    [a_tick, *ticks],
                    grid,
                    ranges,
                )
                if not flags:
                    return voicings[1:], []
            except PlanError:
                pass
    return search_voicings(cands, harmonies, ticks, grid, ranges)


def realize_form(
    form: str,
    tonic: str,
    mode: str | None = None,
    *,
    ranges: Mapping[str, Sequence[int]] | None = None,
    **opts: Any,
) -> dict[str, Any]:
    """The plan, with every chord voiced in SATB and each section's parts and flags."""
    movements = build_form(form, tonic, mode, **opts)
    payload = _payload(
        form, movements, int(opts.get("seed", 0)), opts.get("harmonic_rhythm", "bar")
    )
    rl = range_list(ranges)
    total_flags = 0
    for mv, mv_out in zip(movements, payload["movements"]):
        anchor: tuple[PlannedChord, int, tuple[int, ...]] | None = None
        for sec, sec_out in zip(mv.sections, mv_out["sections"]):
            voicings, flags = _voice_section(sec, mv.grid, rl, anchor)
            parts: dict[str, list[dict[str, int]]] = {p: [] for p in SATB}
            chords = [c for ph in sec.phrases for c in ph.chords]
            for c_out, c, v in zip(sec_out["chords"], chords, voicings):
                spell = c.harmony.spell
                c_out["pitches"] = dict(zip(SATB, v))
                c_out["names"] = dict(zip(SATB, (name_of(m, spell) for m in v)))
                for part, m in zip(SATB, v):
                    parts[part].append(
                        {
                            "note": m,
                            "tick": c_out["tick"],
                            "ticks": c_out["ticks"],
                            "velocity": VELOCITY,
                        }
                    )
            sec_out["parts"] = parts
            sec_out["flags"] = [f.as_dict() for f in flags]
            total_flags += len(flags)
            if chords:
                anchor = (chords[-1], sec_out["chords"][-1]["tick"], voicings[-1])
    payload["flag_count"] = total_flags
    return payload
