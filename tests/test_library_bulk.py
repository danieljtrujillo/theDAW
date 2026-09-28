"""Bulk library writes: batched upserts, a resumable folder import, and the
background job that drives it.

Importing ~200,000 songs through ``register_reference`` meant 200,000 committed
transactions (each one bumping ``library_revision``), 200,000 tag reads for
cover art, 200,000 queued analysis jobs, and one HTTP request held open for all
of it. These tests pin the batched replacement: one transaction per batch, no
per-file cover extraction, no enqueued jobs, a job you can poll and cancel, and
a re-run that skips what is already registered.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.lib import known_paths
from backend.modules.library import router as library_router_module
from backend.modules.library import store as store_mod
from backend.modules.library.db import EntryFilters, LibraryDB
from backend.modules.library.store import LibraryStore


def _payload(entry_id: str, **overrides) -> dict:
    payload: dict = {
        "id": entry_id,
        "kind": "audio",
        "title": entry_id,
        "prompt": "",
        "notes": "",
        "source": "folder",
        "duration": 1.0,
        "audio_filename": "output.wav",
        "timestamp": "2026-09-18T00:00:00Z",
        "metadata_json": {},
    }
    payload.update(overrides)
    return payload


def _make_folder(root: Path, n: int, *, prefix: str = "track") -> Path:
    folder = root / "music"
    folder.mkdir(parents=True, exist_ok=True)
    for i in range(n):
        (folder / f"{prefix}{i:03d}.mp3").write_bytes(b"ID3\x04\x00\x00" + bytes(64))
    return folder


# ---------------------------------------------------------------------------
# db.upsert_entries_bulk
# ---------------------------------------------------------------------------


def test_bulk_upsert_writes_every_row(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    written = db.upsert_entries_bulk(
        [_payload(f"b{i}") for i in range(2500)], batch=1000
    )
    assert written == 2500
    assert db.count_entries() == 2500
    row = db.get_entry("b7")
    assert row["title"] == "b7"
    assert row["source"] == "folder"


def test_bulk_upsert_bumps_the_revision_once_per_batch(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    before = db.library_revision()
    db.upsert_entries_bulk([_payload(f"b{i}") for i in range(5)], batch=2)
    # 5 records at batch=2 → 3 transactions → 3 bumps, not 5.
    assert db.library_revision() == before + 3

    before = db.library_revision()
    db.upsert_entries_bulk([], batch=2)
    assert db.library_revision() == before, "an empty write opens no transaction"


def test_bulk_upsert_matches_the_single_upsert_row(tmp_path: Path):
    single = LibraryDB(tmp_path / "single.db")
    bulk = LibraryDB(tmp_path / "bulk.db")
    payload = _payload(
        "same",
        title="Same Row",
        prompt="a prompt",
        negative_prompt="no vocals",
        model="medium",
        duration=42.5,
        steps=8,
        cfg=1.5,
        seed=99,
        mime_type="audio/flac",
        file_size_bytes=1234,
        favorite=True,
        rating="like",
        notes="a note",
        tags=["one", "two"],
        metadata_json={"lyrics": "words", "source_path": "D:/x.flac"},
    )
    single.upsert_entry(dict(payload))
    bulk.upsert_entries_bulk([dict(payload)])

    a = single.get_entry("same")
    b = bulk.get_entry("same")
    volatile = {"created_at", "updated_at"}
    assert {k: v for k, v in a.items() if k not in volatile} == {
        k: v for k, v in b.items() if k not in volatile
    }
    assert [dict(r) for r in _tags(single)] == [dict(r) for r in _tags(bulk)]
    assert _prompts(single) == _prompts(bulk)


def _tags(db: LibraryDB):
    return db._conn.execute(
        "SELECT entry_id, tag FROM tag_index ORDER BY tag"
    ).fetchall()


def _prompts(db: LibraryDB) -> list[tuple]:
    return [
        tuple(r)
        for r in db._conn.execute(
            "SELECT entry_id, prompt_kind, prompt_text FROM prompt_corpus ORDER BY prompt_kind"
        ).fetchall()
    ]


def test_bulk_upsert_keeps_created_at_and_refreshes_the_rest(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entries_bulk([_payload("x", title="First", tags=["old"])])
    created_at = db.get_entry("x")["created_at"]

    db.upsert_entries_bulk([_payload("x", title="Second", tags=["new"])])
    row = db.get_entry("x")
    assert row["created_at"] == created_at
    assert row["title"] == "Second"
    assert [r["tag"] for r in _tags(db)] == ["new"]
    assert db.count_entries() == 1


def test_bulk_upsert_keeps_the_search_index_in_step(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    if not db.fts_enabled:
        pytest.skip("build has no FTS5")
    db.upsert_entries_bulk([_payload(f"s{i}", title=f"Sunrise {i}") for i in range(20)])
    assert len(db.list_entries_page(EntryFilters(q="sunrise"), limit=50)) == 20

    db.upsert_entries_bulk([_payload("s3", title="Moonset three")])
    assert len(db.list_entries_page(EntryFilters(q="sunrise"), limit=50)) == 19
    assert [
        r["id"] for r in db.list_entries_page(EntryFilters(q="moonset"), limit=50)
    ] == ["s3"]


def test_registered_source_paths_reports_what_is_already_in(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entries_bulk(
        [
            _payload("a", metadata_json={"source_path": "D:/music/a.mp3"}),
            _payload("b", metadata_json={"source_path": "D:/music/b.mp3"}),
            _payload("c", metadata_json={}),
        ]
    )
    assert db.registered_source_paths() == {"D:/music/a.mp3", "D:/music/b.mp3"}


def test_registered_source_paths_survives_a_broken_metadata_blob(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entries_bulk([_payload("a", metadata_json={"source_path": "D:/a.mp3"})])
    db._conn.execute("UPDATE entries SET metadata_json = 'not json' WHERE id = 'a'")
    db._conn.commit()
    assert db.registered_source_paths() == set()


def test_bulk_relations(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entries_bulk([_payload("child")])
    before = db.library_revision()
    added = db.add_relations_bulk(
        [("srcA", "child", "chimera_source_of"), ("srcB", "child", "chimera_source_of")]
    )
    assert added == 2
    assert db.library_revision() == before + 1
    assert len(db.list_relations(to_id="child")) == 2
    # Idempotent: the UNIQUE(from,to,kind) row is not duplicated.
    db.add_relations_bulk([("srcA", "child", "chimera_source_of")])
    assert len(db.list_relations(to_id="child")) == 2
    assert db.add_relations_bulk([]) == 0


# ---------------------------------------------------------------------------
# store.register_references_bulk
# ---------------------------------------------------------------------------


@pytest.fixture
def store(tmp_path: Path) -> LibraryStore:
    return LibraryStore(tmp_path / "library")


def test_bulk_reference_registers_every_file_without_copying_it(
    store: LibraryStore, tmp_path: Path
):
    folder = _make_folder(tmp_path, 6)
    files = sorted(str(p) for p in folder.glob("*.mp3"))
    result = store.register_references_bulk(files)

    assert len(result.created) == 6
    assert result.skipped == 0 and result.failed == 0
    assert store.db.count_entries() == 6
    record = result.created[0]
    entry_dir = store.root / record.id
    meta = json.loads((entry_dir / "metadata.json").read_text(encoding="utf-8"))
    assert meta["source_path"] == str(Path(files[0]).resolve())
    assert meta["source"] == "folder"
    # Reference-in-place: the audio is NOT copied into the library.
    assert not (entry_dir / Path(files[0]).name).exists()
    assert store.get_entry(record.id) is not None


def test_bulk_reference_defers_jobs_and_skips_cover_extraction(
    store: LibraryStore, tmp_path: Path, monkeypatch
):
    folder = _make_folder(tmp_path, 4)
    enqueued: list[str] = []
    covers: list[Path] = []
    monkeypatch.setattr(
        store_mod,
        "_maybe_enqueue_analysis",
        lambda s, entry_id, **kw: enqueued.append(entry_id),
    )
    monkeypatch.setattr(
        store_mod,
        "extract_cover_for",
        lambda entry_dir, src: covers.append(src) or False,
    )
    store.register_references_bulk(sorted(str(p) for p in folder.glob("*.mp3")))
    assert enqueued == []
    assert covers == []


def test_bulk_reference_is_resumable(store: LibraryStore, tmp_path: Path):
    folder = _make_folder(tmp_path, 5)
    files = sorted(str(p) for p in folder.glob("*.mp3"))
    first = store.register_references_bulk(files)
    assert len(first.created) == 5

    second = store.register_references_bulk(files)
    assert second.created == []
    assert second.skipped == 5
    assert store.db.count_entries() == 5

    # A file added afterwards is picked up; the rest stay skipped.
    (folder / "late.mp3").write_bytes(b"ID3")
    third = store.register_references_bulk(sorted(str(p) for p in folder.glob("*.mp3")))
    assert len(third.created) == 1
    assert third.skipped == 5


def test_bulk_reference_records_failures_and_caps_the_error_list(
    store: LibraryStore, tmp_path: Path
):
    missing = [str(tmp_path / "gone" / f"{i}.mp3") for i in range(60)]
    result = store.register_references_bulk(missing)
    assert result.created == []
    assert result.failed == 60
    assert len(result.errors) == 50
    assert "0.mp3" in result.errors[0]


def test_bulk_reference_opens_one_transaction_per_batch(
    store: LibraryStore, tmp_path: Path
):
    folder = _make_folder(tmp_path, 10)
    before = store.db.library_revision()
    store.register_references_bulk(
        sorted(str(p) for p in folder.glob("*.mp3")), batch=4
    )
    # 10 files at batch=4 → 3 transactions, not 10.
    assert store.db.library_revision() == before + 3


# ---------------------------------------------------------------------------
# The async import job
# ---------------------------------------------------------------------------


def test_import_job_runs_to_completion_and_reports_progress(
    store: LibraryStore, tmp_path: Path
):
    folder = _make_folder(tmp_path, 8)
    job = store_mod.get_import_jobs().create(folder=str(folder), recursive=True)
    assert job.snapshot()["status"] == "queued"

    store.run_import_job(job)
    snap = job.snapshot()
    assert snap["status"] == "done"
    assert snap["seen"] == 8
    assert snap["created"] == 8
    assert snap["skipped"] == 0
    assert snap["failed"] == 0
    assert snap["errors"] == []
    assert snap["started_at"] is not None and snap["finished_at"] is not None
    assert set(snap) == {
        "job_id",
        "status",
        "folder",
        "seen",
        "created",
        "skipped",
        "failed",
        "errors",
        "started_at",
        "finished_at",
    }


def test_import_job_rerun_skips_what_is_already_registered(
    store: LibraryStore, tmp_path: Path
):
    folder = _make_folder(tmp_path, 5)
    jobs = store_mod.get_import_jobs()
    store.run_import_job(jobs.create(folder=str(folder), recursive=True))
    second = jobs.create(folder=str(folder), recursive=True)
    store.run_import_job(second)
    assert second.snapshot()["created"] == 0
    assert second.snapshot()["skipped"] == 5
    assert store.db.count_entries() == 5


def test_import_job_cancels_between_batches(
    store: LibraryStore, tmp_path: Path, monkeypatch
):
    folder = _make_folder(tmp_path, 25)
    job = store_mod.get_import_jobs().create(folder=str(folder), recursive=True)

    real = LibraryStore.register_references_bulk

    def cancel_after_first(self, paths, **kwargs):
        result = real(self, paths, **kwargs)
        job.cancel()
        return result

    monkeypatch.setattr(LibraryStore, "register_references_bulk", cancel_after_first)
    store.run_import_job(job, batch=10)

    snap = job.snapshot()
    assert snap["status"] == "cancelled"
    # The batch in flight finished; the rest never started.
    assert snap["created"] == 10
    assert store.db.count_entries() == 10


def test_import_job_cancelled_before_it_starts_does_nothing(
    store: LibraryStore, tmp_path: Path
):
    folder = _make_folder(tmp_path, 4)
    job = store_mod.get_import_jobs().create(folder=str(folder), recursive=True)
    job.cancel()
    store.run_import_job(job)
    assert job.snapshot()["status"] == "cancelled"
    assert job.snapshot()["created"] == 0
    assert store.db.count_entries() == 0


def test_import_job_reports_a_bad_folder_as_failed(store: LibraryStore, tmp_path: Path):
    job = store_mod.get_import_jobs().create(
        folder=str(tmp_path / "nope"), recursive=True
    )
    store.run_import_job(job)
    snap = job.snapshot()
    assert snap["status"] == "failed"
    assert snap["errors"]


# ---------------------------------------------------------------------------
# reindex
# ---------------------------------------------------------------------------


def test_reindex_reads_each_metadata_file_once(tmp_path: Path, monkeypatch):
    from tests.test_library_store import _seed_generate_entry

    root = tmp_path / "library"
    root.mkdir()
    for i in range(6):
        _seed_generate_entry(root, f"job{i}", 0)
    store = LibraryStore(root)  # the constructor's auto-reindex runs here

    # Count the reads that actually parsed a file; probing a directory that
    # holds no metadata.json costs a stat, not a read.
    reads: list[Path] = []
    real_read = store_mod._read_metadata

    def counting(entry_dir: Path):
        meta = real_read(entry_dir)
        if meta is not None:
            reads.append(entry_dir)
        return meta

    monkeypatch.setattr(store_mod, "_read_metadata", counting)
    assert store.reindex() == 6
    # It used to walk with list_entries and then re-read every file: 12.
    assert len(reads) == 6, f"one read per entry, got {len(reads)}"
    assert store.db.count_entries() == 6


def test_reindex_is_still_idempotent(tmp_path: Path):
    from tests.test_library_store import _seed_generate_entry

    root = tmp_path / "library"
    root.mkdir()
    _seed_generate_entry(root, "jobA", 0, extra_meta={"chimera_sources": ["src.wav"]})
    store = LibraryStore(root)
    assert store.reindex() == 1
    assert store.reindex() == 1
    assert store.db.count_entries() == 1
    assert len(store.db.list_relations(to_id="jobA_00")) == 1


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------


@pytest.fixture
def client_with_root(tmp_path: Path, monkeypatch) -> TestClient:
    monkeypatch.setattr(library_router_module, "_store", None)
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(tmp_path / "library"))
    # /import-folder records the folder as the next picker's start
    # (known_paths.record). Left at its default, that wrote the test's tmp
    # folders into data/known_paths.json of the checkout running the suite.
    monkeypatch.setattr(known_paths, "_STORE_PATH", tmp_path / "known_paths.json")
    monkeypatch.setattr(known_paths, "_GRANTS", {})
    app = FastAPI()
    app.include_router(library_router_module.router, prefix="/api/library")
    return TestClient(app)


def test_async_import_returns_a_job_handle_immediately(client_with_root, tmp_path):
    folder = _make_folder(tmp_path, 3)
    r = client_with_root.post(
        "/api/library/import-folder?async=1", json={"path": str(folder)}
    )
    assert r.status_code == 200
    body = r.json()
    job_id = body["job_id"]
    assert body["status_url"] == f"/api/library/import-jobs/{job_id}"

    status = client_with_root.get(body["status_url"]).json()
    assert status["job_id"] == job_id
    assert status["status"] in {"queued", "running", "done"}

    # Drive the job the way the background consumer would, then re-read.
    store = library_router_module.get_store()
    store.run_import_job(store_mod.get_import_jobs().get(job_id))
    done = client_with_root.get(body["status_url"]).json()
    assert done["status"] == "done"
    assert done["created"] == 3


def test_import_job_status_404s_for_an_unknown_id(client_with_root):
    assert client_with_root.get("/api/library/import-jobs/nope").status_code == 404
    assert client_with_root.delete("/api/library/import-jobs/nope").status_code == 404


def test_deleting_an_import_job_cancels_it(client_with_root, tmp_path):
    folder = _make_folder(tmp_path, 3)
    body = client_with_root.post(
        "/api/library/import-folder?async=1", json={"path": str(folder)}
    ).json()
    r = client_with_root.delete(body["status_url"])
    assert r.status_code == 200
    assert r.json()["status"] == "cancelled"
    assert client_with_root.get(body["status_url"]).json()["status"] == "cancelled"


def test_async_import_still_validates_the_folder_up_front(client_with_root, tmp_path):
    r = client_with_root.post(
        "/api/library/import-folder?async=1", json={"path": str(tmp_path / "nope")}
    )
    assert r.status_code == 400


def test_sync_import_truncates_its_entry_list(client_with_root, tmp_path, monkeypatch):
    folder = _make_folder(tmp_path, 5)
    monkeypatch.setattr(library_router_module, "MAX_SYNC_IMPORT_ENTRIES", 2)
    body = client_with_root.post(
        "/api/library/import-folder", json={"path": str(folder)}
    ).json()
    assert body["created_total"] == 5
    assert len(body["entries"]) == 2
    assert body["cancelled"] is False
    assert body["name"] == folder.name
