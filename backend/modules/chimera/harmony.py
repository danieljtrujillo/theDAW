"""Harmonic planning for Chimera v2: Camelot wheel + minimal-shift target key.

Backend mirror of ``frontend/src/lib/camelot.ts`` (same MAJOR_NUM / MINOR_NUM
tables, sharp spelling, flat aliases) plus the solver that picks ONE target
key for the stack and the per-clip pitch shift (in semitones, capped) that
makes every tonal clip Camelot-compatible with it. Pure Python, no deps.
"""

from __future__ import annotations

import logging
from typing import Literal, Optional, TypedDict

log = logging.getLogger(__name__)

NOTE_NAMES: tuple[str, ...] = (
    "C",
    "C#",
    "D",
    "D#",
    "E",
    "F",
    "F#",
    "G",
    "G#",
    "A",
    "A#",
    "B",
)

# Common flat aliases so user-typed / tagged keys still resolve.
FLAT_TO_SHARP: dict[str, str] = {
    "Db": "C#",
    "Eb": "D#",
    "Gb": "F#",
    "Ab": "G#",
    "Bb": "A#",
}

# Camelot number by note, per ring (verbatim from camelot.ts).
#   Major: C=8B, then going up by fifths +1 around the wheel.
#   Minor: A=8A (relative minor of C major), same fifth logic.
MAJOR_NUM: dict[str, int] = {
    "C": 8,
    "C#": 3,
    "D": 10,
    "D#": 5,
    "E": 12,
    "F": 7,
    "F#": 2,
    "G": 9,
    "G#": 4,
    "A": 11,
    "A#": 6,
    "B": 1,
}
MINOR_NUM: dict[str, int] = {
    "A": 8,
    "A#": 3,
    "B": 10,
    "C": 5,
    "C#": 12,
    "D": 7,
    "D#": 2,
    "E": 9,
    "F": 4,
    "F#": 11,
    "G": 6,
    "G#": 1,
}

Scale = Literal["major", "minor"]
Letter = Literal["A", "B"]
Camelot = tuple[int, str]

# Shift cost by |semitones|; anything beyond the table is extrapolated.
COST: dict[int, float] = {0: 0.0, 1: 1.0, 2: 2.5, 3: 5.0}
_OUTLIER_COST = 6.0
_BASE_BONUS = 0.5
_STRENGTH_BONUS = 0.25


def normalize_note(s: Optional[str]) -> Optional[str]:
    """Return the sharp-spelled note name, or None when unrecognised."""
    if not s:
        return None
    n = str(s).strip()
    if not n:
        return None
    head = n[0].upper() + n[1:]
    # flat alias ('Bb', also 'Bbm' / 'Eb major' — the tail is ignored)
    if head[:2] in FLAT_TO_SHARP:
        return FLAT_TO_SHARP[head[:2]]
    cand = head[:2] if len(head) >= 2 and head[1] == "#" else head[:1]
    return cand if cand in NOTE_NAMES else None


def normalize_scale(s: Optional[str]) -> Scale:
    """'min', 'm', 'minor', 'aeolian' -> 'minor'; everything else 'major'."""
    v = (s or "").strip().lower()
    if v.startswith("min") or v == "m" or v == "aeolian":
        return "minor"
    return "major"


def camelot(key: Optional[str], scale: Optional[str]) -> Optional[Camelot]:
    """(number, letter) for a note + scale; None when the note is unknown."""
    n = normalize_note(key)
    if n is None:
        return None
    if normalize_scale(scale) == "minor":
        return MINOR_NUM[n], "A"
    return MAJOR_NUM[n], "B"


def camelot_code(key: Optional[str], scale: Optional[str]) -> Optional[str]:
    """'8B'-style code, or None when the note is unknown."""
    c = camelot(key, scale)
    return f"{c[0]}{c[1]}" if c else None


def compatible(a: Camelot, b: Camelot) -> bool:
    """Standard Camelot rule: same code, +/-1 on the same ring (12 <-> 1
    wraps), or the same number on the other ring (relative major/minor)."""
    na, la = a
    nb, lb = b
    if la == lb:
        d = (na - nb) % 12
        return d in (0, 1, 11)
    return na == nb


def shift_key(key: str, semitones: int) -> str:
    """Pitch-class arithmetic: 'A' + 3 -> 'C'."""
    n = normalize_note(key)
    if n is None:
        raise ValueError(f"unknown key {key!r}")
    return NOTE_NAMES[(NOTE_NAMES.index(n) + int(semitones)) % 12]


class KeyInput(TypedDict, total=False):
    key: Optional[str]
    scale: Optional[str]
    key_confidence: Optional[float]
    key_strength: Optional[float]
    tonal: bool
    weight: float
    is_base: bool


class ClipHarmony(TypedDict):
    shift_semitones: int
    compatible: bool
    atonal: bool
    outlier: bool
    camelot: Optional[str]  # the clip's OWN (unshifted) Camelot code


class HarmonyPlan(TypedDict):
    target_key: Optional[str]
    target_scale: Optional[str]
    target_camelot: Optional[str]
    source: Literal["base", "solver", "none"]
    per_clip: list[ClipHarmony]


def _shift_order(max_shift: int) -> list[int]:
    """0, -1, +1, -2, +2, ... so ties prefer shifting DOWN."""
    out = [0]
    for k in range(1, max(0, int(max_shift)) + 1):
        out.extend((-k, k))
    return out


def _cost(k: int) -> float:
    a = abs(int(k))
    if a in COST:
        return COST[a]
    return COST[3] + 2.5 * (a - 3)


def _candidates() -> list[tuple[str, Scale]]:
    """All 24 targets in C-major-first ordering (majors C..B, then minors)."""
    out: list[tuple[str, Scale]] = [(n, "major") for n in NOTE_NAMES]
    out.extend((n, "minor") for n in NOTE_NAMES)
    return out


def _empty_plan(clips: list[KeyInput]) -> HarmonyPlan:
    per: list[ClipHarmony] = []
    for c in clips:
        code = camelot_code(c.get("key"), c.get("scale"))
        per.append(
            {
                "shift_semitones": 0,
                "compatible": True,
                "atonal": not _is_tonal(c),
                "outlier": False,
                "camelot": code,
            }
        )
    return {
        "target_key": None,
        "target_scale": None,
        "target_camelot": None,
        "source": "none",
        "per_clip": per,
    }


def _is_tonal(c: KeyInput) -> bool:
    if normalize_note(c.get("key")) is None:
        return False
    return bool(c.get("tonal", True))


def _strength(c: KeyInput) -> float:
    s = c.get("key_strength")
    if s is None:
        s = c.get("key_confidence")
    return float(s) if s is not None else 0.0


def choose_target_key(
    clips: list[KeyInput],
    max_shift: int = 2,
    mode: str = "auto",
) -> HarmonyPlan:
    """Pick the target key minimising the weighted shift cost across the stack.

    For each of the 24 candidate targets, every tonal clip takes the smallest
    |k| in ``[-max_shift, max_shift]`` (down preferred on ties) whose shifted
    key is Camelot-compatible with the target; cost ``COST[|k|] * weight``,
    or ``6.0 * weight`` and ``outlier`` when none fits. The base clip's own
    key gets -0.5, the highest-``key_strength`` clip's key -0.25. Ties break
    on the C-major-first candidate ordering. Atonal clips (``tonal`` False or
    no key) get shift 0 and never count. ``mode == 'off'`` or no tonal clip
    -> target None, all shifts 0, source 'none'.
    """
    if mode == "off":
        return _empty_plan(clips)
    tonal_idx = [i for i, c in enumerate(clips) if _is_tonal(c)]
    if not tonal_idx:
        return _empty_plan(clips)

    base_ct: Optional[Camelot] = None
    for i in tonal_idx:
        if clips[i].get("is_base"):
            base_ct = camelot(clips[i].get("key"), clips[i].get("scale"))
            break
    strong_i = max(tonal_idx, key=lambda i: (_strength(clips[i]), -i))
    strong_ct = camelot(clips[strong_i].get("key"), clips[strong_i].get("scale"))

    order = _shift_order(max_shift)
    best_total = float("inf")
    best_target: tuple[str, Scale] = ("C", "major")
    best_shifts: dict[int, tuple[int, bool]] = {}
    for note, scale in _candidates():
        target_ct = camelot(note, scale)
        assert target_ct is not None
        total = 0.0
        shifts: dict[int, tuple[int, bool]] = {}
        for i in tonal_idx:
            c = clips[i]
            w = max(0.0, float(c.get("weight", 1.0)))
            key = str(c.get("key"))
            scl = c.get("scale")
            found: Optional[int] = None
            for k in order:
                ct = camelot(shift_key(key, k), scl)
                if ct is not None and compatible(ct, target_ct):
                    found = k
                    break
            if found is None:
                total += _OUTLIER_COST * w
                shifts[i] = (0, True)
            else:
                total += _cost(found) * w
                shifts[i] = (found, False)
        if base_ct is not None and target_ct == base_ct:
            total -= _BASE_BONUS
        if strong_ct is not None and target_ct == strong_ct:
            total -= _STRENGTH_BONUS
        if total < best_total - 1e-9:
            best_total = total
            best_target = (note, scale)
            best_shifts = shifts

    target_ct = camelot(best_target[0], best_target[1])
    per: list[ClipHarmony] = []
    for i, c in enumerate(clips):
        code = camelot_code(c.get("key"), c.get("scale"))
        if i not in best_shifts:
            per.append(
                {
                    "shift_semitones": 0,
                    "compatible": False,
                    "atonal": True,
                    "outlier": False,
                    "camelot": code,
                }
            )
            continue
        k, outlier = best_shifts[i]
        per.append(
            {
                "shift_semitones": int(k),
                "compatible": not outlier,
                "atonal": False,
                "outlier": outlier,
                "camelot": code,
            }
        )
    source: Literal["base", "solver"] = (
        "base" if base_ct is not None and target_ct == base_ct else "solver"
    )
    log.debug(
        "choose_target_key: target=%s %s cost=%.2f shifts=%s",
        best_target[0],
        best_target[1],
        best_total,
        [p["shift_semitones"] for p in per],
    )
    return {
        "target_key": best_target[0],
        "target_scale": best_target[1],
        "target_camelot": camelot_code(best_target[0], best_target[1]),
        "source": source,
        "per_clip": per,
    }


def prompt_hint(bpm: float, plan: HarmonyPlan) -> str:
    """'124 BPM' or '124 BPM, key of A minor' (rounded bpm)."""
    s = f"{int(round(float(bpm)))} BPM"
    if plan.get("target_key") and plan.get("target_scale"):
        s += f", key of {plan['target_key']} {plan['target_scale']}"
    return s
