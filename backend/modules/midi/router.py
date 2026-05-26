"""FastAPI router for the MIDI conversion module.

Endpoints (prefix from module.json → ``/api/midi``):

    GET  /                    capability report (which engines installed)
    GET  /{entry_id}          list MIDI rows for an entry
    POST /{entry_id}/run      run conversion (full + optionally stems)
"""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import APIRouter, HTTPException

from backend.modules.library.router import get_store as get_library_store

from .engine import PACKAGE_FOR_ENGINE, engine_capabilities, install_engine
from .runner import convert_entry

log = logging.getLogger(__name__)


router = APIRouter()


@router.get("")
@router.get("/")
def get_capabilities() -> dict:
    caps = engine_capabilities()
    caps["ok"] = caps["basic_pitch"] or caps["piano_transcription_inference"]
    caps["available_engines"] = sorted(PACKAGE_FOR_ENGINE.keys())
    return caps


@router.post("/install")
def midi_install(engine: str = "basic_pitch") -> dict:
    """Pip-install one of the MIDI engines into the main venv.

    Engines: ``basic_pitch`` (Apache-2.0, ~25 MB), ``piano_transcription_inference``
    (MIT, ~100 MB). Defaults to basic_pitch — the multi-instrument
    workhorse — since auto-MIDI for arbitrary stems uses it.
    """
    if engine not in PACKAGE_FOR_ENGINE:
        raise HTTPException(400, f"unknown engine: {engine}")
    try:
        from backend.core.idle import get_idle_manager

        get_idle_manager().bump_activity(tag="midi-install")
    except Exception:
        pass
    try:
        result = install_engine(engine)
        if not result.get("ok"):
            raise HTTPException(500, result)
        return result
    finally:
        try:
            from backend.core.idle import get_idle_manager

            get_idle_manager().release("midi-install")
        except Exception:
            pass


@router.get("/{entry_id}")
def list_entry_midis(entry_id: str) -> dict:
    store = get_library_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    record = store.get_entry(entry_id)
    if record is None:
        raise HTTPException(404, f"entry {entry_id!r} not found")
    return {
        "entry_id": entry_id,
        "midis": store.db.list_midis(entry_id),
    }


@router.post("/{entry_id}/run")
def run_conversion(entry_id: str, from_stems: bool = True) -> dict:
    store = get_library_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    record = store.get_entry(entry_id)
    if record is None:
        raise HTTPException(404, f"entry {entry_id!r} not found")
    audio_path = store.get_audio_path(entry_id)
    if audio_path is None or not Path(audio_path).is_file():
        raise HTTPException(404, f"audio for entry {entry_id!r} not on disk")
    entry_dir = store._dir_for(entry_id)  # noqa: SLF001
    if entry_dir is None:
        raise HTTPException(500, f"entry directory missing for {entry_id!r}")

    try:
        from backend.core.idle import get_idle_manager

        get_idle_manager().bump_activity(tag="midi-manual")
    except Exception:
        pass
    try:
        return convert_entry(
            store.db,
            entry_id,
            Path(audio_path),
            entry_dir,
            from_stems=from_stems,
        )
    finally:
        try:
            from backend.core.idle import get_idle_manager

            get_idle_manager().release("midi-manual")
        except Exception:
            pass
