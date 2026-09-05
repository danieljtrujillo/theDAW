"""Pitch-preserving time-stretch via ffmpeg.

Primary engine: librubberband (frequency-domain, higher quality).
Fallback: atempo (built-in to every ffmpeg build, slightly lower quality).

The fallback path returns engine="atempo" in the result so the caller can
surface a warning to the user.

Every ffmpeg spawn here runs with `-nostdin` AND `stdin=DEVNULL`. The backend
does not always own a real console: under launcher hosts (Pinokio's ConPTY
shells, service wrappers) an inherited stdin handle makes ffmpeg's console
input reader block forever, which presents as "atempo timed out" on a job
that takes under a second in a terminal.
"""

from __future__ import annotations

import logging
import subprocess
from pathlib import Path
from typing import Optional, TypedDict

import numpy as np

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
    # v2 additions (always present):
    filter: str  # the exact ``-af`` string handed to ffmpeg
    pitch_semitones_used: float  # 0.0 whenever the atempo engine ran
    span_used: Optional[tuple[float, float]]  # SOURCE seconds, None = whole file


# ffmpeg ``rubberband`` filter enum options that callers may set through
# ``rb_options``. Keys and values mirror ``ffmpeg -h filter=rubberband``.
RB_OPTION_VALUES: dict[str, tuple[str, ...]] = {
    "transients": ("crisp", "mixed", "smooth"),
    "detector": ("compound", "percussive", "soft"),
    "phase": ("laminar", "independent"),
    "window": ("standard", "short", "long"),
    "smoothing": ("off", "on"),
    "formant": ("shifted", "preserved"),
}


def _validate_rb_options(rb_options: Optional[dict[str, str]]) -> list[tuple[str, str]]:
    """Return ``rb_options`` as ``(key, value)`` pairs in sorted key order.

    Raises ``ValueError`` on an unknown key or a value that is not one of the
    ffmpeg enum names for that key.
    """
    if not rb_options:
        return []
    pairs: list[tuple[str, str]] = []
    for key in sorted(rb_options):
        allowed = RB_OPTION_VALUES.get(key)
        if allowed is None:
            raise ValueError(
                f"unknown rubberband option {key!r}; allowed: {sorted(RB_OPTION_VALUES)}"
            )
        value = str(rb_options[key])
        if value not in allowed:
            raise ValueError(
                f"invalid value {value!r} for rubberband option {key!r}; "
                f"allowed: {list(allowed)}"
            )
        pairs.append((key, value))
    return pairs


def _span_args(span: Optional[tuple[float, float]]) -> list[str]:
    """``-ss/-t`` input options for a SOURCE-seconds window (empty when None).

    Emitted BEFORE ``-i``: on WAV input the fast seek is sample-exact.
    """
    if span is None:
        return []
    start, end = float(span[0]), float(span[1])
    start = max(0.0, start)
    length = end - start
    if length <= 0:
        raise ValueError(f"span must satisfy end > start, got {span!r}")
    return ["-ss", f"{start:.6f}", "-t", f"{length:.6f}"]


def _rubberband_filter(
    ratio: float,
    pitch_semitones: float = 0.0,
    rb_options: Optional[dict[str, str]] = None,
) -> str:
    """Build the ``rubberband=...`` filter string.

    With ``pitch_semitones == 0`` and ``rb_options is None`` this is
    byte-identical to the v1 string (``rubberband=tempo=X:pitchq=quality``).
    """
    parts = [f"rubberband=tempo={ratio:.6f}"]
    if pitch_semitones != 0.0:
        parts.append(f"pitch={2 ** (pitch_semitones / 12):.6f}")
    parts.append("pitchq=quality")
    if rb_options is not None or pitch_semitones != 0.0:
        parts.append("channels=together")
    for key, value in _validate_rb_options(rb_options):
        parts.append(f"{key}={value}")
    return ":".join(parts)


def normalize_to_target(
    input_path: str | Path,
    output_path: str | Path,
    target_sr: int = 44100,
    target_channels: int = 2,
    timeout_sec: float = 120.0,
) -> str:
    """Decode arbitrary audio (mp3/m4a/wav/flac/ogg) to WAV at a fixed sr/channel count."""
    cmd = [
        "ffmpeg",
        "-nostdin",
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
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout_sec,
            stdin=subprocess.DEVNULL,
        )
    except subprocess.TimeoutExpired as e:
        raise RuntimeError(f"ffmpeg normalize timed out after {timeout_sec}s") from e
    if proc.returncode != 0:
        raise RuntimeError(
            f"ffmpeg normalize failed (rc={proc.returncode}): {(proc.stderr or '')[:500]}"
        )
    return str(output_path)


def _build_rubberband_cmd(
    input_path: str,
    output_path: str,
    ratio: float,
    pitch_semitones: float = 0.0,
    rb_options: Optional[dict[str, str]] = None,
    span: Optional[tuple[float, float]] = None,
) -> list[str]:
    return [
        "ffmpeg",
        "-nostdin",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        *_span_args(span),
        "-i",
        input_path,
        "-af",
        _rubberband_filter(ratio, pitch_semitones, rb_options),
        output_path,
    ]


def _build_atempo_cmd(
    input_path: str,
    output_path: str,
    ratio: float,
    span: Optional[tuple[float, float]] = None,
) -> list[str]:
    return [
        "ffmpeg",
        "-nostdin",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        *_span_args(span),
        "-i",
        input_path,
        "-af",
        f"atempo={ratio:.6f}",
        output_path,
    ]


def read_stretched(path: str | Path) -> tuple[np.ndarray, int]:
    """Read a rendered WAV as float32 ``(frames, channels)`` plus its sample rate."""
    import soundfile as sf

    audio, sr = sf.read(str(path), dtype="float32", always_2d=True)
    return np.ascontiguousarray(audio, dtype=np.float32), int(sr)


def stretch_audio(
    input_path: str | Path,
    output_path: str | Path,
    ratio: float,
    timeout_sec: float = 180.0,
    force_engine: Optional[str] = None,
    *,
    pitch_semitones: float = 0.0,
    rb_options: Optional[dict[str, str]] = None,
    span: Optional[tuple[float, float]] = None,
) -> StretchResult:
    """Stretch input audio by `ratio` (output_duration = input_duration / ratio).

    ratio < 1.0 -> slower (longer output).
    ratio > 1.0 -> faster (shorter output).
    ratio == 1.0 still runs through ffmpeg (a no-op stretch) so caller gets a
    consistent normalized output file.

    `force_engine` ∈ {"rubberband", "atempo", None}. Used by tests; production
    callers should leave it None.

    Keyword-only v2 options (defaults reproduce the v1 command byte-for-byte):
    - `pitch_semitones`: pitch shift applied by rubberband (atempo cannot
      shift pitch; the result then carries `pitch_semitones_used == 0.0` and
      a note).
    - `rb_options`: extra rubberband enum options (see `RB_OPTION_VALUES`);
      unknown keys / values raise `ValueError` before ffmpeg is spawned.
    - `span`: `(start_sec, end_sec)` window in SOURCE seconds; only that
      window is decoded and stretched.
    """

    in_str = str(input_path)
    out_str = str(output_path)
    span_used: Optional[tuple[float, float]] = None
    if span is not None:
        span_used = (max(0.0, float(span[0])), float(span[1]))
        _span_args(span_used)  # validate early (end > start)
    pitch_semitones = float(pitch_semitones)
    # Validate options up front so a typo surfaces deterministically on every
    # host, not only where rubberband is present.
    _validate_rb_options(rb_options)

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
        cmd = _build_rubberband_cmd(
            in_str, out_str, ratio, pitch_semitones, rb_options, span_used
        )
        try:
            proc = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=timeout_sec,
                stdin=subprocess.DEVNULL,
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
                "filter": cmd[cmd.index("-af") + 1],
                "pitch_semitones_used": pitch_semitones,
                "span_used": span_used,
            }
        log.warning(
            "rubberband failed (rc=%s), falling back to atempo. stderr: %s",
            proc.returncode,
            (proc.stderr or "")[:500],
        )
        note = "rubberband filter failed; fell back to atempo"

    if pitch_semitones != 0.0:
        pitch_note = "pitch shift unavailable (atempo)"
        note = f"{note}; {pitch_note}" if note else pitch_note

    cmd = _build_atempo_cmd(in_str, out_str, ratio, span_used)
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout_sec,
            stdin=subprocess.DEVNULL,
        )
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
        "filter": cmd[cmd.index("-af") + 1],
        "pitch_semitones_used": 0.0,
        "span_used": span_used,
    }
