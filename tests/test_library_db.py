"""Unit tests for backend.modules.library.db."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from backend.modules.library.db import LibraryDB
from backend.modules.library.store import LibraryStore


def _make_entry_payload(entry_id: str, **overrides) -> dict:
    payload = {
        "id": entry_id,
        "kind": "audio",
        "title": "test",
        "prompt": "ambient track",
        "negative_prompt": "vocals",
        "model": "small",
        "duration": 30.0,
        "steps": 8,
        "cfg": 1.0,
        "seed": 42,
        "mime_type": "audio/wav",
        "audio_filename": "output.wav",
        "file_size_bytes": 100,
        "source": "generate",
        "favorite": False,
        "rating": None,
        "notes": "",
        "timestamp": "2026-05-25T00:00:00Z",
        "tags": ["ambient", "test"],
        "metadata_json": {"raw": "blob"},
    }
    payload.update(overrides)
    return payload


def test_schema_migrates_on_first_open(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    assert db.schema_version() == 4
    assert db.count_entries() == 0


def test_increment_play_count(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry(_make_entry_payload("e1"))
    assert db.get_entry("e1")["play_count"] == 0
    assert db.increment_play_count("e1") == 1
    assert db.increment_play_count("e1") == 2
    row = db.get_entry("e1")
    assert row["play_count"] == 2
    assert row["last_played_at"] is not None
    assert db.increment_play_count("missing") is None


def test_upsert_preserves_play_count(tmp_path: Path):
    # play_count survives metadata edits / re-index — upsert never resets it.
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry(_make_entry_payload("e1"))
    db.increment_play_count("e1")
    db.increment_play_count("e1")
    db.upsert_entry(_make_entry_payload("e1", favorite=True))
    assert db.get_entry("e1")["play_count"] == 2


def test_suggest_playlist(tmp_path: Path):
    from backend.modules.library.suggester import suggest_playlist

    db = LibraryDB(tmp_path / "library.db")
    specs = [
        (120, "C", "major"),
        (122, "G", "major"),
        (124, "D", "major"),
        (118, "A", "minor"),
    ]
    for i, (bpm, key, scale) in enumerate(specs):
        eid = f"e{i}"
        db.upsert_entry(_make_entry_payload(eid, title=f"t{i}", duration=120))
        db.upsert_analysis(eid, {"bpm": bpm, "key": key, "scale": scale})

    res = suggest_playlist(db, target_duration_sec=360, harmonic=True, flow="steady")
    assert 2 <= res["track_count"] <= 4
    assert res["total_duration_sec"] <= 360 * 1.13
    ids = [t["id"] for t in res["tracks"]]
    assert len(ids) == len(set(ids))
    assert all(t["camelot"] for t in res["tracks"])


def test_suggest_playlist_respects_bpm_filter(tmp_path: Path):
    from backend.modules.library.suggester import suggest_playlist

    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry(_make_entry_payload("slow", duration=120))
    db.upsert_analysis("slow", {"bpm": 90, "key": "C", "scale": "major"})
    db.upsert_entry(_make_entry_payload("fast", duration=120))
    db.upsert_analysis("fast", {"bpm": 140, "key": "C", "scale": "major"})

    res = suggest_playlist(db, target_duration_sec=300, bpm_min=130, bpm_max=150)
    ids = [t["id"] for t in res["tracks"]]
    assert "slow" not in ids
    assert "fast" in ids


def test_upsert_entry_round_trip(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry(_make_entry_payload("e1"))

    fetched = db.get_entry("e1")
    assert fetched is not None
    assert fetched["title"] == "test"
    assert fetched["prompt"] == "ambient track"
    assert fetched["model"] == "small"
    assert fetched["duration_sec"] == 30.0
    assert fetched["favorite"] == 0


def test_upsert_entry_is_idempotent(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry(_make_entry_payload("e1", title="v1"))
    db.upsert_entry(_make_entry_payload("e1", title="v2"))
    assert db.count_entries() == 1
    fetched = db.get_entry("e1")
    assert fetched is not None
    assert fetched["title"] == "v2"


def test_tag_index_populates_on_upsert(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry(_make_entry_payload("e1", tags=["ambient", "loop"]))
    db.upsert_entry(_make_entry_payload("e2", tags=["loop", "test"]))

    ambient = db.list_entries_filtered(tag="ambient")
    loop = db.list_entries_filtered(tag="loop")
    test_tag = db.list_entries_filtered(tag="test")
    assert [r["id"] for r in ambient] == ["e1"]
    assert {r["id"] for r in loop} == {"e1", "e2"}
    assert [r["id"] for r in test_tag] == ["e2"]


def test_tag_index_is_replaced_on_upsert(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry(_make_entry_payload("e1", tags=["a", "b"]))
    db.upsert_entry(_make_entry_payload("e1", tags=["c"]))

    a = db.list_entries_filtered(tag="a")
    c = db.list_entries_filtered(tag="c")
    assert a == []
    assert [r["id"] for r in c] == ["e1"]


def test_relations_unique_constraint(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry(_make_entry_payload("parent"))
    db.upsert_entry(_make_entry_payload("child"))
    db.add_relation("parent", "child", "chimera_source_of")
    db.add_relation("parent", "child", "chimera_source_of")  # duplicate
    db.add_relation("parent", "child", "derived_from")  # different kind = new row

    edges_from = db.list_relations(from_id="parent")
    assert len(edges_from) == 2
    kinds = {e["kind"] for e in edges_from}
    assert kinds == {"chimera_source_of", "derived_from"}


def test_delete_entry_cascades_tags_and_relations(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry(_make_entry_payload("e1", tags=["x"]))
    db.upsert_entry(_make_entry_payload("e2"))
    db.add_relation("e1", "e2", "derived_from")
    assert db.list_relations(from_id="e1") != []

    db.delete_entry("e1")
    assert db.get_entry("e1") is None
    assert db.list_entries_filtered(tag="x") == []
    # The relation row referencing the deleted entry-from is gone (cascade).
    assert db.list_relations(from_id="e1") == []


def test_analysis_upsert_round_trip(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry(_make_entry_payload("e1"))

    db.upsert_analysis(
        "e1",
        {
            "bpm": 128.0,
            "beats": [0.5, 1.0, 1.5],
            "key": "C",
            "scale": "major",
            "key_confidence": 0.92,
            "pitch_mean_hz": 220.0,
            "loudness_lufs": -14.5,
            "bars_estimated": 32.0,
            "embedded_tags": {"prompt": "from id3"},
        },
    )
    analysis = db.get_analysis("e1")
    assert analysis is not None
    assert analysis["bpm"] == 128.0
    assert analysis["key"] == "C"
    assert json.loads(analysis["beats_json"]) == [0.5, 1.0, 1.5]
    assert json.loads(analysis["embedded_tags_json"]) == {"prompt": "from id3"}


def test_stems_and_midis(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry(_make_entry_payload("track"))

    db.add_stem(
        stem_id="track_vocals",
        entry_id="track",
        stem_name="vocals",
        audio_path="track/stems/vocals.wav",
        file_size_bytes=2048,
        model="demucs",
        model_variant="htdemucs_ft",
    )
    db.add_stem(
        stem_id="track_drums",
        entry_id="track",
        stem_name="drums",
        audio_path="track/stems/drums.wav",
        model="demucs",
    )
    stems = db.list_stems("track")
    assert [s["stem_name"] for s in stems] == ["drums", "vocals"]

    db.add_midi(
        midi_id="track_full_mid",
        entry_id="track",
        source="full",
        midi_path="track/midi/full.mid",
        engine="basic-pitch",
        notes_count=12,
    )
    db.add_midi(
        midi_id="track_vocals_mid",
        entry_id="track",
        source="stem",
        source_ref="track_vocals",
        midi_path="track/midi/vocals.mid",
        engine="basic-pitch",
    )
    midis = db.list_midis("track")
    assert {m["source"] for m in midis} == {"full", "stem"}


def test_notation_artifacts_round_trip(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry(_make_entry_payload("track"))

    db.add_notation_artifact(
        artifact_id="track_score_xml",
        entry_id="track",
        kind="musicxml",
        path="track/notation/score.musicxml",
        source_ref="track_full_mid",
        engine="music21",
        engine_version="10.3.0",
        metadata={"source_midi": "track/midi/full.mid"},
    )

    artifacts = db.list_notation_artifacts("track")
    assert len(artifacts) == 1
    assert artifacts[0]["kind"] == "musicxml"
    assert (
        json.loads(artifacts[0]["metadata_json"])["source_midi"]
        == "track/midi/full.mid"
    )

    fetched = db.get_notation_artifact("track_score_xml")
    assert fetched is not None
    assert fetched["path"].endswith("score.musicxml")


def _seed_fs_entry(root: Path, entry_id: str) -> None:
    item_dir = root / entry_id
    item_dir.mkdir(parents=True, exist_ok=True)
    (item_dir / "output.wav").write_bytes(b"RIFF\x00\x00\x00\x00WAVE")
    meta = {
        "id": entry_id,
        "filename": "output.wav",
        "mime_type": "audio/wav",
        "title": f"seed-{entry_id}",
        "prompt": "p",
        "duration": 5.0,
        "steps": 8,
        "cfg": 1.0,
        "seed": 1,
        "favorite": False,
        "rating": None,
        "tags": ["seeded"],
        "notes": "",
        "source": "generate",
        "saved_at": 1234567890.0,
    }
    (item_dir / "metadata.json").write_text(json.dumps(meta), encoding="utf-8")


def test_librarystore_auto_reindexes_on_init(tmp_path: Path):
    _seed_fs_entry(tmp_path, "alpha")
    _seed_fs_entry(tmp_path, "beta")
    store = LibraryStore(tmp_path)
    assert store.db is not None
    assert store.db.count_entries() == 2
    ids = {r["id"] for r in store.db.list_entries()}
    assert ids == {"alpha", "beta"}


def test_librarystore_import_blob_writes_to_db(tmp_path: Path):
    store = LibraryStore(tmp_path)
    record = store.import_blob(
        audio_bytes=b"RIFF\x00\x00\x00\x00WAVEdata",
        filename="upload.wav",
        mime_type="audio/wav",
        metadata={"title": "Live", "tags": ["fresh"]},
    )
    assert store.db is not None
    fetched = store.db.get_entry(record.id)
    assert fetched is not None
    assert fetched["title"] == "Live"
    assert {r["id"] for r in store.db.list_entries_filtered(tag="fresh")} == {record.id}


def test_librarystore_chimera_sources_become_lineage_edges(tmp_path: Path):
    store = LibraryStore(tmp_path)
    record = store.import_blob(
        audio_bytes=b"RIFF\x00\x00\x00\x00WAVE",
        filename="mash.wav",
        mime_type="audio/wav",
        metadata={"title": "Chimera", "chimera_sources": ["A.wav", "B.wav"]},
    )
    assert store.db is not None
    edges = store.db.list_relations(to_id=record.id, kind="chimera_source_of")
    sources = {e["from_id"] for e in edges}
    assert sources == {"A.wav", "B.wav"}


def test_librarystore_delete_propagates_to_db(tmp_path: Path):
    store = LibraryStore(tmp_path)
    record = store.import_blob(
        audio_bytes=b"RIFF\x00\x00\x00\x00WAVE",
        filename="x.wav",
        mime_type="audio/wav",
        metadata={"title": "X"},
    )
    assert store.db is not None
    assert store.db.get_entry(record.id) is not None

    store.delete_entry(record.id)
    assert store.db.get_entry(record.id) is None


def test_librarystore_db_disabled(tmp_path: Path):
    store = LibraryStore(tmp_path, db_path=False)
    assert store.db is None
    # Existing filesystem operations still work without the DB.
    record = store.import_blob(
        audio_bytes=b"RIFF\x00\x00\x00\x00WAVE",
        filename="x.wav",
        mime_type="audio/wav",
        metadata={"title": "X"},
    )
    assert record.title == "X"


@pytest.mark.parametrize("entry_id", ["alpha", "beta_with_underscore"])
def test_reindex_is_idempotent(tmp_path: Path, entry_id: str):
    _seed_fs_entry(tmp_path, entry_id)
    store = LibraryStore(tmp_path)
    assert store.db is not None
    first_count = store.reindex()
    second_count = store.reindex()
    assert first_count == 1
    assert second_count == 1
    assert store.db.count_entries() == 1
