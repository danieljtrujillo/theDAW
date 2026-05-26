"""FastAPI router for the disk-backed library.

Endpoints (prefix from module.json → `/api/library`):

    GET    /entries            list all library entries (no audio bytes)
    GET    /entries/{id}       single entry record
    GET    /audio/{id}         stream the audio file
    PATCH  /entries/{id}       update user-mutable fields
    DELETE /entries/{id}       remove the entry (audio + metadata)
    POST   /import             accept an audio upload, return new entry

The audio stream uses FileResponse so range requests work (essential for
the player to scrub) and there's no in-memory copy of large files.
"""

from __future__ import annotations

import json
import logging
import mimetypes
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Body, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from .store import LibraryStore, default_library_root

log = logging.getLogger(__name__)


_store: Optional[LibraryStore] = None


def get_store() -> LibraryStore:
    global _store
    if _store is None:
        project_root = Path(__file__).resolve().parents[3]
        _store = LibraryStore(default_library_root(project_root))
    return _store


router = APIRouter()


@router.get("/entries")
def list_entries() -> dict[str, Any]:
    store = get_store()
    entries = [r.to_dict() for r in store.list_entries()]
    return {"entries": entries, "count": len(entries), "root": str(store.root)}


@router.get("/entries/{entry_id}")
def get_entry(entry_id: str) -> dict[str, Any]:
    record = get_store().get_entry(entry_id)
    if record is None:
        raise HTTPException(404, f"Entry {entry_id!r} not found")
    return record.to_dict()


@router.get("/audio/{entry_id}")
def stream_audio(entry_id: str) -> FileResponse:
    audio_path = get_store().get_audio_path(entry_id)
    if audio_path is None or not audio_path.is_file():
        raise HTTPException(404, f"Audio for entry {entry_id!r} not found")
    mime, _ = mimetypes.guess_type(str(audio_path))
    return FileResponse(
        path=str(audio_path),
        media_type=mime or "audio/wav",
        filename=audio_path.name,
    )


@router.patch("/entries/{entry_id}")
def update_entry(entry_id: str, patch: dict[str, Any] = Body(...)) -> dict[str, Any]:
    record = get_store().update_entry(entry_id, patch)
    if record is None:
        raise HTTPException(404, f"Entry {entry_id!r} not found")
    return record.to_dict()


@router.delete("/entries/{entry_id}")
def delete_entry(entry_id: str) -> dict[str, Any]:
    ok = get_store().delete_entry(entry_id)
    if not ok:
        raise HTTPException(
            404, f"Entry {entry_id!r} not found or could not be deleted"
        )
    return {"deleted": entry_id}


@router.post("/import")
async def import_entry(
    file: UploadFile = File(...),
    metadata: str = Form("{}"),
) -> dict[str, Any]:
    try:
        meta_dict = json.loads(metadata) if metadata else {}
    except json.JSONDecodeError as e:
        raise HTTPException(400, f"metadata must be JSON: {e}")
    if not isinstance(meta_dict, dict):
        raise HTTPException(400, "metadata must be a JSON object")

    audio_bytes = await file.read()
    if not audio_bytes:
        raise HTTPException(400, "empty file")

    record = get_store().import_blob(
        audio_bytes=audio_bytes,
        filename=file.filename or "import.wav",
        mime_type=file.content_type or "audio/wav",
        metadata=meta_dict,
    )
    return record.to_dict()
