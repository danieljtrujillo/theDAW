"""FastAPI router for the Quest cast module.

Endpoints (prefix /api/questcast):
    GET  /status    sidecar + adb/node + relay state, incl. the WebSocket port
    GET  /devices   adb device list (without starting the relay)
    POST /start     ensure adb + bootstrap, spawn the relay; body: {serial?}
    POST /stop      stop the relay

The frontend reads ``ws_port`` from /status (or /start) and connects the VJ's
WebCodecs decoder to ``ws://localhost:<ws_port>``.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, Body

from .sidecar import get_sidecar

log = logging.getLogger(__name__)

router = APIRouter(tags=["questcast"])


@router.get("/status")
def status() -> dict[str, Any]:
    return get_sidecar().status()


@router.get("/devices")
def devices() -> dict[str, Any]:
    return get_sidecar().list_devices()


@router.post("/start")
def start(payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    serial: Optional[str] = None
    if isinstance(payload, dict):
        raw = payload.get("serial")
        serial = str(raw) if raw else None
    return get_sidecar().start(device_serial=serial)


@router.post("/stop")
def stop() -> dict[str, Any]:
    return get_sidecar().stop()
