"""ORCHESTRATE: a sketch of a few parts written out for a whole ensemble.

``orchestrate`` takes the roll's parts (the sketch), the harmony row's roman
numerals when there are any, the meter map and the section markers, and
writes one part per instrument of an ensemble (``ENSEMBLES``: chamber,
classical, romantic, strings), every instrument a record of the notation
registry (``backend/modules/notation/instruments.py``), so a part comes back
with the registry's id, its sounding range respected and its family's place
in score order.

The rules, section by section (a section is the span between two markers,
the whole sketch when there are none):

* **Dynamic.** The section's dynamic is the mean velocity of the melody's
  notes in it (pp .. ff). The loudest section is the climax; a section at
  forte or louder is one too.
* **Melody.** The melody part (the caller's, else the sketch's highest part
  by mean pitch) goes to Violin I as written. Winds double it when the
  section is at mezzo-piano or louder (or the density says so), at the
  octave above when ``density`` is over 0.5 and at the unison otherwise.
  Brass (trumpets, horns) take it on the climax. A doubling that leaves its
  instrument's sounding range moves by octaves until it is inside.
* **Bass.** The bass part (the caller's, else the lowest by mean pitch) goes
  to the cellos as written and to the contrabasses an octave down inside
  their range. A one-part sketch gets a bass of chord roots.
* **Inner voices.** Each chord (the harmony row's numeral where it has one,
  else the chord music21 reads in the sketch's sounding notes, bar by bar) is
  voiced in four voices by the planner's search (``harmony.candidates`` /
  ``harmony.viterbi``, pruned by ``voiceleading.transition_forbidden``), and
  the voices are spread over Violin II, violas, horns, bassoons and the
  second wind players. The texture sets their rhythm: sustained chords in
  ``tutti`` and ``chorale``, repeated pulses in ``melody_accompaniment``, and
  ``call_answer`` alternates the melody between strings and winds section by
  section.
* **Timpani** on the roots of I and V at phrase downbeats; **bass drum and
  cymbals** on the climax's phrase downbeats; the **harp** arpeggiates each
  chord.
* **Expression.** Every note carries the section's dynamic as velocity
  (accompaniment a shade under), and every pitched part gets a CC 1 swell per
  phrase (four bars) that peaks where the melody peaks. Sustained lines are
  ``legato``, accompaniment figures ``staccato``, the basses ``pizzicato``
  under a chorale.

Everything is deterministic: the same sketch and options give the same score.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping, Sequence

import numpy as np
from music21 import key as m21key

from backend.modules.notation.instruments import OrchestraInstrument, by_id

from .harmony import Candidates, PlanError, PlannedChord, candidates, viterbi
from .meter import MeterGrid
from .spec import ORCHESTRA_TEXTURES, PPQ
from .voiceleading import (
    Harmony,
    _guess_key,
    harmony_for,
    harmony_from_pitches,
    key_label,
    parse_key,
)

__all__ = [
    "ENSEMBLES",
    "TEXTURES",
    "OrchestrateError",
    "ensemble_instruments",
    "orchestrate",
]


class OrchestrateError(ValueError):
    """The sketch cannot be orchestrated (no notes, an unknown ensemble...)."""


TEXTURES = ORCHESTRA_TEXTURES

# Chord voices, top first, as the voicing search lays them out (SATB shape),
# in ranges under the melody so Violin I stays on top.
VOICE_RANGES: tuple[tuple[int, int], ...] = ((55, 74), (50, 69), (43, 62), (36, 55))
S, A, T, B = 0, 1, 2, 3

# Dynamics by velocity: the word, and the floor of the band.
DYNAMICS: tuple[tuple[str, int], ...] = (
    ("ff", 104),
    ("f", 88),
    ("mf", 72),
    ("mp", 56),
    ("p", 40),
    ("pp", 0),
)
DEFAULT_VELOCITY = 80
PHRASE_BARS = 4
# Accompaniment sits a shade under the melody.
ACCOMPANIMENT_UNDER = 8


@dataclass(frozen=True)
class Player:
    """One part of an ensemble: its registry instrument, its part name and
    its job.

    ``role``:
      ``lead``     the melody as written (Violin I).
      ``double``   the melody, doubled by winds or brass; ``octave`` is the
                   shift in octaves before fitting to the range.
      ``voice``    a chord voice (``voice`` indexes S, A, T, B).
      ``bass``     the bass line as written (cellos).
      ``bass8vb``  the bass line an octave down (contrabasses).
      ``timpani``, ``harp``, ``kit``  their own figures.
    ``family``: which choir the player answers in (``strings``, ``winds``,
    ``brass``, ``other``).
    ``threshold``: the density from which the player joins outside the
    climax (0 plays always; 1 plays on the climax only).
    """

    instrument_id: str
    name: str
    role: str
    family: str
    threshold: float = 0.0
    voice: int = 0
    octave: int = 0


def _p(
    inst: str,
    name: str,
    role: str,
    family: str,
    threshold: float = 0.0,
    voice: int = 0,
    octave: int = 0,
) -> Player:
    return Player(inst, name, role, family, threshold, voice, octave)


STRINGS: tuple[Player, ...] = (
    _p("violin", "Violin I", "lead", "strings"),
    _p("violin", "Violin II", "voice", "strings", voice=S),
    _p("viola", "Viola", "voice", "strings", voice=A),
    _p("cello", "Cello", "bass", "strings"),
    _p("contrabass", "Contrabass", "bass8vb", "strings"),
)

CHAMBER_WINDS: tuple[Player, ...] = (
    _p("flute", "Flute", "double", "winds", 0.3),
    _p("oboe", "Oboe", "double", "winds", 0.4),
    _p("clarinet-bb", "Clarinet", "voice", "winds", 0.3, voice=T),
    _p("bassoon", "Bassoon", "voice", "winds", 0.2, voice=B),
    _p("horn", "Horn", "voice", "brass", 0.2, voice=T),
)

CLASSICAL_WINDS: tuple[Player, ...] = (
    _p("flute", "Flute I", "double", "winds", 0.3),
    _p("flute", "Flute II", "voice", "winds", 0.5, voice=S, octave=1),
    _p("oboe", "Oboe I", "double", "winds", 0.4),
    _p("oboe", "Oboe II", "voice", "winds", 0.5, voice=A),
    _p("clarinet-bb", "Clarinet I", "double", "winds", 0.4),
    _p("clarinet-bb", "Clarinet II", "voice", "winds", 0.5, voice=T),
    _p("bassoon", "Bassoon I", "voice", "winds", 0.2, voice=T),
    _p("bassoon", "Bassoon II", "voice", "winds", 0.4, voice=B),
    _p("horn", "Horn I", "voice", "brass", 0.2, voice=T),
    _p("horn", "Horn II", "voice", "brass", 0.3, voice=B),
    _p("trumpet-bb", "Trumpet I", "double", "brass", 0.7),
    _p("trumpet-bb", "Trumpet II", "voice", "brass", 0.8, voice=A),
    _p("timpani", "Timpani", "timpani", "other", 0.3),
)

ROMANTIC_WINDS: tuple[Player, ...] = (
    _p("piccolo", "Piccolo", "double", "winds", 0.9, octave=1),
    _p("flute", "Flute I", "double", "winds", 0.3),
    _p("flute", "Flute II", "voice", "winds", 0.5, voice=S, octave=1),
    _p("oboe", "Oboe I", "double", "winds", 0.4),
    _p("oboe", "Oboe II", "voice", "winds", 0.5, voice=A),
    _p("english-horn", "English Horn", "voice", "winds", 0.6, voice=A),
    _p("clarinet-bb", "Clarinet I", "double", "winds", 0.4),
    _p("clarinet-bb", "Clarinet II", "voice", "winds", 0.5, voice=T),
    _p("bass-clarinet", "Bass Clarinet", "voice", "winds", 0.7, voice=B),
    _p("bassoon", "Bassoon I", "voice", "winds", 0.2, voice=T),
    _p("bassoon", "Bassoon II", "voice", "winds", 0.4, voice=B),
    _p("contrabassoon", "Contrabassoon", "voice", "winds", 0.8, voice=B, octave=-1),
    _p("horn", "Horn I", "voice", "brass", 0.2, voice=T),
    _p("horn", "Horn II", "voice", "brass", 0.3, voice=A),
    _p("horn", "Horn III", "voice", "brass", 0.5, voice=S),
    _p("horn", "Horn IV", "voice", "brass", 0.5, voice=B),
    _p("trumpet-bb", "Trumpet I", "double", "brass", 0.7),
    _p("trumpet-bb", "Trumpet II", "voice", "brass", 0.8, voice=A),
    _p("trumpet-bb", "Trumpet III", "voice", "brass", 0.9, voice=T),
    _p("trombone", "Trombone I", "voice", "brass", 0.8, voice=A),
    _p("trombone", "Trombone II", "voice", "brass", 0.8, voice=T),
    _p("bass-trombone", "Bass Trombone", "voice", "brass", 0.9, voice=B),
    _p("tuba", "Tuba", "voice", "brass", 0.9, voice=B, octave=-1),
    _p("timpani", "Timpani", "timpani", "other", 0.3),
    _p("bass-drum", "Bass Drum", "kit", "other", 1.0),
    _p("crash-cymbals", "Crash Cymbals", "kit", "other", 1.0),
    _p("harp", "Harp", "harp", "other", 0.3),
)

ENSEMBLES: dict[str, tuple[Player, ...]] = {
    "strings": STRINGS,
    "chamber": CHAMBER_WINDS + STRINGS,
    "classical": CLASSICAL_WINDS + STRINGS,
    "romantic": ROMANTIC_WINDS + STRINGS,
}


def ensemble_instruments(ensemble: str) -> list[dict[str, str]]:
    """The parts of an ensemble in score order: ``{instrument_id, name}``."""
    players = ENSEMBLES.get(ensemble)
    if players is None:
        raise OrchestrateError(f"no ensemble {ensemble!r}: one of {sorted(ENSEMBLES)}")
    ordered = sorted(players, key=lambda p: _registry(p.instrument_id).order)
    return [{"instrument_id": p.instrument_id, "name": p.name} for p in ordered]


def _registry(instrument_id: str) -> OrchestraInstrument:
    inst = by_id(instrument_id)
    if inst is None:
        raise OrchestrateError(f"no registry instrument {instrument_id!r}")
    return inst


# ---------------------------------------------------------------------------
# the sketch
# ---------------------------------------------------------------------------


@dataclass
class Note:
    note: int
    tick: int
    ticks: int
    velocity: int = DEFAULT_VELOCITY
    articulation: str | None = None

    def as_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "note": self.note,
            "tick": self.tick,
            "ticks": self.ticks,
            "velocity": self.velocity,
        }
        if self.articulation:
            out["articulation"] = self.articulation
        return out


@dataclass
class SketchPart:
    id: str
    name: str
    notes: list[Note]

    @property
    def mean_pitch(self) -> float:
        return sum(n.note for n in self.notes) / len(self.notes) if self.notes else 0.0


def _get(x: Any, k: str, default: Any = None) -> Any:
    return x.get(k, default) if isinstance(x, Mapping) else getattr(x, k, default)


def _parts(raw: Sequence[Any]) -> list[SketchPart]:
    out: list[SketchPart] = []
    for i, p in enumerate(raw):
        notes = []
        for n in _get(p, "notes", []) or []:
            vel = _get(n, "velocity")
            notes.append(
                Note(
                    int(_get(n, "note")),
                    max(0, int(_get(n, "tick"))),
                    max(1, int(_get(n, "ticks"))),
                    int(vel) if vel is not None else DEFAULT_VELOCITY,
                    _get(n, "articulation") or None,
                )
            )
        notes.sort(key=lambda n: (n.tick, n.note))
        pid = str(_get(p, "id") or f"part-{i}")
        out.append(SketchPart(pid, str(_get(p, "name") or pid), notes))
    return out


def _pick(parts: Sequence[SketchPart], wanted: str | None, highest: bool) -> SketchPart:
    with_notes = [p for p in parts if p.notes]
    if wanted:
        hit = next((p for p in parts if p.id == wanted or p.name == wanted), None)
        if hit is None:
            raise OrchestrateError(f"no part {wanted!r} in the sketch")
        if not hit.notes:
            raise OrchestrateError(f"part {hit.name!r} has no notes")
        return hit
    return (
        max(with_notes, key=lambda p: p.mean_pitch)
        if highest
        else min(with_notes, key=lambda p: p.mean_pitch)
    )


# ---------------------------------------------------------------------------
# sections, phrases, dynamics
# ---------------------------------------------------------------------------


@dataclass
class Section:
    index: int
    name: str
    tick: int
    end: int
    velocity: int = DEFAULT_VELOCITY
    dynamic: str = "mf"
    climax: bool = False
    phrases: list[tuple[int, int]] = field(default_factory=list)
    plan: str = ""


def dynamic_of(velocity: int) -> str:
    for word, floor in DYNAMICS:
        if velocity >= floor:
            return word
    return "pp"


def _sections(markers: Sequence[Any], start: int, end: int) -> list[Section]:
    marks = sorted(
        ((max(0, int(_get(m, "tick"))), str(_get(m, "name") or "")) for m in markers),
        key=lambda x: x[0],
    )
    marks = [(t, n) for t, n in marks if start <= t < end]
    if not marks or marks[0][0] > start:
        marks.insert(0, (start, "" if not marks else "Opening"))
    out: list[Section] = []
    for i, (t, name) in enumerate(marks):
        nxt = marks[i + 1][0] if i + 1 < len(marks) else end
        if nxt <= t:
            continue
        out.append(Section(len(out), name or f"Section {len(out) + 1}", t, nxt))
    return out


def _phrases(grid: MeterGrid, sec: Section) -> list[tuple[int, int]]:
    """Four-bar spans from the section's first bar; the last takes the rest."""
    first = grid.bar_at(sec.tick).bar
    last = grid.bar_at(max(sec.tick, sec.end - 1)).bar
    out: list[tuple[int, int]] = []
    b = first
    while b <= last:
        t0 = max(sec.tick, grid.bar(b).tick)
        b_end = min(b + PHRASE_BARS, last + 1)
        t1 = min(sec.end, grid.bar(b_end).tick)
        if t1 > t0:
            out.append((t0, t1))
        b = b_end
    return out or [(sec.tick, sec.end)]


def _in(notes: Iterable[Note], t0: int, t1: int) -> list[Note]:
    return [n for n in notes if t0 <= n.tick < t1]


# ---------------------------------------------------------------------------
# harmony slots
# ---------------------------------------------------------------------------


@dataclass
class Slot:
    tick: int
    ticks: int
    harmony: Harmony
    figure: str
    chord: PlannedChord | None
    key: m21key.Key

    @property
    def pcs(self) -> list[int]:
        return sorted(self.harmony.pcs)


def _planned(figure: str, k: m21key.Key) -> PlannedChord | None:
    try:
        return PlannedChord(figure, k, "given")
    except Exception:
        # A figure music21 cannot build (a reading it printed but will not parse).
        return None


def _slots(
    grid: MeterGrid,
    parts: Sequence[SketchPart],
    harmony_row: Sequence[Any],
    k: m21key.Key,
    start: int,
    end: int,
) -> list[Slot]:
    row: list[tuple[int, str, m21key.Key]] = []
    for c in harmony_row:
        fig = str(_get(c, "figure") or "").strip()
        if not fig:
            continue
        ck = _get(c, "key")
        try:
            local = parse_key(str(ck)) if ck else k
        except ValueError:
            local = k
        row.append((max(0, int(_get(c, "tick"))), fig, local))
    row.sort(key=lambda x: x[0])
    bounds = {start, end}
    b = grid.bar_at(start).bar
    while True:
        t = grid.bar(b).tick
        if t >= end:
            break
        if t > start:
            bounds.add(t)
        b += 1
    for t, _f, _k in row:
        if start < t < end:
            bounds.add(t)
    ticks = sorted(bounds)
    out: list[Slot] = []
    prev: Slot | None = None
    tonic = PlannedChord("I" if k.mode == "major" else "i", k, "tonic")
    for t0, t1 in zip(ticks, ticks[1:]):
        active = None
        for rt, fig, local in row:
            if rt <= t0:
                active = (fig, local)
        chord: PlannedChord | None = None
        harmony: Harmony | None = None
        figure = ""
        local_key = k
        if active:
            figure, local_key = active
            chord = _planned(figure, local_key)
            if chord is not None:
                harmony = chord.harmony
            else:
                try:
                    harmony = harmony_for(figure, local_key)
                except Exception:
                    harmony = None
        if harmony is None:
            harmony = harmony_from_pitches(_sounding(parts, t0, t1), k)
            if harmony is not None and harmony.figure:
                figure = harmony.figure
                chord = _planned(figure, k)
        if harmony is None:
            if prev is not None:
                harmony, figure, chord, local_key = (
                    prev.harmony,
                    prev.figure,
                    prev.chord,
                    prev.key,
                )
            else:
                harmony, figure, chord = tonic.harmony, tonic.figure, tonic
        slot = Slot(t0, t1 - t0, harmony, figure, chord, local_key)
        out.append(slot)
        prev = slot
    return out


def _sounding(parts: Sequence[SketchPart], t0: int, t1: int) -> list[int]:
    """The pitches that make the chord of a slot: the notes sounding on its
    downbeat, then, while fewer than three pitch classes, the notes that
    start inside it, longest first, up to four pitch classes."""
    on_beat = [n for p in parts for n in p.notes if n.tick <= t0 < n.tick + n.ticks]
    later = sorted(
        (n for p in parts for n in p.notes if t0 < n.tick < t1),
        key=lambda n: (-min(n.ticks, t1 - n.tick), n.tick),
    )
    pcs: list[int] = []
    out: list[int] = []
    for n in sorted(on_beat, key=lambda n: n.note) + later:
        if n.note % 12 in pcs:
            continue
        if len(pcs) >= 3 and n not in on_beat:
            break
        if len(pcs) >= 4:
            break
        pcs.append(n.note % 12)
        out.append(n.note)
    return out


def _voicings(slots: Sequence[Slot]) -> list[tuple[int, int, int, int]]:
    """Four voices per slot, top first, by the planner's search; a chord no
    voicing reaches holds the voicing before it."""
    cands: list[Candidates | None] = []
    for s in slots:
        c: Candidates | None = None
        if s.chord is not None:
            try:
                c = candidates(s.chord, VOICE_RANGES)
            except (PlanError, Exception):
                c = None
        cands.append(c)
    have = [i for i, c in enumerate(cands) if c is not None]
    chosen: dict[int, tuple[int, int, int, int]] = {}
    if have:
        runs: list[list[int]] = [[have[0]]]
        for i in have[1:]:
            if i == runs[-1][-1] + 1:
                runs[-1].append(i)
            else:
                runs.append([i])
        for run in runs:
            cs = [cands[i] for i in run]
            hs = [slots[i].harmony for i in run]
            try:
                idx = viterbi(cs, hs)  # type: ignore[arg-type]
            except PlanError:
                idx = [int(np.argmin(c.unary)) for c in cs]  # type: ignore[union-attr]
            for i, j in zip(run, idx):
                v = cands[i].voicings[j]  # type: ignore[union-attr]
                chosen[i] = (int(v[0]), int(v[1]), int(v[2]), int(v[3]))
    out: list[tuple[int, int, int, int]] = []
    last: tuple[int, int, int, int] | None = None
    for i, s in enumerate(slots):
        v = chosen.get(i)
        if v is None:
            v = last if last is not None else _plain_voicing(s.pcs)
        out.append(v)
        last = v
    return out


def _plain_voicing(pcs: Sequence[int]) -> tuple[int, int, int, int]:
    """A close voicing of the chord's pitch classes from the bass up, for a
    chord the planner cannot voice."""
    if not pcs:
        return (67, 64, 60, 48)
    seq = list(pcs) + [pcs[0]] * (4 - len(pcs)) if len(pcs) < 4 else list(pcs[:4])
    root = seq[0]
    bass = 36 + ((root - 36) % 12)
    upper = []
    at = 55
    for pc in seq[:3]:
        p = at + ((pc - at) % 12)
        upper.append(p)
        at = p + 1
    upper.sort(reverse=True)
    return (upper[0], upper[1], upper[2], bass)


# ---------------------------------------------------------------------------
# pitches in range
# ---------------------------------------------------------------------------


def fit(pitch: int, lo: int, hi: int) -> int:
    """``pitch`` moved by octaves until it sits in ``lo..hi``; clamped when
    the range is narrower than an octave."""
    p = pitch
    while p < lo:
        p += 12
    while p > hi:
        p -= 12
    if p < lo:
        p = lo if hi - lo < 12 else lo + ((pitch - lo) % 12)
    return max(lo, min(hi, p))


def _fit_line(
    notes: Sequence[Note], inst: OrchestraInstrument, octave: int = 0
) -> list[Note]:
    lo, hi = inst.range_low, inst.range_high
    return [
        Note(
            fit(n.note + 12 * octave, lo, hi),
            n.tick,
            n.ticks,
            n.velocity,
            n.articulation,
        )
        for n in notes
    ]


# ---------------------------------------------------------------------------
# the score
# ---------------------------------------------------------------------------


@dataclass
class Written:
    player: Player
    inst: OrchestraInstrument
    notes: list[Note] = field(default_factory=list)
    controls: list[dict[str, int]] = field(default_factory=list)


def _plays(player: Player, sec: Section, density: float) -> bool:
    if player.threshold <= 0:
        return True
    if sec.climax:
        return True
    return density >= player.threshold


def _lead_family(sec: Section, texture: str) -> str:
    """Which choir carries the melody in a section."""
    if texture == "call_answer":
        return "strings" if sec.index % 2 == 0 else "winds"
    return "strings"


def _melody_doubles(player: Player, sec: Section, density: float, texture: str) -> bool:
    """Whether a doubling player takes the melody in a section."""
    lead = _lead_family(sec, texture)
    if player.family == "brass":
        return sec.climax or density >= player.threshold
    if player.family == "winds":
        if player.threshold >= 0.9:
            return sec.climax and density >= 0.6
        if lead == "winds":
            return True
        return (
            sec.dynamic in ("mp", "mf", "f", "ff")
            or density >= player.threshold
            or texture == "tutti"
        )
    return True


def _sustained(n: Note, beat: int) -> str | None:
    return "legato" if n.ticks >= beat else None


def _chord_notes(
    slot: Slot,
    voicing: tuple[int, int, int, int],
    player: Player,
    inst: OrchestraInstrument,
    grid: MeterGrid,
    texture: str,
    velocity: int,
    density: float,
) -> list[Note]:
    pitch = fit(
        voicing[player.voice] + 12 * player.octave, inst.range_low, inst.range_high
    )
    vel = max(1, velocity - ACCOMPANIMENT_UNDER)
    pulsed = texture == "melody_accompaniment" and player.family == "strings"
    if not pulsed:
        return [Note(pitch, slot.tick, slot.ticks, vel, "legato")]
    out: list[Note] = []
    bar = grid.bar_at(slot.tick)
    unit = (
        bar.meter.unit_ticks
        if density <= 0.5
        else max(PPQ // 4, bar.meter.unit_ticks // 2)
    )
    t = slot.tick
    end = slot.tick + slot.ticks
    while t < end:
        length = min(unit, end - t)
        out.append(Note(pitch, t, max(1, length * 3 // 4), vel, "staccato"))
        t += unit
    return out


def _harp_notes(
    slot: Slot, inst: OrchestraInstrument, velocity: int, density: float
) -> list[Note]:
    pcs = slot.pcs
    if not pcs:
        return []
    root = slot.harmony.root_pc if slot.harmony.root_pc is not None else pcs[0]
    base = fit(48 + ((root - 48) % 12), inst.range_low, inst.range_high)
    tones = sorted(pcs)
    ladder: list[int] = []
    p = base
    while p <= min(inst.range_high, base + 24) and len(ladder) < 8:
        if p % 12 in tones:
            ladder.append(p)
        p += 1
    if not ladder:
        return []
    unit = PPQ // 2 if density <= 0.5 else PPQ // 4
    out: list[Note] = []
    t = slot.tick
    end = slot.tick + slot.ticks
    i = 0
    vel = max(1, velocity - ACCOMPANIMENT_UNDER)
    while t < end:
        out.append(Note(ladder[i % len(ladder)], t, min(unit, end - t), vel))
        t += unit
        i += 1
    return out


def _is_root_of_i_or_v(slot: Slot) -> int | None:
    h = slot.harmony
    if h.root_pc is None:
        return None
    tonic = slot.key.tonic.pitchClass
    if h.root_pc in (tonic, (tonic + 7) % 12) and h.inversion == 0:
        return h.root_pc
    return None


def _swell(
    phrase: tuple[int, int], melody: Sequence[Note], velocity: int
) -> list[dict[str, int]]:
    """CC 1 points over a phrase: from a floor up to the melody's peak and
    back, every half bar of quarters (two beats)."""
    t0, t1 = phrase
    inside = _in(melody, t0, t1)
    peak_tick = (
        max(inside, key=lambda n: (n.note, n.velocity)).tick
        if inside
        else (t0 + t1) // 2
    )
    peak_tick = min(max(peak_tick, t0), max(t0, t1 - 1))
    floor = max(8, min(100, velocity - 30))
    top = max(floor + 8, min(127, velocity + 16))
    step = 2 * PPQ
    points: list[dict[str, int]] = []
    t = t0
    while t < t1:
        if t <= peak_tick:
            frac = (t - t0) / max(1, peak_tick - t0)
        else:
            frac = 1 - (t - peak_tick) / max(1, t1 - peak_tick)
        frac = max(0.0, min(1.0, frac))
        points.append(
            {
                "tick": t,
                "controller": 1,
                "value": int(round(floor + (top - floor) * frac)),
            }
        )
        t += step
    if not points or points[-1]["tick"] != peak_tick:
        points.append({"tick": peak_tick, "controller": 1, "value": top})
    points.sort(key=lambda p: p["tick"])
    dedup: dict[int, dict[str, int]] = {}
    for p in points:
        dedup[p["tick"]] = p
    return [dedup[t] for t in sorted(dedup)]


def _names(players: Iterable[Player]) -> str:
    names = [p.name for p in players]
    if not names:
        return ""
    if len(names) == 1:
        return names[0]
    return ", ".join(names[:-1]) + " and " + names[-1]


def orchestrate(
    parts: Sequence[Any],
    *,
    ensemble: str = "classical",
    texture: str = "tutti",
    density: float = 0.5,
    melody: str | None = None,
    bass: str | None = None,
    key: str | None = None,
    mode: str | None = None,
    harmony: Sequence[Any] | None = None,
    meter_map: Sequence[Any] | None = None,
    pickup_steps: float = 0,
    markers: Sequence[Any] | None = None,
) -> dict[str, Any]:
    """The sketch ``parts`` (``[{id, name, notes: [{note, tick, ticks,
    velocity?, articulation?}]}]``) written for ``ensemble``. See the module
    docstring for the rules; the answer holds ``parts`` (one per instrument,
    with ``instrument_id``, ``notes`` and ``controls``), ``sections`` (each
    with its dynamic, its lead and its plan sentence) and ``plan`` (the
    sentences)."""
    players = ENSEMBLES.get(ensemble)
    if players is None:
        raise OrchestrateError(f"no ensemble {ensemble!r}: one of {sorted(ENSEMBLES)}")
    if texture not in TEXTURES:
        raise OrchestrateError(f"no texture {texture!r}: one of {list(TEXTURES)}")
    density = max(0.0, min(1.0, float(density)))
    sketch = _parts(parts)
    if not any(p.notes for p in sketch):
        raise OrchestrateError("the sketch has no notes")
    melody_part = _pick(sketch, melody, highest=True)
    bass_part = _pick(sketch, bass, highest=False)
    one_line = bass_part is melody_part
    if key:
        k = parse_key(key, mode)
    else:
        guessed = _guess_key({p.name: [n.as_dict() for n in p.notes] for p in sketch})
        k = guessed if guessed is not None else m21key.Key("C")

    grid = MeterGrid(meter_map, pickup_steps)
    start = min(n.tick for p in sketch for n in p.notes)
    end = max(n.tick + n.ticks for p in sketch for n in p.notes)
    start = grid.bar(grid.bar_at(start).bar).tick
    sections = _sections(markers or [], start, end)
    for sec in sections:
        inside = _in(melody_part.notes, sec.tick, sec.end)
        sec.velocity = (
            int(round(sum(n.velocity for n in inside) / len(inside)))
            if inside
            else DEFAULT_VELOCITY
        )
        sec.dynamic = dynamic_of(sec.velocity)
        sec.phrases = _phrases(grid, sec)
    loudest = max(sections, key=lambda s: (s.velocity, -s.index))
    for sec in sections:
        sec.climax = sec is loudest or sec.velocity >= 88

    slots = _slots(grid, sketch, harmony or [], k, start, end)
    voicings = _voicings(slots)

    # The bass line: the sketch's, or chord roots for a one-line sketch.
    if one_line:
        bass_line = [
            Note(
                fit(
                    s.harmony.root_pc if s.harmony.root_pc is not None else s.pcs[0],
                    36,
                    55,
                ),
                s.tick,
                s.ticks,
                DEFAULT_VELOCITY,
            )
            for s in slots
            if s.pcs
        ]
    else:
        bass_line = list(bass_part.notes)

    written: dict[str, Written] = {}
    for pl in players:
        written[pl.name] = Written(pl, _registry(pl.instrument_id))

    for sec in sections:
        vel = sec.velocity
        beat = grid.bar_at(sec.tick).meter.unit_ticks
        lead = _lead_family(sec, texture)
        sec_slots = [s for s in slots if sec.tick <= s.tick < sec.end]
        sec_voicings = [voicings[slots.index(s)] for s in sec_slots]
        melody_in = _in(melody_part.notes, sec.tick, sec.end)
        bass_in = _in(bass_line, sec.tick, sec.end)
        doubled: list[Player] = []
        held: list[Player] = []
        answer_strings = texture == "call_answer" and lead == "winds"
        for w in written.values():
            pl, inst = w.player, w.inst
            if pl.role == "lead":
                if answer_strings:
                    for s, v in zip(sec_slots, sec_voicings):
                        w.notes += _chord_notes(
                            s,
                            v,
                            Player(pl.instrument_id, pl.name, "voice", "strings", 0, S),
                            inst,
                            grid,
                            "tutti",
                            vel,
                            density,
                        )
                    held.append(pl)
                else:
                    w.notes += [
                        Note(
                            fit(n.note, inst.range_low, inst.range_high),
                            n.tick,
                            n.ticks,
                            vel,
                            n.articulation or _sustained(n, beat),
                        )
                        for n in melody_in
                    ]
                continue
            if pl.role == "double":
                answering = (
                    pl.family == "winds" and lead == "winds" and pl.threshold < 0.9
                )
                if not _plays(pl, sec, density) and not answering:
                    continue
                if _melody_doubles(pl, sec, density, texture):
                    octave = (
                        pl.octave
                        if pl.octave
                        else (1 if density > 0.5 and pl.family == "winds" else 0)
                    )
                    if pl.family == "winds" and pl.threshold >= 0.9:
                        octave = 2 if density > 0.5 else 1
                    w.notes += [
                        Note(
                            fit(n.note + 12 * octave, inst.range_low, inst.range_high),
                            n.tick,
                            n.ticks,
                            vel,
                            n.articulation or _sustained(n, beat),
                        )
                        for n in melody_in
                    ]
                    doubled.append(pl)
                else:
                    for s, v in zip(sec_slots, sec_voicings):
                        w.notes += _chord_notes(
                            s,
                            v,
                            Player(pl.instrument_id, pl.name, "voice", pl.family, 0, S),
                            inst,
                            grid,
                            texture,
                            vel,
                            density,
                        )
                    held.append(pl)
                continue
            if pl.role == "voice":
                if not _plays(pl, sec, density):
                    continue
                if (
                    pl.family == "brass"
                    and texture == "chorale"
                    and not sec.climax
                    and pl.threshold > 0.3
                ):
                    continue
                for s, v in zip(sec_slots, sec_voicings):
                    w.notes += _chord_notes(s, v, pl, inst, grid, texture, vel, density)
                held.append(pl)
                continue
            if pl.role in ("bass", "bass8vb"):
                octave = -1 if pl.role == "bass8vb" else 0
                art = "pizzicato" if texture == "chorale" else None
                for n in bass_in:
                    p = fit(n.note + 12 * octave, inst.range_low, inst.range_high)
                    w.notes.append(
                        Note(
                            p,
                            n.tick,
                            n.ticks,
                            vel,
                            art
                            or n.articulation
                            or (_sustained(n, beat) or "staccato"),
                        )
                    )
                continue
            if pl.role == "timpani":
                if not _plays(pl, sec, density):
                    continue
                for t0, _t1 in sec.phrases:
                    slot = next(
                        (s for s in sec_slots if s.tick <= t0 < s.tick + s.ticks), None
                    )
                    if slot is None:
                        continue
                    root = _is_root_of_i_or_v(slot)
                    if root is None:
                        continue
                    w.notes.append(
                        Note(
                            fit(root, inst.range_low, inst.range_high),
                            t0,
                            min(beat, slot.tick + slot.ticks - t0),
                            vel,
                        )
                    )
                continue
            if pl.role == "kit":
                if not sec.climax:
                    continue
                pitch = inst.kit_pitch if inst.kit_pitch is not None else inst.range_low
                for i, (t0, _t1) in enumerate(sec.phrases):
                    if pl.instrument_id == "crash-cymbals" and i > 0:
                        continue
                    w.notes.append(Note(pitch, t0, beat, vel))
                continue
            if pl.role == "harp":
                if not _plays(pl, sec, density):
                    continue
                for s in sec_slots:
                    w.notes += _harp_notes(s, inst, vel, density)
                continue
        # The plan sentence.
        bars = f"bars {grid.bar_at(sec.tick).bar + 1}-{grid.bar_at(max(sec.tick, sec.end - 1)).bar + 1}"
        lead_name = "The winds carry" if answer_strings else "Violin I carries"
        doubles = _names(doubled)
        holds = _names(held)
        bass_text = "pizzicato" if texture == "chorale" else "arco"
        sec.plan = (
            f"{sec.name}, {bars}, {sec.dynamic}{' (climax)' if sec.climax else ''}: "
            f"{lead_name} the melody"
            + (f", doubled by {doubles}" if doubles else "")
            + (f"; {holds} hold the harmony" if holds else "")
            + f"; Cello and Contrabass carry the bass {bass_text}."
        )

    # Expression: a CC 1 swell per phrase on every pitched part that plays.
    for w in written.values():
        if not w.notes or w.inst.percussion:
            continue
        w.notes.sort(key=lambda n: (n.tick, n.note))
        for sec in sections:
            for phrase in sec.phrases:
                if any(phrase[0] <= n.tick < phrase[1] for n in w.notes):
                    w.controls += _swell(phrase, melody_part.notes, sec.velocity)
        w.controls.sort(key=lambda c: c["tick"])

    ordered = sorted(
        written.values(), key=lambda w: (w.inst.order, players.index(w.player))
    )
    return {
        "key": key_label(k),
        "ppq": PPQ,
        "ensemble": ensemble,
        "texture": texture,
        "density": density,
        "melody_part": melody_part.id,
        "bass_part": bass_part.id,
        "parts": [
            {
                "name": w.player.name,
                "instrument_id": w.player.instrument_id,
                "role": w.player.role,
                "notes": [n.as_dict() for n in w.notes],
                "controls": list(w.controls),
            }
            for w in ordered
        ],
        "sections": [
            {
                "name": s.name,
                "tick": s.tick,
                "ticks": s.end - s.tick,
                "dynamic": s.dynamic,
                "velocity": s.velocity,
                "climax": s.climax,
                "lead": "winds"
                if (texture == "call_answer" and s.index % 2 == 1)
                else "strings",
                "plan": s.plan,
            }
            for s in sections
        ],
        "plan": [s.plan for s in sections],
        "chords": [
            {
                "tick": s.tick,
                "ticks": s.ticks,
                "figure": s.figure,
                "key": key_label(s.key),
            }
            for s in slots
        ],
    }
