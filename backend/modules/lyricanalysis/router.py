"""``/api/lyricanalysis``: the per-entry literary-analysis document, the
stateless pasted-text pass, and the analysis job. The prefix is added by the
module loader."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException

from backend.core.jobs import Job, get_job
from backend.modules.library.router import get_store

from .schema import (
    ANALYZER_VERSION,
    MEANING_KINDS,
    REPETITION_KINDS,
    RHYME_KINDS,
    SOUND_KINDS,
    STRUCTURE_KINDS,
    AnalyzeTextRequest,
    RunRequest,
)

log = logging.getLogger(__name__)

router = APIRouter()


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


@router.get("")
@router.get("/")
def capabilities() -> dict[str, Any]:
    """What this module can do here and now: the taxonomy the UI builds its
    filter rows from, and whether the interpretive pass has a key to run on."""
    from . import llm

    providers = llm.available_providers()
    return {
        "ok": True,
        "llm_available": bool(providers),
        "providers": providers,
        "kinds": {
            "rhyme": list(RHYME_KINDS),
            "sound": list(SOUND_KINDS),
            "repetition": list(REPETITION_KINDS),
            "structure": list(STRUCTURE_KINDS),
            "meaning": list(MEANING_KINDS),
        },
        "analyzer_version": ANALYZER_VERSION,
    }


@router.post("/analyze")
def analyze_text(req: AnalyzeTextRequest) -> dict[str, Any]:
    """Pasted text, no library entry, nothing written to disk."""
    from . import service

    return service.analyze_text(req).model_dump()


@router.get("/jobs/{job_id}")
def job_status(job_id: str) -> dict[str, Any]:
    job = get_job(job_id)
    if job is None or job.module != "lyricanalysis":
        raise HTTPException(
            status_code=404, detail={"error": "unknown lyricanalysis job"}
        )
    return _job_payload(job)


@router.get("/{entry_id}")
def get_analysis(entry_id: str) -> dict[str, Any]:
    from . import service

    try:
        return service.get_bundle(entry_id)
    except KeyError:
        raise HTTPException(
            status_code=404, detail={"error": f"unknown entry {entry_id}"}
        )


@router.post("/{entry_id}/run")
async def run_analysis(entry_id: str, req: RunRequest) -> dict[str, Any]:
    from . import llm, service

    _entry_or_404(entry_id)
    # The interpretive pass spends an assistant key, so refuse up front rather
    # than starting a job that can only record its own failure.
    if req.llm and not llm.available_providers(req.api_key):
        raise HTTPException(
            status_code=409,
            detail={"error": "llm unavailable", "providers": list(llm.PROVIDER_ORDER)},
        )
    job, reused = service.begin_run(entry_id, req.model_dump())
    return {"ok": True, "job": _job_payload(job), "reused": reused}


@router.get("/{entry_id}/job")
def active_analysis_job(entry_id: str) -> dict[str, Any]:
    """The analysis running for the entry, if any — a tab that opened mid-run
    picks it up here."""
    from . import service

    _entry_or_404(entry_id)
    job = service.active_job(entry_id)
    return {"job": _job_payload(job) if job else None}


@router.delete("/{entry_id}")
def delete_analysis(entry_id: str) -> dict[str, Any]:
    from . import service

    try:
        return {"ok": service.delete_doc(entry_id)}
    except KeyError:
        raise HTTPException(
            status_code=404, detail={"error": f"unknown entry {entry_id}"}
        )
