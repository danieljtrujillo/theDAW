"""A queued auto-analysis job whose library was closed before it ran.

Analysis jobs wait in the process-wide background queue for an idle moment.
The library can be closed or replaced in the meantime (a library folder
change, a retried open), and the job then ran analyze_and_persist against a
closed SQLite connection and logged "job analysis:... failed: Cannot operate
on a closed database". The sequence here is the real one: the import queues
the job, the library closes, the job runs.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path

import pytest

from backend.core import background_workers
from backend.modules.analysis import engine
from backend.modules.library import store as store_mod
from backend.modules.library.store import LibraryStore
from backend.modules.settings import router as settings_router
from tests.test_library_store import _seed_generate_entry


class _Settings:
    def get_section(self, name: str) -> dict:
        assert name == "analysis"
        return {"auto_on_import": True}


class _Queue:
    def __init__(self) -> None:
        self.jobs: list[tuple[str, object]] = []

    def enqueue(self, name: str, fn) -> None:
        self.jobs.append((name, fn))


def test_an_analysis_queued_before_the_library_closed_skips_quietly(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
):
    _seed_generate_entry(tmp_path, "job1", 0)
    store = LibraryStore(tmp_path)
    queue = _Queue()
    monkeypatch.setattr(settings_router, "get_store", lambda: _Settings())
    monkeypatch.setattr(background_workers, "get_background_queue", lambda: queue)

    def must_not_run(*_a, **_k):
        raise AssertionError("analysis ran against a closed library")

    monkeypatch.setattr(engine, "analyze_and_persist", must_not_run)

    assert store_mod._maybe_enqueue_analysis(store, "job1_00", source="import")
    ((name, job),) = queue.jobs
    assert name == "analysis:job1_00"

    assert store.db is not None
    store.db.close()
    assert store.db.closed

    with caplog.at_level(logging.INFO, logger=store_mod.__name__):
        asyncio.run(job())
    assert "analysis for job1_00 skipped: its library was closed" in caplog.text


def test_an_analysis_on_an_open_library_still_runs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    _seed_generate_entry(tmp_path, "job1", 0)
    store = LibraryStore(tmp_path)
    queue = _Queue()
    ran: list[str] = []
    monkeypatch.setattr(settings_router, "get_store", lambda: _Settings())
    monkeypatch.setattr(background_workers, "get_background_queue", lambda: queue)
    monkeypatch.setattr(
        engine,
        "analyze_and_persist",
        lambda db, entry_id, *a, **k: ran.append(entry_id),
    )

    assert store_mod._maybe_enqueue_analysis(store, "job1_00", source="import")
    ((_, job),) = queue.jobs
    asyncio.run(job())
    assert ran == ["job1_00"]
    assert store.db is not None
    store.db.close()
