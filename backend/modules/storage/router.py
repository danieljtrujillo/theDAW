"""FastAPI router for the storage module (prefix ``/api/storage``).

    GET    /locations            every model/data location with size + file count
    GET    /hf-cache             per-repo breakdown of the Hugging Face cache
    GET    /checkpoints          registered local checkpoints + catalog availability
    POST   /checkpoints          register a local checkpoint {path, name?}
    DELETE /checkpoints/{ck_id}  unregister (files are never touched)
    GET    /local-only           is no-download mode on?
    PUT    /local-only           toggle no-download mode {enabled}
    POST   /open                 open a known location in the OS file explorer

Sizes come from a recursive walk cached for 60 seconds per path (pass
``refresh=1`` to force). The WSL-side Magenta locations are probed through
``wsl.exe`` with a short timeout and the same cache, so a missing distro
degrades to ``exists: false`` instead of an error.
"""

from __future__ import annotations

import logging
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from stable_audio_3.model_configs import (
    _local_override,
    _local_search_dirs,
    arc_models,
    rf_models,
)

from .store import PROJECT_ROOT, get_registry

log = logging.getLogger(__name__)

router = APIRouter()

_SIZE_TTL_SECONDS = 60.0
_size_cache: dict[str, tuple[float, dict]] = {}
_size_lock = threading.Lock()

_WSL_TIMEOUT = 10
_wsl_cache: dict[str, tuple[float, dict]] = {}


def _dir_stats(path: Path) -> dict:
    """Recursive size + file count. Junctions/symlinks are not followed."""
    total = 0
    files = 0
    stack = [path]
    while stack:
        current = stack.pop()
        try:
            with os.scandir(current) as it:
                for entry in it:
                    try:
                        if entry.is_symlink():
                            continue
                        if entry.is_dir(follow_symlinks=False):
                            stack.append(Path(entry.path))
                        elif entry.is_file(follow_symlinks=False):
                            total += entry.stat(follow_symlinks=False).st_size
                            files += 1
                    except OSError:
                        continue
        except OSError:
            continue
    return {"bytes": total, "files": files}


def _cached_dir_stats(path: Path, refresh: bool) -> dict:
    key = str(path).lower()
    now = time.monotonic()
    with _size_lock:
        hit = _size_cache.get(key)
        if hit and not refresh and now - hit[0] < _SIZE_TTL_SECONDS:
            return hit[1]
    stats = _dir_stats(path) if path.is_dir() else {"bytes": None, "files": None}
    with _size_lock:
        _size_cache[key] = (now, stats)
    return stats


def _hf_cache_dir() -> Path:
    from huggingface_hub.constants import HF_HUB_CACHE

    return Path(HF_HUB_CACHE)


def _wsl_distro() -> str | None:
    try:
        from backend.modules.magenta.sidecar import _wsl_distro as magenta_distro

        return magenta_distro()
    except Exception:
        return None


def _wsl_location(label: str, key: str, wsl_path: str, refresh: bool) -> dict:
    """Best-effort size probe of a WSL-side directory via ``wsl.exe du``."""
    now = time.monotonic()
    hit = _wsl_cache.get(key)
    if hit and not refresh and now - hit[0] < _SIZE_TTL_SECONDS * 5:
        return hit[1]

    distro = _wsl_distro()
    entry = {
        "key": key,
        "label": label,
        "path": None,
        "kind": "wsl",
        "exists": False,
        "bytes": None,
        "files": None,
    }
    if distro:
        try:
            # The script goes in on stdin AS BYTES: wsl.exe re-joins argv after
            # `--` without preserving quoting (which empties quoted variable
            # assignments passed via `bash -lc '...'`), and text-mode stdin
            # would CRLF-translate the newlines into bash syntax errors.
            script = (
                f'p="{wsl_path}"\n'
                'if [ -d "$p" ]; then\n'
                "  echo EXISTS\n"
                '  du -sb "$p" 2>/dev/null | cut -f1\n'
                '  readlink -f "$p"\n'
                "fi\n"
            )
            result = subprocess.run(
                ["wsl.exe", "-d", distro, "--", "bash", "-l"],
                input=script.encode("utf-8"),
                capture_output=True,
                timeout=_WSL_TIMEOUT,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            stdout = result.stdout.decode("utf-8", errors="replace")
            lines = [ln.strip() for ln in stdout.splitlines() if ln.strip()]
            if lines and lines[0] == "EXISTS":
                entry["exists"] = True
                if len(lines) > 1 and lines[1].isdigit():
                    entry["bytes"] = int(lines[1])
                if len(lines) > 2:
                    entry["path"] = (
                        f"\\\\wsl.localhost\\{distro}{lines[2].replace('/', chr(92))}"
                    )
        except (OSError, subprocess.TimeoutExpired) as e:
            log.debug("storage: WSL probe for %s failed: %s", key, e)
    _wsl_cache[key] = (now, entry)
    return entry


def _windows_locations() -> list[tuple[str, str, Path]]:
    """(key, label, path) for every Windows-side location worth surfacing."""
    locations: list[tuple[str, str, Path]] = [
        (
            "hf-cache",
            "Hugging Face cache (SA3 checkpoints, T5Gemma, more)",
            _hf_cache_dir(),
        ),
    ]
    seen: set[str] = set()
    for i, d in enumerate(_local_search_dirs()):
        norm = str(d).lower().rstrip("\\/")
        if norm in seen:
            continue
        seen.add(norm)
        locations.append((f"sa3-local-{i}", "Local model folder (SA3 search path)", d))
    locations += [
        (
            "generations",
            "Generated audio library",
            PROJECT_ROOT / "data" / "generations",
        ),
        ("rag-index", "Assistant RAG index", PROJECT_ROOT / "backend" / "rag_index"),
        (
            "torch-cache",
            "Torch hub cache (Demucs, MIDI models)",
            Path(os.environ.get("TORCH_HOME", Path.home() / ".cache" / "torch")),
        ),
    ]
    return locations


@router.get("/locations")
def storage_locations(refresh: bool = False) -> dict:
    items = []
    for key, label, path in _windows_locations():
        stats = _cached_dir_stats(path, refresh)
        items.append(
            {
                "key": key,
                "label": label,
                "path": str(path),
                "kind": "windows",
                "exists": path.is_dir(),
                **stats,
            }
        )
    items.append(
        _wsl_location(
            "Magenta RT2 model assets (WSL)",
            "magenta-assets",
            "$HOME/Documents/Magenta/magenta-rt-v2",
            refresh,
        )
    )
    items.append(
        _wsl_location(
            "Magenta RT2 engine venv (WSL)", "magenta-venv", "$HOME/mrt2", refresh
        )
    )
    return {"locations": items}


@router.get("/hf-cache")
def storage_hf_cache() -> dict:
    cache_dir = _hf_cache_dir()
    if not cache_dir.is_dir():
        return {"path": str(cache_dir), "repos": [], "total_bytes": 0}
    try:
        from huggingface_hub import scan_cache_dir

        info = scan_cache_dir(cache_dir)
    except Exception as e:
        raise HTTPException(500, f"HF cache scan failed: {e}") from e
    repos = sorted(
        (
            {
                "repo_id": r.repo_id,
                "repo_type": r.repo_type,
                "bytes": r.size_on_disk,
                "files": r.nb_files,
                "path": str(r.repo_path),
                "last_accessed": r.last_accessed,
            }
            for r in info.repos
        ),
        key=lambda r: -(r["bytes"] or 0),
    )
    return {"path": str(cache_dir), "repos": repos, "total_bytes": info.size_on_disk}


@router.get("/checkpoints")
def storage_checkpoints() -> dict:
    from huggingface_hub import try_to_load_from_cache

    registry = get_registry()
    catalog = []
    for name, cfg in {**arc_models, **rf_models}.items():
        local = (
            _local_override(cfg.repo_id, cfg.config_path) is not None
            and _local_override(cfg.repo_id, cfg.ckpt_path) is not None
        )
        cached = local or (
            isinstance(try_to_load_from_cache(cfg.repo_id, cfg.config_path), str)
            and isinstance(try_to_load_from_cache(cfg.repo_id, cfg.ckpt_path), str)
        )
        catalog.append(
            {
                "name": name,
                "repo_id": cfg.repo_id,
                "source": "local" if local else "cached" if cached else "download",
            }
        )
    return {
        "registered": registry.list_checkpoints(),
        "catalog": catalog,
        "local_only": registry.local_only(),
    }


class AddCheckpointBody(BaseModel):
    path: str
    name: str | None = None


@router.post("/checkpoints")
def storage_add_checkpoint(body: AddCheckpointBody) -> dict:
    try:
        return get_registry().add_checkpoint(body.path, body.name)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@router.delete("/checkpoints/{ck_id:path}")
def storage_remove_checkpoint(ck_id: str) -> dict:
    if not get_registry().remove_checkpoint(ck_id):
        raise HTTPException(404, f"No registered checkpoint {ck_id!r}")
    return {"removed": ck_id}


class LocalOnlyBody(BaseModel):
    enabled: bool


@router.get("/local-only")
def storage_local_only() -> dict:
    return {"enabled": get_registry().local_only()}


@router.put("/local-only")
def storage_set_local_only(body: LocalOnlyBody) -> dict:
    return {"enabled": get_registry().set_local_only(body.enabled)}


class OpenBody(BaseModel):
    path: str


def _allowed_open_roots() -> list[str]:
    roots = [str(p) for _, _, p in _windows_locations()]
    roots += [e["path"] for e in get_registry().list_checkpoints()]
    distro = _wsl_distro()
    if distro:
        roots.append(f"\\\\wsl.localhost\\{distro}")
    return [r.lower().rstrip("\\/") for r in roots]


@router.post("/open")
def storage_open(body: OpenBody) -> dict:
    """Open a location in Explorer. Only paths under a known location are allowed."""
    target = body.path.strip()
    normalized = target.lower().rstrip("\\/")
    if not any(
        normalized == root
        or normalized.startswith(root + "\\")
        or normalized.startswith(root + "/")
        for root in _allowed_open_roots()
    ):
        raise HTTPException(403, "That path is not one of theDAW's model locations.")
    if sys.platform != "win32":
        raise HTTPException(501, "Open-in-explorer is implemented for Windows only.")
    try:
        os.startfile(target)  # noqa: S606 — deliberate, validated against known roots
    except OSError as e:
        raise HTTPException(404, f"Could not open {target!r}: {e}") from e
    return {"opened": target}
