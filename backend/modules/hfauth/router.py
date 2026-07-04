"""FastAPI router for the Hugging Face auth module (prefix ``/api/hfauth``).

    GET  /status     current login state (env or stored token, whoami-validated)
    POST /login      validate a token via whoami and persist it to the hub store
    POST /logout     remove the stored token
    GET  /login-url  where the frontend should open the system browser

Token detection is non-blocking: ``/status`` reads the ``HF_TOKEN`` env var
and huggingface_hub's standard token file locally, then validates the token
against ``whoami-v2`` in a daemon thread. The result is cached in module
memory for 10 minutes, so the first call may return
``{"logged_in": null, "checking": true}`` while validation is in flight.

Handlers are sync ``def`` functions, so Starlette runs them on its worker
thread pool -- the blocking httpx whoami call (10s timeout on login) never
touches the event loop.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

# huggingface_hub is an existing app dependency (used by the storage and
# modeldl modules). Its HF_TOKEN_PATH constant resolves the standard token
# file -- the same one `hf auth login` writes -- honoring HF_HOME overrides.
from huggingface_hub.constants import HF_TOKEN_PATH

log = logging.getLogger(__name__)

router = APIRouter()

_TOKEN_PATH = Path(HF_TOKEN_PATH)

_WHOAMI_URL = "https://huggingface.co/api/whoami-v2"
_LOGIN_URL = "https://huggingface.co/settings/tokens"
_LOGIN_TIMEOUT_S = 10.0
_STATUS_TIMEOUT_S = 8.0
_CACHE_TTL_S = 10 * 60  # definitive results (valid/invalid) hold for 10 min
_RETRY_TTL_S = 60  # indeterminate results (hub unreachable) retry sooner

# whoami-result cache, guarded by _cache_lock. ``token`` records which token
# the cached verdict applies to; a token change invalidates the cache.
_cache_lock = threading.Lock()
_cache: dict[str, Any] = {
    "token": None,
    "checked_at": 0.0,
    "logged_in": None,
    "username": None,
}
_check_in_flight = False


def _detect_token() -> tuple[str | None, str]:
    """(token, source) using only local reads -- no network. ``source`` is
    'env' | 'stored' | 'none'; the env var wins, matching huggingface_hub."""
    env_token = os.environ.get("HF_TOKEN", "").strip()
    if env_token:
        return env_token, "env"
    try:
        stored = _TOKEN_PATH.read_text(encoding="utf-8").strip()
    except OSError:
        stored = ""
    if stored:
        return stored, "stored"
    return None, "none"


def _whoami(token: str, timeout: float) -> str:
    """The username for ``token``. Raises httpx.HTTPStatusError on a rejected
    token, httpx.HTTPError on network trouble, ValueError on an odd payload."""
    with httpx.Client(timeout=timeout) as client:
        resp = client.get(_WHOAMI_URL, headers={"Authorization": f"Bearer {token}"})
        resp.raise_for_status()
        data = resp.json()
    name = data.get("name") if isinstance(data, dict) else None
    if not name:
        raise ValueError("whoami response had no username")
    return str(name)


def _cache_fresh(token: str) -> bool:
    """Whether the cached verdict still applies to ``token``. Caller holds
    _cache_lock. Indeterminate (offline) verdicts expire faster."""
    if _cache["token"] != token:
        return False
    ttl = _CACHE_TTL_S if _cache["logged_in"] is not None else _RETRY_TTL_S
    return (time.time() - float(_cache["checked_at"])) < ttl


def _background_check(token: str) -> None:
    """Daemon-thread body: validate ``token`` via whoami and cache the verdict.
    A network failure caches ``logged_in: None`` so /status reports unknown
    instead of wrongly logging the user out while offline."""
    global _check_in_flight
    logged_in: bool | None = None
    username: str | None = None
    try:
        username = _whoami(token, _STATUS_TIMEOUT_S)
        logged_in = True
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code in (401, 403):
            logged_in = False
        else:
            log.warning("hfauth: whoami returned HTTP %s", exc.response.status_code)
    except (httpx.HTTPError, ValueError) as exc:
        log.warning("hfauth: whoami check failed: %s", exc)
    with _cache_lock:
        _check_in_flight = False
        _cache.update(
            {
                "token": token,
                "checked_at": time.time(),
                "logged_in": logged_in,
                "username": username,
            }
        )


class LoginRequest(BaseModel):
    token: str


@router.get("/status")
def status() -> dict[str, Any]:
    """Login state without ever blocking on the network: cached verdicts are
    served directly; otherwise a daemon thread revalidates and this call
    returns ``{"logged_in": null, "checking": true}`` in the meantime."""
    global _check_in_flight
    token, source = _detect_token()
    if token is None:
        return {"logged_in": False, "username": None, "token_source": "none"}
    with _cache_lock:
        if _cache_fresh(token):
            if _cache["logged_in"] is None:
                # Last check could not reach the Hub; report unknown until
                # the shorter retry TTL lapses.
                return {
                    "logged_in": None,
                    "username": None,
                    "token_source": source,
                    "checking": bool(_check_in_flight),
                }
            return {
                "logged_in": _cache["logged_in"],
                "username": _cache["username"],
                "token_source": source,
            }
        if not _check_in_flight:
            _check_in_flight = True
            threading.Thread(
                target=_background_check,
                args=(token,),
                name="hfauth-whoami",
                daemon=True,
            ).start()
    return {
        "logged_in": None,
        "username": None,
        "token_source": source,
        "checking": True,
    }


@router.post("/login")
def login(body: LoginRequest) -> dict[str, Any]:
    """Validate the submitted token via whoami (10s timeout, on the request's
    worker thread) and persist it to huggingface_hub's standard token file."""
    token = body.token.strip()
    if not token:
        raise HTTPException(status_code=401, detail="Empty token")
    try:
        username = _whoami(token, _LOGIN_TIMEOUT_S)
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code in (401, 403):
            raise HTTPException(
                status_code=401, detail="Invalid Hugging Face token"
            ) from exc
        raise HTTPException(
            status_code=502,
            detail=f"huggingface.co returned HTTP {exc.response.status_code}",
        ) from exc
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(
            status_code=503, detail=f"Could not reach huggingface.co: {exc}"
        ) from exc

    # Persist to huggingface_hub's standard token store (the same file the
    # hub library and CLI read), so hf_hub_download etc. pick it up.
    try:
        _TOKEN_PATH.parent.mkdir(parents=True, exist_ok=True)
        _TOKEN_PATH.write_text(token, encoding="utf-8")
    except OSError as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Token validated but could not be stored: {exc}",
        ) from exc

    if os.environ.get("HF_TOKEN", "").strip():
        log.info(
            "hfauth: HF_TOKEN env var is set and takes precedence over the stored token"
        )
    with _cache_lock:
        _cache.update(
            {
                "token": token,
                "checked_at": time.time(),
                "logged_in": True,
                "username": username,
            }
        )
    return {"logged_in": True, "username": username}


@router.post("/logout")
def logout() -> dict[str, Any]:
    """Remove the stored token file and drop the cached verdict."""
    try:
        _TOKEN_PATH.unlink(missing_ok=True)
    except OSError as exc:
        raise HTTPException(
            status_code=500, detail=f"Could not remove stored token: {exc}"
        ) from exc
    if os.environ.get("HF_TOKEN", "").strip():
        log.warning(
            "hfauth: HF_TOKEN env var is still set; it keeps the session "
            "authenticated until the process env changes"
        )
    with _cache_lock:
        _cache.update(
            {
                "token": None,
                "checked_at": 0.0,
                "logged_in": None,
                "username": None,
            }
        )
    return {"logged_in": False}


@router.get("/login-url")
def login_url() -> dict[str, str]:
    """Where the frontend should open the system browser to mint a token."""
    return {"url": _LOGIN_URL}
