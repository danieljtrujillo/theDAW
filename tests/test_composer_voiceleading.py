"""The composer's voice-leading checker and meter mapping, on hand-written
four-part examples in C major. Each faulty example breaks one rule; the
Bach-style cadence breaks none.

Pure music21; no model, no GPU.
"""

from __future__ import annotations

from backend.modules.composer.meter import MeterGrid, time_signature, sanitize_meter
from backend.modules.composer.voiceleading import check_parts, parse_key
from tests.timing_bounds import prompt_seconds

Q = 960
C = parse_key("C")


def _part(pitches: list[int]) -> list[dict]:
    return [{"note": p, "tick": i * Q, "ticks": Q} for i, p in enumerate(pitches)]


def _satb(s: list[int], a: list[int], t: list[int], b: list[int]) -> dict:
    return {"soprano": _part(s), "alto": _part(a), "tenor": _part(t), "bass": _part(b)}


def _rules(flags) -> list[tuple[str, list[str], int]]:
    return [(f.rule, f.parts, f.tick) for f in flags]


def test_a_bach_style_cadence_passes() -> None:
    # I - ii6/5 - V7 - I: the seventh of ii6/5 (C) and of V7 (F) fall by step,
    # the leading tone rises to the tonic.
    parts = _satb(
        [72, 74, 74, 72],
        [67, 69, 65, 64],
        [64, 60, 59, 60],
        [48, 53, 55, 48],
    )
    assert check_parts(parts, key=C) == []
    # The same with the harmony named, and with no key at all (music21 finds C).
    chords = [
        {"tick": 0, "figure": "I", "key": "C"},
        {"tick": Q, "figure": "ii65", "key": "C"},
        {"tick": 2 * Q, "figure": "V7", "key": "C"},
        {"tick": 3 * Q, "figure": "I", "key": "C"},
    ]
    assert check_parts(parts, chords=chords) == []
    assert check_parts(parts) == []


def test_parallel_fifths_are_caught() -> None:
    parts = _satb([67, 69], [64, 65], [60, 62], [48, 53])
    flags = check_parts(parts, key=C)
    assert _rules(flags) == [("parallel_fifths", ["soprano", "tenor"], Q)]
    f = flags[0]
    assert (f.bar, f.beat) == (0, 2)
    assert "G4/C4 to A4/D4" in f.message


def test_parallel_octaves_are_caught() -> None:
    parts = _satb([72, 74], [67, 69], [64, 65], [48, 50])
    rules = {r for r, _p, _t in _rules(check_parts(parts, key=C))}
    assert "parallel_octaves" in rules and "parallel_fifths" in rules


def test_a_hidden_octave_in_the_outer_voices_is_caught() -> None:
    # IV -> I: the soprano leaps A4 -> C5 while the bass rises F2 -> C3,
    # similar motion into an octave.
    parts = _satb([69, 72], [65, 67], [60, 64], [41, 48])
    assert _rules(check_parts(parts, key=C)) == [
        ("hidden_octaves", ["soprano", "bass"], Q)
    ]


def test_a_hidden_fifth_reached_by_step_in_the_soprano_passes() -> None:
    # Soprano F5 -> G5 by step, bass up to C3: the common-practice exception.
    parts = _satb([77, 79], [69, 72], [60, 64], [41, 48])
    assert "hidden_fifths" not in {r for r, _p, _t in _rules(check_parts(parts, key=C))}


def test_voice_crossing_is_caught() -> None:
    parts = _satb([67, 67], [72, 72], [64, 64], [48, 48])
    assert _rules(check_parts(parts, key=C)) == [
        ("voice_crossing", ["soprano", "alto"], 0)
    ]


def test_spacing_over_an_octave_is_caught() -> None:
    parts = _satb([79, 79], [64, 64], [60, 60], [48, 48])
    assert _rules(check_parts(parts, key=C)) == [("spacing", ["soprano", "alto"], 0)]


def test_an_unresolved_leading_tone_is_caught() -> None:
    # V -> vi with the soprano's B4 falling to A4 instead of rising to C5.
    parts = _satb([71, 69], [67, 64], [62, 60], [55, 57])
    flags = check_parts(parts, key=C)
    assert _rules(flags) == [("unresolved_leading_tone", ["soprano"], 0)]
    assert "B4" in flags[0].message


def test_an_unresolved_seventh_is_caught() -> None:
    # V7 -> I with the alto's F4 leaping up to G4.
    parts = _satb([74, 72], [65, 67], [59, 60], [55, 48])
    rules = [r for r, _p, _t in _rules(check_parts(parts, key=C))]
    assert rules == ["unresolved_seventh"]


def test_an_out_of_range_note_is_caught_with_custom_ranges() -> None:
    parts = _satb([81, 81], [72, 72], [64, 64], [48, 48])
    assert _rules(check_parts(parts, key=C)) == [("range", ["soprano"], 0)]
    # A wider soprano, as an instrument registry would pass it, lets it through.
    assert check_parts(parts, key=C, ranges={"soprano": [60, 84]}) == []
    # And a part can be named anything, with its range given.
    renamed = {"violin": parts["soprano"], "viola": parts["alto"]}
    flags = check_parts(renamed, key=C, ranges={"violin": [55, 79]})
    assert _rules(flags) == [("range", ["violin"], 0)]


def test_flags_are_placed_by_the_meter_map() -> None:
    # 3/4, parallel fifths on the downbeat of bar 1 (tick 2880).
    s = [
        {"note": 67, "tick": 0, "ticks": 2880},
        {"note": 69, "tick": 2880, "ticks": 960},
    ]
    t = [
        {"note": 60, "tick": 0, "ticks": 2880},
        {"note": 62, "tick": 2880, "ticks": 960},
    ]
    flags = check_parts(
        {"soprano": s, "tenor": t},
        key=C,
        meter_map=[{"bar": 0, "meter": {"num": 3, "den": 4, "groups": []}}],
    )
    assert [(f.rule, f.bar, f.beat) for f in flags] == [("parallel_fifths", 1, 1)]


# ---------------------------------------------------------------------------
# meter
# ---------------------------------------------------------------------------


def test_seven_eight_as_two_two_three_puts_strong_beats_on_its_groups() -> None:
    meter_map = [{"bar": 0, "meter": {"num": 7, "den": 8, "groups": [2, 2, 3]}}]
    grid = MeterGrid(meter_map)
    assert grid.strong_ticks(1) == [0, 960, 1920]
    assert grid.strong_ticks(2) == [0, 960, 1920, 3360, 4320, 5280]
    ts = time_signature(sanitize_meter({"num": 7, "den": 8, "groups": [2, 2, 3]}))
    assert ts.getBeatOffsets() == [0.0, 1.0, 2.0]
    assert [ts.getAccentWeight(o) for o in (0.0, 1.0, 2.0)] == [1.0, 0.5, 0.5]
    assert grid.locate(1919) == (0, 2)
    assert grid.locate(3360) == (1, 1)


def test_other_meters_count_as_the_roll_counts_them() -> None:
    # 3+2+2 puts the long group first.
    g = MeterGrid([{"bar": 0, "meter": {"num": 7, "den": 8, "groups": [3, 2, 2]}}])
    assert g.strong_ticks(1) == [0, 1440, 2400]
    # 6/8 without groups counts in two dotted beats.
    g = MeterGrid([{"bar": 0, "meter": {"num": 6, "den": 8, "groups": []}}])
    assert [p.tick for p in g.bar(0).pulses()] == [0, 1440]
    # 4/4 keeps music21's hierarchy: beats 1 and 3 are strong.
    assert MeterGrid().strong_ticks(1) == [0, 1920]
    # Groups that do not sum to the numerator are dropped, as meterMap.ts does.
    assert sanitize_meter({"num": 7, "den": 8, "groups": [2, 2]}).groups == ()
    # A meter change at bar 2, and a pickup of one quarter (4 steps).
    g = MeterGrid(
        [
            {"bar": 0, "meter": {"num": 4, "den": 4, "groups": []}},
            {"bar": 2, "meter": {"num": 5, "den": 8, "groups": [3, 2]}},
        ],
        pickup_steps=4,
    )
    assert g.bar(-1).ticks == 960
    assert g.bar(2).tick == 960 + 2 * 3840
    assert [p.tick - g.bar(2).tick for p in g.bar(2).pulses()] == [0, 1440]
    assert g.locate(0) == (-1, 1)


def test_bar_at_a_far_tick_is_arithmetic_past_the_last_meter() -> None:
    """``bar_at`` finds the segment by bisection and counts bars in it, so a
    tick a million bars on answers at once, and every tick of the first
    segments lands in the bar a walk from the start finds."""
    import time

    meter_map = [
        {"bar": 0, "meter": {"num": 4, "den": 4, "groups": []}},
        {"bar": 2, "meter": {"num": 7, "den": 8, "groups": [2, 2, 3]}},
        {"bar": 5, "meter": {"num": 3, "den": 4, "groups": []}},
    ]
    grid = MeterGrid(meter_map, pickup_steps=4)

    walked = []
    tick = grid.pickup_ticks
    for index in range(12):
        ticks = grid.meter_at(index).bar_ticks
        walked.append((index, tick, ticks))
        tick += ticks
    for index, start, ticks in walked:
        for probe in (start, start + ticks // 2, start + ticks - 1):
            bar = grid.bar_at(probe)
            assert (bar.bar, bar.tick, bar.ticks) == (index, start, ticks)
            assert grid.bar(index).tick == start
    assert grid.bar_at(0).bar == -1, "the pickup"

    far = 10**12
    began = time.perf_counter()
    bar = grid.bar_at(far)
    elapsed = time.perf_counter() - began
    assert elapsed < prompt_seconds(0.05), f"{elapsed:.3f} s"
    last_start = walked[5][1]
    assert bar.bar == 5 + (far - last_start) // 2880
    assert bar.tick <= far < bar.tick + bar.ticks
