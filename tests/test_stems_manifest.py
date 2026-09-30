"""Unit tests for backend.modules.stems.manifest and the engine's use of it.

The pure half (``classify`` / ``reconcile`` / ``build_run_manifest``) is
exercised for every stem mode the sidecar supports, including the three
shapes a 12-stem run can land in: the normal 10 files, the 11-file case
where ``drums.wav`` survived alongside the LARSNET parts, and the
LARSNET-fallback case where the drum parts never appeared.

The engine half runs ``separate_entry`` against a fake sidecar so a
partial fetch is proven to be reported as partial instead of silently
"complete".
"""

from __future__ import annotations

import asyncio
import io
import json
import sqlite3
import threading
import time
import wave
from datetime import datetime
from pathlib import Path
from typing import Any

import pytest

from backend.modules.library.db import LibraryDB
from backend.modules.stems.manifest import (
    EXPECTED,
    LARSNET_PARTS,
    LARSNET_WEIGHTS_LICENSE,
    MANIFEST_FILENAME,
    MANIFEST_VERSION,
    build_run_manifest,
    classify,
    larsnet_note,
    parse_sidecar_submit_message,
    reconcile,
    role_name,
)

# The three 12-stem shapes, named once so the tests read like the recon.
TWELVE_COMPLETE = [
    "vocals",
    "bass",
    "other",
    "guitar",
    "piano",
    "kick",
    "snare",
    "toms",
    "hihat",
    "cymbals",
]
TWELVE_DRUMS_KEPT = ["drums", *TWELVE_COMPLETE]
TWELVE_LARSNET_FELL_BACK = ["vocals", "drums", "bass", "other", "guitar", "piano"]


def _entry(item: list[dict[str, Any]], name: str) -> dict[str, Any]:
    matches = [e for e in item if e["name"] == name]
    assert matches, f"{name!r} missing from {[e['name'] for e in item]}"
    return matches[0]


# ---------------------------------------------------------------------------
# expected roles
# ---------------------------------------------------------------------------


def test_expected_roles_per_mode() -> None:
    assert EXPECTED[2] == ["vocals", "no_vocals"]
    assert EXPECTED[4] == ["vocals", "drums", "bass", "other"]
    assert EXPECTED[6] == ["vocals", "drums", "bass", "other", "guitar", "piano"]
    assert EXPECTED[12] == TWELVE_COMPLETE
    # 12 replaces drums with the LARSNET parts — drums is not an expected role.
    assert "drums" not in EXPECTED[12]
    assert len(EXPECTED[12]) == 10


def test_expected_is_not_shared_mutable_state() -> None:
    first = reconcile(4, ["vocals"])["expected"]
    first.append("tampered")
    assert EXPECTED[4] == ["vocals", "drums", "bass", "other"]


def test_role_name_strips_the_extension() -> None:
    assert role_name("no_vocals.wav") == "no_vocals"
    assert role_name("kick") == "kick"
    assert role_name(" drums.wav ") == "drums"


# ---------------------------------------------------------------------------
# classify
# ---------------------------------------------------------------------------


def test_classify_two_stem_run_has_two_parts() -> None:
    out = classify(["vocals.wav", "no_vocals.wav"])
    assert [e["name"] for e in out] == ["vocals", "no_vocals"]
    assert all(e["role"] == "part" for e in out)
    assert all(e["gain_normalized"] is False for e in out)
    assert all("aggregate_of" not in e for e in out)


def test_classify_four_stem_run_keeps_drums_a_part() -> None:
    out = classify(["vocals.wav", "drums.wav", "bass.wav", "other.wav"])
    assert all(e["role"] == "part" for e in out)
    assert _entry(out, "drums")["gain_normalized"] is False


def test_classify_six_stem_run_is_all_parts() -> None:
    out = classify([f"{n}.wav" for n in EXPECTED[6]])
    assert [e["role"] for e in out] == ["part"] * 6


def test_classify_twelve_stem_run_flags_larsnet_parts_as_normalized() -> None:
    out = classify([f"{n}.wav" for n in TWELVE_COMPLETE])
    assert all(e["role"] == "part" for e in out)
    for part in LARSNET_PARTS:
        assert _entry(out, part)["gain_normalized"] is True
    for demucs_stem in ("vocals", "bass", "other", "guitar", "piano"):
        assert _entry(out, demucs_stem)["gain_normalized"] is False


def test_classify_marks_drums_an_aggregate_when_larsnet_parts_are_present() -> None:
    out = classify([f"{n}.wav" for n in TWELVE_DRUMS_KEPT])
    drums = _entry(out, "drums")
    assert drums["role"] == "aggregate"
    assert drums["aggregate_of"] == list(LARSNET_PARTS)
    assert drums["gain_normalized"] is False
    assert _entry(out, "kick")["role"] == "part"


def test_classify_drums_aggregate_lists_only_the_parts_that_exist() -> None:
    out = classify(["drums", "kick", "snare"])
    assert _entry(out, "drums")["aggregate_of"] == ["kick", "snare"]


def test_classify_marks_no_vocals_an_aggregate_when_other_parts_exist() -> None:
    out = classify(["vocals", "no_vocals", "drums", "bass", "other"])
    no_vocals = _entry(out, "no_vocals")
    assert no_vocals["role"] == "aggregate"
    # Everything but vocals, and never itself.
    assert no_vocals["aggregate_of"] == ["bass", "drums", "other"]
    assert _entry(out, "vocals")["role"] == "part"


def test_classify_no_vocals_aggregate_skips_the_drums_aggregate() -> None:
    # drums is itself an aggregate here, so counting it AND its parts would
    # double-count the kit.
    out = classify(["vocals", "no_vocals", "drums", "kick", "snare", "bass"])
    assert _entry(out, "no_vocals")["aggregate_of"] == ["bass", "kick", "snare"]


def test_classify_deduplicates_and_preserves_first_seen_order() -> None:
    out = classify(["bass.wav", "bass", "vocals.wav"])
    assert [e["name"] for e in out] == ["bass", "vocals"]


def test_classify_drops_blank_names_and_rejects_non_strings() -> None:
    assert classify(["bass.wav", "", "   "]) == classify(["bass.wav"])
    with pytest.raises(TypeError):
        classify(["bass.wav", 7])  # type: ignore[list-item]


# ---------------------------------------------------------------------------
# reconcile
# ---------------------------------------------------------------------------


def test_reconcile_two_stem_complete() -> None:
    out = reconcile(2, ["vocals.wav", "no_vocals.wav"])
    assert out["status"] == "complete"
    assert out["requested_mode"] == 2
    assert out["produced"] == ["vocals", "no_vocals"]
    assert out["missing"] == []
    assert out["unexpected"] == []
    assert [p["name"] for p in out["parts"]] == ["vocals", "no_vocals"]
    assert out["aggregates"] == []


def test_reconcile_four_and_six_stem_complete() -> None:
    for mode in (4, 6):
        out = reconcile(mode, [f"{n}.wav" for n in EXPECTED[mode]])
        assert out["status"] == "complete", mode
        assert out["missing"] == []


def test_reconcile_twelve_to_ten_is_complete() -> None:
    out = reconcile(12, [f"{n}.wav" for n in TWELVE_COMPLETE])
    assert out["status"] == "complete"
    assert out["missing"] == []
    assert out["unexpected"] == []
    assert len(out["parts"]) == 10
    assert out["aggregates"] == []


def test_reconcile_twelve_with_drums_kept_flags_the_aggregate() -> None:
    out = reconcile(12, [f"{n}.wav" for n in TWELVE_DRUMS_KEPT])
    # Every requested role arrived; drums is a bonus file, not a shortfall.
    assert out["status"] == "complete"
    assert out["missing"] == []
    assert out["unexpected"] == ["drums"]
    assert [a["name"] for a in out["aggregates"]] == ["drums"]
    assert out["aggregates"][0]["aggregate_of"] == list(LARSNET_PARTS)


def test_reconcile_twelve_without_drum_parts_is_degraded() -> None:
    out = reconcile(12, [f"{n}.wav" for n in TWELVE_LARSNET_FELL_BACK])
    assert out["status"] == "degraded"
    assert out["missing"] == list(LARSNET_PARTS)
    assert out["unexpected"] == ["drums"]
    # drums is a plain part here: there are no LARSNET parts for it to sum.
    assert [p["name"] for p in out["parts"]].count("drums") == 1
    assert out["aggregates"] == []


def test_reconcile_degraded_plus_a_real_shortfall_is_partial() -> None:
    # LARSNET fell back AND vocals never made it: the worse status wins so the
    # missing vocals cannot hide behind "degraded".
    produced = [n for n in TWELVE_LARSNET_FELL_BACK if n != "vocals"]
    out = reconcile(12, produced)
    assert out["status"] == "partial"
    assert "vocals" in out["missing"]


def test_reconcile_partial_fetch_reports_the_missing_role() -> None:
    out = reconcile(4, ["vocals.wav", "drums.wav", "other.wav"])
    assert out["status"] == "partial"
    assert out["missing"] == ["bass"]
    assert out["unexpected"] == []


def test_reconcile_nothing_produced_is_partial_with_everything_missing() -> None:
    out = reconcile(4, [])
    assert out["status"] == "partial"
    assert out["missing"] == EXPECTED[4]
    assert out["parts"] == []


def test_reconcile_missing_keeps_expected_order() -> None:
    out = reconcile(6, ["bass.wav"])
    assert out["missing"] == ["vocals", "drums", "other", "guitar", "piano"]


def test_reconcile_rejects_an_unsupported_mode() -> None:
    with pytest.raises(ValueError):
        reconcile(5, ["vocals.wav"])
    with pytest.raises(ValueError):
        reconcile("12", ["vocals.wav"])  # type: ignore[arg-type]


def test_reconcile_synthesizes_roles_for_an_old_run_from_db_stem_names() -> None:
    # Old runs have no manifest on disk; the router re-derives roles from the
    # ``stem_name`` column, which carries no extension.
    rows = ["bass", "cymbals", "drums", "guitar", "hihat", "kick"]
    out = reconcile(12, rows)
    by_name = {e["name"]: e for e in out["parts"] + out["aggregates"]}
    assert by_name["drums"]["role"] == "aggregate"
    assert by_name["drums"]["aggregate_of"] == ["kick", "hihat", "cymbals"]
    assert by_name["kick"]["gain_normalized"] is True
    assert by_name["guitar"]["gain_normalized"] is False


# ---------------------------------------------------------------------------
# licence note + sidecar message parsing
# ---------------------------------------------------------------------------


def test_larsnet_note_only_when_larsnet_parts_are_present() -> None:
    assert larsnet_note(["vocals", "drums", "bass", "other"]) is None
    note = larsnet_note([f"{n}.wav" for n in TWELVE_COMPLETE])
    assert note is not None
    assert note["weights_license"] == "CC BY-NC 4.0"
    assert note["weights_license"] == LARSNET_WEIGHTS_LICENSE
    assert note["parts"] == list(LARSNET_PARTS)


def test_parse_sidecar_submit_message_reads_device_and_quality() -> None:
    parsed = parse_sidecar_submit_message(
        "Processing 12-stem separation on cuda (balanced)"
    )
    assert parsed == {"device": "cuda", "quality": "balanced"}


def test_parse_sidecar_submit_message_tolerates_junk() -> None:
    for junk in (None, "", "Queued in sidecar", "separation on"):
        assert parse_sidecar_submit_message(junk) == {"device": None, "quality": None}


# ---------------------------------------------------------------------------
# build_run_manifest
# ---------------------------------------------------------------------------


def _manifest(**over: Any) -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "requested_mode": 12,
        "produced_names": [f"{n}.wav" for n in TWELVE_COMPLETE],
        "run_id": "b4c1f0f0b4c1f0f0",
        "separated_at": "2026-09-18T10:00:00Z",
        "quality_requested": None,
        "quality_effective": "hq",
        "device": "cuda",
        "device_source": "sidecar",
        "file_bytes": {n: 100 for n in TWELVE_COMPLETE},
    }
    kwargs.update(over)
    return build_run_manifest(**kwargs)


def test_build_run_manifest_carries_run_context_and_reconciliation() -> None:
    m = _manifest()
    assert m["manifest_version"] == MANIFEST_VERSION
    assert m["run_id"] == "b4c1f0f0b4c1f0f0"
    assert m["separated_at"] == "2026-09-18T10:00:00Z"
    assert m["provider"] == "demucs+larsnet"
    assert m["device"] == "cuda"
    assert m["device_source"] == "sidecar"
    assert m["quality_requested"] is None
    assert m["quality_effective"] == "hq"
    assert m["file_bytes"]["kick"] == 100
    assert m["status"] == "complete"
    assert m["expected"] == EXPECTED[12]
    assert m["larsnet"]["weights_license"] == "CC BY-NC 4.0"


def test_build_run_manifest_provider_is_plain_demucs_without_drum_parts() -> None:
    m = _manifest(
        requested_mode=4,
        produced_names=["vocals.wav", "drums.wav", "bass.wav", "other.wav"],
        file_bytes={"vocals": 1, "drums": 2, "bass": 3, "other": 4},
    )
    assert m["provider"] == "demucs"
    assert m["larsnet"] is None


def test_build_run_manifest_is_json_serializable() -> None:
    assert json.loads(json.dumps(_manifest()))["status"] == "complete"


def test_build_run_manifest_rejects_bad_file_bytes() -> None:
    with pytest.raises(ValueError):
        _manifest(file_bytes={"vocals": -1})
    with pytest.raises(ValueError):
        _manifest(file_bytes={"vocals": 1.5})


# ---------------------------------------------------------------------------
# engine: manifest written, partial run reported partial
# ---------------------------------------------------------------------------


def _wav_bytes(frames: int = 32) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(44100)
        w.writeframes(b"\x00\x00" * 2 * frames)
    return buf.getvalue()


class _FakeSidecar:
    """Stands in for StemsSidecar: submit → one completed poll → listing."""

    def __init__(self, names: list[str], *, fail: tuple[str, ...] = ()) -> None:
        self._names = names
        self._fail = fail
        self.submitted: list[dict[str, Any]] = []

    async def submit_separation(
        self, audio_path: Path, *, stems: int, device: Any, quality: Any
    ) -> dict:
        self.submitted.append({"stems": stems, "device": device, "quality": quality})
        return {
            "task_id": "task-1",
            "status": "queued",
            "message": f"Processing {stems}-stem separation on cpu (balanced)",
        }

    async def poll_status(self, task_id: str) -> dict:
        return {"status": "completed", "progress": 100, "message": "done"}

    async def list_stems(self, task_id: str) -> dict:
        return {"files": [{"name": n, "size": 4} for n in self._names]}

    async def fetch_stem_bytes(self, task_id: str, filename: str) -> bytes:
        if filename in self._fail:
            raise RuntimeError(f"simulated fetch failure for {filename}")
        return _wav_bytes()


@pytest.fixture()
def stems_db(tmp_path: Path) -> LibraryDB:
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "e1", "title": "fake"})
    return db


def _run_separation(
    db: LibraryDB,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    fake: _FakeSidecar,
    *,
    stems: int,
) -> tuple[dict[str, Any], Path]:
    from backend.modules.stems import engine as stems_engine
    from backend.modules.stems import sidecar as stems_sidecar

    # _effective_device_label probes the real sidecar for CUDA; keep the test
    # off the filesystem/subprocess path.
    monkeypatch.setattr(
        stems_sidecar,
        "probe",
        lambda: {"packages": {"torch": {"cuda_available": False, "version": "fake"}}},
    )
    entry_dir = tmp_path / "entry"
    entry_dir.mkdir()
    audio = tmp_path / "input.wav"
    audio.write_bytes(_wav_bytes())
    stems_engine.clear_progress("e1")
    payload = asyncio.run(
        stems_engine.separate_entry(
            db, "e1", audio, entry_dir, stems=stems, sidecar=fake
        )
    )
    return payload, entry_dir / "stems" / MANIFEST_FILENAME


def _stems_client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Any, Any]:
    """A TestClient over the stems router pointed at a throwaway library root."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from backend.modules.library import router as library_router_module
    from backend.modules.stems import router as stems_router_module
    from tests.test_library_store import _seed_generate_entry

    monkeypatch.setattr(library_router_module, "_store", None)
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(tmp_path))
    _seed_generate_entry(tmp_path, "job_seed", 0)

    app = FastAPI()
    app.include_router(stems_router_module.router, prefix="/api/stems")
    client = TestClient(app)
    store = library_router_module.get_store()
    assert store.db is not None
    return client, store


def _seed_stems(store: Any, job_id: str, names: list[str]) -> str:
    from tests.test_library_store import _seed_generate_entry

    _seed_generate_entry(store.root, job_id, 0)
    store.reindex()  # the stems rows FK onto an entry row
    entry_id = f"{job_id}_00"
    for name in names:
        store.db.add_stem(
            stem_id=f"{entry_id}__{name}",
            entry_id=entry_id,
            stem_name=name,
            audio_path=f"/tmp/{name}.wav",
            file_size_bytes=10,
            model="demucs",
            model_variant="12-stem",
        )
    return entry_id


def test_engine_writes_a_manifest_for_a_complete_twelve_stem_run(
    stems_db: LibraryDB, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake = _FakeSidecar([f"{n}.wav" for n in TWELVE_COMPLETE])
    payload, manifest_path = _run_separation(
        stems_db, tmp_path, monkeypatch, fake, stems=12
    )

    assert manifest_path.is_file()
    m = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert m["status"] == "complete"
    assert m["requested_mode"] == 12
    assert sorted(m["produced"]) == sorted(TWELVE_COMPLETE)
    assert m["missing"] == []
    assert m["provider"] == "demucs+larsnet"
    assert m["larsnet"]["weights_license"] == "CC BY-NC 4.0"
    # The sidecar reported its own device/quality in the submit message.
    assert m["device"] == "cpu"
    assert m["device_source"] == "sidecar"
    assert m["quality_requested"] is None
    assert m["quality_effective"] == "balanced"
    assert all(v > 0 for v in m["file_bytes"].values())
    assert len(m["run_id"]) >= 16
    assert datetime.fromisoformat(m["separated_at"].replace("Z", "+00:00")).tzinfo

    assert payload["status"] == "complete"
    assert payload["missing"] == []
    assert payload["manifest"]["status"] == "complete"
    assert stems_db.get_entry("e1")["stems_status"] == "complete"

    # Nothing was requested, so the progress line reports the tier the sidecar
    # named rather than guessing one.
    from backend.modules.stems.engine import get_progress

    snap = get_progress("e1") or {}
    assert snap["quality"] == "balanced (sidecar default)"
    assert "hq (sidecar default)" not in snap["message"]


def test_engine_reports_a_partial_fetch_as_partial(
    stems_db: LibraryDB, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake = _FakeSidecar(
        ["vocals.wav", "drums.wav", "bass.wav", "other.wav"], fail=("bass.wav",)
    )
    payload, manifest_path = _run_separation(
        stems_db, tmp_path, monkeypatch, fake, stems=4
    )

    m = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert m["status"] == "partial"
    assert m["missing"] == ["bass"]
    assert "bass" not in m["produced"]
    assert "bass" not in m["file_bytes"]

    assert payload["status"] == "partial"
    assert payload["missing"] == ["bass"]
    assert payload["written"] == 3
    assert stems_db.get_entry("e1")["stems_status"] == "partial"

    # TrackMenu stops polling /progress only on idle|completed|failed|aborted,
    # so the terminal phase stays "completed" while the message tells the truth.
    from backend.modules.stems.engine import get_progress

    snap = get_progress("e1") or {}
    assert snap["phase"] == "completed"
    assert "partial" in snap["message"]
    assert "bass" in snap["message"]
    assert snap["result_status"] == "partial"
    assert snap["missing"] == ["bass"]


def test_router_synthesizes_roles_for_an_old_run_without_a_manifest(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, store = _stems_client(tmp_path, monkeypatch)
    entry_id = _seed_stems(store, "job_old", [*TWELVE_DRUMS_KEPT])

    body = client.get(f"/api/stems/{entry_id}").json()
    assert body["manifest"] is None
    by_name = {row["stem_name"]: row for row in body["stems"]}
    assert by_name["drums"]["role"] == "aggregate"
    assert by_name["drums"]["aggregate_of"] == list(LARSNET_PARTS)
    assert by_name["kick"]["role"] == "part"
    assert by_name["kick"]["gain_normalized"] is True
    assert by_name["vocals"]["gain_normalized"] is False
    assert "aggregate_of" not in by_name["vocals"]


def test_the_library_connection_waits_for_a_lock_instead_of_failing_the_open(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """This module's router opens the library through get_store(), and on a
    loaded machine that open raised `sqlite3.OperationalError: database is
    locked` out of LibraryDB._migrate: nothing set PRAGMA busy_timeout, so the
    write lock its DDL needs was only ever waited on for sqlite3.connect's
    implicit 5 s -- less than the index builds _migrate itself measures in
    "seconds to minutes". An unopenable library, from a lock that would have
    cleared."""
    from backend.modules.library.db import BUSY_TIMEOUT_MS

    _client, store = _stems_client(tmp_path, monkeypatch)
    assert store.db is not None
    (timeout,) = store.db._conn.execute("PRAGMA busy_timeout").fetchone()  # noqa: SLF001
    assert timeout == BUSY_TIMEOUT_MS
    assert BUSY_TIMEOUT_MS > 5_000, (
        "5 s is sqlite3.connect's default and was not enough"
    )


def test_a_library_open_waits_out_a_write_lock_another_connection_holds(
    tmp_path: Path,
) -> None:
    """The test above pins the configuration; this one pins the behaviour it
    buys. A second connection holds the write lock for longer than
    sqlite3.connect's implicit 5 s, and opening the library during that hold
    has to WAIT rather than raise `database is locked` out of _migrate's DDL.
    Runs for about 6 s by construction: the hold has to outlast the default."""
    path = tmp_path / "locked.db"
    holder = sqlite3.connect(str(path), check_same_thread=False)
    # The holder puts the file in the same journal mode LibraryDB uses, so the
    # library's own `journal_mode = WAL` is a no-op and the lock the open meets
    # is the one the schema DDL needs.
    holder.execute("PRAGMA journal_mode = WAL")
    locked = threading.Event()
    release = threading.Event()

    def hold() -> None:
        holder.execute("BEGIN IMMEDIATE")
        holder.execute("CREATE TABLE IF NOT EXISTS hold (x INTEGER)")
        locked.set()
        release.wait(20)
        holder.rollback()

    thread = threading.Thread(target=hold, daemon=True)
    thread.start()
    try:
        assert locked.wait(5), "the second connection never took the write lock"
        timer = threading.Timer(6.0, release.set)
        timer.start()
        started = time.monotonic()
        try:
            db = LibraryDB(path, enable_fts=False)
        finally:
            waited = time.monotonic() - started
            release.set()
            timer.cancel()
        # Closed before the timing assert: a failed assert must not leave the
        # handles open, or Windows cannot remove tmp_path and the timing
        # failure is buried under a teardown error.
        db.close()
        assert waited > 5.0, (
            f"the open returned in {waited:.1f}s -- it never met the lock, so "
            "this test proves nothing about waiting for one"
        )
    finally:
        release.set()
        thread.join(20)
        holder.close()


def test_router_returns_the_manifest_when_one_was_written(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, store = _stems_client(tmp_path, monkeypatch)
    entry_id = _seed_stems(store, "job_new", list(TWELVE_COMPLETE))
    entry_dir = store._dir_for(entry_id)  # noqa: SLF001
    assert entry_dir is not None
    stems_dir = entry_dir / "stems"
    stems_dir.mkdir(parents=True, exist_ok=True)
    (stems_dir / MANIFEST_FILENAME).write_text(json.dumps(_manifest()), "utf-8")

    body = client.get(f"/api/stems/{entry_id}").json()
    assert body["manifest"]["status"] == "complete"
    assert body["manifest"]["larsnet"]["weights_license"] == "CC BY-NC 4.0"
    assert {row["stem_name"] for row in body["stems"]} == set(TWELVE_COMPLETE)


def test_router_tolerates_a_corrupt_manifest(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, store = _stems_client(tmp_path, monkeypatch)
    entry_id = _seed_stems(store, "job_bad", ["vocals", "no_vocals"])
    entry_dir = store._dir_for(entry_id)  # noqa: SLF001
    assert entry_dir is not None
    (entry_dir / "stems").mkdir(parents=True, exist_ok=True)
    (entry_dir / "stems" / MANIFEST_FILENAME).write_text("{not json", "utf-8")

    body = client.get(f"/api/stems/{entry_id}").json()
    assert body["manifest"] is None
    assert {row["role"] for row in body["stems"]} == {"part"}


def test_engine_degrades_when_larsnet_falls_back(
    stems_db: LibraryDB, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake = _FakeSidecar([f"{n}.wav" for n in TWELVE_LARSNET_FELL_BACK])
    payload, manifest_path = _run_separation(
        stems_db, tmp_path, monkeypatch, fake, stems=12
    )

    m = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert m["status"] == "degraded"
    assert m["provider"] == "demucs"
    assert m["missing"] == list(LARSNET_PARTS)
    assert payload["status"] == "degraded"
    assert stems_db.get_entry("e1")["stems_status"] == "degraded"
