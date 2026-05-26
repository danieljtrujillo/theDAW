"""Unit tests for backend.modules.chimera.stretch.

Stretches a synthesized 440 Hz sine and verifies (a) output duration matches
the requested ratio within tolerance, (b) the dominant frequency is still
~440 Hz (pitch preserved), (c) both rubberband and atempo engines work.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from backend.modules.chimera.stretch import stretch_audio
from backend.modules.chimera.config import probe


def _synth_sine(freq_hz: float, duration_sec: float, sr: int = 44100) -> np.ndarray:
    t = np.arange(int(duration_sec * sr), dtype=np.float32) / sr
    return (0.5 * np.sin(2 * np.pi * freq_hz * t)).astype(np.float32)


def _dominant_freq(audio: np.ndarray, sr: int) -> float:
    spec = np.abs(np.fft.rfft(audio))
    freqs = np.fft.rfftfreq(len(audio), 1 / sr)
    return float(freqs[int(np.argmax(spec))])


def _write_sine(tmp_path: Path, freq_hz: float, duration_sec: float) -> Path:
    sr = 44100
    audio = _synth_sine(freq_hz, duration_sec, sr)
    out = tmp_path / f"sine_{int(freq_hz)}Hz_{duration_sec:.2f}s.wav"
    sf.write(str(out), audio, sr)
    return out


_RUBBERBAND_AVAILABLE = probe()["librubberband"]


@pytest.mark.skipif(not _RUBBERBAND_AVAILABLE, reason="librubberband not present")
@pytest.mark.parametrize("ratio", [0.5, 1.0, 1.5, 2.0])
def test_stretch_rubberband_duration_and_pitch(tmp_path: Path, ratio: float):
    src_dur = 2.0
    src = _write_sine(tmp_path, 440.0, src_dur)
    dst = tmp_path / "out.wav"

    result = stretch_audio(src, dst, ratio, force_engine="rubberband")

    assert result["engine"] == "rubberband"
    assert result["clamped"] is False

    audio, sr = sf.read(str(dst))
    if audio.ndim == 2:
        audio = audio[:, 0]
    out_dur = len(audio) / sr
    expected_dur = src_dur / ratio
    # rubberband isn't sample-exact; accept ±5%
    assert out_dur == pytest.approx(expected_dur, rel=0.05), (
        f"ratio={ratio} expected~{expected_dur:.2f}s got {out_dur:.2f}s"
    )

    # Pitch preserved
    dom = _dominant_freq(audio[: int(sr * 1.0)], sr)
    assert abs(dom - 440.0) < 5.0, f"pitch drifted: {dom} Hz"


@pytest.mark.parametrize("ratio", [0.5, 1.0, 1.5, 2.0])
def test_stretch_atempo_duration_and_pitch(tmp_path: Path, ratio: float):
    src_dur = 2.0
    src = _write_sine(tmp_path, 440.0, src_dur)
    dst = tmp_path / "out.wav"

    result = stretch_audio(src, dst, ratio, force_engine="atempo")

    assert result["engine"] == "atempo"

    audio, sr = sf.read(str(dst))
    if audio.ndim == 2:
        audio = audio[:, 0]
    out_dur = len(audio) / sr
    expected_dur = src_dur / ratio
    assert out_dur == pytest.approx(expected_dur, rel=0.05), (
        f"ratio={ratio} expected~{expected_dur:.2f}s got {out_dur:.2f}s"
    )

    dom = _dominant_freq(audio[: int(sr * 1.0)], sr)
    assert abs(dom - 440.0) < 5.0, f"pitch drifted: {dom} Hz"


def test_stretch_clamps_out_of_range(tmp_path: Path):
    src = _write_sine(tmp_path, 440.0, 1.0)
    dst = tmp_path / "out.wav"

    result = stretch_audio(src, dst, ratio=3.0, force_engine="atempo")

    assert result["clamped"] is True
    assert result["ratio_used"] == 2.0
    assert result["note"] is not None


def test_stretch_unity_ratio_still_produces_output(tmp_path: Path):
    src = _write_sine(tmp_path, 440.0, 1.0)
    dst = tmp_path / "out.wav"

    result = stretch_audio(src, dst, ratio=1.0, force_engine="atempo")

    assert result["clamped"] is False
    assert Path(result["output_path"]).exists()
