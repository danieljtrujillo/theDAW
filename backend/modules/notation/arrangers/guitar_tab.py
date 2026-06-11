"""MIDI → guitar/bass tablature arranger.

Pitch alone underdetermines a tab: the same note can be played at several
string/fret positions. This module reads a (preferably single-instrument)
MIDI and chooses playable positions with a dynamic-programming pass that
minimizes hand travel, prefers open strings and low positions, and keeps
simultaneous notes to a playable shape. Output is a structured tab plus an
alphaTex string for the alphaTab renderer.

No new dependencies: reading uses music21 (already the module backbone) and
the arrangement itself is pure Python.
"""

from __future__ import annotations

import itertools
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

log = logging.getLogger(__name__)

# Open-string MIDI pitches, listed LOW string (thickest) first. MIDI 40 = E2.
TUNINGS: dict[str, list[int]] = {
    "guitar-standard": [40, 45, 50, 55, 59, 64],  # E2 A2 D3 G3 B3 E4
    "guitar-drop-d": [38, 45, 50, 55, 59, 64],  # D2 A2 D3 G3 B3 E4
    "guitar-7-string": [35, 40, 45, 50, 55, 59, 64],  # B1 E2 A2 D3 G3 B3 E4
    "bass-standard": [28, 33, 38, 43],  # E1 A1 D2 G2
    "bass-5-string": [23, 28, 33, 38, 43],  # B0 E1 A1 D2 G2
}

_DEFAULT_TUNING_FOR_INSTRUMENT = {
    "guitar": "guitar-standard",
    "bass": "bass-standard",
}

# difficulty -> (max_fret, max_stretch). Higher difficulty allows higher and
# wider positions; lower keeps everything close to the nut.
_DIFFICULTY = {
    "easy": (5, 3),
    "medium": (12, 4),
    "hard": (19, 5),
}

# Cost weights for the fingering search.
_LOW_FRET_WEIGHT = 0.25  # mild preference for low frets / open strings
_PRODUCT_ITER_CAP = 20000  # guard against combinatorial blow-up on dense chords
_PLACEMENT_CAP = 64  # keep at most this many candidate shapes per beat

_PITCH_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


@dataclass
class _Event:
    offset: float  # in quarter lengths from the start of the piece
    quarter_length: float
    pitches: list[int]  # MIDI pitch numbers, ascending and de-duplicated


def _pitch_name(midi_pitch: int) -> str:
    """Scientific pitch name for an alphaTex ``\\tuning`` directive (MIDI 40 → E2)."""
    return f"{_PITCH_CLASSES[midi_pitch % 12]}{midi_pitch // 12 - 1}"


def _resolve_tuning(
    instrument: str,
    tuning: Optional[list[int]],
    tuning_name: Optional[str],
) -> tuple[Optional[list[int]], str]:
    if tuning:
        return [int(p) for p in tuning], "custom"
    if tuning_name:
        known = TUNINGS.get(tuning_name)
        return (known, tuning_name) if known else (None, tuning_name)
    name = _DEFAULT_TUNING_FOR_INSTRUMENT.get(instrument, "guitar-standard")
    return TUNINGS[name], name


def _read_events(midi_path: Path) -> list[_Event]:
    from music21 import chord, converter, note  # type: ignore[import]

    score = converter.parse(str(midi_path))
    try:
        score = score.quantize((4, 3), inPlace=False, recurse=True)
    except Exception as exc:  # noqa: BLE001 - quantize is best-effort
        log.debug("guitar_tab: quantize skipped for %s: %s", midi_path, exc)

    # Parsing a MIDI yields individual Note objects even for simultaneous
    # pitches, so group by onset to recover chords (a beat = one onset).
    by_offset: dict[float, dict[str, Any]] = {}
    for el in score.flatten().notes:
        ql = float(el.quarterLength or 0.0)
        if ql <= 0:
            ql = 1.0
        if isinstance(el, note.Note):
            pitches = [int(el.pitch.midi)]
        elif isinstance(el, chord.Chord):
            pitches = [int(p.midi) for p in el.pitches]
        else:
            continue
        offset = round(float(el.offset), 4)
        slot = by_offset.setdefault(offset, {"ql": ql, "pitches": set()})
        slot["ql"] = max(slot["ql"], ql)
        slot["pitches"].update(pitches)

    return [
        _Event(
            offset=offset,
            quarter_length=float(slot["ql"]),
            pitches=sorted(slot["pitches"]),
        )
        for offset, slot in sorted(by_offset.items())
    ]


def _positions_for_pitch(
    pitch: int, tuning: list[int], capo: int, max_fret: int
) -> list[tuple[int, int]]:
    """Playable ``(string_index, fret)`` positions for a pitch. ``string_index``
    is 0-based, low string first. Fret numbers are relative to the capo."""
    out: list[tuple[int, int]] = []
    for string_index, open_pitch in enumerate(tuning):
        fret = pitch - (open_pitch + capo)
        if 0 <= fret <= max_fret:
            out.append((string_index, fret))
    return out


def _placements_for_event(
    pitches: list[int],
    tuning: list[int],
    capo: int,
    max_fret: int,
    max_stretch: int,
) -> list[tuple[tuple[int, int], ...]]:
    """Feasible fingerings for one beat: assign every pitch to a distinct
    string with a hand span within ``max_stretch`` (open strings are free)."""
    per_pitch = [_positions_for_pitch(p, tuning, capo, max_fret) for p in pitches]
    if any(not candidates for candidates in per_pitch):
        return []  # at least one pitch is unplayable in this tuning / range

    placements: list[tuple[tuple[int, int], ...]] = []
    for examined, combo in enumerate(itertools.product(*per_pitch)):
        if examined >= _PRODUCT_ITER_CAP:
            break
        strings = [s for (s, _f) in combo]
        if len(set(strings)) != len(strings):
            continue  # two notes can't share a string
        fretted = [f for (_s, f) in combo if f > 0]
        if fretted and (max(fretted) - min(fretted)) > max_stretch:
            continue
        placements.append(tuple(combo))
        if len(placements) >= _PLACEMENT_CAP:
            break
    return placements


def _hand_position(placement: tuple[tuple[int, int], ...]) -> float:
    fretted = [f for (_s, f) in placement if f > 0]
    return sum(fretted) / len(fretted) if fretted else 0.0


def _position_cost(placement: tuple[tuple[int, int], ...]) -> float:
    return sum(f for (_s, f) in placement) * _LOW_FRET_WEIGHT


def _transition_cost(
    prev: tuple[tuple[int, int], ...], cur: tuple[tuple[int, int], ...]
) -> float:
    return abs(_hand_position(prev) - _hand_position(cur))


def _arrange(
    events: list[_Event],
    tuning: list[int],
    capo: int,
    max_fret: int,
    max_stretch: int,
) -> tuple[list[tuple[_Event, list[int], tuple[tuple[int, int], ...]]], int, int]:
    """Choose a fingering per beat. Returns ``(chosen, unplayable_events,
    dropped_notes)`` where ``chosen`` aligns each event's pitches with the
    selected ``(string_index, fret)`` positions."""
    nstrings = len(tuning)
    prepared: list[tuple[_Event, list[int], list[tuple[tuple[int, int], ...]]]] = []
    dropped = 0
    for ev in events:
        pitches = ev.pitches
        if len(pitches) > nstrings:
            # Can't play more notes than strings; keep the highest (melody).
            dropped += len(pitches) - nstrings
            pitches = pitches[-nstrings:]
        placements = _placements_for_event(pitches, tuning, capo, max_fret, max_stretch)
        prepared.append((ev, pitches, placements))

    playable = [(ev, p, pls) for (ev, p, pls) in prepared if pls]
    unplayable_events = len(prepared) - len(playable)
    if not playable:
        return [], unplayable_events, dropped

    n = len(playable)
    dp_cost: list[list[float]] = [[0.0] * len(p[2]) for p in playable]
    dp_back: list[list[int]] = [[-1] * len(p[2]) for p in playable]
    for j, placement in enumerate(playable[0][2]):
        dp_cost[0][j] = _position_cost(placement)
    for i in range(1, n):
        prev_placements = playable[i - 1][2]
        for j, placement in enumerate(playable[i][2]):
            pos_cost = _position_cost(placement)
            best_cost = float("inf")
            best_k = 0
            for k, prev in enumerate(prev_placements):
                cost = dp_cost[i - 1][k] + _transition_cost(prev, placement)
                if cost < best_cost:
                    best_cost = cost
                    best_k = k
            dp_cost[i][j] = pos_cost + best_cost
            dp_back[i][j] = best_k

    last = min(range(len(dp_cost[-1])), key=lambda x: dp_cost[-1][x])
    chosen_index = [0] * n
    for i in range(n - 1, -1, -1):
        chosen_index[i] = last
        last = dp_back[i][last]

    chosen = [
        (playable[i][0], playable[i][1], playable[i][2][chosen_index[i]])
        for i in range(n)
    ]
    return chosen, unplayable_events, dropped


def _quarter_length_to_duration(ql: float) -> int:
    """Map a quarter-length to the nearest alphaTex note value (1=whole … 32)."""
    if ql <= 0:
        return 4
    target = 4.0 / ql
    return min((1, 2, 4, 8, 16, 32), key=lambda d: abs(d - target))


def _build_alphatex(
    beats: list[tuple[float, float, list[tuple[int, int]]]],
    tuning: list[int],
    capo: int,
    title: str,
    tempo: Optional[int],
) -> str:
    """Render chosen beats to alphaTex. ``beats`` carries ``(offset, ql,
    placement)`` with placement as 1-based alphaTab ``(string, fret)`` pairs."""
    lines: list[str] = []
    if title:
        lines.append(f'\\title "{title}"')
    if tempo:
        lines.append(f"\\tempo {int(tempo)}")
    # alphaTex lists strings high-to-low; sounding pitch includes the capo.
    tuning_names = " ".join(_pitch_name(p + capo) for p in reversed(tuning))
    lines.append(f"\\tuning ({tuning_names})")
    lines.append(".")

    tokens: list[str] = []
    current_duration: Optional[int] = None
    current_bar: Optional[int] = None
    for offset, ql, placement in beats:
        bar = int(offset // 4.0)
        if current_bar is None:
            current_bar = bar
        elif bar != current_bar:
            tokens.append("|")
            current_bar = bar
        duration = _quarter_length_to_duration(ql)
        if duration != current_duration:
            tokens.append(f":{duration}")
            current_duration = duration
        if len(placement) == 1:
            string, fret = placement[0]
            tokens.append(f"{fret}.{string}")
        else:
            inner = " ".join(f"{fret}.{string}" for (string, fret) in placement)
            tokens.append(f"({inner})")

    lines.append(" ".join(tokens))
    return "\n".join(lines) + "\n"


def arrange_tabs(
    midi_path: Path,
    *,
    instrument: str = "guitar",
    tuning: Optional[list[int]] = None,
    tuning_name: Optional[str] = None,
    capo: int = 0,
    difficulty: str = "medium",
    title: str = "",
    tempo: Optional[int] = None,
) -> dict[str, Any]:
    """Arrange a MIDI file into tablature for a fretted instrument.

    Returns a result dict — never raises. On success it includes the chosen
    ``notes`` (each with 1-based ``string`` and capo-relative ``fret``), an
    ``alphatex`` render string, and ``stats``.
    """
    if not midi_path.is_file():
        return {"ok": False, "error": f"midi not found: {midi_path}"}
    try:
        import music21  # type: ignore[import] # noqa: F401
    except ImportError:
        return {"ok": False, "error": "music21 is not installed."}

    resolved_tuning, resolved_name = _resolve_tuning(instrument, tuning, tuning_name)
    if resolved_tuning is None:
        return {"ok": False, "error": f"unknown tuning: {tuning_name!r}"}
    capo = max(0, int(capo))
    max_fret, max_stretch = _DIFFICULTY.get(difficulty, _DIFFICULTY["medium"])

    try:
        events = _read_events(midi_path)
    except Exception as exc:  # noqa: BLE001
        log.warning("guitar_tab: failed to read %s: %s", midi_path, exc)
        return {"ok": False, "error": repr(exc)}
    if not events:
        return {"ok": False, "error": "no notes found in MIDI"}

    chosen, unplayable_events, dropped = _arrange(
        events, resolved_tuning, capo, max_fret, max_stretch
    )
    nstrings = len(resolved_tuning)

    notes: list[dict[str, Any]] = []
    beats: list[tuple[float, float, list[tuple[int, int]]]] = []
    for ev, pitches, placement in chosen:
        beat_placement: list[tuple[int, int]] = []
        for pitch, (string_index, fret) in zip(pitches, placement):
            string_number = nstrings - string_index
            notes.append(
                {
                    "string": string_number,
                    "fret": fret,
                    "pitch": pitch,
                    "offset": ev.offset,
                    "quarter_length": ev.quarter_length,
                }
            )
            beat_placement.append((string_number, fret))
        beat_placement.sort()
        beats.append((ev.offset, ev.quarter_length, beat_placement))

    alphatex = _build_alphatex(beats, resolved_tuning, capo, title, tempo)
    return {
        "ok": True,
        "instrument": instrument,
        "tuning": resolved_tuning,
        "tuning_name": resolved_name,
        "capo": capo,
        "difficulty": difficulty,
        "notes": notes,
        "alphatex": alphatex,
        "stats": {
            "events": len(events),
            "placed_events": len(chosen),
            "unplayable_events": unplayable_events,
            "dropped_notes": dropped,
            "note_count": len(notes),
        },
    }
