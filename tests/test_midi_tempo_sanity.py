"""A nonsense analysis tempo is not stamped on an entry's MIDI files.

The analysis stores aubio's closing tempo estimate, which a fade or a tail can
drag anywhere; entries in a real library read 40.69 BPM while their beat lists
keep 95 to 152 BPM, and every file converted from them carried 40.69. The runner keeps a tempo
inside its sane range, falls back to the beat list's own tempo, and stamps
nothing when neither is usable. The conversions are recorded, not run.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from backend.modules.midi import runner as runner_module

SR = 22050


def _wav(tmp_path: Path, name: str = "stem.wav") -> Path:
    path = tmp_path / name
    sf.write(str(path), np.zeros(SR, dtype=np.float32), SR)
    return path


def _entry_with_analysis(tmp_path: Path, bpm, beats) -> tuple:
    from backend.modules.library.db import LibraryDB

    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track"})
    db.upsert_analysis("track", {"bpm": bpm, "beats": beats})
    entry_dir = tmp_path / "entry"
    (entry_dir / "stems").mkdir(parents=True)
    drums = _wav(entry_dir / "stems", "drums.wav")
    db.add_stem(
        stem_id="track__drums",
        entry_id="track",
        stem_name="drums",
        audio_path=str(drums),
    )
    return db, entry_dir, _wav(tmp_path, "full.wav")


def _record_conversions(monkeypatch) -> list[dict]:
    calls: list[dict] = []

    def fake(src, out, *, hint="generic", auto_install=True, **kw):
        calls.append({"target": Path(out).stem, **kw})
        Path(out).parent.mkdir(parents=True, exist_ok=True)
        Path(out).write_bytes(b"MThd")
        return {"ok": True, "engine": "fake", "engine_version": "1"}

    monkeypatch.setattr(runner_module, "convert_to_midi", fake)
    return calls


def test_an_out_of_range_analysis_tempo_falls_back_to_the_beat_list(
    monkeypatch, tmp_path: Path
):
    """aubio's closing estimate of 40.69 BPM over a beat list that keeps
    another tempo (here 120 BPM, beats half a second apart)."""
    beats = [0.25 + 0.5 * i for i in range(40)]
    db, entry_dir, full = _entry_with_analysis(tmp_path, 40.69, beats)
    calls = _record_conversions(monkeypatch)
    runner_module.convert_entry(
        db, "track", full, entry_dir, from_stems=True, auto_install=False
    )
    assert {c["target"]: c["bpm"] for c in calls} == {
        "full": pytest.approx(120.0),
        "drums": pytest.approx(120.0),
    }
    drums = next(c for c in calls if c["target"] == "drums")
    assert drums["beats"] == beats


def test_an_out_of_range_tempo_with_no_usable_beats_stamps_nothing(
    monkeypatch, tmp_path: Path
):
    db, entry_dir, full = _entry_with_analysis(tmp_path, 40.69, [])
    calls = _record_conversions(monkeypatch)
    runner_module.convert_entry(
        db, "track", full, entry_dir, from_stems=True, auto_install=False
    )
    assert [c["bpm"] for c in calls] == [None, None]
    drums = next(c for c in calls if c["target"] == "drums")
    assert drums["beats"] is None


def test_beats_that_imply_a_nonsense_tempo_are_not_used_either(
    monkeypatch, tmp_path: Path
):
    beats = [0.25 + 1.5 * i for i in range(20)]  # 40 BPM
    db, entry_dir, full = _entry_with_analysis(tmp_path, 400.0, beats)
    calls = _record_conversions(monkeypatch)
    runner_module.convert_entry(
        db, "track", full, entry_dir, from_stems=True, auto_install=False
    )
    assert [c["bpm"] for c in calls] == [None, None]


def test_a_sane_analysis_tempo_is_kept(monkeypatch, tmp_path: Path):
    beats = [0.25 + 0.5 * i for i in range(40)]
    db, entry_dir, full = _entry_with_analysis(tmp_path, 97.0, beats)
    calls = _record_conversions(monkeypatch)
    runner_module.convert_entry(
        db, "track", full, entry_dir, from_stems=True, auto_install=False
    )
    assert [c["bpm"] for c in calls] == [97.0, 97.0]


def test_a_missing_analysis_tempo_is_read_from_the_beat_list(
    monkeypatch, tmp_path: Path
):
    beats = [0.1 + 0.6 * i for i in range(30)]  # 100 BPM
    db, entry_dir, full = _entry_with_analysis(tmp_path, None, beats)
    calls = _record_conversions(monkeypatch)
    runner_module.convert_entry(
        db, "track", full, entry_dir, from_stems=True, auto_install=False
    )
    assert [c["bpm"] for c in calls] == [pytest.approx(100.0)] * 2
