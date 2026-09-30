"""Batch-12 T05 tests: LIB-003 (loudness_lufs is computed via native BS.1770,
not mislabeled RMS or a mono-downmixed proxy) and LIB-007 (module.json
description matches actual behaviour)."""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import soundfile as sf

from backend.modules.analysis.bars import estimate_loudness_lufs
from backend.modules.analysis.engine import analyze_audio


def _tone(seconds: float, sr: int, freq: float = 440.0, amp: float = 0.2) -> np.ndarray:
    t = np.linspace(0, seconds, int(sr * seconds), endpoint=False, dtype=np.float32)
    return (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def _write_wav(path: Path, data: np.ndarray, sr: int) -> None:
    sf.write(str(path), data, sr)


def test_estimate_loudness_lufs_missing_file_returns_none(tmp_path: Path):
    missing = tmp_path / "nope.wav"
    assert estimate_loudness_lufs(missing) is None


def test_estimate_loudness_lufs_returns_finite_negative_lufs_for_a_real_tone(
    tmp_path: Path,
):
    sr = 44100
    y = _tone(5.0, sr=sr)  # long enough for BS.1770's 400 ms gating blocks
    p = tmp_path / "tone_mono.wav"
    _write_wav(p, y, sr)

    lufs = estimate_loudness_lufs(p)
    assert lufs is not None
    assert isinstance(lufs, float)
    assert -60.0 < lufs < 0.0


def test_estimate_loudness_lufs_short_clip_returns_none(tmp_path: Path):
    sr = 44100
    y = _tone(0.05, sr=sr)  # far too short for BS.1770's ~0.4s gating block
    p = tmp_path / "short.wav"
    _write_wav(p, y, sr)

    assert estimate_loudness_lufs(p) is None


def test_estimate_loudness_lufs_silence_returns_none(tmp_path: Path):
    sr = 44100
    y = np.zeros(sr * 5, dtype=np.float32)
    p = tmp_path / "silence.wav"
    _write_wav(p, y, sr)

    # Fully silent audio gates to -inf under BS.1770 (nothing survives the
    # -70 LUFS absolute gate) -> None, never an RMS-dB number mislabeled as
    # LUFS.
    assert estimate_loudness_lufs(p) is None


def test_estimate_loudness_lufs_stereo_matches_native_pyloudnorm_within_half_lu(
    tmp_path: Path,
):
    """LIB-003 audit fix items 1/5: measuring on the shared mono/22.05kHz
    decode read 3 dB low on L=R stereo (and up to ~9.5 dB low on wide
    stereo), because downmixing to mono halves the per-channel power
    BS.1770 expects to see twice. This writes a real L=R stereo file,
    measures it independently with pyloudnorm on the native (frames,
    channels) array, and checks our function reproduces that closely."""
    import pyloudnorm as pyln

    sr = 44100
    mono = _tone(5.0, sr=sr, amp=0.3)
    stereo = np.stack([mono, mono], axis=1)  # (frames, 2), L == R
    p = tmp_path / "stereo_tone.wav"
    _write_wav(p, stereo, sr)

    reference = float(pyln.Meter(sr).integrated_loudness(stereo))
    assert math.isfinite(reference)

    measured = estimate_loudness_lufs(p)
    assert measured is not None
    assert abs(measured - reference) <= 0.5


def test_analyze_audio_includes_loudness_lufs(tmp_path: Path):
    sr = 44100
    y = _tone(3.0, sr=sr)
    p = tmp_path / "tone.wav"
    _write_wav(p, y, sr)

    out = analyze_audio(p, include_key=False, include_pitch=False, include_prompt=False)

    assert "loudness_lufs" in out
    assert out["loudness_lufs"] is not None
    assert isinstance(out["loudness_lufs"], float)


def test_module_json_description_reflects_actual_default_on_idle_behaviour():
    module_json = (
        Path(__file__).resolve().parents[1]
        / "backend"
        / "modules"
        / "analysis"
        / "module.json"
    )
    data = json.loads(module_json.read_text(encoding="utf-8"))
    desc = data["description"]

    # settings/store.py DEFAULT_SETTINGS: analysis.auto_on_import/auto_on_generate
    # are True — analysis runs automatically by default, not only when a user
    # opts in. The description must not claim "opt-in".
    assert "opt-in" not in desc.lower()
    # It really is idle-gated (background_workers.py waits on IdleManager),
    # and that is worth keeping in the description.
    assert "idle" in desc.lower()
    # And it must say the true default: on by default / automatic.
    assert "default" in desc.lower() or "automatic" in desc.lower()
