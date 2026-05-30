"""High-level: separate one library entry into stems, persist them.

Drives the sidecar end-to-end: submit the entry's audio, poll for
completion, fetch each stem file, write it to
``data/generations/<entry_id>/stems/<name>.wav``, write a ``stems``
row + a ``stem_of`` relation for each stem, update the entry's
``stems_status``.

Used by both:
  - manual /api/stems/{entry_id}/run endpoint (foreground)
  - the background worker enqueued from settings.stems.auto_on_import /
    auto_on_generate (idle-gated)
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Optional

from backend.modules.library.db import LibraryDB

from .sidecar import StemsSidecar, get_sidecar

log = logging.getLogger(__name__)


POLL_INTERVAL_SEC = 2.0
JOB_TIMEOUT_SEC = 30 * 60  # 30 minutes — Demucs on CPU can be slow


# Process-wide progress for in-flight separations. Keyed by entry_id.
# The /api/stems/{entry_id}/progress endpoint reads this; the frontend
# polls it every ~1s during a stems run so the user sees what's actually
# happening (installing deps / launching sidecar / separating / writing).
_PROGRESS_LOCK = threading.Lock()
_PROGRESS: dict[str, dict[str, Any]] = {}
# entry_ids the user has asked to abort. ``separate_entry`` checks this
# on every poll iteration and raises if its id is in the set.
_ABORT_REQUESTS: set[str] = set()


def request_abort(entry_id: str) -> bool:
    """Signal an in-flight separation to bail at the next poll tick.
    Returns True if the entry was in-flight."""
    with _PROGRESS_LOCK:
        snap = _PROGRESS.get(entry_id)
        if snap is None:
            return False
        _ABORT_REQUESTS.add(entry_id)
        snap["phase"] = "aborting"
        snap["message"] = "Abort requested — will stop at next poll tick"
        snap["updated_at"] = time.time()
        return True


def _should_abort(entry_id: str) -> bool:
    with _PROGRESS_LOCK:
        return entry_id in _ABORT_REQUESTS


def _clear_abort(entry_id: str) -> None:
    with _PROGRESS_LOCK:
        _ABORT_REQUESTS.discard(entry_id)


def _set_progress(entry_id: str, **fields: Any) -> None:
    with _PROGRESS_LOCK:
        cur = _PROGRESS.setdefault(entry_id, {})
        cur.update(fields)
        cur["updated_at"] = time.time()


def get_progress(entry_id: str) -> Optional[dict[str, Any]]:
    with _PROGRESS_LOCK:
        snap = _PROGRESS.get(entry_id)
        return dict(snap) if snap else None


def clear_progress(entry_id: str) -> None:
    with _PROGRESS_LOCK:
        _PROGRESS.pop(entry_id, None)


async def separate_entry(
    db: LibraryDB,
    entry_id: str,
    audio_path: Path,
    entry_dir: Path,
    *,
    stems: int = 4,
    device: Optional[str] = None,
    quality: Optional[str] = None,
    sidecar: Optional[StemsSidecar] = None,
) -> dict:
    """Run separation for one entry. Returns the final task payload.
    Raises if the sidecar isn't reachable or times out.

    ``device`` may be 'cpu' / 'cuda' / 'mps' / None (sidecar chooses).

    Writes per-phase progress to the shared ``_PROGRESS`` map so the
    frontend can poll ``/api/stems/{entry_id}/progress`` while this is
    running and surface what's happening in the ProcessingLog.
    """
    sc = sidecar or get_sidecar()

    _set_status(db, entry_id, "running")
    device_label = device or "auto (sidecar picks)"
    quality_label = quality or "hq (sidecar default)"
    # Stash the device + quality + stems so every later progress tick
    # can include them in its message — the sidecar's own status updates
    # don't carry them.
    _ctx = f"device={device_label}, quality={quality_label}, stems={stems}"
    _set_progress(
        entry_id,
        phase="starting",
        message=f"Preparing sidecar… ({_ctx})",
        progress=0,
        stems=stems,
        device=device_label,
        quality=quality_label,
    )
    try:
        _set_progress(
            entry_id,
            phase="bootstrap",
            message=(
                "Bootstrapping sidecar venv (first run can take several minutes "
                "while demucs + torch + dependencies download)…"
            ),
        )
        submit = await sc.submit_separation(
            audio_path, stems=stems, device=device, quality=quality
        )
        task_id = submit.get("task_id")
        if not task_id:
            raise RuntimeError(f"sidecar didn't return a task_id: {submit}")
        sidecar_msg = submit.get("message") or "Queued in sidecar"
        _set_progress(
            entry_id,
            phase="queued",
            task_id=task_id,
            message=f"{sidecar_msg} ({_ctx})",
            progress=0,
        )

        deadline = time.monotonic() + JOB_TIMEOUT_SEC
        last_status: dict = {}
        last_logged_phase = ""
        while time.monotonic() < deadline:
            if _should_abort(entry_id):
                _clear_abort(entry_id)
                raise RuntimeError(f"stem separation aborted by user for {entry_id}")
            last_status = await sc.poll_status(task_id)
            sidecar_status = last_status.get("status") or "running"
            sidecar_message = last_status.get("message") or ""
            sidecar_progress = last_status.get("progress")
            # Always include the device/quality context so the frontend
            # log line tells the user what's actually running — the
            # sidecar's own status response doesn't carry these.
            full_message = (
                f"{sidecar_message} ({_ctx})" if sidecar_message else f"({_ctx})"
            )
            _set_progress(
                entry_id,
                phase=sidecar_status,
                message=full_message,
                progress=sidecar_progress,
                task_id=task_id,
            )
            # Surface only phase changes to the python logger (the
            # frontend polls progress directly).
            if sidecar_status != last_logged_phase:
                log.info(
                    "stems.engine: %s → %s (%s)",
                    entry_id,
                    sidecar_status,
                    sidecar_message,
                )
                last_logged_phase = sidecar_status
            if sidecar_status in ("completed", "error", "failed"):
                break
            await asyncio.sleep(POLL_INTERVAL_SEC)
        else:
            raise RuntimeError(f"stem separation timed out for {entry_id}")

        if last_status.get("status") != "completed":
            raise RuntimeError(f"stem separation failed for {entry_id}: {last_status}")

        stems_dir = entry_dir / "stems"
        stems_dir.mkdir(parents=True, exist_ok=True)

        listing = await sc.list_stems(task_id)
        files = _normalize_stem_filenames(listing)
        _set_progress(
            entry_id,
            phase="writing",
            message=f"Writing {len(files)} stem(s) to disk…",
        )

        written = 0
        for filename in files:
            try:
                data = await sc.fetch_stem_bytes(task_id, filename)
            except Exception as e:
                log.warning(
                    "stems.engine: fetch failed for %s/%s: %s", entry_id, filename, e
                )
                continue
            out_path = stems_dir / filename
            # Re-encode 32-bit-float WAV (what demucs emits) to PCM_16
            # WAV to halve the on-disk footprint. Stems are perceptually
            # indistinguishable at 16-bit and the user explicitly asked
            # for smaller files.
            written_bytes = _write_stem_compact(data, out_path)
            stem_name = Path(filename).stem
            db.add_stem(
                stem_id=f"{entry_id}__{stem_name}",
                entry_id=entry_id,
                stem_name=stem_name,
                audio_path=str(out_path),
                file_size_bytes=written_bytes,
                model="demucs",
                model_variant=f"{stems}-stem",
            )
            db.add_relation(
                from_id=entry_id,
                to_id=f"{entry_id}__{stem_name}",
                kind="stem_of",
            )
            written += 1

        if files and written == 0:
            raise RuntimeError(
                f"stem separation produced {len(files)} listed file(s) "
                f"but none could be fetched/written for {entry_id}"
            )

        _set_status(db, entry_id, "complete")
        _set_progress(
            entry_id,
            phase="completed",
            message=f"Wrote {written} stem(s)",
            progress=100,
        )
        return {
            "task_id": task_id,
            "status": "completed",
            "written": written,
            "files": files,
        }
    except Exception as e:
        aborted = "aborted by user" in str(e)
        _set_status(db, entry_id, "aborted" if aborted else "failed")
        _set_progress(
            entry_id,
            phase="aborted" if aborted else "failed",
            message=str(e),
        )
        _clear_abort(entry_id)
        raise


def _set_status(db: LibraryDB, entry_id: str, status: str) -> None:
    try:
        with db._txn() as cur:  # noqa: SLF001
            cur.execute(
                "UPDATE entries SET stems_status = ?, updated_at = ? WHERE id = ?",
                (status, time.time(), entry_id),
            )
    except Exception as e:
        log.debug(
            "stems.engine: status update failed for %s -> %s: %s", entry_id, status, e
        )


def _stem_uuid() -> str:
    """Stable-ish, mostly-unique id for stems we couldn't disambiguate
    by name. Currently unused — kept for future ``add_stem`` cases that
    need it."""
    return uuid.uuid4().hex[:12]


def _normalize_stem_filenames(listing: Any) -> list[str]:
    """Coerce the sidecar's ``/stems/{task_id}`` listing into a list of
    safe basename filenames (e.g. ``["bass.wav", "drums.wav"]``).

    The integration-package sidecar returns rich dict entries:

        {"files": [{"name": "bass.wav", "size": 1234, "url": "/stems/<task>/bass.wav"}, ...]}

    Older or alternative shapes we tolerate:

      * ``{"files": ["bass.wav", "drums.wav"]}``        — list of strings
      * ``{"stems": [...]}``                            — same data under
        a different key
      * ``{"files": {"bass.wav": "/abs/path/bass.wav"}}`` — dict of
        name -> path

    Unsafe entries (anything with path separators, ``..``, or missing a
    ``name``/``url``) are dropped with a warning rather than raising so
    one bad item can't tank a whole separation run.
    """
    if not isinstance(listing, dict):
        return []

    raw_files: Any = listing.get("files")
    if raw_files is None:
        raw_files = listing.get("stems") or []

    candidates: list[str] = []
    if isinstance(raw_files, dict):
        # name -> path mapping; we just need the keys (names).
        candidates.extend(str(k) for k in raw_files.keys())
    elif isinstance(raw_files, list):
        for item in raw_files:
            if isinstance(item, str):
                candidates.append(item)
                continue
            if isinstance(item, dict):
                name = item.get("name")
                if not name:
                    # Fall back to the basename of the url if present.
                    url = item.get("url") or item.get("path") or ""
                    if url:
                        name = Path(str(url)).name
                if name:
                    candidates.append(str(name))
                    continue
            log.warning(
                "stems.engine: dropping unrecognized stem listing entry: %r", item
            )
    else:
        log.warning(
            "stems.engine: unexpected sidecar listing shape (%s); ignoring",
            type(raw_files).__name__,
        )
        return []

    safe: list[str] = []
    seen: set[str] = set()
    for raw in candidates:
        name = raw.strip()
        if not name:
            continue
        # Reject anything that could escape the stems dir.
        if (
            "/" in name
            or "\\" in name
            or name in ("..", ".")
            or ".." in name.split("/")
        ):
            log.warning("stems.engine: dropping unsafe stem filename: %r", raw)
            continue
        # The integration-package only emits .wav stems today; keep the
        # filter loose enough to accept future formats but still drop
        # obvious junk.
        if not Path(name).suffix:
            log.warning("stems.engine: dropping extensionless stem name: %r", raw)
            continue
        if name in seen:
            continue
        seen.add(name)
        safe.append(name)
    return safe


def _write_stem_compact(wav_bytes: bytes, out_path: Path) -> int:
    """Write demucs's float WAV out as PCM_16. Falls back to writing
    the original bytes if soundfile isn't available."""
    try:
        import io

        import soundfile as sf
    except ImportError:
        out_path.write_bytes(wav_bytes)
        return len(wav_bytes)
    try:
        audio, sr = sf.read(io.BytesIO(wav_bytes), dtype="float32")
        sf.write(str(out_path), audio, sr, subtype="PCM_16")
        return out_path.stat().st_size
    except Exception as e:
        log.warning(
            "stems.engine: PCM_16 reencode failed for %s, writing raw: %s",
            out_path.name,
            e,
        )
        out_path.write_bytes(wav_bytes)
        return len(wav_bytes)
