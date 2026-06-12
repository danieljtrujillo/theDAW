"""Tests for the rule-based score arrangers.

music21 is a core dependency, so these run the real arrange → MusicXML path
end-to-end against synthetic polyphonic MIDIs and assert the artifact, part
counts, and valid MusicXML output.
"""

from __future__ import annotations

from pathlib import Path

import pretty_midi  # type: ignore[import]

from backend.modules.library.db import LibraryDB
from backend.modules.notation.arrangers.score_arrange import arrange
from backend.modules.notation.engine import midi_to_arrangement


def _write_poly_midi(path: Path) -> None:
    """A four-beat phrase of low+high dyads so reductions split across staves."""
    pm = pretty_midi.PrettyMIDI(initial_tempo=120)
    inst = pretty_midi.Instrument(program=0)
    lows = [48, 50, 52, 53]
    highs = [72, 74, 76, 77]
    for i in range(4):
        start = i * 0.5
        inst.notes.append(pretty_midi.Note(100, lows[i], start, start + 0.5))
        inst.notes.append(pretty_midi.Note(100, highs[i], start, start + 0.5))
    pm.instruments.append(inst)
    path.parent.mkdir(parents=True, exist_ok=True)
    pm.write(str(path))


def _write_line_midi(path: Path, pitches: list[int]) -> None:
    pm = pretty_midi.PrettyMIDI(initial_tempo=120)
    inst = pretty_midi.Instrument(program=0)
    for i, pitch in enumerate(pitches):
        start = i * 0.5
        inst.notes.append(pretty_midi.Note(100, pitch, start, start + 0.5))
    pm.instruments.append(inst)
    path.parent.mkdir(parents=True, exist_ok=True)
    pm.write(str(path))


def _write_triad_midi(path: Path) -> None:
    """Two whole-note triads (C major then F major) for clean chord symbols."""
    pm = pretty_midi.PrettyMIDI(initial_tempo=120)
    inst = pretty_midi.Instrument(program=0)
    for beat, triad in enumerate([[60, 64, 67], [65, 69, 72]]):
        start = beat * 1.0
        for pitch in triad:
            inst.notes.append(pretty_midi.Note(100, pitch, start, start + 1.0))
    pm.instruments.append(inst)
    path.parent.mkdir(parents=True, exist_ok=True)
    pm.write(str(path))


def _read_musicxml(path: Path) -> str:
    return Path(path).read_text(encoding="utf-8", errors="ignore").lower()


def test_piano_reduction_splits_into_two_staves(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track"})
    midi = tmp_path / "midi" / "poly.mid"
    _write_poly_midi(midi)

    result = midi_to_arrangement(
        db,
        entry_id="track",
        sources=[midi],
        style="piano-reduction",
        output_path=tmp_path / "notation" / "poly__piano.musicxml",
        source_ref="poly_mid",
        artifact_id="poly__piano__musicxml",
    )

    assert result["ok"] is True, result
    assert result["stats"]["parts"] == 2
    assert "score-partwise" in _read_musicxml(Path(result["path"]))

    artifacts = db.list_notation_artifacts("track", kind="musicxml")
    assert len(artifacts) == 1
    assert artifacts[0]["engine"] == "music21-arrange"

    related = db.list_relations(from_id="poly_mid")
    assert any(r["kind"] == "arranged_as_notation" for r in related)


def test_lead_sheet_produces_single_part(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track"})
    midi = tmp_path / "poly.mid"
    _write_poly_midi(midi)

    result = midi_to_arrangement(
        db,
        entry_id="track",
        sources=[midi],
        style="lead-sheet",
        output_path=tmp_path / "notation" / "poly__lead.musicxml",
        source_ref="poly_mid",
    )
    assert result["ok"] is True, result
    assert result["stats"]["parts"] == 1
    assert "score-partwise" in _read_musicxml(Path(result["path"]))


def test_lead_sheet_emits_chord_symbols_for_triads(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track"})
    midi = tmp_path / "triads.mid"
    _write_triad_midi(midi)

    result = midi_to_arrangement(
        db,
        entry_id="track",
        sources=[midi],
        style="lead-sheet",
        output_path=tmp_path / "notation" / "triads__lead.musicxml",
        source_ref="triads_mid",
    )
    assert result["ok"] is True, result
    xml = _read_musicxml(Path(result["path"]))
    assert "score-partwise" in xml
    # At least one identifiable chord symbol (<harmony>) was written.
    assert "<harmony" in xml


def test_simplified_keeps_top_line(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track"})
    midi = tmp_path / "poly.mid"
    _write_poly_midi(midi)

    result = midi_to_arrangement(
        db,
        entry_id="track",
        sources=[midi],
        style="simplified",
        output_path=tmp_path / "notation" / "poly__simple.musicxml",
        source_ref="poly_mid",
    )
    assert result["ok"] is True, result
    assert result["stats"]["parts"] == 1
    # Skyline keeps the four high notes, one per beat.
    assert result["stats"]["notes"] == 4


def test_band_score_one_part_per_stem(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track"})
    midi_a = tmp_path / "midi" / "stem_a.mid"
    midi_b = tmp_path / "midi" / "stem_b.mid"
    _write_line_midi(midi_a, [60, 62, 64, 65])
    _write_line_midi(midi_b, [36, 38, 40, 41])

    result = midi_to_arrangement(
        db,
        entry_id="track",
        sources=[midi_a, midi_b],
        style="band-score",
        output_path=tmp_path / "notation" / "band.musicxml",
        source_ref="stem_a_mid",
    )
    assert result["ok"] is True, result
    assert result["stats"]["parts"] == 2
    xml = _read_musicxml(Path(result["path"]))
    assert "score-partwise" in xml
    # A complete time signature must be present, or OSMD fails to render with
    # "Cannot read properties of undefined (reading 'denominator')".
    assert "<beat-type>" in xml


def test_arrange_rejects_unknown_style(tmp_path: Path):
    midi = tmp_path / "poly.mid"
    _write_poly_midi(midi)
    result = arrange([midi], "orchestral-mega-suite")
    assert result["ok"] is False
    assert "unknown arrangement style" in result["error"]


def test_arrange_missing_source(tmp_path: Path):
    result = arrange([tmp_path / "nope.mid"], "simplified")
    assert result["ok"] is False
    assert "not found" in result["error"]
