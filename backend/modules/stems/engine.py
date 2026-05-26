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
import time
import uuid
from pathlib import Path
from typing import Optional

from backend.modules.library.db import LibraryDB

from .sidecar import StemsSidecar, get_sidecar

log = logging.getLogger(__name__)


POLL_INTERVAL_SEC = 2.0
JOB_TIMEOUT_SEC = 30 * 60  # 30 minutes — Demucs on CPU can be slow


async def separate_entry(
    db: LibraryDB,
    entry_id: str,
    audio_path: Path,
    entry_dir: Path,
    *,
    stems: int = 4,
    device: Optional[str] = None,
    sidecar: Optional[StemsSidecar] = None,
) -> dict:
    """Run separation for one entry. Returns the final task payload.
    Raises if the sidecar isn't reachable or times out.

    ``device`` may be 'cpu' / 'cuda' / 'mps' / None (sidecar chooses)."""
    sc = sidecar or get_sidecar()

    _set_status(db, entry_id, "running")
    try:
        submit = await sc.submit_separation(audio_path, stems=stems, device=device)
        task_id = submit.get("task_id")
        if not task_id:
            raise RuntimeError(f"sidecar didn't return a task_id: {submit}")

        deadline = time.monotonic() + JOB_TIMEOUT_SEC
        last_status: dict = {}
        while time.monotonic() < deadline:
            last_status = await sc.poll_status(task_id)
            status_value = last_status.get("status")
            if status_value in ("completed", "error", "failed"):
                break
            await asyncio.sleep(POLL_INTERVAL_SEC)
        else:
            raise RuntimeError(f"stem separation timed out for {entry_id}")

        if last_status.get("status") != "completed":
            raise RuntimeError(f"stem separation failed for {entry_id}: {last_status}")

        stems_dir = entry_dir / "stems"
        stems_dir.mkdir(parents=True, exist_ok=True)

        listing = await sc.list_stems(task_id)
        files = listing.get("files") or listing.get("stems") or []
        if isinstance(files, dict):
            # Some shapes return a name → path mapping.
            files = list(files.keys())

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
            out_path.write_bytes(data)
            stem_name = Path(filename).stem
            db.add_stem(
                stem_id=f"{entry_id}__{stem_name}",
                entry_id=entry_id,
                stem_name=stem_name,
                audio_path=str(out_path),
                file_size_bytes=len(data),
                model="demucs",
                model_variant=f"{stems}-stem",
            )
            db.add_relation(
                from_id=entry_id,
                to_id=f"{entry_id}__{stem_name}",
                kind="stem_of",
            )
            written += 1

        _set_status(db, entry_id, "complete")
        return {
            "task_id": task_id,
            "status": "completed",
            "written": written,
            "files": files,
        }
    except Exception:
        _set_status(db, entry_id, "failed")
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
