"""HTTP API for .gan web plugins.

Imports VST Foundry exports into .gan packages, lists the installed library,
and serves an extracted plugin's web assets to an iframe. The plugin UI talks
to theDAW over postMessage (relayed by the composed index.html); routing a
plugin's control outputs to targets happens on the frontend.
"""

from __future__ import annotations

import hashlib
import logging
import os
import shutil
import subprocess
import sys
import threading
from uuid import uuid4
from email.utils import formatdate, parsedate_to_datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from backend.core.startup import register_startup_hook
from backend.modules.plugin.gan_file import GanFile
from backend.modules.plugin.owl_import import import_vst_foundry, source_fingerprint
from backend.lib import paths

log = logging.getLogger(__name__)

router = APIRouter()

# Repo-root anchored, so it resolves regardless of the process CWD.
_REPO_ROOT = Path(__file__).resolve().parents[3]
GAN_DIR = paths.data_path("plugins")
RUNTIME_DIR = GAN_DIR / "_runtime"

# In-repo source for the bundled "The Owl" plugin (the sidecar .gan).
_OWL_PROJECT = (
    _REPO_ROOT
    / "backend"
    / "modules"
    / "plugin"
    / "assets"
    / "the-owl"
    / "project.json"
)
_OWL_BG = _REPO_ROOT / "frontend" / "public" / "owl" / "the-owl.png"

# In-repo source for the bundled "Ares" control surface (VST Foundry export). Its
# background.png sits beside the project.json, so the importer auto-loads it.
_ARES_PROJECT = (
    _REPO_ROOT / "backend" / "modules" / "plugin" / "assets" / "ares" / "project.json"
)


def _gan_path(plugin_id: str) -> Path:
    return GAN_DIR / f"{plugin_id}.gan"


# Every write to an extracted runtime goes through this. Three endpoints and
# the startup builder can all extract at once, and an iframe is reading the
# same tree while they do.
_RUNTIME_LOCK = threading.RLock()


def _runtime_root(plugin_id: str) -> Path:
    return RUNTIME_DIR / plugin_id


def _runtime_dir(plugin_id: str) -> Path:
    """The directory an iframe is served from right now.

    A published runtime lives in a versioned subdirectory named in the
    ``current`` pointer file. Installs that predate versioning kept the assets
    directly in the plugin's runtime root, and those keep working until the
    next build replaces them.
    """
    root = _runtime_root(plugin_id)
    try:
        name = (root / "current").read_text(encoding="utf-8").strip()
    except OSError:
        name = ""
    if name and (root / name / "index.html").is_file():
        return root / name
    return root


def _prune_runtimes(root: Path, keep: str) -> None:
    """Drop superseded versions and any pre-versioning leftovers.

    Best-effort on purpose: on Windows a file an iframe still has open cannot
    be removed, and a stale directory nothing points at costs only disk.
    """
    for child in root.iterdir():
        if child.name in {keep, "current"}:
            continue
        try:
            shutil.rmtree(child) if child.is_dir() else child.unlink()
        except OSError:
            pass


def _publish_runtime(gan_path: Path, plugin_id: str) -> Path:
    """Extract a .gan and publish it as the plugin's runtime, all or nothing.

    Extraction used to write straight into the live directory, file by file,
    while serve_runtime kept serving from it -- and serve_runtime only checks
    that index.html exists, so a rebuild under an open surface could hand the
    iframe an old document with new assets beside it. Each build now lands in
    its own directory and the pointer flips once the whole tree is there.

    The new directory is never renamed over an existing one: on Windows an
    open handle anywhere inside a directory blocks that, which is the failure
    mode a staging swap would have hit on exactly the surfaces this protects.
    """
    root = _runtime_root(plugin_id)
    root.mkdir(parents=True, exist_ok=True)
    version = f"v{uuid4().hex[:12]}"
    with _RUNTIME_LOCK:
        staging = root / f".staging-{version}"
        GanFile.extract(str(gan_path), str(staging))
        final = root / version
        os.replace(staging, final)
        pointer_tmp = root / f".current-{version}"
        pointer_tmp.write_text(version, encoding="utf-8")
        os.replace(pointer_tmp, root / "current")
        _prune_runtimes(root, keep=version)
    return final


def _entry_url(plugin_id: str, manifest: dict) -> str:
    entry = manifest.get("entry_html") or "index.html"
    return f"/api/plugin/{plugin_id}/runtime/{entry}"


def _ensure_runtime(plugin_id: str) -> dict:
    """Extract a stored .gan to its runtime dir if not already present; return
    the manifest."""
    gan = _gan_path(plugin_id)
    if not gan.is_file():
        raise HTTPException(404, f"Plugin not found: {plugin_id}")
    if not (_runtime_dir(plugin_id) / "index.html").is_file():
        _publish_runtime(gan, plugin_id)
    return GanFile.info(str(gan))


def _installed_up_to_date(plugin_id: str, fingerprint: str) -> dict | None:
    """The installed bundle's manifest when it was composed from exactly these
    inputs (same source fingerprint) and its runtime is extracted; else None.
    Lets the bundled-plugin packagers skip the rebuild that used to rewrite the
    .gan and every runtime file on each MIX mount (which also invalidated the
    browser's cached copies, so the surface re-downloaded its 1 MB artwork on
    every tab return)."""
    gan = _gan_path(plugin_id)
    if not gan.is_file() or not (_runtime_dir(plugin_id) / "index.html").is_file():
        return None
    try:
        manifest = GanFile.info(str(gan))
    except (ValueError, OSError):
        return None
    if manifest.get("source_hash") != fingerprint:
        return None
    return manifest


class ImportOwlRequest(BaseModel):
    project_path: str
    name: str | None = None


class OpenRequest(BaseModel):
    id: str | None = None
    path: str | None = None


@router.post("/import-owl")
def import_owl(req: ImportOwlRequest) -> dict:
    """Import a VST Foundry export (project.json or its folder) into a .gan,
    store it, extract its runtime, and return the manifest + entry URL."""
    src = Path(req.project_path)
    if src.is_dir():
        src = src / "project.json"
    if not src.is_file():
        raise HTTPException(400, f"project.json not found at: {req.project_path}")

    try:
        manifest, assets = import_vst_foundry(str(src), name=req.name)
    except (ValueError, KeyError) as e:
        raise HTTPException(400, f"Import failed: {e}")

    GAN_DIR.mkdir(parents=True, exist_ok=True)
    gan_path = _gan_path(manifest.id)
    manifest_dict = GanFile.save(manifest, assets, str(gan_path))
    _publish_runtime(gan_path, manifest.id)

    return {
        "manifest": manifest_dict,
        "gan_path": str(gan_path),
        "entry_url": _entry_url(manifest.id, manifest_dict),
    }


@router.get("/list")
def list_plugins() -> dict:
    """List installed .gan plugins (manifest summary each).

    Waits for the startup build when one is in flight: the MIX view lists once
    on mount and only Ares has a follow-up call, so answering early on a fresh
    install left the shelf empty until a manual reload.
    """
    _wait_for_bundled()
    GAN_DIR.mkdir(parents=True, exist_ok=True)
    out = []
    for gan in sorted(GAN_DIR.glob("*.gan")):
        try:
            m = GanFile.info(str(gan))
        except (ValueError, OSError) as e:
            log.warning("Skipping unreadable .gan %s: %s", gan.name, e)
            continue
        out.append(
            {
                "id": m.get("id"),
                "name": m.get("name"),
                "kind": m.get("kind"),
                "description": m.get("description"),
                "controls": m.get("controls", []),
                "gan_path": str(gan),
                "entry_url": _entry_url(m.get("id", gan.stem), m),
            }
        )
    return {"plugins": out}


@router.get("/info")
def plugin_info(path: str) -> dict:
    """Read the manifest of a .gan at an arbitrary path (no install)."""
    try:
        return GanFile.info(path)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/open")
def open_plugin(req: OpenRequest) -> dict:
    """Open an installed plugin by id, or install+open a .gan at a path.
    Returns the manifest + entry URL ready to iframe."""
    if req.id:
        manifest = _ensure_runtime(req.id)
        return {"manifest": manifest, "entry_url": _entry_url(req.id, manifest)}

    if req.path:
        src = Path(req.path)
        if not src.is_file():
            raise HTTPException(400, f".gan not found: {req.path}")
        try:
            manifest = GanFile.info(req.path)
        except ValueError as e:
            raise HTTPException(400, str(e))
        pid = manifest.get("id") or src.stem
        # Install a copy into the library if it is not already there.
        GAN_DIR.mkdir(parents=True, exist_ok=True)
        dest = _gan_path(pid)
        if src.resolve() != dest.resolve():
            GanFile.install(str(src), str(dest))
        _publish_runtime(dest, pid)
        return {"manifest": manifest, "entry_url": _entry_url(pid, manifest)}

    raise HTTPException(400, "Provide an id or a path.")


@router.post("/package-owl")
def package_owl() -> dict:
    """Build (or rebuild) the bundled 'The Owl' sidecar .gan in data/plugins from
    the in-repo assets (owl artwork + canvas surfaces), excluding the preset
    carousel. Returns its path so the UI can reveal/share it like a VST bundle."""
    if not _OWL_PROJECT.is_file():
        raise HTTPException(500, f"Owl project asset missing: {_OWL_PROJECT}")
    if not _OWL_BG.is_file():
        # Packaging drops it and the surface opens blank, which is invisible
        # until someone looks at the plugin. Say so where it can be found.
        log.warning("plugin: Owl artwork missing at %s; packaging without it", _OWL_BG)
    owl_opts = dict(
        name="The Owl",
        plugin_id="the-owl",
        background_path=str(_OWL_BG) if _OWL_BG.is_file() else None,
        exclude_substrings=["carousel"],
    )
    gan_path = _gan_path("the-owl")
    fingerprint = source_fingerprint(str(_OWL_PROJECT), **owl_opts)
    if (cached := _installed_up_to_date("the-owl", fingerprint)) is not None:
        return {"manifest": cached, "gan_path": str(gan_path), "rebuilt": False}
    try:
        manifest, assets = import_vst_foundry(str(_OWL_PROJECT), **owl_opts)
    except (ValueError, KeyError) as e:
        raise HTTPException(500, f"Owl package failed: {e}")
    GAN_DIR.mkdir(parents=True, exist_ok=True)
    manifest_dict = GanFile.save(manifest, assets, str(gan_path))
    _publish_runtime(gan_path, "the-owl")
    return {"manifest": manifest_dict, "gan_path": str(gan_path), "rebuilt": True}


@router.post("/package-ares")
def package_ares() -> dict:
    """Build (or rebuild) the bundled 'Ares' control surface .gan in data/plugins
    from the in-repo VST Foundry export (project.json + background.png beside it).
    Returns its path + entry URL so the MIX Studio tile can open it in the stage."""
    if not _ARES_PROJECT.is_file():
        raise HTTPException(500, f"Ares project asset missing: {_ARES_PROJECT}")
    gan_path = _gan_path("ares")
    fingerprint = source_fingerprint(str(_ARES_PROJECT), name="Ares", plugin_id="ares")
    # Unchanged source + template -> the installed bundle IS this package.
    # Answer from it without touching a file, so the stage iframe can never
    # race a rewrite and the browser cache of the runtime assets stays warm.
    if (cached := _installed_up_to_date("ares", fingerprint)) is not None:
        return {
            "manifest": cached,
            "gan_path": str(gan_path),
            "entry_url": _entry_url("ares", cached),
            "rebuilt": False,
        }
    try:
        manifest, assets = import_vst_foundry(
            str(_ARES_PROJECT),
            name="Ares",
            plugin_id="ares",
        )
    except (ValueError, KeyError) as e:
        raise HTTPException(500, f"Ares package failed: {e}")
    GAN_DIR.mkdir(parents=True, exist_ok=True)
    manifest_dict = GanFile.save(manifest, assets, str(gan_path))
    _publish_runtime(gan_path, "ares")
    return {
        "manifest": manifest_dict,
        "gan_path": str(gan_path),
        "entry_url": _entry_url("ares", manifest_dict),
        "rebuilt": True,
    }


class RevealRequest(BaseModel):
    path: str


@router.post("/reveal")
def reveal_path(req: RevealRequest) -> dict:
    """Reveal a file in the OS file manager (Explorer/Finder), selecting it."""
    p = Path(req.path)
    if not p.exists():
        raise HTTPException(404, f"Not found: {req.path}")
    plat: str = sys.platform
    try:
        if plat == "win32":
            subprocess.Popen(["explorer", f"/select,{p}"])
        elif plat == "darwin":
            subprocess.Popen(["open", "-R", str(p)])
        else:
            subprocess.Popen(["xdg-open", str(p.parent)])
    except OSError as e:
        raise HTTPException(500, f"Reveal failed: {e}")
    return {"status": "ok", "path": str(p)}


@router.delete("/{plugin_id}")
def delete_plugin(plugin_id: str) -> dict:
    """Remove an installed plugin and its extracted runtime."""
    gan = _gan_path(plugin_id)
    removed = False
    if gan.is_file():
        gan.unlink()
        removed = True
    with _RUNTIME_LOCK:
        root = _runtime_root(plugin_id)
        if root.is_dir():
            shutil.rmtree(root, ignore_errors=True)
    if not removed:
        raise HTTPException(404, f"Plugin not found: {plugin_id}")
    return {"status": "deleted", "id": plugin_id}


def _not_modified(request: Request, etag: str, mtime: float) -> bool:
    """True when the client's cached copy (If-None-Match / If-Modified-Since)
    is still the file on disk, so a 304 can stand in for the body."""
    inm = request.headers.get("if-none-match")
    if inm:
        return etag in [tag.strip().removeprefix("W/") for tag in inm.split(",")]
    ims = request.headers.get("if-modified-since")
    if ims:
        try:
            return parsedate_to_datetime(ims).timestamp() >= int(mtime)
        except (TypeError, ValueError):
            return False
    return False


@router.get("/{plugin_id}/runtime/{asset_path:path}")
def serve_runtime(plugin_id: str, asset_path: str, request: Request) -> Response:
    """Serve an extracted plugin asset to the iframe. Guards against traversal.

    Assets are served with ``Cache-Control: no-cache`` plus conditional-GET
    support: the browser keeps its copy (the 1 MB artwork, two dozen element
    documents) and revalidates each with a cheap 304 round trip, so re-opening
    a surface is near-instant while a repackaged runtime still shows up at once
    (its mtime/etag change, so the revalidation returns the new body).
    """
    # Only extract when the runtime dir is missing: reading the .gan's manifest
    # for every one of a surface's ~25 asset requests bought nothing.
    if not (_runtime_dir(plugin_id) / "index.html").is_file():
        _ensure_runtime(plugin_id)
    base = _runtime_dir(plugin_id).resolve()
    target = (base / asset_path).resolve()
    if not str(target).startswith(str(base)) or not target.is_file():
        raise HTTPException(404, "Asset not found")
    stat = target.stat()
    etag_base = f"{stat.st_mtime}-{stat.st_size}"
    etag = f'"{hashlib.md5(etag_base.encode(), usedforsecurity=False).hexdigest()}"'
    headers = {
        "Cache-Control": "no-cache",
        "ETag": etag,
        "Last-Modified": formatdate(stat.st_mtime, usegmt=True),
    }
    if _not_modified(request, etag, stat.st_mtime):
        return Response(status_code=304, headers=headers)
    return FileResponse(target, headers=headers)


# Set once the startup build has finished (or failed). list_plugins waits on
# it so a fresh install cannot answer an empty shelf that nothing refreshes:
# the MIX view lists once on mount, and only Ares has a follow-up call.
_BUNDLED_READY = threading.Event()
_BUNDLED_STARTED = False
# Long enough for a cold first build on a slow disk, short enough that a build
# wedged on something unforeseen degrades to a stale list rather than a hung UI.
_BUNDLED_WAIT_SEC = 20.0


def _wait_for_bundled() -> None:
    """Block briefly until the startup build has published, if one is running."""
    if _BUNDLED_STARTED and not _BUNDLED_READY.is_set():
        _BUNDLED_READY.wait(_BUNDLED_WAIT_SEC)


def _build_bundled_plugins() -> None:
    """Build the two bundled .gan plugins if they are not installed yet.

    Both are compiled from in-repo assets by package-owl / package-ares, and
    nothing called those until a person opened the shelf and pressed a button.
    A fresh install — Pinokio, or the packaged desktop app — therefore started
    with an empty PLUGINS shelf and an empty MIX Studio tile, while the
    machine that had once pressed the button kept working. Both builders
    fingerprint their source and return the installed bundle untouched when it
    matches, so running this on every start costs one hash after the first.

    Off the startup path in a daemon thread: importing a Foundry project is a
    second or two of work and nothing should wait on it.
    """

    def _build() -> None:
        try:
            for label, build in (("The Owl", package_owl), ("Ares", package_ares)):
                try:
                    if build().get("rebuilt"):
                        log.info("plugin: built the bundled %s package", label)
                except Exception as e:  # noqa: BLE001 — one missing asset is not fatal
                    log.warning("plugin: bundled %s is unavailable: %s", label, e)
        finally:
            # Always, including after a crash in a packager: a listing that
            # waits forever is worse than one that lists what is there.
            _BUNDLED_READY.set()

    global _BUNDLED_STARTED
    _BUNDLED_STARTED = True
    _BUNDLED_READY.clear()
    threading.Thread(target=_build, daemon=True, name="plugin-bundled").start()


register_startup_hook("plugin-bundled", _build_bundled_plugins)
