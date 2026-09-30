"""The whole-family lineage walk, ``GET /api/library/{id}/lineage/full``.

``/lineage`` stops at 600 nodes so one screen never draws an enormous family.
Save lineage used that same route, so a saved family was cut at 600 with no
word to the user. These tests replay that: the capped route cuts a family, and
the export route, asked over HTTP the way the app asks it, carries every
relative, with each edge once, in a document whose counts prove it arrived
whole.

The reference for "every relative" is main's own walk (851f6a0, the build
before the cap), copied below: the export must hold the family that build's
Save lineage wrote, edge rows whole (weight, metadata and time included).
"""

from __future__ import annotations

import json
import random
import threading
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.modules.library import router
from backend.modules.library.store import LibraryStore

WAV = b"RIFF\x00\x00\x00\x00WAVE"


def _store(tmp_path: Path) -> LibraryStore:
    store = LibraryStore(tmp_path)
    assert store.db is not None
    return store


def _client(monkeypatch: pytest.MonkeyPatch, store: LibraryStore) -> TestClient:
    monkeypatch.setattr(router, "_store", store)
    app = FastAPI()
    app.include_router(router.router, prefix="/api/library")
    return TestClient(app)


def _main_walk(store: LibraryStore, entry_id: str, depth: int) -> dict[str, Any]:
    """main's ``get_lineage`` at 851f6a0: every node to the depth, no cap."""
    seen_ids: set[str] = {entry_id}
    edges: list[dict[str, Any]] = []
    frontier = [entry_id]
    for _ in range(depth):
        next_frontier: list[str] = []
        for node_id in frontier:
            outgoing = store.db.list_relations(from_id=node_id)
            incoming = store.db.list_relations(to_id=node_id)
            for e in outgoing + incoming:
                edges.append(e)
                for nb in (e["from_id"], e["to_id"]):
                    if nb not in seen_ids:
                        seen_ids.add(nb)
                        next_frontier.append(nb)
        frontier = next_frontier
        if not frontier:
            break
    rows = {tuple(sorted(e.items())) for e in edges}
    return {"nodes": seen_ids, "edges": rows}


def _read_full(client: TestClient, entry_id: str, depth: int) -> dict[str, Any]:
    res = client.get(f"/api/library/{entry_id}/lineage/full", params={"depth": depth})
    assert res.status_code == 200, res.text
    assert res.headers["content-type"].startswith("application/json")
    return json.loads(res.text)


def test_save_lineage_route_carries_the_family_the_capped_route_cuts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """700 children and a grandchild: the screen route stops at 600, and says
    it was the cap that stopped it; the export route answers all 702."""
    store = _store(tmp_path)
    root = store.import_blob(WAV, "root.wav", "audio/wav", metadata={"title": "Root"})
    store.db.add_relations_bulk(
        (root.id, f"child-{i:04d}", "derived_from") for i in range(700)
    )
    store.db.add_relation(
        "child-0000", "grandchild", "inpaint", weight=0.25, metadata={"mask": [1, 3]}
    )
    client = _client(monkeypatch, store)

    capped = client.get(f"/api/library/{root.id}/lineage", params={"depth": 8}).json()
    assert len(capped["nodes"]) == router.LINEAGE_MAX_NODES
    assert capped["truncated"] is True
    assert capped["capped"] is True, (
        "the cap cut it, so the whole family can be asked for"
    )

    whole = _read_full(client, root.id, 8)
    ids = {n["id"] for n in whole["nodes"]}
    assert len(whole["nodes"]) == 702 == len(ids), "every relative, each once"
    assert "grandchild" in ids
    assert len(whole["edges"]) == 701
    assert whole["node_count"] == 702
    assert whole["edge_count"] == 701
    assert whole["truncated"] is False
    assert whole["capped"] is False
    assert whole["node_cap"] is None
    assert whole["root"] == root.id
    assert whole["depth"] == 8
    root_node = next(n for n in whole["nodes"] if n["id"] == root.id)
    assert root_node == {
        "id": root.id,
        "kind": "entry",
        "title": "Root",
        "source": root_node["source"],
        "duration_sec": root_node["duration_sec"],
    }
    assert next(n for n in whole["nodes"] if n["id"] == "grandchild") == {
        "id": "grandchild",
        "kind": "external",
    }
    # The saved edge is the whole relations row, as main's Save lineage wrote.
    inpaint = next(e for e in whole["edges"] if e["to_id"] == "grandchild")
    assert inpaint["from_id"] == "child-0000"
    assert inpaint["kind"] == "inpaint"
    assert inpaint["weight"] == 0.25
    assert json.loads(inpaint["metadata_json"]) == {"mask": [1, 3]}
    assert isinstance(inpaint["created_at"], float)
    assert isinstance(inpaint["id"], int)


def test_whole_family_matches_mains_walk(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """Random families with repeated inserts, self-loops, cycles and edges
    inside one generation: the export holds exactly main's nodes and edge rows,
    each once."""
    store = _store(tmp_path)
    rng = random.Random(207)
    ids = [f"n{i:03d}" for i in range(160)]
    rows: list[tuple[str, str, str]] = []
    for _ in range(420):
        a, b = rng.choice(ids), rng.choice(ids)
        rows.append(
            (a, b, rng.choice(("derived_from", "inpaint", "chimera_source_of")))
        )
    # Repeated inserts (the table's UNIQUE key keeps one row each) and
    # self-loops, whose one row a naive walk writes twice.
    rows.extend(rows[:40])
    rows.extend((i, i, "derived_from") for i in ids[:5])
    store.db.add_relations_bulk(rows)
    root = store.import_blob(WAV, "r.wav", "audio/wav", metadata={"title": "R"})
    store.db.add_relations_bulk(
        [(root.id, ids[0], "derived_from"), (ids[7], root.id, "inpaint")]
    )
    client = _client(monkeypatch, store)

    for depth in (0, 1, 2, 3, 5, 8):
        whole = _read_full(client, root.id, depth)
        want = _main_walk(store, root.id, depth)
        node_ids = [n["id"] for n in whole["nodes"]]
        edge_rows = [tuple(sorted(e.items())) for e in whole["edges"]]
        assert set(node_ids) == want["nodes"], f"depth {depth}: nodes differ from main"
        assert len(node_ids) == len(set(node_ids)), (
            f"depth {depth}: a node is listed twice"
        )
        assert set(edge_rows) == want["edges"], f"depth {depth}: edges differ from main"
        assert len(edge_rows) == len(set(edge_rows)), (
            f"depth {depth}: an edge is written twice"
        )
        assert whole["node_count"] == len(node_ids)
        assert whole["edge_count"] == len(edge_rows)


def test_a_hub_past_the_per_hop_read_bound_is_exported_whole(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """9,000 relatives on one hop: the screen route reads 4,000 at most, the
    export reads them all, a fetch at a time."""
    store = _store(tmp_path)
    hub = store.import_blob(WAV, "hub.wav", "audio/wav", metadata={"title": "Hub"})
    store.db.add_relations_bulk(
        (hub.id, f"r-{i:05d}", "derived_from") for i in range(4500)
    )
    store.db.add_relations_bulk((f"p-{i:05d}", hub.id, "inpaint") for i in range(4500))
    client = _client(monkeypatch, store)

    capped = client.get(f"/api/library/{hub.id}/lineage", params={"depth": 4}).json()
    assert capped["capped"] is True
    assert len(capped["nodes"]) <= router.LINEAGE_MAX_NODES

    whole = _read_full(client, hub.id, 4)
    assert whole["node_count"] == 9001 == len({n["id"] for n in whole["nodes"]})
    assert whole["edge_count"] == 9000 == len(whole["edges"])


def test_depth_still_bounds_the_export_and_it_says_so(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """A chain six long, walked two: the export stops where it was asked to and
    says there is more, the way the screen route does; walked to its end, it
    says nothing is left out. Depth-only cuts are not the cap's doing."""
    store = _store(tmp_path)
    root = store.import_blob(WAV, "a.wav", "audio/wav", metadata={"title": "A"})
    previous = root.id
    for i in range(6):
        store.db.add_relation(previous, f"chain-{i}", "derived_from")
        previous = f"chain-{i}"
    client = _client(monkeypatch, store)

    short = _read_full(client, root.id, 2)
    assert short["node_count"] == 3
    assert short["truncated"] is True
    exact = _read_full(client, root.id, 6)
    assert exact["node_count"] == 7
    assert exact["truncated"] is False, "the last generation lands on the last hop"
    deep = _read_full(client, root.id, 99)
    assert deep["depth"] == router.LINEAGE_MAX_DEPTH

    screen = client.get(f"/api/library/{root.id}/lineage", params={"depth": 2}).json()
    assert screen["truncated"] is True
    assert screen["capped"] is False, (
        "only the depth cut it; the whole family is no larger"
    )


def test_the_export_route_refuses_an_unknown_song(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    client = _client(monkeypatch, _store(tmp_path))
    res = client.get("/api/library/nope/lineage/full")
    assert res.status_code == 404
    assert "not found" in res.json()["detail"]


def test_the_walk_never_holds_the_library_lock_between_pieces(tmp_path: Path):
    """The export streams while other requests write the library. Between two
    pieces of the answer, another thread must be able to take the write lock."""
    store = _store(tmp_path)
    root = store.import_blob(WAV, "a.wav", "audio/wav", metadata={"title": "A"})
    # Two generations wide enough for several chunks of ids each.
    store.db.add_relations_bulk(
        (root.id, f"c-{i:04d}", "derived_from") for i in range(2000)
    )
    store.db.add_relations_bulk(
        (f"c-{i:04d}", f"g-{i:04d}", "derived_from") for i in range(2000)
    )

    pieces = router._lineage_full_chunks(store.db, root.id, 3)
    text: list[str] = []
    waits = 0
    for piece in pieces:
        text.append(piece)
        got: list[bool] = []

        def take() -> None:
            ok = store.db._writelock.acquire(timeout=2)
            got.append(ok)
            if ok:
                store.db._writelock.release()

        t = threading.Thread(target=take)
        t.start()
        t.join()
        assert got == [True], "the write lock was held across a yield"
        waits += 1
    assert waits > 3, "the answer arrives in pieces, not in one block"
    body = json.loads("".join(text))
    assert body["node_count"] == 4001
    assert body["edge_count"] == 4000
