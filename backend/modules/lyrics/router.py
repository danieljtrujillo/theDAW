"""``/api/lyrics``: the per-entry lyrics document, LRC import/export and the
transcribe / align jobs. The prefix is added by the module loader."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query, Response

from backend.core.jobs import Job, get_job
from backend.modules.library.router import get_store
from backend.modules.vocal.transcription import available as transcription_available

from . import service
from .schema import AlignRequest, ImportRequest, PutLyricsRequest, TranscribeRequest

router = APIRouter()

INSTALL_ROUTE = "/api/vocal/transcription/install"


def _entry_or_404(entry_id: str) -> None:
    if get_store().get_entry(entry_id) is None:
        raise HTTPException(
            status_code=404, detail={"error": f"unknown entry {entry_id}"}
        )


def _job_payload(job: Job) -> dict[str, Any]:
    return {
        "id": job.id,
        "status": job.status,
        "progress": job.progress,
        "message": job.message,
        "result": job.result,
        "error": job.error,
    }


def _require_transcription() -> None:
    if not transcription_available():
        raise HTTPException(
            status_code=409,
            detail={"error": "transcription unavailable", "install": INSTALL_ROUTE},
        )


@router.get("/jobs/{job_id}")
def job_status(job_id: str) -> dict[str, Any]:
    job = get_job(job_id)
    if job is None or job.module != "lyrics":
        raise HTTPException(status_code=404, detail={"error": "unknown lyrics job"})
    return _job_payload(job)


@router.get("/{entry_id}")
def get_lyrics(entry_id: str) -> dict[str, Any]:
    try:
        return service.get_bundle(entry_id)
    except KeyError:
        raise HTTPException(
            status_code=404, detail={"error": f"unknown entry {entry_id}"}
        )


@router.put("/{entry_id}")
def put_lyrics(entry_id: str, req: PutLyricsRequest) -> dict[str, Any]:
    _entry_or_404(entry_id)
    doc = service.normalize_doc(entry_id, req, service.load_doc(entry_id))
    return service.save_doc(doc).model_dump()


@router.delete("/{entry_id}")
def delete_lyrics(entry_id: str) -> dict[str, Any]:
    try:
        return {"ok": service.delete_doc(entry_id)}
    except KeyError:
        raise HTTPException(
            status_code=404, detail={"error": f"unknown entry {entry_id}"}
        )


@router.post("/{entry_id}/transcribe")
async def transcribe_lyrics(entry_id: str, req: TranscribeRequest) -> dict[str, Any]:
    _entry_or_404(entry_id)
    _require_transcription()
    job, reused = service.begin_transcribe(entry_id, req.model_dump())
    return {"ok": True, "job": {"id": job.id}, "reused": reused}


@router.post("/{entry_id}/align")
async def align_lyrics(entry_id: str, req: AlignRequest) -> dict[str, Any]:
    _entry_or_404(entry_id)
    _require_transcription()
    job, reused = service.begin_align(entry_id, req.model_dump())
    return {"ok": True, "job": {"id": job.id}, "reused": reused}


@router.get("/{entry_id}/job")
def active_lyrics_job(entry_id: str) -> dict[str, Any]:
    """The align / transcribe job running for the entry, if any (the auto
    pipeline may have started one before the SING tab opened)."""
    _entry_or_404(entry_id)
    job = service.active_job(entry_id)
    return {"job": _job_payload(job) if job else None}


@router.post("/{entry_id}/import")
def import_lyrics(entry_id: str, req: ImportRequest) -> dict[str, Any]:
    _entry_or_404(entry_id)
    return service.import_doc(entry_id, req.format, req.content).model_dump()


@router.get("/{entry_id}/export")
def export_lyrics(
    entry_id: str,
    format: str = Query("lrc", pattern="^(lrc|txt)$"),
    words: int = Query(0, ge=0, le=1),
) -> Response:
    try:
        content, filename = service.export_text(entry_id, format, bool(words))
    except KeyError:
        raise HTTPException(status_code=404, detail={"error": "no lyrics to export"})
    return Response(
        content=content,
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
