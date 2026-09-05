"""Beat Saber lane / layer / colour / cut / difficulty assignment for note charts.

Pure dict arithmetic over the ``gantasmo.notechart`` part blocks; no music21.
The mapping is computed ONCE here and carried on every chart event as five
additive integer fields (``bsLine``, ``bsLayer``, ``bsColor``, ``bsCut``,
``bsMinDifficulty``) so that :mod:`.beatsaber` (the ``.dat`` writer) and the web
highway's "blocks" skin render exactly the same notes without a second, drifting
implementation. Unity's ``JsonUtility`` ignores the extra fields.

Difficulty sets are monotone by construction: an event kept at ``Easy`` is kept
at every harder level, so ``notes_for_level(level)`` is a superset of
``notes_for_level(level - 1)``.

Value vocabulary (Beat Saber v2/v3 beatmap semantics, BSMG reference):
  line index 0..3 (0 = leftmost), line layer 0..2 (0 = bottom),
  colour 0 = red/left saber, 1 = blue/right saber,
  cut direction 0 Up, 1 Down, 2 Left, 3 Right, 4 UpLeft, 5 UpRight,
  6 DownLeft, 7 DownRight, 8 Any.
"""

from __future__ import annotations

import math
from typing import Any, Optional

# (name, Info.dat _difficultyRank, note jump movement speed)
DIFFICULTIES: list[tuple[str, int, float]] = [
    ("Easy", 1, 10.0),
    ("Normal", 3, 12.0),
    ("Hard", 5, 14.0),
    ("Expert", 7, 16.0),
    ("ExpertPlus", 9, 18.0),
]
DIFFICULTY_NAMES: list[str] = [name for name, _, _ in DIFFICULTIES]

# Every event carries these; -1 means "never a Beat Saber note".
BS_DEFAULTS: dict[str, int] = {
    "bsLine": 0,
    "bsLayer": 0,
    "bsColor": 0,
    "bsCut": 8,
    "bsMinDifficulty": -1,
}

CUT_UP = 0
CUT_DOWN = 1
CUT_ANY = 8

# Grid an onset must sit on (in quarter-note beats) to be admitted at a level;
# None admits any onset. Fractional tolerance is GRID_TOLERANCE of a grid unit.
GRID: dict[int, Optional[float]] = {0: 1.0, 1: 0.5, 2: 0.25, 3: None, 4: None}
GRID_TOLERANCE = 0.125
# Minimum seconds between two consecutive notes of the SAME hand at a level.
MIN_GAP: dict[int, float] = {0: 0.5, 1: 0.3, 2: 0.18, 3: 0.10, 4: 0.0}


def _f(value: Any, default: float = 0.0) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    return out if math.isfinite(out) else default


def _i(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def is_candidate(event: dict[str, Any], is_percussion: bool) -> bool:
    """Whether one chart event can become a Beat Saber note at all.

    Rests, graces, tie continuations, irrational tuplets and non-root chord
    members never do; neither does anything in a percussion part (a drum hit has
    no pitch to place on the grid, and the drums skin owns those events).
    """
    if is_percussion:
        return False
    if event.get("isRest") or event.get("isGrace"):
        return False
    if event.get("tie", "") not in ("", "start"):
        return False
    if event.get("tupletBracket", "") == "irrational":
        return False
    chord_id = _i(event.get("chordId", -1), -1)
    if chord_id != -1 and not event.get("isChordRoot"):
        return False
    return True


def _median(values: list[float]) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2.0


def _layer_for(staff_step: int) -> int:
    if staff_step < 2:
        return 0
    if staff_step <= 6:
        return 1
    return 2


def _on_grid(beats: float, unit: Optional[float]) -> bool:
    if unit is None:
        return True
    ratio = beats / unit
    return abs(ratio - round(ratio)) <= GRID_TOLERANCE


def assign(parts: list[dict[str, Any]], *, include_percussion: bool = False) -> dict:
    """Stamp ``bs*`` fields on every event of every part, in place.

    Returns ``{"candidates": n, "perDifficulty": {name: count}}`` where
    ``perDifficulty[name]`` counts the notes present at that level (cumulative).
    Non-candidates keep :data:`BS_DEFAULTS` (``bsMinDifficulty`` -1).
    """
    # (1) collect candidates per part, resetting every event to the defaults so
    # a re-run over an already mapped chart cannot leak stale values.
    per_part: dict[int, list[dict[str, Any]]] = {}
    for part_index, part in enumerate(parts):
        percussion = bool(part.get("isPercussion")) and not include_percussion
        for event in part.get("events", []):
            event.update(BS_DEFAULTS)
            if is_candidate(event, percussion):
                per_part.setdefault(part_index, []).append(event)

    if not per_part:
        return {
            "candidates": 0,
            "perDifficulty": {name: 0 for name in DIFFICULTY_NAMES},
        }

    medians: dict[int, float] = {}
    means: dict[int, float] = {}
    for part_index, events in per_part.items():
        midis = [_f(e.get("midi")) for e in events]
        medians[part_index] = _median(midis)
        means[part_index] = sum(midis) / len(midis)

    # Global onset order; ties broken by part then pitch so the walk is stable.
    ordered: list[tuple[int, dict[str, Any]]] = [
        (part_index, event)
        for part_index, events in per_part.items()
        for event in events
    ]
    ordered.sort(
        key=lambda item: (
            _f(item[1].get("onsetSecRaw")),
            item[0],
            _f(item[1].get("midi")),
        )
    )

    # (2) hand assignment.
    multi_part = len(per_part) >= 2
    red_part = min(means, key=lambda idx: (means[idx], idx)) if multi_part else -1

    last_midi: dict[int, Optional[float]] = {0: None, 1: None}
    last_onset: dict[int, list[float]] = {
        0: [-math.inf] * len(DIFFICULTIES),
        1: [-math.inf] * len(DIFFICULTIES),
    }
    per_level = [0] * len(DIFFICULTIES)

    for order_index, (part_index, event) in enumerate(ordered):
        if multi_part:
            hand = 0 if part_index == red_part else 1
        else:
            hand = order_index % 2
        midi = _f(event.get("midi"))
        median = medians[part_index]

        # (3) line: red on the left half, blue on the right; low pitch outward.
        if hand == 0:
            line = 0 if midi < median else 1
        else:
            line = 3 if midi < median else 2

        # (4) layer from the staff position.
        layer = _layer_for(_i(event.get("staffStep"), 4))

        # (5) cut from the melodic direction within the same hand.
        previous = last_midi[hand]
        if previous is None or midi == previous:
            cut = CUT_ANY
        elif midi > previous:
            cut = CUT_UP
        else:
            cut = CUT_DOWN
        last_midi[hand] = midi

        # (6) first level whose grid and per-hand gap admit this onset.
        onset_sec = _f(event.get("onsetSecRaw"))
        onset_beats = _f(event.get("onsetBeats"))
        level = len(DIFFICULTIES) - 1
        for candidate_level in range(len(DIFFICULTIES)):
            gap = onset_sec - last_onset[hand][candidate_level]
            if (
                _on_grid(onset_beats, GRID[candidate_level])
                and gap >= MIN_GAP[candidate_level]
            ):
                level = candidate_level
                break
        for later in range(level, len(DIFFICULTIES)):
            last_onset[hand][later] = onset_sec
            per_level[later] += 1

        event["bsLine"] = line
        event["bsLayer"] = layer
        event["bsColor"] = hand
        event["bsCut"] = cut
        event["bsMinDifficulty"] = level

    return {
        "candidates": len(ordered),
        "perDifficulty": {
            name: per_level[index] for index, (name, _, _) in enumerate(DIFFICULTIES)
        },
    }


def notes_for_level(
    parts: list[dict[str, Any]],
    level: int,
    part_indices: Optional[list[int]] = None,
) -> list[dict[str, Any]]:
    """Mapped events present at ``level`` (0 Easy .. 4 ExpertPlus).

    Sorted by raw onset then line so a ``.dat`` writer emits them in order.
    ``part_indices`` restricts the parts; ``None`` means every part.
    """
    wanted = None if part_indices is None else {int(i) for i in part_indices}
    out: list[dict[str, Any]] = []
    for part_index, part in enumerate(parts):
        if wanted is not None and part_index not in wanted:
            continue
        for event in part.get("events", []):
            minimum = _i(event.get("bsMinDifficulty", -1), -1)
            if 0 <= minimum <= level:
                out.append(event)
    out.sort(key=lambda e: (_f(e.get("onsetSecRaw")), _i(e.get("bsLine"))))
    return out


def level_index(name: str) -> int:
    """Index of a difficulty name in :data:`DIFFICULTIES`, or -1."""
    lowered = (name or "").strip().lower().replace("+", "plus").replace(" ", "")
    for index, (known, _, _) in enumerate(DIFFICULTIES):
        if known.lower() == lowered:
            return index
    return -1
