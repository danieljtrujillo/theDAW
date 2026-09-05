"""HTTP surface for the Lyria 3 Pro sidecar.

Mirrors backend/modules/vj/router.py: the frontend asks GET /url, which blocks
server-side until the child is listening, and the view retries while that
happens. Warm-up is request-driven (there is no FastAPI startup hook) so the
Node process only starts when someone actually opens the Lyria panel.

This module deliberately does NOT proxy Lyria's own API. The embedded iframe
loads directly from the sidecar's origin, so its relative /api/* fetches
resolve against its own server. That is what lets Lyria's frontend stay
byte-for-byte as-is: no CORS, no base URL, no client rewrite.

Setup lives here too, so Settings can fix a missing Lyria without naming a
git command:

    POST /install          clone StarskreamEXE/lyria-3-pro into the expected
                           folder (needs git) and run its npm install, in the
                           background; output goes to the sidecar log
    GET  /install/status   poll the install
    GET  /key              is a GEMINI_API_KEY known, and from where
    POST /key {key}        store the key theDAW hands the sidecar
    DELETE /key            forget the stored key
"""

from __future__ import annotations

import logging
import os
import threading

from fastapi import APIRouter, Body, HTTPException

from . import sidecar

log = logging.getLogger(__name__)

router = APIRouter(tags=["lyria"])

_auto_spawn_lock = threading.Lock()
_auto_spawn_started = False


def _maybe_auto_spawn() -> None:
    """Kick a one-time background readiness thread.

    Fires on the first read endpoint rather than at import: spawning a Node
    process for a panel the user may never open wastes memory. The work runs
    on a daemon thread so a first-run npm install never blocks the request.
    """
    global _auto_spawn_started
    if os.environ.get("theDAW_LYRIA_NO_AUTO_SPAWN"):
        return
    # Nothing to warm until the checkout exists; the install route is the
    # path that creates it, and a warm-up would only log the same complaint.
    if not sidecar.project_present():
        return
    with _auto_spawn_lock:
        if _auto_spawn_started:
            return
        _auto_spawn_started = True

    def _warm() -> None:
        try:
            sidecar.ensure_running()
        except Exception as e:  # noqa: BLE001 - warm-up is best-effort
            log.warning("lyria.router: warm-up failed: %s", e)

    threading.Thread(target=_warm, daemon=True, name="lyria-warm").start()


@router.get("/url")
async def url() -> dict:
    """Return the URL the Lyria app is served on, spawning it if needed.

    Blocks until the child is listening (up to the sidecar's readiness
    deadline), so the frontend can treat a 200 as "safe to mount the iframe".
    503 on failure, with the sidecar's diagnostic as the detail.
    """
    _maybe_auto_spawn()
    try:
        live = sidecar.ensure_running()
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    cfg = sidecar.resolve_config()
    lan_ip = sidecar.detect_lan_ip()
    return {
        "url": live,
        "mode": "mock" if cfg.mock else "live",
        "mock": cfg.mock,
        "port": cfg.port,
        "mobile_url": f"http://{lan_ip}:{cfg.port}" if lan_ip else None,
        "lan_ip": lan_ip,
    }


@router.get("/status")
async def status() -> dict:
    """Non-spawning diagnostics, plus a warm kick so opening Settings starts
    the child in the background."""
    _maybe_auto_spawn()
    info = sidecar.probe()
    info["ok"] = not info["issues"] and info["listening"]
    return info


@router.post("/start")
async def start() -> dict:
    """Foreground spawn. Used by the view's Retry button."""
    try:
        live = sidecar.ensure_running()
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    return {"ok": True, "url": live}


@router.post("/stop")
async def stop() -> dict:
    return {"ok": True, "stopped": sidecar.stop()}


# ── setup: clone + npm install, from a button ────────────────────────────────


@router.post("/install")
async def install() -> dict:
    """Clone the Lyria project into the folder the sidecar expects and run its
    npm install, in the background. Returns the install state right away;
    poll GET /install/status. 409 when a prerequisite is missing (git for the
    clone, Node.js for npm), naming it."""
    try:
        return sidecar.start_install()
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e


@router.get("/install/status")
async def install_status() -> dict:
    return sidecar.install_status()


# ── GEMINI_API_KEY the sidecar is handed ─────────────────────────────────────


@router.get("/key")
async def key_status() -> dict:
    key, source = sidecar.gemini_key()
    return {
        "configured": bool(key),
        "source": source,
        "prefix": (key[:6] + "…") if key else None,
        "mock": sidecar.is_mock(),
    }


@router.post("/key")
async def set_key(key: str = Body(..., embed=True)) -> dict:
    """Store the key. A running sidecar is stopped so the next open hands it
    the new key (the child reads GEMINI_API_KEY from its environment)."""
    value = (key or "").strip()
    if len(value) < 8:
        raise HTTPException(
            status_code=400, detail="That does not look like an API key."
        )
    sidecar.set_gemini_key(value)
    restarted = sidecar.stop()
    key_value, source = sidecar.gemini_key()
    return {
        "ok": True,
        "configured": bool(key_value),
        "source": source,
        "prefix": (key_value[:6] + "…") if key_value else None,
        "restarted": restarted,
    }


@router.delete("/key")
async def clear_key() -> dict:
    removed = sidecar.clear_gemini_key()
    key, source = sidecar.gemini_key()
    return {"ok": True, "removed": removed, "configured": bool(key), "source": source}
