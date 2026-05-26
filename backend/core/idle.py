"""Track whether the app is currently 'idle' so opt-in background workers
(analysis, stems, MIDI conversion) only run when they won't compete with
foreground user activity for CPU / GPU.

The simple model:

- Foreground endpoints (generate, studio render, chimera, library import)
  call ``bump_activity()`` at entry. This stamps "the user just did
  something."
- Background workers call ``is_idle(min_idle_seconds)`` before pulling
  each job from the queue. They wait until the user has been quiet for
  the configured grace period.
- ``gpu_pressure()`` reports a coarse low/medium/high signal based on
  current CUDA memory usage. Workers can downgrade themselves (e.g.,
  stems sidecar runs CPU-only when pressure is high) instead of waiting.

We deliberately don't track individual jobs here — that's the job queue's
problem. This module just answers "should anything heavy start right
now?".
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Literal, Optional

log = logging.getLogger(__name__)


GpuPressure = Literal["low", "medium", "high"]


class IdleManager:
    """Process-wide idle tracker. Cheap, thread-safe, no asyncio coupling
    so it can be called from sync code paths."""

    def __init__(self, default_min_idle_seconds: float = 30.0) -> None:
        self._lock = threading.RLock()
        self._last_activity_ts: float = 0.0
        self.default_min_idle_seconds = float(default_min_idle_seconds)
        # Tracks active long-running operations by tag. While any tag is
        # active we are NOT idle, regardless of elapsed time.
        self._active: dict[str, int] = {}

    # ---- Activity stamping --------------------------------------------------

    def bump_activity(self, *, tag: Optional[str] = None) -> None:
        """Record that the user is currently doing something foreground.
        Optional ``tag`` lets a long-running op start/stop a hold."""
        with self._lock:
            self._last_activity_ts = time.monotonic()
            if tag:
                self._active[tag] = self._active.get(tag, 0) + 1

    def release(self, tag: str) -> None:
        with self._lock:
            if tag not in self._active:
                return
            self._active[tag] -= 1
            if self._active[tag] <= 0:
                self._active.pop(tag, None)
            self._last_activity_ts = time.monotonic()

    # ---- Queries ------------------------------------------------------------

    def is_idle(self, min_idle_seconds: Optional[float] = None) -> bool:
        threshold = (
            self.default_min_idle_seconds
            if min_idle_seconds is None
            else float(min_idle_seconds)
        )
        with self._lock:
            if self._active:
                return False
            if self._last_activity_ts == 0.0:
                return True
            return (time.monotonic() - self._last_activity_ts) >= threshold

    def seconds_since_activity(self) -> float:
        with self._lock:
            if self._last_activity_ts == 0.0:
                return float("inf")
            return time.monotonic() - self._last_activity_ts

    def active_tags(self) -> list[str]:
        with self._lock:
            return [t for t, n in self._active.items() if n > 0]

    def gpu_pressure(self) -> GpuPressure:
        """Coarse VRAM-utilization signal. Returns 'low' when we can't
        introspect (no torch / no CUDA)."""
        try:
            import torch  # local import — keep this module light
        except ImportError:
            return "low"
        try:
            if not torch.cuda.is_available():
                return "low"
            free_b, total_b = torch.cuda.mem_get_info()  # type: ignore[attr-defined]
        except Exception:
            return "low"
        if total_b <= 0:
            return "low"
        used_frac = 1.0 - (free_b / total_b)
        if used_frac >= 0.85:
            return "high"
        if used_frac >= 0.55:
            return "medium"
        return "low"

    def snapshot(self) -> dict[str, object]:
        return {
            "idle": self.is_idle(),
            "seconds_since_activity": self.seconds_since_activity(),
            "active_tags": self.active_tags(),
            "gpu_pressure": self.gpu_pressure(),
            "min_idle_seconds": self.default_min_idle_seconds,
        }

    def set_min_idle_seconds(self, seconds: float) -> None:
        with self._lock:
            self.default_min_idle_seconds = float(seconds)


# Process-wide singleton. Modules that need to gate work share this instance.
_default: Optional[IdleManager] = None


def get_idle_manager() -> IdleManager:
    global _default
    if _default is None:
        _default = IdleManager()
    return _default
