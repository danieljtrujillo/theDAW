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
from backend.modules.notation import pdf_render
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
    # music21 cannot write ABC (ConverterABC is input-only), so this routes to
    # the local writer in exporters/abc_writer.py.
    assert result["engine"] == "abc-writer"
    final = Path(result["path"])
    assert final.is_file()
    text = final.read_text(encoding="utf-8", errors="ignore")
    assert text.strip()

    # Assert real ABC structure, not merely a non-empty file. The previous
    # music21 path wrote "<music21.stream.Stream 0x...>" and reported success,
    # which a non-empty check happily accepted; these lines would have caught it.
    assert text.startswith("X:"), text[:80]
    header = {line.split(":", 1)[0] for line in text.splitlines() if ":" in line[:2]}
    assert {"X", "T", "M", "L", "K"} <= header, header
    assert "music21" not in text
    # A C-major scale must engrave actual pitch tokens and a bar line.
    assert "|" in text
    assert any(letter in text for letter in ("C", "D", "E", "F", "G", "A", "B"))

    # And it must be readable back as ABC by a real parser.
    from music21 import converter as m21converter

    reparsed = m21converter.parse(str(final))
    assert len(list(reparsed.recurse().notes)) > 0

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


def test_pdf_export_no_longer_needs_musescore(tmp_path: Path):
    """PDF is engraved headlessly by the frontend's OpenSheetMusicDisplay, so it
    works with no MuseScore install. This previously asserted the opposite: the
    old music21/MuseScore path returned ok=False with an install hint whenever
    the CLI was absent, which left a machine without MuseScore unable to export
    a printable sheet at all. When the Node renderer is unavailable too (no node,
    or frontend deps not installed) the call must still degrade rather than
    raise. The test adapts to whichever environment runs it."""
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

    if pdf_render.available()["ok"]:
        assert result["ok"] is True, result
        final = Path(result["path"])
        assert final.is_file()
        # A real engraved document, not an empty or stub file.
        assert final.read_bytes()[:5] == b"%PDF-"
        assert result["engine"] == "osmd"
        # The staging MusicXML written for a MIDI source must be cleaned up, and
        # must never leave a DB row pointing at a deleted path.
        assert not list(final.parent.glob("*__osmd_src.musicxml"))
    elif musescore_binary() is None:
        assert result["ok"] is False
        assert result["engine"] == "osmd"
        assert result["error"]


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
