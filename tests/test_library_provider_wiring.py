"""Provider labeling wired through the store, the router, and the SQL filter.

``backend.modules.library.provider`` decides WHAT a track's provider is;
these tests cover the three places that answer is used:

* the import paths, which store the label and the curated embedded fields,
* the read path, which derives a label for entries that were imported long
  before this feature existed -- without opening a single audio file -- and
  persists that answer once, so the label and the SQL filter agree from then
  on,
* the list filter, which has to match a newly labeled entry and a legacy
  Suno entry with the same ``provider=suno``.

Every fixture is synthetic: the ids, the handle and the model string below
are invented for this file and name nothing in anyone's library.
"""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.modules.library import router as library_router_module
from backend.modules.library.db import EntryFilters
from backend.modules.library.store import LibraryStore

SUNO_ID = "11111111-2222-3333-4444-555555555555"
PARENT_ID = "99999999-8888-7777-6666-555555555555"
ZERO_ID = "00000000-0000-0000-0000-000000000000"
LEGACY_ID = "12121212-3434-5656-7878-909090909090"


def _tagged_mp3(
    path: Path,
    *,
    txxx: dict[str, str] | None = None,
    album: str = "",
    artist: str = "",
    encoder: str = "",
) -> bytes:
    """A file carrying only ID3 frames -- enough for the tag reader, and not
    a byte of audio. Mirrors the fixture style in ``test_library_tags.py``."""
    from mutagen.id3 import ID3, TALB, TPE1, TSSE, TXXX

    path.write_bytes(b"")
    tags = ID3()
    if album:
        tags.add(TALB(encoding=3, text=[album]))
    if artist:
        tags.add(TPE1(encoding=3, text=[artist]))
    if encoder:
        tags.add(TSSE(encoding=3, text=[encoder]))
    for desc, value in (txxx or {}).items():
        tags.add(TXXX(encoding=3, desc=desc, text=[value]))
    tags.save(str(path))
    return path.read_bytes()


def _suno_bytes(tmp_path: Path, name: str = "song.mp3", **overrides: str) -> bytes:
    """The three identifying frames a real Suno file carries, plus the
    curated ones and a few analytics frames that must never be ingested."""
    txxx = {
        "generator": "suno",
        "suno_id": SUNO_ID,
        "suno_prompt": "a chorus about the tide",
        "suno_style": "dark synthwave",
        "suno_negative_tags": "brass",
        "suno_model_name": "test-model-v1",
        "suno_model_version": "9.9",
        "suno_handle": "neutral-handle",
        "suno_parent_id": PARENT_ID,
        "suno_is_instrumental": "False",
        # Analytics: about how the song did, not about the song.
        "suno_play_count": "4321",
        "suno_upvote_count": "77",
        "suno_popularity_class": "top",
        "suno_skip_rate": "0.5",
    }
    txxx.update(overrides)
    return _tagged_mp3(
        tmp_path / name, txxx=txxx, album="Suno AI", artist="Test Artist"
    )


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
        "prompt": "",
        "model": "medium",
        "source": "generate",
        "duration": 1.0,
        "tags": [],
        "notes": "",
        "saved_at": 1700000000.0,
    }
    payload.update(meta)
    (entry_dir / "metadata.json").write_text(json.dumps(payload), encoding="utf-8")
    return entry_dir


def _read_meta(root: Path, entry_id: str) -> dict:
    return json.loads((root / entry_id / "metadata.json").read_text(encoding="utf-8"))


@pytest.fixture
def client_with_root(tmp_path: Path, monkeypatch) -> TestClient:
    monkeypatch.setattr(library_router_module, "_store", None)
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(tmp_path))
    app = FastAPI()
    app.include_router(library_router_module.router, prefix="/api/library")
    return TestClient(app)


# ---- Import path -----------------------------------------------------------


def test_import_blob_labels_a_suno_file(tmp_path: Path):
    store = LibraryStore(tmp_path / "lib")
    record = store.import_blob(
        audio_bytes=_suno_bytes(tmp_path),
        filename="song.mp3",
        mime_type="audio/mpeg",
    )

    assert record.provider == "suno"
    assert record.provider_label == "Suno"
    assert record.provider_is_ai is True
    assert record.provider_id == SUNO_ID
    # The import stays an import: `source` is untouched by labeling.
    assert record.source == "import"
    assert "suno" in record.tags


def test_import_blob_fills_gaps_from_the_curated_embedded_fields(tmp_path: Path):
    store = LibraryStore(tmp_path / "lib")
    record = store.import_blob(
        audio_bytes=_suno_bytes(tmp_path),
        filename="song.mp3",
        mime_type="audio/mpeg",
    )

    assert record.prompt == "a chorus about the tide"
    assert record.negative_prompt == "brass"
    # The model name is passed through from the file, not the generator slug.
    assert record.model == "test-model-v1"
    # Suno's prompt frame holds the sung words, so a vocal track gets lyrics.
    assert record.lyrics == "a chorus about the tide"

    meta = _read_meta(store.root, record.id)
    assert meta["style"] == "dark synthwave"
    assert meta["model_version"] == "9.9"
    assert meta["artist"] == "Test Artist"
    assert meta["parent_id"] == PARENT_ID
    assert meta["is_instrumental"] is False
    assert meta["provider"] == "suno"
    assert meta["provider_label"] == "Suno"
    assert meta["provider_is_ai"] is True
    assert meta["provider_id"] == SUNO_ID


def test_import_blob_caller_metadata_still_wins(tmp_path: Path):
    store = LibraryStore(tmp_path / "lib")
    record = store.import_blob(
        audio_bytes=_suno_bytes(tmp_path),
        filename="song.mp3",
        mime_type="audio/mpeg",
        metadata={
            "prompt": "caller prompt",
            "negative_prompt": "caller negative",
            "model": "caller model",
            "lyrics": "caller lyrics",
            "tags": ["mine"],
        },
    )

    assert record.prompt == "caller prompt"
    assert record.negative_prompt == "caller negative"
    assert record.model == "caller model"
    assert record.lyrics == "caller lyrics"
    # Labeling still happened; the provider tag joins the caller's tags once.
    assert record.provider == "suno"
    assert record.tags == ["mine", "suno"]


def test_import_blob_does_not_duplicate_an_existing_provider_tag(tmp_path: Path):
    store = LibraryStore(tmp_path / "lib")
    record = store.import_blob(
        audio_bytes=_suno_bytes(tmp_path),
        filename="song.mp3",
        mime_type="audio/mpeg",
        metadata={"tags": ["Suno"]},
    )

    assert record.tags == ["Suno"]


def test_import_blob_never_ingests_analytics_or_a_zero_uuid(tmp_path: Path):
    store = LibraryStore(tmp_path / "lib")
    record = store.import_blob(
        audio_bytes=_suno_bytes(tmp_path, suno_parent_id=ZERO_ID),
        filename="song.mp3",
        mime_type="audio/mpeg",
    )

    meta = _read_meta(store.root, record.id)
    # The all-zero parent uuid means "no parent", not a parent.
    assert "parent_id" not in meta
    # No analytics frame becomes a curated field of its own.
    for banned in (
        "play_count",
        "upvote_count",
        "popularity_class",
        "skip_rate",
    ):
        assert banned not in meta


def test_a_file_whose_only_tool_is_its_encoder_falls_back_to_the_derived_slug(
    tmp_path: Path,
):
    """An mp3 written by LAME or ffmpeg says nothing about where the music came
    from, so nothing is stored and nothing is tagged -- the entry keeps the
    slug the catalogue has always shown an import under."""
    store = LibraryStore(tmp_path / "lib")
    record = store.import_blob(
        audio_bytes=_tagged_mp3(tmp_path / "plain.mp3", encoder="Lavf60.16.100"),
        filename="plain.mp3",
        mime_type="audio/mpeg",
    )

    assert record.provider == "import"
    assert record.provider_label == "Imported"
    assert record.provider_is_ai is False
    assert record.provider_id is None
    assert record.tags == []
    assert "provider" not in _read_meta(store.root, record.id)


def test_register_reference_labels_the_file_it_points_at(tmp_path: Path):
    source = tmp_path / "outside" / "song.mp3"
    source.parent.mkdir(parents=True, exist_ok=True)
    _suno_bytes(tmp_path / "outside", name="song.mp3")

    store = LibraryStore(tmp_path / "lib")
    record = store.register_reference(str(source), {"source": "folder"})

    assert record is not None
    assert record.provider == "suno"
    assert record.provider_id == SUNO_ID
    # A reference is still a reference: the audio was not copied in.
    assert _read_meta(store.root, record.id)["source_path"] == str(source.resolve())


def test_bulk_reference_import_opens_no_source_file(tmp_path: Path, monkeypatch):
    """The 200,000-file path must not gain a per-file tag read."""
    from backend.modules.library import tags as tags_module

    folder = tmp_path / "outside"
    folder.mkdir(parents=True, exist_ok=True)
    for index in range(3):
        _suno_bytes(folder, name=f"song{index}.mp3")

    store = LibraryStore(tmp_path / "lib")
    reads: list[str] = []
    real = tags_module.extract_embedded_tags
    monkeypatch.setattr(
        tags_module,
        "extract_embedded_tags",
        lambda path: (reads.append(str(path)), real(path))[1],
    )
    result = store.register_references_bulk(
        sorted(str(p) for p in folder.glob("*.mp3"))
    )

    assert len(result.created) == 3
    assert reads == []


# ---- Read path -------------------------------------------------------------


def test_read_time_derivation_from_stored_embedded_tags(client_with_root, tmp_path):
    """No provider in metadata, no audio read: the label comes from the tags
    the analysis pass already stored. This is how the existing library is
    labeled -- no backfill; the answer is persisted once, per returned row,
    by the read that derived it (see the write-through section below)."""
    _seed_entry(tmp_path, "entry_derived", {"source": "import"})
    store = library_router_module.get_store()
    assert store.db is not None
    store.db.upsert_analysis(
        "entry_derived",
        {"embedded_tags": {"generator": "suno", "txxx_suno_id": SUNO_ID}},
    )

    single = client_with_root.get("/api/library/entries/entry_derived").json()
    assert single["provider"] == "suno"
    assert single["provider_label"] == "Suno"
    assert single["provider_is_ai"] is True
    assert single["provider_id"] == SUNO_ID

    listed = client_with_root.get("/api/library/entries?limit=10").json()["entries"]
    assert [e["provider"] for e in listed] == ["suno"]


def test_legacy_suno_entry_is_labeled_without_an_analysis_row(
    client_with_root, tmp_path
):
    _seed_entry(tmp_path, "entry_legacy", {"source": "suno", "suno_id": LEGACY_ID})

    body = client_with_root.get("/api/library/entries/entry_legacy").json()
    assert body["provider"] == "suno"
    assert body["provider_label"] == "Suno"
    assert body["provider_id"] == LEGACY_ID


def test_an_entry_nothing_identifies_falls_back_to_the_derived_slug(
    client_with_root, tmp_path
):
    _seed_entry(tmp_path, "entry_plain", {"source": "generate", "model": "medium"})

    body = client_with_root.get("/api/library/entries/entry_plain").json()
    assert body["provider"] == "stable-audio"
    assert body["provider_label"] == "Stable Audio"
    assert body["provider_is_ai"] is True
    assert body["provider_id"] is None


def test_stored_label_wins_over_the_embedded_tags(client_with_root, tmp_path):
    _seed_entry(
        tmp_path,
        "entry_pinned",
        {
            "source": "import",
            "provider": "bandcamp",
            "provider_label": "Bandcamp",
            "provider_is_ai": False,
        },
    )
    store = library_router_module.get_store()
    assert store.db is not None
    store.db.upsert_analysis("entry_pinned", {"embedded_tags": {"generator": "suno"}})

    body = client_with_root.get("/api/library/entries/entry_pinned").json()
    assert body["provider"] == "bandcamp"
    assert body["provider_is_ai"] is False


def _provider_column(store: LibraryStore, entry_id: str):
    assert store.db is not None
    row = store.db.get_entry(entry_id)
    assert row is not None
    return row["provider"]


def test_a_thedaw_frame_never_refiles_a_native_generation(
    client_with_root, tmp_path, write_spy
):
    """The fallback's last arm is not a detection that outranks anything.

    ``thedaw`` means "made in theDAW, origin unspecified" -- it is what an
    entry NOTHING identifies is filed under, and it is not an AI provider. A
    theDAW encoder frame is on every file this app writes, including its own
    Stable Audio generations, so letting that frame win would refile a native
    generation as non-AI in the filter, the facet and the badge -- and the
    read path would then PERSIST that into ``entries.provider``, permanently.

    An entry whose ``source`` is 'generate' derives ``stable-audio``, which is
    a better answer than the fallback, so the detection is dropped.
    """
    _seed_entry(tmp_path, "entry_native", {"source": "generate", "model": "medium"})
    store = library_router_module.get_store()
    assert store.db is not None
    store.db.upsert_analysis(
        "entry_native", {"embedded_tags": {"encoder": "theDAW 1.0"}}
    )
    before = _provider_column(store, "entry_native")

    single = client_with_root.get("/api/library/entries/entry_native").json()
    assert single["provider"] == "stable-audio"
    assert single["provider_is_ai"] is True

    listed = client_with_root.get("/api/library/entries?limit=10").json()["entries"]
    assert [e["provider"] for e in listed] == ["stable-audio"]

    # Nothing was written through: the column still says what it said, and the
    # metadata on disk was never rewritten with a provider.
    assert write_spy == []
    assert _provider_column(store, "entry_native") == before
    assert "provider" not in _read_meta(store.root, "entry_native")


def test_a_thedaw_frame_outranks_an_import(client_with_root, tmp_path, write_spy):
    """The other side of the same clause: it turns on the derivation's ROLE.

    'import' says the row came from outside and nothing about who made the
    music; "made in theDAW" is more specific and neither is claimed to be a
    generator, so here the frame is the better answer -- applied, and persisted
    so the ``provider=`` filter files the entry where it is shown.
    """
    _seed_entry(tmp_path, "entry_imported", {"source": "import", "model": "imported"})
    store = library_router_module.get_store()
    assert store.db is not None
    store.db.upsert_analysis(
        "entry_imported", {"embedded_tags": {"encoder": "theDAW 1.0"}}
    )

    body = client_with_root.get("/api/library/entries/entry_imported").json()
    assert body["provider"] == "thedaw"
    assert body["provider_label"] == "theDAW"
    assert body["provider_is_ai"] is False
    assert [call for call in write_spy if "entry_imported" in call]
    assert _provider_column(store, "entry_imported") == "thedaw"


def test_a_real_provider_frame_still_outranks_a_derivation(
    client_with_root, tmp_path, write_spy
):
    """The guard above is narrow: it silences the FALLBACK slug only.

    A Suno frame on a row the columns call 'generate' still wins, and is still
    persisted -- which is the behaviour the write-through exists for.
    """
    _seed_entry(tmp_path, "entry_suno_gen", {"source": "generate", "model": "medium"})
    store = library_router_module.get_store()
    assert store.db is not None
    store.db.upsert_analysis(
        "entry_suno_gen",
        {"embedded_tags": {"generator": "suno", "txxx_suno_id": SUNO_ID}},
    )

    body = client_with_root.get("/api/library/entries/entry_suno_gen").json()
    assert body["provider"] == "suno"
    assert body["provider_id"] == SUNO_ID
    assert [call for call in write_spy if "entry_suno_gen" in call]
    assert _provider_column(store, "entry_suno_gen") == "suno"


#: An invented tool name no rule claims and no generic-encoder marker matches,
#: so ``detect_provider`` mints a slug for it (step 4). Names nothing real.
UNKNOWN_TOOL = "Acme Mastering Suite"
UNKNOWN_TOOL_SLUG = "acme-mastering-suite"


def test_a_minted_tool_slug_never_refiles_a_generation(
    client_with_root, tmp_path, write_spy
):
    """A tool frame describes what TOUCHED the file, not what made the music.

    Step 4 of ``detect_provider`` mints a slug from any tool string it does not
    recognise, and that slug is non-AI. An entry the columns call a generation
    already has a better answer, and it is an AI one, so a bounce through some
    unknown mastering tool must not turn it into a non-AI provider in the
    filter, the facet and the badge -- nor be persisted there.
    """
    _seed_entry(tmp_path, "entry_tooled", {"source": "generate", "model": "medium"})
    store = library_router_module.get_store()
    assert store.db is not None
    store.db.upsert_analysis(
        "entry_tooled", {"embedded_tags": {"encoder": UNKNOWN_TOOL}}
    )
    before = _provider_column(store, "entry_tooled")

    single = client_with_root.get("/api/library/entries/entry_tooled").json()
    assert single["provider"] == "stable-audio"
    assert single["provider_is_ai"] is True

    listed = client_with_root.get("/api/library/entries?limit=10").json()["entries"]
    assert [e["provider"] for e in listed] == ["stable-audio"]

    assert write_spy == []
    assert _provider_column(store, "entry_tooled") == before
    assert "provider" not in _read_meta(store.root, "entry_tooled")


def test_a_minted_tool_slug_still_answers_for_an_import(
    client_with_root, tmp_path, write_spy
):
    """Non-AI over a non-AI derivation is fine: 'import' says nothing about
    who made the track, and the file at least names the tool. The rule only
    protects an AI derivation."""
    _seed_entry(tmp_path, "entry_tooled_imp", {"source": "import", "model": "imported"})
    store = library_router_module.get_store()
    assert store.db is not None
    store.db.upsert_analysis(
        "entry_tooled_imp", {"embedded_tags": {"encoder": UNKNOWN_TOOL}}
    )

    body = client_with_root.get("/api/library/entries/entry_tooled_imp").json()
    assert body["provider"] == UNKNOWN_TOOL_SLUG
    assert body["provider_label"] == UNKNOWN_TOOL
    assert body["provider_is_ai"] is False
    assert [call for call in write_spy if "entry_tooled_imp" in call]
    assert _provider_column(store, "entry_tooled_imp") == UNKNOWN_TOOL_SLUG


def test_a_thedaw_detection_over_a_thedaw_derivation_writes_nothing(
    client_with_root, tmp_path, write_spy
):
    """The pass-through branch, pinned.

    Where the derivation IS the fallback the detection is allowed through --
    and it agrees with what the entry is already shown as, so nothing about
    the four wire fields changed and no write follows. This is the claim the
    rank rule's docstring makes; without a test it is only a claim.
    """
    _seed_entry(tmp_path, "entry_set", {"source": "performance-set", "model": "medium"})
    store = library_router_module.get_store()
    assert store.db is not None
    store.db.upsert_analysis("entry_set", {"embedded_tags": {"encoder": "theDAW 1.0"}})
    before = _provider_column(store, "entry_set")

    body = client_with_root.get("/api/library/entries/entry_set").json()
    assert body["provider"] == "thedaw"
    assert body["provider_is_ai"] is False
    assert write_spy == []
    assert _provider_column(store, "entry_set") == before


# ---- Import-time labeling under the same rank rule -------------------------


def _import_with_encoder(store: LibraryStore, tmp_path: Path, encoder: str, **meta):
    return store.import_blob(
        audio_bytes=_tagged_mp3(tmp_path / "bounce.mp3", encoder=encoder),
        filename="bounce.mp3",
        mime_type="audio/mpeg",
        metadata=dict(meta),
    )


def test_import_of_a_generation_ignores_a_thedaw_frame(tmp_path: Path):
    """The import labeler applies the SAME rank rule as the read path.

    A theDAW bounce re-imported as a generation keeps the generation's own
    label: no provider fields in its ``metadata.json``, and no ``thedaw`` tag
    inviting the tag filter to disagree with the provider filter.
    """
    store = LibraryStore(tmp_path / "lib")
    record = _import_with_encoder(store, tmp_path, "theDAW 1.0", source="generate")

    assert record.provider == "stable-audio"
    assert record.provider_is_ai is True
    assert record.tags == []
    meta = _read_meta(store.root, record.id)
    assert "provider" not in meta
    assert "provider_label" not in meta
    assert "thedaw" not in (meta.get("tags") or [])


def test_import_of_a_generation_ignores_a_minted_tool_slug(tmp_path: Path):
    store = LibraryStore(tmp_path / "lib")
    record = _import_with_encoder(store, tmp_path, UNKNOWN_TOOL, source="generate")

    assert record.provider == "stable-audio"
    assert record.provider_is_ai is True
    assert record.tags == []
    assert "provider" not in _read_meta(store.root, record.id)


def test_import_with_a_thedaw_frame_beats_the_import_label(tmp_path: Path):
    """Clause (a) turns on the derivation's ROLE, not on the slug.

    'import' is not an AI derivation, so a theDAW frame is the better answer
    and is stored and tagged -- the same answer the router gives the same entry
    on a read (``test_a_thedaw_frame_outranks_an_import``), which is the point
    of both labelers asking one function.
    """
    store = LibraryStore(tmp_path / "lib")
    record = _import_with_encoder(store, tmp_path, "theDAW 1.0", source="import")

    assert record.provider == "thedaw"
    assert record.provider_label == "theDAW"
    assert record.provider_is_ai is False
    assert "thedaw" in record.tags
    assert _read_meta(store.root, record.id)["provider"] == "thedaw"


def test_import_with_a_minted_tool_frame_beats_the_import_label(tmp_path: Path):
    """The import labeler's positive case for a non-AI detection: an unknown
    tool names something, and 'import' does not."""
    store = LibraryStore(tmp_path / "lib")
    record = _import_with_encoder(store, tmp_path, UNKNOWN_TOOL, source="import")

    assert record.provider == UNKNOWN_TOOL_SLUG
    assert record.provider_label == UNKNOWN_TOOL
    assert record.provider_is_ai is False
    assert UNKNOWN_TOOL_SLUG in record.tags
    assert _read_meta(store.root, record.id)["provider"] == UNKNOWN_TOOL_SLUG


@pytest.mark.parametrize("falsy", [None, ""], ids=["none", "empty"])
def test_import_labels_from_the_columns_the_row_will_actually_hold(
    tmp_path: Path, falsy
):
    """The labeler and the row must read the same ``(model, source)``.

    A caller may hand ``import_blob`` a falsy ``source``; every record
    constructor normalises that to its own default ('generate' for an audio
    entry), and the read path derives from the normalised row. Deriving from
    the raw dict here instead made the two disagree: the labeler saw no source
    at all, derived the non-AI fallback, let a theDAW frame win and PERSISTED
    ``provider=thedaw`` -- for a row whose every other reader says
    stable-audio.
    """
    store = LibraryStore(tmp_path / "lib")
    record = _import_with_encoder(
        store, tmp_path, "theDAW 1.0", source=falsy, model="medium"
    )

    assert record.source == "generate"
    assert record.provider == "stable-audio"
    assert record.provider_is_ai is True
    assert record.tags == []
    assert "provider" not in _read_meta(store.root, record.id)


def test_an_outranked_detection_still_ingests_the_curated_song_fields(tmp_path: Path):
    """Losing the RANK is not losing the song.

    The curated fields describe the music -- prompt, style, lyrics, the model
    version the file names -- and none of them claims a provider. They are
    worth ingesting whoever wins, so only the four provider wire fields and the
    provider tag are skipped when the detection is outranked.
    """
    store = LibraryStore(tmp_path / "lib")
    record = store.import_blob(
        audio_bytes=_tagged_mp3(
            tmp_path / "curated.mp3",
            encoder=UNKNOWN_TOOL,
            txxx={
                "style": "dream pop",
                "model_version": "v2.1",
                "lyrics": "a line",
                "prompt": "a prompt",
            },
        ),
        filename="curated.mp3",
        mime_type="audio/mpeg",
        metadata={"source": "generate"},
    )

    # The provider answer is the row's own, and nothing was tagged.
    assert record.provider == "stable-audio"
    assert record.provider_is_ai is True
    assert record.tags == []
    meta = _read_meta(store.root, record.id)
    assert "provider" not in meta
    assert "provider_label" not in meta

    # The song fields are ingested all the same.
    assert meta["style"] == "dream pop"
    assert meta["model_version"] == "v2.1"
    assert record.lyrics == "a line"
    assert record.prompt == "a prompt"


def test_import_of_a_generation_still_takes_a_real_service_frame(tmp_path: Path):
    """Unchanged: a named service outranks the derivation either way."""
    store = LibraryStore(tmp_path / "lib")
    record = store.import_blob(
        audio_bytes=_suno_bytes(tmp_path),
        filename="song.mp3",
        mime_type="audio/mpeg",
        metadata={"source": "generate"},
    )

    assert record.provider == "suno"
    assert record.provider_is_ai is True
    assert record.provider_id == SUNO_ID
    assert "suno" in record.tags


# ---- List filter -----------------------------------------------------------


@pytest.fixture
def mixed_library(tmp_path: Path) -> LibraryStore:
    """One entry per way a track can be (or fail to be) a Suno track."""
    root = tmp_path / "lib"
    # Seeded before the store opens, so the auto-reindex picks them up.
    root.mkdir(parents=True, exist_ok=True)
    _seed_entry(root, "legacy_source", {"source": "suno"})
    _seed_entry(root, "legacy_id", {"source": "import", "suno_id": LEGACY_ID})
    _seed_entry(root, "plain", {"source": "generate"})

    store = LibraryStore(root)
    store.import_blob(
        audio_bytes=_suno_bytes(tmp_path),
        filename="fresh.mp3",
        mime_type="audio/mpeg",
        metadata={"title": "fresh suno"},
    )
    store.import_blob(
        audio_bytes=_tagged_mp3(
            tmp_path / "udio.mp3", txxx={"generator": "udio", "udio_id": "u-0001"}
        ),
        filename="udio.mp3",
        mime_type="audio/mpeg",
        metadata={"title": "fresh udio"},
    )
    return store


def _ids(store: LibraryStore, **kwargs) -> set[str]:
    assert store.db is not None
    return set(store.db.list_entry_ids(EntryFilters(**kwargs), 100))


def _titles(store: LibraryStore, **kwargs) -> set[str]:
    assert store.db is not None
    return {
        str(row["title"])
        for row in store.db.list_entries_page(EntryFilters(**kwargs), limit=100)
    }


def test_provider_filter_matches_new_and_legacy_suno_entries(mixed_library):
    store = mixed_library
    matched = _titles(store, provider="suno")

    assert matched == {"fresh suno", "legacy_source", "legacy_id"}
    assert store.db is not None
    assert store.db.count_entries_filtered(EntryFilters(provider="suno")) == 3


def test_provider_filter_excludes_other_providers(mixed_library):
    store = mixed_library
    assert _titles(store, provider="udio") == {"fresh udio"}
    assert _titles(store, provider="bandcamp") == set()


def test_provider_filter_is_case_insensitive_about_the_slug(mixed_library):
    assert len(_ids(mixed_library, provider="SUNO")) == 3


def test_source_filter_is_unchanged_by_the_provider_filter(mixed_library):
    store = mixed_library
    # `source` still means the three-value column it always meant.
    assert _titles(store, source="generate") == {"plain"}
    assert _titles(store, source="import") == {
        "legacy_id",
        "fresh suno",
        "fresh udio",
    }
    assert _titles(store, source="suno") == {"legacy_source"}
    # Combining the two narrows to the intersection.
    assert _titles(store, source="import", provider="suno") == {
        "legacy_id",
        "fresh suno",
    }


def test_provider_filter_survives_the_user_deleting_the_provider_tag(
    tmp_path: Path,
):
    """The tag is a convenience; ``$.provider`` is the authority."""
    store = LibraryStore(tmp_path / "lib")
    record = store.import_blob(
        audio_bytes=_suno_bytes(tmp_path),
        filename="song.mp3",
        mime_type="audio/mpeg",
    )
    store.update_entry(record.id, {"tags": []})

    assert _ids(store, provider="suno") == {record.id}


# ---- Python / SQL parity ---------------------------------------------------

#: One row per rule of the provider precedence, plus the two cases that decide
#: whether the two implementations really are the same rule: a stored label
#: (rule 1) whose model would otherwise say something else, and a model that
#: merely CONTAINS "suno", which the frontend's `includes('suno')` matches and
#: an equality test would not. ``(entry_id, model, source, extra, slug)``.
PARITY_ROWS: tuple[tuple[str, str, str, dict, str], ...] = (
    (
        "stored_label",
        "medium",
        "import",
        {
            "provider": "bandcamp",
            "provider_label": "Bandcamp",
            "provider_is_ai": False,
        },
        "bandcamp",
    ),
    ("legacy_source", "medium", "suno", {}, "suno"),
    ("legacy_suno_id", "medium", "import", {"suno_id": LEGACY_ID}, "suno"),
    ("model_suno", "suno", "folder", {}, "suno"),
    ("model_sunoesque", "sunoesque", "generate", {}, "suno"),
    ("model_magenta", "gemini-magenta", "generate", {}, "gemini-magenta"),
    ("model_gemini", "gemini-music", "generate", {}, "gemini-magenta"),
    ("model_udio", "udio-v2", "generate", {}, "udio"),
    ("model_riffusion", "riffusion", "generate", {}, "riffusion"),
    ("plain_import", "whatever", "import", {}, "import"),
    ("native_generate", "medium", "generate", {}, "stable-audio"),
    ("native_studio", "", "studio", {}, "stable-audio"),
    # T13: made IN theDAW without a model. These used to be labeled
    # "Stable Audio (AI)" on the wire AND filed under stable-audio by SQL --
    # agreeing with each other and wrong in both places.
    ("native_performance_set", "", "performance-set", {}, "thedaw"),
    ("native_vj", None, "vj", {}, "thedaw"),
)


@pytest.fixture
def parity_store(tmp_path: Path) -> LibraryStore:
    root = tmp_path / "lib"
    root.mkdir(parents=True, exist_ok=True)
    for entry_id, model, source, extra, _slug in PARITY_ROWS:
        _seed_entry(root, entry_id, {"model": model, "source": source, **extra})
    return LibraryStore(root)


def test_the_wire_label_matches_the_rule_table(parity_store):
    """What an entry is labeled, read off disk and read out of the DB."""
    expected = {entry_id: slug for entry_id, _m, _s, _x, slug in PARITY_ROWS}
    assert {r.id: r.provider for r in parity_store.list_entries()} == expected
    paged = parity_store.list_entries_page(EntryFilters(), limit=100)
    assert {r.id: r.provider for r in paged} == expected


def test_the_sql_filter_files_every_entry_under_its_wire_label(parity_store):
    """The parity that matters: for every rule, the slug Python puts on the
    wire is the slug the SQL filter returns that entry under -- and no entry
    is returned under two."""
    wire = {r.id: r.provider for r in parity_store.list_entries()}
    by_entry: dict[str, list[str]] = {entry_id: [] for entry_id in wire}
    for slug in sorted(set(wire.values())):
        for entry_id in _ids(parity_store, provider=slug):
            by_entry[entry_id].append(slug)

    assert by_entry == {entry_id: [slug] for entry_id, slug in wire.items()}
    assert parity_store.db is not None
    for slug in sorted(set(wire.values())):
        matched = sum(1 for value in wire.values() if value == slug)
        assert (
            parity_store.db.count_entries_filtered(EntryFilters(provider=slug))
            == matched
        )


def test_the_provider_facet_counts_every_entry_under_the_slug_it_filters_as(
    parity_store,
):
    """The facet counts a row under the slug the FILTER returns it under.

    CHANGED by the resolved ``provider`` column (T11). This test used to pin
    the opposite: the facet grouped on ``(model, source)`` alone, because the
    rule's two metadata-backed arms -- a stored ``$.provider`` and a
    ``$.suno_id`` -- could only be read by parsing every row's
    ``metadata_json``, which cost 570 ms at 200,000 rows against the facet's
    300 ms budget. So ``stored_label`` was counted under "import" while
    ``provider=bandcamp`` was what actually returned it, and the divergence was
    pinned rather than fixed.

    Resolving those two arms ONCE into ``entries.provider`` made the whole rule
    affordable to group on: the facet and the filter now read the same
    ``PROVIDER_SQL``, out of the same index, so "counted as" and "filtered as"
    are the same string for every row by construction. Asserted here as an
    identity against the filter rather than against a second expression, since
    an expression could agree with the facet and both be wrong.
    """
    assert parity_store.db is not None
    facet = {
        row["value"]: row["count"]
        for row in parity_store.db.facet_counts(EntryFilters(), ["provider"])[
            "provider"
        ]
    }
    wire = {r.id: r.provider for r in parity_store.list_entries()}
    for slug, count in facet.items():
        assert _ids(parity_store, provider=slug) == {
            entry_id for entry_id, value in wire.items() if value == slug
        }
        assert count == len(_ids(parity_store, provider=slug))
    # Every entry lands in exactly one bucket, and the gap this used to have
    # is closed from both ends.
    assert sum(facet.values()) == len(PARITY_ROWS)
    assert facet["bandcamp"] == 1
    assert _ids(parity_store, provider="bandcamp") == {"stored_label"}
    assert _ids(parity_store, provider="import") == {"plain_import"}
    assert "legacy_suno_id" in _ids(parity_store, provider="suno")


#: The fallback rule walked model-string by model-string, in both languages.
#: The SAME table ``inferProvider`` walks in
#: ``frontend/src/catalog/catalogProviders.test.ts``: three implementations of
#: one rule, one list of cases, so a fix on one side that is not made on the
#: others fails here. ``(model, source, slug)``.
#:
#: ``stable-audio-3-medium`` and ``audiocraft`` are the reason the udio arm
#: deletes the word "audio" before it looks: "udio" is a substring of "audio",
#: so a bare substring test filed every Stable Audio model under Udio. The
#: ``chirp-*`` rows are the T14 arm: Suno names no model of its own, and
#: neither "suno" nor a stored label appears on one of those rows.
FALLBACK_PARITY_ROWS: tuple[tuple[object, object, str], ...] = (
    ("chirp-v4", "suno", "suno"),
    # T14: ``chirp`` is Suno's model family and the only thing an exported Suno
    # song's model column says. The source arm answers the row above; these
    # three are the rows that USED to fall through it -- an import of the
    # audio, a row re-sourced by a writer, a row whose source says nothing --
    # and be badged by the last arm.
    ("chirp-v4", "generate", "suno"),
    ("chirp-v4", "import", "suno"),
    ("chirp-v4", "", "suno"),
    ("chirp-crow", "", "suno"),
    ("suno-v3", "generate", "suno"),
    ("sunoesque", "import", "suno"),
    ("magenta-rt", "generate", "gemini-magenta"),
    ("gemini-x", "import", "gemini-magenta"),
    ("udio-1", "import", "udio"),
    ("Udio v1.5", "generate", "udio"),
    ("stable-audio-3-medium", "generate", "stable-audio"),
    ("audiocraft", "import", "import"),
    ("audio-udio-blend", "import", "udio"),
    ("riffusion", "import", "riffusion"),
    ("imported", "import", "import"),
    (None, "import", "import"),
    ("stable-audio-3", "generate", "stable-audio"),
    ("sa3", "generate", "stable-audio"),
    ("anything", "studio", "stable-audio"),
    ("mixdown", "studio", "stable-audio"),
    # T13: the last arm is theDAW's own, not Stable Audio. A DJ performance
    # set, VJ media, an unrecognised source and a row that says nothing at all
    # are made IN theDAW; they are not generated by a model.
    ("", "performance-set", "thedaw"),
    (None, "vj", "thedaw"),
    ("anything", "", "thedaw"),
    (None, None, "thedaw"),
)


def test_the_fallback_rule_reads_every_model_string_the_frontend_does():
    """The Python twin of ``PROVIDER_FALLBACK_SQL``, row by row."""
    from backend.modules.library.db import infer_provider

    for model, source, slug in FALLBACK_PARITY_ROWS:
        assert infer_provider(model, source) == slug, (model, source)


def test_the_sql_fallback_files_every_model_string_where_python_does(tmp_path: Path):
    """The same table through SQL, on entries whose metadata names no provider
    at all -- so the ``provider`` column is NULL for every one of them and the
    fallback is what answers.

    ``None`` is seeded as the column's own default (``model`` is NOT NULL
    DEFAULT '' and ``source`` defaults to 'generate'), which is what a row with
    no value actually holds; both spellings reach the same arm of the rule.
    """
    from backend.modules.library.db import infer_provider

    root = tmp_path / "lib"
    root.mkdir(parents=True, exist_ok=True)
    expected: dict[str, str] = {}
    seeded: list[tuple[str, tuple[object, object, str]]] = []
    for index, (model, source, slug) in enumerate(FALLBACK_PARITY_ROWS):
        if not source:
            # ``entries.source`` is NOT NULL DEFAULT 'generate' and every
            # writer spells a falsy source that way, so a None/'' row cannot
            # exist in the table to be filed under anything: it IS a
            # 'generate' row, which the arm above already covers. Before T13
            # seeding it as 'generate' happened to give the same answer the
            # table wants ('stable-audio' either way); now it does not, so
            # seeding it here would assert the wrong thing about the column.
            # ``model`` has no such problem -- NOT NULL DEFAULT '' reaches the
            # same arm as None.
            continue
        entry_id = f"fallback_{index:02d}"
        _seed_entry(root, entry_id, {"model": model, "source": source})
        expected[entry_id] = slug
        seeded.append((entry_id, (model, source, slug)))
    store = LibraryStore(root)
    assert store.db is not None

    # These rows name no provider, so the column is NULL and the fallback is
    # what answers -- except ``source='suno'``, which is BOTH an arm of the
    # fallback and a legacy metadata marker, and so resolves to the same slug
    # from either side. Nowhere does the column contradict the fallback.
    columns = {
        str(r["id"]): r["provider"]
        for r in store.db._conn.execute("SELECT id, provider FROM entries").fetchall()
    }
    assert columns["fallback_00"] == "suno"  # the ('chirp-v4', 'suno') row
    assert {k: v for k, v in columns.items() if k != "fallback_00"} == {
        entry_id: None for entry_id in expected if entry_id != "fallback_00"
    }

    for slug in sorted(set(expected.values())):
        assert _ids(store, provider=slug) == {
            entry_id for entry_id, value in expected.items() if value == slug
        }
    assert {r.id: r.provider for r in store.list_entries()} == expected
    assert {
        entry_id: infer_provider(model, source)
        for entry_id, (model, source, _slug) in seeded
    } == expected


def test_infer_provider_still_mirrors_the_frontend_rules():
    """The FALLBACK alone, as the pure function its SQL twin is written from.

    ``suno_id`` is no longer an argument: it lives in an entry's metadata, and
    everything only the metadata knows is resolved into the ``provider`` column
    at write time instead of being asked of the columns at query time. The rows
    that carry one are therefore excluded here with the stored-label row --
    neither is this function's business any more.
    """
    from backend.modules.library.db import infer_provider

    for _id, model, source, extra, slug in PARITY_ROWS:
        if "provider" in extra or "suno_id" in extra:
            continue
        assert infer_provider(model, source) == slug


def test_list_endpoint_filters_and_counts_by_provider(client_with_root, tmp_path):
    _seed_entry(tmp_path, "legacy_source", {"source": "suno"})
    _seed_entry(tmp_path, "plain", {"source": "generate"})
    store = library_router_module.get_store()
    store.import_blob(
        audio_bytes=_suno_bytes(tmp_path),
        filename="fresh.mp3",
        mime_type="audio/mpeg",
        metadata={"title": "fresh suno"},
    )

    body = client_with_root.get("/api/library/entries?provider=suno").json()
    assert {e["title"] for e in body["entries"]} == {"legacy_source", "fresh suno"}
    assert body["total"] == 2
    assert all(e["provider"] == "suno" for e in body["entries"])

    ids = client_with_root.get("/api/library/entries/ids?provider=suno").json()
    assert ids["total"] == 2

    empty = client_with_root.get("/api/library/entries?provider=udio").json()
    assert empty["entries"] == []
    assert empty["total"] == 0


# ---- Read-time write-through -----------------------------------------------
#
# The label an entry is SHOWN with is derived in Python from the tag blob in
# its analysis row; the ``provider=`` filter is SQL over the entry row alone.
# Until the derived answer is stored, those two disagree about the same entry
# forever and it answers to NO provider filter: not the slug it is shown under
# (SQL does not return it) and not the slug SQL files it under (the catalogue
# re-applies the filter to the rows it loaded and drops it). These cover the
# write that ends the disagreement, and everything it must not do.

#: The entry the defect was found on: a stock Suno MP3 imported long before
#: labeling existed, so the row itself says "imported" / "import" and the only
#: surviving evidence is the tag blob the analysis pass stored.
STOCK_ID = "entry_stock_suno"


def _stock_suno_embedded(tmp_path: Path) -> dict:
    """The tag blob a stock Suno download leaves, straight out of the reader
    rather than hand-written, so the fixture cannot invent a frame name."""
    from backend.modules.library.tags import extract_embedded_tags

    _suno_bytes(tmp_path, name="stock.mp3")
    return extract_embedded_tags(tmp_path / "stock.mp3")


def _seed_stock_suno(root: Path, entry_id: str = STOCK_ID) -> None:
    _seed_entry(root, entry_id, {"source": "import", "model": "imported"})


def _analyze_as_stock_suno(store: LibraryStore, tmp_path: Path, entry_id: str) -> None:
    assert store.db is not None
    store.db.upsert_analysis(
        entry_id, {"embedded_tags": _stock_suno_embedded(tmp_path)}
    )


def _filtered(client: TestClient, slug: str) -> dict:
    return client.get(f"/api/library/entries?provider={slug}&limit=50").json()


@pytest.fixture
def write_spy(monkeypatch) -> list[dict]:
    """Every call the read path makes to the persistence, in order."""
    calls: list[dict] = []
    real = LibraryStore.record_detected_providers

    def spy(self, detected):
        calls.append(dict(detected))
        return real(self, detected)

    monkeypatch.setattr(LibraryStore, "record_detected_providers", spy)
    return calls


def test_a_stock_suno_import_becomes_findable_after_one_unfiltered_read(
    client_with_root, tmp_path
):
    """The defect, end to end.

    Before: the entry is shown as Suno and filed under ``import``, so
    ``provider=suno`` cannot see it. One ordinary list read later it is filed
    where it is shown, and only there."""
    _seed_stock_suno(tmp_path)
    store = library_router_module.get_store()
    _analyze_as_stock_suno(store, tmp_path, STOCK_ID)

    before_suno = _filtered(client_with_root, "suno")
    before_import = _filtered(client_with_root, "import")
    assert before_suno["total"] == 0
    assert before_suno["entries"] == []
    assert [e["id"] for e in before_import["entries"]] == [STOCK_ID]
    # A filtered page shows rows as the filter filed them -- it does not
    # relabel its own result set out from under the filter that chose it.
    assert before_import["entries"][0]["provider"] == "import"
    assert before_import["total"] == len(before_import["entries"]) == 1

    listed = client_with_root.get("/api/library/entries?limit=50").json()
    assert [e["provider"] for e in listed["entries"]] == ["suno"]

    after_suno = _filtered(client_with_root, "suno")
    after_import = _filtered(client_with_root, "import")
    assert [e["id"] for e in after_suno["entries"]] == [STOCK_ID]
    assert after_suno["total"] == len(after_suno["entries"]) == 1
    assert after_suno["entries"][0]["provider_id"] == SUNO_ID
    assert after_import["entries"] == []
    assert after_import["total"] == 0


def test_the_write_through_stores_the_wire_fields_and_why(client_with_root, tmp_path):
    _seed_stock_suno(tmp_path)
    store = library_router_module.get_store()
    _analyze_as_stock_suno(store, tmp_path, STOCK_ID)
    client_with_root.get("/api/library/entries?limit=50")

    meta = _read_meta(store.root, STOCK_ID)
    assert meta["provider"] == "suno"
    assert meta["provider_label"] == "Suno"
    assert meta["provider_is_ai"] is True
    assert meta["provider_id"] == SUNO_ID
    assert meta["provider_confidence"] == "explicit"
    assert meta["provider_evidence"]
    # Both copies of an entry's metadata agree; the column is what the SQL
    # filter reads.
    assert store.db is not None
    row = store.db.get_entry(STOCK_ID)
    assert row is not None
    assert json.loads(row["metadata_json"])["provider"] == "suno"
    # Import-time behaviour is NOT repeated here: no provider tag is added.
    assert meta["tags"] == []


def test_the_write_through_never_overwrites_a_stored_provider(
    client_with_root, tmp_path
):
    _seed_entry(
        tmp_path,
        "entry_pinned_wt",
        {
            "source": "import",
            "model": "imported",
            "provider": "bandcamp",
            "provider_label": "Bandcamp",
            "provider_is_ai": False,
        },
    )
    store = library_router_module.get_store()
    _analyze_as_stock_suno(store, tmp_path, "entry_pinned_wt")

    body = client_with_root.get("/api/library/entries?limit=50").json()

    assert [e["provider"] for e in body["entries"]] == ["bandcamp"]
    meta = _read_meta(store.root, "entry_pinned_wt")
    assert meta["provider"] == "bandcamp"
    assert "provider_evidence" not in meta
    assert _filtered(client_with_root, "bandcamp")["total"] == 1


def test_a_second_read_writes_nothing(client_with_root, tmp_path, write_spy):
    _seed_stock_suno(tmp_path)
    store = library_router_module.get_store()
    _analyze_as_stock_suno(store, tmp_path, STOCK_ID)

    client_with_root.get("/api/library/entries?limit=50")
    assert [sorted(call) for call in write_spy] == [[STOCK_ID]]
    path = store.root / STOCK_ID / "metadata.json"
    raw = path.read_bytes()
    mtime = path.stat().st_mtime_ns
    assert store.db is not None
    row_json = store.db.get_entry(STOCK_ID)["metadata_json"]

    second = client_with_root.get("/api/library/entries?limit=50").json()

    # The label is still right, and nothing was written to produce it: the
    # persistence was not reached a second time at all.
    assert [e["provider"] for e in second["entries"]] == ["suno"]
    assert len(write_spy) == 1
    assert path.read_bytes() == raw
    assert path.stat().st_mtime_ns == mtime
    assert store.db.get_entry(STOCK_ID)["metadata_json"] == row_json


def test_the_write_through_is_not_a_user_edit(client_with_root, tmp_path, monkeypatch):
    """``updated_at``, ``timestamp``, sort position, the user-edit write path
    and the background queues: none of them may notice this."""
    from backend.modules.library import store as store_module

    _seed_entry(tmp_path, "aaa_before", {"source": "generate"})
    _seed_stock_suno(tmp_path)
    _seed_entry(tmp_path, "zzz_after", {"source": "generate"})
    store = library_router_module.get_store()
    assert store.db is not None
    _analyze_as_stock_suno(store, tmp_path, STOCK_ID)

    before_row = store.db.get_entry(STOCK_ID)
    before_order = [
        e["id"]
        for e in client_with_root.get("/api/library/entries?limit=50").json()["entries"]
    ]
    before_meta = _read_meta(store.root, STOCK_ID)

    enqueued: list[str] = []
    for name in (
        "_maybe_enqueue_analysis",
        "_maybe_enqueue_stems",
        "_maybe_enqueue_shards",
        "_maybe_enqueue_midi",
        "_maybe_enqueue_lyrics",
        "_maybe_enqueue_score",
    ):
        monkeypatch.setattr(
            store_module, name, lambda *a, _n=name, **k: enqueued.append(_n)
        )
    upserts: list[str] = []
    monkeypatch.setattr(
        type(store.db),
        "upsert_entry",
        lambda self, payload: upserts.append(str(payload.get("id"))),
    )

    # The read above already wrote for STOCK_ID, so a second untouched entry
    # provides the write that happens with the spies installed.
    _seed_stock_suno(tmp_path, "entry_stock_two")
    store.db.upsert_entries_bulk(
        [
            {
                "id": "entry_stock_two",
                "source": "import",
                "model": "imported",
                "title": "entry_stock_two",
                "metadata_json": _read_meta(store.root, "entry_stock_two"),
            }
        ]
    )
    _analyze_as_stock_suno(store, tmp_path, "entry_stock_two")
    two_before = store.db.get_entry("entry_stock_two")
    two_meta_before = _read_meta(store.root, "entry_stock_two")

    after = client_with_root.get("/api/library/entries?limit=50").json()

    # Nothing enqueued, and not one row went through the user-edit path.
    assert enqueued == []
    assert upserts == []
    # The write added the provider keys and changed NOTHING else in the file:
    # the entry's own timestamps are byte-identical.
    two_meta_after = _read_meta(store.root, "entry_stock_two")
    assert two_meta_after["provider"] == "suno"
    assert {
        k: v for k, v in two_meta_after.items() if not k.startswith("provider")
    } == two_meta_before
    # Neither row's DB timestamps moved.
    two_after = store.db.get_entry("entry_stock_two")
    assert two_after["updated_at"] == two_before["updated_at"]
    assert two_after["timestamp"] == two_before["timestamp"]
    assert store.db.get_entry(STOCK_ID)["updated_at"] == before_row["updated_at"]
    assert _read_meta(store.root, STOCK_ID) == before_meta
    # Sort position is unchanged for every entry that existed before.
    assert [
        e["id"] for e in after["entries"] if e["id"] in before_order
    ] == before_order


def test_a_failing_write_still_returns_the_labeled_response(
    client_with_root, tmp_path, monkeypatch
):
    _seed_stock_suno(tmp_path)
    store = library_router_module.get_store()
    _analyze_as_stock_suno(store, tmp_path, STOCK_ID)

    def boom(self, detected):
        raise RuntimeError("read-only library")

    monkeypatch.setattr(LibraryStore, "record_detected_providers", boom)

    body = client_with_root.get("/api/library/entries?limit=50").json()
    single = client_with_root.get(f"/api/library/entries/{STOCK_ID}").json()

    assert [e["provider"] for e in body["entries"]] == ["suno"]
    assert body["entries"][0]["provider_id"] == SUNO_ID
    assert body["total"] == 1
    assert single["provider"] == "suno"
    # Degraded to exactly the old behaviour: derived every read, stored never.
    assert "provider" not in _read_meta(store.root, STOCK_ID)


def test_the_single_entry_read_writes_through_too(client_with_root, tmp_path):
    _seed_stock_suno(tmp_path)
    store = library_router_module.get_store()
    _analyze_as_stock_suno(store, tmp_path, STOCK_ID)

    assert _filtered(client_with_root, "suno")["total"] == 0
    body = client_with_root.get(f"/api/library/entries/{STOCK_ID}").json()

    assert body["provider"] == "suno"
    assert _read_meta(store.root, STOCK_ID)["provider"] == "suno"
    assert [e["id"] for e in _filtered(client_with_root, "suno")["entries"]] == [
        STOCK_ID
    ]


def test_recording_the_same_detection_twice_is_a_no_op(tmp_path):
    from backend.modules.library.provider import detect_provider

    root = tmp_path / "lib"
    root.mkdir(parents=True, exist_ok=True)
    _seed_stock_suno(root)
    store = LibraryStore(root)
    info = detect_provider(_stock_suno_embedded(tmp_path), None)
    assert info is not None
    assert store.db is not None

    assert store.record_detected_providers({STOCK_ID: info}) == 1
    path = root / STOCK_ID / "metadata.json"
    raw = path.read_bytes()
    row_json = store.db.get_entry(STOCK_ID)["metadata_json"]

    # Second time: the entry already carries an answer, so there is nothing
    # left to write -- which is what makes two simultaneous readers safe.
    assert store.record_detected_providers({STOCK_ID: info}) == 0
    assert path.read_bytes() == raw
    assert store.db.get_entry(STOCK_ID)["metadata_json"] == row_json
    # An id with no entry folder is skipped, never invented.
    assert store.record_detected_providers({"no_such_entry": info}) == 0
    assert store.db.get_entry("no_such_entry") is None


def test_two_concurrent_recorders_serialize_and_exactly_one_writes(tmp_path):
    """The metadata lock makes the two orderings the only two outcomes.

    Both threads ask to record the same detection for the same entry. The
    lock serializes the whole read-merge-write-mirror of one entry, so the
    second thread's never-overwrite check runs against what the first
    already stored: one writes, one finds nothing to do, neither raises, and
    the file is a complete document either way."""
    from backend.modules.library.provider import detect_provider

    root = tmp_path / "lib"
    root.mkdir(parents=True, exist_ok=True)
    _seed_stock_suno(root)
    store = LibraryStore(root)
    info = detect_provider(_stock_suno_embedded(tmp_path), None)
    assert info is not None
    assert store.db is not None

    start = threading.Barrier(2)
    errors: list[BaseException] = []
    written: list[int] = []

    def record() -> None:
        start.wait(timeout=10)
        try:
            written.append(store.record_detected_providers({STOCK_ID: info}))
        except BaseException as e:  # the assertion below is that there is none
            errors.append(e)

    threads = [threading.Thread(target=record) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=10)

    assert errors == []
    # Exactly one write happened: the loser saw the winner's stored answer.
    assert sorted(written) == [0, 1]
    meta = _read_meta(root, STOCK_ID)
    assert meta["provider"] == "suno"
    assert meta["provider_id"] == SUNO_ID
    stored = json.loads(store.db.get_entry(STOCK_ID)["metadata_json"])
    assert stored["provider"] == "suno"


def test_a_concurrent_user_edit_is_never_lost(tmp_path, monkeypatch):
    """The lost update the lock exists to stop.

    A user PATCH lands between the write-through's read and its write. Disk
    is the source of truth, so an overwrite here is unrecoverable --
    ``reindex()`` would copy the loss into the DB rather than repair it. The
    write-through is held at the instant after its read; without the lock the
    edit proceeds and is then overwritten by the stale copy, with it the edit
    cannot start until the write-through is done. Either way BOTH the user's
    fields and the provider keys must survive, on disk and in the column.
    """
    from backend.modules.library import store as store_module
    from backend.modules.library.provider import detect_provider

    root = tmp_path / "lib"
    root.mkdir(parents=True, exist_ok=True)
    _seed_stock_suno(root)
    store = LibraryStore(root)
    info = detect_provider(_stock_suno_embedded(tmp_path), None)
    assert info is not None
    assert store.db is not None

    read_done = threading.Event()
    edit_done = threading.Event()
    real_read = store_module._read_metadata

    def hooked_read(entry_dir):
        meta = real_read(entry_dir)
        if threading.current_thread().name == "write-through":
            # Read taken. Give the editor every chance to get in front of
            # the write that follows. Bounded, because when the lock works
            # the editor is blocked and this wait must still end.
            read_done.set()
            edit_done.wait(timeout=2.0)
        return meta

    monkeypatch.setattr(store_module, "_read_metadata", hooked_read)

    edit = {
        "rating": "like",
        "notes": "the user typed this",
        "tags": ["mine"],
        "lyrics": "the user pasted these words",
    }
    failures: list[BaseException] = []

    def write_through() -> None:
        try:
            store.record_detected_providers({STOCK_ID: info})
        except BaseException as e:
            failures.append(e)

    def user_edit() -> None:
        try:
            read_done.wait(timeout=5.0)
            store.update_entry(STOCK_ID, dict(edit))
        except BaseException as e:
            failures.append(e)
        finally:
            edit_done.set()

    threads = [
        threading.Thread(target=write_through, name="write-through"),
        threading.Thread(target=user_edit, name="editor"),
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=20)
    assert not any(t.is_alive() for t in threads)
    assert failures == []

    on_disk = _read_meta(root, STOCK_ID)
    in_column = json.loads(store.db.get_entry(STOCK_ID)["metadata_json"])
    for field, value in edit.items():
        assert on_disk[field] == value, f"{field} lost on disk"
        assert in_column[field] == value, f"{field} lost in metadata_json"
    assert on_disk["provider"] == "suno"
    assert in_column["provider"] == "suno"


# ---- Atomic metadata writes ------------------------------------------------


def _big_payload(marker: str) -> dict:
    """A document too large to land in one filesystem write, so an
    interleaved writer shows up as mixed bytes rather than a lucky atom."""
    return {
        "id": "shared_entry",
        "title": marker,
        "lyrics": marker * 6000,
        "notes": marker * 3000,
        "tags": [marker],
    }


def test_concurrent_metadata_writes_never_interleave(tmp_path):
    """Two writers of one entry used to share ``metadata.json.tmp``: their
    bytes mixed in that one file and the mixture was renamed over the real
    one. A reader must only ever see one whole document or the other."""
    from backend.modules.library import store as store_module

    entry_dir = tmp_path / "entry"
    entry_dir.mkdir(parents=True, exist_ok=True)
    payloads = [_big_payload("a"), _big_payload("b")]
    store_module._write_metadata(entry_dir, payloads[0])

    stop = threading.Event()
    problems: list[str] = []
    wrote: list[int] = []

    def writer(payload: dict) -> None:
        for _ in range(60):
            try:
                store_module._write_metadata(entry_dir, payload)
                wrote.append(1)
            except PermissionError:
                # Windows refuses a rename ONTO a file another thread has
                # open, which the reader below is doing continuously. That
                # is a sharing rule, not damage: the temp file is cleaned
                # up and the document on disk is left whole. Pre-existing
                # behaviour of this writer, and the read path swallows it.
                pass
            except BaseException as e:
                problems.append(f"write failed: {type(e).__name__}: {e}")
                return

    def reader() -> None:
        while not stop.is_set():
            try:
                seen = _read_meta(entry_dir.parent, "entry")
            except json.JSONDecodeError as e:
                problems.append(f"torn document: {e}")
                return
            except OSError:
                # Windows can refuse the open during the rename itself;
                # that is a sharing rule, not a damaged file.
                continue
            if seen not in payloads:
                problems.append(f"mixed document: title={seen.get('title')!r}")
                return

    threads = [threading.Thread(target=writer, args=(p,)) for p in payloads]
    watcher = threading.Thread(target=reader)
    watcher.start()
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)
    stop.set()
    watcher.join(timeout=30)

    assert problems == []
    # Not vacuous: writes really did land while the reader was watching.
    assert sum(wrote) > 0
    assert _read_meta(entry_dir.parent, "entry") in payloads
    # Every temp file is either renamed into place or removed.
    assert list(entry_dir.glob("*.tmp")) == []


def test_a_failed_metadata_write_leaves_no_orphan_temp_file(tmp_path, monkeypatch):
    from backend.modules.library import store as store_module

    entry_dir = tmp_path / "entry"
    entry_dir.mkdir(parents=True, exist_ok=True)
    store_module._write_metadata(entry_dir, {"id": "entry", "title": "before"})

    def boom(self, target):
        raise OSError("no rename for you")

    monkeypatch.setattr(Path, "replace", boom)

    with pytest.raises(OSError):
        store_module._write_metadata(entry_dir, {"id": "entry", "title": "after"})

    assert list(entry_dir.glob("*.tmp")) == []
    assert _read_meta(tmp_path, "entry")["title"] == "before"


# ---- What the write-through costs a client ---------------------------------


def test_the_write_through_does_not_move_the_library_revision(
    client_with_root, tmp_path
):
    """The revision means "your cached pages are stale". This write changes
    no column a list shows, no tag, no index and no ordering, and the very
    response that triggers it already carries the new label -- so firing it
    would only make a first scroll throw its cache away. A real edit still
    fires it."""
    _seed_stock_suno(tmp_path)
    store = library_router_module.get_store()
    assert store.db is not None
    _analyze_as_stock_suno(store, tmp_path, STOCK_ID)

    before = store.db.library_revision()
    body = client_with_root.get("/api/library/entries?limit=50").json()

    assert [e["provider"] for e in body["entries"]] == ["suno"]
    assert _read_meta(store.root, STOCK_ID)["provider"] == "suno"
    assert store.db.library_revision() == before
    assert body["revision"] == before

    store.update_entry(STOCK_ID, {"notes": "a real edit"})
    assert store.db.library_revision() > before


def test_a_damaged_metadata_file_is_skipped_once_and_never_rewritten(
    client_with_root, tmp_path, caplog
):
    _seed_stock_suno(tmp_path)
    store = library_router_module.get_store()
    assert store.db is not None
    _analyze_as_stock_suno(store, tmp_path, STOCK_ID)
    # Damaged AFTER the row exists: the list still returns it from the DB.
    path = store.root / STOCK_ID / "metadata.json"
    path.write_text('{"id": "entry_stock_suno", "tit', encoding="utf-8")
    raw = path.read_bytes()

    with caplog.at_level("WARNING"):
        bodies = [
            client_with_root.get("/api/library/entries?limit=50").json()
            for _ in range(3)
        ]

    for body in bodies:
        assert [e["id"] for e in body["entries"]] == [STOCK_ID]
        # The label is still derived for display; only the storing is skipped.
        assert body["entries"][0]["provider"] == "suno"
    # Never rewritten from a guess, and never re-read after the first failure.
    assert path.read_bytes() == raw
    failed_reads = [r for r in caplog.records if "failed to read" in r.getMessage()]
    assert len(failed_reads) == 1


def test_a_huge_label_and_evidence_are_bounded_the_same_way_everywhere(
    client_with_root, tmp_path
):
    """An unrecognised generator frame becomes the label verbatim and the
    evidence quotes it. A multi-kilobyte frame must not end up in every list
    response, nor forever in the metadata the provider filter scans."""
    from backend.modules.library.store import PROVIDER_TEXT_MAX

    _seed_entry(tmp_path, "entry_huge", {"source": "import", "model": "imported"})
    store = library_router_module.get_store()
    assert store.db is not None
    store.db.upsert_analysis(
        "entry_huge", {"embedded_tags": {"generator": "Obscure Tracker " * 400}}
    )

    body = client_with_root.get("/api/library/entries?limit=50").json()
    shown = body["entries"][0]["provider_label"]
    meta = _read_meta(store.root, "entry_huge")

    assert 0 < len(shown) <= PROVIDER_TEXT_MAX
    assert meta["provider_label"] == shown
    assert 0 < len(meta["provider_evidence"]) <= PROVIDER_TEXT_MAX
    # And the bound survives its own round trip: the label read back out of
    # storage is the same string that was stored and shown, not a re-clipped
    # or re-stripped near-miss.
    again = client_with_root.get("/api/library/entries/entry_huge").json()
    assert again["provider_label"] == shown
    assert _read_meta(store.root, "entry_huge")["provider_label"] == shown


def test_a_huge_slug_is_bounded_in_storage_and_on_the_wire(client_with_root, tmp_path):
    """The slug is an identifier, not prose: it is compared in SQL, filed
    under, sent as a query parameter and stored in an INDEXED column. A
    multi-kilobyte generator frame must not mint a multi-kilobyte
    identifier."""
    from backend.modules.library.provider import PROVIDER_SLUG_MAX
    from backend.modules.library.store import _bounded_slug

    # The boundary belt on its own: whatever reaches storage or the wire is
    # bounded there too, not only where `provider.py` mints a slug -- a
    # hand-edited metadata.json or a row from an older build goes through
    # this and no other check.
    assert _bounded_slug("obscure-tracker-" * 40) == _bounded_slug(
        _bounded_slug("obscure-tracker-" * 40)
    )
    assert len(_bounded_slug("obscure-tracker-" * 40)) <= PROVIDER_SLUG_MAX
    assert not _bounded_slug("obscure-tracker-" * 40).endswith("-")

    _seed_entry(tmp_path, "entry_slug", {"source": "import", "model": "imported"})
    store = library_router_module.get_store()
    assert store.db is not None
    store.db.upsert_analysis(
        "entry_slug", {"embedded_tags": {"generator": "Obscure Tracker " * 400}}
    )

    body = client_with_root.get("/api/library/entries?limit=50").json()
    slug = body["entries"][0]["provider"]
    meta = _read_meta(store.root, "entry_slug")

    assert 0 < len(slug) <= PROVIDER_SLUG_MAX
    assert meta["provider"] == slug
    # Still a slug after the cut: no dangling separator where it landed.
    assert not slug.startswith("-") and not slug.endswith("-")
    # Bounding an already-bounded slug changes nothing, so the same bound
    # applied at the source produces the same string, not a second cut.
    assert _bounded_slug(slug) == slug
    # And the filter files it under exactly the slug it is shown with.
    assert [e["id"] for e in _filtered(client_with_root, slug)["entries"]] == [
        "entry_slug"
    ]


def test_a_slug_that_bounds_away_to_nothing_labels_nothing(tmp_path):
    from backend.modules.library.provider import ProviderInfo
    from backend.modules.library.store import (
        bounded_provider_info,
        bounded_provider_wire_fields,
    )

    void = ProviderInfo(
        provider="---",
        label="Nothing",
        is_ai=False,
        provider_id=None,
        confidence="explicit",
        evidence="generator=---",
    )

    assert bounded_provider_info(void) is None
    assert bounded_provider_wire_fields(void) == {
        "provider": None,
        "provider_label": None,
        "provider_is_ai": None,
        "provider_id": None,
    }


# ---- A filtered page does not rewrite its own result set --------------------


def test_a_provider_filtered_read_neither_relabels_nor_writes(
    client_with_root, tmp_path, write_spy
):
    """Under an active provider filter the rows shown are the rows that
    filter matched, labeled as SQL filed them. Relabeling them would show
    rows the filter does not match, refile them out from under the user's
    cursor mid-scroll, make ``total`` disagree with the rows it was counted
    for, and skip entries at the next offset."""
    _seed_stock_suno(tmp_path)
    store = library_router_module.get_store()
    _analyze_as_stock_suno(store, tmp_path, STOCK_ID)

    filtered = _filtered(client_with_root, "import")

    assert [e["id"] for e in filtered["entries"]] == [STOCK_ID]
    assert filtered["entries"][0]["provider"] == "import"
    assert filtered["total"] == len(filtered["entries"]) == 1
    # Nothing was written, so the page a client caches stays the page the
    # filter would return for it.
    assert write_spy == []
    assert "provider" not in _read_meta(store.root, STOCK_ID)
    # The analysis itself is still attached; only the relabeling is skipped.
    assert filtered["entries"][0]["embedded_tags"]["generator"] == "suno"

    # An unfiltered read is what labels the library, and then the filters
    # agree with the label.
    client_with_root.get("/api/library/entries?limit=50")
    assert _read_meta(store.root, STOCK_ID)["provider"] == "suno"
    assert _filtered(client_with_root, "import")["entries"] == []
    assert [e["id"] for e in _filtered(client_with_root, "suno")["entries"]] == [
        STOCK_ID
    ]


# ---- Self-repair when only the mirror failed --------------------------------


def test_a_failed_mirror_is_repaired_by_the_next_read(
    client_with_root, tmp_path, monkeypatch, write_spy
):
    """The half-written row, and why it cannot be left alone.

    The file write lands and the DB mirror fails: disk says "labeled", the
    column does not, and the never-overwrite rule would make that permanent
    -- no later read could repair the column, and the row would answer to no
    provider filter for good. The next read mirrors the DISK dict instead.
    """
    _seed_stock_suno(tmp_path)
    store = library_router_module.get_store()
    assert store.db is not None
    _analyze_as_stock_suno(store, tmp_path, STOCK_ID)

    real_mirror = type(store.db).set_entry_metadata
    calls: list[int] = []

    def flaky(self, metadata_by_id):
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("database is locked")
        return real_mirror(self, metadata_by_id)

    monkeypatch.setattr(type(store.db), "set_entry_metadata", flaky)

    first = client_with_root.get("/api/library/entries?limit=50").json()
    # Disk was labeled; the column was not, so the filter is still wrong.
    assert first["entries"][0]["provider"] == "suno"
    assert _read_meta(store.root, STOCK_ID)["provider"] == "suno"
    assert (
        json.loads(store.db.get_entry(STOCK_ID)["metadata_json"]).get("provider")
        is None
    )
    assert _filtered(client_with_root, "suno")["total"] == 0

    second = client_with_root.get("/api/library/entries?limit=50").json()

    # Repaired from disk, which is the source of truth -- not re-merged.
    assert second["entries"][0]["provider"] == "suno"
    assert json.loads(store.db.get_entry(STOCK_ID)["metadata_json"])["provider"] == (
        "suno"
    )
    assert [e["id"] for e in _filtered(client_with_root, "suno")["entries"]] == [
        STOCK_ID
    ]

    # And now it is settled: the third read asks the store for nothing.
    before = len(write_spy)
    third = client_with_root.get("/api/library/entries?limit=50").json()
    assert third["entries"][0]["provider"] == "suno"
    assert len(write_spy) == before


def test_a_different_stored_slug_is_never_touched_by_the_repair(tmp_path, monkeypatch):
    """Somebody else's answer wins and costs nothing to keep winning."""
    from backend.modules.library import store as store_module
    from backend.modules.library.provider import detect_provider

    root = tmp_path / "lib"
    root.mkdir(parents=True, exist_ok=True)
    _seed_entry(
        root,
        "entry_theirs",
        {
            "source": "import",
            "model": "imported",
            "provider": "bandcamp",
            "provider_label": "Bandcamp",
            "provider_is_ai": False,
        },
    )
    store = LibraryStore(root)
    info = detect_provider(_stock_suno_embedded(tmp_path), None)
    assert info is not None
    assert store.db is not None
    before = (root / "entry_theirs" / "metadata.json").read_bytes()

    assert store.record_detected_providers({"entry_theirs": info}) == 0
    assert (root / "entry_theirs" / "metadata.json").read_bytes() == before
    assert (
        json.loads(store.db.get_entry("entry_theirs")["metadata_json"])["provider"]
        == "bandcamp"
    )

    # Settled: a second call does not open the file at all.
    reads: list[str] = []
    real_checked = store_module._read_metadata_checked
    monkeypatch.setattr(
        store_module,
        "_read_metadata_checked",
        lambda d: (reads.append(str(d)), real_checked(d))[1],
    )

    assert store.record_detected_providers({"entry_theirs": info}) == 0
    assert reads == []


# ---- Transient vs durable failures -----------------------------------------


def test_a_transient_read_error_is_not_memoized(tmp_path, monkeypatch):
    """An OSError is a sharing violation, an antivirus pass, a drive
    blinking -- it says nothing durable about the entry, so blacklisting it
    for the life of the process would take a healthy track out of service."""
    from backend.modules.library.provider import detect_provider

    root = tmp_path / "lib"
    root.mkdir(parents=True, exist_ok=True)
    _seed_stock_suno(root)
    store = LibraryStore(root)
    info = detect_provider(_stock_suno_embedded(tmp_path), None)
    assert info is not None

    real_read_text = Path.read_text
    fail_once = {"left": 1}

    def flaky_read_text(self, *args, **kwargs):
        if self.name == "metadata.json" and fail_once["left"]:
            fail_once["left"] -= 1
            raise OSError("temporarily unavailable")
        return real_read_text(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", flaky_read_text)

    assert store.record_detected_providers({STOCK_ID: info}) == 0
    assert store._unparsable_meta == {}
    assert store._provider_settled == set()
    # The very next call succeeds: nothing was remembered.
    assert store.record_detected_providers({STOCK_ID: info}) == 1
    assert _read_meta(root, STOCK_ID)["provider"] == "suno"


def test_a_repaired_metadata_file_is_read_again(tmp_path):
    """The damaged-file memo is keyed on the bytes it gave up on, so fixing
    the file is enough -- no restart."""
    from backend.modules.library.provider import detect_provider

    root = tmp_path / "lib"
    root.mkdir(parents=True, exist_ok=True)
    _seed_stock_suno(root)
    store = LibraryStore(root)
    info = detect_provider(_stock_suno_embedded(tmp_path), None)
    assert info is not None
    good = (root / STOCK_ID / "metadata.json").read_bytes()

    (root / STOCK_ID / "metadata.json").write_text('{"id": "trunc', encoding="utf-8")
    assert store.record_detected_providers({STOCK_ID: info}) == 0
    assert STOCK_ID in store._unparsable_meta

    (root / STOCK_ID / "metadata.json").write_bytes(good)
    assert store.record_detected_providers({STOCK_ID: info}) == 1
    assert _read_meta(root, STOCK_ID)["provider"] == "suno"


def test_a_read_only_library_is_not_re_attempted_every_request(tmp_path, monkeypatch):
    """A full volume or a read-only library fails every row of every page.
    Each entry is retried on a timer, not on every request."""
    from backend.modules.library import store as store_module
    from backend.modules.library.provider import detect_provider

    root = tmp_path / "lib"
    root.mkdir(parents=True, exist_ok=True)
    _seed_stock_suno(root)
    store = LibraryStore(root)
    info = detect_provider(_stock_suno_embedded(tmp_path), None)
    assert info is not None

    attempts: list[int] = []
    real_write = store_module._write_metadata

    def refuse(entry_dir, payload):
        attempts.append(1)
        raise OSError("read-only file system")

    monkeypatch.setattr(store_module, "_write_metadata", refuse)

    for _ in range(5):
        assert store.record_detected_providers({STOCK_ID: info}) == 0
    assert len(attempts) == 1

    # Once the retry window has passed, the entry is tried again -- and when
    # the volume is writable again it simply works.
    store._provider_write_failed[STOCK_ID] = (
        time.monotonic() - store_module.PROVIDER_WRITE_RETRY_SECONDS - 1
    )
    monkeypatch.setattr(store_module, "_write_metadata", real_write)
    assert store.record_detected_providers({STOCK_ID: info}) == 1
    assert _read_meta(root, STOCK_ID)["provider"] == "suno"


def test_a_detection_with_no_provider_id_keeps_the_one_the_entry_has(tmp_path):
    """The merge must not erase a field by writing None over it."""
    from backend.modules.library.provider import detect_provider

    root = tmp_path / "lib"
    root.mkdir(parents=True, exist_ok=True)
    _seed_entry(
        root,
        "entry_keeps_id",
        {"source": "import", "model": "imported", "provider_id": "kept-0001"},
    )
    store = LibraryStore(root)
    # A generator frame with no id frame beside it: provider_id is None.
    info = detect_provider({"generator": "udio"}, None)
    assert info is not None and info.provider_id is None

    assert store.record_detected_providers({"entry_keeps_id": info}) == 1
    meta = _read_meta(root, "entry_keeps_id")
    assert meta["provider"] == "udio"
    assert meta["provider_id"] == "kept-0001"


# ---- metadata.json that carries no `source` -------------------------------


def _seed_entry_without(root: Path, entry_id: str, meta: dict, *drop: str) -> Path:
    """``_seed_entry`` with some keys removed from the written metadata.

    ``backend/server.py`` writes a native generation's ``metadata.json``
    without a ``source`` key at all, so the read path has to supply the same
    default the record does rather than derive a provider from "".
    """
    entry_dir = _seed_entry(root, entry_id, meta)
    payload = json.loads((entry_dir / "metadata.json").read_text(encoding="utf-8"))
    for key in drop:
        payload.pop(key, None)
    (entry_dir / "metadata.json").write_text(json.dumps(payload), encoding="utf-8")
    return entry_dir


def test_a_generation_whose_metadata_omits_source_is_still_stable_audio(
    tmp_path: Path,
):
    """The record defaults a missing ``source`` to 'generate', so the provider
    derived beside it must read the same default: the wire label, the SQL
    filter and the ``provider`` facet all have to say stable-audio for the
    same entry."""
    root = tmp_path / "lib"
    root.mkdir(parents=True, exist_ok=True)
    _seed_entry_without(root, "no_source_generate", {"model": "medium"}, "source")
    store = LibraryStore(root)

    record = store.get_entry("no_source_generate")
    assert record is not None
    assert record.source == "generate"
    assert record.provider == "stable-audio"
    assert record.provider_label == "Stable Audio"
    assert record.provider_is_ai is True
    assert _ids(store, provider="stable-audio") == {"no_source_generate"}
    assert _ids(store, provider="thedaw") == set()


def test_a_media_entry_whose_metadata_omits_source_is_still_an_import(
    tmp_path: Path,
):
    """The media record defaults a missing ``source`` to 'import'; the
    provider derived beside it reads the same default."""
    root = tmp_path / "lib"
    root.mkdir(parents=True, exist_ok=True)
    entry_dir = _seed_entry_without(
        root,
        "no_source_media",
        {"kind": "image", "filename": "still.png", "model": ""},
        "source",
    )
    (entry_dir / "still.png").write_bytes(b"")
    store = LibraryStore(root)

    record = store.get_entry("no_source_media")
    assert record is not None
    assert record.source == "import"
    assert record.provider == "import"
    assert record.provider_label == "Imported"
    assert record.provider_is_ai is False
    assert _ids(store, provider="import") == {"no_source_media"}
    assert _ids(store, provider="thedaw") == set()


def test_the_source_default_never_reaches_the_step_that_fills_the_column(
    tmp_path: Path, monkeypatch
):
    """The default is the FALLBACK's, not the detection's.

    Step 1 of the wire derivation and the ``provider`` column are the same
    function over the same dict -- ``resolved_provider_slug`` computes the
    column from the metadata exactly as stored. Handing step 1 a dict with a
    ``source`` the file does not carry would give the wire a rule SQL cannot
    have: today ``provider.detect_provider`` already reads ``meta["source"]``
    (the legacy ``source='suno'`` marker), so this is not hypothetical. The
    defaults go to step 2, whose twin reads the very columns they came from.
    """
    from backend.modules.library import store as library_store_module
    from backend.modules.library.db import resolved_provider_slug

    root = tmp_path / "lib"
    root.mkdir(parents=True, exist_ok=True)
    _seed_entry_without(root, "no_source_probe", {"model": "medium"}, "source")

    seen: list[dict] = []
    real = library_store_module.detect_provider

    def spy(embedded, meta=None):
        seen.append(dict(meta or {}))
        return real(embedded, meta)

    monkeypatch.setattr(library_store_module, "detect_provider", spy)
    store = LibraryStore(root)
    record = store.get_entry("no_source_probe")
    assert record is not None
    assert record.source == "generate"
    assert record.provider == "stable-audio"

    # Step 1 saw the dict on disk, unchanged -- no injected 'source'.
    on_disk = _read_meta(root, "no_source_probe")
    assert "source" not in on_disk
    assert seen and all("source" not in meta for meta in seen)
    assert seen[0] == on_disk

    # And the two halves still agree: the metadata names no provider, so the
    # column is NULL and the fallback answers for the row -- which is the same
    # answer the wire just gave it.
    assert resolved_provider_slug(on_disk) is None
    assert store.db is not None
    row = store.db.get_entry("no_source_probe")
    assert row is not None
    assert row["provider"] is None
    assert _ids(store, provider="stable-audio") == {"no_source_probe"}


def test_a_stored_source_of_suno_answers_suno_on_the_wire_and_in_the_column():
    """The one rule today that reads ``meta["source"]``, on both sides.

    ``provider._legacy_suno`` treats a stored ``source`` of "suno" as evidence,
    so a dict that CARRIES one has to get the same answer from the wire
    derivation and from the function that fills the ``provider`` column --
    which is what handing both the same unmodified dict buys.
    """
    from backend.modules.library.db import resolved_provider_slug
    from backend.modules.library.store import _provider_wire

    meta = {"id": "legacy_suno_dict", "model": "medium", "source": "suno"}
    wire = _provider_wire(meta, source="generate", model="medium")

    assert wire["provider"] == "suno"
    assert wire["provider_is_ai"] is True
    assert resolved_provider_slug(meta) == "suno"
    # And the dict is still the caller's: nothing was injected into it.
    assert meta == {"id": "legacy_suno_dict", "model": "medium", "source": "suno"}


def test_the_sql_else_arm_answers_thedaw_for_a_blank_source(tmp_path: Path):
    """Every writer here spells a falsy ``source`` as 'generate', so the two
    ``FALLBACK_PARITY_ROWS`` with no source are skipped above. The column can
    still hold '' -- a hand-edited row, a future writer -- and the ELSE arm is
    what answers for it, so the row is inserted directly to prove it.

    ``source`` is ``NOT NULL``, so a NULL row cannot exist in the table; the
    NULL half of the same arm is asserted on the shared expression itself, a
    line below.
    """
    from backend.modules.library.db import LibraryDB, PROVIDER_FALLBACK_SQL

    db = LibraryDB(tmp_path / "library.db", enable_fts=False)
    db._conn.execute(
        "INSERT INTO entries (id, kind, title, model, source, provider, "
        "created_at, updated_at, metadata_json) "
        "VALUES ('blank_source', 'audio', 'blank_source', 'anything', '', "
        "NULL, 1.0, 1.0, '{}')"
    )
    db._conn.commit()

    assert set(db.list_entry_ids(EntryFilters(provider="thedaw"), 10)) == {
        "blank_source"
    }
    assert set(db.list_entry_ids(EntryFilters(provider="stable-audio"), 10)) == set()
    assert db.facet_counts(EntryFilters(), ["provider"])["provider"] == [
        {"value": "thedaw", "count": 1}
    ]

    # The same arm over a NULL source and a NULL model, on the same expression
    # text the indexes and the filter are built from.
    null_row = db._conn.execute(
        f"SELECT {PROVIDER_FALLBACK_SQL} AS provider FROM "
        "(SELECT NULL AS source, NULL AS model) e"
    ).fetchone()
    assert null_row["provider"] == "thedaw"
    db.close()
