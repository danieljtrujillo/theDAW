"""FastAPI router for the ytimport module.

Endpoints (prefix from module.json -> ``/api/ytimport``):

    GET  /          capability report (yt-dlp + ffmpeg present?)
    POST /fetch     download audio from a URL and stream the Opus bytes back,
                    with metadata in ``X-*`` headers. Cleans up its temp dir.
"""

from __future__ import annotations

import asyncio
import logging
import shutil
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel

from .engine import YtImportError, download_audio

log = logging.getLogger(__name__)


router = APIRouter()


class FetchRequest(BaseModel):
    url: str


@router.get("")
@router.get("/")
def get_capabilities() -> dict:
    try:
        import yt_dlp  # noqa: F401

        have_ytdlp = True
    except ImportError:
        have_ytdlp = False
    return {
        "ok": have_ytdlp,
        "yt_dlp": have_ytdlp,
        "ffmpeg": bool(shutil.which("ffmpeg")),
        "codec": "opus",
    }


@router.post("/fetch")
async def fetch(req: FetchRequest) -> Response:
    url = (req.url or "").strip()
    if not url:
        raise HTTPException(400, "no url provided")
    if "open.spotify.com" in url or url.startswith("spotify:"):
        raise HTTPException(
            400,
            "Spotify streams are DRM-protected and can't be downloaded. "
            "Paste a YouTube, SoundCloud, or Bandcamp link instead.",
        )
    if not (url.startswith("http://") or url.startswith("https://")):
        raise HTTPException(400, "url must start with http:// or https://")

    # Hold the idle gate so background workers (analysis) don't compete with the
    # download/transcode, mirroring the other foreground module endpoints.
    try:
        from backend.core.idle import get_idle_manager

        get_idle_manager().bump_activity(tag="ytimport")
    except Exception:
        pass

    try:
        try:
            dl = await asyncio.to_thread(download_audio, url)
        except YtImportError as e:
            raise HTTPException(502, f"download failed: {e}")

        try:
            data = dl.path.read_bytes()
        finally:
            shutil.rmtree(dl.tmpdir, ignore_errors=True)
    finally:
        try:
            from backend.core.idle import get_idle_manager

            get_idle_manager().release("ytimport")
        except Exception:
            pass

    filename = f"{dl.title}.{dl.ext}"
    media_type = "audio/ogg" if dl.ext == "opus" else "application/octet-stream"
    headers = {
        "Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}",
        "X-Title": quote(dl.title),
        "X-Uploader": quote(dl.uploader),
        "X-Duration": str(dl.duration),
        "X-Filename": quote(filename),
    }
    log.info("ytimport: fetched %r (%d bytes) from %s", dl.title, len(data), url)
    return Response(content=data, media_type=media_type, headers=headers)
