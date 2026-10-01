"""Process liveness that answers the same on every platform.

On Linux and macOS a process that has exited stays in the process table as a
zombie until its parent waits on it. ``os.kill(pid, 0)``,
``psutil.pid_exists`` and ``psutil.wait_procs`` all report a zombie as alive;
the Windows probes report an exited process as gone at once. A zombie runs no
code and holds no port, so every liveness check here counts it as gone.
"""

from __future__ import annotations

import os
import time
from typing import Any, Iterable


def is_zombie(pid: int) -> bool:
    """True when ``pid`` has exited and only waits for its parent to reap it.
    Always False on Windows, which has no zombies."""
    if os.name == "nt":
        return False
    try:
        with open(f"/proc/{pid}/stat", "rb") as f:
            # "pid (comm) state ..."; comm may itself contain ")" or spaces.
            return f.read().rpartition(b")")[2].split()[0] == b"Z"
    except (OSError, IndexError):
        pass
    try:
        import psutil

        return psutil.Process(pid).status() == psutil.STATUS_ZOMBIE
    except Exception:  # noqa: BLE001 - no /proc and no psutil answer: not a zombie
        return False


def _running(proc: Any) -> bool:
    """Whether a ``psutil.Process`` still runs code; a zombie does not."""
    import psutil

    try:
        return proc.is_running() and proc.status() != psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess:
        return False
    except psutil.AccessDenied:
        return True


def wait_gone(procs: Iterable[Any], timeout: float) -> list[Any]:
    """Wait up to ``timeout`` seconds for ``psutil.Process`` objects to stop
    and return the ones still running. A zombie counts as gone, so a tree
    whose parent never reaps it does not burn the whole timeout."""
    deadline = time.monotonic() + timeout
    pending = [p for p in procs if _running(p)]
    while pending and time.monotonic() < deadline:
        time.sleep(0.05)
        pending = [p for p in pending if _running(p)]
    return pending
