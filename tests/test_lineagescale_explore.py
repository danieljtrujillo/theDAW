"""Tests for ``backend.modules.lineagescale.explore`` -- the LEARN explorer.

Every number the landing page shows is a list you can open, and these are the
routes behind those lists. Everything runs against a synthetic library built
here, through the real :class:`~backend.modules.library.db.LibraryDB` schema.
Nothing opens the user's library, starts a server or binds a port.

NOTHING HERE MAY REACH THE USER'S LIBRARY. The routes resolve the store
through ``lineage_router.get_library_store``, which every test replaces with a
stub over the fixture database -- but a name bound at import time slips past
that, and one did: ``explore.warm_explore_cache`` captured
``get_library_store`` on import and a test of the warm therefore ran a full
pass over the real library. Two tripwires make that unrepeatable, on EVERY test
in this file (``_no_real_library``): the app's cached ``LibraryStore`` is
replaced with one that raises on any use, and ``default_library_root`` -- the
only thing that names the user's directory -- is replaced with a function that
raises. An escape is now a loud failure instead of a 200,000-song read.

The load-bearing assertion in this file is not a row count: it is that the
explorer's populations ARE the summary's populations. ``/summary`` says 8,595
songs are in the largest family and N are standalone; a list that opens off
those numbers and shows a different set of songs is a worse lie than showing
no list at all. So the family sizes are checked against ``largest_tree`` and
the ``set=`` populations against ``with_lineage`` / ``standalone``, computed by
the code that already answers ``/summary``.
"""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.modules.library import router as library_router, store as library_store
from backend.modules.library.db import LibraryDB
from backend.modules.lineagescale import explore, router as lineage_router
from backend.modules.lineagescale.graph import KIND_ORDER
from tests.lineagescale_fixtures import StubStore

PREFIX = "/api/lineage-scale"
EXPLORE = f"{PREFIX}/explore"

#: One family of four, one of two, one written by the OTHER writer's
#: direction, three songs with no lineage at all, one mashup welding two
#: families into a cluster that is not a family, plus the endpoints that have
#: no ``entries`` row (a stem, a MIDI file).
FAMILY_A = ("a0", "a1", "a2", "a3")
FAMILY_B = ("b0", "b1")
FAMILY_C = ("c0", "c1")
STANDALONE = ("s0", "s1", "s2")
MASHUP = "m0"

ENTRY_IDS = (*FAMILY_A, *FAMILY_B, *FAMILY_C, MASHUP, *STANDALONE)

TITLES = {
    "a0": "Alpha root",
    "a1": "Alpha cover",
    "a2": "Alpha edit",
    "a3": "Alpha branch",
    "b0": "Beta root",
    "b1": "Beta cover",
    "c0": "Gamma root",
    "c1": "Gamma poller child",
    "m0": "Mashup of alpha and beta",
    "s0": "Solo one",
    "s1": "Solo two",
    "s2": "Alpha lookalike with no lineage",
}

#: ``(from_id, to_id, kind)`` exactly as a writer would store it.
LINKS = (
    # Promoted lineage: from_id is the derived song.
    ("a1", "a0", "cover_of"),
    ("a2", "a1", "edit_of"),
    ("a3", "a0", "derived_from"),
    ("b1", "b0", "cover_of"),
    # The Suno poller's bare kind points the OTHER way: from_id is the source.
    ("c0", "c1", "cover"),
    # A mashup uses one song from each family: a cluster, not a family.
    ("m0", "a0", "mashup_source"),
    ("m0", "b0", "mashup_source"),
    # An artifact link -- never lineage, never a node.
    ("a0", "a0.mid", "midi_of"),
    # A locally separated stem: from_id is the SOURCE for this one row.
    ("a1", "a1__vocals", "stem_of"),
)


@pytest.fixture(scope="module")
def library(tmp_path_factory: pytest.TempPathFactory) -> Iterator[LibraryDB]:
    path: Path = tmp_path_factory.mktemp("lineagescale-explore") / "library.db"
    db = LibraryDB(path, enable_fts=False)
    db.upsert_entries_bulk(
        [
            {
                "id": entry_id,
                "kind": "audio",
                "title": TITLES[entry_id],
                "model": "synthetic-a",
                "source": "generate",
                "duration": 30.0 + index,
            }
            for index, entry_id in enumerate(ENTRY_IDS)
        ],
        batch=50,
    )
    db.add_relations_bulk(list(LINKS))
    conn = db._conn  # noqa: SLF001 - fixture setup, the convention db.py uses
    with db._writelock:  # noqa: SLF001 - fixture setup
        cur = conn.cursor()
        try:
            cur.executemany(
                "UPDATE entries SET created_at = ?, play_count = ? WHERE id = ?",
                [
                    (1_700_000_000.0 + index, index, entry_id)
                    for index, entry_id in enumerate(ENTRY_IDS)
                ],
            )
            conn.commit()
        finally:
            cur.close()
    yield db
    db.close()


class _PoisonStore:
    """What ``library_router.get_store()`` returns while these tests run.

    Any code path that reaches the app's own store instead of the fixture's --
    a stale import-time binding, a forgotten monkeypatch -- touches this and
    fails, instead of quietly opening the user's 200,000-song library.
    """

    used = False

    def __getattr__(self, name: str) -> Any:
        type(self).used = True
        raise AssertionError(
            f"a lineagescale explore test reached the app's LibraryStore ({name!r}); "
            "it must go through the fixture's stub"
        )


@pytest.fixture(autouse=True)
def _no_real_library(monkeypatch: pytest.MonkeyPatch) -> Iterator[_PoisonStore]:
    """The user's library is unreachable for the length of every test here."""

    def _explode(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError(
            "default_library_root() was consulted: something is about to open "
            "the user's real library"
        )

    poison = _PoisonStore()
    _PoisonStore.used = False
    monkeypatch.setattr(library_router, "_store", poison)
    monkeypatch.setattr(library_store, "default_library_root", _explode)
    monkeypatch.setattr(library_router, "default_library_root", _explode, raising=False)
    yield poison


@pytest.fixture(autouse=True)
def _clear_caches() -> Iterator[None]:
    lineage_router._stats_cache.clear()
    explore.clear_caches()
    yield
    lineage_router._stats_cache.clear()
    explore.clear_caches()


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch, library: LibraryDB) -> TestClient:
    store = StubStore(library)
    monkeypatch.setattr(lineage_router, "get_library_store", lambda: store)
    app = FastAPI()
    app.include_router(lineage_router.router, prefix=PREFIX)
    return TestClient(app)


@contextmanager
def _traced(monkeypatch: pytest.MonkeyPatch, library: LibraryDB) -> Iterator[list[str]]:
    """Every statement every connection this module opens issues.

    The same shape as ``tests/test_lineagescale.py::_traced`` -- the explorer
    reads on the module's own read-only connection, so watching only the app's
    connection would watch an empty room.
    """
    statements: list[str] = []
    real_connect = sqlite3.connect

    def traced_connect(*args: Any, **kwargs: Any) -> sqlite3.Connection:
        conn = real_connect(*args, **kwargs)
        conn.set_trace_callback(statements.append)
        return conn

    monkeypatch.setattr(sqlite3, "connect", traced_connect)
    shared = library._conn  # noqa: SLF001 - the fixture's own connection
    shared.set_trace_callback(statements.append)
    try:
        yield statements
    finally:
        shared.set_trace_callback(None)


def _summary(client: TestClient) -> dict[str, Any]:
    res = client.get(f"{PREFIX}/summary")
    assert res.status_code == 200
    return res.json()


def _ids(body: dict[str, Any]) -> list[str]:
    return [row["id"] for row in body["rows"]]


# ------------------------------------------------------------------- songs


def test_songs_populations_are_the_summary_populations(client: TestClient) -> None:
    """The two numbers on the landing page open the two lists they count."""
    summary = _summary(client)

    linked = client.get(f"{EXPLORE}/songs", params={"set": "with_lineage", "limit": 50})
    standalone = client.get(
        f"{EXPLORE}/songs", params={"set": "standalone", "limit": 50}
    )
    assert linked.status_code == 200
    assert standalone.status_code == 200

    assert linked.json()["total"] == summary["with_lineage"]
    assert standalone.json()["total"] == summary["standalone"]
    assert sorted(_ids(standalone.json())) == sorted(STANDALONE)
    assert set(_ids(linked.json())) == set(ENTRY_IDS) - set(STANDALONE)


def test_songs_rows_carry_the_badge_columns_and_the_link_count(
    client: TestClient,
) -> None:
    body = client.get(
        f"{EXPLORE}/songs",
        params={"set": "with_lineage", "sort": "links", "dir": "desc"},
    ).json()
    first = body["rows"][0]
    # `source` travels with `model` or the badge lies about a legacy import.
    assert set(first) >= {
        "id",
        "title",
        "model",
        "source",
        "duration_sec",
        "play_count",
        "created_at",
        "links",
    }
    assert first["source"] == "generate"
    # a0 is the parent of a1 and a3 and a source of the mashup: three pairs.
    assert first["id"] == "a0"
    assert first["links"] == 3


def test_songs_search_is_a_substring_of_the_title(client: TestClient) -> None:
    body = client.get(
        f"{EXPLORE}/songs", params={"set": "standalone", "q": "alpha"}
    ).json()
    assert _ids(body) == ["s2"]
    assert body["total"] == 1


def test_songs_paging_reports_the_whole_population(client: TestClient) -> None:
    page1 = client.get(
        f"{EXPLORE}/songs", params={"set": "with_lineage", "limit": 4, "offset": 0}
    ).json()
    page2 = client.get(
        f"{EXPLORE}/songs", params={"set": "with_lineage", "limit": 4, "offset": 4}
    ).json()
    assert page1["total"] == page2["total"] == 9
    assert len(page1["rows"]) == 4
    assert len(page2["rows"]) == 4
    assert not set(_ids(page1)) & set(_ids(page2))


def test_songs_sorts_in_both_directions(client: TestClient) -> None:
    asc = _ids(
        client.get(
            f"{EXPLORE}/songs",
            params={"set": "standalone", "sort": "title", "dir": "asc"},
        ).json()
    )
    desc = _ids(
        client.get(
            f"{EXPLORE}/songs",
            params={"set": "standalone", "sort": "title", "dir": "desc"},
        ).json()
    )
    assert asc == ["s2", "s0", "s1"]
    assert desc == list(reversed(asc))


@pytest.mark.parametrize(
    "params",
    [
        {"set": "everything"},
        {"set": "standalone", "sort": "colour"},
        {"set": "standalone", "dir": "sideways"},
    ],
)
def test_songs_rejects_what_it_cannot_answer(
    client: TestClient, params: dict[str, str]
) -> None:
    assert client.get(f"{EXPLORE}/songs", params=params).status_code == 400


# ------------------------------------------------------------------- kinds


def test_kinds_counts_links_in_the_asked_for_role(client: TestClient) -> None:
    parents = client.get(f"{EXPLORE}/kinds/cover_of", params={"role": "parent"}).json()
    children = client.get(f"{EXPLORE}/kinds/cover_of", params={"role": "child"}).json()
    assert sorted(_ids(parents)) == ["a0", "b0"]
    assert sorted(_ids(children)) == ["a1", "b1"]
    assert parents["total"] == 2
    assert all(row["count"] == 1 for row in parents["rows"])


def test_kinds_reads_direction_from_the_role_table_not_from_the_columns(
    client: TestClient,
) -> None:
    """``cover`` is written from_id=parent; ``cover_of`` is from_id=child.

    Reading both the same way is the standing trap this table exists to
    close: c0 is the SOURCE of the poller's row even though it is ``from_id``.
    """
    parents = client.get(f"{EXPLORE}/kinds/cover", params={"role": "parent"}).json()
    assert _ids(parents) == ["c0"]
    children = client.get(f"{EXPLORE}/kinds/cover", params={"role": "child"}).json()
    assert _ids(children) == ["c1"]


def test_kinds_role_any_takes_both_ends(client: TestClient) -> None:
    body = client.get(f"{EXPLORE}/kinds/cover_of", params={"role": "any"}).json()
    assert sorted(_ids(body)) == ["a0", "a1", "b0", "b1"]
    assert body["total"] == 4


def test_kinds_sorts_by_count_and_by_title(client: TestClient) -> None:
    by_count = client.get(
        f"{EXPLORE}/kinds/mashup_source", params={"role": "child", "sort": "count"}
    ).json()
    assert _ids(by_count) == ["m0"]
    assert by_count["rows"][0]["count"] == 2
    by_title = client.get(
        f"{EXPLORE}/kinds/cover_of",
        params={"role": "parent", "sort": "title", "dir": "asc"},
    ).json()
    assert _ids(by_title) == ["a0", "b0"]


def test_kinds_searches_and_pages(client: TestClient) -> None:
    hit = client.get(
        f"{EXPLORE}/kinds/cover_of", params={"role": "parent", "q": "beta"}
    ).json()
    assert _ids(hit) == ["b0"]
    page = client.get(
        f"{EXPLORE}/kinds/cover_of", params={"role": "any", "limit": 1, "offset": 1}
    ).json()
    assert page["total"] == 4
    assert len(page["rows"]) == 1


@pytest.mark.parametrize(
    "path,params",
    [
        ("/kinds/not_a_kind", {"role": "parent"}),
        ("/kinds/cover_of", {"role": "aunt"}),
        ("/kinds/cover_of", {"role": "parent", "sort": "colour"}),
    ],
)
def test_kinds_rejects_what_it_cannot_answer(
    client: TestClient, path: str, params: dict[str, str]
) -> None:
    assert client.get(f"{EXPLORE}{path}", params=params).status_code == 400


def test_every_kind_in_the_role_table_is_answerable(client: TestClient) -> None:
    from backend.modules.lineagescale.graph import KIND_ORDER

    for kind in KIND_ORDER:
        res = client.get(f"{EXPLORE}/kinds/{kind}", params={"role": "any"})
        assert res.status_code == 200, kind


# ---------------------------------------------------------------- rankings


def test_rankings_generalise_the_presets_to_any_kind_and_role(
    client: TestClient,
) -> None:
    body = client.get(
        f"{EXPLORE}/rankings", params={"kind": "cover_of", "role": "parent"}
    ).json()
    assert sorted(_ids(body)) == ["a0", "b0"]
    assert body["rows"][0]["count"] == 1


def test_rankings_any_kind_ranks_by_every_non_artifact_link(
    client: TestClient,
) -> None:
    parents = client.get(
        f"{EXPLORE}/rankings", params={"kind": "any", "role": "parent"}
    ).json()
    # a0 has two children plus the mashup that uses it.
    assert _ids(parents)[0] == "a0"
    assert parents["rows"][0]["count"] == 3
    # An artifact link is counted by nobody: a0's midi_of row is not in there.
    assert all(row["count"] <= 3 for row in parents["rows"])


def test_rankings_pages_and_rejects_bad_input(client: TestClient) -> None:
    page = client.get(
        f"{EXPLORE}/rankings",
        params={"kind": "any", "role": "child", "limit": 2, "offset": 0},
    ).json()
    assert len(page["rows"]) <= 2
    assert page["total"] >= len(page["rows"])
    assert (
        client.get(
            f"{EXPLORE}/rankings", params={"kind": "nope", "role": "parent"}
        ).status_code
        == 400
    )
    assert (
        client.get(
            f"{EXPLORE}/rankings", params={"kind": "any", "role": "aunt"}
        ).status_code
        == 400
    )


# ---------------------------------------------------------------- families


def test_families_are_ancestry_components_and_the_biggest_is_the_summary_number(
    client: TestClient,
) -> None:
    summary = _summary(client)
    body = client.get(f"{EXPLORE}/families").json()
    assert body["rows"][0]["size"] == summary["largest_tree"]
    # A mashup welds A and B into one CLUSTER. It must not weld them into one
    # family: three families, not one of six.
    sizes = [row["size"] for row in body["rows"]]
    assert sizes == [4, 2, 2]
    assert body["total"] == 3


def test_families_carry_a_title_for_the_row(client: TestClient) -> None:
    row = client.get(f"{EXPLORE}/families").json()["rows"][0]
    assert row["title"]
    assert row["root_id"] in FAMILY_A
    assert set(row) >= {"root_id", "size", "title", "model", "source"}


def test_family_members_are_paged_and_complete(client: TestClient) -> None:
    root = client.get(f"{EXPLORE}/families").json()["rows"][0]["root_id"]
    body = client.get(f"{EXPLORE}/families/{root}/members", params={"limit": 50}).json()
    assert body["total"] == 4
    assert sorted(_ids(body)) == sorted(FAMILY_A)
    page = client.get(
        f"{EXPLORE}/families/{root}/members", params={"limit": 2, "offset": 2}
    ).json()
    assert len(page["rows"]) == 2
    assert page["total"] == 4


def test_family_members_answer_for_any_member_id_not_just_the_root(
    client: TestClient,
) -> None:
    body = client.get(f"{EXPLORE}/families/a2/members").json()
    assert sorted(_ids(body)) == sorted(FAMILY_A)


def test_family_members_search_and_sort(client: TestClient) -> None:
    body = client.get(
        f"{EXPLORE}/families/a0/members", params={"q": "edit", "sort": "title"}
    ).json()
    assert _ids(body) == ["a2"]
    desc = _ids(
        client.get(
            f"{EXPLORE}/families/a0/members", params={"sort": "title", "dir": "desc"}
        ).json()
    )
    # "Alpha root", "Alpha edit", "Alpha cover", "Alpha branch".
    assert desc == ["a0", "a2", "a1", "a3"]


def test_family_members_404_for_a_song_with_no_family(client: TestClient) -> None:
    assert client.get(f"{EXPLORE}/families/s0/members").status_code == 404
    assert client.get(f"{EXPLORE}/families/nobody/members").status_code == 404


def test_standalone_by_links_still_honours_the_direction(client: TestClient) -> None:
    """Every standalone song has zero links, so the tiebreak is the order --
    and asking for it backwards must still turn it round."""
    asc = _ids(
        client.get(
            f"{EXPLORE}/songs",
            params={"set": "standalone", "sort": "links", "dir": "asc"},
        ).json()
    )
    desc = _ids(
        client.get(
            f"{EXPLORE}/songs",
            params={"set": "standalone", "sort": "links", "dir": "desc"},
        ).json()
    )
    assert asc == ["s2", "s0", "s1"]
    assert desc == list(reversed(asc))


# ------------------------------------------------------------------ budget


def test_no_route_ever_reads_a_json_column(
    monkeypatch: pytest.MonkeyPatch, library: LibraryDB
) -> None:
    """The reason this module is fast: ~34 KB of ``metadata_json`` a row.

    Every statement every explorer route issues is traced and none of them
    may name a ``*_json`` column or ``SELECT *``.
    """
    store = StubStore(library)
    monkeypatch.setattr(lineage_router, "get_library_store", lambda: store)
    app = FastAPI()
    app.include_router(lineage_router.router, prefix=PREFIX)
    with TestClient(app) as client, _traced(monkeypatch, library) as statements:
        client.get(f"{EXPLORE}/songs", params={"set": "with_lineage", "sort": "links"})
        client.get(f"{EXPLORE}/songs", params={"set": "standalone", "q": "solo"})
        client.get(f"{EXPLORE}/kinds/cover_of", params={"role": "any", "sort": "count"})
        client.get(f"{EXPLORE}/kinds/cover_of", params={"role": "parent", "q": "beta"})
        client.get(f"{EXPLORE}/rankings", params={"kind": "any", "role": "parent"})
        client.get(f"{EXPLORE}/rankings", params={"kind": "cover_of", "role": "child"})
        client.get(f"{EXPLORE}/families")
        client.get(f"{EXPLORE}/families/a0/members")
    assert statements, "the trace saw nothing, so it proves nothing"
    for sql in statements:
        lowered = " ".join(sql.lower().split())
        assert "_json" not in lowered, sql
        assert "select *" not in lowered, sql


def test_the_explorer_reads_on_its_own_connection_and_closes_it(
    monkeypatch: pytest.MonkeyPatch, library: LibraryDB
) -> None:
    """No handle is left open: on Windows an open handle locks the file."""
    opened: list[sqlite3.Connection] = []
    real_connect = sqlite3.connect

    def traced_connect(*args: Any, **kwargs: Any) -> sqlite3.Connection:
        conn = real_connect(*args, **kwargs)
        opened.append(conn)
        return conn

    monkeypatch.setattr(sqlite3, "connect", traced_connect)
    store = StubStore(library)
    monkeypatch.setattr(lineage_router, "get_library_store", lambda: store)
    app = FastAPI()
    app.include_router(lineage_router.router, prefix=PREFIX)
    with TestClient(app) as client:
        assert client.get(f"{EXPLORE}/families").status_code == 200
    assert opened, "the explorer never opened its own connection"
    for conn in opened:
        with pytest.raises(sqlite3.ProgrammingError):
            conn.execute("SELECT 1")


def test_after_the_warm_no_kind_list_reads_the_relations_rows(
    monkeypatch: pytest.MonkeyPatch, library: LibraryDB
) -> None:
    """Opening a kind list must not scan ``relations``.

    There is no index on ``relations(kind)``, so "the songs with a link of kind
    K" asked of the database is a full read of the table -- 475,174 rows on the
    real library, for every kind row a user clicks. The one pass counts every
    kind as it goes instead, so after the warm these eighteen requests read
    entries and nothing else. The link signature is the one statement allowed
    to name ``relations``: it is two covering counts and it is what tells the
    cache the graph has not changed.
    """
    store = StubStore(library)
    monkeypatch.setattr(lineage_router, "get_library_store", lambda: store)
    app = FastAPI()
    app.include_router(lineage_router.router, prefix=PREFIX)
    explore.clear_caches()
    assert explore.warm_explore_cache() is True
    with TestClient(app) as client, _traced(monkeypatch, library) as statements:
        for kind in KIND_ORDER:
            assert (
                client.get(
                    f"{EXPLORE}/kinds/{kind}", params={"role": "any"}
                ).status_code
                == 200
            )
            assert (
                client.get(
                    f"{EXPLORE}/kinds/{kind}",
                    params={"role": "parent", "sort": "count"},
                ).status_code
                == 200
            )
        assert (
            client.get(
                f"{EXPLORE}/rankings", params={"kind": "cover_of", "role": "parent"}
            ).status_code
            == 200
        )
    assert statements, "the trace saw nothing, so it proves nothing"
    for sql in statements:
        lowered = " ".join(sql.lower().split())
        assert "from_id" not in lowered, sql
        assert "to_id" not in lowered, sql
        if "relations" in lowered:
            assert "count(*) from relations" in lowered, sql


def test_a_second_page_does_not_repeat_the_library_wide_pass(
    client: TestClient,
) -> None:
    """The pass is 3.6 s on the real library. It runs once per link change."""
    explore.clear_caches()
    before = explore._family_cache.passes
    client.get(f"{EXPLORE}/families")
    after_first = explore._family_cache.passes
    client.get(f"{EXPLORE}/families", params={"offset": 1})
    client.get(f"{EXPLORE}/rankings", params={"kind": "any", "role": "parent"})
    assert after_first == before + 1
    assert explore._family_cache.passes == after_first


def test_the_warm_hook_fills_the_cache_from_the_fixture_and_nothing_else(
    monkeypatch: pytest.MonkeyPatch, library: LibraryDB, _no_real_library: _PoisonStore
) -> None:
    """The warm reads whoever owns the store WHEN IT RUNS.

    It used to read the one this module imported, which is the app's -- so this
    test used to run a library-wide pass over the user's real library. What is
    asserted is therefore not "the cache filled" but "the cache filled WITH THE
    FIXTURE": the index describes twelve synthetic songs, the app's store was
    never touched, and nothing asked where the real library lives.
    """
    store = StubStore(library)
    monkeypatch.setattr(lineage_router, "get_library_store", lambda: store)
    explore.clear_caches()
    before = explore._family_cache.passes
    assert explore.warm_explore_cache() is True
    assert explore._family_cache.passes == before + 1

    index = explore._family_cache._value
    assert index is not None
    assert index.entries_total == len(ENTRY_IDS)
    assert set(index.entry_ids) == set(ENTRY_IDS)
    assert _PoisonStore.used is False


def test_the_warm_cannot_fall_back_to_the_app_store(
    _no_real_library: _PoisonStore,
) -> None:
    """With no stub installed, the warm finds the app's store -- and stops.

    This is the escape the review caught, from the other side: the warm must
    resolve ``get_library_store`` through the router module at call time, so
    the only store it can ever reach is the one the process has installed. Here
    that is the poison, so the pass never runs and no library is opened.
    """
    explore.clear_caches()
    before = explore._family_cache.passes
    assert explore.warm_explore_cache() is False
    assert explore._family_cache.passes == before
    assert _PoisonStore.used is True
