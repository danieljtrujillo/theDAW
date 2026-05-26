"""Unit tests for the analysis module."""

from __future__ import annotations

import json
from pathlib import Path

from backend.modules.analysis.bars import estimate_bars
from backend.modules.analysis.engine import analyze_and_persist, persist_analysis
from backend.modules.analysis.ffprobe import has_ffprobe, probe_file
from backend.modules.analysis.key import _correlate, _MAJOR_PROFILE


def test_estimate_bars_empty():
    assert estimate_bars([]) is None


def test_estimate_bars_four_four():
    beats = [0.5 * i for i in range(16)]
    assert estimate_bars(beats, time_sig_numerator=4) == 4.0


def test_estimate_bars_three_four():
    beats = [0.5 * i for i in range(12)]
    assert estimate_bars(beats, time_sig_numerator=3) == 4.0


def test_key_correlation_matches_self():
    # The major profile correlated with itself should produce the
    # maximum at rotation 0 (C major). Numerically: corr(x, x) == 1.0.
    corr = _correlate(list(_MAJOR_PROFILE), _MAJOR_PROFILE)
    assert max(range(12), key=lambda i: corr[i]) == 0
    assert abs(corr[0] - 1.0) < 1e-9


def test_key_correlation_handles_zero_vector():
    corr = _correlate([0.0] * 12, _MAJOR_PROFILE)
    assert corr == [0.0] * 12


def test_probe_file_returns_empty_when_no_ffprobe_or_missing(tmp_path: Path):
    missing = tmp_path / "nope.wav"
    out = probe_file(missing)
    # Either ffprobe is missing OR the file is missing — both → {}.
    assert out == {}


def test_probe_file_real_wav_when_ffprobe_available(tmp_path: Path):
    if not has_ffprobe():
        return  # silently skip on environments without ffprobe
    # Build a real 1-second silence WAV with soundfile.
    try:
        import numpy as np
        import soundfile as sf
    except ImportError:
        return
    p = tmp_path / "silent.wav"
    sf.write(str(p), np.zeros((44100, 2), dtype=np.float32), 44100)
    out = probe_file(p)
    summary = out.get("_summary") or {}
    assert summary.get("sample_rate") == 44100
    assert summary.get("channels") == 2


def _seed_entry(root: Path, entry_id: str, sr: int = 22050) -> Path:
    """Seed a real WAV-backed library entry for engine tests."""
    item_dir = root / entry_id
    item_dir.mkdir(parents=True, exist_ok=True)
    import numpy as np
    import soundfile as sf

    # 2 seconds of a 440 Hz sine — gives the analyzer something real to chew on.
    t = np.linspace(0, 2.0, sr * 2, endpoint=False, dtype=np.float32)
    y = 0.2 * np.sin(2 * np.pi * 440.0 * t)
    audio_path = item_dir / "output.wav"
    sf.write(str(audio_path), y, sr)
    meta = {
        "id": entry_id,
        "filename": "output.wav",
        "audio_filename": "output.wav",
        "mime_type": "audio/wav",
        "title": entry_id,
        "prompt": "test sine",
        "duration": 2.0,
        "steps": 8,
        "cfg": 1.0,
        "seed": 1,
        "favorite": False,
        "rating": None,
        "tags": [],
        "notes": "",
        "source": "import",
        "saved_at": 1234567890.0,
        "embedded_tags": {"hint": "stub"},
    }
    (item_dir / "metadata.json").write_text(json.dumps(meta), encoding="utf-8")
    return audio_path


def test_engine_writes_to_db_and_metadata(tmp_path: Path):
    try:
        import numpy as np  # noqa: F401
        import soundfile as sf  # noqa: F401
    except ImportError:
        return

    from backend.modules.library.store import LibraryStore

    audio_path = _seed_entry(tmp_path, "alpha")
    store = LibraryStore(tmp_path)
    assert store.db is not None
    # _sync runs via auto-reindex on init; the entries row exists.
    assert store.db.get_entry("alpha") is not None

    entry_dir = store._dir_for("alpha")
    metadata_path = (entry_dir / "metadata.json") if entry_dir else None

    payload = analyze_and_persist(
        store.db,
        "alpha",
        audio_path,
        metadata_path=metadata_path,
        settings={"include_key": True, "include_genre": False},
    )

    # Engine produced a payload with expected keys.
    assert payload.get("version") == 1
    assert "analyzed_at" in payload
    # Pitch detection finds ~440 Hz on a sine tone (within tolerance).
    pitch = payload.get("pitch_mean_hz")
    if pitch is not None:
        assert 430.0 <= pitch <= 450.0

    # DB row exists.
    db_analysis = store.db.get_analysis("alpha")
    assert db_analysis is not None
    assert db_analysis["version"] == 1

    # Entry status updated.
    row = store.db.get_entry("alpha")
    assert row is not None
    assert row["analysis_status"] == "complete"

    # metadata.json now has an 'analysis' section.
    assert metadata_path is not None
    meta = json.loads(metadata_path.read_text(encoding="utf-8"))
    assert "analysis" in meta
    assert "beats_count" in meta["analysis"]


def test_persist_analysis_handles_missing_metadata_file(tmp_path: Path):
    """If the metadata.json doesn't exist, persist_analysis still writes
    to the DB and doesn't raise."""
    from backend.modules.library.db import LibraryDB

    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "x"})
    persist_analysis(
        db,
        "x",
        {"version": 1, "bpm": 120.0, "beats": [0.5, 1.0]},
        metadata_path=tmp_path / "does-not-exist.json",
    )
    out = db.get_analysis("x")
    assert out is not None
    assert out["bpm"] == 120.0
