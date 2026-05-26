"""Unit tests for backend.modules.library.tags."""

from __future__ import annotations

from pathlib import Path

from backend.modules.library.tags import (
    KNOWN_AI_TAGS,
    _stringify,
    extract_embedded_tags,
)


def test_extract_returns_empty_for_missing_file(tmp_path: Path):
    out = extract_embedded_tags(tmp_path / "does-not-exist.mp3")
    assert out == {}


def test_extract_returns_empty_for_garbage_bytes(tmp_path: Path):
    p = tmp_path / "garbage.mp3"
    p.write_bytes(b"this is not an mp3 file")
    out = extract_embedded_tags(p)
    # Must not raise; returns empty dict.
    assert isinstance(out, dict)


def test_stringify_handles_lists():
    assert _stringify(["a", "b", "c"]) == "a, b, c"
    assert _stringify([]) == ""
    assert _stringify(None) == ""
    assert _stringify(b"hello") == "hello"
    assert _stringify("plain") == "plain"


def test_known_ai_tags_routes_aliases():
    # Sanity-check the alias map: every value should be one of the
    # canonical names we surface at the top level.
    canonical = {
        "prompt",
        "negative_prompt",
        "model",
        "seed",
        "cfg",
        "steps",
        "generator",
        "lyrics",
    }
    for key, target in KNOWN_AI_TAGS.items():
        assert target in canonical, f"{key} -> {target} not in canonical set"


def test_round_trip_through_id3_mp3(tmp_path: Path):
    """Build an ID3-tagged file and verify extract picks up
    TXXX:prompt as the canonical 'prompt' field."""
    from mutagen.id3 import ID3, TIT2, TXXX

    p = tmp_path / "fixture.mp3"
    # mutagen's ID3 writer works on any path with an ID3 header at
    # offset 0 OR an empty file (it will create the header). We use
    # an empty file to keep the fixture simple — we're testing tag
    # parsing, not MPEG sync.
    p.write_bytes(b"")
    tags = ID3()
    tags.add(TIT2(encoding=3, text=["FixtureTitle"]))
    tags.add(TXXX(encoding=3, desc="prompt", text=["forest at dawn"]))
    tags.add(TXXX(encoding=3, desc="model", text=["udio-v2"]))
    tags.add(TXXX(encoding=3, desc="seed", text=["12345"]))
    tags.save(str(p))

    out = extract_embedded_tags(p)
    # The TXXX:prompt should surface as canonical 'prompt'.
    assert out.get("prompt") == "forest at dawn"
    assert out.get("model") == "udio-v2"
    assert out.get("seed") == "12345"
    assert out.get("title") == "FixtureTitle"
    # The raw txxx_* fields are also retained for debugging.
    assert out.get("txxx_prompt") == "forest at dawn"


def test_import_blob_picks_up_embedded_prompt(tmp_path: Path):
    """End-to-end: a file with embedded prompt → LibraryStore.import_blob
    surfaces that prompt on the resulting record without the caller
    supplying it."""
    from mutagen.id3 import ID3, TXXX

    from backend.modules.library.store import LibraryStore

    src = tmp_path / "scratch.mp3"
    src.write_bytes(b"")
    tags = ID3()
    tags.add(TXXX(encoding=3, desc="prompt", text=["solar wind chorale"]))
    tags.save(str(src))

    audio_bytes = src.read_bytes()
    store_root = tmp_path / "lib"
    store = LibraryStore(store_root)
    record = store.import_blob(
        audio_bytes=audio_bytes,
        filename="scratch.mp3",
        mime_type="audio/mpeg",
        metadata={"title": "From upload"},
    )
    assert record.title == "From upload"  # explicit metadata wins
    # Caller didn't supply a prompt; embedded TXXX:prompt fills it in.
    assert record.prompt == "solar wind chorale"
