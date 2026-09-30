"""Unit tests for backend.modules.library.provider.

Every fixture here is a synthetic tag dict: invented ids, invented handles,
no real user media and no real file is ever opened. The module under test
is pure, so that is the whole surface.
"""

from __future__ import annotations

import pytest

from backend.modules.library.provider import (
    FALLBACK_PROVIDER,
    ORIGIN_TOOL_FRAME,
    PROVIDER_RULES,
    PROVIDER_SLUG_MAX,
    URL_KEY_PRIORITY,
    ProviderInfo,
    curated_fields,
    detect_provider,
    detection_outranks,
    is_analytics_key,
    provider_wire_fields,
)

SAMPLE_ID = "11111111-2222-4333-8444-555555555555"
PARENT_ID = "99999999-8888-4777-8666-555555555444"
ZERO_UUID = "00000000-0000-0000-0000-000000000000"


# --- explicit Suno signals, each one alone ----------------------------------


def test_suno_detected_from_generator_alone():
    info = detect_provider({"generator": "suno"})
    assert info is not None
    assert info.provider == "suno"
    assert info.label == "Suno"
    assert info.is_ai is True
    assert info.confidence == "explicit"
    assert info.evidence == "generator=suno"
    assert info.provider_id is None


def test_suno_detected_from_a_chirp_model_frame():
    """The generator frame names the MODEL, not the service.

    ``chirp-v4``, ``chirp-crow``, ``chirp-bluejay`` are Suno's model family and
    the only thing an exported Suno song's model string ever says.
    ``db.infer_provider`` reads it as Suno (schema step 11), so this side must
    too: a rule that disagrees with the derivation files one file twice.
    """
    info = detect_provider({"generator": "chirp-v4"})
    assert info is not None
    assert info.provider == "suno"
    assert info.label == "Suno"
    assert info.is_ai is True
    assert info.confidence == "explicit"
    assert detect_provider({"encoder": "chirp-crow"}).provider == "suno"


def test_suno_detected_from_id_frame_alone():
    info = detect_provider({"txxx_suno_id": SAMPLE_ID})
    assert info is not None
    assert info.provider == "suno"
    assert info.provider_id == SAMPLE_ID
    assert info.confidence == "explicit"
    assert "txxx_suno_id" in info.evidence


def test_suno_inferred_from_album_alone():
    info = detect_provider({"album": "Suno AI"})
    assert info is not None
    assert info.provider == "suno"
    assert info.confidence == "inferred"
    assert info.evidence == "album=Suno AI"


def test_suno_id_is_carried_when_generator_decides():
    info = detect_provider({"generator": "suno", "txxx_suno_id": SAMPLE_ID})
    assert info is not None
    assert info.provider_id == SAMPLE_ID


# --- legacy entries labeled before this feature -----------------------------


def test_legacy_meta_source_suno():
    info = detect_provider({}, {"source": "suno"})
    assert info is not None
    assert info.provider == "suno"
    assert info.confidence == "explicit"
    assert info.evidence == "meta.source=suno"


def test_legacy_meta_suno_id_field():
    info = detect_provider({}, {"source": "import", "suno_id": SAMPLE_ID})
    assert info is not None
    assert info.provider == "suno"
    assert info.provider_id == SAMPLE_ID
    assert info.confidence == "explicit"


def test_legacy_meta_sunoid_tag():
    info = detect_provider({}, {"tags": ["mixtape", f"sunoid:{SAMPLE_ID}"]})
    assert info is not None
    assert info.provider == "suno"
    assert info.provider_id == SAMPLE_ID


def test_legacy_meta_bare_suno_tag():
    info = detect_provider({}, {"tags": "suno, drums"})
    assert info is not None
    assert info.provider == "suno"
    assert info.provider_id is None


def test_legacy_zero_uuid_is_not_a_provider_id():
    info = detect_provider({}, {"source": "suno", "suno_id": ZERO_UUID})
    assert info is not None
    assert info.provider == "suno"
    assert info.provider_id is None


# --- stored provider wins ---------------------------------------------------


def test_meta_provider_wins_over_embedded_tags():
    info = detect_provider(
        {"generator": "suno", "txxx_suno_id": SAMPLE_ID},
        {
            "provider": "bandcamp",
            "provider_label": "Bandcamp",
            "provider_is_ai": False,
            "provider_id": "cassette-42",
        },
    )
    assert info is not None
    assert info.provider == "bandcamp"
    assert info.label == "Bandcamp"
    assert info.is_ai is False
    assert info.provider_id == "cassette-42"
    assert info.evidence == "meta.provider"


def test_meta_provider_without_label_uses_the_table():
    info = detect_provider({}, {"provider": "udio"})
    assert info is not None
    assert info.provider == "udio"
    assert info.label == "Udio"
    assert info.is_ai is True


def test_meta_provider_wins_over_legacy_suno_markers():
    info = detect_provider({}, {"provider": "soundcloud", "source": "suno"})
    assert info is not None
    assert info.provider == "soundcloud"
    assert info.is_ai is False


# --- domain inference -------------------------------------------------------


def test_domain_inferred_from_comment_url():
    info = detect_provider(
        {"comment": "bought at https://someartist.bandcamp.com/track/a-song"}
    )
    assert info is not None
    assert info.provider == "bandcamp"
    assert info.is_ai is False
    assert info.confidence == "inferred"
    assert info.evidence.startswith("comment=")


def test_domain_inferred_from_url_frame():
    info = detect_provider({"website": "https://www.udio.com/songs/abc123"})
    assert info is not None
    assert info.provider == "udio"
    assert info.is_ai is True
    assert info.confidence == "inferred"


def test_short_youtube_domain_matches():
    info = detect_provider({"url": "https://youtu.be/abcdefghijk"})
    assert info is not None
    assert info.provider == "youtube"


def test_source_url_outranks_a_commerce_url():
    # WPAY points at a store that merely took the money; WOAS points at
    # where the track actually lives.
    info = detect_provider(
        {
            "payment_url": "https://someshop.bandcamp.com/album/a-record",
            "publisher_url": "https://alabel.bandcamp.com",
            "source_url": "https://soundcloud.com/neutral-handle/a-track",
        }
    )
    assert info is not None
    assert info.provider == "soundcloud"
    assert info.confidence == "inferred"
    assert info.evidence.startswith("source_url=")


def test_file_url_outranks_the_comment_and_artist_url():
    info = detect_provider(
        {
            "comment": "grab it at https://someshop.bandcamp.com/track/x",
            "artist_url": "https://open.spotify.com/artist/neutral",
            "file_url": "https://www.udio.com/songs/neutral",
        }
    )
    assert info is not None
    assert info.provider == "udio"
    assert info.evidence.startswith("file_url=")


def test_wxxx_frame_outranks_the_artist_url():
    info = detect_provider(
        {
            "artist_url": "https://open.spotify.com/artist/neutral",
            "wxxx_download": "https://someshop.bandcamp.com/track/x",
        }
    )
    assert info is not None
    assert info.provider == "bandcamp"
    assert info.evidence.startswith("wxxx_download=")


def test_commerce_url_alone_still_resolves():
    info = detect_provider({"payment_url": "https://someshop.bandcamp.com/album/x"})
    assert info is not None
    assert info.provider == "bandcamp"
    assert info.confidence == "inferred"
    assert info.evidence == "payment_url=someshop.bandcamp.com"


def test_url_priority_order_is_one_constant():
    named = [key for key in URL_KEY_PRIORITY if key != "*"]
    assert named == [
        "source_url",
        "file_url",
        "artist_url",
        "comment",
        "publisher_url",
        "commercial_url",
        "payment_url",
        "radio_url",
        "copyright_url",
    ]
    # Unnamed url-ish frames (WXXX and friends) sit between the two groups.
    assert 0 < URL_KEY_PRIORITY.index("*") < URL_KEY_PRIORITY.index("artist_url")


def test_image_url_analytics_frame_never_infers_a_provider():
    info = detect_provider({"txxx_suno_image_url": "https://cdn.suno.com/x.jpeg"})
    assert info is None


# --- other tools ------------------------------------------------------------


def test_unknown_generator_becomes_its_own_provider():
    info = detect_provider({"generator": "Harmony Forge 2"})
    assert info is not None
    assert info.provider == "harmony-forge-2"
    assert info.label == "Harmony Forge 2"
    assert info.is_ai is False
    assert info.confidence == "explicit"


@pytest.mark.parametrize(
    ("value", "slug"),
    [
        ("Sunshine Audio", "sunshine-audio"),
        ("David Synth", "david-synth"),
        ("Treason Records", "treason-records"),
        ("Nerogen", "nerogen"),
    ],
)
def test_generic_markers_never_match_inside_a_word(value: str, slug: str):
    # "shine", "avid", "reason", "nero" are encoder/DAW names, but only as
    # whole words — these four are their own providers, not encoders.
    info = detect_provider({"generator": value})
    assert info is not None, value
    assert info.provider == slug
    assert info.label == value
    assert info.confidence == "explicit"


@pytest.mark.parametrize(
    "value",
    [
        "Lavf58.76.100",
        "Lavf61.7.100",
        "LAME3.100",
        "ffmpeg",
        "iTunes 12.13",
        "Logic Pro X 10.7",
        "REAPER v7",
        "FL Studio 21",
        "Exact Audio Copy",
    ],
)
def test_generic_encoders_are_not_providers(value: str):
    assert detect_provider({"encoder": value}) is None, value


def test_guessed_udio_id_frames_identify_nothing():
    # Nobody has a Udio file, so no Udio frame name is in the table. A key
    # we merely imagined must not label the entry.
    assert detect_provider({"udio_id": SAMPLE_ID}) is None
    assert detect_provider({"txxx_udio_id": SAMPLE_ID}) is None


def test_udio_identified_by_generator_value():
    info = detect_provider({"generator": "udio"})
    assert info is not None
    assert info.provider == "udio"
    assert info.label == "Udio"
    assert info.is_ai is True
    assert info.confidence == "explicit"


def test_udio_identified_by_domain():
    info = detect_provider({"comment": "made on https://www.udio.com/songs/xyz"})
    assert info is not None
    assert info.provider == "udio"
    assert info.confidence == "inferred"


def test_no_tags_gives_none():
    assert detect_provider({}) is None
    assert detect_provider({}, {}) is None
    assert detect_provider({"title": "A Song", "bpm": "128"}) is None


# --- curated fields ---------------------------------------------------------


def _suno_embedded() -> dict[str, str]:
    return {
        "generator": "suno",
        "album": "Suno AI",
        "txxx_suno_id": SAMPLE_ID,
        "txxx_suno_prompt": "[Verse]\nsalt on the window",
        "txxx_suno_style": "dream pop, tape hiss",
        "txxx_suno_negative_tags": "brass",
        "txxx_suno_model_name": "chirp-v9-flux",
        "txxx_suno_model_version": "v9.2",
        "txxx_suno_created_date": "2026-04-02T10:00:00Z",
        "txxx_suno_handle": "neutral_handle",
        "txxx_suno_bpm": "128",
        "txxx_suno_key": "F minor",
        "txxx_suno_parent_id": PARENT_ID,
        "txxx_suno_lyrics_is_instrumental": "False",
        # analytics — none of these may ever appear in the curated output
        "txxx_suno_play_count": "4210",
        "txxx_suno_upvote_count": "17",
        "txxx_suno_skip_rate": "0.12",
        "txxx_suno_popularity_class": "B",
        "txxx_suno_engagement_score": "0.4",
        "txxx_suno_user_id": "user-neutral",
        "txxx_suno_image_url": "https://cdn.example.com/a.jpeg",
        "txxx_suno_days_since_creation": "40",
        "txxx_suno_is_following_creator": "False",
    }


def test_curated_maps_the_suno_fields():
    embedded = _suno_embedded()
    info = detect_provider(embedded)
    out = curated_fields(embedded, info)
    assert out["provider_id"] == SAMPLE_ID
    assert out["prompt"] == "[Verse]\nsalt on the window"
    assert out["lyrics"] == "[Verse]\nsalt on the window"
    assert out["style"] == "dream pop, tape hiss"
    assert out["negative_prompt"] == "brass"
    assert out["model"] == "chirp-v9-flux"
    assert out["model_version"] == "v9.2"
    assert out["created_at"] == "2026-04-02T10:00:00Z"
    assert out["artist"] == "neutral_handle"
    assert out["bpm"] == 128
    assert out["key"] == "F minor"
    assert out["parent_id"] == PARENT_ID
    assert out["is_instrumental"] is False


def test_curated_never_leaks_analytics_or_empty_values():
    embedded = _suno_embedded()
    embedded["txxx_suno_style"] = ""
    embedded["txxx_suno_style_prompt"] = "   "
    allowed = {
        "provider_id",
        "prompt",
        "style",
        "negative_prompt",
        "lyrics",
        "model",
        "model_version",
        "created_at",
        "artist",
        "bpm",
        "key",
        "parent_id",
        "is_instrumental",
    }
    out = curated_fields(embedded, detect_provider(embedded))
    assert set(out) <= allowed
    assert "style" not in out
    assert all(v not in ("", None) for v in out.values())
    for leaked in ("play_count", "skip_rate", "user_id", "image_url", "popularity"):
        assert not any(leaked in key for key in out)


def test_curated_drops_the_all_zero_parent_uuid():
    embedded = {"generator": "suno", "txxx_suno_parent_id": ZERO_UUID}
    out = curated_fields(embedded, detect_provider(embedded))
    assert "parent_id" not in out


def test_curated_falls_back_to_the_nested_ancestry_parent():
    embedded = {
        "generator": "suno",
        "txxx_suno_parent_id": ZERO_UUID,
        "txxx_suno_ancestry": {"parent_id": PARENT_ID},
    }
    out = curated_fields(embedded, detect_provider(embedded))
    assert out["parent_id"] == PARENT_ID


def test_curated_reads_nested_metadata_blob():
    embedded = {
        "generator": "suno",
        "txxx_suno_metadata": {
            "prompt": "a hymn for the tide",
            "tags": "ambient",
            "negative_tags": "vocals",
            "model_badges": {"badge_kind": "flagged"},
        },
    }
    out = curated_fields(embedded, detect_provider(embedded))
    assert out["prompt"] == "a hymn for the tide"
    assert out["style"] == "ambient"
    assert out["negative_prompt"] == "vocals"
    assert "model_badges" not in out


def test_curated_reads_the_observed_lyrics_prompt_key():
    embedded = {
        "generator": "suno",
        "txxx_suno_prompt": "a one-line brief",
        "txxx_suno_lyrics_prompt": "[Verse]\nthe words as sung",
    }
    out = curated_fields(embedded, detect_provider(embedded))
    assert out["lyrics"] == "[Verse]\nthe words as sung"
    assert out["prompt"] == "a one-line brief"


def test_curated_instrumental_true_means_no_lyrics():
    embedded = {
        "generator": "suno",
        "txxx_suno_prompt": "[Instrumental]",
        "txxx_suno_lyrics_is_instrumental": "True",
    }
    out = curated_fields(embedded, detect_provider(embedded))
    assert out["is_instrumental"] is True
    assert "lyrics" not in out
    assert out["prompt"] == "[Instrumental]"


def test_curated_is_empty_without_usable_tags():
    assert curated_fields({}, None) == {}
    assert curated_fields({"txxx_suno_play_count": "9"}, None) == {}


def test_curated_prefers_the_detected_provider_id():
    embedded = {"generator": "suno"}
    info = ProviderInfo(
        provider="suno",
        label="Suno",
        is_ai=True,
        provider_id=SAMPLE_ID,
        confidence="explicit",
        evidence="meta.suno_id",
    )
    assert curated_fields(embedded, info)["provider_id"] == SAMPLE_ID


def test_analytics_key_predicate():
    for key in (
        "txxx_suno_play_count",
        "txxx_suno_popularity_class",
        "txxx_suno_engagement_score",
        "txxx_suno_skip_rate",
        "txxx_suno_reaction.kind",
        "txxx_suno_session_id",
        "txxx_suno_cluster_label",
        "txxx_suno_nearest_neighbors",
        "txxx_suno_action_config.mode",
        "txxx_suno_metadata.model_badges.kind",
        "txxx_suno_image_url",
        "txxx_suno_user_id",
        "txxx_suno_is_following_creator",
        "txxx_suno_days_since_creation",
        "txxx_suno_persona.name",
    ):
        assert is_analytics_key(key), key
    for key in ("prompt", "txxx_suno_style", "txxx_suno_id", "album", "key"):
        assert not is_analytics_key(key), key


# --- the stock Suno download: five keys, none of them naming Suno -----------


def _stock_suno(**overrides: str) -> dict[str, str]:
    """A download straight from Suno: title, artist, album==title, id, year."""
    tags = {
        "title": "Harbour Lights",
        "artist": "Neutral Test Account",
        "album": "Harbour Lights",
        "comment": SAMPLE_ID,
        "date": "2025",
    }
    tags.update(overrides)
    return tags


def test_stock_suno_download_is_identified_by_its_fingerprint():
    info = detect_provider(_stock_suno())
    assert info is not None
    assert info.provider == "suno"
    assert info.label == "Suno"
    assert info.is_ai is True
    assert info.confidence == "inferred"
    assert info.provider_id == SAMPLE_ID
    assert "comment" in info.evidence
    assert SAMPLE_ID in info.evidence


def test_stock_suno_uuid_is_lowercased():
    info = detect_provider(_stock_suno(comment=SAMPLE_ID.upper()))
    assert info is not None
    assert info.provider == "suno"
    assert info.provider_id == SAMPLE_ID
    assert SAMPLE_ID in info.evidence


def test_stock_suno_comment_must_be_the_uuid_and_nothing_else():
    assert detect_provider(_stock_suno(comment=f"track {SAMPLE_ID}")) is None
    assert detect_provider(_stock_suno(comment=f"{SAMPLE_ID} (v2)")) is None


def test_stock_suno_needs_album_to_equal_title():
    assert detect_provider(_stock_suno(album="Harbour Lights EP")) is None
    assert detect_provider(_stock_suno(album="")) is None


def test_album_equal_to_title_alone_is_not_suno():
    assert detect_provider(_stock_suno(comment="ripped from tape")) is None
    assert detect_provider(_stock_suno(comment="")) is None


def test_stock_suno_rejects_the_all_zero_uuid():
    assert detect_provider(_stock_suno(comment=ZERO_UUID)) is None


def test_an_explicit_generator_beats_the_stock_fingerprint():
    info = detect_provider(_stock_suno(generator="udio"))
    assert info is not None
    assert info.provider == "udio"
    assert info.confidence == "explicit"
    assert info.evidence == "generator=udio"


def test_a_known_domain_beats_the_stock_fingerprint():
    info = detect_provider(
        _stock_suno(source_url="https://someartist.bandcamp.com/track/harbour-lights")
    )
    assert info is not None
    assert info.provider == "bandcamp"
    assert info.confidence == "inferred"
    assert info.evidence.startswith("source_url=")


def test_legacy_meta_still_wins_over_the_stock_fingerprint():
    info = detect_provider(_stock_suno(), {"provider": "bandcamp"})
    assert info is not None
    assert info.provider == "bandcamp"
    assert info.evidence == "meta.provider"

    info = detect_provider(_stock_suno(), {"source": "suno", "suno_id": PARENT_ID})
    assert info is not None
    assert info.provider == "suno"
    assert info.confidence == "explicit"
    assert info.evidence == "meta.source=suno"
    assert info.provider_id == PARENT_ID


def test_stock_suno_curated_fields_come_only_from_the_file():
    embedded = _stock_suno()
    info = detect_provider(embedded)
    out = curated_fields(embedded, info)
    assert out["provider_id"] == SAMPLE_ID
    assert out["artist"] == "Neutral Test Account"
    assert out["created_at"] == "2025"
    assert "prompt" not in out
    assert "lyrics" not in out
    assert "style" not in out
    assert "model" not in out


def test_stock_suno_wire_fields():
    info = detect_provider(_stock_suno())
    assert provider_wire_fields(info) == {
        "provider": "suno",
        "provider_label": "Suno",
        "provider_is_ai": True,
        "provider_id": SAMPLE_ID,
    }


# --- wire shape -------------------------------------------------------------


def test_wire_fields_for_none():
    assert provider_wire_fields(None) == {
        "provider": None,
        "provider_label": None,
        "provider_is_ai": None,
        "provider_id": None,
    }


def test_wire_fields_for_an_info():
    info = detect_provider({"generator": "suno", "txxx_suno_id": SAMPLE_ID})
    assert provider_wire_fields(info) == {
        "provider": "suno",
        "provider_label": "Suno",
        "provider_is_ai": True,
        "provider_id": SAMPLE_ID,
    }


# --- the slug is bounded ----------------------------------------------------


def test_a_multi_kilobyte_generator_yields_a_bounded_slug():
    """An unrecognised ``generator`` frame becomes the entry's provider, and
    that slug is then stored in metadata.json, copied into the
    ``metadata_json`` column, returned on every listed row, and compared by
    SQL. A frame holding kilobytes must not become kilobytes of identity."""
    raw = "Unbounded Frame " * 320
    assert len(raw) > 5000
    info = detect_provider({"generator": raw})
    assert info is not None
    assert len(info.provider) <= PROVIDER_SLUG_MAX
    # Truncation lands on a separator here; it is trimmed back off, so the
    # slug reads as words and never ends in "-".
    assert (
        info.provider
        == "unbounded-frame-unbounded-frame-unbounded-frame-unbounded-frame"
    )
    assert not info.provider.endswith("-")
    # Only the slug is bounded here — the label is the raw value the file
    # carried, which the store clips to its own PROVIDER_TEXT_MAX on write.
    assert info.label == raw.strip()
    assert info.confidence == "explicit"


def test_a_bounded_slug_never_ends_in_a_separator():
    # 64 chars of "a" then a separator then more: the cut is inside the word
    # in one case and on the separator in the other. Neither may end in "-".
    for filler in ("a" * 63, "a" * 64, "a" * 65, "ab " * 400):
        info = detect_provider({"generator": f"{filler} Machine {'x' * 4000}"})
        assert info is not None, filler
        assert 0 < len(info.provider) <= PROVIDER_SLUG_MAX, filler
        assert not info.provider.endswith("-"), filler
        assert not info.provider.startswith("-"), filler


@pytest.mark.parametrize(
    "value",
    ["", "   ", "---", "!!!", "  ***  ", "///", "…", "™ ®"],
)
def test_an_all_punctuation_generator_is_no_provider(value: str):
    """An empty slug means "this frame identifies nothing" — the passthrough
    rule must yield None rather than a provider with an empty id."""
    assert detect_provider({"generator": value}) is None


def test_a_multi_kilobyte_stored_provider_is_bounded_too():
    """The other place a slug is produced: a value already sitting in an
    entry's metadata, which wins over every embedded signal."""
    info = detect_provider({"generator": "suno"}, {"provider": "Runaway Value " * 400})
    assert info is not None
    assert 0 < len(info.provider) <= PROVIDER_SLUG_MAX
    assert not info.provider.endswith("-")


@pytest.mark.parametrize(
    ("tags", "slug"),
    [
        ({"generator": "suno"}, "suno"),
        ({"generator": "udio"}, "udio"),
        ({"generator": "Harmony Forge 2"}, "harmony-forge-2"),
        ({"album": "Suno AI"}, "suno"),
    ],
)
def test_known_and_short_slugs_are_unaffected_by_the_bound(tags: dict, slug: str):
    info = detect_provider(tags)
    assert info is not None
    assert info.provider == slug


def test_every_table_slug_is_inside_the_bound():
    for rule in PROVIDER_RULES:
        assert 0 < len(rule.provider) <= PROVIDER_SLUG_MAX, rule.provider


def test_a_thedaw_generator_is_thedaw_and_not_an_ai_provider():
    """ "theDAW" in a generator/encoder frame says the file was made IN theDAW
    and nothing about its origin -- a DJ set and a VJ clip carry it too -- so
    it is the same ``thedaw`` slug the column fallback's last arm answers, and
    it is not claimed to be a generator. Only the explicit Stable Audio
    spellings are the AI provider."""
    info = detect_provider({"generator": "theDAW"})
    assert info is not None
    assert info.provider == "thedaw"
    assert info.label == "theDAW"
    assert info.is_ai is False

    for value in ("stable-audio", "Stable Audio"):
        info = detect_provider({"generator": value})
        assert info is not None, value
        assert info.provider == "stable-audio", value
        assert info.label == "Stable Audio", value
        assert info.is_ai is True, value


# --- the rank rule, used by both labelers -----------------------------------


def test_the_fallback_slug_here_is_the_one_the_column_rule_uses():
    """``FALLBACK_PROVIDER`` is spelled in this module because ``db`` imports
    it and not the other way round. If the two ever drift, one labeler starts
    protecting a slug the other has never heard of."""
    from backend.modules.library.db import DEFAULT_PROVIDER

    assert FALLBACK_PROVIDER == DEFAULT_PROVIDER


def _info(provider: str, *, is_ai: bool, origin: str = "") -> ProviderInfo:
    return ProviderInfo(
        provider=provider,
        label=provider,
        is_ai=is_ai,
        provider_id=None,
        confidence="explicit",
        evidence="encoder=test",
        origin=origin,
    )


def test_a_named_service_detection_always_outranks_the_derivation():
    for slug, is_ai in (("suno", True), ("udio", True), ("bandcamp", False)):
        for derived, derived_is_ai in (
            ("stable-audio", True),
            ("import", False),
            (FALLBACK_PROVIDER, False),
        ):
            assert detection_outranks(
                _info(slug, is_ai=is_ai), derived, derived_is_ai
            ), (slug, derived)


def test_the_fallback_slug_loses_only_to_an_ai_derivation():
    """ "Made in theDAW" is more specific than "imported" and neither claims a
    generator, so the frame wins there. Against a generation it says nothing
    the columns do not say better, and winning would refile it as non-AI."""
    info = _info(FALLBACK_PROVIDER, is_ai=False)
    assert detection_outranks(info, "stable-audio", True) is False
    assert detection_outranks(info, "suno", True) is False
    assert detection_outranks(info, "import", False) is True
    assert detection_outranks(info, FALLBACK_PROVIDER, False) is True


def test_a_minted_tool_slug_loses_only_to_an_ai_derivation():
    minted = _info("acme-mastering-suite", is_ai=False, origin=ORIGIN_TOOL_FRAME)
    assert detection_outranks(minted, "stable-audio", True) is False
    assert detection_outranks(minted, "suno", True) is False
    assert detection_outranks(minted, "import", False) is True
    assert detection_outranks(minted, FALLBACK_PROVIDER, False) is True
    # The same slug from a RULE rather than a tool frame is a signature
    # someone observed, so it is not second-guessed.
    assert detection_outranks(_info("bandcamp", is_ai=False), "stable-audio", True)


def test_step_four_marks_its_answer_and_the_named_rules_do_not():
    minted = detect_provider({"encoder": "Acme Mastering Suite"})
    assert minted is not None
    assert minted.provider == "acme-mastering-suite"
    assert minted.is_ai is False
    assert minted.origin == ORIGIN_TOOL_FRAME
    for tags in ({"generator": "suno"}, {"generator": "theDAW"}):
        named = detect_provider(tags)
        assert named is not None, tags
        assert named.origin == "", tags
    # Not a wire field: what a row shows and stores is unchanged by it.
    assert set(provider_wire_fields(minted)) == {
        "provider",
        "provider_label",
        "provider_is_ai",
        "provider_id",
    }
