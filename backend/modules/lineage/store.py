"""SQLite-backed store for render lineage.

Where the library's own SQLite file (``library.db``, see
``backend.modules.library.db``) answers "what do I know about this audio
file", this module answers two different, cheaper questions that would
otherwise mean scanning every entry's sidecar:

  - "which projects/renders used this library entry as a source" --
    :meth:`LineageStore.used_in`, the reverse index over ``contributions``.
  - "what was this rendered file made from" -- :meth:`LineageStore.sources_for`,
    keyed on the render's own output entry.

The database lives in its own file, ``<library root>/lineage.db``, next to
(but never inside) the library's ``library.db``. It never opens, imports, or
depends on ``backend.modules.library.db`` -- the two stores are independent,
so a corrupt or locked ``lineage.db`` can never take the library down, and
vice versa. A render's ``record_json`` column is the canonical answer for
:meth:`LineageStore.get_render` / :meth:`LineageStore.sources_for` -- it is
decoded and returned verbatim, never rebuilt from the flattened columns,
which exist purely to make ``used_in`` and ``sources_for`` indexable.

Deleting a library entry never touches this database: there is no code path
here that removes lineage rows, so a `used_in` history survives the entry
that made it -- recovering that history is often exactly the point of
keeping it around after the entry itself is gone.

Zero external deps -- stdlib ``sqlite3`` + ``backend.modules.lineage.records``
only.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from backend.lib import paths
from backend.modules.lineage.records import LineageError, normalize_record

__all__ = [
    "LineageError",
    "LineageStore",
    "MAX_USED_IN_RENDERS",
    "SCHEMA_VERSION",
    "default_lineage_db_path",
    "default_lineage_root",
]

#: Value stored in ``schema_meta`` -- one fixed schema, no migrations yet.
SCHEMA_VERSION = "1"

#: Cap on the ``renders`` list a single ``used_in`` call returns. An entry
#: reused across thousands of renders (a drum loop, a vocal chop) would
#: otherwise make the response unbounded. The ``projects`` rollup is NOT
#: capped -- it is aggregated over every matching render before this limit
#: is applied, so its ``renders`` counts and ``last_render_at`` stay accurate
#: even for an entry with more history than fits in the capped list.
MAX_USED_IN_RENDERS = 500


_SCHEMA_STATEMENTS = (
    """
    CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS renders (
        render_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        project_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        output_entry_id TEXT,
        output_path TEXT,
        output_start_sec REAL,
        output_end_sec REAL,
        record_json TEXT NOT NULL,
        stored_at REAL NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS contributions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        render_id TEXT NOT NULL REFERENCES renders(render_id) ON DELETE CASCADE,
        library_entry_id TEXT NOT NULL,
        clip_id TEXT NOT NULL,
        track_id TEXT NOT NULL,
        start_sec REAL NOT NULL,
        end_sec REAL NOT NULL,
        source_offset_sec REAL NOT NULL,
        role TEXT NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_contributions_entry ON contributions(library_entry_id)",
    "CREATE INDEX IF NOT EXISTS idx_contributions_render ON contributions(render_id)",
    "CREATE INDEX IF NOT EXISTS idx_renders_project ON renders(project_id)",
    "CREATE INDEX IF NOT EXISTS idx_renders_output_entry ON renders(output_entry_id)",
)


_UPSERT_RENDER_SQL = """
    INSERT INTO renders (
        render_id, project_id, project_name, created_at, kind,
        output_entry_id, output_path, output_start_sec, output_end_sec,
        record_json, stored_at
    ) VALUES (
        :render_id, :project_id, :project_name, :created_at, :kind,
        :output_entry_id, :output_path, :output_start_sec, :output_end_sec,
        :record_json, :stored_at
    )
    ON CONFLICT(render_id) DO UPDATE SET
        project_id = excluded.project_id,
        project_name = excluded.project_name,
        created_at = excluded.created_at,
        kind = excluded.kind,
        output_entry_id = excluded.output_entry_id,
        output_path = excluded.output_path,
        output_start_sec = excluded.output_start_sec,
        output_end_sec = excluded.output_end_sec,
        record_json = excluded.record_json,
        stored_at = excluded.stored_at
"""

_INSERT_CONTRIBUTION_SQL = """
    INSERT INTO contributions (
        render_id, library_entry_id, clip_id, track_id,
        start_sec, end_sec, source_offset_sec, role
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
"""

_USED_IN_RENDERS_SQL = """
    SELECT render_id, project_id, project_name, created_at, kind,
           output_entry_id, output_path
    FROM renders
    WHERE render_id IN (
        SELECT DISTINCT render_id FROM contributions WHERE library_entry_id = ?
    )
    ORDER BY created_at DESC, render_id ASC
"""

_SOURCES_FOR_SQL = """
    SELECT record_json FROM renders
    WHERE output_entry_id = ?
    ORDER BY created_at DESC, render_id ASC
    LIMIT 1
"""


def default_lineage_root() -> Path:
    """The lineage database's root directory, resolved fresh on every call.

    Mirrors ``backend.modules.library.store.default_library_root()``: the
    lineage store lives next to the library it describes, so it follows the
    same ``theDAW_GENERATIONS_DIR`` override (see ``backend.lib.paths``).
    Resolved at call time, never cached, so a test that sets the env var
    before constructing a store sees it take effect without reimporting
    anything.
    """
    return paths.library_root()


def default_lineage_db_path() -> Path:
    """``<default_lineage_root()>/lineage.db``, resolved at call time."""
    return default_lineage_root() / "lineage.db"


def _now() -> float:
    return time.time()


class LineageStore:
    """Thin DAO over a single SQLite file recording render lineage.

    The connection uses ``check_same_thread=False`` so it survives FastAPI's
    threadpool, gated by an internal ``RLock`` -- the same recipe as
    ``backend.modules.library.db.LibraryDB``, but this class never imports
    that module: the two databases are independent.
    """

    def __init__(self, db_path: Path) -> None:
        self.path = db_path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._writelock = threading.RLock()
        self._conn = sqlite3.connect(str(self.path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        # Off by default; contributions relies on the ON DELETE CASCADE.
        self._conn.execute("PRAGMA foreign_keys = ON")
        # WAL gives us readers concurrent with writers.
        self._conn.execute("PRAGMA journal_mode = WAL")
        self._conn.execute("PRAGMA synchronous = NORMAL")
        self._create_schema()

    def close(self) -> None:
        with self._writelock:
            self._conn.close()

    # ---- Schema ---------------------------------------------------------

    def _create_schema(self) -> None:
        with self._writelock:
            for statement in _SCHEMA_STATEMENTS:
                self._conn.execute(statement)
            self._conn.execute(
                "INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('schema_version', ?)",
                (SCHEMA_VERSION,),
            )
            self._conn.commit()

    # ---- Connection helper ------------------------------------------------

    @contextmanager
    def _txn(self) -> Iterator[sqlite3.Cursor]:
        with self._writelock:
            cur = self._conn.cursor()
            try:
                yield cur
                self._conn.commit()
            except Exception:
                self._conn.rollback()
                raise
            finally:
                cur.close()

    # ---- Writes -------------------------------------------------------------

    def put_render(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Validate and store one render's lineage record.

        Re-posting the same ``render_id`` replaces the previous row and its
        contributions in a single transaction -- never appends -- so a
        render that is re-exported (same id, edited timeline) always
        reflects only its latest contributions. Returns the normalised
        record. Raises :class:`LineageError` -- and writes nothing -- when
        ``payload`` fails validation.
        """
        record = normalize_record(payload)
        render_id = record["render_id"]
        output = record["output"]
        params = {
            "render_id": render_id,
            "project_id": record["project_id"],
            "project_name": record["project_name"],
            "created_at": record["created_at"],
            "kind": output["kind"],
            "output_entry_id": output["library_entry_id"],
            "output_path": output["path"],
            "output_start_sec": output["start_sec"],
            "output_end_sec": output["end_sec"],
            "record_json": json.dumps(record),
            "stored_at": _now(),
        }
        contribution_rows = [
            (
                render_id,
                contribution["library_entry_id"],
                contribution["clip_id"],
                contribution["track_id"],
                contribution["start_sec"],
                contribution["end_sec"],
                contribution["source_offset_sec"],
                contribution["role"],
            )
            for contribution in record["contributions"]
        ]
        with self._txn() as cur:
            cur.execute("DELETE FROM contributions WHERE render_id = ?", (render_id,))
            cur.execute(_UPSERT_RENDER_SQL, params)
            cur.executemany(_INSERT_CONTRIBUTION_SQL, contribution_rows)
        return record

    # ---- Reads --------------------------------------------------------------

    def get_render(self, render_id: str) -> dict[str, Any] | None:
        """The stored record for ``render_id``, decoded from ``record_json``
        -- the canonical answer, never rebuilt from the flattened columns."""
        with self._writelock:
            row = self._conn.execute(
                "SELECT record_json FROM renders WHERE render_id = ?", (render_id,)
            ).fetchone()
        if row is None:
            return None
        return json.loads(row["record_json"])

    def used_in(self, library_entry_id: str) -> dict[str, Any]:
        """Every project/render that used ``library_entry_id`` as a source.

        An entry contributing many clips to the same render counts as one
        render -- the ``render_id IN (SELECT DISTINCT ...)`` subquery below
        is what collapses that, not a Python-side dedupe.
        """
        with self._writelock:
            rows = self._conn.execute(
                _USED_IN_RENDERS_SQL, (library_entry_id,)
            ).fetchall()

        projects_by_id: dict[str, dict[str, Any]] = {}
        for row in rows:
            project_id = row["project_id"]
            project = projects_by_id.get(project_id)
            if project is None:
                # Rows arrive sorted by created_at DESC, so the first row
                # seen for a given project is necessarily its most recent.
                projects_by_id[project_id] = {
                    "project_id": project_id,
                    "project_name": row["project_name"],
                    "renders": 1,
                    "last_render_at": row["created_at"],
                }
            else:
                project["renders"] += 1

        # Primary key last_render_at DESC, secondary key project_name ASC:
        # sort ascending by name first, then a stable sort on the primary
        # key preserves that ordering within ties.
        projects = sorted(projects_by_id.values(), key=lambda p: p["project_name"])
        projects.sort(key=lambda p: p["last_render_at"], reverse=True)

        renders = [
            {
                "render_id": row["render_id"],
                "created_at": row["created_at"],
                "kind": row["kind"],
                "project_id": row["project_id"],
                "project_name": row["project_name"],
                "output_entry_id": row["output_entry_id"],
                "output_path": row["output_path"],
            }
            for row in rows[:MAX_USED_IN_RENDERS]
        ]

        return {
            "entry_id": library_entry_id,
            "projects": projects,
            "renders": renders,
        }

    def sources_for(self, library_entry_id: str) -> dict[str, Any]:
        """The most recent render whose output was ``library_entry_id``."""
        with self._writelock:
            row = self._conn.execute(_SOURCES_FOR_SQL, (library_entry_id,)).fetchone()
        record = json.loads(row["record_json"]) if row is not None else None
        return {"entry_id": library_entry_id, "render": record}
