"""Admin-level operations exposed under /api/admin/*.

POST /api/admin/restart — schedules a clean re-exec of the backend.
Returns 202 immediately, then exits with sentinel code 88 so the
backend._supervisor parent process respawns a fresh inner inside the
same console window. The frontend polls /api/health until it comes
back.
"""

from __future__ import annotations

import logging
import os
import threading
import time

from fastapi import APIRouter

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/admin", tags=["admin"])

RESTART_EXIT_CODE = 88


def _delayed_exit(delay_seconds: float, code: int) -> None:
    time.sleep(delay_seconds)
    log.info("admin.restart: exiting with code %d (supervisor will respawn)", code)
    # os._exit avoids running atexit handlers — they tend to hang on
    # uvicorn shutdown when called from a request thread. The
    # supervisor catches the rc and respawns.
    os._exit(code)


@router.post("/restart")
def restart() -> dict:
    """Schedule a backend restart and return 202.

    The supervisor parent (backend._supervisor) sees the sentinel exit
    code and re-launches backend.run inside the same console. The
    frontend should poll /api/health until it responds again.
    """
    # 600ms gives uvicorn time to flush the response and the client
    # time to read it before the process disappears.
    t = threading.Thread(
        target=_delayed_exit, args=(0.6, RESTART_EXIT_CODE), daemon=True
    )
    t.start()
    return {
        "ok": True,
        "scheduled": True,
        "supervisor_required": True,
        "exit_code": RESTART_EXIT_CODE,
        "hint": "If the supervisor isn't running (backend launched via "
        "python -m backend.run instead of backend._supervisor), the "
        "process will exit and you'll have to start it again manually.",
    }
