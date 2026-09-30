"""Admin-level operations exposed under /api/admin/*.

POST /api/admin/restart — schedules a clean re-exec of the backend.
Answers at once, then exits with sentinel code 88 so the
supervisor parent process (backend._devstack, or backend._supervisor)
respawns a fresh inner inside the same console. The frontend polls
/api/health until it comes back.

POST /api/admin/shutdown — schedules a CLEAN exit with rc=0. The
supervisor sees a non-restart exit code and terminates rather than
respawning, so the whole theDAW console closes. Used by the
SETTINGS modal's Shutdown button, the desktop shell's quit, and
``python -m backend.ports --free`` on every launch.

Both run the app's shutdown handlers -- the same ``_on_shutdown`` the
FastAPI lifespan runs, which ``backend/server.py`` registers on
``app.state`` under ``SHUTDOWN_HANDLERS_STATE`` -- before the process
exits, with a time budget. Both refuse a request that a web page outside
theDAW started (``refuse_cross_site``): stopping the backend is not
something any site the user visits may do. Both also refuse a caller that is
not this machine (``require_loopback_or_launch_token``): the backend binds
0.0.0.0, and a script on the LAN that sends no browser headers passed the
cross-site check. Every caller that legitimately stops the backend is on this
machine: the SETTINGS modal in this machine's browser, the desktop shell
(``electron-ui/main/index.ts`` posts to 127.0.0.1 and carries the launch
token) and ``python -m backend.ports --free``.
"""

from __future__ import annotations

import asyncio
import logging
import os
import threading
import time
from typing import Awaitable, Callable, Optional

from fastapi import APIRouter, Depends, HTTPException, Request

from backend.lib.cross_site import refuse_cross_site, require_loopback_or_launch_token

log = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/admin",
    tags=["admin"],
    dependencies=[
        Depends(refuse_cross_site),
        Depends(require_loopback_or_launch_token),
    ],
)

RESTART_EXIT_CODE = 88
SUPERVISOR_ENV_FLAG = "SA3_SUPERVISOR_PRESENT"

#: The ``app.state`` attribute holding the app's shutdown coroutine function.
SHUTDOWN_HANDLERS_STATE = "run_shutdown_handlers"

#: How long the shutdown handlers get before the process exits anyway. The live
#: VST hosts alone may take their own shutdown timeout plus a terminate wait,
#: and a hung handler must not keep a Shutdown click from ever finishing.
#: ``backend.ports`` waits longer than this before it signals the process.
SHUTDOWN_HANDLER_BUDGET_SEC = 15.0

#: The pause before the handlers start, so uvicorn flushes the response and
#: the client reads it before anything stops.
_EXIT_DELAY_SEC = 0.6

ShutdownHandlers = Callable[[], Awaitable[None]]


def _run_shutdown_handlers(
    loop: asyncio.AbstractEventLoop, handlers: ShutdownHandlers
) -> bool:
    """Run ``handlers`` on the server's event loop and wait. True if they ran.

    Called from the exit thread, so the coroutine is handed to the loop that
    serves requests -- the one every handler expects to run on -- and this
    thread only waits for it, up to the budget.
    """
    future = asyncio.run_coroutine_threadsafe(handlers(), loop)
    try:
        future.result(timeout=SHUTDOWN_HANDLER_BUDGET_SEC)
    except Exception:
        future.cancel()
        log.warning(
            "admin: shutdown handlers did not finish within %.0f s; exiting anyway",
            SHUTDOWN_HANDLER_BUDGET_SEC,
            exc_info=True,
        )
        return False
    return True


def _delayed_exit(
    delay_seconds: float,
    code: int,
    loop: Optional[asyncio.AbstractEventLoop] = None,
    handlers: Optional[ShutdownHandlers] = None,
) -> None:
    time.sleep(delay_seconds)
    # os._exit below skips atexit handlers (they hang on uvicorn shutdown when
    # called from a request thread) and the lifespan's own shutdown half, so
    # the handlers that half would run are run here first: the live VST hosts,
    # which save their plugin state, the background queue, the assistant's
    # claude children and every sidecar.
    ran = False
    if loop is not None and handlers is not None:
        ran = _run_shutdown_handlers(loop, handlers)
    if not ran:
        _stop_children_directly()
    log.info("admin: exiting with code %d", code)
    os._exit(code)


def _stop_children_directly() -> None:
    """Stop the live VST hosts and the sidecars without the app's handlers.

    For when no lifespan registered the handlers, or they ran out of budget.
    The hosts come first so each can still save its plugin state; a host the
    handlers already reached is gone from the host manager, so that call
    returns at once. The sidecars would otherwise be orphaned holding their
    ports.
    """
    try:
        from backend.modules.vst.live_host import kill_all as stop_live_vst_hosts

        stop_live_vst_hosts()
    except Exception:
        # Teardown must never block the exit; the line is the only trace.
        log.warning("admin: stopping the live VST hosts failed", exc_info=True)
    try:
        from backend.core.teardown import stop_all_sidecars

        stop_all_sidecars()
    except Exception:
        log.warning("admin: stopping the sidecars failed", exc_info=True)


def _schedule_exit(request: Request, code: int) -> None:
    """Start the thread that runs the shutdown handlers and exits with ``code``."""
    handlers = getattr(request.app.state, SHUTDOWN_HANDLERS_STATE, None)
    t = threading.Thread(
        target=_delayed_exit,
        args=(_EXIT_DELAY_SEC, code, asyncio.get_running_loop(), handlers),
        daemon=True,
    )
    t.start()


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
async def restart(request: Request) -> dict:
    """Schedule a backend restart and answer at once.

    The supervisor parent (theDAW.bat's dev stack) sees the sentinel
    exit code and re-launches backend.run inside the same console. The
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
                "supervisor. Launch via theDAW.bat (which runs it under "
                "backend._devstack) instead of `python -m backend.run`, "
                "then try again."
            ),
        )
    _schedule_exit(request, RESTART_EXIT_CODE)
    return {
        "ok": True,
        "scheduled": True,
        "exit_code": RESTART_EXIT_CODE,
    }


@router.post("/shutdown")
async def shutdown(request: Request) -> dict:
    """Schedule a clean backend shutdown (rc=0).

    The supervisor only respawns on RESTART_EXIT_CODE (88); any other
    exit code ends the loop and the supervisor process exits normally.
    So rc=0 cleanly stops the whole theDAW console and the user has to
    relaunch via theDAW.bat.
    """
    _schedule_exit(request, 0)
    return {
        "ok": True,
        "scheduled": True,
        "exit_code": 0,
    }
