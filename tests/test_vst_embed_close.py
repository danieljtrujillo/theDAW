"""Unit tests for the bounded WM_CLOSE retry policy used by the VST editor embed.

These run everywhere (the module is ctypes/time/threading-free); they encode the
failure mode the embed actually hit: a plugin vetoing or ignoring WM_CLOSE and
leaving the watcher thread blocked in show_editor() forever with no bound on the
wait.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from backend.modules.vst.embed_close import CloseSequencer, describe  # noqa: E402


def test_first_step_posts_close():
    seq = CloseSequencer()
    assert seq.step(0.0, window_alive=True) == "post"
    assert seq.posts == 1


def test_window_gone_reports_closed():
    """The window disappearing ends the sequence immediately, before or after
    a post — there is nothing left to post to or wait on."""
    fresh = CloseSequencer()
    assert fresh.step(0.0, window_alive=False) == "closed"

    posted = CloseSequencer()
    posted.step(0.0, window_alive=True)
    assert posted.step(0.5, window_alive=False) == "closed"


def test_reposts_once_after_the_repost_delay():
    seq = CloseSequencer(timeout_s=5.0, repost_after_s=2.0)
    assert seq.step(0.0, window_alive=True) == "post"  # first post
    assert seq.step(2.0, window_alive=True) == "post"  # the one re-post
    assert seq.posts == 2
    assert seq.step(2.5, window_alive=True) == "wait"  # never a third post


def test_gives_up_at_the_timeout():
    seq = CloseSequencer(timeout_s=5.0, repost_after_s=2.0)
    seq.step(0.0, window_alive=True)
    seq.step(2.0, window_alive=True)
    assert seq.step(5.0, window_alive=True) == "give_up"


def test_invalid_timings_are_rejected():
    with pytest.raises(ValueError):
        CloseSequencer(timeout_s=0)
    with pytest.raises(ValueError):
        CloseSequencer(repost_after_s=-1)
    with pytest.raises(ValueError):
        CloseSequencer(timeout_s=2.0, repost_after_s=2.0)


def test_describe_formats_the_log_line():
    assert describe("post", 2.0, 2) == "close: action=post elapsed=2.0s posts=2"


def test_describe_rejects_an_unknown_action():
    with pytest.raises(ValueError):
        describe("bogus", 0.0, 0)
