"""The LEARN explorer: every number on the landing page is a list you can open.

Mounted under ``/api/lineage-scale/explore`` from ``router.py``'s last line.

GET /explore/songs                    the two summary populations, as lists
GET /explore/kinds/{kind}             songs holding links of one kind, by role
GET /explore/rankings                 "most links of kind K as parent/child"
GET /explore/families                 ancestry components, biggest first
GET /explore/families/{id}/members    one family, paged

``/summary`` counts songs with lineage, songs without, the largest family and
the largest cluster, and ``/rankings`` ranks four preset lists. None of those
numbers led anywhere: the four presets were the only way into a 200,000-song
library. These routes open the same populations, by any kind, in either role,
searchable, sortable and paged -- and they are the SAME populations, computed
the same way, so a list that opens off a number holds exactly the songs that
number counted. ``tests/test_lineagescale_explore.py`` asserts that against
``/summary``'s own answers rather than against hand-written constants.

Everything here is GET and read-only, on ``router.py``'s own read-only
snapshot connection (:class:`~.router._Snapshot`). No statement names a
``*_json`` column or selects ``*``: a real row carries ~34 KB of
``metadata_json`` and nothing on this screen needs a byte of it.

THE COST MODEL
--------------
Three shapes of question, three answers:

* *Is this song linked at all?* Two indexed ``EXISTS`` probes
  (``idx_relations_from`` / ``idx_relations_to``) evaluated while SQLite walks
  the entries table in the sort order's own index. Page one costs a few
  hundred probes, not a table scan.
* *How many songs are in this population, and which have the most links?*
  A whole-graph question. It is answered ONCE per change to the link graph and
  cached (:class:`_ExploreIndex`), keyed on ``router``'s link signature -- the
  same key ``/summary``'s cache uses, so a play-count bump does not invalidate
  it. The pass is warmed by a daemon thread a few seconds after startup, like
  the summary's, so the first list a user opens does not pay for it.
* *Which songs hold a link of kind K?* The SAME pass. There is no index on
  ``relations(kind)``, so asking that question per kind would be a full read of
  the table EVERY time a kind list is opened -- 475,174 rows on the real
  library, unindexed, under this module's lock, for a question the pass has
  already walked past. So every kind's count tables are built in the one pass
  and kept with it, and the startup warm covers them too: opening a kind list
  after the warm issues no read of ``relations`` at all.

What the index costs to hold: the entry-id set, the family membership, two
count dictionaries over linked entries, and two per-kind count dictionaries.
The per-kind tables are the big ones -- at most TWO dict entries per distinct
(kind, child, parent). Measured on the real library (194,529 entries,
475,446 kind-count entries, 2026-09-22): the finished index retains 85 MB
and the pass peaks at 203 MB while its transient adjacency is alive, 7.0 s
on a read-only connection. Every key is shared with the entry-id set rather
than copied. Counts only: no id lists are stored; the order a ``count`` sort
needs is computed on demand and memoised per (kind, role) as references,
which grows that slot by up to one reference per ranked id for the life of
the index.

One slot, replaced whole when the links change. The adjacency the pass builds
is transient and freed before the index is stored, exactly as
``compute_library_stats`` already does for ``/summary``.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from dataclasses import dataclass
from typing import Any, Iterable, Optional, Sequence

from fastapi import APIRouter, HTTPException, Query

from backend.core.startup import register_startup_hook
from backend.modules.library.db import search_tokens

from .graph import (
    ARTIFACT_KINDS,
    KIND_ORDER,
    ROLE_ANCESTRY,
    ROLE_ARTIFACT,
    SOURCE_END_FROM,
    orient,
    role_of,
    source_end_of,
)
from .router import (
    _ENTRY_COLUMNS,
    _ENTRY_SELECT,
    _Snapshot,
    _db,
    _entry_rows,
    _link_signature,
    router as _parent_router,
)

log = logging.getLogger(__name__)

router = APIRouter()

#: Rows one explorer page returns, and the ceiling a caller can ask for.
DEFAULT_PAGE = 50
MAX_PAGE = 500

#: Populations ``/explore/songs`` can open. They are the two numbers under the
#: "Songs" card, and they partition the library.
SETS = ("with_lineage", "standalone")
#: Which end of a link the song is on. ``any`` is either end.
ROLES = ("parent", "child", "any")
#: Roles a ranking can be built for: "most X as a parent" / "as a child".
RANKING_ROLES = ("parent", "child")
#: ``any`` stands for every kind that is not an artifact rendering.
KIND_ANY = "any"

SORT_TITLE = "title"
SORT_CREATED = "created"
SORT_PLAYS = "plays"
SORT_LINKS = "links"
SORT_COUNT = "count"
SORT_SIZE = "size"

SONG_SORTS = (SORT_TITLE, SORT_CREATED, SORT_PLAYS, SORT_LINKS)
KIND_SORTS = (SORT_COUNT, SORT_TITLE, SORT_CREATED, SORT_PLAYS)
DIRECTIONS = ("asc", "desc")

#: Column ORDER BY for the sorts SQL can answer. ``e.rowid`` is the tiebreak
#: because every one of these columns has an index that ends in it, so the
#: page is an index walk and a deep OFFSET skips rows without materialising
#: them -- the same rule ``library/db.py``'s ``_SORT_SQL`` follows.
_SORT_COLUMNS = {
    SORT_TITLE: "e.title COLLATE NOCASE",
    SORT_CREATED: "e.created_at",
    SORT_PLAYS: "e.play_count",
}

#: Seconds after startup before the explorer's pass runs. Later than the
#: summary's warm (``router.WARM_DELAY_SEC``) on purpose: the two read the same
#: table and there is no reason for them to do it at the same moment.
WARM_DELAY_SEC = 20.0

_ARTIFACT_SQL = ", ".join("?" * len(ARTIFACT_KINDS))
_ARTIFACT_PARAMS = sorted(ARTIFACT_KINDS)

#: The ``stem_of`` rows the local separator wrote point the other way from the
#: promoted writer's, and are told apart by the id template that writer uses:
#: the stem's id is the parent's id plus "__" plus the stem name
#: (``graph.is_local_stem_link``). This is that same test in SQL, so a
#: database answer and a graph answer cannot disagree about which end is the
#: source.
_LOCAL_STEM_SQL = "instr(r.to_id, r.from_id || '__') = 1"


def _clamp(value: Any, lo: int, hi: int, fallback: int) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return fallback
    return max(lo, min(n, hi))


def _page_args(offset: int, limit: int) -> tuple[int, int]:
    return _clamp(offset, 0, 10_000_000, 0), _clamp(limit, 1, MAX_PAGE, DEFAULT_PAGE)


def _check(value: str, allowed: Sequence[str], name: str) -> str:
    if value not in allowed:
        raise HTTPException(400, f"{name} must be one of {', '.join(allowed)}")
    return value


def _like_clause(column: str, q: Optional[str]) -> tuple[str, list[Any]]:
    """A title substring filter, or nothing.

    ``search_tokens`` is the library's own sanitiser (``library/db.py``): it
    keeps letters and digits only, so a token carries no ``%``, no ``_`` and
    no LIKE escape is needed. A query string with nothing searchable in it
    matches NOTHING rather than everything -- the same rule the library list
    follows, so the two searches cannot disagree.
    """
    if q is None or not q.strip():
        return "", []
    tokens = search_tokens(q)
    if not tokens:
        return "0", []
    return (
        " AND ".join(f"{column} LIKE ?" for _ in tokens),
        [f"%{token}%" for token in tokens],
    )


def _matches_tokens(title: str, q: Optional[str]) -> bool:
    """:func:`_like_clause`'s rule, applied in Python to a title already read.

    Used only where the population comes out of the cached index rather than
    out of SQL, so the two paths answer the same question.
    """
    if q is None or not q.strip():
        return True
    tokens = search_tokens(q)
    if not tokens:
        return False
    lowered = title.lower()
    return all(token in lowered for token in tokens)


def _ids_matching(snap: _Snapshot, q: Optional[str]) -> Optional[set[str]]:
    """The ids whose title matches ``q``, or None when nothing can match.

    For the lists whose population comes off the cached index rather than out
    of a WHERE clause: one read of the id column, never a title per candidate.
    """
    like_sql, like_params = _like_clause("e.title", q)
    if not like_sql or like_sql == "0":
        return None
    return {
        str(row["id"])
        for row in snap.read(f"SELECT id FROM entries e WHERE {like_sql}", like_params)
    }


def _row_payload(
    row: Optional[dict[str, Any]], entry_id: str, **extra: Any
) -> dict[str, Any]:
    """One list row: the seven allowed columns, plus whatever counted it.

    ``source`` travels with ``model`` always, or the badge lies: a legacy Suno
    import has model "" and source "suno", and a badge given only the model
    calls it Stable Audio.
    """
    base: dict[str, Any] = {key: (row or {}).get(key) for key in _ENTRY_COLUMNS}
    base["id"] = entry_id
    base["title"] = (row or {}).get("title") or entry_id
    base["model"] = (row or {}).get("model") or ""
    base["source"] = (row or {}).get("source") or ""
    base["duration_sec"] = float((row or {}).get("duration_sec") or 0.0)
    base["play_count"] = int((row or {}).get("play_count") or 0)
    base["created_at"] = float((row or {}).get("created_at") or 0.0)
    base.update(extra)
    return base


def _rows_for(
    snap: _Snapshot, ids: Sequence[str], **per_id: Any
) -> list[dict[str, Any]]:
    """The page's columns, read fresh, in the order the ids were ranked.

    The index caches ids and counts, never a title or a play count: a renamed
    song shows its new name on the next request without re-running the pass.
    """
    entries = _entry_rows(snap, list(ids))
    out: list[dict[str, Any]] = []
    for entry_id in ids:
        extra = {key: value.get(entry_id, 0) for key, value in per_id.items()}
        out.append(_row_payload(entries.get(entry_id), entry_id, **extra))
    return out


# ------------------------------------------------------------ the index


@dataclass(frozen=True)
class _Family:
    """One ancestry component: the songs that really do share a line of
    descent. NOT a connected component -- a mashup has parents from unrelated
    trees, and one connected component in the real library holds 81,501
    songs."""

    root: str
    members: tuple[str, ...]

    @property
    def size(self) -> int:
        return len(self.members)


@dataclass(frozen=True)
class _ExploreIndex:
    """Everything a list needs that a single song's row cannot answer."""

    revision: int
    entries_total: int
    linked_total: int
    parent_counts: dict[str, int]
    child_counts: dict[str, int]
    ranked_parent: tuple[str, ...]
    ranked_child: tuple[str, ...]
    families: tuple[_Family, ...]
    family_of: dict[str, int]
    entry_ids: frozenset[str]
    #: kind -> {entry id: links of that kind where the song is the SOURCE}.
    kind_parent: dict[str, dict[str, int]]
    #: kind -> {entry id: links of that kind where the song is the DERIVED one}.
    kind_child: dict[str, dict[str, int]]
    #: kind -> how many songs are on EITHER end. Precomputed because the answer
    #: is a set union over both tables and ``total`` is on every page.
    kind_any_total: dict[str, int]
    #: (kind, role) -> that table's ids in count order. Filled on demand, never
    #: by the pass: it is 8 bytes an id for a kind somebody actually opened,
    #: against a list per kind for kinds nobody asks about. Two threads racing
    #: here compute the same tuple, so the last writer wins with the same value.
    ranked_kinds: dict[tuple[str, str], tuple[str, ...]]

    def links(self, entry_id: str) -> int:
        return self.parent_counts.get(entry_id, 0) + self.child_counts.get(entry_id, 0)

    def linked_ids(self) -> list[str]:
        merged = dict.fromkeys(self.ranked_parent)
        merged.update(dict.fromkeys(self.ranked_child))
        return list(merged)

    def kind_count(self, kind: str, role: str, entry_id: str) -> int:
        """Links of ``kind`` this song holds in ``role``."""
        parents = self.kind_parent.get(kind) or {}
        children = self.kind_child.get(kind) or {}
        if role == "parent":
            return parents.get(entry_id, 0)
        if role == "child":
            return children.get(entry_id, 0)
        return parents.get(entry_id, 0) + children.get(entry_id, 0)

    def kind_total(self, kind: str, role: str) -> int:
        """Songs holding at least one link of ``kind`` in ``role``."""
        if role == "parent":
            return len(self.kind_parent.get(kind) or {})
        if role == "child":
            return len(self.kind_child.get(kind) or {})
        return self.kind_any_total.get(kind, 0)

    def kind_ranked(self, kind: str, role: str) -> tuple[str, ...]:
        """Those songs, most links of that kind first, ties by id."""
        key = (kind, role)
        cached = self.ranked_kinds.get(key)
        if cached is not None:
            return cached
        if role == "parent":
            ids: Iterable[str] = (self.kind_parent.get(kind) or {}).keys()
        elif role == "child":
            ids = (self.kind_child.get(kind) or {}).keys()
        else:
            merged = dict.fromkeys(self.kind_parent.get(kind) or {})
            merged.update(dict.fromkeys(self.kind_child.get(kind) or {}))
            ids = merged.keys()
        order = tuple(
            sorted(
                ids, key=lambda key_id: (-self.kind_count(kind, role, key_id), key_id)
            )
        )
        self.ranked_kinds[key] = order
        return order


def _build_index(snap: _Snapshot, revision: int) -> _ExploreIndex:
    """ONE pass over ``relations`` and one over ``entries``.

    The same two reads ``compute_library_stats`` makes, oriented by the same
    :func:`~.graph.orient`, so the families here and the ``largest_tree`` on
    the landing page are the same components by construction. The adjacency is
    local and freed on return; only ids and counts survive.
    """
    entry_ids: set[str] = {
        str(row["id"]) for row in snap.stream("SELECT id FROM entries")
    }

    pairs: set[tuple[str, str]] = set()
    ancestry: list[tuple[str, str]] = []
    kind_parent: dict[str, dict[str, int]] = {}
    kind_child: dict[str, dict[str, int]] = {}
    # Dedup is PER KIND here, not per pair: the same (child, parent) is stored
    # several times over -- one stem is derived_from + edit_of + stem_of -- and
    # each of those kinds counts that pair once. The pair-level set below is a
    # different question (how many RELATIONSHIPS there are) and keeps its own.
    counted: set[tuple[str, str, str]] = set()
    for row in snap.stream("SELECT from_id, to_id, kind FROM relations"):
        kind = str(row["kind"])
        pair = orient(str(row["from_id"]), str(row["to_id"]), kind)
        if pair is None:
            continue
        child, parent = pair
        triple = (kind, child, parent)
        if triple not in counted:
            counted.add(triple)
            if parent in entry_ids:
                slot = kind_parent.setdefault(kind, {})
                slot[parent] = slot.get(parent, 0) + 1
            if child in entry_ids:
                slot = kind_child.setdefault(kind, {})
                slot[child] = slot.get(child, 0) + 1
        # An artifact rendering is not lineage: it is counted for its own kind
        # list above and then left out of everything the landing page counts.
        role = role_of(kind)
        if role == ROLE_ARTIFACT or pair in pairs:
            continue
        pairs.add(pair)
        if role == ROLE_ANCESTRY:
            ancestry.append(pair)
    del counted

    parent_counts: dict[str, int] = {}
    child_counts: dict[str, int] = {}
    linked: set[str] = set()
    for child, parent in pairs:
        linked.add(child)
        linked.add(parent)
        if parent in entry_ids:
            parent_counts[parent] = parent_counts.get(parent, 0) + 1
        if child in entry_ids:
            child_counts[child] = child_counts.get(child, 0) + 1
    del pairs

    # Ancestry components. Union-find over the same pairs the summary unions
    # for ``largest_tree``, then counted in SONGS: an endpoint with no entries
    # row (a stem, a chimera source label) is welded in but is a file name,
    # not a track, and counting it would inflate the family.
    parent_of: dict[str, str] = {}

    def find(key: str) -> str:
        root = key
        while parent_of.get(root, root) != root:
            root = parent_of[root]
        while parent_of.get(key, key) != root:
            parent_of[key], key = root, parent_of[key]
        return root

    for child, parent in ancestry:
        # Register both ends before uniting: a node that is only ever a root
        # would otherwise never become a key, and would be missing from its
        # own family -- the family holding a0 lost the child linked straight
        # to it.
        parent_of.setdefault(child, child)
        parent_of.setdefault(parent, parent)
        a, b = find(child), find(parent)
        if a != b:
            parent_of[b] = a
    del ancestry

    grouped: dict[str, list[str]] = {}
    for key in parent_of:
        if key in entry_ids:
            grouped.setdefault(find(key), []).append(key)
    families = tuple(
        sorted(
            (
                _Family(root=min(members), members=tuple(sorted(members)))
                for members in grouped.values()
                if members
            ),
            key=lambda fam: (-fam.size, fam.root),
        )
    )
    family_of = {
        member: position
        for position, family in enumerate(families)
        for member in family.members
    }

    return _ExploreIndex(
        revision=revision,
        entries_total=len(entry_ids),
        linked_total=sum(1 for entry_id in entry_ids if entry_id in linked),
        parent_counts=parent_counts,
        child_counts=child_counts,
        ranked_parent=_ranked(parent_counts),
        ranked_child=_ranked(child_counts),
        families=families,
        family_of=family_of,
        entry_ids=frozenset(entry_ids),
        kind_parent=kind_parent,
        kind_child=kind_child,
        kind_any_total={
            kind: len(
                (kind_parent.get(kind) or {}).keys()
                | (kind_child.get(kind) or {}).keys()
            )
            for kind in set(kind_parent) | set(kind_child)
        },
        ranked_kinds={},
    )


def _ranked(counts: dict[str, int]) -> tuple[str, ...]:
    """Ids by count, biggest first, ties by id so a page is stable."""
    return tuple(sorted(counts, key=lambda key: (-counts[key], key)))


class _IndexCache:
    """One slot, keyed on ``router``'s link signature.

    A concurrent second caller waits on the lock rather than starting its own
    pass, and the signature is read INSIDE the lock for the reason
    ``router._StatsCache`` states: a signature read before it can be older
    than the rows the pass then walks.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._value: Optional[_ExploreIndex] = None
        #: How many full passes have run. Instrumentation for the tests.
        self.passes = 0

    def get(self, snap: _Snapshot) -> _ExploreIndex:
        with self._lock:
            revision = _link_signature(snap).identity
            cached = self._value
            if cached is not None and cached.revision == revision:
                return cached
            index = _build_index(snap, revision)
            self.passes += 1
            self._value = index
            return index

    def clear(self) -> None:
        with self._lock:
            self._value = None


_index_cache = _IndexCache()
#: The tests read this; it is the same object as :data:`_index_cache`.
_family_cache = _index_cache


def clear_caches() -> None:
    """Drop the index. For tests, which build several libraries in one
    process and must never inherit one another's answers."""
    _index_cache.clear()


# ------------------------------------------------------------------- songs


def _lineage_exists_sql() -> tuple[str, list[Any]]:
    """True for a song that is an endpoint of any non-artifact link.

    Exactly ``/summary``'s rule: artifact renderings are not lineage and a
    self-link is not a relationship. Both halves are an indexed probe
    (``idx_relations_from`` / ``idx_relations_to``).
    """
    sql = (
        f"(EXISTS (SELECT 1 FROM relations r WHERE r.from_id = e.id "
        f"AND r.to_id <> e.id AND r.kind NOT IN ({_ARTIFACT_SQL})) "
        f"OR EXISTS (SELECT 1 FROM relations r WHERE r.to_id = e.id "
        f"AND r.from_id <> e.id AND r.kind NOT IN ({_ARTIFACT_SQL})))"
    )
    return sql, [*_ARTIFACT_PARAMS, *_ARTIFACT_PARAMS]


def _songs_sync(
    db: Any,
    which: str,
    q: Optional[str],
    sort: str,
    direction: str,
    offset: int,
    limit: int,
) -> dict[str, Any]:
    with _Snapshot(db) as snap:
        index = _index_cache.get(snap)
        if sort == SORT_LINKS:
            rows, total = _songs_by_links(
                snap, index, which, q, direction, offset, limit
            )
        else:
            rows, total = _songs_by_column(
                snap, index, which, q, sort, direction, offset, limit
            )
    return {
        "set": which,
        "sort": sort,
        "dir": direction,
        "total": total,
        "offset": offset,
        "limit": limit,
        "rows": rows,
    }


def _songs_by_column(
    snap: _Snapshot,
    index: _ExploreIndex,
    which: str,
    q: Optional[str],
    sort: str,
    direction: str,
    offset: int,
    limit: int,
) -> tuple[list[dict[str, Any]], int]:
    """One page, walked in the sort column's own index.

    The population filter is the ``EXISTS`` pair, evaluated per row as SQLite
    walks; the total for an unfiltered list comes out of the cached index
    instead of being counted again.
    """
    exists_sql, exists_params = _lineage_exists_sql()
    predicate = exists_sql if which == "with_lineage" else f"NOT {exists_sql}"
    like_sql, like_params = _like_clause("e.title", q)
    where = predicate + (f" AND {like_sql}" if like_sql else "")
    order = f"{_SORT_COLUMNS[sort]} {direction.upper()}, e.rowid {direction.upper()}"
    page = snap.read(
        f"SELECT {_ENTRY_SELECT} FROM entries e WHERE {where} "
        f"ORDER BY {order} LIMIT ? OFFSET ?",
        [*exists_params, *like_params, limit, offset],
    )
    if like_sql:
        total_row = snap.read(
            f"SELECT COUNT(*) FROM entries e WHERE {where}",
            [*exists_params, *like_params],
        )
        total = int(total_row[0][0] or 0)
    else:
        total = (
            index.linked_total
            if which == "with_lineage"
            else max(0, index.entries_total - index.linked_total)
        )
    rows = [
        _row_payload(
            {key: row[key] for key in _ENTRY_COLUMNS},
            str(row["id"]),
            links=index.links(str(row["id"])),
        )
        for row in page
    ]
    return rows, total


def _songs_by_links(
    snap: _Snapshot,
    index: _ExploreIndex,
    which: str,
    q: Optional[str],
    direction: str,
    offset: int,
    limit: int,
) -> tuple[list[dict[str, Any]], int]:
    """Ranked by how many relationships the song is in.

    Not a column, so it comes off the cached index. A standalone song has no
    links by definition, so for that population this sort is the title order
    with a zero in the count.
    """
    if which == "standalone":
        # Every standalone song has zero links, so the tiebreak IS the order --
        # but the direction the caller asked for still decides which way it runs.
        return _songs_by_column(
            snap, index, which, q, SORT_TITLE, direction, offset, limit
        )
    candidates = index.linked_ids()
    if q is not None and q.strip():
        matched = _ids_matching(snap, q)
        if matched is None:
            return [], 0
        candidates = [entry_id for entry_id in candidates if entry_id in matched]
    # Most links first is the ranking; ``asc`` is that list read backwards.
    candidates.sort(key=lambda key: (-index.links(key), key))
    if direction == "asc":
        candidates.reverse()
    page = candidates[offset : offset + limit]
    counts = {entry_id: index.links(entry_id) for entry_id in page}
    return _rows_for(snap, page, links=counts), len(candidates)


@router.get("/songs")
async def explore_songs(
    which: str = Query(SETS[0], alias="set", description=" | ".join(SETS)),
    q: Optional[str] = None,
    sort: str = SORT_TITLE,
    dir: str = "asc",  # noqa: A002 - the wire name; shadows nothing used here
    offset: int = 0,
    limit: int = DEFAULT_PAGE,
) -> dict[str, Any]:
    """The two numbers under the Songs card, as lists you can read."""
    _check(which, SETS, "set")
    _check(sort, SONG_SORTS, "sort")
    _check(dir, DIRECTIONS, "dir")
    page_offset, page_limit = _page_args(offset, limit)
    return await asyncio.to_thread(
        _songs_sync, _db(), which, q, sort, dir, page_offset, page_limit
    )


# ------------------------------------------------------------------- kinds


def _kind_probes(kind: str, role: str) -> list[tuple[str, str]]:
    """``(column, guard)`` pairs whose ``EXISTS`` means "this song is on that
    end of a link of this kind".

    The column is always ``from_id`` or ``to_id`` so the probe is an index
    seek. ``stem_of`` needs both, because its two writers point opposite ways
    and the row itself says which one wrote it.
    """
    if role == "any":
        return [("from_id", ""), ("to_id", "")]
    end = source_end_of(kind)
    parent_column = "from_id" if end == SOURCE_END_FROM else "to_id"
    child_column = "to_id" if parent_column == "from_id" else "from_id"
    wanted = parent_column if role == "parent" else child_column
    if kind != "stem_of":
        return [(wanted, "")]
    # The local separator writes ``stem_of`` with from_id as the SOURCE, the
    # opposite of the promoted writer. So each role lives in BOTH columns and
    # the guard says which writer's row is meant -- the same test
    # ``graph.is_local_stem_link`` applies, so SQL and the graph cannot
    # disagree about which end is the parent.
    local_wanted = "from_id" if role == "parent" else "to_id"
    other = "to_id" if local_wanted == "from_id" else "from_id"
    if wanted == local_wanted:
        return [
            (wanted, f" AND {_LOCAL_STEM_SQL}"),
            (other, f" AND NOT {_LOCAL_STEM_SQL}"),
        ]
    return [
        (wanted, f" AND NOT {_LOCAL_STEM_SQL}"),
        (local_wanted, f" AND {_LOCAL_STEM_SQL}"),
    ]


def _kind_predicate(kind: str, role: str) -> tuple[str, list[Any]]:
    parts: list[str] = []
    params: list[Any] = []
    for column, guard in _kind_probes(kind, role):
        parts.append(
            f"EXISTS (SELECT 1 FROM relations r WHERE r.{column} = e.id "
            f"AND r.kind = ? AND r.from_id <> r.to_id{guard})"
        )
        params.append(kind)
    return "(" + " OR ".join(parts) + ")", params


def _kinds_sync(
    db: Any,
    kind: str,
    role: str,
    q: Optional[str],
    sort: str,
    direction: str,
    offset: int,
    limit: int,
) -> dict[str, Any]:
    with _Snapshot(db) as snap:
        index = _index_cache.get(snap)
        if sort == SORT_COUNT:
            ranked = list(index.kind_ranked(kind, role))
            if direction == "asc":
                ranked.reverse()
            if q is not None and q.strip():
                matched = _ids_matching(snap, q)
                if matched is None:
                    ranked = []
                else:
                    ranked = [key for key in ranked if key in matched]
            total = len(ranked)
            page = ranked[offset : offset + limit]
            rows = _rows_for(
                snap,
                page,
                count={
                    entry_id: index.kind_count(kind, role, entry_id)
                    for entry_id in page
                },
            )
        else:
            predicate, params = _kind_predicate(kind, role)
            like_sql, like_params = _like_clause("e.title", q)
            where = predicate + (f" AND {like_sql}" if like_sql else "")
            order = f"{_SORT_COLUMNS[sort]} {direction.upper()}, e.rowid {direction.upper()}"
            found = snap.read(
                f"SELECT {_ENTRY_SELECT} FROM entries e WHERE {where} "
                f"ORDER BY {order} LIMIT ? OFFSET ?",
                [*params, *like_params, limit, offset],
            )
            rows = [
                _row_payload(
                    {key: row[key] for key in _ENTRY_COLUMNS},
                    str(row["id"]),
                    count=index.kind_count(kind, role, str(row["id"])),
                )
                for row in found
            ]
            total = (
                index.kind_total(kind, role)
                if not like_sql
                else int(
                    snap.read(
                        f"SELECT COUNT(*) FROM entries e WHERE {where}",
                        [*params, *like_params],
                    )[0][0]
                    or 0
                )
            )
    return {
        "kind": kind,
        "role": role,
        "sort": sort,
        "dir": direction,
        "total": total,
        "offset": offset,
        "limit": limit,
        "rows": rows,
    }


@router.get("/kinds/{kind}")
async def explore_kind(
    kind: str,
    role: str = "any",
    q: Optional[str] = None,
    sort: str = SORT_COUNT,
    dir: str = "desc",  # noqa: A002 - the wire name
    offset: int = 0,
    limit: int = DEFAULT_PAGE,
) -> dict[str, Any]:
    """Songs holding at least one link of ``kind``, on the asked-for end.

    Every kind in the role table is answerable, in either role -- the four
    preset lists were four of them.
    """
    if kind not in KIND_ORDER:
        raise HTTPException(400, f"unknown kind {kind!r}")
    _check(role, ROLES, "role")
    _check(sort, KIND_SORTS, "sort")
    _check(dir, DIRECTIONS, "dir")
    page_offset, page_limit = _page_args(offset, limit)
    return await asyncio.to_thread(
        _kinds_sync, _db(), kind, role, q, sort, dir, page_offset, page_limit
    )


# ---------------------------------------------------------------- rankings


def _rankings_sync(
    db: Any, kind: str, role: str, offset: int, limit: int
) -> dict[str, Any]:
    with _Snapshot(db) as snap:
        index = _index_cache.get(snap)
        if kind == KIND_ANY:
            ranked = index.ranked_parent if role == "parent" else index.ranked_child
            counts: dict[str, int] = (
                index.parent_counts if role == "parent" else index.child_counts
            )
            total = len(ranked)
            page = list(ranked[offset : offset + limit])
            rows = _rows_for(
                snap,
                page,
                count={entry_id: counts.get(entry_id, 0) for entry_id in page},
            )
        else:
            ordered = index.kind_ranked(kind, role)
            total = len(ordered)
            page = list(ordered[offset : offset + limit])
            rows = _rows_for(
                snap,
                page,
                count={
                    entry_id: index.kind_count(kind, role, entry_id)
                    for entry_id in page
                },
            )
    return {
        "kind": kind,
        "role": role,
        "sort": SORT_COUNT,
        "total": total,
        "offset": offset,
        "limit": limit,
        "rows": rows,
    }


@router.get("/rankings")
async def explore_rankings(
    kind: str = KIND_ANY,
    role: str = "parent",
    sort: str = SORT_COUNT,
    offset: int = 0,
    limit: int = DEFAULT_PAGE,
) -> dict[str, Any]:
    """ "Songs with the most links of kind K, as a parent / as a child".

    The four preset lists on the landing page are four answers to this
    question; ``/rankings`` still serves them unchanged. This one answers it
    for any kind, in either role, and pages.
    """
    if kind != KIND_ANY and kind not in KIND_ORDER:
        raise HTTPException(400, f"unknown kind {kind!r}")
    _check(role, RANKING_ROLES, "role")
    _check(sort, (SORT_COUNT,), "sort")
    page_offset, page_limit = _page_args(offset, limit)
    return await asyncio.to_thread(
        _rankings_sync, _db(), kind, role, page_offset, page_limit
    )


# ---------------------------------------------------------------- families


def _families_sync(db: Any, direction: str, offset: int, limit: int) -> dict[str, Any]:
    with _Snapshot(db) as snap:
        index = _index_cache.get(snap)
        families = list(index.families)
        if direction == "asc":
            families.reverse()
        page = families[offset : offset + limit]
        entries = _entry_rows(snap, [family.root for family in page])
        rows = [
            _row_payload(
                entries.get(family.root),
                family.root,
                root_id=family.root,
                size=family.size,
            )
            for family in page
        ]
    return {
        "sort": SORT_SIZE,
        "dir": direction,
        "total": len(index.families),
        "offset": offset,
        "limit": limit,
        "rows": rows,
    }


@router.get("/families")
async def explore_families(
    sort: str = SORT_SIZE,
    dir: str = "desc",  # noqa: A002 - the wire name
    offset: int = 0,
    limit: int = DEFAULT_PAGE,
) -> dict[str, Any]:
    """Every real family, biggest first.

    A family is a connected component over ANCESTRY links only -- the
    definition behind the landing page's "largest family". Mashups are left
    out on purpose: they weld unrelated trees into clusters tens of thousands
    of songs wide, which is the one number on that page that is not a family.
    """
    _check(sort, (SORT_SIZE,), "sort")
    _check(dir, DIRECTIONS, "dir")
    page_offset, page_limit = _page_args(offset, limit)
    return await asyncio.to_thread(_families_sync, _db(), dir, page_offset, page_limit)


def _members_sync(
    db: Any,
    entry_id: str,
    q: Optional[str],
    sort: str,
    direction: str,
    offset: int,
    limit: int,
) -> dict[str, Any]:
    with _Snapshot(db) as snap:
        index = _index_cache.get(snap)
        position = index.family_of.get(entry_id)
        if position is None:
            raise HTTPException(404, f"{entry_id!r} is not in a family")
        family = index.families[position]
        entries = _entry_rows(snap, list(family.members))
        members = [
            entry_id
            for entry_id in family.members
            if _matches_tokens(
                str((entries.get(entry_id) or {}).get("title") or entry_id), q
            )
        ]

        def key(member: str) -> Any:
            row = entries.get(member) or {}
            if sort == SORT_CREATED:
                return (float(row.get("created_at") or 0.0), member)
            if sort == SORT_PLAYS:
                return (int(row.get("play_count") or 0), member)
            if sort == SORT_LINKS:
                return (index.links(member), member)
            return (str(row.get("title") or member).casefold(), member)

        members.sort(key=key, reverse=direction == "desc")
        page = members[offset : offset + limit]
        rows = [
            _row_payload(entries.get(member), member, links=index.links(member))
            for member in page
        ]
    return {
        "root_id": family.root,
        "sort": sort,
        "dir": direction,
        "total": len(members),
        "offset": offset,
        "limit": limit,
        "rows": rows,
    }


@router.get("/families/{entry_id}/members")
async def explore_family_members(
    entry_id: str,
    q: Optional[str] = None,
    sort: str = SORT_TITLE,
    dir: str = "asc",  # noqa: A002 - the wire name
    offset: int = 0,
    limit: int = DEFAULT_PAGE,
) -> dict[str, Any]:
    """One family, paged. ``entry_id`` may be the family's id or ANY member's:
    a user clicking a song wants that song's family, not a lookup table."""
    _check(sort, SONG_SORTS, "sort")
    _check(dir, DIRECTIONS, "dir")
    page_offset, page_limit = _page_args(offset, limit)
    return await asyncio.to_thread(
        _members_sync, _db(), entry_id, q, sort, dir, page_offset, page_limit
    )


# ------------------------------------------------------------ startup warm


_warm_thread: Optional[threading.Thread] = None


def warm_explore_cache() -> bool:
    """Run the explorer's pass once, off any request.

    The store is looked up through ``router`` at call time, so whoever owns
    ``get_library_store`` when this runs is whose library is read -- a test's
    fixture, never the one this module happened to import.

    The same deal ``router.warm_stats_cache`` makes, for the same reasons and
    with the same two refusals: no library database, no warm; no read-only
    connection, no warm -- a background pass has no business holding
    ``LibraryDB``'s write lock for the seconds this takes.
    """
    try:
        # Through the router MODULE, at call time -- never a name bound at
        # import. A background pass that reads a store this module captured on
        # import is a pass over whatever library was configured then, which in
        # a test is the real one sitting behind the fixture's monkeypatch.
        # `_db()` already resolves this way, which is why the routes were safe.
        from . import router as _router

        store = _router.get_library_store()
        db = getattr(store, "db", None)
        if db is None:
            log.info("lineagescale: explore warm skipped, no library database")
            return False
        with _Snapshot(db) as snap:
            if not snap.isolated:
                log.info("lineagescale: explore warm skipped, no read-only connection")
                return False
            _index_cache.get(snap)
    except Exception:  # noqa: BLE001 - logged once, swallowed: see router
        log.warning(
            "lineagescale: warming the explorer index failed; the first "
            "explore request will pay for the pass",
            exc_info=True,
        )
        return False
    return True


def start_explore_warm_thread(delay: Optional[float] = None) -> threading.Thread:
    """A daemon thread, for the reason ``router.start_warm_thread`` gives: the
    idle-gated background queue has one consumer and a job that starts by
    sleeping would hold it shut."""
    global _warm_thread
    wait = WARM_DELAY_SEC if delay is None else float(delay)

    def _run() -> None:
        if wait > 0:
            time.sleep(wait)
        warm_explore_cache()

    thread = threading.Thread(
        target=_run, name="lineagescale-explore-warm", daemon=True
    )
    _warm_thread = thread
    thread.start()
    return thread


def _startup_warm() -> None:
    start_explore_warm_thread()


register_startup_hook("lineagescale-explore-warm", _startup_warm)


# Mounted from THIS side rather than from `router.py`'s: whichever module is
# imported first, the other one is fully executed by the time this line runs,
# so the sub-router is never attached empty.
_parent_router.include_router(router, prefix="/explore")
