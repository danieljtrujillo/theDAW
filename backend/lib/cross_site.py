"""Refuse requests that a web page outside theDAW started.

The server binds 0.0.0.0, so any page the user has open can still send it a
request. CORS (backend/server.py's ``CORSMiddleware``) restricts which origin
is allowed to *read the response* to a cross-origin request -- it does
nothing to stop the request from being sent and executed server-side in the
first place: a "simple" request (no custom headers, a body type like
``text/plain``) needs no preflight and runs with full effect whether or not
its origin is one CORS would have allowed to see the result. A loopback TCP
peer doesn't help either -- a page the user's own desktop browser visits IS a
loopback caller. Routes that open a native dialog on this machine, list the
paths theDAW remembers, serve/write files, or rotate the LAN pairing token
depend on ``refuse_cross_site`` (which reads ``Sec-Fetch-Site``/``Origin``/
``Referer`` -- headers page script cannot set) so only theDAW's own UI and
native callers reach them, independent of both CORS and TCP peer.
"""

from __future__ import annotations

from fastapi import HTTPException, Request

from backend.lib import launch_token, pairing

# The origin rules the Gemini proxy already enforces: loopback, private-range
# and app:// origins are this machine's UI; anything else is a foreign page.
# caller_is_loopback is the same ipaddress-based TCP-peer check genai-proxy's
# own SEC-001 gate uses (handles ``::1`` and IPv4-mapped ``::ffff:127.0.0.1``,
# both of which a dual-stack socket can report behind Vite's xfwd dev proxy).
from backend.modules.genaiproxy.access import caller_is_loopback, is_local_origin

__all__ = [
    "refuse_cross_site",
    "require_loopback_or_launch_token",
    "require_loopback_launch_or_pairing_token",
]


def refuse_cross_site(request: Request) -> None:
    """403 for a call started by a web page outside theDAW.

    A browser labels its requests with ``Sec-Fetch-Site``, ``Origin`` or
    ``Referer``, and page script cannot change those. A native caller, such as
    the desktop shell recording a finished download, sends none of them and
    passes."""
    headers = request.headers
    if not (
        headers.get("sec-fetch-site") or headers.get("origin") or headers.get("referer")
    ):
        return
    if not is_local_origin(request):
        raise HTTPException(403, "This request came from a page outside theDAW.")


def require_loopback_or_launch_token(request: Request) -> None:
    """403 unless this machine's own UI or the desktop shell is asking.

    ``refuse_cross_site`` above tells a foreign *page* apart from theDAW's own
    UI, but it still trusts headers a non-browser LAN caller is free to send
    (or omit). For a route that opens a native dialog on this machine or
    bundles arbitrary bytes into a file the caller names (ITW security P1:
    project save with ``embed_audio``, plugin reveal), that is not enough:
    the caller must either be this machine's own TCP peer (loopback, so no
    header can lie about it) or carry the desktop shell's launch token, the
    same check ``places/router.py``'s ``/record`` uses
    (``backend.lib.launch_token.header_matches``). A loopback caller -- this
    machine's own UI -- is unaffected either way.
    """
    if caller_is_loopback(request):
        return
    if launch_token.header_matches(request):
        return
    raise HTTPException(403, "This request must come from theDAW's desktop shell.")


def require_loopback_launch_or_pairing_token(request: Request) -> None:
    """Same as ``require_loopback_or_launch_token``, plus a valid LAN pairing
    token (``backend.lib.pairing``).

    Deliberately a separate function, not an extra branch inside
    ``require_loopback_or_launch_token``: pairing is a paired device's
    substitute for the (browser-unreachable) launch token on a route that
    device legitimately uses -- project save/open/export, known places, the
    VST scan and render routes -- but does NOT unlock a route that acts on
    this machine's own desktop, like plugin ``/reveal``, the plugin editor
    window, or moving the projects folder, which stay loopback-or-launch-
    token only.
    """
    if caller_is_loopback(request):
        return
    if launch_token.header_matches(request):
        return
    if pairing.header_matches(request):
        return
    raise HTTPException(
        403, "This request must come from theDAW's desktop shell or a paired device."
    )
