"""FastAPI router for the Underfit sidecar module.

Endpoints:
  * GET  /api/underfit/status — non-spawning health check + diagnostics.
  * POST /api/underfit/start  — explicit spawn; returns the URL once the
                                dashboard answers.
  * POST /api/underfit/stop   — terminates the sidecar (only a process
                                we spawned; a manual instance is left
                                alone, and training runs always survive).

The module auto-spawns the dashboard at backend startup (unless
``theDAW_UNDERFIT_NO_AUTO_SPAWN`` is set) so the Underfit tab — which
polls :8791 directly and never calls this router — connects without the
user launching anything by hand.
"""

from __future__ import annotations

import logging
import os
import threading

from fastapi import APIRouter, HTTPException

from . import sidecar

log = logging.getLogger(__name__)

router = APIRouter(tags=["underfit"])


@router.get("/status")
def get_status() -> dict:
    info = sidecar.probe()
    info["ok"] = not info["issues"] and info["listening"]
    return info


@router.post("/start")
def post_start() -> dict:
    try:
        url = sidecar.ensure_running()
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    return {"ok": True, "url": url}


@router.post("/stop")
def post_stop() -> dict:
    stopped = sidecar.stop()
    return {"ok": True, "stopped": stopped}


@router.on_event("startup")
def startup_underfit() -> None:
    """Spawn in a background thread so a slow/broken underfit checkout
    never delays backend startup."""
    if os.environ.get("theDAW_UNDERFIT_NO_AUTO_SPAWN"):
        return

    def _spawn() -> None:
        try:
            url = sidecar.ensure_running()
            log.info("underfit.router: auto-spawn ready at %s", url)
        except Exception as e:  # noqa: BLE001 — log and swallow
            log.warning("underfit.router: auto-spawn failed: %s", e)

    threading.Thread(target=_spawn, daemon=True, name="underfit-auto-spawn").start()


@router.on_event("shutdown")
def shutdown_underfit() -> None:
    sidecar.stop()
