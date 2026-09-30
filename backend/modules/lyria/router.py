"""HTTP surface for the Lyria 3 Pro sidecar.

Mirrors backend/modules/vj/router.py in shape: the frontend asks GET /url for
the sidecar's URL and mounts the iframe on a 200. GET /url itself never
starts anything: when no Lyria is listening it answers 503 and the panel
posts /start, which blocks server-side until the child is listening (and
runs the first npm install), while the view retries. Starting the child runs
a program on this machine, so it stays behind the change gate (_CHANGES)
with every other state-changing route; the reads answer anyone who can reach
the port. Warm-up is request-driven (there is no FastAPI startup hook) so
the Node process only starts when someone actually opens the Lyria panel,
and only when that someone passes the change gate.

This module deliberately does NOT proxy Lyria's own API. The embedded iframe
loads directly from the sidecar's origin, so its relative /api/* fetches
resolve against its own server. That is what lets Lyria's frontend stay
byte-for-byte as-is: no CORS, no base URL, no client rewrite.

Setup lives here too, so Settings can fix a missing Lyria without naming a
git command:

    POST /install          clone the latest StarskreamEXE/lyria-3-pro into
                           the expected folder (needs git) and run its npm
                           install, in the background; output goes to the
                           sidecar log
    GET  /install/status   poll the install
    POST /update           fast-forward a clean checkout to the latest commit
                           of the repo's default branch, in the background,
                           stopping Lyria for the move and starting it again
    GET  /update           poll the update; ``?check=true`` also asks GitHub
                           for the latest commit (at most once per ten
                           minutes) so the panel can say one is waiting
    GET  /key              is a GEMINI_API_KEY known, and from where
    POST /key {key}        append a Gemini key theDAW hands the sidecar
    DELETE /key            forget the stored Gemini keys
    GET  /keys             per-provider COUNTS and sources (never values)
    POST /keys {provider,key}     append a key for that provider
    DELETE /keys {provider,index} forget the stored key at that position
    POST /keys/provider {provider}  gemini | openrouter | "" for auto
    POST /keys/pool {share}       hand the assistant's pooled keys to Lyria too
    POST /restart          end the Lyria on the port (ours, or one adopted
                           from the configured checkout) and start a fresh
                           child with the current keys

The /key trio is the original single-Gemini surface, kept working: POST now
appends rather than replaces, because a checkout with server/keys.ts tries the
keys in order and skips a rejected one, so a second key is a fallback and not
a correction.

Every route that changes keys stops a running sidecar, so the next open hands
the child the new environment -- the child reads its keys from the environment
at spawn, not per request. A Lyria this process did not spawn (``external``)
keeps its old keys; those routes say so, and POST /restart replaces it.

Every route that changes state -- keys, the provider, the pool switch,
install, start, stop, restart, import -- is gated by ``refuse_cross_site``
(no foreign page) AND ``require_loopback_launch_or_pairing_token`` (this
machine, the desktop shell or a paired phone): the server binds 0.0.0.0, so
without the second gate any device on the LAN could delete the user's keys,
stop the sidecar, or run the install. The GET routes only report.

No response body here ever carries key material.

INT-002 adds two routes at the bottom of this file that DO reach into the
sidecar -- over its loopback origin only, and for its own generation listing:

    POST /import-new       register new sidecar generations as library entries
    GET  /imports          seen-map counts (which generations are already in)
"""

from __future__ import annotations

import asyncio
import logging
import os
import threading

from fastapi import APIRouter, Body, Depends, HTTPException, Request

from backend.lib.cross_site import (
    refuse_cross_site,
    require_loopback_launch_or_pairing_token,
)
from backend.modules.genaiproxy.access import caller_is_loopback

from . import importer, sidecar

log = logging.getLogger(__name__)

router = APIRouter(tags=["lyria"])

#: The gate on every route that changes something. See the module docstring.
_CHANGES = [
    Depends(refuse_cross_site),
    Depends(require_loopback_launch_or_pairing_token),
]

_auto_spawn_lock = threading.Lock()
_auto_spawn_started = False


def _caller_may_change(request: Request) -> bool:
    """Whether ``request`` would pass ``_CHANGES``: theDAW's own UI, the
    desktop shell or a paired device. The read routes use it to decide
    whether to kick the warm-up, so a read from anyone else stays a read."""
    try:
        refuse_cross_site(request)
        require_loopback_launch_or_pairing_token(request)
    except HTTPException:
        return False
    return True


def _maybe_auto_spawn() -> None:
    """Kick a one-time background readiness thread.

    Fires on the first read endpoint from a caller ``_CHANGES`` would pass,
    rather than at import: spawning a Node process for a panel the user may
    never open wastes memory. The work runs on a daemon thread so a first-run
    npm install never blocks the request.
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
        except Exception as e:  # warm-up is best-effort
            log.warning("lyria.router: warm-up failed: %s", e)

    threading.Thread(target=_warm, daemon=True, name="lyria-warm").start()


#: The 503 detail GET /url answers when no Lyria is listening. The panel
#: posts /start on any failed read; the words are for a caller that cannot.
NOT_RUNNING_DETAIL = (
    "Lyria is not running. Open the Lyria tab in theDAW, or press Start on "
    "the Lyria card in Settings > Models."
)


@router.get("/url")
async def url(request: Request) -> dict:
    """Return the URL the Lyria app is served on, without starting it.

    A 200 means a Lyria answers on the port, so the frontend can mount the
    iframe. 503 with :data:`NOT_RUNNING_DETAIL` when nothing listens there,
    and 503 with the sidecar's port-collision diagnostic when something else
    does. Starting the child is ``POST /start``'s job, behind the change
    gate; a caller that gate would pass also kicks the background warm-up
    here, so opening the panel still starts Lyria without a second click.
    """
    if _caller_may_change(request):
        _maybe_auto_spawn()
    try:
        # The identity probe makes a TCP connect and an HTTP request -- off
        # the event loop like the other sidecar calls in this file.
        live = await asyncio.to_thread(sidecar.running_url)
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    if live is None:
        raise HTTPException(status_code=503, detail=NOT_RUNNING_DETAIL)
    cfg = sidecar.resolve_config()
    lan_ip = sidecar.detect_lan_ip()
    # Only claim a cost mode (mock/live) for a process WE spawned -- theDAW
    # controls that process's environment (LYRIA_MOCK). An adopted listener
    # someone launched manually may be running with a different, unknown
    # cost mode, so claiming "mock" for it would be a straight-up lie (item 5).
    # owns_process() takes _state_lock, which can be held by a concurrent
    # ensure_running()/stop() for a while -- off the loop like the rest.
    owns = await asyncio.to_thread(sidecar.owns_process)
    mode = ("mock" if cfg.mock else "live") if owns else "external"
    return {
        "url": live,
        "mode": mode,
        "mock": cfg.mock if owns else None,
        "external": not owns,
        "port": cfg.port,
        "mobile_url": f"http://{lan_ip}:{cfg.port}" if lan_ip else None,
        "lan_ip": lan_ip,
        # What the last Update or latest-commit check found; ``reason`` says
        # why a checkout was left where it is, for the panel to show.
        "checkout": sidecar.checkout_state(),
    }


@router.get("/status")
async def status(request: Request) -> dict:
    """Non-spawning diagnostics, plus a warm kick so opening Settings starts
    the child in the background (for a caller the change gate would pass)."""
    if _caller_may_change(request):
        _maybe_auto_spawn()
    # probe() now includes an HTTP identity call (_is_lyria_server) on top of
    # the TCP check, so it can block for up to that request's timeout --
    # keep it off the event loop like the other sidecar calls in this file.
    info = await asyncio.to_thread(sidecar.probe)
    info["ok"] = not info["issues"] and info["listening"]
    return info


@router.post("/start", dependencies=_CHANGES)
async def start() -> dict:
    """Foreground spawn: blocks until the child is listening (installs
    included). The panel posts it whenever GET /url says nothing is running,
    and its Retry button does the same."""
    try:
        live = await asyncio.to_thread(sidecar.ensure_running)
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    return {"ok": True, "url": live}


@router.post("/stop", dependencies=_CHANGES)
async def stop() -> dict:
    # stop() can taskkill+wait(5)+kill+wait(5) -- up to ~10s -- off the loop.
    stopped = await asyncio.to_thread(sidecar.stop)
    return {"ok": True, "stopped": stopped}


@router.post("/restart", dependencies=_CHANGES)
async def restart() -> dict:
    """End the Lyria on the port and start a fresh child, which reads the
    current keys, provider and cost mode. This is how a Lyria adopted from an
    earlier session (``external`` in /url) gets theDAW's keys: stop() holds no
    handle to it. 409 when the port is held by something theDAW will not end
    (not Lyria, a Lyria from another folder, a process it cannot see), 503
    when the fresh child does not come up -- each with the reason."""
    try:
        live = await asyncio.to_thread(sidecar.restart)
    except sidecar.RestartRefused as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    owns = await asyncio.to_thread(sidecar.owns_process)
    cfg = sidecar.resolve_config()
    return {
        "ok": True,
        "url": live,
        "mode": ("mock" if cfg.mock else "live") if owns else "external",
        "mock": cfg.mock if owns else None,
        "external": not owns,
        "checkout": sidecar.checkout_state(),
    }


# ── setup: clone + npm install, from a button ────────────────────────────────


@router.post("/install", dependencies=_CHANGES)
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


# ── update: fast-forward to the latest commit, from the Lyria panel ──────────


@router.post("/update", dependencies=_CHANGES)
async def update() -> dict:
    """Fast-forward the checkout to the latest commit of the Lyria repo's
    default branch, in the background. Returns the update state right away;
    poll GET /update. A checkout with local changes, on its own branch, or
    managed through theDAW_LYRIA_PROJECT is left alone, and the finished
    state's ``message`` says why. 409 when there is no checkout yet or an
    Install is running."""
    try:
        return await asyncio.to_thread(sidecar.start_update)
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e


@router.get("/update")
async def update_status(check: bool = False) -> dict:
    """The update job, the checkout state, and the latest commit theDAW knows
    of. ``check=true`` asks GitHub (``git ls-remote``, rate-limited in the
    sidecar) before answering."""
    latest = await asyncio.to_thread(sidecar.check_latest) if check else None
    cfg = sidecar.resolve_config()
    return {
        "job": sidecar.update_status(),
        "checkout": sidecar.checkout_state(),
        "latest": latest,
        "compat": await asyncio.to_thread(sidecar.checkout_compat, cfg.project_path),
    }


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


@router.post("/key", dependencies=_CHANGES)
async def set_key(key: str = Body(..., embed=True)) -> dict:
    """Append a Gemini key. A running sidecar is stopped so the next open hands
    it the new environment (the child reads GEMINI_API_KEY at spawn)."""
    value = (key or "").strip()
    if len(value) < 8:
        raise HTTPException(
            status_code=400, detail="That does not look like an API key."
        )
    sidecar.set_gemini_key(value)
    # stop() can taskkill+wait(5)+kill+wait(5) -- up to ~10s -- off the loop.
    restarted = await asyncio.to_thread(sidecar.stop)
    key_value, source = sidecar.gemini_key()
    return {
        "ok": True,
        "configured": bool(key_value),
        "source": source,
        "prefix": (key_value[:6] + "…") if key_value else None,
        "restarted": restarted,
    }


@router.delete("/key", dependencies=_CHANGES)
async def clear_key() -> dict:
    """Forget the stored Gemini keys. A running sidecar is stopped, as every
    other key change does, so it cannot keep using a key the user removed."""
    removed = await asyncio.to_thread(sidecar.clear_gemini_key)
    restarted = await asyncio.to_thread(sidecar.stop)
    key, source = sidecar.gemini_key()
    return {
        "ok": True,
        "removed": removed,
        "configured": bool(key),
        "source": source,
        "restarted": restarted,
    }


# ── per-provider ordered key lists ───────────────────────────────────────────
#
# The embedded app takes an ordered list per provider and skips a rejected key
# (its server/keys.ts), so theDAW stores lists, not single keys. These routes
# report COUNTS and SOURCES only: a list UI has no use for the values, and a
# response body is the easiest place to leak one.


def _bad_provider(e: ValueError) -> HTTPException:
    return HTTPException(status_code=400, detail=str(e))


async def _stopped_summary() -> dict:
    """Stop a running sidecar (so the next open gets the new environment) and
    return the fresh key summary. Same contract as POST /key.

    ``external_running`` is True when a Lyria this process did not spawn still
    serves the port: stop() cannot end it, so it keeps the old keys until the
    user presses Restart in the Lyria panel (POST /restart)."""
    # stop() can taskkill+wait(5)+kill+wait(5) -- up to ~10s -- off the loop.
    restarted = await asyncio.to_thread(sidecar.stop)
    summary = await asyncio.to_thread(sidecar.key_summary)
    external = await asyncio.to_thread(sidecar.adopted_running)
    return {
        "ok": True,
        "restarted": restarted,
        "external_running": external,
        **summary,
    }


@router.get("/keys")
async def keys_status() -> dict:
    """Per-provider counts and sources. Never key values."""
    return await asyncio.to_thread(sidecar.key_summary)


@router.post("/keys", dependencies=_CHANGES)
async def add_provider_key(
    provider: str = Body(..., embed=True), key: str = Body(..., embed=True)
) -> dict:
    """Append a key to one provider's ordered list."""
    value = (key or "").strip()
    if len(value) < 8:
        raise HTTPException(
            status_code=400, detail="That does not look like an API key."
        )
    try:
        await asyncio.to_thread(sidecar.add_key, provider, value)
    except ValueError as e:
        raise _bad_provider(e) from e
    return await _stopped_summary()


@router.delete("/keys", dependencies=_CHANGES)
async def remove_provider_key(
    provider: str = Body(..., embed=True), index: int = Body(..., embed=True)
) -> dict:
    """Forget the stored key at ``index``. Positions index the STORED list
    only -- keys that come from the environment or the assistant's pool are
    not theDAW's to remove, and are removed where they were set."""
    try:
        removed = await asyncio.to_thread(sidecar.remove_key, provider, index)
    except ValueError as e:
        raise _bad_provider(e) from e
    if not removed:
        raise HTTPException(
            status_code=404, detail=f"No stored key at position {index}."
        )
    return await _stopped_summary()


@router.post("/keys/provider", dependencies=_CHANGES)
async def set_key_provider(provider: str | None = Body(None, embed=True)) -> dict:
    """Set the provider the child should default to. An empty value clears the
    preference, which hands the choice back to the keys (and then to the
    child's own default when both providers are available)."""
    try:
        await asyncio.to_thread(sidecar.set_provider_preference, provider)
    except ValueError as e:
        raise _bad_provider(e) from e
    return await _stopped_summary()


@router.post("/keys/pool", dependencies=_CHANGES)
async def set_key_pool(share: bool = Body(..., embed=True)) -> dict:
    """Turn "share the assistant's key pool with Lyria" on or off. Off (the
    default) the child gets the keys the user entered in the Lyria card, the
    environment's, and the first pooled Gemini key only when neither of those
    has one; on, every pooled Gemini, OpenRouter and openrouter-free key
    follows them."""
    await asyncio.to_thread(sidecar.set_pool_shared, share is True)
    return await _stopped_summary()


# ── INT-002: the sidecar's generations, as first-class library entries ───────
#
# The embedded app keeps its own library; these two routes are what makes a
# track generated in the panel a theDAW entry (catalog, lineage, EDIT, stems,
# export). The work itself lives in importer.py -- see its module docstring for
# the loopback-only download rule and the seen map.


@router.post("/import-new", dependencies=_CHANGES)
async def import_new(
    request: Request, include_mock: bool = Body(False, embed=True)
) -> dict:
    """Import every sidecar generation the library does not have yet.

    Body is optional; ``{"include_mock": true}`` opts in to the locally
    synthesized mock audio the sidecar produces in its default cost-safe mode,
    and is honoured only for a caller on this machine (loopback): the panel
    never sends it, and a paired device must not be able to fill the library
    with sine waves. Never raises for a stopped sidecar -- that answers with a
    ``reason``.
    """
    include = include_mock is True and caller_is_loopback(request)
    return await importer.sync_generations(include_mock=include)


@router.get("/imports")
async def imports() -> dict:
    """Counts and ids from the seen map. Never audio, never a prompt."""
    # Reads a file off disk -- off the loop, consistent with the rest here.
    return await asyncio.to_thread(importer.imports_summary)
