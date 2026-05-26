"""Pitch-preserving time-stretch via ffmpeg.

Primary engine: librubberband (frequency-domain, higher quality).
Fallback: atempo (built-in to every ffmpeg build, slightly lower quality).

The fallback path returns engine="atempo" in the result so the caller can
surface a warning to the user.
"""

from __future__ import annotations

import logging
import subprocess
from pathlib import Path
from typing import Optional, TypedDict

from .config import probe

log = logging.getLogger(__name__)


RATIO_MIN = 0.5
RATIO_MAX = 2.0


class StretchResult(TypedDict):
    output_path: str
    ratio_used: float
    engine: str
    clamped: bool
    note: Optional[str]


def normalize_to_target(
    input_path: str | Path,
    output_path: str | Path,
    target_sr: int = 44100,
    target_channels: int = 2,
    timeout_sec: float = 30.0,
) -> str:
    """Decode arbitrary audio (mp3/m4a/wav/flac/ogg) to WAV at a fixed sr/channel count."""
    cmd = [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(input_path),
        "-ac",
        str(target_channels),
        "-ar",
        str(target_sr),
        "-f",
        "wav",
        str(output_path),
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_sec)
    except subprocess.TimeoutExpired as e:
        raise RuntimeError(f"ffmpeg normalize timed out after {timeout_sec}s") from e
    if proc.returncode != 0:
        raise RuntimeError(
            f"ffmpeg normalize failed (rc={proc.returncode}): {(proc.stderr or '')[:500]}"
        )
    return str(output_path)


def _build_rubberband_cmd(input_path: str, output_path: str, ratio: float) -> list[str]:
    return [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        input_path,
        "-af",
        f"rubberband=tempo={ratio:.6f}:pitchq=quality",
        output_path,
    ]


def _build_atempo_cmd(input_path: str, output_path: str, ratio: float) -> list[str]:
    return [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        input_path,
        "-af",
        f"atempo={ratio:.6f}",
        output_path,
    ]


def stretch_audio(
    input_path: str | Path,
    output_path: str | Path,
    ratio: float,
    timeout_sec: float = 60.0,
    force_engine: Optional[str] = None,
) -> StretchResult:
    """Stretch input audio by `ratio` (output_duration = input_duration / ratio).

    ratio < 1.0 -> slower (longer output).
    ratio > 1.0 -> faster (shorter output).
    ratio == 1.0 still runs through ffmpeg (a no-op stretch) so caller gets a
    consistent normalized output file.

    `force_engine` ∈ {"rubberband", "atempo", None}. Used by tests; production
    callers should leave it None.
    """

    in_str = str(input_path)
    out_str = str(output_path)

    clamped = False
    if ratio < RATIO_MIN:
        clamped = True
        ratio = RATIO_MIN
    elif ratio > RATIO_MAX:
        clamped = True
        ratio = RATIO_MAX

    use_rubberband: bool
    if force_engine == "rubberband":
        use_rubberband = True
    elif force_engine == "atempo":
        use_rubberband = False
    else:
        tools = probe()
        use_rubberband = bool(tools["ffmpeg"] and tools["librubberband"])

    note: Optional[str] = None

    if use_rubberband:
        cmd = _build_rubberband_cmd(in_str, out_str, ratio)
        try:
            proc = subprocess.run(
                cmd, capture_output=True, text=True, timeout=timeout_sec
            )
        except subprocess.TimeoutExpired as e:
            raise RuntimeError(
                f"ffmpeg rubberband timed out after {timeout_sec}s"
            ) from e

        if proc.returncode == 0:
            return {
                "output_path": out_str,
                "ratio_used": ratio,
                "engine": "rubberband",
                "clamped": clamped,
                "note": "ratio clamped to safe range" if clamped else None,
            }
        log.warning(
            "rubberband failed (rc=%s), falling back to atempo. stderr: %s",
            proc.returncode,
            (proc.stderr or "")[:500],
        )
        note = "rubberband filter failed; fell back to atempo"

    cmd = _build_atempo_cmd(in_str, out_str, ratio)
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_sec)
    except subprocess.TimeoutExpired as e:
        raise RuntimeError(f"ffmpeg atempo timed out after {timeout_sec}s") from e

    if proc.returncode != 0:
        raise RuntimeError(
            f"ffmpeg atempo failed (rc={proc.returncode}): {(proc.stderr or '')[:500]}"
        )

    return {
        "output_path": out_str,
        "ratio_used": ratio,
        "engine": "atempo",
        "clamped": clamped,
        "note": note or ("ratio clamped to safe range" if clamped else None),
    }
