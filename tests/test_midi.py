"""Unit tests for the midi module.

We can't assume basic-pitch or piano-transcription-inference are
installed (they're heavy optional deps), so these tests cover the
graceful-degradation paths: capability probe, routing logic, and the
DB rows / status transitions that happen when all engines are missing.
"""

from __future__ import annotations

from pathlib import Path

from backend.modules.midi.engine import (
    convert_to_midi,
    engine_capabilities,
    hint_for_stem,
)
from backend.modules.midi.runner import convert_entry


def test_engine_capabilities_returns_bools():
    caps = engine_capabilities()
    assert isinstance(caps["basic_pitch"], bool)
    assert isinstance(caps["piano_transcription_inference"], bool)


def test_hint_for_stem_routes_piano_specially():
    assert hint_for_stem("piano") == "piano"
    assert hint_for_stem("Piano") == "piano"
    assert hint_for_stem("KEYS") == "piano"
    assert hint_for_stem("vocals") == "generic"
    assert hint_for_stem("drums") == "generic"
    assert hint_for_stem(None) == "generic"
    assert hint_for_stem("") == "generic"


def test_convert_to_midi_returns_error_when_no_engine_installed_and_no_autoinstall(
    tmp_path: Path,
):
    """With ``auto_install=False`` and no engine present, convert_to_midi
    returns ok=False with an install hint — not a raise. (The
    auto_install=True path is exercised manually via the /install endpoint;
    we don't run real pip in unit tests.)"""
    caps = engine_capabilities()
    if caps["basic_pitch"] or caps["piano_transcription_inference"]:
        return  # an engine IS installed; this graceful-degrade path isn't reachable

    src = tmp_path / "x.wav"
    src.write_bytes(b"RIFF\x00\x00\x00\x00WAVE")
    out = tmp_path / "x.mid"
    result = convert_to_midi(src, out, auto_install=False)
    assert result["ok"] is False
    assert "no MIDI conversion engine" in result["error"]


def test_convert_to_midi_missing_input(tmp_path: Path):
    result = convert_to_midi(tmp_path / "nope.wav", tmp_path / "nope.mid")
    assert result["ok"] is False
    assert "audio not found" in result["error"]


def test_convert_entry_records_failures_when_no_engine(tmp_path: Path):
    """When no engine is installed, convert_entry should still:
    - update the entry status to 'failed'
    - return a result with successes=0
    - not raise."""
    caps = engine_capabilities()
    if caps["basic_pitch"] or caps["piano_transcription_inference"]:
        return

    from backend.modules.library.db import LibraryDB

    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track"})

    entry_dir = tmp_path / "entry"
    entry_dir.mkdir()
    audio = entry_dir / "audio.wav"
    audio.write_bytes(b"RIFF\x00\x00\x00\x00WAVE")

    summary = convert_entry(
        db, "track", audio, entry_dir, from_stems=False, auto_install=False
    )
    assert summary["entry_id"] == "track"
    assert summary["status"] == "failed"
    assert summary["successes"] == 0
    assert summary["failures"] >= 1

    row = db.get_entry("track")
    assert row is not None
    assert row["midi_status"] == "failed"
