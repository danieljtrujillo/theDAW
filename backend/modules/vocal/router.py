"""Vocal engine API.

The prerequisite pipeline that produces the canonical vocal artifact. Singing
synthesis and voice conversion (SoulX and others) stay deferred; they consume the
artifact this module produces.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.core.jobs import Job, create_job, get_job

from . import service

router = APIRouter()


class PrepareRequest(BaseModel):
    asset_id: str
    isolate: bool = True
    isolation: str = "vocal_isolate"  # vocal_isolate | demucs
    cleanup: bool = True
    transcribe: bool = False
    language: str = "en"


@router.get("/health")
def health() -> dict:
    return service.health()


@router.post("/prepare")
def prepare(req: PrepareRequest) -> dict:
    job = create_job("vocal", f"Prepare vocal artifact ({req.asset_id})")
    service.start_prepare(job, req.model_dump())
    return {"ok": True, "job": {"id": job.id}}


def _job_payload(job: Job) -> dict:
    return {
        "id": job.id,
        "status": job.status,
        "progress": job.progress,
        "message": job.message,
        "result": job.result,
        "error": job.error,
    }


@router.get("/jobs/{job_id}")
def job_status(job_id: str) -> dict:
    job = get_job(job_id)
    if job is None or job.module != "vocal":
        raise HTTPException(status_code=404, detail="job not found")
    return _job_payload(job)


@router.post("/jobs/{job_id}/cancel")
def job_cancel(job_id: str) -> dict:
    job = get_job(job_id)
    if job is None or job.module != "vocal":
        raise HTTPException(status_code=404, detail="job not found")
    job.update(status="cancelled", message="cancelled by user")
    return {"ok": True}


@router.get("/metadata/{asset_id}")
def get_metadata(asset_id: str) -> dict:
    art = service.load_artifact(asset_id)
    if art is None:
        raise HTTPException(status_code=404, detail="no artifact for asset")
    return art
