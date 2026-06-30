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


# --- Recent files tracking (simple in-memory list) ---
_recent_files: list[dict] = []
MAX_RECENT = 20


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
    formats (AIFF/CAF/…) are transcoded to WAV on the fly. Restricted to audio."""
    p = Path(path).expanduser()
    if not p.is_file():
        raise HTTPException(status_code=404, detail=f"Audio file not found: {path}")
    ext = p.suffix.lower()
    if ext not in _AUDIO_EXTS:
        raise HTTPException(status_code=400, detail=f"Not an audio file: {p.name}")

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
