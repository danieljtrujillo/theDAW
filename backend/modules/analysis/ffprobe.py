"""Thin ``ffprobe -of json`` wrapper that returns format + stream metadata.

Returns the parsed JSON dict on success, or ``{}`` if ffprobe is missing
or the file can't be probed. Never raises — callers treat ffprobe data
as best-effort enrichment.

ffprobe writes its JSON as UTF-8, so the run names that encoding. Without it
CPython decodes the child's bytes with the Windows ANSI codepage and one byte
outside cp1252 — a title tag, an artist name, a path — raises UnicodeDecodeError
inside ``subprocess.run``, which is a ValueError and so escaped the except below
and reached the request as a 500.
"""

from __future__ import annotations

import json
import logging
import subprocess
from pathlib import Path
from typing import Any

from backend.lib import ffmpeg_tools
from backend.lib.launch_token import child_env

log = logging.getLogger(__name__)


def has_ffprobe() -> bool:
    """Whether an ffprobe exists: the one from the build
    ``backend.lib.ffmpeg_tools`` chose, else the first on PATH."""
    return ffmpeg_tools.find_ffprobe() is not None


def probe_file(path: Path, timeout_sec: float = 20.0) -> dict[str, Any]:
    """Run ffprobe and return parsed metadata.

    Output shape (subset we surface):
      {
        "format": {"format_name": "wav", "duration": "30.5", "size": "...", "bit_rate": "..."},
        "streams": [{"codec_type": "audio", "codec_name": "pcm_s16le",
                     "sample_rate": "44100", "channels": 2, "bits_per_sample": 16,
                     "duration": "30.5", ...}],
        "_summary": {                  (we add this for convenience)
          "sample_rate": 44100,
          "channels": 2,
          "bit_depth": 16,
          "bit_depth_is_float": false,
          "sample_fmt": "s16",
          "duration_sec": 30.5,
          "codec": "pcm_s16le",
          "container": "wav",
          "bit_rate_kbps": null
        }
      }
    """
    ffprobe = ffmpeg_tools.find_ffprobe()
    if ffprobe is None:
        return {}
    p = Path(path)
    if not p.is_file():
        return {}
    try:
        result = subprocess.run(
            [
                ffprobe,
                "-v",
                "error",
                "-of",
                "json",
                "-show_format",
                "-show_streams",
                str(p),
            ],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_sec,
            stdin=subprocess.DEVNULL,
            env=child_env(),
        )
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError, ValueError) as e:
        log.info("analysis.ffprobe: probe failed for %s: %s", p.name, e)
        return {}
    if result.returncode != 0:
        log.info(
            "analysis.ffprobe: ffprobe returned %d for %s: %s",
            result.returncode,
            p.name,
            (result.stderr or "").strip()[:200],
        )
        return {}
    # A zero exit with nothing on stdout is a probe that produced no metadata.
    # json.loads on that raised TypeError, which no caller expects from a
    # function documented never to raise.
    if not result.stdout:
        log.info("analysis.ffprobe: ffprobe printed no metadata for %s", p.name)
        return {}
    try:
        payload = json.loads(result.stdout)
    except (ValueError, TypeError):
        log.info("analysis.ffprobe: ffprobe printed unreadable metadata for %s", p.name)
        return {}
    if not isinstance(payload, dict):
        return {}

    payload["_summary"] = _summarize(payload)
    return payload


def _summarize(payload: dict[str, Any]) -> dict[str, Any]:
    """Extract the fields callers most often want."""
    fmt = payload.get("format") or {}
    streams = payload.get("streams") or []
    audio_stream: dict[str, Any] = {}
    for s in streams:
        if s.get("codec_type") == "audio":
            audio_stream = s
            break

    def _to_int(v: Any) -> int | None:
        try:
            return int(v)
        except (TypeError, ValueError):
            return None

    def _to_float(v: Any) -> float | None:
        try:
            return float(v)
        except (TypeError, ValueError):
            return None

    bit_rate = _to_int(fmt.get("bit_rate"))
    # bits_per_sample reads 32 for pcm_s32le and pcm_f32le alike, so the number
    # on its own cannot answer "is this a float file". sample_fmt can: ffmpeg
    # names float planes 'flt'/'fltp' and doubles 'dbl'/'dblp'. It is only
    # meaningful next to a real word length, though — every lossy decoder also
    # reports 'fltp', and an MP3 is not a float file.
    sample_fmt = str(audio_stream.get("sample_fmt") or "")
    bit_depth = _to_int(audio_stream.get("bits_per_sample")) or _to_int(
        audio_stream.get("bits_per_raw_sample")
    )

    return {
        "sample_rate": _to_int(audio_stream.get("sample_rate")),
        "channels": _to_int(audio_stream.get("channels")),
        "bit_depth": bit_depth,
        "bit_depth_is_float": bool(bit_depth) and sample_fmt.startswith(("flt", "dbl")),
        "sample_fmt": sample_fmt or None,
        "duration_sec": _to_float(fmt.get("duration"))
        or _to_float(audio_stream.get("duration")),
        "codec": audio_stream.get("codec_name"),
        "container": fmt.get("format_name"),
        "bit_rate_kbps": (bit_rate // 1000) if bit_rate else None,
    }
