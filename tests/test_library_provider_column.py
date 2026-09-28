"""The resolved ``entries.provider`` column.

``provider=<slug>`` used to be answered by a SQL rule whose first arm was a
``json_extract`` over ``metadata_json``. Evaluating that for a filtered list or
count makes SQLite read every row's metadata, and the user's real rows carry
their provider's own record at ~34 KB each: measured on that library (194,508
entries) ``GET /entries?provider=suno&limit=200`` took 13.3 s where an
unfiltered page took 0.10 s. The repo's own budget tests never saw it, because
their synthetic rows have a two-byte metadata blob.

These tests pin the replacement: the half of the rule that needs an entry's
metadata is resolved ONCE, by whichever writer is already holding that
metadata, into an indexed column; the other half stays the ``(model, source)``
fallback; and every query -- the page, its count, the id list and the facet --
compares or groups on the two together, so no two of them can file one row
under different slugs.

Every fixture is synthetic. No entry id, model, provider or path below names
anything in anyone's library.
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
from pathlib import Path

import pytest

from backend.modules.library import db as db_module
from backend.modules.library.db import (
    SCHEMA_VERSION,
    EntryFilters,
    LibraryDB,
    infer_provider,
    resolved_provider_slug,
)
from backend.modules.library.store import LibraryStore

#: Absolute ceiling for a provider-filtered page and its count, on the
#: realistic fixture below. Deliberately generous, and tunable with
#: ``THEDAW_PROVIDER_PAGE_BUDGET_MS``.
#:
#: WHY 2000 AND NOT 150. The regression this file exists to catch is a filtered
#: page that READS every row's ``metadata_json``: measured at 13,300 ms against
#: 100 ms unfiltered on the user's library, a ~100x slowdown. A ceiling anywhere
#: under a second catches that with room to spare, and one set just above the
#: fast path's own timing instead catches the runner: at 150 ms the ``all/common``
#: case failed at 396 ms on a 2-vCPU Linux CI runner while passing on two other
#: runs minutes apart -- 2.6x of wall-clock noise, not 100x of blob reading. The
#: property that actually distinguishes the two is RELATIVE
#: (:data:`FILTERED_SLOWDOWN_MAX`), and it holds on any machine.
PAGE_BUDGET_MS = float(os.environ.get("THEDAW_PROVIDER_PAGE_BUDGET_MS") or 2000.0)

#: How much slower a provider-FILTERED page may be than the same page without
#: the provider clause, both measured the same way on the same fixture. The
#: filter seeks an index; reading 60,000 padded blobs instead is ~100x, so a
#: small factor separates them on a fast machine and a slow one alike.
FILTERED_SLOWDOWN_MAX = 3.0

#: Floor under the unfiltered baseline in that ratio. An unfiltered page on this
#: fixture runs in single-digit milliseconds, where the scheduler alone moves the
#: number by more than 3x; below this floor the ratio would measure jitter. The
#: defect is three orders of magnitude clear of it.
SLOWDOWN_FLOOR_MS = 5.0

#: Runs per measurement. The fastest is reported: a page that CAN seek has a
#: floor and no ceiling, so the minimum is the one number a co-tenant on the
#: runner cannot inflate.
BUDGET_REPEATS = 3

#: Absolute ceiling for the provider facet, same model and same reason as
#: :data:`PAGE_BUDGET_MS`: generous, env-tunable, and there to say the query is
#: not reading ~480 MB of blob rather than to time the runner. The old 300 ms
#: sat just above this fixture's own facet timing, which is the shape that
#: failed at 396 ms on a 2-vCPU Linux CI runner for the page.
FACET_BUDGET_MS = float(os.environ.get("THEDAW_PROVIDER_FACET_BUDGET_MS") or 2000.0)

#: The provider facet's twin for the relative assertion: the ``model`` facet,
#: over the SAME filters. A facet has no unfiltered twin -- it never carries a
#: ``provider=`` clause to drop, it always aggregates everything the filters
#: match -- and the page is the wrong baseline because a page reads 200 rows
#: while a facet groups all 60,000. ``model`` is the right one: one aggregate
#: over the same rows with the same cap, differing from the provider facet in
#: exactly the expression it groups on, and it can never read
#: ``metadata_json``. If the provider expression starts reading blobs, the ratio
#: between the two moves and a uniformly slow machine does not move it.
FACET_TWIN_FIELD = "model"

#: The realistic fixture. 60,000 rows whose ``metadata_json`` is padded to ~8 KB
#: each -- ~480 MB of blob, which is what the old rule had to read per filtered
#: page and what the repo's other perf fixtures (a two-byte blob) do not have.
PERF_ROWS = 60_000
PERF_BLOB_BYTES = 8 * 1024

_PAD_CHUNK = "lorem ipsum dolor sit amet consectetur adipiscing elit "

#: A slug carried by ~10 of the 60,000 rows. Invented for this file.
RARE_SLUG = "quiet-shelf"

#: The step that ADDED the column and its indexes, and the step that REBUILT
#: those indexes when the fallback's last arm changed from 'stable-audio' to
#: 'thedaw' (T13). Two of the four indexes are declared ON that expression, and
#: SQLite matches an expression index by the text it was built from, so a
#: library upgraded without step 10 would keep indexes that answer the old rule
#: -- silently, since the queries stay correct and only lose the seek.
PROVIDER_COLUMN_VERSION = 9
PROVIDER_REINDEX_VERSION = 10

#: The step that rebuilt them AGAIN when the Suno arm learned ``chirp``,
#: Suno's model family (T14). The same reason as step 10 one step later:
#: the expression those two indexes are declared on changed its text.
PROVIDER_CHIRP_VERSION = 11

#: The expression the v9 indexes were built from, spelled out because it no
#: longer exists anywhere in the module: this is what a library that migrated
#: BEFORE step 10 has on disk, and rebuilding it is the whole of step 10.
V9_INDEX_EXPR = """COALESCE(NULLIF(provider, ''), CASE
        WHEN source = 'suno'
             OR instr(lower(model), 'suno') > 0 THEN 'suno'
        WHEN instr(lower(model), 'magenta') > 0
             OR instr(lower(model), 'gemini') > 0 THEN 'gemini-magenta'
        WHEN instr(replace(lower(model), 'audio', ''), 'udio') > 0 THEN 'udio'
        WHEN instr(lower(model), 'riffusion') > 0 THEN 'riffusion'
        WHEN source = 'import' THEN 'import'
        ELSE 'stable-audio'
    END)"""

#: The four indexes step 9 builds and step 10 rebuilds.
PROVIDER_INDEXES = (
    "idx_entries_provider",
    "idx_entries_provider_created",
    "idx_entries_provider_any_kind",
    "idx_entries_facet_provider",
)

#: The two of them declared on the expression rather than on columns.
EXPRESSION_INDEXES = ("idx_entries_provider_created", "idx_entries_provider_any_kind")


def _payload(entry_id: str, **overrides) -> dict:
    payload: dict = {
        "id": entry_id,
        "kind": "audio",
        "title": entry_id,
        "model": "medium",
        "source": "generate",
        "duration": 1.0,
        "audio_filename": "output.wav",
        "timestamp": "2026-09-21T00:00:00Z",
        "metadata_json": {},
    }
    payload.update(overrides)
    return payload


def _seed_entry(root: Path, entry_id: str, meta: dict) -> Path:
    """One flat on-disk entry, the layout an import leaves behind."""
    entry_dir = root / entry_id
    entry_dir.mkdir(parents=True, exist_ok=True)
    (entry_dir / "audio.mp3").write_bytes(b"")
    payload = {
        "id": entry_id,
        "filename": "audio.mp3",
        "audio_filename": "audio.mp3",
        "mime_type": "audio/mpeg",
        "title": entry_id,
        "model": "medium",
        "source": "generate",
        "duration": 1.0,
        "tags": [],
        "saved_at": 1700000000.0,
    }
    payload.update(meta)
    (entry_dir / "metadata.json").write_text(json.dumps(payload), encoding="utf-8")
    return entry_dir


def _column(db: LibraryDB, entry_id: str):
    row = db._conn.execute(
        "SELECT provider FROM entries WHERE id = ?", (entry_id,)
    ).fetchone()
    return row["provider"] if row else None


def _indexes(conn: sqlite3.Connection) -> set[str]:
    return {
        str(r[0])
        for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'index'"
        ).fetchall()
    }


def _index_sql(conn: sqlite3.Connection, name: str) -> str:
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?", (name,)
    ).fetchone()
    return str(row[0]) if row and row[0] else ""


def _row_dump(conn: sqlite3.Connection, columns: str) -> list[tuple]:
    return [
        tuple(r) for r in conn.execute(f"SELECT {columns} FROM entries ORDER BY id")
    ]


def _traced(db: LibraryDB, run) -> list[str]:
    """Every SQL statement ``run()`` executes, expanded with its parameters."""
    seen: list[str] = []
    db._conn.set_trace_callback(seen.append)
    try:
        run()
    finally:
        db._conn.set_trace_callback(None)
    return seen


def _plan(conn: sqlite3.Connection, sql: str) -> list[str]:
    return [str(r[-1]) for r in conn.execute("EXPLAIN QUERY PLAN " + sql).fetchall()]


# ---------------------------------------------------------------------------
# The migration
# ---------------------------------------------------------------------------


@pytest.fixture
def v8_library(tmp_path: Path) -> Path:
    """A library written by the build BEFORE the column existed, then closed.

    The migration list is truncated only while this database is being created
    and is restored before the fixture returns, so the test that follows opens
    it with the real, current build -- which is the upgrade being tested.
    """
    current = db_module._MIGRATIONS
    db_module._MIGRATIONS = [
        step for step in current if step[0] < PROVIDER_COLUMN_VERSION
    ]
    try:
        db = LibraryDB(tmp_path / "library.db")
        assert db.schema_version() == PROVIDER_COLUMN_VERSION - 1
        _seed_v8_rows(db)
    finally:
        db_module._MIGRATIONS = current
    db.close()
    return tmp_path / "library.db"


def _seed_v8_rows(db: LibraryDB) -> None:
    # Written with the INSERT that build issued -- it cannot name a column
    # that does not exist yet, which is also the point of the last test below.
    db._conn.executemany(
        "INSERT INTO entries (id, kind, title, model, source, created_at, "
        "updated_at, metadata_json) VALUES (?, 'audio', ?, ?, ?, 1.0, 1.0, ?)",
        [
            (
                "old_labeled",
                "old_labeled",
                "medium",
                "generate",
                '{"provider": "bandcamp"}',
            ),
            ("old_legacy", "old_legacy", "medium", "import", '{"suno_id": "s-01"}'),
            ("old_plain", "old_plain", "medium", "generate", "{}"),
            ("old_udio", "old_udio", "udio-1", "import", "{}"),
        ],
    )
    db._conn.commit()


def test_the_migration_adds_the_column_and_its_indexes_without_touching_a_row(
    v8_library: Path,
):
    """Additive and O(1) in rows: the schema gains a column and three indexes,
    and not one existing row is rewritten.

    ``ADD COLUMN`` with no default only rewrites the schema -- SQLite reads a
    record that is short of the new column back as NULL -- so this costs the
    same on an empty library and on 200,000 entries, and it never opens one
    row's metadata. That is the whole reason there is no backfill.
    """
    old = sqlite3.connect(str(v8_library))
    old.row_factory = sqlite3.Row
    columns = (
        "id, kind, title, prompt, negative_prompt, model, duration_sec, steps, "
        "cfg, seed, mime, audio_filename, file_size_bytes, source, favorite, "
        "rating, notes, timestamp, created_at, updated_at, analysis_status, "
        "stems_status, midi_status, metadata_json, play_count, last_played_at"
    )
    before = _row_dump(old, columns)
    assert "provider" not in {r[1] for r in old.execute("PRAGMA table_info(entries)")}
    old.close()

    db = LibraryDB(v8_library)
    assert db.schema_version() == SCHEMA_VERSION
    assert _row_dump(db._conn, columns) == before
    assert {r[1] for r in db._conn.execute("PRAGMA table_info(entries)")} >= {
        "provider"
    }
    # Nothing was resolved: the migration wrote no row, so every pre-existing
    # entry is still unresolved and still answered by the fallback.
    assert _column(db, "old_labeled") is None
    assert _column(db, "old_legacy") is None
    assert set(PROVIDER_INDEXES) <= _indexes(db._conn)
    db.close()


def test_the_migration_is_idempotent_and_a_fresh_library_is_born_with_it(
    v8_library: Path, tmp_path: Path
):
    """Re-opening runs nothing a second time, and a brand new database is
    already at the current schema rather than migrating into it."""
    first = LibraryDB(v8_library)
    dump = _row_dump(first._conn, "id, provider, metadata_json")
    first.close()
    again = LibraryDB(v8_library)
    assert again.schema_version() == SCHEMA_VERSION
    assert _row_dump(again._conn, "id, provider, metadata_json") == dump
    again.close()

    fresh = LibraryDB(tmp_path / "fresh.db")
    assert fresh.schema_version() == SCHEMA_VERSION
    assert set(PROVIDER_INDEXES) <= _indexes(fresh._conn)
    fresh.close()


def test_a_build_that_does_not_know_the_column_still_reads_and_writes(
    v8_library: Path,
):
    """The column is nullable with no default, so the statements an older build
    issues -- which name every column except this one -- still work against a
    migrated database."""
    LibraryDB(v8_library).close()
    old = sqlite3.connect(str(v8_library))
    old.row_factory = sqlite3.Row
    old.execute(
        "INSERT INTO entries (id, kind, title, model, source, created_at, "
        "updated_at, metadata_json) VALUES ('from_old', 'audio', 'x', 'medium', "
        "'import', 1.0, 1.0, '{}')"
    )
    old.commit()
    row = dict(old.execute("SELECT * FROM entries WHERE id='from_old'").fetchone())
    assert row["provider"] is None
    old.close()

    db = LibraryDB(v8_library)
    # ... and the row an older build wrote is filed under the fallback, which
    # is the answer it has always had.
    assert "from_old" in set(db.list_entry_ids(EntryFilters(provider="import"), 10))
    db.close()


# ---------------------------------------------------------------------------
# Step 10: the fallback's text changed, so the indexes built on it are rebuilt
# ---------------------------------------------------------------------------


def _seed_v9_rows(db: LibraryDB) -> None:
    """Three rows as the v9 build left them: a DJ performance set and a
    generation with the column unresolved, and one row already resolved from
    its own metadata."""
    db._conn.executemany(
        "INSERT INTO entries (id, kind, title, model, source, provider, "
        "created_at, updated_at, metadata_json) "
        "VALUES (?, 'audio', ?, ?, ?, ?, 1.0, 1.0, '{}')",
        [
            ("v9_set", "v9_set", "", "performance-set", None),
            ("v9_generated", "v9_generated", "medium", "generate", None),
            ("v9_labeled", "v9_labeled", "medium", "import", "bandcamp"),
        ],
    )
    db._conn.commit()


@pytest.fixture
def v9_library(tmp_path: Path) -> Path:
    """A library migrated by the v9 build: the column and all four indexes are
    there, and the two expression indexes carry the OLD fallback text.

    The statements in step 9 interpolate the module's live expression, so
    running them today builds the NEW text -- which is not what a library
    upgraded before step 10 has on disk. The two expression indexes are
    therefore dropped and rebuilt here from :data:`V9_INDEX_EXPR`, a literal,
    so the fixture is the real historical state rather than a re-run of the
    current code.
    """
    current = db_module._MIGRATIONS
    db_module._MIGRATIONS = [
        step for step in current if step[0] <= PROVIDER_COLUMN_VERSION
    ]
    try:
        db = LibraryDB(tmp_path / "library.db")
        assert db.schema_version() == PROVIDER_COLUMN_VERSION
        _seed_v9_rows(db)
    finally:
        db_module._MIGRATIONS = current
    for name in EXPRESSION_INDEXES:
        db._conn.execute(f"DROP INDEX {name}")
    db._conn.execute(
        f"CREATE INDEX idx_entries_provider_created "
        f"ON entries(kind, {V9_INDEX_EXPR}, created_at DESC)"
    )
    db._conn.execute(
        f"CREATE INDEX idx_entries_provider_any_kind "
        f"ON entries({V9_INDEX_EXPR}, created_at DESC)"
    )
    db._conn.commit()
    for name in EXPRESSION_INDEXES:
        assert "ELSE 'stable-audio'" in _index_sql(db._conn, name), name
    db.close()
    return tmp_path / "library.db"


V9_COLUMNS = "id, kind, title, model, source, provider, created_at, metadata_json"


def test_step_ten_rebuilds_the_expression_indexes_and_rewrites_no_row(
    v9_library: Path,
):
    """The reason a text change to the fallback is a SCHEMA change.

    SQLite records an expression index's text as it was written and matches a
    query's expression against that text, so an index built from the old rule
    can neither serve the new comparison nor hold the right slug for a row.
    Step 10 rebuilds all four provider indexes from the current expression --
    and touches nothing else: no row is rewritten, and a row whose ``provider``
    column was already resolved from its own metadata keeps it, because that
    answer came from real metadata and is still right. Only the FALLBACK, which
    is computed per query and never stored, changes what it says.
    """
    old = sqlite3.connect(str(v9_library))
    old.row_factory = sqlite3.Row
    before = _row_dump(old, V9_COLUMNS)
    old.close()

    db = LibraryDB(v9_library)
    assert db.schema_version() == SCHEMA_VERSION >= PROVIDER_REINDEX_VERSION
    assert _row_dump(db._conn, V9_COLUMNS) == before
    assert set(PROVIDER_INDEXES) <= _indexes(db._conn)

    for name in EXPRESSION_INDEXES:
        sql = _index_sql(db._conn, name)
        assert db_module._PROVIDER_INDEX_EXPR in sql, name
        assert "ELSE 'thedaw'" in sql, name
        assert "ELSE 'stable-audio'" not in sql, name

    # And the rule the rebuilt indexes answer is the new one: the DJ set is
    # theDAW's own, the generation is still Stable Audio, and the row that was
    # already resolved is untouched by either.
    assert set(db.list_entry_ids(EntryFilters(provider="thedaw"), 10)) == {"v9_set"}
    assert set(db.list_entry_ids(EntryFilters(provider="stable-audio"), 10)) == {
        "v9_generated"
    }
    assert set(db.list_entry_ids(EntryFilters(provider="bandcamp"), 10)) == {
        "v9_labeled"
    }
    assert _column(db, "v9_set") is None
    db.close()


def test_a_failed_step_ten_leaves_the_old_indexes_in_place(
    v9_library: Path, monkeypatch
):
    """Step 10 drops four indexes before it builds them, so a failure half way
    through must roll the drops back -- otherwise the crash that interrupted an
    upgrade would leave a 200,000-entry library with no provider index at all
    and every provider filter a table scan."""
    steps = db_module._MIGRATIONS
    step = next(s for s in steps if s[0] == PROVIDER_REINDEX_VERSION)
    monkeypatch.setattr(
        db_module,
        "_MIGRATIONS",
        [
            *(s for s in steps if s[0] < PROVIDER_REINDEX_VERSION),
            (
                PROVIDER_REINDEX_VERSION,
                [step[1][0], "CREATE INDEX no_such_table_idx ON nope(x)"],
            ),
        ],
    )
    with pytest.raises(Exception):
        LibraryDB(v9_library)

    survivor = sqlite3.connect(str(v9_library))
    survivor.row_factory = sqlite3.Row
    assert set(PROVIDER_INDEXES) <= _indexes(survivor)
    for name in EXPRESSION_INDEXES:
        assert "ELSE 'stable-audio'" in _index_sql(survivor, name), name
    survivor.close()

    # A clean reopen with the real statement list still finishes the upgrade.
    monkeypatch.undo()
    db = LibraryDB(v9_library)
    assert db.schema_version() == SCHEMA_VERSION
    for name in EXPRESSION_INDEXES:
        assert db_module._PROVIDER_INDEX_EXPR in _index_sql(db._conn, name), name
    db.close()


#: The expression the v10 indexes were built from: the fallback as it stood
#: after step 10 and before the Suno arm learned ``chirp``. A literal for the
#: same reason :data:`V9_INDEX_EXPR` is one -- it no longer exists anywhere in
#: the module, and it is what a library upgraded before step 11 has on disk.
V10_INDEX_EXPR = """COALESCE(NULLIF(provider, ''), CASE
        WHEN source = 'suno'
             OR instr(lower(model), 'suno') > 0 THEN 'suno'
        WHEN instr(lower(model), 'magenta') > 0
             OR instr(lower(model), 'gemini') > 0 THEN 'gemini-magenta'
        WHEN instr(replace(lower(model), 'audio', ''), 'udio') > 0 THEN 'udio'
        WHEN instr(lower(model), 'riffusion') > 0 THEN 'riffusion'
        WHEN source = 'import' THEN 'import'
        WHEN source = 'generate'
             OR source = 'studio' THEN 'stable-audio'
        ELSE 'thedaw'
    END)"""


def _seed_v10_rows(db: LibraryDB) -> None:
    """Three rows the v10 rule and the v11 rule disagree about by exactly one.

    ``v10_chirp`` is the user's real shape: a Suno song whose ``model`` is
    ``chirp-*`` and whose ``source`` is NOT 'suno' -- an import of the audio.
    The v10 rule files it under 'import'; the v11 rule files it under 'suno'.
    """
    db._conn.executemany(
        "INSERT INTO entries (id, kind, title, model, source, provider, "
        "created_at, updated_at, metadata_json) "
        "VALUES (?, 'audio', ?, ?, ?, ?, 1.0, 1.0, '{}')",
        [
            ("v10_chirp", "v10_chirp", "chirp-v4", "import", None),
            ("v10_generated", "v10_generated", "medium", "generate", None),
            ("v10_labeled", "v10_labeled", "chirp-crow", "import", "bandcamp"),
        ],
    )
    db._conn.commit()


@pytest.fixture
def v10_library(tmp_path: Path) -> Path:
    """A library migrated by the v10 build: all four provider indexes are
    there, and the two expression ones carry the pre-chirp fallback text.

    Built the way ``v9_library`` is and for the same reason: step 10's
    statements interpolate the module's LIVE expression, so re-running them
    today would build the new text rather than the historical one. The two
    expression indexes are therefore rebuilt here from :data:`V10_INDEX_EXPR`,
    a literal.
    """
    current = db_module._MIGRATIONS
    db_module._MIGRATIONS = [
        step for step in current if step[0] <= PROVIDER_REINDEX_VERSION
    ]
    try:
        db = LibraryDB(tmp_path / "library.db")
        assert db.schema_version() == PROVIDER_REINDEX_VERSION
        _seed_v10_rows(db)
    finally:
        db_module._MIGRATIONS = current
    for name in EXPRESSION_INDEXES:
        db._conn.execute(f"DROP INDEX {name}")
    db._conn.execute(
        f"CREATE INDEX idx_entries_provider_created "
        f"ON entries(kind, {V10_INDEX_EXPR}, created_at DESC)"
    )
    db._conn.execute(
        f"CREATE INDEX idx_entries_provider_any_kind "
        f"ON entries({V10_INDEX_EXPR}, created_at DESC)"
    )
    db._conn.commit()
    for name in EXPRESSION_INDEXES:
        sql = _index_sql(db._conn, name)
        assert "ELSE 'thedaw'" in sql, name
        assert "chirp" not in sql, name
    db.close()
    return tmp_path / "library.db"


def test_step_eleven_rebuilds_the_expression_indexes_and_rewrites_no_row(
    v10_library: Path,
):
    """T14, under the contract step 10 already has.

    The Suno arm learned ``chirp`` -- Suno's model family, and the only thing
    an exported Suno song's ``model`` column ever says -- which is a change to
    the TEXT two of these indexes are declared on. SQLite matches an expression
    index by that text, so an index left from v10 could neither serve the new
    comparison nor hold the right slug for a ``chirp-*`` row. Step 11 rebuilds
    all four from the current expression, rewrites no row, and opens no
    ``metadata_json``.
    """
    old = sqlite3.connect(str(v10_library))
    old.row_factory = sqlite3.Row
    before = _row_dump(old, V9_COLUMNS)
    old.close()

    # A v10 file opens at the current version, which step 11 is no longer the
    # last of; every later step must leave the entry rows alone too.
    db = LibraryDB(v10_library)
    assert db.schema_version() == SCHEMA_VERSION >= PROVIDER_CHIRP_VERSION
    assert _row_dump(db._conn, V9_COLUMNS) == before
    assert set(PROVIDER_INDEXES) <= _indexes(db._conn)

    for name in EXPRESSION_INDEXES:
        sql = _index_sql(db._conn, name)
        assert db_module._PROVIDER_INDEX_EXPR in sql, name
        assert "'chirp'" in sql, name

    # And the rule the rebuilt indexes answer is the new one: the imported
    # ``chirp-*`` row is Suno now, the generation is untouched, and the row
    # whose column was already resolved from its own metadata keeps it -- a
    # ``chirp-crow`` model does not outrank a stored label.
    assert set(db.list_entry_ids(EntryFilters(provider="suno"), 10)) == {"v10_chirp"}
    assert set(db.list_entry_ids(EntryFilters(provider="stable-audio"), 10)) == {
        "v10_generated"
    }
    assert set(db.list_entry_ids(EntryFilters(provider="bandcamp"), 10)) == {
        "v10_labeled"
    }
    assert set(db.list_entry_ids(EntryFilters(provider="import"), 10)) == set()
    assert _column(db, "v10_chirp") is None
    db.close()


def test_a_failed_step_eleven_leaves_the_v10_indexes_in_place(
    v10_library: Path, monkeypatch
):
    """Step 11 drops four indexes before it builds them, so a failure half way
    through must roll the drops back -- the same guarantee step 10 has, and
    what keeps an interrupted upgrade from leaving a 200,000-entry library with
    no provider index at all."""
    steps = db_module._MIGRATIONS
    step = next(s for s in steps if s[0] == PROVIDER_CHIRP_VERSION)
    monkeypatch.setattr(
        db_module,
        "_MIGRATIONS",
        [
            *(s for s in steps if s[0] < PROVIDER_CHIRP_VERSION),
            (
                PROVIDER_CHIRP_VERSION,
                [step[1][0], "CREATE INDEX no_such_table_idx ON nope(x)"],
            ),
        ],
    )
    with pytest.raises(Exception):
        LibraryDB(v10_library)

    survivor = sqlite3.connect(str(v10_library))
    survivor.row_factory = sqlite3.Row
    assert set(PROVIDER_INDEXES) <= _indexes(survivor)
    for name in EXPRESSION_INDEXES:
        assert "chirp" not in _index_sql(survivor, name), name
    survivor.close()

    # A clean reopen with the real statement list still finishes the upgrade.
    monkeypatch.undo()
    db = LibraryDB(v10_library)
    assert db.schema_version() == SCHEMA_VERSION
    for name in EXPRESSION_INDEXES:
        assert db_module._PROVIDER_INDEX_EXPR in _index_sql(db._conn, name), name
    db.close()


# ---------------------------------------------------------------------------
# Writers
# ---------------------------------------------------------------------------


def test_every_upsert_resolves_the_column_from_the_metadata_it_writes(tmp_path: Path):
    """One choke point: the column is derived inside ``_entry_row``, so every
    writer that upserts a row fills it without knowing it exists."""
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry(_payload("a", metadata_json={"provider": "Bandcamp"}))
    db.upsert_entries_bulk(
        [
            _payload("b", source="import", metadata_json={"suno_id": "s-02"}),
            _payload("c", metadata_json={"tags": ["sunoid:s-03"]}),
            _payload("d", model="udio-1", source="import"),
        ]
    )
    # Stored lowercase and bounded, from the metadata, never from the columns.
    assert _column(db, "a") == "bandcamp"
    assert _column(db, "b") == "suno"
    assert _column(db, "c") == "suno"
    # Nothing in d's METADATA names a provider, so the column stays unresolved
    # and the fallback answers for it.
    assert _column(db, "d") is None
    assert set(db.list_entry_ids(EntryFilters(provider="udio"), 10)) == {"d"}
    db.close()


def test_an_upsert_carries_the_column_with_the_metadata_it_replaces(tmp_path: Path):
    """A re-upsert that changes the metadata changes the column in the same
    statement, so the two can never describe different providers."""
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry(_payload("a", metadata_json={"provider": "bandcamp"}))
    assert _column(db, "a") == "bandcamp"
    db.upsert_entry(_payload("a", metadata_json={"provider": "soundcloud"}))
    assert _column(db, "a") == "soundcloud"
    assert set(db.list_entry_ids(EntryFilters(provider="soundcloud"), 10)) == {"a"}
    assert db.list_entry_ids(EntryFilters(provider="bandcamp"), 10) == []
    db.close()


def test_the_metadata_write_through_resolves_the_column_in_the_same_write(
    tmp_path: Path,
):
    """``set_entry_metadata`` is the read path's narrow, metadata-only write
    (T08). It writes the column beside the blob in one statement: a label the
    read path just recorded has to be a label the filter answers to, which is
    the entire reason that method exists."""
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry(_payload("a", source="import"))
    assert _column(db, "a") is None
    before = db.library_revision()

    assert db.set_entry_metadata({"a": {"provider": "bandcamp"}}) == 1

    assert _column(db, "a") == "bandcamp"
    assert set(db.list_entry_ids(EntryFilters(provider="bandcamp"), 10)) == {"a"}
    # Still not an edit: no revision bump, no updated_at move.
    assert db.library_revision() == before
    db.close()


def test_an_import_and_a_reindex_resolve_the_column_from_disk(tmp_path: Path):
    """The store's two metadata-owning writers. ``reindex()`` re-reads every
    ``metadata.json`` by design -- it is the user-invoked repair path -- so it
    resolves the column for the rows it rebuilds, without being a new walk."""
    root = tmp_path / "lib"
    root.mkdir(parents=True, exist_ok=True)
    _seed_entry(root, "labeled", {"provider": "bandcamp", "provider_label": "Bandcamp"})
    _seed_entry(root, "legacy", {"source": "import", "suno_id": "s-04"})
    _seed_entry(root, "plain", {"model": "medium", "source": "generate"})
    store = LibraryStore(root)  # opening auto-reindexes
    assert store.db is not None
    assert _column(store.db, "labeled") == "bandcamp"
    assert _column(store.db, "legacy") == "suno"
    assert _column(store.db, "plain") is None

    # A hand-repaired metadata.json is picked up by the repair path.
    (root / "plain" / "metadata.json").write_text(
        json.dumps({"id": "plain", "audio_filename": "audio.mp3", "provider": "udio"}),
        encoding="utf-8",
    )
    store.reindex()
    assert _column(store.db, "plain") == "udio"


# ---------------------------------------------------------------------------
# Never overwrite
# ---------------------------------------------------------------------------


def test_filling_never_overwrites_a_provider_the_row_already_has(tmp_path: Path):
    """The same never-overwrite rule the metadata blob lives under, spelled in
    the UPDATE's own WHERE clause so two threads racing on one row cannot both
    win with different values."""
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry(_payload("a", metadata_json={"provider": "bandcamp"}))
    db.upsert_entry(_payload("b", source="import"))

    assert db.fill_entry_providers({"a": "soundcloud", "b": "suno"}) == 1

    assert _column(db, "a") == "bandcamp"
    assert _column(db, "b") == "suno"
    # And a second call for the same rows writes nothing at all.
    assert db.fill_entry_providers({"a": "soundcloud", "b": "udio"}) == 0
    assert _column(db, "b") == "suno"
    db.close()


# ---------------------------------------------------------------------------
# Lazy resolution, and what the user sees before it happens
# ---------------------------------------------------------------------------


@pytest.fixture
def older_library(tmp_path: Path) -> LibraryStore:
    """A library whose rows were labeled BEFORE the column existed: the answer
    is in each ``metadata.json``, the column is NULL."""
    root = tmp_path / "lib"
    root.mkdir(parents=True, exist_ok=True)
    _seed_entry(root, "shop", {"source": "import", "provider": "bandcamp"})
    _seed_entry(root, "legacy", {"source": "import", "suno_id": "s-05"})
    _seed_entry(root, "plain", {"source": "generate", "model": "medium"})
    store = LibraryStore(root)
    assert store.db is not None
    store.db._conn.execute("UPDATE entries SET provider = NULL")
    store.db._conn.commit()
    return store


def test_an_unresolved_row_is_filtered_counted_and_faceted_under_one_slug(
    older_library: LibraryStore,
):
    """What the user sees between "column NULL" and "column filled".

    The row is returned by, counted in and faceted under the SAME slug at every
    moment -- the fallback's, before; its metadata's, after -- because all
    three read one expression. The answer changes; it is never split, and no
    entry is ever returned under two slugs.
    """
    db = older_library.db
    assert db is not None

    def agree() -> dict[str, int]:
        facet = {
            row["value"]: row["count"]
            for row in db.facet_counts(EntryFilters(), ["provider"])["provider"]
        }
        seen: dict[str, list[str]] = {}
        for slug, count in facet.items():
            ids = db.list_entry_ids(EntryFilters(provider=slug), 100)
            assert (
                count
                == len(ids)
                == db.count_entries_filtered(EntryFilters(provider=slug))
            ), slug
            for entry_id in ids:
                seen.setdefault(entry_id, []).append(slug)
        assert all(len(slugs) == 1 for slugs in seen.values()), seen
        assert sum(facet.values()) == 3
        return facet

    # Before: the fallback answers. 'shop' is filed under 'import' (its source)
    # even though its metadata says bandcamp -- consistently, in all three.
    assert agree() == {"import": 2, "stable-audio": 1}

    older_library.list_entries_page(EntryFilters(), limit=10)

    # After: the metadata's answer, in all three.
    assert agree() == {"bandcamp": 1, "suno": 1, "stable-audio": 1}


def test_the_first_read_resolves_an_older_row_and_the_second_writes_nothing(
    older_library: LibraryStore,
):
    """Resolution is once per row and then free: the second view of the same
    page issues no UPDATE at all, because there is nothing left unresolved."""
    db = older_library.db
    assert db is not None

    first = _traced(
        db, lambda: older_library.list_entries_page(EntryFilters(), limit=10)
    )
    assert _column(db, "shop") == "bandcamp"
    assert _column(db, "legacy") == "suno"
    # 'plain' names no provider, so there is nothing to resolve for it and it
    # is not written on this read or any later one.
    assert _column(db, "plain") is None
    assert any("UPDATE entries SET provider" in sql for sql in first)

    second = _traced(
        db, lambda: older_library.list_entries_page(EntryFilters(), limit=10)
    )
    assert not any("UPDATE entries SET provider" in sql for sql in second)


def test_a_provider_filtered_page_never_refiles_its_own_rows(
    older_library: LibraryStore,
):
    """A page chosen by SQL under one slug must not be relabeled underneath the
    user's cursor -- rows would vanish from the result set as it is read and
    ``total`` would disagree with the rows. Same rule the read-time provider
    upgrade follows (``router._attach_analysis``)."""
    db = older_library.db
    assert db is not None
    traced = _traced(
        db,
        lambda: older_library.list_entries_page(
            EntryFilters(provider="import"), limit=10
        ),
    )
    assert not any("UPDATE entries SET provider" in sql for sql in traced)
    assert _column(db, "shop") is None


# ---------------------------------------------------------------------------
# No query opens the blob
# ---------------------------------------------------------------------------


def test_the_filtered_list_count_ids_and_facet_never_open_metadata_json(
    tmp_path: Path,
):
    """The structural guarantee, which does not depend on machine speed.

    Every statement these four issue is captured and checked for the column
    whose size is the defect, and every plan is checked for an index rather
    than a table scan. The page row itself still RETURNS ``metadata_json`` --
    the record needs its tags and lyrics -- but no predicate, group key or sort
    key reads it, so the cost is 200 rows rather than the whole library.
    """
    db = LibraryDB(tmp_path / "library.db", enable_fts=False)
    db.upsert_entries_bulk(
        [
            _payload(f"e{i:03d}", metadata_json={"provider": "bandcamp"})
            for i in range(20)
        ]
    )
    filters = EntryFilters(kinds=frozenset({"audio"}), provider="bandcamp")
    operations = {
        "page": lambda: db.list_entries_page(filters, limit=200),
        "count": lambda: db.count_entries_filtered(filters),
        "ids": lambda: db.list_entry_ids(filters, 5000),
        "facet": lambda: db.facet_counts(filters, ["provider"]),
    }
    for label, run in operations.items():
        for sql in _traced(db, run):
            assert "metadata_json" not in sql, (label, sql)
            plan = " | ".join(_plan(db._conn, sql))
            assert "metadata_json" not in plan, (label, plan)
    db.close()


# ---------------------------------------------------------------------------
# The budget, on realistic rows
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def realistic_db(tmp_path_factory) -> LibraryDB:
    """60,000 entries whose metadata is padded to ~8 KB each.

    This is the fixture the defect needs: at two bytes of metadata per row --
    what every other perf fixture in this repo uses -- reading every row's
    blob is free and a rule that does it looks fast. ``enable_fts=False``
    because nothing here searches; the full-text index would only lengthen the
    build.
    """
    path = tmp_path_factory.mktemp("provider_perf") / "library.db"
    db = LibraryDB(path, enable_fts=False)
    models = ["medium", "small", "suno", "udio-1", "riffusion", "gemini-music"]
    sources = ["generate", "import", "studio", "folder"]
    pad = {
        f"raw_field_{i}": _PAD_CHUNK
        for i in range(PERF_BLOB_BYTES // len(_PAD_CHUNK) + 1)
    }

    def payloads():
        for i in range(PERF_ROWS):
            meta = dict(pad)
            if i % 3 == 0:
                meta["provider"] = "bandcamp"
            # A RARE slug: the worst case for a filter that cannot seek, since
            # a scan runs to the end of the table before it has 200 rows.
            elif i % 6007 == 1:
                meta["provider"] = RARE_SLUG
            yield _payload(
                f"e{i:07d}",
                kind="audio" if i % 10 else "video",
                model=models[i % len(models)],
                source=sources[(i // 7) % len(sources)],
                metadata_json=meta,
            )

    assert db.upsert_entries_bulk(payloads(), batch=2000) == PERF_ROWS
    assert 0 < db.count_entries_filtered(EntryFilters(provider=RARE_SLUG)) < 20
    yield db
    db.close()
    # ~0.75 GB, and pytest keeps the last three basetemp roots. Removed here so
    # nothing accumulates even when a caller forgets to clean the basetemp.
    for suffix in ("", "-wal", "-shm"):
        Path(str(path) + suffix).unlink(missing_ok=True)


def _ms(run) -> float:
    start = time.perf_counter()
    run()
    return (time.perf_counter() - start) * 1000


def _best_ms(run) -> float:
    """The fastest of :data:`BUDGET_REPEATS` runs of ``run``."""
    return min(_ms(run) for _ in range(BUDGET_REPEATS))


#: ``(label, kinds, slug)``. ``kinds=None`` is the ``?kind=all`` tab, which
#: ``router._KIND_FILTERS`` maps to no ``e.kind`` clause at all -- so the
#: leading column of ``idx_entries_provider_created`` is unconstrained and the
#: page cannot seek. A RARE slug is that shape's worst case: the scan runs the
#: longest before it has 200 rows or reaches the end.
BUDGET_CASES = [
    ("audio/common", frozenset({"audio"}), "bandcamp"),
    ("audio/suno", frozenset({"audio"}), "suno"),
    ("audio/import", frozenset({"audio"}), "import"),
    # The fallback's last arm since T13: every 'folder' row in the fixture.
    ("audio/thedaw", frozenset({"audio"}), "thedaw"),
    ("audio/rare", frozenset({"audio"}), RARE_SLUG),
    ("all/common", None, "bandcamp"),
    ("all/rare", None, RARE_SLUG),
]


@pytest.mark.parametrize(
    "label,kinds,slug", BUDGET_CASES, ids=[case[0] for case in BUDGET_CASES]
)
def test_a_provider_filtered_page_and_its_count_stay_inside_the_budget(
    realistic_db: LibraryDB, label: str, kinds, slug: str
):
    """Two guards, and the relative one is the one that means something.

    The absolute ceiling (:data:`PAGE_BUDGET_MS`) says the query is not reading
    ~480 MB of blob; it is generous on purpose, because a tight one measures the
    runner. The ratio says the provider clause SEEKS: it compares the filtered
    page with the identical page without that clause, measured on the same
    fixture in the same process, so a machine that is uniformly slow moves both
    numbers and the ratio does not move.
    """
    filters = EntryFilters(kinds=kinds, provider=slug)
    unfiltered = EntryFilters(kinds=kinds)

    page_ms = _best_ms(lambda: realistic_db.list_entries_page(filters, limit=200))
    count_ms = _best_ms(lambda: realistic_db.count_entries_filtered(filters))
    base_page_ms = _best_ms(
        lambda: realistic_db.list_entries_page(unfiltered, limit=200)
    )
    base_count_ms = _best_ms(lambda: realistic_db.count_entries_filtered(unfiltered))

    assert page_ms < PAGE_BUDGET_MS, f"{label} page took {page_ms:.1f}ms"
    assert count_ms < PAGE_BUDGET_MS, f"{label} count took {count_ms:.1f}ms"

    page_ceiling = FILTERED_SLOWDOWN_MAX * max(base_page_ms, SLOWDOWN_FLOOR_MS)
    assert page_ms < page_ceiling, (
        f"{label} page took {page_ms:.1f}ms, "
        f"{page_ms / max(base_page_ms, 0.001):.1f}x the unfiltered "
        f"{base_page_ms:.1f}ms -- the provider clause is not seeking an index"
    )
    count_ceiling = FILTERED_SLOWDOWN_MAX * max(base_count_ms, SLOWDOWN_FLOOR_MS)
    assert count_ms < count_ceiling, (
        f"{label} count took {count_ms:.1f}ms, "
        f"{count_ms / max(base_count_ms, 0.001):.1f}x the unfiltered "
        f"{base_count_ms:.1f}ms -- the provider clause is not seeking an index"
    )


def test_the_provider_facet_stays_inside_its_budget(realistic_db: LibraryDB):
    """Absolute ceiling plus the ratio against :data:`FACET_TWIN_FIELD`.

    Both facets aggregate the same rows under the same filters, so the ratio
    isolates the provider expression -- which is the thing that used to open
    every row's ``metadata_json`` -- from how fast the machine is.
    """
    for filters in (
        EntryFilters(kinds=frozenset({"audio"})),
        EntryFilters(),
        EntryFilters(kinds=frozenset({"audio"}), favorite=False),
    ):
        facet_ms = _best_ms(lambda: realistic_db.facet_counts(filters, ["provider"]))
        twin_ms = _best_ms(
            lambda: realistic_db.facet_counts(filters, [FACET_TWIN_FIELD])
        )
        assert facet_ms < FACET_BUDGET_MS, f"facet took {facet_ms:.1f}ms"
        ceiling = FILTERED_SLOWDOWN_MAX * max(twin_ms, SLOWDOWN_FLOOR_MS)
        assert facet_ms < ceiling, (
            f"provider facet took {facet_ms:.1f}ms, "
            f"{facet_ms / max(twin_ms, 0.001):.1f}x the {FACET_TWIN_FIELD} facet's "
            f"{twin_ms:.1f}ms -- the provider expression is not seeking an index"
        )


def test_the_filtered_page_is_an_index_seek_at_sixty_thousand_realistic_rows(
    realistic_db: LibraryDB,
):
    """The plan, not the clock: an indexed SEEK on the resolved expression for
    the page, its count and the id list, and a covering index for the facet.

    An expression index is matched textually-after-resolution, so a drift
    between :data:`~.db.PROVIDER_SQL` and the expression migration 9 declares
    would be SILENT -- the queries stay correct and go 60,000 rows slower.
    This is what notices.
    """
    # The text first: the indexes this plan is about are declared on the
    # module's expression, and step 10 exists so that an upgraded library's are
    # rebuilt from it. A drift between the two is what makes the seek below
    # quietly become a scan.
    for name in EXPRESSION_INDEXES:
        assert db_module._PROVIDER_INDEX_EXPR in _index_sql(realistic_db._conn, name), (
            name
        )

    filters = EntryFilters(kinds=frozenset({"audio"}), provider="bandcamp")
    plans = {
        "page": _traced(realistic_db, lambda: realistic_db.list_entries_page(filters)),
        "count": _traced(
            realistic_db, lambda: realistic_db.count_entries_filtered(filters)
        ),
        "ids": _traced(
            realistic_db, lambda: realistic_db.list_entry_ids(filters, 5000)
        ),
        "facet": _traced(
            realistic_db, lambda: realistic_db.facet_counts(filters, ["provider"])
        ),
    }
    for label, statements in plans.items():
        for sql in statements:
            plan = " | ".join(_plan(realistic_db._conn, sql))
            assert "SCAN e" not in plan, (label, plan)
            if label == "facet":
                assert "idx_entries_facet_provider" in plan, plan
            else:
                assert "idx_entries_provider_created" in plan, (label, plan)

    # The "all" tab sends no kind, so the index above cannot seek -- its
    # leading column is unconstrained. The kind-less twin is what keeps that
    # page a seek instead of a scan to the end of the table.
    any_kind = _traced(
        realistic_db,
        lambda: realistic_db.list_entries_page(EntryFilters(provider=RARE_SLUG)),
    )
    for sql in any_kind:
        plan = " | ".join(_plan(realistic_db._conn, sql))
        assert "idx_entries_provider_any_kind" in plan, plan
        assert "SCAN e" not in plan, plan


def test_the_counts_agree_with_the_filter_on_every_slug_at_scale(
    realistic_db: LibraryDB,
):
    """The invariant the facet used to break, checked on the big table: for
    every slug the facet reports, the filter returns exactly that many rows."""
    filters = EntryFilters(kinds=frozenset({"audio"}))
    facet = realistic_db.facet_counts(filters, ["provider"])["provider"]
    assert facet
    for row in facet:
        assert (
            realistic_db.count_entries_filtered(
                EntryFilters(kinds=frozenset({"audio"}), provider=row["value"])
            )
            == row["count"]
        ), row
    audio = realistic_db.count_entries_filtered(filters)
    assert sum(row["count"] for row in facet) == audio


def test_the_python_fold_and_the_sql_expression_are_one_rule(realistic_db: LibraryDB):
    """``infer_provider`` is the twin of the fallback, and the facet's fold of
    ``COALESCE(column, fallback)`` is the twin of ``PROVIDER_SQL``. Checked
    against SQL's own answer for every distinct triple in the table."""
    rows = realistic_db._conn.execute(
        "SELECT DISTINCT provider AS p, model AS m, source AS s FROM entries"
    ).fetchall()
    assert rows
    for row in rows:
        sql_answer = realistic_db._conn.execute(
            f"SELECT {db_module.PROVIDER_SQL} AS v FROM entries e "
            "WHERE e.provider IS ? AND e.model = ? AND e.source = ? LIMIT 1",
            (row["p"], row["m"], row["s"]),
        ).fetchone()["v"]
        assert (row["p"] or infer_provider(row["m"], row["s"])) == sql_answer
        assert resolved_provider_slug({"provider": row["p"]} if row["p"] else {}) == (
            row["p"] or None
        )
