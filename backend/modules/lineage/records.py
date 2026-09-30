"""Validation and normalisation for render lineage records.

A lineage record describes how one rendered audio/MIDI output was assembled
from library entries and project clips/tracks: which output file resulted,
and which contributions (source clips/tracks, each pinned to a time range and
a library entry) fed it. The studio posts a JSON payload; :func:`normalize_record`
validates it and returns a canonical dict with exactly the same shape every
time, or raises :class:`LineageError` with a user-facing message.

This module is pure logic: no SQLite, no FastAPI, no filesystem access. The
canonical record it returns is later stored verbatim in the lineage database
and copied, unchanged, into the corresponding library entry's folder as a
sidecar file. Because the record is duplicated to that sidecar after this
function returns, it must never carry a hash or checksum of itself -- the
record's own storage locations are not known yet while it is being built, so
a self-checksum would be meaningless (and immediately stale once copied).
"""

from __future__ import annotations

import math
from datetime import UTC, datetime

MAX_CONTRIBUTIONS = 20_000  # max contribution entries a single render may reference
MAX_ID_CHARS = (
    200  # max length of a plain id token (render/project/entry/clip/track ids)
)
MAX_NAME_CHARS = 400  # max length of a human-readable name field (e.g. project_name)
MAX_PATH_CHARS = (
    1024  # max length of a filesystem-path-like text field (e.g. output.path)
)
OUTPUT_KINDS = ("full", "range", "stems", "clips")  # allowed values for output.kind
ROLES = ("audio", "midi", "stem")  # allowed values for contribution.role


class LineageError(ValueError):
    """Raised when a lineage payload fails validation.

    The single exception this module raises. Its message is user-facing text
    -- no tracebacks, no internal paths -- safe to return straight to a caller.
    """


def clean_token(value: object, field: str, *, max_chars: int = MAX_ID_CHARS) -> str:
    """Validate ``value`` as a plain id: non-empty, bounded, no path parts.

    Ids become folder names downstream, so this rejects anything that could
    escape or corrupt a path: separators, NUL, and ``.``/``..``.
    """
    text = "" if value is None else str(value).strip()
    if not text:
        raise LineageError(f"{field} is required")
    if len(text) > max_chars:
        raise LineageError(f"{field} is too long (max {max_chars} characters)")
    if text in (".", "..") or any(ch in text for ch in ("/", "\\", "\x00")):
        raise LineageError(f"{field} must be a plain id without path separators")
    return text


def clean_text(value: object, field: str, *, max_chars: int) -> str:
    """Validate ``value`` as free text: bounded, but empty is allowed.

    Never truncates -- an over-length value is rejected outright so nothing
    is silently coerced into something the caller didn't send.
    """
    text = "" if value is None else str(value).strip()
    if len(text) > max_chars:
        raise LineageError(f"{field} is too long (max {max_chars} characters)")
    return text


def clean_time(value: object, field: str) -> float:
    """Validate ``value`` as a required, finite time offset in seconds."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise LineageError(f"{field} must be a finite number") from None
    if not math.isfinite(number):
        raise LineageError(f"{field} must be a finite number")
    return number


def clean_optional_time(value: object, field: str) -> float | None:
    """Like :func:`clean_time`, but ``None``/absent passes through as ``None``."""
    if value is None:
        return None
    return clean_time(value, field)


def clean_iso_utc(value: object, field: str = "created_at") -> str:
    """Parse an ISO-8601 timestamp and return its canonical UTC form.

    Accepts a trailing ``Z`` (rewritten to ``+00:00`` before parsing) and
    treats a timezone-naive value as already being UTC. The return value is
    always ``YYYY-MM-DDTHH:MM:SS(.ffffff)+00:00``.
    """
    text = "" if value is None else str(value).strip()
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        raise LineageError(f"{field} must be an ISO-8601 timestamp") from None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC).isoformat()


def _normalize_output(raw: object) -> dict:
    if not isinstance(raw, dict):
        raise LineageError("output must be an object")

    library_entry_id = raw.get("library_entry_id")
    if library_entry_id is not None:
        library_entry_id = clean_token(library_entry_id, "output.library_entry_id")

    path = raw.get("path")
    if path is not None:
        path = clean_text(path, "output.path", max_chars=MAX_PATH_CHARS)

    kind = raw.get("kind")
    if kind not in OUTPUT_KINDS:
        raise LineageError("output.kind must be one of full, range, stems, clips")

    start_sec = clean_optional_time(raw.get("start_sec"), "output.start_sec")
    end_sec = clean_optional_time(raw.get("end_sec"), "output.end_sec")
    if start_sec is not None and end_sec is not None and end_sec < start_sec:
        raise LineageError("output.end_sec must be >= output.start_sec")

    return {
        "library_entry_id": library_entry_id,
        "path": path,
        "kind": kind,
        "start_sec": start_sec,
        "end_sec": end_sec,
    }


def _normalize_contribution(raw: object, index: int) -> dict:
    if not isinstance(raw, dict):
        raise LineageError(f"contribution {index}: must be an object")

    prefix = f"contribution {index}"
    library_entry_id = clean_token(
        raw.get("library_entry_id"), f"{prefix}: library_entry_id"
    )
    clip_id = clean_token(raw.get("clip_id"), f"{prefix}: clip_id")
    track_id = clean_token(raw.get("track_id"), f"{prefix}: track_id")

    start_sec = clean_time(raw.get("start_sec"), f"{prefix}: start_sec")
    end_sec = clean_time(raw.get("end_sec"), f"{prefix}: end_sec")
    source_offset_sec = clean_time(
        raw.get("source_offset_sec"), f"{prefix}: source_offset_sec"
    )
    if end_sec < start_sec:
        raise LineageError(f"{prefix}: end_sec must be >= start_sec")

    role = raw.get("role")
    if role not in ROLES:
        raise LineageError(f"{prefix}: role must be one of audio, midi, stem")

    return {
        "library_entry_id": library_entry_id,
        "clip_id": clip_id,
        "track_id": track_id,
        "start_sec": start_sec,
        "end_sec": end_sec,
        "source_offset_sec": source_offset_sec,
        "role": role,
    }


def normalize_record(payload: dict) -> dict:
    """Validate a full render-lineage POST body and return a canonical dict.

    Raises :class:`LineageError` on the first problem found; never truncates
    or coerces bad data into something valid.
    """
    if not isinstance(payload, dict):
        raise LineageError("payload must be an object")

    render_id = clean_token(payload.get("render_id"), "render_id")
    project_id = clean_token(payload.get("project_id"), "project_id")
    project_name = clean_text(
        payload.get("project_name"), "project_name", max_chars=MAX_NAME_CHARS
    )
    created_at = clean_iso_utc(payload.get("created_at"))
    output = _normalize_output(payload.get("output"))

    contributions_raw = payload.get("contributions")
    if not isinstance(contributions_raw, list):
        raise LineageError("contributions must be a list")
    if len(contributions_raw) > MAX_CONTRIBUTIONS:
        raise LineageError(
            f"a render may reference at most {MAX_CONTRIBUTIONS} contributions"
        )
    contributions = [
        _normalize_contribution(item, index)
        for index, item in enumerate(contributions_raw)
    ]

    return {
        "render_id": render_id,
        "project_id": project_id,
        "project_name": project_name,
        "created_at": created_at,
        "output": output,
        "contributions": contributions,
    }
