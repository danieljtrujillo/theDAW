"""The rhythm engine on music with a known, changing meter.

Every signal comes from tests/rhythm_synth.py (deterministic, CPU-only,
rendered straight at the 22.05 kHz the engine works on). The assertions are
about what the user asked for: metamorphic time signatures come back as a
meter map with the right bar lengths in the right order and the changes
placed within a bar; odd meters come back with their grouping; tempo changes
are followed, not averaged; compound is told from simple; syncopation orders
patterns the way a drummer would; a layer keeping its own cycle is reported as
polymeter.
"""

from __future__ import annotations

from functools import lru_cache

import numpy as np
import pytest

from backend.modules.rhythm import engine
from backend.modules.rhythm.engine import (
    analyze_rhythm,
    fit_meter,
    groupings,
    pick_meter,
)
from tests.rhythm_synth import MeterSegment, meter_track

SR = 22050


def _matched(truth: list[float], found: list[float], tol: float) -> float:
    """Fraction of ``truth`` times with a ``found`` time within ``tol``."""
    if not truth:
        return 1.0
    f = np.asarray(found, dtype=np.float64)
    if f.size == 0:
        return 0.0
    return float(np.mean([np.min(np.abs(f - t)) <= tol for t in truth]))


@lru_cache(maxsize=None)
def _analyze(*segs: MeterSegment) -> tuple[dict, dict]:
    y, truth = meter_track(list(segs), sr=SR)
    return analyze_rhythm(y, SR), truth


# --------------------------------------------------------------------------
# the scorer, on numbers
# --------------------------------------------------------------------------


def _accent_pattern(template: list[float], bars: int, noise: float, seed: int = 0):
    rng = np.random.default_rng(seed)
    s = np.tile(np.asarray(template, dtype=np.float64), bars)
    return s + rng.normal(0.0, noise, size=s.size)


def test_groupings_are_every_composition_into_2s_and_3s():
    assert groupings(4) == ((2, 2),)
    assert set(groupings(7)) == {(2, 2, 3), (2, 3, 2), (3, 2, 2)}
    assert set(groupings(5)) == {(2, 3), (3, 2)}
    assert (3, 3) in groupings(6) and (2, 2, 2) in groupings(6)


def test_a_seven_beat_accent_cycle_is_read_as_seven_with_its_grouping():
    fit, conf = pick_meter(fit_meter(_accent_pattern([3, 0, 1, 0, 1, 0, 0], 10, 0.2)))
    assert fit is not None
    assert fit.beats_per_bar == 7
    assert fit.grouping == (2, 2, 3)
    assert fit.phase == 0
    assert conf > 0.5


def test_a_four_beat_cycle_is_four_not_eight_and_not_two():
    fit, conf = pick_meter(fit_meter(_accent_pattern([3, 0, 1.5, 0], 12, 0.2)))
    assert fit is not None
    assert fit.beats_per_bar == 4
    assert conf > 0.4


def test_noise_reads_as_low_confidence():
    _, conf = pick_meter(fit_meter(np.random.default_rng(1).normal(size=64)))
    assert conf < 0.25


# --------------------------------------------------------------------------
# constant meters
# --------------------------------------------------------------------------


@pytest.mark.parametrize("length,bpm", [(4, 120.0), (3, 132.0), (5, 120.0), (7, 128.0)])
def test_a_constant_meter_comes_back_as_one_segment(length: int, bpm: float):
    res, truth = _analyze(MeterSegment(bpm=bpm, beats_per_bar=length, bars=24))
    mm = res["meter_map"]
    assert [m["beats_per_bar"] for m in mm] == [length], res["summary"]
    assert abs(res["tempo"]["bpm"] - bpm) / bpm < 0.03
    assert _matched(truth["downbeats"], res["downbeats"], tol=0.07) >= 0.85, res[
        "summary"
    ]
    assert mm[0]["confidence"] > 0.3


def test_seven_eight_comes_back_with_its_grouping():
    res, _ = _analyze(MeterSegment(bpm=128.0, beats_per_bar=7, bars=24))
    seg = res["meter_map"][0]
    assert seg["grouping"] == [2, 2, 3]
    assert seg["time_signature"].startswith("7/")
    assert "2+2+3" in seg["time_signature"]


# --------------------------------------------------------------------------
# metamorphic
# --------------------------------------------------------------------------


def test_a_metamorphic_piece_maps_every_meter_in_order_within_a_bar():
    res, truth = _analyze(
        MeterSegment(bpm=120.0, beats_per_bar=4, bars=16),
        MeterSegment(bpm=120.0, beats_per_bar=7, bars=12),
        MeterSegment(bpm=120.0, beats_per_bar=5, bars=12),
        MeterSegment(bpm=120.0, beats_per_bar=4, bars=16),
    )
    mm = res["meter_map"]
    assert [m["beats_per_bar"] for m in mm] == [4, 7, 5, 4], res["summary"]
    beat = 60.0 / 120.0
    for found, want in zip(mm[1:], truth["segments"][1:]):
        bar = want["beats_per_bar"] * beat
        assert abs(found["start_sec"] - want["start_sec"]) <= bar + 0.05, (
            f"{want['beats_per_bar']} starts at {found['start_sec']:.2f}, truth {want['start_sec']:.2f}"
        )
    assert _matched(truth["downbeats"], res["downbeats"], tol=0.07) >= 0.8


def test_a_tempo_change_is_followed_not_averaged():
    res, truth = _analyze(
        MeterSegment(bpm=110.0, beats_per_bar=4, bars=16),
        MeterSegment(bpm=140.0, beats_per_bar=4, bars=16),
    )
    segs = res["tempo"]["segments"]
    assert len(segs) == 2, res["tempo"]
    assert abs(segs[0]["bpm"] - 110.0) / 110.0 < 0.04
    assert abs(segs[1]["bpm"] - 140.0) / 140.0 < 0.04
    assert res["tempo"]["stable"] is False
    assert _matched(truth["beats"], res["beats"], tol=0.07) >= 0.9
    assert [m["beats_per_bar"] for m in res["meter_map"]] == [4]


# --------------------------------------------------------------------------
# subdivision, signature
# --------------------------------------------------------------------------


def test_compound_subdivision_is_told_from_simple():
    six_eight, _ = _analyze(
        MeterSegment(bpm=100.0, beats_per_bar=2, bars=24, compound=True)
    )
    four_four, _ = _analyze(MeterSegment(bpm=100.0, beats_per_bar=4, bars=24))
    assert six_eight["meter_map"][0]["subdivision"] == "compound"
    assert six_eight["meter_map"][0]["time_signature"] == "6/8"
    assert four_four["meter_map"][0]["subdivision"] == "simple"
    assert four_four["meter_map"][0]["time_signature"] == "4/4"


# --------------------------------------------------------------------------
# syncopation, swing
# --------------------------------------------------------------------------


def test_syncopation_orders_a_pushed_pattern_above_four_on_the_floor():
    # Hats ON the beats: the pulse reference lives in the high band, and LHL is
    # read on the low band pushing against it — a note on a weak position
    # followed by a REST on a stronger one. (Off-beat hats would fill every
    # rest; no hats at all leaves no pulse for the pushed pattern to push
    # against, and a tracker cannot know which grid the author meant.)
    straight, _ = _analyze(
        MeterSegment(bpm=120.0, beats_per_bar=4, bars=16, hat_on_beat=True)
    )
    pushed, _ = _analyze(
        MeterSegment(
            bpm=120.0,
            beats_per_bar=4,
            bars=16,
            beat_hits=(0,),
            offbeat_hits=(3, 5),
            hat_on_beat=True,
        )
    )
    assert (
        pushed["syncopation"]["mean_lhl"] > straight["syncopation"]["mean_lhl"] + 0.05
    )
    assert (
        pushed["syncopation"]["mean_offbeat_ratio"]
        > straight["syncopation"]["mean_offbeat_ratio"]
    )
    assert len(pushed["syncopation"]["curve"]) == len(pushed["bars"])


def test_swing_ratio_reads_triplet_swing_and_straight_eighths():
    swung, _ = _analyze(MeterSegment(bpm=120.0, beats_per_bar=4, bars=16, swing=1.0))
    straight, _ = _analyze(MeterSegment(bpm=120.0, beats_per_bar=4, bars=16))
    assert swung["syncopation"]["swing_ratio"] is not None
    assert abs(swung["syncopation"]["swing_ratio"] - 2.0) < 0.35
    assert straight["syncopation"]["swing_ratio"] is not None
    assert abs(straight["syncopation"]["swing_ratio"] - 1.0) < 0.2


# --------------------------------------------------------------------------
# polymeter, cross-rhythm
# --------------------------------------------------------------------------


def test_a_layer_keeping_three_over_a_four_is_reported_as_polymeter():
    res, _ = _analyze(MeterSegment(bpm=120.0, beats_per_bar=4, bars=24, poly_cycle=3))
    assert [m["beats_per_bar"] for m in res["meter_map"]] == [4], res["summary"]
    three = [p for p in res["polymeter"] if p["beats_per_bar"] == 3]
    assert three, res["polymeter"]
    assert three[0]["relation"] == "3:4"


def test_a_dotted_quarter_pulse_shows_as_a_three_two_cross_rhythm():
    res, _ = _analyze(
        MeterSegment(bpm=120.0, beats_per_bar=4, bars=24, cross_pulse=1.5)
    )
    ratios = {c["ratio"] for c in res["cross_rhythms"]}
    assert "2:3" in ratios or "3:2" in ratios, res["cross_rhythms"]


# --------------------------------------------------------------------------
# wide and additive meters — read at the tatum
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "length,grouping,tatum_bpm,den",
    [
        (11, (3, 3, 3, 2), 240.0, 8),
        (13, (3, 3, 3, 2, 2), 240.0, 8),
        (19, (3, 3, 3, 3, 3, 2, 2), 480.0, 16),
        (23, (3, 3, 3, 3, 3, 2, 2, 2, 2), 480.0, 16),
    ],
)
def test_wide_additive_meters_are_read_at_the_tatum(
    length: int, grouping: tuple[int, ...], tatum_bpm: float, den: int
):
    # Kicks on the group starts only, hats on every eighth or sixteenth: the
    # felt beats are uneven, the tatum is the only regular pulse, and the bar
    # is a whole number of tatums only — 19/16 is 4.75 quarters.
    res, truth = _analyze(
        MeterSegment(
            bpm=tatum_bpm,
            beats_per_bar=length,
            bars=16,
            grouping=grouping,
            pulse="groups",
        )
    )
    mm = res["meter_map"]
    assert [m["beats_per_bar"] for m in mm] == [length], res["summary"]
    assert mm[0]["grouping"] == list(grouping), res["summary"]
    assert mm[0]["denominator"] == den, res["summary"]
    assert _matched(truth["downbeats"], res["downbeats"], tol=0.07) >= 0.8, res[
        "summary"
    ]


def test_seven_eight_against_five_four_is_a_polymeter():
    # Drums in 5/4 (kicks on the quarters, hats on the eighths); a melody
    # cycling every seven eighths. 3.5 quarters is no bar length at the
    # quarter, so the layer is read on the eighth grid: 7 against 10.
    res, _ = _analyze(
        MeterSegment(
            bpm=240.0,
            beats_per_bar=10,
            bars=24,
            grouping=(2, 2, 2, 2, 2),
            pulse="groups",
            poly_cycle=7,
        )
    )
    mm = res["meter_map"]
    assert len(mm) == 1 and mm[0]["numerator"] / mm[0]["denominator"] == 1.25, res[
        "summary"
    ]
    seven = [p for p in res["polymeter"] if p["beats_per_bar"] == 7]
    assert seven, res["polymeter"]
    assert "7/8" in seven[0]["label"], seven[0]


# --------------------------------------------------------------------------
# the report
# --------------------------------------------------------------------------


def test_the_summary_reads_the_map_back():
    res, _ = _analyze(
        MeterSegment(bpm=120.0, beats_per_bar=4, bars=16),
        MeterSegment(bpm=120.0, beats_per_bar=7, bars=12),
    )
    assert "4/4" in res["summary"] and "7/" in res["summary"]
    assert res["version"] == engine.RHYTHM_VERSION
    assert res["bars"] and res["bars"][0]["start_sec"] < res["bars"][-1]["start_sec"]


def test_silence_and_shorts_do_not_crash():
    assert analyze_rhythm(np.zeros(SR * 2, dtype=np.float32), SR)["meter_map"] == []
    quiet = analyze_rhythm(np.zeros(SR * 10, dtype=np.float32), SR)
    assert quiet["beats"] == [] or quiet["meter_map"] == [] or quiet["summary"]
