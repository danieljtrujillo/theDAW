"""Tests for deterministic semantic tagging and prompt inference.

These are pure functions over an analysis dict, so they run without audio or
external tools. The schema test confirms the analysis table gained the prompt
columns (migration v3) and round-trips them.
"""

from __future__ import annotations

import json
from pathlib import Path

from backend.modules.analysis.prompt import derive_semantic_tags, generate_prompt
from backend.modules.library.db import LibraryDB


def test_semantic_tags_from_full_analysis():
    analysis = {
        "bpm": 128,
        "key": "A",
        "scale": "minor",
        "rms_db": -8.0,
        "pitch_mean_hz": 600.0,
        "pitch_std_hz": 200.0,
        "duration_sec": 180.0,
        "channels": 2,
    }
    tags = derive_semantic_tags(analysis)
    assert "upbeat" in tags and "danceable" in tags  # 110-129 BPM bucket
    assert "A minor" in tags
    assert "moody" in tags  # minor key
    assert "loud" in tags  # rms_db -8 > -10
    assert "bright" in tags  # pitch mean 600 Hz
    assert "full track" in tags  # 180 s
    assert "stereo" in tags


def test_generate_prompt_sentence_structure():
    analysis = {
        "bpm": 128,
        "key": "A",
        "scale": "minor",
        "rms_db": -8.0,
        "pitch_mean_hz": 600.0,
        "duration_sec": 180.0,
        "channels": 2,
    }
    result = generate_prompt(analysis)
    prompt = result["prompt_guess"]
    assert prompt.startswith("Approximately 128 BPM")
    assert "in A minor" in prompt
    assert prompt.endswith(".")
    assert 0.0 < result["prompt_confidence"] <= 0.9
    assert isinstance(result["semantic_tags"], list) and result["semantic_tags"]


def test_generate_prompt_empty_analysis_is_safe():
    result = generate_prompt({})
    assert result["prompt_guess"] == ""
    assert result["semantic_tags"] == []
    assert result["prompt_confidence"] >= 0.3


def test_embedded_genre_folds_into_prompt():
    result = generate_prompt(
        {"bpm": 90, "key": "C", "scale": "major"},
        embedded_tags={"genre": "Lo-Fi Hip Hop"},
    )
    assert "lo-fi hip hop" in result["prompt_guess"].lower()


def test_genre_field_raises_confidence_and_tags():
    base = {"bpm": 120, "key": "G", "scale": "major", "rms_db": -12.0}
    without_genre = generate_prompt(base)
    with_genre = generate_prompt({**base, "genre": "techno"})
    assert with_genre["prompt_confidence"] >= without_genre["prompt_confidence"]
    assert "techno" in with_genre["semantic_tags"]


def test_analysis_schema_v3_persists_prompt(tmp_path: Path):
    db = LibraryDB(tmp_path / "library.db")
    assert db.schema_version() == 3
    db.upsert_entry({"id": "track"})
    db.upsert_analysis(
        "track",
        {
            "bpm": 100,
            "key": "D",
            "scale": "minor",
            "prompt_guess": "Approximately 100 BPM, in D minor, mid-tempo.",
            "prompt_confidence": 0.6,
            "semantic_tags": ["mid-tempo", "D minor", "moody"],
        },
    )
    row = db.get_analysis("track")
    assert row is not None
    assert row["prompt_guess"].startswith("Approximately 100 BPM")
    assert row["prompt_confidence"] == 0.6
    assert json.loads(row["semantic_tags_json"]) == ["mid-tempo", "D minor", "moody"]
