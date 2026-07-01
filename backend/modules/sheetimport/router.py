"""FastAPI router for sheet-music / score import (/api/sheetimport/*).

Parses notated scores (MusicXML, ABC, Humdrum kern, MIDI) into piano-roll note
batches via music21, so a score file can be dropped straight onto the roll.

``POST /parse`` takes a multipart upload (the frontend picks a browser File);
``POST /parse-path`` takes a server-side path for the native picker flow.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel

log = logging.getLogger(__name__)
router = APIRouter()

# Scores are tiny; this only guards against accidental huge uploads.
_MAX_BYTES = 25 * 1024 * 1024


class PathRequest(BaseModel):
    path: str


@router.get("/capabilities")
def capabilities():
    """Report whether the notation engine is available and which formats parse."""
    from .parser import SHEET_SUFFIXES

    ok = False
    version = "unknown"
    try:
        import music21  # type: ignore[import]

        ok = True
        version = str(getattr(music21, "__version__", "unknown"))
    except ImportError:
        ok = False
    return {
        "ok": ok,
        "engine": "music21",
        "engine_version": version,
        "formats": list(SHEET_SUFFIXES),
    }


@router.post("/parse")
async def parse_upload(file: UploadFile = File(...)):
    """Parse an uploaded score into a piano-roll note batch."""
    from .parser import parse_score_bytes

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty file")
    if len(data) > _MAX_BYTES:
        raise HTTPException(status_code=413, detail="Score file too large")
    try:
        return parse_score_bytes(data, file.filename or "score.musicxml")
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:  # noqa: BLE001 - surface parse errors to the client
        raise HTTPException(status_code=422, detail=f"Could not parse score: {e}")


@router.post("/parse-path")
def parse_path(req: PathRequest):
    """Parse a score already on disk (native file-picker flow)."""
    from .parser import parse_score_path

    try:
        return parse_score_path(req.path)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:  # noqa: BLE001 - surface parse errors to the client
        raise HTTPException(status_code=422, detail=f"Could not parse score: {e}")
