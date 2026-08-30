"""Routes backing theDAW's SWAY tab.

The tab asks this module one question -- "is there a cockpit to show, and at
what URL?" -- and renders either the iframe or an actionable explanation of
what is missing. Mounted at /api/sway by backend/modules/loader.py.

This module also owns two glue duties the embedded cockpit needs:

* Template media consent. A staged template (``templates/*.sway``) names its
  audio by absolute path, and the cockpit fetches that audio through
  ``/api/project/clip-audio`` -- which 403s anything outside the allowed media
  roots. Shipping a template in the bundle IS consent for the files it names
  (the exact model .als import and .tasmo open already use), so the template-
  referenced paths are registered with media_access before the iframe URL is
  handed out. Without this, pressing play on a template yields silence: every
  decode error is swallowed into a warnings array nobody renders.

* Durable saves. The embedded cockpit's ``project.write`` persists to
  localStorage plus a browser download; the staged bundle additionally mirrors
  each save to ``POST /api/sway/project-save`` so a real ``.sway`` file lands
  in ``data/sway-projects`` and survives cleared browser storage.
"""

from __future__ import annotations

import json
import logging
import re

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.modules.project import media_access

from . import sidecar

log = logging.getLogger(__name__)
router = APIRouter()

_PROJECTS_DIR = sidecar._REPO_ROOT / "data" / "sway-projects"

_template_media_registered = False


def _collect_media_paths(node: object, out: list[str]) -> None:
    """Walk a .sway document for absolute ``"path"`` values (media refs)."""
    if isinstance(node, dict):
        for key, value in node.items():
            if (
                key == "path"
                and isinstance(value, str)
                and (re.match(r"^[A-Za-z]:[\\/]", value) or value.startswith("/"))
            ):
                out.append(value)
            else:
                _collect_media_paths(value, out)
    elif isinstance(node, list):
        for value in node:
            _collect_media_paths(value, out)


def _register_template_media() -> None:
    """Allowlist every staged template's media with media_access (once)."""
    global _template_media_registered
    if _template_media_registered:
        return
    dist = sidecar.resolve_dist_dir()
    if dist is None:
        return
    paths: list[str] = []
    try:
        for f in sorted((dist / "templates").glob("*.sway")):
            try:
                doc = json.loads(f.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            _collect_media_paths(doc, paths)
    except OSError:
        return
    # Only the STAGED templates above are trusted here. Saved projects under
    # _PROJECTS_DIR are written from a /project-save request body, so reading
    # them back to widen the allowlist would let a request grant itself access
    # to any folder — and would re-grant it on every /status after a restart.
    # media_access's contract is explicit: "Nothing a request body says can
    # widen the allowlist on its own; only a project the server actually
    # parsed can." A cockpit save names media the user already opened, which
    # is therefore already allowlisted, so nothing legitimate needs this.
    if paths:
        media_access.register_paths(paths)
        log.info("sway: registered %d template media path(s)", len(paths))
    _template_media_registered = True


@router.get("/status")
async def sway_status() -> dict:
    """Whether an embedded SwayCommand build is staged and mounted."""
    _register_template_media()
    return sidecar.status()


@router.get("/url")
async def sway_url() -> dict:
    """The URL for the SWAY tab's iframe, or a reason there is none.

    The URL is RELATIVE on purpose. An absolute http://localhost:8600/... works
    in the packaged desktop app and breaks everywhere else (Docker, a phone on
    the LAN, any reverse proxy). Relative also keeps the iframe same-origin
    with theDAW, which is load-bearing: a cross-origin hidden iframe is
    throttled to zero rAF callbacks by Chromium, which would freeze
    SwayCommand's transport clock the moment the user switched tabs.

    The trailing slash is required. Without it the document base becomes "/"
    and the cockpit's relative asset loads (its AudioWorklet in particular)
    resolve against theDAW's root and 404.
    """
    if not sidecar.static_mount_active():
        return {
            "url": None,
            "mode": "unavailable",
            "detail": (
                "No SwayCommand build is staged. Run 'npm run fetch:sway' in "
                "electron-ui/, or point "
                f"{sidecar.DIST_ENV} at a SwayCommand dist-embed directory, "
                "then restart the backend."
            ),
            "status": sidecar.status(),
        }
    _register_template_media()
    return {
        "url": f"{sidecar.STATIC_MOUNT_PATH}/",
        "mode": "static",
        "detail": None,
        "build": sidecar.read_build_stamp(),
    }


class SwayProjectSave(BaseModel):
    name: str
    doc: dict


@router.post("/project-save")
async def sway_project_save(req: SwayProjectSave) -> dict:
    """Persist a cockpit save as a real .sway file under data/sway-projects."""
    safe = re.sub(r"[^\w \-.]+", "", req.name).strip().strip(".") or "untitled"
    if not safe.lower().endswith(".sway"):
        safe += ".sway"
    _PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    target = (_PROJECTS_DIR / safe).resolve()
    if not str(target).startswith(str(_PROJECTS_DIR.resolve())):
        raise HTTPException(400, f"Invalid project name: {req.name}")
    try:
        target.write_text(json.dumps(req.doc, indent=2), encoding="utf-8")
    except OSError as e:
        raise HTTPException(500, f"Save failed: {e}")
    # Deliberately does NOT call media_access.register_paths(req.doc's media).
    # The server binds 0.0.0.0 with permissive CORS, so this body is
    # attacker-reachable; registering paths from it would turn a save into
    # "allowlist any folder on disk", and /clip-audio would then serve the
    # audio under it. The media a real cockpit save names was already
    # allowlisted when the user opened the project, so playback is unaffected.
    # If a path genuinely is not reachable, add it as a media root instead.
    return {"status": "ok", "path": str(target)}


@router.get("/projects")
async def sway_projects() -> dict:
    """List the .sway projects persisted by /project-save, newest first."""
    if not _PROJECTS_DIR.is_dir():
        return {"projects": []}
    rows: list[dict] = []
    for p in _PROJECTS_DIR.glob("*.sway"):
        try:
            rows.append({"name": p.stem, "path": str(p), "mtime": p.stat().st_mtime})
        except OSError:
            continue
    rows.sort(key=lambda r: r["mtime"], reverse=True)
    return {"projects": rows}
