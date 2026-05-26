"""End-to-end MIDI conversion for a library entry.

For each requested target (the full track, and/or each stem if
``from_stems=True``), call the engine, write the .mid into
``data/generations/<entry_id>/midi/<name>.mid``, then insert a row into
the ``midis`` table + a ``midi_of`` relation edge. Update the entry's
``midi_status`` (pending → running → complete | failed | partial).

A 'partial' status means at least one but not all targets succeeded —
common when basic-pitch is installed but piano-transcription isn't.
"""

from __future__ import annotations

import logging
import time
import uuid
from pathlib import Path

from backend.modules.library.db import LibraryDB

from .engine import MidiHint, convert_to_midi, hint_for_stem

log = logging.getLogger(__name__)


def convert_entry(
    db: LibraryDB,
    entry_id: str,
    audio_path: Path,
    entry_dir: Path,
    *,
    from_stems: bool = True,
    auto_install: bool = True,
) -> dict:
    """Convert the full track (and stems if available + requested) to
    MIDI. Returns a summary dict.

    ``auto_install`` (default True) lets convert_to_midi pip-install
    basic-pitch on first call if no engine is present. Tests pass False."""
    _set_status(db, entry_id, "running")
    midi_dir = entry_dir / "midi"
    midi_dir.mkdir(parents=True, exist_ok=True)

    results: list[dict] = []

    # Full-track conversion.
    full_out = midi_dir / "full.mid"
    full_res = convert_to_midi(
        audio_path, full_out, hint="generic", auto_install=auto_install
    )
    results.append({"target": "full", **full_res})
    if full_res.get("ok"):
        db.add_midi(
            midi_id=f"{entry_id}__full",
            entry_id=entry_id,
            source="full",
            midi_path=str(full_out),
            engine=str(full_res.get("engine") or ""),
            engine_version=str(full_res.get("engine_version") or ""),
            notes_count=int(full_res.get("notes_count") or 0),
        )
        db.add_relation(
            from_id=entry_id,
            to_id=f"{entry_id}__full_midi",
            kind="midi_of",
            metadata={"target": "full"},
        )

    # Per-stem conversions (if requested + stems exist).
    if from_stems:
        stems = db.list_stems(entry_id)
        for stem_row in stems:
            stem_name = stem_row.get("stem_name") or ""
            stem_audio = Path(stem_row.get("audio_path") or "")
            if not stem_audio.is_file():
                continue
            hint: MidiHint = hint_for_stem(stem_name)
            stem_out = midi_dir / f"{stem_name}.mid"
            stem_res = convert_to_midi(
                stem_audio, stem_out, hint=hint, auto_install=auto_install
            )
            results.append({"target": stem_name, **stem_res})
            if stem_res.get("ok"):
                stem_id = stem_row.get("id") or f"{entry_id}__{stem_name}"
                db.add_midi(
                    midi_id=f"{entry_id}__{stem_name}_midi",
                    entry_id=entry_id,
                    source="stem",
                    source_ref=str(stem_id),
                    midi_path=str(stem_out),
                    engine=str(stem_res.get("engine") or ""),
                    engine_version=str(stem_res.get("engine_version") or ""),
                    notes_count=int(stem_res.get("notes_count") or 0),
                )
                db.add_relation(
                    from_id=str(stem_id),
                    to_id=f"{entry_id}__{stem_name}_midi",
                    kind="midi_of",
                )

    successes = sum(1 for r in results if r.get("ok"))
    failures = len(results) - successes

    if successes == 0 and failures > 0:
        _set_status(db, entry_id, "failed")
        status = "failed"
    elif failures > 0:
        _set_status(db, entry_id, "partial")
        status = "partial"
    else:
        _set_status(db, entry_id, "complete")
        status = "complete"

    return {
        "entry_id": entry_id,
        "status": status,
        "successes": successes,
        "failures": failures,
        "results": results,
    }


def _set_status(db: LibraryDB, entry_id: str, status: str) -> None:
    try:
        with db._txn() as cur:  # noqa: SLF001
            cur.execute(
                "UPDATE entries SET midi_status = ?, updated_at = ? WHERE id = ?",
                (status, time.time(), entry_id),
            )
    except Exception as e:
        log.debug(
            "midi.runner: status update failed for %s -> %s: %s", entry_id, status, e
        )


def _gen_id() -> str:
    return uuid.uuid4().hex[:12]
