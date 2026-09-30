"""Unit tests for the midi module.

We can't assume basic-pitch or piano-transcription-inference are
installed (they're heavy optional deps), so these tests cover the
graceful-degradation paths: capability probe, routing logic, and the
DB rows / status transitions that happen when all engines are missing.
"""

from __future__ import annotations

import importlib.metadata
import json
from pathlib import Path

import pytest

from backend.modules.midi.engine import (
    _module_version,
    convert_to_midi,
    engine_capabilities,
    hint_for_stem,
)
from backend.modules.midi.runner import convert_entry


def test_engine_capabilities_returns_bools():
    caps = engine_capabilities()
    assert isinstance(caps["basic_pitch"], bool)
    assert isinstance(caps["piano_transcription_inference"], bool)
    assert caps["drum_onsets"] is True


def test_hint_for_stem_routes_piano_specially():
    assert hint_for_stem("piano") == "piano"
    assert hint_for_stem("Piano") == "piano"
    assert hint_for_stem("KEYS") == "piano"
    assert hint_for_stem("vocals") == "generic"
    assert hint_for_stem("drums") == "drums"  # model-free drum engine
    assert hint_for_stem(None) == "generic"
    assert hint_for_stem("") == "generic"


def test_hint_for_stem_sends_a_split_kit_to_the_drum_engine():
    # A 12-stem run splits the kit into five stems; basic-pitch would read
    # each one as pitched notes over five octaves, as it does a whole kit.
    for piece in (
        "kick",
        "snare",
        "toms",
        "hihat",
        "cymbals",
        "Hi-Hat",
        "overheads",
        "percussion",
    ):
        assert hint_for_stem(piece) == "drums", piece
    assert hint_for_stem("bass") == "generic"
    assert hint_for_stem("other") == "generic"


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


def test_module_version_reads_the_distribution_metadata():
    """basic-pitch defines no ``__version__``; the MIDI row still records the
    installed release."""
    try:
        expected = importlib.metadata.version("basic-pitch")
    except importlib.metadata.PackageNotFoundError:
        pytest.skip("basic-pitch is not installed")
    assert _module_version("basic_pitch") == expected


def test_module_version_of_a_missing_engine_is_unknown():
    assert _module_version("no_such_midi_engine") == "unknown"


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


def test_convert_entry_mirrors_new_midi_into_notation_artifacts_immediately(
    tmp_path: Path, monkeypatch
):
    """A successful conversion mirrors its `midis` row into
    `notation_artifacts` right away (SCORE-009 follow-up): no GET self-heal
    (removed) and no backfill run needed -- the write path itself mirrors."""
    from backend.modules.library.db import LibraryDB
    from backend.modules.midi import runner as runner_module

    def _fake_convert_to_midi(src, out, *, hint="generic", auto_install=True, **kw):
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(b"MThd")
        return {
            "ok": True,
            "engine": "fake-engine",
            "engine_version": "1",
            "notes_count": 8,
        }

    monkeypatch.setattr(runner_module, "convert_to_midi", _fake_convert_to_midi)

    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track"})
    entry_dir = tmp_path / "entry"
    entry_dir.mkdir()
    audio = entry_dir / "audio.wav"
    audio.write_bytes(b"RIFF\x00\x00\x00\x00WAVE")

    summary = runner_module.convert_entry(
        db, "track", audio, entry_dir, from_stems=False, auto_install=False
    )
    assert summary["status"] == "complete"
    assert summary["successes"] == 1

    # Immediately, with no backfill call in between: the write path mirrored
    # the row itself.
    mirrored = db.list_notation_artifacts("track", kind="midi")
    assert len(mirrored) == 1
    assert mirrored[0]["id"] == "track__full__artifact_midi"
    assert json.loads(mirrored[0]["metadata_json"])["legacy_midi_id"] == "track__full"


def test_convert_entry_succeeds_even_when_the_notation_mirror_raises(
    tmp_path: Path, monkeypatch
):
    """A failure in the best-effort notation-artifact mirror must never fail
    the MIDI conversion it rides on: the conversion already succeeded and is
    already recorded in the `midis` table before the mirror is attempted."""
    from backend.modules.library.db import LibraryDB
    from backend.modules.midi import runner as runner_module
    from backend.modules.notation import engine as notation_engine_module

    def _fake_convert_to_midi(src, out, *, hint="generic", auto_install=True, **kw):
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(b"MThd")
        return {"ok": True, "engine": "fake-engine", "engine_version": "1"}

    def _raising_mirror(db_arg, entry_id):
        raise RuntimeError("simulated mirror failure")

    monkeypatch.setattr(runner_module, "convert_to_midi", _fake_convert_to_midi)
    monkeypatch.setattr(
        notation_engine_module, "register_existing_midis", _raising_mirror
    )

    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track"})
    entry_dir = tmp_path / "entry"
    entry_dir.mkdir()
    audio = entry_dir / "audio.wav"
    audio.write_bytes(b"RIFF\x00\x00\x00\x00WAVE")

    summary = runner_module.convert_entry(
        db, "track", audio, entry_dir, from_stems=False, auto_install=False
    )
    assert summary["status"] == "complete"
    assert summary["successes"] == 1

    # The conversion itself is still recorded, even though its mirror failed.
    assert len(db.list_midis("track")) == 1
    assert db.list_notation_artifacts("track", kind="midi") == []


def test_convert_entry_mirrors_once_for_a_multi_target_conversion(
    tmp_path: Path, monkeypatch
):
    """register_existing_midis mirrors the WHOLE entry (every midis row, not
    just the one just added), so it must run once per convert_entry call, not
    once per successful target: a full track + 2 stems must mirror once, not
    three times (each of which would also bump library_revision)."""
    from backend.modules.library.db import LibraryDB
    from backend.modules.midi import runner as runner_module
    from backend.modules.notation import engine as notation_engine_module

    def _fake_convert_to_midi(src, out, *, hint="generic", auto_install=True, **kw):
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(b"MThd")
        return {"ok": True, "engine": "fake-engine", "engine_version": "1"}

    calls = {"n": 0}
    real_register_existing_midis = notation_engine_module.register_existing_midis

    def _counting_mirror(db_arg, entry_id):
        calls["n"] += 1
        return real_register_existing_midis(db_arg, entry_id)

    monkeypatch.setattr(runner_module, "convert_to_midi", _fake_convert_to_midi)
    monkeypatch.setattr(
        notation_engine_module, "register_existing_midis", _counting_mirror
    )

    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track"})
    entry_dir = tmp_path / "entry"
    entry_dir.mkdir()
    audio = entry_dir / "audio.wav"
    audio.write_bytes(b"RIFF\x00\x00\x00\x00WAVE")

    for stem_name in ("vocals", "drums"):
        stem_audio = entry_dir / "stems" / f"{stem_name}.wav"
        stem_audio.parent.mkdir(parents=True, exist_ok=True)
        stem_audio.write_bytes(b"RIFF\x00\x00\x00\x00WAVE")
        db.add_stem(
            stem_id=f"track__{stem_name}",
            entry_id="track",
            stem_name=stem_name,
            audio_path=str(stem_audio),
        )

    summary = runner_module.convert_entry(
        db, "track", audio, entry_dir, from_stems=True, auto_install=False
    )
    assert summary["successes"] == 3  # full + 2 stems
    assert calls["n"] == 1
    assert len(db.list_notation_artifacts("track", kind="midi")) == 3
