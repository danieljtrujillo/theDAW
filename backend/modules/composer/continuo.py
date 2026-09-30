"""Figured-bass realization in four parts on music21's realizer.

``realize_continuo`` takes a bass line in ticks with a figure under each note
("", "6", "6/4", "7", "6/5", "4/3", "4/2", "#6", "b7" ...) and a key, and
returns soprano, alto, tenor and bass in ticks.

The line goes into a ``music21.figuredBass.realizer.FiguredBassLine``, whose
segments list every upper-voice possibility over each bass note and every
move between neighbouring segments that music21's own rules accept (parallel
and hidden fifths and octaves, crossing, overlap, spacing, and the special
resolutions of dominant sevenths, diminished sevenths and augmented sixths).
Of those, the planner's search (harmony.py) keeps the parts in their ranges,
applies the checker's tendency-tone rules, and picks the smoothest path; the
result goes through the voice-leading checker like a planned progression.
"""

from __future__ import annotations

import re
from fractions import Fraction
from typing import Any, Mapping, Sequence

import numpy as np
from music21 import meter as m21meter
from music21 import note as m21note
from music21 import pitch as m21pitch
from music21.figuredBass import realizer, rules

from .harmony import LETTERS, Candidates, PlanError, range_list, search_voicings
from .meter import MeterGrid
from .spec import PPQ, SATB
from .voiceleading import (
    Harmony,
    harmony_from_names,
    key_label,
    key_spelling,
    name_of,
    parse_key,
    spelled_pitch,
)

VELOCITY = 80


def normalize_figure(fig: str | None) -> str:
    """music21's comma-separated notation from the ways people write figures:
    "6/4", "6 4", "64" and "6,4" are all "6,4"; "", "5" and "5/3" stay root
    position; accidentals stay on their number."""
    s = (fig or "").strip()
    if not s:
        return ""
    s = s.replace("♯", "#").replace("♭", "b").replace("♮", "n")
    s = re.sub(r"(?<=\d)\s*/\s*(?=[#bn+\-]?\d)", ",", s)
    s = re.sub(r"\s+", ",", s)
    parts = []
    for tok in s.split(","):
        if tok.isdigit() and len(tok) > 1 and tok not in ("11", "13"):
            parts.extend(tok)
        elif tok:
            parts.append(tok)
    s = ",".join(parts)
    # music21 writes a flat as "-"; "b" before a number or alone is a flat.
    s = re.sub(r"b(?=\d|,|$)", "-", s)
    return "" if s in ("5", "5,3") else s


def _get(x: Any, k: str, default: Any = None) -> Any:
    return x.get(k, default) if isinstance(x, Mapping) else getattr(x, k, default)


def _one_bar(total_ticks: int) -> m21meter.TimeSignature:
    """A time signature one bar long for the whole line, so the realizer's
    bass line never splits a note at a bar line (its segments then match the
    notes one to one)."""
    ql = Fraction(max(1, total_ticks), PPQ)
    den = 4
    while (ql * den / 4).denominator != 1 and den < 64:
        den *= 2
    num = int(ql * den / 4)
    return m21meter.TimeSignature(f"{num}/{den}")


def realize_continuo(
    bass: Sequence[Any],
    tonic: str,
    mode: str | None = None,
    *,
    ranges: Mapping[str, Sequence[int]] | None = None,
    meter_map: Sequence[Any] | None = None,
    pickup_steps: float = 0,
) -> dict[str, Any]:
    if not bass:
        raise PlanError("a figured bass needs at least one note")
    k = parse_key(tonic, mode)
    spell = key_spelling(k)
    notes = sorted(bass, key=lambda x: int(_get(x, "tick")))
    for a, b in zip(notes, notes[1:]):
        if int(_get(b, "tick")) < int(_get(a, "tick")) + int(_get(a, "ticks")):
            raise PlanError("bass notes overlap; a figured bass is one note at a time")
    rl = range_list(ranges)
    rmap = dict(zip(SATB, rl))
    grid = MeterGrid(meter_map, pickup_steps)

    total = sum(int(_get(n, "ticks")) for n in notes)
    line = realizer.FiguredBassLine(k, _one_bar(total))
    figures: list[str] = []
    for x in notes:
        n = m21note.Note()
        n.pitch = spelled_pitch(int(_get(x, "note")), spell)
        n.quarterLength = Fraction(max(1, int(_get(x, "ticks"))), PPQ)
        fig = normalize_figure(_get(x, "figure"))
        figures.append(fig)
        try:
            line.addElement(n, fig or None)
        except Exception as e:
            raise PlanError(f"cannot read figure {_get(x, 'figure')!r}: {e}") from e

    fb_rules = rules.Rules()
    # music21's special resolutions (dominant and diminished sevenths,
    # augmented sixths) compute one resolution per possibility with the next
    # bass note in the octave of the current one, not where the line puts it,
    # and in 10.1 their consecutive-rule filter crashes. So every move goes
    # through the ordinary consecutive rules, and the tendency tones resolve by
    # the checker's rules, which the search applies to every move.
    fb_rules.resolveDominantSeventhProperly = False
    fb_rules.resolveDiminishedSeventhProperly = False
    fb_rules.resolveAugmentedSixthProperly = False
    max_pitch = m21pitch.Pitch(midi=rl[0][1])
    segments = line.retrieveSegments(fb_rules, 4, max_pitch)
    if len(segments) != len(notes):
        raise PlanError("the realizer did not keep one segment per bass note")

    cands: list[Candidates] = []
    harmonies: list[Harmony | None] = []
    for seg in segments:
        rows: list[tuple[int, ...]] = []
        for possib in seg.allCorrectSinglePossibilities():
            mids = tuple(p.midi for p in possib)
            if all(lo <= m <= hi for m, (lo, hi) in zip(mids[:3], rl[:3])):
                rows.append(mids)
        if not rows:
            raise PlanError(
                f"no four-part realization of {seg.bassNote.nameWithOctave} "
                f"{seg.pitchNamesInChord} fits the ranges"
            )
        h = harmony_from_names(seg.bassNote.pitch, seg.pitchNamesInChord, k)
        harmonies.append(h)
        sp = dict(spell)
        if h is not None:
            sp.update(h.spell)
        arr = np.array(rows, dtype=np.int64)
        centers = np.array([(lo + hi) / 2 for lo, hi in rl], dtype=float)
        unary = 0.02 * np.abs(arr - centers[None, :]).sum(-1)
        letters = np.array(
            [[LETTERS.index(sp.get(m % 12, "C")[0]) for m in r] for r in rows],
            dtype=np.int64,
        )
        cands.append(Candidates(arr, unary, letters))

    allowed: list[np.ndarray | None] = []
    for i in range(len(segments) - 1):
        index_b = {tuple(r): j for j, r in enumerate(cands[i + 1].voicings.tolist())}
        index_a = {tuple(r): j for j, r in enumerate(cands[i].voicings.tolist())}
        ok = np.zeros((len(index_a), len(index_b)), dtype=bool)
        for pa, pb in segments[i].allCorrectConsecutivePossibilities(segments[i + 1]):
            ia = index_a.get(tuple(p.midi for p in pa))
            ib = index_b.get(tuple(p.midi for p in pb))
            if ia is not None and ib is not None:
                ok[ia, ib] = True
        allowed.append(ok)

    ticks = [int(_get(n, "tick")) for n in notes]
    voicings, flags = search_voicings(
        cands, harmonies, ticks, grid, rmap, allowed, spell
    )

    parts: dict[str, list[dict[str, int]]] = {p: [] for p in SATB}
    chords = []
    for x, v, h, fig in zip(notes, voicings, harmonies, figures):
        t, d = int(_get(x, "tick")), int(_get(x, "ticks"))
        for part, m in zip(SATB, v):
            parts[part].append({"note": m, "tick": t, "ticks": d, "velocity": VELOCITY})
        sp = dict(spell)
        if h is not None:
            sp.update(h.spell)
        bar, beat = grid.locate(t)
        chords.append(
            {
                "bar": bar,
                "beat": beat,
                "tick": t,
                "ticks": d,
                "figure": _get(x, "figure") or "",
                "roman": h.figure if h is not None else None,
                "pitches": dict(zip(SATB, v)),
                "names": dict(zip(SATB, (name_of(m, sp) for m in v))),
            }
        )
    return {
        "key": key_label(k),
        "ppq": PPQ,
        "chords": chords,
        "parts": parts,
        "flags": [f.as_dict() for f in flags],
    }
