"""The phone-companion LAN pairing token.

A phone reaching this backend over a plain ``http://<lan-ip>`` share link is
not a secure context, so its browser sends no ``Sec-Fetch-Site`` at all (only
HTTPS and loopback origins get that header) -- indistinguishable, on headers
alone, from a bare script on the LAN forging a local-looking ``Origin``
(SEC-001). A real secret is the only thing that tells them apart.

This token is that secret. It is generated once, persisted under the app
data dir so it survives a restart, and handed to the desktop UI only over a
loopback-or-launch-token-gated route (``GET /api/pairing/token``); the UI puts
it in the share link's URL *fragment* (``#pair=<token>``), which a browser
never sends to any server and no proxy or server log ever sees. The phone's
``frontend/src/lib/pairing.ts`` reads it once, stores it in
``localStorage``, and attaches it as the ``X-TheDAW-Pair`` header on every
API request after that.

Threat model, stated plainly: the fragment only keeps the token out of
server/proxy logs and out of ``Referer`` -- once the phone has it, every
request after that sends it as a plain HTTP header over the LAN in
cleartext (this is not HTTPS). That defends against a hostile *script*
sharing the LAN (SEC-001's actual threat: no network access needed, just an
open tab or a process on the same Wi-Fi), NOT against a network
eavesdropper who can already see the LAN's traffic -- packet capture,
ARP spoofing, a hostile access point. Against that class of attacker this
token gives no protection, and neither would any other bearer token sent
over plain HTTP.
"""

from __future__ import annotations

import hmac
import logging
import secrets
import threading

from fastapi import Request

from backend.lib import paths
from backend.lib.atomic import atomic_write

log = logging.getLogger(__name__)

__all__ = ["HEADER", "get_token", "regenerate_token", "header_matches"]

HEADER = "X-TheDAW-Pair"

_TOKEN_FILE = paths.data_path("pairing_token.txt")

_lock = threading.Lock()
_cached: str | None = None


def _new_token() -> str:
    return secrets.token_urlsafe(32)


def _write(token: str) -> None:
    atomic_write(_TOKEN_FILE, token, mode=0o600)


def get_token() -> str:
    """The current pairing token, generating and persisting one on first use."""
    global _cached
    with _lock:
        if _cached is not None:
            return _cached
        try:
            existing = _TOKEN_FILE.read_text(encoding="utf-8").strip()
        except (OSError, UnicodeDecodeError):
            # Covers reading only: a corrupt/undecodable file, a directory in
            # its place, or any other OSError. Falls through to minting a
            # fresh token below (see there for what covers *persisting* it).
            existing = ""
        if existing:
            _cached = existing
            return existing
        token = _new_token()
        try:
            _write(token)
        except OSError:
            # Persisting failed too (the same directory-in-place-of-file
            # case, a read-only file, disk full, ...): fail open rather than
            # 500ing every pairing-gated route and the recovery route right
            # along with it. Every call in THIS process session gets the
            # same token via the cache below; it just will not survive a
            # restart until whatever is blocking the write is fixed.
            log.warning(
                "pairing: could not persist a new token; using an "
                "in-memory-only one for this process",
                exc_info=True,
            )
        _cached = token
        return token


def regenerate_token() -> str:
    """Replace the pairing token, invalidating every share link issued so far."""
    global _cached
    with _lock:
        token = _new_token()
        try:
            _write(token)
        except OSError:
            # Same fail-open posture as get_token(): a persist failure must
            # not 500 the recovery route. Every call in THIS process session
            # gets the new token via the cache below. But leaving the OLD
            # token on disk here would silently undo the revocation on the
            # next restart -- get_token() would read it back and hand it out
            # again as if regenerate_token() had never been called. Best-
            # effort delete the stale file instead, so a restart mints a
            # fresh token rather than resurrecting the revoked one; if the
            # delete also fails, the in-memory token still covers this
            # process, same as before.
            try:
                _TOKEN_FILE.unlink(missing_ok=True)
            except OSError:
                pass
            log.warning(
                "pairing: could not persist a regenerated token; using an "
                "in-memory-only one for this process, and removed the stale "
                "on-disk token so a restart does not resurrect it",
                exc_info=True,
            )
        _cached = token
        return token


def header_matches(request: Request) -> bool:
    """True only when the request carries this backend's current pairing
    token in ``X-TheDAW-Pair``. Never logged: callers must not print the
    token itself, only whether it matched."""
    given = request.headers.get(HEADER, "")
    if not given:
        return False
    expected = get_token()
    return hmac.compare_digest(given.encode("utf-8"), expected.encode("utf-8"))
