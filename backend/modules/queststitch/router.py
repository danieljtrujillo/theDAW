"""FastAPI router for the Quest stitch module.

Endpoints (prefix /api/queststitch):
    GET  /status   listener + adb + connection state, source dims, frame counters
    POST /start    start the TCP listener and (re)run adb reverse
    POST /stop     stop the listener
    POST /reattach re-run adb reverse only (after re-plugging the headset)
    WS   /ws       browser relay: streams the clean stitch as H.264 (questcast wire format)

The VJ's ``useQuestStitch`` hook opens /ws and decodes with WebCodecs — the exact
same decoder used for delinQuest, since the wire format is identical.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from . import bridge

log = logging.getLogger(__name__)

router = APIRouter(tags=["queststitch"])


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
    await bridge.add_client(websocket)
    try:
        # The stream is one-way (Quest -> browser); we only await to detect close.
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception as e:  # noqa: BLE001 — client went away mid-message
        log.debug("queststitch: ws error: %s", e)
    finally:
        bridge.remove_client(websocket)
