"""FastAPI router for backup/migration of user data (/api/backup/*).

Endpoints (prefix from module.json -> ``/api/backup``):

- ``GET  /manifest``       — every user-data root with size/file counts.
- ``POST /export``         — start a background zip export; returns a job id.
- ``GET  /export/status``  — poll an export job.
- ``POST /import``         — start a background restore from a backup zip.
- ``GET  /import/status``  — poll an import job.
- ``GET  /pick-folder``    — native OS folder picker for the export target.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from backend.core.folder_dialog import pick_folder
from backend.modules.backup import service

log = logging.getLogger(__name__)
router = APIRouter()


@router.get("/manifest")
async def backup_manifest() -> dict:
    """List every user-data root worth backing up with its size on disk. The
    scan runs in a worker thread with an internal 30s budget so it never
    blocks the event loop or hangs on a huge library."""
    return await asyncio.to_thread(service.compute_manifest)


class ExportRequest(BaseModel):
    dest_dir: Optional[str] = None
    include: Optional[list[str]] = None


@router.post("/export")
async def start_export(req: ExportRequest) -> dict:
    """Kick off a zip export in a background thread. ``dest_dir`` defaults to
    the user's Documents folder; ``include`` limits the export to a subset of
    root ids from GET /manifest."""
    try:
        job_id = await asyncio.to_thread(
            service.start_export, req.dest_dir, req.include
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"job": job_id, "state": "running"}


@router.get("/export/status")
async def export_status(job: str = Query(...)) -> dict:
    status = service.job_status(job, kind="export")
    if status is None:
        raise HTTPException(status_code=404, detail=f"unknown export job: {job}")
    return status


class ImportRequest(BaseModel):
    zip_path: str
    mode: Literal["merge", "replace"] = "merge"


@router.post("/import")
async def start_import(req: ImportRequest) -> dict:
    """Validate the archive (must contain theDAW-backup-manifest.json) and
    restore it in a background thread. ``merge`` skips files that already
    exist; ``replace`` overwrites them."""
    try:
        job_id = await asyncio.to_thread(service.start_import, req.zip_path, req.mode)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"job": job_id, "state": "running"}


@router.get("/import/status")
async def import_status(job: str = Query(...)) -> dict:
    status = service.job_status(job, kind="import")
    if status is None:
        raise HTTPException(status_code=404, detail=f"unknown import job: {job}")
    return status


@router.get("/pick-folder")
async def pick_backup_folder() -> dict:
    """Open the native OS folder picker (blocking dialog runs out-of-process
    with its own timeout) and return the chosen path, or null on cancel."""
    path = await asyncio.to_thread(pick_folder, "Select backup folder")
    return {"path": path}
