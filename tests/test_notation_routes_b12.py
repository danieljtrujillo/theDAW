"""Batch-12 T08 tests: notation route identity/pack/artifacts fixes and the
sheetimport path-containment fix.

SCORE-001: GET /api/notation/{id}/identity persists round-trip through the
    DETAILS identity form's PATCH /api/library/entries/{id}.
SCORE-008: GET /api/notation/pack/{artifact_id} reuses an existing, fresh PDF
    artifact instead of re-engraving on every download.
SCORE-009: GET /api/notation/{id}/artifacts is a pure read.
SEC-005: POST /api/sheetimport/parse-path only reads inside the library root
    / the app's other allowed import directories, and answers only to this
    machine, the desktop shell or a paired phone.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from tests.test_library_store import _seed_generate_entry


LOOPBACK_PEER = ("127.0.0.1", 51000)
LAN_PEER = ("10.20.30.40", 51000)


def _routes_app(tmp_path: Path, monkeypatch) -> FastAPI:
    from backend.modules.library import router as library_router_module
    from backend.modules.notation import router as notation_router_module
    from backend.modules.sheetimport import router as sheetimport_router_module

    monkeypatch.setattr(library_router_module, "_store", None)
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(tmp_path))
    app = FastAPI()
    app.include_router(library_router_module.router, prefix="/api/library")
    app.include_router(notation_router_module.router, prefix="/api/notation")
    app.include_router(sheetimport_router_module.router, prefix="/api/sheetimport")
    return app


@pytest.fixture
def routes_client(tmp_path: Path, monkeypatch) -> TestClient:
    return TestClient(_routes_app(tmp_path, monkeypatch))


@pytest.fixture
def score_client(tmp_path: Path, monkeypatch) -> TestClient:
    """The same app reached from this machine's own UI (a loopback peer), the
    caller /parse-path answers."""
    return TestClient(_routes_app(tmp_path, monkeypatch), client=LOOPBACK_PEER)


# --------------------------------------------------------------------------
# SCORE-001 — DETAILS identity form round-trip
# --------------------------------------------------------------------------


def test_identity_route_reports_auto_guess_before_any_override(
    routes_client: TestClient, tmp_path: Path
):
    """No override yet: auto_artist/auto_title come from the filename split,
    override_artist/override_title are empty."""
    _seed_generate_entry(
        tmp_path, "job_id1", 0, extra_meta={"title": "JERU THE DAMAJA - LORD LYRICAL"}
    )
    entry_id = "job_id1_00"

    r = routes_client.get(f"/api/notation/{entry_id}/identity")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["override_artist"] == ""
    assert body["override_title"] == ""
    assert body["auto_artist"] == "JERU THE DAMAJA"
    assert body["auto_title"] == "LORD LYRICAL"


def test_details_patch_round_trips_into_notation_identity(
    routes_client: TestClient, tmp_path: Path
):
    """The exact request DetailsView.tsx's saveIdentity sends -- PATCH
    /api/library/entries/{id} with notation_artist/notation_title -- is read
    back by GET /api/notation/{id}/identity as override_artist/override_title."""
    _seed_generate_entry(
        tmp_path, "job_id2", 0, extra_meta={"title": "Some Random Filename"}
    )
    entry_id = "job_id2_00"

    r = routes_client.patch(
        f"/api/library/entries/{entry_id}",
        json={"notation_artist": "Jeru The Damaja", "notation_title": "Lord Lyrical"},
    )
    assert r.status_code == 200, r.text

    r = routes_client.get(f"/api/notation/{entry_id}/identity")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["override_artist"] == "Jeru The Damaja"
    assert body["override_title"] == "Lord Lyrical"
    # The auto-guess is still reported alongside the override so the
    # inspector can show it as a placeholder.
    assert body["auto_artist"] == ""
    assert body["auto_title"] == "Some Random Filename"


def test_identity_route_404_for_unknown_entry(routes_client: TestClient):
    r = routes_client.get("/api/notation/does-not-exist/identity")
    assert r.status_code == 404


# --------------------------------------------------------------------------
# SCORE-008 — /pack reuses a fresh PDF instead of re-engraving every call
# --------------------------------------------------------------------------


def _fake_convert_score_counter(calls: dict[str, int]):
    def _fake(db, **kwargs):
        calls["n"] += 1
        output_path = Path(kwargs["output_path"])
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(b"%PDF-fake-" + str(calls["n"]).encode("ascii"))
        # Mirror the real _engrave: report the pinned engraver if one was
        # forced, else OSMD (the one it tries first) -- this is what the
        # router's freshness check (_pack_engine_still_fresh) compares
        # against on a later call.
        rendered_engine = (kwargs.get("options") or {}).get("engine") or "osmd"
        db.add_notation_artifact(
            artifact_id=kwargs["artifact_id"],
            entry_id=kwargs["entry_id"],
            kind="pdf",
            path=str(output_path),
            source_ref=kwargs.get("source_ref"),
            engine=rendered_engine,
            engine_version="1",
        )
        return {"ok": True, "path": str(output_path), "engine": rendered_engine}

    return _fake


def test_pack_reuses_fresh_pdf_and_reengraves_only_when_source_changes(
    routes_client: TestClient, tmp_path: Path, monkeypatch
):
    from backend.modules.library import router as library_router_module
    from backend.modules.notation import router as notation_router_module

    _seed_generate_entry(tmp_path, "job_pk", 0)
    entry_id = "job_pk_00"
    store = library_router_module.get_store()
    assert store.get_entry(entry_id) is not None
    entry_dir = tmp_path / "job_pk" / "00"
    sheet = entry_dir / "notation" / "song.musicxml"
    sheet.parent.mkdir(parents=True, exist_ok=True)
    sheet.write_text("<score-partwise/>", encoding="utf-8")
    store.db.add_notation_artifact(
        artifact_id="song_sheet", entry_id=entry_id, kind="musicxml", path=str(sheet)
    )

    calls = {"n": 0}
    monkeypatch.setattr(
        notation_router_module, "convert_score", _fake_convert_score_counter(calls)
    )

    r1 = routes_client.get("/api/notation/pack/song_sheet")
    assert r1.status_code == 200, r1.text
    assert calls["n"] == 1

    # Second download of the same, unchanged source: no re-engrave.
    r2 = routes_client.get("/api/notation/pack/song_sheet")
    assert r2.status_code == 200, r2.text
    assert calls["n"] == 1

    # Touch the source forward in time past the cached PDF: now stale.
    pdf_artifact = store.db.get_notation_artifact("song_sheet__pdf")
    assert pdf_artifact is not None
    pdf_mtime = Path(pdf_artifact["path"]).stat().st_mtime
    os.utime(sheet, (pdf_mtime + 5, pdf_mtime + 5))

    r3 = routes_client.get("/api/notation/pack/song_sheet")
    assert r3.status_code == 200, r3.text
    assert calls["n"] == 2


def test_pack_reengraves_when_the_identity_override_changes(
    routes_client: TestClient, tmp_path: Path, monkeypatch
):
    """The credit/title a PDF was engraved with are resolved from the
    entry's identity at engrave time (SCORE-008 follow-up): saving a new
    artist/title through the DETAILS form touches no file, so mtime alone
    never notices, and the pack kept shipping the old credit forever."""
    from backend.modules.library import router as library_router_module
    from backend.modules.notation import router as notation_router_module

    _seed_generate_entry(tmp_path, "job_id", 0)
    entry_id = "job_id_00"
    store = library_router_module.get_store()
    entry_dir = tmp_path / "job_id" / "00"
    sheet = entry_dir / "notation" / "song.musicxml"
    sheet.parent.mkdir(parents=True, exist_ok=True)
    sheet.write_text("<score-partwise/>", encoding="utf-8")
    store.db.add_notation_artifact(
        artifact_id="id_sheet", entry_id=entry_id, kind="musicxml", path=str(sheet)
    )

    calls = {"n": 0}
    monkeypatch.setattr(
        notation_router_module, "convert_score", _fake_convert_score_counter(calls)
    )

    r1 = routes_client.get("/api/notation/pack/id_sheet")
    assert r1.status_code == 200, r1.text
    assert calls["n"] == 1
    first_pdf = store.db.get_notation_artifact("id_sheet__pdf")
    assert first_pdf is not None
    first_meta = json.loads(first_pdf["metadata_json"])
    assert first_meta["pack_artist"] not in ("Jeru The Damaja", "")

    # Same request again, nothing changed: reused, not re-engraved.
    r2 = routes_client.get("/api/notation/pack/id_sheet")
    assert r2.status_code == 200, r2.text
    assert calls["n"] == 1

    # Save a new artist through the DETAILS identity form's own route -- this
    # touches metadata.json only, never the sheet file, so mtime freshness
    # alone would keep serving the old PDF.
    r = routes_client.patch(
        f"/api/library/entries/{entry_id}",
        json={"notation_artist": "Jeru The Damaja", "notation_title": "Lord Lyrical"},
    )
    assert r.status_code == 200, r.text

    r3 = routes_client.get("/api/notation/pack/id_sheet")
    assert r3.status_code == 200, r3.text
    assert calls["n"] == 2, "identity override change must force a re-engrave"
    second_pdf = store.db.get_notation_artifact("id_sheet__pdf")
    assert second_pdf is not None
    second_meta = json.loads(second_pdf["metadata_json"])
    assert second_meta["pack_artist"] == "Jeru The Damaja"

    # And now that it matches again, a third call reuses it.
    r4 = routes_client.get("/api/notation/pack/id_sheet")
    assert r4.status_code == 200, r4.text
    assert calls["n"] == 2


def test_pack_reengraves_when_a_different_engraver_is_pinned(
    routes_client: TestClient, tmp_path: Path, monkeypatch
):
    """``?engine=`` pins the PDF engraver like /export does; changing the pin
    between two downloads must not silently reuse a PDF rendered by a
    different engraver."""
    from backend.modules.library import router as library_router_module
    from backend.modules.notation import router as notation_router_module

    _seed_generate_entry(tmp_path, "job_en", 0)
    entry_id = "job_en_00"
    store = library_router_module.get_store()
    entry_dir = tmp_path / "job_en" / "00"
    sheet = entry_dir / "notation" / "song.musicxml"
    sheet.parent.mkdir(parents=True, exist_ok=True)
    sheet.write_text("<score-partwise/>", encoding="utf-8")
    store.db.add_notation_artifact(
        artifact_id="engine_sheet", entry_id=entry_id, kind="musicxml", path=str(sheet)
    )

    calls = {"n": 0}
    monkeypatch.setattr(
        notation_router_module, "convert_score", _fake_convert_score_counter(calls)
    )

    # Unpinned: the fake engraves as OSMD (its default, matching the real
    # _engrave's own preference order).
    r1 = routes_client.get("/api/notation/pack/engine_sheet")
    assert r1.status_code == 200, r1.text
    assert calls["n"] == 1

    # Pinning the SAME engraver that already rendered the cached PDF is not
    # a miss.
    r2 = routes_client.get("/api/notation/pack/engine_sheet", params={"engine": "osmd"})
    assert r2.status_code == 200, r2.text
    assert calls["n"] == 1, "pinning the engraver that already rendered it must reuse"

    # Pinning a DIFFERENT engraver than the one that actually rendered the
    # cached PDF is a miss.
    r3 = routes_client.get(
        "/api/notation/pack/engine_sheet", params={"engine": "musescore"}
    )
    assert r3.status_code == 200, r3.text
    assert calls["n"] == 2, (
        "pinning an engraver that differs from what made the cached PDF must re-engrave"
    )

    r4 = routes_client.get(
        "/api/notation/pack/engine_sheet", params={"engine": "musescore"}
    )
    assert r4.status_code == 200, r4.text
    assert calls["n"] == 2, "the same pin again must reuse"


def test_pack_rejects_an_unknown_engine_pin(
    routes_client: TestClient, tmp_path: Path, monkeypatch
):
    """An unrecognised ``?engine=`` used to pass straight through, silently
    fail inside convert_score, and still answer 200 with a source-only zip.
    It must 422 up front instead, like an unsupported /export format does."""
    from backend.modules.library import router as library_router_module
    from backend.modules.notation import router as notation_router_module

    _seed_generate_entry(tmp_path, "job_bad_engine", 0)
    entry_id = "job_bad_engine_00"
    store = library_router_module.get_store()
    entry_dir = tmp_path / "job_bad_engine" / "00"
    sheet = entry_dir / "notation" / "song.musicxml"
    sheet.parent.mkdir(parents=True, exist_ok=True)
    sheet.write_text("<score-partwise/>", encoding="utf-8")
    store.db.add_notation_artifact(
        artifact_id="bad_engine_sheet",
        entry_id=entry_id,
        kind="musicxml",
        path=str(sheet),
    )

    calls = {"n": 0}
    monkeypatch.setattr(
        notation_router_module, "convert_score", _fake_convert_score_counter(calls)
    )

    r = routes_client.get(
        "/api/notation/pack/bad_engine_sheet", params={"engine": "bogus"}
    )
    assert r.status_code == 422, r.text
    assert calls["n"] == 0, "an invalid engine must be rejected before any engraving"


# --------------------------------------------------------------------------
# SCORE-009 — GET /{entry_id}/artifacts is a pure read
# --------------------------------------------------------------------------


def test_list_artifacts_does_not_write_to_the_db(
    routes_client: TestClient, tmp_path: Path
):
    from backend.modules.library import router as library_router_module

    _seed_generate_entry(tmp_path, "job_ro", 0)
    entry_id = "job_ro_00"
    store = library_router_module.get_store()
    assert store.get_entry(entry_id) is not None
    entry_dir = tmp_path / "job_ro" / "00"

    # A legacy `midis` row with no mirrored notation_artifacts row -- exactly
    # the shape the old self-heal used to mirror on every GET.
    midi_path = entry_dir / "midi" / "scale.mid"
    midi_path.parent.mkdir(parents=True, exist_ok=True)
    midi_path.write_bytes(b"MThd")
    store.db.add_midi(
        midi_id="legacy_mid",
        entry_id=entry_id,
        source="full",
        midi_path=str(midi_path),
    )

    before_rows = store.db.list_notation_artifacts(entry_id)
    # The DB file's own mtime is a vacuous check under WAL journal mode
    # (db.py sets `PRAGMA journal_mode = WAL`): a write commits into the
    # sidecar `-wal` file, which can leave the MAIN file's mtime unchanged.
    # The `-wal` file's size is the real tell for "did anything write" --
    # SQLite only ever appends to it between checkpoints, never shrinks it.
    wal_path = store.db.path.with_name(store.db.path.name + "-wal")
    before_wal_size = wal_path.stat().st_size if wal_path.is_file() else None

    r = routes_client.get(f"/api/notation/{entry_id}/artifacts")
    assert r.status_code == 200, r.text
    assert r.json()["count"] == 0

    after_rows = store.db.list_notation_artifacts(entry_id)
    after_wal_size = wal_path.stat().st_size if wal_path.is_file() else None
    assert after_rows == before_rows == []
    assert after_wal_size == before_wal_size

    # A second read agrees -- no mirroring snuck in on either call.
    r2 = routes_client.get(f"/api/notation/{entry_id}/artifacts")
    assert r2.status_code == 200
    assert r2.json()["count"] == 0


def test_artifacts_and_identity_agree_on_existence(
    routes_client: TestClient, tmp_path: Path
):
    """/{entry_id}/artifacts and /{entry_id}/identity must 404 (or not) the
    same entries, checking the SAME two sources (a DB row OR an on-disk
    directory) rather than just one each:

    - a DB row with no on-disk directory: the old filesystem-only check
      would 404 it even though the DB (and identity) already knows it;
    - an on-disk directory not yet indexed into the DB (a real, if
      momentary, state -- engine.register_on_disk_artifacts' own docstring
      names it): a DB-only check would 404 it even though the entry
      actually exists on disk, which is a real regression a DB-only
      existence check would introduce for /artifacts.
    """
    from backend.modules.library import router as library_router_module

    store = library_router_module.get_store()
    assert store.db is not None
    # A DB row with no on-disk directory at all.
    store.db.upsert_entry({"id": "db_only_entry", "title": "DB Only"})
    assert store.get_entry("db_only_entry") is None

    r_artifacts = routes_client.get("/api/notation/db_only_entry/artifacts")
    r_identity = routes_client.get("/api/notation/db_only_entry/identity")
    assert r_artifacts.status_code == r_identity.status_code == 200
    assert r_artifacts.json()["count"] == 0

    # An on-disk directory with no DB row yet (_seed_generate_entry writes
    # straight to disk; nothing here has synced it into the DB).
    _seed_generate_entry(tmp_path, "job_disk", 0)
    disk_only_id = "job_disk_00"
    assert store.db.get_entry(disk_only_id) is None
    assert store.get_entry(disk_only_id) is not None

    r_artifacts_disk = routes_client.get(f"/api/notation/{disk_only_id}/artifacts")
    r_identity_disk = routes_client.get(f"/api/notation/{disk_only_id}/identity")
    assert r_artifacts_disk.status_code == r_identity_disk.status_code == 200
    assert r_artifacts_disk.json()["count"] == 0

    r_artifacts_404 = routes_client.get("/api/notation/never-heard-of-it/artifacts")
    r_identity_404 = routes_client.get("/api/notation/never-heard-of-it/identity")
    assert r_artifacts_404.status_code == r_identity_404.status_code == 404


# --------------------------------------------------------------------------
# SEC-005 — sheetimport /parse-path path containment
# --------------------------------------------------------------------------

_ABC_TUNE = "X:1\nT:Test Tune\nM:4/4\nL:1/4\nK:C\nC D E F|\n"


def test_parse_path_inside_library_root_succeeds(
    score_client: TestClient, tmp_path: Path
):
    score = tmp_path / "inside.abc"
    score.write_text(_ABC_TUNE, encoding="utf-8")

    r = score_client.post("/api/sheetimport/parse-path", json={"path": str(score)})
    assert r.status_code == 200, r.text
    assert r.json()["ok"] is True


def test_parse_path_answers_a_lan_caller_only_with_a_refusal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A bare LAN script sends no Origin, Referer or Sec-Fetch-Site, so it
    passed refuse_cross_site and read scores out of the library, data/ and
    every granted project folder: parsed notes for a score, 404 or 422 with
    the parser's error text for anything else. It gets 403 for all of them
    now, while this machine's own UI still parses the same file."""
    score = tmp_path / "inside.abc"
    score.write_text(_ABC_TUNE, encoding="utf-8")
    not_a_score = tmp_path / "notes.abc"
    not_a_score.write_text("not a tune", encoding="utf-8")
    app = _routes_app(tmp_path, monkeypatch)
    lan = TestClient(app, client=LAN_PEER)

    for path in (score, not_a_score, tmp_path / "missing.abc"):
        r = lan.post("/api/sheetimport/parse-path", json={"path": str(path)})
        assert r.status_code == 403, (path, r.status_code, r.text)
        assert "tune" not in r.text.lower()

    local = TestClient(app, client=LOOPBACK_PEER)
    r = local.post("/api/sheetimport/parse-path", json={"path": str(score)})
    assert r.status_code == 200, r.text
    assert r.json()["ok"] is True


def test_parse_path_outside_allowed_roots_is_refused(
    score_client: TestClient, tmp_path_factory: pytest.TempPathFactory
):
    outside_dir = tmp_path_factory.mktemp("outside_sec005")
    score = outside_dir / "outside.abc"
    score.write_text(_ABC_TUNE, encoding="utf-8")

    r = score_client.post("/api/sheetimport/parse-path", json={"path": str(score)})
    assert r.status_code == 403, r.text


def test_parse_path_dotdot_traversal_is_refused(
    score_client: TestClient, tmp_path: Path
):
    # tmp_path IS the configured library root; ".." resolves to its parent,
    # which is not one of the allowed roots.
    escaped = str(tmp_path / ".." / "escaped.abc")

    r = score_client.post("/api/sheetimport/parse-path", json={"path": escaped})
    assert r.status_code == 403, r.text


def test_parse_path_different_drive_letter_is_refused(
    score_client: TestClient, tmp_path: Path
):
    this_drive = (tmp_path.drive or "C:").upper()
    other_drive = "Z:" if this_drive != "Z:" else "Y:"
    escaped = f"{other_drive}\\thedaw-sec005-nonexistent\\escaped.abc"

    r = score_client.post("/api/sheetimport/parse-path", json={"path": escaped})
    assert r.status_code == 403, r.text


def test_parse_path_unc_path_is_refused(score_client: TestClient):
    # A UNC path never resolves inside a local library root / app data dir,
    # existing target or not -- containment is checked before any read.
    unc = r"\\evil-server\share\secret.abc"

    r = score_client.post("/api/sheetimport/parse-path", json={"path": unc})
    assert r.status_code in (403, 400, 422), r.text
    assert r.status_code != 200


def test_parse_path_junction_escape_is_refused(
    score_client: TestClient, tmp_path: Path, tmp_path_factory: pytest.TempPathFactory
):
    """A directory link planted INSIDE the library root but pointing OUTSIDE
    it must not let a path reached through the link escape containment:
    `.resolve()` collapses the link to its real target before the
    allowed-roots check runs. The link is an NTFS junction on Windows (no
    privilege needed, unlike a Windows symlink) and a symlink elsewhere, so
    the same escape is covered on every platform CI runs."""
    import subprocess
    import sys

    outside_dir = tmp_path_factory.mktemp("outside_junction_target")
    secret = outside_dir / "secret.abc"
    secret.write_text(_ABC_TUNE, encoding="utf-8")

    junction = tmp_path / "linked"
    if sys.platform == "win32":
        result = subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(junction), str(outside_dir)],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            pytest.skip(
                f"could not create an NTFS junction: {result.stderr or result.stdout}"
            )
    else:
        try:
            os.symlink(outside_dir, junction, target_is_directory=True)
        except OSError as e:
            pytest.skip(f"could not create a directory symlink: {e}")

    escaped = str(junction / "secret.abc")
    r = score_client.post("/api/sheetimport/parse-path", json={"path": escaped})
    assert r.status_code == 403, r.text


# --------------------------------------------------------------------------
# Every notation route that writes a file answers only this machine's own
# UI, the desktop shell or a paired device
# --------------------------------------------------------------------------

_WRITER_POSTS = [
    ("/api/notation/reindex", None),
    ("/api/notation/backfill", None),
    ("/api/notation/no_such_entry/from-midi/m1", None),
    ("/api/notation/no_such_entry/rewrite-from-midi/a1", None),
    (
        "/api/notation/no_such_entry/export",
        {"source_artifact_id": "a1", "format": "pdf"},
    ),
    ("/api/notation/no_such_entry/chords", {}),
    ("/api/notation/no_such_entry/tabs", {}),
    ("/api/notation/no_such_entry/arrange", {"style": "lead-sheet"}),
    ("/api/notation/no_such_entry/perform", {"source_artifact_id": "a1"}),
]


def test_every_notation_writer_refuses_a_foreign_page_and_an_unpaired_lan_caller(
    tmp_path: Path, monkeypatch
) -> None:
    """A page outside theDAW and a LAN caller without the pairing token get
    403 from every POST that writes into the library; a paired device passes
    the gate and reaches the route itself (200 for the library-wide passes,
    404 for an entry that does not exist)."""
    from backend.core import background_workers
    from backend.lib import pairing

    monkeypatch.setattr(pairing, "_TOKEN_FILE", tmp_path / "pairing_token.txt")
    monkeypatch.setattr(pairing, "_cached", None)
    queued: list[str] = []

    class _Queue:
        def enqueue(self, name, _job) -> None:
            queued.append(name)

    monkeypatch.setattr(background_workers, "get_background_queue", _Queue)
    app = _routes_app(tmp_path, monkeypatch)
    local = TestClient(app, client=LOOPBACK_PEER)
    lan = TestClient(app, client=LAN_PEER)
    foreign = {"origin": "https://evil.example", "sec-fetch-site": "cross-site"}
    paired = {pairing.HEADER: pairing.get_token()}

    for url, body in _WRITER_POSTS:
        r = local.post(url, json=body, headers=foreign)
        assert r.status_code == 403, (url, r.status_code, r.text)
        r = lan.post(url, json=body)
        assert r.status_code == 403, (url, r.status_code, r.text)
        r = lan.post(url, json=body, headers=paired)
        expected = 200 if url.endswith(("/reindex", "/backfill")) else 404
        assert r.status_code == expected, (url, r.status_code, r.text)
    assert queued == ["notation:backfill"]
