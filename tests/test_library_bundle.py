"""Unit tests for the library bundle builder + lineage graph BFS."""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path

from backend.modules.library.bundle import build_bundle_bytes
from backend.modules.library.store import LibraryStore


def _seed_with_extras(tmp_path: Path):
    """Seed a library, import an entry, add fake stems + midi rows."""
    store = LibraryStore(tmp_path)
    record = store.import_blob(
        audio_bytes=b"RIFF\x00\x00\x00\x00WAVEdata",
        filename="track.wav",
        mime_type="audio/wav",
        metadata={"title": "Bundle test", "prompt": "test"},
    )
    assert store.db is not None
    entry_dir = store._dir_for(record.id)
    assert entry_dir is not None

    # Fake stems on disk + in DB.
    stems_dir = entry_dir / "stems"
    stems_dir.mkdir()
    vocals = stems_dir / "vocals.wav"
    drums = stems_dir / "drums.wav"
    vocals.write_bytes(b"RIFF\x00\x00\x00\x00WAVEvocals")
    drums.write_bytes(b"RIFF\x00\x00\x00\x00WAVEdrums")
    store.db.add_stem(
        stem_id=f"{record.id}__vocals",
        entry_id=record.id,
        stem_name="vocals",
        audio_path=str(vocals),
        file_size_bytes=vocals.stat().st_size,
        model="demucs",
    )
    store.db.add_stem(
        stem_id=f"{record.id}__drums",
        entry_id=record.id,
        stem_name="drums",
        audio_path=str(drums),
        file_size_bytes=drums.stat().st_size,
        model="demucs",
    )

    # Fake midi on disk + in DB.
    midi_dir = entry_dir / "midi"
    midi_dir.mkdir()
    full_mid = midi_dir / "full.mid"
    full_mid.write_bytes(b"MThd\x00\x00\x00\x06\x00\x00")  # minimal MIDI header
    store.db.add_midi(
        midi_id=f"{record.id}__full",
        entry_id=record.id,
        source="full",
        midi_path=str(full_mid),
        engine="basic-pitch",
    )

    # An analysis row.
    store.db.upsert_analysis(
        record.id,
        {
            "bpm": 120.0,
            "key": "C",
            "scale": "major",
            "bars_estimated": 8.0,
        },
    )

    return store, record


def test_bundle_includes_audio_metadata_stems_midi_lineage_readme(tmp_path: Path):
    store, record = _seed_with_extras(tmp_path)
    entry_dir = store._dir_for(record.id)
    assert entry_dir is not None
    audio_path = store.get_audio_path(record.id)
    metadata_path = entry_dir / "metadata.json"

    analysis = store.db.get_analysis(record.id) if store.db else None
    stems = store.db.list_stems(record.id) if store.db else []
    midis = store.db.list_midis(record.id) if store.db else []
    edges = store.db.list_relations(from_id=record.id) if store.db else []

    data = build_bundle_bytes(
        entry_id=record.id,
        record=record.to_dict(),
        audio_path=audio_path,
        metadata_path=metadata_path,
        analysis=analysis,
        stems=stems,
        midis=midis,
        lineage_edges=edges,
    )

    zf = zipfile.ZipFile(io.BytesIO(data))
    names = set(zf.namelist())

    # Audio at the root.
    assert any(n.endswith(".wav") and "/" not in n for n in names)
    # Metadata, analysis, lineage, prompts, readme.
    assert "metadata.json" in names
    assert "analysis.json" in names
    assert "lineage.json" in names
    assert "prompts.txt" in names
    assert "README.txt" in names
    # Stems + midi nested under their dirs.
    assert "stems/vocals.wav" in names
    assert "stems/drums.wav" in names
    assert "midi/full.mid" in names

    # Sanity-check the analysis payload.
    payload = json.loads(zf.read("analysis.json"))
    assert payload["bpm"] == 120.0
    assert payload["key"] == "C"


def test_bundle_skips_missing_files(tmp_path: Path):
    """If a stem/midi row points to a missing file, we silently skip
    it rather than 500."""
    store = LibraryStore(tmp_path)
    record = store.import_blob(
        audio_bytes=b"RIFF\x00\x00\x00\x00WAVE",
        filename="x.wav",
        mime_type="audio/wav",
        metadata={"title": "Skips"},
    )
    assert store.db is not None
    store.db.add_stem(
        stem_id=f"{record.id}__ghost",
        entry_id=record.id,
        stem_name="ghost",
        audio_path=str(tmp_path / "does-not-exist.wav"),
    )

    data = build_bundle_bytes(
        entry_id=record.id,
        record=record.to_dict(),
        audio_path=store.get_audio_path(record.id),
        metadata_path=None,
        analysis=None,
        stems=store.db.list_stems(record.id),
        midis=[],
        lineage_edges=[],
    )
    zf = zipfile.ZipFile(io.BytesIO(data))
    names = set(zf.namelist())
    # The ghost stem isn't in the zip, but metadata.json (from record) is.
    assert "stems/ghost.wav" not in names
    assert "metadata.json" in names
    assert "README.txt" in names


def test_lineage_endpoint_walks_relations(tmp_path: Path):
    """Manually exercise the BFS by populating relations between three
    entries and checking that GET /lineage returns the expected
    nodes + edges shape."""
    store = LibraryStore(tmp_path)
    assert store.db is not None
    a = store.import_blob(
        b"RIFF\x00\x00\x00\x00WAVE", "a.wav", "audio/wav", metadata={"title": "A"}
    )
    b = store.import_blob(
        b"RIFF\x00\x00\x00\x00WAVE", "b.wav", "audio/wav", metadata={"title": "B"}
    )
    c = store.import_blob(
        b"RIFF\x00\x00\x00\x00WAVE", "c.wav", "audio/wav", metadata={"title": "C"}
    )
    # A is a chimera_source_of B; B is a chimera_source_of C.
    store.db.add_relation(a.id, b.id, "chimera_source_of")
    store.db.add_relation(b.id, c.id, "chimera_source_of")

    # Re-import the router function so we exercise the BFS directly.
    # (Bypass FastAPI to keep this a pure unit test.)
    from backend.modules.library import router

    router._store = store  # noqa: SLF001 — wire the store the router will pick up
    result = router.get_lineage(a.id, depth=3)
    router._store = None  # noqa: SLF001 — reset

    node_ids = {n["id"] for n in result["nodes"]}
    assert a.id in node_ids
    assert b.id in node_ids
    assert c.id in node_ids
    kinds = {e["kind"] for e in result["edges"]}
    assert kinds == {"chimera_source_of"}


def test_full_graph_endpoint(tmp_path: Path):
    store = LibraryStore(tmp_path)
    assert store.db is not None
    a = store.import_blob(
        b"RIFF\x00\x00\x00\x00WAVE", "a.wav", "audio/wav", metadata={"title": "A"}
    )
    b = store.import_blob(
        b"RIFF\x00\x00\x00\x00WAVE", "b.wav", "audio/wav", metadata={"title": "B"}
    )
    store.db.add_relation(a.id, b.id, "derived_from")

    from backend.modules.library import router

    router._store = store  # noqa: SLF001
    result = router.get_full_graph()
    router._store = None  # noqa: SLF001
    assert result["count"] == 2
    assert len(result["edges"]) == 1
