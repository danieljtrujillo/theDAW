"""Who is allowed to spend the server-side ``GEMINI_API_KEY``.

The proxy injects a real key into every request it forwards, and the server
binds 0.0.0.0 so the phone companion and the headset can reach the API. That
combination means an unguarded proxy is a free Gemini account for any page the
user happens to have open and any device on the network.

Two gates, because neither is sufficient alone:

  - Origin. A browser attaches ``Origin`` to every cross-origin request and to
    every POST, and a page cannot forge it. Requiring a local origin therefore
    shuts the drive-by tab out completely, which is the vector that needs no
    network access at all. theDAW's own UI passes: it calls the proxy at
    ``window.location.origin`` (``http://localhost:5173`` in dev through Vite's
    proxy, ``app://.`` in the packaged app, ``http://<lan-ip>:8600`` on the
    phone), so every legitimate origin is loopback, private-range, or a
    non-http app scheme.
  - Token. ``Origin`` is trivially forged by anything that is not a browser, so
    a hostile LAN needs a real secret. ``theDAW_PROXY_TOKEN`` is opt-in: when
    it is set the request must carry it, and when it is not set the origin gate
    stands alone (the default posture on a home network).
"""

from __future__ import annotations

import hmac
import ipaddress
import os
from urllib.parse import urlsplit

from fastapi import Request

# Electron loads the packaged renderer over app://, and a file:// renderer
# reports its scheme the same way. Neither can be reached by a remote page.
_LOCAL_SCHEMES = {"app", "file", "tauri", "capacitor"}

_LOCAL_HOSTNAMES = {"localhost", "127.0.0.1", "::1", "[::1]"}

TOKEN_ENV = "theDAW_PROXY_TOKEN"
TOKEN_HEADER = "x-thedaw-token"
TOKEN_QUERY = "thedaw_token"


def _host_is_local(host: str) -> bool:
    """True for loopback, private-range, and link-local hosts.

    A LAN address counts as local because the phone companion loads the UI from
    this machine over the LAN; the token gate is what covers a hostile LAN.
    """
    h = host.strip().strip("[]").lower()
    if not h:
        return False
    if h in _LOCAL_HOSTNAMES or h.endswith(".local") or h.endswith(".localhost"):
        return True
    try:
        ip = ipaddress.ip_address(h)
    except ValueError:
        return False
    return ip.is_loopback or ip.is_private or ip.is_link_local


def _fetch_site(request: Request) -> str:
    """``Sec-Fetch-Site`` as the browser set it.

    A forbidden header name, so page script cannot touch it. It answers the one
    question ``Origin`` gets wrong at the edges: a sandboxed remote iframe sends
    ``Origin: null``, which is indistinguishable from a renderer on an opaque
    custom scheme unless this header is consulted.
    """
    return (request.headers.get("sec-fetch-site") or "").strip().lower()


def is_local_origin(request: Request) -> bool:
    """Whether the caller's browsing context belongs to this machine."""
    site = _fetch_site(request)
    if site == "cross-site":
        return False
    if site in {"same-origin", "none"}:
        # The browser itself vouches that the page is this server's own UI (or
        # that no page initiated the request at all), which covers the packaged
        # app whether its app:// renderer reports an origin or an opaque one.
        return True

    origin = request.headers.get("origin") or request.headers.get("referer") or ""
    if not origin:
        # No browsing context: a native client, or a same-origin GET that the
        # browser omits the header for. The token gate is the control here.
        return True

    parts = urlsplit(origin)
    scheme = (parts.scheme or "").lower()
    if scheme in _LOCAL_SCHEMES:
        return True
    if scheme not in {"http", "https"}:
        # Includes the literal "null" origin, which a sandboxed iframe on a
        # remote page can produce; treating it as local would reopen the hole.
        return False

    host = parts.hostname or ""
    if _host_is_local(host):
        return True
    # A caller reaching the server by the machine's own name (http://studio-pc:8600)
    # sends an Origin whose host matches the Host it asked for.
    request_host = urlsplit(f"//{request.headers.get('host', '')}").hostname or ""
    return bool(host) and host == request_host


def _token_ok(request: Request) -> bool:
    expected = os.environ.get(TOKEN_ENV, "").strip()
    if not expected:
        return True
    supplied = (
        request.headers.get(TOKEN_HEADER) or request.query_params.get(TOKEN_QUERY) or ""
    )
    # Constant-time compare so the token cannot be recovered byte by byte.
    return hmac.compare_digest(supplied, expected)


def denial_reason(request: Request) -> str | None:
    """None when the caller may spend the key, else a reason safe to return."""
    if not _token_ok(request):
        return "missing or invalid proxy token"
    if not is_local_origin(request):
        return "origin not allowed"
    return None
