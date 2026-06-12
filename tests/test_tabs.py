"""Tests for the MIDI → tablature arranger.

The fingering search is the part worth verifying hard: every chosen
(string, fret) must reproduce the original pitch for the active tuning, frets
must stay within the difficulty's range, and simultaneous notes must land on
distinct strings. music21 is a core dependency, so these run for real.
"""

from __future__ import annotations

import re
from pathlib import Path

import pretty_midi  # type: ignore[import]

from backend.modules.library.db import LibraryDB
from backend.modules.notation.arrangers.guitar_tab import TUNINGS, arrange_tabs
from backend.modules.notation.engine import midi_to_tabs


def _write_sequence_midi(path: Path, pitches: list[int], step: float = 0.5) -> None:
    pm = pretty_midi.PrettyMIDI(initial_tempo=120)
    inst = pretty_midi.Instrument(program=0)
    for i, pitch in enumerate(pitches):
        start = i * step
        inst.notes.append(
            pretty_midi.Note(velocity=100, pitch=pitch, start=start, end=start + step)
        )
    pm.instruments.append(inst)
    path.parent.mkdir(parents=True, exist_ok=True)
    pm.write(str(path))


def _write_chord_midi(path: Path, pitches: list[int]) -> None:
    pm = pretty_midi.PrettyMIDI(initial_tempo=120)
    inst = pretty_midi.Instrument(program=0)
    for pitch in pitches:
        inst.notes.append(
            pretty_midi.Note(velocity=100, pitch=pitch, start=0.0, end=2.0)
        )
    pm.instruments.append(inst)
    path.parent.mkdir(parents=True, exist_ok=True)
    pm.write(str(path))


def _assert_pitches_reproduced(result: dict, tuning_name: str, capo: int = 0) -> None:
    tuning = TUNINGS[tuning_name]
    nstrings = len(tuning)
    for note in result["notes"]:
        string_index = nstrings - note["string"]
        assert 0 <= string_index < nstrings
        assert tuning[string_index] + capo + note["fret"] == note["pitch"]


C_MAJOR_SCALE = [60, 62, 64, 65, 67, 69, 71, 72]


def test_scale_medium_places_all_notes_with_correct_pitches(tmp_path: Path):
    midi = tmp_path / "scale.mid"
    _write_sequence_midi(midi, C_MAJOR_SCALE)

    result = arrange_tabs(midi, instrument="guitar", difficulty="medium")
    assert result["ok"] is True, result
    assert result["tuning_name"] == "guitar-standard"
    assert result["stats"]["note_count"] == len(C_MAJOR_SCALE)
    assert all(0 <= n["fret"] <= 12 for n in result["notes"])
    _assert_pitches_reproduced(result, "guitar-standard")


def test_easy_difficulty_caps_fret_range(tmp_path: Path):
    midi = tmp_path / "scale.mid"
    _write_sequence_midi(midi, C_MAJOR_SCALE)

    result = arrange_tabs(midi, instrument="guitar", difficulty="easy")
    assert result["ok"] is True
    # Easy caps the neck at fret 5; some high notes may be unplayable there,
    # but everything that IS placed must respect the cap.
    assert all(0 <= n["fret"] <= 5 for n in result["notes"])
    _assert_pitches_reproduced(result, "guitar-standard")


def test_chord_notes_use_distinct_strings(tmp_path: Path):
    midi = tmp_path / "triad.mid"
    _write_chord_midi(midi, [60, 64, 67])  # C major triad

    result = arrange_tabs(midi, instrument="guitar", difficulty="medium")
    assert result["ok"] is True, result
    assert result["stats"]["note_count"] == 3
    # All three notes share one onset and sit on different strings.
    offsets = {n["offset"] for n in result["notes"]}
    assert len(offsets) == 1
    strings = [n["string"] for n in result["notes"]]
    assert len(set(strings)) == 3
    _assert_pitches_reproduced(result, "guitar-standard")


def test_bass_uses_four_string_default_tuning(tmp_path: Path):
    midi = tmp_path / "bassline.mid"
    _write_sequence_midi(midi, [28, 31, 33, 35])  # E1 G1 A1 B1

    result = arrange_tabs(midi, instrument="bass", difficulty="medium")
    assert result["ok"] is True, result
    assert result["tuning_name"] == "bass-standard"
    assert len(result["tuning"]) == 4
    _assert_pitches_reproduced(result, "bass-standard")


def test_custom_tuning_is_labelled_custom(tmp_path: Path):
    midi = tmp_path / "scale.mid"
    _write_sequence_midi(midi, C_MAJOR_SCALE)

    result = arrange_tabs(midi, instrument="guitar", tuning=[40, 45, 50, 55, 59, 64])
    assert result["ok"] is True
    assert result["tuning_name"] == "custom"


def test_unplayable_pitches_are_counted_not_crashed(tmp_path: Path):
    midi = tmp_path / "mixed.mid"
    # Pitch 20 is far below the lowest guitar string and has no position.
    _write_sequence_midi(midi, [64, 20, 67])

    result = arrange_tabs(midi, instrument="guitar", difficulty="medium")
    assert result["ok"] is True, result
    assert result["stats"]["unplayable_events"] >= 1
    assert result["stats"]["note_count"] == 2


def test_alphatex_has_header_and_note_tokens(tmp_path: Path):
    midi = tmp_path / "scale.mid"
    _write_sequence_midi(midi, C_MAJOR_SCALE)

    result = arrange_tabs(midi, instrument="guitar", title="Scale Test")
    tex = result["alphatex"]
    assert '\\title "Scale Test"' in tex
    assert "\\tuning (" in tex
    assert "\n.\n" in tex  # metadata terminator line
    assert re.search(r"\d+\.\d+", tex)  # at least one fret.string token
    assert "|" in tex  # the 8-note scale spans two 4/4 bars


def test_midi_to_tabs_registers_alphatex_artifact(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track"})
    midi = tmp_path / "midi" / "scale.mid"
    _write_sequence_midi(midi, C_MAJOR_SCALE)

    output = tmp_path / "notation" / "scale__guitar.alphatex"
    result = midi_to_tabs(
        db,
        entry_id="track",
        midi_path=midi,
        output_path=output,
        instrument="guitar",
        source_ref="scale_mid",
        artifact_id="scale__guitar__alphatex",
    )

    assert result["ok"] is True, result
    assert Path(result["path"]).is_file()

    artifacts = db.list_notation_artifacts("track", kind="alphatex")
    assert len(artifacts) == 1
    assert artifacts[0]["engine"] == "fretboard-dp"

    related = db.list_relations(from_id="scale_mid")
    assert any(
        r["to_id"] == "scale__guitar__alphatex" and r["kind"] == "tabbed_as_notation"
        for r in related
    )
