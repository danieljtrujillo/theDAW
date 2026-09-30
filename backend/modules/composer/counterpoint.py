"""Species counterpoint, invertible counterpoint, and the line search that the
canon and fugue builders share.

Notes are ``{note, tick, ticks}`` at 960 ticks to the quarter; a bar is a
4/4 bar of 3840 ticks, the whole note of the species.

**Intervals.** Every pitch gets a diatonic degree in its key or mode, spelled
as a major or minor key spells it (the flat second, the minor or major third,
the raised fourth, the minor or major sixth and seventh), so an interval has
a generic size as well as a semitone size. Consonant: unisons and octaves, thirds, perfect fifths, sixths.
The perfect fourth, the augmented fourth and the diminished fifth are
consonant only between two upper voices when three or more sound; against the
lowest voice, or in two voices, they are dissonant, as are seconds, sevenths
and every augmented or diminished interval.

**Lines.** A melodic move is a step (a second of one or two semitones), a
third, a perfect fourth, a perfect fifth, a rising minor sixth or an octave.
After a leap larger than a fourth the line turns back; two leaps in one
direction are allowed only when both are thirds; the line spans at most a
tenth; a raised leading tone goes up to its tonic, a raised sixth up to the
raised seventh.

**Dissonance.** A dissonant slice is allowed only as

* a passing tone (stepped into and out of in one direction) or a neighbour
  tone (stepped into and back) in the voice that attacks it, while the other
  voice holds, on a metric position the rules allow;
* a suspension: the voice that holds was consonant where it came in (the
  preparation), the other voice attacks the dissonance on a strong beat, and
  the held voice then falls a step to a consonance. Above, 7-6, 4-3 and 9-8;
  below, 2-3.

**Motion.** No parallel fifths, octaves or unisons (antiparallel ones too);
in two voices no similar motion into a perfect interval at all, and in more
voices no similar motion into one between the outer voices with a leap in the
top voice; no crossing and no overlap. These are the four-part checker's own
motion rules (voiceleading.py), and every finished line also goes through
``check_slices`` there.

**Species.** ``species_counterpoint`` writes a line above or below a cantus
firmus of whole notes:

1. note against note: every note consonant;
2. two half notes a bar: the second may be a passing tone; the penultimate
   bar may hold a whole note, as Fux allows, when the halves cannot close;
3. four quarters a bar: passing tones on beats 2 to 4, neighbour tones on 2
   and 4;
4. syncopation: a half-note rest, then half notes tied over each bar line,
   so every downbeat holds either a consonant tie or a prepared suspension
   resolved down by step; a tie is broken (at most twice) only where neither
   works, and a line with at least one suspension is preferred;
5. florid: a seeded rhythm per bar mixing the others, with eighth pairs
   (moving by step) and tied suspensions.

Each opens on a perfect consonance (unison, fifth or octave above; unison or
octave below), closes with the clausula (a major sixth widening to the octave
or a minor third closing to the unison, the voices moving by contrary step,
the raised sixth and seventh of musica ficta allowed in the penultimate bar),
keeps its highest note to a single climax, has no unison inside the line on
a strong beat, no fifths or octaves on consecutive downbeats unless a leap of
a fourth or more comes between them (consecutive offbeats in the fourth
species) and, in the first species, at most three parallel thirds or sixths
in a row.

The search is a seeded depth-first search: candidates for each note are cut
back from the cadence (each must reach a candidate of the next note), ordered
by a style cost plus seeded jitter, every rule is checked as soon as the
notes it needs exist, and a partial line that breaks one is abandoned, so the
answer has no violations. The search restarts with fresh jitter a few times
before it gives up. ``check_species`` runs the same rules over a
line someone wrote and lists every violation.

**Invertible counterpoint** at the octave, tenth or twelfth: the lower voice
moves up by that interval (diatonically, keeping any accidental), which turns
every interval ``x`` into ``n + 1 - x``. ``invertible_check`` checks both the
pair and its inversion; ``species_counterpoint(invertible=n)`` only accepts
lines whose inversion is also clean (the opening and closing formulas apply
to the written pair).
"""

from __future__ import annotations

import random
from bisect import bisect_left, bisect_right
from dataclasses import dataclass
from itertools import combinations
from typing import Any, Callable, Mapping, Sequence

from .meter import MeterGrid
from .spec import CANTUS_FIRMI, INVERTIBLE_AT, MODES, PPQ, SPECIES
from .voiceleading import Flag, check_slices, slices_from_parts

BAR = 4 * PPQ
HALF = 2 * PPQ
EIGHTH = PPQ // 2
VELOCITY = 80

SCALE_STEPS: dict[str, tuple[int, ...]] = {
    "ionian": (0, 2, 4, 5, 7, 9, 11),
    "dorian": (0, 2, 3, 5, 7, 9, 10),
    "phrygian": (0, 1, 3, 5, 7, 8, 10),
    "lydian": (0, 2, 4, 6, 7, 9, 11),
    "mixolydian": (0, 2, 4, 5, 7, 9, 10),
    "aeolian": (0, 2, 3, 5, 7, 8, 10),
    "major": (0, 2, 4, 5, 7, 9, 11),
    "minor": (0, 2, 3, 5, 7, 8, 10),
}
# The degree of each semitone above the tonic as a major or minor key spells
# it: 1 the flat second, 3 and 4 the minor and major third, 6 the raised
# fourth, 8 and 9 the minor and major sixth, 10 and 11 the minor and major
# seventh. Every mode here spells its own notes the same way.
DEGREE_OF_OFFSET = (0, 1, 1, 2, 2, 3, 3, 4, 5, 5, 6, 6)
LETTER_PC = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
PITCH_NAMES = ("C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B")
POSITION_WORDS = {
    "bar": "downbeat",
    "half": "half bar",
    "beat": "beat",
    "off": "offbeat",
}

__all__ = [
    "BAR",
    "CANTUS_FIRMI",
    "CounterpointError",
    "Scale",
    "check_species",
    "invertible_check",
    "parse_scale",
    "species_counterpoint",
]


class CounterpointError(ValueError):
    """The request cannot be written (a cantus with no cadence, a search that
    found nothing within its budget...)."""


# ---------------------------------------------------------------------------
# scales and intervals
# ---------------------------------------------------------------------------


class Scale:
    """A tonic and a mode, with every pitch's diatonic degree."""

    __slots__ = ("tonic", "mode", "name", "steps", "pcs", "ficta")

    def __init__(self, tonic: int, mode: str, name: str) -> None:
        self.tonic = tonic % 12
        self.mode = mode
        self.name = name
        self.steps = SCALE_STEPS[mode]
        self.pcs = frozenset((self.tonic + s) % 12 for s in self.steps)
        ficta = set()
        if self.steps[6] == 10:
            ficta.add((self.tonic + 11) % 12)  # raised seventh: the leading tone
        if self.steps[5] == 8:
            ficta.add((self.tonic + 9) % 12)  # raised sixth, to reach it by step
        self.ficta = frozenset(ficta)

    @property
    def label(self) -> str:
        return f"{self.name} {self.mode}"

    @property
    def tonal(self) -> bool:
        return self.mode in ("major", "minor")

    def degree(self, midi: int) -> int:
        o = midi - self.tonic
        return (o // 12) * 7 + DEGREE_OF_OFFSET[o % 12]

    def natural(self, degree: int) -> int:
        octave, d = divmod(degree, 7)
        return self.tonic + 12 * octave + self.steps[d]

    def transpose(self, midi: int, steps: int) -> int:
        """Up (or down) ``steps`` degrees in the scale, keeping an accidental."""
        d = self.degree(midi)
        return self.natural(d + steps) + (midi - self.natural(d))

    def semitones(self, steps: int) -> int:
        """The size of the scale's interval of ``steps`` degrees from the tonic."""
        return self.natural(steps) - self.natural(0)

    def is_leading_tone(self, midi: int) -> bool:
        return (
            midi % 12 == (self.tonic + 11) % 12 and (self.tonic + 11) % 12 in self.ficta
        )

    def is_raised_sixth(self, midi: int) -> bool:
        return (
            midi % 12 == (self.tonic + 9) % 12 and (self.tonic + 9) % 12 in self.ficta
        )

    def pitches(self, lo: int, hi: int, *, ficta: bool = False) -> list[int]:
        pcs = self.pcs | self.ficta if ficta else self.pcs
        return [m for m in range(lo, hi + 1) if m % 12 in pcs]


def parse_scale(key: str, mode: str | None = None) -> Scale:
    """A Scale from "D", "f#", "Bb minor", "D dorian" or ("E", "phrygian").

    Without a mode word, an uppercase tonic is major and a lowercase one
    minor. ``b`` after the letter is a flat."""
    words = (key or "").split()
    if not words:
        raise ValueError("a key needs a tonic")
    tonic = words[0]
    word_mode = next((w.lower() for w in words[1:] if w.lower() in MODES), None)
    chosen = (mode or word_mode or "").lower()
    if not chosen:
        chosen = "minor" if tonic[0].islower() else "major"
    if chosen not in MODES:
        raise ValueError(f"mode must be one of {', '.join(MODES)}, not {mode!r}")
    letter = tonic[0].upper()
    if letter not in LETTER_PC:
        raise ValueError(f"not a key tonic: {key!r}")
    pc = LETTER_PC[letter]
    spelled = letter
    for c in tonic[1:]:
        if c in "#♯":
            pc += 1
            spelled += "#"
        elif c in "b-♭":
            pc -= 1
            spelled += "b"
        else:
            raise ValueError(f"not a key tonic: {key!r}")
    return Scale(pc, chosen, spelled)


def infer_scale(pitches: Sequence[int], mode: str | None = None) -> Scale:
    """The mode on the last pitch that holds every pitch (a cantus ends on its
    final): dorian before aeolian, so Fux's D cantus reads as D dorian."""
    final = pitches[-1] % 12
    name = PITCH_NAMES[final]
    order = (
        [mode]
        if mode
        else ["ionian", "dorian", "phrygian", "lydian", "mixolydian", "aeolian"]
    )
    for m in order:
        s = Scale(final, m, name)
        if all(p % 12 in s.pcs for p in pitches):
            return s
    if mode:
        return Scale(final, mode, name)
    raise ValueError("the cantus fits no mode on its final; name the key and mode")


def pname(midi: int) -> str:
    return f"{PITCH_NAMES[midi % 12]}{midi // 12 - 1}"


def consonant(scale: Scale, a: int, b: int, *, upper: bool = False) -> bool:
    """True when a and b are consonant. ``upper``: the pair is two upper voices
    of a texture of three or more, where fourths and tritones are allowed."""
    lo, hi = (a, b) if a <= b else (b, a)
    g = scale.degree(hi) - scale.degree(lo)
    if g < 0:
        return False
    gc, sc = g % 7, (hi - lo) % 12
    if gc == 0:
        return sc == 0
    if gc == 2:
        return sc in (3, 4)
    if gc == 4:
        return sc == 7 or (upper and sc == 6)
    if gc == 5:
        return sc in (8, 9)
    if gc == 3:
        return upper and sc in (5, 6)
    return False


def interval_name(scale: Scale, a: int, b: int) -> str:
    lo, hi = (a, b) if a <= b else (b, a)
    g = scale.degree(hi) - scale.degree(lo) + 1
    ordinal = {1: "unison", 2: "2nd", 3: "3rd", 4: "4th", 5: "5th", 6: "6th"}
    ordinal.update(
        {7: "7th", 8: "octave", 9: "9th", 10: "10th", 11: "11th", 12: "12th"}
    )
    return ordinal.get(g, f"{g}th")


def melodic_kind(scale: Scale, a: int, b: int) -> str | None:
    """'unison', 'step' or 'leap' for a legal melodic move, None otherwise."""
    d = b - a
    g = scale.degree(b) - scale.degree(a)
    if d == 0:
        return "unison" if g == 0 else None
    if g == 0 or (d > 0) != (g > 0):
        return None
    ad, ag = abs(d), abs(g)
    if ag == 1:
        return "step" if ad in (1, 2) else None
    ok = {2: ad in (3, 4), 3: ad == 5, 4: ad == 7, 5: ad == 8 and d > 0, 7: ad == 12}
    return "leap" if ok.get(ag, False) else None


def position(t: int) -> str:
    r = t % BAR
    if r == 0:
        return "bar"
    if r % HALF == 0:
        return "half"
    if r % PPQ == 0:
        return "beat"
    return "off"


def suspension_kind(scale: Scale, held: int, other: int) -> str | None:
    """'7-6', '4-3', '9-8' for a held upper voice, '2-3' for a held lower one."""
    if held > other:
        g = scale.degree(held) - scale.degree(other)
        if g % 7 == 6:
            return "7-6"
        if g % 7 == 3:
            return "4-3"
        if g % 7 == 1 and g >= 7:
            return "9-8"
        return None
    g = scale.degree(other) - scale.degree(held)
    return "2-3" if g % 7 == 1 else None


# ---------------------------------------------------------------------------
# lines and the slice rules
# ---------------------------------------------------------------------------


class Line:
    """One voice's notes in time order. A line being written is ``open``:
    ticks in ``[its last end, seg_end)`` are not known yet."""

    __slots__ = ("name", "pitches", "starts", "ends", "open", "seg_start", "seg_end")

    def __init__(self, name: str, notes: Sequence[Any] = ()) -> None:
        self.name = name
        self.pitches: list[int] = []
        self.starts: list[int] = []
        self.ends: list[int] = []
        self.open = False
        self.seg_start = 0
        self.seg_end = 0
        for x in sorted(notes, key=lambda n: int(_get(n, "tick"))):
            t = int(_get(x, "tick"))
            self.append(int(_get(x, "note")), t, t + max(1, int(_get(x, "ticks"))))

    def append(self, pitch: int, start: int, end: int) -> None:
        self.pitches.append(pitch)
        self.starts.append(start)
        self.ends.append(end)

    def pop(self) -> None:
        self.pitches.pop()
        self.starts.pop()
        self.ends.pop()

    def at(self, t: int) -> int:
        i = bisect_right(self.starts, t) - 1
        return i if i >= 0 and self.ends[i] > t else -1

    def pitch(self, t: int) -> int | None:
        i = self.at(t)
        return self.pitches[i] if i >= 0 else None

    def attacks(self, t: int) -> bool:
        i = bisect_left(self.starts, t)
        return i < len(self.starts) and self.starts[i] == t

    def unknown(self, t: int) -> bool:
        if not self.open:
            return False
        known = max(self.ends[-1] if self.ends else self.seg_start, self.seg_start)
        return known <= t < self.seg_end

    def notes(self, velocity: int = VELOCITY) -> list[dict[str, int]]:
        return [
            {"note": p, "tick": s, "ticks": e - s, "velocity": velocity}
            for p, s, e in zip(self.pitches, self.starts, self.ends)
        ]

    def copy(self, name: str | None = None) -> Line:
        c = Line(name or self.name)
        c.pitches, c.starts, c.ends = (
            list(self.pitches),
            list(self.starts),
            list(self.ends),
        )
        return c


def _get(x: Any, k: str, default: Any = None) -> Any:
    return x.get(k, default) if isinstance(x, Mapping) else getattr(x, k, default)


@dataclass(frozen=True)
class Rules:
    """Where dissonance may fall and how voices may move."""

    passing: frozenset[str] = frozenset({"half", "beat", "off"})
    neighbour: frozenset[str] = frozenset({"beat", "off"})
    suspension: frozenset[str] = frozenset({"bar", "half"})
    upper_suspensions: frozenset[str] = frozenset({"7-6", "4-3", "9-8"})
    lower_suspensions: frozenset[str] = frozenset({"2-3"})
    nct_max: int = HALF
    allow_crossing: bool = False
    max_distance: int = 19  # two voices at most a twelfth apart
    # Two voices alone reach a perfect interval only by contrary or oblique
    # motion (strict counterpoint); off, only the outer-voice rule applies.
    strict_direct: bool = True


FREE = Rules()


class _Stop(Exception):
    pass


class _Out:
    """Collects flags, or stops at the first one when only a yes/no is wanted."""

    def __init__(self, piece: Piece, t: int, collect: bool) -> None:
        self.piece, self.t, self.collect = piece, t, collect
        self.flags: list[Flag] = []

    def add(self, idx: Sequence[int], rule: str, msg: Callable[[], str]) -> None:
        if not self.collect:
            raise _Stop
        self.flags.append(self.piece.flag(self.t, idx, rule, msg()))


class Piece:
    """Lines (top voice first) checked slice by slice: a slice at every onset."""

    def __init__(
        self,
        lines: Sequence[Line],
        scale: Scale,
        rules: Rules = FREE,
        *,
        hook: Callable[[Piece, int, list, list, list, _Out], None] | None = None,
        grid: MeterGrid | None = None,
    ) -> None:
        self.lines = list(lines)
        self.scale = scale
        self.rules = rules
        self.hook = hook
        self.grid = grid or MeterGrid(None)

    @property
    def names(self) -> list[str]:
        return [ln.name for ln in self.lines]

    def flag(self, t: int, idx: Sequence[int], rule: str, message: str) -> Flag:
        bar, beat = self.grid.locate(t)
        return Flag(bar, beat, t, [self.lines[i].name for i in idx], rule, message)

    def times(self, a: int, b: int) -> list[int]:
        out: set[int] = set()
        for ln in self.lines:
            out.update(ln.starts[bisect_left(ln.starts, a) : bisect_left(ln.starts, b)])
        return sorted(out)

    def unknown(self, t: int) -> bool:
        return any(ln.unknown(t) for ln in self.lines)

    def prev_time(self, t: int) -> int | None:
        best = None
        for ln in self.lines:
            i = bisect_left(ln.starts, t) - 1
            if i >= 0 and (best is None or ln.starts[i] > best):
                best = ln.starts[i]
        return best

    # -- the rules at one slice ---------------------------------------------

    def violated(self, t: int) -> bool:
        try:
            self._slice(_Out(self, t, False))
        except _Stop:
            return True
        return False

    def flags_at(self, t: int) -> list[Flag]:
        out = _Out(self, t, True)
        self._slice(out)
        return out.flags

    def flags(self, a: int = 0, b: int | None = None) -> list[Flag]:
        end = b if b is not None else 1 << 40
        return [f for t in self.times(a, end) for f in self.flags_at(t)]

    def _slice(self, out: _Out) -> None:
        t = out.t
        L = self.lines
        r = self.rules
        sc = self.scale
        P = [ln.pitch(t) for ln in L]
        A = [ln.attacks(t) for ln in L]
        if not any(A):
            return
        pt = self.prev_time(t)
        Q = [ln.pitch(pt) for ln in L] if pt is not None else [None] * len(L)
        sounding = [i for i, p in enumerate(P) if p is not None]
        count = len(sounding)
        bass = min((P[i] for i in sounding), default=None)
        both = [i for i in sounding if Q[i] is not None]
        highest = min(both, default=None)
        lowest = max(both, default=None)
        n = len(L)
        for i, j in zip(sounding, sounding[1:]):
            pi, pj = P[i], P[j]
            assert pi is not None and pj is not None
            if j < n - 1 and pi - pj > 12:
                out.add(
                    [i, j],
                    "spacing",
                    lambda i=i, j=j, pi=pi, pj=pj: (
                        f"{L[i].name.capitalize()} and "
                        f"{L[j].name} are more than an octave apart ({pname(pi)} over {pname(pj)})."
                    ),
                )
        for i, j in combinations(sounding, 2):
            pi, pj = P[i], P[j]
            assert pi is not None and pj is not None
            if not r.allow_crossing and pi < pj:
                out.add(
                    [i, j],
                    "voice_crossing",
                    lambda i=i, j=j, pi=pi, pj=pj: (
                        f"{L[i].name.capitalize()} "
                        f"{pname(pi)} is below {L[j].name} {pname(pj)}."
                    ),
                )
            if count == 2 and abs(pi - pj) > r.max_distance:
                out.add(
                    [i, j],
                    "spacing",
                    lambda pi=pi, pj=pj: (
                        f"The voices are more than a twelfth apart "
                        f"({pname(pi)} and {pname(pj)})."
                    ),
                )
            lo = min(pi, pj)
            if not consonant(sc, pi, pj, upper=count > 2 and lo != bass):
                why = self._treatment(t, i, j, A, P)
                if why is not None:
                    out.add(
                        [i, j],
                        "dissonance",
                        lambda pi=pi, pj=pj, why=why: (
                            f"{interval_name(sc, pi, pj).capitalize()} "
                            f"{pname(max(pi, pj))} over {pname(min(pi, pj))} on the "
                            f"{POSITION_WORDS[position(t)]}: {why}."
                        ),
                    )
            qi, qj = Q[i], Q[j]
            if qi is None or qj is None:
                continue
            mi, mj = pi - qi, pj - qj
            if mi == 0 and mj == 0:
                continue
            ia, ib = abs(qi - qj) % 12, abs(pi - pj) % 12
            moved = mi != 0 and mj != 0
            moves = f"({pname(qi)}/{pname(qj)} to {pname(pi)}/{pname(pj)})"
            if moved and ia == ib and ib in (0, 7):
                rule = "parallel_fifths" if ib == 7 else "parallel_octaves"
                out.add(
                    [i, j],
                    rule,
                    lambda rule=rule, moves=moves, i=i, j=j: (
                        f"Parallel "
                        f"{'fifths' if rule == 'parallel_fifths' else 'octaves'} between "
                        f"{L[i].name} and {L[j].name} {moves}."
                    ),
                )
            elif moved and (mi > 0) == (mj > 0) and ib in (0, 7) and ia != ib:
                what = "fifth" if ib == 7 else "octave"
                if i == highest and j == lowest and abs(mi) > 2:
                    out.add(
                        [i, j],
                        f"hidden_{what}s",
                        lambda what=what, moves=moves, i=i: (
                            f"Hidden {what} between the "
                            f"outer voices {moves}: the {L[i].name} leaps into it."
                        ),
                    )
                elif count == 2 and r.strict_direct:
                    out.add(
                        [i, j],
                        "direct_perfect",
                        lambda what=what, moves=moves: (
                            f"Similar motion into a {what} "
                            f"{moves}; two voices reach a perfect interval by contrary or "
                            "oblique motion."
                        ),
                    )
            if not r.allow_crossing and j == i + 1 and (pi < qj or pj > qi):
                out.add(
                    [i, j],
                    "voice_overlap",
                    lambda moves=moves, i=i, j=j: (
                        f"{L[i].name.capitalize()} and {L[j].name} overlap {moves}."
                    ),
                )
        if self.hook is not None:
            self.hook(self, t, P, Q, A, out)

    # -- dissonance treatment -----------------------------------------------

    def _treatment(
        self, t: int, i: int, j: int, A: list[bool], P: list[int | None]
    ) -> str | None:
        """None when the dissonance between voices i and j at t is a passing or
        neighbour tone, a suspension, or may still become one; else why not."""
        if A[i] and A[j]:
            return "both voices attack it"
        if not A[i] and not A[j]:
            return None
        x, y = (i, j) if A[i] else (j, i)
        why = self._nct(x, t)
        if why is None:
            return None
        why_susp = self._suspension(y, x, t, P)
        if why_susp is None:
            return None
        return why if why_susp == "-" else why_susp

    def _nct(self, x: int, t: int) -> str | None:
        r = self.rules
        ln = self.lines[x]
        pos = position(t)
        if pos not in r.passing and pos not in r.neighbour:
            return f"only a suspension may be dissonant on the {POSITION_WORDS[pos]}"
        k = ln.at(t)
        if k <= 0 or ln.ends[k - 1] != t:
            return "it is not approached by step"
        prev, cur = ln.pitches[k - 1], ln.pitches[k]
        if melodic_kind(self.scale, prev, cur) != "step":
            return "it is approached by leap"
        if ln.ends[k] - ln.starts[k] > r.nct_max:
            return "it is too long for a passing tone"
        if k + 1 >= len(ln.pitches):
            return None if ln.open else "it is never resolved"
        if ln.starts[k + 1] != ln.ends[k]:
            return "it is left by a rest"
        nxt = ln.pitches[k + 1]
        if melodic_kind(self.scale, cur, nxt) != "step":
            return "it is left by leap"
        passing = (cur - prev) * (nxt - cur) > 0
        if passing and pos not in r.passing:
            return f"a passing tone is not allowed on the {POSITION_WORDS[pos]}"
        if not passing and pos not in r.neighbour:
            return f"a neighbour tone is not allowed on the {POSITION_WORDS[pos]}"
        return None

    def _suspension(self, y: int, x: int, t: int, P: list[int | None]) -> str | None:
        """None for a (possibly still unresolved) suspension of the held voice
        y against voice x; "-" when it cannot be one at all; else why not."""
        r = self.rules
        if position(t) not in r.suspension:
            return "-"
        ly, lx = self.lines[y], self.lines[x]
        k = ly.at(t)
        if k < 0 or ly.starts[k] >= t:
            return "-"
        s0 = ly.starts[k]
        held = ly.pitches[k]
        prep = lx.pitch(s0)
        if prep is None or not consonant(self.scale, held, prep):
            return "the held note was not prepared by a consonance"
        other = P[x]
        assert other is not None
        kind = suspension_kind(self.scale, held, other)
        allowed = r.upper_suspensions if held > other else r.lower_suspensions
        if kind not in allowed:
            return f"a held {interval_name(self.scale, held, other)} is not a suspension here"
        if k + 1 >= len(ly.pitches):
            return None if ly.open else "the suspension never resolves"
        if ly.starts[k + 1] != ly.ends[k]:
            return "the suspension is left by a rest"
        nxt = ly.pitches[k + 1]
        if not (nxt < held and melodic_kind(self.scale, held, nxt) == "step"):
            return f"the {kind} suspension does not fall a step"
        against = lx.pitch(ly.ends[k])
        if against is None:
            return None  # not written yet, or the other voice rests
        if not consonant(self.scale, nxt, against):
            return f"the {kind} suspension resolves to a dissonance"
        return None


# ---------------------------------------------------------------------------
# melody
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Melody:
    repeats: bool = False
    max_range: int = 16  # a tenth
    eighth_steps: bool = True


MELODY = Melody()


def melodic_problems(
    scale: Scale, ln: Line, k: int, opts: Melody, first: int = 0
) -> list[tuple[str, str]]:
    """(rule, message) for the move into note k of a line; ``first`` is the
    index where the line's own range starts counting."""
    out: list[tuple[str, str]] = []
    P, S, E = ln.pitches, ln.starts, ln.ends
    seg = P[first : k + 1]
    if seg and max(seg) - min(seg) > opts.max_range:
        out.append(("line_range", f"The {ln.name} spans more than a tenth."))
    if k <= 0 or S[k] != E[k - 1]:
        return out
    a, b = P[k - 1], P[k]
    kind = melodic_kind(scale, a, b)
    if kind is None:
        out.append(
            (
                "melodic_interval",
                f"The {ln.name} moves {pname(a)} to {pname(b)}, "
                f"{'an augmented or diminished interval' if abs(b - a) in (1, 3, 6) else 'a forbidden leap'}.",
            )
        )
    elif kind == "unison" and not opts.repeats:
        out.append(("repeated_note", f"The {ln.name} repeats {pname(b)}."))
    if scale.is_leading_tone(a) and b != a + 1:
        out.append(
            ("ficta", f"The raised leading tone {pname(a)} does not rise to the tonic.")
        )
    if scale.is_raised_sixth(a) and b != a + 2:
        out.append(
            ("ficta", f"The raised sixth {pname(a)} does not rise to the leading tone.")
        )
    if opts.eighth_steps and kind != "step":
        if E[k] - S[k] < PPQ or E[k - 1] - S[k - 1] < PPQ:
            out.append(
                ("eighths", f"The {ln.name} leaps into or out of an eighth note.")
            )
    if k >= 2 and S[k - 1] == E[k - 2]:
        m1, m2 = a - P[k - 2], b - a
        if abs(m1) > 5 and (m2 == 0 or (m2 > 0) == (m1 > 0)):
            out.append(
                (
                    "leap_recovery",
                    f"The {ln.name} leaps {pname(P[k - 2])} to {pname(a)} and does not turn back.",
                )
            )
        if abs(m1) > 2 and abs(m2) > 2 and (m1 > 0) == (m2 > 0):
            third = k >= 3 and S[k - 2] == E[k - 3] and abs(P[k - 2] - P[k - 3]) > 2
            third = third and (P[k - 2] - P[k - 3] > 0) == (m1 > 0)
            if abs(m1) > 4 or abs(m2) > 4 or third:
                out.append(
                    (
                        "consecutive_leaps",
                        f"The {ln.name} leaps twice the same way into {pname(b)}.",
                    )
                )
    return out


def melody_flags(
    piece: Piece, index: int, opts: Melody = MELODY, first: int = 0
) -> list[Flag]:
    ln = piece.lines[index]
    return [
        piece.flag(ln.starts[k], [index], rule, msg)
        for k in range(first, len(ln.pitches))
        for rule, msg in melodic_problems(piece.scale, ln, k, opts, first)
    ]


# ---------------------------------------------------------------------------
# the search
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Ev:
    tick: int
    ticks: int
    tie: bool = False  # the same pitch as the note before makes one tied note


@dataclass
class Image:
    """Where the line being searched is written: a line of a piece, shifted in
    time and pitch (a canon's follower, an inversion), up to a cutoff."""

    piece: Piece
    line: Line
    offset: int = 0
    shift: Callable[[int], int] | None = None
    cutoff: int | None = None
    melody: Melody | None = MELODY
    melody_from: int = 0
    continues: bool = False


class SearchFailed(CounterpointError):
    pass


class Search:
    """Depth-first search over the pitches of ``events``."""

    def __init__(
        self,
        events: Sequence[Ev],
        candidates: Callable[[int, Search], list[int]],
        images: Sequence[Image],
        *,
        leaf: Callable[[Search], bool] | None = None,
        budget: int = 40000,
        rng: random.Random | None = None,
        step_ok: Callable[[int, Search], bool] | None = None,
    ) -> None:
        self.step_ok = step_ok
        self.events = list(events)
        self.candidates = candidates
        self.images = list(images)
        self.leaf = leaf
        self.budget = budget
        self.rng = rng or random.Random(0)
        self.nodes = 0
        self.stack: list[list[tuple | None]] = []
        self.pitches: list[int] = []

    def _window(self, im: Image, ev: Ev) -> tuple[int, int] | None:
        t0 = ev.tick + im.offset
        t1 = t0 + ev.ticks
        if im.cutoff is not None:
            if t0 >= im.cutoff:
                return None
            t1 = min(t1, im.cutoff)
        return t0, t1

    def run(self) -> bool:
        if not self.events:
            return True
        for im in self.images:
            first = self._window(im, self.events[0])
            lasts = [w for w in (self._window(im, e) for e in self.events) if w]
            im.line.open = True
            im.line.seg_start = first[0] if first else 0
            im.line.seg_end = lasts[-1][1] if lasts else im.line.seg_start
        ok = self._dfs(0)
        for im in self.images:
            im.line.open = im.continues
            im.line.seg_end = im.line.ends[-1] if im.line.ends else 0
        if not ok:
            raise SearchFailed("no line satisfies every rule")
        return True

    def _push(self, k: int, p: int) -> None:
        ev = self.events[k]
        undo: list[tuple | None] = []
        for im in self.images:
            w = self._window(im, ev)
            if w is None:
                undo.append(None)
                continue
            q = im.shift(p) if im.shift else p
            ln = im.line
            if ev.tie and ln.pitches and ln.ends[-1] == w[0] and ln.pitches[-1] == q:
                undo.append(("extend", ln.ends[-1]))
                ln.ends[-1] = w[1]
            else:
                ln.append(q, w[0], w[1])
                undo.append(("append",))
        self.stack.append(undo)
        self.pitches.append(p)

    def _pop(self) -> None:
        undo = self.stack.pop()
        self.pitches.pop()
        for im, u in zip(self.images, undo):
            if u is None:
                continue
            if u[0] == "append":
                im.line.pop()
            else:
                im.line.ends[-1] = u[1]

    def _clean(self, k: int) -> bool:
        ev = self.events[k]
        for im, u in zip(self.images, self.stack[-1]):
            if u is None:
                continue
            w = self._window(im, ev)
            assert w is not None
            ln = im.line
            piece = im.piece
            times = set(piece.times(w[0], w[1]))
            if u[0] == "append":
                idx = len(ln.pitches) - 1
                if im.melody is not None and melodic_problems(
                    piece.scale, ln, idx, im.melody, im.melody_from
                ):
                    return False
                if idx >= 1:
                    times.update(
                        piece.times(ln.starts[idx - 1], min(ln.ends[idx - 1], w[0]))
                    )
            for t in sorted(times):
                if not piece.unknown(t) and piece.violated(t):
                    return False
        return True

    def _dfs(self, k: int) -> bool:
        if k == len(self.events):
            return self._at_leaf()
        for p in self.candidates(k, self):
            self.nodes += 1
            if self.nodes > self.budget:
                raise SearchFailed(
                    "the search ran out of its budget before every rule was met"
                )
            self._push(k, p)
            if (
                (self.step_ok is None or self.step_ok(k, self))
                and self._clean(k)
                and self._dfs(k + 1)
            ):
                return True
            self._pop()
        return False

    def _at_leaf(self) -> bool:
        if self.leaf is None:
            return True
        closed = [im.line for im in self.images if not im.continues]
        for ln in closed:
            ln.open = False
        ok = self.leaf(self)
        if not ok:
            for ln in closed:
                ln.open = True
        return ok


def rank(
    cands: Sequence[int],
    prev: int | None,
    rng: random.Random,
    extra: Callable[[int], float] | None = None,
    jitter: float = 4.0,
) -> list[int]:
    """Candidates by style cost: steps before leaps, plus seeded jitter."""
    scored = []
    for p in cands:
        c = 0.0
        if prev is not None:
            d = abs(p - prev)
            c += 0.5 * d + (3.0 if d > 4 else 0.0) + (2.0 if d == 0 else 0.0)
        if extra is not None:
            c += extra(p)
        scored.append((c + rng.random() * jitter, p))
    scored.sort()
    return [p for _, p in scored]


def checker_flags(
    lines: Sequence[Line],
    ranges: Mapping[str, tuple[int, int]] | None = None,
    ignore: Sequence[str] = (),
) -> list[Flag]:
    """The four-part checker's motion and range rules over the lines (top
    first). The tendency-tone rules need chord labels that counterpoint does
    not have, so every slice goes in without a harmony."""
    names = [ln.name for ln in lines]
    parts = {ln.name: ln.notes() for ln in lines if ln.pitches}
    names = [n for n in names if n in parts]
    if len(names) < 1:
        return []
    slices = slices_from_parts(parts, names, lambda _s: None)
    flags = check_slices(slices, names, dict(ranges or {}), MeterGrid(None))
    return [f for f in flags if f.rule not in ignore]


# ---------------------------------------------------------------------------
# cantus firmi
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# species
# ---------------------------------------------------------------------------

SPECIES_RULES: dict[int, Rules] = {
    1: Rules(passing=frozenset(), neighbour=frozenset(), suspension=frozenset()),
    2: Rules(
        passing=frozenset({"half"}), neighbour=frozenset(), suspension=frozenset()
    ),
    3: Rules(
        passing=frozenset({"half", "beat"}),
        neighbour=frozenset({"beat"}),
        suspension=frozenset(),
    ),
    4: Rules(passing=frozenset(), neighbour=frozenset(), suspension=frozenset({"bar"})),
    5: Rules(
        passing=frozenset({"half", "beat", "off"}),
        neighbour=frozenset({"beat", "off"}),
        suspension=frozenset({"bar"}),
    ),
}
MAX_BROKEN_TIES = 2
TRIES = 8

# Florid bars: (offset, ticks, tied over from the bar before).
_H, _Q, _E = HALF, PPQ, EIGHTH
FLORID_BARS: dict[str, list[tuple[int, int, bool]]] = {
    "halves": [(0, _H, False), (_H, _H, False)],
    "quarters": [
        (0, _Q, False),
        (_Q, _Q, False),
        (_H, _Q, False),
        (_H + _Q, _Q, False),
    ],
    "half_quarters": [(0, _H, False), (_H, _Q, False), (_H + _Q, _Q, False)],
    "quarters_half": [(0, _Q, False), (_Q, _Q, False), (_H, _H, False)],
    "half_quarter_eighths": [
        (0, _H, False),
        (_H, _Q, False),
        (_H + _Q, _E, False),
        (_H + _Q + _E, _E, False),
    ],
    "quarter_eighths_half": [
        (0, _Q, False),
        (_Q, _E, False),
        (_Q + _E, _E, False),
        (_H, _H, False),
    ],
    "tie_half": [(0, _H, True), (_H, _H, False)],
    "tie_quarters": [(0, _H, True), (_H, _Q, False), (_H + _Q, _Q, False)],
}
FLORID_WEIGHTS = {
    "halves": 2,
    "quarters": 2,
    "half_quarters": 3,
    "quarters_half": 3,
    "half_quarter_eighths": 2,
    "quarter_eighths_half": 2,
    "tie_half": 3,
    "tie_quarters": 3,
}


def florid_rhythm(bars: int, rng: random.Random) -> list[str]:
    """A bar pattern per bar: the first two halves, the penultimate a tied
    suspension (so the bar before it ends on a half), the last a whole."""
    names = list(FLORID_WEIGHTS)
    weights = [FLORID_WEIGHTS[n] for n in names]
    out = ["halves"]
    for b in range(1, bars - 1):
        prev_half = FLORID_BARS[out[-1]][-1][1] == HALF
        need_half_end = b == bars - 3
        if b == bars - 2:
            out.append("tie_half")
            continue
        while True:
            name = rng.choices(names, weights)[0]
            pat = FLORID_BARS[name]
            if pat[0][2] and not prev_half:
                continue
            if need_half_end and pat[-1][1] != HALF:
                continue
            break
        out.append(name)
    out.append("whole")
    return out


def species_events(
    species: int,
    bars: int,
    start: int,
    rng: random.Random,
    whole_penultimate: bool = False,
) -> tuple[list[Ev], list[str]]:
    """The notes to search. ``whole_penultimate``: the second species may
    close with a whole note in the penultimate bar, as Fux allows."""
    evs: list[Ev] = []
    pattern: list[str] = []
    last = start + (bars - 1) * BAR
    if species == 1:
        evs = [Ev(start + b * BAR, BAR) for b in range(bars)]
    elif species in (2, 3):
        step = HALF if species == 2 else PPQ
        halves_until = (bars - (2 if whole_penultimate else 1)) * BAR
        evs = [Ev(start + t, step) for t in range(0, halves_until, step)]
        if whole_penultimate:
            evs.append(Ev(last - BAR, BAR))
            pattern = ["whole_penultimate"]
        evs.append(Ev(last, BAR))
    elif species == 4:
        evs = [Ev(start + HALF, HALF)]
        for b in range(1, bars - 1):
            evs.append(Ev(start + b * BAR, HALF, tie=True))
            evs.append(Ev(start + b * BAR + HALF, HALF))
        evs.append(Ev(last, BAR))
    else:
        pattern = florid_rhythm(bars, rng)
        for b, name in enumerate(pattern[:-1]):
            for off, ticks, tie in FLORID_BARS[name]:
                evs.append(Ev(start + b * BAR + off, ticks, tie))
        evs.append(Ev(last, BAR))
    return evs, pattern


@dataclass
class SpeciesContext:
    species: int
    above: bool
    cp: int  # index of the counterpoint line in the piece
    cf: int
    first_tick: int
    final_tick: int
    written: bool = (
        True  # False for the inverted pair: no opening, cadence or unison rules
    )


def species_hook(
    ctx: SpeciesContext,
) -> Callable[[Piece, int, list, list, list, _Out], None]:
    """The species' own slice rules: the opening, unisons, perfect consonances
    on consecutive strong beats and runs of parallel thirds or sixths."""

    def hook(piece: Piece, t: int, P: list, Q: list, A: list, out: _Out) -> None:
        cp, cf = ctx.cp, ctx.cf
        a, b = P[cp], P[cf]
        if a is None or b is None:
            return
        L = piece.lines
        pos = position(t)
        if ctx.written and A[cp] and t == ctx.first_tick:
            ok = (a - b) % 12 in (0, 7) and a >= b if ctx.above else (b - a) % 12 == 0
            if not ok:
                out.add(
                    [cp, cf],
                    "opening",
                    lambda: (
                        f"The counterpoint opens on a {interval_name(piece.scale, a, b)}; "
                        + (
                            "above the cantus it opens on a unison, fifth or octave."
                            if ctx.above
                            else "below the cantus it opens on a unison or octave."
                        )
                    ),
                )
        if (
            ctx.written
            and A[cp]
            and a == b
            and ctx.first_tick < t < ctx.final_tick
            and (ctx.species == 1 or pos == "bar")
        ):
            out.add(
                [cp, cf], "unison", lambda: f"A unison on {pname(a)} inside the line."
            )
        if ctx.species in (2, 3, 5) and pos == "bar" and t - BAR >= ctx.first_tick:
            a0, b0 = L[cp].pitch(t - BAR), L[cf].pitch(t - BAR)
            if (
                a0 is not None
                and b0 is not None
                and a0 != a
                and b0 != b
                and not _leap_between(L[cp], t - BAR, t)
            ):
                i0, i1 = abs(a0 - b0) % 12, abs(a - b) % 12
                if i0 == i1 and i1 in (0, 7):
                    out.add(
                        [cp, cf],
                        "accented_parallels",
                        lambda: (
                            f"{'Fifths' if i1 == 7 else 'Octaves'} on consecutive "
                            f"downbeats ({pname(a0)}/{pname(b0)} to {pname(a)}/{pname(b)})."
                        ),
                    )
        if ctx.species == 4 and pos == "half" and A[cp] and t - BAR >= ctx.first_tick:
            a0, b0 = L[cp].pitch(t - BAR), L[cf].pitch(t - BAR)
            if a0 is not None and b0 is not None and a0 != a and b0 != b:
                i0, i1 = abs(a0 - b0) % 12, abs(a - b) % 12
                if i0 == i1 and i1 in (0, 7):
                    out.add(
                        [cp, cf],
                        "accented_parallels",
                        lambda: (
                            f"{'Fifths' if i1 == 7 else 'Octaves'} on consecutive "
                            f"offbeats ({pname(a0)}/{pname(b0)} to {pname(a)}/{pname(b)})."
                        ),
                    )
        if ctx.species == 1 and pos == "bar":
            classes = []
            for back in range(4):
                tb = t - back * BAR
                if tb < ctx.first_tick:
                    break
                x, y = L[cp].pitch(tb), L[cf].pitch(tb)
                if x is None or y is None:
                    break
                g = abs(piece.scale.degree(x) - piece.scale.degree(y)) % 7
                classes.append(g if g in (2, 5) else None)
            if len(classes) == 4 and classes[0] is not None and len(set(classes)) == 1:
                what = "thirds" if classes[0] == 2 else "sixths"
                out.add(
                    [cp, cf],
                    "parallel_imperfect",
                    lambda: f"Four parallel {what} in a row; three is the limit.",
                )

    return hook


def _leap_between(ln: Line, t0: int, t1: int) -> bool:
    """True when the line leaps a fourth or more between the notes sounding at
    t0 and t1: Fux lets such a leap separate perfect consonances on
    consecutive strong beats."""
    i, j = ln.at(t0), ln.at(t1)
    if i < 0 or j < 0:
        return False
    return any(abs(ln.pitches[k + 1] - ln.pitches[k]) >= 5 for k in range(i, j))


def species_global(
    piece: Piece, ctx: SpeciesContext, rhythm: bool = False
) -> list[Flag]:
    """The rules over the whole line: the cadence, the single climax, broken
    ties in the fourth species and, for a line someone wrote, its rhythm."""
    out: list[Flag] = []
    cpl, cfl = piece.lines[ctx.cp], piece.lines[ctx.cf]
    idx = [ctx.cp, ctx.cf]
    P = cpl.pitches
    if rhythm:
        out += rhythm_flags(piece, ctx)
    if len(P) >= 2 and len(cfl.pitches) >= 2:
        fin, pen = P[-1], P[-2]
        cf_fin = cfl.pitches[-1]
        cf_pen = cfl.pitch(cpl.starts[-2])
        problems = []
        if cpl.starts[-1] != cfl.starts[-1]:
            problems.append(
                "the counterpoint does not arrive with the cantus's last note"
            )
        if (fin - cf_fin) % 12 != 0 or (fin < cf_fin if ctx.above else fin > cf_fin):
            problems.append("the last interval is not a unison or octave")
        why = "the cantus has no note under the penultimate" if cf_pen is None else None
        if cf_pen is not None:
            why = clausula(piece.scale, pen, fin, cf_pen, cf_fin)
        if why:
            problems.append(why)
        if problems:
            out.append(
                piece.flag(
                    cpl.starts[-1],
                    idx,
                    "cadence",
                    "Cadence: " + "; ".join(problems) + ".",
                )
            )
    if P:
        top = max(P)
        if P.count(top) > 1:
            where = [s for p, s in zip(P, cpl.starts) if p == top]
            out.append(
                piece.flag(
                    where[1],
                    [ctx.cp],
                    "climax",
                    f"The highest note {pname(top)} comes {len(where)} times; "
                    "the line has one climax.",
                )
            )
    if ctx.species == 4:
        broken = [
            s
            for s in cpl.starts
            if s % BAR == 0 and ctx.first_tick < s < ctx.final_tick
        ]
        if len(broken) > MAX_BROKEN_TIES:
            out.append(
                piece.flag(
                    broken[MAX_BROKEN_TIES],
                    [ctx.cp],
                    "broken_ties",
                    f"The syncopation is broken {len(broken)} times; "
                    f"at most {MAX_BROKEN_TIES}.",
                )
            )
    return out


def rhythm_flags(piece: Piece, ctx: SpeciesContext) -> list[Flag]:
    cpl, cfl = piece.lines[ctx.cp], piece.lines[ctx.cf]
    start = cfl.starts[0]
    end = cfl.ends[-1]
    out: list[Flag] = []

    def bad(t: int, msg: str) -> None:
        out.append(piece.flag(t, [ctx.cp], "rhythm", msg))

    sp = ctx.species
    first = start + (HALF if sp == 4 else 0)
    if not cpl.pitches:
        bad(start, "The counterpoint has no notes.")
        return out
    if cpl.starts[0] != first:
        bad(
            cpl.starts[0],
            f"Species {sp} starts {'after a half rest' if sp == 4 else 'with the cantus'}.",
        )
    if cpl.ends[-1] != end or cpl.starts[-1] != end - BAR:
        bad(cpl.starts[-1], "The counterpoint ends on a whole note with the cantus.")
    for k in range(1, len(cpl.starts)):
        if cpl.starts[k] != cpl.ends[k - 1]:
            bad(cpl.starts[k], "The counterpoint has a gap or an overlap.")
    allowed = {
        1: {BAR},
        2: {HALF, BAR},
        3: {PPQ},
        4: {HALF, BAR},
        5: {EIGHTH, PPQ, HALF, BAR},
    }[sp]
    for k in range(len(cpl.starts) - 1):
        s, d = cpl.starts[k], cpl.ends[k] - cpl.starts[k]
        rel = (s - start) % BAR
        ok = d in allowed
        if sp == 4:
            ok = ok and rel % HALF == 0 and (d == HALF or rel == HALF)
        elif sp == 5:
            if d == EIGHTH:
                pair_next = (
                    k + 1 < len(cpl.starts)
                    and cpl.ends[k + 1] - cpl.starts[k + 1] == EIGHTH
                )
                pair_prev = k > 0 and cpl.ends[k - 1] - cpl.starts[k - 1] == EIGHTH
                ok = (rel % PPQ == 0 and pair_next) or (
                    rel % PPQ == EIGHTH and pair_prev
                )
            elif d == BAR:
                ok = rel in (0, HALF)
            else:
                ok = ok and rel % d == 0
        elif sp == 2 and d == BAR:
            ok = k == len(cpl.starts) - 2 and rel == 0
        else:
            ok = ok and rel % d == 0
        if not ok:
            bad(s, f"A note of {d} ticks here does not belong to species {sp}.")
    if any((e - s) != BAR or (s - start) % BAR for s, e in zip(cfl.starts, cfl.ends)):
        bad(start, "The cantus firmus is not in whole notes, one a bar.")
    return out


def _cantus_pitches(cantus: Sequence[Any]) -> list[int]:
    pitches: list[int] = []
    for x in cantus:
        pitches.append(int(x) if isinstance(x, (int, float)) else int(_get(x, "note")))
    return pitches


def _species_setup(
    cf: Sequence[int],
    scale: Scale,
    species: int,
    above: bool,
    start: int,
    invertible: int | None,
    cp_line: Line,
    cf_line: Line,
) -> tuple[Piece, SpeciesContext, Piece | None, SpeciesContext | None, Line | None]:
    rules = SPECIES_RULES[species]
    lines = [cp_line, cf_line] if above else [cf_line, cp_line]
    first = start + (HALF if species == 4 else 0)
    final = start + (len(cf) - 1) * BAR
    ctx = SpeciesContext(
        species, above, 0 if above else 1, 1 if above else 0, first, final
    )
    piece = Piece(lines, scale, rules, hook=species_hook(ctx))
    if not invertible:
        return piece, ctx, None, None, None
    # The lower voice moves up: the cantus when the counterpoint is above it,
    # the counterpoint (as an image of the line being written) when below.
    steps = invertible - 1
    inv_cp = Line("counterpoint")
    if above:
        moved = Line(
            "cantus",
            [
                {"note": scale.transpose(p, steps), "tick": s, "ticks": e - s}
                for p, s, e in zip(cf_line.pitches, cf_line.starts, cf_line.ends)
            ],
        )
        inv_lines = [moved, inv_cp]
    else:
        inv_lines = [inv_cp, cf_line]
    ictx = SpeciesContext(
        species,
        not above,
        1 if above else 0,
        0 if above else 1,
        first,
        final,
        written=False,
    )
    inv = Piece(inv_lines, scale, rules, hook=species_hook(ictx))
    return piece, ctx, inv, ictx, inv_cp


def find_suspensions(piece: Piece, ctx: SpeciesContext) -> list[dict[str, Any]]:
    cpl, cfl = piece.lines[ctx.cp], piece.lines[ctx.cf]
    out = []
    for t in cfl.starts:
        k = cpl.at(t)
        if k < 0 or cpl.starts[k] >= t:
            continue
        held, other = cpl.pitches[k], cfl.pitch(t)
        if other is None or consonant(piece.scale, held, other):
            continue
        kind = suspension_kind(piece.scale, held, other)
        bar, beat = piece.grid.locate(t)
        out.append({"bar": bar, "beat": beat, "tick": t, "figure": kind})
    return out


def species_counterpoint(
    cantus: Sequence[Any],
    *,
    key: str | None = None,
    mode: str | None = None,
    species: int = 1,
    above: bool = True,
    seed: int = 0,
    invertible: int | None = None,
    start_tick: int = 0,
    budget: int = 60000,
) -> dict[str, Any]:
    """A counterpoint in the given species above or below a cantus firmus
    (MIDI notes or ``{note}`` dicts, one whole note a bar)."""
    if species not in SPECIES:
        raise CounterpointError(f"species must be one of {SPECIES}")
    if invertible is not None and invertible not in INVERTIBLE_AT:
        raise CounterpointError(f"invertible counterpoint is at {INVERTIBLE_AT}")
    cf = _cantus_pitches(cantus)
    if not 4 <= len(cf) <= 32:
        raise CounterpointError("a cantus firmus has 4 to 32 notes")
    start = start_tick - start_tick % BAR
    scale = parse_scale(key, mode) if key else infer_scale(cf, mode)
    if cf[-1] % 12 != scale.tonic:
        raise CounterpointError(
            f"the cantus ends on {pname(cf[-1])}, not on the final of {scale.label}"
        )
    if melodic_kind(scale, cf[-2], cf[-1]) != "step":
        raise CounterpointError(
            "the cantus reaches its final by step, or no cadence can be written"
        )
    cf_line = Line(
        "cantus",
        [{"note": p, "tick": start + i * BAR, "ticks": BAR} for i, p in enumerate(cf)],
    )
    lo, hi = (min(cf), max(cf) + 16) if above else (min(cf) - 16, max(cf))
    rng = random.Random(seed)
    last_error: Exception | None = None
    # Restarts with fresh jitter beat one long search: a bad early choice can
    # cost the whole budget before the search backs up to it.
    tries = TRIES
    budget = max(1000, budget // tries)
    for attempt in range(tries):
        events, pattern = species_events(
            species,
            len(cf),
            start,
            rng,
            whole_penultimate=species == 2 and attempt % 2 == 1,
        )
        cp_line = Line("counterpoint")
        piece, ctx, inv, ictx, inv_cp = _species_setup(
            cf, scale, species, above, start, invertible, cp_line, cf_line
        )
        images = [Image(piece, cp_line)]
        if inv is not None:
            assert inv_cp is not None
            steps = (invertible or 1) - 1
            shift = None if above else (lambda p, st=steps: scale.transpose(p, st))
            images.append(Image(inv, inv_cp, shift=shift, melody=None))
        cands, step_ok = _species_candidates(
            scale, cf_line, events, species, above, lo, hi, invertible
        )

        def leaf(
            s: Search,
            piece: Piece = piece,
            ctx: SpeciesContext = ctx,
            inv: Piece | None = inv,
            last: bool = attempt == tries - 1,
        ) -> bool:
            if species_global(piece, ctx):
                return False
            if species in (4, 5) and not last and not find_suspensions(piece, ctx):
                return False  # the syncopated species should show a suspension
            if piece.flags() or (inv is not None and inv.flags()):
                return False
            if checker_flags(piece.lines):
                return False
            return not (inv is not None and checker_flags(inv.lines))

        search = Search(
            events, cands, images, leaf=leaf, budget=budget, rng=rng, step_ok=step_ok
        )
        try:
            search.run()
        except SearchFailed as e:
            last_error = e
            continue
        return _species_payload(
            piece, ctx, inv, scale, species, above, seed, invertible, pattern
        )
    raise CounterpointError(
        f"no species {species} counterpoint {'above' if above else 'below'} this cantus "
        f"was found ({last_error}); try another seed"
    )


def clausula(scale: Scale, pen: int, fin: int, cf_pen: int, cf_fin: int) -> str | None:
    """None when (pen, fin) over (cf_pen, cf_fin) is the closing formula: the
    voices move by contrary step, a major sixth widening to the octave or a
    minor third closing to the unison (or their compounds); else why not."""
    if melodic_kind(scale, pen, fin) != "step":
        return "the counterpoint does not reach the final by step"
    if (
        melodic_kind(scale, cf_pen, cf_fin) != "step"
        or (fin - pen) * (cf_fin - cf_pen) >= 0
    ):
        return "the voices do not close in contrary stepwise motion"
    v, f = abs(pen - cf_pen), abs(fin - cf_fin)
    if (v in (9, 21) and f in (12, 24)) or (v in (3, 15) and f in (0, 12)):
        return None
    return "the penultimate interval is not a major sixth to the octave or a minor third to the unison"


def _species_candidates(
    scale: Scale,
    cf_line: Line,
    events: Sequence[Ev],
    species: int,
    above: bool,
    lo: int,
    hi: int,
    invertible: int | None = None,
) -> tuple[Callable[[int, Search], list[int]], Callable[[int, Search], bool]]:
    """The candidates for each note, and a step test for the search.

    Candidates are cut back from the end: the final is a unison or octave with
    the cantus, the note before it makes the clausula, and every earlier note
    can reach some candidate of the next by a legal move. A note attacked
    where no dissonance is allowed is consonant with the cantus."""
    rules = SPECIES_RULES[species]
    pool = scale.pitches(lo, hi)
    lt = [p for p in range(lo, hi + 1) if scale.is_leading_tone(p)]
    n = len(events)
    cf_at = [cf_line.pitch(ev.tick) for ev in events]
    cf_fin = cf_line.pitches[-1]
    cf_pen = cf_at[n - 2]
    assert cf_pen is not None

    steps = (invertible or 1) - 1

    def inverted(p: int, c: int) -> tuple[int, int]:
        """(upper, lower) of the pair inverted: the lower voice moved up."""
        return (
            (scale.transpose(c, steps), p) if above else (scale.transpose(p, steps), c)
        )

    def side(p: int, c: int | None) -> bool:
        if c is None:
            return True
        if not (p >= c if above else p <= c):
            return False
        if invertible:
            u, v = inverted(p, c)
            return u >= v
        return True

    def cons(p: int, c: int) -> bool:
        if not consonant(scale, p, c):
            return False
        return not invertible or consonant(scale, *inverted(p, c))

    allowed: list[list[int]] = [[] for _ in range(n)]
    allowed[n - 1] = [p for p in pool if (p - cf_fin) % 12 == 0 and side(p, cf_fin)]
    allowed[n - 2] = [
        p
        for p in pool + lt
        if side(p, cf_pen)
        and cons(p, cf_pen)
        and any(clausula(scale, p, f, cf_pen, cf_fin) is None for f in allowed[n - 1])
    ]
    free_pos = rules.passing | rules.neighbour
    # Musica ficta in the penultimate bar: the raised sixth and seventh (F#
    # and G# before A), so the line can rise to the final by whole steps.
    ficta = sorted(pool + [p for p in range(lo, hi + 1) if p % 12 in scale.ficta])
    last_bar = events[n - 1].tick - BAR
    for k in range(n - 3, -1, -1):
        ev, nxt = events[k], events[k + 1]
        c = cf_at[k]
        assert c is not None
        opts = [p for p in (ficta if ev.tick >= last_bar else pool) if side(p, c)]
        if not ev.tie and position(ev.tick) not in free_pos:
            opts = [p for p in opts if cons(p, c)]
        if k == 0:
            opts = [
                p
                for p in opts
                if ((p - c) % 12 in (0, 7) if above else (c - p) % 12 == 0)
            ]
        ahead = allowed[k + 1]
        allowed[k] = [
            p
            for p in opts
            if any(
                (q == p and nxt.tie) or melodic_kind(scale, p, q) in ("step", "leap")
                for q in ahead
            )
        ]
    top_ahead = [
        max((max(a) for a in allowed[k:] if a), default=-1) for k in range(n + 1)
    ]

    def cands(k: int, s: Search) -> list[int]:
        ev = events[k]
        c = cf_at[k]
        assert c is not None
        prev = s.pitches[-1] if s.pitches else None

        def extra(p: int) -> float:
            cost = 0.0
            if abs(p - c) > 16:
                cost += 2.0
            if ev.tie and prev is not None:
                cost += -12.0 if p == prev else 6.0
            if ev.tick % BAR == 0 and not ev.tie:
                g = abs(scale.degree(p) - scale.degree(c)) % 7
                cost += -1.0 if g in (2, 5) else 0.0
            if species in (4, 5) and not ev.tie and k + 1 < n and events[k + 1].tie:
                nxt = cf_at[k + 1]
                if nxt is not None and ev.tick + ev.ticks == events[k + 1].tick:
                    kind = suspension_kind(scale, p, nxt)
                    ok = {"7-6", "4-3"} if above else {"2-3"}
                    if kind in ok and consonant(scale, scale.transpose(p, -1), nxt):
                        cost -= 5.0
                    elif not consonant(scale, p, nxt):
                        cost += 6.0
            return cost

        opts = allowed[k]
        if prev is not None:
            opts = [
                p
                for p in opts
                if (ev.tie and p == prev)
                or melodic_kind(scale, prev, p) in ("step", "leap")
            ]
        top = max(s.pitches) if s.pitches else None

        def cost(p: int) -> float:
            # Coming back to the highest note so far spends the climax.
            return extra(p) + (6.0 if p == top and not ev.tie and k < n - 1 else 0.0)

        return rank(opts, prev, s.rng, cost)

    def step_ok(k: int, s: Search) -> bool:
        # A second highest note is fine only while a higher one can still come.
        top = max(s.pitches)
        if s.pitches.count(top) > 1:
            reach = min(top_ahead[k + 1], min(s.pitches) + MELODY.max_range)
            if reach <= top:
                return False
        if species != 4 or not events[k].tie:
            return True
        broken = sum(
            1
            for i in range(1, k + 1)
            if events[i].tie and s.pitches[i] != s.pitches[i - 1]
        )
        return broken <= MAX_BROKEN_TIES

    return cands, step_ok


def _species_payload(
    piece: Piece,
    ctx: SpeciesContext,
    inv: Piece | None,
    scale: Scale,
    species: int,
    above: bool,
    seed: int,
    invertible: int | None,
    pattern: Sequence[str],
) -> dict[str, Any]:
    cpl, cfl = piece.lines[ctx.cp], piece.lines[ctx.cf]
    violations = (
        piece.flags()
        + melody_flags(piece, ctx.cp)
        + species_global(piece, ctx, rhythm=True)
    )
    out: dict[str, Any] = {
        "species": species,
        "position": "above" if above else "below",
        "key": scale.label,
        "ppq": PPQ,
        "bar_ticks": BAR,
        "seed": seed,
        "invertible": invertible,
        "order": piece.names,
        "parts": {"counterpoint": cpl.notes(), "cantus": cfl.notes()},
        "suspensions": find_suspensions(piece, ctx),
        "rhythm": list(pattern),
        "violations": [f.as_dict() for f in violations],
        "flags": [f.as_dict() for f in checker_flags(piece.lines)],
    }
    if inv is not None and invertible:
        upper, lower = (cpl, cfl) if above else (cfl, cpl)
        out["inversion"] = invertible_check(
            upper.notes(), lower.notes(), invertible, scale=scale
        )
    return out


def check_species(
    cantus: Sequence[Any],
    counterpoint: Sequence[Any],
    *,
    species: int,
    key: str | None = None,
    mode: str | None = None,
    above: bool | None = None,
) -> list[Flag]:
    """Every species rule a written counterpoint breaks. The cantus is whole
    notes (``{note, tick, ticks}``, or MIDI numbers laid one a bar from tick
    0); the counterpoint is ``{note, tick, ticks}``."""
    if species not in SPECIES:
        raise CounterpointError(f"species must be one of {SPECIES}")
    if cantus and isinstance(cantus[0], (int, float)):
        cf_notes = [
            {"note": int(p), "tick": i * BAR, "ticks": BAR}
            for i, p in enumerate(cantus)
        ]
    else:
        cf_notes = [dict(n) for n in cantus]
    cf_line = Line("cantus", cf_notes)
    cp_line = Line("counterpoint", counterpoint)
    if not cf_line.pitches or not cp_line.pitches:
        raise CounterpointError("a cantus and a counterpoint are needed")
    scale = parse_scale(key, mode) if key else infer_scale(cf_line.pitches, mode)
    if above is None:
        above = sum(cp_line.pitches) / len(cp_line.pitches) >= sum(
            cf_line.pitches
        ) / len(cf_line.pitches)
    start = cf_line.starts[0]
    piece, ctx, _i, _c, _l = _species_setup(
        cf_line.pitches, scale, species, above, start, None, cp_line, cf_line
    )
    ctx.first_tick = cp_line.starts[0]
    flags = (
        piece.flags()
        + melody_flags(piece, ctx.cp)
        + species_global(piece, ctx, rhythm=True)
    )
    flags.sort(key=lambda f: (f.tick, f.rule))
    return flags


# ---------------------------------------------------------------------------
# invertible counterpoint
# ---------------------------------------------------------------------------


def invert_pair(
    upper: Line, lower: Line, interval: int, scale: Scale
) -> tuple[Line, Line]:
    """The pair inverted at the ``interval`` (8, 10, 12): the lower voice moves
    up that far, diatonically, and becomes the upper voice."""
    steps = interval - 1
    moved = Line(lower.name)
    for p, s, e in zip(lower.pitches, lower.starts, lower.ends):
        moved.append(scale.transpose(p, steps), s, e)
    return moved, upper.copy()


def invertible_check(
    upper: Sequence[Any],
    lower: Sequence[Any],
    interval: int,
    *,
    key: str | None = None,
    mode: str | None = None,
    scale: Scale | None = None,
    rules: Rules = FREE,
    names: tuple[str, str] = ("upper", "lower"),
) -> dict[str, Any]:
    """Whether a two-voice pair is clean as written and inverted at the octave,
    tenth or twelfth. Both versions go through the dissonance and motion rules
    here and through the four-part checker."""
    if interval not in INVERTIBLE_AT:
        raise CounterpointError(f"invertible counterpoint is at {INVERTIBLE_AT}")
    up = Line(names[0], upper)
    lo = Line(names[1], lower)
    if not up.pitches or not lo.pitches:
        raise CounterpointError("both voices need notes")
    if scale is None:
        scale = (
            parse_scale(key, mode)
            if key
            else infer_scale(lo.pitches + up.pitches, mode)
        )
    new_up, new_lo = invert_pair(up, lo, interval, scale)
    original = Piece([up, lo], scale, rules)
    inverted = Piece([new_up, new_lo], scale, rules)
    res = {}
    for label, pc in (("original", original), ("inverted", inverted)):
        res[label] = {
            "violations": [f.as_dict() for f in pc.flags()],
            "flags": [f.as_dict() for f in checker_flags(pc.lines)],
        }
    ok = all(not res[k]["violations"] and not res[k]["flags"] for k in res)
    return {
        "ok": ok,
        "interval": interval,
        "key": scale.label,
        "original": res["original"],
        "inverted": {
            **res["inverted"],
            "parts": {new_up.name: new_up.notes(), new_lo.name: new_lo.notes()},
            "order": [new_up.name, new_lo.name],
        },
    }
