"""FastAPI router for .tasmo project save/load (/api/project/*)."""

from __future__ import annotations
import hashlib
import json
import logging
import mimetypes
import tempfile
from pathlib import Path
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from backend.modules.project import media_access
from backend.modules.project.tasmo_project import TasmoProject
from backend.modules.project.tasmo_file import TasmoFile

log = logging.getLogger(__name__)
router = APIRouter()

# Formats the browser (Electron/Chromium) decodes natively — served as-is.
_BROWSER_OK_EXTS = {
    ".wav",
    ".wave",
    ".flac",
    ".mp3",
    ".ogg",
    ".oga",
    ".m4a",
    ".aac",
    ".opus",
    ".webm",
    ".weba",
}
# Formats Chromium can't reliably decode (DAW-native sample formats) — these are
# transcoded to WAV on the fly so an imported project still plays.
_TRANSCODE_EXTS = {
    ".aif",
    ".aiff",
    ".aifc",
    ".caf",
    ".wv",
    ".wma",
}
# The endpoint only serves recognized audio (keeps it from being a general file
# reader). The union of what we serve directly and what we transcode.
_AUDIO_EXTS = _BROWSER_OK_EXTS | _TRANSCODE_EXTS


# --- Recent files tracking (in-memory, mirrored to disk so it survives restarts) ---
_RECENT_PATH = Path(__file__).resolve().parents[3] / "data" / "recent_projects.json"
MAX_RECENT = 20


def _load_recent() -> list[dict]:
    """Read the persisted recent list, dropping malformed entries. Any failure
    yields an empty list because recent-project history is a convenience and
    must never block module import or server startup."""
    try:
        raw = json.loads(_RECENT_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    if not isinstance(raw, list):
        return []
    entries: list[dict] = []
    for item in raw:
        if (
            isinstance(item, dict)
            and isinstance(item.get("path"), str)
            and isinstance(item.get("name"), str)
        ):
            entries.append({"path": item["path"], "name": item["name"]})
    return entries[:MAX_RECENT]


_recent_files: list[dict] = _load_recent()

# Projects opened before this process started still have their folders in the
# recent list; seeding from it keeps their clips playable when the UI restores
# a session from its own storage without re-issuing /load.
media_access.register_paths(r["path"] for r in _recent_files)


def _register_project_media(project: TasmoProject, *paths: str) -> None:
    """Grant /clip-audio the folders an opened project draws from.

    Opening a project is the user's consent for the files it names, so each
    clip's linked folder joins the allowlist. In-archive relative refs
    (``audio/kick.wav``) are ignored by register_paths."""
    media_access.register_paths(
        [
            *paths,
            *(
                clip.audio_file
                for track in project.tracks
                for clip in track.clips
                if clip.audio_file
            ),
        ]
    )


class SaveRequest(BaseModel):
    project: dict  # TasmoProject as JSON dict
    path: str  # Where to save the .tasmo file
    embed_audio: bool = False  # If True, bundle audio; if False, link


class LoadRequest(BaseModel):
    path: str  # Path to the .tasmo file to open


class ExportAudioRequest(BaseModel):
    path: str  # Path to the .tasmo file
    output_dir: str  # Directory to extract embedded audio into


class LoadResponse(BaseModel):
    project: dict
    manifest: dict


@router.post("/save")
def save_project(req: SaveRequest):
    """Serialize current session → .tasmo file."""
    try:
        project = TasmoProject.model_validate(req.project)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid project data: {e}")

    # Auto-append .tasmo extension
    path = req.path
    if not path.endswith(".tasmo"):
        path += ".tasmo"

    # Create the destination folder if needed (e.g. a fresh default projects dir
    # the user never created by hand).
    try:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass

    try:
        manifest = TasmoFile.save(project, path, embed_audio=req.embed_audio)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save .tasmo: {e}")

    # Track in recent files
    _add_recent(path, project.project_name)
    _register_project_media(project, path)
    return {"status": "saved", "path": path, "manifest": manifest}


@router.post("/save-session")
async def save_session(
    project: str = Form(...),
    path: str = Form(...),
    files: list[UploadFile] = File(default=[]),
):
    """Save the LIVE session (the EDIT timeline) to a .tasmo, embedding each
    clip's audio bytes uploaded alongside the project JSON.

    The plain ``/save`` endpoint only links files already on disk, which cannot
    capture in-browser editor clips (their audio lives in memory). This accepts
    the project JSON plus one upload per clip — each clip's ``audio_file`` points
    at ``audio/<filename>`` and the matching upload is written into the archive."""
    try:
        project_data = json.loads(project)
        tasmo = TasmoProject.model_validate(project_data)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid project data: {e}")

    audio_files: dict[str, bytes] = {}
    for f in files:
        name = Path(f.filename or "").name
        if not name:
            continue
        audio_files[name] = await f.read()

    out_path = path if path.endswith(".tasmo") else path + ".tasmo"
    try:
        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass

    try:
        manifest = TasmoFile.save(tasmo, out_path, audio_files=audio_files or None)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save .tasmo: {e}")

    _add_recent(out_path, tasmo.project_name)
    _register_project_media(tasmo, out_path)
    return {"status": "saved", "path": out_path, "manifest": manifest}


@router.post("/load", response_model=LoadResponse)
def load_project(req: LoadRequest):
    """Deserialize .tasmo → restore session state."""
    try:
        project, manifest = TasmoFile.load(req.path)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load .tasmo: {e}")

    _add_recent(req.path, project.project_name)
    _register_project_media(project, req.path)
    return LoadResponse(project=project.model_dump(), manifest=manifest)


@router.get("/info")
def project_info(path: str):
    """Read manifest from .tasmo without full project load."""
    try:
        return TasmoFile.info(path)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/recent")
def recent_projects():
    """List recently opened/saved projects."""
    return _recent_files


@router.get("/default-dir")
def default_projects_dir():
    """Suggested default folder for .tasmo saves (created on first save). The
    frontend persists the user's override; this is just the out-of-box default."""
    return {"path": str(Path.home() / "Documents" / "theDAW Projects")}


def _transcode_cache_dir() -> Path:
    d = Path(tempfile.gettempdir()) / "thedaw_transcode"
    d.mkdir(parents=True, exist_ok=True)
    return d


async def _transcode_to_wav(src: Path) -> Path:
    """Transcode a DAW-native sample (AIFF, CAF, …) to WAV the browser can decode.
    Cached by source path + mtime + size so re-opening a project is instant."""
    from backend.lib import ffmpeg

    stat = src.stat()
    key = hashlib.sha1(
        f"{src.resolve()}|{stat.st_mtime_ns}|{stat.st_size}".encode("utf-8")
    ).hexdigest()
    out = _transcode_cache_dir() / f"{key}.wav"
    if out.is_file() and out.stat().st_size > 0:
        return out
    await ffmpeg.render(src, out, filter_args=[], extra_out_args=["-c:a", "pcm_s16le"])
    return out


@router.get("/clip-audio")
async def clip_audio(path: str):
    """Stream a clip's on-disk audio so the browser can load it when a project
    is opened. ``.tasmo`` clips reference linked files by absolute path (or files
    extracted from an embedded archive); the frontend cannot read those directly,
    so it fetches them here. Browser-native formats are served as-is; DAW-native
    formats (AIFF/CAF/…) are transcoded to WAV on the fly. Restricted to audio
    inside theDAW's media roots (see media_access) because the server binds
    0.0.0.0 and this route would otherwise read any file on the machine."""
    p = media_access.resolve_media_path(path)
    if p is None:
        # Answered before any existence check, and identically for "outside the
        # roots" and "unparseable", so the route reveals nothing about the
        # filesystem to a caller that is not entitled to it.
        raise HTTPException(
            status_code=403, detail="Path is outside theDAW media roots"
        )
    ext = p.suffix.lower()
    if ext not in _AUDIO_EXTS:
        raise HTTPException(status_code=400, detail=f"Not an audio file: {p.name}")
    if not p.is_file():
        raise HTTPException(status_code=404, detail="Audio file not found")

    if ext in _TRANSCODE_EXTS:
        try:
            wav = await _transcode_to_wav(p)
            return FileResponse(
                str(wav), media_type="audio/wav", filename=f"{p.stem}.wav"
            )
        except Exception as e:
            # Fall back to serving the original; the browser may still decode it.
            log.warning("clip-audio transcode failed for %s: %s", p.name, e)

    media_type, _ = mimetypes.guess_type(str(p))
    return FileResponse(
        str(p),
        media_type=media_type or "application/octet-stream",
        filename=p.name,
    )


@router.post("/export/audio")
def export_audio(req: ExportAudioRequest):
    """Extract embedded audio files from .tasmo to disk."""
    try:
        extracted = TasmoFile.extract_audio(req.path, req.output_dir)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to extract audio: {e}")
    # The user picked this destination, so its files are theirs to play back.
    media_access.register_paths(extracted)
    return {"extracted": extracted, "count": len(extracted)}


@router.get("/list-audio")
def list_audio(path: str):
    """List embedded audio file names inside a .tasmo."""
    try:
        return {"files": TasmoFile.list_audio(path)}
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


def _add_recent(path: str, name: str) -> None:
    """Add to recent files list (deduped, most recent first)."""
    global _recent_files
    entry = {"path": path, "name": name}
    _recent_files = [r for r in _recent_files if r["path"] != path]
    _recent_files.insert(0, entry)
    _recent_files = _recent_files[:MAX_RECENT]
    # Best-effort persistence: recent-list IO must never fail a save/load request.
    try:
        _RECENT_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = _RECENT_PATH.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(_recent_files, indent=2), encoding="utf-8")
        tmp.replace(_RECENT_PATH)
    except OSError as e:
        log.warning("project.recent: failed to persist %s: %s", _RECENT_PATH, e)
