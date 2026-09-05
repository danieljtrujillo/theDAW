"""Unit tests for the chord track builder (``gantasmo.chordtrack``).

Both sources run against deterministic synthetic fixtures written into
``tmp_path``: a music21 lead sheet with ``<harmony>`` symbols for the harmony
path, and numpy-synthesised triads (C major then G major) written with
soundfile for the chroma path. No model weights, no network.

The assertions follow what breaks the consumer: the SCORE chord strip animates
from ``startSec``/``endSec`` and reads ``kind``/``pitchClasses`` for colour and
diagrams, and a ``null`` anywhere would fail the TS type guard.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np
import pytest
import soundfile as sf  # type: ignore[import]

from backend.modules.notation.exporters.chordtrack import (
    SCHEMA,
    SCHEMA_VERSION,
    build_chordtrack,
    write_chordtrack,
)

_SR = 22050


# --------------------------------------------------------------------------
# fixtures
# --------------------------------------------------------------------------


def _find_null(value: Any, path: str = "$") -> str:
    """Path of the first JSON null, or ``""``."""
    if value is None:
        return path
    if isinstance(value, dict):
        for key, item in value.items():
            found = _find_null(item, f"{path}.{key}")
            if found:
                return found
    elif isinstance(value, list):
        for index, item in enumerate(value):
            found = _find_null(item, f"{path}[{index}]")
            if found:
                return found
    return ""


def _write_lead_sheet(
    path: Path,
    figures: list[tuple[float, str]],
    *,
    bpm: float = 90.0,
    key_name: str = "C",
    quarters: int = 16,
) -> Path:
    """A one-part lead sheet: ``quarters`` quarter notes plus chord symbols at
    the given quarter offsets (music21 figures, ``-`` spells flats)."""
    from music21 import harmony, key, meter, note, stream, tempo  # type: ignore[import]

    score = stream.Score()
    part = stream.Part()
    part.append(tempo.MetronomeMark(number=bpm))
    part.append(meter.TimeSignature("4/4"))
    part.append(key.Key(key_name))
    for offset, figure in figures:
        part.insert(offset, harmony.ChordSymbol(figure))
    for beat in range(quarters):
        n = note.Note("C4")
        n.quarterLength = 1.0
        part.insert(float(beat), n)
    score.insert(0, part)
    path.parent.mkdir(parents=True, exist_ok=True)
    score.write("musicxml", fp=str(path))
    return path


def _triad(midis: list[int], seconds: float) -> np.ndarray:
    t = np.arange(int(_SR * seconds)) / _SR
    out = np.zeros_like(t)
    for midi in midis:
        freq = 440.0 * 2 ** ((midi - 69) / 12)
        # Fundamental plus an octave-below doubling, as a plucked chord has.
        out += np.sin(2 * np.pi * freq * t) + 0.5 * np.sin(2 * np.pi * (freq / 2) * t)
    return out / (len(midis) * 1.5)


@pytest.fixture(scope="module")
def c_then_g_wav(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """8 s at 22050 Hz: C major (0-4 s) then G major (4-8 s)."""
    path = tmp_path_factory.mktemp("chroma") / "x.wav"
    audio = np.concatenate(
        [_triad([60, 64, 67], 4.0), _triad([67, 71, 74], 4.0)]
    ).astype(np.float32)
    sf.write(str(path), audio, _SR)
    return path


@pytest.fixture
def analysis_row() -> dict[str, Any]:
    return {
        "bpm": 120,
        "beats_json": json.dumps([i * 0.5 for i in range(16)]),
        "key": "C",
        "scale": "major",
    }


# --------------------------------------------------------------------------
# harmony source
# --------------------------------------------------------------------------


def test_harmony_timing_kinds_and_contiguity(tmp_path: Path):
    sheet = _write_lead_sheet(
        tmp_path / "lead.musicxml",
        [(0.0, "C"), (4.0, "G7"), (8.0, "Am"), (12.0, "F")],
        bpm=90.0,
    )
    doc = build_chordtrack(
        entry_id="e",
        audio_path=None,
        analysis_row=None,
        lead_sheet_path=sheet,
        method="harmony",
    )

    assert doc["schema"] == SCHEMA
    assert doc["schemaVersion"] == SCHEMA_VERSION
    assert doc["source"] == {
        "entryId": "e",
        "method": "harmony",
        "sourceArtifactId": "",
    }
    assert _find_null(doc) == ""

    chords = doc["chords"]
    assert len(chords) == 4
    sec_per_quarter = 60.0 / 90.0
    expected_starts = [
        0.0,
        4 * sec_per_quarter,
        8 * sec_per_quarter,
        12 * sec_per_quarter,
    ]
    for chord, expected in zip(chords, expected_starts):
        assert chord["startSec"] == pytest.approx(expected, abs=1e-6)
    for earlier, later in zip(chords, chords[1:]):
        assert earlier["endSec"] == pytest.approx(later["startSec"], abs=1e-9)
    assert chords[-1]["endSec"] == pytest.approx(16 * sec_per_quarter, abs=1e-6)

    assert [c["kind"] for c in chords] == [
        "major",
        "dominant-seventh",
        "minor",
        "major",
    ]
    assert [c["rootPc"] for c in chords] == [0, 7, 9, 5]
    assert [c["symbol"] for c in chords] == ["C", "G7", "Am", "F"]
    assert chords[0]["pitchClasses"] == [0, 4, 7]
    assert chords[1]["pitchClasses"][0] == 7 and set(chords[1]["pitchClasses"]) == {
        7,
        11,
        2,
        5,
    }
    assert all(c["bassPc"] == -1 for c in chords)
    assert all(c["confidence"] == 1.0 for c in chords)
    assert [c["id"] for c in chords] == [0, 1, 2, 3]
    assert [c["measure"] for c in chords] == [1, 2, 3, 4]
    assert [c["startBeat"] for c in chords] == [0.0, 4.0, 8.0, 12.0]

    timing = doc["timing"]
    assert timing["bpm"] == pytest.approx(90.0)
    assert timing["beatsPerBar"] == 4
    assert timing["durationSec"] == pytest.approx(16 * sec_per_quarter, abs=1e-6)
    assert timing["beats"][:3] == pytest.approx(
        [0.0, sec_per_quarter, 2 * sec_per_quarter]
    )
    assert timing["downbeats"][:2] == pytest.approx([0.0, 4 * sec_per_quarter])
    assert doc["key"] == {"tonic": "C", "mode": "major", "confidence": 1.0}
    assert doc["stats"]["chordCount"] == 4
    assert doc["stats"]["distinctSymbols"] == 4
    assert doc["stats"]["meanConfidence"] == pytest.approx(1.0)


def test_harmony_spells_flats_in_flat_keys_and_reads_slash_bass(tmp_path: Path):
    sheet = _write_lead_sheet(
        tmp_path / "lead.musicxml",
        [(0.0, "F"), (4.0, "B-"), (8.0, "C7/E"), (12.0, "F")],
        key_name="F",
    )
    doc = build_chordtrack(
        entry_id="e",
        audio_path=None,
        analysis_row=None,
        lead_sheet_path=sheet,
        method="harmony",
    )
    symbols = [c["symbol"] for c in doc["chords"]]
    assert symbols[1] == "Bb"
    assert "A#" not in " ".join(symbols)
    assert doc["chords"][1]["root"] == "Bb"
    assert doc["chords"][1]["rootPc"] == 10
    assert doc["chords"][2]["symbol"] == "C7/E"
    assert doc["chords"][2]["bassPc"] == 4
    assert doc["chords"][2]["rootPc"] == 0
    assert doc["key"]["tonic"] == "F"


def test_harmony_merges_repeated_symbols(tmp_path: Path):
    sheet = _write_lead_sheet(
        tmp_path / "lead.musicxml",
        [(0.0, "C"), (4.0, "C"), (8.0, "G"), (12.0, "G")],
    )
    doc = build_chordtrack(
        entry_id="e",
        audio_path=None,
        analysis_row=None,
        lead_sheet_path=sheet,
        method="harmony",
    )
    assert [c["symbol"] for c in doc["chords"]] == ["C", "G"]
    assert doc["chords"][0]["endSec"] == pytest.approx(doc["chords"][1]["startSec"])


def test_harmony_without_symbols_raises(tmp_path: Path):
    sheet = _write_lead_sheet(tmp_path / "plain.musicxml", [])
    with pytest.raises(ValueError):
        build_chordtrack(
            entry_id="e",
            audio_path=None,
            analysis_row=None,
            lead_sheet_path=sheet,
            method="harmony",
        )


def test_unknown_method_or_resolution_is_rejected(tmp_path: Path):
    with pytest.raises(ValueError):
        build_chordtrack(
            entry_id="e",
            audio_path=None,
            analysis_row=None,
            lead_sheet_path=None,
            method="magic",
        )
    with pytest.raises(ValueError):
        build_chordtrack(
            entry_id="e",
            audio_path=None,
            analysis_row=None,
            lead_sheet_path=None,
            resolution="phrase",
        )


# --------------------------------------------------------------------------
# chroma source
# --------------------------------------------------------------------------


def test_chroma_with_analysis_row_finds_c_then_g(
    c_then_g_wav: Path, analysis_row: dict[str, Any]
):
    doc = build_chordtrack(
        entry_id="e",
        audio_path=c_then_g_wav,
        analysis_row=analysis_row,
        lead_sheet_path=None,
        method="chroma",
    )
    assert doc["source"]["method"] == "chroma"
    assert _find_null(doc) == ""
    chords = doc["chords"]
    assert len(chords) >= 2

    first = chords[0]
    assert first["startSec"] == 0.0
    assert first["rootPc"] == 0
    assert first["kind"] == "major"
    assert first["symbol"] == "C"
    assert first["pitchClasses"] == [0, 4, 7]

    g_chords = [c for c in chords if c["rootPc"] == 7]
    assert g_chords, "expected a G chord in the second half"
    assert abs(g_chords[0]["startSec"] - 4.0) <= 0.6

    for chord in chords:
        assert 0.0 < chord["confidence"] <= 1.0
    for earlier, later in zip(chords, chords[1:]):
        assert earlier["endSec"] == pytest.approx(later["startSec"])
    assert chords[-1]["endSec"] == pytest.approx(8.0, abs=1e-3)

    timing = doc["timing"]
    assert timing["bpm"] == pytest.approx(120.0)
    assert timing["beats"] == pytest.approx([i * 0.5 for i in range(16)])
    assert timing["downbeats"] == pytest.approx([0.0, 2.0, 4.0, 6.0])
    assert timing["durationSec"] == pytest.approx(8.0, abs=1e-3)
    assert doc["key"]["tonic"] == "C" and doc["key"]["mode"] == "major"


def test_chroma_without_analysis_row_uses_beat_tracker(c_then_g_wav: Path):
    doc = build_chordtrack(
        entry_id="e",
        audio_path=c_then_g_wav,
        analysis_row=None,
        lead_sheet_path=None,
        method="chroma",
    )
    assert _find_null(doc) == ""
    assert len(doc["chords"]) >= 2
    assert doc["timing"]["bpm"] > 0
    assert len(doc["timing"]["beats"]) >= 2
    assert doc["key"] == {"tonic": "", "mode": "", "confidence": 0.0}
    roots = [c["rootPc"] for c in doc["chords"]]
    assert 0 in roots and 7 in roots


def test_chroma_bar_resolution_changes_on_downbeats(
    c_then_g_wav: Path, analysis_row: dict[str, Any]
):
    doc = build_chordtrack(
        entry_id="e",
        audio_path=c_then_g_wav,
        analysis_row=analysis_row,
        lead_sheet_path=None,
        method="chroma",
        resolution="bar",
    )
    downbeats = doc["timing"]["downbeats"]
    assert doc["chords"][0]["startSec"] == 0.0
    for chord in doc["chords"][1:]:
        assert any(abs(chord["startSec"] - d) < 1e-6 for d in downbeats), chord
    assert len(doc["chords"]) >= 2


def test_chroma_without_sevenths_only_emits_triads(
    c_then_g_wav: Path, analysis_row: dict[str, Any]
):
    doc = build_chordtrack(
        entry_id="e",
        audio_path=c_then_g_wav,
        analysis_row=analysis_row,
        lead_sheet_path=None,
        method="chroma",
        include_sevenths=False,
    )
    assert {c["kind"] for c in doc["chords"]} <= {"major", "minor", "none"}


def test_chroma_needs_audio():
    with pytest.raises(ValueError):
        build_chordtrack(
            entry_id="e",
            audio_path=None,
            analysis_row=None,
            lead_sheet_path=None,
            method="chroma",
        )


# --------------------------------------------------------------------------
# auto selection
# --------------------------------------------------------------------------


def test_auto_prefers_lead_sheet_with_two_or_more_symbols(
    tmp_path: Path, c_then_g_wav: Path
):
    sheet = _write_lead_sheet(tmp_path / "lead.musicxml", [(0.0, "D"), (8.0, "A")])
    doc = build_chordtrack(
        entry_id="e",
        audio_path=c_then_g_wav,
        analysis_row=None,
        lead_sheet_path=sheet,
        method="auto",
        source_artifact_id="lead-1",
    )
    assert doc["source"]["method"] == "harmony"
    assert doc["source"]["sourceArtifactId"] == "lead-1"
    assert [c["symbol"] for c in doc["chords"]] == ["D", "A"]


def test_auto_falls_back_to_chroma_when_lead_sheet_is_bare(
    tmp_path: Path, c_then_g_wav: Path, analysis_row: dict[str, Any]
):
    sheet = _write_lead_sheet(tmp_path / "plain.musicxml", [])
    doc = build_chordtrack(
        entry_id="e",
        audio_path=c_then_g_wav,
        analysis_row=analysis_row,
        lead_sheet_path=sheet,
        method="auto",
    )
    assert doc["source"]["method"] == "chroma"
    assert doc["chords"][0]["rootPc"] == 0


def test_auto_with_no_sources_raises():
    with pytest.raises(ValueError):
        build_chordtrack(
            entry_id="e",
            audio_path=None,
            analysis_row=None,
            lead_sheet_path=None,
            method="auto",
        )


# --------------------------------------------------------------------------
# writer
# --------------------------------------------------------------------------


def test_write_chordtrack_round_trips(tmp_path: Path):
    sheet = _write_lead_sheet(
        tmp_path / "lead.musicxml", [(0.0, "C"), (4.0, "G7"), (8.0, "Am"), (12.0, "F")]
    )
    output = tmp_path / "notation" / "song__chords.chordtrack.json"
    result = write_chordtrack(
        output,
        entry_id="e",
        audio_path=None,
        analysis_row=None,
        lead_sheet_path=sheet,
        method="harmony",
    )
    assert result["ok"] is True
    assert result["engine"] == "chordtrack"
    assert result["method"] == "harmony"
    assert result["stats"]["chordCount"] == 4
    assert Path(result["path"]) == output
    on_disk = json.loads(output.read_text(encoding="utf-8"))
    assert on_disk["schema"] == SCHEMA
    assert on_disk["schemaVersion"] == SCHEMA_VERSION
    assert _find_null(on_disk) == ""
    assert "null" not in output.read_text(encoding="utf-8")


def test_write_chordtrack_refuses_an_empty_result(tmp_path: Path):
    sheet = _write_lead_sheet(tmp_path / "plain.musicxml", [])
    output = tmp_path / "notation" / "song__chords.chordtrack.json"
    result = write_chordtrack(
        output,
        entry_id="e",
        audio_path=None,
        analysis_row=None,
        lead_sheet_path=sheet,
        method="harmony",
    )
    assert result["ok"] is False
    assert "error" in result
    assert not output.exists()


# --------------------------------------------------------------------------
# route (W2 router spec: POST /api/notation/{entry_id}/chords)
# --------------------------------------------------------------------------


@pytest.fixture
def notation_client(tmp_path: Path, monkeypatch) -> Any:
    """Library + notation routers on a fresh tmp library root (the
    ``tests/test_library_endpoints.py`` pattern)."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from backend.modules.library import router as library_router_module
    from backend.modules.notation import router as notation_router_module

    monkeypatch.setattr(library_router_module, "_store", None)
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(tmp_path))
    app = FastAPI()
    app.include_router(library_router_module.router, prefix="/api/library")
    app.include_router(notation_router_module.router, prefix="/api/notation")
    return TestClient(app)


def test_chords_route_404s_without_sources(notation_client: Any, tmp_path: Path):
    from tests.test_library_store import _seed_generate_entry

    item_dir = _seed_generate_entry(tmp_path, "job_chords", 0)
    # No audio on disk and no lead sheet registered: nothing to derive from.
    (item_dir / "output.wav").unlink()

    r = notation_client.post(
        "/api/notation/job_chords_00/chords", json={"source": "chroma"}
    )
    assert r.status_code == 404
    assert "audio" in str(r.json().get("detail", "")).lower()

    r = notation_client.post(
        "/api/notation/job_chords_00/chords", json={"source": "harmony"}
    )
    assert r.status_code == 404
    assert "lead sheet" in str(r.json().get("detail", "")).lower()

    r = notation_client.post("/api/notation/no-such-entry/chords", json={})
    assert r.status_code == 404
