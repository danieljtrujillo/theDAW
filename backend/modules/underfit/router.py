"""FastAPI router for the Underfit sidecar module.

Endpoints:
  * GET  /api/underfit/status — non-spawning health check + diagnostics.
  * POST /api/underfit/setup  — build underfit/.venv on demand (uv sync),
                                so a Pinokio or desktop install can create
                                the environment from the tab with no terminal.
  * GET  /api/underfit/setup-status — progress of an in-flight setup.
  * POST /api/underfit/start  — explicit spawn; returns the URL once the
                                dashboard answers.
  * POST /api/underfit/stop   — terminates the sidecar (only a process
                                we spawned; a manual instance is left
                                alone, and training runs always survive).
  * GET  /api/underfit/assistant/status — is the UNDERFIT assistant backend
                                (underfit/assistant-backend, :5473) running?
  * POST /api/underfit/assistant/start — start it; returns once it answers.
  * GET  /api/underfit/update-status — is dada-bots/underfit ahead of us?
  * POST /api/underfit/update — pull upstream into the vendored subrepo.
  * GET  /api/underfit/runs — the dashboard's training runs (id, name, status).
  * POST /api/underfit/runs/{id}/kill — stop a run's training process.
  * GET  /api/underfit/runs/{id}/config — that run's settings, shaped as the
                                body /runs/new takes.
  * POST /api/underfit/runs/new — start a run.

The four run routes exist for the footer's TRAIN key, which starts a run from
the last one's settings and stops the live one: the dashboard sends no CORS
headers, so the app cannot read it directly.

The module auto-spawns the dashboard, and the assistant backend its orb talks
to, at backend startup (unless ``theDAW_UNDERFIT_NO_AUTO_SPAWN`` is set;
``theDAW_UNDERFIT_ASSISTANT_NO_AUTO_SPAWN`` skips only the assistant) so the Underfit tab — which
polls :8791 directly and never calls this router — connects without the
user launching anything by hand.
"""

from __future__ import annotations

import logging
import os
import threading
from urllib.parse import quote

import httpx
from fastapi import APIRouter, Depends, HTTPException

from . import assistant_sidecar, sidecar, updater
from backend.core.startup import register_startup_hook
from backend.lib.cross_site import refuse_cross_site

log = logging.getLogger(__name__)

router = APIRouter(tags=["underfit"])

#: The run fields the footer key reads; the dashboard's other fields stay there.
#: ``gpu`` is here so TRAIN can put the next run on the card the last one used.
_RUN_FIELDS = ("id", "display_name", "status", "created_at", "max_steps", "gpu")


def _dashboard_client(timeout: float) -> httpx.Client:
    # trust_env=False: a system proxy must never sit between two local processes.
    return httpx.Client(timeout=timeout, trust_env=False)


def _dashboard_url() -> str:
    return f"http://127.0.0.1:{sidecar.resolve_config().port}"


@router.get("/status")
def get_status() -> dict:
    info = sidecar.probe()
    info["ok"] = not info["issues"] and info["listening"]
    return info


@router.post("/setup")
def post_setup() -> dict:
    """Create underfit/.venv on demand (uv sync) so the tab can build its own
    environment without a terminal. Returns immediately; poll /setup-status."""
    return sidecar.start_setup()


@router.get("/setup-status")
def get_setup_status() -> dict:
    return sidecar.setup_status()


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


@router.get("/assistant/status")
def get_assistant_status() -> dict:
    """The UNDERFIT assistant backend's state, for the orb's status line."""
    return assistant_sidecar.probe()


@router.post("/assistant/start", dependencies=[Depends(refuse_cross_site)])
def post_assistant_start() -> dict:
    """Start the assistant backend (installing its packages the first time).
    Blocks until it answers. The orb calls this from the dashboard's own origin,
    a loopback page, which refuse_cross_site lets through."""
    try:
        url = assistant_sidecar.ensure_running()
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    return {"ok": True, "url": url}


@router.get("/runs")
def get_runs() -> dict:
    """The dashboard's training runs. ``reachable`` is false when the dashboard
    did not answer, with an empty list."""
    try:
        with _dashboard_client(3.0) as client:
            r = client.get(f"{_dashboard_url()}/api/runs")
            r.raise_for_status()
            payload = r.json()
    except (httpx.HTTPError, ValueError) as e:
        return {"reachable": False, "runs": [], "error": str(e)}
    runs = [
        {k: run.get(k) for k in _RUN_FIELDS}
        for run in (payload if isinstance(payload, list) else [])
        if isinstance(run, dict) and run.get("id")
    ]
    return {"reachable": True, "runs": runs}


def _dashboard_body(r: httpx.Response) -> dict:
    """The dashboard's JSON object, or {} for anything else it printed."""
    try:
        body = r.json()
    except ValueError:
        return {}
    return body if isinstance(body, dict) else {}


def _raise_for_dashboard(r: httpx.Response, body: dict) -> None:
    """Pass the dashboard's own refusal through, with its own status and words."""
    if r.status_code < 400:
        return
    message = body.get("error") or f"the dashboard answered HTTP {r.status_code}"
    status = r.status_code if r.status_code in (400, 404, 409) else 502
    raise HTTPException(status_code=status, detail=str(message))


@router.post("/runs/{run_id}/kill")
def post_kill_run(run_id: str) -> dict:
    """Stop a training run: the dashboard kills its process group and marks it
    killed. The dashboard's refusal (unknown run, a run that is not live) comes
    back with its own status and message."""
    url = f"{_dashboard_url()}/api/runs/{quote(run_id, safe='')}/kill"
    try:
        with _dashboard_client(15.0) as client:
            r = client.post(url)
    except httpx.HTTPError as e:
        raise HTTPException(
            status_code=503, detail=f"The Underfit dashboard did not answer: {e}"
        ) from e
    body = _dashboard_body(r)
    _raise_for_dashboard(r, body)
    return body


@router.get("/runs/{run_id}/config")
def get_run_config(run_id: str) -> dict:
    """Everything needed to start the same training again.

    The dashboard's own "clone settings" answer for a run — base model, dataset,
    LoRA type, rank, alpha, include/exclude, learning rate, precision, demo
    settings — which is exactly the body /runs/new takes. The footer's TRAIN key
    reads it so one press repeats the last run instead of sending the user into
    the dashboard's form to retype what it already knows.
    """
    url = f"{_dashboard_url()}/api/clone_settings?run_id={quote(run_id, safe='')}"
    try:
        with _dashboard_client(10.0) as client:
            r = client.get(url)
    except httpx.HTTPError as e:
        raise HTTPException(
            status_code=503, detail=f"The Underfit dashboard did not answer: {e}"
        ) from e
    body = _dashboard_body(r)
    _raise_for_dashboard(r, body)
    # The dashboard answers 200 with {"error": ...} for a run it cannot read.
    if body.get("error"):
        raise HTTPException(status_code=404, detail=str(body["error"]))
    return body


@router.post("/runs/new")
def post_new_run(payload: dict) -> dict:
    """Start a training run.

    A straight pass-through of the dashboard's New Finetune body, so the footer
    sends what the form sends and every refusal (a name already taken, a dataset
    that is gone, no free GPU) arrives in the dashboard's own words. Training
    takes hours, so this returns as soon as the dashboard has spawned the run.
    """
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Expected a JSON object.")
    try:
        with _dashboard_client(60.0) as client:
            r = client.post(f"{_dashboard_url()}/api/runs/new", json=payload)
    except httpx.HTTPError as e:
        raise HTTPException(
            status_code=503, detail=f"The Underfit dashboard did not answer: {e}"
        ) from e
    body = _dashboard_body(r)
    _raise_for_dashboard(r, body)
    if body.get("error"):
        raise HTTPException(status_code=400, detail=str(body["error"]))
    return body


@router.get("/update-status")
def get_update_status(force: bool = False) -> dict:
    """Is dada-bots/underfit ahead of what we've synced? Cached; ``force`` re-checks."""
    return updater.check(force=force)


@router.post("/update")
def post_update() -> dict:
    """Pull upstream into the vendored subrepo (guarded; restarts the dashboard)."""
    result = updater.apply()
    if not result.get("ok"):
        code = 409 if result.get("reason") == "dirty_tree" else 500
        raise HTTPException(status_code=code, detail=result)
    return result


def startup_underfit() -> None:
    """Spawn the dashboard + check for upstream updates, both in background
    threads so a slow/broken checkout or the network never delays startup."""

    def _check() -> None:
        try:
            status = updater.check(force=True)
            if status.get("update_available"):
                log.info(
                    "underfit.router: upstream update available (%s)",
                    status.get("upstream"),
                )
        except Exception as e:  # log and swallow
            log.warning("underfit.router: update check failed: %s", e)

    threading.Thread(target=_check, daemon=True, name="underfit-update-check").start()

    if os.environ.get("theDAW_UNDERFIT_NO_AUTO_SPAWN"):
        return

    def _spawn() -> None:
        try:
            url = sidecar.ensure_running()
            log.info("underfit.router: auto-spawn ready at %s", url)
        except Exception as e:  # log and swallow
            log.warning("underfit.router: auto-spawn failed: %s", e)

    threading.Thread(target=_spawn, daemon=True, name="underfit-auto-spawn").start()

    if os.environ.get("theDAW_UNDERFIT_ASSISTANT_NO_AUTO_SPAWN"):
        return

    def _spawn_assistant() -> None:
        try:
            url = assistant_sidecar.ensure_running()
            log.info("underfit.router: assistant ready at %s", url)
        except RuntimeError as e:
            # probe() keeps the reason; the orb shows it next to its Start key.
            log.warning("underfit.router: assistant auto-start failed: %s", e)

    threading.Thread(
        target=_spawn_assistant, daemon=True, name="underfit-assistant-auto-spawn"
    ).start()


# Runs from the app lifespan (core/startup.py) rather than off the deprecated
# @router.on_event("startup"). There is no shutdown hook to go with it:
# core/teardown.py already stops this sidecar alongside every other one.
register_startup_hook("underfit", startup_underfit)
