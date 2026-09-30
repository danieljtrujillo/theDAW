"""Find, store and serve a library entry's sections.

The bar grid, best first:

  * ``rhythm``  — the bars of the entry's rhythm analysis (the meter map's
                  own bars, which follow a meter or tempo change)
  * ``beats``   — the library analysis's beats, grouped in fours from the
                  downbeat phase chimera's structure code reads
  * ``tracked`` — beats tracked here, grouped the same way
  * ``time``    — two-second windows, when no beat can be read

Stems are the entry's separated stems (a drum kit's LARSNET parts are left
out when the drum stem is there). With none, the finder reads the
percussive, low and harmonic parts of the mix.

A run keeps the user's names and roles (``store.carry_edits``) and writes
each shard's ``section`` (the role of the section holding the shard's
middle), so ``/api/shards/query`` can ask for chorus material.
"""

from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import Any, Optional

import numpy as np

from . import store
from .finder import SECTIONS_VERSION, SR, bars_from_beats, find_sections, time_grid

log = logging.getLogger(__name__)

_DOWNBEAT_MIN_CONF = 0.15
_DRUM_PARTS = {"kick", "snare", "hihat", "cymbals", "toms"}


def _load_mono(path: Path) -> np.ndarray:
    import librosa

    y, _ = librosa.load(str(path), sr=SR, mono=True)
    return np.ascontiguousarray(np.asarray(y, dtype=np.float32))


def _downbeat_phase(y: np.ndarray, beats: list[float]) -> int:
    """Which beat (mod 4) is the downbeat; 0 below chimera's confidence gate."""
    try:
        import librosa

        from backend.modules.chimera.structure import (
            beat_features,
            estimate_downbeat_phase,
        )

        frames = librosa.time_to_frames(np.asarray(beats), sr=SR, hop_length=512)
        feats = beat_features(y, SR, frames, hop=512)
        phase, conf = estimate_downbeat_phase(feats, 4)
        return int(phase) if conf >= _DOWNBEAT_MIN_CONF else 0
    except Exception as e:  # noqa: BLE001 - phase 0 is a valid fallback
        log.info("sections: downbeat phase fell back to 0 (%s)", e)
        return 0


def _rhythm_bars(entry_id: str) -> list[tuple[float, float]]:
    try:
        from backend.modules.rhythm.router import cached_rhythm

        doc = cached_rhythm(entry_id)
    except Exception as e:  # noqa: BLE001 - no rhythm module, no rhythm grid
        log.info("sections: rhythm cache unreadable (%s)", e)
        return []
    bars = (doc or {}).get("bars") or []
    return [
        (float(b["start_sec"]), float(b["end_sec"]))
        for b in bars
        if b.get("end_sec", 0) > b.get("start_sec", 0)
    ]


def _analysis_beats(db: Any, entry_id: str) -> list[float]:
    import json

    a = db.get_analysis(entry_id) or {}
    raw = a.get("beats_json") or a.get("beats") or "[]"
    try:
        beats = json.loads(raw) if isinstance(raw, str) else list(raw)
    except ValueError:
        return []
    return sorted(float(b) for b in beats if b is not None)


def _tracked_beats(y: np.ndarray) -> list[float]:
    try:
        import librosa

        _, beats = librosa.beat.beat_track(y=y, sr=SR, units="time")
        return [float(b) for b in np.asarray(beats).ravel()]
    except Exception as e:  # noqa: BLE001
        log.info("sections: beat tracking failed (%s)", e)
        return []


def bar_grid(
    y: np.ndarray,
    *,
    rhythm_bars: Optional[list[tuple[float, float]]] = None,
    beats: Optional[list[float]] = None,
) -> tuple[list[tuple[float, float]], str]:
    """``(bars, source)`` — see the module comment for the order."""
    duration = y.size / SR
    if rhythm_bars and len(rhythm_bars) >= 2:
        return rhythm_bars, "rhythm"
    for source, bt in (("beats", beats or []), ("tracked", None)):
        if bt is None:
            if duration < 4.0:
                break
            bt = _tracked_beats(y)
        if len(bt) >= 9:
            bars = bars_from_beats(bt, 4, _downbeat_phase(y, bt))
            if len(bars) >= 2:
                return bars, source
    return time_grid(duration), "time"


def entry_stems(db: Any, entry_id: str, entry_dir: Path) -> dict[str, Path]:
    """The entry's separated stems on disk, by name."""
    from backend.modules.shards.extract import role_for

    try:
        rows = db.list_stems(entry_id)
    except Exception:  # noqa: BLE001
        rows = []
    found: dict[str, Path] = {}
    for r in rows:
        raw = str(r.get("audio_path") or "")
        name = str(r.get("stem_name") or "")
        if not raw or not name or name == "mix":
            continue
        p = Path(raw)
        if not p.is_absolute():
            p = entry_dir / raw
        if p.is_file():
            found[name] = p
    if any(role_for(n) == "drums" for n in found):
        found = {n: p for n, p in found.items() if role_for(n) not in _DRUM_PARTS}
    return found


def find_entry_sections(
    db: Any,
    entry_id: str,
    audio: Path,
    entry_dir: Path,
) -> dict[str, Any]:
    """Find the entry's sections, keep the user's edits, store them, fill
    the shard rows, and return the stored document."""
    t0 = time.time()
    y = _load_mono(audio)
    bars, source = bar_grid(
        y, rhythm_bars=_rhythm_bars(entry_id), beats=_analysis_beats(db, entry_id)
    )
    stem_paths = entry_stems(db, entry_id, entry_dir)
    stems: dict[str, np.ndarray] = {}
    for name, p in stem_paths.items():
        try:
            stems[name] = _load_mono(p)
        except Exception as e:  # noqa: BLE001 - one bad stem must not sink the run
            log.info("sections: stem %s unreadable (%s)", name, e)
    result = find_sections(y, bars, duration=y.size / SR, stems=stems or None)
    doc: dict[str, Any] = {
        "version": SECTIONS_VERSION,
        "entry_id": entry_id,
        "found_at": time.time(),
        "elapsed_sec": 0.0,
        "duration_sec": round(y.size / SR, 3),
        "grid": {"source": source, "bars": len(bars)},
        **result,
    }
    doc = store.carry_edits(store.read_sections(entry_id), doc)
    doc["elapsed_sec"] = round(time.time() - t0, 2)
    store.write_sections(entry_id, doc)
    fill_shard_sections(db, entry_id, doc)
    log.info(
        "sections: %s -> %d sections on %d %s bars in %.1fs",
        entry_id,
        len(doc["sections"]),
        len(bars),
        source,
        doc["elapsed_sec"],
    )
    return doc


def fill_shard_sections(db: Any, entry_id: str, doc: Optional[dict[str, Any]]) -> int:
    """Write each of the entry's shards' ``section``; returns how many rows
    changed. A database without the shard table is left alone."""
    try:
        return int(db.set_shard_sections(entry_id, store.spans_of(doc)))
    except Exception as e:  # noqa: BLE001 - the sections stand without shards
        log.info("sections: shard sections not written for %s (%s)", entry_id, e)
        return 0


def edit_entry_section(
    db: Any,
    entry_id: str,
    index: int,
    *,
    name: Optional[str] = None,
    role: Optional[str] = None,
) -> dict[str, Any]:
    """Rename and/or re-role one section; the edit is stored and the shards
    follow a role change. Raises ``LookupError`` when the entry has no
    sections."""
    doc = store.read_sections(entry_id)
    if doc is None:
        raise LookupError("no sections found for this entry yet")
    doc = store.edit_section(doc, index, name=name, role=role)
    store.write_sections(entry_id, doc)
    if role is not None:
        fill_shard_sections(db, entry_id, doc)
    return doc
