"""Unit tests for backend.modules.library.store."""

from __future__ import annotations

import json
from pathlib import Path

from backend.modules.library.db import LibraryDB
from backend.modules.library.store import LibraryStore, USER_MUTABLE_FIELDS


def _seed_generate_entry(
    root: Path,
    job_id: str,
    index: int,
    audio_bytes: bytes = b"RIFF\x00\x00\x00\x00WAVE",
    extra_meta: dict | None = None,
) -> Path:
    """Replicate the on-disk layout that `_save_generation_artifacts_sync`
    creates so we can test the store against real fixtures."""
    item_dir = root / job_id / f"{index:02d}"
    item_dir.mkdir(parents=True, exist_ok=True)
    audio_name = "output.wav"
    (item_dir / audio_name).write_bytes(audio_bytes)
    meta = {
        "job_id": job_id,
        "index": index,
        "filename": audio_name,
        "mime_type": "audio/wav",
        "title": f"gen-{job_id[:6]}",
        "prompt": "test prompt",
        "duration": 30.0,
        "model": "medium",
        "steps": 8,
        "cfg": 1.0,
        "seed": 42,
        "favorite": False,
        "rating": None,
        "tags": [],
        "notes": "",
        "source": "generate",
        "saved_at": 1234567890.0,
    }
    if extra_meta:
        meta.update(extra_meta)
    (item_dir / "metadata.json").write_text(json.dumps(meta), encoding="utf-8")
    return item_dir


def test_list_entries_picks_up_nested_generate_layout(tmp_path: Path):
    _seed_generate_entry(tmp_path, "job_alpha", 0)
    _seed_generate_entry(tmp_path, "job_alpha", 1)
    _seed_generate_entry(tmp_path, "job_beta", 0)

    store = LibraryStore(tmp_path)
    records = store.list_entries()

    ids = {r.id for r in records}
    assert ids == {"job_alpha_00", "job_alpha_01", "job_beta_00"}
    for r in records:
        assert r.audio_url == f"/api/library/audio/{r.id}"
        assert r.file_size_bytes > 0
        assert r.source == "generate"


def test_get_entry_returns_correct_record(tmp_path: Path):
    _seed_generate_entry(tmp_path, "job1", 0, extra_meta={"prompt": "pinpoint test"})
    store = LibraryStore(tmp_path)

    record = store.get_entry("job1_00")

    assert record is not None
    assert record.id == "job1_00"
    assert record.prompt == "pinpoint test"


def test_get_entry_missing_returns_none(tmp_path: Path):
    store = LibraryStore(tmp_path)
    assert store.get_entry("nope") is None


def test_get_audio_path_resolves_declared_filename(tmp_path: Path):
    item_dir = _seed_generate_entry(tmp_path, "job1", 0)
    store = LibraryStore(tmp_path)

    audio = store.get_audio_path("job1_00")

    assert audio is not None
    assert audio == item_dir / "output.wav"


def test_update_entry_writes_only_user_mutable_fields(tmp_path: Path):
    _seed_generate_entry(tmp_path, "job1", 0)
    store = LibraryStore(tmp_path)

    record = store.update_entry(
        "job1_00",
        {
            "favorite": True,
            "rating": "like",
            "tags": ["chimera", "test"],
            "notes": "great",
            "prompt": "SHOULD NOT CHANGE",  # not in USER_MUTABLE_FIELDS
        },
    )

    assert record is not None
    assert record.favorite is True
    assert record.rating == "like"
    assert record.tags == ["chimera", "test"]
    assert record.notes == "great"
    # Backend-owned field stays put.
    assert record.prompt == "test prompt"

    # Re-read from disk to confirm persistence.
    fresh = LibraryStore(tmp_path)
    record2 = fresh.get_entry("job1_00")
    assert record2 is not None
    assert record2.favorite is True


def test_update_entry_rejects_invalid_rating(tmp_path: Path):
    _seed_generate_entry(tmp_path, "job1", 0)
    store = LibraryStore(tmp_path)

    record = store.update_entry("job1_00", {"rating": "smashing"})

    assert record is not None
    assert record.rating is None  # coerced


def test_delete_entry_removes_directory(tmp_path: Path):
    item_dir = _seed_generate_entry(tmp_path, "job1", 0)
    store = LibraryStore(tmp_path)

    assert store.delete_entry("job1_00") is True
    assert not item_dir.exists()
    assert store.get_entry("job1_00") is None


def test_delete_entry_missing_returns_false(tmp_path: Path):
    store = LibraryStore(tmp_path)
    assert store.delete_entry("nope") is False


def test_import_blob_creates_top_level_entry(tmp_path: Path):
    store = LibraryStore(tmp_path)

    audio_bytes = b"RIFF\x00\x00\x00\x00WAVEdata"
    record = store.import_blob(
        audio_bytes=audio_bytes,
        filename="my upload.wav",
        mime_type="audio/wav",
        metadata={"title": "Imported track", "source": "import", "tags": ["bucket"]},
    )

    assert record.title == "Imported track"
    assert record.source == "import"
    assert record.tags == ["bucket"]
    assert record.file_size_bytes == len(audio_bytes)

    # Lives at top level, not nested.
    assert (tmp_path / record.id).is_dir()
    assert (tmp_path / record.id / "metadata.json").is_file()

    # Round-trip via list/get.
    listed = {r.id for r in store.list_entries()}
    assert record.id in listed


def test_user_mutable_fields_frozenset_is_locked():
    # Lock the contract — adding a new field requires an intentional update.
    assert USER_MUTABLE_FIELDS == frozenset(
        {"favorite", "rating", "tags", "notes", "title", "chimera_sources", "lyrics"}
    )


def test_update_entry_accepts_chimera_sources_patch(tmp_path: Path):
    _seed_generate_entry(tmp_path, "job1", 0)
    store = LibraryStore(tmp_path)

    record = store.update_entry("job1_00", {"chimera_sources": ["A.wav", "B.wav"]})
    assert record is not None
    assert record.chimera_sources == ["A.wav", "B.wav"]


def test_record_reads_legacy_model_name_and_cfg_scale_aliases(tmp_path: Path):
    _seed_generate_entry(
        tmp_path,
        "legacy",
        0,
        extra_meta={
            "model_name": "small",
            "cfg_scale": 7.5,
            "model": None,
            "cfg": None,
        },
    )
    store = LibraryStore(tmp_path)

    record = store.get_entry("legacy_00")
    assert record is not None
    assert record.model == "small"
    assert record.cfg == 7.5


# ---- lyrics field -----------------------------------------------------------


def test_update_entry_round_trips_lyrics(tmp_path: Path):
    item_dir = _seed_generate_entry(tmp_path, "job1", 0)
    store = LibraryStore(tmp_path)

    record = store.update_entry("job1_00", {"lyrics": "la la\nda da"})

    assert record is not None
    assert record.lyrics == "la la\nda da"
    assert record.to_dict()["lyrics"] == "la la\nda da"

    # Persisted into metadata.json, the source of truth.
    meta = json.loads((item_dir / "metadata.json").read_text(encoding="utf-8"))
    assert meta["lyrics"] == "la la\nda da"

    # Survives a fresh store and both list paths (the DB mirror was synced).
    fresh = LibraryStore(tmp_path)
    got = fresh.get_entry("job1_00")
    assert got is not None
    assert got.lyrics == "la la\nda da"
    assert {r.id: r.lyrics for r in fresh.list_entries()}["job1_00"] == "la la\nda da"
    assert {r.id: r.lyrics for r in fresh.list_entries_fast()}["job1_00"] == (
        "la la\nda da"
    )


def test_update_entry_coerces_lyrics_to_str(tmp_path: Path):
    _seed_generate_entry(tmp_path, "job1", 0)
    store = LibraryStore(tmp_path)

    record = store.update_entry("job1_00", {"lyrics": 123})
    assert record is not None
    assert record.lyrics == "123"

    # None / falsy clears to '' rather than the string 'None'.
    record = store.update_entry("job1_00", {"lyrics": None})
    assert record is not None
    assert record.lyrics == ""


def test_record_defaults_lyrics_to_empty_string(tmp_path: Path):
    _seed_generate_entry(tmp_path, "job1", 0)
    store = LibraryStore(tmp_path)

    record = store.get_entry("job1_00")
    assert record is not None
    assert record.lyrics == ""
    assert record.to_dict()["lyrics"] == ""


def test_suno_metadata_lyrics_surfaces_on_record(tmp_path: Path):
    # Suno External API cache shape: an "inferred" marker plus the nested
    # metadata.lyrics that _flatten_suno_meta lifts to meta["lyrics"].
    _seed_generate_entry(
        tmp_path,
        "suno1",
        0,
        extra_meta={"model": "suno", "inferred": {}, "metadata": {"lyrics": "hey"}},
    )
    store = LibraryStore(tmp_path)

    record = store.get_entry("suno1_00")
    assert record is not None
    assert record.lyrics == "hey"

    walked = {r.id: r.lyrics for r in store.list_entries()}
    assert walked["suno1_00"] == "hey"

    store.reindex()
    fast = {r.id: r.lyrics for r in store.list_entries_fast()}
    assert fast["suno1_00"] == "hey"


def test_delete_notation_artifact(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    try:
        db.upsert_entry({"id": "e1", "title": "t", "audio_filename": "a.wav"})
        db.add_notation_artifact(
            artifact_id="e1__lyrics__lyrics",
            entry_id="e1",
            kind="lyrics",
            path=str(tmp_path / "e1" / "lyrics.json"),
            engine="lyrics",
            engine_version="1",
            metadata={"source": "manual"},
        )
        assert db.get_notation_artifact("e1__lyrics__lyrics") is not None

        assert db.delete_notation_artifact("e1__lyrics__lyrics") is True
        assert db.get_notation_artifact("e1__lyrics__lyrics") is None
        assert db.list_notation_artifacts("e1", kind="lyrics") == []
        # Second delete is a no-op.
        assert db.delete_notation_artifact("e1__lyrics__lyrics") is False
    finally:
        db.close()
