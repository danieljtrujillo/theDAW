"""Download audio from a URL with yt-dlp and hand back an Opus file.

Strategy (highest quality, manageable size):
  * Grab the best available audio stream.
  * Run yt-dlp's ``FFmpegExtractAudio`` with ``preferredcodec='opus'``. When the
    source stream is *already* Opus (the YouTube default) ffmpeg stream-copies it
    — no re-encode, no generation loss, tiny files. Only a non-Opus source (e.g.
    AAC) is transcoded, at 192k (transparent).

Opus decodes natively in the browser (Web Audio ``decodeAudioData``) and via
ffmpeg-backed analysis, and the Media Bucket already accepts ``.opus`` — so the
imported file drops straight into the existing flows.
"""

from __future__ import annotations

import logging
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

log = logging.getLogger(__name__)


class YtImportError(Exception):
    """Raised when a URL can't be downloaded/extracted."""


@dataclass
class DownloadedAudio:
    path: Path
    tmpdir: Path
    title: str
    uploader: str
    duration: float
    ext: str


def _ffmpeg_dir() -> str | None:
    """Directory containing ffmpeg, if discoverable, so yt-dlp finds it even when
    PATH differs between the shell and the server process."""
    ff = shutil.which("ffmpeg")
    return str(Path(ff).parent) if ff else None


def download_audio(url: str) -> DownloadedAudio:
    """Download ``url`` to a fresh temp dir and return the produced Opus file.

    The caller owns ``DownloadedAudio.tmpdir`` and must remove it when done.
    """
    try:
        import yt_dlp
    except ImportError as e:  # pragma: no cover - depends on install state
        raise YtImportError(
            "yt-dlp is not installed on the backend. Run `uv sync` to install it."
        ) from e

    tmpdir = Path(tempfile.mkdtemp(prefix="ytimport_"))
    ydl_opts: dict = {
        "format": "bestaudio/best",
        "outtmpl": str(tmpdir / "%(title)s.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "restrictfilenames": True,
        "postprocessors": [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": "opus",
                # Ignored when the source is already Opus (ffmpeg copies the
                # stream). Only applies when transcoding a non-Opus source.
                "preferredquality": "192",
            }
        ],
    }
    ff_dir = _ffmpeg_dir()
    if ff_dir:
        ydl_opts["ffmpeg_location"] = ff_dir

    try:
        # cast: ydl_opts is an ordinary dict; YoutubeDL's params is a strict
        # TypedDict (_Params). We build it dynamically, so hand it over as Any.
        with yt_dlp.YoutubeDL(cast(Any, ydl_opts)) as ydl:
            info = ydl.extract_info(url, download=True)
    except Exception as e:
        shutil.rmtree(tmpdir, ignore_errors=True)
        raise YtImportError(str(e)) from e

    # A playlist URL (despite noplaylist) can yield an info dict with entries.
    # `.get` (not []) — "entries" is an optional TypedDict key.
    if isinstance(info, dict):
        entries = [e for e in (info.get("entries") or []) if e]
        if entries:
            info = entries[0]

    produced = sorted(tmpdir.glob("*.opus")) or [
        p for p in tmpdir.iterdir() if p.is_file()
    ]
    if not produced:
        shutil.rmtree(tmpdir, ignore_errors=True)
        raise YtImportError("download produced no audio file")

    path = produced[0]
    meta = info if isinstance(info, dict) else {}
    title = str(meta.get("title") or path.stem)
    uploader = str(
        meta.get("uploader") or meta.get("channel") or meta.get("uploader_id") or ""
    )
    try:
        duration = float(meta.get("duration") or 0.0)
    except (TypeError, ValueError):
        duration = 0.0

    return DownloadedAudio(
        path=path,
        tmpdir=tmpdir,
        title=title,
        uploader=uploader,
        duration=duration,
        ext=path.suffix.lstrip("."),
    )
