"""FastAPI router for the VJ sidecar module.

Endpoints:
  * GET  /api/vj/url     — returns the live URL of the running VJ
                           dev server, spawning it on first call.
                           Frontend wires the VJ iframe via this so
                           the port isn't hardcoded in TS.
  * GET  /api/vj/status  — non-spawning health check + diagnostics
                           for the Settings UI.
  * POST /api/vj/start   — explicit (foreground) spawn. Returns the
                           URL once Vite is ready.
  * POST /api/vj/stop    — terminates the sidecar.

The module also auto-spawns the VJ dev server on backend startup
(unless STABLEDAW_VJ_NO_AUTO_SPAWN is set) so by the time the user
clicks the VJ tab, the iframe loads instantly.
"""

from __future__ import annotations

import logging
import os
import threading

from fastapi import APIRouter, HTTPException

from . import sidecar

log = logging.getLogger(__name__)

router = APIRouter(tags=["vj"])

_auto_spawn_started = False
_auto_spawn_lock = threading.Lock()


def _maybe_auto_spawn() -> None:
    """Kick off ensure_running() in a background thread once. Called
    on the first /status / /url request so the heavy npm-install on
    first run doesn't block the request thread."""
    global _auto_spawn_started
    if os.environ.get("STABLEDAW_VJ_NO_AUTO_SPAWN"):
        return
    with _auto_spawn_lock:
        if _auto_spawn_started:
            return
        _auto_spawn_started = True

    def _spawn() -> None:
        try:
            url = sidecar.ensure_running()
            log.info("vj.router: auto-spawn ready at %s", url)
        except Exception as e:  # noqa: BLE001 — log and swallow
            log.warning("vj.router: auto-spawn failed: %s", e)

    threading.Thread(target=_spawn, daemon=True, name="vj-auto-spawn").start()


@router.get("/url")
def get_url() -> dict:
    """Return the URL of the running VJ dev server. Spawns it if it
    isn't running yet — the caller (frontend iframe) will block until
    Vite is ready, which on first run can take ~30s (npm install).

    Also returns ``mobile_url`` — a LAN-reachable address (or None if
    the machine has no non-loopback IP) so the frontend can render a QR
    code / shareable link for phones on the same Wi-Fi."""
    _maybe_auto_spawn()
    try:
        url = sidecar.ensure_running()
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    cfg = sidecar.resolve_config()
    return {
        "url": url,
        "mobile_url": sidecar.mobile_url_for(cfg.port),
        "lan_ip": sidecar.detect_lan_ip(),
    }


@router.get("/mobile")
def get_mobile() -> dict:
    """Return just the LAN-reachable mobile URL (spawning the server if
    needed). 503s with a clear message when no LAN IP is detectable so
    the UI can tell the user to connect to a network."""
    _maybe_auto_spawn()
    try:
        sidecar.ensure_running()
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    cfg = sidecar.resolve_config()
    mobile_url = sidecar.mobile_url_for(cfg.port)
    if not mobile_url:
        raise HTTPException(
            status_code=503,
            detail=(
                "No LAN IP detected — connect this machine to a network "
                "(Wi-Fi/Ethernet) so phones can reach the VJ output."
            ),
        )
    return {"mobile_url": mobile_url, "lan_ip": sidecar.detect_lan_ip()}


@router.get("/status")
def get_status() -> dict:
    """Non-spawning diagnostics. Returns probe() output verbatim plus
    a top-level `ok` boolean the Settings UI can pivot on."""
    _maybe_auto_spawn()
    info = sidecar.probe()
    info["ok"] = not info["issues"] and info["listening"]
    return info


@router.post("/start")
def post_start() -> dict:
    """Explicit foreground start. Same as /url but kept distinct so
    the frontend can show a spinner with a meaningful 'starting…'
    state when the user manually opts in from a stopped state."""
    try:
        url = sidecar.ensure_running()
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    return {"ok": True, "url": url}


@router.post("/stop")
def post_stop() -> dict:
    """Terminate the sidecar. Returns whether we actually stopped a
    live process (false = nothing was running)."""
    stopped = sidecar.stop()
    return {"ok": True, "stopped": stopped}
