"""Lyrics service: the on-disk document, its artifact row, the plain-text
mirror, and the transcribe / align background jobs."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import tempfile
import time
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Optional

from backend.core.jobs import Job
from backend.modules.library.router import get_store
from backend.modules.vocal import transcription
from backend.modules.vocal.preprocess import isolation
from backend.modules.vocal.schema import Lyrics
from backend.modules.vocal.service import _lyrics_from_transcription

from . import lrc
from .align import align_words, normalize_token
from .derive import derive_untimed_doc
from .schema import (
    ARTIFACT_KIND,
    MIN_WORD_MS,
    LyricLine,
    LyricsDoc,
    LyricsStats,
    PutLyricsRequest,
    from_vocal_lyrics,
    join_lines,
    split_text,
    to_vocal_lyrics,
    words_for,
)

log = logging.getLogger(__name__)

DOC_FILENAME = "lyrics.json"
VOCAL_ARTIFACT_FILENAME = "vocal_metadata.json"
# The first N lyric words prime whisper when aligning pasted text.
PROMPT_WORDS = 200

_running: set[asyncio.Task] = set()


# ---- paths and documents ----------------------------------------------------


def artifact_id(entry_id: str) -> str:
    return f"{entry_id}__lyrics__lyrics"


def doc_path(entry_id: str) -> Optional[Path]:
    entry_dir = get_store()._dir_for(entry_id)
    return None if entry_dir is None else entry_dir / DOC_FILENAME


def load_doc(entry_id: str) -> Optional[LyricsDoc]:
    path = doc_path(entry_id)
    if path is None or not path.is_file():
        return None
    try:
        return LyricsDoc.model_validate(json.loads(path.read_text(encoding="utf-8")))
    except Exception as e:  # noqa: BLE001 - a corrupt file reads as absent
        log.warning("lyrics: %s unreadable: %s", path, e)
        return None


def get_bundle(entry_id: str) -> dict[str, Any]:
    store = get_store()
    if store.get_entry(entry_id) is None:
        raise KeyError(entry_id)
    doc = load_doc(entry_id)
    if doc is not None:
        return {"doc": doc.model_dump(), "persisted": True, "notes_candidate": None}
    derived, notes_candidate = derive_untimed_doc(store, entry_id)
    return {
        "doc": derived.model_dump(),
        "persisted": False,
        "notes_candidate": notes_candidate,
    }


def _norm_line(text: str) -> str:
    return " ".join(normalize_token(w) for w in text.split())


def _carry_over(old: list[LyricLine], new: list[LyricLine]) -> None:
    """Copy timings from ``old`` onto the lines of ``new`` that did not
    change (matched by normalized text, in order)."""
    matcher = SequenceMatcher(
        None,
        [_norm_line(ln.text) for ln in old],
        [_norm_line(ln.text) for ln in new],
        autojunk=False,
    )
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag != "equal":
            continue
        for oi, ni in zip(range(i1, i2), range(j1, j2)):
            src, dst = old[oi], new[ni]
            if dst.kind != "lyric":
                continue
            dst.start_ms = src.start_ms
            dst.end_ms = src.end_ms
            dst.confidence = src.confidence
            if len(src.words) == len(dst.words):
                for sw, dw in zip(src.words, dst.words):
                    dw.start_ms = sw.start_ms
                    dw.end_ms = sw.end_ms


def _apply_invariants(doc: LyricsDoc) -> None:
    floor: Optional[int] = None
    for line in doc.lines:
        if line.kind != "lyric":
            line.start_ms = None
            line.end_ms = None
            line.confidence = None
            line.words = []
            continue
        if not line.words and line.text.strip():
            line.words = words_for(line.text)
        if line.start_ms is not None:
            line.start_ms = max(0, int(line.start_ms))
            if floor is not None and line.start_ms < floor:
                line.start_ms = floor
            floor = line.start_ms
            if line.end_ms is not None and line.end_ms < line.start_ms + MIN_WORD_MS:
                line.end_ms = line.start_ms + MIN_WORD_MS
        elif line.end_ms is not None:
            line.end_ms = None
        for word in line.words:
            if word.start_ms is None:
                word.end_ms = None
                continue
            word.start_ms = max(0, int(word.start_ms))
            if line.start_ms is not None and word.start_ms < line.start_ms:
                word.start_ms = line.start_ms
            if line.end_ms is not None and word.start_ms > line.end_ms:
                word.start_ms = line.end_ms
            if word.end_ms is not None:
                if word.end_ms < word.start_ms + MIN_WORD_MS:
                    word.end_ms = word.start_ms + MIN_WORD_MS
                if line.end_ms is not None and word.end_ms > line.end_ms:
                    word.end_ms = max(line.end_ms, word.start_ms + MIN_WORD_MS)
    doc.text = join_lines(doc.lines)


def normalize_doc(
    entry_id: str, req: PutLyricsRequest, existing: Optional[LyricsDoc]
) -> LyricsDoc:
    doc = existing.model_copy(deep=True) if existing else LyricsDoc(entry_id=entry_id)
    doc.entry_id = entry_id
    if req.lines is not None:
        doc.lines = [ln.model_copy(deep=True) for ln in req.lines]
    elif req.text is not None:
        new_lines = split_text(req.text)
        if existing is not None:
            _carry_over(existing.lines, new_lines)
        doc.lines = new_lines
    if req.offset_ms is not None:
        doc.offset_ms = int(req.offset_ms)
    if req.language:
        doc.language = req.language
    if req.source is not None:
        doc.source = req.source
    elif req.text is not None and not doc.source:
        doc.source = "manual"
    _apply_invariants(doc)
    doc.updated_at = time.time()
    return doc


def _atomic_write(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def save_doc(doc: LyricsDoc) -> LyricsDoc:
    store = get_store()
    path = doc_path(doc.entry_id)
    if path is None:
        raise KeyError(doc.entry_id)
    _atomic_write(path, doc.model_dump())
    timed = sum(1 for ln in doc.lines if ln.kind == "lyric" and ln.start_ms is not None)
    if store.db is not None:
        try:
            store.db.add_notation_artifact(
                artifact_id=artifact_id(doc.entry_id),
                entry_id=doc.entry_id,
                kind=ARTIFACT_KIND,
                path=str(path),
                engine="lyrics",
                engine_version="1",
                metadata={
                    "source": doc.source,
                    "timed_lines": timed,
                    "total_lines": len(doc.lines),
                },
            )
        except Exception as e:  # noqa: BLE001 - the file is the truth; the row is a cache
            log.warning("lyrics: artifact row failed for %s: %s", doc.entry_id, e)
    record = store.get_entry(doc.entry_id)
    if record is not None and (record.lyrics or "") != doc.text:
        store.update_entry(doc.entry_id, {"lyrics": doc.text})
    return doc


def delete_doc(entry_id: str) -> bool:
    store = get_store()
    if store.get_entry(entry_id) is None:
        raise KeyError(entry_id)
    path = doc_path(entry_id)
    removed = False
    if path is not None and path.is_file():
        path.unlink()
        removed = True
    if store.db is not None:
        try:
            removed = (
                store.db.delete_notation_artifact(artifact_id(entry_id)) or removed
            )
        except Exception as e:  # noqa: BLE001
            log.warning("lyrics: artifact row delete failed for %s: %s", entry_id, e)
    return removed


def import_doc(entry_id: str, fmt: str, content: str) -> LyricsDoc:
    existing = load_doc(entry_id)
    if fmt == "lrc":
        parsed = lrc.parse_lrc(content)
        req = PutLyricsRequest(
            lines=parsed.lines, offset_ms=parsed.offset_ms, source="lrc"
        )
    else:
        req = PutLyricsRequest(text=content, source="manual")
    return save_doc(normalize_doc(entry_id, req, existing))


def _song_slug(title: str, fallback: str = "lyrics") -> str:
    cleaned = "".join(c if (c.isalnum() or c in " -_") else "_" for c in (title or ""))
    cleaned = "_".join(cleaned.split()).strip("_-")
    return cleaned[:60] or fallback


def _artist() -> str:
    try:
        from backend.modules.notation.engine import artist_name

        return artist_name()
    except Exception:  # noqa: BLE001 - the credit is optional
        return ""


def export_text(entry_id: str, fmt: str, words: bool) -> tuple[str, str]:
    """``(content, filename)``; raises KeyError when the entry is unknown or
    has no lyrics at all."""
    store = get_store()
    record = store.get_entry(entry_id)
    if record is None:
        raise KeyError(entry_id)
    doc = load_doc(entry_id)
    if doc is None:
        doc, _ = derive_untimed_doc(store, entry_id)
    if not doc.text.strip():
        raise KeyError(entry_id)
    slug = _song_slug(record.title)
    if fmt == "lrc":
        duration_ms = int(record.duration * 1000) if record.duration else None
        return (
            lrc.format_lrc(
                doc,
                title=record.title,
                artist=_artist(),
                duration_ms=duration_ms,
                words=words,
            ),
            f"{slug}.lrc",
        )
    return lrc.format_txt(doc), f"{slug}.txt"


# ---- vocal artifact interplay -----------------------------------------------


def seed_from_vocal_artifact(entry_id: str, art: dict[str, Any]) -> None:
    """After a transcribing ``prepare``, write lyrics.json once from the
    artifact's words. Never overwrites an existing document."""
    if load_doc(entry_id) is not None:
        return
    lyrics = Lyrics.model_validate(art.get("lyrics") or {})
    if not lyrics.words:
        return
    doc = from_vocal_lyrics(entry_id, lyrics)
    _apply_invariants(doc)
    doc.updated_at = time.time()
    save_doc(doc)


def write_back_to_vocal_artifact(entry_id: str, doc: LyricsDoc) -> bool:
    """Replace the ``lyrics`` block of ``vocal_metadata.json`` in place (no new
    artifact rows). Returns False when there is no artifact to update."""
    entry_dir = get_store()._dir_for(entry_id)
    if entry_dir is None:
        return False
    path = entry_dir / VOCAL_ARTIFACT_FILENAME
    if not path.is_file():
        return False
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        log.warning("lyrics: vocal artifact unreadable for %s: %s", entry_id, e)
        return False
    payload["lyrics"] = to_vocal_lyrics(doc).model_dump()
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    try:
        from backend.modules.vocal import service as vocal_service

        if entry_id in vocal_service._artifacts:
            vocal_service._artifacts[entry_id] = payload
    except Exception:  # noqa: BLE001 - the in-memory cache is optional
        pass
    return True


# ---- jobs --------------------------------------------------------------------


def _track(task: asyncio.Task) -> None:
    _running.add(task)
    task.add_done_callback(_running.discard)


def start_transcribe(job: Job, entry_id: str, req: dict[str, Any]) -> None:
    _track(asyncio.create_task(run_transcribe(job, entry_id, req)))


def start_align(job: Job, entry_id: str, req: dict[str, Any]) -> None:
    _track(asyncio.create_task(run_align(job, entry_id, req)))


def _vocal_stem_paths(entry_id: str) -> list[Path]:
    """Every stem of the entry whose name says vocal (``vocals``,
    ``lead_vocals``, ``backup_vocals`` ...), lead first, files that exist."""
    store = get_store()
    if store.db is None:
        return []
    try:
        rows = store.db.list_stems(entry_id)
    except Exception as e:  # noqa: BLE001
        log.info("lyrics: stems lookup failed for %s: %s", entry_id, e)
        return []
    found: list[tuple[int, str, Path]] = []
    for row in rows:
        name = str(row.get("stem_name", "")).lower()
        if "vocal" not in name and "vox" not in name:
            continue
        p = Path(str(row.get("audio_path", "")))
        if not p.is_file():
            continue
        rank = 0 if name in ("vocals", "vocal", "lead_vocals", "lead") else 1
        found.append((rank, name, p))
    found.sort(key=lambda t: (t[0], t[1]))
    return [p for _, _, p in found]


def _mix_stems(paths: list[Path], out: Path) -> Path:
    """Sum several stems (lead + backup vocals) into one mono file for
    whisper, peak-normalised. Falls back to the first stem on any error."""
    if len(paths) == 1:
        return paths[0]
    try:
        import numpy as np
        import soundfile as sf

        mix = None
        rate = 0
        for p in paths:
            data, sr = sf.read(str(p), dtype="float32", always_2d=True)
            mono = data.mean(axis=1)
            if mix is None:
                mix, rate = mono, sr
                continue
            if sr != rate:
                log.info(
                    "lyrics: stem %s has rate %d, expected %d; skipped",
                    p.name,
                    sr,
                    rate,
                )
                continue
            n = min(len(mix), len(mono))
            mix = mix[:n] + mono[:n]
        if mix is None or rate <= 0:
            return paths[0]
        peak = float(np.max(np.abs(mix))) if len(mix) else 0.0
        if peak > 0:
            mix = mix * (0.9 / peak)
        sf.write(str(out), mix, rate, subtype="PCM_16")
        return out
    except Exception as e:  # noqa: BLE001 - one stem beats no stem
        log.info("lyrics: stem mix failed (%s); using %s", e, paths[0].name)
        return paths[0]


def _stems_available() -> bool:
    """Is the Demucs stems sidecar installed and importable? Never raises."""
    try:
        from backend.modules.stems.sidecar import probe

        return bool(probe().get("ok"))
    except Exception as e:  # noqa: BLE001
        log.info("lyrics: stems probe failed: %s", e)
        return False


async def _separate_stems(entry_id: str) -> None:
    """Run the built-in stemmer (4 stems) so a vocals stem exists."""
    from backend.modules.stems.engine import separate_entry

    store = get_store()
    src = store.get_audio_path(entry_id)
    entry_dir = store._dir_for(entry_id)
    if store.db is None or src is None or entry_dir is None:
        raise RuntimeError("library DB or audio missing")
    await separate_entry(store.db, entry_id, Path(src), entry_dir, stems=4)


async def _resolve_vocal_audio(
    entry_id: str, work: Path, isolate: bool, job: Optional[Job] = None
) -> tuple[Path, str]:
    """The cleanest vocal we can get, in order: the entry's vocal stems (lead
    and backup mixed together); the stemmer run now when it is installed and
    ``isolate`` is on; the mid/side isolation of the mix into ``work``; the
    mix itself."""
    store = get_store()
    stems = _vocal_stem_paths(entry_id)
    if stems:
        return _mix_stems(stems, work / "vocals_mix.wav"), "stem"
    src = store.get_audio_path(entry_id)
    if src is None or not Path(src).is_file():
        raise FileNotFoundError(f"no audio for entry {entry_id}")
    src = Path(src)
    if not isolate:
        return src, "mix"
    if _stems_available():
        if job is not None:
            job.update(
                progress=0.1, message="separating stems (Demucs) for a clean vocal"
            )
        try:
            await _separate_stems(entry_id)
            stems = _vocal_stem_paths(entry_id)
            if stems:
                return _mix_stems(stems, work / "vocals_mix.wav"), "stem"
        except Exception as e:  # noqa: BLE001 - fall back to the light isolation
            log.info("lyrics: stem separation skipped for %s: %s", entry_id, e)
    isolated = await isolation.isolate(src, work / "isolated.wav")
    if isolated == src:
        return src, "mix"
    cleaned = await isolation.cleanup(isolated, work / "cleaned.wav")
    return cleaned, "isolate"


def _frame_ratio(src: Path, cur: Path) -> float:
    if src == cur:
        return 1.0
    try:
        import soundfile as sf

        a = sf.info(str(src))
        b = sf.info(str(cur))
        if a.frames <= 0 or b.frames <= 0:
            return 1.0
        return (a.frames / a.samplerate) / (b.frames / b.samplerate)
    except Exception:  # noqa: BLE001
        return 1.0


def _duration_ms(entry_id: str, path: Path) -> int:
    record = get_store().get_entry(entry_id)
    if record is not None and record.duration:
        return int(record.duration * 1000)
    try:
        import soundfile as sf

        info = sf.info(str(path))
        return int(info.frames / max(1, info.samplerate) * 1000)
    except Exception:  # noqa: BLE001
        return 0


def _language_for_request(language: Optional[str]) -> str:
    """``auto`` (or empty) asks whisper to detect; anything else is a code."""
    code = str(language or "").strip().lower()
    return code if code and code != "auto" else "auto"


def _language_detected(res: dict[str, Any], requested: str) -> str:
    """The code to store on the document: whisper's detection when the request
    was ``auto``, else the requested code."""
    detected = str(res.get("language") or "").strip().lower()
    if requested != "auto":
        return requested
    return detected or "en"


def _asr_words(res: dict[str, Any], scale: float) -> list[dict[str, Any]]:
    words: list[dict[str, Any]] = []
    for seg in res.get("segments", []) or []:
        for w in seg.get("words", []) or []:
            if w.get("start") is None or w.get("end") is None:
                continue
            words.append(
                {
                    "word": w.get("word") or "",
                    "start": float(w["start"]) * scale,
                    "end": float(w["end"]) * scale,
                }
            )
    return words


async def run_transcribe(job: Job, entry_id: str, req: dict[str, Any]) -> None:
    try:
        job.update(status="running", progress=0.05, message="resolving vocal")
        language = _language_for_request(req.get("language"))
        with tempfile.TemporaryDirectory() as td:
            path, audio_source = await _resolve_vocal_audio(
                entry_id, Path(td), bool(req.get("isolate", True)), job
            )
            job.update(
                progress=0.2, message="transcribing (first run installs whisper)"
            )
            res = await transcription.transcribe(
                path,
                language,
                extra={"condition_on_previous_text": False, "vad_filter": True},
            )
        if not res.get("ok"):
            raise RuntimeError(str(res.get("error") or "transcription failed"))
        job.update(progress=0.9, message="saving")
        language = _language_detected(res, language)
        doc = from_vocal_lyrics(entry_id, _lyrics_from_transcription(res, language))
        doc.language = language
        existing = load_doc(entry_id)
        if existing is not None:
            doc.offset_ms = existing.offset_ms
        doc.source = "transcribed"
        doc.stats = LyricsStats(
            matched=sum(len(ln.words) for ln in doc.lines),
            total=sum(len(ln.words) for ln in doc.lines),
            asr_words=sum(len(ln.words) for ln in doc.lines),
            audio_source=audio_source,
        )
        _apply_invariants(doc)
        doc.updated_at = time.time()
        save_doc(doc)
        if bool(req.get("sync_vocal")):
            write_back_to_vocal_artifact(entry_id, doc)
        job.result = doc.model_dump()
        job.update(status="done", progress=1.0, message="lyrics transcribed")
    except Exception as e:  # noqa: BLE001 - the job reports every failure
        log.exception("lyrics transcribe failed")
        job.error = repr(e)
        job.update(status="failed", message=str(e))


async def run_align(job: Job, entry_id: str, req: dict[str, Any]) -> None:
    try:
        job.update(status="running", progress=0.05, message="resolving vocal")
        language = _language_for_request(req.get("language"))
        existing = load_doc(entry_id)
        text = req.get("text")
        if not text:
            if existing is not None and existing.text.strip():
                text = existing.text
            else:
                derived, _ = derive_untimed_doc(get_store(), entry_id)
                text = derived.text
        if not str(text or "").strip():
            raise RuntimeError("no lyrics to align: paste or transcribe them first")
        base_lines = split_text(str(text))
        lyric_words = [
            w for ln in base_lines if ln.kind == "lyric" for w in ln.text.split()
        ]
        with tempfile.TemporaryDirectory() as td:
            path, audio_source = await _resolve_vocal_audio(
                entry_id, Path(td), bool(req.get("isolate", True)), job
            )
            src = get_store().get_audio_path(entry_id)
            scale = _frame_ratio(Path(src), path) if src else 1.0
            if abs(scale - 1.0) > 1e-3:
                log.info("lyrics: rescaling ASR times by %.4f for %s", scale, entry_id)
            duration_ms = _duration_ms(entry_id, Path(src) if src else path)
            job.update(
                progress=0.2, message="transcribing (first run installs whisper)"
            )
            res = await transcription.transcribe(
                path,
                language,
                extra={
                    "initial_prompt": " ".join(lyric_words[:PROMPT_WORDS]),
                    "condition_on_previous_text": False,
                    "vad_filter": False,
                },
            )
        if not res.get("ok"):
            raise RuntimeError(str(res.get("error") or "transcription failed"))
        job.update(progress=0.85, message="aligning")
        lines, stats = align_words(base_lines, _asr_words(res, scale), duration_ms)
        stats.audio_source = audio_source
        doc = LyricsDoc(
            entry_id=entry_id,
            language=_language_detected(res, language),
            source="aligned",
            offset_ms=existing.offset_ms if existing else 0,
            lines=lines,
            stats=stats,
        )
        _apply_invariants(doc)
        doc.updated_at = time.time()
        save_doc(doc)
        if bool(req.get("sync_vocal")):
            write_back_to_vocal_artifact(entry_id, doc)
        job.result = doc.model_dump()
        job.update(
            status="done",
            progress=1.0,
            message=f"aligned {stats.matched}/{stats.total} words",
        )
    except Exception as e:  # noqa: BLE001
        log.exception("lyrics align failed")
        job.error = repr(e)
        job.update(status="failed", message=str(e))
