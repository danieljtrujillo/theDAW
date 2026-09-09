"""``/api/lyricanalysis``: the per-entry literary-analysis document, the
standalone lyric documents the LYRIC tab writes, the stateless pasted-text
pass, and the analysis job. The prefix is added by the module loader.

An analysis subject is either a library entry or a standalone document, and the
``/{entry_id}`` routes serve both — ``documents.is_document_id`` tells them
apart, and a document id (``lyricdoc_`` + 32 hex) can never be an entry id. That
is what lets one analysis pane read a song's lyrics or a notebook page without
knowing the difference."""

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
    AttachLyricDocumentRequest,
    CreateLyricDocumentRequest,
    ImportLyricDocumentRequest,
    PutLyricMarksRequest,
    RunRequest,
    UpdateLyricDocumentRequest,
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


# ---- standalone lyric documents ---------------------------------------------
#
# Declared BEFORE ``/{entry_id}``: FastAPI matches routes in registration
# order, so "/documents" placed after the parametrised route would be swallowed
# by it and every list would answer "unknown entry documents".


@router.get("/documents")
def list_documents() -> dict[str, Any]:
    from . import documents

    return {"documents": [d.model_dump() for d in documents.list_documents()]}


@router.post("/documents")
def create_document(req: CreateLyricDocumentRequest) -> dict[str, Any]:
    from . import documents

    try:
        return documents.create(req).model_dump()
    except KeyError:
        raise HTTPException(
            status_code=404, detail={"error": f"unknown entry {req.entry_id}"}
        )


@router.post("/documents/import")
def import_document(req: ImportLyricDocumentRequest) -> dict[str, Any]:
    """Start a new document from a library entry's existing lyrics."""
    from . import documents

    try:
        return documents.import_from_entry(req).model_dump()
    except KeyError:
        raise HTTPException(
            status_code=404, detail={"error": f"unknown entry {req.entry_id}"}
        )


@router.get("/documents/{doc_id}")
def get_document(doc_id: str) -> dict[str, Any]:
    from . import documents

    doc = documents.load(doc_id)
    if doc is None:
        raise HTTPException(
            status_code=404, detail={"error": f"unknown lyric document {doc_id}"}
        )
    return doc.model_dump()


@router.put("/documents/{doc_id}")
def put_document(doc_id: str, req: UpdateLyricDocumentRequest) -> dict[str, Any]:
    from . import documents

    try:
        return documents.update(doc_id, req).model_dump()
    except KeyError as e:
        # The unknown subject is the document, or the song the body asked to
        # attach it to — say which.
        subject = e.args[0] if e.args else doc_id
        raise HTTPException(
            status_code=404,
            detail={"error": f"unknown lyric document or entry {subject}"},
        )


@router.delete("/documents/{doc_id}")
def delete_document(doc_id: str) -> dict[str, Any]:
    from . import documents

    return {"ok": documents.delete(doc_id)}


@router.post("/documents/{doc_id}/duplicate")
def duplicate_document(doc_id: str) -> dict[str, Any]:
    from . import documents

    try:
        return documents.duplicate(doc_id).model_dump()
    except KeyError:
        raise HTTPException(
            status_code=404, detail={"error": f"unknown lyric document {doc_id}"}
        )


@router.post("/documents/{doc_id}/attach")
def attach_document(doc_id: str, req: AttachLyricDocumentRequest) -> dict[str, Any]:
    """Make the draft a song's: record the link, and optionally write the words
    into that entry's own lyrics document."""
    from . import documents

    try:
        return documents.attach(doc_id, req.entry_id, req.write_lyrics).model_dump()
    except KeyError as e:
        subject = e.args[0] if e.args else doc_id
        raise HTTPException(
            status_code=404,
            detail={"error": f"unknown lyric document or entry {subject}"},
        )


# ---- the writer's own marks on a document ------------------------------------
#
# Three segments, so neither ``/documents/{doc_id}`` nor ``/{entry_id}`` can
# swallow these — but they stay inside the ``/documents`` block anyway, because
# the ordering rule above is about where a route is declared, not about how
# many segments it happens to have today.


@router.get("/documents/{doc_id}/marks")
def get_document_marks(doc_id: str) -> dict[str, Any]:
    """The writer's marks, anchored onto the words as they are now, with the
    ids of the ones the lyric moved out from under."""
    from . import documents

    try:
        return documents.marks_bundle(doc_id)
    except KeyError:
        raise HTTPException(
            status_code=404, detail={"error": f"unknown lyric document {doc_id}"}
        )


@router.put("/documents/{doc_id}/marks")
def put_document_marks(doc_id: str, req: PutLyricMarksRequest) -> dict[str, Any]:
    """Replace the whole mark set. Ids are minted server-side; spans that name
    no word in the document are dropped, and the response says how many."""
    from . import documents

    try:
        return documents.put_marks(doc_id, req)
    except KeyError:
        raise HTTPException(
            status_code=404, detail={"error": f"unknown lyric document {doc_id}"}
        )
    except ValueError as e:
        raise HTTPException(status_code=413, detail={"error": str(e)})


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
    from . import documents, service

    if documents.is_document_id(entry_id):
        try:
            return documents.analysis_bundle(entry_id)
        except KeyError:
            raise HTTPException(
                status_code=404,
                detail={"error": f"unknown lyric document {entry_id}"},
            )
    try:
        return service.get_bundle(entry_id)
    except KeyError:
        raise HTTPException(
            status_code=404, detail={"error": f"unknown entry {entry_id}"}
        )


@router.post("/{entry_id}/run")
async def run_analysis(entry_id: str, req: RunRequest) -> dict[str, Any]:
    from . import documents, llm, service

    is_document = documents.is_document_id(entry_id)
    if not is_document:
        _entry_or_404(entry_id)
    # The interpretive pass spends an assistant key, so refuse up front rather
    # than starting a job that can only record its own failure.
    if req.llm and not llm.available_providers(req.api_key):
        raise HTTPException(
            status_code=409,
            detail={"error": "llm unavailable", "providers": list(llm.PROVIDER_ORDER)},
        )
    try:
        job, reused = (
            documents.begin_run(entry_id, req.model_dump())
            if is_document
            else service.begin_run(entry_id, req.model_dump())
        )
    except KeyError:
        raise HTTPException(
            status_code=404, detail={"error": f"unknown lyric document {entry_id}"}
        )
    return {"ok": True, "job": _job_payload(job), "reused": reused}


@router.get("/{entry_id}/job")
def active_analysis_job(entry_id: str) -> dict[str, Any]:
    """The analysis running for the subject, if any — a tab that opened mid-run
    picks it up here."""
    from . import documents, service

    if documents.is_document_id(entry_id):
        if documents.load(entry_id) is None:
            raise HTTPException(
                status_code=404,
                detail={"error": f"unknown lyric document {entry_id}"},
            )
    else:
        _entry_or_404(entry_id)
    job = service.active_job(entry_id)
    return {"job": _job_payload(job) if job else None}


@router.delete("/{entry_id}")
def delete_analysis(entry_id: str) -> dict[str, Any]:
    from . import documents, service

    if documents.is_document_id(entry_id):
        try:
            return {"ok": documents.delete_analysis(entry_id)}
        except KeyError:
            raise HTTPException(
                status_code=404,
                detail={"error": f"unknown lyric document {entry_id}"},
            )
    try:
        return {"ok": service.delete_doc(entry_id)}
    except KeyError:
        raise HTTPException(
            status_code=404, detail={"error": f"unknown entry {entry_id}"}
        )
