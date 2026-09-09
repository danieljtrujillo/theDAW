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
    LYRIC_DOCUMENT_VERSION,
    CreateLyricDocumentRequest,
    ImportLyricDocumentRequest,
    LyricAnalysisDoc,
    LyricDocument,
    LyricDocumentSummary,
    LyricMark,
    PutLyricMarksRequest,
    Span,
    UpdateLyricDocumentRequest,
)

log = logging.getLogger(__name__)

DIRNAME = "lyric-documents"
ANALYSIS_DIRNAME = "analysis"
MARKS_DIRNAME = "marks"
ID_PREFIX = "lyricdoc_"
_ID_RE = re.compile(r"^lyricdoc_[0-9a-f]{32}$")
MARK_ID_PREFIX = "lyricmark_"
_MARK_ID_RE = re.compile(r"^lyricmark_[0-9a-f]{32}$")
DEFAULT_TITLE = "Untitled"
# The title is metadata, never a filename, so it only needs a sane bound.
MAX_TITLE = 120

# A notebook page is one lyric, not a corpus. These are the bounds a hostile
# PUT hits instead of the disk; a writer marking up a song never comes near
# them. Label, kind and group are metadata (squeezed to one line); the note is
# the writer's prose, so it keeps its line breaks and is only bounded.
MAX_MARKS = 2000
MAX_SPANS_PER_MARK = 32
MAX_MARK_LABEL = 200
MAX_MARK_NOTE = 4000
MAX_MARK_KIND = 64
MAX_MARK_GROUP = 120
# ``target_group`` is not metadata: it is the ``Device.group`` a reject names,
# matched character for character. Squeezing it to the display bound would let
# a long group silently stop matching, and a reject that quietly stops working
# is worse than one that was never made — so it gets a bound of its own, far
# past anything ``devices.py`` mints.
MAX_MARK_TARGET = 512

# How far a mark may have slid before we stop looking for it. Inserting or
# cutting a verse moves everything below it by a handful of lines; past this
# the lyric was rewritten rather than shifted, and guessing would be worse than
# saying "this mark no longer matches".
MAX_REANCHOR_SHIFT = 16


def documents_dir() -> Path:
    """``<project>/data/lyric-documents``; ``theDAW_LYRIC_DOCS_DIR`` wins."""
    configured = os.getenv("theDAW_LYRIC_DOCS_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    project_root = Path(__file__).resolve().parents[3]
    return project_root / "data" / DIRNAME


def new_id() -> str:
    return f"{ID_PREFIX}{uuid.uuid4().hex}"


def new_mark_id() -> str:
    return f"{MARK_ID_PREFIX}{uuid.uuid4().hex}"


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
                raw = json.loads(_read_text(path))
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


def is_mark_id(mark_id: Any) -> bool:
    """True only for a mark id this module minted — the same gate
    ``is_document_id`` is, for the same reason. A PUT may echo one back to keep
    a mark's identity (and its ``created_at``) across a save; it can never
    invent one, and an id that names no stored mark is replaced with a fresh
    one rather than trusted."""
    return isinstance(mark_id, str) and _MARK_ID_RE.match(mark_id) is not None


def _doc_path(doc_id: str) -> Path:
    if not is_document_id(doc_id):
        raise KeyError(doc_id)
    return documents_dir() / f"{doc_id}.json"


def _analysis_path(doc_id: str) -> Path:
    if not is_document_id(doc_id):
        raise KeyError(doc_id)
    return documents_dir() / ANALYSIS_DIRNAME / f"{doc_id}.json"


def _marks_path(doc_id: str) -> Path:
    if not is_document_id(doc_id):
        raise KeyError(doc_id)
    return documents_dir() / MARKS_DIRNAME / f"{doc_id}.json"


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


def _read_text(path: Path) -> Optional[str]:
    """The file's text, or None when there is no such file.

    This is the read half of ``_atomic_write`` and it needs the same retry, for
    the same reason: Windows refuses to open a file while ``os.replace`` is
    renaming over it, and raises ``PermissionError`` rather than anything that
    reads as "busy". Every load here treats an unreadable file as an absent
    one, so without the retry a save landing mid-read turns a document that
    plainly exists into "unknown lyric document" — a 404 on a marks PUT and an
    empty mark set on a GET, both while the writer is typing in the other pane.
    A mixed read/write load test hit both in seconds.

    Opening the file IS the existence check, deliberately: ``Path.is_file()``
    swallows that same ``PermissionError`` and answers False, so using it as
    the gate reports a locked file as a missing one — which is the identical
    bug wearing a different hat.
    """
    for attempt in range(12):
        try:
            return path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return None
        except PermissionError:
            if attempt == 11:
                raise
            time.sleep(0.02)
    return None


def _clean_title(title: str) -> str:
    return " ".join(str(title or "").split())[:MAX_TITLE]


# ---- documents ---------------------------------------------------------------


def load(doc_id: str) -> Optional[LyricDocument]:
    """The document, or None when there is none (a corrupt file reads as
    absent, the way every other document store here treats one)."""
    if not is_document_id(doc_id):
        return None
    path = _doc_path(doc_id)
    try:
        text = _read_text(path)
        if text is None:
            return None
        return LyricDocument.model_validate(json.loads(text))
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
    """Remove the document, its stored analysis and the writer's marks. False
    when there was none."""
    if not is_document_id(doc_id):
        return False
    removed = False
    for path in (_doc_path(doc_id), _analysis_path(doc_id), _marks_path(doc_id)):
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


# ---- the writer's own marks --------------------------------------------------
#
# Marks live in their own file, never inside the analysis: a re-run rewrites the
# analysis wholesale, and the writer's annotations have to survive that
# untouched. They are merged in on the way out, by ``service.apply_marks``, so
# the stored analysis only ever holds what the detectors found.


def _bounded(value: Any, limit: int) -> str:
    """One-line metadata, squeezed and capped — the same treatment the title
    gets, for the same reason: it is displayed, never used as a path."""
    return " ".join(str(value or "").split())[:limit]


def _word_grid(doc: LyricDocument) -> list[list[str]]:
    """The document's words in ``Span`` coordinates: ``grid[line][word]``.

    Built with the same ``split_text`` the detectors read, so a mark's anchors
    mean exactly what a device's anchors mean. Marker lines have no words, so a
    mark can never land on "[Chorus]"."""
    from backend.modules.lyrics.schema import split_text

    return [[w.text for w in ln.words] for ln in split_text(doc.text)]


def _slice_at(
    grid: list[list[str]],
    line: int,
    word: int,
    char_start: int,
    char_end: Optional[int],
) -> Optional[str]:
    """What the document actually says at that anchor, or None when the anchor
    is not on the page — a negative index, a line past the end, a word past the
    end of its line."""
    if line < 0 or line >= len(grid):
        return None
    row = grid[line]
    if word < 0 or word >= len(row):
        return None
    text = row[word]
    start = max(0, min(int(char_start or 0), len(text)))
    end = len(text) if char_end is None else max(start, min(int(char_end), len(text)))
    return text[start:end]


def _clean_span(span: Span, grid: list[list[str]]) -> Optional[Span]:
    """The span with its character offsets clamped into the word it names and
    its text taken from the DOCUMENT rather than from the request — or None when
    it names a line or word that is not there.

    An anchor the words cannot back is never stored: the UI would paint at a
    phantom index. The denormalised text is not decoration either — it is the
    only thing that lets a later edit be detected, so it always comes from the
    lyric, never from whatever the client claimed was there.
    """
    line, word = int(span.line), int(span.word)
    if _slice_at(grid, line, word, 0, None) is None:
        return None
    text = grid[line][word]
    # Always at least one character. A span clamped down to nothing carries no
    # text, and a span with no text is an anchor that verifies nothing: it holds
    # against whatever word later lands at that index, so the mark can never be
    # found stale, and it paints a zero-width highlight the writer cannot see.
    # Words in the grid are never empty, so there is always a character to keep.
    start = max(0, min(int(span.char_start or 0), len(text) - 1))
    end = (
        None
        if span.char_end is None
        else max(start + 1, min(int(span.char_end), len(text)))
    )
    return Span(
        line=line,
        word=word,
        char_start=start,
        char_end=end,
        text=text[start : len(text) if end is None else end],
    )


def _anchor_key(span: Span) -> tuple[int, int, int, Optional[int]]:
    """Where a span points, with no regard for what it says it found there."""
    return (int(span.line), int(span.word), int(span.char_start or 0), span.char_end)


def _clean_mark(
    mark: LyricMark,
    stored: dict[str, LyricMark],
    grid: list[list[str]],
    taken: set[str],
    now: float,
) -> Optional[LyricMark]:
    """One mark as it will be stored, or None when it anchors to nothing real.

    A mark that arrived with spans and kept none of them is dropped: every
    anchor it had names a line or word the lyric does not have, so storing it
    would only put a phantom highlight in front of the writer. A mark with no
    spans at all is a note about the whole lyric, and is kept.
    """
    previous = stored.get(mark.id) if is_mark_id(mark.id) else None
    if previous is None or mark.id in taken:
        mark_id, previous = new_mark_id(), None
    else:
        mark_id = mark.id
    incoming = mark.spans[:MAX_SPANS_PER_MARK]
    if previous is not None and [_anchor_key(s) for s in incoming] == [
        _anchor_key(s) for s in previous.spans
    ]:
        # The editor owns the list and PUTs the WHOLE set on every save, so most
        # marks in a request are only being echoed back. Re-deriving their text
        # from the document would quietly re-seat a mark the words had moved out
        # from under: the anchor would pick up whatever now sits at that index,
        # the mark would stop being reported stale, and the writer would be
        # shown a highlight they never made — or, if the marked line was cut
        # outright, the mark would be dropped and their annotation lost. A mark
        # whose anchors did not move therefore keeps the spans it was stored
        # with, verbatim. Only a mark the writer actually re-placed is re-read
        # off the page.
        spans = [s.model_copy(deep=True) for s in previous.spans]
    else:
        spans = [
            cleaned
            for cleaned in (_clean_span(s, grid) for s in incoming)
            if cleaned is not None
        ]
        if incoming and not spans:
            return None
    cleaned = LyricMark(
        id=mark_id,
        kind=_bounded(mark.kind, MAX_MARK_KIND),
        label=_bounded(mark.label, MAX_MARK_LABEL),
        group=_bounded(mark.group, MAX_MARK_GROUP),
        spans=spans,
        note=str(mark.note or "").strip()[:MAX_MARK_NOTE],
        verdict=mark.verdict,
        target_group=_bounded(mark.target_group, MAX_MARK_TARGET),
        created_at=previous.created_at if previous else now,
        updated_at=now,
    )
    # The editor PUTs the whole set on every save, so an untouched mark must
    # keep the timestamp it had — else "last edited" means "last saved
    # anything" and the writer can never see which mark they just moved.
    if previous is not None and previous.model_dump(
        exclude={"updated_at"}
    ) == cleaned.model_dump(exclude={"updated_at"}):
        cleaned.updated_at = previous.updated_at
    return cleaned


def _load_marks_file(doc_id: str) -> tuple[list[LyricMark], Optional[int]]:
    """``(marks, the document's line count when these anchors were last known
    good)``. The count is None for a file written by hand, and for one written
    before it was recorded. A corrupt file reads as no marks, the way every
    other store in this module treats one."""
    if not is_document_id(doc_id):
        return [], None
    path = _marks_path(doc_id)
    try:
        text = _read_text(path)
        if text is None:
            return [], None
        raw = json.loads(text)
        rows = raw.get("marks") if isinstance(raw, dict) else raw
        marks = [LyricMark.model_validate(row) for row in (rows or [])]
        lines = raw.get("lines") if isinstance(raw, dict) else None
    except Exception as e:  # noqa: BLE001 - a corrupt file reads as absent
        log.warning("lyricanalysis: marks %s unreadable: %s", path, e)
        return [], None
    # An id that is not one of ours cannot have got here through the routes,
    # but a hand-edited file is still a file we have to read.
    return (
        [m for m in marks if is_mark_id(m.id)][:MAX_MARKS],
        lines if isinstance(lines, int) and not isinstance(lines, bool) else None,
    )


def load_marks(doc_id: str) -> list[LyricMark]:
    """The stored marks exactly as written, unanchored."""
    return _load_marks_file(doc_id)[0]


def save_marks(doc_id: str, marks: list[LyricMark], lines: int) -> list[LyricMark]:
    """Write the set, stamped with the number of lines the document had while
    these anchors were known good — which is what lets a later read tell a mark
    pushed down the page by an insertion from one whose own line was rewritten.
    See ``_shift_window``."""
    _atomic_write(
        _marks_path(doc_id),
        {
            "version": LYRIC_DOCUMENT_VERSION,
            "doc_id": doc_id,
            "lines": int(lines),
            "marks": [m.model_dump() for m in marks],
        },
    )
    return marks


def _anchors_hold(grid: list[list[str]], spans: list[Span], shift: int) -> bool:
    """True when every span of a mark still covers the words it was placed on,
    with all of them moved down by ``shift`` lines."""
    for span in spans:
        found = _slice_at(
            grid, span.line + shift, span.word, span.char_start, span.char_end
        )
        if found is None:
            return False
        if span.text and found != span.text:
            return False
    return True


def _shift_window(delta: Optional[int]) -> list[int]:
    """The line shifts worth trying, nearest first.

    A mark slides only because lines were added or cut ABOVE it, so how far the
    document itself grew or shrank both bounds the search and says which way it
    can run. That bound is not a nicety. Without it the search is content
    matching, and lyrics repeat themselves by design: mark the first chorus of
    a song, rewrite that chorus, and an unbounded search finds the writer's
    words still sitting in the second chorus six lines further down, moves the
    mark there and reports it sound. A document that did not change length
    cannot have pushed anything anywhere, so nothing is tried at all.

    The bound is ``<=``, not ``==``: lines cut below the mark shrink the
    document without moving it. The residue is a net-zero edit — as many lines
    added above as cut below, with no read in between — where a mark that did
    move is reported stale instead. That is the safe way to be wrong: the
    anchors stay where the writer put them and the pane says so.

    ``delta`` is None only for a marks file written by hand, which has no count
    to measure against; then the whole window is tried, as before.
    """
    if delta is None:
        return [s for step in range(1, MAX_REANCHOR_SHIFT + 1) for s in (step, -step)]
    sign = 1 if delta > 0 else -1
    return [sign * step for step in range(1, min(abs(delta), MAX_REANCHOR_SHIFT) + 1)]


def _reanchor(
    mark: LyricMark, grid: list[list[str]], delta: Optional[int]
) -> tuple[LyricMark, bool, bool]:
    """``(mark, moved, stale)`` for the lyric as it is now.

    A mark is followed when the whole of it shifted by the same number of lines
    — which is exactly what inserting or deleting a line above it does — when
    the words it covers are still those words, and when the document changed
    length by at least that much in that direction (``_shift_window``). That is
    the honest limit: rewriting the marked line itself cannot be followed,
    because there is nothing left to recognise, and such a mark is reported
    stale rather than dragged onto whatever now sits at that index — or onto
    the same words somewhere else in the song.
    """
    if not mark.spans:
        return mark, False, False
    if _anchors_hold(grid, mark.spans, 0):
        return mark, False, False
    for shift in _shift_window(delta):
        if not _anchors_hold(grid, mark.spans, shift):
            continue
        moved = mark.model_copy(deep=True)
        for span in moved.spans:
            span.line += shift
        return moved, True, False
    return mark, False, True


def resolve_marks(
    doc_id: str, doc: Optional[LyricDocument] = None
) -> tuple[list[LyricMark], set[str]]:
    """The document's marks anchored onto the words as they are NOW, plus the
    ids of the ones that could not be found any more.

    Re-anchored marks are written back: the search is relative to what is
    stored, so leaving a shifted mark alone would make every later edit stack
    another shift on top of it until the total ran past ``MAX_REANCHOR_SHIFT``
    and a mark that was only ever pushed down a page was declared lost.

    That write-back is why a read holds the marks file's lock: without it a
    repair computed before a concurrent PUT could land after it and put the
    old set back.
    """
    if not is_document_id(doc_id):
        return [], set()
    if doc is None:
        doc = load(doc_id)
        if doc is None:
            return [], set()
    grid = _word_grid(doc)
    resolved: list[LyricMark] = []
    stale: set[str] = set()
    moved_any = False
    with _write_lock(_marks_path(doc_id)):
        marks, was = _load_marks_file(doc_id)
        delta = None if was is None else len(grid) - was
        for mark in marks:
            mark, moved, is_stale = _reanchor(mark, grid, delta)
            moved_any = moved_any or moved
            if is_stale:
                stale.add(mark.id)
            resolved.append(mark)
        # The stamp is refreshed even when nothing moved — an edit BELOW every
        # mark changes the count without shifting one, and leaving the old
        # count behind would spend that difference on the next edit's budget.
        if resolved and (moved_any or was != len(grid)):
            try:
                save_marks(doc_id, resolved, len(grid))
            except OSError as e:
                # Re-anchoring is a repair, not the answer: a read that cannot
                # write still returns the marks in the right place.
                log.warning(
                    "lyricanalysis: could not re-anchor marks for %s: %s", doc_id, e
                )
    return resolved, stale


def marks_bundle(doc_id: str) -> dict[str, Any]:
    """``{marks, stale, updated_at}`` — the mark set with its anchors brought up
    to date, and the ids the words moved out from under. Raises KeyError when
    there is no such document."""
    doc = load(doc_id)
    if doc is None:
        raise KeyError(doc_id)
    marks, stale = resolve_marks(doc_id, doc)
    return {
        "marks": [m.model_dump() for m in marks],
        "stale": sorted(stale),
        "updated_at": max((m.updated_at for m in marks), default=0.0),
    }


def put_marks(doc_id: str, req: PutLyricMarksRequest) -> dict[str, Any]:
    """Replace the document's whole mark set — the editor owns the list.

    Raises KeyError for an unknown document and ValueError for a set larger
    than one lyric could hold. Ids are minted here: an id that names a stored
    mark is kept so the mark keeps its history, and anything else is replaced.
    """
    # The id gate before anything else, so a hostile path is a 404 whatever body
    # came with it.
    if not is_document_id(doc_id):
        raise KeyError(doc_id)
    # The whole read-modify-write under the marks file's own lock, so two
    # windows saving the same annotation cannot interleave.
    with _write_lock(_marks_path(doc_id)):
        doc = load(doc_id)
        # Existence before size: a PUT to a document that is not there is a 404
        # even when the body is also too big, or the client is told to send
        # fewer marks to a page that does not exist.
        if doc is None:
            raise KeyError(doc_id)
        if len(req.marks) > MAX_MARKS:
            raise ValueError(
                f"{len(req.marks)} marks is more than the {MAX_MARKS} allowed"
            )
        grid = _word_grid(doc)
        stored = {m.id: m for m in load_marks(doc_id)}
        now = now_stamp()
        kept: list[LyricMark] = []
        taken: set[str] = set()
        for mark in req.marks:
            cleaned = _clean_mark(mark, stored, grid, taken, now)
            if cleaned is None:
                continue
            taken.add(cleaned.id)
            kept.append(cleaned)
        save_marks(doc_id, kept, len(grid))
    return {
        "marks": [m.model_dump() for m in kept],
        # Every span was just re-derived from the document, so nothing can be
        # stale yet; the key is here so the shape does not change between GET
        # and PUT.
        "stale": [],
        # Marks whose anchors named nothing in the lyric. The editor shows the
        # difference rather than silently keeping a shorter list.
        "dropped": len(req.marks) - len(kept),
        "updated_at": max((m.updated_at for m in kept), default=0.0),
    }


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
    try:
        text = _read_text(path)
        if text is None:
            return None
        return LyricAnalysisDoc.model_validate(json.loads(text))
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
    so the analysis pane does not care which kind of subject it is reading.

    A document with marks also gets a ``marks`` summary, and its ``doc`` is the
    merged view: rejected findings removed, the writer's own marks alongside
    the detected ones. The key is absent when there are no marks, so nothing
    that never marked anything up sees a shape it did not have before.
    """
    from . import service

    doc = load(doc_id)
    if doc is None:
        raise KeyError(doc_id)
    marks, stale = resolve_marks(doc_id, doc)
    analysis = load_analysis(doc_id)
    if analysis is None:
        bundle: dict[str, Any] = {"doc": None, "persisted": False, "stale": False}
        painted = 0
        suppressed = 0
    else:
        merged = service.apply_marks(analysis, marks, skip=stale)
        painted = sum(1 for d in merged.devices if service.is_mark_device(d))
        suppressed = len(analysis.devices) - (len(merged.devices) - painted)
        bundle = {
            "doc": merged.model_dump(),
            "persisted": True,
            "stale": service.is_stale(analysis, source_lyrics(doc)),
        }
    if marks:
        bundle["marks"] = {
            "total": len(marks),
            "stale": sorted(stale),
            "painted": painted,
            "suppressed": suppressed,
        }
    return bundle


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
        # The writer's marks are merged into what the job hands back, never into
        # what it saves: the analysis file holds detections only, which is what
        # makes a re-run unable to overwrite a mark.
        marks, stale_marks = resolve_marks(doc_id, doc)
        stored = load_analysis(doc_id)
        if (
            not req.get("force")
            and stored is not None
            and not service.is_stale(stored, lyrics)
            and not (req.get("llm") and (stored.llm is None or stored.llm.error))
        ):
            job.result = service.apply_marks(
                stored, marks, skip=stale_marks
            ).model_dump()
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
        job.result = service.apply_marks(analysis, marks, skip=stale_marks).model_dump()
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
