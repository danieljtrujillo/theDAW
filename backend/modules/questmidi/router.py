"""FastAPI router for the Quest MIDI bridge module.

Endpoints (prefix /api/questmidi):
    GET  /status   listener + adb + connection state
    POST /start    start the listener and (re)run adb reverse
    POST /stop     stop the listener
    POST /reattach re-run adb reverse only (after re-plugging the headset)
    WS   /ws       browser relay: receives Quest MIDI, sends return MIDI

The WebSocket is the live path the frontend keeps open. Inbound Quest MIDI
arrives as {"type":"midi","data":[...]}; the browser publishes it to midiBus.
The browser sends {"data":[...]} to push return MIDI back to the headset.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from . import bridge

log = logging.getLogger(__name__)

router = APIRouter(tags=["questmidi"])


@router.get("/status")
async def get_status() -> dict:
    return bridge.status()


@router.post("/start")
async def start() -> dict:
    await bridge.ensure_started()
    await bridge.reattach_adb()
    return bridge.status()


@router.post("/stop")
async def stop() -> dict:
    await bridge.stop()
    return bridge.status()


@router.post("/reattach")
async def reattach() -> dict:
    """Re-run adb reverse without restarting the listener (re-plug recovery)."""
    ok = await bridge.reattach_adb()
    return {"adb_reverse_ok": ok, **bridge.status()}


@router.websocket("/ws")
async def ws(websocket: WebSocket) -> None:
    await websocket.accept()
    # Make sure the TCP listener + adb tunnel are up the moment a browser attaches.
    await bridge.ensure_started()

    async def send(msg: list[int]) -> None:
        await websocket.send_json({"type": "midi", "data": msg})

    bridge.add_client(send)
    try:
        while True:
            data = await websocket.receive_json()
            payload = data.get("data") if isinstance(data, dict) else None
            if payload:
                bridge.send_to_quest(payload)
    except WebSocketDisconnect:
        pass
    except Exception as e:  # noqa: BLE001 — client went away mid-message
        log.debug("questmidi: ws error: %s", e)
    finally:
        bridge.remove_client(send)
