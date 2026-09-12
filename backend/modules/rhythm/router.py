"""FastAPI router for the rhythm module (prefix from module.json: ``/api/rhythm``).

    GET  /                capability report
    GET  /{entry_id}      the cached analysis for a library entry — 200 with
                          ``status: pending`` when there is none yet (the
                          Details panel polls this; a 404 would paint the
                          Network tab red for a normal state)
    POST /{entry_id}/run  analyze the entry's audio now, cache it, return it
    POST /file            analyze an arbitrary audio path (tools, tests,
                          the UNCANNY report), optional stems by name

Results are cached as JSON under ``data/rhythm/<entry_id>.json`` — written
atomically, versioned by ``RHYTHM_VERSION`` so a cache from an older engine
reads as pending and re-runs.
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.lib.atomic import atomic_write

from .engine import RHYTHM_VERSION, analyze_file

log = logging.getLogger(__name__)

router = APIRouter()

# Repo-root anchored, so it resolves regardless of the process CWD.
_REPO_ROOT = Path(__file__).resolve().parents[3]
CACHE_DIR = _REPO_ROOT / "data" / "rhythm"


def _cache_path(entry_id: str) -> Path:
    safe = "".join(c for c in entry_id if c.isalnum() or c in "-_") or "entry"
    return CACHE_DIR / f"{safe}.json"


def _read_cache(entry_id: str) -> Optional[dict[str, Any]]:
    p = _cache_path(entry_id)
    if not p.is_file():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        log.info("rhythm: unreadable cache %s (%s)", p.name, e)
        return None
    if int(data.get("version") or 0) < RHYTHM_VERSION:
        return None
    return data


def _write_cache(entry_id: str, data: dict[str, Any]) -> None:
    atomic_write(_cache_path(entry_id), json.dumps(data))


def _entry_audio(entry_id: str) -> Path:
    from backend.modules.library.router import get_store as get_library_store

    store = get_library_store()
    if store.get_entry(entry_id) is None:
        raise HTTPException(404, f"entry {entry_id!r} not found")
    audio_path = store.get_audio_path(entry_id)
    if audio_path is None or not Path(audio_path).is_file():
        raise HTTPException(404, f"audio for entry {entry_id!r} not on disk")
    return Path(audio_path)


def _bump_idle(tag: str) -> None:
    # A manual run is foreground activity; keep the background workers off it.
    try:
        from backend.core.idle import get_idle_manager

        get_idle_manager().bump_activity(tag=tag)
    except Exception:  # noqa: BLE001 — the idle manager is optional here
        pass


@router.get("")
@router.get("/")
def health() -> dict[str, Any]:
    return {
        "module": "rhythm",
        "version": RHYTHM_VERSION,
        "cache_dir": str(CACHE_DIR),
        "features": [
            "tempo_curve",
            "tempo_segments",
            "beats",
            "downbeats",
            "meter_map",
            "additive_groupings",
            "subdivision",
            "syncopation_lhl",
            "syncopation_wnbd",
            "offbeat_ratio",
            "swing_ratio",
            "polymeter",
            "cross_rhythms",
        ],
    }


@router.get("/{entry_id}")
def get_rhythm(entry_id: str) -> dict[str, Any]:
    cached = _read_cache(entry_id)
    if cached is None:
        return {"entry_id": entry_id, "status": "pending"}
    return {"entry_id": entry_id, "status": "ready", **cached}


@router.post("/{entry_id}/run")
def run_rhythm(entry_id: str) -> dict[str, Any]:
    audio = _entry_audio(entry_id)
    _bump_idle("rhythm-manual")
    t0 = time.time()
    try:
        result = analyze_file(audio)
    except Exception as e:  # noqa: BLE001 — surfaced to the caller as a 500 with the cause
        log.exception("rhythm: analysis failed for %s", audio.name)
        raise HTTPException(500, f"rhythm analysis failed: {e}") from e
    result["analyzed_at"] = time.time()
    result["elapsed_sec"] = round(time.time() - t0, 2)
    result["source"] = audio.name
    _write_cache(entry_id, result)
    return {"entry_id": entry_id, "status": "ready", **result}


class FileRequest(BaseModel):
    path: str
    stems: Optional[dict[str, str]] = None


@router.post("/file")
def run_rhythm_file(req: FileRequest) -> dict[str, Any]:
    p = Path(req.path)
    if not p.is_file():
        raise HTTPException(404, f"audio not found: {req.path}")
    _bump_idle("rhythm-file")
    t0 = time.time()
    try:
        result = analyze_file(p, stems=req.stems)
    except Exception as e:  # noqa: BLE001
        log.exception("rhythm: analysis failed for %s", p.name)
        raise HTTPException(500, f"rhythm analysis failed: {e}") from e
    result["elapsed_sec"] = round(time.time() - t0, 2)
    result["source"] = p.name
    return result
