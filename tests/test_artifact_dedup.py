"""Idempotent artifact persistence: re-running a generation must not leave
stale duplicate copies on disk.

The library persistence helpers (:meth:`LibraryDB.add_notation_artifact`,
``add_midi``, ``add_stem``) key rows on a stable id and ``INSERT OR REPLACE``,
so a re-run reuses the row. The gap these tests pin down is the FILE: when a
re-run writes the artifact to a *different* path (e.g. the song title/slug
changed, so the readable filename drifted) the old file used to be orphaned in
the live directory as a duplicate copy. The helper now supersedes it — moving
the old file into a sibling ``deprecated/`` folder (never deleting) — so the
live directory holds exactly one copy per stable key.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pretty_midi
import pytest

from backend.modules.library.db import LibraryDB
from backend.modules.notation.engine import midi_to_tabs


def _db(tmp_path: Path, entry_id: str = "e") -> LibraryDB:
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": entry_id, "title": entry_id})
    return db


def _write_scale_midi(path: Path) -> None:
    pm = pretty_midi.PrettyMIDI()
    inst = pretty_midi.Instrument(program=0)
    for i, pitch in enumerate([60, 62, 64, 65, 67, 69, 71, 72]):
        start = i * 0.5
        inst.notes.append(
            pretty_midi.Note(velocity=100, pitch=pitch, start=start, end=start + 0.5)
        )
    pm.instruments.append(inst)
    path.parent.mkdir(parents=True, exist_ok=True)
    pm.write(str(path))


# ---- DB helper: supersede-on-path-change --------------------------------


def test_notation_artifact_supersedes_old_file_on_path_change(tmp_path: Path):
    db = _db(tmp_path)
    notation = tmp_path / "e" / "notation"
    notation.mkdir(parents=True)
    old = notation / "OldSlug__full__guitar.alphatex"
    old.write_text("OLD", encoding="utf-8")
    db.add_notation_artifact(
        artifact_id="e__full__guitar__alphatex",
        entry_id="e",
        kind="alphatex",
        path=str(old),
    )

    new = notation / "NewSlug__full__guitar.alphatex"
    new.write_text("NEW", encoding="utf-8")
    db.add_notation_artifact(
        artifact_id="e__full__guitar__alphatex",
        entry_id="e",
        kind="alphatex",
        path=str(new),
    )

    # One row, pointing at the new file.
    rows = db.list_notation_artifacts("e", kind="alphatex")
    assert len(rows) == 1
    assert rows[0]["path"] == str(new)

    # The old copy is gone from the live directory but preserved under
    # deprecated/ (never deleted). The new copy is intact.
    assert not old.exists()
    dep = notation / "deprecated" / "OldSlug__full__guitar.alphatex"
    assert dep.is_file()
    assert dep.read_text(encoding="utf-8") == "OLD"
    assert new.read_text(encoding="utf-8") == "NEW"


def test_notation_artifact_same_path_leaves_no_deprecated(tmp_path: Path):
    db = _db(tmp_path)
    notation = tmp_path / "e" / "notation"
    notation.mkdir(parents=True)
    p = notation / "Song__full__guitar.alphatex"
    p.write_text("v1", encoding="utf-8")
    db.add_notation_artifact(
        artifact_id="e__full__guitar__alphatex",
        entry_id="e",
        kind="alphatex",
        path=str(p),
    )
    # Re-run overwrites the same path in place (identical filename).
    p.write_text("v2", encoding="utf-8")
    db.add_notation_artifact(
        artifact_id="e__full__guitar__alphatex",
        entry_id="e",
        kind="alphatex",
        path=str(p),
    )
    assert p.read_text(encoding="utf-8") == "v2"
    assert not (notation / "deprecated").exists()
    assert len(db.list_notation_artifacts("e", kind="alphatex")) == 1


def test_midi_supersedes_old_file_on_path_change(tmp_path: Path):
    db = _db(tmp_path)
    midi = tmp_path / "e" / "midi"
    midi.mkdir(parents=True)
    old = midi / "full.mid"
    old.write_bytes(b"OLDMIDI")
    db.add_midi(midi_id="e__full", entry_id="e", source="full", midi_path=str(old))

    new = midi / "full_v2.mid"
    new.write_bytes(b"NEWMIDI")
    db.add_midi(midi_id="e__full", entry_id="e", source="full", midi_path=str(new))

    rows = db.list_midis("e")
    assert len(rows) == 1 and rows[0]["midi_path"] == str(new)
    assert not old.exists()
    assert (midi / "deprecated" / "full.mid").read_bytes() == b"OLDMIDI"


def test_stem_supersedes_old_file_on_path_change(tmp_path: Path):
    db = _db(tmp_path)
    stems = tmp_path / "e" / "stems"
    stems.mkdir(parents=True)
    old = stems / "vocals.wav"
    old.write_bytes(b"OLDWAV")
    db.add_stem(
        stem_id="e__vocals", entry_id="e", stem_name="vocals", audio_path=str(old)
    )

    new = stems / "vocals_hq.wav"
    new.write_bytes(b"NEWWAV")
    db.add_stem(
        stem_id="e__vocals", entry_id="e", stem_name="vocals", audio_path=str(new)
    )

    rows = db.list_stems("e")
    assert len(rows) == 1 and rows[0]["audio_path"] == str(new)
    assert not old.exists()
    assert (stems / "deprecated" / "vocals.wav").read_bytes() == b"OLDWAV"


def test_supersede_is_noop_when_old_file_absent(tmp_path: Path):
    """A row whose previous path never materialised on disk (or was already
    moved) must not raise and must not create an empty deprecated/ dir."""
    db = _db(tmp_path)
    db.add_midi(
        midi_id="e__full",
        entry_id="e",
        source="full",
        midi_path=str(tmp_path / "e" / "midi" / "gone.mid"),
    )
    # Second add with a different, still-absent path: nothing to move.
    (tmp_path / "e" / "midi").mkdir(parents=True, exist_ok=True)
    real = tmp_path / "e" / "midi" / "full.mid"
    real.write_bytes(b"X")
    db.add_midi(midi_id="e__full", entry_id="e", source="full", midi_path=str(real))
    assert real.exists()
    assert not (tmp_path / "e" / "midi" / "deprecated").exists()


# ---- Engine: re-running the same generation is idempotent ----------------


def test_tabs_rerun_same_params_yields_one_artifact(tmp_path: Path):
    db = _db(tmp_path)
    midi = tmp_path / "e" / "midi" / "full.mid"
    _write_scale_midi(midi)
    out = tmp_path / "e" / "notation" / "Song__full__guitar.alphatex"

    def _run() -> dict:
        return midi_to_tabs(
            db,
            entry_id="e",
            midi_path=midi,
            output_path=out,
            instrument="guitar",
            title="Song",
            source_ref="e__full",
            artifact_id="e__full__guitar__alphatex",
        )

    r1 = _run()
    assert r1.get("ok"), r1
    r2 = _run()
    assert r2.get("ok"), r2

    rows = db.list_notation_artifacts("e", kind="alphatex")
    assert len(rows) == 1
    files = list((tmp_path / "e" / "notation").glob("*.alphatex"))
    assert len(files) == 1
    assert not (tmp_path / "e" / "notation" / "deprecated").exists()


def test_tabs_different_instrument_yields_distinct_artifacts(tmp_path: Path):
    db = _db(tmp_path)
    midi = tmp_path / "e" / "midi" / "full.mid"
    _write_scale_midi(midi)
    for instrument in ("guitar", "bass"):
        out = tmp_path / "e" / "notation" / f"Song__full__{instrument}.alphatex"
        r = midi_to_tabs(
            db,
            entry_id="e",
            midi_path=midi,
            output_path=out,
            instrument=instrument,
            title="Song",
            source_ref="e__full",
            artifact_id=f"e__full__{instrument}__alphatex",
        )
        assert r.get("ok"), r
    rows = db.list_notation_artifacts("e", kind="alphatex")
    assert len(rows) == 2
    files = sorted(p.name for p in (tmp_path / "e" / "notation").glob("*.alphatex"))
    assert files == ["Song__full__bass.alphatex", "Song__full__guitar.alphatex"]


# ---- Shared physical files must never be superseded ----------------------


def test_shared_physical_file_is_not_superseded(tmp_path: Path):
    """Two rows legitimately share one file (the on-disk recovery scan registers
    a file the real writer also owns). Re-pointing ONE of them must not move the
    shared file, or the other row would resolve to nothing."""
    db = _db(tmp_path)
    notation = tmp_path / "e" / "notation"
    notation.mkdir(parents=True)
    shared = notation / "full.mid"
    shared.write_bytes(b"SHARED")
    db.add_notation_artifact(
        artifact_id="e__full__midi",
        entry_id="e",
        kind="midi",
        path=str(shared),
        engine="recovered-from-disk",
    )
    db.add_notation_artifact(
        artifact_id="e__full__artifact_midi",
        entry_id="e",
        kind="midi",
        path=str(shared),
    )

    # Re-point only the mirror row at a freshly written file.
    new = notation / "full_regenerated.mid"
    new.write_bytes(b"NEW")
    db.add_notation_artifact(
        artifact_id="e__full__artifact_midi",
        entry_id="e",
        kind="midi",
        path=str(new),
    )

    assert shared.is_file(), "shared file was moved out from under the other row"
    assert not (notation / "deprecated").exists()
    still = db.get_notation_artifact("e__full__midi")
    assert still is not None and Path(still["path"]).is_file()
    assert Path(db.get_notation_artifact("e__full__artifact_midi")["path"]) == new


def test_identical_content_under_two_names_is_not_superseded(tmp_path: Path):
    """Two writers spelling one filename differently register the SAME artifact
    id with byte-identical payloads; neither copy is stale, so nothing moves
    (otherwise alternating runs ping-pong copies into deprecated/ forever)."""
    db = _db(tmp_path)
    notation = tmp_path / "e" / "notation"
    notation.mkdir(parents=True)
    bare = notation / "e__full.musicxml"
    bare.write_text("<score/>", encoding="utf-8")
    db.add_notation_artifact(
        artifact_id="e__full__musicxml",
        entry_id="e",
        kind="musicxml",
        path=str(bare),
    )
    scored = notation / "Song__e__full.musicxml"
    scored.write_text("<score/>", encoding="utf-8")  # identical payload
    db.add_notation_artifact(
        artifact_id="e__full__musicxml",
        entry_id="e",
        kind="musicxml",
        path=str(scored),
    )
    assert bare.is_file()
    assert not (notation / "deprecated").exists()


@pytest.mark.skipif(
    sys.platform != "win32",
    reason="POSIX allows renaming a file with an open handle, so the OS would "
    "never refuse the move and the assertion would be vacuous",
)
def test_locked_old_file_never_raises_and_row_stays_authoritative(tmp_path: Path):
    """A superseding move is housekeeping: when the OS refuses it (Windows holds
    the open handle), persistence of the row must still succeed and the old file
    must survive untouched in place."""
    db = _db(tmp_path)
    notation = tmp_path / "e" / "notation"
    notation.mkdir(parents=True)
    old = notation / "Old__full__guitar.alphatex"
    old.write_text("OLD", encoding="utf-8")
    db.add_notation_artifact(
        artifact_id="e__full__guitar__alphatex",
        entry_id="e",
        kind="alphatex",
        path=str(old),
    )
    new = notation / "New__full__guitar.alphatex"
    new.write_text("NEW", encoding="utf-8")
    with old.open("rb"):  # hold a handle open across the write
        db.add_notation_artifact(
            artifact_id="e__full__guitar__alphatex",
            entry_id="e",
            kind="alphatex",
            path=str(new),
        )
    row = db.get_notation_artifact("e__full__guitar__alphatex")
    assert row is not None and row["path"] == str(new)
    assert len(db.list_notation_artifacts("e", kind="alphatex")) == 1
    # The move was refused, so the old copy is still exactly where it was.
    assert old.is_file() and old.read_text(encoding="utf-8") == "OLD"
    assert not (notation / "deprecated" / old.name).exists()


# ---- Recovery scans must not re-create duplicate rows --------------------


def test_register_existing_midis_skips_an_already_represented_file(tmp_path: Path):
    """A MIDI file already represented by another row must not gain a second
    (mirror) row — that is how duplicates returned after every consolidation."""
    from backend.modules.notation.engine import register_existing_midis

    db = _db(tmp_path)
    midi_dir = tmp_path / "e" / "midi"
    midi_dir.mkdir(parents=True)
    mid = midi_dir / "full.mid"
    mid.write_bytes(b"M")
    db.add_midi(midi_id="e__full", entry_id="e", source="full", midi_path=str(mid))
    db.add_notation_artifact(
        artifact_id="e__canonical__midi",
        entry_id="e",
        kind="midi",
        path=str(mid),
        engine="music21",
    )
    before = len(db.list_notation_artifacts("e"))
    register_existing_midis(db, "e")
    assert len(db.list_notation_artifacts("e")) == before


def test_register_existing_midis_still_mirrors_an_unrepresented_file(tmp_path: Path):
    """The guard must not break normal mirroring."""
    from backend.modules.notation.engine import register_existing_midis

    db = _db(tmp_path)
    midi_dir = tmp_path / "e" / "midi"
    midi_dir.mkdir(parents=True)
    mid = midi_dir / "full.mid"
    mid.write_bytes(b"M")
    db.add_midi(midi_id="e__full", entry_id="e", source="full", midi_path=str(mid))
    register_existing_midis(db, "e")
    assert db.get_notation_artifact("e__full__artifact_midi") is not None


def test_register_on_disk_skips_an_already_represented_file(tmp_path: Path):
    """The on-disk scan derives ids from filenames, so a file a create-path row
    already owns would otherwise be recovered a second time under a new id."""
    from backend.modules.notation.engine import register_on_disk_artifacts

    db = _db(tmp_path)
    notation = tmp_path / "e" / "notation"
    notation.mkdir(parents=True)
    sheet = notation / "Song__full__lead-sheet.musicxml"
    sheet.write_text("<score/>", encoding="utf-8")
    db.add_notation_artifact(
        artifact_id="e__full__lead-sheet__musicxml",
        entry_id="e",
        kind="musicxml",
        path=str(sheet),
        engine="music21-arrange",
    )
    before = len(db.list_notation_artifacts("e"))
    recovered = register_on_disk_artifacts(db, tmp_path / "e", "e")
    assert recovered == []
    assert len(db.list_notation_artifacts("e")) == before


# ---- The canonical mirror must win over a filename-derived recovery row ---


def test_bundle_order_scan_then_mirror_yields_the_canonical_mirror(tmp_path: Path):
    """Bundle and reindex run the on-disk scan BEFORE any mirroring. The scan must
    not claim a MIDI the library owns: its filename-derived row carries no
    legacy_midi_id, so ``/from-midi/{midi_id}`` could not resolve through it."""
    import json as _json

    from backend.modules.notation.engine import (
        register_existing_midis,
        register_on_disk_artifacts,
    )

    db = _db(tmp_path)
    midi_dir = tmp_path / "e" / "midi"
    midi_dir.mkdir(parents=True)
    mid = midi_dir / "full.mid"
    mid.write_bytes(b"M")
    db.add_midi(
        midi_id="e__full",
        entry_id="e",
        source="full",
        midi_path=str(mid),
        engine="basic-pitch",
    )

    register_on_disk_artifacts(db, tmp_path / "e", "e")  # scan first
    register_existing_midis(db, "e")  # then mirror

    rows = db.list_notation_artifacts("e", kind="midi")
    assert len(rows) == 1, [r["id"] for r in rows]
    assert rows[0]["id"] == "e__full__artifact_midi"
    assert _json.loads(rows[0]["metadata_json"])["legacy_midi_id"] == "e__full"


def test_recovery_holder_is_upgradeable_by_the_mirror(tmp_path: Path):
    """A library already stuck on a recovery row must still get its mirror on the
    next scan (the consolidator then retires the recovery row)."""
    from backend.modules.notation.engine import register_existing_midis

    db = _db(tmp_path)
    midi_dir = tmp_path / "e" / "midi"
    midi_dir.mkdir(parents=True)
    mid = midi_dir / "full.mid"
    mid.write_bytes(b"M")
    db.add_midi(midi_id="e__full", entry_id="e", source="full", midi_path=str(mid))
    db.add_notation_artifact(
        artifact_id="e__full__midi",
        entry_id="e",
        kind="midi",
        path=str(mid),
        source_ref=str(mid),
        engine="recovered-from-disk",
    )

    register_existing_midis(db, "e")
    ids = {r["id"] for r in db.list_notation_artifacts("e", kind="midi")}
    assert "e__full__artifact_midi" in ids, "mirror was blocked by the recovery row"
    assert ids == {"e__full__midi", "e__full__artifact_midi"}
    assert mid.is_file()


def test_cross_table_shared_file_is_not_superseded(tmp_path: Path):
    """The shared-file guard spans TABLES: a notation mirror and a midis row point
    at one .mid, so re-pointing the midis row must not move it."""
    db = _db(tmp_path)
    midi_dir = tmp_path / "e" / "midi"
    midi_dir.mkdir(parents=True)
    mid = midi_dir / "full.mid"
    mid.write_bytes(b"M")
    db.add_midi(midi_id="e__full", entry_id="e", source="full", midi_path=str(mid))
    db.add_notation_artifact(
        artifact_id="e__full__artifact_midi", entry_id="e", kind="midi", path=str(mid)
    )

    new = midi_dir / "full_v2.mid"
    new.write_bytes(b"M2")
    db.add_midi(midi_id="e__full", entry_id="e", source="full", midi_path=str(new))

    assert mid.is_file(), "the notation mirror's file was moved out from under it"
    assert not (midi_dir / "deprecated").exists()
    mirror = db.get_notation_artifact("e__full__artifact_midi")
    assert mirror is not None and Path(mirror["path"]).is_file()


def test_sheet_path_follows_the_entry_record_title(tmp_path: Path, monkeypatch):
    """Both writers of an entry's sheet must read the title from the SAME place —
    the entry record — or their filenames diverge and they ping-pong."""
    from backend.modules.library import router as library_router_module
    from backend.modules.notation.engine import (
        _scored_name,
        _song_slug,
        sheet_output_path,
    )
    from tests.test_library_store import _seed_generate_entry

    monkeypatch.setattr(library_router_module, "_store", None)
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(tmp_path))
    _seed_generate_entry(tmp_path, "job_t", 0)
    entry_id = "job_t_00"
    store = library_router_module.get_store()
    # Diverge the entries TABLE title from the entry RECORD's title.
    store.db.upsert_entry({"id": entry_id, "title": "TableOnlyTitle"})

    record_title = str(getattr(store.get_entry(entry_id), "title", "") or "")
    path = sheet_output_path(store, entry_id, "m1")
    assert path is not None
    assert path.name == _scored_name(_song_slug(record_title), "m1.musicxml")


# ---- Listing serves one canonical artifact per file ----------------------


def test_listing_hides_a_recovery_row_shadowed_by_a_real_row(tmp_path: Path):
    """A legacy library holds both rows for one file until consolidation. The
    LISTING must serve only the real one: the recovery row has no
    legacy_midi_id and its source_ref is an absolute path, so a client reading
    the first midi artifact would resolve a filesystem path as a midi id."""
    from backend.modules.notation.engine import drop_superseded_recovery_rows

    db = _db(tmp_path)
    midi_dir = tmp_path / "e" / "midi"
    midi_dir.mkdir(parents=True)
    mid = midi_dir / "full.mid"
    mid.write_bytes(b"M")
    # The recovery row is written FIRST, so it sorts first by created_at.
    db.add_notation_artifact(
        artifact_id="e__full__midi",
        entry_id="e",
        kind="midi",
        path=str(mid),
        source_ref=str(mid),
        engine="recovered-from-disk",
    )
    db.add_notation_artifact(
        artifact_id="e__full__artifact_midi",
        entry_id="e",
        kind="midi",
        path=str(mid),
        engine="basic-pitch",
        metadata={"legacy_midi_id": "e__full"},
    )
    rows = db.list_notation_artifacts("e")
    assert [r["id"] for r in rows][0] == "e__full__midi", "precondition: older first"

    served = drop_superseded_recovery_rows(rows)
    assert [r["id"] for r in served] == ["e__full__artifact_midi"]
    # Nothing was deleted — both rows are still in the DB for the consolidator.
    assert len(db.list_notation_artifacts("e")) == 2


def test_listing_still_returns_an_unshadowed_recovery_row(tmp_path: Path):
    """A recovery row for a stray file that NO real row covers is the only
    representation of that artifact and must still be served."""
    from backend.modules.notation.engine import drop_superseded_recovery_rows

    db = _db(tmp_path)
    notation = tmp_path / "e" / "notation"
    notation.mkdir(parents=True)
    stray = notation / "Stray__hand_placed.musicxml"
    stray.write_text("<score/>", encoding="utf-8")
    db.add_notation_artifact(
        artifact_id="e__Stray__hand_placed__musicxml",
        entry_id="e",
        kind="musicxml",
        path=str(stray),
        source_ref=str(stray),
        engine="recovered-from-disk",
    )
    served = drop_superseded_recovery_rows(db.list_notation_artifacts("e"))
    assert [r["id"] for r in served] == ["e__Stray__hand_placed__musicxml"]


def test_artifacts_route_serves_one_row_per_file(tmp_path: Path, monkeypatch):
    """End to end through the route, including the ``kind`` filter: coverage is
    computed over the whole listing so a filter cannot expose the shadowed row.

    GET /{entry_id}/artifacts is a pure read (SCORE-009): it no longer mirrors
    the legacy ``midis`` row into ``notation_artifacts`` itself. That mirror
    is now an explicit step -- the one-time
    :func:`backend.modules.notation.backfill.migrate_legacy_midi_mirror`
    migration -- run here before the GET, the same way a real launch's
    background pass would run it before any client calls the route.
    """
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from backend.modules.library import router as library_router_module
    from backend.modules.notation import router as notation_router_module
    from backend.modules.notation.backfill import migrate_legacy_midi_mirror
    from tests.test_library_store import _seed_generate_entry

    monkeypatch.setattr(library_router_module, "_store", None)
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(tmp_path))
    _seed_generate_entry(tmp_path, "job_ls", 0)
    entry_id = "job_ls_00"
    app = FastAPI()
    app.include_router(library_router_module.router, prefix="/api/library")
    app.include_router(notation_router_module.router, prefix="/api/notation")
    client = TestClient(app)

    store = library_router_module.get_store()
    entry_dir = tmp_path / "job_ls" / "00"
    mid = entry_dir / "midi" / "full.mid"
    mid.parent.mkdir(parents=True, exist_ok=True)
    mid.write_bytes(b"M")
    store.db.add_notation_artifact(
        artifact_id=f"{entry_id}__full__midi",
        entry_id=entry_id,
        kind="midi",
        path=str(mid),
        source_ref=str(mid),
        engine="recovered-from-disk",
    )
    store.db.add_midi(
        midi_id=f"{entry_id}__full",
        entry_id=entry_id,
        source="full",
        midi_path=str(mid),
        engine="basic-pitch",
    )

    mig_res = migrate_legacy_midi_mirror(store)
    assert mig_res["errors"] == 0, mig_res
    assert mig_res["mirrored"] >= 1, mig_res

    r = client.get(f"/api/notation/{entry_id}/artifacts")
    assert r.status_code == 200, r.text
    body = r.json()
    # Response shape unchanged.
    assert set(body) == {"entry_id", "artifacts", "count"}
    assert body["count"] == len(body["artifacts"])
    midis = [a for a in body["artifacts"] if a["kind"] == "midi"]
    assert len(midis) == 1, [a["id"] for a in midis]
    assert midis[0]["id"] == f"{entry_id}__full__artifact_midi"
    assert (
        json.loads(midis[0]["metadata_json"])["legacy_midi_id"] == f"{entry_id}__full"
    )

    # Same answer through the kind filter, and ``count`` must describe the
    # FILTERED list (a regression returning the pre-filter count would lie).
    r = client.get(f"/api/notation/{entry_id}/artifacts", params={"kind": "midi"})
    assert r.status_code == 200
    fb = r.json()
    assert [a["id"] for a in fb["artifacts"]] == [f"{entry_id}__full__artifact_midi"]
    assert fb["count"] == len(fb["artifacts"])


def test_migrate_legacy_midi_mirror_runs_once(tmp_path: Path):
    """The one-time migration mirrors a pre-existing ``midis`` row exactly
    once: a second call (a second launch) does not rescan the library."""
    from backend.modules.notation.backfill import (
        legacy_midi_mirror_done,
        migrate_legacy_midi_mirror,
    )

    class _Store:
        def __init__(self, db: LibraryDB, root: Path) -> None:
            self.db = db
            self.root = root

        def _dir_for(self, entry_id: str):  # noqa: ANN001, ANN201 - test stub
            # No on-disk entry directories in this DB-only test: nothing for
            # the on-disk-recovery half of the migration to find.
            return None

    db = _db(tmp_path, "e")
    store = _Store(db, tmp_path)
    mid = tmp_path / "e" / "midi" / "full.mid"
    _write_scale_midi(mid)
    db.add_midi(midi_id="e__full", entry_id="e", source="full", midi_path=str(mid))

    assert legacy_midi_mirror_done(store) is False

    res1 = migrate_legacy_midi_mirror(store)
    assert res1["scanned"] == 1
    assert res1["mirrored"] == 1
    assert res1["errors"] == 0
    assert legacy_midi_mirror_done(store) is True
    mirrored_rows = db.list_notation_artifacts("e", kind="midi")
    assert len(mirrored_rows) == 1
    assert mirrored_rows[0]["id"] == "e__full__artifact_midi"

    # A second launch: the row is removed so a rescan would recreate it, but
    # the marker says it already ran, so the "second launch" call must not
    # touch the DB at all.
    db.delete_notation_artifact("e__full__artifact_midi")
    res2 = migrate_legacy_midi_mirror(store)
    assert res2 == {"scanned": 0, "mirrored": 0, "disk_recovered": 0, "errors": 0}
    assert db.list_notation_artifacts("e", kind="midi") == []


def test_migrate_legacy_midi_mirror_marks_done_only_without_errors(tmp_path: Path):
    """A run that hits an error does not mark itself done, so the failed
    entry is retried (not silently skipped forever); a run with zero errors
    marks done and clears any earlier pending ids."""
    from backend.modules.notation.backfill import (
        legacy_midi_mirror_done,
        migrate_legacy_midi_mirror,
    )

    class _Store:
        def __init__(self, db: LibraryDB) -> None:
            self.db = db

        def _dir_for(self, entry_id: str):  # noqa: ANN001, ANN201 - test stub
            return None

    db = _db(tmp_path, "good")
    db.upsert_entry({"id": "bad", "title": "bad"})
    store = _Store(db)

    good_mid = tmp_path / "good" / "midi" / "full.mid"
    _write_scale_midi(good_mid)
    db.add_midi(
        midi_id="good__full", entry_id="good", source="full", midi_path=str(good_mid)
    )
    bad_mid = tmp_path / "bad" / "midi" / "full.mid"
    _write_scale_midi(bad_mid)
    db.add_midi(
        midi_id="bad__full", entry_id="bad", source="full", midi_path=str(bad_mid)
    )

    from backend.modules.notation import engine as engine_module

    real_register_existing_midis = engine_module.register_existing_midis

    def _flaky(db_arg, entry_id):
        if entry_id == "bad":
            raise RuntimeError("simulated failure")
        return real_register_existing_midis(db_arg, entry_id)

    # migrate_legacy_midi_mirror does `from .engine import register_existing_midis`
    # fresh on every call, so patching the attribute on the engine module
    # itself (not a name inside backfill's namespace) is what actually takes
    # effect.
    engine_module.register_existing_midis = _flaky
    try:
        res1 = migrate_legacy_midi_mirror(store)
    finally:
        engine_module.register_existing_midis = real_register_existing_midis

    import backend.modules.notation.backfill as backfill_module

    assert res1["errors"] == 1, res1
    assert res1["mirrored"] == 1, res1  # "good" still mirrored
    assert legacy_midi_mirror_done(store) is False
    # "good" is not retried again; only "bad" is pending.
    state = backfill_module._read_migration_state(db)  # noqa: SLF001 - test only
    assert state["pending_ids"] == ["bad"]

    # Next call (real function restored): only "bad" is retried, and it now
    # succeeds, so the migration marks itself done.
    res2 = migrate_legacy_midi_mirror(store)
    assert res2["scanned"] == 1, res2  # only the pending id, not a full rescan
    assert res2["mirrored"] == 1, res2
    assert res2["errors"] == 0, res2
    assert legacy_midi_mirror_done(store) is True
    assert db.list_notation_artifacts("bad", kind="midi")[0]["id"] == (
        "bad__full__artifact_midi"
    )


def test_migrate_legacy_midi_mirror_abandons_after_max_attempts(tmp_path: Path, caplog):
    """An id that keeps failing is retried up to a bound, not forever: after
    3 attempts it is abandoned (dropped from pending_ids, logged), and the
    migration marks itself done rather than re-walking an ever-pending id
    (or, in an all-fail first run, the WHOLE library) on every launch."""
    import logging

    from backend.modules.notation.backfill import (
        legacy_midi_mirror_done,
        migrate_legacy_midi_mirror,
    )

    class _Store:
        def __init__(self, db: LibraryDB) -> None:
            self.db = db

        def _dir_for(self, entry_id: str):  # noqa: ANN001, ANN201 - test stub
            return None

    db = _db(tmp_path, "bad")
    store = _Store(db)
    bad_mid = tmp_path / "bad" / "midi" / "full.mid"
    _write_scale_midi(bad_mid)
    db.add_midi(
        midi_id="bad__full", entry_id="bad", source="full", midi_path=str(bad_mid)
    )

    from backend.modules.notation import engine as engine_module

    def _always_fails(db_arg, entry_id):
        raise RuntimeError("simulated permanent failure")

    monkeypatch_target = engine_module.register_existing_midis
    engine_module.register_existing_midis = _always_fails
    try:
        with caplog.at_level(
            logging.WARNING, logger="backend.modules.notation.backfill"
        ):
            res1 = migrate_legacy_midi_mirror(store)
            assert res1["errors"] == 1
            assert legacy_midi_mirror_done(store) is False

            res2 = migrate_legacy_midi_mirror(store)
            assert res2["scanned"] == 1  # still just the one pending id
            assert legacy_midi_mirror_done(store) is False

            res3 = migrate_legacy_midi_mirror(store)
            assert res3["scanned"] == 1
            # Third attempt: now abandoned, so the migration marks itself
            # done and warns about the abandoned id.
            assert legacy_midi_mirror_done(store) is True
            assert any(
                "bad" in r.message and "abandon" in r.message.lower()
                for r in caplog.records
            )
    finally:
        engine_module.register_existing_midis = monkeypatch_target

    # A fourth call is the true no-op the "done" marker promises: it must
    # not attempt "bad" again (it would still fail, if it did).
    res4 = migrate_legacy_midi_mirror(store)
    assert res4 == {"scanned": 0, "mirrored": 0, "disk_recovered": 0, "errors": 0}


def test_migrate_recovers_on_disk_artifacts_with_lost_rows(tmp_path: Path):
    """An entry whose ``notation_artifacts`` rows are lost but whose files
    survive on disk is recovered by the one-time migration itself: before
    this, ``register_on_disk_artifacts`` was reachable only from the manual
    ``POST /reindex`` route once the GET self-heal that used to call it was
    removed (SCORE-009), so a library restored from an older DB backup would
    otherwise show such an entry as permanently empty."""
    from backend.modules.notation.backfill import migrate_legacy_midi_mirror

    entry_id = "e"
    db = _db(tmp_path, entry_id)
    entry_dir = tmp_path / entry_id
    notation = entry_dir / "notation"
    notation.mkdir(parents=True)
    sheet = notation / "song.musicxml"
    sheet.write_text("<score-partwise/>", encoding="utf-8")

    class _Store:
        def __init__(self, db: LibraryDB, root: Path) -> None:
            self.db = db
            self.root = root

        def _dir_for(self, eid: str):  # noqa: ANN001, ANN201 - test stub
            d = self.root / eid
            return d if d.is_dir() else None

    store = _Store(db, tmp_path)
    assert db.list_notation_artifacts(entry_id) == []

    res = migrate_legacy_midi_mirror(store)
    assert res["errors"] == 0, res
    assert res["disk_recovered"] == 1, res

    rows = db.list_notation_artifacts(entry_id, kind="musicxml")
    assert len(rows) == 1
    assert rows[0]["path"] == str(sheet)
    assert rows[0]["engine"] == "recovered-from-disk"


def test_shadowed_recovery_musicxml_is_not_a_lead_sheet_candidate(tmp_path: Path):
    """The chord-track source search must obey the same one-artifact-per-file rule:
    a shadowed recovered-from-disk row must never be picked as the lead sheet."""
    from backend.modules.notation.router import _find_lead_sheet

    db = _db(tmp_path)
    notation = tmp_path / "e" / "notation"
    notation.mkdir(parents=True)
    sheet = notation / "Song__full__lead-sheet.musicxml"
    sheet.write_text("<score/>", encoding="utf-8")
    # _find_lead_sheet walks the candidates NEWEST-first, so the recovery row is
    # written LAST: without the filter it is reached first and wins, which is
    # exactly the regression this test pins down.
    db.add_notation_artifact(
        artifact_id="e__full__lead-sheet__musicxml",
        entry_id="e",
        kind="musicxml",
        path=str(sheet),
        engine="music21-arrange",
        metadata={"style": "lead-sheet"},
    )
    db.add_notation_artifact(
        artifact_id="e__recovered__musicxml",
        entry_id="e",
        kind="musicxml",
        path=str(sheet),
        source_ref=str(sheet),
        engine="recovered-from-disk",
        metadata={"style": "lead-sheet"},
    )
    rows = db.list_notation_artifacts("e", kind="musicxml")
    assert rows[-1]["id"] == "e__recovered__musicxml", "precondition: recovery newest"

    class _Store:
        def __init__(self, db):
            self.db = db

    chosen = _find_lead_sheet(_Store(db), "e", None)
    assert chosen is not None
    assert chosen["id"] == "e__full__lead-sheet__musicxml"
