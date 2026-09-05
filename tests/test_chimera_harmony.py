"""Unit tests for backend.modules.chimera.harmony (Camelot + target key solver)."""

from __future__ import annotations

import pytest

from backend.modules.chimera.harmony import (
    KeyInput,
    camelot,
    camelot_code,
    choose_target_key,
    compatible,
    normalize_note,
    normalize_scale,
    prompt_hint,
    shift_key,
)

# Verbatim expectations from frontend/src/lib/camelot.ts.
_MAJOR = {
    "C": "8B",
    "C#": "3B",
    "D": "10B",
    "D#": "5B",
    "E": "12B",
    "F": "7B",
    "F#": "2B",
    "G": "9B",
    "G#": "4B",
    "A": "11B",
    "A#": "6B",
    "B": "1B",
}
_MINOR = {
    "A": "8A",
    "A#": "3A",
    "B": "10A",
    "C": "5A",
    "C#": "12A",
    "D": "7A",
    "D#": "2A",
    "E": "9A",
    "F": "4A",
    "F#": "11A",
    "G": "6A",
    "G#": "1A",
}


def _clip(
    key: str | None,
    scale: str | None,
    *,
    tonal: bool = True,
    weight: float = 1.0,
    is_base: bool = False,
    strength: float | None = None,
) -> KeyInput:
    return {
        "key": key,
        "scale": scale,
        "key_confidence": 0.5,
        "key_strength": strength,
        "tonal": tonal,
        "weight": weight,
        "is_base": is_base,
    }


def test_camelot_table_parity_with_frontend():
    for note, code in _MAJOR.items():
        assert camelot_code(note, "major") == code
    for note, code in _MINOR.items():
        assert camelot_code(note, "minor") == code
    assert camelot_code("C", "major") == "8B"
    assert camelot_code("A", "minor") == "8A"
    assert camelot_code("F#", "minor") == "11A"
    assert camelot_code("B", "major") == "1B"
    assert camelot("C", "major") == (8, "B")


def test_normalizers_match_frontend():
    assert normalize_note("Bb") == "A#"
    assert normalize_note("db") == "C#"
    assert normalize_note(" f# ") == "F#"
    assert normalize_note("H") is None
    assert normalize_note(None) is None
    assert normalize_scale("min") == "minor"
    assert normalize_scale("m") == "minor"
    assert normalize_scale("Aeolian") == "minor"
    assert normalize_scale("maj") == "major"
    assert normalize_scale(None) == "major"
    assert camelot_code("Eb", "min") == camelot_code("D#", "minor")
    assert camelot_code("X", "major") is None


def test_compatible_rules():
    assert compatible((8, "B"), (8, "B"))
    assert compatible((8, "B"), (9, "B"))
    assert compatible((8, "B"), (7, "B"))
    assert compatible((8, "B"), (8, "A"))
    assert compatible((12, "B"), (1, "B"))
    assert compatible((1, "A"), (12, "A"))
    assert not compatible((8, "B"), (10, "B"))
    assert not compatible((8, "B"), (9, "A"))
    assert not compatible((8, "B"), (6, "B"))


def test_shift_key_wraps():
    assert shift_key("A", 3) == "C"
    assert shift_key("C", -1) == "B"
    assert shift_key("B", 1) == "C"
    assert shift_key("G#", 12) == "G#"
    assert shift_key("Bb", -2) == "G#"
    with pytest.raises(ValueError):
        shift_key("Q", 1)


def test_relative_keys_no_shift():
    plan = choose_target_key([_clip("A", "minor"), _clip("C", "major")])
    assert [p["shift_semitones"] for p in plan["per_clip"]] == [0, 0]
    assert (plan["target_key"], plan["target_scale"]) in {
        ("A", "minor"),
        ("C", "major"),
    }
    assert plan["target_camelot"] in {"8A", "8B"}
    assert plan["source"] == "solver"
    assert all(p["compatible"] and not p["outlier"] for p in plan["per_clip"])
    assert plan["per_clip"][0]["camelot"] == "8A"
    assert plan["per_clip"][1]["camelot"] == "8B"


def test_fifth_neighbours_need_no_shift():
    # G (9B) and A (11B) are both neighbours of D (10B): no shift needed.
    plan = choose_target_key([_clip("G", "major"), _clip("A", "major")], max_shift=2)
    assert [p["shift_semitones"] for p in plan["per_clip"]] == [0, 0]
    assert plan["target_camelot"] == "10B"


def test_min_total_shift_prefers_down():
    # F# major (2B) vs C major (8B): a tritone apart, one clip must move one
    # semitone. Both -1 and +1 land next to the target; the solver takes -1.
    plan = choose_target_key([_clip("F#", "major"), _clip("C", "major")], max_shift=2)
    shifts = [p["shift_semitones"] for p in plan["per_clip"]]
    assert sum(abs(s) for s in shifts) == 1
    assert sorted(shifts) == [-1, 0]
    assert not any(p["outlier"] for p in plan["per_clip"])
    target = camelot(plan["target_key"], plan["target_scale"])
    assert target is not None
    for c, p in zip([("F#", "major"), ("C", "major")], plan["per_clip"]):
        shifted = camelot(shift_key(c[0], p["shift_semitones"]), c[1])
        assert shifted is not None and compatible(shifted, target)


def test_atonal_clip_unshifted():
    plan = choose_target_key(
        [_clip("F#", "major", tonal=False), _clip("C", "major"), _clip(None, None)]
    )
    assert plan["target_camelot"] == "8B"
    assert plan["per_clip"][0]["shift_semitones"] == 0
    assert plan["per_clip"][0]["atonal"] is True
    assert plan["per_clip"][2]["atonal"] is True
    assert plan["per_clip"][2]["camelot"] is None
    assert plan["per_clip"][1]["shift_semitones"] == 0
    assert plan["per_clip"][1]["atonal"] is False
    # only atonal clips -> no target at all
    none = choose_target_key([_clip("C", "major", tonal=False)])
    assert none["target_key"] is None
    assert none["source"] == "none"


def test_outlier_flagged():
    # E major (12B) vs A# major (6B) sit opposite on the wheel. With no
    # shifting allowed nothing is compatible with both -> one outlier.
    plan = choose_target_key([_clip("E", "major"), _clip("A#", "major")], max_shift=0)
    outliers = [p["outlier"] for p in plan["per_clip"]]
    assert outliers.count(True) == 1
    assert all(p["shift_semitones"] == 0 for p in plan["per_clip"])
    flagged = plan["per_clip"][outliers.index(True)]
    assert flagged["compatible"] is False and flagged["atonal"] is False
    # a two-semitone budget resolves the same pair (D# major 5B ~ 6B)
    ok = choose_target_key([_clip("E", "major"), _clip("A#", "major")], max_shift=2)
    assert not any(p["outlier"] for p in ok["per_clip"])


def test_base_key_wins_ties():
    plan = choose_target_key([_clip("A", "minor"), _clip("C", "major", is_base=True)])
    assert (plan["target_key"], plan["target_scale"]) == ("C", "major")
    assert plan["source"] == "base"
    plan = choose_target_key([_clip("A", "minor", is_base=True), _clip("C", "major")])
    assert (plan["target_key"], plan["target_scale"]) == ("A", "minor")
    assert plan["source"] == "base"


def test_strongest_key_breaks_ties_without_base():
    plan = choose_target_key(
        [_clip("A", "minor", strength=0.9), _clip("C", "major", strength=0.1)]
    )
    assert (plan["target_key"], plan["target_scale"]) == ("A", "minor")
    assert plan["source"] == "solver"


def test_mode_off_zero_shifts():
    plan = choose_target_key([_clip("E", "major"), _clip("A#", "major")], mode="off")
    assert plan["target_key"] is None
    assert plan["target_scale"] is None
    assert plan["target_camelot"] is None
    assert plan["source"] == "none"
    assert all(p["shift_semitones"] == 0 for p in plan["per_clip"])
    assert all(not p["outlier"] for p in plan["per_clip"])
    assert plan["per_clip"][0]["camelot"] == "12B"


def test_prompt_hint_format():
    plan = choose_target_key([_clip("A", "minor", is_base=True)])
    assert prompt_hint(124.3, plan) == "124 BPM, key of A minor"
    assert prompt_hint(124.3, choose_target_key([], mode="off")) == "124 BPM"
