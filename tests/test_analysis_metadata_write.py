"""How the analysis engine writes an entry's ``metadata.json``.

Analysis runs in the BACKGROUND -- from the idle queue after an import, from
the shard pipeline, from a manual ``/run`` -- so it routinely overlaps the
user rating, tagging or editing lyrics on the same entry. That file is the
library's source of truth (``reindex()`` rebuilds the database FROM it), so a
lost update here is unrecoverable and a torn document is permanent damage.

These tests pin the three properties that stop both:

* the read-modify-write runs under the library store's metadata lock, with
  the READ inside it, so a user edit landing mid-write survives,
* the write goes through the store's atomic writer -- a unique temp file in
  the entry's own directory, never the shared ``metadata.json.tmp`` two
  writers used to mix their bytes in,
* a damaged document is left alone rather than replaced by one holding
  nothing but the analysis.

Every fixture is synthetic: invented ids, empty files, tmp dirs only. No
audio is decoded and no real library is opened.
"""

from __future__ import annotations

import json
import re
import threading
from pathlib import Path

import pytest

from backend.modules.analysis import engine as engine_module
from backend.modules.analysis.engine import persist_analysis
from backend.modules.library.db import LibraryDB
from backend.modules.library.store import LibraryStore

ENTRY_ID = "entry-under-analysis"


def _payload(bpm: float = 128.0) -> dict:
    """An analysis payload shaped like ``analyze_audio``'s return value."""
    return {
        "version": 3,
        "analyzed_at": 1700000000.0,
        "bpm": bpm,
        "beats": [0.5, 1.0, 1.5, 2.0],
        "key": "C",
        "scale": "major",
        "key_confidence": 0.9,
        "rms_db": -14.0,
        "loudness_lufs": -12.0,
        "bars_estimated": 1.0,
        "semantic_tags": ["warm"],
        "prompt_guess": "a warm loop",
        "prompt_confidence": 0.5,
        "ffprobe": {"_summary": {"sample_rate": 44100}},
    }


def _seed_entry(root: Path, entry_id: str = ENTRY_ID, **extra) -> Path:
    """One flat on-disk entry, the layout an import leaves behind."""
    entry_dir = root / entry_id
    entry_dir.mkdir(parents=True, exist_ok=True)
    (entry_dir / "audio.mp3").write_bytes(b"")
    payload = {
        "id": entry_id,
        "filename": "audio.mp3",
        "audio_filename": "audio.mp3",
        "mime_type": "audio/mpeg",
        "title": "A Quiet Take",
        "prompt": "",
        "model": "imported",
        "source": "import",
        "duration": 1.0,
        "tags": [],
        "notes": "",
        "saved_at": 1700000000.0,
    }
    payload.update(extra)
    (entry_dir / "metadata.json").write_text(json.dumps(payload), encoding="utf-8")
    return entry_dir


def _read_meta(entry_dir: Path) -> dict:
    return json.loads((entry_dir / "metadata.json").read_text(encoding="utf-8"))


# ---- The lost update -------------------------------------------------------


def test_a_user_edit_during_an_analysis_write_is_never_lost(tmp_path, monkeypatch):
    """The lost update this lock exists to stop.

    A user PATCH lands between the analysis write's read and its write. Held
    at the instant after its read, the unlocked writer lets the edit proceed
    and then replaces it with the stale copy it is holding -- rating, notes,
    tags and lyrics gone from disk, and ``reindex()`` would copy the loss
    into the database rather than repair it. Under the lock the editor cannot
    start until the analysis write is done, so BOTH the user's fields and
    ``meta["analysis"]`` survive.

    Deterministic: the two threads rendezvous on events, never on sleeps.
    """
    root = tmp_path / "lib"
    root.mkdir(parents=True, exist_ok=True)
    entry_dir = _seed_entry(root)
    store = LibraryStore(root)
    assert store.db is not None
    assert store.db.get_entry(ENTRY_ID) is not None

    read_done = threading.Event()
    edit_done = threading.Event()
    real_read = engine_module._read_entry_metadata

    def hooked_read(metadata_path):
        meta = real_read(metadata_path)
        if threading.current_thread().name == "analysis":
            # Read taken. Give the editor every chance to get in front of
            # the write that follows. Bounded, because when the lock works
            # the editor is blocked and this wait must still end.
            read_done.set()
            edit_done.wait(timeout=2.0)
        return meta

    monkeypatch.setattr(engine_module, "_read_entry_metadata", hooked_read)

    edit = {
        "rating": "like",
        "notes": "the user typed this",
        "tags": ["mine"],
        "lyrics": "the user pasted these words",
    }
    failures: list[BaseException] = []

    def analysis() -> None:
        try:
            persist_analysis(
                store.db,
                ENTRY_ID,
                _payload(),
                metadata_path=entry_dir / "metadata.json",
                store=store,
            )
        except BaseException as e:  # noqa: BLE001 - reported, not swallowed
            failures.append(e)

    def user_edit() -> None:
        try:
            read_done.wait(timeout=5.0)
            store.update_entry(ENTRY_ID, dict(edit))
        except BaseException as e:  # noqa: BLE001 - reported, not swallowed
            failures.append(e)
        finally:
            edit_done.set()

    threads = [
        threading.Thread(target=analysis, name="analysis"),
        threading.Thread(target=user_edit, name="editor"),
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=20)
    assert not any(t.is_alive() for t in threads)
    assert failures == []

    on_disk = _read_meta(entry_dir)
    for field, value in edit.items():
        assert on_disk[field] == value, f"{field} lost on disk"
    assert on_disk["analysis"]["bpm"] == 128.0
    assert on_disk["title"] == "A Quiet Take"


def test_the_analysis_write_takes_the_same_lock_the_store_writers_take(tmp_path):
    """Not a proxy for the test above: the guard must resolve to the store's
    OWN lock object, since a lock nobody else takes is only the appearance of
    safety."""
    root = tmp_path / "lib"
    root.mkdir(parents=True, exist_ok=True)
    entry_dir = _seed_entry(root)
    store = LibraryStore(root)

    guard = engine_module._metadata_guard(entry_dir / "metadata.json", store)
    assert guard is store._meta_lock


def test_a_store_that_does_not_own_the_file_is_not_used_as_its_lock(
    tmp_path, monkeypatch
):
    """A store rooted elsewhere guards nothing here -- its lock serializes
    only threads holding that object, and no writer of this file holds it."""
    from backend.modules.library import router as library_router

    # No singleton to fall back to, whatever else ran in this process first.
    monkeypatch.setattr(library_router, "_store", None)
    root = tmp_path / "lib"
    root.mkdir(parents=True, exist_ok=True)
    entry_dir = _seed_entry(root)
    elsewhere = LibraryStore(tmp_path / "other-lib")

    assert engine_module._store_guarding(entry_dir / "metadata.json", elsewhere) is None
    assert engine_module._store_guarding(entry_dir / "metadata.json", None) is None


def test_the_engine_never_builds_a_library_store_to_find_a_lock(tmp_path, monkeypatch):
    """Falling back to ``get_store()`` would open the real library database
    and auto-reindex it when empty -- 200,000 entries walked so a writer can
    borrow a mutex. An absent singleton stays absent; the write still
    happens, unguarded but atomic."""
    from backend.modules.library import router as library_router

    monkeypatch.setattr(library_router, "_store", None)
    root = tmp_path / "lib"
    root.mkdir(parents=True, exist_ok=True)
    entry_dir = _seed_entry(root)
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": ENTRY_ID})

    persist_analysis(
        db, ENTRY_ID, _payload(), metadata_path=entry_dir / "metadata.json"
    )

    assert library_router._store is None
    assert _read_meta(entry_dir)["analysis"]["bpm"] == 128.0
    assert list(entry_dir.glob("*.tmp")) == []


# ---- Temp files ------------------------------------------------------------


def test_the_write_leaves_no_temp_file_and_never_uses_the_shared_name(
    tmp_path, monkeypatch
):
    """Two writers of one entry used to share ``metadata.json.tmp``: their
    bytes mixed in that one file and the mixture was renamed over the real
    document."""
    root = tmp_path / "lib"
    root.mkdir(parents=True, exist_ok=True)
    entry_dir = _seed_entry(root)
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": ENTRY_ID})

    renamed: list[str] = []
    real_replace = Path.replace

    def recording_replace(self, target):
        renamed.append(self.name)
        return real_replace(self, target)

    monkeypatch.setattr(Path, "replace", recording_replace)

    persist_analysis(
        db, ENTRY_ID, _payload(), metadata_path=entry_dir / "metadata.json"
    )

    assert renamed, "nothing was renamed into place"
    for name in renamed:
        assert name != "metadata.json.tmp"
        # Unique per write: metadata.json.<pid>.<thread id>.<8 hex>.tmp
        assert re.fullmatch(r"metadata\.json\.\d+\.\d+\.[0-9a-f]{8}\.tmp", name), name
    assert list(entry_dir.glob("*.tmp")) == []
    assert _read_meta(entry_dir)["analysis"]["bpm"] == 128.0


def test_a_failed_write_leaves_no_orphan_temp_file_and_no_damage(tmp_path, monkeypatch):
    root = tmp_path / "lib"
    root.mkdir(parents=True, exist_ok=True)
    entry_dir = _seed_entry(root)
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": ENTRY_ID})

    def boom(self, target):
        raise OSError("no rename for you")

    monkeypatch.setattr(Path, "replace", boom)

    # The failure is logged, not raised: analysis must not fail because the
    # durable backup could not be written. Same as before this change.
    persist_analysis(
        db, ENTRY_ID, _payload(), metadata_path=entry_dir / "metadata.json"
    )

    assert list(entry_dir.glob("*.tmp")) == []
    on_disk = _read_meta(entry_dir)
    assert "analysis" not in on_disk
    assert on_disk["title"] == "A Quiet Take"
    # The database still has the analysis — the metadata file is a backup of
    # it, not the other way round.
    assert db.get_analysis(ENTRY_ID)["bpm"] == 128.0


# ---- Damaged documents -----------------------------------------------------


@pytest.mark.parametrize(
    "raw",
    ['{"id": "entry-under-analysis", "title": ', "not json at all", "[1, 2, 3]", '"a"'],
)
def test_a_damaged_metadata_file_is_never_replaced_by_the_analysis(tmp_path, raw: str):
    """Rewriting an unparsable file from a guess replaces an entry's whole
    record -- title, tags, rating, notes, lyrics, prompt -- with a document
    holding nothing but the analysis just computed. Worse than the damage,
    and not repairable from the database. Left alone instead, the way the
    store treats a metadata file it cannot parse."""
    root = tmp_path / "lib"
    root.mkdir(parents=True, exist_ok=True)
    entry_dir = root / ENTRY_ID
    entry_dir.mkdir(parents=True, exist_ok=True)
    metadata_path = entry_dir / "metadata.json"
    metadata_path.write_text(raw, encoding="utf-8")
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": ENTRY_ID})

    persist_analysis(db, ENTRY_ID, _payload(), metadata_path=metadata_path)

    assert metadata_path.read_text(encoding="utf-8") == raw
    assert list(entry_dir.glob("*.tmp")) == []
    # The analysis still reached the database.
    assert db.get_analysis(ENTRY_ID)["bpm"] == 128.0


# ---- Behaviour preservation ------------------------------------------------


def test_the_written_keys_and_the_return_value_are_unchanged(tmp_path):
    root = tmp_path / "lib"
    root.mkdir(parents=True, exist_ok=True)
    entry_dir = _seed_entry(root, tags=["keep-me"], notes="written earlier")
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": ENTRY_ID})
    payload = _payload()
    before = _read_meta(entry_dir)

    assert (
        persist_analysis(
            db, ENTRY_ID, payload, metadata_path=entry_dir / "metadata.json"
        )
        is None
    )

    after = _read_meta(entry_dir)
    # Everything the file already held is still there, untouched.
    for key, value in before.items():
        assert after[key] == value, key
    # ``analysis`` holds every payload key except the two bulky ones, plus
    # the beat COUNT in place of the beat list.
    expected = {k for k in payload if k not in ("ffprobe", "beats")} | {"beats_count"}
    assert set(after["analysis"]) == expected
    assert after["analysis"]["beats_count"] == 4
    assert after["analysis"]["bpm"] == 128.0
    assert "ffprobe" not in after["analysis"]
    assert "beats" not in after["analysis"]
    # The analysis table is where readers get an analysis; the metadata
    # column is not a second copy of it.
    assert db.get_analysis(ENTRY_ID)["bpm"] == 128.0
    stored = json.loads(db.get_entry(ENTRY_ID)["metadata_json"] or "{}")
    assert "analysis" not in stored


def test_a_missing_metadata_file_is_still_not_created(tmp_path):
    """Unchanged behaviour: no file, no write, no exception, DB still gets
    the analysis."""
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": ENTRY_ID})

    persist_analysis(
        db, ENTRY_ID, _payload(), metadata_path=tmp_path / "does-not-exist.json"
    )

    assert not (tmp_path / "does-not-exist.json").exists()
    assert not (tmp_path / "metadata.json").exists()
    assert db.get_analysis(ENTRY_ID)["bpm"] == 128.0


def test_callers_may_omit_the_store_entirely(tmp_path):
    """The signature gained an optional keyword and nothing else: the two
    positional-plus-metadata_path call shapes already in the tree still
    work."""
    root = tmp_path / "lib"
    root.mkdir(parents=True, exist_ok=True)
    entry_dir = _seed_entry(root)
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": ENTRY_ID})

    persist_analysis(
        db,
        ENTRY_ID,
        _payload(99.0),
        metadata_path=entry_dir / "metadata.json",
        embedded_tags={"generator": "suno"},
    )

    assert _read_meta(entry_dir)["analysis"]["bpm"] == 99.0
    row = db.get_analysis(ENTRY_ID)
    assert row["bpm"] == 99.0
    assert json.loads(row["embedded_tags_json"])["generator"] == "suno"
