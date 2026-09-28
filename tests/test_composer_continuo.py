"""The composer's figured-bass realizer: music21's FiguredBassLine segments,
searched for the smoothest path, then run through the voice-leading checker.

Pure music21 + numpy; no model, no GPU.
"""

from __future__ import annotations

import pytest

from backend.modules.composer.continuo import normalize_figure, realize_continuo
from backend.modules.composer.harmony import PlanError
from backend.modules.composer.voiceleading import SATB, check_parts, parse_key

Q = 960


def test_figures_are_read_the_ways_people_write_them() -> None:
    assert normalize_figure("") == ""
    assert normalize_figure("5") == ""
    assert normalize_figure("5/3") == ""
    assert normalize_figure("6") == "6"
    for spelling in ("6/4", "64", "6 4", "6,4"):
        assert normalize_figure(spelling) == "6,4"
    assert normalize_figure("4/3") == "4,3"
    assert normalize_figure("#6") == "#6"
    assert normalize_figure("b7") == "-7"
    assert normalize_figure("♭") == "-"


def test_a_short_figured_bass_realizes_without_parallels() -> None:
    # C: I - ii6 - I6/4 - V7 - I, figured 5, 6, 6/4, 7, (5).
    bass = [
        {"note": 48, "tick": 0, "ticks": Q, "figure": "5"},
        {"note": 53, "tick": Q, "ticks": Q, "figure": "6"},
        {"note": 55, "tick": 2 * Q, "ticks": Q, "figure": "6/4"},
        {"note": 55, "tick": 3 * Q, "ticks": Q, "figure": "7"},
        {"note": 48, "tick": 4 * Q, "ticks": 4 * Q, "figure": ""},
    ]
    out = realize_continuo(bass, "C", "major")
    assert out["flags"] == []
    assert [c["roman"] for c in out["chords"]] == ["I", "ii6", "I64", "V7", "I"]
    # The bass is the line as written, the upper parts sound with it.
    assert [n["note"] for n in out["parts"]["bass"]] == [48, 53, 55, 55, 48]
    for p in SATB:
        assert [(n["tick"], n["ticks"]) for n in out["parts"][p]] == [
            (0, Q),
            (Q, Q),
            (2 * Q, Q),
            (3 * Q, Q),
            (4 * Q, 4 * Q),
        ]
    # Every chord holds the pitches its figure asks for.
    wanted = [{0, 4, 7}, {5, 9, 2}, {7, 0, 4}, {7, 11, 2, 5}, {0, 4, 7}]
    for c, pcs in zip(out["chords"], wanted):
        got = {m % 12 for m in c["pitches"].values()}
        assert got <= pcs and (pcs - got) <= {7, 2}, (c, pcs)
    # The checker, run again from the outside, finds no parallels, nor anything else.
    assert check_parts(out["parts"], key=parse_key("C")) == []


def test_a_minor_bass_with_a_raised_third() -> None:
    # a: i - V6 (#6 over G#) - i - iv6 - V (#)
    bass = [
        {"note": 45, "tick": 0, "ticks": Q, "figure": ""},
        {"note": 44, "tick": Q, "ticks": Q, "figure": "6"},
        {"note": 45, "tick": 2 * Q, "ticks": Q, "figure": ""},
        {"note": 53, "tick": 3 * Q, "ticks": Q, "figure": "6"},
        {"note": 52, "tick": 4 * Q, "ticks": 2 * Q, "figure": "#"},
    ]
    out = realize_continuo(bass, "A", "minor")
    assert out["flags"] == []
    # The final V carries G#.
    assert 8 in {m % 12 for m in out["chords"][-1]["pitches"].values()}


def test_overlapping_bass_notes_are_refused() -> None:
    bass = [
        {"note": 48, "tick": 0, "ticks": 2 * Q, "figure": ""},
        {"note": 50, "tick": Q, "ticks": Q, "figure": "6"},
    ]
    with pytest.raises(PlanError):
        realize_continuo(bass, "C")
