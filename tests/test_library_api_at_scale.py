"""The library API, priced on a library the size of a real one.

Two features passed every test in this repository and then broke on the user's
library (194,508 entries, ~34 KB of ``metadata_json`` a row, 475,174
relations): the provider filter read every row's blob (13.3 s for one page)
and the LEARN tab fetched the whole lineage graph (128 MB, then a crash).
Every existing fixture writes a two-byte metadata blob, so at that weight a
query that reads every row looks free.

This module is the guard that would have caught both. It drives the real
routers over :mod:`tests.library_scale_fixture` -- 20,000 entries, ~8 KB of
metadata each, ~50,000 relations -- and holds them to three rules:

1. **Every GET answers.** Enumerated from ``app.routes``, not from a list
   someone has to remember to extend, so a route added tomorrow is measured
   tomorrow. Status under 500, response under
   :data:`SIZE_BUDGET_BYTES`, wall time under :data:`TIME_BUDGET_SECONDS`.
2. **Nothing whole-library is allowed to grow with the library.** The size
   budget's exceptions are named in :data:`SIZE_ALLOWLIST`, each with its
   reason. One more response does grow with the library -- ``GET /entries``
   with no parameters, the documented pre-paging shape -- and rather than
   being allowlisted away it keeps its own test, which asserts the shape we
   WANT under a strict xfail, so the day it improves the build says "good
   news, remove the marker" instead of going red.
3. **The invariant, not the stopwatch.** A machine's speed is not a
   guarantee; a trace callback is. The paged list, its count, the id list,
   the facets and every lineage-scale route must not execute a single
   statement that opens a blob -- either by naming a blob column or by
   selecting every column of ``entries`` -- outside the documented
   exceptions (:data:`_BLOB_READ_EXCEPTIONS`).

Rule 3 is the one that bites on a fast machine, and it is the one that caught
the planted regression: putting ``json_extract(e.metadata_json, '$.provider')``
back into ``PROVIDER_SQL`` fails
``test_the_list_routes_never_open_a_blob_column`` on this fixture whatever the
hardware does.

Every id, title, provider slug and path here is invented by the fixture
module. Nothing reads, writes or names anything in anyone's library.

**Run it with a basetemp on a drive that has room.** The fixture writes about
400 MB (a ~340 MB database plus a 20,000-directory tree), and pytest's default
basetemp is on the system drive, which is how a run of this module once filled
a developer's ``C:`` to zero. Pass the flag::

    uv run pytest --basetemp=D:/theDAW-pytest-tmp/s3r2 tests/test_library_api_at_scale.py

On Windows the module refuses to build on ``%SystemDrive%`` -- it skips, loudly,
naming that flag -- rather than filling it (see :func:`_require_roomy_basetemp`).
The check is Windows-only: on the Linux runner, whose single drive is its root
filesystem and whose image is thrown away after the job, nothing changes.
"""

from __future__ import annotations

import os
import re
import shutil
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.lib import known_paths, paths
from backend.modules.assets import router as assets_router_module
from backend.modules.library import router as library_router_module
from backend.modules.lineagescale import router as lineagescale_router_module
from tests.library_scale_fixture import (
    COMMON_ID,
    ENTRIES,
    HUB_ID,
    RARE_PROVIDER,
    SEARCH_WORD,
    STEM_ID,
    ScaleLibrary,
    build_scale_library,
    database_bytes,
    remove_database,
)

LIBRARY_PREFIX = "/api/library"
LINEAGE_PREFIX = "/api/lineage-scale"
ASSETS_PREFIX = "/api/assets"
PREFIXES = (LIBRARY_PREFIX, LINEAGE_PREFIX, ASSETS_PREFIX)

#: No whole-library response may exceed this. The LEARN crash was a 128 MB
#: body; 2 MB is already far more than any single view can draw.
SIZE_BUDGET_BYTES = 2 * 1024 * 1024

#: Wall time per route. Deliberately loose -- this is a smoke ceiling for a
#: route that has gone quadratic, not a benchmark. The real guarantee is the
#: trace test below, which does not depend on how fast this machine is.
#: A route that has gone quadratic on this fixture takes tens of seconds, so
#: 5 s costs the ceiling no teeth and leaves room for a 2-vCPU CI runner,
#: where ``/_graph/all`` (886 ms here) and a cold ``/rankings`` are the slow
#: pair. ``THEDAW_SCALE_TIME_BUDGET`` raises it on a machine that needs more.
TIME_BUDGET_SECONDS = float(os.environ.get("THEDAW_SCALE_TIME_BUDGET", "5.0"))

#: The ONLY routes allowed past :data:`SIZE_BUDGET_BYTES`, each with the
#: reason it is allowed. Every one is documented, every one is deliberate,
#: and nothing else may join without a line here.
SIZE_ALLOWLIST: dict[str, str] = {
    f"{LIBRARY_PREFIX}/_graph/all": (
        "the pre-LEARN whole-library graph: one node per entry by design, "
        "which is exactly the shape that crashed the browser at 194,508 -- "
        "pinned by its own test below rather than capped here"
    ),
    f"{LIBRARY_PREFIX}/{{entry_id}}/bundle": (
        "a zip of one entry AND the vendored Unity package: its size is a "
        "function of what is checked into this repository, not of how big "
        "the library is, so holding it to the library budget would measure "
        "the wrong thing -- the allowlist ceiling still holds it to a size"
    ),
    f"{LIBRARY_PREFIX}/{{entry_id}}/lineage/full": (
        "the whole family of one entry, uncapped on purpose: Save lineage "
        "writes it, and INFO loads it only when the user presses Load the "
        "whole family, while every screen reads the capped /lineage on its "
        "own. It streams while the walk runs, so the server never holds the "
        "whole answer; its size is the family's, and the allowlist ceiling "
        "still holds it to a size"
    ),
}

#: A ceiling for the allowlisted routes anyway, so 'unbounded' still
#: cannot mean 'unbounded'. Sized off this fixture, which is a tenth of the
#: real library.
ALLOWLIST_SIZE_CEILING_BYTES = 64 * 1024 * 1024

#: Columns that hold a blob a query must never open. ``metadata_json`` is the
#: one that cost 13.3 s; the rest are the same mistake waiting on the
#: analysis tables.
BLOB_COLUMNS = (
    "metadata_json",
    "raw_json",
    "embedded_tags_json",
    "beats_json",
    "semantic_tags_json",
)

#: The routes rule 3 covers: everything whose cost must be independent of how
#: fat a row is. Each list route is probed searched as well as unsearched:
#: ``LibraryDB._text_match_sql`` has a documented non-fts5 fallback, an
#: ``instr`` scan of the search text tables, and an unsearched sweep never
#: reaches it. :data:`SEARCH_WORD` is in every fixture title, so the searched
#: probes match all 20,000 rows.
LIST_ROUTE_PATHS = (
    f"{LIBRARY_PREFIX}/entries?limit=50",
    f"{LIBRARY_PREFIX}/entries?limit=50&provider={RARE_PROVIDER}",
    f"{LIBRARY_PREFIX}/entries?limit=50&sort=plays_desc",
    f"{LIBRARY_PREFIX}/entries?limit=50&favorite=true",
    f"{LIBRARY_PREFIX}/entries?limit=50&q={SEARCH_WORD}",
    f"{LIBRARY_PREFIX}/entries/ids",
    f"{LIBRARY_PREFIX}/entries/ids?q={SEARCH_WORD}",
    f"{LIBRARY_PREFIX}/entries/facets?fields=model,provider,source,kind",
    f"{LIBRARY_PREFIX}/entries/facets?fields=provider&q={SEARCH_WORD}",
    f"{LIBRARY_PREFIX}/entries/facets?fields=provider&provider={RARE_PROVIDER}",
    f"{LINEAGE_PREFIX}/summary",
    f"{LINEAGE_PREFIX}/rankings",
    f"{LINEAGE_PREFIX}/{HUB_ID}/neighbourhood",
    f"{LINEAGE_PREFIX}/{HUB_ID}/relatives?direction=down",
)


def _normalise(statement: str) -> str:
    return " ".join(statement.lower().split())


def _match_total(path: str, body: Any) -> int:
    """How many rows a list route's answer says its filters matched.

    ``/entries`` and ``/entries/ids`` both report ``total``; ``/entries/facets``
    reports counts per value, which sum to the matched set (its cap applies per
    field, and a probe of one field cannot reach it here).
    """
    if "/entries/facets" in path:
        return sum(
            int(value["count"])
            for values in body["facets"].values()
            for value in values
        )
    return int(body["total"])


#: Any column whose name ends in ``_json`` -- the blob columns of
#: :data:`BLOB_COLUMNS` and whichever one a table grows next.
_JSON_COLUMN_RE = re.compile(r"\b\w*_json\b")


def _names_a_json_column_outside_the_projection(statement: str) -> bool:
    """A blob column named somewhere OTHER than the select list.

    Both exceptions below are about a projection over rows already chosen: the
    page's ~50 whole rows, or the page's ids. Neither is about a PREDICATE that
    opens a blob, and a predicate is what decides how many rows get read. The
    non-fts5 search fallback is exactly that shape -- ``SELECT e.* ... WHERE
    (... json_extract(e.metadata_json, '$.lyrics') LIKE ?) ... LIMIT ? OFFSET
    ?`` -- and it opens all 20,000 blobs to return 50 rows, so the page shape
    must not buy it an exception.

    The shipped page statement stays clean: ``list_entries_page``'s only
    non-trivial predicate is ``PROVIDER_SQL``, and that expression (``db.py``,
    ``_PROVIDER_RESOLVED_TEMPLATE`` over ``_PROVIDER_FALLBACK_TEMPLATE``) reads
    ``e.provider``, ``e.model`` and ``e.source`` and nothing else -- the whole
    reason the provider column exists. Read it before relaxing this.
    """
    # Every select list replaced by a marker that keeps the SQL's shape and
    # carries no column name, so `json_extract(metadata_json, ?) AS j0` in a
    # projection is invisible here and the same call in a WHERE is not.
    remainder = _SELECT_LIST_RE.sub(" select from ", statement)
    if _JSON_COLUMN_RE.search(remainder):
        return True
    # A predicate can hold a SELECT of its own, and blanking every select list
    # blanks that one too -- ``WHERE ? IN (SELECT json_extract(metadata_json,
    # '$.lyrics') FROM entries)`` reads every row's blob and leaves a clean
    # remainder behind. So everything from the first WHERE onward is checked
    # RAW: nothing after it is a projection of the rows being chosen.
    _, where, predicate = statement.partition(" where ")
    return bool(where) and bool(_JSON_COLUMN_RE.search(predicate))


#: A ``LIMIT`` of any kind, and the paged list's ``LIMIT ? OFFSET ?`` shape.
#: The second is what ``list_entries_page`` (``db.py``) actually emits, so an
#: exception written against it cannot be borrowed by a statement that merely
#: contains the word "limit" somewhere -- in a column name, a string literal,
#: or a subquery that bounds nothing the outer scan does.
_LIMIT_RE = re.compile(r"\blimit\b\s*(?:\?|\d+)")
_PAGE_LIMIT_RE = re.compile(r"\blimit\b\s*(?:\?|\d+)\s*offset\s*(?:\?|\d+)")


def _is_paged_list_row_read(statement: str) -> bool:
    """The paged list's OWN row read: the page's ~50 rows, and only those.

    ``LibraryDB`` projects chosen metadata keys (lyrics, and friends) for the
    ids already on the page with ``json_extract(metadata_json, ?) AS j<n>``.
    That is bounded by the page size, not by the table, which is the whole
    distinction this exception draws -- so the bound is required here rather
    than assumed: the ids are named (``WHERE id IN (...)``) or the statement
    carries a ``LIMIT``. The same projection over the whole table, which is
    what a new caller reaching for it without a page would write, opens 20,000
    blobs and is not this exception.
    """
    if "json_extract(metadata_json" not in statement or " as j" not in statement:
        return False
    if _names_a_json_column_outside_the_projection(statement):
        return False
    return "where id in" in statement or bool(_LIMIT_RE.search(statement))


def _is_single_entry_read(statement: str) -> bool:
    """The single-entry GET: one row, by id, blob and all.

    ``GET /entries/{id}`` exists to return an entry's metadata. Reading one
    row's blob is the request, not a leak.
    """
    return "from entries" in statement and "where id =" in statement


#: The select list: everything between ``SELECT`` and its ``FROM``. Non-greedy
#: and found repeatedly, so a subquery's own select list is examined as itself
#: rather than swallowing the outer one.
_SELECT_LIST_RE = re.compile(r"\bselect\b(.*?)\bfrom\b")

#: A star ANYWHERE in a select list -- ``*``, ``e.*``, or ``e.id, e.*``, which
#: an anchored ``select\s+\*`` pattern reads straight past. ``count(*)`` does
#: not match (the lookbehind excludes a star that opens a function's argument
#: list) and neither does a named column list, which is the point.
_STAR_RE = re.compile(r"\.\*|(?<![\w.(])\*")

#: ``FROM entries``, the table -- bounded so it is not also satisfied by
#: ``FROM entries_search`` (the fts5 index) or its text tables, which hold no
#: blob and whose rows are not rows of ``entries``.
_ENTRIES_TABLE_RE = re.compile(r"\bfrom\s+entries\b")


def _selects_every_entries_column(statement: str) -> bool:
    """A statement that reads every column of ``entries`` without saying so.

    ``LibraryDB.list_entries`` (``SELECT * FROM entries ORDER BY created_at
    DESC``), ``list_entries_filtered`` and ``list_entries_page`` (``SELECT
    e.* FROM entries e``) all carry ``metadata_json`` back for every row they
    touch, and none of them names it -- so a rule matching column names alone
    cannot see them, and a facet or a count quietly routed through
    ``list_entries()`` would read 20,000 blobs and pass.
    """
    if not _ENTRIES_TABLE_RE.search(statement):
        return False
    return any(
        _STAR_RE.search(select_list)
        for select_list in _SELECT_LIST_RE.findall(statement)
    )


def _is_paged_star_row_read(statement: str) -> bool:
    """The paged list's whole-row read, bounded by its own ``LIMIT``.

    ``list_entries_page`` is ``SELECT e.* ... LIMIT ? OFFSET ?``: whole rows,
    blob and all, for the page's ~50 ids. The page is the entire reason it is
    allowed, so a blob column named anywhere but the select list forfeits it
    (:func:`_names_a_json_column_outside_the_projection`): a WHERE that opens
    every row's blob to pick 50 is the 13.3 s bug with a LIMIT bolted on. Past
    that this exception requires the page's shape -- ``LIMIT`` followed
    by ``OFFSET``, both bound -- and not merely the word "limit" somewhere in
    the statement, which any whole-table ``SELECT e.*`` can carry in a column
    name or a literal. ``list_entries()``'s unbounded ``SELECT * FROM
    entries`` has neither and stays an offender.
    """
    if _names_a_json_column_outside_the_projection(statement):
        return False
    return _selects_every_entries_column(statement) and bool(
        _PAGE_LIMIT_RE.search(statement)
    )


#: The exception set, explicit and closed. Anything else that opens a blob
#: inside a list route is a regression.
_BLOB_READ_EXCEPTIONS = (
    ("the paged list's own row read", _is_paged_list_row_read),
    ("the single-entry GET", _is_single_entry_read),
    ("the paged list's bounded whole-row read", _is_paged_star_row_read),
)


def _blob_offenders(statements: list[str]) -> list[str]:
    """Statements that open a blob and are not one of the exceptions.

    "Open a blob" is either naming one of :data:`BLOB_COLUMNS` or selecting
    every column of ``entries``, which reads ``metadata_json`` without ever
    naming it.
    """
    offenders: list[str] = []
    for statement in statements:
        lowered = _normalise(statement)
        opens_blob = any(
            column in lowered for column in BLOB_COLUMNS
        ) or _selects_every_entries_column(lowered)
        if not opens_blob:
            continue
        if any(matches(lowered) for _, matches in _BLOB_READ_EXCEPTIONS):
            continue
        offenders.append(lowered[:400])
    return offenders


#: The two whole-table passes ``_StatsCache.get`` runs, verbatim as the trace
#: callback sees them once normalised. That cache is a module singleton, so a
#: warm slot skips both passes -- and a trace test that only checks "no blob
#: column" then passes having exercised nothing at all. The trace test
#: asserts both of these appeared, and compares them for EQUALITY: the first
#: is a prefix of ``_link_fetcher``'s bounded ``... WHERE from_id IN (?, ...)``
#: (``lineagescale/router.py``), which neighbourhood and relatives run on
#: every call, so a substring test is satisfied by a warm cache and proves
#: nothing about the whole-table pass it is named for.
LINEAGE_STATS_STREAMS = (
    "select from_id, to_id, kind from relations",
    "select id, created_at from entries",
)


# ---------------------------------------------------------------------------
# The app, and the routes enumerated out of it
# ---------------------------------------------------------------------------


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(library_router_module.router, prefix=LIBRARY_PREFIX)
    app.include_router(lineagescale_router_module.router, prefix=LINEAGE_PREFIX)
    app.include_router(assets_router_module.router, prefix=ASSETS_PREFIX)
    return app


def _walk_get_paths(routes: Any, prefix: str) -> Iterator[str]:
    """Every GET path under ``routes``, following FastAPI's lazy includes.

    A modern ``include_router`` leaves ONE wrapper object in ``app.routes``
    holding the original router, not the expanded routes, so a walk that only
    reads ``route.path`` finds four ``/docs`` entries and nothing else.
    """
    for route in routes:
        included = getattr(route, "original_router", None)
        if included is not None:
            context = getattr(route, "include_context", None)
            inner_prefix = prefix + (getattr(context, "prefix", "") or "")
            yield from _walk_get_paths(included.routes, inner_prefix)
            continue
        path = getattr(route, "path", "")
        methods = getattr(route, "methods", None) or frozenset()
        if path and "GET" in methods:
            yield prefix + path


def _get_route_templates() -> tuple[str, ...]:
    paths = set(_walk_get_paths(_build_app().routes, ""))
    return tuple(sorted(p for p in paths if p.startswith(PREFIXES)))


#: Path parameters, resolved to ids the fixture actually has. ``entry_id``
#: gets two -- an ordinary song and the hub -- because a fan of hundreds is
#: the shape a per-song route can go quadratic on. The rest are ids no
#: library has, so those routes answer 404, which is a perfectly good
#: sub-500 answer and still prices the lookup.
_PARAM_VALUES: dict[str, tuple[str, ...]] = {
    "entry_id": (COMMON_ID, HUB_ID),
    "stem_id": (STEM_ID,),
    "job_id": ("scale-no-such-import-job",),
    "asset_id": ("scale-no-such-asset",),
    # `/api/lineage-scale/explore/kinds/{kind}` — a relation kind, not an id.
    # `derived_from` is the library's commonest kind (164,779 links in the real
    # one), so the probe measures the expensive answer rather than an empty one.
    "kind": ("derived_from",),
}


#: Query strings the enumerated probe sends, and the only one there is.
#: ``GET /entries`` with no parameters at all is documented in the router as
#: the pre-paging shape: every entry of the kind, for callers older than
#: paging. Probing it bare would measure that legacy dump instead of the
#: paged list every current client asks for -- so the dump gets pinned by its
#: own test (``test_the_unpaged_entries_list_is_not_a_full_dump``) and the
#: enumerated probe asks the way the app asks.
#: ``/entries/facets`` is the other one: ``fields`` is required, so a bare
#: probe is a 422 that measures the validator instead of the four
#: whole-library GROUP BYs this route is the reason to be afraid of.
_QUERY_DEFAULTS: dict[str, str] = {
    f"{LIBRARY_PREFIX}/entries": "limit=200",
    f"{LIBRARY_PREFIX}/entries/facets": "fields=model,provider,source,kind",
}


def _fill(template: str) -> list[str]:
    """Every concrete path ``template`` stands for, or [] if it needs an id
    this module has no value for -- which fails ``test_every_get_route_has_an
    _id_to_probe_with`` rather than skipping quietly."""
    filled = [template]
    for name, values in _PARAM_VALUES.items():
        token = "{" + name + "}"
        if not any(token in path for path in filled):
            continue
        filled = [path.replace(token, value) for path in filled for value in values]
    if "{" in "".join(filled):
        return []
    query = _QUERY_DEFAULTS.get(template)
    if query:
        filled = [f"{path}?{query}" for path in filled]
    return filled


ROUTE_TEMPLATES = _get_route_templates()
ROUTE_CASES = tuple(
    (template, path) for template in ROUTE_TEMPLATES for path in _fill(template)
)

#: Filled in by the budget test, printed by the report at the end. A plain
#: dict, because the tests run in file order in one process.
_MEASURED: dict[str, tuple[float, int, int]] = {}

#: The library revision as it stood before the first probe, recorded by the
#: client fixture so ``test_the_read_probes_did_not_write`` can prove that no
#: GET in the sweep committed anything.
_REVISION_AT_START: list[int] = []


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _require_roomy_basetemp(base: Path) -> None:
    """Refuse to build ~400 MB on the Windows system drive.

    Nothing in pytest pins where ``tmp_path_factory`` lands, and the default is
    under the system drive's temp directory -- which is how a run of this module
    once took a developer's ``C:`` to zero bytes free. On Windows, where that
    drive is the one with the OS and the page file on it, an unset
    ``--basetemp`` skips the module and says which flag to pass. Elsewhere (the
    Linux runner, whose root filesystem is the only one it has and whose image
    is discarded after the job) the check does not apply.
    """
    if os.name != "nt":
        return
    system_drive = os.environ.get("SystemDrive", "C:").rstrip("\\/")
    if base.resolve().drive.upper() != system_drive.upper():
        return
    pytest.skip(
        f"this fixture writes ~400 MB and the basetemp is on {system_drive} "
        "(the system drive). Re-run with a basetemp on another drive, e.g. "
        "--basetemp=D:/theDAW-pytest-tmp/s3r2, and delete it afterwards."
    )


@pytest.fixture(scope="module")
def scale_library(tmp_path_factory: pytest.TempPathFactory) -> Iterator[ScaleLibrary]:
    """The 20,000-entry library, built once for the whole module.

    The build is inside the ``try``: it opens a ~400 MB database well before
    it has finished filling it, so a raise past that point must still close
    the handle and delete the file. The 20,000-directory disk tree goes in
    the same ``finally`` -- ``remove_database`` only ever knew about the
    database -- rather than waiting for whoever clears the basetemp.
    """
    _require_roomy_basetemp(tmp_path_factory.getbasetemp())
    root = tmp_path_factory.mktemp("library-at-scale")
    built: ScaleLibrary | None = None
    try:
        built = build_scale_library(root)
        yield built
    finally:
        if built is not None:
            built.close()
            remove_database(built.db_path)
        shutil.rmtree(root, ignore_errors=True)


@pytest.fixture(scope="module")
def client(scale_library: ScaleLibrary) -> Iterator[TestClient]:
    """The real routers, over the fixture's root.

    One warm-up request before anything is measured: the first request builds
    the store, which opens the database and may backfill an index. That cost
    is real but it is a cold-start cost, and charging it to whichever route
    happens to be alphabetically first would make the budgets meaningless.

    The known-paths store is redirected into the fixture root as well. The
    assets routes in the sweep resolve every row's installed path, which reads
    ``paths.data_path("known_paths.json")`` -- the developer's own file, with
    the folders they have opened in it. A guard has no business reading that,
    and a probe whose answer depends on it measures a different library on
    every machine.
    """
    with pytest.MonkeyPatch.context() as patch:
        patch.setenv("theDAW_GENERATIONS_DIR", str(scale_library.root))
        # ``theDAW_GENERATIONS_DIR`` only moves the library tree. Everything
        # that reaches for ``paths.data_path`` -- ``GET /setlists`` scanning
        # ``<data>/performance-sets`` is the one that bit -- still read this
        # machine's own ``data/``, so the sweep measured whatever the
        # developer happened to have there and CI measured an empty folder.
        # ``theDAW_DATA_DIR`` is read on every call (``backend/lib/paths.py``),
        # so setting it here redirects the whole tree with nothing reimported.
        data_root = scale_library.root / "data"
        data_root.mkdir(parents=True, exist_ok=True)
        patch.setenv("theDAW_DATA_DIR", str(data_root))
        patch.setattr(library_router_module, "_store", None)
        # Through the patch context, not the setter: the setter leaves the
        # redirect standing if anything below raises -- TestClient, the
        # warm-up GET, the revision read -- and the fixture then deletes the
        # directory it points at, so every later test in the session reads a
        # known-paths file that is not there. MonkeyPatch undoes it on every
        # path out, including the raising one.
        patch.setattr(
            known_paths,
            "_STORE_PATH",
            scale_library.root / "known_paths.json",
        )
        with TestClient(_build_app()) as test_client:
            test_client.get(f"{LIBRARY_PREFIX}/summary")
            _REVISION_AT_START.append(
                library_router_module.get_store().db.library_revision()
            )
            try:
                yield test_client
            finally:
                store = library_router_module._store
                database = getattr(store, "db", None)
                if database is not None:
                    database.close()
                library_router_module._store = None


@pytest.fixture(autouse=True)
def _clear_lineage_stats_cache() -> Iterator[None]:
    """The lineage stats cache is module-level on purpose: the whole point of
    it is that the second request does not repeat the first one's two
    whole-table passes. Which means no test here may inherit another's
    answer -- the parametrised sweep asks ``/summary`` and ``/rankings`` long
    before the trace test runs. Mirrors ``tests/test_lineagescale.py``'s
    ``_clear_stats_cache``."""
    lineagescale_router_module._stats_cache.clear()
    yield
    lineagescale_router_module._stats_cache.clear()


@contextmanager
def _traced(store_db: Any) -> Iterator[list[str]]:
    """Every statement every connection involved issues.

    The lineage-scale routes open their OWN read-only connection, so watching
    only the store's would watch an empty room -- the same reason
    ``tests/test_lineagescale.py`` patches ``sqlite3.connect``.

    The lineage stats cache is cleared on the way in as well as by the
    autouse fixture, so a route probed EARLIER IN THE SAME TEST cannot warm
    it either. Without this the trace saw a cache hit -- a signature query
    and a few bounded reads -- and the strongest test in this module was
    proving nothing whatever about ``/summary`` or ``/rankings``.
    """
    lineagescale_router_module._stats_cache.clear()
    statements: list[str] = []
    opened: list[sqlite3.Connection] = []
    real_connect = sqlite3.connect

    def traced_connect(*args: Any, **kwargs: Any) -> sqlite3.Connection:
        conn = real_connect(*args, **kwargs)
        conn.set_trace_callback(statements.append)
        opened.append(conn)
        return conn

    shared = store_db._conn  # noqa: SLF001 - the store's own connection
    shared.set_trace_callback(statements.append)
    sqlite3.connect = traced_connect  # type: ignore[assignment]
    try:
        yield statements
    finally:
        sqlite3.connect = real_connect  # type: ignore[assignment]
        shared.set_trace_callback(None)
        # A connection opened under the patch keeps appending to this list
        # for as long as it lives, which would leak one test's
        # instrumentation into the next one's trace.
        for conn in opened:
            try:
                conn.set_trace_callback(None)
            except sqlite3.ProgrammingError:
                pass  # closed already by whoever opened it


# ---------------------------------------------------------------------------
# 1 + 2: every GET answers, and nothing grows with the library
# ---------------------------------------------------------------------------


def test_the_fixture_is_actually_heavy(scale_library: ScaleLibrary) -> None:
    """A guard on a thin fixture guards nothing.

    This is the assertion the two shipped regressions needed: if the blob
    weight ever drops back to a couple of bytes a row, every budget below
    passes for the wrong reason.
    """
    assert scale_library.entries == ENTRIES
    assert scale_library.relations > 45_000
    assert scale_library.blob_bytes / scale_library.entries > 7_000
    assert scale_library.stems > 0
    assert scale_library.midis > 0


def test_every_get_route_has_an_id_to_probe_with() -> None:
    """Enumeration is the point: a route added with a new path parameter must
    fail here, not vanish from the guard."""
    assert ROUTE_TEMPLATES, "no GET routes were enumerated from app.routes"
    unprobed = [t for t in ROUTE_TEMPLATES if not _fill(t)]
    assert not unprobed, f"no id value for {unprobed}; add one to _PARAM_VALUES"


@pytest.mark.parametrize(
    ("template", "path"), ROUTE_CASES, ids=[path for _, path in ROUTE_CASES]
)
def test_every_get_route_answers_within_budget(
    client: TestClient, template: str, path: str
) -> None:
    started = time.perf_counter()
    response = client.get(path)
    elapsed = time.perf_counter() - started
    size = len(response.content)
    _MEASURED[path] = (elapsed, size, response.status_code)

    assert response.status_code < 500, response.text[:400]
    if template in SIZE_ALLOWLIST:
        assert size < ALLOWLIST_SIZE_CEILING_BYTES, (
            f"{template} is allowlisted for {SIZE_ALLOWLIST[template]}, "
            f"but {size} bytes is past even the allowlist ceiling"
        )
    else:
        assert size <= SIZE_BUDGET_BYTES, (
            f"{path} returned {size} bytes for {ENTRIES} entries. Either it "
            "grows with the library -- the LEARN crash -- or it belongs in "
            "SIZE_ALLOWLIST with a reason."
        )
    assert elapsed < TIME_BUDGET_SECONDS, f"{path} took {elapsed:.3f}s"


def test_the_read_probes_did_not_write(client: TestClient) -> None:
    """Every route the sweep probes is a GET, and a GET must not commit.

    Two of them do work that is not a library read: ``/{entry_id}/bundle``
    runs a notation recovery/register step on its way to zipping, and
    ``/audio/{entry_id}/cover`` can write a poster it had to derive. Whether
    either actually commits against this fixture is not something a reader
    should have to take on trust, so the counter that ``LibraryDB._txn``
    bumps once per committed write is compared across the whole sweep. It
    also means the budgets above all measured the same library.
    """
    assert _REVISION_AT_START, "the client fixture never recorded a revision"
    # Selected on its own (``-k read_probes``) the comparison below is
    # tautological: no probe ran, so of course nothing was written. The sweep
    # records one entry per case, so requiring them proves the thing this test
    # claims. Other tests add keys of their own, hence >= rather than ==.
    assert len(_MEASURED) >= len(ROUTE_CASES), (
        f"only {len(_MEASURED)} of {len(ROUTE_CASES)} probes ran before this "
        "test, so it would pass without any GET having been made. Run the "
        "module, or select this test together with "
        "test_every_get_route_answers_within_budget."
    )
    store = library_router_module.get_store()
    assert store.db.library_revision() == _REVISION_AT_START[0], (
        "a GET committed a write during the probe sweep. A read probe must "
        "not: it makes the sweep order matter, and it means one of these "
        "routes is doing repair work on a page load."
    )


def test_the_probes_read_no_known_paths_but_the_fixtures(
    client: TestClient, scale_library: ScaleLibrary
) -> None:
    """The assets routes in the sweep must not read the developer's own file.

    ``/api/assets`` resolves each row's installed path through
    ``known_paths.installed_asset_path``, which without a redirect opens
    ``paths.data_path("known_paths.json")``: the real file, holding the folders
    this machine's user has browsed to. The client fixture points the store at
    the fixture root; this is the assertion that it still does.
    """
    expected = (scale_library.root / "known_paths.json").resolve()
    resolved = Path(known_paths._store_path()).resolve()  # noqa: SLF001
    assert resolved == expected, (
        f"the known-paths store resolved to {resolved}, not the fixture's "
        f"{expected}: the assets probes are reading a real user's file"
    )


def test_the_probes_read_nothing_under_the_real_data_dir(
    client: TestClient, scale_library: ScaleLibrary
) -> None:
    """``known_paths.json`` was not the only leak, and naming files one at a
    time was never going to find the next one.

    ``paths.data_path`` is not redirected by ``theDAW_GENERATIONS_DIR``, so
    every route that reaches for the data tree rather than the library tree
    read this machine's own folder. ``GET /setlists`` is how that surfaced:
    it scans ``<data>/performance-sets`` and, on a checkout that has sets in
    it, registered 25 of the developer's files into the fixture -- a probe
    whose answer, and whose cost, depended on whose machine it ran on. The
    whole data root is redirected now, so the sweep reads the fixture or
    nothing.
    """
    root = scale_library.root.resolve()
    data_root = paths.data_dir().resolve()
    assert data_root.is_relative_to(root), (
        f"the data root resolved to {data_root}, outside the fixture's "
        f"{root}: the probes are reading this machine's own data tree"
    )
    perf_sets = library_router_module._perf_sets_root().resolve()  # noqa: SLF001
    assert perf_sets.is_relative_to(root), (
        f"the setlists probe scans {perf_sets}, outside the fixture's {root}"
    )


# ---------------------------------------------------------------------------
# The whole-library graph, held to the shape we want
# ---------------------------------------------------------------------------


@pytest.mark.xfail(
    strict=True,
    reason=(
        "``/_graph/all`` is the route that crashed LEARN, and it is "
        "unchanged. The fix shipped a new surface (``/api/lineage-scale``) "
        "next to it rather than capping this one, so this asserts the shape "
        "we WANT -- fewer nodes than the library has entries -- under a "
        "strict xfail. The day a cap or a page lands it xpasses: good news, "
        "remove the marker and drop the SIZE_ALLOWLIST entry. Until then it "
        "is a documented known-bad, not a red build somebody has to edit."
    ),
)
def test_the_whole_library_graph_is_bounded(client: TestClient) -> None:
    """One node per entry is what it does today; this is the desired shape."""
    response = client.get(f"{LIBRARY_PREFIX}/_graph/all")
    assert response.status_code < 500
    body = response.json()
    nodes = body.get("nodes")
    assert isinstance(nodes, list)
    _MEASURED["_graph/all::nodes"] = (0.0, len(nodes), response.status_code)
    assert len(nodes) < ENTRIES


# ---------------------------------------------------------------------------
# 3: the machine-independent guarantee
# ---------------------------------------------------------------------------


def test_the_blob_rule_flags_a_blob_read_and_spares_the_exceptions() -> None:
    """The guard's own guard: :func:`_blob_offenders` over hand-written SQL.

    Every other test here needs a 400 MB fixture to say anything, so the rule
    itself was only ever exercised by planting a regression in the backend by
    hand. These are the statements that matter, written out: the 13.3 s
    provider filter, ``list_entries``'s unbounded ``SELECT *``, an unbounded
    ``SELECT e.*``, and each of the three exceptions.
    """
    offending = [
        "SELECT id, json_extract(e.metadata_json, '$.provider') AS provider "
        "FROM entries e ORDER BY e.created_at DESC",
        "SELECT * FROM entries ORDER BY created_at DESC",
        "SELECT e.* FROM entries e WHERE e.source = ? ORDER BY e.created_at DESC",
        # a star that is not the first thing after SELECT: the whole row, plus
        # a named column, which an anchored pattern reads straight past
        "SELECT e.id, e.* FROM entries e ORDER BY e.created_at DESC",
        # the word "limit" without the page: a whole-table read that borrows
        # the paged exception by naming a column
        "SELECT e.* FROM entries e WHERE e.play_limit IS NULL",
        # the page's projection over the whole table instead of the page's ids
        "SELECT id, json_extract(metadata_json, ?) AS j0 FROM entries",
        # the non-fts5 search fallback's PAGE: the page shape is intact and
        # the select list is just the star, but the predicate opens all 20,000
        # blobs to return 50 rows
        "SELECT e.* FROM entries e WHERE (e.title LIKE ? OR COALESCE(CASE WHEN "
        "json_valid(e.metadata_json) THEN json_extract(e.metadata_json, "
        "'$.lyrics') END, '') LIKE ?) ORDER BY e.created_at DESC LIMIT ? OFFSET ?",
        # a blob read hidden in a predicate's SUBQUERY: blanking every
        # select list blanks this one too, so the remainder looks clean and
        # the page shape would buy the exception
        "SELECT e.* FROM entries e WHERE ? IN (SELECT json_extract("
        "metadata_json, '$.lyrics') FROM entries) ORDER BY e.created_at DESC "
        "LIMIT ? OFFSET ?",
        # the same fallback in the paged list's own projection shape: the ids
        # are named, but the predicate is still a whole-table blob read
        "SELECT id, json_extract(metadata_json, ?) AS j0 FROM entries WHERE "
        "json_extract(metadata_json, '$.lyrics') LIKE ? AND id IN (?, ?)",
        # the non-fts5 search fallback's LIKE, which opens every row's lyrics
        "SELECT COUNT(*) AS c FROM entries e WHERE (e.title LIKE ? OR "
        "COALESCE(CASE WHEN json_valid(e.metadata_json) THEN "
        "json_extract(e.metadata_json, '$.lyrics') END, '') LIKE ?)",
    ]
    allowed = [
        # the paged list's projection: bounded by the ids on the page
        "SELECT id, title, CASE WHEN json_valid(metadata_json) THEN "
        "json_extract(metadata_json, ?) END AS j0 FROM entries "
        "WHERE id IN (?, ?)",
        # the single-entry GET
        "SELECT * FROM entries WHERE id = ?",
        # the paged list's own whole-row read
        "SELECT e.* FROM entries e ORDER BY e.created_at DESC LIMIT 50 OFFSET 0",
        # neither names nor selects a blob
        "SELECT COUNT(*) FROM entries",
        "SELECT id, created_at FROM entries",
        "SELECT provider, COUNT(*) FROM entries GROUP BY provider",
        # the fts5 search index is not the entries table: its rows hold no
        # blob, so a star over it reads nothing this rule is about
        "SELECT * FROM entries_search WHERE entries_search MATCH ?",
        # the paged list, searched: the outer select list is the star, the
        # subquery's is a rowid, and the page shape is intact
        "SELECT e.* FROM entries e WHERE e.rowid IN (SELECT rowid AS rid FROM "
        "entries_search WHERE entries_search MATCH ?) ORDER BY e.created_at DESC "
        "LIMIT ? OFFSET ?",
    ]
    assert _blob_offenders(offending) == [_normalise(s) for s in offending]
    assert _blob_offenders(allowed) == []


def test_the_list_routes_never_open_a_blob_column(
    client: TestClient, scale_library: ScaleLibrary
) -> None:
    """The invariant behind the 13.3 s page, as SQL rather than a stopwatch.

    Every route here answers about the whole table, so any statement naming a
    blob column reads every row's blob. The exception set is closed and
    documented: the page's own bounded row read, and the single-entry GET.
    """
    store = library_router_module.get_store()
    with _traced(store.db) as statements:
        for path in LIST_ROUTE_PATHS:
            # 200, not "under 500": a route that rejected the probe as a 422
            # runs no SQL at all, and an empty trace proves nothing.
            response = client.get(path)
            assert response.status_code == 200, path
            if f"q={SEARCH_WORD}" in path:
                # Same reasoning one step further in: a search that matched
                # nothing is a predicate the planner may have answered from an
                # index without ever reaching the fallback's LIKE.
                assert _match_total(path, response.json()) > 0, (
                    f"{path} matched no row, so it priced no search: "
                    f"{SEARCH_WORD!r} is in every title the fixture writes"
                )

    assert statements, "the trace callback saw nothing, so it proved nothing"
    normalised = [_normalise(s) for s in statements]
    assert any("from entries" in s for s in normalised), (
        "no statement touched the entries table; the routes cannot have run"
    )
    # The lineage routes are the ones a warm cache can hide: with the stats
    # slot already filled they answer from memory, run a signature query and
    # a few bounded entry reads, and a "no blob column" assertion passes
    # having priced nothing. Both whole-table passes must appear.
    for stream in LINEAGE_STATS_STREAMS:
        # Equality, not containment: see LINEAGE_STATS_STREAMS -- the bounded
        # link fetch starts with the same 45 characters as the whole-table
        # pass, so `in` answers yes for a route that read nothing but an
        # index.
        assert stream in normalised, (
            f"the lineage stats pass never ran: no statement was {stream!r}. "
            "That cache is a module singleton and the sweep above warms it, "
            "so a trace without this proves nothing about /summary or "
            "/rankings -- clear _stats_cache before tracing."
        )
    offenders = _blob_offenders(statements)
    assert not offenders, (
        "a whole-library query opened a blob column, which on the real "
        f"library means reading ~6.6 GB: {offenders[:5]}"
    )


def test_the_single_entry_get_reads_at_most_its_own_row(
    client: TestClient,
) -> None:
    """The one route the blob rule cannot apply to, held to the weaker one.

    ``GET /entries/{id}`` exists to return an entry's metadata, so it is in
    the exception set. Measured on this build it does not use the exception
    at all -- the record is assembled from ``<root>/<id>/metadata.json`` and
    its SQL names no blob column -- but the exception stays, because reading
    ONE row's blob here would be the request rather than a leak. What it may
    never do is open the column across rows, and that is what this asserts.
    """
    store = library_router_module.get_store()
    with _traced(store.db) as statements:
        assert client.get(f"{LIBRARY_PREFIX}/entries/{COMMON_ID}").status_code == 200

    assert statements, "the trace callback saw nothing, so it proved nothing"
    blob_reads = [
        _normalise(s)
        for s in statements
        if any(column in _normalise(s) for column in BLOB_COLUMNS)
    ]
    assert all(_is_single_entry_read(s) for s in blob_reads), [
        s[:200] for s in blob_reads
    ]


@pytest.mark.xfail(
    strict=True,
    reason=(
        "``GET /entries`` with no parameters returns the whole kind, as "
        "designed. The router documents this on purpose: it is byte-for-byte "
        "the endpoint that predates paging, for callers that predate paging. "
        "It is also the third response on this surface whose size is the "
        "library's size -- 21 MB at 20,000 entries, so ~200 MB at the real "
        "194,508. Changing the default is a product decision, not a test's, "
        "so the shape we WANT is what is asserted, under a strict xfail: if "
        "a cap or a default limit ever lands this xpasses and says so, "
        "rather than failing a build for having got better."
    ),
)
def test_the_unpaged_entries_list_is_not_a_full_dump(
    client: TestClient, scale_library: ScaleLibrary
) -> None:
    """The desired shape: the bare list fits inside the size budget."""
    response = client.get(f"{LIBRARY_PREFIX}/entries")
    assert response.status_code == 200
    size = len(response.content)
    body = response.json()
    _MEASURED["/api/library/entries (no params, legacy dump)"] = (
        0.0,
        size,
        response.status_code,
    )
    assert body["count"] > scale_library.entries * 0.9
    assert len(body["entries"]) == body["count"]
    assert size <= SIZE_BUDGET_BYTES


def test_a_provider_filtered_page_costs_what_an_unfiltered_one_costs(
    client: TestClient,
) -> None:
    """The regression in its own terms: the filter that took 13.3 s.

    A ratio, not an absolute, so the assertion means the same thing on a
    laptop and on CI. The old rule was ~130x.

    Best of three each, not one sample apiece: a ratio between two single
    timings is at the mercy of whatever else the runner was doing during one
    of them, and the fastest run of three is the one least polluted by it.
    A route reading 20,000 blobs has no fast run.
    """
    plain = f"{LIBRARY_PREFIX}/entries?limit=200"
    filtered = f"{LIBRARY_PREFIX}/entries?limit=200&provider={RARE_PROVIDER}"

    def fastest_of_three(path: str) -> float:
        best = float("inf")
        for _ in range(3):
            started = time.perf_counter()
            assert client.get(path).status_code == 200, path
            best = min(best, time.perf_counter() - started)
        return best

    client.get(plain)
    client.get(filtered)
    plain_seconds = fastest_of_three(plain)
    filtered_seconds = fastest_of_three(filtered)

    budget = max(plain_seconds * 12.0, 0.4)
    assert filtered_seconds < budget, (
        f"a provider-filtered page took {filtered_seconds:.3f}s against "
        f"{plain_seconds:.3f}s unfiltered; the filter is reading blobs again"
    )


# ---------------------------------------------------------------------------
# What it measured
# ---------------------------------------------------------------------------


def test_zz_report(scale_library: ScaleLibrary) -> None:
    """Not an assertion -- the numbers, so a CI log says what it priced.

    Named to sort last. ``-s`` shows it; without ``-s`` it is silent and
    costs nothing.
    """
    print(
        f"\nfixture: {scale_library.entries} entries, "
        f"{scale_library.relations} relations, "
        f"{scale_library.blob_bytes / 1e6:.1f} MB of metadata_json, "
        f"db {database_bytes(Path(scale_library.db_path)) / 1e6:.1f} MB, "
        f"built in {scale_library.build_seconds:.1f}s"
    )
    for path, (elapsed, size, status) in sorted(_MEASURED.items()):
        print(f"  {elapsed * 1000:8.1f} ms  {size:>10} B  {status}  {path}")
