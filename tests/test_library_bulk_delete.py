"""Bulk delete: "Clear all" / "Clear non-favorites" in one request, safely.

Clearing a 200,000-entry library used to be 200,000 DELETE requests, each one
its own transaction, its own revision bump and its own ``rmtree``. These tests
pin the batched replacement -- and, more importantly, the safety rules that a
loop over single deletes never had to state:

  * a reference-in-place entry (its audio lives wherever the user keeps it)
    loses its library folder and its rows, and NOTHING else. The source media
    is never touched.
  * nothing is removed from disk until the resolved path has been proved to be
    inside the library root.
  * the filter form re-counts on the server and refuses (409, deleting nothing)
    when the count the client confirmed is not the count the server sees.
  * a filter that would match the whole library needs an explicit ``all`` flag.
  * one failure never aborts the rest; it is reported per id.

The last test deletes 50,000 rows out of 200,000 and prints what it cost.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.modules.library import router as library_router_module
from backend.modules.library.db import EntryFilters, LibraryDB
from backend.modules.library.store import LibraryStore
from tests.test_library_search_parity import (
    _assert_search_index_intact as check_search_index,
)

#: The ticket's budget for 50,000 ids.
DELETE_BUDGET_S = 30.0
PERF_ROWS = 200_000
PERF_DELETE = 50_000


def _payload(entry_id: str, **overrides) -> dict:
    payload: dict = {
        "id": entry_id,
        "kind": "audio",
        "title": entry_id,
        "prompt": "",
        "notes": "",
        "model": "small",
        "source": "generate",
        "favorite": False,
        "duration": 1.0,
        "audio_filename": "output.wav",
        "timestamp": "2026-09-18T00:00:00Z",
        "metadata_json": {},
    }
    payload.update(overrides)
    return payload


def _managed_entry(store: LibraryStore, entry_id: str, **meta) -> Path:
    """An entry whose audio lives INSIDE the library, the way an import or a
    generation writes it."""
    entry_dir = store.root / entry_id
    entry_dir.mkdir(parents=True, exist_ok=True)
    (entry_dir / "output.wav").write_bytes(b"RIFF\x00\x00\x00\x00WAVE")
    payload = {
        "id": entry_id,
        "filename": "output.wav",
        "audio_filename": "output.wav",
        "mime_type": "audio/wav",
        "title": entry_id,
        "prompt": "",
        "model": "small",
        "duration": 1.0,
        "source": "import",
        "tags": [],
        "notes": "",
        "saved_at": 1234567890.0,
    }
    payload.update(meta)
    (entry_dir / "metadata.json").write_text(json.dumps(payload), encoding="utf-8")
    store.db.upsert_entry({**payload, "kind": "audio", "metadata_json": payload})
    return entry_dir


@pytest.fixture
def store(tmp_path: Path) -> LibraryStore:
    return LibraryStore(tmp_path / "library")


# ---------------------------------------------------------------------------
# db.delete_entries_bulk
# ---------------------------------------------------------------------------


def test_db_bulk_delete_removes_the_rows(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entries_bulk([_payload(f"e{i}") for i in range(20)])
    assert db.delete_entries_bulk([f"e{i}" for i in range(5)]) == 5
    assert db.count_entries() == 15
    assert db.get_entry("e0") is None
    assert db.get_entry("e5") is not None
    # An id that is not there is simply not deleted; it is not an error here.
    assert db.delete_entries_bulk(["nope"]) == 0


def test_db_bulk_delete_bumps_the_revision_once_per_batch(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entries_bulk([_payload(f"e{i}") for i in range(10)])
    before = db.library_revision()
    db.delete_entries_bulk([f"e{i}" for i in range(10)], batch=4)
    # 10 ids in batches of 4 -> 3 transactions, 3 bumps. Not 10.
    assert db.library_revision() == before + 3


def test_search_no_longer_finds_a_bulk_deleted_entry(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    if not db.fts_enabled:
        pytest.skip("build has no FTS5; the LIKE path reads live columns")
    db.upsert_entries_bulk(
        [_payload("keep", title="Harbor Light"), _payload("drop", title="Harbor Dark")]
    )
    assert len(db.list_entries_page(EntryFilters(q="harbor"), limit=10)) == 2

    db.delete_entries_bulk(["drop"])
    found = db.list_entries_page(EntryFilters(q="harbor"), limit=10)
    assert [r["id"] for r in found] == ["keep"]
    assert db.count_entries_filtered(EntryFilters(q="dark")) == 0
    # An fts5 index only reports a bad delete through corruption, so ask it
    # directly, against its content view as well as internally.
    check_search_index(db)


def test_relations_referencing_a_deleted_entry_go_too(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entries_bulk([_payload("a"), _payload("b"), _payload("c")])
    db.add_relations_bulk([("a", "b", "derived-from"), ("c", "a", "derived-from")])
    assert len(db.list_relations()) == 2
    db.delete_entries_bulk(["a"])
    # The edge a->b (a is the source) and the edge c->a (a is the target) both
    # go; `relations` is polymorphic so no foreign key would have done it.
    assert db.list_relations() == []


def test_cascading_tables_are_emptied_for_a_bulk_deleted_entry(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entries_bulk([_payload("a", tags=["chill"]), _payload("b")])
    db.upsert_analysis("a", {"bpm": 120.0})
    assert db.get_analysis("a") is not None
    db.delete_entries_bulk(["a"])
    assert db.get_analysis("a") is None
    assert (
        db._conn.execute(
            "SELECT COUNT(*) c FROM tag_index WHERE entry_id = 'a'"
        ).fetchone()["c"]
        == 0
    )


def test_existing_entry_ids_reports_only_the_rows_that_are_there(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entries_bulk([_payload(f"e{i}") for i in range(3)])
    assert db.existing_entry_ids(["e0", "e2", "ghost"]) == {"e0", "e2"}
    assert db.existing_entry_ids([]) == set()


# ---------------------------------------------------------------------------
# store.delete_entries_bulk -- the safety rules
# ---------------------------------------------------------------------------


def test_a_bulk_delete_of_many_batches_checkpoints_the_wal_once(
    store: LibraryStore,
):
    """The store hands the DB one batch at a time. Each batch commits on its
    own, but the WAL is copied back into the database file once, after the
    last one -- not once per batch, which was half the cost of a large
    delete."""
    for i in range(7):
        _managed_entry(store, f"c{i}", title=f"Cobalt {i}")
    statements: list[str] = []
    store.db._conn.set_trace_callback(statements.append)
    try:
        result = store.delete_entries_bulk([f"c{i}" for i in range(7)], batch=3)
    finally:
        store.db._conn.set_trace_callback(None)
    assert result.deleted == 7
    checkpoints = [s for s in statements if "wal_checkpoint" in s]
    assert checkpoints == ["PRAGMA wal_checkpoint(PASSIVE)"]
    # Automatic checkpoints are back on afterwards.
    assert store.db._conn.execute("PRAGMA wal_autocheckpoint").fetchone()[0] > 0
    assert store.db.count_entries_filtered(EntryFilters(q="cobalt")) == 0
    check_search_index(store.db)


def test_bulk_delete_removes_the_folder_and_the_row(store: LibraryStore):
    first = _managed_entry(store, "m1")
    second = _managed_entry(store, "m2")
    result = store.delete_entries_bulk(["m1"])

    assert result.deleted == 1
    assert result.failed == []
    assert not first.exists()
    assert second.exists()
    assert store.db.get_entry("m1") is None
    assert store.db.get_entry("m2") is not None


def test_a_reference_in_place_source_file_survives(store: LibraryStore, tmp_path: Path):
    """The whole reason this ticket is marked risky: an entry registered from
    the user's own music folder must lose its library folder and its rows and
    NOTHING else."""
    outside = tmp_path / "my music"
    outside.mkdir()
    src = outside / "keeper.mp3"
    src.write_bytes(b"ID3\x04\x00\x00" + bytes(64))

    record = store.register_reference(str(src))
    assert record is not None
    entry_dir = store.root / record.id
    meta = json.loads((entry_dir / "metadata.json").read_text(encoding="utf-8"))
    assert meta["source_path"] == str(src.resolve())

    result = store.delete_entries_bulk([record.id])

    assert result.deleted == 1
    assert result.failed == []
    assert not entry_dir.exists()
    assert store.db.get_entry(record.id) is None
    # The user's file, and the folder it lives in, are untouched.
    assert src.is_file()
    assert src.read_bytes().startswith(b"ID3")
    assert outside.is_dir()


def test_a_path_that_escapes_the_library_root_is_refused(
    store: LibraryStore, tmp_path: Path
):
    """``_dir_for`` joins the entry id onto the root, so an id carrying ``..``
    resolves outside it. Nothing is removed and nothing is deleted from the DB
    for such an id."""
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "metadata.json").write_text("{}", encoding="utf-8")
    (outside / "precious.wav").write_bytes(b"RIFF")
    escaping = "../outside"
    assert store._dir_for(escaping) is not None  # it really does resolve out

    result = store.delete_entries_bulk([escaping])

    assert result.deleted == 0
    assert [f["id"] for f in result.failed] == [escaping]
    assert "root" in result.failed[0]["error"]
    assert outside.is_dir()
    assert (outside / "precious.wav").is_file()


def test_one_bad_id_never_aborts_the_rest(store: LibraryStore):
    for i in range(4):
        _managed_entry(store, f"m{i}")
    result = store.delete_entries_bulk(["m0", "ghost", "m1", "m2", "m3"])
    assert result.deleted == 4
    assert [f["id"] for f in result.failed] == ["ghost"]
    assert store.db.count_entries() == 0


def test_a_row_whose_folder_was_deleted_by_hand_is_still_cleared(store: LibraryStore):
    """These rows are invisible in the list (the store skips them) but they are
    counted in ``total``, so refusing to delete them would make "Clear all"
    never converge."""
    entry_dir = _managed_entry(store, "orphan")
    import shutil

    shutil.rmtree(entry_dir)
    result = store.delete_entries_bulk(["orphan"])
    assert result.deleted == 1
    assert result.failed == []
    assert store.db.get_entry("orphan") is None


def test_ids_are_deduplicated(store: LibraryStore):
    _managed_entry(store, "m1")
    result = store.delete_entries_bulk(["m1", "m1", "m1"])
    assert result.deleted == 1
    assert result.failed == []


def test_filesystem_removal_happens_after_the_row_is_committed(
    store: LibraryStore, monkeypatch
):
    """Ordering rule: the DB commit first, then the folder. A crash between the
    two leaves an orphan folder (harmless, re-importable); the other order
    leaves a row pointing at audio that is gone."""
    order: list[str] = []
    real_delete = store.db.delete_entries_bulk

    def spy_delete(ids, **kw):
        order.append("db")
        return real_delete(ids, **kw)

    monkeypatch.setattr(store.db, "delete_entries_bulk", spy_delete)
    import shutil as _shutil

    from backend.modules.library import store as store_mod

    real_rmtree = _shutil.rmtree
    monkeypatch.setattr(
        store_mod.shutil,
        "rmtree",
        lambda p, *a, **k: (order.append("fs"), real_rmtree(p, *a, **k))[1],
    )
    _managed_entry(store, "m1")
    store.delete_entries_bulk(["m1"])
    assert order == ["db", "fs"]


# ---------------------------------------------------------------------------
# POST /entries/bulk-delete -- the contract T33 codes against
# ---------------------------------------------------------------------------


@pytest.fixture
def client_with_root(tmp_path: Path, monkeypatch) -> TestClient:
    monkeypatch.setattr(library_router_module, "_store", None)
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(tmp_path / "root"))
    app = FastAPI()
    app.include_router(library_router_module.router, prefix="/api/library")
    # This machine's own UI: the route answers only a loopback peer or the
    # desktop shell's launch token (see the LAN test below).
    return TestClient(app, client=("127.0.0.1", 51000))


def _seed_via_client(client: TestClient, n: int, **meta) -> LibraryStore:
    store = library_router_module.get_store()
    for i in range(n):
        _managed_entry(store, f"e{i:03d}", **meta)
    return store


def test_a_lan_caller_cannot_bulk_delete(client_with_root, monkeypatch):
    """A script on the LAN sends no browser headers, so nothing header-based
    tells it from the UI; the TCP peer does. Neither form deletes a row, and
    the desktop shell's launch token is the one thing that passes from there."""
    from backend.lib import launch_token

    monkeypatch.delenv(launch_token.ENV_VAR, raising=False)
    store = _seed_via_client(client_with_root, 3)
    lan = TestClient(client_with_root.app, client=("10.20.30.40", 51000))

    by_ids = lan.post("/api/library/entries/bulk-delete", json={"ids": ["e000"]})
    assert by_ids.status_code == 403
    by_filter = lan.post(
        "/api/library/entries/bulk-delete",
        json={"filter": {}, "all": True, "confirm_total": 3},
    )
    assert by_filter.status_code == 403
    remaining = library_router_module._entry_filters("all", None, None, None)
    assert store.db.count_entries_filtered(remaining) == 3

    monkeypatch.setenv(launch_token.ENV_VAR, "s3cret-launch")
    shell = lan.post(
        "/api/library/entries/bulk-delete",
        json={"ids": ["e000"]},
        headers={launch_token.HEADER: "s3cret-launch"},
    )
    assert shell.status_code == 200
    assert shell.json()["deleted"] == 1


def test_bulk_delete_by_ids_answers_the_frozen_shape(client_with_root):
    _seed_via_client(client_with_root, 3)
    r = client_with_root.post(
        "/api/library/entries/bulk-delete", json={"ids": ["e000", "e001"]}
    )
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"deleted", "failed", "total_matched", "revision"}
    assert body["deleted"] == 2
    assert body["failed"] == []
    assert body["total_matched"] == 2
    assert isinstance(body["revision"], int)
    summary = client_with_root.get("/api/library/summary").json()
    assert summary["counts"]["tracks"] == 1


def test_bulk_delete_reports_failures_in_the_response(client_with_root):
    _seed_via_client(client_with_root, 1)
    body = client_with_root.post(
        "/api/library/entries/bulk-delete", json={"ids": ["e000", "ghost"]}
    ).json()
    assert body["deleted"] == 1
    assert body["total_matched"] == 2
    assert len(body["failed"]) == 1
    assert set(body["failed"][0]) == {"id", "error"}
    assert body["failed"][0]["id"] == "ghost"
    assert "no such library entry" in body["failed"][0]["error"]
    # deleted + every failure accounts for the whole request.
    assert body["deleted"] + len(body["failed"]) == body["total_matched"]


def test_bulk_delete_refuses_more_ids_than_the_cap(client_with_root, monkeypatch):
    monkeypatch.setattr(library_router_module, "MAX_BULK_DELETE_IDS", 3)
    r = client_with_root.post(
        "/api/library/entries/bulk-delete", json={"ids": [f"x{i}" for i in range(4)]}
    )
    assert r.status_code == 400
    assert "3" in r.json()["detail"]


def test_bulk_delete_needs_exactly_one_of_ids_or_filter(client_with_root):
    for body in (
        {},
        {"ids": ["a"], "filter": {"kind": "audio"}, "confirm_total": 1},
        {"filter": {"kind": "audio"}},  # confirm_total is required with a filter
    ):
        r = client_with_root.post("/api/library/entries/bulk-delete", json=body)
        assert r.status_code == 400, body


def test_the_filter_form_deletes_what_the_filter_matches(client_with_root):
    _seed_via_client(client_with_root, 4)
    store = library_router_module.get_store()
    store.db.upsert_entry(
        {
            "id": "e000",
            "kind": "audio",
            "title": "e000",
            "favorite": True,
            "source": "import",
        }
    )
    r = client_with_root.post(
        "/api/library/entries/bulk-delete",
        json={"filter": {"kind": "audio", "favorite": False}, "confirm_total": 3},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["deleted"] == 3
    assert body["total_matched"] == 3
    assert store.db.count_entries() == 1
    assert store.db.get_entry("e000") is not None


def test_a_confirm_total_mismatch_deletes_nothing(client_with_root):
    store = _seed_via_client(client_with_root, 4)
    r = client_with_root.post(
        "/api/library/entries/bulk-delete",
        json={"filter": {"kind": "audio"}, "confirm_total": 3},
    )
    assert r.status_code == 409
    body = r.json()
    assert body["total_matched"] == 4
    assert "detail" in body
    # NOTHING was deleted.
    assert store.db.count_entries() == 4
    assert (store.root / "e000").is_dir()


def test_a_row_written_during_the_filter_read_is_refused_not_substituted(
    client_with_root, monkeypatch
):
    """F2b / R2 finding 2: the filter form used to re-count, confirm the count
    matched, and only THEN re-read ids newest-first and trim to that count. A
    row written in the gap between the count and that re-read landed at the
    front of the newest-first list, so trimming kept it and dropped the
    oldest row the client actually confirmed -- deleting an entry the client
    never saw instead of the one it did.

    Reproduced here by making the id-read itself the point where the "other
    request" lands its write, which is exactly the gap the fix collapses: one
    read, compared to ``confirm_total`` with no trimming.
    """
    store = _seed_via_client(client_with_root, 3)
    real_list_entry_ids = store.db.list_entry_ids
    injected: list[bool] = []

    def racing_list_entry_ids(filters, cap, **kwargs):
        if not injected:
            injected.append(True)
            _managed_entry(store, "raced_in")
        return real_list_entry_ids(filters, cap, **kwargs)

    monkeypatch.setattr(store.db, "list_entry_ids", racing_list_entry_ids)

    r = client_with_root.post(
        "/api/library/entries/bulk-delete",
        json={"filter": {"kind": "audio"}, "confirm_total": 3},
    )

    assert r.status_code == 409
    body = r.json()
    assert body["total_matched"] == 4
    assert "detail" in body
    # NOTHING was deleted -- not the raced-in row, not any of the confirmed ones.
    assert store.db.count_entries() == 4
    assert store.db.get_entry("raced_in") is not None
    assert store.db.get_entry("e000") is not None
    assert store.db.get_entry("e001") is not None
    assert store.db.get_entry("e002") is not None


def test_a_confirm_total_mismatch_by_more_than_one_reports_the_real_total(
    client_with_root,
):
    """R2 finding 2, round 2: ``list_entry_ids`` answers at most
    ``confirm_total + 1`` rows, so reusing its length as the refusal's
    ``total_matched`` is only right when the library drifted by exactly one
    row. Seed 6, confirm 3: the capped read returns 4 ids, but the real total
    is 6 and the response must say so -- the frontend retries the request
    with this number (``backendLocalProvider.ts``'s ``totalMatched``) and
    pre-fills the typed confirmation with it."""
    store = _seed_via_client(client_with_root, 6)
    r = client_with_root.post(
        "/api/library/entries/bulk-delete",
        json={"filter": {"kind": "audio"}, "confirm_total": 3},
    )
    assert r.status_code == 409
    body = r.json()
    assert body["total_matched"] == 6
    assert "detail" in body
    # NOTHING was deleted.
    assert store.db.count_entries() == 6


def test_the_filter_forms_deleted_set_is_exactly_what_was_matched(client_with_root):
    """Equal totals: the ids actually removed are exactly the ids the filter
    matched, not a trimmed/reordered stand-in for them."""
    store = _seed_via_client(client_with_root, 4)
    store.db.upsert_entry(
        {
            "id": "e000",
            "kind": "audio",
            "title": "e000",
            "favorite": True,
            "source": "import",
        }
    )
    filters = library_router_module._entry_filters("audio", None, False, None)
    matched_ids = store.db.list_entry_ids(filters, 10)
    assert set(matched_ids) == {"e001", "e002", "e003"}

    r = client_with_root.post(
        "/api/library/entries/bulk-delete",
        json={"filter": {"kind": "audio", "favorite": False}, "confirm_total": 3},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["deleted"] == 3
    assert body["total_matched"] == 3

    for entry_id in matched_ids:
        assert store.db.get_entry(entry_id) is None
    assert store.db.get_entry("e000") is not None


def test_an_empty_filter_needs_the_all_guard(client_with_root):
    store = _seed_via_client(client_with_root, 3)
    refused = client_with_root.post(
        "/api/library/entries/bulk-delete", json={"filter": {}, "confirm_total": 3}
    )
    assert refused.status_code == 400
    assert "all" in refused.json()["detail"]
    assert store.db.count_entries() == 3

    allowed = client_with_root.post(
        "/api/library/entries/bulk-delete",
        json={"filter": {}, "confirm_total": 3, "all": True},
    )
    assert allowed.status_code == 200, allowed.text
    assert allowed.json()["deleted"] == 3
    assert store.db.count_entries() == 0


def test_the_all_guard_still_checks_the_count(client_with_root):
    store = _seed_via_client(client_with_root, 3)
    r = client_with_root.post(
        "/api/library/entries/bulk-delete",
        json={"filter": {}, "confirm_total": 99, "all": True},
    )
    assert r.status_code == 409
    assert store.db.count_entries() == 3


def test_the_filter_form_rejects_an_unknown_kind(client_with_root):
    _seed_via_client(client_with_root, 1)
    r = client_with_root.post(
        "/api/library/entries/bulk-delete",
        json={"filter": {"kind": "nonsense"}, "confirm_total": 1},
    )
    assert r.status_code == 400


def test_the_revision_rises_across_a_bulk_delete(client_with_root):
    _seed_via_client(client_with_root, 3)
    before = client_with_root.get("/api/library/summary").json()["revision"]
    body = client_with_root.post(
        "/api/library/entries/bulk-delete", json={"ids": ["e000", "e001"]}
    ).json()
    assert body["revision"] > before
    assert (
        body["revision"]
        == (client_with_root.get("/api/library/summary").json()["revision"])
    )


def test_the_route_is_not_swallowed_by_the_entry_id_routes(client_with_root):
    _seed_via_client(client_with_root, 1)
    r = client_with_root.post("/api/library/entries/bulk-delete", json={"ids": []})
    assert r.status_code == 200
    assert r.json()["deleted"] == 0
    # The single-entry routes still work.
    assert client_with_root.get("/api/library/entries/e000").status_code == 200
    assert client_with_root.delete("/api/library/entries/e000").status_code == 200


def test_the_failed_list_is_capped(client_with_root, monkeypatch):
    monkeypatch.setattr(library_router_module, "MAX_BULK_DELETE_ERRORS", 5)
    body = client_with_root.post(
        "/api/library/entries/bulk-delete",
        json={"ids": [f"ghost{i}" for i in range(20)]},
    ).json()
    assert body["deleted"] == 0
    assert body["total_matched"] == 20
    assert len(body["failed"]) == 5


# ---------------------------------------------------------------------------
# 200,000 rows, 50,000 deleted
# ---------------------------------------------------------------------------


def _perf_payloads(n: int) -> list[dict]:
    adjectives = ("neon", "velvet", "glass", "iron", "amber", "quiet", "hollow")
    nouns = ("drift", "signal", "harbor", "ember", "static", "orbit", "field")
    return [
        {
            "id": f"perf{i:07d}",
            "kind": "audio",
            "title": f"{adjectives[i % 7]} {nouns[(i // 7) % 7]} {i:07d}",
            "prompt": f"{nouns[i % 7]} texture take {i % 97}",
            "notes": "",
            "model": "reference",
            "source": "folder",
            "favorite": (i % 50 == 0),
            "duration": float(30 + (i % 600)),
            "audio_filename": f"{i:07d}.flac",
            "timestamp": "2026-09-18T00:00:00Z",
            "metadata_json": {"source_path": f"D:/music/{i:07d}.flac"},
        }
        for i in range(n)
    ]


def test_fifty_thousand_ids_delete_inside_the_budget(tmp_path: Path):
    """Through the STORE, so the per-id directory resolution is in the number
    too -- that is what the endpoint actually pays."""
    store = LibraryStore(tmp_path / "library")
    t0 = time.perf_counter()
    assert store.db.upsert_entries_bulk(_perf_payloads(PERF_ROWS), batch=5000) == (
        PERF_ROWS
    )
    build_s = time.perf_counter() - t0
    assert store.db.count_entries() == PERF_ROWS

    ids = [f"perf{i:07d}" for i in range(PERF_DELETE)]
    revision_before = store.db.library_revision()
    t0 = time.perf_counter()
    result = store.delete_entries_bulk(ids)
    delete_s = time.perf_counter() - t0

    assert result.deleted == PERF_DELETE
    assert result.failed == []
    assert store.db.count_entries() == PERF_ROWS - PERF_DELETE
    bumps = store.db.library_revision() - revision_before
    assert 0 < bumps <= PERF_DELETE / 100, "one revision per batch, not per row"

    t0 = time.perf_counter()
    total = store.db.count_entries_filtered(EntryFilters(kinds=frozenset({"audio"})))
    count_ms = (time.perf_counter() - t0) * 1000
    assert total == PERF_ROWS - PERF_DELETE

    print(
        f"\n[200k delete] build={build_s:.1f}s  "
        f"delete({PERF_DELETE})={delete_s:.2f}s  revision bumps={bumps}  "
        f"count after={count_ms:.1f}ms"
    )
    assert delete_s < DELETE_BUDGET_S, f"delete took {delete_s:.1f}s"
