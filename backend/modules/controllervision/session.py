"""Phone-pairing sessions for controller image capture.

The desktop can't easily take a photo of the controller it's plugged into, so
we let a PHONE do it: the desktop opens a session, shows a QR, the phone loads a
tiny self-contained upload page (served by THIS backend over the LAN — no
frontend build needed on the phone), snaps/uploads a photo, the backend runs the
CV detection, and the desktop polls the session for the result.

In-memory, short-TTL, no DB. A session id is a short random token. Sessions hold
at most one pending result; they expire after SESSION_TTL so abandoned pairings
don't leak. Everything stays on the LAN (the QR points at the machine's LAN IP).
"""

from __future__ import annotations

import secrets
import threading
import time
from typing import Any, Optional

SESSION_TTL = 600.0  # seconds — a pairing is good for 10 minutes


class _Session:
    __slots__ = ("id", "created", "result", "received_at")

    def __init__(self, sid: str) -> None:
        self.id = sid
        self.created = time.time()
        self.result: Optional[dict[str, Any]] = None
        self.received_at: Optional[float] = None


_lock = threading.Lock()
_sessions: dict[str, _Session] = {}


def _prune(now: float) -> None:
    """Drop expired sessions (caller holds the lock)."""
    dead = [sid for sid, s in _sessions.items() if now - s.created > SESSION_TTL]
    for sid in dead:
        _sessions.pop(sid, None)


def create_session() -> str:
    sid = secrets.token_urlsafe(16)
    now = time.time()
    with _lock:
        _prune(now)
        _sessions[sid] = _Session(sid)
    return sid


def set_result(sid: str, result: dict[str, Any]) -> bool:
    """Store the CV result a phone produced. Returns False for unknown/expired."""
    now = time.time()
    with _lock:
        _prune(now)
        s = _sessions.get(sid)
        if s is None:
            return False
        s.result = result
        s.received_at = now
        return True


def get_status(sid: str) -> Optional[dict[str, Any]]:
    """Poll a session. None if unknown/expired; else a status dict the desktop
    can read (pending until the phone uploads, then the CV result)."""
    now = time.time()
    with _lock:
        _prune(now)
        s = _sessions.get(sid)
        if s is None:
            return None
        if s.result is None:
            return {"id": sid, "status": "pending"}
        return {"id": sid, "status": "ready", "result": s.result}


def session_exists(sid: str) -> bool:
    now = time.time()
    with _lock:
        _prune(now)
        return sid in _sessions
