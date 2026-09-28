"""Wall-clock stamps that order the way they were handed out.

Windows' ``time.time()`` moves in 15.6 ms steps, so two things made in quick
succession get the same stamp, and a list ordered "newest first" by that stamp
falls back to whatever order the ties happen to be read in: folder order,
dict order, index order. The ties are exact, so no sort key can break them the
right way after the fact.

An :class:`IncreasingClock` hands out ``time.time()`` except when that would
repeat or go back, when it hands out a microsecond past the last stamp
instead. The stamps stay honest wall-clock times; only their order is fixed.
"""

from __future__ import annotations

import threading
import time

#: The nudge past the last stamp: far below any clock step, and still
#: distinct after a float64 round trip through JSON or SQLite REAL.
STEP = 1e-6


class IncreasingClock:
    """``time.time()``, strictly increasing across every call on this clock."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._last = 0.0

    def advance_past(self, stamp: float) -> None:
        """Never hand out ``stamp`` or anything before it (a stamp already on
        disk from an earlier run, say)."""
        with self._lock:
            if stamp > self._last:
                self._last = float(stamp)

    def __call__(self) -> float:
        with self._lock:
            now = time.time()
            if now <= self._last:
                now = self._last + STEP
            self._last = now
            return now
