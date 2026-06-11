"""Unit tests for the notation module.

music21 is a declared core dependency, so unlike the heavy MIDI engines we
can assume it is importable here and exercise the real MIDI → MusicXML path
end-to-end against a synthetic MIDI file. The tests also cover the
legacy-``midis``-mirroring helper that makes existing MIDI conversions
first-class notation artifacts.
"""

from __future__ import annotations

from pathlib import Path

import pretty_midi  # type: ignore[import]

from backend.modules.library.db import LibraryDB
from backend.modules.notation.engine import (
    capabilities,
    convert_score,
    midi_to_musicxml,
    musescore_binary,
    register_existing_midis,
)


def _write_scale_midi(path: Path) -> None:
    """Write a tiny C-major scale as a Standard MIDI File."""
    pm = pretty_midi.PrettyMIDI()
    inst = pretty_midi.Instrument(program=0)
    for i, pitch in enumerate([60, 62, 64, 65, 67, 69, 71, 72]):
        start = i * 0.5
        inst.notes.append(
            pretty_midi.Note(velocity=100, pitch=pitch, start=start, end=start + 0.5)
        )
    pm.instruments.append(inst)
    path.parent.mkdir(parents=True, exist_ok=True)
    pm.write(str(path))


def test_capabilities_reports_music21_available():
    caps = capabilities()
    assert caps["ok"] is True
    # music21 is a core dependency, so the probe must see it.
    assert caps["music21"] is True
    assert "musicxml" in caps["formats"]


def test_midi_to_musicxml_end_to_end(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track"})

    midi_path = tmp_path / "midi" / "scale.mid"
    _write_scale_midi(midi_path)

    output = tmp_path / "notation" / "scale.musicxml"
    result = midi_to_musicxml(
        db,
        entry_id="track",
        midi_path=midi_path,
        output_path=output,
        source_ref="scale_mid",
        artifact_id="scale__musicxml",
    )

    assert result["ok"] is True, result
    assert result["engine"] == "music21"

    final = Path(result["path"])
    assert final.is_file()
    xml = final.read_text(encoding="utf-8", errors="ignore").lower()
    assert "score-partwise" in xml

    # The artifact is registered and discoverable.
    artifacts = db.list_notation_artifacts("track", kind="musicxml")
    assert len(artifacts) == 1
    assert artifacts[0]["id"] == "scale__musicxml"
    assert artifacts[0]["engine"] == "music21"

    # Lineage relation is recorded from the source MIDI to the score.
    related = db.list_relations(from_id="scale_mid")
    assert any(
        r["to_id"] == "scale__musicxml" and r["kind"] == "rendered_as_notation"
        for r in related
    )


def test_convert_score_to_abc_end_to_end(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track"})

    midi_path = tmp_path / "midi" / "scale.mid"
    _write_scale_midi(midi_path)

    output = tmp_path / "notation" / "scale.abc"
    result = convert_score(
        db,
        entry_id="track",
        source_path=midi_path,
        fmt="abc",
        output_path=output,
        source_ref="scale_mid",
        artifact_id="scale__abc",
    )

    assert result["ok"] is True, result
    assert result["engine"] == "music21"
    final = Path(result["path"])
    assert final.is_file()
    assert final.read_text(encoding="utf-8", errors="ignore").strip()

    artifacts = db.list_notation_artifacts("track", kind="abc")
    assert len(artifacts) == 1
    assert artifacts[0]["id"] == "scale__abc"


def test_convert_score_rejects_unsupported_format(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track"})
    midi_path = tmp_path / "midi" / "scale.mid"
    _write_scale_midi(midi_path)

    result = convert_score(
        db,
        entry_id="track",
        source_path=midi_path,
        fmt="totally-not-a-format",
        output_path=tmp_path / "out.bin",
    )
    assert result["ok"] is False
    assert "unsupported" in result["error"]


def test_pdf_export_is_gated_on_musescore(tmp_path: Path):
    """PDF export requires the MuseScore CLI. Without it the call degrades to
    ``ok=False`` with an install hint rather than raising; with it installed
    the export succeeds. The test adapts to whichever environment runs it."""
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track"})
    midi_path = tmp_path / "midi" / "scale.mid"
    _write_scale_midi(midi_path)

    result = convert_score(
        db,
        entry_id="track",
        source_path=midi_path,
        fmt="pdf",
        output_path=tmp_path / "notation" / "scale.pdf",
    )

    if musescore_binary() is None:
        assert result["ok"] is False
        assert result["engine"] == "musescore"
        assert "MuseScore" in result["error"]
    else:
        assert result["ok"] is True, result
        assert Path(result["path"]).is_file()


def test_midi_to_musicxml_missing_input_returns_error(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track"})
    result = midi_to_musicxml(
        db,
        entry_id="track",
        midi_path=tmp_path / "does_not_exist.mid",
        output_path=tmp_path / "out.musicxml",
    )
    assert result["ok"] is False
    assert "not found" in result["error"]


def test_register_existing_midis_mirrors_legacy_rows(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track"})

    midi_path = tmp_path / "midi" / "full.mid"
    _write_scale_midi(midi_path)
    db.add_midi(
        midi_id="track_full_mid",
        entry_id="track",
        source="full",
        midi_path=str(midi_path),
        source_ref="track_full_audio",
        engine="basic_pitch",
        engine_version="0.4.0",
        notes_count=8,
    )

    created = register_existing_midis(db, "track")
    assert len(created) == 1

    artifacts = db.list_notation_artifacts("track", kind="midi")
    assert len(artifacts) == 1
    artifact = artifacts[0]
    assert artifact["id"] == "track_full_mid__artifact_midi"
    assert artifact["path"] == str(midi_path)
    assert artifact["engine"] == "basic_pitch"

    # Idempotent: a second pass does not duplicate the mirrored artifact.
    register_existing_midis(db, "track")
    assert len(db.list_notation_artifacts("track", kind="midi")) == 1
