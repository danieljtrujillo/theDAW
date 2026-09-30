"""Link roles, edge orientation and the bounded walks behind
``/api/lineage-scale``.

Everything here is pure. Functions take plain rows -- or a callable that
supplies them -- and return plain data: no FastAPI, no sqlite handle, nothing
that needs a server. ``router.py`` is the only place that touches the library
database and it stays thin, so every rule below is testable on its own.

Why the module exists: ``GET /api/library/_graph/all`` loads every entry and
every relation and hands the browser the lot. On the real library that is
194,833 nodes, 475,174 links and a 128 MB response, and the drawing never
happens. Here the unit of work is ONE song's neighbourhood, bounded before it
is built.

DIRECTION is the load-bearing fact and it is NOT uniform across writers, so
every kind in :data:`KIND_ROLES` records the writer its ``source_end`` was
read from. Nothing here infers direction from timestamps.

THREE FACTS THIS MODULE IS BUILT AROUND
---------------------------------------
1. A connected component is not a family. One component in the real library
   holds 81,501 songs, welded together by ``mashup_source`` links: a mashup
   has parents from unrelated trees. So ``uses`` links are shown one hop from
   the focus and are never walked through -- a neighbourhood cannot leak into
   an unrelated tree.
2. The same relationship is stored several times. One stem points at the same
   parent as ``derived_from`` + ``edit_of`` + ``stem_of``. Every link between
   the same (child, parent) pair is therefore ONE edge carrying ``kinds``.
3. A song's own neighbourhood is small (median 2, p99 ~750) but a few songs
   have ~800 direct relatives. More than :data:`GROUP_THRESHOLD` relatives of
   one kind in one direction collapse into a group with a count, so a hub
   costs the same as an ordinary song.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Callable, Iterable, Iterator, Mapping, Optional, Sequence

# --------------------------------------------------------------------- roles

#: One song came from another. Walked across generations.
ROLE_ANCESTRY = "ancestry"
#: A cross-reference ("this mashup uses A and B"). Shown one hop from the
#: focus, never recursed -- see fact 1 in the module docstring.
ROLE_USES = "uses"
#: Not a song (a MIDI file, a score, a chord chart). Counted, never drawn.
ROLE_ARTIFACT = "artifact"
#: A kind :data:`KIND_ROLES` has never heard of -- a hand-written row, a
#: writer added after this table, a library carried over from another build.
#: Treated like ``uses``: shown one hop, never recursed. Ancestry is NOT
#: assumed. Every kind this repository's own writers produce is in the table,
#: and ``tests/test_lineagescale.py`` scans those writers to keep it that way.
ROLE_OTHER = "other"

#: ``to_id`` is the source, ``from_id`` is the derived song.
SOURCE_END_TO = "to"
#: ``from_id`` is the source, ``to_id`` is the derived song.
SOURCE_END_FROM = "from"


@dataclass(frozen=True)
class LinkKind:
    """One row of the role table.

    ``writer`` is the file the ``source_end`` was read from; it is part of the
    data because the two directions in this repository are a standing trap.
    """

    kind: str
    role: str
    source_end: str
    writer: str


# Declaration order is display order: ``kinds[0]`` of a merged edge is the
# kind the UI colours and labels by, so the specific kinds (cover, edit) come
# before the generic one (derived_from) that co-occurs with everything.
_KINDS: tuple[LinkKind, ...] = (
    # Promoted lineage. The writer appends ``(child, parent, relation)``, so
    # from_id is the derived song and to_id is its source.
    LinkKind("cover_of", ROLE_ANCESTRY, SOURCE_END_TO, "suno_promote.py:1633"),
    # The Suno poller writes its own bare kind for a derived track, and it
    # points the OTHER way: ``add_relation(from_id=<parent>, to_id=<the new
    # entry>, kind=mode)`` with ``mode`` in ("cover", "mashup"), so from_id is
    # the SOURCE. Read with the promoted writer's direction these came out
    # backwards, dashed, and out of the ancestry rankings.
    LinkKind(
        "cover", ROLE_ANCESTRY, SOURCE_END_FROM, "backend/modules/suno/router.py:346"
    ),
    LinkKind("edit_of", ROLE_ANCESTRY, SOURCE_END_TO, "suno_promote.py:1633"),
    LinkKind("derived_from", ROLE_ANCESTRY, SOURCE_END_TO, "suno_promote.py:1633"),
    LinkKind("upsample_of", ROLE_ANCESTRY, SOURCE_END_TO, "suno_promote.py:1633"),
    LinkKind("overpaint_of", ROLE_ANCESTRY, SOURCE_END_TO, "suno_promote.py:1633"),
    LinkKind("underpaint_of", ROLE_ANCESTRY, SOURCE_END_TO, "suno_promote.py:1633"),
    LinkKind("speed_change_of", ROLE_ANCESTRY, SOURCE_END_TO, "suno_promote.py:1633"),
    # stem_of has TWO writers pointing opposite ways -- see _LOCAL_STEM_NOTE
    # and :func:`orient`. The table carries the promoted one (every one of the
    # 6,428 stem_of links in the real library came from there).
    LinkKind("stem_of", ROLE_ANCESTRY, SOURCE_END_TO, "suno_promote.py:1633"),
    # A mashup points at each of its sources: from_id is the mashup.
    LinkKind("mashup_source", ROLE_USES, SOURCE_END_TO, "suno_promote.py:1633"),
    # The Suno poller's bare sibling, written the other way round: from_id is
    # the source clip, to_id is the mashup built from it.
    LinkKind(
        "mashup", ROLE_USES, SOURCE_END_FROM, "backend/modules/suno/router.py:346"
    ),
    # The opposite way round: ``(label, entry_id, "chimera_source_of")`` --
    # from_id is the source label, to_id is the song built from it.
    LinkKind(
        "chimera_source_of",
        ROLE_USES,
        SOURCE_END_FROM,
        "backend/modules/library/store.py:794",
    ),
    # Artifacts: from_id is the song, to_id is the file produced from it.
    LinkKind(
        "midi_of", ROLE_ARTIFACT, SOURCE_END_FROM, "backend/modules/midi/runner.py:97"
    ),
    LinkKind(
        "rendered_as_notation",
        ROLE_ARTIFACT,
        SOURCE_END_FROM,
        "backend/modules/notation/engine.py:2442",
    ),
    LinkKind(
        "tabbed_as_notation",
        ROLE_ARTIFACT,
        SOURCE_END_FROM,
        "backend/modules/notation/engine.py:2545",
    ),
    LinkKind(
        "arranged_as_notation",
        ROLE_ARTIFACT,
        SOURCE_END_FROM,
        "backend/modules/notation/engine.py:2635",
    ),
    # A score played into audio: from_id is the sheet artifact, to_id is the
    # new Library entry holding the render.
    LinkKind(
        "rendered_as_audio",
        ROLE_ARTIFACT,
        SOURCE_END_FROM,
        "backend/modules/notation/musescore_render.py:388",
    ),
    LinkKind(
        "charted_as_chords",
        ROLE_ARTIFACT,
        SOURCE_END_FROM,
        "backend/modules/notation/router.py:648",
    ),
)

#: kind -> :class:`LinkKind`. The single source of truth for role + direction.
KIND_ROLES: dict[str, LinkKind] = {k.kind: k for k in _KINDS}

#: kind -> display rank. Unknown kinds sort last (see :func:`sort_kinds`).
KIND_ORDER: dict[str, int] = {k.kind: i for i, k in enumerate(_KINDS)}

ANCESTRY_KINDS: frozenset[str] = frozenset(
    k.kind for k in _KINDS if k.role == ROLE_ANCESTRY
)
USES_KINDS: frozenset[str] = frozenset(k.kind for k in _KINDS if k.role == ROLE_USES)
ARTIFACT_KINDS: frozenset[str] = frozenset(
    k.kind for k in _KINDS if k.role == ROLE_ARTIFACT
)

#: Strongest role first. A pair carrying both an ancestry kind and a ``uses``
#: kind IS a derivation; the cross-reference is the weaker statement.
_ROLE_RANK: dict[str, int] = {
    ROLE_ANCESTRY: 0,
    ROLE_USES: 1,
    ROLE_OTHER: 2,
    ROLE_ARTIFACT: 3,
}

# ``backend/modules/stems/engine.py:311`` writes a locally separated stem as
# ``add_relation(from_id=entry_id, to_id=f"{entry_id}__{stem_name}",
# kind="stem_of")`` -- from_id is the SOURCE there, the opposite of the
# promoted writer's ``stem_of``. The two are told apart by the id template
# that writer uses verbatim (the stem id is the parent id plus "__" plus the
# stem name), not by a timestamp or a guess: entry ids are uuid4 hex or
# "{job_id}_{index:02d}" (store.py), so no promoted child id can start with
# another entry's whole id followed by "__".
_LOCAL_STEM_NOTE = "backend/modules/stems/engine.py:311"
_LOCAL_STEM_SEPARATOR = "__"


def is_local_stem_link(from_id: str, to_id: str, kind: str) -> bool:
    """True for a ``stem_of`` row written by the local stem separator."""
    return kind == "stem_of" and to_id.startswith(from_id + _LOCAL_STEM_SEPARATOR)


def role_of(kind: str) -> str:
    """The role of ``kind``. An unrecognised kind is :data:`ROLE_OTHER` --
    ancestry is never assumed for something no writer in this repo produces."""
    info = KIND_ROLES.get(kind)
    return info.role if info is not None else ROLE_OTHER


def source_end_of(kind: str) -> str:
    """Which end of a raw row is the source for ``kind``."""
    info = KIND_ROLES.get(kind)
    return info.source_end if info is not None else SOURCE_END_TO


def orient(from_id: str, to_id: str, kind: str) -> Optional[tuple[str, str]]:
    """Turn a raw ``relations`` row into ``(child, parent)``.

    ``parent`` is the source, ``child`` is the thing made from it. Returns
    ``None`` for a self-link, which is not a relationship and would otherwise
    make a node its own ancestor.
    """
    if not from_id or not to_id or from_id == to_id:
        return None
    end = source_end_of(kind)
    if is_local_stem_link(from_id, to_id, kind):
        end = SOURCE_END_FROM
    if end == SOURCE_END_FROM:
        return to_id, from_id
    return from_id, to_id


def sort_kinds(kinds: Iterable[str]) -> tuple[str, ...]:
    """Deduplicate and order kinds for display. ``result[0]`` is the kind the
    UI colours the merged edge by."""
    unique = {str(k) for k in kinds if k}
    return tuple(sorted(unique, key=lambda k: (KIND_ORDER.get(k, len(_KINDS)), k)))


def role_for_kinds(kinds: Sequence[str]) -> str:
    """The role of a merged edge: the strongest role among its kinds."""
    if not kinds:
        return ROLE_OTHER
    return min((role_of(k) for k in kinds), key=lambda r: _ROLE_RANK[r])


# ---------------------------------------------------------------- edge shapes


@dataclass(frozen=True)
class MergedEdge:
    """Every link between one (child, parent) pair, as one edge.

    On the wire ``from`` is always the derived song and ``to`` is always its
    source, whichever way round the writer stored it.
    """

    child: str
    parent: str
    kinds: tuple[str, ...]
    role: str

    def to_wire(self) -> dict[str, Any]:
        return {
            "from": self.child,
            "to": self.parent,
            "kinds": list(self.kinds),
            "role": self.role,
        }


@dataclass(frozen=True)
class Group:
    """A collapsed fan: more than :data:`GROUP_THRESHOLD` relatives of one
    kind hanging off one node in one direction."""

    id: str
    parent_id: str
    direction: str
    kind: str
    count: int
    sample_ids: tuple[str, ...]

    def to_wire(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "parent_id": self.parent_id,
            "direction": self.direction,
            "kind": self.kind,
            "count": self.count,
            "sample_ids": list(self.sample_ids),
        }


# ------------------------------------------------------------------ bounds

#: ``up``/``down`` are clamped to this many generations either way.
MAX_DEPTH = 8
DEFAULT_UP = 2
DEFAULT_DOWN = 1
#: How many nodes one neighbourhood may carry.
MIN_BUDGET = 50
MAX_BUDGET = 1500
DEFAULT_BUDGET = 400
#: More than this many relatives of one kind in one direction become a group
#: instead of nodes. 12 fits on screen; 13 is already a wall.
GROUP_THRESHOLD = 12
#: How many ids a group carries so the UI can show a preview.
GROUP_SAMPLE_IDS = 5
#: ``full_view_ok``: at or below this many linked songs LEARN opens the
#: classic whole-library drawing by default; past it, the scale view. A
#: threshold, not a measurement of where the drawing stops responding, which
#: is why LEARN keeps the classic view reachable past it. ``/summary`` sends
#: it as ``full_view_limit`` so the UI's warning quotes the number that
#: decided.
FULL_VIEW_LIMIT = 2000
#: Rows one ranked list returns before clamping.
DEFAULT_RANKING_LIMIT = 50
MAX_RANKING_LIMIT = 500
#: Rows one relatives page returns.
DEFAULT_RELATIVES_LIMIT = 100
MAX_RELATIVES_LIMIT = 500

UP = "up"
DOWN = "down"
DIRECTIONS = (UP, DOWN)

RANKING_LISTS = ("most_derived", "deepest", "mashup_sources", "recent")
RELATIVES_SORTS = ("title", "plays", "recent")
KIND_ALL = "all"


def clamp_depth(value: int) -> int:
    return max(0, min(int(value), MAX_DEPTH))


def clamp_budget(value: int) -> int:
    return max(MIN_BUDGET, min(int(value), MAX_BUDGET))


def clamp_ranking_limit(value: int) -> int:
    return max(1, min(int(value), MAX_RANKING_LIMIT))


def clamp_relatives_limit(value: int) -> int:
    return max(1, min(int(value), MAX_RELATIVES_LIMIT))


# ----------------------------------------------------------- neighbourhood

#: A callable the router supplies: given some ids, yield every raw
#: ``(from_id, to_id, kind)`` row touching any of them in either column.
FetchLinks = Callable[[Sequence[str]], Iterable[tuple[str, str, str]]]


@dataclass
class Neighbourhood:
    """The bounded result of :func:`build_neighbourhood`."""

    focus: str
    order: list[str]
    generation: dict[str, int]
    edges: list[MergedEdge]
    groups: list[Group]
    hidden: dict[str, dict[str, int]]
    truncated: bool
    budget: int
    up: int
    down: int


def directions_to_expand(generation: int, up: int, down: int) -> tuple[str, ...]:
    """Which way a node at ``generation`` is still allowed to grow.

    A node above the focus only grows further up and a node below it only
    grows further down: a neighbourhood is an ancestry line, not a sweep
    sideways through every sibling subtree.
    """
    out: list[str] = []
    if generation <= 0 and -generation < up:
        out.append(UP)
    if generation >= 0 and generation < down:
        out.append(DOWN)
    return tuple(out)


def _index_links(
    rows: Iterable[tuple[str, str, str]],
    ids: Sequence[str],
) -> dict[str, dict[str, dict[str, set[str]]]]:
    """``node -> direction -> relative -> kinds`` for the given ids.

    ``up`` holds the node's sources, ``down`` its derivatives. Artifact links
    are dropped here: they are files, not songs, and are never drawn.
    Duplicate rows collapse into the kind set, so a row seen twice (once from
    each end of the frontier query) costs nothing.
    """
    wanted = set(ids)
    out: dict[str, dict[str, dict[str, set[str]]]] = {
        node: {UP: {}, DOWN: {}} for node in wanted
    }
    for from_id, to_id, kind in rows:
        pair = orient(from_id, to_id, kind)
        if pair is None:
            continue
        if role_of(kind) == ROLE_ARTIFACT:
            continue
        child, parent = pair
        if child in wanted:
            out[child][UP].setdefault(parent, set()).add(kind)
        if parent in wanted:
            out[parent][DOWN].setdefault(child, set()).add(kind)
    return out


def _relative_pair(node: str, relative: str, direction: str) -> tuple[str, str]:
    """``(child, parent)`` for an edge between ``node`` and ``relative``."""
    if direction == UP:
        return node, relative
    return relative, node


def build_neighbourhood(
    focus_id: str,
    *,
    up: int = DEFAULT_UP,
    down: int = DEFAULT_DOWN,
    budget: int = DEFAULT_BUDGET,
    fetch_links: FetchLinks,
) -> Neighbourhood:
    """Breadth-first, nearest first, stopping at ``budget``.

    ``fetch_links`` is the only way out of this function; everything else is
    arithmetic. The walk fetches ONE batch of links per level, which is what
    keeps the cost proportional to the neighbourhood rather than the library.

    Rules, all of them from the module docstring:

    * ancestry links are walked; ``uses``/``other`` links are shown one hop
      from the focus and never walked through -- neither by following one
      from a node that is not the focus, nor by carrying on past a node that
      was reached through one;
    * more than :data:`GROUP_THRESHOLD` new relatives of one kind in one
      direction become a :class:`Group` instead of nodes;
    * ``hidden[node]`` counts the ancestry relatives of that node (plus the
      focus's ``uses`` relatives, which is where they are shown) that ended up
      neither a node nor inside a group, in BOTH directions, so the UI can
      offer "+N more" on any node it drew;
    * the budget counts nodes; hitting it sets ``truncated``.
    """
    up = clamp_depth(up)
    down = clamp_depth(down)
    budget = clamp_budget(budget)

    generation: dict[str, int] = {focus_id: 0}
    order: list[str] = [focus_id]
    pair_kinds: dict[tuple[str, str], set[str]] = {}
    groups: list[Group] = []
    #: (node, direction) -> relatives swallowed by a group, so they are not
    #: counted a second time as hidden.
    grouped: dict[tuple[str, str], set[str]] = {}
    hidden: dict[str, dict[str, int]] = {}
    truncated = False
    #: Nodes reached through a ``uses``/``other`` link. They are drawn, and
    #: their links are read so they can carry a "+N more", but the walk stops
    #: at them: expanding a mashup's other parent is walking THROUGH the
    #: cross-reference, which is how a two-hop view turns into an
    #: 81,501-song component.
    terminal: set[str] = set()

    #: (node, direction) -> every relative of that node the view could have
    #: drawn. Kept until the walk finishes: a node found two levels later by
    #: another path must not still be counted as hidden from here.
    eligible: dict[tuple[str, str], set[str]] = {}

    frontier: list[str] = [focus_id]
    while frontier:
        links = _index_links(fetch_links(frontier), frontier)
        discovered: list[str] = []
        # Record what each node COULD have shown before deciding what it does
        # show. The subtraction happens once the whole walk is over: a
        # relative reached two levels later by another path is on screen, and
        # counting it as hidden here would be a "+1 more" that leads nowhere.
        for node in frontier:
            for direction in DIRECTIONS:
                seen_here = eligible.setdefault((node, direction), set())
                for relative, kinds in links[node][direction].items():
                    role = role_for_kinds(sort_kinds(kinds))
                    if role == ROLE_ANCESTRY or node == focus_id:
                        seen_here.add(relative)
        for node in frontier:
            node_gen = generation[node]
            if node in terminal:
                continue
            for direction in directions_to_expand(node_gen, up, down):
                candidates: dict[str, tuple[tuple[str, ...], str]] = {}
                for relative, kinds in links[node][direction].items():
                    ordered = sort_kinds(kinds)
                    role = role_for_kinds(ordered)
                    if node != focus_id and role != ROLE_ANCESTRY:
                        # A mashup welds unrelated trees together. Following
                        # one past the focus is how a neighbourhood becomes
                        # an 81,501-song component.
                        continue
                    pair = _relative_pair(node, relative, direction)
                    if relative in generation:
                        pair_kinds.setdefault(pair, set()).update(ordered)
                        continue
                    candidates[relative] = (ordered, role)

                by_kind: dict[str, list[str]] = {}
                for relative, (ordered, _role) in candidates.items():
                    by_kind.setdefault(ordered[0], []).append(relative)

                for kind in sorted(
                    by_kind, key=lambda k: (KIND_ORDER.get(k, len(_KINDS)), k)
                ):
                    relatives = sorted(by_kind[kind])
                    if len(relatives) > GROUP_THRESHOLD:
                        groups.append(
                            Group(
                                id=f"{node}|{direction}|{kind}",
                                parent_id=node,
                                direction=direction,
                                kind=kind,
                                count=len(relatives),
                                sample_ids=tuple(relatives[:GROUP_SAMPLE_IDS]),
                            )
                        )
                        grouped.setdefault((node, direction), set()).update(relatives)
                        # A relative folded in here can still be DRAWN later,
                        # by another path -- the fold is per (node, direction,
                        # kind), not a decision about the relative itself.
                        # Record the pair now so that node keeps its line back
                        # to this parent instead of arriving unattached. The
                        # edge is emitted only when BOTH ends were drawn (see
                        # ``edges`` below), so a relative that stays folded
                        # still ships no edge and the fold still saves the
                        # payload it was there to save.
                        for relative in relatives:
                            pair = _relative_pair(node, relative, direction)
                            pair_kinds.setdefault(pair, set()).update(
                                candidates[relative][0]
                            )
                        continue
                    for relative in relatives:
                        if len(order) >= budget:
                            truncated = True
                            continue
                        ordered, relative_role = candidates[relative]
                        if relative_role != ROLE_ANCESTRY:
                            terminal.add(relative)
                        generation[relative] = (
                            node_gen - 1 if direction == UP else node_gen + 1
                        )
                        order.append(relative)
                        discovered.append(relative)
                        pair = _relative_pair(node, relative, direction)
                        pair_kinds.setdefault(pair, set()).update(ordered)

        frontier = discovered

    for node in order:
        counts = {UP: 0, DOWN: 0}
        for direction in DIRECTIONS:
            swallowed = grouped.get((node, direction), ())
            counts[direction] = sum(
                1
                for relative in eligible.get((node, direction), ())
                if relative not in generation and relative not in swallowed
            )
        if counts[UP] or counts[DOWN]:
            hidden[node] = counts

    edges = [
        MergedEdge(
            child=child,
            parent=parent,
            kinds=sort_kinds(kinds),
            role=role_for_kinds(sort_kinds(kinds)),
        )
        for (child, parent), kinds in pair_kinds.items()
        # Both ends have to be on screen. A pair recorded for a relative that
        # was folded into a group and never drawn is not a line to nowhere.
        if child in generation and parent in generation
    ]
    return Neighbourhood(
        focus=focus_id,
        order=order,
        generation=generation,
        edges=edges,
        groups=groups,
        hidden=hidden,
        truncated=truncated,
        budget=budget,
        up=up,
        down=down,
    )


# --------------------------------------------------------------- relatives


def collect_relatives(
    entry_id: str,
    *,
    direction: str,
    kind: str,
    rows: Iterable[tuple[str, str, str]],
) -> list[tuple[str, tuple[str, ...]]]:
    """``[(relative_id, kinds)]`` for one song, one direction, merged.

    ``kind`` is a single kind or :data:`KIND_ALL`. ``all`` means everything
    the graph draws (ancestry + uses); an artifact kind has to be asked for by
    name, because a score is not a relative of a song in the way another song
    is. Ordering is by id so the caller's sort is the only thing that decides
    the page.
    """
    merged: dict[str, set[str]] = {}
    for from_id, to_id, row_kind in rows:
        pair = orient(from_id, to_id, row_kind)
        if pair is None:
            continue
        child, parent = pair
        if direction == UP:
            if child != entry_id:
                continue
            relative = parent
        else:
            if parent != entry_id:
                continue
            relative = child
        if kind == KIND_ALL:
            if role_of(row_kind) == ROLE_ARTIFACT:
                continue
        elif row_kind != kind:
            continue
        merged.setdefault(relative, set()).add(row_kind)
    return [(rid, sort_kinds(kinds)) for rid, kinds in sorted(merged.items())]


# ------------------------------------------------------- library-wide stats


@dataclass(frozen=True)
class RankedId:
    """One row of a ranked list, before the router attaches a title."""

    id: str
    count: int
    detail: str


@dataclass(frozen=True)
class LibraryStats:
    """Everything ``/summary`` and ``/rankings`` answer with, from one pass.

    Both routes are served from this, so asking for a ranked list after the
    summary costs nothing. Only the small results are kept: the adjacency the
    pass builds is freed before this is returned.
    """

    summary: dict[str, Any]
    rankings: dict[str, list[RankedId]]
    revision: int


class _UnionFind:
    """Index-based union-find. Dicts of ids would be ~3x slower over the
    475,174 links the real library has, and this runs on a request."""

    def __init__(self) -> None:
        self._index: dict[str, int] = {}
        self._parent: list[int] = []
        self._rank: list[int] = []

    def node(self, key: str) -> int:
        idx = self._index.get(key)
        if idx is None:
            idx = len(self._parent)
            self._index[key] = idx
            self._parent.append(idx)
            self._rank.append(0)
        return idx

    def find(self, idx: int) -> int:
        parent = self._parent
        root = idx
        while parent[root] != root:
            root = parent[root]
        while parent[idx] != root:
            parent[idx], idx = root, parent[idx]
        return root

    def union(self, a: str, b: str) -> None:
        ra, rb = self.find(self.node(a)), self.find(self.node(b))
        if ra == rb:
            return
        if self._rank[ra] < self._rank[rb]:
            ra, rb = rb, ra
        self._parent[rb] = ra
        if self._rank[ra] == self._rank[rb]:
            self._rank[ra] += 1

    def largest_component(self, members: Iterable[str]) -> int:
        """The biggest component, counting only ``members``.

        The count is in songs: a chimera source label is welded into the
        component but it is a file name, not a track, and counting it would
        inflate the number the landing page shows.
        """
        sizes: dict[int, int] = {}
        best = 0
        for key in members:
            idx = self._index.get(key)
            if idx is None:
                best = max(best, 1)
                continue
            root = self.find(idx)
            size = sizes.get(root, 0) + 1
            sizes[root] = size
            if size > best:
                best = size
        return best


def longest_ancestry_chains(
    parents: Mapping[str, Sequence[tuple[str, str]]],
) -> tuple[dict[str, int], dict[str, tuple[str, ...]]]:
    """Longest chain of sources ending at each node, and the kinds along it.

    Iterative on purpose: a recursive walk over 194,833 nodes is the same
    "Maximum call stack size exceeded" this whole module exists to escape,
    one language over. Cycle-safe: an edge back into the chain currently
    being resolved is ignored rather than followed, so a 2-cycle is depth 1
    on each side instead of an infinite climb.
    """
    WHITE, GREY, BLACK = 0, 1, 2
    state: dict[str, int] = {}
    depth: dict[str, int] = {}
    via: dict[str, tuple[str, ...]] = {}

    for start in parents:
        if state.get(start, WHITE) != WHITE:
            continue
        stack: list[tuple[str, bool]] = [(start, False)]
        while stack:
            node, resolved = stack.pop()
            if resolved:
                best = 0
                best_via: tuple[str, ...] = ()
                for parent, kind in parents.get(node, ()):
                    if state.get(parent, WHITE) != BLACK:
                        continue
                    candidate = depth[parent] + 1
                    if candidate > best:
                        best = candidate
                        trail = [kind]
                        for step in via.get(parent, ()):
                            if step not in trail:
                                trail.append(step)
                        best_via = tuple(trail[:3])
                depth[node] = best
                via[node] = best_via
                state[node] = BLACK
                continue
            if state.get(node, WHITE) != WHITE:
                continue
            state[node] = GREY
            stack.append((node, True))
            for parent, _kind in parents.get(node, ()):
                if state.get(parent, WHITE) == WHITE:
                    stack.append((parent, False))
    return depth, via


def _iso(ts: float) -> str:
    try:
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(float(ts)))
    except (OSError, OverflowError, TypeError, ValueError):
        return ""


def _top(
    counts: Mapping[str, int],
    limit: int,
    *,
    only: Optional[set[str]] = None,
) -> list[str]:
    """Highest count first, id ascending as the tie-break so two calls on an
    unchanged library return the same rows in the same order."""
    keys = counts.keys() if only is None else (k for k in counts if k in only)
    return sorted(keys, key=lambda k: (-counts[k], k))[:limit]


def _kind_detail(kinds: Mapping[str, int]) -> str:
    ranked = sorted(kinds.items(), key=lambda kv: (-kv[1], kv[0]))[:3]
    return " · ".join(f"{kind} {n}" for kind, n in ranked)


def compute_library_stats(
    link_rows: Iterable[tuple[str, str, str]],
    entry_rows: Iterable[tuple[str, float]],
    *,
    revision: int,
    limit: int = DEFAULT_RANKING_LIMIT,
) -> LibraryStats:
    """ONE pass over ``relations`` and one over ``entries``.

    ``link_rows`` is ``(from_id, to_id, kind)`` and is consumed as a stream --
    475,174 rows are never all resident. ``entry_rows`` is ``(id, created_at)``:
    the two columns the summary and the ``recent`` ranking need, and no blob.
    """
    limit = clamp_ranking_limit(limit)

    by_kind: dict[str, int] = {}
    links_raw = 0
    #: (child, parent) -> the kind that decides the pair's colour and role.
    pairs: dict[tuple[str, str], str] = {}

    for from_id, to_id, kind in link_rows:
        links_raw += 1
        by_kind[kind] = by_kind.get(kind, 0) + 1
        pair = orient(from_id, to_id, kind)
        if pair is None:
            continue
        current = pairs.get(pair)
        if current is None or KIND_ORDER.get(kind, len(_KINDS)) < KIND_ORDER.get(
            current, len(_KINDS)
        ):
            pairs[pair] = kind

    created_at: dict[str, float] = {}
    for entry_id, entry_created in entry_rows:
        created_at[str(entry_id)] = float(entry_created or 0.0)
    entry_ids = created_at.keys()

    connected = _UnionFind()
    tree = _UnionFind()
    linked: set[str] = set()
    derived_children: dict[str, set[str]] = {}
    ancestry_parents: dict[str, list[tuple[str, str]]] = {}
    uses_products: dict[str, set[str]] = {}
    newest_child: dict[str, float] = {}

    for (child, parent), kind in pairs.items():
        role = role_of(kind)
        if role == ROLE_ARTIFACT:
            continue
        linked.add(child)
        linked.add(parent)
        connected.union(child, parent)
        if role == ROLE_ANCESTRY:
            tree.union(child, parent)
            derived_children.setdefault(parent, set()).add(child)
            ancestry_parents.setdefault(child, []).append((parent, kind))
            born = created_at.get(child)
            if born is not None and born > newest_child.get(parent, float("-inf")):
                newest_child[parent] = born
        elif role == ROLE_USES:
            uses_products.setdefault(parent, set()).add(child)

    entry_id_set = set(entry_ids)
    with_lineage = sum(1 for entry_id in entry_id_set if entry_id in linked)
    entries_total = len(entry_id_set)

    derived_counts = {k: len(v) for k, v in derived_children.items()}
    uses_counts = {k: len(v) for k, v in uses_products.items()}
    depth, via = longest_ancestry_chains(ancestry_parents)

    most_derived_ids = _top(derived_counts, limit, only=entry_id_set)
    mashup_ids = _top(uses_counts, limit, only=entry_id_set)
    deepest_ids = sorted(
        (k for k in depth if depth[k] > 0 and k in entry_id_set),
        key=lambda k: (-depth[k], k),
    )[:limit]
    recent_ids = sorted(
        (k for k in newest_child if k in entry_id_set),
        key=lambda k: (-newest_child[k], k),
    )[:limit]

    # Kind breakdowns only for the rows that actually made a list.
    wanted = set(most_derived_ids) | set(mashup_ids)
    breakdown: dict[str, dict[str, int]] = {}
    if wanted:
        for (_child, parent), kind in pairs.items():
            if parent in wanted and role_of(kind) != ROLE_ARTIFACT:
                slot = breakdown.setdefault(parent, {})
                slot[kind] = slot.get(kind, 0) + 1

    rankings = {
        "most_derived": [
            RankedId(
                id=entry_id,
                count=derived_counts[entry_id],
                detail=_kind_detail(breakdown.get(entry_id, {})),
            )
            for entry_id in most_derived_ids
        ],
        "deepest": [
            RankedId(
                id=entry_id,
                count=depth[entry_id],
                detail=" → ".join(via.get(entry_id, ())),
            )
            for entry_id in deepest_ids
        ],
        "mashup_sources": [
            RankedId(
                id=entry_id,
                count=uses_counts[entry_id],
                detail=_kind_detail(breakdown.get(entry_id, {})),
            )
            for entry_id in mashup_ids
        ],
        "recent": [
            RankedId(
                id=entry_id,
                count=derived_counts.get(entry_id, 0),
                detail=_iso(newest_child[entry_id]),
            )
            for entry_id in recent_ids
        ],
    }

    summary = {
        "entries": entries_total,
        "with_lineage": with_lineage,
        "standalone": max(0, entries_total - with_lineage),
        "links_raw": links_raw,
        "links_distinct": len(pairs),
        "by_kind": dict(sorted(by_kind.items())),
        "largest_connected": connected.largest_component(entry_id_set),
        "largest_tree": tree.largest_component(entry_id_set),
        "full_view_ok": with_lineage <= FULL_VIEW_LIMIT,
        "full_view_limit": FULL_VIEW_LIMIT,
        "revision": revision,
    }
    return LibraryStats(summary=summary, rankings=rankings, revision=revision)


def chunked(items: Sequence[str], size: int) -> Iterator[Sequence[str]]:
    """Slice an id list into SQL-variable-sized pieces."""
    for start in range(0, len(items), size):
        yield items[start : start + size]
