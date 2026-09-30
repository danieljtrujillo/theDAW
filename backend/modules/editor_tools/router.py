"""FastAPI router for the editor-tools module (prefix from module.json:
``/api/editor-tools``).

    POST /analyze         multipart clip -> duration, levels, tempo, onsets, key
    POST /detect-tempo    the same clip -> {bpm, confidence, beats}
    POST /compare-timing  MIDI note starts vs audio onsets -> the offset to nudge by
    POST /stretch         multipart clip + ratio or bpm pair -> audio/wav bytes

Nothing is cached and nothing is written outside a temp directory that is
removed in a ``finally``: these are measuring tools the Edit timeline calls
with whatever the user has selected, not a library pipeline.

``/compare-timing`` takes EITHER ``application/json`` with the onsets already
in hand (the timeline usually has them from a previous ``/analyze``, and
re-detecting them would be both slower and a different answer) OR
``multipart/form-data`` with the audio to detect them from. FastAPI cannot
declare one signature covering both — ``File``/``Form`` force multipart for
the whole body — so the dispatch is on the content type, and the request body
schema is spelled out in ``openapi_extra`` so ``/openapi.json`` still
describes both shapes for tool registration.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import re
import tempfile
import time
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import Response
from starlette.datastructures import UploadFile as StarletteUploadFile

from backend.lib import ffmpeg

from .engine import (
    DEFAULT_MAX_MATCH_SEC,
    EDITOR_TOOLS_VERSION,
    RATIO_MAX,
    RATIO_MIN,
    DecodeError,
    analyze_clip,
    analyze_clip_at_rate,
    compare_timing,
    detect_onsets,
    detect_tempo,
    load_clip,
    resolve_ratio,
    stretch_filter,
    to_analysis_mono,
)

log = logging.getLogger(__name__)

router = APIRouter(tags=["editor-tools"])

_SAFE_SUFFIX = re.compile(r"[^A-Za-z0-9]")
_STRETCH_TIMEOUT_SEC = 300.0

#: What ffmpeg prints when it cannot open or decode the INPUT (lowercased).
#: Only these make a failed stretch the client's fault; see
#: :func:`_stretch_failure_status`.
_INPUT_DECODE_MARKERS = (
    "invalid data found when processing input",
    "could not find codec",
    "error opening input",
)
#: The message ``backend/lib/ffmpeg.run`` raises when its own timeout fires.
_LIB_TIMEOUT_PREFIX = "timed out after"


def _stretch_failure_status(
    error: ffmpeg.FFmpegError, elapsed_sec: float, timeout_sec: float
) -> int:
    """The HTTP status for a failed ``/stretch`` render, from what is KNOWN.

    ``FFmpegError.returncode`` alone cannot decide this: ``backend/lib/ffmpeg``
    uses -1 both for its timeout and for "produced no output", a POSIX child
    killed by SIGHUP also reports -1, and a positive exit status is as likely
    to be the disk or the encoder as the upload. So:

    * **500 — timeout.** The lib's timeout message, OR the render having used
      its whole budget (``elapsed >= timeout``, the timeout this router
      passed). Checked first: a run cut off mid-decode may have printed a
      decode complaint on its way out, and that is still our time limit.
    * **400 — the input.** ffmpeg RAN and exited (``returncode > 0``; signal
      deaths are negative on POSIX, and -1 is the lib's sentinel) AND its
      stderr names an input open/decode failure
      (:data:`_INPUT_DECODE_MARKERS`). That is an unsupported or corrupt
      upload — the client's to fix.
    * **500 — everything else.** Disk full, encoder failure, a signalled
      child, a zero exit with no output: this server failing work it accepted.
    """
    stderr = (error.stderr or "").lower()
    if stderr.startswith(_LIB_TIMEOUT_PREFIX) or elapsed_sec >= timeout_sec:
        return 500
    if error.returncode > 0 and any(m in stderr for m in _INPUT_DECODE_MARKERS):
        return 400
    return 500


def _suffix_of(upload: UploadFile) -> str:
    """The upload's extension, stripped to alphanumerics.

    Only the extension is ever taken from ``filename`` — the rest is a name
    the client chose, and a path separator in it must not reach the temp
    directory.
    """
    raw = Path(upload.filename or "").suffix.lstrip(".")
    safe = _SAFE_SUFFIX.sub("", raw)[:10]
    return f".{safe}" if safe else ".bin"


async def _staged(upload: UploadFile) -> tuple[Path, Path]:
    """Stream the upload into a fresh temp directory. Returns ``(dir, file)``;
    the caller removes the directory."""
    tmp = Path(tempfile.mkdtemp(prefix="editor_tools_"))
    src = tmp / f"input{_suffix_of(upload)}"
    await ffmpeg.stream_upload_to(src, upload)
    return tmp, src


def _hint(sample_rate_hint: Optional[int]) -> Optional[int]:
    if sample_rate_hint is None:
        return None
    rate = int(sample_rate_hint)
    if not 1000 <= rate <= 768000:
        raise HTTPException(400, f"sample_rate_hint {rate} is not a sample rate")
    return rate


@router.get("/")
def health() -> dict[str, Any]:
    return {
        "module": "editor_tools",
        "version": EDITOR_TOOLS_VERSION,
        "features": ["analyze", "detect-tempo", "compare-timing", "stretch"],
        "ratio_range": [RATIO_MIN, RATIO_MAX],
    }


@router.post("/analyze")
async def analyze(
    file: UploadFile = File(...),
    sample_rate_hint: Optional[int] = Form(None),
) -> dict[str, Any]:
    """Duration, sample rate, channels, peak/RMS dBFS, tempo, onsets and key."""
    rate = _hint(sample_rate_hint)
    tmp, src = await _staged(file)
    try:
        if rate is None:
            return await asyncio.to_thread(analyze_clip, src)
        return await asyncio.to_thread(analyze_clip_at_rate, src, rate)
    except DecodeError as e:
        raise HTTPException(400, f"could not decode the audio: {e}") from e
    finally:
        ffmpeg.cleanup(tmp)


@router.post("/detect-tempo")
async def detect_tempo_endpoint(
    file: UploadFile = File(...),
    sample_rate_hint: Optional[int] = Form(None),
) -> dict[str, Any]:
    """``{bpm, confidence, beats}`` — the ``tempo`` block of ``/analyze``."""
    rate = _hint(sample_rate_hint)
    tmp, src = await _staged(file)
    try:
        if rate is not None:
            result = await asyncio.to_thread(analyze_clip_at_rate, src, rate)
            return result["tempo"]
        return await asyncio.to_thread(detect_tempo, src)
    except DecodeError as e:
        raise HTTPException(400, f"could not decode the audio: {e}") from e
    finally:
        ffmpeg.cleanup(tmp)


_COMPARE_TIMING_BODY = {
    "required": True,
    "content": {
        "application/json": {
            "schema": {
                "type": "object",
                "required": ["noteStartsSec"],
                "properties": {
                    "onsets": {
                        "type": "array",
                        "items": {"type": "number"},
                        "description": "Audio onset times in seconds.",
                    },
                    "noteStartsSec": {
                        "type": "array",
                        "items": {"type": "number"},
                        "description": "MIDI note start times in seconds.",
                    },
                    "maxMatchSec": {
                        "type": "number",
                        "default": DEFAULT_MAX_MATCH_SEC,
                    },
                },
            }
        },
        "multipart/form-data": {
            "schema": {
                "type": "object",
                "required": ["file", "noteStartsSec"],
                "properties": {
                    "file": {"type": "string", "format": "binary"},
                    "noteStartsSec": {
                        "type": "string",
                        "description": "JSON array of seconds.",
                    },
                    "maxMatchSec": {
                        "type": "number",
                        "default": DEFAULT_MAX_MATCH_SEC,
                    },
                },
            }
        },
    },
}


def _numbers(value: Any, field: str) -> list[float]:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError as e:
            raise HTTPException(400, f"{field} must be a JSON array of seconds") from e
    if not isinstance(value, list):
        raise HTTPException(400, f"{field} must be an array of seconds")
    try:
        numbers = [float(v) for v in value]
    except (TypeError, ValueError) as e:
        raise HTTPException(400, f"{field} must contain only numbers") from e
    # ``json.loads`` accepts the non-standard NaN / Infinity / -Infinity
    # tokens. Letting one through puts a bare ``NaN`` in the RESPONSE, which
    # no strict JSON parser will read, and poisons the median besides.
    if not all(math.isfinite(n) for n in numbers):
        raise HTTPException(400, f"{field} must not contain NaN or Infinity")
    return numbers


def _window(value: Any) -> float:
    """``maxMatchSec`` as a float, or the default when it was not sent."""
    if value is None or value == "":
        return DEFAULT_MAX_MATCH_SEC
    try:
        window = float(value)
    except (TypeError, ValueError) as e:
        raise HTTPException(400, "maxMatchSec must be a number of seconds") from e
    # Before the sign test: ``nan < 0`` is False, so a NaN window would slip
    # past it and then match nothing while reporting no error.
    if not math.isfinite(window):
        raise HTTPException(400, "maxMatchSec must be a finite number of seconds")
    if window < 0:
        raise HTTPException(400, "maxMatchSec must not be negative")
    return window


def _onsets_of_upload(path: Path) -> list[float]:
    audio, sr = load_clip(path)
    return detect_onsets(to_analysis_mono(audio, sr))


@router.post("/compare-timing", openapi_extra={"requestBody": _COMPARE_TIMING_BODY})
async def compare_timing_endpoint(request: Request) -> dict[str, Any]:
    """MIDI note starts against audio onsets, as the offset to nudge by.

    ``medianOffsetSec`` is audio minus MIDI: positive means the MIDI should
    move LATER, negative means it is late and should move earlier.
    """
    content_type = (
        (request.headers.get("content-type") or "").split(";")[0].strip().lower()
    )

    if content_type == "multipart/form-data":
        form = await request.form()
        upload = form.get("file")
        if "noteStartsSec" not in form:
            raise HTTPException(400, "noteStartsSec is required")
        notes = _numbers(form["noteStartsSec"], "noteStartsSec")
        window = _window(form.get("maxMatchSec"))
        if "onsets" in form:
            onsets = _numbers(form["onsets"], "onsets")
        elif isinstance(upload, StarletteUploadFile):
            # Starlette's class, not FastAPI's subclass: ``request.form()``
            # builds the Starlette one, and an isinstance check against the
            # subclass silently reads every upload as "no file given".
            tmp, src = await _staged(upload)
            try:
                onsets = await asyncio.to_thread(_onsets_of_upload, src)
            except DecodeError as e:
                raise HTTPException(400, f"could not decode the audio: {e}") from e
            finally:
                ffmpeg.cleanup(tmp)
        else:
            raise HTTPException(400, "pass either onsets or an audio file")
        return compare_timing(onsets, notes, window)

    try:
        payload = await request.json()
    except ValueError as e:
        raise HTTPException(400, "body must be JSON or multipart/form-data") from e
    if not isinstance(payload, dict):
        raise HTTPException(400, "body must be a JSON object")
    if "noteStartsSec" not in payload:
        raise HTTPException(400, "noteStartsSec is required")
    if payload.get("onsets") is None:
        raise HTTPException(
            400,
            "pass onsets in the JSON body, or post the audio as multipart/form-data",
        )
    notes = _numbers(payload["noteStartsSec"], "noteStartsSec")
    onsets = _numbers(payload["onsets"], "onsets")
    window = _window(payload.get("maxMatchSec"))
    return compare_timing(onsets, notes, window)


@router.post(
    "/stretch",
    response_class=Response,
    responses={
        200: {"content": {"audio/wav": {}}, "description": "The stretched clip"}
    },
)
async def stretch(
    file: UploadFile = File(...),
    ratio: Optional[float] = Form(None),
    source_bpm: Optional[float] = Form(None),
    target_bpm: Optional[float] = Form(None),
) -> Response:
    """Time-stretch without moving the pitch, returned as a float WAV.

    ``ratio`` is new_duration / old_duration; ``source_bpm`` + ``target_bpm``
    derive it as ``source_bpm / target_bpm``. The output is 32-bit float
    because it goes straight back into the Edit timeline, where a
    requantization to 16 bit on every warp is loss for nothing.
    """
    try:
        value = resolve_ratio(ratio, source_bpm, target_bpm)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    filter_string = stretch_filter(value)
    timeout_sec = _STRETCH_TIMEOUT_SEC
    tmp, src = await _staged(file)
    started = time.monotonic()
    try:
        out = tmp / "stretched.wav"
        await ffmpeg.render(
            src,
            out,
            ["-filter:a", filter_string],
            ["-c:a", "pcm_f32le"],
            timeout=timeout_sec,
        )
        data = out.read_bytes()
    except ffmpeg.FFmpegError as e:
        status = _stretch_failure_status(e, time.monotonic() - started, timeout_sec)
        log.warning("editor_tools: stretch failed -> %d (%s)", status, e)
        raise HTTPException(status, f"time-stretch failed: {e}") from e
    finally:
        ffmpeg.cleanup(tmp)

    stem = _SAFE_SUFFIX.sub("_", Path(file.filename or "clip").stem)[:60] or "clip"
    return Response(
        content=data,
        media_type="audio/wav",
        headers={
            "Content-Disposition": f'attachment; filename="{stem}_stretched.wav"',
            "X-Stretch-Ratio": f"{value:.6f}",
            "X-Stretch-Filter": filter_string,
        },
    )
