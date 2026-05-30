"""Unit tests for backend.modules.stems.engine.

These tests focus on the pure helpers (no sidecar, no Demucs, no DB).
The wider engine flow is exercised by integration tests / manual runs;
here we only nail down the sidecar listing contract that previously
caused `0 stem(s) written` runs (see fetch-failed regression where the
sidecar returned ``{files: [{name, size, url}]}`` but the engine
treated each item as a string filename).
"""

from __future__ import annotations

from backend.modules.stems.engine import _normalize_stem_filenames


def test_normalize_handles_live_sidecar_dict_entries() -> None:
    """Current integration-package shape: list of dicts with name/size/url."""
    listing = {
        "files": [
            {"name": "bass.wav", "size": 5292078, "url": "/stems/task/bass.wav"},
            {"name": "drums.wav", "size": 5292078, "url": "/stems/task/drums.wav"},
            {"name": "other.wav", "size": 5292078, "url": "/stems/task/other.wav"},
            {"name": "vocals.wav", "size": 5292078, "url": "/stems/task/vocals.wav"},
        ]
    }
    assert _normalize_stem_filenames(listing) == [
        "bass.wav",
        "drums.wav",
        "other.wav",
        "vocals.wav",
    ]


def test_normalize_handles_legacy_string_list() -> None:
    """Plain list of strings shape (older sidecars / tests)."""
    listing = {"files": ["bass.wav", "drums.wav"]}
    assert _normalize_stem_filenames(listing) == ["bass.wav", "drums.wav"]


def test_normalize_handles_stems_key_fallback() -> None:
    """Some shapes expose the array under ``stems`` instead of ``files``."""
    listing = {"stems": [{"name": "vocals.wav"}]}
    assert _normalize_stem_filenames(listing) == ["vocals.wav"]


def test_normalize_handles_name_to_path_dict() -> None:
    """Dict-shape: keys are filenames, values are absolute paths."""
    listing = {"files": {"bass.wav": "/tmp/bass.wav", "drums.wav": "/tmp/drums.wav"}}
    out = _normalize_stem_filenames(listing)
    assert sorted(out) == ["bass.wav", "drums.wav"]


def test_normalize_recovers_name_from_url_when_name_missing() -> None:
    listing = {"files": [{"url": "/stems/task/guitar.wav", "size": 1}]}
    assert _normalize_stem_filenames(listing) == ["guitar.wav"]


def test_normalize_drops_path_traversal_entries() -> None:
    listing = {
        "files": [
            {"name": "bass.wav"},
            {"name": "../evil.wav"},
            {"name": "subdir/drums.wav"},
            {"name": "ok.wav"},
        ]
    }
    assert _normalize_stem_filenames(listing) == ["bass.wav", "ok.wav"]


def test_normalize_drops_extensionless_and_empty_entries() -> None:
    listing = {"files": [{"name": "bass.wav"}, {"name": ""}, {"name": "README"}]}
    assert _normalize_stem_filenames(listing) == ["bass.wav"]


def test_normalize_deduplicates_preserving_order() -> None:
    listing = {"files": ["bass.wav", "bass.wav", "drums.wav"]}
    assert _normalize_stem_filenames(listing) == ["bass.wav", "drums.wav"]


def test_normalize_returns_empty_for_unexpected_shapes() -> None:
    assert _normalize_stem_filenames(None) == []  # type: ignore[arg-type]
    assert _normalize_stem_filenames({"files": 42}) == []
    assert _normalize_stem_filenames({}) == []
    assert _normalize_stem_filenames({"files": None, "stems": None}) == []
