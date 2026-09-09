"""Standalone lyric documents: the notebook the LYRIC tab writes in.

A lyric here belongs to no library entry. It is written, edited and analysed on
its own, and only becomes a song's lyrics when the writer attaches it — which
is the reverse of the per-entry path in ``service.py``, where the analysis is
derived from a song that already exists.

Files live under ``data/lyric-documents`` (``theDAW_LYRIC_DOCS_DIR`` overrides
the directory), one JSON per document, with the stored analysis in an
``analysis/`` subdirectory so listing the notebook never has to parse a
thousand device spans. Every write stages into a tmp file of its own and then
renames, under a per-file lock, so two saves of one draft cannot interleave —
see ``_atomic_write``.

Ids are minted here and NEVER taken from a request: ``is_document_id`` is the
only gate, and it accepts exactly ``lyricdoc_`` plus 32 hex characters. That is
what makes ``documents_dir() / f"{doc_id}.json"`` safe — no traversal, no
absolute path, no NUL byte, no overlong name and no unicode can reach the
filesystem, because none of them are that shape.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Optional

from backend.core.jobs import Job

from .schema import (
    CreateLyricDocumentRequest,
    ImportLyricDocumentRequest,
    LyricAnalysisDoc,
    LyricDocument,
    LyricDocumentSummary,
    UpdateLyricDocumentRequest,
)

log = logging.getLogger(__name__)

DIRNAME = "lyric-documents"
ANALYSIS_DIRNAME = "analysis"
ID_PREFIX = "lyricdoc_"
_ID_RE = re.compile(r"^lyricdoc_[0-9a-f]{32}$")
DEFAULT_TITLE = "Untitled"
# The title is metadata, never a filename, so it only needs a sane bound.
MAX_TITLE = 120


def documents_dir() -> Path:
    """``<project>/data/lyric-documents``; ``theDAW_LYRIC_DOCS_DIR`` wins."""
    configured = os.getenv("theDAW_LYRIC_DOCS_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    project_root = Path(__file__).resolve().parents[3]
    return project_root / "data" / DIRNAME


def new_id() -> str:
    return f"{ID_PREFIX}{uuid.uuid4().hex}"


# The switcher is ordered newest-first, and on Windows ``time.time()`` moves in
# ~15 ms steps: two documents saved in the same tick get byte-identical stamps,
# the sort falls back to whatever order the directory happened to be read in,
# and "newest" becomes a coin toss (a list test caught it flickering). Stamps
# are therefore handed out strictly increasing. They stay honest wall-clock
# times — the nudge is a microsecond — and the counter is seeded from the
# newest stamp already on disk so the guarantee survives a restart.
_stamp_lock = threading.Lock()
_last_stamp = 0.0
_stamp_seeded = False


def _seed_stamp() -> None:
    """Read the newest stamp on disk once, so a restart cannot hand out a
    stamp behind a document written by the previous run."""
    global _last_stamp, _stamp_seeded
    newest = 0.0
    try:
        for path in documents_dir().glob("*.json"):
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
            except Exception:  # noqa: BLE001 - a corrupt file just has no stamp
                continue
            stamp = raw.get("updated_at")
            if isinstance(stamp, (int, float)) and stamp > newest:
                newest = float(stamp)
    except OSError:
        pass
    _last_stamp = max(_last_stamp, newest)
    _stamp_seeded = True


def now_stamp() -> float:
    """Wall-clock, never equal to or behind the last stamp handed out."""
    global _last_stamp
    with _stamp_lock:
        if not _stamp_seeded:
            _seed_stamp()
        now = time.time()
        if now <= _last_stamp:
            now = _last_stamp + 1e-6
        _last_stamp = now
        return now


def is_document_id(doc_id: Any) -> bool:
    """True only for an id this module minted. Everything else — an entry id,
    ``../``, an absolute path, a NUL byte, unicode — is not a document."""
    return isinstance(doc_id, str) and _ID_RE.match(doc_id) is not None


def _doc_path(doc_id: str) -> Path:
    if not is_document_id(doc_id):
        raise KeyError(doc_id)
    return documents_dir() / f"{doc_id}.json"


def _analysis_path(doc_id: str) -> Path:
    if not is_document_id(doc_id):
        raise KeyError(doc_id)
    return documents_dir() / ANALYSIS_DIRNAME / f"{doc_id}.json"


# One lock per file, so the read-modify-write in ``update`` and the write in
# ``save`` cannot interleave for the same document. The routes are sync ``def``
# handlers, which FastAPI runs in a threadpool: two saves of one draft (two
# windows, or a keystroke landing while the previous PUT is still writing) are
# genuinely concurrent.
_write_locks_guard = threading.Lock()
_write_locks: dict[str, threading.RLock] = {}


def _write_lock(path: Path) -> threading.RLock:
    key = str(path)
    with _write_locks_guard:
        lock = _write_locks.get(key)
        if lock is None:
            lock = threading.RLock()
            _write_locks[key] = lock
        return lock


def _atomic_write(path: Path, payload: dict[str, Any]) -> None:
    """Write through a tmp file nobody else can be holding, then rename.

    The tmp name carries a nonce rather than being ``<id>.json.tmp``: a shared
    staging name is not atomic at all, because two writers truncate and fill
    the SAME file and the rename then publishes their interleaved bytes. That
    leaves a draft as unparseable JSON, and ``load`` reads unparseable as
    absent — the words are gone from the notebook with no error anywhere.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
    with _write_lock(path):
        try:
            tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
            # Windows fails the rename while any other handle has either file
            # open — a concurrent reader is enough. The write itself is done;
            # only the publish needs the retry.
            for attempt in range(12):
                try:
                    os.replace(tmp, path)
                    return
                except PermissionError:
                    if attempt == 11:
                        raise
                    time.sleep(0.02)
        finally:
            try:
                tmp.unlink()
            except OSError:
                pass


def _clean_title(title: str) -> str:
    return " ".join(str(title or "").split())[:MAX_TITLE]


# ---- documents ---------------------------------------------------------------


def load(doc_id: str) -> Optional[LyricDocument]:
    """The document, or None when there is none (a corrupt file reads as
    absent, the way every other document store here treats one)."""
    if not is_document_id(doc_id):
        return None
    path = _doc_path(doc_id)
    if not path.is_file():
        return None
    try:
        return LyricDocument.model_validate(
            json.loads(path.read_text(encoding="utf-8"))
        )
    except Exception as e:  # noqa: BLE001 - a corrupt file reads as absent
        log.warning("lyricanalysis: document %s unreadable: %s", path, e)
        return None


def save(doc: LyricDocument) -> LyricDocument:
    doc.updated_at = now_stamp()
    _atomic_write(_doc_path(doc.id), doc.model_dump())
    return doc


def _counts(text: str) -> tuple[int, int]:
    """``(lyric lines, words)`` counted the way the analysis counts them."""
    from backend.modules.lyrics.schema import split_text

    lines = [ln for ln in split_text(text) if ln.kind == "lyric" and ln.text.strip()]
    return len(lines), sum(len(ln.text.split()) for ln in lines)


def summarize(doc: LyricDocument) -> LyricDocumentSummary:
    lines, words = _counts(doc.text)
    return LyricDocumentSummary(
        id=doc.id,
        title=doc.title or DEFAULT_TITLE,
        updated_at=doc.updated_at,
        created_at=doc.created_at,
        lines=lines,
        words=words,
        entry_id=doc.entry_id or None,
        analyzed=_analysis_path(doc.id).is_file(),
    )


# path -> (mtime_ns, size, summary). Summarising is the expensive half of a
# listing: ``_counts`` runs the real ``split_text`` over every word of every
# draft, so an unbounded notebook turns filling in a dropdown into an
# O(everything you have ever written) call — and the tab re-lists after every
# NEW, DUPLICATE, DELETE, SAVE TO SONG and detach, when only one file moved.
# Keyed on the file's own stat, so any write invalidates exactly its own row.
# ``analyzed`` is NOT cached: the analysis lands in a different file and leaves
# the document's mtime alone.
_summary_cache: dict[str, tuple[int, int, LyricDocumentSummary]] = {}


def list_documents() -> list[LyricDocumentSummary]:
    """Every document, most recently edited first."""
    root = documents_dir()
    if not root.is_dir():
        return []
    rows: list[LyricDocumentSummary] = []
    seen: set[str] = set()
    for path in root.glob(f"{ID_PREFIX}*.json"):
        doc_id = path.stem
        if not is_document_id(doc_id):
            continue
        try:
            stat = path.stat()
        except OSError:
            continue
        key = str(path)
        seen.add(key)
        stamp = (stat.st_mtime_ns, stat.st_size)
        cached = _summary_cache.get(key)
        if cached is not None and cached[:2] == stamp:
            row = cached[2]
        else:
            doc = load(doc_id)
            if doc is None:
                _summary_cache.pop(key, None)
                continue
            row = summarize(doc)
            _summary_cache[key] = (stamp[0], stamp[1], row)
        analyzed = _analysis_path(doc_id).is_file()
        rows.append(
            row
            if row.analyzed == analyzed
            else row.model_copy(update={"analyzed": analyzed})
        )
    for gone in set(_summary_cache) - seen:
        _summary_cache.pop(gone, None)
    # Total order: the id breaks a tie that survived the monotonic stamp
    # (documents written by an older build, or copied in by hand).
    rows.sort(key=lambda r: (r.updated_at, r.created_at, r.id), reverse=True)
    return rows


def create(req: CreateLyricDocumentRequest) -> LyricDocument:
    if req.entry_id and _entry_title(req.entry_id) is None:
        raise KeyError(req.entry_id)
    now = now_stamp()
    doc = LyricDocument(
        id=new_id(),
        title=_clean_title(req.title) or DEFAULT_TITLE,
        text=req.text or "",
        language=req.language or "en",
        entry_id=req.entry_id or "",
        created_at=now,
    )
    return save(doc)


def update(doc_id: str, req: UpdateLyricDocumentRequest) -> LyricDocument:
    """Apply the fields the request carries. Raises KeyError when there is no
    such document, or when a non-empty ``entry_id`` names no library entry."""
    # The whole read-modify-write under the document's own lock, so a
    # concurrent save cannot land between the load and the write.
    with _write_lock(_doc_path(doc_id)):
        doc = load(doc_id)
        if doc is None:
            raise KeyError(doc_id)
        if req.title is not None:
            doc.title = _clean_title(req.title) or DEFAULT_TITLE
        if req.text is not None:
            doc.text = req.text
        if req.language is not None and req.language.strip():
            doc.language = req.language.strip()
        # An empty string is a real value here: it detaches the draft from its
        # song. Anything else must name a song that exists, or this PUT would
        # be a way around ``attach``'s check and leave the draft claiming a
        # library entry nobody can open.
        if req.entry_id is not None:
            if req.entry_id and _entry_title(req.entry_id) is None:
                raise KeyError(req.entry_id)
            doc.entry_id = req.entry_id
        return save(doc)


def delete(doc_id: str) -> bool:
    """Remove the document and its stored analysis. False when there was none."""
    if not is_document_id(doc_id):
        return False
    removed = False
    for path in (_doc_path(doc_id), _analysis_path(doc_id)):
        if path.is_file():
            path.unlink()
            removed = True
    return removed


def duplicate(doc_id: str) -> LyricDocument:
    """A copy of the draft, unattached: a variation is not the same song's
    lyrics until the writer says it is."""
    src = load(doc_id)
    if src is None:
        raise KeyError(doc_id)
    return create(
        CreateLyricDocumentRequest(
            title=f"{src.title or DEFAULT_TITLE} copy",
            text=src.text,
            language=src.language,
        )
    )


# ---- the library entry a draft can become ------------------------------------


def _entry_title(entry_id: str) -> Optional[str]:
    from backend.modules.library.router import get_store

    record = get_store().get_entry(entry_id)
    return None if record is None else str(getattr(record, "title", "") or "")


def attach(doc_id: str, entry_id: str, write_lyrics: bool = False) -> LyricDocument:
    """Link the draft to a library entry, optionally writing the words into
    that entry's own lyrics document. Raises KeyError for an unknown document
    or entry."""
    doc = load(doc_id)
    if doc is None:
        raise KeyError(doc_id)
    if _entry_title(entry_id) is None:
        raise KeyError(entry_id)
    if write_lyrics:
        # Through the lyrics service, never around it: it is what carries word
        # timings over by line diff and keeps the entry's own row in step.
        from backend.modules.lyrics import service as lyrics_service
        from backend.modules.lyrics.schema import PutLyricsRequest

        lyrics_service.save_doc(
            lyrics_service.normalize_doc(
                entry_id,
                PutLyricsRequest(text=doc.text, source="manual"),
                lyrics_service.load_doc(entry_id),
            )
        )
    doc.entry_id = entry_id
    return save(doc)


def import_from_entry(req: ImportLyricDocumentRequest) -> LyricDocument:
    """A new document seeded with an entry's existing lyrics — the starting
    point for rewriting a song's words without touching the song."""
    from backend.modules.lyrics import service as lyrics_service

    entry_id = req.entry_id
    title = _entry_title(entry_id)
    if title is None:
        raise KeyError(entry_id)
    bundle = lyrics_service.get_bundle(entry_id)
    text = str((bundle.get("doc") or {}).get("text") or "")
    return create(
        CreateLyricDocumentRequest(
            title=_clean_title(req.title) or title or DEFAULT_TITLE,
            text=text,
            entry_id=entry_id,
        )
    )


# ---- the analysis of a document ----------------------------------------------


def source_lyrics(doc: LyricDocument):
    """The document's text in the ``LyricsDoc`` shape every detector reads, so
    a finding's (line, word) anchors mean the same thing here as on a song."""
    from backend.modules.lyrics.schema import LyricsDoc, split_text

    return LyricsDoc(
        entry_id="",
        language=doc.language or "en",
        source="manual",
        text=doc.text,
        lines=split_text(doc.text),
        updated_at=doc.updated_at,
    )


def load_analysis(doc_id: str) -> Optional[LyricAnalysisDoc]:
    if not is_document_id(doc_id):
        return None
    path = _analysis_path(doc_id)
    if not path.is_file():
        return None
    try:
        return LyricAnalysisDoc.model_validate(
            json.loads(path.read_text(encoding="utf-8"))
        )
    except Exception as e:  # noqa: BLE001 - a corrupt file reads as absent
        log.warning("lyricanalysis: document analysis %s unreadable: %s", path, e)
        return None


def save_analysis(doc_id: str, analysis: LyricAnalysisDoc) -> LyricAnalysisDoc:
    _atomic_write(_analysis_path(doc_id), analysis.model_dump())
    return analysis


def delete_analysis(doc_id: str) -> bool:
    if not is_document_id(doc_id):
        raise KeyError(doc_id)
    if load(doc_id) is None:
        raise KeyError(doc_id)
    path = _analysis_path(doc_id)
    if not path.is_file():
        return False
    path.unlink()
    return True


def analysis_bundle(doc_id: str) -> dict[str, Any]:
    """``{doc, persisted, stale}`` — the same envelope the entry route returns,
    so the analysis pane does not care which kind of subject it is reading."""
    from . import service

    doc = load(doc_id)
    if doc is None:
        raise KeyError(doc_id)
    analysis = load_analysis(doc_id)
    if analysis is None:
        return {"doc": None, "persisted": False, "stale": False}
    return {
        "doc": analysis.model_dump(),
        "persisted": True,
        "stale": service.is_stale(analysis, source_lyrics(doc)),
    }


def start_run(job: Job, doc_id: str, req: dict[str, Any]) -> None:
    import asyncio

    from . import service

    service._track(asyncio.create_task(run_analysis(job, doc_id, req)))


def begin_run(doc_id: str, req: dict[str, Any]) -> tuple[Job, bool]:
    """Start an analysis for the document, or hand back the one already
    running for it. Shares the service's job registry — it is keyed by the
    subject's id and a document id can never collide with an entry id."""
    from backend.core.jobs import create_job

    from . import service

    if load(doc_id) is None:
        raise KeyError(doc_id)
    job = service.active_job(doc_id)
    if job is not None:
        return job, True
    job = create_job("lyricanalysis", f"Analyse lyric document ({doc_id})")
    service.register_job(doc_id, job)
    start_run(job, doc_id, req)
    return job, False


async def run_analysis(job: Job, doc_id: str, req: dict[str, Any]) -> None:
    """The deterministic pass over a document's own words, plus the optional
    interpretive one, stored beside the document."""
    import asyncio

    from . import service

    try:
        job.update(status="running", progress=0.05, message="reading the lyrics")
        doc = load(doc_id)
        if doc is None:
            raise RuntimeError(f"unknown lyric document {doc_id}")
        lyrics = source_lyrics(doc)
        if not any(ln.kind == "lyric" and ln.words for ln in lyrics.lines):
            raise RuntimeError("no lyrics to analyse: write some words first")
        stored = load_analysis(doc_id)
        if (
            not req.get("force")
            and stored is not None
            and not service.is_stale(stored, lyrics)
            and not (req.get("llm") and (stored.llm is None or stored.llm.error))
        ):
            job.result = stored.model_dump()
            job.update(
                status="done", progress=1.0, message="analysis is already up to date"
            )
            return
        job.update(progress=0.2, message="finding rhymes, sounds and repetitions")
        analysis = await asyncio.to_thread(service.analyse_lyrics, doc_id, lyrics)
        note = ""
        if req.get("llm"):
            # The service's pass, not a copy of it: it is the one place that
            # knows how to record a failed reading without losing a good
            # deterministic analysis.
            note = await service._run_llm_pass(job, analysis, lyrics, req)
        job.update(progress=0.9, message="saving")
        analysis.updated_at = time.time()
        save_analysis(doc_id, analysis)
        job.result = analysis.model_dump()
        job.update(
            status="done",
            progress=1.0,
            message=(
                f"found {len(analysis.devices)} devices across "
                f"{len(analysis.lines)} lines{note}"
            ),
        )
    except Exception as e:  # noqa: BLE001 - the job reports every failure
        log.exception("lyricanalysis document run failed")
        job.error = repr(e)
        job.update(status="failed", message=str(e))
