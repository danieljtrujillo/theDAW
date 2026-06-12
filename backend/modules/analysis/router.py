"""FastAPI router for the analysis module.

Endpoints (prefix from module.json → ``/api/analysis``):

    GET  /              health / capability report
    GET  /{id}          fetch the analysis row for an entry
    POST /{id}/run      run analysis synchronously and return the
                        result. Foreground call; bumps the idle
                        manager so background workers don't compete.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from fastapi import APIRouter, HTTPException

from backend.modules.library.router import get_store as get_library_store

from .engine import ANALYSIS_VERSION, analyze_and_persist
from .ffprobe import has_ffprobe
from .prompt import generate_prompt

log = logging.getLogger(__name__)


router = APIRouter()


@router.get("")
@router.get("/")
def get_capabilities() -> dict:
    return {
        "ok": True,
        "ffprobe": has_ffprobe(),
        "engines": ["aubio (tempo)", "librosa (key/pitch/bars/rms)"],
        "prompt_inference": "deterministic",
        "semantic_tags": True,
        "ml_enrichers": [],
    }


def _analysis_from_row(row: dict) -> dict:
    """Reconstruct the fields the prompt generator needs from a stored
    analysis row, pulling duration/channels out of the ffprobe summary."""
    try:
        summary = (json.loads(row.get("ffprobe_json") or "{}") or {}).get("_summary")
    except (TypeError, ValueError):
        summary = None
    summary = summary or {}
    return {
        "bpm": row.get("bpm"),
        "key": row.get("key"),
        "scale": row.get("scale"),
        "key_confidence": row.get("key_confidence"),
        "rms_db": row.get("rms_db"),
        "loudness_lufs": row.get("loudness_lufs"),
        "pitch_mean_hz": row.get("pitch_mean_hz"),
        "pitch_std_hz": row.get("pitch_std_hz"),
        "genre": row.get("genre"),
        "duration_sec": summary.get("duration_sec"),
        "channels": summary.get("channels"),
    }


@router.get("/{entry_id}/prompt")
def get_prompt(entry_id: str) -> dict:
    """Generate a Stable Audio-style prompt and semantic tags from an entry's
    analysis. Regenerated from the stored analysis each call, so entries
    analyzed before this feature still get a prompt."""
    store = get_library_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    row = store.db.get_analysis(entry_id)
    if row is None:
        raise HTTPException(404, f"entry {entry_id!r} has no analysis yet")

    try:
        embedded = json.loads(row.get("embedded_tags_json") or "{}")
    except (TypeError, ValueError):
        embedded = {}
    title = str(getattr(store.get_entry(entry_id), "title", "") or "")
    result = generate_prompt(
        _analysis_from_row(row),
        embedded_tags=embedded if isinstance(embedded, dict) else {},
        title=title,
    )
    return {"entry_id": entry_id, **result}


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
    # A row from an older analyzer version is reported as 'pending' so the
    # frontend re-runs it (Mixxx-style: re-analyze when the analyzer changes).
    # This is how stale bpm=null rows — written before the librosa tempo
    # fallback — heal themselves instead of looking permanently analyzed.
    if int(row.get("version") or 0) < ANALYSIS_VERSION:
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
