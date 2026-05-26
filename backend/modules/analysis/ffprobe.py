"""Thin ``ffprobe -of json`` wrapper that returns format + stream metadata.

Returns the parsed JSON dict on success, or ``{}`` if ffprobe is missing
or the file can't be probed. Never raises — callers treat ffprobe data
as best-effort enrichment.
"""

from __future__ import annotations

import json
import logging
import shutil
import subprocess
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)


def has_ffprobe() -> bool:
    return shutil.which("ffprobe") is not None


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
          "duration_sec": 30.5,
          "codec": "pcm_s16le",
          "container": "wav",
          "bit_rate_kbps": null
        }
      }
    """
    if not has_ffprobe():
        return {}
    p = Path(path)
    if not p.is_file():
        return {}
    try:
        result = subprocess.run(
            [
                "ffprobe",
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
            timeout=timeout_sec,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as e:
        log.info("analysis.ffprobe: probe failed for %s: %s", p.name, e)
        return {}
    if result.returncode != 0:
        log.info(
            "analysis.ffprobe: ffprobe returned %d for %s: %s",
            result.returncode,
            p.name,
            result.stderr.strip()[:200],
        )
        return {}
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError:
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

    return {
        "sample_rate": _to_int(audio_stream.get("sample_rate")),
        "channels": _to_int(audio_stream.get("channels")),
        "bit_depth": _to_int(audio_stream.get("bits_per_sample"))
        or _to_int(audio_stream.get("bits_per_raw_sample")),
        "duration_sec": _to_float(fmt.get("duration"))
        or _to_float(audio_stream.get("duration")),
        "codec": audio_stream.get("codec_name"),
        "container": fmt.get("format_name"),
        "bit_rate_kbps": (bit_rate // 1000) if bit_rate else None,
    }
