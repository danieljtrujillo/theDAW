"""The backend's startup never waits on the library, at 200,000 entries.

Opening main's library (schema 6) with this build upgrades it to schema 13
(index builds: about 9 s at 200,000 rows on an NVMe disk, minutes on a slow
one) and builds the search index from scratch (about 30 s more). The backend
used to do the upgrade inside its lifespan, so ``/api/health`` answered only
once it was over, and a search during the index build held a request thread
until the build ended (52 to 170 s at 200,000 rows).

Now the library opens on a thread of its own: health answers at once, the
list answers 503 with the progress while the upgrade runs, a search during
the index build answers promptly from the rows indexed so far and says so,
and ``/api/library/index-status`` reports every phase with a count and an
ETA. The rest of this file covers what keeps the data safe when the app
closes part way: the read of every ``metadata.json`` into an empty database
resumes on the next start, and the progress a status request reports.
"""

from __future__ import annotations

import sqlite3
import threading
import time
from pathlib import Path

from fastapi.testclient import TestClient

from backend.modules.library import router as library_router_module
from backend.modules.library.db import (
    DISK_READ_PENDING_KEY,
    EntryFilters,
    FairRLock,
    SEARCH_BUILD_THREAD,
    LibraryDB,
    LibraryProgress,
)
from backend.modules.library.store import LibraryStore
from tests.test_library_search_parity import _main_build
from tests.test_library_store import _seed_generate_entry
from tests.test_security_b12 import real_app_context

#: The library size the startup has to survive.
ROWS = 200_000

#: A request that answers "at once" answers inside this.
PROMPT_SEC = 1.0

_MAIN_INSERT = """
    INSERT INTO entries (
        id, kind, title, prompt, negative_prompt, model, duration_sec, steps,
        cfg, seed, mime, audio_filename, file_size_bytes, source, favorite,
        rating, notes, timestamp, created_at, updated_at, analysis_status,
        stems_status, midi_status, metadata_json
    ) VALUES (?, 'audio', ?, '', '', ?, ?, 0, 0, 0, 'audio/wav', 'output.wav',
              1000, 'generate', ?, NULL, '', '2026-01-01', ?, ?, 'pending',
              'pending', 'pending', '{}')
"""


def _seed_mains_library(path: Path, rows: int) -> None:
    """main's schema-6 file with ``rows`` entries, written in one transaction
    (main's own upsert commits per row: minutes for 200,000). Titles are
    short so the file stays small; every title holds "harbor", and one in
    every 10,000 also holds "zircon"."""
    main = _main_build().LibraryDB(path)
    main.close()
    now = time.time()
    conn = sqlite3.connect(path)
    try:
        conn.executemany(
            _MAIN_INSERT,
            (
                (
                    f"s{i:06d}",
                    f"Harbor {i}" + (" Zircon" if i % 10_000 == 0 else ""),
                    ("small", "medium", "chirp-v4")[i % 3],
                    60.0 + i % 240,
                    1 if i % 9 == 0 else 0,
                    now - i,
                    now - i,
                )
                for i in range(rows)
            ),
        )
        conn.commit()
    finally:
        conn.close()


def _status(client: TestClient) -> dict:
    response = client.get("/api/library/index-status")
    assert response.status_code == 200
    return response.json()


def _timed_get(client: TestClient, url: str, **kwargs) -> tuple[float, object]:
    began = time.perf_counter()
    response = client.get(url, **kwargs)
    return time.perf_counter() - began, response


def _timed_post(client: TestClient, url: str, **kwargs) -> tuple[float, object]:
    began = time.perf_counter()
    response = client.post(url, **kwargs)
    return time.perf_counter() - began, response


def _wait_for_phase(client: TestClient, wanted: set[str], timeout: float) -> dict:
    deadline = time.monotonic() + timeout
    while True:
        status = _status(client)
        if status["phase"] in wanted:
            return status
        assert status["phase"] != "failed", status
        assert time.monotonic() < deadline, f"never reached {wanted}: {status}"
        time.sleep(0.05)


def test_health_and_search_answer_while_a_200k_library_is_upgraded_and_indexed(
    tmp_path: Path, monkeypatch
) -> None:
    root = tmp_path / "app-generations"
    root.mkdir()
    path = root / "library.db"
    _seed_mains_library(path, ROWS)

    try:
        with (
            real_app_context(tmp_path, monkeypatch) as app,
            TestClient(app, client=("127.0.0.1", 51000)) as client,
        ):
            # --- the schema upgrade, on its own thread ---------------------
            status = _wait_for_phase(client, {"upgrade", "index", "ready"}, 60)
            assert status["phase"] == "upgrade", (
                "the upgrade of 200,000 rows was over before the first request: "
                f"{status}"
            )
            during_upgrade: list[float] = []
            while True:
                took, response = _timed_get(client, "/api/health")
                after = _status(client)
                if after["phase"] != "upgrade":
                    break
                assert response.status_code == 200
                during_upgrade.append(took)
                if len(during_upgrade) >= 5:
                    break
                time.sleep(0.2)
            assert during_upgrade, "no health request landed during the upgrade"
            assert max(during_upgrade) < PROMPT_SEC, during_upgrade
            assert after["total"] > 0 and after["done"] <= after["total"]

            took, listed = _timed_get(
                client, "/api/library/entries", params={"limit": 5}
            )
            # Waits at most OPEN_WAIT_SEC, then frees the thread with a 503.
            assert took < library_router_module.OPEN_WAIT_SEC + PROMPT_SEC, took
            if listed.status_code == 503:
                body = listed.json()
                assert body["library_status"]["phase"] == "upgrade"
                assert listed.headers["retry-after"] == "2"
            else:
                # Only when the upgrade really ended inside the wait.
                assert listed.status_code == 200
                assert _status(client)["phase"] != "upgrade"

            # --- the search index build, in batches ------------------------
            status = _wait_for_phase(client, {"index", "ready"}, 600)
            assert status["phase"] == "index", (
                f"the index build of 200,000 rows was over at once: {status}"
            )
            assert status["total"] == ROWS
            health: list[float] = []
            narrow: list[float] = []
            broad: list[float] = []
            partial_seen = False
            while _status(client)["phase"] == "index":
                took, response = _timed_get(client, "/api/health")
                assert response.status_code == 200
                health.append(took)
                took, found = _timed_get(
                    client, "/api/library/entries", params={"limit": 5, "q": "zircon"}
                )
                assert found.status_code == 200
                narrow.append(took)
                if not found.json()["search_index"]["complete"]:
                    partial_seen = True
                    body = found.json()
                    assert body["search_index"]["total"] == ROWS
                    assert body["total"] <= ROWS // 10_000
                took, found = _timed_get(
                    client, "/api/library/entries", params={"limit": 5, "q": "harbor"}
                )
                assert found.status_code == 200
                broad.append(took)
                time.sleep(0.5)
            assert partial_seen, "no search landed while the index was building"
            assert max(health) < PROMPT_SEC, health
            assert max(narrow) < PROMPT_SEC, narrow
            # "harbor" matches every indexed row: counting 100,000+ matches is
            # the query's own cost, measured at 0.2-0.5 s.
            assert max(broad) < 3 * PROMPT_SEC, broad

            # --- done: every row is found ----------------------------------
            _wait_for_phase(client, {"ready"}, 600)
            done = client.get(
                "/api/library/entries", params={"limit": 5, "q": "zircon"}
            ).json()
            assert done["search_index"] == {"complete": True}
            assert done["total"] == ROWS // 10_000
    finally:
        # A few hundred MB under the basetemp; nothing reads them after this.
        for suffix in ("", "-wal", "-shm"):
            Path(f"{path}{suffix}").unlink(missing_ok=True)


def test_a_read_of_the_disk_cut_short_resumes_on_the_next_start(
    tmp_path: Path, monkeypatch
) -> None:
    """A first start reads every metadata.json into the empty database. When
    the app closes part way, the next start used to see a non-empty database
    and never read the rest: those entries stayed missing from the list until
    a manual reindex. The read is flagged until its last batch, so the next
    start reads again and finds every entry."""
    root = tmp_path / "gens"
    for i in range(30):
        _seed_generate_entry(root, f"job{i:03d}", 0, extra_meta={"title": f"Track {i}"})

    real_upsert = LibraryDB.upsert_entries_bulk
    batches: list[int] = []

    def dying_upsert(self, payloads, *args, **kwargs):
        batches.append(len(payloads))
        if len(batches) == 2:
            raise OSError("the app closed")
        return real_upsert(self, payloads, *args, **kwargs)

    monkeypatch.setattr(LibraryDB, "upsert_entries_bulk", dying_upsert)
    real_reindex = LibraryStore.reindex

    def small_batches(self, **kwargs):
        kwargs["batch"] = 10
        return real_reindex(self, **kwargs)

    monkeypatch.setattr(LibraryStore, "reindex", small_batches)
    try:
        LibraryStore(root)
    except OSError:
        pass
    else:
        raise AssertionError("the read did not stop")
    monkeypatch.setattr(LibraryDB, "upsert_entries_bulk", real_upsert)

    probe = LibraryDB(root / "library.db")
    try:
        assert probe.count_entries() == 10, "the first batch was committed"
        assert probe.get_flag(DISK_READ_PENDING_KEY) is not None
    finally:
        probe.close()

    store = LibraryStore(root)
    try:
        assert store.db is not None
        assert store.db.count_entries() == 30, "the next start read the rest"
        assert store.db.get_flag(DISK_READ_PENDING_KEY) is None
        assert store.db.count_entries_filtered(EntryFilters(q="track")) == 30
    finally:
        store.db.close()

    # A third start has nothing to read: the database is full and unflagged.
    reads: list[int] = []

    def counting_reindex(self, **kwargs):
        reads.append(1)
        return real_reindex(self, **kwargs)

    monkeypatch.setattr(LibraryStore, "reindex", counting_reindex)
    store = LibraryStore(root)
    try:
        assert reads == []
    finally:
        assert store.db is not None
        store.db.close()


def test_the_first_read_reports_folders_and_entries(tmp_path: Path) -> None:
    """The LIBRARY tab's bar during a first start: the read counts top-level
    folders (known before it starts) and the entries it finds."""
    root = tmp_path / "gens"
    for i in range(12):
        _seed_generate_entry(root, f"job{i:03d}", 0, extra_meta={"title": f"Track {i}"})
    seen: list[dict] = []

    class WatchingProgress(LibraryProgress):
        def advance(self, task: str, units: int = 0, *, items: int = 0) -> None:
            super().advance(task, units, items=items)
            if task == "read":
                seen.append(self.snapshot())

    progress = WatchingProgress()
    store = LibraryStore(root, progress=progress)
    try:
        read = [s for s in seen if s["phase"] == "read"]
        assert read, "the read reported progress"
        assert {s["total"] for s in read} == {12}
        assert read[-1]["done"] == 12 and read[-1]["items"] == 12
        assert progress.snapshot()["phase"] == "opening", "nothing left running"
    finally:
        assert store.db is not None
        store.db.close()


def test_progress_eta_counts_only_the_units_done_since_a_resume() -> None:
    progress = LibraryProgress()
    progress.begin("index", 200_000, done=150_000)
    started = progress._tasks["index"]["started"]
    # 10,000 rows in 2 s since the resume: 40,000 rows left take 8 s.
    progress._tasks["index"]["started"] = started - 2.0
    progress.advance("index", 10_000)
    snap = progress.snapshot()
    assert snap["phase"] == "index"
    assert snap["done"] == 160_000 and snap["total"] == 200_000
    assert snap["eta_sec"] is not None and 7.5 <= snap["eta_sec"] <= 8.5
    progress.finish("index")
    progress.mark_opened()
    assert progress.snapshot()["phase"] == "ready"
    progress.fail("disk full", label="The search index build stopped")
    failed = progress.snapshot()
    assert failed["phase"] == "failed" and failed["error"] == "disk full"
    assert failed["label"] == "The search index build stopped"


def test_the_startup_only_starts_the_open(tmp_path: Path, monkeypatch) -> None:
    """The lifespan returns while the library is still opening: a library
    whose open is held answers health at once, and the list answers 503 with
    the progress instead of holding the request thread."""
    real_init = LibraryStore.__init__
    release = threading.Event()

    def held_init(self, *args, **kwargs):
        if threading.current_thread().name == library_router_module.LIBRARY_OPEN_THREAD:
            release.wait(timeout=60)
        real_init(self, *args, **kwargs)

    monkeypatch.setattr(LibraryStore, "__init__", held_init)
    monkeypatch.setattr(library_router_module, "OPEN_WAIT_SEC", 0.2)
    try:
        with (
            real_app_context(tmp_path, monkeypatch) as app,
            TestClient(app, client=("127.0.0.1", 51000)) as client,
        ):
            took, health = _timed_get(client, "/api/health")
            assert health.status_code == 200 and took < PROMPT_SEC
            took, listed = _timed_get(
                client, "/api/library/entries", params={"limit": 5}
            )
            assert listed.status_code == 503 and took < PROMPT_SEC
            assert listed.json()["library_status"]["phase"] == "opening"
            for route in (
                "/api/library/summary",
                "/api/library/entries/stats",
                "/api/library/entries/facets?fields=model",
                "/api/library/entries/ids",
                "/api/library/entries/resolve?ref=harbor",
            ):
                took, refused = _timed_get(client, route)
                assert refused.status_code == 503 and took < PROMPT_SEC, route
                assert refused.json()["library_status"]["phase"] == "opening"
            took, refused = _timed_post(
                client, "/api/library/entries/bulk-delete", json={"ids": ["x"]}
            )
            assert refused.status_code == 503 and took < PROMPT_SEC
            assert _status(client)["phase"] == "opening"
            release.set()
            _wait_for_phase(client, {"ready"}, 60)
            listed = client.get("/api/library/entries", params={"limit": 5})
            assert listed.status_code == 200
    finally:
        release.set()


def test_a_failed_open_is_retried_after_the_backoff(
    tmp_path: Path, monkeypatch
) -> None:
    """An open that raises (the file locked by another process, say) is
    reported as failed. A caller that needs the store inside
    OPEN_RETRY_AFTER_SEC gets that failure without another attempt; the first
    caller after it tries again, so the library never stays unopenable until
    a restart."""
    root = tmp_path / "gens"
    root.mkdir()
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(root))
    monkeypatch.setattr(library_router_module, "_store", None)
    monkeypatch.setattr(library_router_module, "_opening", None)
    monkeypatch.setattr(library_router_module, "OPEN_RETRY_AFTER_SEC", 60.0)
    real_init = LibraryStore.__init__
    attempts: list[int] = []

    def flaky_init(self, *args, **kwargs):
        attempts.append(1)
        if len(attempts) == 1:
            raise sqlite3.OperationalError("database is locked")
        real_init(self, *args, **kwargs)

    monkeypatch.setattr(LibraryStore, "__init__", flaky_init)
    for _ in range(2):
        try:
            library_router_module.get_store()
        except RuntimeError as e:
            assert "database is locked" in str(e)
        else:
            raise AssertionError("the open did not fail")
        assert library_router_module.library_status()["phase"] == "failed"
    assert len(attempts) == 1, "inside the backoff, the failure is answered as it is"

    monkeypatch.setattr(library_router_module, "OPEN_RETRY_AFTER_SEC", 0.0)
    store = library_router_module.get_store()
    try:
        assert len(attempts) == 2
        assert library_router_module.library_status()["phase"] == "ready"
    finally:
        assert store.db is not None
        store.db.close()


def _wait_for_failed(client: TestClient, timeout: float = 30) -> dict:
    deadline = time.monotonic() + timeout
    while True:
        status = _status(client)
        if status["phase"] == "failed":
            return status
        assert time.monotonic() < deadline, f"never failed: {status}"
        time.sleep(0.05)


def test_a_failed_open_stays_failed_on_the_progress_poll_until_retry(
    tmp_path: Path, monkeypatch
) -> None:
    """The LIBRARY tab polls /index-status every second. That poll used to
    start a new open whenever the store was missing, so after a failure it
    always saw a fresh attempt at phase "opening": the failure alert never
    showed, and every poll made another attempt (and, before LibraryStore
    closed a failed open's database, another connection and build thread).
    Now the poll reports "failed" and starts nothing; the list answers 503
    with the failure; the Retry button (POST /retry-open) is what tries
    again."""
    attempts: list[int] = []
    failing = [True]
    real_init = LibraryStore.__init__

    def broken_init(self, *args, **kwargs):
        if threading.current_thread().name == library_router_module.LIBRARY_OPEN_THREAD:
            attempts.append(1)
            if failing[0]:
                raise OSError("the library folder cannot be read")
        real_init(self, *args, **kwargs)

    monkeypatch.setattr(LibraryStore, "__init__", broken_init)
    # raising=False: the backoff is what this test pins, and a build without
    # it must fail on the behaviour, not on the missing name.
    monkeypatch.setattr(
        library_router_module, "OPEN_RETRY_AFTER_SEC", 600.0, raising=False
    )
    with (
        real_app_context(tmp_path, monkeypatch) as app,
        TestClient(app, client=("127.0.0.1", 51000)) as client,
    ):
        status = _wait_for_failed(client)
        assert "cannot be read" in status["error"]
        for _ in range(6):
            time.sleep(0.1)
            assert _status(client)["phase"] == "failed"
        assert len(attempts) == 1, attempts

        listed = client.get("/api/library/entries", params={"limit": 5})
        assert listed.status_code == 503
        assert listed.json()["library_status"]["phase"] == "failed"
        assert listed.headers["retry-after"] == "600"
        assert len(attempts) == 1, "the list answers the failure; it opens nothing"

        retried = client.post("/api/library/retry-open")
        assert retried.status_code == 200
        _wait_for_failed(client)
        assert len(attempts) == 2, "the Retry button tries again"

        failing[0] = False
        assert client.post("/api/library/retry-open").status_code == 200
        _wait_for_phase(client, {"ready"}, 60)
        assert len(attempts) == 3
        assert (
            client.get("/api/library/entries", params={"limit": 5}).status_code == 200
        )


def test_a_failed_open_closes_its_database_and_stops_its_build(
    tmp_path: Path, monkeypatch
) -> None:
    """A LibraryStore that raised after its LibraryDB was open kept that
    database open: nothing else holds the store, and the exception kept it
    alive. When the file needed a search index build, the build thread ran on
    to the end on its own connection, one more for every retry."""
    root = tmp_path / "gens"
    root.mkdir()
    path = root / "library.db"
    _seed_mains_library(path, 60_000)
    closes: list[int] = []
    real_close = LibraryDB.close

    def counting_close(self):
        closes.append(1)
        real_close(self)

    def unreadable(self):
        raise OSError("the disk went away")

    monkeypatch.setattr(LibraryDB, "close", counting_close)
    monkeypatch.setattr(LibraryDB, "count_entries", unreadable)
    try:
        LibraryStore(root, build_search_in_background=True)
    except OSError:
        pass
    else:
        raise AssertionError("the open did not fail")
    assert closes == [1], "the failed open closed its database"
    deadline = time.monotonic() + 5
    while any(t.name == SEARCH_BUILD_THREAD for t in threading.enumerate()):
        assert time.monotonic() < deadline, "the build of a failed open ran on"
        time.sleep(0.05)
    path.unlink()  # nothing holds the file any more


def test_a_database_whose_open_fails_is_closed(tmp_path: Path, monkeypatch) -> None:
    """LibraryDB.__init__ opens the connection before the migration and the
    search setup; either raising left that connection open."""
    closes: list[int] = []
    real_close = LibraryDB.close

    def counting_close(self):
        closes.append(1)
        real_close(self)

    def broken(self, *, background: bool = False):
        raise sqlite3.OperationalError("disk I/O error")

    monkeypatch.setattr(LibraryDB, "close", counting_close)
    monkeypatch.setattr(LibraryDB, "_ensure_search", broken)
    path = tmp_path / "library.db"
    try:
        LibraryDB(path)
    except sqlite3.OperationalError:
        pass
    else:
        raise AssertionError("the open did not fail")
    assert closes == [1]
    path.unlink()


def _search_build_held(monkeypatch) -> tuple[threading.Event, list[int]]:
    """Hold the background search build before its first row, and make its
    first run fail when asked to."""
    release = threading.Event()
    fail_first: list[int] = []
    real_rows = LibraryDB._index_search_rows

    def held_rows(self, start, *args, **kwargs):
        if threading.current_thread().name == SEARCH_BUILD_THREAD:
            release.wait(timeout=60)
            if fail_first:
                fail_first.pop()
                raise sqlite3.OperationalError("database or disk is full")
        return real_rows(self, start, *args, **kwargs)

    monkeypatch.setattr(LibraryDB, "_index_search_rows", held_rows)
    return release, fail_first


def test_play_and_reveal_get_the_partial_ids_while_select_all_waits(
    tmp_path: Path, monkeypatch
) -> None:
    """Play the list, a shift-click range and revealing a track all read
    /entries/ids. During the index build a search there answered 409, so play
    fell back to one track and reveal failed. They send partial=true and get
    the ids the list shows, with search_index; select-all (no flag) is still
    refused until the build finishes."""
    root = tmp_path / "app-generations"
    root.mkdir()
    _seed_mains_library(root / "library.db", 500)
    release, _ = _search_build_held(monkeypatch)
    try:
        with (
            real_app_context(tmp_path, monkeypatch) as app,
            TestClient(app, client=("127.0.0.1", 51000)) as client,
        ):
            _wait_for_phase(client, {"index"}, 60)
            refused = client.get("/api/library/entries/ids", params={"q": "harbor"})
            assert refused.status_code == 409
            assert "still being built" in refused.json()["detail"]
            partial = client.get(
                "/api/library/entries/ids", params={"q": "harbor", "partial": "true"}
            )
            assert partial.status_code == 200
            body = partial.json()
            assert body["search_index"]["complete"] is False
            assert body["search_index"]["total"] == 500
            assert body["total"] == len(body["ids"]) < 500
            release.set()
            _wait_for_phase(client, {"ready"}, 60)
            done = client.get("/api/library/entries/ids", params={"q": "harbor"})
            assert done.status_code == 200
            assert done.json()["total"] == 500
            assert done.json()["search_index"] == {"complete": True}
    finally:
        release.set()


def test_a_stopped_build_says_so_and_the_retry_restarts_it(
    tmp_path: Path, monkeypatch
) -> None:
    """After a background build stopped, select-all by a search answered 409
    "still being built (0 of 0 entries) ... when it finishes", but nothing
    would finish it before a restart. It now answers 503 saying the build
    stopped, and POST /retry-open restarts the build from its cursor."""
    root = tmp_path / "app-generations"
    root.mkdir()
    _seed_mains_library(root / "library.db", 500)
    release, fail_first = _search_build_held(monkeypatch)
    fail_first.append(1)
    try:
        with (
            real_app_context(tmp_path, monkeypatch) as app,
            TestClient(app, client=("127.0.0.1", 51000)) as client,
        ):
            _wait_for_phase(client, {"index"}, 60)
            release.set()
            status = _wait_for_failed(client)
            assert status["label"] == "The search index build stopped"
            stopped = client.get("/api/library/entries/ids", params={"q": "harbor"})
            assert stopped.status_code == 503
            assert "build stopped" in stopped.json()["detail"]
            assert "disk is full" in stopped.json()["detail"]

            assert client.post("/api/library/retry-open").status_code == 200
            _wait_for_phase(client, {"ready"}, 60)
            done = client.get("/api/library/entries/ids", params={"q": "harbor"})
            assert done.status_code == 200
            assert done.json()["total"] == 500
    finally:
        release.set()


def test_the_library_lock_is_handed_over_in_arrival_order() -> None:
    """``FairRLock``: a thread that releases the lock and asks again at once
    queues behind the threads already waiting (``threading.RLock`` usually
    hands it straight back, which is how a search waited 4 s behind the index
    build and the notation backfill). Re-entrant for its owner, and a timed
    wait that runs out leaves the queue as it found it."""
    lock = FairRLock()
    order: list[str] = []
    lock.acquire()
    assert lock.acquire(), "re-entrant for the owner"
    lock.release()

    def waiter(name: str) -> None:
        with lock:
            order.append(name)

    first = threading.Thread(target=waiter, args=("first",))
    first.start()
    while not lock._queue:
        time.sleep(0.001)
    second = threading.Thread(target=waiter, args=("second",))
    second.start()
    while len(lock._queue) < 2:
        time.sleep(0.001)

    timed: list[bool] = []
    impatient = threading.Thread(
        target=lambda: timed.append(lock.acquire(timeout=0.05))
    )
    impatient.start()
    impatient.join()
    assert timed == [False] and len(lock._queue) == 2

    lock.release()
    # The releasing thread asks again at once: it queues behind both.
    with lock:
        order.append("releaser")
    first.join()
    second.join()
    assert order == ["first", "second", "releaser"]
    assert lock._owner is None and not lock._queue
    try:
        lock.release()
    except RuntimeError:
        pass
    else:
        raise AssertionError("releasing an unheld lock must raise")
