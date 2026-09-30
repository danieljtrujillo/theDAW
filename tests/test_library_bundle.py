"""Unit tests for the library bundle builder + lineage graph BFS."""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path

from backend.modules.library.bundle import build_bundle_bytes
from backend.modules.library.store import LibraryStore


def _seed_with_extras(tmp_path: Path):
    """Seed a library, import an entry, add fake stems + midi rows."""
    store = LibraryStore(tmp_path)
    record = store.import_blob(
        audio_bytes=b"RIFF\x00\x00\x00\x00WAVEdata",
        filename="track.wav",
        mime_type="audio/wav",
        metadata={"title": "Bundle test", "prompt": "test"},
    )
    assert store.db is not None
    entry_dir = store._dir_for(record.id)
    assert entry_dir is not None

    # Fake stems on disk + in DB.
    stems_dir = entry_dir / "stems"
    stems_dir.mkdir()
    vocals = stems_dir / "vocals.wav"
    drums = stems_dir / "drums.wav"
    vocals.write_bytes(b"RIFF\x00\x00\x00\x00WAVEvocals")
    drums.write_bytes(b"RIFF\x00\x00\x00\x00WAVEdrums")
    store.db.add_stem(
        stem_id=f"{record.id}__vocals",
        entry_id=record.id,
        stem_name="vocals",
        audio_path=str(vocals),
        file_size_bytes=vocals.stat().st_size,
        model="demucs",
    )
    store.db.add_stem(
        stem_id=f"{record.id}__drums",
        entry_id=record.id,
        stem_name="drums",
        audio_path=str(drums),
        file_size_bytes=drums.stat().st_size,
        model="demucs",
    )

    # Fake midi on disk + in DB.
    midi_dir = entry_dir / "midi"
    midi_dir.mkdir()
    full_mid = midi_dir / "full.mid"
    full_mid.write_bytes(b"MThd\x00\x00\x00\x06\x00\x00")  # minimal MIDI header
    store.db.add_midi(
        midi_id=f"{record.id}__full",
        entry_id=record.id,
        source="full",
        midi_path=str(full_mid),
        engine="basic-pitch",
    )

    # An analysis row.
    store.db.upsert_analysis(
        record.id,
        {
            "bpm": 120.0,
            "key": "C",
            "scale": "major",
            "bars_estimated": 8.0,
        },
    )

    return store, record


def test_bundle_includes_audio_metadata_stems_midi_lineage_readme(tmp_path: Path):
    store, record = _seed_with_extras(tmp_path)
    entry_dir = store._dir_for(record.id)
    assert entry_dir is not None
    audio_path = store.get_audio_path(record.id)
    metadata_path = entry_dir / "metadata.json"

    analysis = store.db.get_analysis(record.id) if store.db else None
    stems = store.db.list_stems(record.id) if store.db else []
    midis = store.db.list_midis(record.id) if store.db else []
    edges = store.db.list_relations(from_id=record.id) if store.db else []

    data = build_bundle_bytes(
        entry_id=record.id,
        record=record.to_dict(),
        audio_path=audio_path,
        metadata_path=metadata_path,
        analysis=analysis,
        stems=stems,
        midis=midis,
        lineage_edges=edges,
    )

    zf = zipfile.ZipFile(io.BytesIO(data))
    names = set(zf.namelist())

    # Audio at the root.
    assert any(n.endswith(".wav") and "/" not in n for n in names)
    # Metadata, analysis, lineage, prompts, readme.
    assert "metadata.json" in names
    assert "analysis.json" in names
    assert "lineage.json" in names
    assert "prompts.txt" in names
    assert "README.txt" in names
    # Stems + midi nested under their dirs.
    assert "stems/vocals.wav" in names
    assert "stems/drums.wav" in names
    assert "midi/full.mid" in names

    # Sanity-check the analysis payload.
    payload = json.loads(zf.read("analysis.json"))
    assert payload["bpm"] == 120.0
    assert payload["key"] == "C"


def test_bundle_skips_missing_files(tmp_path: Path):
    """If a stem/midi row points to a missing file, we silently skip
    it rather than 500."""
    store = LibraryStore(tmp_path)
    record = store.import_blob(
        audio_bytes=b"RIFF\x00\x00\x00\x00WAVE",
        filename="x.wav",
        mime_type="audio/wav",
        metadata={"title": "Skips"},
    )
    assert store.db is not None
    store.db.add_stem(
        stem_id=f"{record.id}__ghost",
        entry_id=record.id,
        stem_name="ghost",
        audio_path=str(tmp_path / "does-not-exist.wav"),
    )

    data = build_bundle_bytes(
        entry_id=record.id,
        record=record.to_dict(),
        audio_path=store.get_audio_path(record.id),
        metadata_path=None,
        analysis=None,
        stems=store.db.list_stems(record.id),
        midis=[],
        lineage_edges=[],
    )
    zf = zipfile.ZipFile(io.BytesIO(data))
    names = set(zf.namelist())
    # The ghost stem isn't in the zip, but metadata.json (from record) is.
    assert "stems/ghost.wav" not in names
    assert "metadata.json" in names
    assert "README.txt" in names


def test_lineage_endpoint_walks_relations(tmp_path: Path):
    """Manually exercise the BFS by populating relations between three
    entries and checking that GET /lineage returns the expected
    nodes + edges shape."""
    store = LibraryStore(tmp_path)
    assert store.db is not None
    a = store.import_blob(
        b"RIFF\x00\x00\x00\x00WAVE", "a.wav", "audio/wav", metadata={"title": "A"}
    )
    b = store.import_blob(
        b"RIFF\x00\x00\x00\x00WAVE", "b.wav", "audio/wav", metadata={"title": "B"}
    )
    c = store.import_blob(
        b"RIFF\x00\x00\x00\x00WAVE", "c.wav", "audio/wav", metadata={"title": "C"}
    )
    # A is a chimera_source_of B; B is a chimera_source_of C.
    store.db.add_relation(a.id, b.id, "chimera_source_of")
    store.db.add_relation(b.id, c.id, "chimera_source_of")

    # Re-import the router function so we exercise the BFS directly.
    # (Bypass FastAPI to keep this a pure unit test.)
    from backend.modules.library import router

    router._store = store  # noqa: SLF001 — wire the store the router will pick up
    result = router.get_lineage(a.id, depth=3)
    deep = router.get_lineage(a.id, depth=4)
    router._store = None  # noqa: SLF001 — reset

    # The depth the per-track view actually asks for, on a family that fits:
    # the same three songs, and nothing claiming anything was left out.
    assert {n["id"] for n in deep["nodes"]} == {a.id, b.id, c.id}
    assert deep["truncated"] is False

    node_ids = {n["id"] for n in result["nodes"]}
    assert a.id in node_ids
    assert b.id in node_ids
    assert c.id in node_ids
    kinds = {e["kind"] for e in result["edges"]}
    assert kinds == {"chimera_source_of"}
    # A family this small is nowhere near the cap, so the answer is whole.
    assert result["truncated"] is False
    assert result["node_cap"] == router.LINEAGE_MAX_NODES


def test_full_graph_endpoint(tmp_path: Path):
    store = LibraryStore(tmp_path)
    assert store.db is not None
    a = store.import_blob(
        b"RIFF\x00\x00\x00\x00WAVE", "a.wav", "audio/wav", metadata={"title": "A"}
    )
    b = store.import_blob(
        b"RIFF\x00\x00\x00\x00WAVE", "b.wav", "audio/wav", metadata={"title": "B"}
    )
    store.db.add_relation(a.id, b.id, "derived_from")

    from backend.modules.library import router

    router._store = store  # noqa: SLF001
    result = router.get_full_graph()
    router._store = None  # noqa: SLF001
    assert result["count"] == 2
    assert len(result["edges"]) == 1


def test_lineage_endpoint_caps_a_huge_family(tmp_path: Path):
    """A hub with more relatives than can be drawn is cut, not shipped whole.

    The per-track BFS is the ONE lineage request that stays safe on a library
    too big for the whole-library graph, so it must be bounded in its own
    right: a node cap, the flag that says the answer was cut, and the cap it
    was cut at. What survives the cut is the root's OWN family first — the
    BFS admits a hop entirely before it looks at the next one, so nothing
    further away can take a place from an immediate neighbour."""
    store = LibraryStore(tmp_path)
    assert store.db is not None
    root = store.import_blob(
        b"RIFF\x00\x00\x00\x00WAVE", "root.wav", "audio/wav", metadata={"title": "R"}
    )
    # A star: 700 children off the root, and one grandchild two hops out.
    store.db.add_relations_bulk(
        (root.id, f"child-{i:04d}", "derived_from") for i in range(700)
    )
    store.db.add_relation("child-0000", "grandchild-far", "derived_from")

    from backend.modules.library import router

    # Every statement the walk issues, so the columns it reads are checked and
    # not assumed: a 600-node family must never open a blob column.
    statements: list[str] = []
    store.db._conn.set_trace_callback(statements.append)  # noqa: SLF001
    router._store = store  # noqa: SLF001 — wire the store the router will pick up
    try:
        result = router.get_lineage(root.id, depth=4)
    finally:
        router._store = None  # noqa: SLF001 — reset
        store.db._conn.set_trace_callback(None)  # noqa: SLF001

    entry_reads = [s for s in statements if "FROM entries" in s]
    assert entry_reads, "the walk does read the entries table"
    for sql in entry_reads:
        assert "metadata_json" not in sql, f"a blob column was opened: {sql}"
        assert "SELECT *" not in sql, f"the whole row was read: {sql}"
    assert len(entry_reads) < len(result["nodes"]), (
        "the nodes are read in bulk, not one statement per node"
    )

    assert result["node_cap"] == router.LINEAGE_MAX_NODES
    assert result["truncated"] is True
    assert len(result["nodes"]) == router.LINEAGE_MAX_NODES

    node_ids = {n["id"] for n in result["nodes"]}
    assert root.id in node_ids
    assert all(i.startswith("child-") for i in node_ids - {root.id}), (
        "the cut keeps the root's own children, not something further out"
    )
    assert "grandchild-far" not in node_ids

    # Nothing dangles: every surviving edge joins two surviving nodes.
    for edge in result["edges"]:
        assert edge["from_id"] in node_ids
        assert edge["to_id"] in node_ids


def test_lineage_endpoint_bounds_the_work_one_hop_can_do(tmp_path: Path):
    """A hub with 9,000 relatives is READ within a bound, not read whole.

    The node cap alone bounds the ANSWER, not the work: walking a hub by
    asking for its relations a node at a time and materialising every row
    builds tens of thousands of dicts before the cap refuses the 601st node,
    and the user has an 81,000-song welded component. So each hop reads its
    relations in one bounded, projected statement, and a hop that fills that
    bound says the answer was cut."""
    store = LibraryStore(tmp_path)
    assert store.db is not None
    root = store.import_blob(
        b"RIFF\x00\x00\x00\x00WAVE", "hub.wav", "audio/wav", metadata={"title": "Hub"}
    )
    store.db.add_relations_bulk(
        (root.id, f"r-{i:05d}", "derived_from") for i in range(9000)
    )

    from backend.modules.library import router

    statements: list[str] = []
    store.db._conn.set_trace_callback(statements.append)  # noqa: SLF001
    router._store = store  # noqa: SLF001
    try:
        result = router.get_lineage(root.id, depth=4)
    finally:
        router._store = None  # noqa: SLF001
        store.db._conn.set_trace_callback(None)  # noqa: SLF001

    assert result["truncated"] is True
    assert len(result["nodes"]) <= router.LINEAGE_MAX_NODES
    assert len(result["edges"]) <= router.LINEAGE_MAX_EDGES_PER_HOP

    relation_reads = [s for s in statements if "FROM relations" in s]
    assert relation_reads, "the walk does read the relations table"
    for sql in relation_reads:
        assert "SELECT *" not in sql, f"the whole row was read: {sql}"
        assert "metadata_json" not in sql, f"a blob column was opened: {sql}"
        assert "LIMIT" in sql, f"the read is unbounded: {sql}"
    assert len(relation_reads) <= 4, (
        f"one bounded read per hop, not one per node: {len(relation_reads)}"
    )


def test_lineage_endpoint_says_so_when_the_depth_ran_out(tmp_path: Path):
    """Relatives left unwalked because the DEPTH ended are left out too.

    ``truncated`` is the answer's one word for "there is more of this family
    than you are looking at", so it cannot mean only "a cap bit"."""
    store = LibraryStore(tmp_path)
    assert store.db is not None
    root = store.import_blob(
        b"RIFF\x00\x00\x00\x00WAVE", "a.wav", "audio/wav", metadata={"title": "A"}
    )
    # A chain five hops long, walked two.
    previous = root.id
    for i in range(5):
        nxt = f"chain-{i}"
        store.db.add_relation(previous, nxt, "derived_from")
        previous = nxt

    from backend.modules.library import router

    router._store = store  # noqa: SLF001
    try:
        shallow = router.get_lineage(root.id, depth=2)
        whole = router.get_lineage(root.id, depth=9)
    finally:
        router._store = None  # noqa: SLF001

    assert len(shallow["nodes"]) == 3, "the root and two hops of it"
    assert shallow["truncated"] is True, "and the chain goes on past them"
    assert len(whole["nodes"]) == 6
    assert whole["truncated"] is False, "walked to its end, nothing left out"


def test_lineage_endpoint_asks_before_it_claims_the_family_was_cut(tmp_path: Path):
    """ "There is more" is a question about the graph, not about the walk.

    A family whose last generation lands exactly on the final hop leaves the
    walk holding a frontier and NOTHING beyond it; reading that frontier as
    "cut" tells the user part of their family is hidden when all of it is on
    screen."""
    store = LibraryStore(tmp_path)
    assert store.db is not None
    root = store.import_blob(
        b"RIFF\x00\x00\x00\x00WAVE", "a.wav", "audio/wav", metadata={"title": "A"}
    )
    lonely = store.import_blob(
        b"RIFF\x00\x00\x00\x00WAVE", "b.wav", "audio/wav", metadata={"title": "B"}
    )
    previous = root.id
    for i in range(3):
        nxt = f"gen-{i}"
        store.db.add_relation(previous, nxt, "derived_from")
        previous = nxt

    from backend.modules.library import router

    router._store = store  # noqa: SLF001
    try:
        exact = router.get_lineage(root.id, depth=3)
        short = router.get_lineage(root.id, depth=2)
        none_asked = router.get_lineage(root.id, depth=0)
        alone = router.get_lineage(lonely.id, depth=0)
    finally:
        router._store = None  # noqa: SLF001

    assert len(exact["nodes"]) == 4
    assert exact["truncated"] is False, (
        "the last generation lands on the last hop — the family is whole"
    )
    assert short["truncated"] is True, "one hop shorter, and it is not"
    assert none_asked["truncated"] is True, "no hops at all leaves the family out"
    assert alone["truncated"] is False, "but a song with no relations has none to leave"


def test_lineage_relation_rows_chunks_and_never_pays_twice(tmp_path: Path):
    """A frontier wider than one statement, and edges that span two chunks.

    Each id is listed once per chunk, so a relation between ids in different
    chunks comes back from both reads — and once the two directions are read
    separately, an edge between two frontier ids comes back from both of
    those too. Counting a repeat against the hop's budget would spend it on
    rows the answer already holds."""
    store = LibraryStore(tmp_path)
    assert store.db is not None
    ids = [f"wide-{i:04d}" for i in range(500)]
    # Every edge joins the first half to the second, so no chunking of this
    # frontier can put both ends of an edge in the same read.
    pairs = [(ids[i], ids[i + 250]) for i in range(250)]
    store.db.add_relations_bulk((f, t, "derived_from") for f, t in pairs)

    from backend.modules.library import router

    # Room for every edge in BOTH direction budgets, so nothing here is about
    # the budget running out — only about what repeats cost.
    rows, cut = router._lineage_relation_rows(  # noqa: SLF001
        store.db, ids, 2 * len(pairs) + 2
    )
    keys = [(r["from_id"], r["to_id"], r["kind"]) for r in rows]
    assert len(keys) == len(set(keys)), (
        f"a row is returned once, however often it is read: {len(keys)} rows, "
        f"{len(set(keys))} distinct"
    )
    assert len(rows) == len(pairs), (
        f"and every distinct edge is there: expected {len(pairs)}, got {len(rows)}"
    )
    assert cut is False, "with nothing left out"


def test_lineage_relation_rows_keeps_both_directions_when_it_is_cut(tmp_path: Path):
    """A hub cut by the budget keeps its sources AND its derivatives.

    Spending the hop's whole budget on whichever direction is read first
    hands back a hub with 4,000 parents and no children — a picture of the
    read order, not of the song."""
    store = LibraryStore(tmp_path)
    assert store.db is not None
    hub = "welded-hub"
    store.db.add_relations_bulk(
        (hub, f"out-{i:05d}", "derived_from") for i in range(3000)
    )
    store.db.add_relations_bulk(
        (f"in-{i:05d}", hub, "derived_from") for i in range(3000)
    )

    from backend.modules.library import router

    rows, cut = router._lineage_relation_rows(  # noqa: SLF001
        store.db, [hub], router.LINEAGE_MAX_EDGES_PER_HOP
    )
    assert cut is True, "6,000 relations do not fit in the hop's budget"
    assert len(rows) <= router.LINEAGE_MAX_EDGES_PER_HOP
    outgoing = [r for r in rows if r["from_id"] == hub]
    incoming = [r for r in rows if r["to_id"] == hub]
    assert outgoing, "the derivatives survive the cut"
    assert incoming, "and so do the sources"


def _repeats_fixture(tmp_path: Path) -> tuple[LibraryStore, list[str], int]:
    """A frontier whose second direction re-reads what the first already took.

    Two edges have BOTH ends in the frontier, so the second direction reads
    them again and keeps nothing. Three more are visible only to the second
    direction, and spend its budget down before the page of repeats is read —
    which is how that page can be made full, or not, by the budget alone."""
    store = LibraryStore(tmp_path)
    assert store.db is not None
    ids = [f"wide-{i:04d}" for i in range(500)]
    repeats = [(ids[0], ids[449]), (ids[1], ids[450])]
    fresh = [(f"ext-{i}", ids[i]) for i in range(3)]
    store.db.add_relations_bulk((f, t, "derived_from") for f, t in [*repeats, *fresh])
    return store, ids, len(repeats) + len(fresh)


def test_lineage_relation_rows_a_full_page_of_repeats_is_still_a_cut(tmp_path: Path):
    """A page that came back FULL was stopped, repeats or not.

    The budget is spent only on distinct edges — but "was this read stopped
    short" is a question about the read, and a full page has rows behind it
    that were never looked at. That those in hand happened to be repeats says
    nothing about the ones that were not read. Reporting a cut that turns out
    to have lost nothing costs one honest sentence on screen; reporting a
    family whole when rows were never read is the answer that misleads, so
    the raw page is what decides it."""
    store, ids, distinct = _repeats_fixture(tmp_path)

    from backend.modules.library import router

    # A budget that leaves room for exactly one more row when the repeats are
    # read: the page comes back full.
    rows, cut = router._lineage_relation_rows(store.db, ids, 8)  # noqa: SLF001
    keys = {(r["from_id"], r["to_id"], r["kind"]) for r in rows}
    assert len(keys) == distinct == len(rows), "every distinct edge is still returned"
    assert cut is True, "and the read that stopped is reported as one"


def test_lineage_relation_rows_a_short_page_of_repeats_is_not_a_cut(tmp_path: Path):
    """The same repeats, read with room to spare, are no cut at all.

    The safe answer above is not a blanket "repeats mean cut": a page that
    came back shorter than its limit is the end of what there was to read,
    and the answer says so."""
    store, ids, distinct = _repeats_fixture(tmp_path)

    from backend.modules.library import router

    # Two more of budget, so the page of repeats comes back short of its limit.
    rows, cut = router._lineage_relation_rows(store.db, ids, 10)  # noqa: SLF001
    keys = {(r["from_id"], r["to_id"], r["kind"]) for r in rows}
    assert len(keys) == distinct == len(rows)
    assert cut is False, "nothing was left unread, so nothing is claimed to be"


def test_lineage_endpoint_says_unknown_is_more(tmp_path: Path):
    """A probe that filled its page says "more", even seeing nothing new.

    The probe reads the frontier's relations to answer "is there family past
    this?". When its page fills, the rows past it were never looked at, so a
    page carrying only already-seen songs settles nothing — and between
    claiming a family is whole and admitting it might not be, the answer that
    cannot mislead is the second."""
    store = LibraryStore(tmp_path)
    assert store.db is not None
    root = store.import_blob(
        b"RIFF\x00\x00\x00\x00WAVE", "r.wav", "audio/wav", metadata={"title": "R"}
    )
    store.db.add_relation(root.id, "near-a", "derived_from")
    store.db.add_relation(root.id, "near-b", "derived_from")
    # Far more relations between those two than one probe can read, and not
    # one of them reaches a song the walk has not already got.
    store.db.add_relations_bulk(
        ("near-a", "near-b", f"kind-{i:05d}") for i in range(4100)
    )

    from backend.modules.library import router

    router._store = store  # noqa: SLF001
    try:
        result = router.get_lineage(root.id, depth=1)
    finally:
        router._store = None  # noqa: SLF001

    assert {n["id"] for n in result["nodes"]} == {root.id, "near-a", "near-b"}
    assert result["truncated"] is True, (
        "the probe could not read to the end, so 'whole' is not something to claim"
    )


def test_lineage_relation_read_uses_the_index_and_never_sorts(tmp_path: Path):
    """The read the walk actually issues, as SQLite plans it.

    ``relations.id`` is the rowid, and the ``IN`` is served by
    ``idx_relations_from`` / ``idx_relations_to``. Asking for ``ORDER BY id``
    on top of that makes SQLite visit every matching index entry and sort
    them before the ``LIMIT`` can bite, which on a hub is the whole degree —
    exactly the cost the per-hop bound exists to avoid. This pins the plan of
    the shipped statement, and shows what the dropped clause would have
    cost."""
    store = LibraryStore(tmp_path)
    assert store.db is not None
    store.db.add_relations_bulk(
        ("hub", f"child-{i:05d}", "derived_from") for i in range(3000)
    )
    store.db.add_relations_bulk(
        (f"src-{i:05d}", "hub", "derived_from") for i in range(3000)
    )

    from backend.modules.library import router

    marks = ", ".join("?" * 3)
    params = ["hub", "a", "b", 4000]
    cur = store.db._conn.cursor()  # noqa: SLF001
    try:
        for column in ("from_id", "to_id"):
            shipped = (
                f"SELECT {router._LINEAGE_EDGE_SELECT} FROM relations "  # noqa: SLF001
                f"WHERE {column} IN ({marks}) LIMIT ?"
            )
            plan = [
                row["detail"]
                for row in cur.execute(
                    "EXPLAIN QUERY PLAN " + shipped, params
                ).fetchall()
            ]
            print(f"[{column}] shipped: {plan}")
            assert any("INDEX" in line for line in plan), (
                f"the read must be served by an index, not a scan: {plan}"
            )
            assert not any(line.startswith("SCAN relations") for line in plan), (
                f"and never by a table scan: {plan}"
            )
            assert not any("TEMP B-TREE" in line for line in plan), (
                f"and must not sort before the LIMIT: {plan}"
            )

            sorted_form = (
                f"SELECT {router._LINEAGE_EDGE_SELECT} FROM relations "  # noqa: SLF001
                f"WHERE {column} IN ({marks}) ORDER BY id LIMIT ?"
            )
            sorted_plan = [
                row["detail"]
                for row in cur.execute(
                    "EXPLAIN QUERY PLAN " + sorted_form, params
                ).fetchall()
            ]
            print(f"[{column}] with ORDER BY id: {sorted_plan}")
            assert any("TEMP B-TREE" in line for line in sorted_plan), (
                f"ORDER BY id is what adds the sort — if this ever stops being "
                f"true the clause can come back: {sorted_plan}"
            )
    finally:
        cur.close()
