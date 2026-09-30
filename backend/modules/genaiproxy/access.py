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
  - Token. ``Origin``, and every ``Sec-Fetch-*`` header along with it, is
    trivially forged by anything that is not a real browser -- a LAN script
    can send ``Sec-Fetch-Site: same-origin`` itself, so that header is not
    proof either (SEC-001). A non-loopback caller must therefore also carry
    a real secret: the desktop shell's launch token
    (``backend/lib/launch_token.py``), a LAN pairing token
    (``backend/lib/pairing.py`` -- what the phone uses, since a plain
    ``http://<lan-ip>`` share link is not a secure context and so its browser
    sends it no ``Sec-Fetch-*`` headers to lean on at all), or the opt-in
    ``theDAW_PROXY_TOKEN``. This extra check is enforced in ``denial_reason``
    via ``_needs_loopback_or_launch_token``, not in ``is_local_origin``
    itself, which other routers also rely on and which is unaffected.
"""

from __future__ import annotations

import hmac
import ipaddress
import os
from urllib.parse import urlsplit

from fastapi import Request

from backend.lib import launch_token, pairing

# Electron loads the packaged renderer over app://, and a file:// renderer
# reports its scheme the same way. Neither can be reached by a remote page.
_LOCAL_SCHEMES = {"app", "file", "tauri", "capacitor"}

_LOCAL_HOSTNAMES = {"localhost", "127.0.0.1", "::1", "[::1]"}


def _peer_ip(host: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    """``host`` parsed as an IP, with an IPv4-mapped IPv6 address (e.g.
    ``::ffff:127.0.0.1``, which a dual-stack socket can report for an IPv4
    peer) unwrapped to its IPv4 form. A non-IP host (a hostname, or a fake
    TestClient peer) is not an address at all, so it is never loopback."""
    h = host.strip().strip("[]")
    if not h:
        return None
    try:
        ip = ipaddress.ip_address(h)
    except ValueError:
        return None
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        return ip.ipv4_mapped
    return ip


def caller_is_loopback(request: Request) -> bool:
    """Whether the TCP peer itself -- what the OS reports for the socket, not
    anything a caller's headers can claim -- is this machine.

    Behind Vite's dev proxy (xfwd), the peer the backend sees is Vite's own
    outgoing connection, which can be reported as ``::1`` rather than
    ``127.0.0.1`` depending on the local dual-stack route; both, and the
    IPv4-mapped form, must count."""
    client = request.client
    ip = _peer_ip(client.host if client else "")
    return ip is not None and ip.is_loopback


# Public name is `caller_is_loopback` above; this alias exists only because
# `backend/modules/vst/router.py` still imports the old underscore-prefixed
# name and is out of scope for this pass. Remove once that importer switches.
_caller_is_loopback = caller_is_loopback


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
    """Whether the caller's browsing context belongs to this machine.

    Shared with ``backend.lib.cross_site.refuse_cross_site``, used across many
    routers -- kept exactly as before. genai-proxy's own extra SEC-001 check
    lives in ``denial_reason`` below, not here, so it cannot change behaviour
    for any other caller of this function.
    """
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
        # browser omits the header for. Only allow when a proxy token is
        # configured and was already validated by the caller.
        return bool(os.environ.get(TOKEN_ENV, "").strip())

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


def _needs_loopback_or_launch_token(request: Request) -> bool:
    """SEC-001: every header ``is_local_origin`` trusts -- ``Sec-Fetch-Site``
    included -- is one a non-browser HTTP client is free to set to whatever
    it likes; nothing stops a LAN script from sending
    ``Sec-Fetch-Site: same-origin`` itself. So this check is header-blind on
    purpose: it never reads ``Sec-Fetch-Site``, ``Origin`` or ``Referer``, only
    facts a caller cannot fake -- the real TCP peer, or a secret it actually
    holds. A non-loopback caller must carry the desktop shell's launch token
    (``backend/lib/launch_token.py``), a valid LAN pairing token
    (``backend/lib/pairing.py`` -- what the phone, which is not a secure
    context over plain ``http://<lan-ip>`` and so gets no ``Sec-Fetch-*``
    headers from its browser at all, actually uses), or the opt-in
    ``theDAW_PROXY_TOKEN`` (already validated by ``_token_ok`` before
    ``denial_reason`` gets here, so it is not asked for twice). Scoped to
    genai-proxy only: it does not touch ``is_local_origin`` itself, so every
    other caller of that function (``backend.lib.cross_site.refuse_cross_site``
    and the routers behind it) is unaffected.
    """
    if os.environ.get(TOKEN_ENV, "").strip():
        return False
    return not (
        caller_is_loopback(request)
        or launch_token.header_matches(request)
        or pairing.header_matches(request)
    )


def denial_reason(request: Request) -> str | None:
    """None when the caller may spend the key, else a reason safe to return."""
    if not _token_ok(request):
        return "missing or invalid proxy token"
    if not is_local_origin(request):
        return "origin not allowed"
    if _needs_loopback_or_launch_token(request):
        return "non-loopback caller must present the launch or pairing token"
    return None
