"""Batch-12 T04 fixes for the library store/DB.

LIB-001: upsert_entry / upsert_entries_bulk must never reset
analysis_status / stems_status / midi_status -- those are owned by the
analysis, stems, and midi engines via their own dedicated UPDATE statements.
LIB-002: reindex() must enqueue analysis for new/changed entries.
LIB-004: the unpaged list-enrichment paths (analysis, play counts) must not
read every column / the whole entries table just to attach a few fields.
SCORE-001 support: the DETAILS identity form's field names
(notation_artist, notation_title) must be accepted by USER_MUTABLE_FIELDS.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.modules.library import router as library_router_module
from backend.modules.library import store as store_mod
from backend.modules.library.db import LibraryDB
from backend.modules.library.store import USER_MUTABLE_FIELDS, LibraryStore


@pytest.fixture(autouse=True)
def _no_real_analysis_enqueue(monkeypatch):
    """Every test in this module gets a no-op ``_maybe_enqueue_analysis`` by
    default, so constructing a ``LibraryStore`` / calling ``reindex()`` never
    touches the real settings file or the real background queue. Tests that
    need to observe enqueue calls re-patch it themselves with a counting
    lambda -- monkeypatch layers cleanly, the later patch simply wins for
    that test."""
    monkeypatch.setattr(store_mod, "_maybe_enqueue_analysis", lambda *a, **kw: None)


def _payload(entry_id: str, **overrides) -> dict:
    payload = {
        "id": entry_id,
        "kind": "audio",
        "title": "test",
        "prompt": "ambient track",
        "negative_prompt": "",
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
        "tags": [],
        "metadata_json": {},
    }
    payload.update(overrides)
    return payload


# ---- LIB-001: upsert must preserve analysis/stems/midi status -------------


def test_upsert_entry_preserves_analysis_status_set_by_the_analysis_engine(
    tmp_path: Path,
):
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry(_payload("e1"))
    assert db.get_entry("e1")["analysis_status"] == "pending"

    # The analysis engine marks progress with its own dedicated UPDATE
    # (backend/modules/analysis/engine.py:270), never through upsert_entry.
    db._conn.execute(
        "UPDATE entries SET analysis_status = ? WHERE id = ?", ("done", "e1")
    )
    db._conn.commit()

    # A routine metadata-only re-save (title/tag edit, reindex) must not
    # wipe that status back to 'pending'.
    db.upsert_entry(_payload("e1", title="renamed"))
    row = db.get_entry("e1")
    assert row["title"] == "renamed"
    assert row["analysis_status"] == "done"


def test_upsert_entry_preserves_stems_and_midi_status(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry(_payload("e1"))
    db._conn.execute(
        "UPDATE entries SET stems_status = ?, midi_status = ? WHERE id = ?",
        ("done", "failed", "e1"),
    )
    db._conn.commit()

    db.upsert_entry(_payload("e1", notes="edited"))
    row = db.get_entry("e1")
    assert row["stems_status"] == "done"
    assert row["midi_status"] == "failed"


def test_upsert_entries_bulk_preserves_analysis_status(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entries_bulk([_payload("e1"), _payload("e2")])
    db._conn.execute(
        "UPDATE entries SET analysis_status = ? WHERE id = ?", ("done", "e1")
    )
    db._conn.commit()

    db.upsert_entries_bulk([_payload("e1", title="renamed"), _payload("e2")])
    assert db.get_entry("e1")["analysis_status"] == "done"
    assert db.get_entry("e1")["title"] == "renamed"


def test_new_entry_still_defaults_analysis_status_to_pending(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry(_payload("brand-new"))
    row = db.get_entry("brand-new")
    assert row["analysis_status"] == "pending"
    assert row["stems_status"] == "pending"
    assert row["midi_status"] == "pending"


# ---- LIB-002: reindex enqueues analysis for new/changed entries -----------


def _seed_entry(
    root: Path, entry_id: str, *, audio_bytes: bytes = b"RIFF" + b"\x00" * 20
) -> Path:
    entry_dir = root / entry_id
    entry_dir.mkdir(parents=True, exist_ok=True)
    (entry_dir / "output.wav").write_bytes(audio_bytes)
    meta = {
        "id": entry_id,
        "filename": "output.wav",
        "audio_filename": "output.wav",
        "mime_type": "audio/wav",
        "title": entry_id,
        "prompt": "",
        "duration": 10.0,
        "model": "small",
        "steps": 8,
        "cfg": 1.0,
        "seed": 1,
        "favorite": False,
        "rating": None,
        "tags": [],
        "notes": "",
        "source": "import",
        "saved_at": 1.0,
        "timestamp": "2026-05-25T00:00:00Z",
    }
    (entry_dir / "metadata.json").write_text(json.dumps(meta), encoding="utf-8")
    return entry_dir


def test_reindex_enqueues_analysis_for_new_entries(tmp_path: Path, monkeypatch):
    root = tmp_path / "library"
    store = LibraryStore(root)  # empty root: auto-reindex on init is a no-op
    _seed_entry(root, "new1")

    enqueued: list[str] = []
    monkeypatch.setattr(
        store_mod,
        "_maybe_enqueue_analysis",
        lambda s, entry_id, **kw: enqueued.append(entry_id) or True,
    )

    count = store.reindex(enqueue_analysis=True)
    assert count == 1
    assert enqueued == ["new1"]


def test_reindex_does_not_reenqueue_unchanged_entries(tmp_path: Path, monkeypatch):
    root = tmp_path / "library"
    store = LibraryStore(root)
    _seed_entry(root, "stable1")
    store.reindex(enqueue_analysis=True)

    enqueued: list[str] = []
    monkeypatch.setattr(
        store_mod,
        "_maybe_enqueue_analysis",
        lambda s, entry_id, **kw: enqueued.append(entry_id) or True,
    )
    store.reindex(enqueue_analysis=True)
    assert enqueued == []


def test_reindex_reenqueues_changed_entries(tmp_path: Path, monkeypatch):
    root = tmp_path / "library"
    store = LibraryStore(root)
    _seed_entry(root, "changed1", audio_bytes=b"RIFF" + b"\x00" * 20)
    store.reindex(enqueue_analysis=True)

    # Simulate the audio file being re-rendered/replaced with different bytes.
    (root / "changed1" / "output.wav").write_bytes(b"RIFF" + b"\x00" * 400)
    meta_path = root / "changed1" / "metadata.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    meta["duration"] = 99.0
    meta_path.write_text(json.dumps(meta), encoding="utf-8")

    enqueued: list[str] = []
    monkeypatch.setattr(
        store_mod,
        "_maybe_enqueue_analysis",
        lambda s, entry_id, **kw: enqueued.append(entry_id) or True,
    )
    store.reindex(enqueue_analysis=True)
    assert enqueued == ["changed1"]


def test_init_auto_reindex_never_enqueues_analysis(tmp_path: Path, monkeypatch):
    """A lost, deleted, or rebuilt library.db next to a library that already
    has entries on disk must not queue the whole library for analysis the
    next time the app starts -- with no stored rows every entry on disk
    looks "new"."""
    root = tmp_path / "library"
    root.mkdir(parents=True, exist_ok=True)
    _seed_entry(root, "e1")
    _seed_entry(root, "e2")

    enqueued: list[str] = []
    monkeypatch.setattr(
        store_mod,
        "_maybe_enqueue_analysis",
        lambda s, entry_id, **kw: enqueued.append(entry_id) or True,
    )

    # __init__ constructs a fresh library.db (count_entries() == 0) and
    # auto-reindexes -- this must pass enqueue_analysis=False internally.
    store = LibraryStore(root)
    assert store.db.count_entries() == 2
    assert enqueued == []


def test_reindex_enqueue_analysis_false_enqueues_nothing(tmp_path: Path, monkeypatch):
    root = tmp_path / "library"
    store = LibraryStore(root)
    _seed_entry(root, "new1")

    enqueued: list[str] = []
    monkeypatch.setattr(
        store_mod,
        "_maybe_enqueue_analysis",
        lambda s, entry_id, **kw: enqueued.append(entry_id) or True,
    )
    store.reindex(enqueue_analysis=False)
    assert enqueued == []


def test_bare_reindex_over_600_new_entries_enqueues_nothing(
    tmp_path: Path, monkeypatch
):
    """``enqueue_analysis`` defaults to False now -- a bare reindex() must
    never enqueue, regardless of how many entries are new/changed. This is
    the exact scenario that previously queued 600 real jobs."""
    root = tmp_path / "library"
    store = LibraryStore(root)
    for i in range(600):
        _seed_entry(root, f"bare{i}")

    enqueued: list[str] = []
    monkeypatch.setattr(
        store_mod,
        "_maybe_enqueue_analysis",
        lambda s, entry_id, **kw: enqueued.append(entry_id) or True,
    )

    count = store.reindex()  # no enqueue_analysis kwarg -- the bare default
    assert count == 600
    assert enqueued == []


# ---- LIB-004: narrow the unpaged list-enrichment reads ---------------------


def test_get_all_analysis_omits_unused_wide_columns(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry(_payload("e1"))
    db.upsert_analysis(
        "e1",
        {
            "bpm": 120.0,
            "key": "C",
            "beats": [0.1, 0.5, 0.9],
        },
    )
    rows = db.get_all_analysis()
    assert rows["e1"]["bpm"] == 120.0
    assert rows["e1"]["key"] == "C"
    # beats_json / version are never read by the list-enrichment path
    # (backend/modules/library/router.py:_analysis_payload) and must not be
    # pulled into memory for every entry in a 200,000-track library.
    assert "beats_json" not in rows["e1"]
    assert "version" not in rows["e1"]


def test_all_play_counts_matches_play_counts_for(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry(_payload("e1"))
    db.upsert_entry(_payload("e2"))
    db.increment_play_count("e1")
    db.increment_play_count("e1")
    db.increment_play_count("e2")

    all_counts = db.all_play_counts()
    assert all_counts["e1"]["play_count"] == 2
    assert all_counts["e2"]["play_count"] == 1
    assert all_counts == db.play_counts_for(["e1", "e2"])


def test_attach_play_counts_unpaged_uses_narrow_query(tmp_path: Path, monkeypatch):
    root = tmp_path / "library"
    store = LibraryStore(root)
    _seed_entry(root, "e1")
    store.reindex()

    called: dict[str, bool] = {"all_play_counts": False, "list_entries": False}
    real_all = store.db.all_play_counts
    real_list = store.db.list_entries

    def spy_all():
        called["all_play_counts"] = True
        return real_all()

    def spy_list(*a, **kw):
        called["list_entries"] = True
        return real_list(*a, **kw)

    monkeypatch.setattr(store.db, "all_play_counts", spy_all)
    monkeypatch.setattr(store.db, "list_entries", spy_list)

    entries = [{"id": "e1"}]
    library_router_module._attach_play_counts(store, entries)
    assert called["all_play_counts"] is True
    assert called["list_entries"] is False


# ---- SCORE-001 support: notation identity is user-mutable -----------------


def test_notation_identity_fields_are_user_mutable():
    assert "notation_artist" in USER_MUTABLE_FIELDS
    assert "notation_title" in USER_MUTABLE_FIELDS


def test_update_entry_persists_notation_identity(tmp_path: Path):
    root = tmp_path / "library"
    store = LibraryStore(root)
    _seed_entry(root, "e1")
    store.reindex()

    record = store.update_entry(
        "e1", {"notation_artist": "Some Artist", "notation_title": "Some Title"}
    )
    assert record is not None
    meta = json.loads((root / "e1" / "metadata.json").read_text(encoding="utf-8"))
    assert meta["notation_artist"] == "Some Artist"
    assert meta["notation_title"] == "Some Title"


# ---- POST /reindex analyze opt-in + 500-entry cap --------------------------


@pytest.fixture
def client_with_root(tmp_path: Path, monkeypatch) -> TestClient:
    monkeypatch.setattr(library_router_module, "_store", None)
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(tmp_path / "library"))
    app = FastAPI()
    app.include_router(library_router_module.router, prefix="/api/library")
    return TestClient(app)


def test_reindex_endpoint_default_never_enqueues_analysis(
    client_with_root: TestClient, tmp_path: Path, monkeypatch
):
    root = tmp_path / "library"
    _seed_entry(root, "e1")
    _seed_entry(root, "e2")
    _seed_entry(root, "e3")

    enqueued: list[str] = []
    monkeypatch.setattr(
        store_mod,
        "_maybe_enqueue_analysis",
        lambda s, entry_id, **kw: enqueued.append(entry_id) or True,
    )

    resp = client_with_root.post("/api/library/reindex")
    assert resp.status_code == 200
    body = resp.json()
    assert body["reindexed"] == 3
    assert "analysis_skipped" not in body
    assert enqueued == []


def test_reindex_endpoint_analyze_true_enqueues_changed_entries(
    client_with_root: TestClient, tmp_path: Path, monkeypatch
):
    root = tmp_path / "library"
    # First call constructs the store against an empty root (nothing to
    # enqueue either way), matching a real "app already ran once" library.
    assert client_with_root.post("/api/library/reindex").json()["reindexed"] == 0

    _seed_entry(root, "c1")
    _seed_entry(root, "c2")
    _seed_entry(root, "c3")

    enqueued: list[str] = []
    monkeypatch.setattr(
        store_mod,
        "_maybe_enqueue_analysis",
        lambda s, entry_id, **kw: enqueued.append(entry_id) or True,
    )

    resp = client_with_root.post("/api/library/reindex?analyze=true")
    assert resp.status_code == 200
    body = resp.json()
    assert body["reindexed"] == 3
    assert body["analysis_enqueued"] == 3
    assert "analysis_skipped" not in body
    assert set(enqueued) == {"c1", "c2", "c3"}


def test_reindex_endpoint_analyze_true_over_cap_enqueues_none(
    client_with_root: TestClient, tmp_path: Path, monkeypatch
):
    root = tmp_path / "library"
    assert client_with_root.post("/api/library/reindex").json()["reindexed"] == 0

    for i in range(501):
        _seed_entry(root, f"big{i}")

    enqueued: list[str] = []
    monkeypatch.setattr(
        store_mod,
        "_maybe_enqueue_analysis",
        lambda s, entry_id, **kw: enqueued.append(entry_id) or True,
    )

    resp = client_with_root.post("/api/library/reindex?analyze=true")
    assert resp.status_code == 200
    body = resp.json()
    assert body["reindexed"] == 501
    assert body["analysis_skipped"] == 501
    assert body["reason"] == "too many entries to queue at once"
    assert "analysis_enqueued" not in body
    assert enqueued == []
