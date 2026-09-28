"""The composer's form plans: sonata keys in the exposition and the
recapitulation, symphony movements in their conventional relations, pivot
chords wherever a section changes key, and realized sections the
voice-leading checker has nothing to say about.

Pure music21 + numpy; no model, no GPU.
"""

from __future__ import annotations

import time

import pytest

from backend.modules.composer.form import plan_form, realize_form
from backend.modules.composer.spec import SATB
from backend.modules.composer.voiceleading import check_parts, parse_key

Q = 960


def _sections(plan: dict, movement: int = 0) -> list[dict]:
    return plan["movements"][movement]["sections"]


def _find(plan: dict, role: str, part: str) -> dict:
    return next(s for s in _sections(plan) if s["role"] == role and s["part"] == part)


def _recheck(sec: dict, meter_map: list) -> list:
    return check_parts(
        sec["parts"],
        chords=[
            {"tick": c["tick"], "figure": c["figure"], "key": c["key"]}
            for c in sec["chords"]
        ],
        meter_map=meter_map,
    )


def _same(a: str, b: str) -> bool:
    ka, kb = parse_key(a), parse_key(b)
    return ka.tonic.pitchClass == kb.tonic.pitchClass and ka.mode == kb.mode


# ---------------------------------------------------------------------------
# sonata
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("seed", [0, 1, 2])
def test_a_major_key_sonata_puts_its_second_group_in_the_dominant_then_the_tonic(
    seed: int,
) -> None:
    plan = plan_form("sonata", "C", "major", seed=seed)
    expo = _find(plan, "second_group", "exposition")
    recap = _find(plan, "second_group", "recapitulation")
    assert expo["key"] == "G major"
    assert {c["key"] for c in expo["chords"]} == {"G major"}
    assert recap["key"] == "C major"
    assert {c["key"] for c in recap["chords"]} == {"C major"}
    # The transition gets to G through a pivot chord and stops on its dominant.
    tr = _find(plan, "transition", "exposition")
    pivots = [c for c in tr["chords"] if c["kind"] == "pivot"]
    assert len(pivots) == 1 and pivots[0]["pivot"]["key"] == "G major"
    assert tr["end_key"] == "G major"
    assert tr["phrases"][-1]["cadence"] == "half"
    assert tr["chords"][-1]["figure"] == "V" and tr["chords"][-1]["key"] == "G major"
    # The recapitulation's transition stays home.
    rtr = _find(plan, "transition", "recapitulation")
    assert {c["key"] for c in rtr["chords"]} == {"C major"}
    # The piece ends on a perfect authentic cadence in C.
    last = _sections(plan)[-1]
    assert last["role"] == "coda" and last["chords"][-1]["figure"] == "I"
    assert last["phrases"][-1]["cadence"] == "authentic_perfect"


@pytest.mark.parametrize(
    "tonic,relative", [("A", "C major"), ("F#", "A major"), ("c", "Eb major")]
)
def test_a_minor_key_sonata_puts_its_second_group_in_the_relative_major(
    tonic: str, relative: str
) -> None:
    plan = plan_form("sonata", tonic, "minor", seed=3)
    home = parse_key(tonic, "minor")
    expo = _find(plan, "second_group", "exposition")
    recap = _find(plan, "second_group", "recapitulation")
    assert _same(expo["key"], relative)
    assert all(_same(c["key"], relative) for c in expo["chords"])
    assert parse_key(recap["key"]).tonic.pitchClass == home.tonic.pitchClass
    assert parse_key(recap["key"]).mode == "minor"


def test_the_development_walks_remote_keys_and_ends_on_the_home_dominant() -> None:
    plan = plan_form("sonata", "C", "major", seed=4)
    dev = _find(plan, "development", "development")
    keys = [ph["modulate_to"] for ph in dev["phrases"] if ph["modulate_to"]]
    home = parse_key("C")
    # At least one key the tonic is not closely related to.
    assert any(abs(parse_key(k).sharps - home.sharps) >= 2 for k in keys)
    # The tonic is not touched until the retransition.
    assert "C major" not in keys[:-1]
    assert keys[-1] == "C major"
    assert dev["chords"][-1]["figure"] == "V" and dev["chords"][-1]["key"] == "C major"
    # Each hop is one pivot phrase.
    assert sum(1 for c in dev["chords"] if c["kind"] == "pivot") == len(keys)


def test_a_recapitulated_theme_brings_its_harmony_back() -> None:
    plan = plan_form("sonata", "D", "major", seed=6)
    a = _find(plan, "first_group", "exposition")
    b = _find(plan, "first_group", "recapitulation")
    assert [c["figure"] for c in a["chords"]] == [c["figure"] for c in b["chords"]]
    expo = _find(plan, "second_group", "exposition")
    recap = _find(plan, "second_group", "recapitulation")
    assert [c["figure"] for c in expo["chords"]] == [
        c["figure"] for c in recap["chords"]
    ]


def test_sections_run_past_sixteen_bars_and_bars_add_up() -> None:
    plan = plan_form("sonata", "Bb", "major", seed=1, bars=160)
    mv = plan["movements"][0]
    assert max(s["bars"] for s in mv["sections"]) > 16
    assert sum(s["bars"] for s in mv["sections"]) == mv["bars"] == plan["bars"]
    assert mv["bars"] >= 160
    # Sections and phrases lie end to end.
    bar = 0
    tick = 0
    for s in mv["sections"]:
        assert s["start_bar"] == bar and s["start_tick"] == tick
        assert sum(p["bars"] for p in s["phrases"]) == s["bars"]
        assert s["ticks"] == s["bars"] * 4 * Q
        bar += s["bars"]
        tick += s["ticks"]
    assert mv["ticks"] == tick


def test_a_plan_is_the_same_for_the_same_seed() -> None:
    assert plan_form("rondo", "G", seed=9) == plan_form("rondo", "G", seed=9)
    assert plan_form("rondo", "G", seed=9) != plan_form("rondo", "G", seed=10)


# ---------------------------------------------------------------------------
# key changes go through pivots
# ---------------------------------------------------------------------------


FORM_CASES = [
    ("sonata", "C", "major", {}),
    ("sonata", "E", "minor", {}),
    ("rondo", "F", "major", {"rondo": "ABACA"}),
    ("rondo", "g", None, {"rondo": "ABACABA"}),
    ("theme_and_variations", "D", "major", {"variations": 4}),
    ("minuet_and_trio", "G", "major", {}),
    ("scherzo", "c", None, {}),
]


@pytest.mark.parametrize("form,tonic,mode,opts", FORM_CASES)
def test_every_key_change_goes_through_a_pivot_chord(
    form: str, tonic: str, mode: str | None, opts: dict
) -> None:
    plan = plan_form(form, tonic, mode, seed=2, **opts)
    secs = _sections(plan)
    for prev, sec in zip(secs, secs[1:]):
        assert sec["enter_key"] == prev["end_key"]
        first = sec["phrases"][0]
        if _same(first["key"], prev["end_key"]):
            continue
        # A new key without a pivot: only the parallel-mode switch of a variation.
        assert sec["join"] == "direct", (sec["label"], prev["end_key"], first["key"])
        assert (
            parse_key(first["key"]).tonic.pitchClass
            == parse_key(prev["end_key"]).tonic.pitchClass
        )
    for sec in secs:
        for ph in sec["phrases"]:
            chords = [
                c
                for c in sec["chords"]
                if c["bar"] >= ph["start_bar"]
                and c["bar"] < ph["start_bar"] + ph["bars"]
            ]
            pivots = [c for c in chords if c["kind"] == "pivot"]
            if ph["modulate_to"]:
                assert (
                    len(pivots) == 1 and pivots[0]["pivot"]["key"] == ph["modulate_to"]
                )
                assert pivots[0]["key"] == ph["key"]
                assert chords[-1]["key"] == ph["modulate_to"]
            else:
                assert not pivots
                assert {c["key"] for c in chords} == {ph["key"]}
        # Where a section starts somewhere else, its first phrase is the pivot.
        if sec["join"] == "pivot":
            assert sec["phrases"][0]["modulate_to"] is not None


def test_rondo_episodes_and_refrains() -> None:
    plan = plan_form("rondo", "C", "major", seed=5, rondo="ABACABA")
    labels = [s["label"] for s in _sections(plan) if s["role"] != "retransition"]
    assert labels == list("ABACABA")
    keys = {s["label"]: [] for s in _sections(plan)}
    for s in _sections(plan):
        keys[s["label"]].append(s["key"])
    assert set(keys["A"]) == {"C major"}
    assert keys["B"] == ["G major", "C major"], "the last B is in the tonic"
    assert keys["C"][0] in ("A minor", "F major")
    # Each refrain after an episode in another key follows a retransition on V.
    secs = _sections(plan)
    for i, s in enumerate(secs):
        if s["label"] == "A" and i > 0 and not _same(secs[i - 1]["key"], "C major"):
            assert secs[i - 1]["role"] == "retransition"
            assert secs[i - 1]["chords"][-1]["figure"] == "V"


def test_variations_keep_the_theme_harmony_and_one_goes_minore() -> None:
    plan = plan_form("theme_and_variations", "F", "major", seed=1, variations=5)
    secs = _sections(plan)
    theme = [c["figure"] for c in secs[0]["chords"]]
    variations = [s for s in secs if s["role"] == "variation"]
    assert len(variations) == 5
    minore = [s for s in variations if s["key"] == "F minor"]
    assert len(minore) == 1 and "Minore" in minore[0]["label"]
    for v in variations:
        if v is not minore[0]:
            assert v["key"] == "F major"
            assert [c["figure"] for c in v["chords"]] == theme


def test_minuet_and_trio_shape() -> None:
    plan = plan_form("minuet_and_trio", "D", "major", seed=0)
    mv = plan["movements"][0]
    assert mv["meter"] == {"num": 3, "den": 4, "groups": []}
    roles = [s["role"] for s in mv["sections"]]
    assert roles == [
        "minuet",
        "minuet",
        "trio",
        "retransition",
        "minuet_da_capo",
        "minuet_da_capo",
    ]
    first, second, trio = mv["sections"][:3]
    assert first["end_key"] == "A major", "the first reprise closes in the dominant"
    assert second["end_key"] == "D major"
    assert trio["key"] == "G major", "the trio is in the subdominant"
    # Da capo: the minuet's harmony again.
    for a, b in (
        (mv["sections"][0], mv["sections"][4]),
        (mv["sections"][1], mv["sections"][5]),
    ):
        assert [c["figure"] for c in a["chords"]] == [c["figure"] for c in b["chords"]]
    scherzo = plan_form("scherzo", "D", "major", seed=0)["movements"][0]
    assert scherzo["tempo"]["bpm"] > mv["tempo"]["bpm"]
    assert scherzo["bars"] > mv["bars"]


# ---------------------------------------------------------------------------
# symphony
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "tonic,mode,slow",
    [
        ("C", "major", "F major"),
        ("Eb", "major", "Ab major"),
        ("D", "minor", "F major"),
        ("g", None, "Bb major"),
    ],
)
@pytest.mark.parametrize("seed", [0, 1, 2, 3])
def test_symphony_movements_follow_the_conventional_relations(
    tonic: str, mode: str | None, slow: str, seed: int
) -> None:
    plan = plan_form("symphony", tonic, mode, seed=seed)
    home = parse_key(tonic, mode)
    mvs = plan["movements"]
    assert len(mvs) == 4
    first, second, third, fourth = mvs
    assert (
        _same(first["key"], plan["key"]) and parse_key(first["key"]).mode == home.mode
    )
    assert first["form"] == "sonata"
    assert first["meter"] == {"num": 4, "den": 4, "groups": []}
    assert first["tempo"]["marking"] == "Allegro"

    assert _same(second["key"], slow)
    assert (second["meter"]["num"], second["meter"]["den"]) in ((2, 4), (3, 8))
    assert second["tempo"]["marking"] == "Andante"
    assert second["tempo"]["bpm"] < first["tempo"]["bpm"]

    assert _same(third["key"], first["key"])
    assert third["meter"] == {"num": 3, "den": 4, "groups": []}
    assert third["form"] in ("minuet_and_trio", "scherzo")
    assert third["tempo"]["marking"].split(":")[0] in ("Menuetto", "Scherzo")

    assert _same(fourth["key"], first["key"])
    assert fourth["tempo"]["marking"] in ("Allegro molto", "Presto")
    assert fourth["tempo"]["bpm"] >= first["tempo"]["bpm"]

    for mv in mvs:
        assert _same(mv["sections"][0]["key"], mv["key"])
        assert _same(mv["sections"][-1]["end_key"], mv["key"]), mv["title"]
        assert mv["sections"][0]["join"] == "start"
        assert mv["meter_map"] == [{"bar": 0, "meter": mv["meter"]}]
        assert (
            mv["tempo_map"][0]["beat"] == 0
            and mv["tempo_map"][0]["bpm"] == mv["tempo"]["bpm"]
        )
        assert all(s["meter"] == mv["meter"] for s in mv["sections"])
    assert plan["bars"] == sum(mv["bars"] for mv in mvs)


# ---------------------------------------------------------------------------
# realization
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("form,tonic,mode,opts", FORM_CASES)
def test_every_realized_section_has_no_flags(
    form: str, tonic: str, mode: str | None, opts: dict
) -> None:
    plan = realize_form(form, tonic, mode, seed=1, **opts)
    assert plan["flag_count"] == 0
    for mv in plan["movements"]:
        for sec in mv["sections"]:
            assert sec["flags"] == [], (sec["label"], sec["flags"])
            assert _recheck(sec, mv["meter_map"]) == [], sec["label"]
            for c in sec["chords"]:
                v = [c["pitches"][p] for p in SATB]
                assert v == sorted(v, reverse=True)
            for p in SATB:
                notes = sec["parts"][p]
                assert len(notes) == len(sec["chords"])
                assert notes[0]["tick"] == sec["start_tick"]


def test_a_realized_symphony_has_no_flags_and_ticks_per_movement() -> None:
    plan = realize_form("symphony", "A", "major", seed=2)
    assert plan["flag_count"] == 0
    for mv in plan["movements"]:
        assert mv["sections"][0]["start_tick"] == 0
        for sec in mv["sections"]:
            assert sec["flags"] == []
            assert _recheck(sec, mv["meter_map"]) == []
        last = mv["sections"][-1]
        assert last["start_tick"] + last["ticks"] == mv["ticks"]


def test_a_seven_eight_sonata_puts_its_chords_on_the_group_starts() -> None:
    meter = {"num": 7, "den": 8, "groups": [2, 2, 3]}
    plan = realize_form(
        "sonata", "D", "minor", seed=2, bars=48, meter=meter, harmonic_rhythm="pulse"
    )
    mv = plan["movements"][0]
    assert mv["meter_map"] == [{"bar": 0, "meter": meter}]
    assert plan["flag_count"] == 0
    bar = 7 * Q // 2
    for sec in mv["sections"]:
        for c in sec["chords"]:
            assert (c["tick"] % bar) in (0, Q, 2 * Q)


def test_a_two_hundred_bar_sonata_realizes_in_under_thirty_seconds() -> None:
    t0 = time.perf_counter()
    plan = realize_form("sonata", "C", "major", seed=7, bars=200)
    took = time.perf_counter() - t0
    assert plan["bars"] >= 200
    assert plan["flag_count"] == 0
    assert took < 30, f"{took:.1f} s"


def test_bad_requests_are_refused() -> None:
    from backend.modules.composer.harmony import PlanError

    with pytest.raises(PlanError):
        plan_form("fugue", "C")
    with pytest.raises(PlanError):
        plan_form("sonata", "C", bars=8)
    with pytest.raises(PlanError):
        plan_form("rondo", "C", rondo="ABAB")
    with pytest.raises(PlanError):
        plan_form("sonata", "C", harmonic_rhythm="beat")
    with pytest.raises(ValueError):
        plan_form("sonata", "H")
