"""Tests for ``backend.modules.lineagescale``.

Everything runs against the synthetic library in
``tests/lineagescale_fixtures.py``. Nothing here opens the user's library,
starts a server, or touches port 8600: the router's ``get_store`` is replaced
with a stub whose only attribute is the fixture database.

The pure algorithms are tested without FastAPI and the routes are tested
through ``TestClient``, which is the split ``graph.py`` exists to make
possible.
"""

from __future__ import annotations

import gc
import logging
import re
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.modules.lineagescale import graph, router as lineage_router
from tests.lineagescale_fixtures import (
    HUB_CHILDREN,
    METADATA_PAD_BYTES,
    THRESHOLD_EXACT_CHILDREN,
    THRESHOLD_OVER_CHILDREN,
    UNKNOWN_KIND,
    FixtureLibrary,
    StubStore,
    build_fixture_library,
    build_small_library,
    entry_rows,
    link_rows,
    metadata_blob_size,
)
from tests.timing_bounds import prompt_seconds

PREFIX = "/api/lineage-scale"

#: The only logger whose records say anything about this module.
_ROUTER_LOGGER = "backend.modules.lineagescale.router"


# --------------------------------------------------------------- fixtures


@pytest.fixture(scope="session")
def library(tmp_path_factory: pytest.TempPathFactory) -> Iterator[FixtureLibrary]:
    """The big synthetic library. Built once: ~13,000 padded rows."""
    path = tmp_path_factory.mktemp("lineagescale") / "library.db"
    fixture = build_fixture_library(path)
    yield fixture
    fixture.close()


@pytest.fixture(scope="session")
def small_library(tmp_path_factory: pytest.TempPathFactory) -> Iterator[FixtureLibrary]:
    path = tmp_path_factory.mktemp("lineagescale-small") / "library.db"
    fixture = build_small_library(path)
    yield fixture
    fixture.close()


@pytest.fixture(autouse=True)
def _clear_stats_cache() -> Iterator[None]:
    """The stats cache is module-level on purpose. Two fixtures in one
    session can land on the same ``library_revision``, so no test may inherit
    another's answer."""
    lineage_router._stats_cache.clear()
    yield
    lineage_router._stats_cache.clear()


def _client(monkeypatch: pytest.MonkeyPatch, fixture: FixtureLibrary) -> TestClient:
    store = StubStore(fixture.db)
    monkeypatch.setattr(lineage_router, "get_library_store", lambda: store)
    app = FastAPI()
    app.include_router(lineage_router.router, prefix=PREFIX)
    return TestClient(app)


@contextmanager
def _traced(
    monkeypatch: pytest.MonkeyPatch, fixture: FixtureLibrary
) -> Iterator[list[str]]:
    """Every statement every connection the module opens issues.

    The library-wide pass runs on its own read-only connection now, so
    watching only the app's connection would watch an empty room.
    """
    statements: list[str] = []
    real_connect = sqlite3.connect

    def traced_connect(*args: Any, **kwargs: Any) -> sqlite3.Connection:
        conn = real_connect(*args, **kwargs)
        conn.set_trace_callback(statements.append)
        return conn

    monkeypatch.setattr(sqlite3, "connect", traced_connect)
    shared = fixture.db._conn  # noqa: SLF001 - the fixture's own connection
    shared.set_trace_callback(statements.append)
    try:
        yield statements
    finally:
        shared.set_trace_callback(None)


def _in_memory_fetch(fixture: FixtureLibrary) -> graph.FetchLinks:
    """``fetch_links`` backed by a dict, for the pure walk tests."""
    index: dict[str, list[tuple[str, str, str]]] = {}
    for from_id, to_id, kind in link_rows(fixture.db):
        index.setdefault(from_id, []).append((from_id, to_id, kind))
        index.setdefault(to_id, []).append((from_id, to_id, kind))

    def fetch(ids: Any) -> list[tuple[str, str, str]]:
        out: list[tuple[str, str, str]] = []
        for node_id in ids:
            out.extend(index.get(node_id, ()))
        return out

    return fetch


def _stats(fixture: FixtureLibrary) -> graph.LibraryStats:
    return graph.compute_library_stats(
        link_rows(fixture.db), entry_rows(fixture.db), revision=1
    )


# ------------------------------------------------------- the role table


#: Every file under ``backend/`` that calls a relation writer, and what each
#: one is for. Asserted to BE the complete list, so a writer that moves, or a
#: new one, fails this test by name instead of quietly adding a kind the role
#: table has never heard of.
#:
#: ``library/db.py`` is the writer's own definition, not a call site, so it is
#: excluded by matching only ``.add_relation(`` / ``.add_relations_bulk(``.
_RELATION_WRITER_FILES = (
    "backend/modules/library/store.py",
    "backend/modules/midi/runner.py",
    "backend/modules/notation/engine.py",
    "backend/modules/notation/musescore_render.py",
    "backend/modules/notation/router.py",
    "backend/modules/notation/score_import.py",
    "backend/modules/stems/engine.py",
    "backend/modules/suno/router.py",
)

_WRITER_CALL_RE = re.compile(r"\.add_relations?(?:_bulk)?\(")
#: ``kind="literal"`` in a call site.
_KIND_LITERAL_RE = re.compile(r"""kind\s*=\s*["']([A-Za-z0-9_]+)["']""")
#: ``kind=name`` — a variable, resolved below.
_KIND_NAME_RE = re.compile(r"kind\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\s*[,)]")
#: ``add_relations_bulk(name)`` — a list of ``(from, to, kind)`` tuples.
_BULK_NAME_RE = re.compile(r"add_relations_bulk\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)")
#: How far above a call site a binding for its kind is looked for.
_RESOLVE_WINDOW = 40


def _kinds_from_helper(text: str, helper: str) -> set[str]:
    """String literals in the LAST position of a 3-tuple inside ``helper``.

    ``library/store.py`` writes ``(str(label), entry_id, "chimera_source_of")``
    from ``_chimera_edges`` and passes the tuples on, so the kind is a literal
    in the helper rather than at the call site.
    """
    match = re.search(rf"^def {re.escape(helper)}\(", text, re.MULTILINE)
    if match is None:
        return set()
    rest = text[match.start() :]
    end = re.search(r"\n(?=\S)", rest[1:])
    body = rest if end is None else rest[: end.start() + 1]
    return set(re.findall(r""",\s*["']([A-Za-z0-9_]+)["']\s*\)""", body))


def _kind_argument_texts(call: str) -> list[str]:
    """The source text of every ``kind=`` argument in a call site.

    The value ends at the first comma or closing bracket OUTSIDE any bracket it
    opened itself, so ``kind="a", engine="b"`` yields only ``"a"`` while
    ``kind="a" if p else "b"`` yields the whole conditional.
    """
    out: list[str] = []
    for match in re.finditer(r"kind\s*=\s*", call):
        rest = call[match.end() :]
        depth = 0
        end = len(rest)
        for index, char in enumerate(rest):
            if char in "([{":
                depth += 1
            elif char in ")]}":
                if depth == 0:
                    end = index
                    break
                depth -= 1
            elif char == "," and depth == 0:
                end = index
                break
        out.append(rest[:end])
    return out


def _kinds_written_by(path: Path) -> tuple[set[str], list[str]]:
    """``(kinds, unresolved)`` for one writer file.

    Three ways a call site names its kind, and nothing else is guessed:
      1. ``kind="literal"``;
      2. ``kind=name`` guarded by ``name in ("a", "b")`` within
         :data:`_RESOLVE_WINDOW` lines above (``suno/router.py``'s ``mode``);
      3. the kind comes from a same-file helper the binding names --
         ``for ..., kind in _helper(...)`` or ``rows.extend(_helper(...))``.

    A call site none of those resolve is UNRESOLVED and fails the test: a new
    way of passing a kind must be read by a human, not silently skipped.
    """
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    kinds: set[str] = set()
    unresolved: list[str] = []
    for number, line in enumerate(lines, start=1):
        if not _WRITER_CALL_RE.search(line):
            continue
        window = "\n".join(lines[max(0, number - _RESOLVE_WINDOW) : number])
        # The call's own arguments may wrap onto the following lines.
        call = "\n".join(lines[number - 1 : number + 6])
        found = set(_KIND_LITERAL_RE.findall(call))
        if not found:
            names = _KIND_NAME_RE.findall(call) + _BULK_NAME_RE.findall(call)
            for name in names:
                guard = re.findall(
                    rf"\b{re.escape(name)}\b\s+(?:not\s+)?in\s+[({{\[]([^)}}\]]*)[)}}\]]",
                    window,
                )
                for group in guard:
                    found |= set(re.findall(r"""["']([A-Za-z0-9_]+)["']""", group))
                for helper in re.findall(
                    rf"(?:for[^\n]*\b{re.escape(name)}\b[^\n]*\bin\s+|"
                    rf"\b{re.escape(name)}\s*\.\s*(?:extend|append)\(\s*)"
                    rf"([A-Za-z_][A-Za-z0-9_]*)\(",
                    window,
                ):
                    found |= _kinds_from_helper(text, helper)
        # A kind argument may carry MORE quoted tokens than the literal regex
        # attributed to it -- `kind="a" if p else "b"` registers only "a", and
        # the kind that got away would reach the database with no row in the
        # role table while this scan still passed. So every quoted token in the
        # argument's own text has to be accounted for.
        leftover: set[str] = set()
        for value in _kind_argument_texts(call):
            leftover |= set(re.findall(r"""["']([A-Za-z0-9_]+)["']""", value))
        leftover -= found
        if found:
            kinds |= found
        if leftover:
            unresolved.append(
                f"{path.as_posix()}:{number}: {line.strip()} "
                f"(kinds the scan could not attribute: {sorted(leftover)})"
            )
        elif not found:
            unresolved.append(f"{path.as_posix()}:{number}: {line.strip()}")
    return kinds, unresolved


def test_the_role_table_covers_every_kind_this_repository_writes():
    """The table is the single source of truth, so a kind a writer in this
    repo produces and the table has never heard of is a bug in the table.

    The expected set is READ OFF THE WRITERS rather than typed out here: a
    hand-written list can only ever repeat what the table already says, which
    is how ``cover`` and ``mashup`` (``backend/modules/suno/router.py:346``)
    sat outside the table under a test with this name.
    """
    root = Path(__file__).resolve().parents[1]

    # The list of writer files is itself an assertion: a writer that moved, or
    # a new one, must break this test rather than go unread.
    found_files = sorted(
        path.relative_to(root).as_posix()
        for path in (root / "backend").rglob("*.py")
        if _WRITER_CALL_RE.search(path.read_text(encoding="utf-8"))
    )
    assert found_files == sorted(_RELATION_WRITER_FILES), (
        "the set of relation writers under backend/ changed; read the new one "
        "and give every kind it writes a row in graph.KIND_ROLES"
    )

    written: set[str] = set()
    unresolved: list[str] = []
    for relative in _RELATION_WRITER_FILES:
        path = root / relative
        assert path.is_file(), f"{relative} is gone; find where its writer went"
        kinds, missed = _kinds_written_by(path)
        written |= kinds
        unresolved.extend(missed)

    assert not unresolved, (
        "a relation writer passes its kind in a way this scan cannot read; "
        f"read it and extend the scan: {unresolved}"
    )
    # A broken regex must not pass by finding nothing: the two bare kinds this
    # test was rewritten for, and the helper-supplied one, are the proof the
    # scan reached all three shapes of call site.
    assert {"cover", "mashup", "chimera_source_of"} <= written, written

    missing = sorted(kind for kind in written if kind not in graph.KIND_ROLES)
    assert not missing, (
        f"these kinds are written under backend/ and are not in the role "
        f"table, so they read as role 'other' with a guessed direction: "
        f"{missing}"
    )

    # The bare Suno kinds point the OTHER way round from their `_of` siblings.
    assert graph.KIND_ROLES["cover"].source_end == graph.SOURCE_END_FROM
    assert graph.KIND_ROLES["mashup"].source_end == graph.SOURCE_END_FROM
    assert graph.orient("parent", "child", "cover") == ("child", "parent")
    assert graph.orient("source", "mashup_song", "mashup") == (
        "mashup_song",
        "source",
    )
    # Display order keeps the specific kind ahead of the generic one.
    assert graph.KIND_ORDER["cover"] < graph.KIND_ORDER["derived_from"]

    assert graph.ANCESTRY_KINDS == {
        "cover_of",
        "edit_of",
        "derived_from",
        "upsample_of",
        "overpaint_of",
        "underpaint_of",
        "speed_change_of",
        "stem_of",
        "cover",
    }
    assert graph.USES_KINDS == {"mashup_source", "chimera_source_of", "mashup"}
    for info in graph.KIND_ROLES.values():
        assert info.writer, f"{info.kind} has no writer recorded"
        assert info.source_end in (graph.SOURCE_END_TO, graph.SOURCE_END_FROM)


#: Every file that points a reader at the line of ``suno/router.py`` where the
#: bare ``cover``/``mashup`` kinds are written. A citation is documentation that
#: rots silently: the call moved down four lines and all five kept naming 342,
#: which sends the next reader to an unrelated comment.
_SUNO_WRITER_CITERS = (
    "backend/modules/lineagescale/graph.py",
    "frontend/src/lineagescale/lineageScaleModel.ts",
    "frontend/src/lineagescale/lineageScaleModel.test.ts",
    "tests/test_lineagescale.py",
)

_SUNO_CITATION_RE = re.compile(r"backend/modules/suno/router\.py:(\d+)")


def test_every_citation_of_the_suno_relation_writer_points_at_the_call():
    """A ``suno/router.py:<line>`` pointer must land ON the ``add_relation``
    call. Checked rather than trusted, because the drift is invisible: the
    number still looks like a line number after the code moves."""
    root = Path(__file__).resolve().parents[1]
    target = (root / "backend/modules/suno/router.py").read_text(encoding="utf-8")
    lines = target.splitlines()

    cited: list[tuple[str, int]] = []
    for relative in _SUNO_WRITER_CITERS:
        path = root / relative
        assert path.is_file(), f"{relative} is gone; the citation moved with it"
        for number in _SUNO_CITATION_RE.findall(path.read_text(encoding="utf-8")):
            cited.append((relative, int(number)))

    assert cited, "the citations vanished; find where they went before deleting this"
    for relative, number in cited:
        assert 1 <= number <= len(lines), (
            f"{relative} cites suno/router.py:{number}, past the end of a "
            f"{len(lines)}-line file"
        )
        assert "add_relation(" in lines[number - 1], (
            f"{relative} cites suno/router.py:{number}, which is "
            f"{lines[number - 1].strip()!r} and not the add_relation call; "
            "the writer moved, so update every citation"
        )
    # All of them, not just the one file that happened to be read first.
    assert {relative for relative, _ in cited} == set(_SUNO_WRITER_CITERS)


def test_a_conditional_kind_argument_is_unresolved_and_not_half_read(tmp_path):
    """``kind="a" if p else "b"`` registers only ``"a"`` under the literal
    regex, so the second kind would reach the database with no row in the role
    table and this scan would still pass. A quoted token the scan did not
    account for therefore fails loudly."""
    partial = tmp_path / "conditional_writer.py"
    partial.write_text(
        "def w(store, a, b, flag):\n"
        "    store.db.add_relation(from_id=a, to_id=b, "
        'kind="alpha" if flag else "beta")\n',
        encoding="utf-8",
    )
    kinds, unresolved = _kinds_written_by(partial)
    assert len(unresolved) == 1, unresolved
    assert "beta" in unresolved[0], unresolved
    assert "alpha" in kinds, "what it DID read is still reported"

    # An ordinary literal call site stays resolved: the new check must not turn
    # every writer into a failure.
    plain = tmp_path / "plain_writer.py"
    plain.write_text(
        "def w(store, a, b):\n"
        '    store.db.add_relation(from_id=a, to_id=b, kind="alpha")\n',
        encoding="utf-8",
    )
    assert _kinds_written_by(plain) == ({"alpha"}, [])

    # A kind that is resolved from a guarded variable carries no quoted token
    # of its own at the call site, so it must not be reported as a leftover.
    guarded = tmp_path / "guarded_writer.py"
    guarded.write_text(
        "def w(store, a, b, mode):\n"
        '    if mode in ("cover", "mashup"):\n'
        "        store.db.add_relation(from_id=a, to_id=b, kind=mode)\n",
        encoding="utf-8",
    )
    assert _kinds_written_by(guarded) == ({"cover", "mashup"}, [])

    # And a literal kind followed by another quoted argument is not a leftover
    # either: only the kind argument's own text is read.
    neighboured = tmp_path / "neighboured_writer.py"
    neighboured.write_text(
        "def w(store, a, b):\n"
        '    store.db.add_relation(from_id=a, to_id=b, kind="alpha", engine="beta")\n',
        encoding="utf-8",
    )
    assert _kinds_written_by(neighboured) == ({"alpha"}, [])


def test_an_unrecognised_kind_is_not_assumed_to_be_ancestry():
    assert graph.role_of(UNKNOWN_KIND) == graph.ROLE_OTHER
    assert graph.role_of("cover_of") == graph.ROLE_ANCESTRY
    assert graph.role_of("mashup_source") == graph.ROLE_USES
    assert graph.role_of("midi_of") == graph.ROLE_ARTIFACT


def test_orientation_follows_each_writer_and_not_the_column_order():
    """Two writers in this repository point opposite ways. Getting this
    wrong makes a song its own ancestor's child."""
    # Promoted lineage: (child, parent, kind).
    assert graph.orient("child", "parent", "derived_from") == ("child", "parent")
    assert graph.orient("mashup", "source", "mashup_source") == ("mashup", "source")
    # library/store.py: (source_label, entry_id, "chimera_source_of").
    assert graph.orient("label", "song", "chimera_source_of") == ("song", "label")
    # notation/midi: (song, artifact_id, kind).
    assert graph.orient("song", "score", "rendered_as_notation") == ("score", "song")
    # stems/engine.py writes (parent, f"{parent}__{name}", "stem_of") ...
    assert graph.orient("aaa", "aaa__vocals", "stem_of") == ("aaa__vocals", "aaa")
    # ... while the promoted writer writes (child, parent).
    assert graph.orient("aaa", "bbb", "stem_of") == ("aaa", "bbb")


def test_a_link_from_a_song_to_itself_is_not_a_relationship():
    assert graph.orient("same", "same", "derived_from") is None


def test_the_strongest_role_wins_when_one_pair_carries_several_kinds():
    assert graph.role_for_kinds(("cover_of", "mashup_source")) == graph.ROLE_ANCESTRY
    assert graph.role_for_kinds(("mashup_source",)) == graph.ROLE_USES


# ------------------------------------------------------------ duplicates


def test_three_links_between_one_pair_are_one_edge_carrying_three_kinds(library):
    """The real library stores one stem as derived_from + edit_of + stem_of.
    Drawn as three arrows it is three relationships that do not exist."""
    walk = graph.build_neighbourhood(
        library.ids.duplicate_child,
        up=1,
        down=0,
        budget=100,
        fetch_links=_in_memory_fetch(library),
    )
    edges = [e for e in walk.edges if e.parent == library.ids.duplicate_parent]
    assert len(edges) == 1
    assert edges[0].kinds == ("edit_of", "derived_from", "stem_of")
    assert edges[0].role == graph.ROLE_ANCESTRY
    # kinds[0] is what the UI colours by: the specific kind, not the generic
    # one that co-occurs with everything.
    assert edges[0].kinds[0] == "edit_of"


# --------------------------------------------------------- neighbourhood


def test_generations_are_negative_upward_and_positive_downward(library):
    walk = graph.build_neighbourhood(
        library.ids.hub,
        up=1,
        down=1,
        budget=1500,
        fetch_links=_in_memory_fetch(library),
    )
    assert walk.generation[library.ids.hub] == 0
    assert walk.generation[library.ids.hub_parent] == -1
    down = graph.build_neighbourhood(
        library.ids.threshold_exact,
        up=0,
        down=1,
        budget=1500,
        fetch_links=_in_memory_fetch(library),
    )
    children = [n for n, g in down.generation.items() if g == 1]
    assert len(children) == THRESHOLD_EXACT_CHILDREN


def test_exactly_twelve_relatives_stay_nodes_and_thirteen_become_a_group(library):
    fetch = _in_memory_fetch(library)
    exact = graph.build_neighbourhood(
        library.ids.threshold_exact, up=0, down=1, budget=1500, fetch_links=fetch
    )
    assert exact.groups == []
    assert len(exact.order) == THRESHOLD_EXACT_CHILDREN + 1

    over = graph.build_neighbourhood(
        library.ids.threshold_over, up=0, down=1, budget=1500, fetch_links=fetch
    )
    assert len(over.order) == 1, "a grouped fan costs no nodes"
    assert len(over.groups) == 1
    group = over.groups[0]
    assert group.count == THRESHOLD_OVER_CHILDREN
    assert group.parent_id == library.ids.threshold_over
    assert group.direction == graph.DOWN
    assert group.kind == "cover_of"
    # The contract says up to five, so five is the number, not whatever the
    # constant happens to say.
    assert graph.GROUP_SAMPLE_IDS == 5
    assert len(group.sample_ids) == 5
    assert set(group.sample_ids) <= {
        f"threshold-over-c{i:02d}" for i in range(THRESHOLD_OVER_CHILDREN)
    }


def test_a_hub_of_eight_hundred_children_costs_three_groups_not_eight_hundred(
    library,
):
    walk = graph.build_neighbourhood(
        library.ids.hub,
        up=1,
        down=1,
        budget=1500,
        fetch_links=_in_memory_fetch(library),
    )
    assert len(walk.order) == 2, "the focus and its one parent"
    assert {(g.kind, g.count) for g in walk.groups} == {
        ("cover_of", 400),
        ("edit_of", 250),
        ("upsample_of", 150),
    }
    assert sum(g.count for g in walk.groups) == HUB_CHILDREN
    assert walk.truncated is False


def test_a_uses_link_is_never_walked_through(library):
    """A mashup welds two unrelated trees. Its sources are shown; their
    ancestors are not, at any depth, or the neighbourhood becomes the
    81,501-song component."""
    walk = graph.build_neighbourhood(
        library.ids.mashup,
        up=8,
        down=8,
        budget=1500,
        fetch_links=_in_memory_fetch(library),
    )
    assert set(walk.order) == {
        library.ids.mashup,
        library.ids.mashup_parent_a,
        library.ids.mashup_parent_b,
    }
    assert library.ids.mashup_grandparent_a not in walk.generation
    assert library.ids.mashup_grandparent_b not in walk.generation
    assert set(walk.generation.values()) == {0, -1}
    # The sources still say how much is behind them.
    assert walk.hidden[library.ids.mashup_parent_a]["up"] == 1
    for edge in walk.edges:
        assert edge.role == graph.ROLE_USES
        assert edge.kinds == ("mashup_source",)


def test_a_uses_link_is_not_even_followed_from_a_node_that_is_not_the_focus(
    library,
):
    """Focus a song one hop above a mashup: the mashup is a derivative of
    nothing here, so no ``uses`` edge may appear at all."""
    walk = graph.build_neighbourhood(
        library.ids.mashup_grandparent_a,
        up=8,
        down=8,
        budget=1500,
        fetch_links=_in_memory_fetch(library),
    )
    assert library.ids.mashup not in walk.generation
    assert all(e.role == graph.ROLE_ANCESTRY for e in walk.edges)


def test_an_unknown_kind_is_shown_one_hop_and_never_recursed(library):
    walk = graph.build_neighbourhood(
        library.ids.unknown_child,
        up=8,
        down=0,
        budget=1500,
        fetch_links=_in_memory_fetch(library),
    )
    assert library.ids.unknown_parent in walk.generation
    assert library.ids.unknown_grandparent not in walk.generation
    edge = next(e for e in walk.edges if e.parent == library.ids.unknown_parent)
    assert edge.role == graph.ROLE_OTHER
    assert edge.kinds == (UNKNOWN_KIND,)


def test_artifact_links_are_counted_but_never_drawn(library):
    walk = graph.build_neighbourhood(
        library.ids.artifact_song,
        up=8,
        down=8,
        budget=1500,
        fetch_links=_in_memory_fetch(library),
    )
    assert walk.order == [library.ids.artifact_song]
    assert walk.edges == []
    assert walk.hidden == {}
    summary = _stats(library).summary
    for artifact_kind in ("midi_of", "rendered_as_notation", "charted_as_chords"):
        assert summary["by_kind"][artifact_kind] >= 1


def test_the_budget_stops_the_walk_and_admits_it(library):
    walk = graph.build_neighbourhood(
        library.ids.threshold_exact,
        up=0,
        down=1,
        budget=graph.MIN_BUDGET,
        fetch_links=_in_memory_fetch(library),
    )
    assert walk.truncated is False, "13 nodes is under the floor of 50"

    fetch = _in_memory_fetch(library)
    whole = graph.build_neighbourhood(
        library.ids.budget_root, up=0, down=3, budget=1500, fetch_links=fetch
    )
    assert len(whole.order) == library.expected["budget_descendants"] + 1
    assert whole.truncated is False

    wide = graph.build_neighbourhood(
        library.ids.budget_root, up=0, down=3, budget=60, fetch_links=fetch
    )
    assert wide.truncated is True
    assert len(wide.order) == 60
    assert wide.budget == 60
    # What the budget cut is still counted, so the UI can say how much.
    assert sum(c["down"] for c in wide.hidden.values()) > 0


def test_hidden_counts_what_the_view_left_out(library):
    """ "+N more" has to be a number the user can act on: what was cut, not
    what is already on screen."""
    fetch = _in_memory_fetch(library)
    walk = graph.build_neighbourhood(
        library.ids.deep_tip, up=2, down=1, budget=1500, fetch_links=fetch
    )
    boundary = min(walk.generation, key=lambda node: walk.generation[node])
    assert walk.generation[boundary] == -2
    assert walk.hidden[boundary] == {"up": 1, "down": 0}
    # Everything that IS on screen is not also counted as missing.
    for node_id, counts in walk.hidden.items():
        assert counts["up"] >= 0 and counts["down"] >= 0
        assert node_id in walk.generation
    grouped = graph.build_neighbourhood(
        library.ids.threshold_over, up=0, down=1, budget=1500, fetch_links=fetch
    )
    assert grouped.hidden == {}, "a group already carries its own count"


def test_a_relative_folded_at_one_parent_and_drawn_at_another_keeps_both_edges():
    """A fold is per (node, direction, kind), not a verdict on the relative.

    So one of a folded fan can still be reached by another path and drawn --
    and when it is, it must arrive attached. Without its line back to the
    parent that folded it, the song appears in the picture as if that
    relationship did not exist.
    """
    rows = [("a-parent", "f", "derived_from"), ("b-parent", "f", "derived_from")]
    fan = [f"g-{i:02d}" for i in range(graph.GROUP_THRESHOLD + 1)]
    for child in fan:
        rows.append((child, "a-parent", "cover_of"))
    # The first of the fan is ALSO an ordinary child of the other parent.
    shared = fan[0]
    rows.append((shared, "b-parent", "edit_of"))

    index: dict[str, list[tuple[str, str, str]]] = {}
    for from_id, to_id, kind in rows:
        index.setdefault(from_id, []).append((from_id, to_id, kind))
        index.setdefault(to_id, []).append((from_id, to_id, kind))

    walk = graph.build_neighbourhood(
        "f",
        up=0,
        down=3,
        budget=1500,
        fetch_links=lambda ids: [row for i in ids for row in index.get(i, ())],
    )

    # The fan is still folded: one group, and only the shared song was drawn.
    assert [(g.parent_id, g.kind, g.count) for g in walk.groups] == [
        ("a-parent", "cover_of", len(fan))
    ]
    assert set(walk.order) == {"f", "a-parent", "b-parent", shared}

    pairs = {(edge.child, edge.parent): edge.kinds for edge in walk.edges}
    assert (shared, "b-parent") in pairs, "the path that drew it"
    assert (shared, "a-parent") in pairs, (
        "the parent that folded it lost its line to a song that IS on screen"
    )
    assert pairs[(shared, "a-parent")] == ("cover_of",)
    # And nothing is drawn to a relative that stayed folded.
    for child, parent in pairs:
        assert child in walk.generation and parent in walk.generation
    assert not any(node in pairs for node in ((f, "a-parent") for f in fan[1:]))


def test_a_two_cycle_does_not_loop(library):
    walk = graph.build_neighbourhood(
        library.ids.cycle_a,
        up=8,
        down=8,
        budget=1500,
        fetch_links=_in_memory_fetch(library),
    )
    assert set(walk.order) == {library.ids.cycle_a, library.ids.cycle_b}
    assert len(walk.edges) == 2, "each is a cover of the other: two real edges"


def test_depth_and_budget_are_clamped_to_the_contract(library):
    fetch = _in_memory_fetch(library)
    walk = graph.build_neighbourhood(
        library.ids.deep_tip, up=99, down=-4, budget=99_999, fetch_links=fetch
    )
    assert walk.up == graph.MAX_DEPTH
    assert walk.down == 0
    assert walk.budget == graph.MAX_BUDGET
    tiny = graph.build_neighbourhood(
        library.ids.deep_tip, up=1, down=0, budget=1, fetch_links=fetch
    )
    assert tiny.budget == graph.MIN_BUDGET


def test_a_locally_separated_stem_is_a_derivative_not_an_ancestor(library):
    """``stems/engine.py`` writes stem_of the other way round. Read with the
    promoted writer's direction, a song's own stems become its parents."""
    fetch = _in_memory_fetch(library)
    walk = graph.build_neighbourhood(
        library.ids.local_stem_parent, up=2, down=2, budget=1500, fetch_links=fetch
    )
    assert walk.generation[library.ids.local_stem_id] == 1

    promoted = graph.build_neighbourhood(
        library.ids.promoted_stem_child, up=2, down=2, budget=1500, fetch_links=fetch
    )
    assert promoted.generation[library.ids.promoted_stem_parent] == -1


# ----------------------------------------------------------- the library


def test_the_summary_counts_the_library(library):
    summary = _stats(library).summary
    expected = library.expected
    assert summary["entries"] == expected["entries"]
    assert summary["with_lineage"] == expected["with_lineage"]
    assert summary["standalone"] == expected["standalone"]
    assert summary["links_raw"] == expected["links_raw"]
    # The duplicate pair's three rows are one relationship.
    assert summary["links_distinct"] == expected["links_raw"] - 2
    assert summary["full_view_ok"] is False
    assert sum(summary["by_kind"].values()) == summary["links_raw"]
    assert summary["revision"] == 1


def test_a_song_with_only_artifacts_is_standalone(library):
    """A MIDI file is not a relative. Counting it as lineage would say
    thousands of untouched songs have a family."""
    summary = _stats(library).summary
    assert summary["standalone"] == len(library.ids.standalone) + 1


def test_a_connected_component_is_not_a_family(library):
    """The measured fact the whole design rests on: ``uses`` links weld
    unrelated trees into one huge component."""
    summary = _stats(library).summary
    assert summary["largest_connected"] == library.expected["largest_connected"]
    assert summary["largest_tree"] == library.expected["largest_tree"]
    assert summary["largest_connected"] > summary["largest_tree"] * 4


def test_the_summary_sends_the_limit_full_view_ok_was_decided_by(
    monkeypatch, small_library
):
    """LEARN's warning quotes ``full_view_limit``. It has to be the number
    ``full_view_ok`` was decided against, so a limit that moves moves both,
    and the warning never quotes a stale copy."""
    summary = _stats(small_library).summary
    assert summary["full_view_limit"] == graph.FULL_VIEW_LIMIT
    with_lineage = summary["with_lineage"]

    monkeypatch.setattr(graph, "FULL_VIEW_LIMIT", with_lineage - 1)
    moved = _stats(small_library).summary
    assert moved["full_view_limit"] == with_lineage - 1
    assert moved["full_view_ok"] is False

    monkeypatch.setattr(graph, "FULL_VIEW_LIMIT", with_lineage)
    at = _stats(small_library).summary
    assert at["full_view_limit"] == with_lineage
    assert at["full_view_ok"] is True


def test_full_view_ok_is_true_while_the_library_is_still_small(small_library):
    summary = _stats(small_library).summary
    assert summary["full_view_ok"] is True
    assert summary["entries"] == 4
    assert summary["standalone"] == 1
    assert summary["largest_tree"] == 3


def test_the_longest_chain_survives_two_thousand_generations_and_a_cycle(library):
    """Recursion would die at the default limit of 1,000 long before it got
    to the real library's depth; a cycle would never come back at all."""
    deepest = _stats(library).rankings["deepest"]
    assert deepest[0].id == library.ids.deep_deepest_leaf
    assert deepest[0].count == library.expected["deepest_depth"]
    assert deepest[0].detail

    cyclic, _via = graph.longest_ancestry_chains(
        {"a": [("b", "cover_of")], "b": [("a", "cover_of")]}
    )
    assert cyclic == {"a": 1, "b": 0} or cyclic == {"a": 0, "b": 1}


def test_most_derived_counts_distinct_children(library):
    rows = _stats(library).rankings["most_derived"]
    assert rows[0].id == library.ids.hub
    assert rows[0].count == HUB_CHILDREN
    assert "cover_of 400" in rows[0].detail


def test_most_derived_counts_one_child_linked_three_ways_once():
    """derived_from + edit_of + stem_of between one pair is one child. Counted
    per row it would be three, and the real library has 66,098 songs with 3-5
    outgoing links."""
    stats = graph.compute_library_stats(
        [
            ("child", "parent", "derived_from"),
            ("child", "parent", "edit_of"),
            ("child", "parent", "stem_of"),
        ],
        [("child", 2.0), ("parent", 1.0)],
        revision=7,
    )
    assert stats.summary["links_raw"] == 3
    assert stats.summary["links_distinct"] == 1
    assert stats.rankings["most_derived"][0].id == "parent"
    assert stats.rankings["most_derived"][0].count == 1


def test_mashup_sources_counts_distinct_products(library):
    rows = _stats(library).rankings["mashup_sources"]
    assert rows[0].id == library.ids.mashup_popular_source
    assert rows[0].count == library.expected["popular_source_users"]


def test_recent_is_the_song_whose_newest_child_is_newest(library):
    rows = _stats(library).rankings["recent"]
    assert rows[0].id == library.ids.recent_parent
    assert rows[0].detail.endswith("Z")


def test_a_ranked_list_breaks_ties_on_the_id_so_it_never_reshuffles(library):
    """Thousands of songs share a count. Without a tie-break the order is
    whatever the pass happened to build, and the landing page reshuffles
    under the user between two identical loads."""
    rows = _stats(library).rankings["most_derived"]
    for previous, current in zip(rows, rows[1:]):
        assert previous.count >= current.count
        if previous.count == current.count:
            assert previous.id < current.id
    again = _stats(library).rankings["most_derived"]
    assert [r.id for r in rows] == [r.id for r in again]


# ---------------------------------------------------------------- routes


def test_the_module_loads_through_the_real_autoloader_with_all_four_routes():
    from backend.modules.loader import load_modules

    modules_dir = Path(__file__).resolve().parents[1] / "backend" / "modules"
    app = FastAPI()
    manifests = load_modules(app, modules_dir)

    assert app.state.module_load_errors.get("lineagescale") is None
    manifest = next(m for m in manifests if m["name"] == "lineagescale")
    assert manifest["api_prefix"] == PREFIX
    # ``app.routes`` holds one opaque wrapper per included router in this
    # FastAPI; the generated schema is where the mounted paths are readable
    # (the same place ``tests/test_editor_tools.py`` looks).
    paths = set(app.openapi()["paths"])
    assert paths >= {
        f"{PREFIX}/summary",
        f"{PREFIX}/rankings",
        f"{PREFIX}/{{entry_id}}/neighbourhood",
        f"{PREFIX}/{{entry_id}}/relatives",
    }


def test_the_summary_route_answers_the_contract(monkeypatch, library):
    client = _client(monkeypatch, library)
    body = client.get(f"{PREFIX}/summary").json()
    assert set(body) == {
        "entries",
        "with_lineage",
        "standalone",
        "links_raw",
        "links_distinct",
        "by_kind",
        "largest_connected",
        "largest_tree",
        "full_view_ok",
        "full_view_limit",
        "revision",
        # A superset of the original contract: whether these numbers came
        # out of the cache or this request ran the pass for them.
        "warm",
    }
    assert body["entries"] == library.expected["entries"]
    # ``revision`` is the identity of the link signature, not the library
    # write counter: an identity to compare for equality, never for order.
    with lineage_router._Snapshot(library.db) as snap:
        assert body["revision"] == lineage_router._link_signature(snap).identity


def test_the_rankings_route_answers_every_list_and_refuses_the_rest(
    monkeypatch, library
):
    client = _client(monkeypatch, library)
    for name in graph.RANKING_LISTS:
        response = client.get(f"{PREFIX}/rankings", params={"list": name, "limit": 5})
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["list"] == name
        assert len(body["rows"]) <= 5
        for row in body["rows"]:
            assert set(row) == {
                "id",
                "title",
                "model",
                # T14: `source` is not decoration here either. The badge is
                # `(model, source)` together, and a landing list without this
                # field badged every Suno song -- whose model is `chirp-*` --
                # by the fallback's last arm.
                "source",
                "count",
                "detail",
            }
            assert row["title"]
    assert client.get(f"{PREFIX}/rankings", params={"list": "nope"}).status_code == 400


def test_a_ranked_row_carries_the_source_column_its_badge_needs(
    monkeypatch, tmp_path: Path
):
    """A Suno song in a ranked list is a Suno song.

    Its own library, built here rather than taken from the session fixture,
    because it is edited: the row is given the two columns the user's 194,000
    Suno rows carry (``source='suno'``, a ``chirp-*`` model) and the route must
    hand BOTH to the client. ``/neighbourhood`` and ``/relatives`` already do;
    ``/rankings`` sent `model` alone, so the badge saw
    ``{model: 'chirp-v4', source: undefined}`` and fell through to the
    fallback.
    """
    fixture = build_small_library(tmp_path / "library.db")
    try:
        ranked_id = fixture.ids.deep_root
        fixture.db._conn.execute(  # noqa: SLF001 - the fixture's own connection
            "UPDATE entries SET model = 'chirp-v4', source = 'suno' WHERE id = ?",
            (ranked_id,),
        )
        fixture.db._conn.commit()  # noqa: SLF001
        client = _client(monkeypatch, fixture)
        rows = client.get(f"{PREFIX}/rankings", params={"list": "most_derived"}).json()[
            "rows"
        ]
        row = next(r for r in rows if r["id"] == ranked_id)
        assert row["model"] == "chirp-v4"
        assert row["source"] == "suno"
    finally:
        fixture.close()


def test_the_neighbourhood_route_answers_the_contract(monkeypatch, library):
    client = _client(monkeypatch, library)
    response = client.get(
        f"{PREFIX}/{library.ids.hub}/neighbourhood",
        params={"up": 1, "down": 1, "budget": 400},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["focus"] == library.ids.hub
    assert body["budget"] == 400
    assert body["truncated"] is False
    focus_node = next(n for n in body["nodes"] if n["id"] == library.ids.hub)
    assert set(focus_node) == {
        "id",
        "title",
        "model",
        "source",
        "duration_sec",
        "play_count",
        "in_library",
        "generation",
    }
    assert focus_node["generation"] == 0
    assert focus_node["in_library"] is True
    assert {g["kind"] for g in body["groups"]} == {
        "cover_of",
        "edit_of",
        "upsample_of",
    }
    for edge in body["edges"]:
        assert set(edge) == {"from", "to", "kinds", "role"}


def test_an_id_that_is_only_a_link_endpoint_is_a_node_out_of_the_library(
    monkeypatch, library
):
    client = _client(monkeypatch, library)
    body = client.get(f"{PREFIX}/{library.ids.dangling_song}/neighbourhood").json()
    ghost = next(n for n in body["nodes"] if n["id"] == library.ids.dangling_source)
    assert ghost["in_library"] is False
    assert ghost["title"] == library.ids.dangling_source
    assert ghost["generation"] == -1
    # ... and it is a real destination, not a dead end.
    assert (
        client.get(f"{PREFIX}/{library.ids.dangling_source}/neighbourhood").status_code
        == 200
    )


def test_an_unknown_id_is_a_404(monkeypatch, library):
    client = _client(monkeypatch, library)
    assert client.get(f"{PREFIX}/no-such-song/neighbourhood").status_code == 404
    assert client.get(f"{PREFIX}/no-such-song/relatives").status_code == 404


def test_the_relatives_route_pages_sorts_and_counts(monkeypatch, library):
    client = _client(monkeypatch, library)
    base = f"{PREFIX}/{library.ids.hub}/relatives"
    first = client.get(base, params={"direction": "down", "limit": 100}).json()
    assert first["total"] == HUB_CHILDREN
    assert len(first["rows"]) == 100
    for row in first["rows"]:
        assert set(row) == {
            "id",
            "title",
            "model",
            # `source` is not decoration: the provider badge needs it, and a
            # legacy Suno import has an empty model, so a row without it is
            # badged Stable Audio.
            "source",
            "duration_sec",
            "play_count",
            "kinds",
        }
        assert row["source"] == "generate"

    second = client.get(
        base, params={"direction": "down", "limit": 100, "offset": 100}
    ).json()
    assert second["total"] == HUB_CHILDREN
    assert {r["id"] for r in first["rows"]}.isdisjoint(
        {r["id"] for r in second["rows"]}
    )

    titles = [r["title"] for r in first["rows"]]
    assert titles == sorted(titles, key=str.casefold)

    only_covers = client.get(
        base, params={"direction": "down", "kind": "cover_of"}
    ).json()
    assert only_covers["total"] == 400
    assert all(row["kinds"] == ["cover_of"] for row in only_covers["rows"])

    up = client.get(base, params={"direction": "up"}).json()
    assert [r["id"] for r in up["rows"]] == [library.ids.hub_parent]


def test_the_relatives_route_refuses_a_direction_sort_or_kind_it_cannot_serve(
    monkeypatch, library
):
    client = _client(monkeypatch, library)
    base = f"{PREFIX}/{library.ids.hub}/relatives"
    assert client.get(base, params={"direction": "sideways"}).status_code == 400
    assert client.get(base, params={"sort": "vibes"}).status_code == 400
    assert client.get(base, params={"kind": "not_a_kind"}).status_code == 400
    capped = client.get(base, params={"direction": "down", "limit": 5_000}).json()
    assert len(capped["rows"]) == graph.MAX_RELATIVES_LIMIT


def test_relatives_merges_duplicate_kinds_into_one_row(monkeypatch, library):
    client = _client(monkeypatch, library)
    body = client.get(
        f"{PREFIX}/{library.ids.duplicate_child}/relatives",
        params={"direction": "up"},
    ).json()
    assert body["total"] == 1
    assert body["rows"][0]["kinds"] == ["edit_of", "derived_from", "stem_of"]


def test_the_library_database_being_absent_is_a_503(monkeypatch):
    """Two guards, on purpose: the route refuses a store with no database,
    and a session refuses a database it cannot read. Either one alone still
    answers 503, so this asserts on every route rather than on one line."""
    store = StubStore(None)
    monkeypatch.setattr(lineage_router, "get_library_store", lambda: store)
    app = FastAPI()
    app.include_router(lineage_router.router, prefix=PREFIX)
    client = TestClient(app)
    assert client.get(f"{PREFIX}/summary").status_code == 503
    assert client.get(f"{PREFIX}/rankings").status_code == 503
    assert client.get(f"{PREFIX}/anything/neighbourhood").status_code == 503
    assert client.get(f"{PREFIX}/anything/relatives").status_code == 503


# ----------------------------------------------------------------- costs


def test_the_padding_in_the_fixture_is_real(library):
    """If the blob were thin, the test below would prove nothing."""
    assert METADATA_PAD_BYTES >= 8_000
    assert metadata_blob_size(library.db, library.ids.hub) >= 8_000


def test_no_statement_this_module_issues_reads_a_json_blob(monkeypatch, library):
    """Real rows carry ~34 KB of ``metadata_json``. One ``SELECT *`` over the
    entries table is the difference between a fast route and a 13-second one,
    and it is invisible in a test library of thin synthetic rows."""
    client = _client(monkeypatch, library)
    with _traced(monkeypatch, library) as statements:
        client.get(f"{PREFIX}/summary")
        client.get(f"{PREFIX}/rankings", params={"list": "most_derived"})
        client.get(f"{PREFIX}/{library.ids.hub}/neighbourhood")
        client.get(
            f"{PREFIX}/{library.ids.hub}/relatives", params={"direction": "down"}
        )

    assert statements, "the trace callback saw nothing, so it proved nothing"
    assert any("FROM relations" in s for s in statements), "the pass never ran"
    for statement in statements:
        lowered = " ".join(statement.lower().split())
        assert "_json" not in lowered, f"reads a blob column: {statement}"
        assert "select *" not in lowered, f"selects every column: {statement}"


def test_the_per_song_routes_never_read_a_whole_table(monkeypatch, library):
    """The cost rule, as an invariant rather than a stopwatch: one song's
    routes touch ``entries`` and ``relations`` only through an indexed
    filter. A whole-table read looks fine on a small test library and is the
    13-second route on the user's."""
    client = _client(monkeypatch, library)
    with _traced(monkeypatch, library) as statements:
        client.get(f"{PREFIX}/{library.ids.hub}/neighbourhood")
        client.get(
            f"{PREFIX}/{library.ids.hub}/relatives", params={"direction": "down"}
        )

    reads = [" ".join(statement.lower().split()) for statement in statements]
    assert reads, "the trace callback saw nothing, so it proved nothing"
    assert any("from relations" in sql for sql in reads), "no links were read"
    assert any("from entries" in sql for sql in reads), "no entries were read"
    for sql in reads:
        if "from entries" in sql or "from relations" in sql:
            assert " where " in sql, f"whole-table read: {sql}"


def test_a_hub_neighbourhood_and_a_relatives_page_are_fast(monkeypatch, library):
    """800 children is the real library's biggest fan. Both routes have to
    stay indexed and page-sized."""
    client = _client(monkeypatch, library)
    neighbourhood = f"{PREFIX}/{library.ids.hub}/neighbourhood"
    relatives = f"{PREFIX}/{library.ids.hub}/relatives"
    client.get(neighbourhood)
    client.get(relatives, params={"direction": "down"})

    # A full garbage collection first: in a long pytest run the heap holds
    # every module collected before, and a collection falling inside the
    # timed request measured the collector (about 150 ms), not the route.
    gc.collect()
    started = time.perf_counter()
    assert client.get(neighbourhood).status_code == 200
    neighbourhood_ms = (time.perf_counter() - started) * 1000

    gc.collect()
    started = time.perf_counter()
    assert client.get(relatives, params={"direction": "down"}).status_code == 200
    relatives_ms = (time.perf_counter() - started) * 1000

    assert neighbourhood_ms < 250, f"neighbourhood took {neighbourhood_ms:.0f} ms"
    assert relatives_ms < 250, f"relatives took {relatives_ms:.0f} ms"


def test_the_summary_is_computed_once_and_then_served_from_the_cache(
    monkeypatch, library
):
    client = _client(monkeypatch, library)
    passes = lineage_router._stats_cache.passes
    started = time.perf_counter()
    cold = client.get(f"{PREFIX}/summary")
    cold_seconds = time.perf_counter() - started
    assert cold.status_code == 200
    assert cold_seconds < prompt_seconds(3.0), (
        f"first summary took {cold_seconds:.2f} s"
    )

    warm = client.get(f"{PREFIX}/summary")
    # Every number is the same; the one thing that changes is the honest
    # report of which request paid for them.
    assert cold.json()["warm"] is False
    assert warm.json()["warm"] is True
    assert {k: v for k, v in warm.json().items() if k != "warm"} == {
        k: v for k, v in cold.json().items() if k != "warm"
    }
    assert lineage_router._stats_cache.passes == passes + 1, (
        "the warm request ran the pass"
    )

    # What the cache costs, timed apart from the test client. A TestClient
    # round trip to a route that does nothing takes 15-55 ms on a machine
    # that is also running the app, so a stopwatch around ``client.get``
    # measured the client and failed with the cache path at 8 ms. The cache
    # path is timed on its own, and the request is timed against the same
    # client's round trip to an empty route: best of five each, so one
    # scheduler hiccup does not decide it.
    def best_ms(call: Any) -> float:
        runs = []
        for _ in range(5):
            started = time.perf_counter()
            call()
            runs.append((time.perf_counter() - started) * 1000)
        return min(runs)

    cache_ms = best_ms(lambda: lineage_router._summary_sync(library.db))
    client.app.add_api_route("/empty", lambda: {})
    empty_ms = best_ms(lambda: client.get("/empty"))
    request_ms = best_ms(lambda: client.get(f"{PREFIX}/summary"))
    assert lineage_router._stats_cache.passes == passes + 1, (
        "a warm request ran the pass"
    )
    assert cache_ms < 20, f"the cached summary took {cache_ms:.1f} ms to serve"
    assert request_ms - empty_ms < 20, (
        f"the cached summary request took {request_ms:.1f} ms against "
        f"{empty_ms:.1f} ms for an empty route"
    )


def test_a_new_song_invalidates_the_cached_pass(monkeypatch, tmp_path):
    """A library that changed must not keep answering with yesterday's
    numbers, and one that did not must not pay for the pass again."""
    fixture = build_small_library(tmp_path / "library.db")
    try:
        client = _client(monkeypatch, fixture)
        before = client.get(f"{PREFIX}/summary").json()
        assert before["entries"] == 4

        fixture.db.upsert_entry({"id": "small-newcomer", "title": "newcomer"})
        after = client.get(f"{PREFIX}/summary").json()
        assert after["revision"] != before["revision"]
        assert after["entries"] == 5
        assert after["standalone"] == 2
    finally:
        fixture.close()


class _LockThatLetsAWriteIn:
    """The real lock, plus the one interleaving that matters.

    A signature read taken BEFORE the lock has already gone stale by the time
    the pass runs: any write landing in between is inside the pass's rows and
    outside its identity. The first acquisition IS that moment, so the write
    happens there.
    """

    def __init__(self, inner: Any, on_first_enter: Any) -> None:
        self._inner = inner
        self._on_first_enter = on_first_enter
        self.entries = 0

    def __enter__(self) -> bool:
        self._inner.acquire()
        self.entries += 1
        if self.entries == 1:
            self._on_first_enter()
        return True

    def __exit__(self, *exc_info: Any) -> bool:
        self._inner.release()
        return False

    def locked(self) -> bool:
        return self._inner.locked()


def test_the_signature_is_read_inside_the_lock_so_it_matches_the_rows(
    monkeypatch, tmp_path
):
    """The cache key has to describe the state the pass actually walked.

    Read before the lock, it can be older: the numbers then say one library
    and the identity stamped on them says another, so the next caller finds a
    mismatch and pays for the whole pass again -- and two callers straddling
    one write each run a pass, with the one holding the older identity
    overwriting the other's correct answer.
    """
    fixture = build_small_library(tmp_path / "library.db")
    try:
        real_signature = lineage_router._link_signature
        held_while_reading: list[bool] = []

        def hooked(snap: Any) -> Any:
            held_while_reading.append(lineage_router._stats_cache._lock.locked())
            return real_signature(snap)

        def write_a_link() -> None:
            fixture.db.add_relation(
                from_id="small-solo", to_id="small-root", kind="cover_of"
            )

        monkeypatch.setattr(lineage_router, "_link_signature", hooked)
        monkeypatch.setattr(
            lineage_router._stats_cache,
            "_lock",
            _LockThatLetsAWriteIn(lineage_router._stats_cache._lock, write_a_link),
        )

        body = lineage_router._summary_sync(fixture.db)

        assert held_while_reading == [True], (
            "the signature was read outside the lock, where a write can slip "
            "between it and the pass"
        )
        # The write landed before the pass, so the numbers include it ...
        assert body["links_raw"] == 3
        # ... and so must the identity they are stored under.
        with lineage_router._Snapshot(fixture.db) as snap:
            assert body["revision"] == real_signature(snap).identity, (
                "the cached numbers describe a newer library than their own "
                "revision, so the next caller recomputes all of it"
            )
    finally:
        fixture.close()


def test_the_read_only_connection_waits_out_a_busy_database(library):
    """A WAL checkpoint makes a reader briefly busy, and that has to be a wait
    rather than a 500 for a lock which clears in milliseconds.

    Pinned as this module's own number, not the driver's: ``sqlite3.connect``
    happens to set a 5 s busy_timeout from its default ``timeout`` argument,
    so without the pragma this passes only by accident and stops passing the
    day anyone passes ``timeout=0``.
    """
    with lineage_router._Snapshot(library.db) as snap:
        assert snap.isolated, "this pragma is about the module's OWN connection"
        assert (
            snap.read("PRAGMA busy_timeout")[0][0]
            == lineage_router.READONLY_BUSY_TIMEOUT_MS
        )
    assert lineage_router.READONLY_BUSY_TIMEOUT_MS > 0


# -------------------------------------------- the pass, and what wakes it


def test_the_library_wide_pass_does_not_hold_the_app_write_lock(library):
    """The pass reads every link -- 3.6 s on the real library. Taken on
    ``LibraryDB``'s connection it holds that database's write lock for the
    whole time and every write in the app queues behind it: a play-count
    bump, a save, an import, the read-path write-through.

    The lock is held here for real, by another thread, and released as soon
    as the assertion has been made, so a regression is a failed assertion
    rather than a hung test run.
    """
    lock = library.db._writelock  # noqa: SLF001 - the fixture's own lock
    holding = threading.Event()
    release = threading.Event()
    result: dict[str, Any] = {}

    def hold_the_lock() -> None:
        with lock:
            holding.set()
            release.wait(60)

    def run_the_pass() -> None:
        # ``_summary_sync`` is exactly what the route awaits; calling it
        # directly keeps the framework out of the measurement.
        result["summary"] = lineage_router._summary_sync(library.db)

    holder = threading.Thread(target=hold_the_lock, daemon=True)
    holder.start()
    assert holding.wait(10), "could not take the library write lock"

    worker = threading.Thread(target=run_the_pass, daemon=True)
    worker.start()
    worker.join(timeout=20)
    blocked = worker.is_alive()

    release.set()
    holder.join(10)
    worker.join(30)

    assert not blocked, "the pass waited for the library write lock"
    assert result["summary"]["entries"] == library.expected["entries"]


def test_the_pass_opens_its_own_connection_and_closes_it(tmp_path):
    """An open handle keeps the file locked on Windows, so deleting it is
    the proof there is no leak."""
    path = tmp_path / "library.db"
    fixture = build_small_library(path)
    with lineage_router._Snapshot(fixture.db) as snap:
        assert snap.isolated, "the pass should not be sharing the app connection"
        assert lineage_router._link_signature(snap).entries == 4
    assert lineage_router._summary_sync(fixture.db)["entries"] == 4
    fixture.close()
    path.unlink()
    assert not path.exists()


def test_a_database_that_cannot_be_opened_read_only_still_answers(
    monkeypatch, tmp_path
):
    """The fallback is not decoration: an in-memory database in a test, or a
    SQLite build that refuses read-only WAL, still has to get an answer."""
    fixture = build_small_library(tmp_path / "library.db")
    try:
        monkeypatch.setattr(lineage_router, "_open_readonly", lambda db: None)
        with lineage_router._Snapshot(fixture.db) as snap:
            assert snap.isolated is False
        assert lineage_router._summary_sync(fixture.db)["entries"] == 4
    finally:
        fixture.close()


def test_a_play_count_or_a_title_edit_does_not_rerun_the_pass(monkeypatch, tmp_path):
    """``library_revision`` moves on every write, so keying the cache on it
    means a user pressing play with the landing page open pays a full pass
    each time. The link graph did not change, so the numbers must not be
    recomputed -- and the new title must still be on screen, because the
    cache holds ids and counts and never a display column."""
    fixture = build_small_library(tmp_path / "library.db")
    try:
        client = _client(monkeypatch, fixture)
        client.get(f"{PREFIX}/rankings", params={"list": "most_derived"})
        passes = lineage_router._stats_cache.passes
        revision_before = fixture.db.library_revision()

        fixture.db.increment_play_count("small-child")
        fixture.db.upsert_entry({"id": "small-root", "title": "a brand new name"})
        assert fixture.db.library_revision() > revision_before, (
            "the library write counter must have moved, or this proves nothing"
        )

        body = client.get(f"{PREFIX}/rankings", params={"list": "most_derived"}).json()
        assert lineage_router._stats_cache.passes == passes, "the pass ran again"
        assert "a brand new name" in {row["title"] for row in body["rows"]}
    finally:
        fixture.close()


def test_a_new_link_does_rerun_the_pass(monkeypatch, tmp_path):
    fixture = build_small_library(tmp_path / "library.db")
    try:
        client = _client(monkeypatch, fixture)
        first = client.get(f"{PREFIX}/summary").json()
        passes = lineage_router._stats_cache.passes

        fixture.db.add_relation(
            from_id="small-solo", to_id="small-root", kind="cover_of"
        )
        second = client.get(f"{PREFIX}/summary").json()

        assert lineage_router._stats_cache.passes == passes + 1
        assert second["revision"] != first["revision"]
        assert second["links_raw"] == first["links_raw"] + 1
        assert second["standalone"] == 0
    finally:
        fixture.close()


def test_two_first_calls_at_once_compute_once(library):
    """Four threads arriving on a cold cache must not start four passes over
    half a million links."""
    lineage_router._stats_cache.clear()
    passes = lineage_router._stats_cache.passes
    answers: list[dict[str, Any]] = []
    errors: list[BaseException] = []

    def call() -> None:
        try:
            answers.append(lineage_router._summary_sync(library.db))
        except BaseException as exc:  # noqa: BLE001 - re-raised through `errors`
            errors.append(exc)

    threads = [threading.Thread(target=call, daemon=True) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(60)
        assert not thread.is_alive()

    assert not errors, errors
    assert lineage_router._stats_cache.passes == passes + 1
    assert len(answers) == 4
    # One pass, so exactly one of the four says it ran it; the numbers the
    # other three waited for are the same numbers.
    assert [a["warm"] for a in answers].count(False) == 1
    stripped = [{k: v for k, v in a.items() if k != "warm"} for a in answers]
    assert all(answer == stripped[0] for answer in stripped)


def test_the_link_signature_is_cheap(library):
    """It runs on every request, so it has to be index lookups rather than a
    second pass wearing a hat."""
    with lineage_router._Snapshot(library.db) as snap:
        plan = [
            " ".join(str(part) for part in row)
            for row in snap.read("EXPLAIN QUERY PLAN " + lineage_router._SIGNATURE_SQL)
        ]
        assert plan
        for step in plan:
            if "relations" in step or "entries" in step:
                assert "INDEX" in step or "SEARCH" in step, step
        lineage_router._link_signature(snap)
        started = time.perf_counter()
        for _ in range(5):
            lineage_router._link_signature(snap)
        each_ms = (time.perf_counter() - started) * 1000 / 5
    assert each_ms < 5, f"the signature cost {each_ms:.2f} ms"


# ------------------------------------------------ warming it at startup


def _registered_startup_warm() -> Any:
    """The hook the router registered when it was imported, by name.

    Looked up rather than called through ``run_startup_hooks()``: that runs
    EVERY module's hook, and one of them spawns the underfit sidecar. This
    still drives the real registration, which is the part that decides
    whether the warm happens at all.
    """
    from backend.core import startup as core_startup

    hooks = dict(core_startup._hooks)  # noqa: SLF001 - the registry's own list
    assert "lineagescale-warm" in hooks, "the router registered no startup warm"
    return hooks["lineagescale-warm"]


def _run_startup_warm(monkeypatch: pytest.MonkeyPatch, timeout: float = 60.0) -> None:
    """Fire the registered hook with its delay taken out, and wait for it."""
    monkeypatch.setattr(lineage_router, "WARM_DELAY_SEC", 0.0)
    _registered_startup_warm()()
    thread = lineage_router._warm_thread
    assert thread is not None, "the hook started no thread"
    thread.join(timeout)
    assert not thread.is_alive(), "the warm thread never finished"


def test_the_startup_warm_fills_the_cache_before_the_first_request(
    monkeypatch, small_library
):
    """The whole point: the first LEARN open after a restart is 60 ms, not
    the 8.6 s the pass costs on the real library."""
    client = _client(monkeypatch, small_library)
    before = lineage_router._stats_cache.passes

    _run_startup_warm(monkeypatch)

    assert lineage_router._stats_cache.passes == before + 1, "the warm ran no pass"
    body = client.get(f"{PREFIX}/summary").json()
    assert body["warm"] is True
    assert body["entries"] == 4
    assert lineage_router._stats_cache.passes == before + 1, (
        "the request recomputed what the warm had already computed"
    )


def test_the_startup_warm_waits_for_the_search_index_build(monkeypatch, small_library):
    """A library-wide pass beside the search index build starves the request
    threads of the interpreter, so the warm runs after the build ends."""
    _client(monkeypatch, small_library)
    db = small_library.db
    before = lineage_router._stats_cache.passes
    db._search_built.clear()
    try:
        thread = threading.Thread(target=lineage_router.warm_stats_cache, daemon=True)
        thread.start()
        thread.join(0.5)
        assert thread.is_alive(), "the warm ran while the index build was still going"
        assert lineage_router._stats_cache.passes == before
    finally:
        db._search_built.set()
    thread.join(30.0)
    assert not thread.is_alive(), "the warm never ran after the build ended"
    assert lineage_router._stats_cache.passes == before + 1


def test_the_startup_warm_does_nothing_without_a_library_database(monkeypatch, caplog):
    """A launch where the library never came up. Warming a cache for it
    would be inventing an answer, and failing would take the app down from
    a daemon thread."""
    monkeypatch.setattr(lineage_router, "get_library_store", lambda: StubStore(None))
    caplog.set_level(logging.DEBUG, logger="backend.modules.lineagescale.router")
    before = lineage_router._stats_cache.passes

    _run_startup_warm(monkeypatch)

    assert lineage_router._stats_cache.passes == before
    # This module's own logger only: an unrelated WARNING from anywhere else
    # in the app is not evidence about this warm.
    assert not [
        r
        for r in caplog.records
        if r.levelno >= logging.WARNING and r.name == _ROUTER_LOGGER
    ], "a library that is simply absent is not a failure"


def test_a_warm_that_fails_logs_once_and_leaves_the_routes_working(
    monkeypatch, caplog, tmp_path
):
    fixture = build_small_library(tmp_path / "library.db")
    try:
        client = _client(monkeypatch, fixture)
        failing = {"on": True}
        real_open = lineage_router._open_readonly

        def flaky(db: Any) -> Any:
            if failing["on"]:
                raise sqlite3.OperationalError("disk I/O error")
            return real_open(db)

        monkeypatch.setattr(lineage_router, "_open_readonly", flaky)
        caplog.set_level(logging.WARNING, logger="backend.modules.lineagescale.router")

        _run_startup_warm(monkeypatch)

        complaints = [
            r
            for r in caplog.records
            if r.levelno >= logging.WARNING and r.name == _ROUTER_LOGGER
        ]
        assert len(complaints) == 1, complaints

        failing["on"] = False
        body = client.get(f"{PREFIX}/summary").json()
        assert body["entries"] == 4
        # Nothing was warmed, so this request is the one that pays.
        assert body["warm"] is False
    finally:
        fixture.close()


def test_a_warm_that_cannot_open_its_own_connection_declines(monkeypatch, tmp_path):
    """The request path falls back to ``LibraryDB``'s connection under its
    write lock, because a request has to be answered. A warm nobody asked
    for does not get that licence: a 3.6 s pass under that lock stalls every
    write in the app."""
    fixture = build_small_library(tmp_path / "library.db")
    try:
        monkeypatch.setattr(
            lineage_router, "get_library_store", lambda: StubStore(fixture.db)
        )
        monkeypatch.setattr(lineage_router, "_open_readonly", lambda db: None)
        before = lineage_router._stats_cache.passes

        assert lineage_router.warm_stats_cache() is False
        assert lineage_router._stats_cache.passes == before
    finally:
        fixture.close()


def test_the_startup_warm_does_not_hold_the_app_write_lock(monkeypatch, library):
    """Same technique as the request-path lock test above: the lock is held
    for real, by another thread, so a regression is a failed assertion
    rather than a hung run."""
    monkeypatch.setattr(
        lineage_router, "get_library_store", lambda: StubStore(library.db)
    )
    lock = library.db._writelock  # noqa: SLF001 - the fixture's own lock
    holding = threading.Event()
    release = threading.Event()
    result: dict[str, Any] = {}

    def hold_the_lock() -> None:
        with lock:
            holding.set()
            release.wait(60)

    holder = threading.Thread(target=hold_the_lock, daemon=True)
    holder.start()
    assert holding.wait(10), "could not take the library write lock"

    def run_the_warm() -> None:
        result["warmed"] = lineage_router.warm_stats_cache()

    worker = threading.Thread(target=run_the_warm, daemon=True)
    worker.start()
    worker.join(timeout=20)
    blocked = worker.is_alive()

    release.set()
    holder.join(10)
    worker.join(30)

    assert not blocked, "the warm waited for the library write lock"
    assert result["warmed"] is True
