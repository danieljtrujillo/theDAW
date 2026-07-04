"""FastAPI router for Quest APK deploy (prefix ``/api/quest``).

    GET  /status        adb availability + connected devices (Quest flagged)
    POST /deploy         adb install -r a prebuilt APK, optionally launch it
    GET  /pick-apk       native Open-file dialog filtered to *.apk
    POST /set-adb-path   persist a manual adb path when it is not auto-found

Deploy-only: this installs an already-built APK onto a connected headset over
adb (the same bridge theDAW-XR uses). It does not build the APK from Unity.
Handlers offload the blocking adb/dialog calls to worker threads.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.core.folder_dialog import pick_open_file
from backend.modules.quest import service

log = logging.getLogger(__name__)
router = APIRouter()

_APK_FILTER = "Android package (*.apk)|*.apk|All files (*.*)|*.*"


def _status_payload() -> dict:
    adb, source = service.resolve_adb()
    cfg = service.load_config()
    devices = service.list_devices(adb) if adb else []
    return {
        "adb_available": adb is not None,
        "adb_path": adb,
        "adb_source": source,
        "adb_version": service.adb_version(adb) if adb else None,
        "devices": devices,
        "quest_connected": any(d["is_quest"] and d["ready"] for d in devices),
        "config": {
            "default_package": cfg.get("default_package"),
            "last_apk_path": cfg.get("last_apk_path"),
        },
    }


@router.get("/status")
async def quest_status() -> dict:
    """adb availability plus the current device list (Quest headsets flagged)."""
    return await asyncio.to_thread(_status_payload)


class DeployRequest(BaseModel):
    apk_path: str
    serial: Optional[str] = None
    package: Optional[str] = None
    launch: bool = True


@router.post("/deploy")
async def quest_deploy(req: DeployRequest) -> dict:
    """Install the APK onto the target headset, then optionally launch it."""
    adb, _ = await asyncio.to_thread(service.resolve_adb)
    if adb is None:
        raise HTTPException(
            status_code=409,
            detail="adb was not found. Set its path in the Quest deploy dialog.",
        )
    installed, install_log = await asyncio.to_thread(
        service.install_apk, adb, req.apk_path, req.serial
    )
    result: dict = {
        "installed": installed,
        "install_log": install_log,
        "launched": False,
        "launch_log": None,
        "package": req.package,
    }
    if not installed:
        result["ok"] = False
        return result
    # Remember the APK for next time.
    await asyncio.to_thread(service.save_config, {"last_apk_path": req.apk_path})
    if req.launch and req.package:
        launched, launch_log = await asyncio.to_thread(
            service.launch_package, adb, req.package, req.serial
        )
        result["launched"] = launched
        result["launch_log"] = launch_log
        await asyncio.to_thread(service.save_config, {"default_package": req.package})
    result["ok"] = True
    return result


@router.get("/pick-apk")
async def quest_pick_apk() -> dict:
    """Open the native file picker for an .apk and return the chosen path."""
    cfg = await asyncio.to_thread(service.load_config)
    last = cfg.get("last_apk_path")
    initial = str(Path(last).parent) if isinstance(last, str) and last else None
    path = await asyncio.to_thread(
        pick_open_file, "Select the Quest APK", initial, _APK_FILTER
    )
    return {"path": path}


class AdbPathRequest(BaseModel):
    path: str


@router.post("/set-adb-path")
async def quest_set_adb_path(req: AdbPathRequest) -> dict:
    """Validate and persist a manual adb path (when auto-discovery misses it)."""
    candidate = req.path.strip()
    if not candidate or not Path(candidate).expanduser().is_file():
        raise HTTPException(status_code=400, detail=f"Not a file: {candidate}")
    version = await asyncio.to_thread(service.adb_version, candidate)
    if version is None:
        raise HTTPException(
            status_code=400,
            detail="That file does not run as adb (adb version failed).",
        )
    await asyncio.to_thread(service.save_config, {"adb_path": candidate})
    return {"adb_available": True, "adb_path": candidate, "adb_version": version}
