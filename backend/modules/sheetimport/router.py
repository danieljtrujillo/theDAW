"""FastAPI router for sheet-music / score import (/api/sheetimport/*).

Parses notated scores (MusicXML, ABC, Humdrum kern, MIDI) into piano-roll note
batches via music21, so a score file can be dropped straight onto the roll.

``POST /parse`` takes a multipart upload (the frontend picks a browser File);
``POST /parse-path`` takes a server-side path for the native picker flow.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from backend.lib.cross_site import (
    refuse_cross_site,
    require_loopback_launch_or_pairing_token,
)
from backend.modules.notation.mxl_guard import MxlRefused

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
        import music21

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


@router.post(
    "/parse",
    dependencies=[
        Depends(refuse_cross_site),
        Depends(require_loopback_launch_or_pairing_token),
    ],
)
async def parse_upload(file: UploadFile = File(...)):
    """Parse an uploaded score into a piano-roll note batch. music21 runs in
    the threadpool: a long score takes seconds to parse, and the event loop
    keeps answering every other request meanwhile."""
    from .parser import parse_score_bytes

    data = await file.read(_MAX_BYTES + 1)
    if not data:
        raise HTTPException(status_code=400, detail="Empty file")
    if len(data) > _MAX_BYTES:
        raise HTTPException(status_code=413, detail="Score file too large")
    try:
        return await run_in_threadpool(
            parse_score_bytes, data, file.filename or "score.musicxml"
        )
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except MxlRefused as e:
        raise HTTPException(status_code=e.status, detail=str(e))
    except Exception as e:
        # Any parser failure is the file's: the client shows music21's words.
        raise HTTPException(status_code=422, detail=f"Could not parse score: {e}")


@router.post(
    "/parse-path",
    dependencies=[
        Depends(refuse_cross_site),
        Depends(require_loopback_launch_or_pairing_token),
    ],
)
def parse_path(req: PathRequest):
    """Parse a score already on disk (native file-picker flow).

    ``req.path`` must resolve inside the library root or one of the app's
    other allowed import directories (SEC-005) -- the same containment
    policy ``/api/project/clip-audio`` already enforces for server-side audio
    paths. Resolution happens before the check, so a ``..`` segment or a
    symlink pointing outside those roots cannot slip through, and a path
    that resolves outside them is refused before the filesystem is ever read.

    Those roots include ``data/`` and every folder an opened project drew
    from, and the answer tells a missing file (404) from an unparseable one
    (422) with the parser's error text. A bare LAN script sending no
    ``Origin``/``Referer``/``Sec-Fetch-Site`` passed ``refuse_cross_site``
    alone, so the route is held to the gate ``/clip-audio`` uses: this
    machine's UI, the desktop shell or a paired phone.
    """
    from backend.modules.project.media_access import resolve_media_path

    from .parser import parse_score_path

    resolved = resolve_media_path(req.path)
    if resolved is None:
        raise HTTPException(
            status_code=403,
            detail="Path is outside the library and the app's allowed import directories",
        )
    try:
        return parse_score_path(str(resolved))
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except MxlRefused as e:
        raise HTTPException(status_code=e.status, detail=str(e))
    except Exception as e:  # noqa: BLE001 - surface parse errors to the client
        raise HTTPException(status_code=422, detail=f"Could not parse score: {e}")
