"""Pure policy for a bounded WM_CLOSE sequence for the embedded VST editor.

``win_embed``'s close path used to be fire-and-forget: post one WM_CLOSE to the
editor's hwnd and return immediately. A plugin can ignore or veto WM_CLOSE (some
raise an "unsaved changes?" prompt, some just swallow it), and when it does, the
editor window is left on screen — still pinned above the Electron window and
clipped to the embed rect — while the sidecar's ``show_editor()`` call stays
blocked forever and the app is left polling a status that never settles.

This module holds the bounded-retry policy that fixes that, deliberately free
of ctypes/time/threading (and of ``win_embed`` itself) so it can be unit tested
on any platform without a real window: :class:`CloseSequencer` decides what to
do next from the elapsed time and whether the window still exists; :func:`describe`
renders that decision as one log line. ``win_embed`` owns the clock, the actual
``PostMessageW``/``IsWindow`` calls, and the sleep between polls.

Units: ``elapsed_s`` is seconds, measured by the caller, since the FIRST
WM_CLOSE was posted — not since the sequence object was created and not since
the previous call.
"""

from __future__ import annotations


class CloseSequencer:
    """Decide the next action in a bounded "ask the plugin to close" sequence.

    The sequence posts once, waits up to ``repost_after_s`` for the window to
    go away, posts exactly one more time if it hasn't, then waits up to
    ``timeout_s`` (total, since the first post) before giving up. The window
    disappearing (``window_alive=False``) ends the sequence immediately at any
    point — once it's gone there is nothing left to post to or wait on.
    """

    def __init__(self, *, timeout_s: float = 5.0, repost_after_s: float = 2.0) -> None:
        if timeout_s <= 0:
            raise ValueError(f"timeout_s must be > 0, got {timeout_s!r}")
        if repost_after_s < 0:
            raise ValueError(f"repost_after_s must be >= 0, got {repost_after_s!r}")
        if repost_after_s >= timeout_s:
            raise ValueError(
                f"repost_after_s ({repost_after_s!r}) must be < timeout_s "
                f"({timeout_s!r})"
            )
        self.timeout_s = timeout_s
        self.repost_after_s = repost_after_s
        self.posts: int = 0

    def step(self, elapsed_s: float, window_alive: bool) -> str:
        """Return the next action for the caller to take.

        One of ``"post"`` (send WM_CLOSE now), ``"wait"`` (do nothing this
        pass), ``"closed"`` (the window is gone; the sequence is done) or
        ``"give_up"`` (timed out; stop waiting on this window).
        """
        if not window_alive:
            return "closed"

        if self.posts == 0:
            self.posts = 1
            return "post"

        if self.posts == 1 and elapsed_s >= self.repost_after_s:
            self.posts = 2
            return "post"

        if elapsed_s >= self.timeout_s:
            return "give_up"

        return "wait"


def describe(action: str, elapsed_s: float, posts: int) -> str:
    """Render one log line for a :meth:`CloseSequencer.step` decision.

    Raises ValueError if ``action`` is not one of the four literals
    :meth:`CloseSequencer.step` can return.
    """
    if action not in ("post", "wait", "closed", "give_up"):
        raise ValueError(f"unknown close action: {action!r}")
    return f"close: action={action} elapsed={elapsed_s:.1f}s posts={posts}"
