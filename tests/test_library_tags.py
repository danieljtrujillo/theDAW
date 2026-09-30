"""Unit tests for backend.modules.library.tags."""

from __future__ import annotations

from pathlib import Path

from backend.modules.library.tags import (
    KNOWN_AI_TAGS,
    _detect_generator,
    _id3_link_payload,
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
    # Sanity-check the alias map: every value should map to one of the
    # canonical field names we surface at the top level. New canonical
    # names land here when the metadata extractor adds new aliases per
    # docs/guides/AUDIO_VS_NONAUDIO_FIELD_GUIDE.md.
    canonical = {
        # Prompt + lyrics
        "prompt",
        "negative_prompt",
        "lyrics",
        "style_prompt",
        "style",
        "tags",
        "control_tags",
        # Model / generator identity
        "model",
        "model_version",
        "generator",
        "artist",
        "creator",
        "creator_id",
        "creator_handle",
        # Generation knobs
        "seed",
        "cfg",
        "steps",
        "audio_weight",
        "style_weight",
        "weirdness",
        "make_instrumental",
        "is_instrumental",
        "infill",
        "has_vocal",
        "has_stem",
        "persona_id",
        # Musical features
        "bpm",
        "bpm_min",
        "bpm_max",
        "key",
        "scale",
        "genre",
        "genres",
        "mood",
        "moods",
        "energy",
        "vocal_type",
        "instruments",
        # Identity / lineage
        "source_id",
        "parent_id",
        "root_id",
        "title",
        # Engagement
        "play_count",
        "upvote_count",
        "skip_rate",
        "engagement_score",
        "popularity_class",
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


def _write_id3(path: Path, *frames) -> Path:
    """An empty file carrying only the given ID3 frames.

    Same fixture shape as ``test_round_trip_through_id3_mp3`` above: mutagen
    writes an ID3 header onto an empty file, which is all the tag reader
    needs — these tests are about frame parsing, not MPEG sync.
    """
    from mutagen.id3 import ID3

    path.write_bytes(b"")
    tags = ID3()
    for frame in frames:
        tags.add(frame)
    tags.save(str(path))
    return path


def test_id3_url_and_encoder_frames_are_extracted(tmp_path: Path):
    """WXXX / W-frames / TSSE / TENC / TPUB / TCOP reach the flat dict."""
    from mutagen.id3 import TCOP, TENC, TPUB, TSSE, WOAF, WOAR, WOAS, WXXX

    p = _write_id3(
        tmp_path / "links.mp3",
        WXXX(encoding=3, desc="Purchase", url="https://shop.example.test/x"),
        WOAS(url="https://label.example.test/track/9"),
        WOAR(url="https://label.example.test/artist/a"),
        WOAF(url="https://files.example.test/a.mp3"),
        TSSE(encoding=3, text=["Lavf58.29.100"]),
        TENC(encoding=3, text=["neutral-encoder"]),
        TPUB(encoding=3, text=["Neutral Publisher"]),
        TCOP(encoding=3, text=["2026 Neutral"]),
    )

    out = extract_embedded_tags(p)
    # A user-defined URL is keyed by its description, the way TXXX is.
    assert out.get("wxxx_purchase") == "https://shop.example.test/x"
    assert out.get("source_url") == "https://label.example.test/track/9"
    assert out.get("artist_url") == "https://label.example.test/artist/a"
    assert out.get("file_url") == "https://files.example.test/a.mp3"
    assert out.get("encoder") == "Lavf58.29.100"
    assert out.get("encoded_by") == "neutral-encoder"
    assert out.get("publisher") == "Neutral Publisher"
    assert out.get("copyright") == "2026 Neutral"
    # Values stay strings; nothing here is promoted to a container.
    assert all(isinstance(v, str) for v in out.values())


def test_id3_repeated_url_frames_are_comma_joined(tmp_path: Path):
    """WOAR may appear once per artist; both land under one key."""
    from mutagen.id3 import WOAR

    p = _write_id3(
        tmp_path / "two-artists.mp3",
        WOAR(url="https://one.example.test/a"),
        WOAR(url="https://two.example.test/b"),
    )

    out = extract_embedded_tags(p)
    joined = out.get("artist_url", "")
    assert "https://one.example.test/a" in joined
    assert "https://two.example.test/b" in joined
    assert ", " in joined


def test_id3_empty_url_frame_is_skipped(tmp_path: Path):
    """An empty URL contributes no key, and does not cost the good ones."""
    from mutagen.id3 import WOAF, WOAS

    p = _write_id3(
        tmp_path / "half-empty.mp3",
        WOAF(url=""),
        WOAS(url="https://label.example.test/track/9"),
    )

    out = extract_embedded_tags(p)
    assert "file_url" not in out
    assert out.get("source_url") == "https://label.example.test/track/9"


def test_id3_link_payload_survives_a_malformed_frame():
    """A frame that does not hold what its id claims is skipped silently."""
    from mutagen.id3 import WOAS

    class _Exploding:
        @property
        def url(self):
            raise ValueError("frame data is junk")

    class _FakeTags:
        def items(self):
            return [
                ("WOAR", _Exploding()),
                ("WXXX:broken", object()),  # no .desc, no .url
                ("WOAS", WOAS(url="https://label.example.test/track/9")),
            ]

    out = _id3_link_payload(_FakeTags())
    assert out == {"source_url": "https://label.example.test/track/9"}


def test_id3_link_payload_survives_unreadable_tags():
    """An ID3 object that cannot even be iterated returns an empty dict."""

    class _Hostile:
        def items(self):
            raise OSError("tag truncated")

    assert _id3_link_payload(_Hostile()) == {}


def test_woas_url_alone_identifies_the_provider(tmp_path: Path):
    """End-to-end: a source URL is the file's ONLY origin signal.

    Nothing else in this file says where it came from — no generator, no
    album, no comment — so provider detection can only succeed if the ID3
    reader surfaced ``WOAS`` under a key the detector recognises as a URL.
    """
    from mutagen.id3 import WOAS

    from backend.modules.library import provider

    p = _write_id3(
        tmp_path / "store-download.mp3",
        WOAS(url="https://bandcamp.com/track/xyz"),
    )

    embedded = extract_embedded_tags(p)
    assert set(embedded) == {"source_url"}

    info = provider.detect_provider(embedded)
    assert info is not None
    assert info.provider == "bandcamp"
    assert info.is_ai is False
    assert info.confidence == "inferred"
    assert "bandcamp.com" in info.evidence


def test_woas_url_alone_identifies_an_ai_provider(tmp_path: Path):
    """The same path for a generation service: a Suno link, nothing else."""
    from mutagen.id3 import WOAS

    from backend.modules.library import provider

    p = _write_id3(
        tmp_path / "ai-track.mp3",
        WOAS(url="https://suno.com/song/0000-neutral"),
    )

    embedded = extract_embedded_tags(p)
    assert embedded.get("source_url") == "https://suno.com/song/0000-neutral"

    info = provider.detect_provider(embedded)
    assert info is not None
    assert info.provider == "suno"
    assert info.is_ai is True


def test_a_thedaw_encoder_signature_is_thedaw_not_stable_audio():
    """The generator signature has to agree with the provider rule: "theDAW"
    means made in theDAW, origin unspecified (``thedaw``), not the Stable
    Audio generator.

    The explicit ``stable-audio`` spellings are asserted by
    ``test_a_stable_audio_signature_is_not_read_as_udio`` below, which pins the
    "udio"-inside-"audio" rule that used to shadow them.
    """
    assert _detect_generator({"encoder": "theDAW 1.0"}) == "thedaw"
    assert _detect_generator({"encoder": "suno v4"}) == "suno"


def test_a_chirp_generator_signature_is_suno():
    """``chirp`` is Suno's model family, and a frame that names the model
    instead of the service is the only thing some files say.

    ``db.infer_provider`` and its SQL twin read a ``chirp-*`` model as Suno
    (schema step 11); a file whose generator frame says the same word has to
    resolve to the same service here, or one file is Suno by its columns and
    something else by its tags.
    """
    assert _detect_generator({"encoder": "chirp-v4"}) == "suno"
    assert _detect_generator({"generator": "chirp-crow"}) == "suno"
    assert _detect_generator({"encoder": "Chirp v3.5"}) == "suno"


def test_a_stable_audio_signature_is_not_read_as_udio():
    """ "udio" is a substring of "audio", so a bare substring test files every
    encoder string containing "audio" under the Udio generator.

    The rule here is the one ``_PROVIDER_BY_MODEL_SUBSTRING`` in ``db.py``
    already spells for the ``model`` column (and ``inferProvider`` in
    ``frontend/src/catalog/catalogProviders.ts`` for the catalogue): delete the
    word "audio" from the text before looking for "udio". That keeps every real
    Udio spelling matching -- including a blend whose name carries both words --
    while a Stable Audio encoder frame lands on its own signature instead.
    """
    # Not Udio: the word "audio" is what matched, not the service.
    assert _detect_generator({"encoder": "stable-audio"}) == "stable-audio"
    assert _detect_generator({"encoder": "Stable Audio 3"}) == "stable-audio"
    assert _detect_generator({"encoder": "stable_audio 3 medium"}) == "stable-audio"
    assert _detect_generator({"encoder": "theDAW 1.0"}) == "thedaw"
    # No signature at all rather than a wrong one: "stableaudio" is a spelling
    # nothing in the table declares, and it must not fall through to Udio.
    assert _detect_generator({"encoder": "stableaudio"}) != "udio"
    # A tag KEY naming the model reached the same shadowing through the
    # key-only heuristic, which uses the same rule now.
    assert _detect_generator({"stable_audio_version": "3"}) != "udio"

    # Still Udio: every observed spelling, and a name carrying both words.
    assert _detect_generator({"encoder": "udio"}) == "udio"
    assert _detect_generator({"encoder": "Udio v1.5"}) == "udio"
    assert _detect_generator({"comment": "made with udio"}) == "udio"
    assert _detect_generator({"encoder": "audio-udio-blend"}) == "udio"
    assert _detect_generator({"udio_song_id": "abc"}) == "udio"
