"""
Isolated concurrency tests for the Claude persistent SSE stream lock.

These exercise ``_stream_claude`` (the dispatcher that holds the per-session
serialization lock) and ``_stream_claude_persistent``'s drain-on-disconnect
path. Everything is faked: ``_stream_claude_persistent`` is monkeypatched with a
fake async generator for the dispatcher tests, and the drain test drives a fake
subprocess with an in-memory stdout. No real Claude CLI subprocess is spawned.

Async behavior is driven with ``asyncio.run`` inside plain pytest functions so
the suite needs no pytest-asyncio / anyio plugin configuration.

SCOPE NOTE (T07 of ``orchestration/plans/P-20260915-bcc-assistant.md``): the
spawn-per-message dispatcher these tests pin was MOVED VERBATIM out of
``backend/assistant_routes.py`` into
``backend/deprecated/assistant_claude_spawn_20260915.py`` when the live Claude
path moved to the persistent session engine. The assertions below are unchanged
— only the module they are imported from moved — so the concurrency behaviour of
that code stays verifiable instead of being silently dropped. The CURRENT Claude
path is covered by ``tests/test_assistant_routes_claude.py`` and
``tests/test_assistant_claude_session.py``.
"""

import asyncio
import gc
import json
import time

import pytest

from backend.assistant_routes import ChatMessage, ChatRequest
from backend.deprecated import assistant_claude_spawn_20260915 as ar


# ---------------------------------------------------------------------------
# Fakes and helpers
# ---------------------------------------------------------------------------
class FakeRequest:
    """Minimal stand-in for a Starlette Request, disconnect flag only."""

    def __init__(self, disconnected=False):
        self._disconnected = disconnected

    async def is_disconnected(self) -> bool:
        return self._disconnected


class FakeStdout:
    """
    In-memory async StreamReader-like object: readline() pops queued lines.

    When ``gate`` is supplied, readline() parks until the gate is set (and sets
    ``parked``), which lets a test cancel a turn while it is mid-read.
    """

    def __init__(self, lines: list[bytes], gate=None, parked=None, gate_after=0):
        self._lines = list(lines)
        self._gate = gate
        self._parked = parked
        self._gate_after = gate_after
        self.served = 0

    async def readline(self) -> bytes:
        if (
            self._gate is not None
            and self.served >= self._gate_after
            and not self._gate.is_set()
        ):
            if self._parked is not None:
                self._parked.set()
            await self._gate.wait()
        self.served += 1
        await asyncio.sleep(0)
        if self._lines:
            return self._lines.pop(0)
        return b""  # EOF

    def at_eof(self) -> bool:
        return not self._lines


class FakeStdin:
    def __init__(self):
        self.written: list[bytes] = []

    def write(self, data: bytes) -> None:
        self.written.append(data)

    async def drain(self) -> None:
        await asyncio.sleep(0)


class FakeStderr:
    def __init__(self, data: bytes = b""):
        self._data = data

    async def read(self) -> bytes:
        await asyncio.sleep(0)
        return self._data


class FakeProcess:
    """Fake asyncio subprocess: live (returncode None) with fake stdio."""

    def __init__(
        self,
        stdout_lines: list[bytes],
        exit_code=None,
        stderr=b"",
        gate=None,
        parked=None,
        gate_after=0,
    ):
        self.returncode = None
        self.stdout = FakeStdout(
            stdout_lines, gate=gate, parked=parked, gate_after=gate_after
        )
        self.stdin = FakeStdin()
        self.stderr = FakeStderr(stderr)
        self._exit_code = exit_code

    async def wait(self) -> int:
        """Resolve immediately so _claude_exit_detail does not stall the test."""
        await asyncio.sleep(0)
        if self._exit_code is not None:
            self.returncode = self._exit_code
        return self.returncode

    def terminate(self) -> None:
        self.returncode = self._exit_code if self._exit_code is not None else -15


class CountingDisconnect:
    """is_disconnected() that returns True only from the Nth poll onward."""

    def __init__(self, true_from_poll: int):
        self._true_from_poll = true_from_poll
        self.polls = 0

    async def is_disconnected(self) -> bool:
        self.polls += 1
        return self.polls >= self._true_from_poll


def _req(claude_session_id=None, conversation_id=None, text="hello"):
    return ChatRequest(
        messages=[ChatMessage(role="user", content=text)],
        conversationId=conversation_id,
        claudeSessionId=claude_session_id,
        claudeMode="interactive",
    )


async def _collect(agen) -> list:
    return [frame async for frame in agen]


@pytest.fixture(autouse=True)
def _isolate_claude_state():
    """Reset module-level Claude session state around every test."""
    for store in (
        ar._claude_stream_locks,
        ar._claude_processes,
        ar._claude_process_configs,
        ar._claude_crash_log,
        ar._claude_drain_tasks,
        ar._claude_drain_task_refs,
    ):
        store.clear()
    ar._stable_audio_skill_bootstrapped_sessions.clear()
    yield
    for store in (
        ar._claude_stream_locks,
        ar._claude_processes,
        ar._claude_process_configs,
        ar._claude_crash_log,
        ar._claude_drain_tasks,
        ar._claude_drain_task_refs,
    ):
        store.clear()
    ar._stable_audio_skill_bootstrapped_sessions.clear()


# ---------------------------------------------------------------------------
# (a) Two concurrent requests for the same stable id are serialized.
# ---------------------------------------------------------------------------
def test_same_stable_id_requests_are_serialized(monkeypatch):
    in_flight = 0
    max_in_flight = 0
    started = 0

    async def fake_persistent(req, request):
        nonlocal in_flight, max_in_flight, started
        started += 1
        in_flight += 1
        max_in_flight = max(max_in_flight, in_flight)
        try:
            yield ar._sse_frame({"type": "text_delta", "delta": "hi"})
            await asyncio.sleep(0.05)
            yield ar._sse_frame(
                {"type": "done", "usage": {"prompt_tokens": 0, "completion_tokens": 0}}
            )
        finally:
            in_flight -= 1

    monkeypatch.setattr(ar, "_stream_claude_persistent", fake_persistent)

    async def run():
        r = FakeRequest()
        t1 = asyncio.create_task(_collect(ar._stream_claude(_req("sess-a"), r)))
        # Give the first request time to acquire the lock before the second.
        await asyncio.sleep(0.01)
        t2 = asyncio.create_task(_collect(ar._stream_claude(_req("sess-a"), r)))
        return await asyncio.gather(t1, t2)

    frames1, frames2 = asyncio.run(run())

    # The two turns never overlapped, and both produced their done frame.
    assert max_in_flight == 1
    assert started == 2
    assert any('"type": "done"' in f for f in frames1)
    assert any('"type": "done"' in f for f in frames2)
    # Lock released after both turns (setdefault created exactly one).
    assert set(ar._claude_stream_locks) == {"sess-a"}
    assert not ar._claude_stream_locks["sess-a"].locked()


# ---------------------------------------------------------------------------
# (b) A request with no ids acquires no lock and leaves the dict untouched.
# ---------------------------------------------------------------------------
def test_anonymous_request_uses_no_lock(monkeypatch):
    async def fake_persistent(req, request):
        yield ar._sse_frame({"type": "text_delta", "delta": "anon"})
        yield ar._sse_frame(
            {"type": "done", "usage": {"prompt_tokens": 0, "completion_tokens": 0}}
        )

    monkeypatch.setattr(ar, "_stream_claude_persistent", fake_persistent)

    frames = asyncio.run(_collect(ar._stream_claude(_req(None, None), FakeRequest())))

    assert any('"delta": "anon"' in f for f in frames)
    assert any('"type": "done"' in f for f in frames)
    # No lock was ever inserted for an anonymous request.
    assert ar._claude_stream_locks == {}


# ---------------------------------------------------------------------------
# (c) A queued request yields the status frame and at least one ping.
# ---------------------------------------------------------------------------
def test_queued_request_yields_status_and_ping(monkeypatch):
    # Shrink the keepalive so the queued acquire times out quickly and pings.
    monkeypatch.setattr(ar, "KEEPALIVE_INTERVAL", 0.02)

    first_acquired = asyncio.Event()
    release_first = asyncio.Event()

    async def fake_persistent(req, request):
        # Signal that this (first) turn holds the lock, then hold it until told.
        first_acquired.set()
        yield ar._sse_frame({"type": "text_delta", "delta": "first"})
        await release_first.wait()
        yield ar._sse_frame(
            {"type": "done", "usage": {"prompt_tokens": 0, "completion_tokens": 0}}
        )

    monkeypatch.setattr(ar, "_stream_claude_persistent", fake_persistent)

    async def run():
        r = FakeRequest()
        t1 = asyncio.create_task(_collect(ar._stream_claude(_req("sess-c"), r)))
        await asyncio.wait_for(first_acquired.wait(), timeout=1.0)
        # Second request must now queue behind the lock and emit pings.
        t2 = asyncio.create_task(_collect(ar._stream_claude(_req("sess-c"), r)))
        # Let the queued request time out at least twice on the tiny keepalive.
        await asyncio.sleep(0.1)
        release_first.set()
        return await asyncio.gather(t1, t2)

    _frames1, frames2 = asyncio.run(run())

    # First frame of the queued request is the queued-status frame.
    assert '"message": "queued behind the current turn"' in frames2[0]
    # At least one keepalive ping was emitted while blocked.
    assert any(f == ": ping\n\n" for f in frames2)
    # And it eventually ran and completed once the lock freed.
    assert any('"type": "done"' in f for f in frames2)


# ---------------------------------------------------------------------------
# (d) Lock released on early consumer aclose and when the inner gen raises.
# ---------------------------------------------------------------------------
def test_lock_released_on_early_aclose(monkeypatch):
    async def fake_persistent(req, request):
        yield ar._sse_frame({"type": "text_delta", "delta": "one"})
        await asyncio.sleep(0.05)
        yield ar._sse_frame(
            {"type": "done", "usage": {"prompt_tokens": 0, "completion_tokens": 0}}
        )

    monkeypatch.setattr(ar, "_stream_claude_persistent", fake_persistent)

    async def run():
        gen = ar._stream_claude(_req("sess-d1"), FakeRequest())
        first = await gen.__anext__()  # acquires lock, yields first frame
        await gen.aclose()  # throws GeneratorExit at the yield point
        return first

    first = asyncio.run(run())

    assert '"delta": "one"' in first
    assert not ar._claude_stream_locks["sess-d1"].locked()


def test_lock_released_when_inner_generator_raises(monkeypatch):
    async def fake_persistent(req, request):
        yield ar._sse_frame({"type": "text_delta", "delta": "boom"})
        raise RuntimeError("inner failure")

    monkeypatch.setattr(ar, "_stream_claude_persistent", fake_persistent)

    async def run():
        with pytest.raises(RuntimeError, match="inner failure"):
            await _collect(ar._stream_claude(_req("sess-d2"), FakeRequest()))

    asyncio.run(run())

    assert not ar._claude_stream_locks["sess-d2"].locked()


# ---------------------------------------------------------------------------
# (e) Drain-on-disconnect: consume through the result without yielding.
# ---------------------------------------------------------------------------
def test_drain_on_disconnect_consumes_to_result(monkeypatch):
    session_id = "sess-e"

    leftover = (
        json.dumps(
            {
                "type": "content_block_delta",
                "delta": {"type": "text_delta", "text": "LEFTOVER"},
            }
        ).encode("utf-8")
        + b"\n"
    )
    result_line = (
        json.dumps(
            {"type": "result", "usage": {"input_tokens": 3, "output_tokens": 4}}
        ).encode("utf-8")
        + b"\n"
    )
    # A trailing line proves the drain stops at the result and does not over-read.
    trailing = (
        json.dumps(
            {
                "type": "content_block_delta",
                "delta": {"type": "text_delta", "text": "NEXT_TURN"},
            }
        ).encode("utf-8")
        + b"\n"
    )

    fake_proc = FakeProcess([leftover, result_line, trailing])
    ar._claude_processes[session_id] = fake_proc
    # Match desired config so the persistent path reuses this fake process.
    desired = (
        ar._resolve_claude_model(_req(session_id)),
        ar._resolve_claude_effort(_req(session_id)),
    )
    ar._claude_process_configs[session_id] = desired

    # Disconnected by the time the read loop starts → immediate drain.
    request = FakeRequest(disconnected=True)

    frames = asyncio.run(
        _collect(ar._stream_claude_persistent(_req(session_id), request))
    )

    # Nothing from the drained turn was yielded to the (gone) client.
    assert not any("LEFTOVER" in f for f in frames)
    assert not any("NEXT_TURN" in f for f in frames)
    # The result line was consumed, so the trailing line is left for the next
    # turn — drain stopped exactly at `done`.
    assert fake_proc.stdout._lines == [trailing]
    # Process kept alive for the next message (drain saw `done`, no cleanup).
    assert ar._claude_processes.get(session_id) is fake_proc


# ---------------------------------------------------------------------------
# (i) Disconnect WHILE QUEUED: abandon without acquiring or releasing.
# ---------------------------------------------------------------------------
def test_disconnect_while_queued_abandons_without_acquiring(monkeypatch):
    monkeypatch.setattr(ar, "KEEPALIVE_INTERVAL", 0.02)

    first_acquired = asyncio.Event()
    release_first = asyncio.Event()

    async def fake_persistent(req, request):
        first_acquired.set()
        yield ar._sse_frame({"type": "text_delta", "delta": "first"})
        await release_first.wait()
        yield ar._sse_frame(
            {"type": "done", "usage": {"prompt_tokens": 0, "completion_tokens": 0}}
        )

    monkeypatch.setattr(ar, "_stream_claude_persistent", fake_persistent)

    async def run():
        t1 = asyncio.create_task(
            _collect(ar._stream_claude(_req("sess-i"), FakeRequest()))
        )
        await asyncio.wait_for(first_acquired.wait(), timeout=1.0)
        # Queued consumer goes away: False on poll 1, True on poll 2.
        gone = CountingDisconnect(true_from_poll=2)
        queued = await _collect(ar._stream_claude(_req("sess-i"), gone))
        # Lock must still be held by turn 1 and NOT released by the abandoner.
        still_locked = ar._claude_stream_locks["sess-i"].locked()
        release_first.set()
        await t1
        return queued, still_locked, gone.polls

    queued, still_locked, polls = asyncio.run(run())

    # Emitted the queued status, then pinged once, then abandoned.
    assert '"message": "queued behind the current turn"' in queued[0]
    assert queued.count(": ping\n\n") == 1
    assert polls == 2
    # It never acquired, so it must never have released turn 1's lock.
    assert still_locked is True
    # Turn 1 owned the lock throughout and released it exactly once at the end.
    assert not ar._claude_stream_locks["sess-i"].locked()


# ---------------------------------------------------------------------------
# (ii) Drain terminal path: EOF pops the process and records a crash.
# ---------------------------------------------------------------------------
def test_drain_on_disconnect_eof_cleans_up_process():
    session_id = "sess-eof"
    fake_proc = FakeProcess([], exit_code=1, stderr=b"claude blew up")
    ar._claude_processes[session_id] = fake_proc
    ar._claude_process_configs[session_id] = (
        ar._resolve_claude_model(_req(session_id)),
        ar._resolve_claude_effort(_req(session_id)),
    )

    asyncio.run(
        _collect(
            ar._stream_claude_persistent(
                _req(session_id), FakeRequest(disconnected=True)
            )
        )
    )

    # EOF during drain → dead process cleaned up so the next turn respawns.
    assert session_id not in ar._claude_processes
    assert session_id not in ar._claude_process_configs
    assert len(ar._claude_crash_log.get(session_id, [])) == 1


# ---------------------------------------------------------------------------
# Shared fixtures for the cancellation-handoff tests
# ---------------------------------------------------------------------------
def _delta_line(text: str) -> bytes:
    return (
        json.dumps(
            {
                "type": "content_block_delta",
                "delta": {"type": "text_delta", "text": text},
            }
        ).encode("utf-8")
        + b"\n"
    )


def _result_line() -> bytes:
    return (
        json.dumps(
            {"type": "result", "usage": {"input_tokens": 1, "output_tokens": 2}}
        ).encode("utf-8")
        + b"\n"
    )


def _install_fake_process(session_id: str, lines, gate=None, parked=None, gate_after=0):
    proc = FakeProcess(lines, gate=gate, parked=parked, gate_after=gate_after)
    ar._claude_processes[session_id] = proc
    ar._claude_process_configs[session_id] = (
        ar._resolve_claude_model(_req(session_id)),
        ar._resolve_claude_effort(_req(session_id)),
    )
    return proc


async def _settle():
    """Let scheduled done-callbacks run."""
    for _ in range(5):
        await asyncio.sleep(0)


def _count_releases(monkeypatch) -> list:
    """
    Record every _release_quietly call.

    Necessary because _release_quietly swallows RuntimeError, so a double release
    would otherwise be invisible.
    """
    releases: list = []
    real_release = ar._release_quietly

    def counting_release(lock):
        releases.append(lock)
        real_release(lock)

    monkeypatch.setattr(ar, "_release_quietly", counting_release)
    return releases


# ---------------------------------------------------------------------------
# (iii) CancelledError mid-turn → detached drain finishes, THEN lock releases.
# ---------------------------------------------------------------------------
def test_cancelled_turn_drains_via_detached_task(monkeypatch):
    session_id = "sess-iii"
    leftover = _delta_line("LEFTOVER")
    result_line = _result_line()
    trailing = _delta_line("NEXT_TURN")

    releases = _count_releases(monkeypatch)

    async def run():
        gate = asyncio.Event()
        parked = asyncio.Event()
        proc = _install_fake_process(
            session_id, [leftover, result_line, trailing], gate=gate, parked=parked
        )

        async def consume():
            async for _frame in ar._stream_claude(_req(session_id), FakeRequest()):
                pass

        task = asyncio.create_task(consume())
        # Wait until the turn is parked mid-read, holding the lock.
        await asyncio.wait_for(parked.wait(), timeout=2.0)
        lock = ar._claude_stream_locks[session_id]
        assert lock.locked()

        # Simulate Starlette cancelling stream_response on http.disconnect.
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        await _settle()

        # Handoff happened: dispatcher popped the token, strong ref anchored,
        # and the lock is STILL held so no queued turn can read stdout yet.
        assert ar._claude_drain_tasks == {}
        assert len(ar._claude_drain_task_refs) == 1
        drain_task = next(iter(ar._claude_drain_task_refs))
        assert lock.locked()
        assert releases == []

        # Let the drain read: it consumes leftover + result, then releases.
        gate.set()
        await asyncio.wait_for(drain_task, timeout=3.0)
        await _settle()

        assert not lock.locked()
        assert ar._claude_drain_task_refs == set()
        return proc

    proc = asyncio.run(run())

    # Drain stopped exactly at `done`; the next turn's line is untouched.
    assert proc.stdout._lines == [trailing]
    # Released exactly once, by the drain's done-callback.
    assert len(releases) == 1
    # Process kept alive for the next message.
    assert ar._claude_processes.get(session_id) is proc


# ---------------------------------------------------------------------------
# (iv) End-to-end: queued turn 2 runs only after turn 1's drain, sees only
#      its own frames.
# ---------------------------------------------------------------------------
def test_queued_turn_reads_only_its_own_frames_after_drain(monkeypatch):
    session_id = "sess-iv"
    t1_leftover = _delta_line("TURN1_LEFTOVER")
    t1_result = _result_line()
    t2_delta = _delta_line("TURN2_OWN")
    t2_result = _result_line()

    releases = _count_releases(monkeypatch)

    async def run():
        gate = asyncio.Event()
        parked = asyncio.Event()
        _install_fake_process(
            session_id,
            [t1_leftover, t1_result, t2_delta, t2_result],
            gate=gate,
            parked=parked,
        )

        async def consume_first():
            async for _frame in ar._stream_claude(_req(session_id), FakeRequest()):
                pass

        t1 = asyncio.create_task(consume_first())
        await asyncio.wait_for(parked.wait(), timeout=2.0)

        # Turn 2 arrives while turn 1 holds the lock → queues.
        t2 = asyncio.create_task(
            _collect(ar._stream_claude(_req(session_id), FakeRequest()))
        )
        await asyncio.sleep(0.01)

        # Turn 1's client disconnects (cancellation), handing off the drain.
        t1.cancel()
        with pytest.raises(asyncio.CancelledError):
            await t1
        await _settle()

        # Turn 2 must still be queued: the drain holds the lock.
        assert not t2.done()
        gate.set()
        frames2 = await asyncio.wait_for(t2, timeout=5.0)
        await _settle()
        return frames2

    frames2 = asyncio.run(run())

    # Turn 2 saw ONLY its own frames — never turn 1's leftover.
    assert any("TURN2_OWN" in f for f in frames2)
    assert not any("TURN1_LEFTOVER" in f for f in frames2)
    assert any('"type": "done"' in f for f in frames2)
    assert '"message": "queued behind the current turn"' in frames2[0]
    # Lock free again afterwards.
    assert not ar._claude_stream_locks[session_id].locked()
    # Exactly two releases total (turn 1's drain, then turn 2) — a double release
    # cannot hide behind _release_quietly's RuntimeError swallow.
    assert len(releases) == 2


# ---------------------------------------------------------------------------
# (v) A drain already finished at finally-time releases immediately and pops.
# ---------------------------------------------------------------------------
def test_finished_drain_at_finally_releases_immediately(monkeypatch):
    session_id = "sess-v"

    async def _already_done():
        return None

    async def fake_persistent(req, request):
        # Register a task that is already complete, as if the drain finished
        # before the dispatcher's finally ran.
        task = asyncio.create_task(_already_done())
        await asyncio.sleep(0)
        assert task.done()
        ar._claude_drain_tasks[session_id] = task
        yield ar._sse_frame(
            {"type": "done", "usage": {"prompt_tokens": 0, "completion_tokens": 0}}
        )

    monkeypatch.setattr(ar, "_stream_claude_persistent", fake_persistent)

    asyncio.run(_collect(ar._stream_claude(_req(session_id), FakeRequest())))

    # Entry popped (exactly-once) and the lock released synchronously.
    assert ar._claude_drain_tasks == {}
    assert not ar._claude_stream_locks[session_id].locked()


# ---------------------------------------------------------------------------
# (vi) Strong reference keeps the detached drain alive across gc.collect().
# ---------------------------------------------------------------------------
def test_detached_drain_survives_gc_while_running():
    session_id = "sess-vi"
    leftover = _delta_line("LEFTOVER")
    result_line = _result_line()

    async def run():
        gate = asyncio.Event()
        parked = asyncio.Event()
        _install_fake_process(
            session_id, [leftover, result_line], gate=gate, parked=parked
        )

        async def consume():
            async for _frame in ar._stream_claude(_req(session_id), FakeRequest()):
                pass

        task = asyncio.create_task(consume())
        await asyncio.wait_for(parked.wait(), timeout=2.0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        await _settle()

        # Strong ref anchored while draining; drop every local handle and force a
        # collection — the task must survive and still complete.
        assert len(ar._claude_drain_task_refs) == 1
        gc.collect()
        assert len(ar._claude_drain_task_refs) == 1
        drain_task = next(iter(ar._claude_drain_task_refs))
        assert not drain_task.done()

        gate.set()
        await asyncio.wait_for(drain_task, timeout=3.0)
        await _settle()
        # Empty after: handoff token popped by the dispatcher, anchor self-removed.
        assert ar._claude_drain_tasks == {}
        assert ar._claude_drain_task_refs == set()

    asyncio.run(run())

    assert not ar._claude_stream_locks[session_id].locked()


# ---------------------------------------------------------------------------
# (R2-a) GeneratorExit at the yield (consumer aclose, NO cancellation) must
#        still hand off the drain. This is the path Starlette takes when the
#        cancellation lands on `await send(...)` instead of our readline().
# ---------------------------------------------------------------------------
def test_generator_close_hands_off_drain(monkeypatch):
    session_id = "sess-close"
    t1_leftover = _delta_line("TURN1_LEFTOVER")
    t1_result = _result_line()
    t2_delta = _delta_line("TURN2_OWN")
    t2_result = _result_line()

    releases = _count_releases(monkeypatch)

    async def run():
        gate = asyncio.Event()
        parked = asyncio.Event()
        # gate_after=1: the first readline serves t1_leftover immediately, so the
        # generator suspends at an in-loop yield; every later read parks, which
        # holds the detached drain open long enough to observe the lock.
        proc = _install_fake_process(
            session_id,
            [t1_leftover, t1_result, t2_delta, t2_result],
            gate=gate,
            parked=parked,
            gate_after=1,
        )

        # Turn 1: pull frames until the generator is suspended at a yield INSIDE
        # the read loop, then aclose(). NO cancellation is delivered anywhere —
        # this is the pure GeneratorExit finalization path.
        gen = ar._stream_claude(_req(session_id), FakeRequest())
        await gen.__anext__()  # "thinking..." status; lock acquired
        lock = ar._claude_stream_locks[session_id]
        assert lock.locked()

        frame = await gen.__anext__()  # t1_leftover → suspended in-loop
        assert "TURN1_LEFTOVER" in frame

        await gen.aclose()  # GeneratorExit at the in-loop yield
        await _settle()

        # Handoff happened on the close path, and the lock is still held.
        assert len(ar._claude_drain_task_refs) == 1
        drain_task = next(iter(ar._claude_drain_task_refs))
        assert lock.locked()
        assert releases == []

        # Turn 2 queues, then runs only after the drain finishes.
        t2 = asyncio.create_task(
            _collect(ar._stream_claude(_req(session_id), FakeRequest()))
        )
        await asyncio.sleep(0.01)
        assert not t2.done()

        gate.set()
        await asyncio.wait_for(drain_task, timeout=3.0)
        frames2 = await asyncio.wait_for(t2, timeout=5.0)
        await _settle()
        return proc, frames2

    proc, frames2 = asyncio.run(run())

    # Drain consumed turn 1's leftover + result; turn 2 saw only its own frames.
    assert any("TURN2_OWN" in f for f in frames2)
    assert not any("TURN1_LEFTOVER" in f for f in frames2)
    assert any('"type": "done"' in f for f in frames2)
    assert proc.stdout._lines == []
    # One release for the drain handoff, one for turn 2 — never a double.
    assert len(releases) == 2


def test_close_at_thinking_yield_hands_off_drain(monkeypatch):
    """
    A close landing on the pre-loop "thinking..." yield must still hand off.

    The prompt is already written+drained to stdin at that point, so Claude WILL
    produce frames for this turn; abandoning them would offset every later turn in
    the session by one.
    """
    session_id = "sess-thinking-close"
    leftover = _delta_line("TURN1_LEFTOVER")
    result_line = _result_line()
    trailing = _delta_line("NEXT_TURN")
    releases = _count_releases(monkeypatch)

    async def run():
        gate = asyncio.Event()
        parked = asyncio.Event()
        # gate_after=0: the drain parks on its very first read, so the handoff is
        # observable (ungated it would finish before we could look).
        proc = _install_fake_process(
            session_id,
            [leftover, result_line, trailing],
            gate=gate,
            parked=parked,
            gate_after=0,
        )
        gen = ar._stream_claude(_req(session_id), FakeRequest())

        frame = await gen.__anext__()  # "thinking..." — no stdout read yet
        assert "thinking" in frame
        assert proc.stdout.served == 0
        lock = ar._claude_stream_locks[session_id]
        assert lock.locked()

        await gen.aclose()  # pure GeneratorExit at the "thinking..." yield
        await asyncio.wait_for(parked.wait(), timeout=2.0)

        # Handoff happened and the lock is still held by the drain. The token was
        # popped exactly once by the dispatcher's finally.
        assert ar._claude_drain_tasks == {}
        assert len(ar._claude_drain_task_refs) == 1
        drain_task = next(iter(ar._claude_drain_task_refs))
        assert lock.locked()
        assert releases == []

        gate.set()
        await asyncio.wait_for(drain_task, timeout=3.0)
        await _settle()
        return proc

    proc = asyncio.run(run())

    # The drain consumed leftover + result and stopped at `done`.
    assert proc.stdout._lines == [trailing]
    assert len(releases) == 1
    assert not ar._claude_stream_locks[session_id].locked()
    assert ar._claude_processes.get(session_id) is proc


def test_cancel_at_thinking_yield_hands_off_drain(monkeypatch):
    """
    Cancellation variant of the pre-loop "thinking..." yield gap.

    The cancel is thrown at the OUTER dispatcher yield; it reaches the inner
    generator as GeneratorExit via the dispatcher's aclose(). The inner
    CancelledError handler is only reachable mid-await, never at a suspended yield.
    """
    session_id = "sess-thinking-cancel"
    leftover = _delta_line("TURN1_LEFTOVER")
    result_line = _result_line()
    trailing = _delta_line("NEXT_TURN")
    releases = _count_releases(monkeypatch)

    async def run():
        gate = asyncio.Event()
        parked = asyncio.Event()
        proc = _install_fake_process(
            session_id,
            [leftover, result_line, trailing],
            gate=gate,
            parked=parked,
            gate_after=0,
        )
        gen = ar._stream_claude(_req(session_id), FakeRequest())

        frame = await gen.__anext__()  # "thinking..." — no stdout read yet
        assert "thinking" in frame
        assert proc.stdout.served == 0
        lock = ar._claude_stream_locks[session_id]

        # Deliver CancelledError at that suspended yield, as an anyio cancel scope
        # does to the generator Starlette is iterating.
        with pytest.raises(asyncio.CancelledError):
            await gen.athrow(asyncio.CancelledError())
        await asyncio.wait_for(parked.wait(), timeout=2.0)

        # Token popped exactly once by the dispatcher's finally.
        assert ar._claude_drain_tasks == {}
        assert len(ar._claude_drain_task_refs) == 1
        drain_task = next(iter(ar._claude_drain_task_refs))
        assert lock.locked()
        assert releases == []

        gate.set()
        await asyncio.wait_for(drain_task, timeout=3.0)
        await _settle()
        return proc

    proc = asyncio.run(run())

    assert proc.stdout._lines == [trailing]
    assert len(releases) == 1
    assert not ar._claude_stream_locks[session_id].locked()


def test_generator_close_after_done_skips_handoff(monkeypatch):
    """A close AFTER the turn's result must NOT start a pointless drain."""
    session_id = "sess-close-done"
    _install_fake_process(session_id, [_delta_line("A"), _result_line()])
    releases = _count_releases(monkeypatch)

    async def run():
        gen = ar._stream_claude(_req(session_id), FakeRequest())
        frames = []
        async for frame in gen:
            frames.append(frame)
        await gen.aclose()
        await _settle()
        return frames

    frames = asyncio.run(run())

    assert any('"type": "done"' in f for f in frames)
    # turn_completed was True → no handoff, lock released exactly once.
    assert ar._claude_drain_tasks == {}
    assert ar._claude_drain_task_refs == set()
    assert len(releases) == 1
    assert not ar._claude_stream_locks[session_id].locked()


# ---------------------------------------------------------------------------
# (R2-c) create_task failing (loop closing) → no registration, immediate release.
# ---------------------------------------------------------------------------
def test_handoff_when_create_task_fails_releases_immediately(monkeypatch):
    session_id = "sess-noloop"
    releases = _count_releases(monkeypatch)

    def boom(*_args, **_kwargs):
        raise RuntimeError("no running event loop")

    async def run():
        gate = asyncio.Event()
        parked = asyncio.Event()
        _install_fake_process(
            session_id, [_delta_line("X"), _result_line()], gate=gate, parked=parked
        )

        async def consume():
            async for _frame in ar._stream_claude(_req(session_id), FakeRequest()):
                pass

        task = asyncio.create_task(consume())
        await asyncio.wait_for(parked.wait(), timeout=2.0)
        # Only now break task creation, so our own consume() task was unaffected.
        # Scoped context so undoing this patch cannot also revert the
        # _release_quietly counter installed before it.
        with pytest.MonkeyPatch.context() as patch:
            patch.setattr(ar.asyncio, "create_task", boom)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            await _settle()

    asyncio.run(run())

    # Nothing registered, and the lock was released normally (never leaked).
    assert ar._claude_drain_tasks == {}
    assert ar._claude_drain_task_refs == set()
    assert len(releases) == 1
    assert not ar._claude_stream_locks[session_id].locked()


# ---------------------------------------------------------------------------
# (R2-d) Byte-budget continuity across inline drain → detached drain.
# ---------------------------------------------------------------------------
def test_byte_cap_fires_inside_drain_from_zero_budget(monkeypatch):
    """
    The cap aborts the drain and cleans up the process.

    Note this starts from an EMPTY budget: FakeRequest(disconnected=True) diverts
    to the inline drain before the live loop reads anything. Cross-phase
    continuity is covered by test_byte_budget_continues_across_inline_handoff.
    """
    session_id = "sess-budget"
    fat = b"x" * 400 + b"\n"  # 401 bytes
    monkeypatch.setattr(ar, "CLAUDE_MAX_STDOUT_BYTES", 600)

    async def run():
        proc = _install_fake_process(session_id, [fat, fat, fat, fat])
        await _collect(
            ar._stream_claude_persistent(
                _req(session_id), FakeRequest(disconnected=True)
            )
        )
        return proc

    proc = asyncio.run(run())

    # 401 ok, 802 > 600 → aborted after exactly 2 lines, 2 left unread.
    assert len(proc.stdout._lines) == 2
    # Byte-cap path terminates and cleans up the process.
    assert session_id not in ar._claude_processes


def test_byte_budget_continues_across_inline_handoff(monkeypatch):
    """
    Case 7: live loop reads N bytes → polled disconnect starts the INLINE drain →
    cancellation lands mid-inline-drain → exactly ONE handoff whose budget already
    includes the live-loop bytes.
    """
    session_id = "sess-continuity"
    live = _delta_line("LIVE")  # consumed by the live loop
    tail = _delta_line("TAIL")  # reached only by the detached drain
    result_line = _result_line()

    captured: list = []
    real_detached = ar._drain_claude_turn_detached

    async def spy_detached(process, sid, start_time, budget):
        captured.append(budget)
        await real_detached(process, sid, start_time, budget)

    monkeypatch.setattr(ar, "_drain_claude_turn_detached", spy_detached)

    async def run():
        gate = asyncio.Event()
        parked = asyncio.Event()
        # gate_after=1: live loop reads `live`, then the inline drain parks.
        _install_fake_process(
            session_id,
            [live, tail, result_line],
            gate=gate,
            parked=parked,
            gate_after=1,
        )
        # Connected for the first poll, disconnected for the second → the live
        # loop consumes `live`, then the inline drain starts and parks.
        request = CountingDisconnect(true_from_poll=2)

        async def consume():
            async for _frame in ar._stream_claude(_req(session_id), request):
                pass

        task = asyncio.create_task(consume())
        await asyncio.wait_for(parked.wait(), timeout=2.0)

        # Cancel MID-INLINE-DRAIN (the inline drain is parked in readline).
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        await _settle()

        assert len(ar._claude_drain_task_refs) == 1
        drain_task = next(iter(ar._claude_drain_task_refs))
        gate.set()
        await asyncio.wait_for(drain_task, timeout=3.0)
        await _settle()

    asyncio.run(run())

    # Exactly one handoff, and its budget carried the live-loop bytes forward.
    assert len(captured) == 1
    budget = captured[0]
    assert budget.total == len(live) + len(tail) + len(result_line)
    # Turn finished on `result`, so the process stays alive.
    assert session_id in ar._claude_processes
    assert not ar._claude_stream_locks[session_id].locked()


def test_byte_budget_object_is_shared_not_copied():
    """_drain_claude_turn must mutate the caller's budget, not a copy."""
    budget = ar._ByteBudget(total=100)
    line = b"y" * 49 + b"\n"  # 50 bytes
    proc = FakeProcess([line, _result_line()])

    asyncio.run(ar._drain_claude_turn(proc, "sess-shared", time.monotonic(), budget))

    # The caller's object advanced by both consumed lines.
    assert budget.total == 100 + len(line) + len(_result_line())


# ---------------------------------------------------------------------------
# (R2-e) Process-identity guard: already popped/replaced → no handoff, no
#        duplicate crash record.
# ---------------------------------------------------------------------------
def test_handoff_skipped_when_process_already_replaced(monkeypatch):
    session_id = "sess-identity"
    releases = _count_releases(monkeypatch)

    async def run():
        gate = asyncio.Event()
        parked = asyncio.Event()
        _install_fake_process(
            session_id, [_delta_line("X"), _result_line()], gate=gate, parked=parked
        )

        async def consume():
            async for _frame in ar._stream_claude(_req(session_id), FakeRequest()):
                pass

        task = asyncio.create_task(consume())
        await asyncio.wait_for(parked.wait(), timeout=2.0)

        # Simulate a concurrent cleanup/respawn: the registry no longer holds the
        # process this turn was reading, and a crash was already recorded.
        ar._claude_record_crash(session_id)
        ar._claude_processes[session_id] = FakeProcess([])

        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        await _settle()

    asyncio.run(run())

    # No handoff for a process we no longer own → no second crash record.
    assert ar._claude_drain_tasks == {}
    assert ar._claude_drain_task_refs == set()
    assert len(ar._claude_crash_log.get(session_id, [])) == 1
    assert len(releases) == 1
    assert not ar._claude_stream_locks[session_id].locked()
