"""FastAPI router for the disk-backed library.

Endpoints (prefix from module.json → `/api/library`):

    GET    /summary            category counts + the DB revision they came from
    GET    /entries            list entries (?kind=audio|video|image|media|score|all);
                               with ?limit= it is paged + searchable (see below)
    GET    /entries/ids        every matching id, for select-all / shift-range
    GET    /entries/facets     value counts per field, for the filter dropdowns
    GET    /entries/stats      favourites / size / duration totals of a query
    GET    /entries/resolve    the audio entry a LOOM reference names
    GET    /index-status       how far opening the library has got (progress bar)
    POST   /retry-open         open the library again after a failed open, or
                               restart a search index build that stopped
    POST   /entries/bulk-delete  delete many entries by id, or by filter
    GET    /entries/{id}       single entry record
    GET    /audio/{id}         stream the audio file
    GET    /audio/{id}/cover   cover art for an audio entry
    POST   /audio/{id}/cover   attach/refresh one entry's cover art
    GET    /media/{id}         stream a video/image entry (Range-capable)
    GET    /media/{id}/thumb   poster thumbnail for a media entry
    PATCH  /entries/{id}       update user-mutable fields
    DELETE /entries/{id}       remove the entry (audio + metadata)
    POST   /import             accept an audio upload, return new entry
    POST   /import-media       accept a video/image upload, return new entry
    POST   /import-folder      add a folder reference-in-place (?async=1 → a job)
    GET    /import-jobs/{id}   progress of an async folder import
    DELETE /import-jobs/{id}   cancel one after the batch in flight
    POST   /covers/backfill    re-read embedded art for entries with none
    POST   /reindex            re-sync the SQLite mirror from the filesystem

The audio stream uses FileResponse so range requests work (essential for
the player to scrub) and there's no in-memory copy of large files.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import mimetypes
import os
import re
import tempfile
import threading
import time
from collections.abc import Callable, Iterator, Sequence
from pathlib import Path
from typing import Any, Optional

import httpx
from fastapi import (
    APIRouter,
    Body,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    UploadFile,
)
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from pydantic import BaseModel

from . import media_roots
from .bundle import build_bundle_bytes
from .db import (
    ANALYSIS_SCALAR_KEYS,
    DEFAULT_SORT,
    FACET_FIELDS,
    FFPROBE_SUMMARY_KEYS,
    SORTS,
    EntryFilters,
    LibraryDB,
    LibraryProgress,
    SearchIndexFailed,
    _chunks,
    _MAX_SQL_PARAMS,
    derived_provider_wire,
)
from .provider import ProviderInfo, detect_provider, detection_outranks
from .store import (
    AUDIO_EXTS,
    MAX_REINDEX_ANALYSIS_ENQUEUE,
    ImportJob,
    LibraryStore,
    _read_metadata,
    bounded_provider_info,
    bounded_provider_wire_fields,
    default_library_root,
    get_import_jobs,
)
from .tags import MAX_EMBEDDED_COVER_BYTES
from backend.modules.analysis.engine import profile_of_row
from backend.core.startup import register_startup_hook
from backend.lib import known_paths, paths
from backend.lib.atomic import atomic_write
from backend.lib.fswalk import walk_files
from backend.lib.cross_site import (
    refuse_cross_site,
    require_loopback_or_launch_token,
)

log = logging.getLogger(__name__)

#: Page size ceiling. 500 rows is already more than any screen shows; the cap
#: is what stops a client from asking for the 200,000-row response this whole
#: endpoint exists to replace.
MAX_PAGE_LIMIT = 500

#: Page size when a caller asks for a filtered/searched list without saying how
#: many rows it wants.
DEFAULT_PAGE_LIMIT = 200

#: Ceiling on ``GET /entries/ids``. Select-all over more than this is refused
#: (413) rather than answered with a list the client cannot hold.
MAX_SELECTABLE_IDS = 50_000

#: How many entries ONE request may persist a read-time provider detection
#: for (:func:`_record_detected_providers`). A paged list is under this by
#: construction, so it never bites there; it exists for the legacy unpaged
#: shape, which returns the WHOLE library and must stay a read of 200,000 rows
#: instead of becoming a 200,000-file migration. Rows it skips are written by
#: the paged reads that follow, each one for the page it was already serving.
MAX_PROVIDER_WRITEBACK = MAX_PAGE_LIMIT

#: Ceiling on the ``ids`` form of ``POST /entries/bulk-delete``. Above this the
#: caller has to say what it wants with a filter instead of naming every row,
#: which is also what lets the server re-count before it deletes anything.
MAX_BULK_DELETE_IDS = 5_000

#: How many per-id failures one bulk-delete response carries. The rest are
#: implied by ``deleted + failures == total_matched``.
MAX_BULK_DELETE_ERRORS = 50

#: A paged row carries at most this much lyric text; the rest is only on the
#: single-entry read. A page of 500 songs with full lyrics is megabytes of
#: text nothing on screen displays.
LYRICS_PREVIEW_CHARS = 280

#: How many created entries the SYNCHRONOUS folder import echoes back. The
#: full count is always reported as ``created_total``.
MAX_SYNC_IMPORT_ENTRIES = 200

# MAX_REINDEX_ANALYSIS_ENQUEUE (the cap for POST /reindex?analyze=true) lives
# in store.py -- it is also reindex()'s own default max_enqueue, so a bare
# reindex() call is capped the same way even without going through this
# route. Imported above, not redefined here.


_store: Optional[LibraryStore] = None

#: The name of the thread that opens the library.
LIBRARY_OPEN_THREAD = "library-open"

#: How long a route in this file waits for the library to finish opening
#: before it answers 503 with the progress instead. A small library opens well
#: inside it, so its first request just answers; a large one being upgraded
#: frees the request thread and the LIBRARY tab shows the progress bar. Every
#: sync route here answers this way, reads and writes alike: a single-entry
#: lookup used to hold its thread for the whole upgrade, and a write that
#: arrives during the upgrade is better refused with a Retry-After than held
#: for minutes.
OPEN_WAIT_SEC = 1.5

#: How long a failed open stays failed before a caller that needs the store
#: (:func:`get_store`, :func:`store_or_opening`) starts another one. The
#: LIBRARY tab's Retry button (``POST /retry-open``) starts one at once. The
#: progress poll never starts one: a poll that retried would show a fresh
#: ``opening`` every second and never the failure, and each attempt that
#: failed part way would leave its database behind.
OPEN_RETRY_AFTER_SEC = 30.0


class LibraryOpening(Exception):
    """The library is still opening (schema upgrade under way); carries the
    progress snapshot a 503 answers with."""

    def __init__(self, status: dict[str, Any]) -> None:
        super().__init__(status.get("label") or "the library is opening")
        self.status = status


class _OpenAttempt:
    """One open of the library at ``root``, run on :data:`LIBRARY_OPEN_THREAD`."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.progress = LibraryProgress()
        self.done = threading.Event()
        self.store: Optional[LibraryStore] = None
        self.error: Optional[BaseException] = None
        #: ``time.monotonic()`` when the open failed; None until it does.
        self.failed_at: Optional[float] = None


_open_lock = threading.Lock()
_opening: Optional[_OpenAttempt] = None


def _run_open(attempt: _OpenAttempt) -> None:
    """Open the store and publish it.

    The schema upgrade (seconds to minutes on a 200,000-entry library from
    main's schema 6) and a first start's read of every ``metadata.json``
    (:meth:`~.store.LibraryStore.read_disk_into_db`) run here, on a thread of
    their own, so the backend's startup and ``/api/health`` never wait for
    them. Each migration step commits with its version bump, and the read is
    flagged until its last batch, so a close part way through either resumes
    on the next start. The store is published only once the database mirrors
    the disk: a half-read library would answer 404 for entries that exist.
    The search index build then runs on a thread of its own
    (:meth:`~.db.LibraryDB._ensure_search`) while the store answers.
    """
    global _store
    try:
        store = LibraryStore(
            attempt.root,
            build_search_in_background=True,
            progress=attempt.progress,
        )
    except BaseException as e:
        # LibraryStore closes its database when it raises after opening it,
        # so a failed attempt holds no connection and runs no build thread.
        attempt.error = e
        attempt.failed_at = time.monotonic()
        attempt.progress.fail(str(e) or type(e).__name__)
        log.exception("library: opening %s failed", attempt.root)
        attempt.done.set()
        return
    with _open_lock:
        current = _opening is attempt
        if current:
            _store = store
    attempt.store = store
    attempt.progress.mark_opened()
    attempt.done.set()
    if not current and store.db is not None:
        # Replaced while it opened (the library folder moved): nobody reads
        # this store, and its build must not keep the file open.
        store.db.close()


def start_opening(*, retry: bool = False) -> _OpenAttempt:
    """Start opening the library on :data:`LIBRARY_OPEN_THREAD`, or return
    the attempt already running. A finished attempt is reused while its store
    is the published one and the library folder is still the same. A failed
    one is returned as it is (so its failure stays visible) until
    :data:`OPEN_RETRY_AFTER_SEC` has passed, or at once when ``retry`` asks
    for a new attempt (the Retry button)."""
    global _opening
    root = default_library_root()
    with _open_lock:
        attempt = _opening
        if attempt is not None and attempt.root == root:
            if not attempt.done.is_set():
                return attempt
            if attempt.error is None and _store is not None and _store is attempt.store:
                return attempt
            if (
                attempt.error is not None
                and not retry
                and attempt.failed_at is not None
                and time.monotonic() - attempt.failed_at < OPEN_RETRY_AFTER_SEC
            ):
                return attempt
        attempt = _OpenAttempt(root)
        _opening = attempt
    threading.Thread(
        target=_run_open, args=(attempt,), name=LIBRARY_OPEN_THREAD, daemon=True
    ).start()
    return attempt


def _on_event_loop() -> bool:
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return False
    return True


def get_store() -> LibraryStore:
    """The process's library, waiting for it to open when it has not yet.

    The backend's startup only starts the open (:func:`start_opening`); the
    first caller that needs the store waits for the schema upgrade on the
    thread it already runs on. The sync routes in this file wait at most
    :data:`OPEN_WAIT_SEC` instead (:func:`store_or_opening`); this is for the
    other modules and the async routes. Async callers reach this through
    ``asyncio.to_thread``; one that calls it on the event loop while the
    library opens is logged, and waits, because failing it could drop a
    generated take's library record."""
    store = _store
    if store is not None:
        return store
    attempt = start_opening()
    if not attempt.done.is_set() and _on_event_loop():
        log.warning(
            "library: get_store() waited for the library to open ON the event "
            "loop; call it through asyncio.to_thread",
            stack_info=True,
        )
    attempt.done.wait()
    if attempt.error is not None:
        raise RuntimeError(
            f"the library could not be opened: {attempt.error}"
        ) from attempt.error
    published = _store
    if published is not None:
        return published
    assert attempt.store is not None
    return attempt.store


def store_or_opening(wait: Optional[float] = None) -> LibraryStore:
    """The store, or :class:`LibraryOpening` after at most ``wait`` seconds
    (default :data:`OPEN_WAIT_SEC`, read at call time) of the schema upgrade:
    what every sync route in this file answers with (:func:`_opening_response`,
    a 503 carrying ``library_status`` and a Retry-After) so no request thread
    is held for the whole upgrade."""
    store = _store
    if store is not None:
        return store
    attempt = start_opening()
    if not attempt.done.wait(timeout=OPEN_WAIT_SEC if wait is None else wait):
        raise LibraryOpening(library_status())
    if attempt.error is not None:
        # Answered like the upgrade: 503 with ``phase: failed`` and the reason,
        # which the LIBRARY tab shows with its Retry button.
        raise LibraryOpening(attempt.progress.snapshot())
    return get_store()


def library_status() -> dict[str, Any]:
    """Where opening the library has got (``LibraryProgress.snapshot``).
    Takes no database lock and reads no row: it answers while the upgrade
    holds the file."""
    store = _store
    if store is not None and store.db is not None:
        return store.db.progress.snapshot()
    attempt = _opening
    if attempt is None:
        return LibraryProgress().snapshot()
    return attempt.progress.snapshot()


def _opening_response(exc: LibraryOpening) -> JSONResponse:
    label = exc.status.get("label") or "The library is opening"
    if exc.status.get("phase") == "failed":
        detail = f"{label}: {exc.status.get('error') or 'unknown error'}"
        retry_after = str(int(OPEN_RETRY_AFTER_SEC))
    else:
        detail = f"{label}; the library answers when it finishes"
        retry_after = "2"
    return JSONResponse(
        status_code=503,
        content={"detail": detail, "library_status": exc.status},
        headers={"Retry-After": retry_after},
    )


router = APIRouter()


def _attach_play_counts(
    store: LibraryStore,
    entries: list[dict[str, Any]],
    *,
    ids: Optional[list[str]] = None,
) -> None:
    """Merge the persistent play_count / last_played_at from the DB into entry
    dicts. The DB column is the source for these; entries with no DB row read 0.
    The frontend sorts on play_count, so it ships with every entry payload.

    ``ids`` restricts the lookup to one page (:meth:`LibraryDB.play_counts_for`).
    Without it, every entry is enriched (:meth:`LibraryDB.all_play_counts`) --
    both read only ``id, play_count, last_played_at`` (LIB-004): the unpaged
    path used to call :meth:`LibraryDB.list_entries` (``SELECT *``), reading
    every column of every row -- including ``metadata_json`` -- just to
    attach two numbers, which is ruinous once the library has 200,000 rows."""
    if store.db is None:
        for e in entries:
            e.setdefault("play_count", 0)
            e.setdefault("last_played_at", None)
        return
    if ids is None:
        rows: dict[str, Any] = store.db.all_play_counts()
    else:
        rows = store.db.play_counts_for(ids)
    for e in entries:
        row = rows.get(e["id"]) or {}
        e["play_count"] = int(row.get("play_count") or 0)
        e["last_played_at"] = row.get("last_played_at")


# Scalar analysis columns that are safe to expose on the entry verbatim. The
# `*_json` columns (embedded_tags_json / ffprobe_json / semantic_tags_json) are
# parsed separately below so the frontend never receives raw JSON strings.
# Defined in db.py, whose search index matches exactly what an entry carries.
_ANALYSIS_SCALAR_KEYS = ANALYSIS_SCALAR_KEYS

# Selected file-technical keys pulled out of the ffprobe `_summary` blob so the
# inspector can show them as plain rows (sample rate, codec, …) without dumping
# the whole ffprobe payload. Defined in db.py for the same reason.
_FFPROBE_SUMMARY_KEYS = FFPROBE_SUMMARY_KEYS


def _loose_json(text: Optional[str]) -> Any:
    """Tolerant JSON parse for the stored `*_json` analysis columns. Returns the
    decoded value for objects/arrays, or ``None`` for empty/invalid input — so a
    malformed column degrades to "absent" instead of raising mid-request."""
    if not text:
        return None
    try:
        value = json.loads(text)
    except (TypeError, ValueError):
        return None
    return value if isinstance(value, (dict, list)) else None


# WHY THIS ENRICHMENT EXISTS:
# The frontend was built to read ``entry.analysis`` (the Catalogue inspector's
# ANALYSIS section + library search by bpm/key/genre) and ``entry.embedded_tags``
# (the EMBEDDED TAGS section), but the entry payload never carried them — so
# those sections rendered empty and the stored analytics were effectively
# invisible. The two helpers below light them up. Both are additive + defensive:
# an entry with no analysis row is left exactly as-is.


def _analysis_payload(row: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    """Turn one stored analysis row into the ``(analysis, embedded_tags)`` pair
    the frontend consumes.

    ``analysis`` is a FLAT scalar dict with NULL columns dropped (so the UI only
    shows real data); ``embedded_tags`` is the parsed ID3/Vorbis/iTunes dict
    (empty when the file carried none). The stored ``*_json`` columns are parsed
    here so callers never receive raw JSON strings.
    """
    analysis: dict[str, Any] = {
        k: row[k] for k in _ANALYSIS_SCALAR_KEYS if row.get(k) is not None
    }
    semantic = _loose_json(row.get("semantic_tags_json"))
    if semantic:
        analysis["semantic_tags"] = semantic
    # File technicals live inside the ffprobe summary blob; surface a few.
    summary = _loose_json(row.get("ffprobe_json")) or {}
    summary = summary.get("_summary") if isinstance(summary, dict) else None
    if isinstance(summary, dict):
        for k in _FFPROBE_SUMMARY_KEYS:
            if summary.get(k) is not None:
                analysis.setdefault(k, summary[k])
    # WHICH profile wrote this row. A 'dj' row measured no pitch statistics
    # and no integrated loudness, so a reader that treats "field absent" as
    # "nothing to show" would present a partial row as a complete one. Always
    # present, and always 'full' for a row with no marker -- which is every
    # row written before profiles existed.
    analysis["profile"] = profile_of_row(row)
    embedded = _loose_json(row.get("embedded_tags_json"))
    if not (isinstance(embedded, dict) and embedded):
        embedded = {}
    return analysis, embedded


def _derive_provider(
    entry: dict[str, Any], embedded: dict[str, Any]
) -> Optional[ProviderInfo]:
    """Upgrade an entry's provider using the tags its analysis pass stored.

    The store already labeled the entry (``store._provider_wire``): a stored
    label or a legacy Suno marker where there was one, and otherwise the
    ``model`` / ``source`` guess the catalogue has always shown. This is the
    middle rank, and it only applies to the entries whose origin nothing but
    the file itself knows -- a Suno track imported long before labeling
    existed, whose surviving evidence is the tag blob in its analysis row.

    The guess is replaced, a real label is not: an entry whose provider is
    exactly what the ``(model, source)`` fallback produces carries no better
    information, so the file's own tags outrank it -- as far as
    :func:`~.provider.detection_outranks` lets them. No audio file is opened,
    which is how the
    existing library gets labeled with no backfill and no re-analysis. Entries
    with no analysis row never reach here and keep what the store gave them.

    Returns the detection when it CHANGED any of the four wire fields, so the
    caller can persist it once (:func:`_record_detected_providers`), and None
    otherwise. That write is the whole point: the label lives in Python and
    the ``provider=`` filter lives in SQL over the entry row, so until the
    derived answer is stored the two file the same entry under different
    slugs and it answers to no provider filter at all. Once stored, rule 1 of
    ``PROVIDER_SQL`` agrees with what is shown, this function returns None for
    that entry, and no further request writes anything.
    """
    current = entry.get("provider")
    derived_wire = derived_provider_wire(entry.get("model"), entry.get("source"))
    derived = str(derived_wire["provider"])
    if current and current != derived:
        return None
    info = bounded_provider_info(detect_provider(embedded, None))
    if info is None:
        return None
    # The same rank rule the import labeler uses
    # (``store._apply_provider_labels``), so an entry is not labeled one way
    # when it is imported and another way when it is read. It is what keeps a
    # theDAW encoder frame -- on every file this app writes, including its own
    # Stable Audio generations -- and a slug minted from some unknown mastering
    # tool from refiling a generation as a non-AI provider in the filter, the
    # facet and the badge, which the write-through below would then make
    # permanent.
    if not detection_outranks(info, derived, bool(derived_wire["provider_is_ai"])):
        return None
    fields = bounded_provider_wire_fields(info)
    changed = any(entry.get(key) != value for key, value in fields.items())
    entry.update(fields)
    return info if changed else None


def _apply_analysis(
    entry: dict[str, Any],
    row: Optional[dict[str, Any]],
    *,
    derive_provider: bool = True,
) -> Optional[ProviderInfo]:
    """Merge one analysis ``row`` onto one ``entry`` dict in place. No-op when
    ``row`` is ``None`` (entry not analyzed) or yields nothing renderable.

    With ``derive_provider=False`` the analysis and the embedded tags are
    still attached and the entry keeps the provider the store gave it. See
    :func:`_attach_analysis`.

    Returns what :func:`_derive_provider` decided is worth persisting, or None.
    """
    if not row:
        return None
    analysis, embedded = _analysis_payload(row)
    if analysis:
        entry["analysis"] = analysis
    if not embedded:
        return None
    entry["embedded_tags"] = embedded
    if not derive_provider:
        return None
    return _derive_provider(entry, embedded)


def _record_detected_providers(
    store: LibraryStore, detected: dict[str, ProviderInfo]
) -> None:
    """Persist read-time detections, and never let that spoil the read.

    The write is the store's narrow, metadata-only one: it does not move
    ``updated_at`` or ``timestamp``, does not re-index, does not enqueue a
    job, and refuses to overwrite a provider an entry already carries. Any
    failure -- a read-only library, a locked database, a vanished entry
    folder -- is dropped, because the response is already correct without it;
    the entry simply keeps deriving its label on every read, which is what it
    did before this existed.

    ONE warning per request, never one per row, and at warning rather than
    debug: a swallow this broad would otherwise hide a real bug in this path
    (a TypeError, a renamed attribute) behind a silent, permanently
    unpersisted label. The exception type is logged with the message so the
    difference between "the disk said no" and "this code is wrong" is visible
    in an ordinary log.
    """
    if not detected:
        return
    try:
        store.record_detected_providers(detected)
    except Exception as e:
        log.warning(
            "library.router: provider write-through skipped for %d entries: %s: %s",
            len(detected),
            type(e).__name__,
            e,
        )


def _attach_analysis(
    store: LibraryStore,
    entries: list[dict[str, Any]],
    *,
    ids: Optional[list[str]] = None,
    derive_provider: bool = True,
) -> None:
    """Bulk-enrich a LIST of entries with their analysis. ONE query for the
    whole list (no N+1), then an in-memory join by id. ``ids`` narrows that
    query to the page, instead of loading every analyzed entry in the
    library.

    ``derive_provider=False`` for a request that asked for ONE provider. A
    provider-filtered page must not rewrite its own result set: the rows were
    chosen by SQL under one slug, and relabeling them afterwards would show
    rows the filter does not match, drop them from under the user's cursor as
    the write-through refiles them, make ``total`` (counted after) disagree
    with the rows, and skip entries at the next offset -- with no revision
    bump to tell the client, correctly, since nothing it caches changed. So
    under an active provider filter every row is labeled exactly as SQL filed
    it and nothing is written. The unfiltered list and the single-entry read
    are what label the library.
    """
    if store.db is None:
        return
    rows = (
        store.db.get_all_analysis() if ids is None else store.db.get_analysis_for(ids)
    )
    if not rows:
        return
    detected: dict[str, ProviderInfo] = {}
    for e in entries:
        info = _apply_analysis(e, rows.get(e["id"]), derive_provider=derive_provider)
        if info is not None and len(detected) < MAX_PROVIDER_WRITEBACK:
            detected[str(e["id"])] = info
    _record_detected_providers(store, detected)


def _trim_lyrics(entry: dict[str, Any]) -> None:
    """Replace a long ``lyrics`` field with a preview, in place.

    A paged row is for a list: it needs enough text to show a snippet, not the
    whole song. The full text stays on ``GET /entries/{id}``. Short lyrics are
    left exactly as they are, so a row is only ever reshaped when there is
    something to save."""
    lyrics = entry.get("lyrics") or ""
    if len(lyrics) <= LYRICS_PREVIEW_CHARS:
        return
    entry.pop("lyrics", None)
    entry["lyrics_preview"] = lyrics[:LYRICS_PREVIEW_CHARS]
    entry["has_lyrics"] = True


def _attach_analysis_one(store: LibraryStore, entry: dict[str, Any]) -> None:
    """Enrich a SINGLE entry via a targeted ``get_analysis(id)`` lookup — so a
    single-entry GET never loads the entire analysis table (which the bulk
    helper would). Used by the per-id endpoint that inspectors hit on select.

    Persists a read-time detection exactly as the list does, so an entry
    opened in the inspector and the same entry seen in a page end up filed
    under the same slug whichever was read first."""
    if store.db is None:
        return
    info = _apply_analysis(entry, store.db.get_analysis(entry["id"]))
    if info is not None:
        _record_detected_providers(store, {str(entry["id"]): info})


_KIND_FILTERS: dict[str, Optional[set[str]]] = {
    "audio": {"audio"},
    "video": {"video"},
    "image": {"image"},
    "media": {"video", "image"},
    # Composition entries: a score with no recording (notation import).
    "score": {"score"},
    "all": None,
}


def _entry_filters(
    kind: str,
    q: Optional[str],
    favorite: Optional[bool],
    source: Optional[str],
    provider: Optional[str] = None,
) -> EntryFilters:
    kinds = _KIND_FILTERS[kind]
    return EntryFilters(
        kinds=frozenset(kinds) if kinds is not None else None,
        favorite=favorite,
        source=source,
        provider=provider,
        q=q,
    )


def _validate_listing(kind: str, sort: Optional[str], offset: int) -> None:
    if kind not in _KIND_FILTERS:
        raise HTTPException(
            400, f"kind must be one of {sorted(_KIND_FILTERS)}, got {kind!r}"
        )
    if sort is not None and sort not in SORTS:
        raise HTTPException(400, f"sort must be one of {list(SORTS)}, got {sort!r}")
    if offset < 0:
        raise HTTPException(400, f"offset must be >= 0, got {offset}")


@router.get("/entries")
def list_entries(
    kind: str = "audio",
    limit: Optional[int] = None,
    offset: int = 0,
    q: Optional[str] = None,
    sort: Optional[str] = None,
    favorite: Optional[bool] = None,
    source: Optional[str] = None,
    provider: Optional[str] = None,
) -> Any:
    """The library list, in two shapes.

    With NONE of ``limit`` / ``offset`` / ``q`` / ``sort`` / ``favorite`` /
    ``source`` / ``provider`` this is byte-for-byte the endpoint it has always
    been: every entry of the requested kind, plus ``count`` / ``root`` /
    ``kind``. Callers that predate paging keep working unchanged.

    ``provider`` narrows to one origin slug ("suno", "bandcamp", ...) and is a
    DIFFERENT axis from ``source``, which still means generate / studio /
    import. It matches entries labeled at import AND the legacy Suno entries
    that predate labeling.

    With any of them it is paged: filtering, searching and sorting happen in
    SQL, records are built for the page only, and the response adds ``total``
    (rows matching the filters), ``offset``, ``limit`` and ``revision`` (the
    library revision the page was read at, so a client can drop a stale
    response). Long ``lyrics`` are replaced by ``lyrics_preview`` +
    ``has_lyrics``; the full text stays on ``GET /entries/{id}``.

    A search (``q``) adds ``search_index`` (:meth:`~.db.LibraryDB.search_status`):
    while the index is still being built the page covers the entries indexed
    so far and says how many that is, and the answer never waits for the rest.
    While the library is still opening (a schema upgrade) the route answers
    503 with ``library_status`` after at most :data:`OPEN_WAIT_SEC`.
    """
    # Default 'audio' preserves the historical behavior: the tracks/stems/
    # midi library never sees video/image entries. The VIDEO tab requests
    # ?kind=media (video + image); ?kind=all returns everything.
    _validate_listing(kind, sort, offset)
    if limit is not None and not (1 <= limit <= MAX_PAGE_LIMIT):
        raise HTTPException(400, f"limit must be 1..{MAX_PAGE_LIMIT}, got {limit}")
    try:
        store = store_or_opening()
    except LibraryOpening as e:
        return _opening_response(e)

    paged = (
        any(v is not None for v in (limit, q, sort, favorite, source, provider))
        or offset > 0
    )
    if not paged:
        entries = [
            r.to_dict() for r in store.list_entries_fast(kinds=_KIND_FILTERS[kind])
        ]
        _attach_play_counts(store, entries)
        _attach_analysis(store, entries)
        return {
            "entries": entries,
            "count": len(entries),
            "root": str(store.root),
            "kind": kind,
        }

    if store.db is None:
        raise HTTPException(503, "library DB not available")
    page_limit = limit if limit is not None else DEFAULT_PAGE_LIMIT
    filters = _entry_filters(kind, q, favorite, source, provider)
    try:
        entries = [
            r.to_dict()
            for r in store.list_entries_page(
                filters, sort=sort or DEFAULT_SORT, limit=page_limit, offset=offset
            )
        ]
        total = store.db.count_entries_filtered(filters)
    except SearchIndexFailed as e:
        raise HTTPException(503, str(e)) from e
    ids = [str(e["id"]) for e in entries]
    _attach_play_counts(store, entries, ids=ids)
    # A provider-filtered page is labeled exactly as SQL filed it, and nothing
    # is written: see _attach_analysis for why relabeling a filtered result
    # set would be incoherent.
    _attach_analysis(store, entries, ids=ids, derive_provider=provider is None)
    for entry in entries:
        _trim_lyrics(entry)
    body: dict[str, Any] = {
        "entries": entries,
        "count": len(entries),
        "total": total,
        "offset": offset,
        "limit": page_limit,
        "revision": store.db.library_revision(),
        "kind": kind,
    }
    if q is not None:
        body["search_index"] = store.db.search_status()
    return body


def _partial_search_refusal(
    store: LibraryStore, q: Optional[str], what: str
) -> Optional[JSONResponse]:
    """The answer to an action on every match of ``q`` (select every match,
    delete every match) while the search index does not cover the library,
    or None when it may go ahead.

    409 while the index is still being built: a search then covers only the
    entries indexed so far, which is fine to look at and wrong to act on. 503
    when the build stopped: nothing finishes it until it is restarted
    (``POST /retry-open``) or theDAW starts again. Both bodies carry
    ``search_index``, which is how a client tells this 409 from bulk delete's
    count conflict (``total_matched``)."""
    if store.db is None or q is None or not q.strip():
        return None
    status = store.db.search_status()
    if status.get("complete"):
        return None
    if status.get("failed"):
        return JSONResponse(
            status_code=503,
            content={
                "detail": f"the library search index build stopped "
                f"({status.get('error')}); {what} after it is restarted",
                "search_index": status,
            },
        )
    return JSONResponse(
        status_code=409,
        content={
            "detail": f"the search index is still being built "
            f"({status.get('indexed', 0):,} of {status.get('total', 0):,} "
            f"entries); {what} when it finishes",
            "search_index": status,
        },
    )


@router.get("/entries/ids")
def list_entry_ids(
    kind: str = "audio",
    q: Optional[str] = None,
    sort: Optional[str] = None,
    favorite: Optional[bool] = None,
    source: Optional[str] = None,
    provider: Optional[str] = None,
    partial: bool = False,
) -> Any:
    """Every id matching the filters, in the same order the paged list uses.

    This is what select-all and shift-click ranges need: the client holds the
    ids, not the rows. Declared BEFORE ``/entries/{entry_id}`` so the literal
    path is not swallowed by the id parameter. Refuses (413) above
    ``MAX_SELECTABLE_IDS`` rather than streaming an unbounded list.

    While the search index is still being built a search matches the entries
    indexed so far. Select-all acts on every match, so by default a search
    then answers 409. ``partial=true`` is for the callers that follow the
    list on screen (play the list, a shift-click range, revealing a track):
    they get the ids the list shows, and a searched answer carries
    ``search_index`` saying how much of the library that is.
    """
    _validate_listing(kind, sort, 0)
    try:
        store = store_or_opening()
    except LibraryOpening as e:
        return _opening_response(e)
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    if not partial:
        refusal = _partial_search_refusal(store, q, "select every match")
        if refusal is not None:
            return refusal
    filters = _entry_filters(kind, q, favorite, source, provider)
    # One row past the cap comes back when there are more, so no second COUNT
    # is needed to tell "at the limit" from "over it".
    try:
        ids = store.db.list_entry_ids(
            filters, MAX_SELECTABLE_IDS, sort=sort or DEFAULT_SORT
        )
    except SearchIndexFailed as e:
        raise HTTPException(503, str(e)) from e
    if len(ids) > MAX_SELECTABLE_IDS:
        raise HTTPException(
            413,
            f"more than {MAX_SELECTABLE_IDS} entries match; narrow the filters "
            "or the search before selecting them all",
        )
    body: dict[str, Any] = {"ids": ids, "total": len(ids)}
    if q is not None:
        body["search_index"] = store.db.search_status()
    return body


@router.get("/entries/facets")
def entry_facets(
    fields: str,
    kind: str = "audio",
    q: Optional[str] = None,
    favorite: Optional[bool] = None,
    source: Optional[str] = None,
    provider: Optional[str] = None,
) -> Any:
    """Value counts for the filter dropdowns, over the WHOLE filtered library.

    ``fields`` is required and comma-separated; every value must be one of
    :data:`~backend.modules.library.db.FACET_FIELDS` (``model``, ``provider``,
    ``source``, ``kind``). Repeats are answered once, in the order first asked
    for. The remaining parameters are the paged list's filters and mean exactly
    the same thing here, so a dropdown can never offer a value the list would
    not show.

    Each field comes back as ``[{"value", "count"}]`` sorted by count
    descending then value ascending (the "unset" bucket last), capped at
    :data:`~backend.modules.library.db.MAX_FACET_VALUES`. ``revision`` is the
    library revision the counts were read at, so a client can drop a stale
    response -- the same field the paged list carries.

    Declared BEFORE ``/entries/{entry_id}`` so the literal path is not
    swallowed by the id parameter.
    """
    _validate_listing(kind, None, 0)
    requested = [part.strip() for part in fields.split(",") if part.strip()]
    if not requested:
        raise HTTPException(
            400, f"fields must name at least one of {list(FACET_FIELDS)}"
        )
    unknown = [name for name in requested if name not in FACET_FIELDS]
    if unknown:
        raise HTTPException(
            400, f"fields must be among {list(FACET_FIELDS)}, got {unknown}"
        )
    try:
        store = store_or_opening()
    except LibraryOpening as e:
        return _opening_response(e)
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    filters = _entry_filters(kind, q, favorite, source, provider)
    try:
        facets = store.db.facet_counts(filters, requested)
    except SearchIndexFailed as e:
        raise HTTPException(503, str(e)) from e
    body: dict[str, Any] = {
        "facets": facets,
        "revision": store.db.library_revision(),
    }
    if q is not None:
        body["search_index"] = store.db.search_status()
    return body


@router.get("/entries/stats")
def entry_stats(
    kind: str = "audio",
    q: Optional[str] = None,
    favorite: Optional[bool] = None,
    source: Optional[str] = None,
    provider: Optional[str] = None,
) -> Any:
    """Totals over the WHOLE filtered library: ``count``, ``favorites``,
    ``size_bytes`` and ``duration_sec``, for the chips above the library list.

    The parameters are the paged list's filters and mean exactly the same
    thing, so the chips always describe the rows the list is paging through
    -- all of them, not the pages a client happens to hold. ``revision`` is
    the library revision the totals were read at, like the list and the
    facets carry. Declared BEFORE ``/entries/{entry_id}`` so the literal path
    is not swallowed by the id parameter.
    """
    _validate_listing(kind, None, 0)
    try:
        store = store_or_opening()
    except LibraryOpening as e:
        return _opening_response(e)
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    filters = _entry_filters(kind, q, favorite, source, provider)
    try:
        stats = store.db.entry_stats(filters)
    except SearchIndexFailed as e:
        raise HTTPException(503, str(e)) from e
    body: dict[str, Any] = {**stats, "revision": store.db.library_revision()}
    if q is not None:
        body["search_index"] = store.db.search_status()
    return body


@router.get("/entries/resolve")
def resolve_entry_ref(
    ref: str = Query(..., min_length=1, max_length=512),
) -> Any:
    """The audio entry a LOOM score or template names by ``ref`` -- an id, an
    id prefix, or a title fragment -- over the whole library. Answers
    ``{"id": ...}``, with ``null`` when nothing matches. See
    :meth:`~.db.LibraryDB.resolve_entry_ref` for the order of preference.
    Declared BEFORE ``/entries/{entry_id}``.

    A search like the list: while the library is still opening it answers
    503 with ``library_status`` after at most :data:`OPEN_WAIT_SEC`, and the
    LOOM asks again once the library has opened."""
    try:
        store = store_or_opening()
    except LibraryOpening as e:
        return _opening_response(e)
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    return {"id": store.db.resolve_entry_ref(ref)}


class BulkDeleteFilter(BaseModel):
    """The subset of the listing filters a bulk delete may target. ``kind``
    absent means EVERY kind -- an absent filter field never narrows, which is
    what makes ``{}`` mean "the whole library" and why it needs the ``all``
    guard."""

    q: Optional[str] = None
    kind: Optional[str] = None
    favorite: Optional[bool] = None
    source: Optional[str] = None


class BulkDeleteRequest(BaseModel):
    ids: Optional[list[str]] = None
    filter: Optional[BulkDeleteFilter] = None
    confirm_total: Optional[int] = None
    all: bool = False


@router.post(
    "/entries/bulk-delete",
    dependencies=[Depends(require_loopback_or_launch_token)],
)
def bulk_delete_entries(req: BulkDeleteRequest) -> Any:
    """Delete many entries in one request. Two forms, exactly one per call.

    Answers this machine only (``require_loopback_or_launch_token``, the gate
    ``/media-roots`` uses): the filter form can clear the whole library, and a
    LAN caller that sends no browser headers passes every header-based check.

    ``{"ids": [...]}`` deletes those entries, at most
    :data:`MAX_BULK_DELETE_IDS` of them.

    ``{"filter": {...}, "confirm_total": n}`` deletes everything the filter
    matches -- but the SERVER re-counts first, and if the count is not ``n`` it
    answers 409 with the count it saw and deletes NOTHING. That is the whole
    point of the form: the client is confirming a number it showed the user, so
    a library that changed underneath it must not be cleared on the strength of
    a stale one. An empty filter would match the whole library and is refused
    unless ``"all": true`` is sent alongside.

    Answers ``{deleted, failed, total_matched, revision}``. ``failed`` carries
    at most :data:`MAX_BULK_DELETE_ERRORS` entries, and
    ``deleted + (every failure) == total_matched`` always, so a client can tell
    how many failures were elided.

    Declared BEFORE ``/entries/{entry_id}`` so the literal path is not swallowed
    by the id parameter.
    """
    if (req.ids is None) == (req.filter is None):
        raise HTTPException(400, "send exactly one of 'ids' or 'filter'")
    try:
        store = store_or_opening()
    except LibraryOpening as e:
        return _opening_response(e)
    if store.db is None:
        raise HTTPException(503, "library DB not available")

    if req.ids is not None:
        if len(req.ids) > MAX_BULK_DELETE_IDS:
            raise HTTPException(
                400,
                f"at most {MAX_BULK_DELETE_IDS} ids per request, got {len(req.ids)}; "
                "use the filter form to clear more than that",
            )
        ids = list(dict.fromkeys(str(entry_id) for entry_id in req.ids))
        total_matched = len(ids)
    else:
        spec = req.filter
        assert spec is not None  # the exactly-one check above guarantees it
        if req.confirm_total is None:
            raise HTTPException(400, "'confirm_total' is required with 'filter'")
        if spec.kind is not None and spec.kind not in _KIND_FILTERS:
            raise HTTPException(
                400, f"kind must be one of {sorted(_KIND_FILTERS)}, got {spec.kind!r}"
            )
        narrows = (spec.q, spec.kind, spec.favorite, spec.source) != (
            None,
            None,
            None,
            None,
        )
        if not narrows and not req.all:
            raise HTTPException(
                400,
                "an empty filter matches the whole library; resend with "
                '"all": true to confirm that is what you mean',
            )
        refusal = _partial_search_refusal(store, spec.q, "delete every match")
        if refusal is not None:
            return refusal
        filters = _entry_filters(spec.kind or "all", spec.q, spec.favorite, spec.source)
        # Read the matching ids FIRST, capped at what the client confirmed.
        # ``list_entry_ids`` answers at most ``confirm_total + 1`` of them, so
        # a length equal to ``confirm_total`` can only mean the library still
        # has exactly that many matches -- no second COUNT needed. Comparing
        # lengths with no trimming is what makes the deleted set exactly the
        # confirmed set: the previous code counted first, THEN re-read ids
        # newest-first and trimmed to the count, so a row written in that gap
        # landed at the front of the newest-first list and got deleted instead
        # of the oldest row the client actually confirmed.
        ids = store.db.list_entry_ids(filters, req.confirm_total)
        if len(ids) != req.confirm_total:
            # NOTHING has been deleted at this point, and nothing will be.
            # ``list_entry_ids`` saturates at ``confirm_total + 1``, so its
            # length is not the true count once the library has drifted by
            # more than one row -- only the refusal path pays for an exact
            # COUNT, so the total the client is told to re-confirm against
            # is real, not a capped stand-in for it.
            total_matched = store.db.count_entries_filtered(filters)
            return JSONResponse(
                status_code=409,
                content={
                    "detail": (
                        f"the library changed: {total_matched} entries match, not "
                        f"{req.confirm_total}. Re-read the count and try again."
                    ),
                    "total_matched": total_matched,
                },
            )
        total_matched = len(ids)

    result = store.delete_entries_bulk(ids)
    return {
        "deleted": result.deleted,
        "failed": result.failed[:MAX_BULK_DELETE_ERRORS],
        "total_matched": total_matched,
        "revision": store.db.library_revision(),
    }


@router.get("/entries/{entry_id}")
def get_entry(entry_id: str) -> dict[str, Any]:
    try:
        store = store_or_opening()
    except LibraryOpening as e:
        return _opening_response(e)
    record = store.get_entry(entry_id)
    if record is None:
        raise HTTPException(404, f"Entry {entry_id!r} not found")
    data = record.to_dict()
    _attach_play_counts(store, [data])
    _attach_analysis_one(store, data)
    return data


@router.get("/entries/{entry_id}/path")
def get_entry_audio_path(entry_id: str) -> dict[str, Any]:
    """The absolute path of an entry's audio file on this machine.

    The footer's track menu reads it for Show in folder and Copy file path. A
    reference-in-place import resolves to the file where the user keeps it."""
    try:
        store = store_or_opening()
    except LibraryOpening as e:
        return _opening_response(e)
    if store.get_entry(entry_id) is None:
        raise HTTPException(404, f"Entry {entry_id!r} not found")
    audio_path = store.get_audio_path(entry_id)
    if audio_path is None or not audio_path.is_file():
        raise HTTPException(404, f"Entry {entry_id!r} has no audio file on disk")
    return {"id": entry_id, "path": str(audio_path.resolve())}


# Containers Chromium's media stack has no demuxer for. An <audio> pointed at
# one fails with DEMUXER_ERROR_COULD_NOT_OPEN and the UI reports "no supported
# sources" — verified on Chrome 152, where canPlayType('audio/aiff') is "".
# AIFF is the one that bites here (a whole DJ performance-set library is .aiff),
# but the rule is the check, not the list.
_BROWSER_UNPLAYABLE_SUFFIXES = frozenset({".aiff", ".aif", ".aifc", ".wma", ".ape"})
# Remuxed copies of an entry's OWN audio live beside it, in their own folder so
# they can never be mistaken for the source and never match AUDIO_EXTS scans of
# the entry dir. A file the library only REFERENCES (a media root, a folder
# import's source_path) is cached elsewhere entirely -- see `_playable_cache_for`.
_PLAYABLE_CACHE_DIRNAME = "_playable"


def _playable_cache_for(
    audio_path: Path, entry_dir: Optional[Path], entry_id: str
) -> Optional[Path]:
    """Which folder may hold the browser-playable remux of ``audio_path``.

    The entry's own folder ONLY when the file is actually in it. An entry
    resolved from a media root is referenced, not owned: writing a decoded WAV
    into its folder would put bytes in a directory the user never asked us to
    fill (and would make the entry look like it has audio of its own). Those
    land in the data tree instead, keyed by entry id.
    """
    if entry_dir is None:
        return None
    if media_roots.path_is_within(audio_path, entry_dir):
        return entry_dir
    # Keyed by the id the caller asked for, never by `entry_dir.name` -- the
    # nested generate layout names that folder "00", which every job has.
    return media_roots.playable_cache_dir(entry_id)


def _resolve_for_stream(
    store: LibraryStore, entry_id: str
) -> tuple[Optional[Path], Optional[Path]]:
    """``(audio file, folder its remux may be cached in)`` for one entry.

    Every filesystem call the stream path needs before it can answer lives
    here -- the entry dir, the media-root index and its stat, the containment
    check -- because ``stream_audio`` is ``async def`` and hands this to a
    thread. Called inline it would run ON the event loop, where one stat of a
    sleeping external drive stalls every other request in the process.
    """
    audio_path = store.get_audio_path(entry_id)
    if audio_path is None or not audio_path.is_file():
        return None, None
    entry_dir = store._dir_for(entry_id)  # noqa: SLF001
    return audio_path, _playable_cache_for(audio_path, entry_dir, entry_id)


def _entry_dir_and_meta(
    store: LibraryStore, entry_id: str
) -> tuple[Optional[Path], Optional[dict[str, Any]]]:
    """The entry's folder and its metadata, for the remote-copy path. Same
    reason as ``_resolve_for_stream``: ``_dir_for`` stats and
    ``_read_metadata`` reads a file, and neither may do it on the loop."""
    entry_dir = store._dir_for(entry_id)  # noqa: SLF001
    if entry_dir is None:
        return None, None
    return entry_dir, _read_metadata(entry_dir)


def _playable_audio(audio_path: Path, cache_parent: Optional[Path]) -> tuple[Path, str]:
    """``(path, media_type)`` the browser can actually open.

    libsndfile reads AIFF natively, so the fix is a remux to WAV — both are
    PCM, so only the header and the byte order change. Nothing is re-encoded
    and no bit depth is lost; the source's own subtype is carried over.

    Cached under ``cache_parent`` (see ``_playable_cache_for``), so a file
    costs this once rather than once per play, and re-done if the source is
    ever replaced. ``cache_parent`` is required and has no fallback: there is
    no folder this may write to by default. Any failure falls back to serving
    the original: a file the browser refuses is no worse than one that 500s,
    and the log says which happened.
    """
    guessed = mimetypes.guess_type(str(audio_path))[0] or "audio/wav"
    if audio_path.suffix.lower() not in _BROWSER_UNPLAYABLE_SUFFIXES:
        return audio_path, guessed
    if cache_parent is None:
        # Nowhere this may write. The source's own folder is NOT a fallback:
        # it belongs to the user, and a remux dropped beside their file is the
        # bug this cache exists to avoid. The browser gets the original and
        # says it cannot play it, which is the honest answer.
        log.info(
            "library: no cache folder for %s; serving the original", audio_path.name
        )
        return audio_path, guessed

    cache_dir = cache_parent / _PLAYABLE_CACHE_DIRNAME
    cached = cache_dir / f"{audio_path.stem}.wav"
    try:
        if cached.is_file() and cached.stat().st_mtime >= audio_path.stat().st_mtime:
            return cached, "audio/wav"
    except OSError:
        pass

    try:
        import soundfile as sf

        from backend.lib.audio_io import load_audio_array, save_audio

        # Keep 24-bit masters 24-bit; only bump 8/16-bit sources to PCM_16.
        try:
            src_subtype = str(sf.info(str(audio_path)).subtype or "")
        except Exception:  # noqa: BLE001 — the read below is the real gate
            src_subtype = ""
        subtype = (
            "PCM_24"
            if any(w in src_subtype for w in ("24", "32", "FLOAT"))
            else "PCM_16"
        )

        data, sr = load_audio_array(audio_path)
        cache_dir.mkdir(parents=True, exist_ok=True)
        # Write to a sibling then rename: a half-written file is never served.
        staging = cached.with_suffix(".wav.part")
        save_audio(staging, data, sr, format="wav", subtype=subtype)
        staging.replace(cached)
        log.info(
            "library: remuxed %s -> %s (%s) for browser playback",
            audio_path.name,
            cached.name,
            subtype,
        )
        return cached, "audio/wav"
    except Exception as exc:  # noqa: BLE001 — fall back to the original, never 500
        log.warning(
            "library: could not remux %s for playback (%s); serving original",
            audio_path.name,
            exc,
        )
        return audio_path, guessed


#: Entries whose remote copy answered 4xx, with the detail that was served.
#: Bounded and process-lifetime: the point is that a host which has refused
#: once is not asked again by the same run, not that the answer is permanent.
_CDN_REFUSED_CAP = 4096
_cdn_refused: dict[str, str] = {}


def _unreachable_detail(entry_id: str, reason: str) -> str:
    """What the player shows the user: WHY there is no audio, not just 404."""
    return (
        f"Audio for entry {entry_id!r}: no local file in any media root and "
        f"the remote copy is not accessible ({reason})."
    )


def _remember_cdn_refusal(entry_id: str, detail: str) -> None:
    """Record a settled refusal, logging once per entry. Oldest out first so
    a long session over a large library cannot grow this without bound."""
    if entry_id in _cdn_refused:
        return
    if len(_cdn_refused) >= _CDN_REFUSED_CAP:
        _cdn_refused.pop(next(iter(_cdn_refused)))
    _cdn_refused[entry_id] = detail
    log.warning("library: %s", detail)


#: Cache policy for a library entry's local audio. ``no-cache`` means "keep a
#: copy, but ask before using it": every use is a conditional request, and
#: :func:`stream_audio` answers one whose ETag still matches with an empty 304,
#: so a deck reload costs a round trip, not a download. A long ``max-age``
#: skipped the question entirely, which kept the browser playing whatever it
#: first received -- the unplayable original when the AIFF remux had failed,
#: and the old bytes after the user re-exported a referenced file to the same
#: path. ``private`` because a library is one user's: no shared proxy may keep
#: a copy.
_AUDIO_CACHE_CONTROL = "private, no-cache"


def _audio_etag(served: Path, st: os.stat_result) -> str:
    """A strong validator for the bytes ``stream_audio`` is about to send.

    Built from the served path as well as its size and mtime: the path
    changes when a failed remux starts succeeding (the original becomes the
    cached WAV), and size + mtime change when a file is replaced in place.
    Starlette's own ETag uses size + mtime only, and ``FileResponse`` never
    compares it against the request, so on its own it could not answer 304.
    """
    basis = f"{served}|{st.st_size}|{st.st_mtime_ns}"
    return (
        '"'
        + hashlib.sha1(basis.encode("utf-8"), usedforsecurity=False).hexdigest()
        + '"'
    )


def _etag_matches(if_none_match: Optional[str], etag: str) -> bool:
    """RFC 9110 weak comparison of ``If-None-Match`` against ``etag``."""
    if not if_none_match:
        return False
    if if_none_match.strip() == "*":
        return True
    bare = etag.removeprefix("W/")
    return any(
        tag.strip().removeprefix("W/") == bare for tag in if_none_match.split(",")
    )


@router.get("/audio/{entry_id}")
async def stream_audio(entry_id: str, request: Request) -> Response:
    # CHANGED: support CDN-backed entries — if no local file exists but
    # metadata has a cdn_audio_url, proxy the audio from Suno CDN on demand.
    # Even building the store is filesystem work the first time (it walks the
    # library root), and this handler is `async def`, so everything below runs
    # ON the event loop unless it is handed to a thread. A sleeping external
    # drive would otherwise stall every other request in the process.
    store = await asyncio.to_thread(get_store)
    audio_path, cache_parent = await asyncio.to_thread(
        _resolve_for_stream, store, entry_id
    )
    if audio_path is not None:
        # Decoding a long AIFF is seconds of blocking work; off the event loop
        # it goes, or every other request on the server stalls behind it.
        served, media_type = await asyncio.to_thread(
            _playable_audio, audio_path, cache_parent
        )
        # One stat, off the loop, shared by the validator and the response
        # (FileResponse would otherwise stat the file again itself).
        st = await asyncio.to_thread(os.stat, served)
        etag = _audio_etag(served, st)
        headers = {"Cache-Control": _AUDIO_CACHE_CONTROL, "ETag": etag}
        if _etag_matches(request.headers.get("if-none-match"), etag):
            # The browser's copy is these exact bytes: tell it to use it.
            return Response(status_code=304, headers=headers)
        return FileResponse(
            path=str(served),
            media_type=media_type,
            filename=served.name,
            headers=headers,
            stat_result=st,
        )
    # No local file, in the entry or in any media root — the remote copy is
    # the last resort. On the first successful fetch the bytes are persisted
    # next to the entry, so a working CDN costs one download ever.
    entry_dir, meta = await asyncio.to_thread(_entry_dir_and_meta, store, entry_id)
    if entry_dir is not None:
        refused = _cdn_refused.get(entry_id)
        if refused is not None:
            # Asked once, told no. A player that retries eight times must not
            # become eight requests to a host that has already refused.
            raise HTTPException(404, refused)
        cdn_url = (meta or {}).get("cdn_audio_url")
        if cdn_url:
            try:
                async with httpx.AsyncClient(timeout=120.0) as client:
                    resp = await client.get(cdn_url)
                    resp.raise_for_status()
                audio_bytes = resp.content
                # Cache to disk so future requests skip CDN. Written aside and
                # renamed, off the event loop: the next play serves whatever
                # sits at this name, so a write cut short (a full disk, a
                # kill) must leave no file there at all, never half a track.
                local_name = (meta or {}).get("audio_filename") or f"{entry_id}.mp3"
                local_path = entry_dir / local_name
                try:
                    await asyncio.to_thread(atomic_write, local_path, audio_bytes)
                    log.info("library: cached CDN audio to %s", local_path)
                except OSError as write_err:
                    log.warning("library: failed to cache CDN audio: %s", write_err)
                return Response(
                    content=audio_bytes,
                    media_type="audio/mpeg",
                    headers={"X-Audio-Source": "cdn-proxy"},
                )
            except httpx.HTTPStatusError as exc:
                status = exc.response.status_code
                detail = _unreachable_detail(
                    entry_id, f"the host answered HTTP {status}"
                )
                if 400 <= status < 500:
                    # A 4xx is the host's settled answer (a CDN closed to
                    # anonymous requests answers 403 forever), so it is
                    # remembered and logged once for this entry rather than
                    # re-asked on every play.
                    _remember_cdn_refusal(entry_id, detail)
                else:
                    log.warning("library: CDN proxy failed for %s: %s", entry_id, exc)
                raise HTTPException(404, detail) from exc
            except Exception as exc:  # noqa: BLE001
                # A timeout or a dropped connection is not settled: it is
                # logged and the next request is free to try again.
                log.warning("library: CDN proxy failed for %s: %s", entry_id, exc)
                raise HTTPException(
                    404, _unreachable_detail(entry_id, f"the fetch failed: {exc}")
                ) from exc
    raise HTTPException(
        404,
        f"Audio for entry {entry_id!r} not found: no file in the entry, none in "
        "any media root, and no remote copy recorded.",
    )


@router.get("/audio/{entry_id}/cover")
def stream_audio_cover(entry_id: str) -> FileResponse:
    """Serve the cover art for an audio entry (JPEG). Same shape as the media
    poster route: the store normalises everything to one file, so there is no
    content negotiation and a missing cover is a plain 404.

    A bulk-imported entry has no cover on disk (extraction is skipped to keep
    a 200,000-file import from reading every file's tags). ``extract_missing``
    makes the first request for one look, once per entry per process; a track
    that carries no picture still answers 404."""
    try:
        store = store_or_opening()
    except LibraryOpening as e:
        return _opening_response(e)
    cover_path = store.get_cover_path(entry_id, extract_missing=True)
    if cover_path is None or not cover_path.is_file():
        raise HTTPException(404, f"Cover for entry {entry_id!r} not found")
    return FileResponse(path=str(cover_path), media_type="image/jpeg")


@router.post("/audio/{entry_id}/cover")
async def set_audio_cover(
    entry_id: str,
    file: Optional[UploadFile] = File(None),
) -> dict[str, Any]:
    """Attach or refresh an entry's cover art.

    With an uploaded image, that picture becomes the cover; with no upload,
    the entry's audio file is re-read for its embedded front cover. Both go
    through the same normalisation, so an entry can never end up holding a
    30MB PNG. 404 when the entry is unknown, 422 when nothing usable came
    back (no embedded picture, or an image we refused).
    """
    store = await asyncio.to_thread(get_store)
    entry = store.get_entry(entry_id)
    if entry is None:
        raise HTTPException(404, f"Entry {entry_id!r} not found")
    # Audio only. A video/image entry has its own poster route and every list
    # path reports its cover_url as None, so accepting one here would write
    # art no surface can ever show and answer 200 for it.
    if entry.kind != "audio":
        raise HTTPException(404, f"Entry {entry_id!r} is not an audio entry")

    image_bytes: Optional[bytes] = None
    if file is not None:
        # Bounded read: an oversized upload is rejected without ever being
        # held in memory in full.
        image_bytes = await file.read(MAX_EMBEDDED_COVER_BYTES + 1)
        if not image_bytes:
            raise HTTPException(400, "empty image")
        if len(image_bytes) > MAX_EMBEDDED_COVER_BYTES:
            raise HTTPException(413, f"image exceeds {MAX_EMBEDDED_COVER_BYTES} bytes")

    cover_url = store.attach_cover(entry_id, image_bytes)
    if cover_url is None:
        raise HTTPException(
            422,
            "uploaded image could not be used as cover art"
            if file is not None
            else f"Entry {entry_id!r} has no embedded cover art",
        )
    return {
        "id": entry_id,
        "cover_url": cover_url,
        "source": "upload" if file is not None else "embedded",
    }


class CoverBackfillRequest(BaseModel):
    """``overwrite`` re-reads entries that already have art (use after a
    re-tag); ``limit`` caps how many entries one pass touches."""

    overwrite: bool = False
    limit: Optional[int] = None


@router.post("/covers/backfill")
def backfill_covers(
    req: CoverBackfillRequest = Body(default=CoverBackfillRequest()),
) -> dict[str, Any]:
    """Give already-imported audio entries the cover art their files carry.

    Entries imported before covers existed have none on disk; this walks them
    and extracts what is embedded. Idempotent, so it is safe to re-run."""
    limit = req.limit
    if limit is not None and limit < 1:
        raise HTTPException(400, "limit must be >= 1")
    try:
        store = store_or_opening()
    except LibraryOpening as e:
        return _opening_response(e)
    return store.backfill_covers(overwrite=req.overwrite, limit=limit)


@router.get("/stems/{stem_id}/audio")
def stream_stem_audio(stem_id: str) -> FileResponse:
    """Serve the actual WAV bytes for one separated stem so the frontend
    can fetch it as a Blob and feed it into the editor / init / inpaint
    targets (the library audio endpoint only knows about parent tracks,
    not their stem children)."""
    try:
        store = store_or_opening()
    except LibraryOpening as e:
        return _opening_response(e)
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    stem = store.db.get_stem(stem_id)
    if stem is None:
        raise HTTPException(404, f"stem {stem_id!r} not found")
    path = Path(stem.get("audio_path") or "")
    if not path.is_file():
        raise HTTPException(404, f"stem file missing on disk: {path}")
    mime, _ = mimetypes.guess_type(str(path))
    return FileResponse(
        path=str(path),
        media_type=mime or "audio/wav",
        filename=path.name,
    )


@router.patch("/stems/{stem_id}")
def update_stem(stem_id: str, patch: dict[str, Any] = Body(...)) -> dict[str, Any]:
    """Mutate a stem row. Currently only ``favorite`` is user-mutable so
    stems behave like first-class library items."""
    try:
        store = store_or_opening()
    except LibraryOpening as e:
        return _opening_response(e)
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    if "favorite" in patch:
        ok = store.db.set_stem_favorite(stem_id, bool(patch["favorite"]))
        if not ok:
            raise HTTPException(404, f"stem {stem_id!r} not found")
    row = store.db.get_stem(stem_id)
    if row is None:
        raise HTTPException(404, f"stem {stem_id!r} not found")
    return dict(row)


@router.delete("/stems/{stem_id}")
def delete_stem(stem_id: str) -> dict[str, Any]:
    """Delete one separated stem (its WAV on disk + its DB row), leaving the
    parent track and sibling stems untouched."""
    try:
        store = store_or_opening()
    except LibraryOpening as e:
        return _opening_response(e)
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    row = store.db.get_stem(stem_id)
    if row is None:
        raise HTTPException(404, f"stem {stem_id!r} not found")
    audio_path = Path(row.get("audio_path") or "")
    if audio_path.is_file():
        try:
            audio_path.unlink()
        except OSError as e:
            log.warning("library: failed to delete stem file %s: %s", audio_path, e)
    store.db.delete_stem(stem_id)
    return {"deleted": stem_id}


@router.get("/media-roots", dependencies=[Depends(require_loopback_or_launch_token)])
def media_roots_status() -> dict[str, Any]:
    """The media-root index: which folders, how many files, how old, and
    whether a walk is running.

    Loopback-or-launch-token, not merely cross-site-refused: this names
    folders on this machine, and ``refuse_cross_site`` passes any caller that
    simply sends no browser headers -- which a LAN script does by default."""
    return media_roots.status()


@router.post(
    "/media-roots/rescan",
    dependencies=[Depends(require_loopback_or_launch_token)],
)
def rescan_media_roots() -> dict[str, Any]:
    """Walk the roots again on a daemon thread and answer immediately.
    ``started`` is False when a scan was already running — a second walk over
    the same tree would only slow the first."""
    started = media_roots.start_scan(force=True)
    payload = media_roots.status()
    payload["started"] = started
    return payload


@router.get("/media/{entry_id}")
def stream_media(entry_id: str) -> FileResponse:
    """Stream a video/image library entry. FileResponse honors Range
    requests, which video scrubbing needs."""
    try:
        store = store_or_opening()
    except LibraryOpening as e:
        return _opening_response(e)
    media_path = store.get_media_path(entry_id)
    if media_path is None or not media_path.is_file():
        raise HTTPException(404, f"Media for entry {entry_id!r} not found")
    mime, _ = mimetypes.guess_type(str(media_path))
    return FileResponse(
        path=str(media_path),
        media_type=mime or "application/octet-stream",
        filename=media_path.name,
    )


@router.get("/media/{entry_id}/thumb")
def stream_media_thumb(entry_id: str) -> FileResponse:
    """Serve the poster thumbnail for a media entry (JPEG)."""
    try:
        store = store_or_opening()
    except LibraryOpening as e:
        return _opening_response(e)
    thumb_path = store.get_thumb_path(entry_id)
    if thumb_path is None or not thumb_path.is_file():
        raise HTTPException(404, f"Thumbnail for entry {entry_id!r} not found")
    return FileResponse(path=str(thumb_path), media_type="image/jpeg")


@router.post("/import-media")
async def import_media(
    file: UploadFile = File(...),
    metadata: str = Form("{}"),
) -> dict[str, Any]:
    """Import a video or image (kind='video'|'image'). Stores the original
    untouched, probes dimensions / duration / alpha, renders a poster."""
    try:
        meta_dict = json.loads(metadata) if metadata else {}
    except json.JSONDecodeError as e:
        raise HTTPException(400, f"metadata must be JSON: {e}")
    if not isinstance(meta_dict, dict):
        raise HTTPException(400, "metadata must be a JSON object")

    media_bytes = await file.read()
    if not media_bytes:
        raise HTTPException(400, "empty file")

    store = await asyncio.to_thread(get_store)
    try:
        record = store.import_media(
            media_bytes=media_bytes,
            filename=file.filename or "import.bin",
            mime_type=file.content_type or "",
            metadata=meta_dict,
        )
    except ValueError as e:
        raise HTTPException(415, str(e))
    return record.to_dict()


class ImportFolderRequest(BaseModel):
    path: Optional[str] = None
    recursive: bool = True


def _enqueue_import_job(store: LibraryStore, job: ImportJob) -> None:
    """Hand one import job to the project's background queue.

    The queue's consumer awaits ``job.fn`` on the event loop, so the work goes
    through ``asyncio.to_thread`` -- the same shape every other library
    background job uses. The queue is idle-gated and single-consumer: a large
    import waits for the app to go quiet and, while it runs, nothing else
    heavy starts. That is the right ordering for a mass import, but it does
    mean the job may not begin the instant it is queued.
    """

    async def _run() -> None:
        import asyncio

        await asyncio.to_thread(store.run_import_job, job)

    try:
        from backend.core.background_workers import get_background_queue

        get_background_queue().enqueue(f"library-import:{job.id}", _run)
    except Exception as e:  # noqa: BLE001 - the job must report, not raise
        log.warning("library: failed to queue import job %s: %s", job.id, e)
        job.finish("failed", error=f"could not start the import: {e!r}")


@router.get("/import-jobs/{job_id}")
def get_import_job(job_id: str) -> dict[str, Any]:
    """Progress of one async folder import. Jobs live in this process only:
    an unknown id is a 404, including after a restart."""
    job = get_import_jobs().get(job_id)
    if job is None:
        raise HTTPException(404, f"import job {job_id!r} not found")
    return job.snapshot()


@router.delete("/import-jobs/{job_id}")
def cancel_import_job(job_id: str) -> dict[str, Any]:
    """Ask an import to stop. A running job stops after the batch in flight
    commits, so the library is left consistent and the import is resumable --
    re-running it skips everything already registered."""
    job = get_import_jobs().get(job_id)
    if job is None:
        raise HTTPException(404, f"import job {job_id!r} not found")
    job.cancel()
    return job.snapshot()


@router.post("/import-folder", dependencies=[Depends(refuse_cross_site)])
def import_folder(
    req: ImportFolderRequest = Body(default=ImportFolderRequest()),
    run_async: bool = Query(False, alias="async"),
) -> dict[str, Any]:
    """Add a local folder of audio as a playlist, REFERENCE-IN-PLACE: each file
    becomes a library entry that points at the on-disk file (no copy), so it
    plays / analyses like any track. With no ``path``, opens a native folder
    picker in the last music folder added. Returns the created entries; the
    caller builds the setlist.

    With ``?async=1`` the folder is validated here and the scan + registration
    move to a background job: the response is ``{job_id, status_url}`` and the
    caller polls. That is the only form that works for a folder of ~200,000
    songs -- the synchronous one holds a request open for the whole import and
    is capped at ``MAX_SYNC_IMPORT_ENTRIES`` echoed entries.
    """
    folder = req.path
    if not folder:
        from backend.core import folder_dialog

        try:
            folder = folder_dialog.pick_folder(
                title="Choose a music folder to add as a playlist",
                initial=known_paths.last_folder("library-folder"),
            )
        except folder_dialog.PickerError as e:
            raise HTTPException(e.status_code, str(e)) from e
    if not folder:
        return {"cancelled": True, "folder": None, "entries": []}
    root = Path(folder)
    if not root.is_dir():
        raise HTTPException(400, f"not a folder: {folder!r}")
    # Picked or typed, the folder is where the next picker opens.
    known_paths.record(root, "library-folder", source="library-folder")
    try:
        store = store_or_opening()
    except LibraryOpening as e:
        return _opening_response(e)

    if run_async:
        job = get_import_jobs().create(folder=str(root), recursive=req.recursive)
        _enqueue_import_job(store, job)
        return {
            "job_id": job.id,
            "status_url": f"{store.api_prefix}/import-jobs/{job.id}",
        }

    paths = walk_files(root) if req.recursive else root.iterdir()
    files = sorted(
        (p for p in paths if p.is_file() and p.suffix.lower() in AUDIO_EXTS),
        key=lambda p: str(p).lower(),
    )
    entries: list[dict[str, Any]] = []
    created_total = 0
    for f in files:
        rec = store.register_reference(str(f), {"source": "folder"})
        if rec is None:
            continue
        created_total += 1
        # Every entry is created; only the echo is bounded. A 200,000-file
        # folder would otherwise serialize the whole library into one response.
        if len(entries) < MAX_SYNC_IMPORT_ENTRIES:
            entries.append(rec.to_dict())
    return {
        "cancelled": False,
        "folder": str(root),
        "name": root.name,
        "entries": entries,
        "created_total": created_total,
    }


# ---------------------------------------------------------------------------
# Suno full-cache import: stage, then promote
# ---------------------------------------------------------------------------
#
# Two long jobs, both driven through the SAME ``/import-jobs/{id}`` routes as a
# folder import, because from the user's side they are the same thing: a huge
# import you start, watch, and may want to stop. Registered above the
# ``/{entry_id}/...`` routes so ``/suno/stage-report`` is never read as an
# entry id.


_PERF_SETS_DIRNAME = "performance-sets"


def _perf_sets_root() -> Path:
    """`<data>/performance-sets/` — where external set builders
    (Z-AutoDJ) drop prepared sets: one folder per set containing the audio
    files plus a `performance.json` timeline."""
    return paths.data_path(_PERF_SETS_DIRNAME)


def _perf_set_dirs(root: Path) -> list[Path]:
    """Every folder under `root` that holds a `performance.json`, in a stable
    order, so the listing and the register route walk the same sets."""
    return [
        p
        for p in sorted(q for q in root.iterdir() if q.is_dir())
        if (p / "performance.json").is_file()
    ]


def _load_perf_set(
    store: LibraryStore, set_dir: Path, *, register: bool = False
) -> Optional[dict[str, Any]]:
    """Turn one `<set_dir>/performance.json` into a frontend Setlist dict.

    Audio files are registered reference-in-place as library entries so the
    DJ decks + analysis pipeline treat them like any other track. A sidecar
    `.thedaw-import.json` in the set folder maps filename -> entryId so
    repeated calls reuse entries instead of duplicating them.

    That registration is a *write* -- one committed ``upsert_entry`` per track
    plus the sidecar -- so it happens only under ``register=True``, from the
    POST below, when the user opens the set. The default read reports what the
    sidecar already knows and leaves a never-opened track as
    ``entryId: None``, which the frontend's ``SetlistEntry`` already allows
    (`state/setlistStore.ts`: ``entryId: string | null``)."""
    perf_path = set_dir / "performance.json"
    try:
        perf = json.loads(perf_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        log.warning("performance set %s unreadable: %s", set_dir.name, e)
        return None
    tracks = perf.get("tracks")
    if not isinstance(tracks, list) or not tracks:
        log.warning("performance set %s has no tracks", set_dir.name)
        return None

    sidecar_path = set_dir / ".thedaw-import.json"
    try:
        sidecar: dict[str, Any] = json.loads(sidecar_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        sidecar = {}
    if not isinstance(sidecar, dict):
        sidecar = {}
    sidecar_dirty = False

    resolved_set_dir = set_dir.resolve()
    entries: list[dict[str, Any]] = []
    #: What the set IS, independent of whether its tracks have been registered
    #: yet: the id below is hashed from this, not from the entry ids, so the
    #: id a listing hands the frontend is the id registration hands back.
    signature: list[Any] = []
    #: The entries exactly as main's listing built them, from the tracks the
    #: sidecar maps to a live entry. Main hashed its set id over these, so
    #: this rebuilds the id a browser already stored for the same folder.
    legacy_entries: list[dict[str, Any]] = []
    for t in tracks:
        if not isinstance(t, dict):
            continue
        fname = t.get("file")
        if not isinstance(fname, str) or not fname:
            continue
        if (
            fname.startswith(("/", "\\"))
            or re.match(r"^[A-Za-z]:[\\/]", fname)
            or ".." in fname
        ):
            log.warning(
                "performance set %s: rejecting unsafe file %r", set_dir.name, fname
            )
            continue
        audio_path = (set_dir / fname).resolve()
        try:
            audio_path.relative_to(resolved_set_dir)
        except ValueError:
            log.warning(
                "performance set %s: file escapes set dir %r", set_dir.name, fname
            )
            continue
        if not audio_path.is_file():
            log.warning("performance set %s: missing audio %r", set_dir.name, fname)
            continue
        label = t.get("title") or audio_path.stem
        entry_id = sidecar.get(fname)
        if not (isinstance(entry_id, str) and store.get_entry(entry_id) is not None):
            entry_id = None
            if register:
                rec = store.register_reference(
                    str(audio_path),
                    {"source": "performance-set", "title": label},
                )
                if rec is None:
                    continue
                entry_id = rec.id
                sidecar[fname] = entry_id
                sidecar_dirty = True
        perf_block: dict[str, Any] = {}
        for src_key, dst_key in (
            ("cue_in_s", "cueIn"),
            ("mix_out_s", "mixOut"),
            ("transition_s", "transitionSec"),
        ):
            v = t.get(src_key)
            if isinstance(v, (int, float)) and v >= 0:
                perf_block[dst_key] = float(v)
        entry: dict[str, Any] = {
            "entryId": entry_id,
            # The file this row came from. The frontend patches registered ids
            # into the set the user has (which they may have reordered, and
            # two tracks may share a title), and a name is the only thing that
            # identifies a row across that; the label alone cross-binds.
            "file": fname,
            "label": label,
            "kind": "audio",
        }
        if perf_block:
            entry["perf"] = perf_block
        entries.append(entry)
        signature.append([fname, label, perf_block])
        if isinstance(entry_id, str):
            legacy: dict[str, Any] = {
                "entryId": entry_id,
                "label": label,
                "kind": "audio",
            }
            if perf_block:
                legacy["perf"] = perf_block
            legacy_entries.append(legacy)

    if sidecar_dirty:
        try:
            # Atomic: a torn sidecar reads as {} and forgets every entry id the
            # folder had, so the set lists unregistered and main's id is lost.
            atomic_write(sidecar_path, json.dumps(sidecar, indent=2))
        except OSError as e:
            log.warning("performance set %s: sidecar write failed: %s", set_dir.name, e)

    if not entries:
        return None
    name = perf.get("name") if isinstance(perf.get("name"), str) else set_dir.name
    # Deterministic id including a content hash: a rebuilt set (new timeline)
    # gets a NEW id, so the frontend's merge-by-id import picks it up instead
    # of keeping a stale copy. The rebuilt set's old copy stays in the
    # browser's storage, as it always has.
    # Hashed over the timeline, NOT over the entry ids: listing a set and then
    # registering it must produce the same id, or the frontend would file the
    # opened set as a second, duplicate list.
    digest = hashlib.sha1(
        json.dumps(signature, sort_keys=True).encode("utf-8")
    ).hexdigest()[:8]
    slug = re.sub(r"[^a-z0-9]+", "-", str(name).lower()).strip("-") or "set"
    mtime_ms = int(perf_path.stat().st_mtime * 1000)
    set_id = f"zad-{slug}-{digest}"
    # The id main gave this folder: the same slug, hashed over the entry dicts
    # its listing built (it registered every track as it listed, so its ids are
    # the ones in the sidecar). A browser that ran main stored the set under
    # that id; the frontend's import retires it in favour of `id`, carrying
    # the user's edits and active choice over, instead of showing the set
    # twice.
    legacy_ids: list[str] = []
    if legacy_entries:
        legacy_digest = hashlib.sha1(
            json.dumps(legacy_entries, sort_keys=True).encode("utf-8")
        ).hexdigest()[:8]
        legacy_id = f"zad-{slug}-{legacy_digest}"
        if legacy_id != set_id:
            legacy_ids.append(legacy_id)
    return {
        "id": set_id,
        "legacyIds": legacy_ids,
        "name": str(name),
        "entries": entries,
        "createdAt": mtime_ms,
        "updatedAt": mtime_ms,
        "notes": "Imported performance set (Z-AutoDJ)",
    }


@router.get("/setlists")
def list_bundled_setlists() -> dict[str, Any]:
    """Bundled/prepared setlists for the DJ tab. Scans
    `data/performance-sets/<Set>/performance.json` folders (dropped there by
    Z-AutoDJ or by hand) and returns them in the frontend Setlist shape.
    The frontend calls this on startup and merges by id (setlistStore
    `importBundled`); an empty list is a valid, cheap response.

    Read-only, and it has to be: this fires on every startup, and registering
    a set's tracks here put one committed write per file behind a page load
    (caught by `tests/test_library_api_at_scale.py`). A set nobody has opened
    still lists -- with `entryId: null` on each track the sidecar does not
    know yet. `POST /setlists/{set_id}/register` fills those in."""
    root = _perf_sets_root()
    if not root.is_dir():
        return {"setlists": []}
    try:
        store = store_or_opening()
    except LibraryOpening as e:
        return _opening_response(e)
    setlists: list[dict[str, Any]] = []
    for set_dir in _perf_set_dirs(root):
        loaded = _load_perf_set(store, set_dir)
        if loaded is not None:
            setlists.append(loaded)
    return {"setlists": setlists}


#: One lock per performance-set folder, so two clients opening the same set at
#: once cannot both read the same stale sidecar and register its tracks twice.
#: The store de-duplicates on ``source_path`` as well (and that is the guarantee
#: that survives two processes); this keeps the sidecar write coherent and keeps
#: the second caller off the file system while the first is registering.
_PERF_SET_LOCKS: dict[str, threading.Lock] = {}
_PERF_SET_LOCKS_GUARD = threading.Lock()


def _perf_set_lock(set_dir: Path) -> threading.Lock:
    key = str(set_dir.resolve())
    with _PERF_SET_LOCKS_GUARD:
        return _PERF_SET_LOCKS.setdefault(key, threading.Lock())


@router.post("/setlists/{set_id}/register", dependencies=[Depends(refuse_cross_site)])
def register_bundled_setlist(set_id: str) -> dict[str, Any]:
    """Register one bundled set's audio files — the write half of the route
    above, run when the user opens the set rather than when the tab loads.

    Idempotent: a track the sidecar already maps to a live entry is reused,
    so opening the same set twice registers nothing the second time. The
    returned Setlist has the same id and the same shape the listing returns,
    with the `entryId`s filled in, so the frontend can drop it straight over
    the copy it merged at startup."""
    root = _perf_sets_root()
    if root.is_dir():
        try:
            store = store_or_opening()
        except LibraryOpening as e:
            return _opening_response(e)
        for set_dir in _perf_set_dirs(root):
            listed = _load_perf_set(store, set_dir)
            if listed is None or listed["id"] != set_id:
                continue
            with _perf_set_lock(set_dir):
                registered = _load_perf_set(store, set_dir, register=True)
            if registered is not None:
                return {"setlist": registered}
            break
    # No id in the message: it comes from the caller, and an error page is the
    # last place to echo one back.
    raise HTTPException(404, "no such bundled performance set")


@router.post("/reindex")
def reindex_library(analyze: bool = False) -> dict[str, Any]:
    """Walk the on-disk library and upsert every entry into the SQLite mirror.
    Heals entries added to data/generations outside the API (dropped in by
    hand, synced from another machine, ...). store.reindex() is idempotent,
    so repeated calls are safe.

    ``analyze`` (query param, default ``false``) opts in to enqueuing
    background analysis for new/changed entries (LIB-002); the default is a
    heal-only pass that never analyzes, because a lost or empty DB next to an
    existing 200,000-entry library would otherwise make EVERY entry look
    "new" and mass re-analyze the whole thing -- the user's hard rule is
    never to do that. Even with ``analyze=true``, more than
    :data:`MAX_REINDEX_ANALYSIS_ENQUEUE` new/changed entries in one call
    enqueues none and reports ``analysis_skipped`` instead, rather than
    flooding the analysis worker."""
    try:
        store = store_or_opening()
    except LibraryOpening as e:
        return _opening_response(e)
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    report: dict[str, Any] = {}
    reindexed = store.reindex(
        enqueue_analysis=analyze,
        max_enqueue=MAX_REINDEX_ANALYSIS_ENQUEUE,
        report=report,
    )
    if report.get("analysis_skipped"):
        return {
            "reindexed": reindexed,
            "analysis_skipped": report["analysis_skipped"],
            "reason": "too many entries to queue at once",
        }
    return {"reindexed": reindexed, "analysis_enqueued": report.get("enqueued", 0)}


@router.patch("/entries/{entry_id}")
def update_entry(entry_id: str, patch: dict[str, Any] = Body(...)) -> dict[str, Any]:
    try:
        store = store_or_opening()
    except LibraryOpening as e:
        return _opening_response(e)
    record = store.update_entry(entry_id, patch)
    if record is None:
        raise HTTPException(404, f"Entry {entry_id!r} not found")
    return record.to_dict()


@router.post("/entries/{entry_id}/play")
def register_play(entry_id: str) -> dict[str, Any]:
    """Increment the persistent play counter. The player calls this when a
    track starts. Survives restarts (SQLite), and metadata edits / re-analysis
    leave it intact (upsert_entry never writes play_count)."""
    try:
        store = store_or_opening()
    except LibraryOpening as e:
        return _opening_response(e)
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    new_count = store.db.increment_play_count(entry_id)
    if new_count is None:
        # On disk but missing a DB row (added out-of-band): sync, then retry.
        record = store.get_entry(entry_id)
        if record is None:
            raise HTTPException(404, f"Entry {entry_id!r} not found")
        entry_dir = store._dir_for(entry_id)  # noqa: SLF001
        meta = _read_metadata(entry_dir) if entry_dir is not None else None
        store._sync_record_to_db(record, meta or {})  # noqa: SLF001
        new_count = store.db.increment_play_count(entry_id) or 1
    return {"id": entry_id, "play_count": new_count}


class SuggestRequest(BaseModel):
    target_duration_sec: float = 1800.0
    bpm_min: Optional[float] = None
    bpm_max: Optional[float] = None
    harmonic: bool = True
    flow: str = "steady"
    genre: Optional[str] = None
    query: Optional[str] = None
    seed_id: Optional[str] = None
    max_tracks: int = 60


@router.post("/suggest-playlist")
def suggest_playlist_endpoint(req: SuggestRequest = Body(...)) -> dict[str, Any]:
    """Build an analysis-driven playlist (harmonic + bpm-flow sequencing) that
    fits the requested time budget. Needs the DB, where analysis lives."""
    try:
        store = store_or_opening()
    except LibraryOpening as e:
        return _opening_response(e)
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    from .suggester import suggest_playlist

    return suggest_playlist(
        store.db,
        target_duration_sec=req.target_duration_sec,
        bpm_min=req.bpm_min,
        bpm_max=req.bpm_max,
        harmonic=req.harmonic,
        flow=req.flow,
        genre=req.genre,
        query=req.query,
        seed_id=req.seed_id,
        max_tracks=req.max_tracks,
    )


@router.delete("/entries/{entry_id}")
def delete_entry(entry_id: str) -> dict[str, Any]:
    try:
        store = store_or_opening()
    except LibraryOpening as e:
        return _opening_response(e)
    ok = store.delete_entry(entry_id)
    if not ok:
        raise HTTPException(
            404, f"Entry {entry_id!r} not found or could not be deleted"
        )
    return {"deleted": entry_id}


@router.get("/index-status")
async def library_index_status() -> dict[str, Any]:
    """Where opening the library has got, for the LIBRARY tab's progress bar:
    ``{phase, label, done, total, items, eta_sec, opened, error}``.

    ``phase`` is ``upgrade`` (schema migration statements), ``read`` (the
    top-level folders of a first start's read of every ``metadata.json``;
    ``items`` counts the entries found), ``index`` (entries in the search
    index), ``opening``, ``ready`` or ``failed``. Answers from memory at once,
    whatever holds the database: it never takes the write lock.

    It starts the open only when no attempt exists for the library folder.
    A failed open stays ``failed`` here until the Retry button
    (``POST /retry-open``), or a caller that needs the store after
    :data:`OPEN_RETRY_AFTER_SEC`, starts another. An ``async`` route, so it
    runs on the event loop and answers even while every threadpool thread is
    busy. Declared before the ``/{entry_id}/...`` routes so the literal path
    is not swallowed by the entry-id parameter."""
    if _store is None:
        attempt = _opening
        if attempt is None or attempt.root != default_library_root():
            start_opening()
    return library_status()


@router.post("/retry-open", dependencies=[Depends(refuse_cross_site)])
async def library_retry_open() -> dict[str, Any]:
    """The Retry button of the LIBRARY tab's failure alert: open the library
    again after a failed open, or restart a search index build that stopped
    (from its last committed batch). Answers the new ``index-status``
    snapshot once the work has started; the open and the build run on
    threads of their own. The start itself (the library root lookup, the
    build's first statements under the database lock) runs off the event
    loop."""
    store = _store
    if store is None:
        await asyncio.to_thread(start_opening, retry=True)
    elif store.db is not None:
        await asyncio.to_thread(store.db.restart_search_build)
    return library_status()


@router.get("/summary")
def library_summary() -> Any:
    """Category counts for the library tab strip, plus the DB revision they
    were read at. Declared before the ``/{entry_id}/...`` routes so a literal
    path can never be swallowed by the entry-id parameter."""
    try:
        store = store_or_opening()
    except LibraryOpening as e:
        return _opening_response(e)
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    return store.db.library_counts()


@router.get("/{entry_id}/bundle")
def download_bundle(entry_id: str) -> Response:
    try:
        store = store_or_opening()
    except LibraryOpening as e:
        return _opening_response(e)
    record = store.get_entry(entry_id)
    if record is None:
        raise HTTPException(404, f"Entry {entry_id!r} not found")

    audio_path = store.get_audio_path(entry_id)
    entry_dir = store._dir_for(entry_id)  # noqa: SLF001
    metadata_path = (entry_dir / "metadata.json") if entry_dir else None

    analysis: Optional[dict[str, Any]] = None
    stems: list[dict[str, Any]] = []
    midis: list[dict[str, Any]] = []
    scores: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []
    if store.db is not None:
        analysis = store.db.get_analysis(entry_id)
        stems = store.db.list_stems(entry_id)
        midis = store.db.list_midis(entry_id)
        # Recover scores that exist on disk but lost their DB row, otherwise a
        # bundle silently ships without notation the entry demonstrably has.
        if entry_dir is not None:
            try:
                from backend.modules.notation.engine import register_on_disk_artifacts

                register_on_disk_artifacts(store.db, entry_dir, entry_id)
            except Exception as exc:  # noqa: BLE001 - recovery is best-effort
                log.debug("bundle: artifact recovery skipped for %s: %s", entry_id, exc)
        # Notation artifacts minus raw midi (already bundled under midi/).
        scores = [
            a
            for a in store.db.list_notation_artifacts(entry_id)
            if a.get("kind") != "midi"
        ]
        # Edges where entry is either parent or child.
        edges = store.db.list_relations(from_id=entry_id) + store.db.list_relations(
            to_id=entry_id
        )

    # Engrave a printable PDF for every sheet and tab in the bundle. Imported
    # here rather than at module scope so the library router keeps loading even
    # if the notation module is disabled or its deps are missing.
    pdf_renderer = None
    unity_package: Optional[Path] = None
    try:
        from backend.modules.notation.pdf_render import (
            available,
            render_musicxml_pdf,
            unity_package_dir,
        )

        if available()["ok"]:
            pdf_renderer = render_musicxml_pdf
        else:
            log.info("bundle: PDF engraving unavailable, shipping sources only")
        unity_package = unity_package_dir()
    except Exception as exc:  # noqa: BLE001 - a bundle must never fail over extras
        log.info("bundle: notation extras unavailable (%s)", exc)

    # The Unity flying-notation chart, written to a scratch file for the zip. It
    # is derived from the first sheet rather than stored, so it always matches
    # the notation actually in the bundle.
    with tempfile.TemporaryDirectory() as staging:
        unity_chart: Optional[Path] = None
        sheet = next(
            (
                Path(s["path"])
                for s in scores
                if str(s.get("kind")) == "musicxml"
                and Path(s.get("path") or "").is_file()
            ),
            None,
        )
        if sheet is not None:
            try:
                from backend.modules.notation.engine import artist_name, clean_title
                from backend.modules.notation.exporters.notechart import write_notechart

                candidate = Path(staging) / f"{sheet.stem}.notechart.json"
                result = write_notechart(
                    sheet,
                    candidate,
                    title=clean_title(record.title or ""),
                    artist=artist_name(),
                    entry_id=entry_id,
                )
                if result.get("ok") and candidate.is_file():
                    unity_chart = candidate
                else:
                    log.info("bundle: note chart skipped (%s)", result.get("error"))
            except Exception as exc:  # noqa: BLE001 - a bundle must never fail over extras
                log.info("bundle: note chart unavailable (%s)", exc)

        data = build_bundle_bytes(
            entry_id=entry_id,
            record=record.to_dict(),
            audio_path=audio_path,
            metadata_path=metadata_path,
            analysis=analysis,
            stems=stems,
            midis=midis,
            scores=scores,
            lineage_edges=edges,
            pdf_renderer=pdf_renderer,
            unity_chart=unity_chart,
            unity_package_dir=unity_package,
        )

    safe_title = "".join(
        c if c.isalnum() or c in "-_." else "_" for c in (record.title or "entry")
    )[:60]
    filename = f"{safe_title}_{entry_id[:8]}.zip"
    return Response(
        content=data,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


#: The most nodes one song's lineage answer may carry.
#:
#: This BFS is the lineage request that stays available on a library too large
#: for the whole-library graph, so it has to be bounded in its own right: one
#: hub with tens of thousands of relatives must not be able to hand the browser
#: the very answer the whole-library route was withdrawn for.
#:
#: The cut follows the walk, so it takes from the far edge of the family, never
#: from the near one: a hop is admitted in full before the next hop is looked
#: at, and the root's own parents and children are the first hop. When the cap
#: bites, the answer says so (``truncated`` and ``capped``) and names the cap
#: it was cut at. The cap bounds what one screen draws; ``/lineage/full`` is the
#: walk that carries the whole family, for an export or an explicit request.
LINEAGE_MAX_NODES = 600

#: The deepest walk either lineage route takes, in hops from the song.
LINEAGE_MAX_DEPTH = 10

#: The most relation rows ONE hop of the walk may read.
#:
#: :data:`LINEAGE_MAX_NODES` bounds the ANSWER; this bounds the WORK. Asking a
#: hub for its relations one node at a time and materialising every row builds
#: a dict per relation before the node cap can refuse anything — and a welded
#: mashup component in this library runs to 81,000 songs. One projected,
#: limited statement per hop makes both the work and the memory a function of
#: these constants and not of one song's degree.
LINEAGE_MAX_EDGES_PER_HOP = 4000

#: The columns a lineage edge carries on the wire. ``relations`` also holds
#: ``metadata_json``; nothing drawing this graph reads it.
_LINEAGE_EDGE_COLUMNS = ("from_id", "to_id", "kind")
_LINEAGE_EDGE_SELECT = ", ".join(_LINEAGE_EDGE_COLUMNS)


def _lineage_relation_rows(
    db: LibraryDB, ids: list[str], limit: int
) -> tuple[list[dict[str, Any]], bool]:
    """Up to ``limit`` DISTINCT relation rows touching ``ids``, either way.

    Returns the rows and whether a read was stopped by its bound — which is
    the walk's signal that this hop was cut.

    Three things this shape is careful about:

    * **Both directions get half the budget each**, in their own statement.
      Read together, whichever direction the rows happen to be stored in
      first spends the whole budget, and a cut hub comes back with 4,000
      parents and no children — a picture of the read order, not of the song.
    * **A row is counted once.** An id is listed once per chunk, so an edge
      between ids in different chunks is read twice, and an edge between two
      frontier ids is read once per direction. Budget spent on a row the
      answer already holds buys nothing. The CUT, though, is judged on the
      raw page: a page that came back full has rows behind it that were
      never read, whether or not the ones in hand were repeats.
    * **No ``ORDER BY``.** ``relations.id`` is the rowid while the ``IN`` is
      served by ``idx_relations_from`` / ``idx_relations_to``, so ordering by
      it makes SQLite visit every matching index entry and sort before the
      ``LIMIT`` can bite — Σ(degree) rows under the write lock, which is the
      cost this whole helper exists to avoid. The returned rows are sorted in
      Python instead, where the count is already bounded by ``limit``."""
    out: list[dict[str, Any]] = []
    unique = list(dict.fromkeys(ids))
    if not unique or limit <= 0:
        return out, False
    hit_limit = False
    seen_keys: set[tuple[str, str, str]] = set()
    # ids + the LIMIT parameter must fit the statement's budget; halved again
    # so the same chunk size is safe if the two sides are ever read together.
    chunk_size = max(1, (_MAX_SQL_PARAMS - 1) // 2)
    first_half = max(1, limit // 2)
    budgets = (("from_id", first_half), ("to_id", max(1, limit - first_half)))
    with db._writelock:  # noqa: SLF001 — the DB exposes no bounded projection
        cur = db._conn.cursor()  # noqa: SLF001
        try:
            for column, budget in budgets:
                taken = 0
                for chunk in _chunks(unique, chunk_size):
                    remaining = budget - taken
                    if remaining <= 0:
                        hit_limit = True
                        break
                    marks = ", ".join("?" * len(chunk))
                    # One row past the budget, so "there was more" is read off
                    # the answer rather than guessed from a full page.
                    rows = cur.execute(
                        f"SELECT {_LINEAGE_EDGE_SELECT} FROM relations "
                        f"WHERE {column} IN ({marks}) LIMIT ?",
                        [*chunk, remaining + 1],
                    ).fetchall()
                    fresh: list[tuple[tuple[str, str, str], dict[str, Any]]] = []
                    page_keys: set[tuple[str, str, str]] = set()
                    for row in rows:
                        edge = {k: row[k] for k in _LINEAGE_EDGE_COLUMNS}
                        key = (edge["from_id"], edge["to_id"], edge["kind"])
                        if key in seen_keys or key in page_keys:
                            continue
                        page_keys.add(key)
                        fresh.append((key, edge))
                    # The page was read one row past the budget. If it came
                    # back full, the rows BEHIND it were never looked at —
                    # and that is true however many of the ones in hand were
                    # repeats. Saying "there is more" when there is not costs
                    # the user one honest sentence; saying a family is whole
                    # when rows were never read is the lie.
                    if len(rows) > remaining:
                        hit_limit = True
                    # The budget itself is still spent only on new rows.
                    if len(fresh) > remaining:
                        fresh = fresh[:remaining]
                    for key, edge in fresh:
                        seen_keys.add(key)
                        out.append(edge)
                        taken += 1
        finally:
            cur.close()
    # Bounded by `limit`, so this sort is cheap — and it is the determinism
    # the dropped ORDER BY would have cost a whole index scan to get.
    out.sort(key=lambda e: (e["from_id"], e["to_id"], e["kind"]))
    return out, hit_limit


#: The columns a lineage node carries — and therefore the only ones read.
#: ``entries`` also holds ``metadata_json``, so a whole-row read would drag one
#: blob per node through the connection for a payload that ships four fields.
_LINEAGE_NODE_COLUMNS = ("id", "title", "source", "duration_sec")
_LINEAGE_NODE_SELECT = ", ".join(_LINEAGE_NODE_COLUMNS)


def _lineage_entry_rows(db: LibraryDB, ids: list[str]) -> dict[str, dict[str, Any]]:
    """Those four columns for these ids, in chunked bulk reads.

    One statement per chunk rather than one per node: the cap allows 600
    relatives, and 600 round trips to read four fields each is the shape this
    mirrors from ``lineagescale``'s ``_entry_rows``."""
    out: dict[str, dict[str, Any]] = {}
    unique = list(dict.fromkeys(ids))
    if not unique:
        return out
    with db._writelock:  # noqa: SLF001 — the DB exposes no bulk projection
        cur = db._conn.cursor()  # noqa: SLF001
        try:
            for chunk in _chunks(unique, _MAX_SQL_PARAMS):
                marks = ", ".join("?" * len(chunk))
                rows = cur.execute(
                    f"SELECT {_LINEAGE_NODE_SELECT} FROM entries WHERE id IN ({marks})",
                    list(chunk),
                ).fetchall()
                for row in rows:
                    out[str(row["id"])] = {k: row[k] for k in _LINEAGE_NODE_COLUMNS}
        finally:
            cur.close()
    return out


@router.get("/{entry_id}/lineage")
def get_lineage(entry_id: str, depth: int = 3) -> dict[str, Any]:
    """Return nodes + edges within ``depth`` hops of ``entry_id``.

    BFS over the ``relations`` table in both directions (parents AND
    children). Cheap because edges are indexed both ways, and bounded by
    :data:`LINEAGE_MAX_NODES` so an enormous family is cut rather than sent.

    ``truncated`` says more of the family exists than the answer holds, for
    any reason. ``capped`` says a bound of this route cut it (the node cap or
    the per-hop read), which is the case ``/lineage/full`` answers in full; a
    family that is only deeper than ``depth`` is ``truncated`` and not
    ``capped``."""
    try:
        store = store_or_opening()
    except LibraryOpening as e:
        return _opening_response(e)
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    record = store.get_entry(entry_id)
    if record is None:
        raise HTTPException(404, f"entry {entry_id!r} not found")

    depth = max(0, min(int(depth), LINEAGE_MAX_DEPTH))
    seen_ids: set[str] = {entry_id}
    edges: list[dict[str, Any]] = []
    frontier: list[str] = [entry_id]
    capped = False
    for _ in range(depth):
        hop_rows, hop_cut = _lineage_relation_rows(
            store.db, frontier, LINEAGE_MAX_EDGES_PER_HOP
        )
        if hop_cut:
            capped = True
        next_frontier: list[str] = []
        for e in hop_rows:
            for nb in (e["from_id"], e["to_id"]):
                if nb in seen_ids:
                    continue
                if len(seen_ids) >= LINEAGE_MAX_NODES:
                    capped = True
                    continue
                seen_ids.add(nb)
                next_frontier.append(nb)
            # An edge to a node the cap refused would dangle, so it is
            # kept only once BOTH of its ends are in the answer.
            if e["from_id"] in seen_ids and e["to_id"] in seen_ids:
                edges.append(e)
        # The hop that hit a bound is finished — so the near family is whole —
        # and then the walk stops rather than filling up on distant cousins.
        frontier = next_frontier
        if capped or not frontier:
            break
    truncated = capped
    # Relatives the DEPTH never reached are left out just as surely as ones a
    # cap refused, and `truncated` is this answer's word for "there is more of
    # this family than you are looking at" (`capped` covers the caps alone,
    # which loading the whole family can undo). But a frontier is not
    # itself evidence of one: a family whose last generation lands exactly on
    # the final hop leaves the walk holding a frontier with nothing beyond it,
    # and calling that cut tells the user part of their family is hidden when
    # all of it is on screen. So it is asked, once, within the same bound a
    # real hop uses.
    #
    # The probe answers "yes" outright when it finds a song the walk never
    # reached. Its other "yes" is an admission rather than a finding: a probe
    # whose own read filled up never looked at the rows past it, so a page
    # carrying only already-seen songs settles nothing. Between claiming a
    # family is whole and admitting it might not be, the answer that cannot
    # mislead is the second, so an unread remainder counts as "there is more".
    if not truncated and frontier:
        beyond, probe_cut = _lineage_relation_rows(
            store.db, frontier, LINEAGE_MAX_EDGES_PER_HOP
        )
        found_unseen = any(
            e["from_id"] not in seen_ids or e["to_id"] not in seen_ids for e in beyond
        )
        truncated = found_unseen or probe_cut

    # Materialize node payloads for everything we touched.
    rows_by_id = _lineage_entry_rows(store.db, list(seen_ids))
    nodes = [
        _lineage_node_payload(node_id, rows_by_id.get(node_id)) for node_id in seen_ids
    ]

    # Dedup edges by (from, to, kind).
    seen_edges = set()
    deduped_edges: list[dict[str, Any]] = []
    for e in edges:
        key = (e["from_id"], e["to_id"], e["kind"])
        if key in seen_edges:
            continue
        seen_edges.add(key)
        deduped_edges.append(e)

    return {
        "root": entry_id,
        "nodes": nodes,
        "edges": deduped_edges,
        "truncated": truncated,
        "capped": capped,
        "node_cap": LINEAGE_MAX_NODES,
    }


#: Rows one read of the whole-family walk takes from SQLite at a time, so one
#: hub's relations never sit in memory whole.
_LINEAGE_FULL_FETCH = 2000

#: Edge text held in memory before the whole-family walk spills it to disk.
#: The JSON carries the nodes before the edges, and the edges are found during
#: the same walk, so they wait in a temporary file until the nodes are sent.
_LINEAGE_FULL_SPOOL_BYTES = 8 * 1024 * 1024

#: The columns an edge of the whole-family answer carries: the whole
#: ``relations`` row, as Save lineage wrote it before the cap (weight, metadata
#: and time included). The screen route sends three of them; a saved family is
#: a record, not a drawing.
_LINEAGE_FULL_EDGE_COLUMNS = (
    "id",
    "from_id",
    "to_id",
    "kind",
    "weight",
    "metadata_json",
    "created_at",
)
_LINEAGE_FULL_EDGE_SELECT = ", ".join(_LINEAGE_FULL_EDGE_COLUMNS)


def _lineage_node_payload(node_id: str, row: dict[str, Any] | None) -> dict[str, Any]:
    """One node as both lineage routes send it."""
    if row is None:
        # Stem / midi / external label: kept in the graph without a full row
        # so the visualization can show it as a placeholder.
        return {"id": node_id, "kind": "external"}
    return {
        "id": node_id,
        "kind": "entry",
        "title": row.get("title"),
        "source": row.get("source"),
        "duration_sec": row.get("duration_sec"),
    }


def _lineage_has_unseen(db: LibraryDB, ids: list[str], hop_of: dict[str, int]) -> bool:
    """Whether any song related to ``ids`` is missing from ``hop_of``.

    Stops at the first one, so a wide last generation costs only the rows read
    before the answer is known."""
    with db._writelock:
        cur = db._conn.cursor()
        try:
            for column, other in (("from_id", "to_id"), ("to_id", "from_id")):
                for chunk in _chunks(ids, _MAX_SQL_PARAMS):
                    marks = ", ".join("?" * len(chunk))
                    cur.execute(
                        f"SELECT {other} FROM relations WHERE {column} IN ({marks})",
                        list(chunk),
                    )
                    while True:
                        rows = cur.fetchmany(_LINEAGE_FULL_FETCH)
                        if not rows:
                            break
                        if any(str(r[0]) not in hop_of for r in rows):
                            return True
        finally:
            cur.close()
    return False


def _lineage_full_hop(
    db: LibraryDB,
    chunk: Sequence[str],
    hop: int,
    hop_of: dict[str, int],
    write_edge: Callable[[dict[str, Any]], None],
) -> list[str]:
    """Walk one chunk of generation ``hop``: every relation touching it.

    Songs reached for the first time get ``hop + 1`` in ``hop_of`` and are
    returned. Each edge goes to ``write_edge`` once: from the side of the
    endpoint the walk reached first, and from its ``from_id`` side when both
    ends are in the same generation. ``relations`` is UNIQUE on (from_id,
    to_id, kind), so a key is one row, and every row with a given end is read
    by the one statement whose chunk holds that end. The write lock is held for
    this chunk only."""
    found: list[str] = []
    marks = ", ".join("?" * len(chunk))
    with db._writelock:
        cur = db._conn.cursor()
        try:
            for column, other in (("from_id", "to_id"), ("to_id", "from_id")):
                cur.execute(
                    f"SELECT {_LINEAGE_FULL_EDGE_SELECT} FROM relations "
                    f"WHERE {column} IN ({marks})",
                    list(chunk),
                )
                while True:
                    rows = cur.fetchmany(_LINEAGE_FULL_FETCH)
                    if not rows:
                        break
                    for row in rows:
                        far = str(row[other])
                        far_hop = hop_of.get(far)
                        if far_hop is None:
                            far_hop = hop + 1
                            hop_of[far] = far_hop
                            found.append(far)
                        if far_hop < hop or (far_hop == hop and column == "to_id"):
                            continue
                        write_edge({k: row[k] for k in _LINEAGE_FULL_EDGE_COLUMNS})
        finally:
            cur.close()
    return found


def _lineage_full_chunks(db: LibraryDB, entry_id: str, depth: int) -> Iterator[str]:
    """The whole family within ``depth`` hops, as JSON text in pieces.

    The same document ``/lineage`` answers (``root``, ``nodes``, ``edges``,
    ``truncated``, ``capped``) with no node cap and no per-hop bound, plus
    ``depth``, ``node_count`` and ``edge_count``. The counts come last, so a
    reader can tell a whole answer from one cut off mid-stream.

    What stays in memory is the map of song id to hop and one fetch of rows;
    the edges wait in a spooled temporary file while the nodes are sent. The
    write lock is taken per chunk of ids inside :func:`_lineage_full_hop` and
    is never held across a ``yield``."""
    hop_of: dict[str, int] = {entry_id: 0}
    edge_count = 0
    spool = tempfile.SpooledTemporaryFile(
        max_size=_LINEAGE_FULL_SPOOL_BYTES, mode="w+", encoding="utf-8"
    )

    def write_edge(edge: dict[str, Any]) -> None:
        nonlocal edge_count
        if edge_count:
            spool.write(", ")
        spool.write(json.dumps(edge))
        edge_count += 1

    def nodes_json(ids: list[str]) -> str:
        rows = _lineage_entry_rows(db, ids)
        return ", ".join(json.dumps(_lineage_node_payload(i, rows.get(i))) for i in ids)

    try:
        yield f'{{"root": {json.dumps(entry_id)}, "depth": {depth}, "nodes": ['
        yield nodes_json([entry_id])
        node_count = 1
        frontier: list[str] = [entry_id]
        hop = 0
        while frontier and hop < depth:
            next_frontier: list[str] = []
            for chunk in _chunks(frontier, _MAX_SQL_PARAMS):
                found = _lineage_full_hop(db, chunk, hop, hop_of, write_edge)
                if found:
                    yield ", " + nodes_json(found)
                    node_count += len(found)
                    next_frontier.extend(found)
            frontier = next_frontier
            hop += 1
        # Relatives past the depth are left out, and the answer says so the
        # way the capped route does. The last generation reached is the
        # frontier the walk stopped holding.
        truncated = bool(frontier) and _lineage_has_unseen(db, frontier, hop_of)
        yield '], "edges": ['
        spool.seek(0)
        while True:
            block = spool.read(1 << 16)
            if not block:
                break
            yield block
        tail = {
            "truncated": truncated,
            "capped": False,
            "node_cap": None,
            "node_count": node_count,
            "edge_count": edge_count,
        }
        yield "], " + json.dumps(tail)[1:]
    finally:
        spool.close()


@router.get("/{entry_id}/lineage/full")
def get_lineage_full(entry_id: str, depth: int = 8) -> StreamingResponse:
    """The whole family within ``depth`` hops of ``entry_id``, streamed.

    ``/lineage`` stops at :data:`LINEAGE_MAX_NODES` so one screen never has to
    draw an enormous family. This walk has no node cap: Save lineage writes the
    whole family with it, and INFO loads it when the user asks for the whole
    family. The JSON is written while the walk runs, so the server never holds
    the family's whole answer in memory."""
    try:
        store = store_or_opening()
    except LibraryOpening as e:
        return _opening_response(e)
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    if store.get_entry(entry_id) is None:
        raise HTTPException(404, f"entry {entry_id!r} not found")
    depth = max(0, min(int(depth), LINEAGE_MAX_DEPTH))
    return StreamingResponse(
        _lineage_full_chunks(store.db, entry_id, depth),
        media_type="application/json",
    )


@router.get("/_all/stems")
def list_all_stems() -> dict[str, Any]:
    """Return every stem across every entry, joined to the parent
    entry's title for grouping in the UI."""
    try:
        store = store_or_opening()
    except LibraryOpening as e:
        return _opening_response(e)
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    out = store.db.list_all_stems()
    return {"stems": out, "count": len(out)}


@router.get("/_all/midi")
def list_all_midi() -> dict[str, Any]:
    """Return every MIDI file across every entry, joined to the parent
    entry's title."""
    try:
        store = store_or_opening()
    except LibraryOpening as e:
        return _opening_response(e)
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    out = store.db.list_all_midis()
    return {"midis": out, "count": len(out)}


@router.get("/_all/scores")
def list_all_scores() -> dict[str, Any]:
    """Return every notation/score artifact across every entry, joined to the
    parent entry's title. Excludes raw ``midi`` artifacts (those live in the
    MIDI tab); keeps sheets, tabs, arrangements, and exports."""
    try:
        store = store_or_opening()
    except LibraryOpening as e:
        return _opening_response(e)
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    out = [
        art
        for art in store.db.list_all_notation_artifacts()
        if art.get("kind") != "midi"
    ]
    return {"scores": out, "count": len(out)}


@router.get("/_graph/all")
def get_full_graph() -> dict[str, Any]:
    """Return EVERY entry + relation in the library, PLUS virtual nodes
    for stems / midis / external source-labels referenced in edges but
    not present in the entries table. Without those virtual nodes the
    genealogy view sees chimera-children as orphans (their from_id is a
    file-name string, not an entry id) and the layered layout collapses
    to one row. Cheap up to a few thousand entries; if it grows large
    we'll paginate later."""
    try:
        store = store_or_opening()
    except LibraryOpening as e:
        return _opening_response(e)
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    raw_entries = store.db.list_entries()
    raw_edges = store.db.list_relations()

    entries_by_id: dict[str, dict[str, Any]] = {r["id"]: r for r in raw_entries}
    nodes: list[dict[str, Any]] = [
        {
            "id": r["id"],
            "kind": "entry",
            "title": r.get("title"),
            "source": r.get("source"),
            "duration_sec": r.get("duration_sec"),
            "model": r.get("model"),
            # The genealogy/3D-graph header can highlight most-played nodes.
            "play_count": int(r.get("play_count") or 0),
        }
        for r in raw_entries
    ]
    seen_ids = set(entries_by_id.keys())

    # Look up stems + midis once so we can label virtual nodes nicely.
    all_stems: dict[str, dict[str, Any]] = {
        s["id"]: s for s in store.db.list_all_stems()
    }
    all_midis: dict[str, dict[str, Any]] = {
        m["id"]: m for m in store.db.list_all_midis()
    }

    for edge in raw_edges:
        for ref in (edge["from_id"], edge["to_id"]):
            if ref in seen_ids:
                continue
            seen_ids.add(ref)
            if ref in all_stems:
                stem = all_stems[ref]
                nodes.append(
                    {
                        "id": ref,
                        "kind": "stem",
                        "title": stem.get("stem_name") or ref,
                        "source": "stem",
                        "model": stem.get("model"),
                    }
                )
            elif ref in all_midis:
                midi = all_midis[ref]
                nodes.append(
                    {
                        "id": ref,
                        "kind": "midi",
                        "title": Path(midi.get("midi_path") or ref).stem,
                        "source": "midi",
                        "model": midi.get("engine"),
                    }
                )
            else:
                # Chimera source-label or external reference.
                nodes.append(
                    {
                        "id": ref,
                        "kind": "external",
                        "title": ref,
                        "source": "external",
                    }
                )

    return {"nodes": nodes, "edges": raw_edges, "count": len(nodes)}


@router.post("/import")
async def import_entry(
    file: UploadFile = File(...),
    metadata: str = Form("{}"),
) -> dict[str, Any]:
    try:
        meta_dict = json.loads(metadata) if metadata else {}
    except json.JSONDecodeError as e:
        raise HTTPException(400, f"metadata must be JSON: {e}")
    if not isinstance(meta_dict, dict):
        raise HTTPException(400, "metadata must be a JSON object")

    audio_bytes = await file.read()
    if not audio_bytes:
        raise HTTPException(400, "empty file")

    store = await asyncio.to_thread(get_store)
    record = store.import_blob(
        audio_bytes=audio_bytes,
        filename=file.filename or "import.wav",
        mime_type=file.content_type or "audio/wav",
        metadata=meta_dict,
    )
    return record.to_dict()


def _startup_index_media_roots() -> None:
    """Index the user's media folders once the app is up.

    A daemon thread, like the lineage-scale warm: a few hundred thousand
    files on a spinning disk is minutes of walking, and no request may wait
    for it. Until it lands every lookup answers None, which is exactly the
    behaviour the library had before the index existed.
    """
    media_roots.start_scan()


register_startup_hook("library-media-roots", _startup_index_media_roots)


# Optional local extension. ``suno_routes`` (bulk provider-cache ingestion) is
# not part of the repository; when the module is absent the library simply has
# no such routes. Included last so everything it borrows from this module
# already exists.
try:
    from . import suno_routes as _suno_routes
except ImportError:
    _suno_routes = None
else:
    router.include_router(_suno_routes.router)
