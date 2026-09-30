"""Lists ordered newest first by a wall-clock stamp keep that order within one
tick of the clock.

Windows' time.time() moves in 15.6 ms steps. Every test here freezes the clock
at one value, which is what two saves inside one step look like, and replays
the save-then-list sequence. Before backend/lib/stamps.py the stamps tied and
each list fell back to insertion or rowid order, oldest first.
"""

from __future__ import annotations

import asyncio
import os
import time
from pathlib import Path

import pytest

from backend.lib.stamps import STEP, IncreasingClock

FROZEN = 1_790_000_000.0


@pytest.fixture
def frozen_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(time, "time", lambda: FROZEN)


def test_the_clock_never_repeats_or_goes_back(frozen_clock: None) -> None:
    clock = IncreasingClock()
    stamps = [clock() for _ in range(5)]
    assert stamps[0] == FROZEN
    assert all(b > a for a, b in zip(stamps, stamps[1:]))
    # Still honest wall-clock times: four nudges of about STEP each (float
    # rounding at this magnitude moves each by a fraction of it).
    assert 0 < stamps[-1] - stamps[0] < 8 * STEP

    clock.advance_past(FROZEN + 10.0)  # a stamp already on disk, ahead of now
    assert clock() > FROZEN + 10.0


def test_library_entries_saved_in_one_tick_list_newest_first(
    frozen_clock: None, tmp_path: Path
) -> None:
    from backend.modules.library.db import EntryFilters, LibraryDB

    db = LibraryDB(tmp_path / "library.db")
    try:
        for entry_id in ("first", "second", "third"):
            db.upsert_entry(
                {
                    "id": entry_id,
                    "kind": "audio",
                    "title": entry_id,
                    "source": "generate",
                    "audio_filename": "output.wav",
                }
            )
        newest_first = ["third", "second", "first"]
        assert [r["id"] for r in db.list_entries()] == newest_first
        assert [r["id"] for r in db.list_entries_filtered()] == newest_first
        assert [r["id"] for r in db.list_entries_with_analysis()] == newest_first
        page = db.list_entries_page(EntryFilters(), sort="created_desc")
        assert [r["id"] for r in page] == newest_first
    finally:
        db.close()


def test_background_jobs_queued_in_one_tick_list_newest_first(
    frozen_clock: None,
) -> None:
    from backend.core.background_workers import BackgroundQueue

    async def work() -> None:
        return None

    queue = BackgroundQueue()
    queued = [queue.enqueue(name, work).id for name in ("a", "b", "c")]
    assert [j["id"] for j in queue.list_jobs()] == queued[::-1]


def test_sway_scenes_written_in_one_tick_list_by_name(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A whole install lands in one tick of the file clock. The scenes list
    by name, the same on every read and every platform."""
    from backend.modules.sway import router as sway_router

    scenes = tmp_path / "sway-projects"
    scenes.mkdir()
    for name in ("delta", "Alpha", "_intro", "charlie", "bravo"):
        path = scenes / f"{name}.sway"
        path.write_text("{}", encoding="utf-8")
        os.utime(path, (FROZEN, FROZEN))
    newer = scenes / "zulu.sway"
    newer.write_text("{}", encoding="utf-8")
    os.utime(newer, (FROZEN + 60, FROZEN + 60))
    monkeypatch.setattr(sway_router, "_PROJECTS_DIR", scenes)
    monkeypatch.setattr(sway_router, "_catalog_scene_digests", lambda: {})

    listed = asyncio.run(sway_router.sway_projects())["projects"]
    assert [r["name"] for r in listed] == [
        "zulu",
        "_intro",
        "Alpha",
        "bravo",
        "charlie",
        "delta",
    ]
