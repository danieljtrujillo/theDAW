"""VJ broadcast / watch-link signaling.

A tiny WebRTC signaling relay so viewers can watch the live VJ output (with
audio) over a shareable link. Media is peer-to-peer — only SDP/ICE pass through
here — so the venue LAN gets full quality and low latency. The broadcaster is
the VJ app (one per room); viewers join the same room and get a direct peer.

Endpoints (prefix /api/broadcast):
    GET  /link            room id + LAN / public watch URLs + ICE config
    GET  /watch/{room}    self-contained HTML viewer page
    WS   /ws?room=&role=  signaling relay (role = broadcaster | viewer)

Signaling messages are JSON. The relay routes by viewer id:
    viewer  → relay: {type:'answer'|'ice', ...}            (to the broadcaster)
    broadcaster → relay: {type:'offer'|'ice', viewerId, ...} (to that viewer)
    relay → broadcaster: {type:'viewer-join'|'viewer-leave', viewerId}
"""

from __future__ import annotations

import logging
import os
import secrets
from typing import Any, Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse

log = logging.getLogger(__name__)

router = APIRouter(tags=["broadcast"])


class _Room:
    def __init__(self) -> None:
        self.broadcaster: Optional[WebSocket] = None
        self.viewers: dict[str, WebSocket] = {}


_rooms: dict[str, _Room] = {}

# Default room id so a single VJ rig "just works" without coordinating ids.
DEFAULT_ROOM = "live"


def _lan_ip() -> Optional[str]:
    try:
        from ..vj.sidecar import detect_lan_ip

        return detect_lan_ip()
    except Exception:  # noqa: BLE001 — best-effort
        return None


def _ice_servers() -> list[dict[str, Any]]:
    """STUN (always) + optional TURN from env for public reach.

    Env: ``theDAW_TURN_URL`` (e.g. turn:turn.example.com:3478),
    ``theDAW_TURN_USER``, ``theDAW_TURN_PASS``.
    """
    servers: list[dict[str, Any]] = [{"urls": ["stun:stun.l.google.com:19302"]}]
    turn_url = os.getenv("theDAW_TURN_URL")
    if turn_url:
        servers.append(
            {
                "urls": [turn_url],
                "username": os.getenv("theDAW_TURN_USER", ""),
                "credential": os.getenv("theDAW_TURN_PASS", ""),
            }
        )
    return servers


@router.get("/link")
def get_link(room: str = DEFAULT_ROOM, port: int = 8600) -> dict[str, Any]:
    """Watch URLs + ICE config for a room. ``port`` is the backend port the
    viewer page is served from (the frontend passes its known backend port)."""
    lan = _lan_ip()
    lan_url = f"http://{lan}:{port}/api/broadcast/watch/{room}" if lan else None
    public_base = os.getenv("theDAW_PUBLIC_BASE")  # e.g. https://vj.mydomain.com
    public_url = (
        f"{public_base.rstrip('/')}/api/broadcast/watch/{room}" if public_base else None
    )
    return {
        "room": room,
        "lan_url": lan_url,
        "public_url": public_url,
        "lan_ip": lan,
        "ice_servers": _ice_servers(),
        "viewers": len(_rooms.get(room, _Room()).viewers) if room in _rooms else 0,
    }


@router.websocket("/ws")
async def ws(websocket: WebSocket) -> None:
    await websocket.accept()
    params = websocket.query_params
    room_id = params.get("room") or DEFAULT_ROOM
    role = params.get("role") or "viewer"
    room = _rooms.setdefault(room_id, _Room())

    viewer_id: Optional[str] = None
    try:
        if role == "broadcaster":
            room.broadcaster = websocket
            log.info("broadcast: broadcaster joined room %s", room_id)
            # Tell the broadcaster about any viewers already waiting.
            for vid in list(room.viewers):
                await websocket.send_json({"type": "viewer-join", "viewerId": vid})
            await _relay_broadcaster(websocket, room)
        else:
            viewer_id = secrets.token_hex(4)
            room.viewers[viewer_id] = websocket
            log.info("broadcast: viewer %s joined room %s", viewer_id, room_id)
            if room.broadcaster is not None:
                try:
                    await room.broadcaster.send_json(
                        {"type": "viewer-join", "viewerId": viewer_id}
                    )
                except Exception:  # noqa: BLE001 — broadcaster went away
                    pass
            else:
                await websocket.send_json({"type": "no-broadcaster"})
            await _relay_viewer(websocket, room, viewer_id)
    except WebSocketDisconnect:
        pass
    except Exception as e:  # noqa: BLE001 — log + clean up
        log.warning("broadcast: ws error in room %s: %s", room_id, e)
    finally:
        if role == "broadcaster" and room.broadcaster is websocket:
            room.broadcaster = None
        if viewer_id is not None:
            room.viewers.pop(viewer_id, None)
            if room.broadcaster is not None:
                try:
                    await room.broadcaster.send_json(
                        {"type": "viewer-leave", "viewerId": viewer_id}
                    )
                except Exception:  # noqa: BLE001
                    pass
        if room.broadcaster is None and not room.viewers:
            _rooms.pop(room_id, None)


async def _relay_broadcaster(ws_: WebSocket, room: _Room) -> None:
    """Broadcaster → viewer routing. Messages carry a target ``viewerId``."""
    while True:
        msg = await ws_.receive_json()
        vid = msg.get("viewerId")
        target = room.viewers.get(vid) if vid else None
        if target is not None:
            payload = {k: v for k, v in msg.items() if k != "viewerId"}
            try:
                await target.send_json(payload)
            except Exception:  # noqa: BLE001 — viewer gone
                pass


async def _relay_viewer(ws_: WebSocket, room: _Room, viewer_id: str) -> None:
    """Viewer → broadcaster routing. The relay stamps the source ``viewerId``."""
    while True:
        msg = await ws_.receive_json()
        if room.broadcaster is not None:
            try:
                await room.broadcaster.send_json({**msg, "viewerId": viewer_id})
            except Exception:  # noqa: BLE001 — broadcaster gone
                pass


@router.get("/watch/{room}", response_class=HTMLResponse)
def watch(room: str) -> HTMLResponse:
    """Self-contained WebRTC viewer page (no app bundle)."""
    ice = _ice_servers()
    import json

    html = _VIEWER_HTML.replace("__ROOM__", room).replace("__ICE__", json.dumps(ice))
    return HTMLResponse(content=html)


_VIEWER_HTML = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>VJ Live</title>
<style>
  html,body{margin:0;height:100%;background:#000;overflow:hidden;font-family:ui-monospace,Menlo,monospace}
  #v{position:fixed;inset:0;width:100%;height:100%;object-fit:contain;background:#000}
  #overlay{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;
    flex-direction:column;gap:14px;color:#9fe;background:rgba(0,0,0,.85);cursor:pointer;z-index:2;text-align:center;padding:24px}
  #overlay h1{font-size:13px;letter-spacing:.3em;text-transform:uppercase;margin:0;color:#cffafe}
  #overlay p{font-size:11px;color:#7dd3fc;max-width:300px;line-height:1.6}
  #status{position:fixed;left:8px;bottom:8px;font-size:10px;color:#5b6;z-index:3;opacity:.7}
  .hidden{display:none!important}
</style>
</head>
<body>
  <video id="v" autoplay playsinline></video>
  <div id="overlay"><h1>VJ Live</h1><p>Tap to start the stream (enables sound).</p></div>
  <div id="status">connecting…</div>
<script>
const ROOM = "__ROOM__";
const ICE = __ICE__;
const v = document.getElementById('v');
const overlay = document.getElementById('overlay');
const statusEl = document.getElementById('status');
const setStatus = (t)=>{ statusEl.textContent = t; };
let pc=null, ws=null, started=false;

function connect(){
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/api/broadcast/ws?room=${encodeURIComponent(ROOM)}&role=viewer`);
  ws.onopen = ()=> setStatus('waiting for broadcaster…');
  ws.onclose = ()=>{ setStatus('disconnected — retrying'); setTimeout(connect, 1500); };
  ws.onerror = ()=> setStatus('signaling error');
  ws.onmessage = async (ev)=>{
    const m = JSON.parse(ev.data);
    if(m.type === 'no-broadcaster'){ setStatus('nobody is live yet — waiting'); return; }
    if(m.type === 'offer'){
      pc = new RTCPeerConnection({ iceServers: ICE });
      pc.ontrack = (e)=>{ if(v.srcObject !== e.streams[0]){ v.srcObject = e.streams[0]; } };
      pc.onicecandidate = (e)=>{ if(e.candidate) ws.send(JSON.stringify({type:'ice', candidate:e.candidate})); };
      pc.onconnectionstatechange = ()=> setStatus('peer: '+pc.connectionState);
      await pc.setRemoteDescription(m);
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      ws.send(JSON.stringify({type:'answer', sdp:ans.sdp, sdpType:ans.type}));
      setStatus('connecting to broadcaster…');
    } else if(m.type === 'ice' && pc){
      try{ await pc.addIceCandidate(m.candidate); }catch(e){}
    }
  };
}
overlay.addEventListener('click', ()=>{
  started = true; overlay.classList.add('hidden');
  v.muted = false; v.play().catch(()=>{});
  if(!ws) connect();
});
// Begin signaling immediately; audio unmutes on the tap.
connect();
</script>
</body>
</html>
"""
