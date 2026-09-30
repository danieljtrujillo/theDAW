"""Tests for scripts/consolidate_generation_artifacts.py.

The consolidator is a non-destructive housekeeping tool: it finds pre-existing
duplicate artifact copies (files orphaned by an older naming scheme, and
redundant DB rows for the same logical artifact) and, only with ``--apply``,
moves the superseded FILES into a sibling ``deprecated/`` folder (never
deleting) and de-duplicates the redundant DB ROWS down to the canonical one.

Invariants proven here:
  * dry-run (default) reports duplicates and modifies NOTHING (files or rows);
  * ``--apply`` moves superseded copies to deprecated/ and drops redundant rows;
  * ``--apply`` is idempotent (a second run is a no-op);
  * no data is lost — the total file count (live + deprecated/) is preserved;
  * a rowless file with NO canonical counterpart is left in place (recoverable).
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

from backend.modules.library.db import LibraryDB

_SCRIPT = (
    Path(__file__).resolve().parents[1]
    / "scripts"
    / "consolidate_generation_artifacts.py"
)


def _load_module():
    spec = importlib.util.spec_from_file_location(
        "consolidate_generation_artifacts", _SCRIPT
    )
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    # Register before exec so dataclasses can resolve cls.__module__.
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


def _count_files(root: Path) -> int:
    return sum(1 for p in root.rglob("*") if p.is_file())


def _seed_entry_with_slug_drift(tmp_path: Path) -> tuple[Path, LibraryDB, str]:
    """Entry with a canonical alphatex (current slug) whose OLD-slug copy was
    orphaned on disk, and a redundant recovered row pointing at that old copy.
    """
    root = tmp_path / "generations"
    entry_id = "e9072f8ee5f74d06a617f48b62fb7673"
    entry_dir = root / entry_id
    notation = entry_dir / "notation"
    notation.mkdir(parents=True)
    (entry_dir / "metadata.json").write_text(
        '{"id": "%s"}' % entry_id, encoding="utf-8"
    )

    canonical = notation / f"NewSong__{entry_id}__full__guitar.alphatex"
    canonical.write_text("CANON", encoding="utf-8")
    orphan = notation / f"OldSong__{entry_id}__full__guitar.alphatex"
    orphan.write_text("OLD", encoding="utf-8")

    db = LibraryDB(root / "library.db")
    db.upsert_entry({"id": entry_id, "title": "NewSong"})
    # Canonical create-scheme row.
    db.add_notation_artifact(
        artifact_id=f"{entry_id}__full__guitar__alphatex",
        entry_id=entry_id,
        kind="alphatex",
        path=str(canonical),
    )
    # Redundant recovered row for the same logical artifact, pointing at the
    # old-slug copy (as register_on_disk_artifacts would have derived it).
    db.add_notation_artifact(
        artifact_id=f"{entry_id}__OldSong__{entry_id}__full__guitar__alphatex",
        entry_id=entry_id,
        kind="alphatex",
        path=str(orphan),
        engine="recovered-from-disk",
    )
    return root, db, entry_id


def test_build_plan_reports_duplicate_without_modifying(tmp_path: Path):
    root, db, entry_id = _seed_entry_with_slug_drift(tmp_path)
    before = _count_files(root)
    rows_before = len(db.list_notation_artifacts(entry_id))

    mod = _load_module()
    plan = mod.build_plan(root=root, db_path=root / "library.db", entry_ids=[entry_id])

    # Something is flagged (a superseded file and/or a redundant row).
    assert plan.total_actions() >= 1
    # Read-only: nothing moved, no rows dropped, deprecated/ not created.
    assert _count_files(root) == before
    assert len(db.list_notation_artifacts(entry_id)) == rows_before
    assert not (root / entry_id / "notation" / "deprecated").exists()


def test_apply_moves_copy_and_dedupes_rows_losslessly(tmp_path: Path):
    root, db, entry_id = _seed_entry_with_slug_drift(tmp_path)
    before = _count_files(root)

    mod = _load_module()
    mod.build_plan(root=root, db_path=root / "library.db", entry_ids=[entry_id]).apply()

    # File total preserved (moved, never deleted).
    assert _count_files(root) == before
    # Old copy no longer in the live notation dir; it lives under deprecated/.
    notation = root / entry_id / "notation"
    live = sorted(p.name for p in notation.glob("*.alphatex"))
    assert live == [f"NewSong__{entry_id}__full__guitar.alphatex"]
    deprecated = list((notation / "deprecated").glob("*.alphatex"))
    assert len(deprecated) == 1 and deprecated[0].read_text(encoding="utf-8") == "OLD"

    # Exactly one canonical row remains.
    rows = db.list_notation_artifacts(entry_id, kind="alphatex")
    assert len(rows) == 1
    assert rows[0]["id"] == f"{entry_id}__full__guitar__alphatex"
    assert rows[0]["path"].endswith(f"NewSong__{entry_id}__full__guitar.alphatex")


def test_apply_is_idempotent(tmp_path: Path):
    root, db, entry_id = _seed_entry_with_slug_drift(tmp_path)
    mod = _load_module()
    mod.build_plan(root=root, db_path=root / "library.db", entry_ids=[entry_id]).apply()
    after_first = _count_files(root)

    # A fresh plan now finds nothing to do, and applying it changes nothing.
    plan2 = mod.build_plan(root=root, db_path=root / "library.db", entry_ids=[entry_id])
    assert plan2.total_actions() == 0
    plan2.apply()
    assert _count_files(root) == after_first
    assert len(db.list_notation_artifacts(entry_id, kind="alphatex")) == 1


def test_pure_orphan_without_canonical_is_left_in_place(tmp_path: Path):
    """A rowless file with no canonical counterpart is recoverable, not a
    duplicate — the consolidator must never move it."""
    root = tmp_path / "generations"
    entry_id = "solo"
    notation = root / entry_id / "notation"
    notation.mkdir(parents=True)
    (root / entry_id / "metadata.json").write_text('{"id": "solo"}', encoding="utf-8")
    lonely = notation / "Song__full__lead-sheet.musicxml"
    lonely.write_text("<score/>", encoding="utf-8")
    db = LibraryDB(root / "library.db")
    db.upsert_entry({"id": entry_id, "title": "Song"})

    mod = _load_module()
    plan = mod.build_plan(root=root, db_path=root / "library.db", entry_ids=[entry_id])
    plan.apply()
    assert lonely.is_file()
    assert not (notation / "deprecated").exists()


def test_cli_dry_run_is_read_only(tmp_path: Path):
    root, db, entry_id = _seed_entry_with_slug_drift(tmp_path)
    before = _count_files(root)
    proc = subprocess.run(
        [
            sys.executable,
            str(_SCRIPT),
            "--root",
            str(root),
            "--db",
            str(root / "library.db"),
            "--entry",
            entry_id,
        ],
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0, proc.stderr
    # Default is dry-run: reports but changes nothing.
    assert _count_files(root) == before
    assert not (root / entry_id / "notation" / "deprecated").exists()
    assert len(db.list_notation_artifacts(entry_id)) == 2
    assert "DRY-RUN" in proc.stdout or "dry-run" in proc.stdout.lower()


def _seed_dir(tmp_path: Path, entry_id: str, sub: str) -> tuple[Path, Path, LibraryDB]:
    root = tmp_path / "generations"
    directory = root / entry_id / sub
    directory.mkdir(parents=True)
    (root / entry_id / "metadata.json").write_text(
        '{"id": "%s"}' % entry_id, encoding="utf-8"
    )
    db = LibraryDB(root / "library.db")
    db.upsert_entry({"id": entry_id, "title": "Song"})
    return root, directory, db


def test_mirror_row_beats_recovery_row_even_with_empty_engine(tmp_path: Path):
    """register_existing_midis mirrors the midis row's own (often EMPTY) engine,
    so an empty engine must NOT be read as 'recovered'. The recovery row is the
    one to drop — keeping it instead would just let the next
    GET /notation/{entry}/artifacts re-create the mirror."""
    entry_id = "e"
    root, midi_dir, db = _seed_dir(tmp_path, entry_id, "midi")
    mid = midi_dir / "full.mid"
    mid.write_bytes(b"M")
    db.add_notation_artifact(
        artifact_id="e__full__artifact_midi",
        entry_id=entry_id,
        kind="midi",
        path=str(mid),
        engine="",
    )
    db.add_notation_artifact(
        artifact_id="e__full__midi",
        entry_id=entry_id,
        kind="midi",
        path=str(mid),
        engine="recovered-from-disk",
    )

    mod = _load_module()
    plan = mod.build_plan(root=root, db_path=root / "library.db", entry_ids=[entry_id])
    assert len(plan.row_deletes) == 1
    assert plan.row_deletes[0].row_id == "e__full__midi"
    assert plan.row_deletes[0].survivor_id == "e__full__artifact_midi"
    # Both rows point at the SAME file, so nothing is moved.
    assert plan.file_moves == []

    plan.apply()
    assert {r["id"] for r in db.list_notation_artifacts(entry_id)} == {
        "e__full__artifact_midi"
    }
    assert mid.is_file()


def test_dedupe_carries_favorite_and_repoints_relations(tmp_path: Path):
    """Collapsing a row must not silently drop user state: a favourite flag is
    carried onto the survivor and relation edges are RE-POINTED, not deleted."""
    entry_id = "e"
    root, stems_dir, db = _seed_dir(tmp_path, entry_id, "stems")
    wav = stems_dir / "vocals.wav"
    wav.write_bytes(b"W")
    db.add_stem(
        stem_id="e__vocals", entry_id=entry_id, stem_name="vocals", audio_path=str(wav)
    )
    db.add_stem(
        stem_id="e__vocals__dup",
        entry_id=entry_id,
        stem_name="vocals",
        audio_path=str(wav),
    )
    db.set_stem_favorite("e__vocals__dup", True)
    db.add_relation(from_id="e__vocals__dup", to_id="downstream", kind="midi_of")

    mod = _load_module()
    plan = mod.build_plan(root=root, db_path=root / "library.db", entry_ids=[entry_id])
    stem_drops = [rd for rd in plan.row_deletes if rd.table == "stems"]
    assert len(stem_drops) == 1
    assert stem_drops[0].row_id == "e__vocals__dup"
    assert stem_drops[0].survivor_id == "e__vocals"
    assert stem_drops[0].carries_favorite is True
    assert stem_drops[0].relation_edges == 1
    # The dry-run report says what would be carried over.
    text = plan.report(apply=False)
    assert "favorite=1 carried over" in text
    assert "relation edge(s) re-pointed" in text

    plan.apply()
    rows = db.list_stems(entry_id)
    assert len(rows) == 1 and rows[0]["id"] == "e__vocals"
    assert rows[0]["favorite"] == 1, "favourite was lost in the collapse"
    edges = db.list_relations(from_id="e__vocals")
    assert any(e["to_id"] == "downstream" for e in edges), "relation edge was lost"
    assert wav.is_file()


def test_duplicate_midi_rows_collapse(tmp_path: Path):
    """The midis table is consolidated too, not just notation_artifacts."""
    entry_id = "e"
    root, midi_dir, db = _seed_dir(tmp_path, entry_id, "midi")
    mid = midi_dir / "full.mid"
    mid.write_bytes(b"M")
    db.add_midi(midi_id="e__full", entry_id=entry_id, source="full", midi_path=str(mid))
    db.add_midi(
        midi_id="e__full__dup", entry_id=entry_id, source="full", midi_path=str(mid)
    )

    mod = _load_module()
    plan = mod.build_plan(root=root, db_path=root / "library.db", entry_ids=[entry_id])
    midi_drops = [rd for rd in plan.row_deletes if rd.table == "midis"]
    assert len(midi_drops) == 1 and midi_drops[0].row_id == "e__full__dup"
    plan.apply()
    assert [r["id"] for r in db.list_midis(entry_id)] == ["e__full"]
    assert mid.is_file()


def test_recovery_scans_do_not_recreate_rows_after_consolidation(tmp_path: Path):
    """The durability check: once consolidated, the on-disk recovery scans that
    run on bundle / reindex / artifacts reads must not re-introduce the dupes."""
    from backend.modules.notation.engine import (
        register_existing_midis,
        register_on_disk_artifacts,
    )

    root, db, entry_id = _seed_entry_with_slug_drift(tmp_path)
    mod = _load_module()
    mod.build_plan(root=root, db_path=root / "library.db", entry_ids=[entry_id]).apply()
    settled = len(db.list_notation_artifacts(entry_id))

    register_existing_midis(db, entry_id)
    register_on_disk_artifacts(db, root / entry_id, entry_id)
    assert len(db.list_notation_artifacts(entry_id)) == settled


def test_cli_apply_is_idempotent(tmp_path: Path):
    root, db, entry_id = _seed_entry_with_slug_drift(tmp_path)
    before = _count_files(root)
    argv = [
        sys.executable,
        str(_SCRIPT),
        "--root",
        str(root),
        "--db",
        str(root / "library.db"),
        "--entry",
        entry_id,
        "--apply",
    ]

    first = subprocess.run(argv, capture_output=True, text=True)
    assert first.returncode == 0, first.stderr
    assert _count_files(root) == before, "a file was lost"
    assert len(db.list_notation_artifacts(entry_id, kind="alphatex")) == 1

    second = subprocess.run(argv, capture_output=True, text=True)
    assert second.returncode == 0, second.stderr
    assert "nothing to consolidate" in second.stdout
    assert _count_files(root) == before
    assert len(db.list_notation_artifacts(entry_id, kind="alphatex")) == 1


def test_shared_tail_with_different_kinds_is_not_grouped(tmp_path: Path):
    """Row DELETION keys on the group key, and ``_tail`` only assumes the segment
    before the first ``__`` is the song slug. Two artifacts that coincidentally
    share a tail but are different KINDS must never be collapsed into one."""
    entry_id = "e"
    root, notation, db = _seed_dir(tmp_path, entry_id, "notation")
    a = notation / "Alpha__score.musicxml"
    a.write_text("A", encoding="utf-8")
    b = notation / "Beta__score.musicxml"
    b.write_text("B", encoding="utf-8")
    db.add_notation_artifact(
        artifact_id="r_xml",
        entry_id=entry_id,
        kind="musicxml",
        path=str(a),
        engine="music21",
    )
    db.add_notation_artifact(
        artifact_id="r_chart",
        entry_id=entry_id,
        kind="notechart",
        path=str(b),
        engine="notechart",
    )

    mod = _load_module()
    plan = mod.build_plan(root=root, db_path=root / "library.db", entry_ids=[entry_id])
    assert plan.row_deletes == [], "different kinds were collapsed into one group"
    assert plan.file_moves == []


def test_colliding_relation_edge_is_left_as_orphan_and_not_over_counted(
    tmp_path: Path,
):
    """When the loser's edge would collide with one the survivor already has, the
    re-point is skipped: the orphan edge is PRESERVED (never deleted) and the
    applied count must not claim it moved."""
    entry_id = "e"
    root, stems_dir, db = _seed_dir(tmp_path, entry_id, "stems")
    wav = stems_dir / "vocals.wav"
    wav.write_bytes(b"W")
    db.add_stem(
        stem_id="e__vocals", entry_id=entry_id, stem_name="vocals", audio_path=str(wav)
    )
    db.add_stem(
        stem_id="e__vocals__dup",
        entry_id=entry_id,
        stem_name="vocals",
        audio_path=str(wav),
    )
    # Survivor already carries the identical (to_id, kind) edge -> collision.
    db.add_relation(from_id="e__vocals", to_id="down", kind="midi_of")
    db.add_relation(from_id="e__vocals__dup", to_id="down", kind="midi_of")

    mod = _load_module()
    plan = mod.build_plan(root=root, db_path=root / "library.db", entry_ids=[entry_id])
    # The dry-run states an upper bound, not a promise.
    assert "up to 1 relation edge(s) re-pointed" in plan.report(apply=False)

    result = plan.apply()
    assert result["relations_repointed"] == 0, "claimed a collided edge was moved"
    assert any(e["to_id"] == "down" for e in db.list_relations(from_id="e__vocals"))
    # The loser's edge is orphaned but still present — nothing was deleted.
    assert db.list_relations(from_id="e__vocals__dup")
    assert wav.is_file()


def test_stuck_recovery_row_is_collapsed_to_the_mirror(tmp_path: Path):
    """End to end: a library stuck on a recovery row gains its mirror, and the
    consolidator then retires the recovery row, leaving the mirror canonical."""
    from backend.modules.notation.engine import register_existing_midis

    entry_id = "e"
    root, midi_dir, db = _seed_dir(tmp_path, entry_id, "midi")
    mid = midi_dir / "full.mid"
    mid.write_bytes(b"M")
    db.add_midi(midi_id="e__full", entry_id=entry_id, source="full", midi_path=str(mid))
    db.add_notation_artifact(
        artifact_id="e__full__midi",
        entry_id=entry_id,
        kind="midi",
        path=str(mid),
        source_ref=str(mid),
        engine="recovered-from-disk",
    )

    register_existing_midis(db, entry_id)
    assert len(db.list_notation_artifacts(entry_id, kind="midi")) == 2

    mod = _load_module()
    mod.build_plan(root=root, db_path=root / "library.db", entry_ids=[entry_id]).apply()
    rows = db.list_notation_artifacts(entry_id, kind="midi")
    assert [r["id"] for r in rows] == ["e__full__artifact_midi"]
    assert mid.is_file(), "the shared .mid was moved"


def test_connect_readonly_falls_back_to_immutable(tmp_path: Path, monkeypatch):
    """A WAL database with no ``-shm`` sidecar cannot be opened ``mode=ro``; the
    reader must fall back to ``immutable=1`` rather than failing the dry-run."""
    import sqlite3

    root = tmp_path / "generations"
    root.mkdir()
    db = LibraryDB(root / "library.db")
    db.upsert_entry({"id": "e", "title": "t"})
    # immutable=1 ignores the WAL, so the writer must be closed (checkpointing it
    # into the main file) for that fallback to see a complete database.
    db.close()

    mod = _load_module()
    real_connect = sqlite3.connect
    attempted: list[str] = []

    def fake_connect(database, *args, **kwargs):
        # First positional is sqlite3.connect's `database`; `uri=True` arrives as
        # a keyword, so this parameter must NOT be named `uri`.
        attempted.append(str(database))
        if "mode=ro" in str(database):
            raise sqlite3.OperationalError("simulated: unable to open database file")
        return real_connect(database, *args, **kwargs)

    monkeypatch.setattr(mod.sqlite3, "connect", fake_connect)
    conn = mod._connect_readonly(root / "library.db")
    try:
        assert conn.execute("SELECT COUNT(*) FROM entries").fetchone()[0] == 1
        # And the artifact tables the tool reads are visible.
        conn.execute("SELECT 1 FROM notation_artifacts LIMIT 1").fetchall()
    finally:
        conn.close()
    assert any("mode=ro" in u for u in attempted)
    assert any("immutable=1" in u for u in attempted)
