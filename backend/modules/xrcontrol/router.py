"""FastAPI router for the XR / companion control bus (spatialization P0).

A relay between theDAW (the browser, which owns the control manifest and the
wired setters) and controller peers: a theDAW-XR headset and, from Phase 3, the
web-mobile and Flutter companions. The relay forwards each control JSON frame to
every OTHER authenticated peer, so the browser host and its controllers exchange
messages without the backend understanding them.

The relay holds no manifest and no control state. It holds only the session
pairing posture (set by the host) and which peers have passed the pairing gate,
so a host can require a code before a controller drives the desktop audio. See
docs/companion-control-contract.md for the full protocol.

Endpoints (prefix /api/xr/control):
    GET  /status   connected-peer count
    WS   /ws       peer relay (browser host <-> controllers)

Pairing handshake (relay-handled, never forwarded):
    host       -> relay : {"type":"host-hello","posture":{"mode":"open"|"code","code":...}}
    relay      -> host  : {"type":"host-ack","posture":...,"peers":[{"peerId","label"}]}
    controller -> relay : {"type":"controller-hello","label":...,"code":...}
    relay      -> ctrl  : {"type":"pair-ok","peerId":N} | {"type":"pair-rejected","reason":...}
    relay      -> host  : {"type":"peer-joined","peerId":N,"label":...} | {"type":"peer-left","peerId":N}
    host       -> relay : {"type":"kick","peerId":N}

Control frames (forwarded between authenticated peers, shapes defined in the
frontend contract, not enforced here):
    host -> controller : {"type":"manifest","version":N,"entries":[...]}
                         {"type":"control-changed","id":...,"value":...}
    controller -> host : {"type":"request-controls"}
                         {"type":"control-set","id":...,"value":...}
                         {"type":"pad"|"jog"|"trigger", ...}
"""

from __future__ import annotations

import logging
import os

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

log = logging.getLogger(__name__)

router = APIRouter(tags=["xrcontrol"])

# The host role is privileged: it sets the pairing posture. In the shipped
# topology the desktop browser is co-located with the backend (theDAW.bat,
# Electron, or dev via the Vite proxy), so it reaches the relay as localhost.
# Restricting host-hello to localhost stops a LAN companion from claiming the
# host role and resetting posture to open to bypass code pairing. A remote-host
# deployment (e.g. a Docker container served to a browser on another machine)
# opts in with THEDAW_XR_ALLOW_REMOTE_HOST=1.
_LOCAL_HOSTS = {"127.0.0.1", "::1", "localhost"}

# Every connected peer (browser hosts and controllers alike).
_clients: set[WebSocket] = set()

# Per-peer metadata: {"role": "host"|"controller"|"legacy", "label": str,
# "peerId": int, "authed": bool}. A peer that never sends a hello stays "legacy"
# and is authed under the posture in force when it connected.
_meta: dict[WebSocket, dict] = {}

# The current host peer (last socket to send host-hello), if any.
_host: WebSocket | None = None

# Session pairing posture. Default "open" preserves the pre-v1 behavior so the
# existing theDAW-XR headset keeps working until a host opts into code pairing.
_posture: dict = {"mode": "open", "code": None}

# Monotonic peer id counter (id() would be reused after GC).
_next_peer_id = 0


def _new_peer_id() -> int:
    global _next_peer_id
    _next_peer_id += 1
    return _next_peer_id


def _is_authed(peer: WebSocket) -> bool:
    m = _meta.get(peer)
    return bool(m and m.get("authed"))


def _is_local(peer: WebSocket) -> bool:
    client = getattr(peer, "client", None)
    host = getattr(client, "host", None) if client else None
    return host in _LOCAL_HOSTS


def _may_host(peer: WebSocket) -> bool:
    """Whether `peer` is allowed to (become / stay) the host and set posture.

    An established host can only be replaced by itself; a LAN companion can
    never seize it. Establishing a fresh host requires a localhost origin
    unless remote hosts are explicitly allowed.
    """
    if _host is not None and peer is not _host:
        return False
    if _is_local(peer):
        return True
    return os.environ.get("THEDAW_XR_ALLOW_REMOTE_HOST") == "1"


def _peer_list() -> list[dict]:
    """Authenticated controller peers, for the host's connected-devices view."""
    out: list[dict] = []
    for peer, m in _meta.items():
        if m.get("role") == "controller" and m.get("authed"):
            out.append({"peerId": m.get("peerId"), "label": m.get("label") or "device"})
    return out


@router.get("/status")
async def status() -> dict:
    return {"clients": len(_clients)}


async def _send(peer: WebSocket, msg: object) -> bool:
    try:
        await peer.send_json(msg)
        return True
    except Exception:  # noqa: BLE001 — peer went away
        _drop(peer)
        return False


async def _relay(origin: WebSocket, msg: object) -> None:
    """Forward one control frame to every OTHER authenticated peer."""
    if not _is_authed(origin):
        return  # an unauthenticated peer cannot inject control frames
    for peer in list(_clients):
        if peer is origin or not _is_authed(peer):
            continue
        await _send(peer, msg)


def _drop(peer: WebSocket) -> None:
    global _host
    _clients.discard(peer)
    _meta.pop(peer, None)
    if peer is _host:
        _host = None


async def _notify_host(msg: object) -> None:
    if _host is not None:
        await _send(_host, msg)


async def _handle_host_hello(peer: WebSocket, msg: dict) -> None:
    """A browser declares itself the host and sets the session posture."""
    global _host, _posture
    _host = peer
    m = _meta.setdefault(peer, {})
    m.update(role="host", authed=True)
    posture = msg.get("posture")
    if isinstance(posture, dict):
        mode = "code" if posture.get("mode") == "code" else "open"
        code = posture.get("code")
        _posture = {"mode": mode, "code": str(code) if code else None}
    await _send(peer, {"type": "host-ack", "posture": _posture, "peers": _peer_list()})


async def _handle_controller_hello(peer: WebSocket, msg: dict) -> None:
    """A controller requests to join; gate it on the current posture."""
    label = msg.get("label")
    m = _meta.setdefault(peer, {})
    m.update(role="controller", label=(str(label) if label else None))
    if "peerId" not in m:
        m["peerId"] = _new_peer_id()
    if _posture["mode"] == "code":
        authed = (
            bool(_posture["code"]) and str(msg.get("code") or "") == _posture["code"]
        )
    else:
        authed = True
    m["authed"] = authed
    if authed:
        await _send(peer, {"type": "pair-ok", "peerId": m["peerId"]})
        await _notify_host(
            {
                "type": "peer-joined",
                "peerId": m["peerId"],
                "label": m.get("label") or "device",
            }
        )
        # The relay holds no manifest, so ask the host to re-publish; its manifest
        # frame is then forwarded to every authed peer, seeding this controller.
        await _notify_host({"type": "request-controls"})
    else:
        await _send(peer, {"type": "pair-rejected", "reason": "code"})


async def _handle_kick(msg: dict) -> None:
    target_id = msg.get("peerId")
    for peer, m in list(_meta.items()):
        if m.get("peerId") == target_id and m.get("role") == "controller":
            try:
                await peer.close()
            except Exception:  # noqa: BLE001 — already closing
                pass
            _drop(peer)
            await _notify_host({"type": "peer-left", "peerId": target_id})
            return


@router.websocket("/ws")
async def ws(websocket: WebSocket) -> None:
    await websocket.accept()
    _clients.add(websocket)
    # Provisional posture snapshot: a peer that never sends a hello (a legacy
    # headset build) is authed iff the posture was open when it connected.
    _meta[websocket] = {"role": "legacy", "authed": _posture["mode"] == "open"}
    log.info("xrcontrol: peer connected (%d total)", len(_clients))
    try:
        while True:
            msg = await websocket.receive_json()
            if not isinstance(msg, dict):
                continue
            t = msg.get("type")
            if t == "host-hello":
                # Only the co-located desktop may claim the host role / set
                # posture; a LAN companion sending host-hello is ignored so it
                # cannot reset posture to open and bypass code pairing.
                if _may_host(websocket):
                    await _handle_host_hello(websocket, msg)
            elif t == "controller-hello":
                await _handle_controller_hello(websocket, msg)
            elif t == "kick" and websocket is _host:
                await _handle_kick(msg)
            else:
                await _relay(websocket, msg)
    except WebSocketDisconnect:
        pass
    except Exception as e:  # noqa: BLE001 — peer went away mid-message
        log.debug("xrcontrol: ws error: %s", e)
    finally:
        was = _meta.get(websocket, {})
        _drop(websocket)
        if was.get("role") == "controller" and was.get("authed"):
            await _notify_host({"type": "peer-left", "peerId": was.get("peerId")})
        log.info("xrcontrol: peer disconnected (%d total)", len(_clients))
