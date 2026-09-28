"""FastAPI router for lineage at 200,000 songs (prefix ``/api/lineage-scale``).

GET /summary                     four headline numbers + the link census
GET /rankings                    most_derived | deepest | mashup_sources | recent
GET /{entry_id}/neighbourhood    one song's bounded graph
GET /{entry_id}/relatives        one song's relatives, paged, as a list

Every route is GET and read-only. Nothing here writes to the library, changes
the schema, touches ``metadata.json`` or reads audio.

Three cost rules hold the whole thing up:

* the per-song routes issue indexed SQL per frontier with chunked ``IN (...)``
  lists and never load a whole table;
* the library-wide routes make ONE pass over ``relations`` -- 3.6 s for the
  real library's 475,174 rows -- and that pass runs on its OWN read-only
  connection, so it never holds the write lock the rest of the app needs
  (:class:`_Snapshot`);
* that pass is cached against a signature OF THE LINKS, not against
  ``library_revision()``. The revision counter moves on every write in the
  library, including a play-count bump, and re-running a 3.6 s pass because
  somebody pressed play is the bug this module exists to avoid
  (:class:`_StatsCache`).

That cache is warmed once a few seconds after startup, by a daemon thread
registered on ``backend/core/startup.py``'s hook registry, so the FIRST LEARN
open after a restart does not pay for the pass either -- 8.6 s on the real
library (:func:`warm_stats_cache`). ``/summary`` reports whether it found the
cache warm. Nothing polls: a library that changes while nobody is looking
still lets the next request recompute, which is the correct answer arriving
once rather than a timer burning a pass nobody asked for.

No statement issued from this module names a ``*_json`` column or selects
``*``. Real rows carry ~34 KB of ``metadata_json``; reading it per row is
~100x slower than the synthetic-row timings in this repository's performance
tests suggest, and nothing here needs a byte of it. ``tests/test_lineagescale.py``
traces every connection this module opens and fails if that ever changes.
"""

from __future__ import annotations

import asyncio
import logging
import sqlite3
import threading
import time
import zlib
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Iterator, Optional, Sequence

from fastapi import APIRouter, HTTPException, Query

from backend.core.startup import register_startup_hook
from backend.modules.library.router import get_store as get_library_store

from .graph import (
    DEFAULT_BUDGET,
    DEFAULT_DOWN,
    DEFAULT_RANKING_LIMIT,
    DEFAULT_RELATIVES_LIMIT,
    DEFAULT_UP,
    DIRECTIONS,
    KIND_ALL,
    KIND_ROLES,
    RANKING_LISTS,
    RELATIVES_SORTS,
    UP,
    LibraryStats,
    build_neighbourhood,
    chunked,
    clamp_budget,
    clamp_depth,
    clamp_ranking_limit,
    clamp_relatives_limit,
    collect_relatives,
    compute_library_stats,
)

log = logging.getLogger(__name__)

router = APIRouter()

#: SQLite's default compiled variable limit is 999; the library DAO chunks at
#: 900 for the same reason (``_MAX_SQL_PARAMS`` in
#: ``backend/modules/library/db.py``). Kept as our own constant rather than
#: imported, because that one is private to its module.
MAX_SQL_PARAMS = 900

#: Rows pulled off a whole-table cursor at a time. 475,174 rows materialised
#: as Python tuples before the first one is counted is 150 MB for nothing.
STREAM_BATCH = 10_000

#: How long this module's read-only connection waits out a transient
#: ``SQLITE_BUSY`` (a WAL checkpoint) before giving up. Waiting is the right
#: answer: the alternative is a 500 for a lock that clears in milliseconds.
#: Far longer than a checkpoint on a library this size, and short enough that
#: a database which really is stuck fails rather than holding the request.
READONLY_BUSY_TIMEOUT_MS = 5000

#: Exactly the entry columns this module is allowed to read. Never a blob.
_ENTRY_COLUMNS = (
    "id",
    "title",
    "model",
    "source",
    "duration_sec",
    "play_count",
    "created_at",
)
_ENTRY_SELECT = ", ".join(_ENTRY_COLUMNS)


def _db() -> Any:
    """The library's :class:`LibraryDB`, or 503."""
    store = get_library_store()
    db = getattr(store, "db", None)
    if db is None:
        raise HTTPException(503, "library database is not available")
    return db


# --------------------------------------------------------------- snapshot


def _open_readonly(db: Any) -> Optional[sqlite3.Connection]:
    """A second connection to the same file, opened read-only.

    ``LibraryDB`` serialises everything -- reads included -- behind one
    connection and one ``RLock``, which is right for a DAO whose reads are
    single rows. It is wrong for a pass over every link in the library: on
    the real library that lock would be held for 3.6 s, and every write
    behind it (a play-count bump, a save, an import) waits that long.

    The library is in WAL mode, so a separate reader gets a consistent
    snapshot without blocking the writer or being blocked by it. Read-only
    is the honest declaration as well as a guard: this module cannot write
    even by accident.

    Returns ``None`` when the file cannot be opened this way -- an in-memory
    database, a path that is not absolute, or a SQLite build that refuses
    read-only WAL -- and the caller falls back to the shared connection.
    """
    path = getattr(db, "path", None)
    if path is None:
        return None
    try:
        uri = Path(path).resolve().as_uri() + "?mode=ro"
    except (ValueError, OSError):
        # ``as_uri`` rejects a relative path and ``":memory:"``.
        return None
    conn: Optional[sqlite3.Connection] = None
    try:
        conn = sqlite3.connect(uri, uri=True, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        # Touch the schema before trusting the handle: opening succeeds
        # lazily, and read-only access to a WAL database is the part that
        # can still fail (it needs the shared-memory index).
        conn.execute("SELECT 1 FROM sqlite_master LIMIT 1").fetchone()
        # A reader in WAL mode is not blocked by a writer, but it IS blocked
        # for the moment a checkpoint moves the WAL back into the database
        # file. That has to be a wait, not an immediate SQLITE_BUSY and a 500
        # for a lock which clears in milliseconds -- so the wait is stated
        # here rather than inherited: ``sqlite3.connect`` does set
        # busy_timeout from its own ``timeout`` argument (5 s by default),
        # but that is the driver's default and not this module's decision,
        # and a caller that ever passes ``timeout=0`` would silently turn
        # every checkpoint into a failed request.
        conn.execute(f"PRAGMA busy_timeout = {READONLY_BUSY_TIMEOUT_MS}")
    except sqlite3.Error as exc:
        log.info("lineagescale: read-only connection unavailable (%s)", exc)
        if conn is not None:
            try:
                conn.close()
            except sqlite3.Error:
                pass
        return None
    return conn


class _Snapshot:
    """One database session for one request.

    Prefers its own read-only connection (:func:`_open_readonly`) and closes
    it on the way out -- an open handle would keep the file locked on
    Windows, which a test relies on to prove there is no leak. Falls back to
    ``LibraryDB``'s connection under ``LibraryDB``'s lock, reached the same
    way ``backend/modules/notation/backfill.py`` already reaches it, adding
    no accessor to ``db.py``.
    """

    def __init__(self, db: Any) -> None:
        self._db = db
        self._conn: Optional[sqlite3.Connection] = None
        self._lock: Optional[Any] = None
        self._owned = False

    @property
    def isolated(self) -> bool:
        """True when this session has its own connection and takes no lock."""
        return self._owned

    def __enter__(self) -> "_Snapshot":
        conn = _open_readonly(self._db)
        if conn is not None:
            self._conn = conn
            self._owned = True
            return self
        self._conn = getattr(self._db, "_conn", None)  # noqa: SLF001 - see class
        self._lock = getattr(self._db, "_writelock", None)  # noqa: SLF001
        if self._conn is None or self._lock is None:
            raise HTTPException(503, "library database is not readable")
        return self

    def __exit__(self, *exc_info: Any) -> bool:
        if self._owned and self._conn is not None:
            self._conn.close()
        self._conn = None
        return False

    @contextmanager
    def _cursor(self) -> Iterator[sqlite3.Cursor]:
        if self._conn is None:  # pragma: no cover - defensive
            raise HTTPException(503, "library database is not readable")
        if self._lock is None:
            cur = self._conn.cursor()
            try:
                yield cur
            finally:
                cur.close()
        else:
            with self._lock:
                cur = self._conn.cursor()
                try:
                    yield cur
                finally:
                    cur.close()

    def read(self, sql: str, params: Sequence[Any] = ()) -> list[sqlite3.Row]:
        with self._cursor() as cur:
            return cur.execute(sql, list(params)).fetchall()

    def stream(self, sql: str) -> Iterator[sqlite3.Row]:
        """Rows from one whole-table read, fetched in batches."""
        with self._cursor() as cur:
            cur.execute(sql)
            while True:
                rows = cur.fetchmany(STREAM_BATCH)
                if not rows:
                    return
                yield from rows


# ----------------------------------------------------------------- entries


def _entry_rows(snap: _Snapshot, ids: Sequence[str]) -> dict[str, dict[str, Any]]:
    """The seven allowed columns for these ids only, chunked."""
    out: dict[str, dict[str, Any]] = {}
    unique = list(dict.fromkeys(ids))
    for chunk in chunked(unique, MAX_SQL_PARAMS):
        marks = ", ".join("?" * len(chunk))
        sql = f"SELECT {_ENTRY_SELECT} FROM entries WHERE id IN ({marks})"
        for row in snap.read(sql, list(chunk)):
            out[str(row["id"])] = {key: row[key] for key in _ENTRY_COLUMNS}
    return out


def _node_payload(
    entry_id: str,
    row: Optional[dict[str, Any]],
    generation: int,
) -> dict[str, Any]:
    """One graph node.

    An id that exists only as a link endpoint -- a stem, a MIDI file, a
    chimera source label -- is still a node, flagged ``in_library: false``.
    Its id is the only name it has, which is what ``/api/library/_graph/all``
    already shows for the same rows, so that is the title.
    """
    if row is None:
        return {
            "id": entry_id,
            "title": entry_id,
            "model": "",
            "source": "",
            "duration_sec": 0.0,
            "play_count": 0,
            "in_library": False,
            "generation": generation,
        }
    return {
        "id": entry_id,
        "title": row.get("title") or "",
        "model": row.get("model") or "",
        "source": row.get("source") or "",
        "duration_sec": float(row.get("duration_sec") or 0.0),
        "play_count": int(row.get("play_count") or 0),
        "in_library": True,
        "generation": generation,
    }


def _exists(snap: _Snapshot, entry_id: str) -> bool:
    """True when the id is a library entry OR an endpoint of some link.

    A stem or a chimera source label has no ``entries`` row but is a real
    point in the graph, and 404-ing it would make half the nodes the
    neighbourhood draws unclickable.
    """
    if snap.read("SELECT id FROM entries WHERE id = ? LIMIT 1", [entry_id]):
        return True
    if snap.read("SELECT id FROM relations WHERE from_id = ? LIMIT 1", [entry_id]):
        return True
    return bool(
        snap.read("SELECT id FROM relations WHERE to_id = ? LIMIT 1", [entry_id])
    )


def _link_fetcher(snap: _Snapshot):
    """A :data:`~.graph.FetchLinks` bound to this session.

    Two indexed reads per chunk -- ``idx_relations_from`` and
    ``idx_relations_to`` (``db.py``) -- and never a whole-table scan.
    """

    def fetch(ids: Sequence[str]) -> Iterable[tuple[str, str, str]]:
        rows: list[tuple[str, str, str]] = []
        for chunk in chunked(list(ids), MAX_SQL_PARAMS):
            marks = ", ".join("?" * len(chunk))
            for column in ("from_id", "to_id"):
                sql = (
                    "SELECT from_id, to_id, kind FROM relations "
                    f"WHERE {column} IN ({marks})"
                )
                rows.extend(
                    (str(r["from_id"]), str(r["to_id"]), str(r["kind"]))
                    for r in snap.read(sql, list(chunk))
                )
        return rows

    return fetch


# ------------------------------------------------------------------- cache


#: One statement, three scalar subqueries. ``MAX(id)`` is a rowid lookup
#: (0.07 ms at 389,058 rows); the two counts are covering-index scans
#: (7.7 ms together at that size, ~9 ms projected for the real library's
#: 475,174 links). Against a 3.6 s pass that is the trade.
_SIGNATURE_SQL = (
    "SELECT (SELECT COUNT(*) FROM relations), "
    "(SELECT MAX(id) FROM relations), "
    "(SELECT COUNT(*) FROM entries)"
)


@dataclass(frozen=True)
class _LinkSignature:
    """What has to change before the pass is worth running again.

    ``relations.id`` is ``INTEGER PRIMARY KEY AUTOINCREMENT``, so a rowid is
    never reused: ANY insert moves ``max_relation_id`` forward. Links are
    written with ``INSERT OR IGNORE`` and deleted whole rows at a time
    (``LibraryDB.delete_entry`` / ``delete_entries_bulk`` / ``delete_stem`` /
    ``delete_midi``), so a delete moves ``relations``. ``entries`` is in here
    because the summary counts entries and standalone songs, and a brand new
    song with no links would otherwise not show up.

    The one change this does NOT see is an in-place rewrite of a link's
    endpoints with no insert and no delete. Exactly one thing in this
    repository does that -- ``scripts/consolidate_generation_artifacts.py:236``
    (``UPDATE OR IGNORE relations SET from_id/to_id ...``), a maintenance
    script, not the running app -- and after it runs the first write of any
    kind moves the signature again.
    """

    relations: int
    max_relation_id: int
    entries: int

    @property
    def identity(self) -> int:
        """The number ``/summary`` reports as ``revision``.

        An IDENTITY, not a counter: equal means "the link graph has not
        changed", and nothing more. Do not compare two of them with ``<``.
        """
        return zlib.crc32(
            f"{self.relations}:{self.max_relation_id}:{self.entries}".encode("ascii")
        )


def _link_signature(snap: _Snapshot) -> _LinkSignature:
    row = snap.read(_SIGNATURE_SQL)[0]
    return _LinkSignature(int(row[0] or 0), int(row[1] or 0), int(row[2] or 0))


class _StatsCache:
    """One slot, keyed on the link signature.

    Only the finished numbers are kept -- a few hundred rows of ids and
    counts -- never the adjacency the pass builds, and never a title or a
    play count: those are read fresh per request so an edit shows up
    immediately without paying for the pass again.

    A concurrent second caller waits on the lock rather than starting its own
    pass over half a million links.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._value: Optional[LibraryStats] = None
        #: How many full passes have run. Instrumentation, for the tests that
        #: pin "this did not recompute".
        self.passes = 0

    def get(self, snap: _Snapshot, *, limit: int) -> tuple[LibraryStats, bool]:
        """The numbers, and whether they were already sitting here.

        The second element is False for exactly the one call that ran the
        pass and True for every call served from the slot, which is what
        ``/summary`` reports as ``warm``.
        """
        with self._lock:
            # Read INSIDE the lock, immediately before the pass. A signature
            # taken before the lock can be older than the rows the pass then
            # walks: the stored numbers would describe a newer library than
            # the identity stamped on them, so the next caller -- reading the
            # newer signature -- finds a mismatch and pays for the pass all
            # over again. Worse with two callers straddling one write: each
            # runs a pass and the one holding the older identity overwrites
            # the other's correct answer.
            signature = _link_signature(snap)
            cached = self._value
            if cached is not None and cached.revision == signature.identity:
                return cached, True
            stats = compute_library_stats(
                (
                    (str(r["from_id"]), str(r["to_id"]), str(r["kind"]))
                    for r in snap.stream("SELECT from_id, to_id, kind FROM relations")
                ),
                (
                    (str(r["id"]), float(r["created_at"] or 0.0))
                    for r in snap.stream("SELECT id, created_at FROM entries")
                ),
                revision=signature.identity,
                limit=limit,
            )
            self.passes += 1
            self._value = stats
            return stats, False

    def clear(self) -> None:
        with self._lock:
            self._value = None


#: Module-level on purpose: the whole point is that the second request does
#: not repeat the first one's pass.
_stats_cache = _StatsCache()

#: Ranked lists are cut to this before caching, so one cache entry serves
#: every ``limit`` a caller can ask for.
_RANKING_CACHE_LIMIT = 500


# ------------------------------------------------------------------ routes


def _summary_sync(db: Any) -> dict[str, Any]:
    with _Snapshot(db) as snap:
        stats, warm = _stats_cache.get(snap, limit=_RANKING_CACHE_LIMIT)
    return {**stats.summary, "warm": warm}


@router.get("/summary")
async def get_summary() -> dict[str, Any]:
    """The library's lineage in one object.

    ``full_view_ok`` says whether LEARN opens the old whole-library drawing
    by default: at or below ``full_view_limit`` linked songs (2,000), yes.
    ``full_view_limit`` is sent so the UI's warning quotes the number that
    decided. ``revision`` is the
    identity of the link signature (see :class:`_LinkSignature`) -- compare
    it for equality, never for order.

    ``warm`` is a superset of the original contract: True when these numbers
    came straight out of the cache, False when THIS request ran the pass and
    therefore waited for it. It is never a promise that an answer is coming
    later -- the route always answers with real numbers -- so a UI uses it to
    say "that one took a moment" or to skip a spinner it does not need, not
    to poll.
    """
    return await asyncio.to_thread(_summary_sync, _db())


def _rankings_sync(db: Any, which: str, limit: int) -> dict[str, Any]:
    with _Snapshot(db) as snap:
        stats, _warm = _stats_cache.get(snap, limit=_RANKING_CACHE_LIMIT)
        ranked = stats.rankings[which][:limit]
        # The cache holds ids, counts and the detail line. The columns on
        # screen are read fresh, every time: a renamed song shows its new
        # title on the next request without a 3.6 s pass, and at most 500
        # ids is one indexed lookup -- the same bounded ``WHERE id IN (...)``
        # over ``_ENTRY_COLUMNS`` the other routes use, so ``source`` costs
        # this route nothing extra: it is already in the row.
        entries = _entry_rows(snap, [r.id for r in ranked])
    rows = [
        {
            "id": r.id,
            "title": (entries.get(r.id) or {}).get("title") or r.id,
            "model": (entries.get(r.id) or {}).get("model") or "",
            # `source` travels WITH `model`, exactly as it does on a
            # neighbourhood node and a relatives row: the provider badge is
            # the two columns together, and a Suno song's model is `chirp-*`
            # while its source says 'suno'. Sent so a client that badges a
            # ranked row has the column it needs -- `RankedList` in
            # `frontend/src/lineagescale/LineageLanding.tsx` now does.
            "source": (entries.get(r.id) or {}).get("source") or "",
            "count": r.count,
            "detail": r.detail,
        }
        for r in ranked
    ]
    return {"list": which, "rows": rows}


@router.get("/rankings")
async def get_rankings(
    # ``list`` on the wire; ``which`` in Python, so the builtin still means
    # the builtin inside this function.
    which: str = Query(
        "most_derived", alias="list", description=" | ".join(RANKING_LISTS)
    ),
    limit: int = DEFAULT_RANKING_LIMIT,
) -> dict[str, Any]:
    """One ranked list. Served from the same pass the summary uses."""
    if which not in RANKING_LISTS:
        raise HTTPException(400, f"list must be one of {', '.join(RANKING_LISTS)}")
    return await asyncio.to_thread(
        _rankings_sync, _db(), which, clamp_ranking_limit(limit)
    )


def _neighbourhood_sync(
    db: Any, entry_id: str, up: int, down: int, budget: int
) -> dict[str, Any]:
    with _Snapshot(db) as snap:
        if not _exists(snap, entry_id):
            raise HTTPException(404, f"entry {entry_id!r} not found")
        walk = build_neighbourhood(
            entry_id,
            up=up,
            down=down,
            budget=budget,
            fetch_links=_link_fetcher(snap),
        )
        entries = _entry_rows(snap, walk.order)
    nodes = [
        _node_payload(node_id, entries.get(node_id), walk.generation[node_id])
        for node_id in walk.order
    ]
    return {
        "focus": walk.focus,
        "nodes": nodes,
        "edges": [edge.to_wire() for edge in walk.edges],
        "groups": [group.to_wire() for group in walk.groups],
        "hidden": walk.hidden,
        "truncated": walk.truncated,
        "budget": walk.budget,
        "up": walk.up,
        "down": walk.down,
    }


@router.get("/{entry_id}/neighbourhood")
async def get_neighbourhood(
    entry_id: str,
    up: int = DEFAULT_UP,
    down: int = DEFAULT_DOWN,
    budget: int = DEFAULT_BUDGET,
) -> dict[str, Any]:
    """One song's graph, bounded before it is built.

    ``generation`` is negative for sources, positive for derivatives, 0 for
    the focus. Out-of-range ``up``/``down``/``budget`` are clamped to the
    contract's limits rather than rejected, the way
    ``/api/library/{id}/lineage`` already clamps its depth.
    """
    return await asyncio.to_thread(
        _neighbourhood_sync,
        _db(),
        entry_id,
        clamp_depth(up),
        clamp_depth(down),
        clamp_budget(budget),
    )


def _relatives_sync(
    db: Any,
    entry_id: str,
    direction: str,
    kind: str,
    sort: str,
    offset: int,
    limit: int,
) -> dict[str, Any]:
    with _Snapshot(db) as snap:
        if not _exists(snap, entry_id):
            raise HTTPException(404, f"entry {entry_id!r} not found")
        rows = _link_fetcher(snap)([entry_id])
        merged = collect_relatives(entry_id, direction=direction, kind=kind, rows=rows)
        entries = _entry_rows(snap, [rid for rid, _kinds in merged])

    def sort_key(item: tuple[str, tuple[str, ...]]) -> tuple[Any, ...]:
        rid, _kinds = item
        row = entries.get(rid) or {}
        if sort == "plays":
            return (-int(row.get("play_count") or 0), rid)
        if sort == "recent":
            return (-float(row.get("created_at") or 0.0), rid)
        return ((row.get("title") or rid).casefold(), rid)

    merged.sort(key=sort_key)
    page = merged[offset : offset + limit]
    return {
        "total": len(merged),
        "rows": [
            {
                "id": rid,
                "title": (entries.get(rid) or {}).get("title") or rid,
                "model": (entries.get(rid) or {}).get("model") or "",
                # `source` travels with `model` or the badge lies: a legacy
                # Suno import has model "" and source "suno", and a badge
                # given only the model calls it Stable Audio (the same bug
                # 30f8732 fixed in the catalogue).
                "source": (entries.get(rid) or {}).get("source") or "",
                "duration_sec": float(
                    (entries.get(rid) or {}).get("duration_sec") or 0.0
                ),
                "play_count": int((entries.get(rid) or {}).get("play_count") or 0),
                "kinds": list(kinds),
            }
            for rid, kinds in page
        ],
    }


@router.get("/{entry_id}/relatives")
async def get_relatives(
    entry_id: str,
    direction: str = UP,
    kind: str = KIND_ALL,
    sort: str = "title",
    offset: int = 0,
    limit: int = DEFAULT_RELATIVES_LIMIT,
) -> dict[str, Any]:
    """A group box opened up: the same relatives as a paged list.

    This is where a fan of 800 covers goes. It is a list, not more graph, so
    the cost is one indexed read plus one chunked lookup of the columns the
    rows show.
    """
    if direction not in DIRECTIONS:
        raise HTTPException(400, f"direction must be one of {', '.join(DIRECTIONS)}")
    if sort not in RELATIVES_SORTS:
        raise HTTPException(400, f"sort must be one of {', '.join(RELATIVES_SORTS)}")
    if kind != KIND_ALL and kind not in KIND_ROLES:
        raise HTTPException(400, f"unknown kind {kind!r}")
    return await asyncio.to_thread(
        _relatives_sync,
        _db(),
        entry_id,
        direction,
        kind,
        sort,
        max(0, int(offset)),
        clamp_relatives_limit(limit),
    )


# ------------------------------------------------------------ startup warm


#: How long the warm waits before it opens anything. The pass is 3.6 s of
#: disk and CPU on the real library and startup has its own I/O to get
#: through (the library store, the notation backfill, the torch warm); five
#: seconds of quiet is enough that this is not competing with any of it, and
#: still far inside the time it takes a user to reach the LEARN tab.
WARM_DELAY_SEC = 5.0

#: The thread :func:`start_warm_thread` last spawned. Diagnostics, and the
#: handle a test joins instead of sleeping.
_warm_thread: Optional[threading.Thread] = None


def warm_stats_cache() -> bool:
    """Run the library-wide pass once, off any request.

    Exactly the compute ``/summary`` and ``/rankings`` run -- the same
    :class:`_Snapshot`, the same :data:`_stats_cache`, the same limit -- so a
    request arriving afterwards finds the slot already filled and the first
    LEARN open after a restart is 60 ms instead of 8.6 s.

    Returns True when the pass ran (or the cache was already warm), False
    when there was nothing to warm. Never raises: a warm that fails costs
    the next request the pass it would have paid anyway, which is not worth
    a traceback out of a daemon thread, so the failure is logged once and
    swallowed.

    Two things it will not do:

    * run without a library database -- a store with ``db is None`` is a
      launch where the library never came up, and warming a cache for it
      would be inventing an answer;
    * take ``LibraryDB._writelock``. The request path may fall back to the
      shared connection under that lock (an in-memory database, a SQLite
      build that refuses read-only WAL) because a request has to be
      answered; a background warm does not, and holding that lock for a
      3.6 s pass nobody asked for would stall every write in the app.

    What it does NOT avoid, and does not need to: a request arriving while
    the warm is mid-pass waits on the stats cache's own single-flight lock
    until that pass finishes. That wait is bounded by the pass the request
    would have run itself on a cold cache, and it ends with the answer
    already computed, so the request is never slower for the warm existing.
    """
    try:
        store = get_library_store()
        db = getattr(store, "db", None)
        if db is None:
            log.info("lineagescale: warm skipped, no library database")
            return False
        with _Snapshot(db) as snap:
            if not snap.isolated:
                log.info(
                    "lineagescale: warm skipped, no read-only connection "
                    "(the write lock is not a background warm's to hold)"
                )
                return False
            _stats_cache.get(snap, limit=_RANKING_CACHE_LIMIT)
    except Exception:  # noqa: BLE001 - see docstring: logged once, swallowed
        log.warning(
            "lineagescale: warming the stats cache failed; the first "
            "/summary or /rankings will pay for the pass",
            exc_info=True,
        )
        return False
    return True


def start_warm_thread(delay: Optional[float] = None) -> threading.Thread:
    """Hand the warm to a daemon thread and return immediately.

    A daemon thread rather than the idle-gated background queue
    (``backend/core/background_workers.py``): that queue has ONE consumer,
    and a job that begins by sleeping through its delay would hold it shut
    against the notation backfill and every analysis/stems/MIDI job behind
    it. This warm wants a few seconds of nothing, not a worker slot, which
    is the same reason ``server._warm_heavy`` and the underfit spawn are
    threads.
    """
    global _warm_thread
    wait = WARM_DELAY_SEC if delay is None else float(delay)

    def _run() -> None:
        if wait > 0:
            time.sleep(wait)
        warm_stats_cache()

    thread = threading.Thread(target=_run, name="lineagescale-warm", daemon=True)
    _warm_thread = thread
    thread.start()
    return thread


def _startup_warm() -> None:
    start_warm_thread()


# Runs from the app lifespan (core/startup.py), last of everything, so the
# library store is already up when the thread wakes. Nothing to undo at
# shutdown: the thread is a daemon and holds no handle past its own `with`.
register_startup_hook("lineagescale-warm", _startup_warm)

# The LEARN explorer (`explore.py`): every number the landing page shows, as a
# list you can open. Imported HERE, at the bottom, because that module reads
# this one's snapshot helpers -- by this line they exist -- and it mounts its
# own sub-router on `router` as it finishes, so either import order works.
from . import explore as _explore  # noqa: E402,F401
