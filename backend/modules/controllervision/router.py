"""FastAPI router for the controllervision module.

Endpoints (prefix from module.json → ``/api/controllervision``):

    GET  /                  capability probe (is OpenCV available?)
    POST /detect            detect controls in an UPLOADED image (multipart)
    POST /detect-by-name    find a product image on Wikimedia for a device
                            name, fetch it, and run detection (returns the
                            source image url + detected controls)

Tier-3 controller recognition (see docs/plans/2026-06-01-dj-suite-foss-expansion
§7a). The result is a SUGGESTED layout the user verifies in the UI; the MIDI
mapping is never inferred from the image (that's Tier-2 capture / MIDI-learn).
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from .engine import (
    cv_available,
    detect_controls_in_image,
    fetch_image_bytes,
    search_wikimedia_image,
)

log = logging.getLogger(__name__)

router = APIRouter()

_MAX_IMAGE_BYTES = 20 * 1024 * 1024  # 20 MB


@router.get("")
@router.get("/")
def capabilities() -> dict[str, Any]:
    return {
        "ok": True,
        "available": cv_available(),
        "engine": "opencv (classical: hough circles + contour shape)",
        "note": "install opencv-python-headless to enable; mapping still comes from MIDI",
    }


def _gate(tag: str, acquire: bool) -> None:
    """Hold/release the idle gate around a foreground CV job (best-effort)."""
    try:
        from backend.core.idle import get_idle_manager

        mgr = get_idle_manager()
        mgr.bump_activity(tag=tag) if acquire else mgr.release(tag)
    except Exception:
        pass


@router.post("/detect")
async def detect_uploaded(image_file: UploadFile = File(...)) -> dict[str, Any]:
    """Detect controls in a user-supplied photo (Tier-3 source #1)."""
    if not cv_available():
        raise HTTPException(
            503,
            "OpenCV not installed — run the controllervision install or use a library/learned profile",
        )
    image_bytes = await image_file.read()
    if not image_bytes:
        raise HTTPException(400, "empty image")
    if len(image_bytes) > _MAX_IMAGE_BYTES:
        raise HTTPException(413, "image exceeds 20 MB")

    _gate("controllervision-detect", True)
    try:
        result = detect_controls_in_image(image_bytes)
    finally:
        _gate("controllervision-detect", False)
    result["source"] = "upload"
    return result


@router.post("/detect-by-name")
async def detect_by_name(device_name: str = Form(...)) -> dict[str, Any]:
    """Find a product image for a device name on Wikimedia, fetch it, detect
    controls (Tier-3 source #2). Returns the image url + detection so the UI can
    show the photo for the user to verify."""
    if not cv_available():
        raise HTTPException(503, "OpenCV not installed")
    name = device_name.strip()
    if not name:
        raise HTTPException(400, "device_name required")

    hit: Optional[dict[str, Any]] = await search_wikimedia_image(name)
    if not hit:
        return {
            "available": True,
            "found": False,
            "query": name,
            "controls": [],
            "counts": {},
        }

    try:
        image_bytes = await fetch_image_bytes(hit["url"])
    except Exception as e:
        raise HTTPException(502, f"failed to fetch image: {e}")
    if len(image_bytes) > _MAX_IMAGE_BYTES:
        raise HTTPException(413, "fetched image too large")

    _gate("controllervision-detect", True)
    try:
        result = detect_controls_in_image(image_bytes)
    finally:
        _gate("controllervision-detect", False)

    result["found"] = True
    result["query"] = name
    result["source"] = hit.get("source", "wikimedia")
    result["imageUrl"] = hit["url"]
    result["imageTitle"] = hit.get("title")
    result["descriptionUrl"] = hit.get("descriptionurl")
    return result
