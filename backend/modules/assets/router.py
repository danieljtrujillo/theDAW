"""HTTP API for the asset library.

    GET  /api/assets                list + search the catalog
    GET  /api/assets/facets         counts per kind, tag and tab
    GET  /api/assets/{id}           one entry
    GET  /api/assets/{id}/cover     its cover image
    GET  /api/assets/{id}/download  the file itself
    POST /api/assets/{id}/install   put the file where its format belongs

Install copies rather than moves: the catalog file is the shipped copy and a
second install has to keep working. Every install answers with the path it
wrote, so the UI can say where the thing went.
"""

from __future__ import annotations

import logging
import shutil
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

from backend.lib import paths

from . import catalog

log = logging.getLogger(__name__)

router = APIRouter()


def _entry_or_404(asset_id: str) -> catalog.AssetEntry:
    for e in catalog.load_entries():
        if e.id == asset_id:
            return e
    raise HTTPException(404, f"No asset with id {asset_id!r}")


def _unique_path(target: Path, name: str) -> Path:
    """``target/name``, with a numeric suffix when that exists already, so an
    install never overwrites a project the user has since edited."""
    candidate = target / name
    if not candidate.exists():
        return candidate
    stem, suffix = Path(name).stem, Path(name).suffix
    for n in range(2, 1000):
        candidate = target / f"{stem} ({n}){suffix}"
        if not candidate.exists():
            return candidate
    raise HTTPException(500, "could not find a free filename to install into")


def _install_gan(entry: catalog.AssetEntry) -> Path:
    """Hand a .gan to the plugin module, which stores and extracts it."""
    from backend.modules.plugin.router import GAN_DIR, _publish_runtime
    from backend.modules.plugin.gan_file import GanFile

    GAN_DIR.mkdir(parents=True, exist_ok=True)
    try:
        manifest = GanFile.info(str(entry.file))
    except (OSError, ValueError) as e:
        raise HTTPException(400, f"{entry.file.name} is not a readable .gan: {e}")
    plugin_id = str(manifest.get("id") or entry.id)
    dest = GAN_DIR / f"{plugin_id}.gan"
    shutil.copy2(entry.file, dest)
    _publish_runtime(dest, plugin_id)
    return dest


def _install_path(entry: catalog.AssetEntry) -> Path:
    """Where this format belongs on this machine."""
    target_name = catalog.FORMAT_TARGETS.get(entry.format)
    if target_name == "projects":
        return Path.home() / "Documents" / "theDAW Projects"
    if target_name is None:
        raise HTTPException(500, f"{entry.format} has its own installer")
    return paths.data_path(target_name)


@router.get("")
@router.get("/")
def list_assets(
    q: str = Query("", description="free text over name, summary, tags and tabs"),
    kind: str = Query("", description="project | plugin | volumetric | scene"),
    tag: str = Query(""),
    tab: str = Query("", description="an app tab the asset demonstrates"),
    available_only: bool = Query(False),
) -> dict[str, Any]:
    entries = catalog.load_entries()
    hits = catalog.search(
        entries,
        query=q,
        kind=kind,
        tag=tag,
        tab=tab,
        available_only=available_only,
    )
    return {
        "total": len(entries),
        "count": len(hits),
        "assets": [e.to_dict() for e in hits],
    }


@router.get("/facets")
def list_facets() -> dict[str, Any]:
    return catalog.facets(catalog.load_entries())


@router.get("/{asset_id}")
def get_asset(asset_id: str) -> dict[str, Any]:
    entry = _entry_or_404(asset_id)
    payload = entry.to_dict()
    payload["installs_to"] = (
        "the plugin shelf" if entry.format == ".gan" else str(_install_path(entry))
    )
    return payload


@router.get("/{asset_id}/cover")
def get_cover(asset_id: str) -> FileResponse:
    entry = _entry_or_404(asset_id)
    if entry.cover is None or not entry.cover.is_file():
        raise HTTPException(404, "no cover image")
    return FileResponse(entry.cover)


@router.get("/{asset_id}/download")
def download_asset(asset_id: str) -> FileResponse:
    entry = _entry_or_404(asset_id)
    if not entry.available:
        raise HTTPException(
            404, f"{entry.name} is listed but not present in this install"
        )
    return FileResponse(
        entry.file,
        filename=entry.file.name,
        media_type="application/octet-stream",
    )


@router.post("/{asset_id}/install")
def install_asset(asset_id: str) -> dict[str, Any]:
    entry = _entry_or_404(asset_id)
    if not entry.available:
        raise HTTPException(
            404, f"{entry.name} is listed but not present in this install"
        )

    if entry.format == ".gan":
        dest = _install_gan(entry)
        return {
            "id": entry.id,
            "installed": True,
            "path": str(dest),
            "where": "the plugin shelf",
        }

    target = _install_path(entry)
    try:
        target.mkdir(parents=True, exist_ok=True)
        dest = _unique_path(target, entry.file.name)
        shutil.copy2(entry.file, dest)
    except OSError as e:
        raise HTTPException(500, f"could not install {entry.name}: {e}") from e
    log.info("assets: installed %s to %s", entry.id, dest)
    return {"id": entry.id, "installed": True, "path": str(dest), "where": str(target)}
