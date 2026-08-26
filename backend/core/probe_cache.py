"""Run slow, rarely-changing capability probes off the event loop, once.

Capability probes (does the sidecar venv import demucs? is basic-pitch
installed?) are cheap to describe and expensive to answer: they spawn an
interpreter and import torch. Called straight from an ``async def`` handler
they stop the single uvicorn worker dead for seconds, which stalls library
streaming, DJ polling, stems progress and the job queue at exactly the moment
the user pressed CREATE.

``CachedProbe`` fixes both halves of that:

  * the probe runs in a worker thread, so the event loop keeps turning;
  * the answer is remembered for ``ttl`` seconds, so the repeated status polls
    that surround every generation and every Settings open cost nothing.

Concurrent callers that arrive while a probe is in flight wait on the same run
rather than each spawning their own. Anything that can change the answer (an
install, an uninstall, a sidecar start) calls ``invalidate()``.
"""

from __future__ import annotations

import asyncio
import time
from typing import Callable, Generic, Optional, TypeVar

T = TypeVar("T")


class CachedProbe(Generic[T]):
    """TTL-cached, thread-offloaded wrapper around one sync probe function."""

    def __init__(
        self,
        fn: Callable[[], T],
        *,
        ttl: float = 30.0,
        name: Optional[str] = None,
    ) -> None:
        self._fn = fn
        self._ttl = float(ttl)
        self.name = name or getattr(fn, "__name__", "probe")
        self._value: Optional[T] = None
        self._fresh_until: float = 0.0
        self._lock = asyncio.Lock()

    @property
    def ttl(self) -> float:
        return self._ttl

    def peek(self) -> Optional[T]:
        """The cached value if it is still fresh, else None. Never runs the probe."""
        if self._value is not None and time.monotonic() < self._fresh_until:
            return self._value
        return None

    def invalidate(self) -> None:
        """Drop the cached answer so the next ``get()`` re-probes."""
        self._fresh_until = 0.0

    async def get(self, *, force: bool = False) -> T:
        if not force:
            cached = self.peek()
            if cached is not None:
                return cached
        async with self._lock:
            # A probe may have completed while we waited for the lock; the
            # point of the lock is that N concurrent pollers cost one run.
            if not force:
                cached = self.peek()
                if cached is not None:
                    return cached
            value = await asyncio.to_thread(self._fn)
            self._value = value
            self._fresh_until = time.monotonic() + self._ttl
            return value
