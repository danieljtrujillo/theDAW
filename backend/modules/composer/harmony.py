"""Harmony planner: roman-numeral progressions voiced in four parts.

``plan_progression`` writes a phrase in a key for a number of bars and voices
it for soprano, alto, tenor and bass so that the voice-leading checker
(voiceleading.py) has nothing to flag.

The phrase opens on the tonic and closes with one of six cadences:

* ``authentic_perfect``: ii6 - I6/4 - V - I, root positions, soprano on 1.
* ``authentic_imperfect``: IV - V - I, soprano off the tonic.
* ``half``: ii6 - V.
* ``plagal``: V - I - IV - I.
* ``deceptive``: ii6 - V7 - vi (VI in minor).
* ``phrygian_half``: i - iv6 - V (iv6 borrowed from minor in a major key).

Between them it walks tonic, predominant and dominant chords, and puts in the
chords the caller asks for with ``include``: ``seventh`` (ii6/5 - V7),
``applied`` (V7/V - V), ``neapolitan`` (N6 - V), ``italian`` (It6 - V),
``french`` (Fr4/3 - V) and ``german`` (Ger6/5 - I6/4 - V, so the fifths of
the German sixth never move in parallel). In minor the dominant is the
harmonic-minor V with the raised leading tone. ``modulate_to`` moves to a
closely related key through a pivot chord that is diatonic in both keys, then
confirms the new key with V7 - I and cadences there.

Chords sit on the pulses of the meter map (meter.py): the group starts of an
additive bar, the dotted beats of a compound one, the beats of a simple one;
with ``harmonic_rhythm="bar"`` one chord fills each bar. The final chord
fills the last bar. A cadential six-four lands on a pulse at least as strong
as the V after it, or the cadence uses IV - ii6 - V instead.

Everything is drawn from ``random.Random(seed)``, so a seed gives the same
phrase every time.

The voicing is a Viterbi search over every SATB voicing of every chord that
is in range, in order, spaced within an octave above the tenor, complete
(a fifth may be left out) and never doubles a leading tone, a chordal seventh
or an augmented-sixth tendency tone. Moves that break a motion or
tendency rule are forbidden; the rest cost their motion, with leaps, tritones
and augmented seconds costing more. The answer goes through the checker, and
any move it flags is forbidden before searching again.
"""

from __future__ import annotations

import random
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, Mapping, Sequence

import numpy as np
from music21 import key as m21key
from music21 import roman

from .meter import MeterGrid
from .spec import CADENCES, FEATURES, HARMONIC_RHYTHMS, PPQ, SATB
from .voiceleading import (
    Harmony,
    Slice,
    check_slices,
    harmony_from_roman,
    is_aug6,
    key_label,
    name_of,
    parse_key,
    resolve_ranges,
    transition_forbidden,
)

__all__ = ["CADENCES", "FEATURES", "HARMONIC_RHYTHMS", "PlanError", "plan_progression"]

LETTERS = "CDEFGAB"
VELOCITY = 80

# (figure, kind) units, by mode.
FEATURE_UNITS: dict[str, dict[str, list[tuple[str, str]]]] = {
    "major": {
        "seventh": [("ii65", "seventh"), ("V7", "seventh"), ("I", "diatonic")],
        "applied": [("V7/V", "applied_dominant"), ("V", "diatonic"), ("I", "diatonic")],
        "neapolitan": [("N6", "neapolitan"), ("V", "diatonic"), ("I", "diatonic")],
        "italian": [("It6", "italian_sixth"), ("V", "diatonic"), ("I", "diatonic")],
        "french": [("Fr43", "french_sixth"), ("V", "diatonic"), ("I", "diatonic")],
        "german": [
            ("Ger65", "german_sixth"),
            ("I64", "cadential_64"),
            ("V", "diatonic"),
            ("I", "diatonic"),
        ],
    },
    "minor": {
        "seventh": [("iiø65", "seventh"), ("V7", "seventh"), ("i", "diatonic")],
        "applied": [("V7/V", "applied_dominant"), ("V", "diatonic"), ("i", "diatonic")],
        "neapolitan": [("N6", "neapolitan"), ("V", "diatonic"), ("i", "diatonic")],
        "italian": [("It6", "italian_sixth"), ("V", "diatonic"), ("i", "diatonic")],
        "french": [("Fr43", "french_sixth"), ("V", "diatonic"), ("i", "diatonic")],
        "german": [
            ("Ger65", "german_sixth"),
            ("i64", "cadential_64"),
            ("V", "diatonic"),
            ("i", "diatonic"),
        ],
    },
}

CADENCE_UNITS: dict[str, dict[str, list[tuple[str, str]]]] = {
    "major": {
        "authentic_perfect": [
            ("ii6", "diatonic"),
            ("I64", "cadential_64"),
            ("V", "diatonic"),
            ("I", "diatonic"),
        ],
        "authentic_imperfect": [
            ("IV", "diatonic"),
            ("V", "diatonic"),
            ("I", "diatonic"),
        ],
        "half": [("ii6", "diatonic"), ("V", "diatonic")],
        "plagal": [
            ("V", "diatonic"),
            ("I", "diatonic"),
            ("IV", "diatonic"),
            ("I", "diatonic"),
        ],
        "deceptive": [("ii6", "diatonic"), ("V7", "seventh"), ("vi", "diatonic")],
        "phrygian_half": [("I", "diatonic"), ("iv6", "mixture"), ("V", "diatonic")],
    },
    "minor": {
        "authentic_perfect": [
            ("iio6", "diatonic"),
            ("i64", "cadential_64"),
            ("V", "diatonic"),
            ("i", "diatonic"),
        ],
        "authentic_imperfect": [
            ("iv", "diatonic"),
            ("V", "diatonic"),
            ("i", "diatonic"),
        ],
        "half": [("iio6", "diatonic"), ("V", "diatonic")],
        "plagal": [
            ("V", "diatonic"),
            ("i", "diatonic"),
            ("iv", "diatonic"),
            ("i", "diatonic"),
        ],
        "deceptive": [("iio6", "diatonic"), ("V", "diatonic"), ("VI", "diatonic")],
        "phrygian_half": [("i", "diatonic"), ("iv6", "diatonic"), ("V", "diatonic")],
    },
}

# Without a cadential six-four, for a meter that would put it on a weak pulse.
CADENCE_NO_64 = {
    "major": [("IV", "diatonic"), ("ii6", "diatonic"), ("V", "diatonic")],
    "minor": [("iv", "diatonic"), ("iio6", "diatonic"), ("V", "diatonic")],
}

# Tonic-to-tonic walks the filler strings together; each ends on a tonic-family chord.
FILLER_UNITS: dict[str, list[list[str]]] = {
    "major": [
        ["I6"],
        ["vi"],
        ["V6", "I"],
        ["IV", "I"],
        ["viio6", "I6"],
        ["IV", "V", "I"],
        ["ii6", "V", "I"],
        ["ii", "V", "I"],
        ["IV", "V7", "I"],
        ["vi", "ii6", "V", "I"],
        ["vi", "IV", "V", "I"],
        ["I6", "ii6", "V7", "I"],
    ],
    "minor": [
        ["i6"],
        ["VI"],
        ["V6", "i"],
        ["iv", "i"],
        ["viio6", "i6"],
        ["iv", "V", "i"],
        ["iio6", "V", "i"],
        ["iv6", "V", "i"],
        ["iv", "V7", "i"],
        ["VI", "iio6", "V", "i"],
        ["VI", "iv", "V", "i"],
        ["i6", "iio6", "V7", "i"],
    ],
}

# Pivot readings in the new key, most useful first (predominants lead on).
PIVOT_PREFERENCE = ["ii", "IV", "iv", "vi", "VI", "iio", "I", "i", "iii", "III"]
DIATONIC_TRIADS = {
    "major": ["I", "ii", "iii", "IV", "V", "vi"],
    "minor": ["i", "iio", "III", "iv", "V", "VI"],
}


class PlanError(ValueError):
    """The request cannot be planned (too few bars, an unknown chord kind...)."""


@dataclass
class Slot:
    bar: int
    beat: int
    tick: int
    ticks: int
    accent: float


@dataclass
class PlannedChord:
    figure: str
    key: m21key.Key
    kind: str
    pivot: tuple[str, m21key.Key] | None = None
    rn: roman.RomanNumeral = field(init=False)
    harmony: Harmony = field(init=False)

    def __post_init__(self) -> None:
        self.rn = roman.RomanNumeral(self.figure, self.key)
        self.harmony = harmony_from_roman(self.rn)


# ---------------------------------------------------------------------------
# the progression
# ---------------------------------------------------------------------------


def _slots(grid: MeterGrid, bars: int, harmonic_rhythm: str) -> list[Slot]:
    out: list[Slot] = []
    all_bars = grid.bars(bars)
    for b in all_bars[:-1]:
        if harmonic_rhythm == "bar":
            out.append(Slot(b.bar, 1, b.tick, b.ticks, 1.0))
        else:
            for p in b.pulses():
                out.append(Slot(b.bar, p.beat, p.tick, p.ticks, p.accent))
    last = all_bars[-1]
    out.append(Slot(last.bar, 1, last.tick, last.ticks, 1.0))
    return out


def _fill(size: int, mode: str, rng: random.Random, after: str | None) -> list[str]:
    out: list[str] = []
    last = after
    while len(out) < size:
        left = size - len(out)
        units = [u for u in FILLER_UNITS[mode] if len(u) <= left and u[0] != last]
        if not units:
            units = [u for u in FILLER_UNITS[mode] if len(u) <= left]
        # Longer walks read as phrases; weigh them up.
        unit = rng.choices(units, weights=[len(u) for u in units])[0]
        out.extend(unit)
        last = unit[-1]
    return out


def _split(total: int, parts: int, rng: random.Random) -> list[int]:
    if parts <= 1:
        return [total]
    cuts = sorted(rng.randint(0, total) for _ in range(parts - 1))
    edges = [0, *cuts, total]
    return [b - a for a, b in zip(edges, edges[1:])]


def closely_related(a: m21key.Key, b: m21key.Key) -> bool:
    same = a.tonic.pitchClass == b.tonic.pitchClass and a.mode == b.mode
    return not same and abs(a.sharps - b.sharps) <= 1


def find_pivot(a: m21key.Key, b: m21key.Key) -> tuple[str, str]:
    """(figure in ``a``, figure in ``b``) of a triad diatonic to both keys."""
    old = {
        fig: frozenset(p.pitchClass for p in roman.RomanNumeral(fig, a).pitches)
        for fig in DIATONIC_TRIADS[a.mode]
        if fig != "V" or a.mode == "major"
    }
    new_figs = [f for f in DIATONIC_TRIADS[b.mode] if f != "V"]
    new = {
        fig: frozenset(p.pitchClass for p in roman.RomanNumeral(fig, b).pitches)
        for fig in new_figs
    }
    for want in PIVOT_PREFERENCE:
        if want not in new:
            continue
        for fig, pcs in old.items():
            if pcs == new[want] and fig not in ("I", "i"):
                return fig, want
    raise PlanError(f"no pivot chord between {key_label(a)} and {key_label(b)}")


def build_progression(
    home: m21key.Key,
    slots: Sequence[Slot],
    *,
    seed: int,
    cadence: str,
    include: Sequence[str],
    modulate_to: m21key.Key | None,
) -> list[PlannedChord]:
    rng = random.Random(seed)
    if cadence not in CADENCES:
        raise PlanError(f"cadence must be one of {', '.join(CADENCES)}")
    unknown = [f for f in include if f not in FEATURES]
    if unknown:
        raise PlanError(f"unknown chord kinds {unknown}; use {', '.join(FEATURES)}")
    final_key = modulate_to or home
    if modulate_to is not None and not closely_related(home, modulate_to):
        raise PlanError(
            f"{key_label(modulate_to)} is not closely related to {key_label(home)}"
        )
    features = list(dict.fromkeys(include))
    rng.shuffle(features)
    units = [FEATURE_UNITS[home.mode][f] for f in features]
    cad = list(CADENCE_UNITS[final_key.mode][cadence])
    tonic = "I" if home.mode == "major" else "i"
    fixed = 1 + sum(len(u) for u in units) + len(cad)
    pivot: tuple[str, str] | None = None
    if modulate_to is not None:
        pivot = find_pivot(home, modulate_to)
        fixed += 3
    total = len(slots)
    if fixed > total:
        raise PlanError(
            f"this plan needs {fixed} chords and the bars hold {total}; "
            "ask for more bars or a faster harmonic rhythm"
        )
    free = total - fixed

    out: list[PlannedChord] = [PlannedChord(tonic, home, "diatonic")]
    home_free = free if modulate_to is None else free // 2
    chunks = _split(home_free, len(units) + 1, rng)
    for i, chunk in enumerate(chunks):
        after = out[-1].figure
        for fig in _fill(chunk, home.mode, rng, after):
            out.append(PlannedChord(fig, home, "diatonic"))
        if i < len(units):
            for fig, kind in units[i]:
                out.append(PlannedChord(fig, home, kind))
    if modulate_to is not None and pivot is not None:
        old_fig, new_fig = pivot
        out.append(PlannedChord(old_fig, home, "pivot", (new_fig, modulate_to)))
        new_tonic = "I" if modulate_to.mode == "major" else "i"
        out.append(PlannedChord("V7", modulate_to, "seventh"))
        out.append(PlannedChord(new_tonic, modulate_to, "diatonic"))
        for fig in _fill(free - home_free, modulate_to.mode, rng, new_tonic):
            out.append(PlannedChord(fig, modulate_to, "diatonic"))
    # A cadential six-four belongs on a pulse at least as strong as its V.
    cad_start = len(out)
    for j, (fig, kind) in enumerate(cad):
        if kind == "cadential_64" and j + 1 < len(cad):
            here = slots[cad_start + j].accent
            nxt = slots[cad_start + j + 1].accent
            if here < nxt:
                cad = CADENCE_NO_64[final_key.mode] + cad[j + 2 :]
            break
    for fig, kind in cad:
        out.append(PlannedChord(fig, final_key, kind))
    assert len(out) == total
    return out


# ---------------------------------------------------------------------------
# voicing
# ---------------------------------------------------------------------------


@dataclass
class Candidates:
    voicings: np.ndarray  # (n, 4) top voice first
    unary: np.ndarray  # (n,)
    letters: np.ndarray  # (n, 4) letter index 0-6 of each voice's spelling


def _no_double(c: PlannedChord) -> set[int]:
    h = c.harmony
    out: set[int] = set()
    if h.lt_pc is not None:
        out.add(h.lt_pc)
    if h.seventh_pc is not None:
        out.add(h.seventh_pc)
    if h.major_like and h.chromatic_third and h.third_pc is not None:
        out.add(h.third_pc)
    if is_aug6(c.figure):
        tonic = c.key.tonic.pitchClass
        out |= {pc for pc in h.pcs if pc != tonic}
    return out


def candidates(
    c: PlannedChord,
    ranges: Sequence[tuple[int, int]],
    soprano: str | None = None,
) -> Candidates:
    h = c.harmony
    pcs = sorted(h.pcs)
    bass_pc = c.rn.bass().pitchClass
    root = h.root_pc
    fifth = h.fifth_pc
    third = h.third_pc
    aug6 = is_aug6(c.figure)
    no_double = _no_double(c)
    neapolitan = c.figure.startswith("N")
    tonic = c.key.tonic.pitchClass
    spell = h.spell

    def opts(lo: int, hi: int) -> list[int]:
        return [m for m in range(lo, hi + 1) if m % 12 in h.pcs]

    (s_lo, s_hi), (a_lo, a_hi), (t_lo, t_hi), (b_lo, b_hi) = ranges
    basses = [m for m in range(b_lo, b_hi + 1) if m % 12 == bass_pc]
    centers = [(lo + hi) / 2 for lo, hi in ranges]
    rows: list[tuple[int, int, int, int]] = []
    costs: list[float] = []
    for s in opts(s_lo, s_hi):
        if soprano == "tonic" and s % 12 != tonic:
            continue
        if soprano == "not_tonic" and s % 12 == tonic:
            continue
        for a in opts(a_lo, a_hi):
            if not (a < s and s - a <= 12):
                continue
            for t in opts(t_lo, t_hi):
                if not (t < a and a - t <= 12):
                    continue
                for b in basses:
                    if b >= t:
                        continue
                    counts = Counter(m % 12 for m in (s, a, t, b))
                    missing = [pc for pc in pcs if pc not in counts]
                    cost = 0.0
                    if missing:
                        if aug6 or missing != [fifth] or fifth == bass_pc:
                            continue
                        if root is None or counts[root] < 2:
                            continue
                        cost += 2.0 if len(pcs) >= 4 else 5.0
                    bad = False
                    for pc, k in counts.items():
                        if k < 2:
                            continue
                        if pc in no_double:
                            bad = True
                            break
                        if aug6 and pc == tonic:
                            continue
                        if neapolitan and pc == bass_pc:
                            continue
                        if pc == root:
                            cost += 0.0
                        elif pc == fifth:
                            cost += 1.0
                        elif pc == third:
                            cost += 3.0
                        else:
                            cost += 4.0
                        if k >= 3 and not missing:
                            cost += 3.0
                    if bad:
                        continue
                    if soprano == "not_tonic" and third is not None and s % 12 != third:
                        cost += 1.0
                    cost += 0.02 * sum(
                        abs(m - ctr) for m, ctr in zip((s, a, t, b), centers)
                    )
                    rows.append((s, a, t, b))
                    costs.append(cost)
    if not rows:
        raise PlanError(f"no four-part voicing of {c.figure} in {key_label(c.key)}")
    arr = np.array(rows, dtype=np.int64)
    letters = np.array(
        [[LETTERS.index(spell.get(m % 12, "C")[0]) for m in row] for row in rows],
        dtype=np.int64,
    )
    return Candidates(arr, np.array(costs, dtype=float), letters)


def transition_cost(a: Candidates, b: Candidates) -> np.ndarray:
    M = b.voicings[None, :, :] - a.voicings[:, None, :]
    A = np.abs(M)
    cost = A[:, :, :3].sum(-1) + 0.5 * A[:, :, 3]
    cost += 1.5 * np.maximum(A[:, :, :3] - 4, 0).sum(-1)
    cost += 0.5 * np.maximum(A[:, :, 0] - 2, 0)
    cost += 6.0 * (A == 6).sum(-1)
    step = (b.letters[None, :, :] - a.letters[:, None, :]) % 7
    cost += 8.0 * ((A == 3) & ((step == 1) | (step == 6))).sum(-1)
    too_far = (A[:, :, :3] > 9).any(-1) | (A[:, :, 3] > 12)
    cost[too_far] = np.inf
    return cost


def viterbi(
    cands: Sequence[Candidates],
    harmonies: Sequence[Harmony | None],
    banned: set[tuple[int, int, int]] | None = None,
    allowed: Sequence[np.ndarray | None] | None = None,
) -> list[int]:
    """Index of the cheapest candidate per chord such that no move breaks a
    rule. ``banned`` holds (chord index, previous candidate, candidate) moves
    to leave out; ``allowed[i - 1]``, when given, marks the moves into chord
    ``i`` that another rule set (music21's realizer) accepts."""
    banned = banned or set()
    acc = cands[0].unary.copy()
    back: list[np.ndarray] = []
    for i in range(1, len(cands)):
        a, b = cands[i - 1], cands[i]
        cost = transition_cost(a, b)
        cost[
            transition_forbidden(a.voicings, b.voicings, harmonies[i - 1], harmonies[i])
        ] = np.inf
        if allowed is not None and allowed[i - 1] is not None:
            cost[~allowed[i - 1]] = np.inf
        for bi, ia, ib in banned:
            if bi == i:
                cost[ia, ib] = np.inf
        total = acc[:, None] + cost
        arg = total.argmin(0)
        back.append(arg)
        acc = total[arg, np.arange(total.shape[1])] + b.unary
    if not np.isfinite(acc).any():
        raise PlanError("no voicing of this progression passes the voice-leading rules")
    idx = [int(acc.argmin())]
    for arg in reversed(back):
        idx.append(int(arg[idx[-1]]))
    idx.reverse()
    return idx


def search_voicings(
    cands: Sequence[Candidates],
    harmonies: Sequence[Harmony | None],
    ticks: Sequence[int],
    grid: MeterGrid,
    ranges: Mapping[str, tuple[int, int]],
    allowed: Sequence[np.ndarray | None] | None = None,
    key_spell: Mapping[int, str] | None = None,
) -> tuple[list[tuple[int, ...]], list[Any]]:
    """Viterbi, then the checker; a move the checker flags is left out and the
    search runs again. Returns the voicings and the flags of the last try
    (empty when it passed)."""
    banned: set[tuple[int, int, int]] = set()
    voicings: list[tuple[int, ...]] = []
    flags: list[Any] = []
    by_tick = {t: i for i, t in enumerate(ticks)}
    for _ in range(40):
        idx = viterbi(cands, harmonies, banned, allowed)
        voicings = [
            tuple(int(x) for x in cands[i].voicings[j]) for i, j in enumerate(idx)
        ]
        slices = [Slice(t, v, h) for t, v, h in zip(ticks, voicings, harmonies)]
        flags = check_slices(slices, SATB, ranges, grid, key_spell)
        if not flags:
            return voicings, []
        before = len(banned)
        for f in flags:
            i = by_tick.get(f.tick)
            if i is None:
                continue
            # A tendency flag sits on the chord that holds the tone; the move
            # it is about is the one after it.
            if f.rule.startswith("unresolved") and i + 1 < len(idx):
                i += 1
            if i >= 1:
                banned.add((i, idx[i - 1], idx[i]))
        if len(banned) == before:
            break
    return voicings, flags


# ---------------------------------------------------------------------------
# the plan
# ---------------------------------------------------------------------------


def range_list(ranges: Mapping[str, Sequence[int]] | None) -> list[tuple[int, int]]:
    r = resolve_ranges(SATB, ranges)
    return [r[p] for p in SATB]


def realize(
    chords: Sequence[PlannedChord],
    slots: Sequence[Slot],
    grid: MeterGrid,
    ranges: Mapping[str, Sequence[int]] | None,
    final_soprano: str | None,
) -> tuple[list[tuple[int, ...]], list[Any]]:
    """Voice the chords; return the voicings and the checker's flags (empty
    unless no voicing passes)."""
    rl = range_list(ranges)
    cands = [
        candidates(c, rl, final_soprano if i == len(chords) - 1 else None)
        for i, c in enumerate(chords)
    ]
    return search_voicings(
        cands,
        [c.harmony for c in chords],
        [s.tick for s in slots],
        grid,
        dict(zip(SATB, rl)),
    )


def plan_progression(
    tonic: str,
    mode: str | None = None,
    *,
    bars: int = 8,
    meter_map: Sequence[Any] | None = None,
    seed: int = 0,
    cadence: str = "authentic_perfect",
    include: Sequence[str] = (),
    modulate_to: str | None = None,
    harmonic_rhythm: str = "pulse",
    ranges: Mapping[str, Sequence[int]] | None = None,
) -> dict[str, Any]:
    if bars < 2:
        raise PlanError("a phrase needs at least two bars")
    if harmonic_rhythm not in HARMONIC_RHYTHMS:
        raise PlanError(f"harmonic_rhythm must be one of {', '.join(HARMONIC_RHYTHMS)}")
    home = parse_key(tonic, mode)
    target = parse_key(modulate_to) if modulate_to else None
    grid = MeterGrid(meter_map)
    slots = _slots(grid, bars, harmonic_rhythm)
    chords = build_progression(
        home,
        slots,
        seed=seed,
        cadence=cadence,
        include=include,
        modulate_to=target,
    )
    final_soprano = {
        "authentic_perfect": "tonic",
        "authentic_imperfect": "not_tonic",
    }.get(cadence)
    voicings, flags = realize(chords, slots, grid, ranges, final_soprano)
    return plan_payload(home, bars, seed, cadence, grid, slots, chords, voicings, flags)


def plan_payload(
    home: m21key.Key,
    bars: int,
    seed: int,
    cadence: str,
    grid: MeterGrid,
    slots: Sequence[Slot],
    chords: Sequence[PlannedChord],
    voicings: Sequence[tuple[int, ...]],
    flags: Sequence[Any],
) -> dict[str, Any]:
    out_chords = []
    parts: dict[str, list[dict[str, int]]] = {p: [] for p in SATB}
    for i, (s, c, v) in enumerate(zip(slots, chords, voicings)):
        spell = c.harmony.spell
        out_chords.append(
            {
                "index": i,
                "bar": s.bar,
                "beat": s.beat,
                "tick": s.tick,
                "ticks": s.ticks,
                "accent": s.accent,
                "figure": c.figure,
                "key": key_label(c.key),
                "kind": c.kind,
                "pivot": (
                    {"figure": c.pivot[0], "key": key_label(c.pivot[1])}
                    if c.pivot
                    else None
                ),
                "pitches": dict(zip(SATB, v)),
                "names": dict(zip(SATB, (name_of(m, spell) for m in v))),
            }
        )
        for part, m in zip(SATB, v):
            parts[part].append(
                {"note": m, "tick": s.tick, "ticks": s.ticks, "velocity": VELOCITY}
            )
    return {
        "key": key_label(home),
        "final_key": key_label(chords[-1].key),
        "bars": bars,
        "seed": seed,
        "cadence": cadence,
        "ppq": PPQ,
        "meter_map": [
            {
                "bar": b,
                "meter": {"num": m.num, "den": m.den, "groups": list(m.groups)},
            }
            for b, m in grid.segments
        ],
        "chords": out_chords,
        "parts": parts,
        "flags": [f.as_dict() for f in flags],
    }
