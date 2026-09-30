"""Unit tests for ``win_embed.run_close``: the bounded-close orchestration
that drives ``embed_close.CloseSequencer`` against a window.

These exercise ``run_close`` purely through the duck-typed ``ops`` object, a
fake clock and a no-op (or clock-advancing) sleep -- no ctypes, no real
window, no real plugin -- so they run on every platform even though
``win_embed`` itself is Windows-only.
"""

import itertools
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from backend.modules.vst.embed_close import CloseSequencer  # noqa: E402
from backend.modules.vst.win_embed import run_close  # noqa: E402

HWND = 0x1234


class FakeOps:
    """Records every call; ``is_window`` replays a scripted sequence."""

    def __init__(self, is_window_results) -> None:
        self._is_window_results = iter(is_window_results)
        self.post_close_calls: list[int] = []
        self.is_window_call_count = 0
        self.unclip_calls = 0
        self.disown_calls = 0

    def post_close(self, hwnd: int) -> bool:
        self.post_close_calls.append(hwnd)
        return True

    def is_window(self, hwnd: int) -> bool:
        self.is_window_call_count += 1
        return next(self._is_window_results)

    def unclip(self, hwnd: int) -> None:
        self.unclip_calls += 1

    def disown(self, hwnd: int) -> None:
        self.disown_calls += 1


class FakeClock:
    """A clock that only moves when something explicitly advances it (here,
    ``sleep``), so a test can prove ``run_close`` never sleeps more than it
    needs to."""

    def __init__(self, start: float = 0.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def _scripted_clock(times):
    """A ``clock`` callable that replays ``times`` in order, one per call."""
    values = iter(times)
    return lambda: next(values)


def test_close_posts_wm_close_and_returns_when_the_window_goes_away():
    ops = FakeOps(is_window_results=[True, False])

    result = run_close(
        ops,
        HWND,
        lambda line: None,
        sequencer=CloseSequencer(),
        sleep=lambda seconds: None,
        clock=_scripted_clock([0.0, 0.0]),
    )

    assert result == "closed"
    assert ops.post_close_calls == [HWND]
    assert ops.unclip_calls == 0
    assert ops.disown_calls == 0


def test_a_plugin_that_ignores_close_is_given_up_on_and_the_window_is_restored():
    ops = FakeOps(is_window_results=[True, True, True, True, True])
    sequencer = CloseSequencer(timeout_s=0.3, repost_after_s=0.1)

    result = run_close(
        ops,
        HWND,
        lambda line: None,
        sequencer=sequencer,
        sleep=lambda seconds: None,
        clock=_scripted_clock([0.0, 0.05, 0.1, 0.2, 0.3]),
    )

    assert result == "gave_up"
    assert ops.post_close_calls == [HWND, HWND]
    assert ops.unclip_calls == 1
    assert ops.disown_calls == 1


def test_close_never_posts_more_than_twice():
    ops = FakeOps(is_window_results=[True, True, True, True, True, True, False])
    sequencer = CloseSequencer(timeout_s=0.3, repost_after_s=0.1)

    result = run_close(
        ops,
        HWND,
        lambda line: None,
        sequencer=sequencer,
        sleep=lambda seconds: None,
        clock=_scripted_clock([0.0, 0.02, 0.05, 0.1, 0.15, 0.2, 0.25]),
    )

    assert result == "closed"
    assert len(ops.post_close_calls) == 2
    assert ops.unclip_calls == 0
    assert ops.disown_calls == 0


def test_no_sleep_call_exceeds_the_timeout():
    ops = FakeOps(is_window_results=itertools.repeat(True))
    sequencer = CloseSequencer(timeout_s=0.3, repost_after_s=0.1)
    clock = FakeClock()

    result = run_close(
        ops,
        HWND,
        lambda line: None,
        sequencer=sequencer,
        sleep=clock.advance,
        clock=clock,
    )

    assert result == "gave_up"
    # 0.1s is the fixed poll interval run_close sleeps between "wait"
    # actions -- total elapsed must never overshoot the sequencer's own
    # timeout by more than that one extra poll.
    assert clock.now <= sequencer.timeout_s + 0.1 + 1e-9
    assert ops.post_close_calls == [HWND, HWND]
    assert ops.unclip_calls == 1
    assert ops.disown_calls == 1
