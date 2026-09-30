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


def test_a_stale_abort_request_does_not_end_the_next_run(tmp_path, monkeypatch) -> None:
    """An abort that lands after a run's last poll tick is never consumed by
    that run. The next run of the same entry starts with the request cleared,
    so it is not ended at its first tick by a press meant for the last one."""
    import asyncio
    from pathlib import Path

    import pytest

    from backend.modules.stems import engine

    entry_id = "stale-abort-entry"
    seen: list[bool] = []

    class FakeSidecar:
        async def submit_separation(self, audio_path, *, stems, device, quality):
            seen.append(engine._should_abort(entry_id))
            raise RuntimeError("stop here: the submit is as far as this run goes")

    class FakeDb:
        pass

    monkeypatch.setattr(engine, "_effective_device_label", lambda requested: "cpu")
    # The previous run finished; its late abort request is still on file.
    engine._set_progress(entry_id, phase="completed", progress=100)
    assert engine.request_abort(entry_id) is True
    assert engine._should_abort(entry_id) is True
    try:
        with pytest.raises(RuntimeError, match="stop here"):
            asyncio.run(
                engine.separate_entry(
                    FakeDb(),
                    entry_id,
                    Path(tmp_path) / "audio.wav",
                    Path(tmp_path),
                    sidecar=FakeSidecar(),
                )
            )
        assert seen == [False], "the run started with the stale request cleared"
        assert engine._should_abort(entry_id) is False
    finally:
        engine.clear_progress(entry_id)
        engine._clear_abort(entry_id)
