"""Tests for CachedProbe (BE-003): slow sync probes off the loop, cached.

The defect these guard is a subprocess-spawning, torch-importing probe called
straight from an async handler on the CREATE path. What matters is that the
loop keeps turning while it runs, that repeat polls do not pay for it again,
and that concurrent pollers collapse onto one run.
"""

from __future__ import annotations

import asyncio
import time

from backend.core.probe_cache import CachedProbe


def test_probe_runs_once_within_ttl():
    calls: list[int] = []

    def probe() -> str:
        calls.append(1)
        return "ok"

    async def scenario():
        p = CachedProbe(probe, ttl=60.0)
        return [await p.get(), await p.get(), await p.get()]

    assert asyncio.run(scenario()) == ["ok", "ok", "ok"]
    assert len(calls) == 1


def test_probe_reruns_after_invalidate():
    calls: list[int] = []

    def probe() -> int:
        calls.append(1)
        return len(calls)

    async def scenario():
        p = CachedProbe(probe, ttl=60.0)
        first = await p.get()
        p.invalidate()
        second = await p.get()
        return first, second

    assert asyncio.run(scenario()) == (1, 2)


def test_probe_reruns_after_ttl_expires():
    calls: list[int] = []

    def probe() -> int:
        calls.append(1)
        return len(calls)

    async def scenario():
        p = CachedProbe(probe, ttl=0.05)
        first = await p.get()
        await asyncio.sleep(0.08)
        return first, await p.get()

    assert asyncio.run(scenario()) == (1, 2)


def test_force_bypasses_a_fresh_cache():
    calls: list[int] = []

    def probe() -> int:
        calls.append(1)
        return len(calls)

    async def scenario():
        p = CachedProbe(probe, ttl=60.0)
        await p.get()
        return await p.get(force=True)

    assert asyncio.run(scenario()) == 2


def test_peek_never_runs_the_probe():
    calls: list[int] = []

    def probe() -> str:
        calls.append(1)
        return "ok"

    p = CachedProbe(probe, ttl=60.0)
    assert p.peek() is None
    assert calls == []


def test_concurrent_callers_collapse_onto_one_run():
    calls: list[int] = []

    def slow_probe() -> str:
        calls.append(1)
        time.sleep(0.2)
        return "ok"

    async def scenario():
        p = CachedProbe(slow_probe, ttl=60.0)
        return await asyncio.gather(*[p.get() for _ in range(10)])

    assert asyncio.run(scenario()) == ["ok"] * 10
    assert len(calls) == 1


def test_probe_does_not_block_the_event_loop():
    """The whole point: a 0.4 s blocking probe must not stall the loop, or
    library streaming and job polling stall with it."""

    def slow_probe() -> str:
        time.sleep(0.4)
        return "ok"

    async def scenario():
        p = CachedProbe(slow_probe, ttl=60.0)
        worst = 0.0

        async def heartbeat(stop: asyncio.Event):
            nonlocal worst
            while not stop.is_set():
                t = time.perf_counter()
                await asyncio.sleep(0.01)
                worst = max(worst, (time.perf_counter() - t) - 0.01)

        stop = asyncio.Event()
        hb = asyncio.create_task(heartbeat(stop))
        await p.get()
        stop.set()
        await hb
        return worst

    worst_stall = asyncio.run(scenario())
    # Sync-on-the-loop would park the heartbeat for the full 0.4 s.
    assert worst_stall < 0.15, f"event loop stalled {worst_stall:.3f}s"


def test_probe_constructed_outside_a_loop_binds_to_the_running_one():
    """Routers build these at import time, long before uvicorn's loop exists."""
    p = CachedProbe(lambda: "ok", ttl=60.0)
    assert asyncio.run(p.get()) == "ok"


def test_a_raising_probe_is_not_cached():
    calls: list[int] = []

    def flaky() -> str:
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("probe blew up")
        return "ok"

    async def scenario():
        p = CachedProbe(flaky, ttl=60.0)
        try:
            await p.get()
        except RuntimeError:
            pass
        return await p.get()

    assert asyncio.run(scenario()) == "ok"
    assert len(calls) == 2
