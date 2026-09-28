"""DJ-1: the analysis endpoint's concurrency cap and single-flight.

These drive the real module-level primitives in
``backend.modules.analysis.router`` with real threads, because both defects
they fix only exist under concurrency: N simultaneous ``/run`` requests used
to start N librosa decodes (the endpoint is a sync ``def``, so FastAPI puts
each on its own threadpool worker), and a deck load racing the browser sweep
on the same track decoded that track twice.
"""

from __future__ import annotations

import ast
import json
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.modules.analysis import engine as analysis_engine
from backend.modules.analysis import router as analysis_router
from backend.modules.library import router as library_router
from backend.modules.library import store as library_store


def test_single_flight_runs_one_analysis_for_concurrent_callers():
    calls: list[int] = []
    started = threading.Event()
    release = threading.Event()

    def work() -> dict:
        calls.append(1)
        started.set()
        assert release.wait(5.0)
        return {"bpm": 128.0}

    results: list[dict] = []
    errors: list[BaseException] = []

    def caller() -> None:
        try:
            results.append(analysis_engine._single_flight(("e1", "dj"), work))  # noqa: SLF001
        except BaseException as e:  # pragma: no cover - failure path
            errors.append(e)

    leader = threading.Thread(target=caller)
    leader.start()
    assert started.wait(5.0), "leader never entered the work function"
    followers = [threading.Thread(target=caller) for _ in range(5)]
    for t in followers:
        t.start()
    # Followers must be parked on the leader, not running their own analysis.
    release.set()
    for t in [leader, *followers]:
        t.join(10.0)

    assert not errors
    assert sum(calls) == 1, "a second /run for a running id started a second analysis"
    assert len(results) == 6
    assert all(r == {"bpm": 128.0} for r in results)
    # Each caller gets its own dict, so one caller cannot mutate another's.
    assert len({id(r) for r in results}) == 6
    assert analysis_engine._inflight == {}  # noqa: SLF001


def test_single_flight_never_exceeds_the_concurrency_cap():
    """Both halves of the cap, without a wall-clock race.

    The old version proved "more than one at a time" by holding each slot for
    0.25 s and hoping two threads overlapped inside that window. That is a
    timing bet, not a proof. Here the FIRST worker in refuses to leave until it
    has SEEN a second worker enter: if the cap ever serialised to one, the
    first worker waits forever and the test fails on that wait rather than on
    a lucky sample.
    """
    cap = analysis_engine.MAX_CONCURRENT_ANALYSES
    assert cap >= 2, "this test is meaningless with a cap of one"
    lock = threading.Lock()
    live = 0
    peak = 0
    second_in = threading.Event()
    overlapped = threading.Event()
    errors: list[str] = []

    def work() -> dict:
        nonlocal live, peak
        with lock:
            live += 1
            peak = max(peak, live)
            rank = live
        if rank == 1:
            # Hold the first slot until somebody else is demonstrably inside.
            if second_in.wait(10.0):
                overlapped.set()
            else:
                errors.append(
                    "no second analysis ever entered: the cap serialised to one"
                )
        else:
            second_in.set()
        with lock:
            live -= 1
        return {}

    threads = [
        threading.Thread(
            target=lambda i=i: analysis_engine._single_flight((f"e{i}", "dj"), work)  # noqa: SLF001
        )
        for i in range(cap * 4)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join(30.0)

    assert not errors, errors
    assert overlapped.is_set(), "the cap must not serialise everything down to one"
    assert peak <= cap, f"{peak} analyses ran at once with a cap of {cap}"
    assert analysis_engine._inflight == {}  # noqa: SLF001


def test_single_flight_reraises_the_leaders_error_to_followers():
    started = threading.Event()
    release = threading.Event()

    def work() -> dict:
        started.set()
        assert release.wait(5.0)
        raise RuntimeError("decode exploded")

    seen: list[BaseException] = []

    def caller() -> None:
        try:
            analysis_engine._single_flight(("boom", "full"), work)  # noqa: SLF001
        except BaseException as e:
            seen.append(e)

    leader = threading.Thread(target=caller)
    leader.start()
    assert started.wait(5.0)
    follower = threading.Thread(target=caller)
    follower.start()
    release.set()
    leader.join(10.0)
    follower.join(10.0)

    assert len(seen) == 2
    assert all(isinstance(e, RuntimeError) for e in seen)
    # A failed run must not be remembered: the next request retries.
    assert analysis_engine._inflight == {}  # noqa: SLF001
    assert analysis_engine._single_flight(("boom", "full"), lambda: {"ok": True}) == {
        "ok": True
    }


class _StubStore:
    """The narrow slice of LibraryStore the /run endpoint touches."""

    def __init__(self, audio_path: Path) -> None:
        self.db = object()
        self._audio = audio_path

    def get_entry(self, entry_id: str):
        return {"id": entry_id}

    def get_audio_path(self, entry_id: str):
        return self._audio

    def _dir_for(self, entry_id: str):
        return self._audio.parent


class _StubDbStore(_StubStore):
    """A stub store whose ``db`` is whatever the test hands it."""

    def __init__(self, db: Any, audio_path: Path | None = None) -> None:
        super().__init__(audio_path or Path("ignored.wav"))
        self.db = db


def _arm_real_library_tripwire(monkeypatch) -> None:
    """Make any fall-back to the real library resolver fail loudly.

    A stubbed store is the ONLY store these tests may reach. If any path falls
    back to ``default_library_root()``, the user's actual library is one call
    away from being opened (and analysed) -- so that call fails loudly instead
    of succeeding quietly. Patched in both modules because the router imports
    the name directly.

    Every test that stubs the store arms this; the source pin at the bottom of
    this file keeps that true for tests added later.
    """

    def _explode(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError(
            "default_library_root() was consulted: something is about to open "
            "the user's real library"
        )

    monkeypatch.setattr(library_store, "default_library_root", _explode)
    monkeypatch.setattr(library_router, "default_library_root", _explode, raising=False)


@pytest.fixture
def run_client(tmp_path: Path, monkeypatch):
    audio = tmp_path / "audio.wav"
    audio.write_bytes(b"RIFF....WAVEfmt ")
    monkeypatch.setattr(analysis_router, "get_library_store", lambda: _StubStore(audio))
    _arm_real_library_tripwire(monkeypatch)

    app = FastAPI()
    app.include_router(analysis_router.router, prefix="/api/analysis")
    return TestClient(app)


def test_run_endpoint_passes_the_dj_profile_through(run_client, monkeypatch):
    seen: dict = {}

    def fake(db, entry_id, audio_path, **kwargs):
        seen.update(kwargs)
        seen["entry_id"] = entry_id
        return {"bpm": 120.0, "profile": kwargs.get("profile")}

    monkeypatch.setattr(analysis_router, "analyze_and_persist", fake)
    r = run_client.post("/api/analysis/abc/run?profile=dj")
    assert r.status_code == 200, r.text
    assert r.json()["profile"] == "dj"
    assert seen["profile"] == "dj"


def test_run_endpoint_defaults_to_the_full_profile(run_client, monkeypatch):
    seen: dict = {}

    def fake(db, entry_id, audio_path, **kwargs):
        seen.update(kwargs)
        return {"bpm": 120.0}

    monkeypatch.setattr(analysis_router, "analyze_and_persist", fake)
    assert run_client.post("/api/analysis/abc/run").status_code == 200
    assert seen["profile"] == "full"


def test_run_endpoint_rejects_an_unknown_profile(run_client, monkeypatch):
    def fake(*a, **k):  # pragma: no cover - must never be reached
        raise AssertionError("analysis ran for an unknown profile")

    monkeypatch.setattr(analysis_router, "analyze_and_persist", fake)
    r = run_client.post("/api/analysis/abc/run?profile=everything")
    assert r.status_code == 422
    assert "everything" in r.text


# ---------------------------------------------------------------------------
# DJ-1R: the cap belongs to the ENGINE, not the endpoint, and the GET reports
# which profile wrote the row.
# ---------------------------------------------------------------------------


class _NoRowsDB:
    """A database with no ``entries`` rows.

    ``analyze_and_persist`` computes and RETURNS the analysis for an entry that
    has no row (derived/variant ids) without persisting anything, so this stub
    exercises the whole wrapper — cap, single-flight, profile — with no schema.
    """

    def __init__(self) -> None:
        self.get_entry_calls = 0

    def get_entry(self, entry_id: str):
        self.get_entry_calls += 1
        return None


def test_the_store_path_and_the_endpoint_share_one_run(tmp_path, monkeypatch):
    """The cap and single-flight were on the ENDPOINT, so the library store's
    background pass (``asyncio.to_thread(analyze_and_persist, ...)``) walked
    straight past both: a background sweep and a deck load could decode the
    same file at the same moment. Both paths enter through
    ``analyze_and_persist``, so that is where the gate has to be."""
    audio = tmp_path / "audio.wav"
    audio.write_bytes(b"RIFF....WAVEfmt ")
    db = _NoRowsDB()
    store = _StubDbStore(db, audio)
    monkeypatch.setattr(analysis_router, "get_library_store", lambda: store)
    _arm_real_library_tripwire(monkeypatch)
    app = FastAPI()
    app.include_router(analysis_router.router, prefix="/api/analysis")
    run_client = TestClient(app)

    calls: list[str] = []
    entered = threading.Event()
    release = threading.Event()

    def fake_analyze(audio_path, **kwargs):
        calls.append(kwargs.get("profile"))
        entered.set()
        assert release.wait(10.0)
        return {"bpm": 128.0, "profile": kwargs.get("profile")}

    monkeypatch.setattr(analysis_engine, "analyze_audio", fake_analyze)

    # Leader: the endpoint.
    posted: list[int] = []

    def via_endpoint() -> None:
        posted.append(
            run_client.post("/api/analysis/shared/run?profile=dj").status_code
        )

    leader = threading.Thread(target=via_endpoint)
    leader.start()
    assert entered.wait(10.0), "the endpoint never reached the analysis"

    # Follower: the store's background path, same entry and profile.
    follower_result: list[dict] = []

    def via_store() -> None:
        follower_result.append(
            analysis_engine.analyze_and_persist(db, "shared", audio, profile="dj")
        )

    follower = threading.Thread(target=via_store)
    follower.start()
    # Deterministic: wait until the follower is parked on the leader's run.
    # The table is keyed per entry: one run of an entry at a time.
    run = analysis_engine._inflight.get("shared")
    assert run is not None
    deadline = time.monotonic() + 10.0
    while run.followers < 1 and time.monotonic() < deadline:
        time.sleep(0.005)
    assert run.followers == 1, "the second caller started its own analysis"

    release.set()
    leader.join(15.0)
    follower.join(15.0)

    assert calls == ["dj"], f"the file was analysed {len(calls)} times, not once"
    assert posted == [200]
    assert follower_result[0]["bpm"] == 128.0
    assert analysis_engine._inflight == {}  # noqa: SLF001


def test_get_analysis_reports_the_profile_that_wrote_the_row(monkeypatch):
    """Without this the DJ tab's cheap row is indistinguishable from a full
    one, and the panels that show pitch/LUFS render a partial row as complete."""
    _arm_real_library_tripwire(monkeypatch)

    class _RowDB:
        def __init__(self, row):
            self._row = row

        def get_analysis(self, entry_id: str):
            return dict(self._row)

    def client_for(row):
        store = _StubDbStore(_RowDB(row))
        monkeypatch.setattr(analysis_router, "get_library_store", lambda: store)
        app = FastAPI()
        app.include_router(analysis_router.router, prefix="/api/analysis")
        return TestClient(app)

    base = {"entry_id": "x", "bpm": 128.0, "version": analysis_router.ANALYSIS_VERSION}

    dj = client_for(
        {**base, "ffprobe_json": json.dumps({analysis_engine.PROFILE_MARKER_KEY: "dj"})}
    ).get("/api/analysis/x")
    assert dj.status_code == 200, dj.text
    assert dj.json()["profile"] == "dj"

    full = client_for({**base, "ffprobe_json": json.dumps({"_summary": {}})}).get(
        "/api/analysis/x"
    )
    assert full.json()["profile"] == "full"

    # Nothing analysed yet: the pending payload says so, and claims no profile.
    class _EmptyDB:
        def get_analysis(self, entry_id: str):
            return None

    monkeypatch.setattr(
        analysis_router, "get_library_store", lambda: _StubDbStore(_EmptyDB())
    )
    app = FastAPI()
    app.include_router(analysis_router.router, prefix="/api/analysis")
    pending = TestClient(app).get("/api/analysis/x").json()
    assert pending["status"] == "pending"
    assert "profile" not in pending


# ---------------------------------------------------------------------------
# One run per entry, a bounded wait, a slot lease, and DJ runs first.
# ---------------------------------------------------------------------------


def _wait_until(predicate, timeout: float = 10.0) -> bool:
    """Poll ``predicate`` until it is true or ``timeout`` passes."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.005)
    return predicate()


def test_a_full_run_waits_for_a_dj_run_of_the_same_entry():
    """The sequence the PR allowed: the DJ tab's dj run of a track is
    decoding when the background queue asks for a full run of the same
    track. Single-flight was keyed per profile, so both ran at once, both
    read the stored row and both wrote the whole row back; whichever saved
    second decided what survived. Now the full run starts only after the dj
    run has finished."""
    live = 0
    peak = 0
    order: list[str] = []
    lock = threading.Lock()
    dj_in = threading.Event()
    release_dj = threading.Event()

    def work(name: str, gate: threading.Event | None):
        def run() -> dict:
            nonlocal live, peak
            with lock:
                live += 1
                peak = max(peak, live)
                order.append(f"{name}:start")
            if name == "dj":
                dj_in.set()
            if gate is not None:
                assert gate.wait(10.0)
            with lock:
                live -= 1
                order.append(f"{name}:end")
            return {"profile": name}

        return run

    results: dict[str, dict] = {}

    def call(profile: str, gate: threading.Event | None) -> None:
        results[profile] = analysis_engine._single_flight(
            ("one-entry", profile), work(profile, gate)
        )

    dj = threading.Thread(target=call, args=("dj", release_dj))
    dj.start()
    assert dj_in.wait(10.0)
    full = threading.Thread(target=call, args=("full", None))
    full.start()
    # Give the full caller every chance to start early; it must not.
    time.sleep(0.2)
    assert order == ["dj:start"], f"a full run overlapped the dj run: {order}"

    release_dj.set()
    dj.join(10.0)
    full.join(10.0)
    assert order == ["dj:start", "dj:end", "full:start", "full:end"]
    assert peak == 1, "two runs of one entry were live at once"
    assert results == {"dj": {"profile": "dj"}, "full": {"profile": "full"}}
    assert analysis_engine._inflight == {}


def test_a_dj_request_shares_a_running_full_run():
    """A full run measures everything a dj run does, so a deck load that
    arrives while the background queue is analysing the same track joins
    that run instead of decoding the file a second time."""
    calls: list[str] = []
    entered = threading.Event()
    release = threading.Event()

    def full_work() -> dict:
        calls.append("full")
        entered.set()
        assert release.wait(10.0)
        return {"profile": "full", "pitch_mean_hz": 440.0}

    def dj_work() -> dict:
        calls.append("dj")
        return {"profile": "dj"}

    out: list[dict] = []
    leader = threading.Thread(
        target=lambda: out.append(
            analysis_engine._single_flight(("shared-full", "full"), full_work)
        )
    )
    leader.start()
    assert entered.wait(10.0)
    follower = threading.Thread(
        target=lambda: out.append(
            analysis_engine._single_flight(("shared-full", "dj"), dj_work)
        )
    )
    follower.start()
    run = analysis_engine._inflight["shared-full"]
    assert _wait_until(lambda: run.followers == 1), "the dj request started its own run"
    release.set()
    leader.join(10.0)
    follower.join(10.0)
    assert calls == ["full"]
    assert out == [{"profile": "full", "pitch_mean_hz": 440.0}] * 2


def test_a_joined_caller_gives_up_after_the_wait_limit(monkeypatch):
    """A leader stuck in the ffmpeg fallback decode (up to 600 s) used to hold
    every caller that joined it for as long as it took. A follower now waits
    FOLLOWER_WAIT_S and then raises AnalysisBusy; the leader is untouched."""
    monkeypatch.setattr(analysis_engine, "FOLLOWER_WAIT_S", 0.3)
    entered = threading.Event()
    release = threading.Event()

    def stuck() -> dict:
        entered.set()
        assert release.wait(10.0)
        return {"bpm": 90.0}

    leader_out: list[dict] = []
    leader = threading.Thread(
        target=lambda: leader_out.append(
            analysis_engine._single_flight(("stuck", "dj"), stuck)
        )
    )
    leader.start()
    try:
        assert entered.wait(10.0)
        started = time.monotonic()
        with pytest.raises(analysis_engine.AnalysisBusy):
            analysis_engine._single_flight(("stuck", "dj"), stuck)
        waited = time.monotonic() - started
        assert 0.2 <= waited < 5.0, f"the follower waited {waited:.2f} s"
    finally:
        release.set()
        leader.join(10.0)
    assert leader_out == [{"bpm": 90.0}], "giving up must not cancel the leader"
    assert analysis_engine._inflight == {}


def test_a_stuck_run_gives_its_slot_back_after_the_lease(monkeypatch):
    """Two stuck runs used to hold both slots, and every other analysis in
    the process waited behind them. After SLOT_LEASE_S the gate hands a
    stuck run's slot to the next caller; the stuck run carries on."""
    monkeypatch.setattr(analysis_engine, "SLOT_LEASE_S", 0.3)
    cap = analysis_engine.MAX_CONCURRENT_ANALYSES
    release = threading.Event()
    stuck_in = threading.Semaphore(0)

    def stuck() -> dict:
        stuck_in.release()
        assert release.wait(15.0)
        return {}

    holders = [
        threading.Thread(
            target=lambda i=i: analysis_engine._single_flight(
                (f"lease-{i}", "full"), stuck
            )
        )
        for i in range(cap)
    ]
    for t in holders:
        t.start()
    for _ in range(cap):
        assert stuck_in.acquire(timeout=10.0), "the stuck runs never took their slots"

    later_ran = threading.Event()

    def later() -> dict:
        later_ran.set()
        return {"ok": True}

    try:
        result: list[dict] = []
        waiter = threading.Thread(
            target=lambda: result.append(
                analysis_engine._single_flight(("lease-next", "full"), later)
            )
        )
        waiter.start()
        assert later_ran.wait(10.0), (
            "every slot stayed held by a stuck run: the next analysis never started"
        )
        waiter.join(10.0)
        assert result == [{"ok": True}]
    finally:
        release.set()
        for t in holders:
            t.join(15.0)
    assert analysis_engine._inflight == {}


def test_dj_runs_take_the_next_slot_ahead_of_full_runs():
    """A deck load's quick dj run used to wait behind whatever full runs the
    background queue or the LOOM shard pipeline had queued first. With both
    slots busy, a full caller that queued FIRST and a dj caller that queued
    SECOND: the next free slot goes to the dj caller."""
    cap = analysis_engine.MAX_CONCURRENT_ANALYSES
    releases = [threading.Event() for _ in range(cap)]
    busy_in = threading.Semaphore(0)
    started: list[str] = []
    lock = threading.Lock()

    def busy(i: int):
        def run() -> dict:
            busy_in.release()
            assert releases[i].wait(15.0)
            return {}

        return run

    def record(name: str):
        def run() -> dict:
            with lock:
                started.append(name)
            return {}

        return run

    holders = [
        threading.Thread(
            target=lambda i=i: analysis_engine._single_flight(
                (f"busy-{i}", "full"), busy(i)
            )
        )
        for i in range(cap)
    ]
    for t in holders:
        t.start()
    for _ in range(cap):
        assert busy_in.acquire(timeout=10.0)

    gate = analysis_engine._gate
    full_waiter = threading.Thread(
        target=lambda: analysis_engine._single_flight(
            ("queued-full", "full"), record("full")
        )
    )
    full_waiter.start()
    assert _wait_until(lambda: len(gate._lines[1]) == 1), "the full caller never queued"
    dj_waiter = threading.Thread(
        target=lambda: analysis_engine._single_flight(("queued-dj", "dj"), record("dj"))
    )
    dj_waiter.start()
    assert _wait_until(lambda: len(gate._lines[0]) == 1), "the dj caller never queued"

    try:
        releases[0].set()
        assert _wait_until(lambda: len(started) >= 1)
        assert started[0] == "dj", f"the free slot went to {started[0]} first"
    finally:
        for r in releases:
            r.set()
        for t in [*holders, full_waiter, dj_waiter]:
            t.join(15.0)
    assert sorted(started) == ["dj", "full"]
    assert analysis_engine._inflight == {}


def test_a_dj_request_that_joins_a_queued_full_run_moves_it_to_the_front():
    """The sequence: two full runs hold both slots, the background queue has
    queued a full run of another track and then one of track X, and the user
    loads X on a deck. The dj request joins X's full run (it answers a dj
    caller), and that run sat in the ordinary line, so the deck waited behind
    every full run queued before it. Now the join moves X's run to the
    priority line and it takes the next free slot."""
    cap = analysis_engine.MAX_CONCURRENT_ANALYSES
    releases = [threading.Event() for _ in range(cap)]
    busy_in = threading.Semaphore(0)
    started: list[str] = []
    lock = threading.Lock()

    def busy(i: int):
        def run() -> dict:
            busy_in.release()
            assert releases[i].wait(15.0)
            return {}

        return run

    def record(name: str):
        def run() -> dict:
            with lock:
                started.append(name)
            return {"profile": "full", "name": name}

        return run

    def never() -> dict:
        with lock:
            started.append("dj-own-run")
        return {}

    holders = [
        threading.Thread(
            target=lambda i=i: analysis_engine._single_flight(
                (f"promote-busy-{i}", "full"), busy(i)
            )
        )
        for i in range(cap)
    ]
    for t in holders:
        t.start()
    for _ in range(cap):
        assert busy_in.acquire(timeout=10.0)

    gate = analysis_engine._gate
    other = threading.Thread(
        target=lambda: analysis_engine._single_flight(
            ("promote-other", "full"), record("other")
        )
    )
    other.start()
    assert _wait_until(lambda: len(gate._lines[1]) == 1), (
        "the first full run never queued"
    )
    track_x = threading.Thread(
        target=lambda: analysis_engine._single_flight(
            ("promote-x", "full"), record("x")
        )
    )
    track_x.start()
    assert _wait_until(lambda: len(gate._lines[1]) == 2), "X's full run never queued"

    deck: list[dict] = []
    dj = threading.Thread(
        target=lambda: deck.append(
            analysis_engine._single_flight(("promote-x", "dj"), never)
        )
    )
    dj.start()
    run = analysis_engine._inflight["promote-x"]
    assert _wait_until(lambda: run.followers == 1), "the dj request did not join X"
    assert _wait_until(lambda: len(gate._lines[0]) == 1), (
        "joining X's queued full run left it in the ordinary line"
    )

    try:
        releases[0].set()
        assert _wait_until(lambda: len(started) >= 1)
        assert started[0] == "x", f"the free slot went to {started[0]} first"
        dj.join(10.0)
        assert deck == [{"profile": "full", "name": "x"}]
    finally:
        for r in releases:
            r.set()
        for t in [*holders, other, track_x, dj]:
            t.join(15.0)
    assert sorted(started) == ["other", "x"]
    assert analysis_engine._inflight == {}
    assert gate._lines == (deque(), deque())


def test_run_endpoint_answers_503_when_the_entry_is_still_busy(run_client, monkeypatch):
    """A joined caller that gives up is a retryable 'busy', not a 500."""
    _arm_real_library_tripwire(monkeypatch)

    def busy(*_a, **_k):
        raise analysis_engine.AnalysisBusy("analysis of 'abc' is still running")

    monkeypatch.setattr(analysis_router, "analyze_and_persist", busy)
    r = run_client.post("/api/analysis/abc/run?profile=dj")
    assert r.status_code == 503
    assert "still running" in r.json()["detail"]


#: Spelled as constants so the scanner's OWN source carries neither marker and
#: needs no self-exclusion.
_STORE_STUB_MARKER = "get_library_store"
_TRIPWIRE_MARKER = "_arm_real_library_tripwire("

#: A scanner that only looked at ``tree.body`` saw neither an ``async def``
#: test nor one grouped inside a class. Both are one refactor away, and an
#: unseen test is an unarmed one.
_SCANNER_SAMPLE = """
class TestGroup:
    def test_nested(self, monkeypatch):
        monkeypatch.setattr(mod, "get_library_store", lambda: stub)


async def test_async(monkeypatch):
    monkeypatch.setattr(mod, "get_library_store", lambda: stub)


def test_armed(monkeypatch):
    monkeypatch.setattr(mod, "get_library_store", lambda: stub)
    _arm_real_library_tripwire(monkeypatch)


def test_with_a_closure(monkeypatch):
    _arm_real_library_tripwire(monkeypatch)

    def client_for(row):
        monkeypatch.setattr(mod, "get_library_store", lambda: stub)
"""


def _unarmed_store_stubbing_tests(source: str) -> list[str]:
    """Names of the tests in ``source`` that stub the store without arming the
    tripwire.

    Scans every named scope -- module level, inside a class, sync or async.
    Functions nested INSIDE one of those are deliberately not scanned as
    scopes of their own: they are part of their enclosing test's source, so a
    closure that stubs the store is covered by the test that owns it.
    """
    tree = ast.parse(source)
    containers: list[Any] = [
        tree,
        *(n for n in ast.walk(tree) if isinstance(n, ast.ClassDef)),
    ]
    unarmed: list[str] = []
    for container in containers:
        for node in container.body:
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            segment = ast.get_source_segment(source, node) or ""
            if _STORE_STUB_MARKER in segment and _TRIPWIRE_MARKER not in segment:
                unarmed.append(node.name)
    return unarmed


def test_every_test_that_stubs_the_store_arms_the_real_library_tripwire():
    """The tripwire is the guard that keeps these tests off the user's real
    library, so it belongs to every test that stubs the store -- not only to
    the one fixture that happened to be written first. Tests added later built
    their own app and stubbed only the store, leaving the real resolver one
    fallback away from being consulted."""
    # The scanner itself first: a pin that cannot SEE a test is not a pin.
    assert sorted(_unarmed_store_stubbing_tests(_SCANNER_SAMPLE)) == [
        "test_async",
        "test_nested",
    ]

    unarmed = _unarmed_store_stubbing_tests(Path(__file__).read_text(encoding="utf-8"))
    assert not unarmed, (
        f"these stub the library store without arming the tripwire: {unarmed}"
    )
