from __future__ import annotations

from fastapi import APIRouter, HTTPException

from . import sidecar

router = APIRouter(tags=["foundry"])


@router.get("/url")
def get_url() -> dict:
    try:
        url = sidecar.ensure_running()
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    return {"url": url}


@router.get("/status")
def get_status() -> dict:
    info = sidecar.probe()
    info["ok"] = not info["issues"] and info["listening"]
    return info


@router.post("/start")
def post_start() -> dict:
    try:
        url = sidecar.ensure_running()
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    return {"ok": True, "url": url}


@router.post("/stop")
def post_stop() -> dict:
    try:
        stopped = sidecar.stop()
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    return {"ok": True, "stopped": stopped}


@router.on_event("shutdown")
def shutdown_foundry() -> None:
    sidecar.stop()
