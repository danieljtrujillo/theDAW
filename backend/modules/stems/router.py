"""FastAPI router for the stems module.

Endpoints (prefix from module.json → ``/api/stems``):

    GET  /probe              non-spawning health snapshot
    GET  /status             current sidecar state (port, running)
    POST /start              manually spawn the sidecar
    POST /stop               manually stop the sidecar
    POST /{entry_id}/run     separate a library entry's audio into stems
                             (foreground; holds the idle gate)
    GET  /{entry_id}         list persisted stems for an entry
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException

from backend.modules.library.router import get_store as get_library_store

from .engine import separate_entry
from .sidecar import get_sidecar, install_dependencies, probe, reset_sidecar

log = logging.getLogger(__name__)


router = APIRouter()


@router.get("/probe")
def stems_probe() -> dict:
    return probe()


@router.get("/status")
def stems_status() -> dict:
    sc = get_sidecar()
    return {
        "running": sc.running,
        "port": sc.port,
        "package_path": str(sc.cfg.package_path),
        "python_exe": str(sc.cfg.python_exe),
    }


@router.post("/start")
def stems_start() -> dict:
    sc = get_sidecar()
    try:
        port = sc.ensure_running()
        return {"ok": True, "port": port}
    except RuntimeError as e:
        raise HTTPException(503, str(e))


@router.post("/install")
def stems_install() -> dict:
    """Pip-install the integration-package's requirements (demucs,
    torchcrepe, audio-separator, …) into the configured Python.
    Blocking; can take several minutes the first time."""
    try:
        from backend.core.idle import get_idle_manager

        get_idle_manager().bump_activity(tag="stems-install")
    except Exception:
        pass
    try:
        result = install_dependencies()
        if not result.get("ok"):
            raise HTTPException(500, result)
        return result
    finally:
        try:
            from backend.core.idle import get_idle_manager

            get_idle_manager().release("stems-install")
        except Exception:
            pass


@router.post("/stop")
def stems_stop() -> dict:
    sc = get_sidecar()
    sc.stop()
    reset_sidecar()
    return {"ok": True, "running": False}


@router.get("/{entry_id}")
def list_entry_stems(entry_id: str) -> dict:
    store = get_library_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    record = store.get_entry(entry_id)
    if record is None:
        raise HTTPException(404, f"entry {entry_id!r} not found")
    return {
        "entry_id": entry_id,
        "stems": store.db.list_stems(entry_id),
    }


@router.post("/{entry_id}/run")
async def run_separation(
    entry_id: str,
    stems: int = 4,
    device: Optional[str] = None,
) -> dict:
    if stems not in (2, 4, 6, 12):
        raise HTTPException(400, "stems must be 2, 4, 6, or 12")
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

        get_idle_manager().bump_activity(tag="stems-manual")
    except Exception:
        pass

    try:
        result = await separate_entry(
            store.db,
            entry_id,
            Path(audio_path),
            entry_dir,
            stems=stems,
            device=device,
        )
        return result
    except RuntimeError as e:
        raise HTTPException(503, str(e))
    finally:
        try:
            from backend.core.idle import get_idle_manager

            get_idle_manager().release("stems-manual")
        except Exception:
            pass
