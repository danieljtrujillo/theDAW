"""Style profiles: what a composer's scores do, counted from the scores.

:func:`extract_profile` reads public-domain scores (the music21 corpus through
``sheetimport.corpus``, or a composition the user imported) and counts:

* **vocabulary**: roman-numeral chords by mode, from the harmony of every
  half beat (a third of a dotted beat) read against the local key
  (:mod:`.romans`). The pitch classes sounding in the half beat, weighted by
  how long they sound, lose their lightest non-bass tones until a triad or a
  seventh chord is left, which drops passing and neighbour tones; a slice
  with no chord in it carries the chord before it on.
* **cadences** by the planner's six types, at every phrase end: a fermata, the
  last chord of a whole piece, and (in a piece with no fermatas) a strong
  pulse where the top part holds two pulses or holds one and rests.
* **harmonic rhythm**: chord changes per bar and per pulse (the meter's beat
  groups: beats of a simple meter, dotted beats of a compound one).
* **texture**: the mean number of parts sounding on a pulse, and a homophony
  score, the mean share of sounding parts that attack together at an attack.
* **meter devices**: the meters by bars, the hemiola rate (triple bar pairs,
  or compound bars, whose outer parts move in twos) and the syncopation rate
  (notes that start on a weaker position and hold through a stronger one).
* **intervals**: melodic intervals in semitones in every part.
* **orchestration**: a preset name for the forces the sample is written for.

A profile carries the works it was counted from. A profile written from
harmony textbooks for a composer the corpus does not hold says so with
``"source": "authored"`` and a one-line ``basis``; :func:`validate_profile`
holds both kinds to the same schema.
"""

from __future__ import annotations

import logging
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from functools import lru_cache
from itertools import combinations
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional, Sequence

import numpy as np

from .romans import (
    chord_roman,
    display_figure,
    global_key,
    key_from_index,
    key_name,
    local_keys,
    vocab_label,
    window_vectors,
)
from .spec import CADENCES
from .stylebook import (
    INTERVAL_BUCKETS,
    SCHEMA,
    SCHEMA_VERSION,
    STYLES_DIR,
    ProfileError,
    list_styles,
    load_style,
    style_ids,
    validate_profile,
)

log = logging.getLogger(__name__)

#: Chords under this share of a mode's vocabulary are left out of the profile.
VOCAB_FLOOR = 0.002
EPS = 1e-6

# Interval sets (from the root) that count as a chord: triads, seventh chords,
# sevenths without their fifth, and the French sixth (the Italian and German
# sixths share a set with the incomplete and complete dominant seventh).
CHORD_SETS = frozenset(
    frozenset(s)
    for s in (
        (0, 4, 7),
        (0, 3, 7),
        (0, 3, 6),
        (0, 4, 8),
        (0, 4, 7, 10),
        (0, 4, 7, 11),
        (0, 3, 7, 10),
        (0, 3, 6, 10),
        (0, 3, 6, 9),
        (0, 4, 10),
        (0, 3, 10),
        (0, 4, 11),
        (0, 4, 6, 10),
    )
)
DOMINANTS = {"V", "V7", "viio", "viio7", "viiø7"}
TONICS = {"I", "i"}


# ---------------------------------------------------------------------------
# one score
# ---------------------------------------------------------------------------


@dataclass
class Tally:
    """Counts from one or more scores; :meth:`add` merges another tally."""

    works: list[str] = field(default_factory=list)
    bars: int = 0
    pulses: int = 0
    changes: int = 0
    vocab: dict[str, Counter] = field(
        default_factory=lambda: {"major": Counter(), "minor": Counter()}
    )
    modes: Counter = field(default_factory=Counter)
    cadences: Counter = field(default_factory=Counter)
    cadence_other: int = 0
    voices_sum: float = 0.0
    voices_n: int = 0
    homophony_sum: float = 0.0
    homophony_n: int = 0
    meters: Counter = field(default_factory=Counter)
    hemiola: int = 0
    hemiola_eligible: int = 0
    syncopated: int = 0
    notes: int = 0
    intervals: Counter = field(default_factory=Counter)
    orchestrations: Counter = field(default_factory=Counter)

    def add(self, other: "Tally") -> None:
        self.works.extend(other.works)
        for name in (
            "bars",
            "pulses",
            "changes",
            "cadence_other",
            "voices_sum",
            "voices_n",
            "homophony_sum",
            "homophony_n",
            "hemiola",
            "hemiola_eligible",
            "syncopated",
            "notes",
        ):
            setattr(self, name, getattr(self, name) + getattr(other, name))
        for mode in ("major", "minor"):
            self.vocab[mode].update(other.vocab[mode])
        for name in ("modes", "cadences", "meters", "intervals", "orchestrations"):
            getattr(self, name).update(getattr(other, name))


@dataclass
class _Events:
    start: np.ndarray
    end: np.ndarray
    midi: np.ndarray
    part: np.ndarray
    names: list[str]  # nameWithOctave, as the score spells it


@dataclass
class _Pulse:
    start: float
    length: float
    accent: float
    bar: int
    subdivisions: int


@dataclass
class _Harmony:
    start: float
    end: float
    label: str
    figure: str
    key: int
    inversion: int
    top_pc: int
    accent: float
    root_pc: int = -1
    names: tuple[str, ...] = ()


def _first_score(parsed: Any) -> Any:
    from music21 import stream

    if isinstance(parsed, stream.Opus):
        scores = list(parsed.scores)
        if not scores:
            raise ProfileError("the file holds no score")
        return scores[0]
    return parsed


def _parts(score: Any) -> list[Any]:
    parts = list(getattr(score, "parts", []) or [])
    return parts or [score]


def _beat_positions(ts: Any) -> list[tuple[float, float]]:
    """(position in quarters, accent) of each beat group of a time signature."""
    out: list[tuple[float, float]] = []
    pos = 0.0
    try:
        terms = list(ts.beatSequence)
    except Exception:
        terms = []
    if not terms:
        terms = []
        beat = float(ts.beatDuration.quarterLength) or 1.0
        n = max(1, int(round(float(ts.barDuration.quarterLength) / beat)))
        for i in range(n):
            out.append((i * beat, 1.0 if i == 0 else 0.5))
        return out
    for term in terms:
        if pos == 0:
            accent = 1.0
        else:
            try:
                accent = float(ts.getAccentWeight(pos, forcePositionMatch=True))
            except Exception:
                accent = 0.5
        out.append((pos, accent))
        pos += float(term.duration.quarterLength)
    return out


def _pulses(part: Any) -> tuple[list[_Pulse], list[tuple[float, float, Any]]]:
    """Pulses of the whole part, and (start, length, time signature) of each bar."""
    from music21 import meter, stream

    pulses: list[_Pulse] = []
    bars: list[tuple[float, float, Any]] = []
    ts = None
    for bi, m in enumerate(part.getElementsByClass(stream.Measure)):
        if m.timeSignature is not None:
            ts = m.timeSignature
        if ts is None:
            ts = meter.TimeSignature("4/4")
        start = float(m.offset)
        length = float(m.duration.quarterLength)
        pad = float(getattr(m, "paddingLeft", 0.0) or 0.0)
        if length <= 0:
            continue
        bars.append((start, length, ts))
        beats = _beat_positions(ts)
        bounds = [p for p, _ in beats] + [float(ts.barDuration.quarterLength)]
        compound = bool(getattr(ts.beatDuration, "dots", 0))
        for i, (pos, accent) in enumerate(beats):
            at = start + pos - pad
            size = bounds[i + 1] - pos
            if at < start - EPS or at >= start + length - EPS:
                continue
            size = min(size, start + length - at)
            pulses.append(_Pulse(at, size, accent, bi, 3 if compound else 2))
    return pulses, bars


def _events(parts: Sequence[Any]) -> tuple[_Events, list[float], list[list[tuple]]]:
    """Every sounding pitch (ties joined), the offsets of fermatas, and per
    part its (start, length, top midi, is_rest) line."""
    from music21 import expressions, note

    starts: list[float] = []
    ends: list[float] = []
    midis: list[int] = []
    owners: list[int] = []
    names: list[str] = []
    fermatas: list[float] = []
    lines: list[list[tuple]] = []
    for pi, part in enumerate(parts):
        flat = part.flatten()
        for n in flat.notes:
            if any(isinstance(e, expressions.Fermata) for e in n.expressions):
                fermatas.append(float(n.offset))
        line: list[tuple] = []
        for n in part.stripTies().flatten().notesAndRests:
            off = float(n.offset)
            dur = float(n.duration.quarterLength)
            if dur <= 0:
                continue
            if isinstance(n, note.Rest):
                line.append((off, dur, -1, True))
                continue
            pitches = list(n.pitches)
            if not pitches:
                continue
            for p in pitches:
                starts.append(off)
                ends.append(off + dur)
                midis.append(int(p.midi))
                owners.append(pi)
                names.append(p.nameWithOctave)
            line.append((off, dur, max(int(p.midi) for p in pitches), False))
        lines.append(line)
    ev = _Events(
        np.asarray(starts, dtype=float),
        np.asarray(ends, dtype=float),
        np.asarray(midis, dtype=int),
        np.asarray(owners, dtype=int),
        names,
    )
    return ev, fermatas, lines


def is_chord(pcs: Iterable[int]) -> bool:
    """Whether a pitch-class set is a triad, a seventh chord (complete or
    without its fifth) or a French sixth, on any of its tones as root."""
    s = {p % 12 for p in pcs}
    if len(s) < 3:
        return False
    return any(frozenset((p - r) % 12 for p in s) in CHORD_SETS for r in s)


def reduce_to_chord(weights: Mapping[int, float], bass_pc: int) -> Optional[set[int]]:
    """The heaviest chord inside a slice's weighted pitch classes: drop the
    lightest non-bass tones (one, then two, then three) until what is left is
    a chord. None when no chord is there."""
    ordered = sorted(weights, key=lambda pc: -weights[pc])[:6]
    pcs = set(ordered) | {bass_pc}
    if is_chord(pcs):
        return pcs
    others = [pc for pc in pcs if pc != bass_pc]
    for k in (1, 2, 3):
        best: Optional[tuple[float, set[int]]] = None
        for drop in combinations(others, k):
            rest = pcs - set(drop)
            if len(rest) < 3 or not is_chord(rest):
                continue
            lost = sum(weights.get(pc, 0.0) for pc in drop)
            if best is None or lost < best[0] - EPS:
                best = (lost, rest)
        if best is not None:
            return best[1]
    return None


@lru_cache(maxsize=65536)
def _read(
    names: tuple[str, ...], key_idx: int, tonic_name: str
) -> tuple[str, str, int, int]:
    """(vocabulary label, display figure, inversion, root pc) of a chord, bass
    first."""
    from music21 import pitch as m21pitch

    k = key_from_index(key_idx, {key_idx % 12: tonic_name} if tonic_name else None)
    pitches = [m21pitch.Pitch(n) for n in names]
    bass = pitches[0]
    for p in pitches[1:]:
        while p.midi <= bass.midi:
            p.octave = (p.octave or 4) + 1
    rn = chord_roman(pitches, k)
    try:
        inv = int(rn.inversion())
    except Exception:
        inv = 0
    return vocab_label(rn.figure), display_figure(rn), inv, rn.root().pitchClass


def _orchestration(parts: Sequence[Any]) -> str:
    names = " ".join(
        str(getattr(p, "partName", "") or getattr(p, "id", "") or "").lower()
        for p in parts
    )
    voices = sum(
        w in names for w in ("soprano", "alto", "tenor", "bass", "voice", "canto")
    )
    strings = sum(names.count(w) for w in ("violin", "viola", "cello", "violoncello"))
    if len(parts) == 4 and voices >= 3:
        return "satb_choir"
    if len(parts) == 4 and strings >= 3:
        return "string_quartet"
    if len(parts) <= 3 and voices >= 1:
        return "voice_and_continuo"
    if len(parts) <= 2 and ("piano" in names or "keyboard" in names):
        return "piano"
    return "chamber_ensemble"


@dataclass
class _Reading:
    parts: list[Any]
    pulses: list[_Pulse]
    bars: list[tuple[float, float, Any]]
    ev: _Events
    fermatas: list[float]
    lines: list[list[tuple]]
    spellings: dict[int, str]
    keys: list[int]
    harmonies: list[_Harmony]
    whole: bool


def _read_score(score: Any, max_bars: Optional[int]) -> Optional[_Reading]:
    """Pulses, notes, local keys and harmonies of a score (its first
    ``max_bars`` bars when given); None when it has no notes."""
    from music21 import stream

    score = _first_score(score)
    whole = True
    try:
        score = score.toSoundingPitch()
    except Exception:
        pass
    parts = _parts(score)
    if max_bars:
        n_bars = len(parts[0].getElementsByClass(stream.Measure))
        if n_bars > max_bars:
            whole = False
            score = score.measures(0, max_bars)
            parts = _parts(score)
    pulses, bars = _pulses(parts[0])
    ev, fermatas, lines = _events(parts)
    if not pulses or len(ev.start) == 0:
        return None

    spell_count: dict[int, Counter] = defaultdict(Counter)
    for m, n in zip(ev.midi, ev.names):
        spell_count[int(m) % 12][n.rstrip("0123456789")] += 1
    spellings = {pc: c.most_common(1)[0][0] for pc, c in spell_count.items()}

    # Local keys, one per pulse, from a window of about a bar each side.
    centers = np.asarray([p.start + p.length / 2 for p in pulses])
    reach = np.asarray([max(4.0, bars[p.bar][1]) for p in pulses])
    vectors = window_vectors(
        ev.start, ev.end, ev.midi, centers - reach, centers + reach
    )
    whole_vec = window_vectors(ev.start, ev.end, ev.midi, [-1.0], [ev.end.max() + 1])
    keys = local_keys(vectors, prior=global_key(whole_vec[0]))
    harmonies = _harmonies(pulses, keys, ev, spellings)
    return _Reading(
        parts, pulses, bars, ev, fermatas, lines, spellings, keys, harmonies, whole
    )


def harmonic_analysis(
    score: Any, *, max_bars: Optional[int] = None
) -> list[dict[str, Any]]:
    """The roman-numeral reading a profile counts, one row per harmony:
    ``{start, end, figure, label, key}`` with offsets in quarter notes."""
    reading = _read_score(score, max_bars)
    if reading is None:
        return []
    sp = reading.spellings
    return [
        {
            "start": h.start,
            "end": h.end,
            "figure": h.figure,
            "label": h.label,
            "key": key_name(
                key_from_index(h.key, {h.key % 12: sp.get(h.key % 12, "")})
            ),
        }
        for h in reading.harmonies
    ]


def analyze_score(
    score: Any, work_id: str = "", *, max_bars: Optional[int] = None
) -> Tally:
    """Count one score (its first ``max_bars`` bars when given)."""
    tally = Tally(works=[work_id] if work_id else [])
    r = _read_score(score, max_bars)
    if r is None:
        return tally
    tally.bars = len(r.bars)
    tally.pulses = len(r.pulses)
    tally.orchestrations[_orchestration(r.parts)] += 1
    for _, _, ts in r.bars:
        tally.meters[ts.ratioString] += 1
    _count_harmony(tally, r.harmonies, r.pulses, r.keys)
    ends = _phrase_ends(r.harmonies, r.fermatas, r.lines, r.pulses, r.whole)
    reach = 2 * max(4.0, r.bars[0][1])
    _count_cadences(tally, r.harmonies, ends, r.ev, r.spellings, reach)
    _count_texture(tally, r.ev, r.pulses, len(r.parts))
    _count_meter(tally, r.bars, r.lines, r.pulses)
    _count_intervals(tally, r.lines)
    return tally


def _harmonies(
    pulses: Sequence[_Pulse],
    keys: Sequence[int],
    ev: _Events,
    spellings: Mapping[int, str],
) -> list[_Harmony]:
    out: list[_Harmony] = []
    for p, k in zip(pulses, keys):
        step = p.length / p.subdivisions
        for j in range(p.subdivisions):
            a = p.start + j * step
            b = a + step
            mask = (ev.start < b - EPS) & (ev.end > a + EPS)
            if not mask.any():
                continue
            idx = np.nonzero(mask)[0]
            weights: dict[int, float] = defaultdict(float)
            best_name: dict[int, tuple[float, str]] = {}
            for i in idx:
                w = min(ev.end[i], b) - max(ev.start[i], a)
                pc = int(ev.midi[i]) % 12
                weights[pc] += w
                if pc not in best_name or w > best_name[pc][0]:
                    best_name[pc] = (w, ev.names[i])
            at_onset = idx[(ev.start[idx] <= a + EPS) & (ev.end[idx] > a + EPS)]
            pool = at_onset if len(at_onset) else idx
            bass_i = int(pool[np.argmin(ev.midi[pool])])
            bass_pc = int(ev.midi[bass_i]) % 12
            top = int(ev.midi[pool].max()) % 12
            pcs = reduce_to_chord(weights, bass_pc)
            if pcs is None:
                if out:
                    out[-1].end = b
                continue
            names = (ev.names[bass_i],) + tuple(
                best_name[pc][1] for pc in sorted(pcs) if pc != bass_pc
            )
            label, figure, inv, root = _read(names, k, spellings.get(k % 12, ""))
            accent = p.accent if j == 0 else 0.0
            if out and out[-1].figure == figure and out[-1].key == k:
                out[-1].end = b
                continue
            out.append(_Harmony(a, b, label, figure, k, inv, top, accent, root, names))
    return out


def _count_harmony(
    tally: Tally,
    harmonies: Sequence[_Harmony],
    pulses: Sequence[_Pulse],
    keys: Sequence[int],
) -> None:
    last: Optional[tuple[str, int]] = None
    for h in harmonies:
        ident = (h.label, h.key)
        if ident == last:
            continue
        last = ident
        tally.changes += 1
        tally.vocab["major" if h.key < 12 else "minor"][h.label] += 1
    for k in keys:
        tally.modes["major" if k < 12 else "minor"] += 1


def classify_cadence(
    approach: _Harmony, arrival: _Harmony, tonic_pc: int
) -> Optional[str]:
    """The planner's cadence type for a phrase end, or None for none of them.

    An applied dominant that resolves to its own chord (V7/IV - IV) is an
    authentic cadence in the key it tonicizes, and a phrase that stops on an
    applied dominant (on V/vi) is a half cadence there."""
    a, b = approach.label, arrival.label
    minor = arrival.key >= 12
    head, _, target = a.partition("/")
    if target and target == b and head in DOMINANTS:
        a, tonic_pc = head, arrival.root_pc
        b = "I"
    if arrival.inversion >= 2 or (arrival.inversion == 1 and b not in TONICS):
        # A six-four is never an arrival, and only a tonic arrives inverted
        # (an imperfect cadence); half and deceptive cadences land in root
        # position.
        return None
    if b in TONICS:
        if a in DOMINANTS:
            perfect = (
                a in ("V", "V7")
                and approach.inversion == 0
                and arrival.inversion == 0
                and arrival.top_pc == tonic_pc
            )
            return "authentic_perfect" if perfect else "authentic_imperfect"
        if a in ("IV", "iv"):
            return "plagal"
        return None
    if b in ("vi", "VI") and a in ("V", "V7"):
        return "deceptive"
    if b in ("V", "V7") or b.split("/")[0] in ("V", "V7"):
        if minor and b == "V" and a == "iv" and approach.inversion == 1:
            return "phrygian_half"
        return "half"
    return None


def _phrase_ends(
    harmonies: Sequence[_Harmony],
    fermatas: Sequence[float],
    lines: Sequence[Sequence[tuple]],
    pulses: Sequence[_Pulse],
    whole: bool,
) -> list[int]:
    """Indexes of the harmonies that end a phrase: under a fermata, the last
    of a whole piece, and (with no fermatas at all) one on a strong pulse
    where the top part's note is followed by a rest."""
    from bisect import bisect_right

    starts = [h.start for h in harmonies]
    ends: set[int] = set()

    def at(offset: float) -> int:
        return max(0, bisect_right(starts, offset + EPS) - 1)

    for f in fermatas:
        ends.add(at(f))
    if whole:
        ends.add(len(harmonies) - 1)
    if not fermatas and lines:
        pulse_len = {round(p.start, 4): p.length for p in pulses}
        top = lines[0]
        for i, (off, dur, _, rest) in enumerate(top):
            if rest:
                continue
            j = at(off)
            h = harmonies[j]
            if abs(h.start - off) > EPS or h.accent < 0.5:
                continue
            size = pulse_len.get(round(off, 4), 1.0)
            next_rest = i + 1 < len(top) and top[i + 1][3]
            if next_rest and dur >= size / 2 - EPS:
                ends.add(j)
    return sorted(j for j in ends if j > 0)


def _count_cadences(
    tally: Tally,
    harmonies: Sequence[_Harmony],
    ends: Sequence[int],
    ev: _Events,
    spellings: Mapping[int, str],
    reach: float,
) -> None:
    """Classify each phrase end. A cadence is heard in the key the phrase
    leads into it in, so the key is read again from the ``reach`` quarters
    before the arrival (a phrase that closes in the dominant key closes with
    an authentic cadence there), and both chords are read in that key."""
    from dataclasses import replace

    from .romans import correlations

    for j in ends:
        arrival = harmonies[j]
        i = j - 1
        # V to V7 is one harmony: the approach is the last chord on another root.
        while i > 0 and harmonies[i].root_pc == arrival.root_pc:
            i -= 1
        approach = harmonies[i]
        if approach.root_pc == arrival.root_pc:
            continue
        vec = window_vectors(
            ev.start, ev.end, ev.midi, [arrival.start - reach], [arrival.end]
        )
        corr = correlations(vec)[0]
        corr[arrival.key] += 0.03
        k = int(corr.argmax())
        tonic_name = spellings.get(k % 12, "")
        if k != arrival.key:
            reread = []
            for h in (approach, arrival):
                label, figure, inv, root = _read(h.names, k, tonic_name)
                reread.append(
                    replace(h, label=label, figure=figure, inversion=inv, key=k)
                )
            approach, arrival = reread
        kind = classify_cadence(approach, arrival, k % 12)
        if kind is None:
            tally.cadence_other += 1
        else:
            tally.cadences[kind] += 1


def _count_texture(
    tally: Tally, ev: _Events, pulses: Sequence[_Pulse], n_parts: int
) -> None:
    for p in pulses:
        sounding = ev.part[(ev.start <= p.start + EPS) & (ev.end > p.start + EPS)]
        n = len(set(sounding.tolist()))
        if n:
            tally.voices_sum += n
            tally.voices_n += 1
    if n_parts < 2:
        return
    onsets = np.unique(np.round(ev.start, 4))
    for t in onsets:
        active = set(ev.part[(ev.start <= t + EPS) & (ev.end > t + EPS)].tolist())
        if len(active) < 2:
            continue
        attacking = set(ev.part[np.abs(ev.start - t) <= EPS].tolist())
        tally.homophony_sum += len(attacking & active) / len(active)
        tally.homophony_n += 1


def _onsets(line: Sequence[tuple]) -> set[float]:
    return {round(off, 4) for off, _, _, rest in line if not rest}


def _count_meter(
    tally: Tally,
    bars: Sequence[tuple[float, float, Any]],
    lines: Sequence[Sequence[tuple]],
    pulses: Sequence[_Pulse],
) -> None:
    from bisect import bisect_left, bisect_right

    outer = [lines[0]] + ([lines[-1]] if len(lines) > 1 else [])
    outer_onsets = [_onsets(line) for line in outer]

    def hit(t: float) -> bool:
        return any(round(t, 4) in s for s in outer_onsets)

    skip = False
    for bi, (start, length, ts) in enumerate(bars):
        full = abs(length - float(ts.barDuration.quarterLength)) < EPS
        if skip:
            skip = False
            continue
        if not full:
            continue
        num, den = ts.numerator, ts.denominator
        beat = float(ts.beatDuration.quarterLength)
        if num == 3 and bi + 1 < len(bars):
            nxt = bars[bi + 1]
            if nxt[2].ratioString != ts.ratioString or abs(nxt[1] - length) > EPS:
                continue
            tally.hemiola_eligible += 1
            if (
                not hit(start + 3 * beat)
                and hit(start + 2 * beat)
                and hit(start + 4 * beat)
            ):
                tally.hemiola += 1
                skip = True
        elif num == 6 and den in (4, 8):
            tally.hemiola_eligible += 1
            third = length / 3
            if (
                not hit(start + length / 2)
                and hit(start + third)
                and hit(start + 2 * third)
            ):
                tally.hemiola += 1

    starts = [p.start for p in pulses]
    accents = [p.accent for p in pulses]
    for line in lines:
        for off, dur, _, rest in line:
            if rest:
                continue
            tally.notes += 1
            i = bisect_left(starts, off - EPS)
            onset = (
                accents[i] if i < len(starts) and abs(starts[i] - off) <= EPS else 0.0
            )
            j = bisect_right(starts, off + EPS)
            k = bisect_left(starts, off + dur - EPS)
            if j < k and max(accents[j:k]) > onset + EPS:
                tally.syncopated += 1


def _count_intervals(tally: Tally, lines: Sequence[Sequence[tuple]]) -> None:
    for line in lines:
        prev: Optional[int] = None
        for _, _, midi, rest in line:
            if rest:
                continue
            if prev is not None:
                step = abs(midi - prev)
                tally.intervals["13+" if step > 12 else str(step)] += 1
            prev = midi


# ---------------------------------------------------------------------------
# the profile
# ---------------------------------------------------------------------------


def _share(
    counter: Mapping[str, float], keys: Sequence[str] | None = None
) -> dict[str, float]:
    total = float(sum(counter.values()))
    names = list(keys) if keys is not None else list(counter)
    if total <= 0:
        return {k: 0.0 for k in names}
    return {k: round(counter.get(k, 0) / total, 4) for k in names}


def _vocab_share(counter: Counter) -> dict[str, float]:
    total = float(sum(counter.values()))
    if total <= 0:
        return {}
    out = {
        k: round(v / total, 4)
        for k, v in counter.most_common()
        if v / total >= VOCAB_FLOOR
    }
    return out


def profile_from_tally(
    tally: Tally,
    *,
    style_id: str,
    name: str,
    era: str = "",
    orchestration: Optional[str] = None,
    sample: Optional[Mapping[str, Any]] = None,
    basis: str = "",
) -> dict[str, Any]:
    if tally.bars == 0 or tally.changes == 0:
        raise ProfileError("the scores hold no harmony to count")
    cadence_total = sum(tally.cadences.values())
    orch = orchestration or (
        tally.orchestrations.most_common(1)[0][0]
        if tally.orchestrations
        else "chamber_ensemble"
    )
    homophony = tally.homophony_sum / tally.homophony_n if tally.homophony_n else 1.0
    doc: dict[str, Any] = {
        "schema": SCHEMA,
        "schemaVersion": SCHEMA_VERSION,
        "id": style_id,
        "name": name,
        "era": era,
        "source": "extracted",
        "basis": basis
        or "counted by backend/modules/composer/profile.py from the works listed",
        "works": list(tally.works),
        "sample": {
            "works": len(tally.works),
            "bars": tally.bars,
            "harmonies": tally.changes,
            "cadences": cadence_total + tally.cadence_other,
            **dict(sample or {}),
        },
        "modes": _share(tally.modes, ("major", "minor")),
        "vocabulary": {m: _vocab_share(tally.vocab[m]) for m in ("major", "minor")},
        "cadences": _share(tally.cadences, CADENCES),
        "cadence_other": round(
            tally.cadence_other / max(1, cadence_total + tally.cadence_other), 4
        ),
        "harmonic_rhythm": {
            "chords_per_bar": round(tally.changes / tally.bars, 3),
            "chords_per_pulse": round(tally.changes / max(1, tally.pulses), 3),
        },
        "texture": {
            "voices": round(tally.voices_sum / max(1, tally.voices_n), 3),
            "homophony": round(homophony, 3),
            "polyphony": round(1.0 - homophony, 3),
        },
        "meter": {
            "meters": _share(tally.meters, sorted(tally.meters)),
            "hemiola": round(tally.hemiola / max(1, tally.hemiola_eligible), 4),
            "syncopation": round(tally.syncopated / max(1, tally.notes), 4),
        },
        "intervals": _share(tally.intervals, INTERVAL_BUCKETS),
        "orchestration": orch,
    }
    errors = validate_profile(doc)
    if errors:
        raise ProfileError("; ".join(errors))
    return doc


def extract_profile(
    scores: Iterable[tuple[str, Any]],
    *,
    style_id: str,
    name: str,
    era: str = "",
    max_bars: Optional[int] = None,
    orchestration: Optional[str] = None,
    sample: Optional[Mapping[str, Any]] = None,
) -> dict[str, Any]:
    """A profile from ``(work id, music21 score)`` pairs."""
    total = Tally()
    for work_id, score in scores:
        total.add(analyze_score(score, work_id, max_bars=max_bars))
    extra = dict(sample or {})
    if max_bars:
        extra.setdefault("max_bars_per_work", max_bars)
    return profile_from_tally(
        total,
        style_id=style_id,
        name=name,
        era=era,
        orchestration=orchestration,
        sample=extra,
    )


def profile_from_corpus(
    ids: Sequence[str],
    *,
    style_id: str = "custom",
    name: str = "",
    max_bars: Optional[int] = 96,
) -> dict[str, Any]:
    """A profile from music21 corpus pieces (ids from ``GET /api/notation/corpus``)."""
    from backend.modules.sheetimport.corpus import describe, resolve

    if not ids:
        raise ProfileError("name at least one corpus piece")
    pairs = []
    composers: Counter = Counter()
    for piece_id in ids:
        entry = resolve(piece_id)
        if entry is None:
            raise ProfileError(f"no piece {piece_id!r} in the music21 corpus")
        composers[describe(entry)["composer"] or ""] += 1
        pairs.append((str(piece_id), entry.parse()))
    label = name or (composers.most_common(1)[0][0] if composers else "") or style_id
    return extract_profile(pairs, style_id=style_id, name=label, max_bars=max_bars)


def profile_from_file(
    path: Path,
    work_id: str,
    *,
    style_id: str = "custom",
    name: str = "",
    max_bars: Optional[int] = 96,
) -> dict[str, Any]:
    """A profile from one score file (an imported composition's sheet)."""
    from music21 import converter

    score = converter.parse(str(path), forceSource=True)
    return extract_profile(
        [(work_id, score)], style_id=style_id, name=name or work_id, max_bars=max_bars
    )


__all__ = [
    "ProfileError",
    "SCHEMA",
    "SCHEMA_VERSION",
    "STYLES_DIR",
    "Tally",
    "analyze_score",
    "classify_cadence",
    "extract_profile",
    "harmonic_analysis",
    "is_chord",
    "list_styles",
    "load_style",
    "profile_from_corpus",
    "profile_from_file",
    "profile_from_tally",
    "reduce_to_chord",
    "style_ids",
    "validate_profile",
]
