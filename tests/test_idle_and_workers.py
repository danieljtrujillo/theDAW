"""Unit tests for the IdleManager and BackgroundQueue."""

from __future__ import annotations

import asyncio
import time

from backend.core.background_workers import BackgroundQueue
from backend.core.idle import IdleManager


def test_idle_manager_starts_idle():
    m = IdleManager()
    assert m.is_idle() is True


def test_idle_manager_bump_activity_marks_busy():
    m = IdleManager(default_min_idle_seconds=0.05)
    m.bump_activity()
    assert m.is_idle() is False


def test_idle_manager_becomes_idle_after_grace_period():
    m = IdleManager(default_min_idle_seconds=0.05)
    m.bump_activity()
    assert m.is_idle() is False
    time.sleep(0.07)
    assert m.is_idle() is True


def test_idle_manager_active_tag_holds_busy():
    m = IdleManager(default_min_idle_seconds=0.0)
    m.bump_activity(tag="generate")
    # Even after the grace period the tag holds us busy.
    time.sleep(0.02)
    assert m.is_idle() is False
    assert "generate" in m.active_tags()
    m.release("generate")
    # After release, with min_idle_seconds=0 we are idle again.
    assert m.is_idle() is True


def test_idle_manager_release_idempotent_when_unknown():
    m = IdleManager()
    m.release("never-started")
    assert m.is_idle() is True


def test_idle_manager_snapshot_keys():
    m = IdleManager()
    snap = m.snapshot()
    for key in (
        "idle",
        "seconds_since_activity",
        "active_tags",
        "gpu_pressure",
        "min_idle_seconds",
    ):
        assert key in snap


def test_background_queue_runs_when_idle():
    async def scenario():
        idle = IdleManager(default_min_idle_seconds=0.0)
        q = BackgroundQueue(idle_manager=idle, poll_interval=0.05)
        q.start()

        ran = asyncio.Event()

        async def work():
            ran.set()

        q.enqueue("test-work", work)
        try:
            await asyncio.wait_for(ran.wait(), timeout=1.0)
        finally:
            await q.stop()

        return ran.is_set()

    assert asyncio.run(scenario()) is True


def test_background_queue_waits_for_idle():
    async def scenario():
        idle = IdleManager(default_min_idle_seconds=0.05)
        q = BackgroundQueue(idle_manager=idle, poll_interval=0.02)
        q.start()

        started_at: dict[str, float] = {}

        async def work():
            started_at["t"] = time.monotonic()

        idle.bump_activity()
        bump_ts = time.monotonic()
        q.enqueue("waited", work)
        try:
            for _ in range(50):
                if "t" in started_at:
                    break
                await asyncio.sleep(0.02)
        finally:
            await q.stop()
        return started_at.get("t"), bump_ts

    finished, bumped = asyncio.run(scenario())
    assert finished is not None
    assert finished - bumped >= 0.04


def test_background_queue_records_failures():
    async def scenario():
        idle = IdleManager(default_min_idle_seconds=0.0)
        q = BackgroundQueue(idle_manager=idle, poll_interval=0.02)
        q.start()

        async def bad_work():
            raise RuntimeError("nope")

        job = q.enqueue("bad", bad_work)
        try:
            for _ in range(50):
                if job.status in ("done", "failed", "cancelled"):
                    break
                await asyncio.sleep(0.02)
        finally:
            await q.stop()
        return job

    job = asyncio.run(scenario())
    assert job.status == "failed"
    assert job.error is not None and "nope" in job.error


def test_background_queue_dedupes_active_job_names():
    async def scenario():
        idle = IdleManager(default_min_idle_seconds=0.0)
        q = BackgroundQueue(idle_manager=idle, poll_interval=0.02)

        async def work():
            await asyncio.sleep(0.05)

        first = q.enqueue("same", work)
        second = q.enqueue("same", work)
        return first, second, q.snapshot()

    first, second, snap = asyncio.run(scenario())
    assert first is second
    assert snap["queue_depth"] == 1
    assert snap["statuses"]["queued"] == 1
