"""FastAPI router for the analysis module.

Endpoints (prefix from module.json → ``/api/analysis``):

    GET  /              health / capability report
    GET  /{id}          fetch the analysis row for an entry
    POST /{id}/run      run analysis synchronously and return the
                        result. Foreground call; bumps the idle
                        manager so background workers don't compete.
                        ``?profile=dj`` runs the deck-only subset.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query

from backend.modules.library.router import get_store as get_library_store

from .engine import (
    ANALYSIS_VERSION,
    PROFILE_DJ,
    PROFILE_FULL,
    AnalysisBusy,
    analyze_and_persist,
    profile_of_row,
)
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
    # WHICH profile wrote this row. A 'dj' row has no pitch statistics and no
    # integrated loudness, and without this field every reader -- the Details
    # panel, the node inspector, the prompt route -- showed a partial row as a
    # complete one whose expensive fields happened to be empty.
    return {**row, "profile": profile_of_row(row)}


@router.post("/{entry_id}/run")
def run_analysis(
    entry_id: str,
    profile: str = Query(
        PROFILE_FULL,
        description=(
            "'full' runs every step; 'dj' runs only what a deck reads "
            "(ffprobe, one decode, tempo+beats+confidence, key, rms) and "
            "leaves pitch and LUFS for a later full run."
        ),
    ),
) -> dict:
    if profile not in (PROFILE_FULL, PROFILE_DJ):
        raise HTTPException(
            422, f"unknown analysis profile {profile!r} (expected 'full' or 'dj')"
        )
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
        # The concurrency cap and the single-flight live in the engine, on
        # analyze_and_persist itself: the library store's background queue
        # calls that function directly and would otherwise bypass a gate kept
        # here. This endpoint owns the profile validation above and nothing
        # else about scheduling.
        return analyze_and_persist(
            store.db,
            entry_id,
            Path(audio_path),
            metadata_path=metadata_path,
            # The store whose metadata lock the entry's other writers take:
            # this runs on FastAPI's threadpool alongside user edits of the
            # same entry, and metadata.json is the source of truth.
            store=store,
            profile=profile,
        )
    except AnalysisBusy as e:
        # Another run of this entry is still going (a slow decode). Nothing
        # was cancelled; the client's queue retries on its own schedule.
        raise HTTPException(503, str(e)) from e
    finally:
        try:
            from backend.core.idle import get_idle_manager

            get_idle_manager().release("analysis-manual")
        except Exception:
            pass
