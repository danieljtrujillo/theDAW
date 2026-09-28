"""The composer's harmony planner: phrases that end where they should, carry
the chords asked for, and come out of the voice-leading checker clean.

Pure music21 + numpy; no model, no GPU.
"""

from __future__ import annotations

import re

import pytest

from backend.modules.composer.harmony import CADENCES, PlanError, plan_progression
from backend.modules.composer.voiceleading import SATB, check_parts, parse_key

KEYS = [("C", "major"), ("A", "minor"), ("F#", "minor"), ("Bb", "major")]


def _root_pc(chord: dict) -> int:
    from music21 import roman

    return (
        roman.RomanNumeral(chord["figure"], parse_key(chord["key"])).root().pitchClass
    )


def _recheck(plan: dict) -> list:
    """Run the plan's own parts back through the public checker, with the
    planned chords as the harmony."""
    return check_parts(
        plan["parts"],
        chords=[
            {"tick": c["tick"], "figure": c["figure"], "key": c["key"]}
            for c in plan["chords"]
        ],
        meter_map=plan["meter_map"],
    )


@pytest.mark.parametrize("tonic,mode", KEYS)
def test_a_phrase_ends_on_its_tonic_with_nothing_flagged(tonic: str, mode: str) -> None:
    plan = plan_progression(tonic, mode, bars=8, seed=1)
    k = parse_key(tonic, mode)
    last = plan["chords"][-1]
    assert _root_pc(last) == k.tonic.pitchClass
    assert last["pitches"]["bass"] % 12 == k.tonic.pitchClass
    # A perfect authentic cadence: the soprano ends on the tonic too.
    assert last["pitches"]["soprano"] % 12 == k.tonic.pitchClass
    assert plan["flags"] == []
    assert _recheck(plan) == []
    # Four parts, one note per chord, top voice above the next all the way down.
    for c in plan["chords"]:
        v = [c["pitches"][p] for p in SATB]
        assert v == sorted(v, reverse=True)
    assert all(len(plan["parts"][p]) == len(plan["chords"]) for p in SATB)


@pytest.mark.parametrize("tonic", ["A", "F#"])
def test_minor_key_dominants_carry_the_raised_leading_tone(tonic: str) -> None:
    plan = plan_progression(tonic, "minor", bars=8, seed=4, include=["seventh"])
    k = parse_key(tonic, "minor")
    lt = (k.tonic.pitchClass - 1) % 12
    dominants = [
        c
        for c in plan["chords"]
        if re.match(r"^V(?!I)", c["figure"]) and "/" not in c["figure"]
    ]
    assert dominants, "a minor phrase with a cadence has a V"
    for c in dominants:
        assert lt in {m % 12 for m in c["pitches"].values()}, c


def test_every_chromatic_chord_appears_when_asked() -> None:
    include = ["neapolitan", "italian", "french", "german", "applied", "seventh"]
    for tonic, mode in [("C", "major"), ("A", "minor")]:
        plan = plan_progression(tonic, mode, bars=8, seed=7, include=include)
        figures = {c["figure"] for c in plan["chords"]}
        assert {"N6", "It6", "Fr43", "Ger65", "V7/V"} <= figures, figures
        kinds = {c["kind"] for c in plan["chords"]}
        assert {
            "neapolitan",
            "italian_sixth",
            "french_sixth",
            "german_sixth",
            "applied_dominant",
            "seventh",
        } <= kinds
        assert plan["flags"] == []
        assert _recheck(plan) == []


def test_the_german_sixth_goes_through_the_cadential_six_four() -> None:
    plan = plan_progression("C", "major", bars=8, seed=2, include=["german"])
    figs = [c["figure"] for c in plan["chords"]]
    i = figs.index("Ger65")
    assert figs[i + 1 : i + 3] == ["I64", "V"]


def test_a_pivot_modulation_from_c_lands_in_g() -> None:
    plan = plan_progression("C", "major", bars=8, seed=3, modulate_to="G")
    assert plan["key"] == "C major"
    assert plan["final_key"] == "G major"
    last = plan["chords"][-1]
    assert last["key"] == "G major"
    assert _root_pc(last) == 7
    pivots = [c for c in plan["chords"] if c["kind"] == "pivot"]
    assert len(pivots) == 1
    pivot = pivots[0]
    assert pivot["key"] == "C major" and pivot["pivot"]["key"] == "G major"
    # The pivot is one triad read in both keys (vi in C is ii in G).
    from music21 import roman

    old = roman.RomanNumeral(pivot["figure"], parse_key("C"))
    new = roman.RomanNumeral(pivot["pivot"]["figure"], parse_key("G"))
    assert {p.pitchClass for p in old.pitches} == {p.pitchClass for p in new.pitches}
    after = plan["chords"][pivot["index"] + 1 :]
    assert all(c["key"] == "G major" for c in after)
    assert plan["flags"] == []


def test_a_key_that_is_not_closely_related_is_refused() -> None:
    with pytest.raises(PlanError):
        plan_progression("C", "major", bars=8, modulate_to="E")


@pytest.mark.parametrize("cadence", CADENCES)
def test_each_cadence_ends_on_its_own_chord(cadence: str) -> None:
    mode = "minor" if cadence == "phrygian_half" else "major"
    plan = plan_progression("D", mode, bars=6, seed=5, cadence=cadence)
    figs = [c["figure"] for c in plan["chords"]]
    ends = {
        "authentic_perfect": ["V", "I"],
        "authentic_imperfect": ["V", "I"],
        "half": ["V"],
        "plagal": ["IV", "I"],
        "deceptive": ["V7", "vi"],
        "phrygian_half": ["iv6", "V"],
    }[cadence]
    assert figs[-len(ends) :] == ends
    if cadence == "authentic_imperfect":
        assert plan["chords"][-1]["pitches"]["soprano"] % 12 != 2
    assert plan["flags"] == []


def test_the_same_seed_writes_the_same_phrase_and_another_seed_may_not() -> None:
    a = plan_progression("Eb", "major", bars=8, seed=11)
    b = plan_progression("Eb", "major", bars=8, seed=11)
    assert a == b
    others = [plan_progression("Eb", "major", bars=8, seed=s) for s in range(12, 16)]
    assert any(
        [c["figure"] for c in o["chords"]] != [c["figure"] for c in a["chords"]]
        for o in others
    )


def test_chords_sit_on_the_group_starts_of_an_additive_meter() -> None:
    meter_map = [{"bar": 0, "meter": {"num": 7, "den": 8, "groups": [2, 2, 3]}}]
    plan = plan_progression("C", "major", bars=4, seed=0, meter_map=meter_map)
    bar0 = [c for c in plan["chords"] if c["bar"] == 0]
    assert [c["tick"] for c in bar0] == [0, 960, 1920]
    assert [c["ticks"] for c in bar0] == [960, 960, 1440]
    assert [c["beat"] for c in bar0] == [1, 2, 3]
    last = plan["chords"][-1]
    assert (last["bar"], last["tick"], last["ticks"]) == (3, 3 * 3360, 3360)
    assert plan["flags"] == []


def test_one_chord_a_bar_and_too_few_bars() -> None:
    plan = plan_progression("G", "major", bars=6, harmonic_rhythm="bar", seed=0)
    assert [c["bar"] for c in plan["chords"]] == list(range(6))
    assert all(c["ticks"] == 3840 for c in plan["chords"])
    with pytest.raises(PlanError):
        plan_progression(
            "G", "major", bars=2, harmonic_rhythm="bar", include=["german"]
        )


def test_custom_ranges_are_kept() -> None:
    ranges = {"soprano": [62, 74], "bass": [43, 55]}
    plan = plan_progression("F", "major", bars=4, seed=0, ranges=ranges)
    for c in plan["chords"]:
        assert 62 <= c["pitches"]["soprano"] <= 74
        assert 43 <= c["pitches"]["bass"] <= 55
    assert plan["flags"] == []


# ---------------------------------------------------------------------------
# style profiles
# ---------------------------------------------------------------------------


def _labels(plan: dict) -> set[str]:
    from backend.modules.composer.romans import vocab_label

    return {vocab_label(c["figure"]) for c in plan["chords"]}


def test_bach_and_debussy_plans_from_one_seed_differ_in_vocabulary() -> None:
    bach = plan_progression("C", "major", bars=8, seed=3, style="bach")
    debussy = plan_progression("C", "major", bars=8, seed=3, style="debussy")
    assert bach["style"] == "bach" and debussy["style"] == "debussy"
    assert bach["flags"] == [] and debussy["flags"] == []
    assert _recheck(bach) == [] and _recheck(debussy) == []
    assert _labels(bach) != _labels(debussy)
    # Debussy's walks lean on mixture and modal chords, Bach's on the dominant.
    modal = {"bVII", "bVI", "bIII", "iv", "v", "II", "IV7", "I7"}
    many = [
        plan_progression("C", "major", bars=8, seed=s, style="debussy")
        for s in range(6)
    ]
    assert any(_labels(p) & modal for p in many)
    assert sum(
        sum(c["figure"].startswith("V") for c in p["chords"]) for p in many
    ) < sum(
        sum(c["figure"].startswith("V") for c in p["chords"])
        for p in (
            plan_progression("C", "major", bars=8, seed=s, style="bach")
            for s in range(6)
        )
    )


@pytest.mark.parametrize(
    "style",
    [
        "bach",
        "handel",
        "haydn",
        "mozart",
        "beethoven",
        "brahms",
        "tchaikovsky",
        "debussy",
        "stravinsky",
        "bartok",
    ],
)
@pytest.mark.parametrize("tonic,mode", [("D", "major"), ("G", "minor")])
def test_every_style_plans_clean_phrases(style: str, tonic: str, mode: str) -> None:
    plan = plan_progression(tonic, mode, bars=8, seed=5, style=style)
    assert plan["flags"] == []
    assert _recheck(plan) == []
    assert plan["harmonic_rhythm"] == "style"


def test_a_style_plan_is_the_same_plan_for_the_same_seed() -> None:
    a = plan_progression("E", "minor", bars=6, seed=11, style="brahms")
    b = plan_progression("E", "minor", bars=6, seed=11, style="brahms")
    assert a == b


def test_the_style_draws_the_cadence_unless_one_is_asked_for() -> None:
    from collections import Counter

    drawn = Counter(
        plan_progression("C", "major", bars=6, seed=s, style="debussy")["cadence"]
        for s in range(12)
    )
    assert len(drawn) > 1
    asked = plan_progression(
        "C", "major", bars=6, seed=0, style="debussy", cadence="authentic_perfect"
    )
    assert asked["cadence"] == "authentic_perfect"
    assert asked["chords"][-1]["figure"] == "I"


def test_a_slow_style_holds_chords_across_pulses() -> None:
    bach = plan_progression("C", "major", bars=8, seed=0, style="bach")
    stravinsky = plan_progression("C", "major", bars=8, seed=0, style="stravinsky")
    # Bach changes chord on every beat; Stravinsky's profile about one in four.
    assert len(bach["chords"]) == 29
    assert len(stravinsky["chords"]) < len(bach["chords"])
    held = [c for c in stravinsky["chords"][:-1] if c["ticks"] > 960]
    assert held
    pulse = plan_progression(
        "C", "major", bars=8, seed=0, style="stravinsky", harmonic_rhythm="pulse"
    )
    assert len(pulse["chords"]) == 29


def test_plain_plans_are_unchanged_by_the_style_machinery() -> None:
    plan = plan_progression("C", "major", bars=8, seed=1)
    assert plan["style"] is None and plan["harmonic_rhythm"] == "pulse"
    assert plan["cadence"] == "authentic_perfect"
    with pytest.raises(PlanError):
        plan_progression("C", "major", style="palestrina")
    with pytest.raises(PlanError):
        plan_progression("C", "major", harmonic_rhythm="style")
