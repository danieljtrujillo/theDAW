"""A synthetic library shaped like the real one, for the lineage-scale tests.

Nothing here touches the user's library. Every id, title and link is made up
by this file; the database is written into whatever temp directory the test
hands it, through the real :class:`~backend.modules.library.db.LibraryDB`
schema so the rows and indexes are the ones production has.

The shapes it builds are the ones that broke the old whole-library drawing,
each sized from the measured facts about the real library:

* a 10,000-song component that only holds together because of ``uses``
  links -- remove them and the biggest piece is 20 (the real library:
  81,501 down to 8,618);
* an ancestry tree 2,000 generations deep and a few thousand nodes wide,
  deeper than CPython's recursion limit, so a recursive walk cannot pass;
* one hub with 800 children of mixed kinds (the real maximum fan is
  ~750-850);
* mashups with two parents from unrelated trees;
* the same pair linked by three kinds at once (the real library stores one
  stem as derived_from + edit_of + stem_of);
* a 2-cycle, dangling endpoints with no ``entries`` row, artifact links,
  locally separated stems (whose writer points the other way), and songs
  with no lineage at all;
* ``metadata_json`` padded to ~8 KB a row, because a query that reads that
  column is ~100x slower than a synthetic thin row suggests and the whole
  point of this module is that it never does.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator, Optional

from backend.modules.library.db import LibraryDB

#: Roughly the per-row weight of a real library row's metadata blob, scaled
#: down so a 13,000-row fixture is ~100 MB rather than ~450 MB.
METADATA_PAD_BYTES = 8_000

#: Every ``created_at`` is derived from this, one second apart, so "most
#: recently extended" has exactly one right answer.
BASE_CREATED_AT = 1_700_000_000.0

# --- region sizes ----------------------------------------------------------
WELD_ISLANDS = 500
WELD_ISLAND_SIZE = 20
#: 500 * 20 = the 10,000-song component welded by ``uses`` links.
WELD_TOTAL = WELD_ISLANDS * WELD_ISLAND_SIZE

DEEP_SPINE = 2_000
DEEP_LEAF_EVERY = 100
DEEP_LEAVES_PER_NODE = 8
#: Spine nodes 100, 200, ... 1900 carry leaves -- the spine runs 0..1999, so
#: the last multiple of 100 that gets any is 1900, not 2000.
DEEP_TOTAL = DEEP_SPINE + ((DEEP_SPINE - 1) // DEEP_LEAF_EVERY) * DEEP_LEAVES_PER_NODE

HUB_CHILDREN = 800
#: The hub's 800 children, split across three kinds. Each split is well over
#: the grouping threshold, so a hub costs three groups instead of 800 nodes.
HUB_KIND_SPLIT = (("cover_of", 400), ("edit_of", 250), ("upsample_of", 150))

MASHUP_BRANCH_SIZE = 7
#: How many separate mashups lean on one popular source, so "biggest mashup
#: source" has a winner rather than a 500-way tie.
MASHUP_POPULAR_USERS = 30
STANDALONE_SONGS = 50

#: A kind no writer in this repository produces. It must land in role
#: ``other``: shown one hop, never recursed, never assumed to be ancestry.
UNKNOWN_KIND = "remixed_by_hand"

#: Exactly the grouping threshold, and one more. 12 relatives stay nodes, 13
#: become a group -- the boundary is the whole point of the rule.
THRESHOLD_EXACT_CHILDREN = 12
THRESHOLD_OVER_CHILDREN = 13

#: A tree that is wide but never wide enough to group: 8 children a node,
#: three deep, so 584 descendants arrive as nodes and a small budget has to
#: stop somewhere in the middle of them.
BUDGET_BRANCH = 8
BUDGET_DEPTH = 3
BUDGET_DESCENDANTS = sum(BUDGET_BRANCH**n for n in range(1, BUDGET_DEPTH + 1))


@dataclass(frozen=True)
class FixtureIds:
    """The named landmarks a test needs to point at.

    Every field defaults to empty so the small fixture can name only the
    handful it has; :func:`build_fixture_library` fills every one, and an
    empty string in a failing assertion means the builder missed it.
    """

    hub: str = ""
    hub_parent: str = ""
    hub_children: tuple[str, ...] = ()
    deep_root: str = ""
    deep_tip: str = ""
    deep_deepest_leaf: str = ""
    mashup: str = ""
    mashup_parent_a: str = ""
    mashup_parent_b: str = ""
    mashup_grandparent_a: str = ""
    mashup_grandparent_b: str = ""
    mashup_popular_source: str = ""
    duplicate_child: str = ""
    duplicate_parent: str = ""
    cycle_a: str = ""
    cycle_b: str = ""
    dangling_song: str = ""
    dangling_source: str = ""
    dangling_child: str = ""
    artifact_song: str = ""
    artifact_ids: tuple[str, ...] = ()
    standalone: tuple[str, ...] = ()
    local_stem_parent: str = ""
    local_stem_id: str = ""
    promoted_stem_child: str = ""
    promoted_stem_parent: str = ""
    recent_parent: str = ""
    recent_child: str = ""
    weld_first_root: str = ""
    weld_second_root: str = ""
    unknown_child: str = ""
    unknown_parent: str = ""
    unknown_grandparent: str = ""
    threshold_exact: str = ""
    threshold_over: str = ""
    budget_root: str = ""


@dataclass
class FixtureLibrary:
    """A built database plus the numbers the tests assert against."""

    db: LibraryDB
    path: Path
    ids: FixtureIds
    expected: dict[str, Any] = field(default_factory=dict)

    def close(self) -> None:
        self.db.close()


def _pad() -> dict[str, Any]:
    return {"pad": "p" * METADATA_PAD_BYTES}


class _Builder:
    """Accumulates entry payloads and edges, then writes them once."""

    def __init__(self) -> None:
        self.entries: list[dict[str, Any]] = []
        self.edges: list[tuple[str, str, str]] = []
        self._created: dict[str, float] = {}

    def song(self, entry_id: str, *, model: str = "synthetic-a") -> str:
        index = len(self.entries)
        self.entries.append(
            {
                "id": entry_id,
                "kind": "audio",
                "title": f"fixture track {index:06d}",
                "model": model,
                "duration": 30.0 + (index % 90),
                "source": "generate",
                "metadata_json": _pad(),
            }
        )
        self._created[entry_id] = BASE_CREATED_AT + index
        return entry_id

    def link(self, from_id: str, to_id: str, kind: str) -> None:
        self.edges.append((from_id, to_id, kind))

    def derived(self, child: str, parent: str, kind: str = "derived_from") -> None:
        """A promoted lineage row: from_id is the derived song."""
        self.link(child, parent, kind)

    def created_at(self) -> dict[str, float]:
        return dict(self._created)


def _build_weld(b: _Builder) -> tuple[str, str]:
    """500 tiny ancestry islands, chained into one component by ``uses``."""
    roots: list[str] = []
    for island in range(WELD_ISLANDS):
        root = b.song(f"weld-{island:04d}-root")
        roots.append(root)
        for member in range(WELD_ISLAND_SIZE - 1):
            child = b.song(f"weld-{island:04d}-m{member:03d}")
            b.derived(child, root, "edit_of")
    for island in range(1, WELD_ISLANDS):
        # This island's root is a mashup that uses the previous island's
        # root. No new songs, no ancestry -- pure welding.
        b.link(roots[island], roots[island - 1], "mashup_source")
    return roots[0], roots[1]


def _build_deep(b: _Builder) -> tuple[str, str, str]:
    """A 2,000-generation spine with leaves every hundredth node."""
    root = b.song("deep-0000")
    previous = root
    deepest_leaf = ""
    for step in range(1, DEEP_SPINE):
        node = b.song(f"deep-{step:04d}")
        b.derived(node, previous, "derived_from")
        previous = node
        if step % DEEP_LEAF_EVERY == 0:
            for leaf_index in range(DEEP_LEAVES_PER_NODE):
                leaf = b.song(f"deep-{step:04d}-leaf{leaf_index}")
                b.derived(leaf, node, "cover_of")
                deepest_leaf = leaf
    tip = previous
    # One leaf on the very last spine node, so the deepest chain in the
    # library ends somewhere with exactly one right answer.
    final_leaf = b.song("deep-tip-leaf")
    b.derived(final_leaf, tip, "cover_of")
    deepest_leaf = final_leaf
    return root, tip, deepest_leaf


def _build_hub(b: _Builder) -> tuple[str, str, tuple[str, ...]]:
    """One song with 800 children of three kinds, and a parent of its own."""
    parent = b.song("hub-parent")
    hub = b.song("hub-song")
    b.derived(hub, parent, "derived_from")
    children: list[str] = []
    index = 0
    for kind, count in HUB_KIND_SPLIT:
        for _ in range(count):
            child = b.song(f"hub-child-{index:04d}")
            b.derived(child, hub, kind)
            children.append(child)
            index += 1
    return hub, parent, tuple(children)


def _build_mashup(b: _Builder) -> tuple[str, str, str, str, str, str]:
    """A mashup with two parents, each with an ancestry line behind it."""
    branches: list[tuple[str, str]] = []
    for name in ("a", "b"):
        previous = b.song(f"mash-{name}-anc{MASHUP_BRANCH_SIZE - 1:02d}")
        oldest = previous
        for step in range(MASHUP_BRANCH_SIZE - 2, -1, -1):
            node = b.song(f"mash-{name}-anc{step:02d}")
            b.derived(node, previous, "edit_of")
            previous = node
        branches.append((previous, oldest))
    mashup = b.song("mash-product")
    for head, _oldest in branches:
        b.link(mashup, head, "mashup_source")

    # One source that a great many mashups reach for.
    popular = b.song("mash-popular-source")
    for index in range(MASHUP_POPULAR_USERS):
        product = b.song(f"mash-user-{index:03d}")
        b.link(product, popular, "mashup_source")
    return (
        mashup,
        branches[0][0],
        branches[1][0],
        branches[0][1],
        branches[1][1],
        popular,
    )


def _build_oddities(b: _Builder) -> dict[str, Any]:
    out: dict[str, Any] = {}

    # The same pair, three times over, exactly as the real library stores a
    # promoted stem.
    dup_parent = b.song("dup-parent")
    dup_child = b.song("dup-child")
    for kind in ("derived_from", "edit_of", "stem_of"):
        b.derived(dup_child, dup_parent, kind)
    out["duplicate_parent"] = dup_parent
    out["duplicate_child"] = dup_child

    # A 2-cycle: each is a cover of the other.
    cycle_a = b.song("cycle-a")
    cycle_b = b.song("cycle-b")
    b.derived(cycle_a, cycle_b, "cover_of")
    b.derived(cycle_b, cycle_a, "cover_of")
    out["cycle_a"] = cycle_a
    out["cycle_b"] = cycle_b

    # Endpoints with no ``entries`` row, on both sides.
    dangling_song = b.song("dangle-song")
    dangling_source = "dangle-ghost-source"
    dangling_child = "dangle-ghost-child"
    b.derived(dangling_song, dangling_source, "derived_from")
    b.derived(dangling_child, dangling_song, "cover_of")
    out["dangling_song"] = dangling_song
    out["dangling_source"] = dangling_source
    out["dangling_child"] = dangling_child

    # Artifacts: files, not songs. The writers point from the song to the
    # file, the opposite of promoted lineage.
    artifact_song = b.song("artifact-song")
    midi_id = f"{artifact_song}__full_midi"
    score_id = "artifact-score-0000"
    chords_id = "artifact-chords-0000"
    b.link(artifact_song, midi_id, "midi_of")
    b.link(artifact_song, score_id, "rendered_as_notation")
    b.link(artifact_song, chords_id, "charted_as_chords")
    out["artifact_song"] = artifact_song
    out["artifact_ids"] = (midi_id, score_id, chords_id)

    # stem_of, both ways round. The local separator writes
    # (parent, f"{parent}__{name}"); the promoted writer writes
    # (child, parent).
    local_parent = b.song("localstem-parent")
    local_stem = f"{local_parent}__vocals"
    b.link(local_parent, local_stem, "stem_of")
    promoted_parent = b.song("promstem-parent")
    promoted_child = b.song("promstem-child")
    b.derived(promoted_child, promoted_parent, "stem_of")
    out["local_stem_parent"] = local_parent
    out["local_stem_id"] = local_stem
    out["promoted_stem_parent"] = promoted_parent
    out["promoted_stem_child"] = promoted_child

    # A kind the role table has never heard of, with a real ancestry line
    # behind its parent that must stay out of sight.
    unknown_grandparent = b.song("unknown-grandparent")
    unknown_parent = b.song("unknown-parent")
    unknown_child = b.song("unknown-child")
    b.derived(unknown_parent, unknown_grandparent, "derived_from")
    b.link(unknown_child, unknown_parent, UNKNOWN_KIND)
    out["unknown_grandparent"] = unknown_grandparent
    out["unknown_parent"] = unknown_parent
    out["unknown_child"] = unknown_child

    # Either side of the grouping threshold.
    threshold_exact = b.song("threshold-exact")
    for index in range(THRESHOLD_EXACT_CHILDREN):
        b.derived(b.song(f"threshold-exact-c{index:02d}"), threshold_exact, "cover_of")
    threshold_over = b.song("threshold-over")
    for index in range(THRESHOLD_OVER_CHILDREN):
        b.derived(b.song(f"threshold-over-c{index:02d}"), threshold_over, "cover_of")
    out["threshold_exact"] = threshold_exact
    out["threshold_over"] = threshold_over

    budget_root = b.song("budget-root")
    level = [budget_root]
    for tier in range(BUDGET_DEPTH):
        nxt: list[str] = []
        for parent_index, parent in enumerate(level):
            for branch in range(BUDGET_BRANCH):
                child = b.song(f"budget-t{tier}-{parent_index:03d}-{branch}")
                b.derived(child, parent, "cover_of")
                nxt.append(child)
        level = nxt
    out["budget_root"] = budget_root

    out["standalone"] = tuple(b.song(f"solo-{i:04d}") for i in range(STANDALONE_SONGS))

    # Written last, so its child holds the newest ``created_at`` in the
    # library and "most recently extended" has one unambiguous winner.
    recent_parent = b.song("recent-parent")
    recent_child = b.song("recent-child")
    b.derived(recent_child, recent_parent, "edit_of")
    out["recent_parent"] = recent_parent
    out["recent_child"] = recent_child
    return out


def build_fixture_library(path: Path) -> FixtureLibrary:
    """Write the whole synthetic library at ``path`` and return it."""
    b = _Builder()
    weld_first, weld_second = _build_weld(b)
    deep_root, deep_tip, deep_leaf = _build_deep(b)
    hub, hub_parent, hub_children = _build_hub(b)
    mashup, parent_a, parent_b, grand_a, grand_b, popular = _build_mashup(b)
    odd = _build_oddities(b)

    ids = FixtureIds(
        hub=hub,
        hub_parent=hub_parent,
        hub_children=hub_children,
        deep_root=deep_root,
        deep_tip=deep_tip,
        deep_deepest_leaf=deep_leaf,
        mashup=mashup,
        mashup_parent_a=parent_a,
        mashup_parent_b=parent_b,
        mashup_grandparent_a=grand_a,
        mashup_grandparent_b=grand_b,
        weld_first_root=weld_first,
        weld_second_root=weld_second,
        mashup_popular_source=popular,
        **odd,
    )

    db = _write(path, b)
    entries_total = len(b.entries)
    # Artifact links are not lineage: the song that has only a MIDI file and
    # a score is as standalone as one with no links at all.
    standalone = STANDALONE_SONGS + 1
    expected = {
        "entries": entries_total,
        "standalone": standalone,
        "with_lineage": entries_total - standalone,
        "links_raw": len(b.edges),
        "largest_connected": WELD_TOTAL,
        "largest_tree": DEEP_TOTAL + 1,
        "deep_total": DEEP_TOTAL + 1,
        "weld_total": WELD_TOTAL,
        "hub_children": HUB_CHILDREN,
        "deepest_depth": DEEP_SPINE,
        "popular_source_users": MASHUP_POPULAR_USERS,
        "budget_descendants": BUDGET_DESCENDANTS,
        "full_view_ok": False,
    }
    return FixtureLibrary(db=db, path=path, ids=ids, expected=expected)


def _write(path: Path, b: _Builder) -> LibraryDB:
    # FTS is a search accelerator this module never uses, and indexing 13,000
    # padded rows is most of the build time.
    db = LibraryDB(path, enable_fts=False)
    db.upsert_entries_bulk(b.entries, batch=500)
    db.add_relations_bulk(b.edges)
    _stamp_created_at(db, b.created_at())
    return db


def _stamp_created_at(db: LibraryDB, created: dict[str, float]) -> None:
    """Give every row a distinct, ordered ``created_at``.

    ``upsert_entries_bulk`` stamps one wall clock per batch, which makes
    "most recently extended" a coin toss. This is a fixture-building write on
    a synthetic temp database -- the module under test never writes anything.
    """
    conn = db._conn  # noqa: SLF001 - fixture setup, same convention as db.py
    with db._writelock:  # noqa: SLF001 - fixture setup
        cur = conn.cursor()
        try:
            cur.executemany(
                "UPDATE entries SET created_at = ? WHERE id = ?",
                [(ts, entry_id) for entry_id, ts in created.items()],
            )
            conn.commit()
        finally:
            cur.close()


def build_small_library(path: Path) -> FixtureLibrary:
    """A handful of songs: enough for ``full_view_ok`` to be true.

    The big fixture answers "what does this do at scale"; this one answers
    "what does it say about a library that is still small", which is the
    other half of ``/summary``.
    """
    b = _Builder()
    root = b.song("small-root")
    child = b.song("small-child")
    grandchild = b.song("small-grandchild")
    solo = b.song("small-solo")
    b.derived(child, root, "cover_of")
    b.derived(grandchild, child, "edit_of")
    db = _write(path, b)
    ids = FixtureIds(
        deep_root=root,
        deep_tip=grandchild,
        deep_deepest_leaf=grandchild,
        duplicate_child=child,
        duplicate_parent=root,
        standalone=(solo,),
        recent_parent=child,
        recent_child=grandchild,
    )
    return FixtureLibrary(
        db=db,
        path=path,
        ids=ids,
        expected={
            "entries": 4,
            "standalone": 1,
            "with_lineage": 3,
            "links_raw": 2,
            "largest_connected": 3,
            "largest_tree": 3,
            "full_view_ok": True,
        },
    )


class StubStore:
    """What ``get_store()`` returns, for a test that must never open the
    user's real library. The router only ever reads ``.db``."""

    def __init__(self, db: Optional[LibraryDB]) -> None:
        self.db = db


def link_rows(db: LibraryDB) -> Iterator[tuple[str, str, str]]:
    """Every ``(from_id, to_id, kind)`` in the fixture, for the pure tests."""
    conn = db._conn  # noqa: SLF001 - fixture read, same convention as db.py
    with db._writelock:  # noqa: SLF001 - fixture read
        cur = conn.cursor()
        try:
            for row in cur.execute(
                "SELECT from_id, to_id, kind FROM relations"
            ).fetchall():
                yield str(row["from_id"]), str(row["to_id"]), str(row["kind"])
        finally:
            cur.close()


def entry_rows(db: LibraryDB) -> Iterator[tuple[str, float]]:
    """Every ``(id, created_at)`` in the fixture, for the pure tests."""
    conn = db._conn  # noqa: SLF001 - fixture read, same convention as db.py
    with db._writelock:  # noqa: SLF001 - fixture read
        cur = conn.cursor()
        try:
            for row in cur.execute("SELECT id, created_at FROM entries").fetchall():
                yield str(row["id"]), float(row["created_at"] or 0.0)
        finally:
            cur.close()


def metadata_blob_size(db: LibraryDB, entry_id: str) -> int:
    """How fat one row's blob is -- so a test can prove the padding is real
    and that avoiding the column is worth something."""
    conn = db._conn  # noqa: SLF001 - fixture read
    with db._writelock:  # noqa: SLF001 - fixture read
        cur = conn.cursor()
        try:
            row = cur.execute(
                "SELECT metadata_json FROM entries WHERE id = ?", (entry_id,)
            ).fetchone()
        finally:
            cur.close()
    return len(row["metadata_json"]) if row else 0
