"""Where another device on this network reaches theDAW.

  * GET /api/network/lan — ``{lan_ip, http_port, https_port, https_url}``

``https_url`` is present ONLY while something is really listening on the TLS
port. The UI puts that address in the Mobile Access link and QR code, and a
link to a port nothing answers on is worse than no link: the person walks to
the other device, scans, and gets a connection error with nothing to tell
them the listener never started. So the answer is a live fact, not a plan —
the launcher's intent lives in ``backend/lib/lan_https.py``.

The liveness probe is a 200 ms loopback connect, cached for five seconds.
Without the cache a UI that polls this route would open a socket per poll;
with a longer one the address would stay stale for a visible while after the
listener came up.
"""

from __future__ import annotations

import os
import socket
import threading
import time
from typing import Optional

from fastapi import APIRouter

from backend import ports
from backend.lib import lan_https

router = APIRouter(tags=["network"])

#: Loopback, so a connect either completes or is refused at once. Long enough
#: to survive a busy moment, short enough that the route never feels slow.
PROBE_TIMEOUT = 0.2
#: How long one probe's answer stands.
PROBE_TTL = 5.0

_probe_lock = threading.Lock()
_probe_cache: dict[int, tuple[float, bool]] = {}


def _probe_once(port: int) -> bool:
    """Is anything accepting connections on ``port`` on this machine?"""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=PROBE_TIMEOUT):
            return True
    except OSError:
        return False


def https_listening(port: int, *, now: Optional[float] = None) -> bool:
    """:func:`_probe_once`, at most once every :data:`PROBE_TTL` seconds.

    ``now`` is injectable so the cache's behaviour is testable without
    sleeping. The probe itself runs outside the lock: a request must never
    wait on another request's socket timeout, and the worst a race costs is
    one extra loopback connect.
    """
    moment = time.monotonic() if now is None else now
    with _probe_lock:
        cached = _probe_cache.get(port)
        if cached is not None and 0 <= moment - cached[0] < PROBE_TTL:
            return cached[1]
    live = _probe_once(port)
    with _probe_lock:
        _probe_cache[port] = (moment, live)
    return live


@router.get("/lan")
def get_lan() -> dict:
    """This machine's address on the network, and how to reach theDAW on it.

    ``lan_ip`` is null when the machine is not on a network. ``https_url`` is
    null unless the TLS listener is up right now; the caller then uses
    ``http://<lan_ip>:<http_port>`` exactly as before.
    """
    lan_ip = lan_https.lan_address(lan_https.detect_lan_ips())
    https_port = lan_https.listener_port(os.environ)
    https_url = None
    if lan_ip and https_listening(https_port):
        https_url = f"https://{lan_ip}:{https_port}"
    return {
        "lan_ip": lan_ip,
        "http_port": ports.frontend_port(),
        "https_port": https_port,
        "https_url": https_url,
    }
