"""Media (video / image) probing and thumbnailing for the library.

Audio entries are the library's original citizens; this module adds the
support code for the ``kind='video'`` and ``kind='image'`` entries that
back the VJ video library and overlay system.

Everything here degrades gracefully: when ffprobe/ffmpeg are missing, an
import still succeeds with unknown dimensions and no thumbnail rather
than failing. Image probing prefers Pillow (a hard dependency) and falls
back to ffprobe; video probing uses ffprobe + ffmpeg.

Alpha detection matters for overlays — a transparent PNG/WebP or a
VP9/WebM with an alpha plane can composite over the base visuals, while
an opaque MP4 cannot. ``has_alpha`` is surfaced so the UI can mark
overlay-capable media.
"""

from __future__ import annotations

import json
import logging
import shutil
import subprocess
from pathlib import Path
from typing import Any, Optional

log = logging.getLogger(__name__)


# Container extensions we accept on the media import path. Kept permissive
# on input; the browser/Chrome decides what it can actually play back.
VIDEO_EXTS: frozenset[str] = frozenset(
    {".mp4", ".webm", ".mov", ".mkv", ".m4v", ".avi", ".ogv"}
)
IMAGE_EXTS: frozenset[str] = frozenset(
    {".png", ".webp", ".gif", ".jpg", ".jpeg", ".bmp", ".avif", ".apng"}
)

# ffmpeg pixel formats that carry an alpha plane. VP9/WebM transparency
# decodes to yuva*; PNG/WebP transparency to rgba/bgra/etc.
_ALPHA_PIX_FMTS: frozenset[str] = frozenset(
    {
        "yuva420p",
        "yuva422p",
        "yuva444p",
        "yuva420p10le",
        "yuva422p10le",
        "yuva444p10le",
        "rgba",
        "bgra",
        "argb",
        "abgr",
        "ya8",
        "ya16",
        "gbrap",
        "gbrap10le",
        "gbrap12le",
        "pal8",  # palette can carry a transparent index (e.g. GIF)
    }
)

_THUMB_MAX_W = 480
# Background a flattened image thumbnail is composited onto. Matches the
# app's near-black panel tone so transparent art reads correctly.
_THUMB_BG = (11, 10, 18)


def classify_ext(filename: str) -> Optional[str]:
    """Return 'video' | 'image' for a recognized media filename, else None."""
    ext = Path(filename).suffix.lower()
    if ext in VIDEO_EXTS:
        return "video"
    if ext in IMAGE_EXTS:
        return "image"
    return None


def find_ffmpeg() -> Optional[str]:
    return shutil.which("ffmpeg")


def find_ffprobe() -> Optional[str]:
    return shutil.which("ffprobe")


def _run(cmd: list[str], timeout: float = 30.0) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(cmd, capture_output=True, timeout=timeout, shell=False)


def _probe_with_ffprobe(path: Path) -> dict[str, Any]:
    """ffprobe the first video/image stream. Returns {} on any failure."""
    ffprobe = find_ffprobe()
    if ffprobe is None:
        return {}
    cmd = [
        ffprobe,
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height,pix_fmt,codec_name,nb_frames",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        str(path),
    ]
    try:
        proc = _run(cmd)
        if proc.returncode != 0:
            return {}
        data = json.loads(proc.stdout.decode("utf-8", "replace") or "{}")
    except (subprocess.SubprocessError, json.JSONDecodeError, OSError) as e:
        log.debug("media.probe: ffprobe failed for %s: %s", path, e)
        return {}
    streams = data.get("streams") or []
    stream = streams[0] if streams else {}
    fmt = data.get("format") or {}
    duration = None
    try:
        duration = float(fmt.get("duration")) if fmt.get("duration") else None
    except (TypeError, ValueError):
        duration = None
    pix_fmt = str(stream.get("pix_fmt") or "")
    return {
        "width": _int_or_none(stream.get("width")),
        "height": _int_or_none(stream.get("height")),
        "pix_fmt": pix_fmt,
        "codec": str(stream.get("codec_name") or ""),
        "duration": duration,
        "has_alpha": pix_fmt in _ALPHA_PIX_FMTS,
    }


def _int_or_none(v: Any) -> Optional[int]:
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _probe_image_with_pillow(path: Path) -> dict[str, Any]:
    """Pillow image probe (dimensions + alpha). Returns {} on failure."""
    try:
        from PIL import Image
    except ImportError:
        return {}
    try:
        with Image.open(path) as im:
            width, height = im.size
            has_alpha = im.mode in ("RGBA", "LA", "PA") or ("transparency" in im.info)
            return {
                "width": int(width),
                "height": int(height),
                "has_alpha": bool(has_alpha),
                "duration": None,
            }
    except Exception as e:  # noqa: BLE001 — Pillow raises many image-specific errors
        log.debug("media.probe: Pillow failed for %s: %s", path, e)
        return {}


def probe_media(path: Path, kind: str) -> dict[str, Any]:
    """Probe a media file for width/height/duration/has_alpha.

    Always returns a dict with those four keys (values may be None /
    False when the tool chain can't read the file). Never raises.
    """
    base = {"width": None, "height": None, "duration": None, "has_alpha": False}
    if kind == "image":
        info = _probe_image_with_pillow(path)
        if not info:
            info = _probe_with_ffprobe(path)
    else:
        info = _probe_with_ffprobe(path)
    base.update({k: info.get(k, base[k]) for k in base})
    return base


def make_thumbnail(path: Path, kind: str, out_path: Path) -> bool:
    """Write a small poster JPEG for ``path`` to ``out_path``.

    Returns True on success. Best-effort: a missing tool chain or an
    undecodable file just yields False and the UI falls back to a
    placeholder.
    """
    try:
        if kind == "image":
            return _thumb_image(path, out_path)
        return _thumb_video(path, out_path)
    except Exception as e:  # noqa: BLE001 — never let a thumbnail break an import
        log.debug("media.thumb: failed for %s: %s", path, e)
        return False


def _thumb_image(path: Path, out_path: Path) -> bool:
    try:
        from PIL import Image
    except ImportError:
        return _thumb_video(path, out_path)  # ffmpeg can still poster an image
    try:
        with Image.open(path) as im:
            im = im.convert("RGBA")
            im.thumbnail((_THUMB_MAX_W, _THUMB_MAX_W * 4))
            bg = Image.new("RGB", im.size, _THUMB_BG)
            bg.paste(im, mask=im.split()[-1])
            bg.save(out_path, "JPEG", quality=82)
        return out_path.is_file()
    except Exception as e:  # noqa: BLE001
        log.debug("media.thumb: Pillow image thumb failed for %s: %s", path, e)
        return False


def _thumb_video(path: Path, out_path: Path) -> bool:
    ffmpeg = find_ffmpeg()
    if ffmpeg is None:
        return False
    # Seek to ~1s (clamped by the file itself; -ss before -i is a fast
    # keyframe seek). One frame, scaled to a max width, JPEG out.
    cmd = [
        ffmpeg,
        "-y",
        "-ss",
        "1",
        "-i",
        str(path),
        "-frames:v",
        "1",
        "-vf",
        f"scale={_THUMB_MAX_W}:-2:force_original_aspect_ratio=decrease",
        "-q:v",
        "4",
        str(out_path),
    ]
    try:
        proc = _run(cmd, timeout=30.0)
    except subprocess.SubprocessError as e:
        log.debug("media.thumb: ffmpeg video thumb failed for %s: %s", path, e)
        return False
    if proc.returncode != 0 or not out_path.is_file():
        # Some very short clips have no frame at 1s — retry from the start.
        cmd[cmd.index("1")] = "0"
        try:
            proc = _run(cmd, timeout=30.0)
        except subprocess.SubprocessError:
            return False
    return out_path.is_file()
