"""Orchestrate the analysis steps for a single library entry.

Read settings to decide what to run, run each step (ffprobe, tempo,
key, pitch, bars, rms), then write results to:

  - SQLite ``analysis`` table (one row per entry)
  - metadata.json next to the audio file (durable backup)
  - Update the entry's ``analysis_status`` field on the entries row

This module is callable from sync code; the BackgroundQueue wraps it in
an async shim. We deliberately avoid asyncio inside the engine so it can
also be invoked directly from a manual ``/run`` endpoint.
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any, Optional

from backend.modules.library.db import LibraryDB

from .bars import estimate_bars, estimate_rms_db
from .ffprobe import probe_file
from .key import detect_key
from .pitch import detect_pitch_stats

log = logging.getLogger(__name__)


# Bump when the analysis pipeline changes in a way that should re-run already-
# analyzed tracks. v2: tempo now falls back to librosa so MP3s actually get a
# BPM (v1 rows persisted bpm=null because aubio can't open MP3). The GET
# endpoint reports version<ANALYSIS_VERSION rows as 'pending' so they re-run.
ANALYSIS_VERSION = 2


def analyze_audio(
    audio_path: Path,
    *,
    include_key: bool = True,
    include_pitch: bool = True,
    include_genre: bool = False,
    include_prompt: bool = True,
) -> dict[str, Any]:
    """Pure analysis call — runs the configured steps, returns a flat
    dict. Idempotent; doesn't touch any persistence."""
    p = Path(audio_path)
    if not p.is_file():
        return {"error": "audio not found"}

    out: dict[str, Any] = {
        "version": ANALYSIS_VERSION,
        "analyzed_at": time.time(),
    }

    # ffprobe summary (sample rate, bit depth, codec, duration, ...)
    probe = probe_file(p)
    out["ffprobe"] = probe
    summary = probe.get("_summary") or {}
    out["sample_rate"] = summary.get("sample_rate")
    out["channels"] = summary.get("channels")
    out["bit_depth"] = summary.get("bit_depth")
    out["codec"] = summary.get("codec")
    out["container"] = summary.get("container")
    duration_sec = summary.get("duration_sec")
    if duration_sec is not None:
        out["duration_sec"] = float(duration_sec)

    # Tempo + beats (reuse chimera detector — it's the single source of
    # truth for BPM in this codebase).
    try:
        from backend.modules.chimera.detect import detect_tempo_and_beats

        tempo = detect_tempo_and_beats(p)
        out["bpm"] = tempo["bpm"]
        out["beats"] = list(tempo["beats"])
    except Exception as e:
        log.info("analysis.engine: tempo failed for %s: %s", p.name, e)
        out["bpm"] = None
        out["beats"] = []

    out["bars_estimated"] = estimate_bars(out.get("beats") or [])
    out["rms_db"] = estimate_rms_db(p)

    if include_key:
        out.update(detect_key(p))
    if include_pitch:
        out.update(detect_pitch_stats(p))
    if include_genre:
        # Reserved — see plan §4.1. Heavy HF dep; skipping for now.
        out["genre"] = None
        out["genre_confidence"] = None

    if include_prompt:
        # Deterministic semantic tags + a Stable Audio-style prompt from the
        # numbers above. Cheap and pure; ML genre/mood enrichers (when added)
        # fold in via the ``genre`` field and embedded tags at persist time.
        from .prompt import generate_prompt

        generated = generate_prompt(out)
        out["prompt_guess"] = generated["prompt_guess"]
        out["prompt_confidence"] = generated["prompt_confidence"]
        out["semantic_tags"] = generated["semantic_tags"]

    return out


def persist_analysis(
    db: LibraryDB,
    entry_id: str,
    payload: dict[str, Any],
    *,
    metadata_path: Optional[Path] = None,
    embedded_tags: Optional[dict[str, Any]] = None,
) -> None:
    """Write analysis payload to SQLite + (optionally) the per-entry
    metadata.json so the data is portable even if the DB is wiped."""
    db_payload = {
        "bpm": payload.get("bpm"),
        "beats": payload.get("beats") or [],
        "key": payload.get("key"),
        "key_confidence": payload.get("confidence")
        if "confidence" in payload and "key" in payload
        else payload.get("key_confidence"),
        "scale": payload.get("scale"),
        "pitch_mean_hz": payload.get("pitch_mean_hz"),
        "pitch_std_hz": payload.get("pitch_std_hz"),
        "loudness_lufs": payload.get("loudness_lufs"),
        "rms_db": payload.get("rms_db"),
        "bars_estimated": payload.get("bars_estimated"),
        "genre": payload.get("genre"),
        "genre_confidence": payload.get("genre_confidence"),
        "prompt_guess": payload.get("prompt_guess"),
        "prompt_confidence": payload.get("prompt_confidence"),
        "semantic_tags": payload.get("semantic_tags") or [],
        "embedded_tags": embedded_tags or {},
        "ffprobe": payload.get("ffprobe") or {},
        "version": payload.get("version") or ANALYSIS_VERSION,
    }
    db.upsert_analysis(entry_id, db_payload)

    if metadata_path is not None and metadata_path.is_file():
        try:
            meta = json.loads(metadata_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            meta = {}
        meta["analysis"] = {
            k: v for k, v in payload.items() if k != "ffprobe" and k != "beats"
        }
        meta["analysis"]["beats_count"] = len(payload.get("beats") or [])
        try:
            tmp = metadata_path.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(meta, indent=2), encoding="utf-8")
            tmp.replace(metadata_path)
        except OSError as e:
            log.warning(
                "analysis.engine: failed to write metadata.json for %s: %s",
                entry_id,
                e,
            )


def analyze_and_persist(
    db: LibraryDB,
    entry_id: str,
    audio_path: Path,
    *,
    metadata_path: Optional[Path] = None,
    settings: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """End-to-end: run analysis, persist to DB + metadata.json, update
    the entry's ``analysis_status`` to 'complete'.

    Returns the full analysis payload (useful for the manual /run
    endpoint to echo back to the caller)."""
    settings = settings or {}
    include_key = bool(settings.get("include_key", True))
    include_genre = bool(settings.get("include_genre", False))

    # Some library rows are derived/variant entries (e.g. "<id>_00") that are
    # listed but have no row in `entries`; persisting analysis for them violates
    # the analysis→entries foreign key. Detect that up front so we still COMPUTE
    # + return the analysis (the UI gets BPM/key) but skip the DB write instead
    # of raising a 500.
    entry_exists = db.get_entry(entry_id) is not None

    # Mark running so the UI can show a chip.
    if entry_exists:
        _set_status(db, entry_id, "running")
    try:
        payload = analyze_audio(
            audio_path,
            include_key=include_key,
            include_pitch=True,
            include_genre=include_genre,
        )
        if not entry_exists:
            log.info(
                "analysis.engine: %s has no entries row (derived/variant?) — "
                "computed analysis but not persisting",
                entry_id,
            )
            return payload
        # Pull embedded tags from metadata.json if present so we
        # persist them alongside analysis (keeps everything in one
        # place for downstream lineage / dataset export).
        embedded: dict[str, Any] = {}
        if metadata_path and metadata_path.is_file():
            try:
                m = json.loads(metadata_path.read_text(encoding="utf-8"))
                if isinstance(m.get("embedded_tags"), dict):
                    embedded = m["embedded_tags"]
            except (OSError, json.JSONDecodeError):
                pass

        # Fold any embedded tags into a richer prompt than the analysis-only
        # baseline computed in analyze_audio.
        if embedded:
            from .prompt import generate_prompt

            entry_row = db.get_entry(entry_id) or {}
            regenerated = generate_prompt(
                payload,
                embedded_tags=embedded,
                title=str(entry_row.get("title") or ""),
            )
            payload["prompt_guess"] = regenerated["prompt_guess"]
            payload["prompt_confidence"] = regenerated["prompt_confidence"]
            payload["semantic_tags"] = regenerated["semantic_tags"]

        persist_analysis(
            db,
            entry_id,
            payload,
            metadata_path=metadata_path,
            embedded_tags=embedded,
        )
        _set_status(db, entry_id, "complete")
        return payload
    except Exception as e:
        log.warning("analysis.engine: failed for %s: %s", entry_id, e)
        _set_status(db, entry_id, "failed")
        raise


def _set_status(db: LibraryDB, entry_id: str, status: str) -> None:
    try:
        # Lightweight UPDATE: we don't go through upsert_entry because
        # we don't want to rewrite every column.
        with db._txn() as cur:  # noqa: SLF001 — intentional internal use
            cur.execute(
                "UPDATE entries SET analysis_status = ?, updated_at = ? WHERE id = ?",
                (status, time.time(), entry_id),
            )
    except Exception as e:
        log.debug(
            "analysis.engine: status update failed for %s -> %s: %s",
            entry_id,
            status,
            e,
        )
