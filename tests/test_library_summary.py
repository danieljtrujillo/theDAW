"""The library category summary: ``db.library_counts()`` + ``GET /api/library/summary``.

The tab strip needs every category's count at boot, not only after the user
visits a sub-tab, and it needs to know when its snapshot went stale. The
counts come from one consistent read; ``revision`` rises once per committed
mutating transaction (deletes included) so a client can tell a fresh answer
from an old one.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.modules.library import router as library_router_module
from backend.modules.library.db import LibraryDB
from tests.test_library_store import _seed_generate_entry

_CATEGORIES = ("tracks", "stems", "midi", "video", "score")


def _entry_payload(entry_id: str, kind: str = "audio") -> dict:
    return {
        "id": entry_id,
        "kind": kind,
        "title": entry_id,
        "audio_filename": "output.wav",
        "timestamp": "2026-09-18T00:00:00Z",
    }


def _insert_orphan(db: LibraryDB, sql: str, params: tuple) -> None:
    """Insert a child row whose parent entry does not exist.

    Foreign keys are ON with ON DELETE CASCADE, so a live DB cannot normally
    produce one; legacy rows and restored-from-backup DBs can. The counts must
    not include them, which is only testable if we can make one.
    """
    db._conn.execute("PRAGMA foreign_keys = OFF")
    try:
        db._conn.execute(sql, params)
        db._conn.commit()
    finally:
        db._conn.execute("PRAGMA foreign_keys = ON")


@pytest.fixture
def client_with_root(tmp_path: Path, monkeypatch) -> TestClient:
    monkeypatch.setattr(library_router_module, "_store", None)
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(tmp_path))

    app = FastAPI()
    app.include_router(library_router_module.router, prefix="/api/library")
    return TestClient(app)


def test_counts_are_real_zeros_on_an_empty_library(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    snapshot = db.library_counts()
    assert snapshot["counts"] == {key: 0 for key in _CATEGORIES}
    assert isinstance(snapshot["revision"], int)
    assert snapshot["revision"] >= 0


def test_every_category_is_counted(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry(_entry_payload("track-a"))
    db.upsert_entry(_entry_payload("track-b"))
    db.upsert_entry(_entry_payload("clip", kind="video"))
    db.upsert_entry(_entry_payload("still", kind="image"))
    db.add_stem(
        stem_id="s1", entry_id="track-a", stem_name="drums", audio_path="drums.wav"
    )
    db.add_stem(
        stem_id="s2", entry_id="track-a", stem_name="bass", audio_path="bass.wav"
    )
    db.add_midi(midi_id="m1", entry_id="track-b", source="full", midi_path="out.mid")
    db.add_notation_artifact(
        artifact_id="n1", entry_id="track-b", kind="sheet", path="sheet.pdf"
    )
    # Raw MIDI artifacts belong to the MIDI tab, never the score tab.
    db.add_notation_artifact(
        artifact_id="n2", entry_id="track-b", kind="midi", path="raw.mid"
    )

    assert db.library_counts()["counts"] == {
        "tracks": 2,
        "stems": 2,
        "midi": 1,
        "video": 2,
        "score": 1,
    }


def test_delete_lowers_the_count_and_raises_the_revision(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry(_entry_payload("track-a"))
    db.add_stem(
        stem_id="s1", entry_id="track-a", stem_name="drums", audio_path="drums.wav"
    )
    before = db.library_counts()
    assert before["counts"]["stems"] == 1

    assert db.delete_stem("s1") is True
    after = db.library_counts()
    assert after["counts"]["stems"] == 0
    assert after["revision"] > before["revision"]

    # Deleting the parent takes its remaining children (and the track) with it.
    db.add_midi(midi_id="m1", entry_id="track-a", source="full", midi_path="out.mid")
    mid = db.library_counts()
    assert mid["counts"] == {"tracks": 1, "stems": 0, "midi": 1, "video": 0, "score": 0}

    assert db.delete_entry("track-a") is True
    end = db.library_counts()
    assert end["counts"] == {key: 0 for key in _CATEGORIES}
    assert end["revision"] > mid["revision"]


def test_revision_is_strictly_monotonic_across_committed_mutations(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    seen = [db.library_counts()["revision"]]
    db.upsert_entry(_entry_payload("track-a"))
    seen.append(db.library_counts()["revision"])
    db.add_stem(
        stem_id="s1", entry_id="track-a", stem_name="drums", audio_path="drums.wav"
    )
    seen.append(db.library_counts()["revision"])
    db.set_stem_favorite("s1", True)
    seen.append(db.library_counts()["revision"])
    db.delete_stem("s1")
    seen.append(db.library_counts()["revision"])

    assert all(b > a for a, b in zip(seen, seen[1:])), seen
    # A read never bumps it.
    assert db.library_counts()["revision"] == seen[-1]


def test_a_rolled_back_transaction_does_not_raise_the_revision(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    before = db.library_counts()["revision"]
    with pytest.raises(RuntimeError):
        with db._txn() as cur:
            cur.execute("DELETE FROM entries")
            raise RuntimeError("boom")
    assert db.library_counts()["revision"] == before


def test_orphaned_children_are_not_counted(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry(_entry_payload("track-a"))
    db.add_stem(
        stem_id="s1", entry_id="track-a", stem_name="drums", audio_path="drums.wav"
    )
    _insert_orphan(
        db,
        "INSERT INTO stems (id, entry_id, stem_name, audio_path) VALUES (?, ?, ?, ?)",
        ("ghost-stem", "gone", "vocals", "vocals.wav"),
    )
    _insert_orphan(
        db,
        "INSERT INTO midis (id, entry_id, source, midi_path) VALUES (?, ?, ?, ?)",
        ("ghost-midi", "gone", "full", "ghost.mid"),
    )
    _insert_orphan(
        db,
        "INSERT INTO notation_artifacts (id, entry_id, kind, path, created_at)"
        " VALUES (?, ?, ?, ?, ?)",
        ("ghost-score", "gone", "sheet", "ghost.pdf", 0.0),
    )

    assert db.library_counts()["counts"] == {
        "tracks": 1,
        "stems": 1,
        "midi": 0,
        "video": 0,
        "score": 0,
    }


def test_summary_endpoint_is_reachable(client_with_root, tmp_path):
    _seed_generate_entry(tmp_path, "job_summary", 0)

    r = client_with_root.get("/api/library/summary")
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"revision", "counts"}
    assert set(body["counts"]) == set(_CATEGORIES)
    assert body["counts"]["tracks"] == 1
    assert all(isinstance(v, int) and v >= 0 for v in body["counts"].values())
    assert isinstance(body["revision"], int)


def test_summary_endpoint_503_without_a_db(client_with_root):
    library_router_module.get_store().db = None
    r = client_with_root.get("/api/library/summary")
    assert r.status_code == 503
