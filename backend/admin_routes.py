"""Admin-level operations exposed under /api/admin/*.

POST /api/admin/restart — schedules a clean re-exec of the backend.
Returns 202 immediately, then exits with sentinel code 88 so the
backend._supervisor parent process respawns a fresh inner inside the
same console window. The frontend polls /api/health until it comes
back.

POST /api/admin/shutdown — schedules a CLEAN exit with rc=0. The
supervisor sees a non-restart exit code and terminates rather than
respawning, so the whole SA3 backend console closes. Used by the
SETTINGS modal's Shutdown button.
"""

from __future__ import annotations

import logging
import os
import threading
import time

from fastapi import APIRouter, HTTPException

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/admin", tags=["admin"])

RESTART_EXIT_CODE = 88
SUPERVISOR_ENV_FLAG = "SA3_SUPERVISOR_PRESENT"


def _delayed_exit(delay_seconds: float, code: int) -> None:
    time.sleep(delay_seconds)
    log.info("admin.restart: exiting with code %d (supervisor will respawn)", code)
    # os._exit avoids running atexit handlers — they tend to hang on
    # uvicorn shutdown when called from a request thread. The
    # supervisor catches the rc and respawns.
    os._exit(code)


@router.get("/restart-status")
def restart_status() -> dict:
    """Surface whether this backend is running under the supervisor —
    the frontend can use this to enable / disable the Restart button
    instead of letting users hit a no-op."""
    return {
        "supervisor_present": os.environ.get(SUPERVISOR_ENV_FLAG) == "1",
        "exit_code_on_restart": RESTART_EXIT_CODE,
    }


@router.post("/restart")
def restart() -> dict:
    """Schedule a backend restart and return 202.

    The supervisor parent (backend._supervisor) sees the sentinel exit
    code and re-launches backend.run inside the same console. The
    frontend should poll /api/health until it responds again.

    Refuses with 412 if the supervisor isn't in the process tree —
    without it, os._exit(88) would just kill the backend permanently
    and the user would have to launch it again manually.
    """
    if os.environ.get(SUPERVISOR_ENV_FLAG) != "1":
        raise HTTPException(
            status_code=412,
            detail=(
                "Restart unavailable: backend not running under the "
                "supervisor. Launch via start-dev.bat (which invokes "
                "`python -m backend._supervisor`) instead of "
                "`python -m backend.run`, then try again."
            ),
        )
    # 600ms gives uvicorn time to flush the response and the client
    # time to read it before the process disappears.
    t = threading.Thread(
        target=_delayed_exit, args=(0.6, RESTART_EXIT_CODE), daemon=True
    )
    t.start()
    return {
        "ok": True,
        "scheduled": True,
        "exit_code": RESTART_EXIT_CODE,
    }


@router.post("/shutdown")
def shutdown() -> dict:
    """Schedule a clean backend shutdown (rc=0).

    The supervisor (backend._supervisor) only respawns on
    RESTART_EXIT_CODE (88); any other exit code ends the loop and the
    supervisor process exits normally. So rc=0 cleanly stops the whole
    SA3 backend console — the user has to relaunch via start-dev.bat.
    """
    t = threading.Thread(target=_delayed_exit, args=(0.6, 0), daemon=True)
    t.start()
    return {
        "ok": True,
        "scheduled": True,
        "exit_code": 0,
    }
