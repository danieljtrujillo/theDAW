"""FastAPI router for the analysis module.

Endpoints (prefix from module.json → ``/api/analysis``):

    GET  /              health / capability report
    GET  /{id}          fetch the analysis row for an entry
    POST /{id}/run      run analysis synchronously and return the
                        result. Foreground call; bumps the idle
                        manager so background workers don't compete.
"""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import APIRouter, HTTPException

from backend.modules.library.router import get_store as get_library_store

from .engine import analyze_and_persist
from .ffprobe import has_ffprobe

log = logging.getLogger(__name__)


router = APIRouter()


@router.get("")
@router.get("/")
def get_capabilities() -> dict:
    return {
        "ok": True,
        "ffprobe": has_ffprobe(),
        "engines": ["aubio (tempo)", "librosa (key/pitch/bars/rms)"],
    }


@router.get("/{entry_id}")
def get_analysis(entry_id: str) -> dict:
    """Return the analysis row for an entry, or an empty payload with
    ``status='pending'`` when nothing has analyzed it yet. We return 200
    (not 404) for the empty case because the frontend Details panel
    polls this on every entry select — a 404 here floods the browser
    Network tab with red errors for entries that simply haven't been
    analyzed yet, which is a normal state, not a failure."""
    store = get_library_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    row = store.db.get_analysis(entry_id)
    if row is None:
        return {"entry_id": entry_id, "status": "pending"}
    return row


@router.post("/{entry_id}/run")
def run_analysis(entry_id: str) -> dict:
    store = get_library_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    record = store.get_entry(entry_id)
    if record is None:
        raise HTTPException(404, f"entry {entry_id!r} not found")
    audio_path = store.get_audio_path(entry_id)
    if audio_path is None or not Path(audio_path).is_file():
        raise HTTPException(404, f"audio for entry {entry_id!r} not on disk")

    entry_dir = store._dir_for(entry_id)  # noqa: SLF001 — internal but stable
    metadata_path = (entry_dir / "metadata.json") if entry_dir else None

    # Hold the idle gate while we run so background workers don't
    # compete (manual /run is treated as foreground activity).
    try:
        from backend.core.idle import get_idle_manager

        get_idle_manager().bump_activity(tag="analysis-manual")
    except Exception:
        pass

    try:
        payload = analyze_and_persist(
            store.db,
            entry_id,
            Path(audio_path),
            metadata_path=metadata_path,
        )
        return payload
    finally:
        try:
            from backend.core.idle import get_idle_manager

            get_idle_manager().release("analysis-manual")
        except Exception:
            pass
