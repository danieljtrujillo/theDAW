#!/usr/bin/env python3
"""Consolidate duplicate generation artifacts (tabs / scores / chords / MIDI /
stems) non-destructively.

Re-running a generation used to leave stale duplicate copies on disk when the
output filename drifted (e.g. the song title/slug changed) while the DB row —
keyed on a stable id — was correctly replaced. The create paths now supersede
the old file automatically (see ``backend.modules.library.db.add_*`` ->
``supersede_artifact_file``) and the on-disk recovery scans no longer re-register
a file some other row already represents, but libraries built before those fixes
still carry:

  * REDUNDANT ROWS: two ``notation_artifacts`` / ``midis`` / ``stems`` rows for
    the SAME logical artifact (typically a create-scheme row, or the
    ``__artifact_midi`` mirror row, plus a ``recovered-from-disk`` row that was
    derived from the filename); and
  * SUPERSEDED FILE COPIES: files on disk that duplicate a canonical,
    row-referenced artifact under an older name.

This tool reports and (with ``--apply``) fixes both, WITHOUT deleting anything on
disk: superseded copies are MOVED into a sibling ``deprecated/`` folder, and
redundant rows collapse onto the canonical one. The collapse is lossless — a
dropped row's ``favorite`` flag is carried onto the survivor and any ``relations``
edge that referenced it is RE-POINTED (never cascade-deleted) — so the dedupe
cannot silently drop user state. It is idempotent (a second run is a no-op) and
safe: a rowless file with no canonical counterpart is left in place, because that
is a recoverable artifact rather than a duplicate.

Default is DRY-RUN (read-only; opens the DB read-only and touches no file).
Pass ``--apply`` to perform the moves + row de-dup. Running ``--apply`` on a real
library is a persistence change; get explicit approval first.

    # Report duplicates for one entry (read-only):
    python scripts/consolidate_generation_artifacts.py --entry <entry_id>

    # Report across the whole library:
    python scripts/consolidate_generation_artifacts.py

    # Actually consolidate (moves to deprecated/, collapses rows):
    python scripts/consolidate_generation_artifacts.py --apply
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Optional

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

from backend.modules.library.db import (  # noqa: E402
    ARTIFACT_PATH_COLUMNS,
    DEPRECATED_DIRNAME,
    normalize_artifact_path,
    supersede_artifact_file,
)
from backend.modules.notation.engine import _kind_and_stem_for_file  # noqa: E402

# The column that flags a recovered row, per table. The path column comes from
# the DB layer's own ARTIFACT_PATH_COLUMNS so the two can never drift.
_ENGINE_COLUMN = {
    "notation_artifacts": "engine",
    "midis": "engine",
    "stems": "model",
}
# table -> (path column, engine/model column).
_TABLES = {
    table: (path_col, _ENGINE_COLUMN[table])
    for table, path_col in ARTIFACT_PATH_COLUMNS
}
# The engine value register_on_disk_artifacts stamps. NOTE: an EMPTY engine is
# deliberately NOT treated as recovered — register_existing_midis mirrors a
# midis row's own (often empty) engine, and misreading that as "recovered" would
# drop the mirror row in favour of the recovery row, which the next
# GET /notation/{entry}/artifacts would simply re-create.
_RECOVERED_ENGINE = "recovered-from-disk"
# Suffix of the id register_existing_midis mirrors a midis row under.
_MIRROR_SUFFIX = "__artifact_midi"
# Entry sub-directories that hold artifact files (matches the notation engine's
# on-disk scan). ``deprecated/`` sub-folders are never scanned.
_SUBDIR_TABLE = {
    "notation": "notation_artifacts",
    "midi": "midis",
    "stems": "stems",
}


def _row_kind(row: sqlite3.Row) -> str:
    """The row's ``kind`` when it has that column (notation_artifacts), else ""."""
    try:
        return str(row["kind"] or "")
    except (IndexError, KeyError):
        return ""


def _tail(name: str) -> str:
    """The stable part of a scored artifact filename: everything after the
    leading ``<song-slug>__`` prefix that ``_scored_name`` prepends. Files
    written for the same logical artifact under different song slugs share this
    tail (``OldSong__x__full__guitar.alphatex`` and
    ``NewSong__x__full__guitar.alphatex`` both -> ``x__full__guitar.alphatex``).
    A name with no ``__`` (a bare stem/MIDI filename) is its own tail."""
    return name.split("__", 1)[1] if "__" in name else name


def _connect_readonly(db_path: Path) -> sqlite3.Connection:
    """Read-only connection, so a dry-run provably cannot write.

    Falls back to ``immutable=1`` because a WAL database whose ``-shm``/``-wal``
    sidecars are absent cannot be opened ``mode=ro``. That fallback reads ONLY the
    main database file and ignores the WAL.

    The probe rejects a connection only when an artifact TABLE is absent, which is
    what catches a snapshot too old to have the schema. It does NOT detect rows
    that exist only in an un-checkpointed WAL: an empty result is indistinguishable
    from an empty library and is accepted, so a stale ``immutable=1`` snapshot can
    still under-report. A genuinely empty new library is therefore accepted, as it
    should be.
    """
    last_error: Optional[BaseException] = None
    for uri in (
        f"file:{db_path}?mode=ro",
        f"file:{db_path}?immutable=1",
    ):
        conn: Optional[sqlite3.Connection] = None
        try:
            conn = sqlite3.connect(uri, uri=True)
            conn.row_factory = sqlite3.Row
            for table in _TABLES:
                conn.execute(f"SELECT 1 FROM {table} LIMIT 1").fetchall()
            return conn
        except sqlite3.Error as exc:
            last_error = exc
            if conn is not None:
                conn.close()
    raise sqlite3.OperationalError(
        f"cannot read {db_path} read-only (last error: {last_error})"
    )


@dataclass(frozen=True)
class RowDelete:
    table: str
    row_id: str
    survivor_id: str
    entry_id: str
    carries_favorite: bool = False
    relation_edges: int = 0


@dataclass(frozen=True)
class FileMove:
    src: Path
    canonical: Path
    entry_id: str
    reason: str


@dataclass
class Plan:
    db_path: Path
    row_deletes: list[RowDelete] = field(default_factory=list)
    file_moves: list[FileMove] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def total_actions(self) -> int:
        return len(self.row_deletes) + len(self.file_moves)

    def report(self, *, apply: bool) -> str:
        banner = "APPLY" if apply else "DRY-RUN (read-only; nothing changed)"
        lines = [f"=== consolidate_generation_artifacts [{banner}] ==="]
        for note in self.notes:
            lines.append(f"  note: {note}")
        if not self.total_actions():
            lines.append("  no duplicate artifacts found — nothing to consolidate.")
            return "\n".join(lines)
        if self.row_deletes:
            lines.append(f"  redundant rows to collapse ({len(self.row_deletes)}):")
            for rd in self.row_deletes:
                carried = []
                if rd.carries_favorite:
                    carried.append("favorite=1 carried over")
                if rd.relation_edges:
                    carried.append(
                        f"up to {rd.relation_edges} relation edge(s) re-pointed"
                    )
                suffix = f" [{'; '.join(carried)}]" if carried else ""
                lines.append(
                    f"    - {rd.table}: drop row {rd.row_id!r} -> keep "
                    f"{rd.survivor_id!r}{suffix}"
                )
        if self.file_moves:
            lines.append(
                f"  superseded file copies to move -> {DEPRECATED_DIRNAME}/ "
                f"({len(self.file_moves)}):"
            )
            for fm in self.file_moves:
                lines.append(f"    - {fm.src}  ({fm.reason})")
        return "\n".join(lines)

    def apply(self) -> dict:
        """Execute the plan. Drops redundant rows only after carrying their
        ``favorite`` flag and re-pointing their relation edges onto the
        survivor, and MOVES superseded files to deprecated/. Never deletes a
        file; never cascade-deletes a relation. Safe to re-run."""
        moved = 0
        dropped = 0
        relations_repointed = 0
        if self.row_deletes:
            conn = sqlite3.connect(str(self.db_path))
            conn.row_factory = sqlite3.Row
            try:
                conn.execute("PRAGMA busy_timeout = 10000")
                for rd in self.row_deletes:
                    # ``favorite`` is the ONLY user-authored column on a stems /
                    # midis row (db.py migration v5); every other column is
                    # engine-derived and the survivor is the create-path row, so
                    # carrying just this flag makes the collapse lossless.
                    if rd.carries_favorite and _has_column(conn, rd.table, "favorite"):
                        conn.execute(
                            f"UPDATE {rd.table} SET favorite = 1 WHERE id = ?",
                            (rd.survivor_id,),
                        )
                    # Re-point rather than cascade-delete: delete_midi /
                    # delete_stem would drop these edges outright. Counted by
                    # comparing the referencing rows before and after, so a
                    # self-edge counts once and an edge whose re-point collided
                    # with an existing (from,to,kind) is not claimed as moved.
                    before_ids = _relation_row_ids(conn, rd.row_id)
                    for col in ("from_id", "to_id"):
                        conn.execute(
                            f"UPDATE OR IGNORE relations SET {col} = ? WHERE {col} = ?",
                            (rd.survivor_id, rd.row_id),
                        )
                    relations_repointed += len(
                        before_ids - _relation_row_ids(conn, rd.row_id)
                    )
                    cur = conn.execute(
                        f"DELETE FROM {rd.table} WHERE id = ?", (rd.row_id,)
                    )
                    dropped += cur.rowcount or 0
                conn.commit()
            finally:
                conn.close()
        for fm in self.file_moves:
            # skip_identical=False: an identical duplicate copy is precisely
            # what consolidation retires.
            if supersede_artifact_file(
                str(fm.src), str(fm.canonical), skip_identical=False
            ):
                moved += 1
        return {
            "rows_dropped": dropped,
            "files_moved": moved,
            "relations_repointed": relations_repointed,
        }


def _has_column(conn: sqlite3.Connection, table: str, column: str) -> bool:
    return any(
        str(r[1]) == column
        for r in conn.execute(f"PRAGMA table_info({table})").fetchall()
    )


def _entry_dir(root: Path, entry_id: str) -> Optional[Path]:
    """Resolve an entry's directory (mirrors LibraryStore._dir_for): the direct
    ``<root>/<entry_id>`` layout, or the nested ``<root>/<job>/<index>`` layout
    for a ``<job>_<index>`` id."""
    direct = root / entry_id
    if (direct / "metadata.json").is_file():
        return direct
    if "_" in entry_id:
        job_id, _, index = entry_id.rpartition("_")
        nested = root / job_id / index
        if (nested / "metadata.json").is_file():
            return nested
    return None


def _canonical_rank(row: sqlite3.Row, engine_col: str, path_col: str) -> tuple:
    """Sort key for choosing the canonical row of a duplicate group; lower wins.

    1. A row whose file still exists beats a dangling one (never canonicalize a
       row that resolves to nothing while a live sibling exists).
    2. Then by id scheme: a create-path id first, the ``__artifact_midi`` mirror
       second, a ``recovered-from-disk`` row last — the recovery row is the
       derived one, and keeping it would just let the real writer re-create its
       own row next time.
    3. Then the id itself, for a deterministic choice. Never by id LENGTH: the
       mirror id is longer than the recovery id it must beat.
    """
    engine = str(row[engine_col] or "").strip().lower()
    row_id = str(row["id"] or "")
    if engine == _RECOVERED_ENGINE:
        tier = 2
    elif row_id.endswith(_MIRROR_SUFFIX):
        tier = 1
    else:
        tier = 0
    file_missing = 0 if Path(str(row[path_col] or "")).is_file() else 1
    return (file_missing, tier, row_id)


def _group_key(table: str, path: str, kind: str = "") -> tuple[str, ...]:
    """Logical identity of an artifact, so two rows/files for the same thing
    collapse — and nothing else does, because row DELETION keys on this.

    Notation artifacts are grouped by ``kind`` PLUS the slug-stripped tail:
    ``_tail`` assumes the segment before the first ``__`` is the song slug, which
    ``_scored_name`` does not guarantee, so two unrelated files can share a tail.
    Requiring the kind to match as well keeps a coincidental tail collision from
    collapsing two different artifacts. MIDI/stem files carry no slug prefix, so
    their basename is their identity.
    """
    name = Path(path).name
    if table == "notation_artifacts":
        return (table, kind, _tail(name))
    return (table, name)


def _relation_row_ids(conn: sqlite3.Connection, row_id: str) -> set[int]:
    """Ids of the ``relations`` rows that reference ``row_id`` on either end.
    One row per edge, so a self-edge is counted once."""
    return {
        int(r["id"])
        for r in conn.execute(
            "SELECT id FROM relations WHERE from_id = ? OR to_id = ?",
            (row_id, row_id),
        )
    }


def _count_relation_edges(conn: sqlite3.Connection, row_id: str) -> int:
    """How many edges reference ``row_id``. An UPPER BOUND on how many will be
    re-pointed: one whose new (from,to,kind) already exists collides and is left
    in place, which the dry-run cannot know ahead of time."""
    return len(_relation_row_ids(conn, row_id))


def build_plan(
    *, root: Path, db_path: Path, entry_ids: Optional[Iterable[str]] = None
) -> Plan:
    """Read-only scan: never opens the DB for writing and never touches a file.
    Returns a :class:`Plan` describing the de-dup that ``--apply`` would do."""
    plan = Plan(db_path=db_path)
    if not db_path.is_file():
        plan.notes.append(f"no library DB at {db_path}; nothing to scan.")
        return plan

    conn = _connect_readonly(db_path)
    try:
        if entry_ids is None:
            ids: set[str] = set()
            for table in _TABLES:
                for r in conn.execute(f"SELECT DISTINCT entry_id FROM {table}"):
                    ids.add(str(r["entry_id"]))
            targets = sorted(ids)
        else:
            targets = list(entry_ids)

        for entry_id in targets:
            _plan_entry(plan, conn, root, entry_id)
    finally:
        conn.close()
    return plan


def _plan_entry(
    plan: Plan, conn: sqlite3.Connection, root: Path, entry_id: str
) -> None:
    entry_dir = _entry_dir(root, entry_id)

    # --- Row de-dup: collapse duplicate rows per logical key --------------
    # Paths are compared normalized so two spellings of one file still match.
    # table -> {normalized path: (raw path, kind)}
    kept: dict[str, dict[str, tuple[str, str]]] = {}
    all_referenced: set[str] = set()
    loser_files: list[tuple[str, str]] = []  # (loser raw path, canonical raw path)

    for table, (path_col, engine_col) in _TABLES.items():
        rows = list(
            conn.execute(f"SELECT * FROM {table} WHERE entry_id = ?", (entry_id,))
        )
        kept[table] = {}
        for r in rows:
            all_referenced.add(normalize_artifact_path(str(r[path_col] or "")))
        groups: dict[tuple[str, ...], list[sqlite3.Row]] = {}
        for r in rows:
            groups.setdefault(
                _group_key(table, str(r[path_col] or ""), _row_kind(r)), []
            ).append(r)
        for members in groups.values():
            members.sort(key=lambda r: _canonical_rank(r, engine_col, path_col))
            canonical = members[0]
            canonical_path = str(canonical[path_col] or "")
            kept[table][normalize_artifact_path(canonical_path)] = (
                canonical_path,
                _row_kind(canonical),
            )
            for loser in members[1:]:
                loser_path = str(loser[path_col] or "")
                favorite = False
                try:
                    favorite = bool(loser["favorite"])
                except (IndexError, KeyError):
                    favorite = False
                plan.row_deletes.append(
                    RowDelete(
                        table=table,
                        row_id=str(loser["id"]),
                        survivor_id=str(canonical["id"]),
                        entry_id=entry_id,
                        carries_favorite=favorite,
                        relation_edges=_count_relation_edges(conn, str(loser["id"])),
                    )
                )
                if loser_path and normalize_artifact_path(
                    loser_path
                ) != normalize_artifact_path(canonical_path):
                    loser_files.append((loser_path, canonical_path))

    # A loser row's file is superseded only if, once its row is gone, nothing
    # else still references it.
    surviving: set[str] = set()
    for table_kept in kept.values():
        surviving |= set(table_kept)
    for loser_path, canonical_path in loser_files:
        if normalize_artifact_path(loser_path) in surviving:
            continue
        if Path(loser_path).is_file():
            plan.file_moves.append(
                FileMove(
                    src=Path(loser_path),
                    canonical=Path(canonical_path),
                    entry_id=entry_id,
                    reason="orphaned copy of a collapsed row",
                )
            )

    # --- Rowless superseded copies on disk --------------------------------
    # Files present on disk that no row references, but that share a logical
    # key with a canonical (row-referenced) file — an older-named duplicate.
    if entry_dir is None:
        return
    for sub, table in _SUBDIR_TABLE.items():
        directory = entry_dir / sub
        if not directory.is_dir():
            continue
        canon_by_key = {
            _group_key(table, raw, kind): raw
            for raw, kind in kept.get(table, {}).values()
        }
        for path in sorted(directory.iterdir()):
            if not path.is_file():
                continue  # skips the deprecated/ sub-folder
            if normalize_artifact_path(str(path)) in all_referenced:
                continue  # a real, row-referenced artifact
            file_kind = ""
            if table == "notation_artifacts":
                file_kind = _kind_and_stem_for_file(path)[0] or ""
                if not file_kind:
                    continue  # not a notation artifact at all
            canonical = canon_by_key.get(_group_key(table, str(path), file_kind))
            if canonical is None:
                continue  # no canonical counterpart -> recoverable, leave it
            plan.file_moves.append(
                FileMove(
                    src=path,
                    canonical=Path(canonical),
                    entry_id=entry_id,
                    reason="rowless copy of a canonical artifact",
                )
            )


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--entry", help="consolidate only this entry id")
    parser.add_argument(
        "--root",
        help="generations root (default: theDAW_GENERATIONS_DIR / data/generations)",
    )
    parser.add_argument("--db", help="library DB path (default: <root>/library.db)")
    parser.add_argument(
        "--apply",
        action="store_true",
        help="perform the de-dup (move copies to deprecated/, collapse redundant "
        "rows). Default is a read-only dry-run.",
    )
    args = parser.parse_args(argv)

    if args.root:
        root = Path(args.root).expanduser().resolve()
    else:
        from backend.lib import paths

        root = paths.library_root()
    db_path = Path(args.db).expanduser().resolve() if args.db else root / "library.db"

    entry_ids = [args.entry] if args.entry else None
    plan = build_plan(root=root, db_path=db_path, entry_ids=entry_ids)
    print(plan.report(apply=args.apply))
    if args.apply and plan.total_actions():
        result = plan.apply()
        print(
            f"  applied: dropped {result['rows_dropped']} row(s), "
            f"re-pointed {result['relations_repointed']} relation edge(s), "
            f"moved {result['files_moved']} file(s) to {DEPRECATED_DIRNAME}/."
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
