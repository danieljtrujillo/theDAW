"""Unit tests for the notation module.

music21 is a declared core dependency, so unlike the heavy MIDI engines we
can assume it is importable here and exercise the real MIDI → MusicXML path
end-to-end against a synthetic MIDI file. The tests also cover the
legacy-``midis``-mirroring helper that makes existing MIDI conversions
first-class notation artifacts.
"""

from __future__ import annotations

import io
import json
import re
import zipfile
from pathlib import Path
from typing import Any

import pretty_midi  # type: ignore[import]
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.modules.library.db import LibraryDB
from backend.modules.notation import pdf_render
from backend.modules.notation.engine import (
    capabilities,
    convert_score,
    is_drum_source,
    lyrics_artifact_id,
    midi_to_musicxml,
    musescore_binary,
    musescore_command,
    raw_midi_for,
    register_existing_midis,
    register_on_disk_artifacts,
    stage_parts,
)
from backend.modules.notation.exporters import beatsaber


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


def _write_drum_midi(path: Path, *, is_drum: bool = True) -> None:
    """A one-bar General-MIDI drum kit at 120 BPM: kick on every beat, closed
    hat on every eighth, snare on 2 and 4 (kit pitches 36/42/38)."""
    pm = pretty_midi.PrettyMIDI(initial_tempo=120)
    inst = pretty_midi.Instrument(program=0, is_drum=is_drum, name="Drums")
    for beat in range(4):
        t = beat * 0.5
        hits = [(t, 36), (t, 42), (t + 0.25, 42)]
        if beat in (1, 3):
            hits.append((t, 38))
        for start, pitch in hits:
            inst.notes.append(pretty_midi.Note(100, pitch, start, start + 0.1))
    pm.instruments.append(inst)
    path.parent.mkdir(parents=True, exist_ok=True)
    pm.write(str(path))


def _percussion_markers(xml: str) -> dict[str, Any]:
    low = xml.lower()
    return {
        "percussion_clef": "<sign>percussion</sign>" in low,
        "unpitched": "<unpitched>" in low,
        # music21 9.x writes <notehead parentheses="no">x</notehead>.
        "x_head": re.search(r"<notehead[^>]*>x</notehead>", low) is not None,
        "treble_clef": "<sign>g</sign>" in low,
    }


def test_capabilities_reports_music21_available():
    caps = capabilities()
    assert caps["ok"] is True
    # music21 is a core dependency, so the probe must see it.
    assert caps["music21"] is True
    assert "musicxml" in caps["formats"]
    # Play-along / Beat Saber targets are unconditional (pure-Python writers).
    assert "beatsaber" in caps["formats"]
    assert "chordtrack" in caps["formats"]
    assert caps["engines"]["score_to_beatsaber"] == "beatsaber"
    assert caps["engines"]["chords"] == "chordtrack"
    # song.ogg encoding depends on ffmpeg; the UI reads a plain bool.
    assert isinstance(caps["ffmpeg"], bool)
    # Tunings ship with their MIDI pitches (low string first) so the frontend
    # chord-diagram generator needs no table of its own.
    pitches = caps["tab_tuning_pitches"]
    assert pitches["guitar-standard"] == [40, 45, 50, 55, 59, 64]
    assert "ukulele-standard" in pitches
    assert len(pitches["ukulele-standard"]) == 4
    assert set(pitches) == set(caps["tab_tunings"])
    assert all(isinstance(p, int) for values in pitches.values() for p in values), (
        pitches
    )


def test_register_on_disk_recovers_new_kinds(tmp_path: Path):
    """Files written by the chord/Beat Saber/notechart exporters are recovered
    with their real kinds, and the entry-root ``lyrics.json`` becomes ONE
    ``lyrics`` artifact under a fixed id (the lyrics workflow relies on it)."""
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track"})
    entry_dir = tmp_path / "track"
    notation = entry_dir / "notation"
    notation.mkdir(parents=True)
    (notation / "a__x.chordtrack.json").write_text("{}", encoding="utf-8")
    (notation / "b.beatsaber.zip").write_bytes(b"PK\x05\x06" + b"\x00" * 18)
    (notation / "c.notechart.json").write_text("{}", encoding="utf-8")
    # The Beat Saber route writes one directory deeper; the unzipped level
    # folder beside the zip is a directory and must be skipped.
    nested = notation / "beatsaber"
    nested.mkdir()
    (nested / "song__scale.beatsaber.zip").write_bytes(b"PK\x05\x06" + b"\x00" * 18)
    (nested / "song__scale").mkdir()
    (nested / "song__scale" / "Info.dat").write_text("{}", encoding="utf-8")
    # Plain .json stays unmapped: not every JSON in an entry is notation.
    (notation / "random.json").write_text("{}", encoding="utf-8")
    (entry_dir / "metadata.json").write_text("{}", encoding="utf-8")
    (entry_dir / "lyrics.json").write_text('{"lines": []}', encoding="utf-8")

    recovered = register_on_disk_artifacts(db, entry_dir, "track")
    by_kind: dict[str, list[dict[str, Any]]] = {}
    for row in recovered:
        by_kind.setdefault(row["kind"], []).append(row)

    assert [r["path"] for r in by_kind["chordtrack"]] == [
        str(notation / "a__x.chordtrack.json")
    ]
    assert by_kind["chordtrack"][0]["id"] == "track__a__x__chordtrack"
    assert sorted(Path(r["path"]).name for r in by_kind["beatsaber"]) == [
        "b.beatsaber.zip",
        "song__scale.beatsaber.zip",
    ]
    assert [Path(r["path"]).name for r in by_kind["notechart"]] == ["c.notechart.json"]
    assert len(by_kind["lyrics"]) == 1
    lyrics = by_kind["lyrics"][0]
    assert lyrics["id"] == lyrics_artifact_id("track") == "track__lyrics__lyrics"
    assert lyrics["path"] == str(entry_dir / "lyrics.json")
    assert lyrics["engine"] == "recovered-from-disk"
    assert "json" not in by_kind
    assert {r["engine"] for r in recovered} == {"recovered-from-disk"}
    assert not any(
        Path(r["path"]).name in ("random.json", "metadata.json", "Info.dat")
        for r in recovered
    )

    # Idempotent.
    assert register_on_disk_artifacts(db, entry_dir, "track") == []
    assert len(db.list_notation_artifacts("track", kind="lyrics")) == 1


def test_register_on_disk_recovers_nothing_without_lyrics(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track"})
    entry_dir = tmp_path / "track"
    entry_dir.mkdir()
    (entry_dir / "metadata.json").write_text("{}", encoding="utf-8")
    assert register_on_disk_artifacts(db, entry_dir, "track") == []


def test_drum_midi_to_musicxml_yields_percussion_clef(tmp_path: Path):
    """A drum-kit MIDI (``is_drum`` instrument) is engraved as an unpitched
    percussion staff, not a treble staff of pitched garbage."""
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track"})
    midi_path = tmp_path / "midi" / "kit.mid"
    _write_drum_midi(midi_path)
    assert is_drum_source(db, midi_path, None) is True

    result = midi_to_musicxml(
        db,
        entry_id="track",
        midi_path=midi_path,
        output_path=tmp_path / "notation" / "kit.musicxml",
        source_ref="kit_mid",
        artifact_id="kit__musicxml",
        title="Kit Song.wav",
    )
    assert result["ok"] is True, result
    assert result["engine"] == "music21"
    xml = Path(result["path"]).read_text(encoding="utf-8", errors="ignore")
    markers = _percussion_markers(xml)
    assert markers["percussion_clef"], markers
    assert markers["unpitched"], markers
    assert markers["x_head"], markers  # hi-hat (42) prints with an x head
    assert not markers["treble_clef"], markers
    # Title stamping still applies to the percussion score.
    assert "Kit Song" in xml
    assert ".wav" not in xml
    artifact = db.get_notation_artifact("kit__musicxml")
    assert json.loads(artifact["metadata_json"])["percussion"] is True


def test_drum_onsets_midi_row_routes_to_percussion_even_without_is_drum(
    tmp_path: Path,
):
    """The ``drum-onsets`` transcriber's row is trusted even when the file is
    not flagged ``is_drum`` (and its name says nothing about drums)."""
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track"})
    midi_path = tmp_path / "midi" / "stem_03.mid"
    _write_drum_midi(midi_path, is_drum=False)
    assert is_drum_source(db, midi_path, None) is False
    db.add_midi(
        midi_id="track_stem_03",
        entry_id="track",
        source="stem",
        midi_path=str(midi_path),
        source_ref="stem_03",
        engine="drum-onsets",
        engine_version="1",
        notes_count=14,
    )
    assert is_drum_source(db, midi_path, "track_stem_03") is True

    result = midi_to_musicxml(
        db,
        entry_id="track",
        midi_path=midi_path,
        output_path=tmp_path / "notation" / "stem_03.musicxml",
        source_ref="track_stem_03",
    )
    assert result["ok"] is True, result
    xml = Path(result["path"]).read_text(encoding="utf-8", errors="ignore")
    assert _percussion_markers(xml)["percussion_clef"]

    # A pitched MIDI with a plain row keeps its treble staff.
    scale = tmp_path / "midi" / "scale.mid"
    _write_scale_midi(scale)
    db.add_midi(
        midi_id="track_scale",
        entry_id="track",
        source="full",
        midi_path=str(scale),
        source_ref="full",
        engine="basic_pitch",
        engine_version="0.4.0",
        notes_count=8,
    )
    assert is_drum_source(db, scale, "track_scale") is False
    result = midi_to_musicxml(
        db,
        entry_id="track",
        midi_path=scale,
        output_path=tmp_path / "notation" / "scale.musicxml",
        source_ref="track_scale",
    )
    markers = _percussion_markers(
        Path(result["path"]).read_text(encoding="utf-8", errors="ignore")
    )
    assert markers["treble_clef"] and not markers["percussion_clef"], markers


def test_raw_midi_for_walks_the_musicxml_lineage(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track"})
    midi_path = tmp_path / "midi" / "scale.mid"
    _write_scale_midi(midi_path)
    db.add_notation_artifact(
        artifact_id="scale_mid", entry_id="track", kind="midi", path=str(midi_path)
    )
    result = midi_to_musicxml(
        db,
        entry_id="track",
        midi_path=midi_path,
        output_path=tmp_path / "notation" / "scale.musicxml",
        source_ref="scale_mid",
        artifact_id="scale_mid__musicxml",
    )
    assert result["ok"] is True, result

    assert raw_midi_for(db, "scale_mid") == (midi_path, "scale_mid")
    assert raw_midi_for(db, "scale_mid__musicxml") == (midi_path, "scale_mid")
    assert raw_midi_for(db, None) == (None, "")
    assert raw_midi_for(db, "nope") == (None, "")
    # A MIDI artifact whose file is gone is not a raw source.
    db.add_notation_artifact(
        artifact_id="ghost", entry_id="track", kind="midi", path=str(tmp_path / "x.mid")
    )
    assert raw_midi_for(db, "ghost") == (None, "")


@pytest.mark.parametrize("bpm_source", ["analysis", "chart"])
def test_convert_score_beatsaber_registers_level_metadata(
    tmp_path: Path, monkeypatch, bpm_source: str
):
    monkeypatch.setattr(beatsaber, "find_ffmpeg", lambda: None)
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track"})
    midi_path = tmp_path / "midi" / "scale.mid"
    _write_scale_midi(midi_path)
    db.add_notation_artifact(
        artifact_id="scale_mid", entry_id="track", kind="midi", path=str(midi_path)
    )
    output = tmp_path / "notation" / "beatsaber" / "song__scale.beatsaber.zip"
    result = convert_score(
        db,
        entry_id="track",
        source_path=midi_path,
        fmt="beatsaber",
        output_path=output,
        source_ref="scale_mid",
        artifact_id="scale_mid__beatsaber",
        title="Song.wav",
        options={
            "difficulties": ["Easy", "expert+"],
            "version": 3,
            "bpm_source": bpm_source,
        },
        audio_path=None,
        audio_duration_sec=4.0,
        analysis_bpm=97.5,
    )
    assert result["ok"] is True, result
    assert result["engine"] == "beatsaber"
    assert Path(result["path"]) == output and output.is_file()
    with zipfile.ZipFile(output) as zf:
        names = zf.namelist()
    assert any(n.endswith("/Info.dat") for n in names)
    assert any(n.endswith("/Easy.dat") for n in names)
    assert any(n.endswith("/ExpertPlus.dat") for n in names)
    assert any(n.endswith("/README.txt") for n in names)  # no ffmpeg -> no song.ogg

    artifact = result["artifact"]
    assert artifact["kind"] == "beatsaber"
    meta = json.loads(artifact["metadata_json"])
    assert meta["format"] == "beatsaber"
    assert meta["difficulties"] == ["Easy", "ExpertPlus"]
    assert set(meta["note_counts"]) == {"Easy", "ExpertPlus"}
    assert meta["version"] == 3
    assert meta["song_ogg"] is False
    assert meta["warning"]
    if bpm_source == "analysis":
        assert meta["bpm_source"] == "analysis" and meta["bpm"] == 97.5
    else:
        assert (
            meta["bpm_source"] == "chart" and meta["bpm"] == meta["chart_bpm"] == 120.0
        )
    # Lineage: the MIDI is the source of the level.
    related = db.list_relations(from_id="scale_mid")
    assert any(r["to_id"] == "scale_mid__beatsaber" for r in related)


def test_convert_score_beatsaber_falls_back_to_chart_bpm_without_analysis(
    tmp_path: Path, monkeypatch
):
    monkeypatch.setattr(beatsaber, "find_ffmpeg", lambda: None)
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track"})
    midi_path = tmp_path / "midi" / "scale.mid"
    _write_scale_midi(midi_path)
    result = convert_score(
        db,
        entry_id="track",
        source_path=midi_path,
        fmt="beatsaber",
        output_path=tmp_path / "notation" / "beatsaber" / "scale.beatsaber.zip",
    )
    assert result["ok"] is True, result
    assert result["bpm_source"] == "chart"
    assert result["bpm"] == 120.0
    assert result["difficulties"] == ["Normal", "Hard"]


# --------------------------------------------------------------------------
# routes (library + notation routers on a tmp library root)
# --------------------------------------------------------------------------


@pytest.fixture
def notation_client(tmp_path: Path, monkeypatch) -> TestClient:
    from backend.modules.library import router as library_router_module
    from backend.modules.notation import router as notation_router_module

    monkeypatch.setattr(library_router_module, "_store", None)
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(tmp_path))
    app = FastAPI()
    app.include_router(library_router_module.router, prefix="/api/library")
    app.include_router(notation_router_module.router, prefix="/api/notation")
    return TestClient(app)


def test_chords_route_builds_from_lead_sheet_and_serves_json(
    notation_client: TestClient, tmp_path: Path
):
    from backend.modules.library import router as library_router_module
    from tests.test_chordtrack import _write_lead_sheet
    from tests.test_library_store import _seed_generate_entry

    _seed_generate_entry(tmp_path, "job_ch", 0)
    entry_id = "job_ch_00"
    store = library_router_module.get_store()
    assert store.get_entry(entry_id) is not None
    entry_dir = tmp_path / "job_ch" / "00"
    sheet = _write_lead_sheet(
        entry_dir / "notation" / "lead.musicxml",
        [(0.0, "C"), (4.0, "G7"), (8.0, "A-"), (12.0, "F")],
        bpm=120.0,
    )
    store.db.add_notation_artifact(
        artifact_id="lead_sheet",
        entry_id=entry_id,
        kind="musicxml",
        path=str(sheet),
        engine="music21-arrange",
        metadata={"style": "lead-sheet"},
    )

    # 'harmony' finds the lead sheet by its arrangement style (no id given).
    r = notation_client.post(
        f"/api/notation/{entry_id}/chords", json={"source": "harmony"}
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["method"] == "harmony"
    assert body["stats"]["chordCount"] == 4
    artifact = body["artifact"]
    assert artifact["kind"] == "chordtrack"
    assert artifact["id"] == f"{entry_id}__chords__chordtrack"
    assert artifact["path"].endswith("__chords.chordtrack.json")
    assert artifact["source_ref"] == "lead_sheet"
    meta = json.loads(artifact["metadata_json"])
    assert meta["method"] == "harmony" and meta["source"] == "harmony"
    doc = json.loads(Path(artifact["path"]).read_text(encoding="utf-8"))
    assert doc["schema"] == "gantasmo.chordtrack"
    assert [c["symbol"] for c in doc["chords"]] == ["C", "G7", "Ab", "F"]
    related = store.db.list_relations(from_id="lead_sheet")
    assert any(r_["kind"] == "charted_as_chords" for r_ in related)

    # Explicit source id + bar resolution re-registers under the same id.
    r = notation_client.post(
        f"/api/notation/{entry_id}/chords",
        json={
            "source": "auto",
            "source_artifact_id": "lead_sheet",
            "resolution": "bar",
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["artifact"]["id"] == artifact["id"]
    assert len(store.db.list_notation_artifacts(entry_id, kind="chordtrack")) == 1

    # The file route serves the chord track as JSON.
    r = notation_client.get(f"/api/notation/file/{artifact['id']}")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/json")
    assert r.json()["schema"] == "gantasmo.chordtrack"

    # Listed among the entry's artifacts with its kind.
    r = notation_client.get(
        f"/api/notation/{entry_id}/artifacts", params={"kind": "chordtrack"}
    )
    assert r.status_code == 200
    assert r.json()["count"] == 1

    # Bad inputs.
    r = notation_client.post(
        f"/api/notation/{entry_id}/chords", json={"source": "psychic"}
    )
    assert r.status_code == 422
    r = notation_client.post(
        f"/api/notation/{entry_id}/chords",
        json={"source": "harmony", "source_artifact_id": "nope"},
    )
    assert r.status_code == 404


def test_export_route_beatsaber_lands_in_its_own_folder_and_serves_zip(
    notation_client: TestClient, tmp_path: Path, monkeypatch
):
    from backend.modules.library import router as library_router_module
    from tests.test_library_store import _seed_generate_entry

    monkeypatch.setattr(beatsaber, "find_ffmpeg", lambda: None)
    _seed_generate_entry(tmp_path, "job_bz", 0)
    entry_id = "job_bz_00"
    store = library_router_module.get_store()
    assert store.get_entry(entry_id) is not None
    entry_dir = tmp_path / "job_bz" / "00"
    midi = entry_dir / "midi" / "scale.mid"
    _write_scale_midi(midi)
    store.db.add_notation_artifact(
        artifact_id="scale_mid", entry_id=entry_id, kind="midi", path=str(midi)
    )
    store.db.upsert_analysis(entry_id, {"bpm": 90.0})

    r = notation_client.post(
        f"/api/notation/{entry_id}/export",
        json={"source_artifact_id": "scale_mid", "format": "beatsaber"},
    )
    assert r.status_code == 200, r.text
    artifact = r.json()["artifact"]
    path = Path(artifact["path"])
    assert path.parent == entry_dir / "notation" / "beatsaber"
    assert path.name.endswith(".beatsaber.zip")
    meta = json.loads(artifact["metadata_json"])
    assert meta["bpm_source"] == "analysis" and meta["bpm"] == 90.0

    r = notation_client.get(f"/api/notation/file/{artifact['id']}")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/zip")
    assert r.content[:2] == b"PK"

    # The existing formats still work with the (ignored) options field absent.
    r = notation_client.post(
        f"/api/notation/{entry_id}/export",
        json={"source_artifact_id": "scale_mid", "format": "notechart"},
    )
    assert r.status_code == 200, r.text
    chart_id = r.json()["artifact"]["id"]
    r = notation_client.get(f"/api/notation/file/{chart_id}")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/json")
    chart = r.json()
    assert chart["schema"] == "gantasmo.notechart"
    # The chart got the entry's duration (seeded metadata says 30 s).
    assert chart["audio"]["durationSec"] == 30.0


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
    a printable sheet at all. MuseScore now stands in the other way round: when
    the Node renderer is unavailable (no node, or frontend deps not installed)
    an installed MuseScore engraves the PDF, and with neither the call must
    still degrade, naming both, rather than raise. The test adapts to whichever
    environment runs it."""
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
        # OSMD is tried first; MuseScore only if that render failed.
        assert result["engine"] in ("osmd", "musescore"), result
        # The staging MusicXML written for a MIDI source must be cleaned up, and
        # must never leave a DB row pointing at a deleted path.
        assert not list(final.parent.glob("*__osmd_src.musicxml"))
    elif musescore_binary() is None:
        assert result["ok"] is False
        assert "OSMD" in result["error"] and "MuseScore" in result["error"], result


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


# ---- measure-and-fit (SCORE tab auto-fit mirrored in the PDF renderer) --------


def _write_six_staff_musicxml(path: Path) -> None:
    """Six treble staves whose chords span C2..C7 on every beat.

    OpenSheetMusicDisplay spaces staves from the rendered ink, so those ledger
    stacks make each system far taller than the printable page at the SCORE
    tab's default 520 px / 0.64 zoom: the case the measure-and-fit zoom exists
    for (OSMD cannot split a system across pages and would otherwise draw it
    straight off the sheet).
    """
    from music21 import chord, clef, meter, stream, tempo  # type: ignore[import]

    score = stream.Score()
    for index in range(6):
        part = stream.Part(id=f"P{index + 1}")
        part.partName = f"Part {index + 1}"
        part.append(clef.TrebleClef())
        part.append(meter.TimeSignature("4/4"))
        if index == 0:
            part.append(tempo.MetronomeMark(number=120))
        for measure in range(8):
            for beat in range(4):
                low = 36 + ((measure * 4 + beat) * 5) % 12
                high = 96 - ((measure + beat) % 5)
                part.append(chord.Chord([low, 60, 84, high], quarterLength=1.0))
        part.makeMeasures(inPlace=True)
        score.insert(0, part)
    path.parent.mkdir(parents=True, exist_ok=True)
    score.write("musicxml", fp=str(path))


def _write_lead_sheet_musicxml(path: Path) -> None:
    """A single-staff melody long enough for several pages: the ordinary sheet
    the auto-fit must leave exactly as it was."""
    from music21 import clef, meter, note, stream, tempo  # type: ignore[import]

    part = stream.Part(id="P1")
    part.partName = "Lead"
    part.append(clef.TrebleClef())
    part.append(meter.TimeSignature("4/4"))
    part.append(tempo.MetronomeMark(number=96))
    scale = [60, 62, 64, 65, 67, 69, 71, 72]
    for measure in range(48):
        for beat in range(4):
            pitch = scale[(measure + beat * 2) % len(scale)]
            part.append(note.Note(pitch, quarterLength=1.0))
    part.makeMeasures(inPlace=True)
    score = stream.Score()
    score.insert(0, part)
    path.parent.mkdir(parents=True, exist_ok=True)
    score.write("musicxml", fp=str(path))


def _skip_unless_headless_renderer() -> None:
    status = pdf_render.available()
    if not status["ok"]:
        pytest.skip(f"headless score renderer unavailable: {status}")


def test_pdf_render_fits_a_tall_score_to_the_page(tmp_path: Path):
    """Six staves of wide chords overflow the page at the default zoom; the
    renderer must lower the zoom (like ScoreView's doRender) until the tallest
    system sits above the usable line, and say so in its report."""
    _skip_unless_headless_renderer()
    source = tmp_path / "notation" / "six_staff.musicxml"
    _write_six_staff_musicxml(source)

    result = pdf_render.render_musicxml_pdf(
        source, tmp_path / "notation" / "six_staff.pdf", page_width=520, check_fit=True
    )

    assert result["ok"] is True, result
    fit = result["fit"]
    assert fit["systems"] > 0
    assert fit["startZoom"] == pytest.approx(0.64)
    # The fit actually had to act: at least one extra pass and a lower zoom ...
    assert fit["passes"] >= 1
    assert 0.3 <= result["zoom"] < 0.64
    # ... and it landed: nothing crosses the usable line, so nothing is drawn
    # off the page.
    assert fit["overflows"] is False
    assert fit["tallestBottom"] <= fit["usable"]
    # The report's geometry is self-consistent (usable keeps 30 % of the
    # 14-unit bottom margin clear; printable is OSMD's own page body).
    assert fit["bottomMargin"] == pytest.approx(14.0)
    assert fit["printable"] == pytest.approx(fit["pageHeight"] - 14.0)
    assert fit["usable"] == pytest.approx(fit["pageHeight"] - 0.3 * 14.0)
    assert fit["printable"] < fit["usable"] < fit["pageHeight"]


def test_pdf_render_leaves_a_lead_sheet_unchanged(tmp_path: Path):
    """A single-staff score fits at the default zoom, so auto-fit must be a
    no-op: same zoom, no extra pass, and the same page count as a render with
    the zoom pinned by hand (the analogue of the user zooming manually)."""
    _skip_unless_headless_renderer()
    source = tmp_path / "notation" / "lead.musicxml"
    _write_lead_sheet_musicxml(source)

    fitted = pdf_render.render_musicxml_pdf(
        source,
        tmp_path / "notation" / "lead_fitted.pdf",
        page_width=520,
        check_fit=True,
    )
    pinned = pdf_render.render_musicxml_pdf(
        source,
        tmp_path / "notation" / "lead_pinned.pdf",
        page_width=520,
        zoom=0.64,
        check_fit=True,
    )

    assert fitted["ok"] is True, fitted
    assert pinned["ok"] is True, pinned
    assert fitted["fit"]["passes"] == 0
    assert fitted["fit"]["overflows"] is False
    assert fitted["zoom"] == pytest.approx(0.64)
    assert pinned["zoom"] == pytest.approx(0.64)
    assert fitted["pages"] >= 2  # long enough that pagination is being tested
    assert fitted["pages"] == pinned["pages"]
    assert fitted["bytes"] == pinned["bytes"]


# ---- any part, any format, from either engraver ---------------------------------


def _write_two_part_musicxml(path: Path) -> None:
    """Two named parts, Lead (treble) then Bass (bass clef), a few notes each,
    in that ``<part-list>`` order."""
    from music21 import clef, meter, note, stream  # type: ignore[import]

    score = stream.Score()
    for index, (name, pitches, part_clef) in enumerate(
        (
            ("Lead", [72, 74, 76, 77], clef.TrebleClef()),
            ("Bass", [36, 38, 40, 41], clef.BassClef()),
        )
    ):
        part = stream.Part(id=f"P{index + 1}")
        part.partName = name
        part.append(part_clef)
        part.append(meter.TimeSignature("4/4"))
        for _measure in range(2):
            for pitch in pitches:
                part.append(note.Note(pitch, quarterLength=1.0))
        part.makeMeasures(inPlace=True)
        score.insert(0, part)
    path.parent.mkdir(parents=True, exist_ok=True)
    score.write("musicxml", fp=str(path))


def test_capabilities_lists_engravers_for_pdf_and_svg():
    """PDF and SVG each come from either engraver (OSMD first, MuseScore as the
    stand-in), so a format is offered exactly when at least one is present,
    and the probe says which, in the order convert_score tries them."""
    caps = capabilities()
    engravers = caps["engravers"]
    for fmt in ("pdf", "svg"):
        assert set(engravers[fmt]) <= {"osmd", "musescore"}, engravers
        assert (fmt in caps["formats"]) == bool(engravers[fmt]), (
            caps["formats"],
            engravers,
        )
    assert engravers["pdf"] == engravers["svg"]
    assert caps["musescore_download_url"].startswith("https://musescore.org")
    first = engravers["pdf"][0] if engravers["pdf"] else None
    assert caps["engines"]["score_to_pdf"] == first
    assert caps["engines"]["score_to_svg"] == first
    if caps["osmd_pdf"]:
        assert engravers["pdf"][0] == "osmd"
    if caps["musescore"]:
        assert "musescore" in engravers["pdf"]
        assert caps["musescore_path"]


def test_convert_score_scopes_any_format_to_one_part(tmp_path: Path):
    """options.parts filters the sheet before the ordinary converter runs, so
    ABC, MusicXML and the note chart of ONE part come out of the same sheet;
    the artifact records which part, the staging file is gone afterwards, and a
    part that does not exist is an error rather than a whole-sheet export."""
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track"})
    sheet = tmp_path / "notation" / "band.musicxml"
    _write_two_part_musicxml(sheet)
    out_dir = tmp_path / "notation"

    # ABC of the Bass only: a single voice (no V: declarations) that says so.
    result = convert_score(
        db,
        entry_id="track",
        source_path=sheet,
        fmt="abc",
        output_path=out_dir / "band__Bass.abc",
        source_ref="band_xml",
        artifact_id="band_xml__abc__p1",
        title="Song.wav",
        options={"parts": [1]},
    )
    assert result["ok"] is True, result
    meta = json.loads(result["artifact"]["metadata_json"])
    assert meta["parts"] == [{"index": 1, "name": "Bass"}]
    assert meta["source"] == str(sheet)  # the sheet, never the staging file
    text = Path(result["path"]).read_text(encoding="utf-8")
    assert "V:" not in text, text
    assert "T:Song · Bass" in text, text
    # The whole sheet has two voices, so the filter did the work.
    whole = convert_score(
        db,
        entry_id="track",
        source_path=sheet,
        fmt="abc",
        output_path=out_dir / "band.abc",
        artifact_id="band_xml__abc",
        title="Song.wav",
    )
    assert whole["ok"] is True, whole
    whole_text = Path(whole["path"]).read_text(encoding="utf-8")
    assert "V:2" in whole_text and "T:Song\n" in whole_text, whole_text

    # MusicXML of the Lead only: exactly one <score-part>, and it is Lead.
    result = convert_score(
        db,
        entry_id="track",
        source_path=sheet,
        fmt="musicxml",
        output_path=out_dir / "band__Lead.musicxml",
        artifact_id="band_xml__musicxml__p0",
        title="Song",
        options={"parts": [0]},
    )
    assert result["ok"] is True, result
    assert result["engine"] == "music21"
    xml = Path(result["path"]).read_text(encoding="utf-8")
    assert xml.count("<score-part ") == 1 and xml.count("<part ") == 1, xml[:2000]
    assert "<part-name>Lead</part-name>" in xml and "Bass" not in xml
    assert "<work-title>Song · Lead</work-title>" in xml
    assert json.loads(result["artifact"]["metadata_json"])["parts"] == [
        {"index": 0, "name": "Lead"}
    ]
    from music21 import converter as m21converter

    assert len(m21converter.parse(result["path"]).parts) == 1

    # The note chart too: one part in the document.
    chart = convert_score(
        db,
        entry_id="track",
        source_path=sheet,
        fmt="notechart",
        output_path=out_dir / "band__Bass.notechart.json",
        options={"parts": [1]},
        audio_duration_sec=8.0,
    )
    assert chart["ok"] is True, chart
    doc = json.loads(Path(chart["path"]).read_text(encoding="utf-8"))
    assert len(doc["parts"]) == 1, [p.get("name") for p in doc["parts"]]

    # Nothing staged is left behind, and nothing staged was registered.
    assert not list(out_dir.glob("*__parts_src.musicxml"))
    assert not list(out_dir.glob("*__parts_midi_src.musicxml"))
    assert all(
        "__parts_src" not in a["path"] for a in db.list_notation_artifacts("track")
    )

    # A part that does not exist is an error, not a silent whole-sheet export.
    missing = convert_score(
        db,
        entry_id="track",
        source_path=sheet,
        fmt="abc",
        output_path=out_dir / "band__p5.abc",
        options={"parts": [5]},
    )
    assert missing["ok"] is False, missing
    assert "5" in missing["error"]
    assert not (out_dir / "band__p5.abc").exists()
    assert not list(out_dir.glob("*__parts_src.musicxml"))


def test_stage_parts_from_a_midi_source(tmp_path: Path):
    """A MIDI source is staged as MusicXML first, then filtered; the MIDI
    staging file goes with it."""
    midi_path = tmp_path / "midi" / "scale.mid"
    _write_scale_midi(midi_path)
    staged = stage_parts(
        midi_path, [0], "Scale", output_path=tmp_path / "out" / "x.abc"
    )
    try:
        assert staged.path.name == "x__parts_src.musicxml"
        assert staged.parts[0]["index"] == 0
        xml = staged.path.read_text(encoding="utf-8")
        assert xml.count("<score-part ") == 1
        assert not list((tmp_path / "out").glob("*__parts_midi_src.musicxml"))
    finally:
        staged.path.unlink(missing_ok=True)
    with pytest.raises(ValueError):
        stage_parts(midi_path, [7], "Scale", output_path=tmp_path / "out" / "y.abc")


def test_svg_export_comes_from_osmd_or_names_both_engravers(tmp_path: Path):
    """SVG is engraved by the headless OSMD renderer first (MuseScore stands
    in); with neither the error names both. A forced engraver that is absent
    is an error, never a silent switch."""
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track"})
    sheet = tmp_path / "notation" / "band.musicxml"
    _write_two_part_musicxml(sheet)
    result = convert_score(
        db,
        entry_id="track",
        source_path=sheet,
        fmt="svg",
        output_path=tmp_path / "notation" / "band.svg",
        artifact_id="band_xml__svg",
        title="Song",
    )
    if pdf_render.available()["ok"]:
        assert result["ok"] is True, result
        assert result["engine"] == "osmd"
        assert result["artifact"]["kind"] == "svg"
        svg_path = Path(result["path"])
        head = svg_path.read_bytes()[:64].lstrip()
        assert head.startswith(b"<svg") or head.startswith(b"<?xml"), head
        opening = svg_path.read_text(encoding="utf-8")[:600]
        assert 'xmlns="http://www.w3.org/2000/svg"' in opening, opening
        assert result["pages"] >= 1

        # One part only, same engraver.
        part = convert_score(
            db,
            entry_id="track",
            source_path=sheet,
            fmt="svg",
            output_path=tmp_path / "notation" / "band__Lead.svg",
            artifact_id="band_xml__svg__p0",
            title="Song",
            options={"parts": [0]},
        )
        assert part["ok"] is True, part
        assert json.loads(part["artifact"]["metadata_json"])["parts"] == [
            {"index": 0, "name": "Lead"}
        ]
        assert not list((tmp_path / "notation").glob("*__parts_src.musicxml"))
    elif musescore_binary() is None:
        assert result["ok"] is False, result
        error = result["error"]
        assert "OSMD" in error and "node" in error and "MuseScore" in error, error

    if musescore_binary() is None:
        forced = convert_score(
            db,
            entry_id="track",
            source_path=sheet,
            fmt="pdf",
            output_path=tmp_path / "notation" / "band_forced.pdf",
            options={"engine": "musescore"},
        )
        assert forced["ok"] is False, forced
        assert "MuseScore was not found" in forced["error"], forced
        assert "musescore.org" in forced["error"]


def test_musescore_command_honours_env_then_settings(tmp_path: Path, monkeypatch):
    """MUSESCORE_BIN wins; without it the path chosen in Settings
    (notation.musescore_path) is found; a stale path is skipped."""
    from backend.modules.settings import router as settings_router

    fake = tmp_path / "MuseScore4.exe"
    fake.write_bytes(b"")
    monkeypatch.setenv("MUSESCORE_BIN", str(fake))
    assert musescore_command() == [str(fake)]
    assert musescore_binary() == str(fake)
    assert capabilities()["musescore_path"] == str(fake)

    monkeypatch.delenv("MUSESCORE_BIN", raising=False)
    settings_file = tmp_path / "settings.json"
    settings_file.write_text(
        json.dumps({"notation": {"musescore_path": str(fake)}}), encoding="utf-8"
    )
    monkeypatch.setenv("theDAW_SETTINGS_PATH", str(settings_file))
    monkeypatch.setattr(settings_router, "_store", None)
    assert musescore_command() == [str(fake)]
    # The settings store accepts the key (it is in DEFAULT_SETTINGS), so a
    # PATCH from the UI lands rather than being dropped as unknown.
    settings_router.get_store().patch({"notation": {"musescore_path": str(fake)}})
    assert settings_router.get_store().get_section("notation")["musescore_path"] == str(
        fake
    )

    fake.unlink()
    assert musescore_binary() != str(fake)


def test_export_route_part_scoped_names_the_artifact_and_file(
    notation_client: TestClient, tmp_path: Path
):
    """POST /export with options.parts names the file after the part and the
    artifact ``__<fmt>__p<i>``, beside the whole-sheet export; the pack takes
    the same filter as ``?parts=``."""
    from backend.modules.library import router as library_router_module
    from tests.test_library_store import _seed_generate_entry

    _seed_generate_entry(tmp_path, "job_px", 0)
    entry_id = "job_px_00"
    store = library_router_module.get_store()
    assert store.get_entry(entry_id) is not None
    entry_dir = tmp_path / "job_px" / "00"
    sheet = entry_dir / "notation" / "band.musicxml"
    _write_two_part_musicxml(sheet)
    store.db.add_notation_artifact(
        artifact_id="band_xml", entry_id=entry_id, kind="musicxml", path=str(sheet)
    )

    r = notation_client.post(
        f"/api/notation/{entry_id}/export",
        json={
            "source_artifact_id": "band_xml",
            "format": "abc",
            "options": {"parts": [0]},
        },
    )
    assert r.status_code == 200, r.text
    artifact = r.json()["artifact"]
    assert artifact["id"].endswith("__abc__p0"), artifact["id"]
    part_path = Path(artifact["path"])
    assert part_path.name.endswith("__Lead.abc"), part_path.name
    assert json.loads(artifact["metadata_json"])["parts"] == [
        {"index": 0, "name": "Lead"}
    ]

    # The whole-sheet export keeps its own id and file; the per-part one stays.
    r = notation_client.post(
        f"/api/notation/{entry_id}/export",
        json={"source_artifact_id": "band_xml", "format": "abc"},
    )
    assert r.status_code == 200, r.text
    whole = r.json()["artifact"]
    assert whole["id"] == "band_xml__abc"
    assert Path(whole["path"]).name.endswith("band.abc")
    assert part_path.is_file()
    assert not list((entry_dir / "notation").glob("*__parts_src.musicxml"))

    # The pack ships the filtered sheet under the part's name.
    r = notation_client.get("/api/notation/pack/band_xml", params={"parts": "1"})
    assert r.status_code == 200, r.text
    with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
        names = zf.namelist()
        xml_name = next(n for n in names if n.endswith(".musicxml"))
        xml = zf.read(xml_name).decode("utf-8")
    assert xml_name.endswith("__Bass.musicxml"), names
    assert xml.count("<score-part ") == 1 and "<part-name>Bass</part-name>" in xml
    assert "__Bass_score.zip" in r.headers["content-disposition"]
    assert not list((entry_dir / "notation").glob("*__parts_src.musicxml"))

    r = notation_client.get("/api/notation/pack/band_xml", params={"parts": "x"})
    assert r.status_code == 422


def test_pack_route_packs_a_midi_source_too(
    notation_client: TestClient, tmp_path: Path
):
    """A MIDI artifact packs as MIDI + PDF (the PDF engraved from a staged
    sheet); without any engraver the zip still carries the MIDI."""
    from backend.modules.library import router as library_router_module
    from tests.test_library_store import _seed_generate_entry

    _seed_generate_entry(tmp_path, "job_pm", 0)
    entry_id = "job_pm_00"
    store = library_router_module.get_store()
    entry_dir = tmp_path / "job_pm" / "00"
    midi = entry_dir / "midi" / "scale.mid"
    _write_scale_midi(midi)
    store.db.add_notation_artifact(
        artifact_id="scale_mid", entry_id=entry_id, kind="midi", path=str(midi)
    )
    r = notation_client.get("/api/notation/pack/scale_mid")
    assert r.status_code == 200, r.text
    with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
        names = zf.namelist()
    assert any(n.endswith(".mid") for n in names), names
    if pdf_render.available()["ok"] or musescore_binary() is not None:
        assert any(n.endswith(".pdf") for n in names), names
    assert not list((entry_dir / "notation").glob("*__osmd_src.musicxml"))
