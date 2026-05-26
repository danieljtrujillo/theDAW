"""Unit tests for backend.modules.chimera.detect.

Synthesizes click tracks at known BPMs and asserts the detector recovers them
within tolerance. Also covers degenerate inputs (too short, silent).
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from backend.modules.chimera.detect import detect_tempo_and_beats


def _synth_click_track(
    bpm: float,
    duration_sec: float,
    sr: int = 44100,
    seed: int = 42,
) -> np.ndarray:
    n_samples = int(duration_sec * sr)
    audio = np.zeros(n_samples, dtype=np.float32)
    rng = np.random.default_rng(seed=seed)
    click_len = int(0.01 * sr)
    envelope = np.linspace(1.0, 0.0, click_len, dtype=np.float32)
    click = rng.standard_normal(click_len).astype(np.float32) * envelope * 0.5

    period = 60.0 / bpm
    t = 0.0
    while t < duration_sec:
        start = int(t * sr)
        end = min(start + click_len, n_samples)
        if start < n_samples:
            audio[start:end] += click[: end - start]
        t += period
    return audio


@pytest.mark.parametrize("target_bpm", [90.0, 120.0, 140.0])
def test_detect_known_bpm(tmp_path: Path, target_bpm: float):
    sr = 44100
    audio = _synth_click_track(target_bpm, duration_sec=8.0, sr=sr)
    wav = tmp_path / f"click_{int(target_bpm)}.wav"
    sf.write(str(wav), audio, sr)

    result = detect_tempo_and_beats(wav)

    assert result["bpm"] is not None, "expected a BPM lock on a clean click track"
    # aubio is allowed to land on half/double tempo; accept that.
    candidates = [target_bpm, target_bpm * 2, target_bpm / 2]
    assert any(abs(result["bpm"] - c) < 3.0 for c in candidates), (
        f"target={target_bpm} got={result['bpm']}"
    )
    # aubio's tempo tracker has a ~2s warmup before it starts emitting beats,
    # so a clean 8s click track typically yields 5–10 beats, not the
    # theoretical maximum. Downbeat alignment only needs the first beat.
    assert len(result["beats"]) >= 4, f"too few beats: {len(result['beats'])}"
    assert result["beats"][0] < 4.0, "first beat should land in the first half"
    assert result["samplerate"] == sr
    assert result["duration_sec"] == pytest.approx(8.0, abs=0.05)


def test_detect_short_file_returns_none(tmp_path: Path):
    sr = 44100
    audio = np.zeros(int(0.5 * sr), dtype=np.float32)
    wav = tmp_path / "short.wav"
    sf.write(str(wav), audio, sr)

    result = detect_tempo_and_beats(wav)

    assert result["bpm"] is None
    assert result["duration_sec"] < 1.0


def test_detect_silent_file_returns_none(tmp_path: Path):
    sr = 44100
    audio = np.zeros(int(3.0 * sr), dtype=np.float32)
    wav = tmp_path / "silent.wav"
    sf.write(str(wav), audio, sr)

    result = detect_tempo_and_beats(wav)

    assert result["bpm"] is None
    assert result["beats"] == []
