"""Four-part voice-leading checker on music21.

``check_parts`` takes parts as lists of notes in ticks, cuts them into slices
at every onset, and flags, per slice or per move between two slices:

* ``parallel_fifths`` / ``parallel_octaves``: two voices that both move and
  keep a perfect fifth or an octave (unisons and compound intervals count, as
  do antiparallel fifths and octaves).
* ``hidden_fifths`` / ``hidden_octaves``: the outer voices reach a fifth or an
  octave in similar motion while the top voice leaps (a step in the top voice
  is the common-practice exception).
* ``voice_crossing``: a voice below the voice under it.
* ``voice_overlap``: a voice moving past where its neighbour just was.
* ``spacing``: more than an octave between two adjacent upper voices.
* ``range``: a note outside its part's range.
* ``unresolved_leading_tone``: a leading tone of a dominant-function chord
  (V, V7, vii°, vii°7, viiø7 and applied dominants) that does not rise a
  half step to its tonic when the harmony changes. An inner voice may drop to
  the fifth of the tonic chord instead, and a leading tone that the next chord
  keeps may be held.
* ``unresolved_seventh``: a chordal seventh that does not fall by step when
  the harmony changes. A seventh over the fifth in the bass (V4/3) may rise by
  step when the bass rises by step.

The motion rules run through ``music21.voiceLeading.VoiceLeadingQuartet``,
with the pitches spelled from the chord and key. The same rules are also
applied to the semitone intervals, so a pair that sounds as a fifth under an
enharmonic spelling still counts. The tendency-tone rules need to know the
harmony: from the ``chords`` the caller passes (roman figures with local keys),
or, without them, from music21's ``romanNumeralFromChord`` in the given key.

The planner's voicing search (harmony.py) prunes with ``transition_forbidden``,
the same integer rules vectorised over every pair of candidate voicings, and
then runs its answer through this checker.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from itertools import combinations
from typing import Any, Iterable, Mapping, Sequence

import numpy as np
from music21 import chord as m21chord
from music21 import key as m21key
from music21 import note as m21note
from music21 import pitch as m21pitch
from music21 import roman
from music21 import voiceLeading

from .meter import MeterGrid
from .spec import DEFAULT_RANGES, RULES, SATB

__all__ = ["DEFAULT_RANGES", "RULES", "SATB", "check_parts", "parse_key"]

PERFECT = (0, 7)
AUG6_PREFIXES = ("It", "Fr", "Ger")


# ---------------------------------------------------------------------------
# keys and spelling
# ---------------------------------------------------------------------------


def parse_key(text: str, mode: str | None = None) -> m21key.Key:
    """A music21 Key from "C", "f#", "Bb major", "F# minor" or ("Bb", "minor").

    Without a mode word, an uppercase letter is major and a lowercase one
    minor, as music21 reads key names. ``b`` after the letter is a flat."""
    raw = (text or "").strip()
    if not raw:
        raise ValueError("a key needs a tonic")
    words = raw.split()
    tonic = words[0]
    rest = [w.lower() for w in words[1:]]
    word_mode = next((w for w in rest if w in ("major", "minor")), None)
    chosen = (mode or word_mode or "").lower() or None
    letter = tonic[0]
    if letter.upper() not in "ABCDEFG":
        raise ValueError(f"not a key tonic: {text!r}")
    acc = tonic[1:].replace("♯", "#").replace("♭", "-").replace("b", "-")
    if any(c not in "#-" for c in acc):
        raise ValueError(f"not a key tonic: {text!r}")
    if chosen is None:
        chosen = "minor" if letter.islower() else "major"
    if chosen not in ("major", "minor"):
        raise ValueError(f"mode must be major or minor, not {mode!r}")
    return m21key.Key(letter.upper() + acc, chosen)


def key_label(k: m21key.Key) -> str:
    return f"{k.tonic.name.replace('-', 'b')} {k.mode}"


def key_spelling(k: m21key.Key) -> dict[int, str]:
    """pc -> name for the key's scale, with the raised sixth and seventh in minor."""
    out = {p.pitchClass: p.name for p in k.getScale().getPitches()}
    if k.mode == "minor":
        for degree in (6, 7):
            p = k.pitchFromDegree(degree).transpose("A1")
            out.setdefault(p.pitchClass, p.name)
    return out


def spelled_pitch(midi: int, spelling: Mapping[int, str] | None) -> m21pitch.Pitch:
    name = (spelling or {}).get(midi % 12)
    if not name:
        return m21pitch.Pitch(midi=midi)
    p = m21pitch.Pitch(name)
    p.octave = 4
    p.octave += (midi - p.midi) // 12
    return p


def name_of(midi: int, spelling: Mapping[int, str] | None = None) -> str:
    return spelled_pitch(midi, spelling).nameWithOctave.replace("-", "b")


# ---------------------------------------------------------------------------
# harmony context
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Harmony:
    """What the tendency rules need to know about a chord."""

    key_label: str
    figure: str | None
    pcs: frozenset[int]
    root_pc: int | None
    third_pc: int | None
    fifth_pc: int | None
    seventh_pc: int | None
    lt_pc: int | None
    lt_target_pc: int | None
    major_like: bool
    chromatic_third: bool
    inversion: int
    ident: tuple
    spelling: tuple[tuple[int, str], ...] = field(default=())

    @property
    def spell(self) -> dict[int, str]:
        return dict(self.spelling)


def is_aug6(figure: str | None) -> bool:
    return bool(figure) and figure.startswith(AUG6_PREFIXES)


def harmony_from_roman(rn: roman.RomanNumeral) -> Harmony:
    k: m21key.Key = rn.key if isinstance(rn.key, m21key.Key) else m21key.Key("C")
    sec = rn.secondaryRomanNumeralKey
    func_key = sec if isinstance(sec, m21key.Key) else k
    pcs = frozenset(p.pitchClass for p in rn.pitches)
    root = rn.root().pitchClass if rn.root() is not None else None
    third = rn.third.pitchClass if rn.third is not None else None
    fifth = rn.fifth.pitchClass if rn.fifth is not None else None
    aug6 = is_aug6(rn.figure)
    seventh = None
    if not aug6 and rn.seventh is not None and len(pcs) >= 4:
        seventh = rn.seventh.pitchClass
    tonic = func_key.tonic.pitchClass
    ltpc = (tonic - 1) % 12
    lt = target = None
    if not aug6 and root is not None and ltpc in pcs:
        dominant = root == (tonic + 7) % 12 and third == ltpc
        leading = root == ltpc
        if dominant or leading:
            lt, target = ltpc, tonic
    major_like = (
        root is not None
        and third == (root + 4) % 12
        and (fifth is None or fifth == (root + 7) % 12)
        and (seventh is None or seventh == (root + 10) % 12)
    )
    scale_pcs = set(key_spelling(k))
    chromatic_third = third is not None and third not in scale_pcs
    spelling = key_spelling(k)
    spelling.update({p.pitchClass: p.name for p in rn.pitches})
    ident: tuple
    if aug6:
        ident = (key_label(k), "aug6", rn.figure[:2])
    else:
        ident = (key_label(k), root, key_label(sec) if sec is not None else None)
    try:
        inversion = int(rn.inversion())
    except Exception:
        # A chord music21 cannot invert counts as root position.
        inversion = 0
    return Harmony(
        key_label=key_label(k),
        figure=rn.figure,
        pcs=pcs,
        root_pc=root,
        third_pc=third,
        fifth_pc=fifth,
        seventh_pc=seventh,
        lt_pc=lt,
        lt_target_pc=target,
        major_like=major_like,
        chromatic_third=chromatic_third,
        inversion=inversion,
        ident=ident,
        spelling=tuple(sorted(spelling.items())),
    )


def harmony_from_pitches(midis: Iterable[int], k: m21key.Key) -> Harmony | None:
    """The harmony music21 reads in these pitches, spelled in key ``k``."""
    spell = key_spelling(k)
    pitches = [spelled_pitch(m, spell) for m in sorted(set(midis))]
    if len(pitches) < 2:
        return None
    try:
        rn = roman.romanNumeralFromChord(m21chord.Chord(pitches), k)
    except Exception:
        # A cluster music21 cannot name has no tendency tones.
        return None
    return harmony_from_roman(rn)


def harmony_from_names(
    bass: m21pitch.Pitch, names: Iterable[str], k: m21key.Key
) -> Harmony | None:
    """The harmony of a bass pitch and the spelled pitch names above it (a
    figured-bass segment's chord)."""
    pitches = [m21pitch.Pitch(bass.nameWithOctave)]
    for name in names:
        p = m21pitch.Pitch(name)
        p.octave = (bass.octave or 3) + 1
        pitches.append(p)
    try:
        rn = roman.romanNumeralFromChord(m21chord.Chord(pitches), k)
    except Exception:
        # A chord music21 cannot name has no tendency tones.
        return None
    return harmony_from_roman(rn)


def harmony_for(figure: str, k: m21key.Key) -> Harmony:
    return harmony_from_roman(roman.RomanNumeral(figure, k))


def requirements(h1: Harmony | None, h2: Harmony | None) -> list[tuple[str, int, int]]:
    """Tendency tones of ``h1`` that must resolve when it moves to ``h2``:
    ``("leading_tone", pc, target_pc)`` and ``("seventh", pc, -1)``."""
    if h1 is None or h2 is None or h1.ident == h2.ident:
        return []
    out: list[tuple[str, int, int]] = []
    if h1.lt_pc is not None and h1.lt_target_pc in h2.pcs:
        out.append(("leading_tone", h1.lt_pc, h1.lt_target_pc))
    elif (
        h1.lt_pc is None
        and h1.major_like
        and h1.third_pc is not None
        and h1.root_pc is not None
        and (h1.chromatic_third or h1.seventh_pc is not None)
        and h2.root_pc == (h1.root_pc + 5) % 12
    ):
        # A chromatic major chord or a dominant seventh moving down a fifth:
        # an applied dominant music21 did not name (inferred harmony).
        out.append(("leading_tone", h1.third_pc, h2.root_pc))
    if h1.seventh_pc is not None:
        out.append(("seventh", h1.seventh_pc, -1))
    return out


# ---------------------------------------------------------------------------
# the rules on integers
# ---------------------------------------------------------------------------


def _ic(a: int, b: int) -> int:
    return abs(a - b) % 12


def tendency_ok(
    kind: str,
    target: int,
    a: int,
    b: int,
    inner: bool,
    h1: Harmony,
    h2: Harmony,
    bass_move: int | None,
) -> bool:
    m = b - a
    if kind == "leading_tone":
        if m == 1 and b % 12 == target:
            return True
        if m == 0 and (a % 12) in h2.pcs:
            return True
        return (
            inner
            and h2.root_pc == target
            and h2.fifth_pc is not None
            and b % 12 == h2.fifth_pc
            and -4 <= m < 0
        )
    # seventh
    if m in (-1, -2):
        return True
    return h1.inversion == 2 and m in (1, 2) and bass_move in (1, 2)


# ---------------------------------------------------------------------------
# vectorised rules for the voicing search
# ---------------------------------------------------------------------------


def transition_forbidden(
    P: np.ndarray, Q: np.ndarray, h1: Harmony | None, h2: Harmony | None
) -> np.ndarray:
    """(len(P), len(Q)) booleans: True where moving from voicing P[i] to Q[j]
    breaks a motion or tendency rule. Rows are voicings top voice first."""
    n = P.shape[1]
    M = Q[None, :, :] - P[:, None, :]
    bad = np.zeros((P.shape[0], Q.shape[0]), dtype=bool)
    for i, j in combinations(range(n), 2):
        ia = np.abs(P[:, i] - P[:, j]) % 12
        ib = np.abs(Q[:, i] - Q[:, j]) % 12
        mi, mj = M[:, :, i], M[:, :, j]
        both = (mi != 0) & (mj != 0)
        same = ia[:, None] == ib[None, :]
        arrive = np.isin(ib, PERFECT)[None, :]
        bad |= both & same & arrive
        if i == 0 and j == n - 1:
            similar = both & (np.sign(mi) == np.sign(mj))
            bad |= similar & arrive & ~same & (np.abs(mi) > 2)
    for i in range(n - 1):
        bad |= Q[None, :, i] < P[:, None, i + 1]
        bad |= Q[None, :, i + 1] > P[:, None, i]
    for kind, pc, target in requirements(h1, h2):
        assert h1 is not None and h2 is not None
        for v in range(n):
            has = (P[:, v] % 12 == pc)[:, None]
            m = M[:, :, v]
            land = (Q[:, v] % 12)[None, :]
            if kind == "leading_tone":
                ok = (m == 1) & (land == target)
                if pc in h2.pcs:
                    ok |= m == 0
                if 0 < v < n - 1 and h2.root_pc == target and h2.fifth_pc is not None:
                    ok |= (land == h2.fifth_pc) & (m < 0) & (m >= -4)
            else:
                ok = (m == -1) | (m == -2)
                if h1.inversion == 2:
                    bm = M[:, :, n - 1]
                    ok |= ((m == 1) | (m == 2)) & ((bm == 1) | (bm == 2))
            bad |= has & ~ok
    return bad


# ---------------------------------------------------------------------------
# the checker
# ---------------------------------------------------------------------------


@dataclass
class Slice:
    tick: int
    pitches: tuple[int | None, ...]
    harmony: Harmony | None
    onsets: tuple[bool, ...] = ()


@dataclass
class Flag:
    bar: int
    beat: int
    tick: int
    parts: list[str]
    rule: str
    message: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "bar": self.bar,
            "beat": self.beat,
            "tick": self.tick,
            "parts": list(self.parts),
            "rule": self.rule,
            "message": self.message,
        }


def resolve_ranges(
    names: Sequence[str], ranges: Mapping[str, Sequence[int]] | None
) -> dict[str, tuple[int, int]]:
    out: dict[str, tuple[int, int]] = {}
    for name in names:
        if name in DEFAULT_RANGES:
            out[name] = DEFAULT_RANGES[name]
    for name, pair in (ranges or {}).items():
        lo, hi = int(pair[0]), int(pair[1])
        out[name] = (min(lo, hi), max(lo, hi))
    return out


def _m21(midi: int, spell: Mapping[int, str]) -> m21note.Note:
    n = m21note.Note()
    n.pitch = spelled_pitch(midi, spell)
    return n


def check_slices(
    slices: Sequence[Slice],
    names: Sequence[str],
    ranges: Mapping[str, tuple[int, int]],
    grid: MeterGrid,
    key_spell: Mapping[int, str] | None = None,
) -> list[Flag]:
    """Every flag in a run of slices whose pitches are listed top voice first."""
    flags: list[Flag] = []
    seen: set[tuple] = set()
    n = len(names)

    def add(tick: int, idx: Sequence[int], rule: str, message: str, sig: tuple) -> None:
        k = (rule, tuple(idx), sig)
        if k in seen:
            return
        seen.add(k)
        bar, beat = grid.locate(tick)
        flags.append(Flag(bar, beat, tick, [names[i] for i in idx], rule, message))

    def spell_for(s: Slice) -> dict[int, str]:
        sp = dict(key_spell or {})
        if s.harmony is not None:
            sp.update(s.harmony.spell)
        return sp

    prev_static: set[tuple] = set()
    for si, s in enumerate(slices):
        sp = spell_for(s)
        here: set[tuple] = set()
        sounding = [(i, p) for i, p in enumerate(s.pitches) if p is not None]
        for i, p in sounding:
            lo_hi = ranges.get(names[i])
            if lo_hi and not (lo_hi[0] <= p <= lo_hi[1]):
                sig = ("range", i, p)
                here.add(sig)
                if sig not in prev_static:
                    add(
                        s.tick,
                        [i],
                        "range",
                        f"{names[i].capitalize()} {name_of(p, sp)} is outside its range "
                        f"{name_of(lo_hi[0])}-{name_of(lo_hi[1])}.",
                        (s.tick,),
                    )
        for (i, p), (j, q) in zip(sounding, sounding[1:]):
            if p < q:
                sig = ("cross", i, j, p, q)
                here.add(sig)
                if sig not in prev_static:
                    add(
                        s.tick,
                        [i, j],
                        "voice_crossing",
                        f"{names[i].capitalize()} {name_of(p, sp)} is below "
                        f"{names[j]} {name_of(q, sp)}.",
                        (s.tick,),
                    )
            if j < n - 1 and p - q > 12:
                sig = ("space", i, j, p, q)
                here.add(sig)
                if sig not in prev_static:
                    add(
                        s.tick,
                        [i, j],
                        "spacing",
                        f"{names[i].capitalize()} and {names[j]} are more than an octave "
                        f"apart ({name_of(p, sp)} over {name_of(q, sp)}).",
                        (s.tick,),
                    )
        prev_static = here
        if si == 0:
            continue
        a = slices[si - 1]
        spa = spell_for(a)
        pairs = [
            (i, j)
            for i, j in combinations(range(n), 2)
            if None not in (a.pitches[i], a.pitches[j], s.pitches[i], s.pitches[j])
        ]
        lowest = max(
            (
                i
                for i in range(n)
                if a.pitches[i] is not None and s.pitches[i] is not None
            ),
            default=None,
        )
        highest = min(
            (
                i
                for i in range(n)
                if a.pitches[i] is not None and s.pitches[i] is not None
            ),
            default=None,
        )
        for i, j in pairs:
            a_i, a_j = a.pitches[i], a.pitches[j]
            b_i, b_j = s.pitches[i], s.pitches[j]
            assert (
                a_i is not None
                and a_j is not None
                and b_i is not None
                and b_j is not None
            )
            mi, mj = b_i - a_i, b_j - a_j
            if mi == 0 and mj == 0:
                continue
            vlq = voiceLeading.VoiceLeadingQuartet(
                _m21(a_i, spa), _m21(b_i, sp), _m21(a_j, spa), _m21(b_j, sp)
            )
            both = mi != 0 and mj != 0
            ia, ib = _ic(a_i, a_j), _ic(b_i, b_j)
            int_par = both and ia == ib and ib in PERFECT
            fifth = vlq.parallelFifth() or (int_par and ib == 7)
            octave = (
                vlq.parallelOctave() or vlq.parallelUnison() or (int_par and ib == 0)
            )
            moves = (
                f"({name_of(a_i, spa)}/{name_of(a_j, spa)} to "
                f"{name_of(b_i, sp)}/{name_of(b_j, sp)})"
            )
            if fifth:
                add(
                    s.tick,
                    [i, j],
                    "parallel_fifths",
                    f"Parallel fifths between {names[i]} and {names[j]} {moves}.",
                    (s.tick,),
                )
            elif octave:
                add(
                    s.tick,
                    [i, j],
                    "parallel_octaves",
                    f"Parallel octaves between {names[i]} and {names[j]} {moves}.",
                    (s.tick,),
                )
            elif i == highest and j == lowest and abs(mi) > 2:
                similar = both and (mi > 0) == (mj > 0)
                int_hidden = similar and ib in PERFECT and ia != ib
                if vlq.hiddenFifth() or (int_hidden and ib == 7):
                    add(
                        s.tick,
                        [i, j],
                        "hidden_fifths",
                        f"Hidden fifth between the outer voices {moves}: "
                        f"the {names[i]} leaps into it.",
                        (s.tick,),
                    )
                elif vlq.hiddenOctave() or (int_hidden and ib == 0):
                    add(
                        s.tick,
                        [i, j],
                        "hidden_octaves",
                        f"Hidden octave between the outer voices {moves}: "
                        f"the {names[i]} leaps into it.",
                        (s.tick,),
                    )
            if j == i + 1 and (vlq.voiceOverlap() or b_i < a_j or b_j > a_i):
                add(
                    s.tick,
                    [i, j],
                    "voice_overlap",
                    f"{names[i].capitalize()} and {names[j]} overlap {moves}.",
                    (s.tick,),
                )
        reqs = requirements(a.harmony, s.harmony)
        if not reqs:
            continue
        assert a.harmony is not None and s.harmony is not None
        bass_idx = lowest
        bass_move = None
        if bass_idx is not None:
            pa, pb = a.pitches[bass_idx], s.pitches[bass_idx]
            if pa is not None and pb is not None:
                bass_move = pb - pa
        for kind, pc, target in reqs:
            for v in range(n):
                pa, pb = a.pitches[v], s.pitches[v]
                if pa is None or pb is None or pa % 12 != pc:
                    continue
                inner = v not in (highest, lowest)
                if tendency_ok(
                    kind, target, pa, pb, inner, a.harmony, s.harmony, bass_move
                ):
                    continue
                if kind == "leading_tone":
                    add(
                        a.tick,
                        [v],
                        "unresolved_leading_tone",
                        f"Leading tone {name_of(pa, spa)} in the {names[v]} "
                        f"({a.harmony.figure}, {a.harmony.key_label}) goes to "
                        f"{name_of(pb, sp)}, not up to "
                        f"{m21pitch.Pitch(target).name.replace('-', 'b')}.",
                        (a.tick,),
                    )
                else:
                    add(
                        a.tick,
                        [v],
                        "unresolved_seventh",
                        f"Chordal seventh {name_of(pa, spa)} in the {names[v]} "
                        f"({a.harmony.figure}, {a.harmony.key_label}) goes to "
                        f"{name_of(pb, sp)}, not down by step.",
                        (a.tick,),
                    )
    flags.sort(key=lambda f: (f.tick, RULES.index(f.rule), f.parts))
    return flags


def order_parts(
    parts: Mapping[str, Sequence[Any]], order: Sequence[str] | None
) -> list[str]:
    """Top voice first: the caller's order, else SATB names in SATB order and
    any other part by its average pitch, highest first."""
    names = list(parts)
    if order:
        missing = [n for n in order if n not in parts]
        if missing:
            raise ValueError(f"order names parts that are not given: {missing}")
        return list(order) + [n for n in names if n not in order]

    def avg(n: str) -> float:
        notes = parts[n]
        return -sum(_note_pitch(x) for x in notes) / len(notes) if notes else 0.0

    satb = [n for n in SATB if n in parts]
    other = sorted((n for n in names if n not in SATB), key=avg)
    if satb and other:
        return sorted(names, key=avg)
    return satb + other


def _get(x: Any, k: str, default: Any = None) -> Any:
    return x.get(k, default) if isinstance(x, Mapping) else getattr(x, k, default)


def _note_pitch(x: Any) -> int:
    v = _get(x, "note")
    if v is None:
        v = _get(x, "pitch")
    return int(v)


def slices_from_parts(
    parts: Mapping[str, Sequence[Any]],
    names: Sequence[str],
    harmonies_at: Any,
) -> list[Slice]:
    """Cut notes (``{note, tick, ticks}``) into slices at every onset."""
    spans: list[list[tuple[int, int, int]]] = []
    onsets: set[int] = set()
    for name in names:
        row = []
        for x in parts[name]:
            t0 = int(_get(x, "tick"))
            t1 = t0 + max(1, int(_get(x, "ticks")))
            row.append((t0, t1, _note_pitch(x)))
            onsets.add(t0)
        row.sort()
        spans.append(row)
    out: list[Slice] = []
    for t in sorted(onsets):
        pitches: list[int | None] = []
        starts: list[bool] = []
        for row in spans:
            here = [p for (t0, t1, p) in row if t0 <= t < t1]
            pitches.append(max(here) if here else None)
            starts.append(any(t0 == t for (t0, _t1, _p) in row))
        out.append(Slice(t, tuple(pitches), None, tuple(starts)))
    for s in out:
        s.harmony = harmonies_at(s)
    return out


def check_parts(
    parts: Mapping[str, Sequence[Any]],
    *,
    key: m21key.Key | None = None,
    chords: Sequence[Any] | None = None,
    ranges: Mapping[str, Sequence[int]] | None = None,
    meter_map: Sequence[Any] | None = None,
    pickup_steps: float = 0,
    order: Sequence[str] | None = None,
) -> list[Flag]:
    """Check parts given as ``{name: [{note, tick, ticks}, ...]}``.

    ``chords`` (``[{tick, figure, key}]``) name the harmony from each tick on;
    without them the harmony of each slice is read in ``key``. Without a key
    either, music21 guesses one from all the notes."""
    names = order_parts(parts, order)
    grid = MeterGrid(meter_map, pickup_steps)
    rng = resolve_ranges(names, ranges)
    if key is None and not chords:
        key = _guess_key(parts)
    planned: list[tuple[int, Harmony]] = []
    for c in chords or []:
        k = parse_key(str(_get(c, "key"))) if _get(c, "key") else key
        if k is None:
            raise ValueError("a chord without a key needs the request's key")
        planned.append((int(_get(c, "tick")), harmony_for(str(_get(c, "figure")), k)))
    planned.sort(key=lambda x: x[0])

    def harmonies_at(s: Slice) -> Harmony | None:
        if planned:
            h = None
            for t, ph in planned:
                if t <= s.tick:
                    h = ph
            return h
        if key is None:
            return None
        return harmony_from_pitches([p for p in s.pitches if p is not None], key)

    slices = slices_from_parts(parts, names, harmonies_at)
    return check_slices(slices, names, rng, grid, key_spelling(key) if key else None)


def _guess_key(parts: Mapping[str, Sequence[Any]]) -> m21key.Key | None:
    from music21 import stream

    s = stream.Stream()
    for notes in parts.values():
        for x in notes:
            n = m21note.Note(midi=_note_pitch(x))
            n.quarterLength = max(1, int(_get(x, "ticks"))) / 960
            s.insert(int(_get(x, "tick")) / 960, n)
    if not s.notes:
        return None
    try:
        k = s.analyze("key")
    except Exception:
        # No key means no tendency-tone checks.
        return None
    return k if isinstance(k, m21key.Key) else None
