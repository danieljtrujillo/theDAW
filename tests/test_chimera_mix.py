"""Unit tests for backend.modules.chimera.mix.

Mixes synthesized sines of different frequencies and asserts:
1. Output length equals the longest input (start-aligned).
2. All input frequencies are present in the output FFT (no clip got lost).
3. RMS is normalized to roughly the target value.
4. Peak respects the ceiling — no clipping.
5. Mismatched sample rates are rejected.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from backend.modules.chimera.mix import mix_clips, TARGET_RMS, PEAK_CEILING


def _write_sine(
    tmp_path: Path, freq_hz: float, duration_sec: float, sr: int = 44100
) -> Path:
    t = np.arange(int(duration_sec * sr), dtype=np.float32) / sr
    audio = (0.5 * np.sin(2 * np.pi * freq_hz * t)).astype(np.float32)
    out = tmp_path / f"sine_{int(freq_hz)}Hz.wav"
    sf.write(str(out), audio, sr)
    return out


def _bin_amplitude(audio: np.ndarray, sr: int, freq_hz: float) -> float:
    spec = np.abs(np.fft.rfft(audio))
    freqs = np.fft.rfftfreq(len(audio), 1 / sr)
    idx = int(np.argmin(np.abs(freqs - freq_hz)))
    return float(spec[idx])


def test_mix_two_clips_preserves_both_frequencies(tmp_path: Path):
    a = _write_sine(tmp_path, 440.0, 2.0)
    b = _write_sine(tmp_path, 880.0, 2.0)
    out = tmp_path / "mix.wav"

    result = mix_clips([a, b], [1.0, 1.0], out)

    assert result["num_clips"] == 2
    assert result["sample_rate"] == 44100
    assert result["duration_sec"] == pytest.approx(2.0, abs=0.01)

    mixed, sr = sf.read(str(out), dtype="float32")
    mono = mixed[:, 0] if mixed.ndim == 2 else mixed

    amp_440 = _bin_amplitude(mono, sr, 440.0)
    amp_880 = _bin_amplitude(mono, sr, 880.0)
    amp_220 = _bin_amplitude(mono, sr, 220.0)

    assert amp_440 > amp_220 * 5, "440 Hz should dominate over noise floor"
    assert amp_880 > amp_220 * 5, "880 Hz should dominate over noise floor"


def test_mix_output_length_matches_longest_clip(tmp_path: Path):
    short = _write_sine(tmp_path, 440.0, 1.0)
    long_ = _write_sine(tmp_path, 880.0, 3.0)
    out = tmp_path / "mix.wav"

    result = mix_clips([short, long_], [1.0, 1.0], out)

    assert result["duration_sec"] == pytest.approx(3.0, abs=0.01)


def test_mix_normalizes_rms(tmp_path: Path):
    a = _write_sine(tmp_path, 440.0, 1.0)
    b = _write_sine(tmp_path, 880.0, 1.0)
    out = tmp_path / "mix.wav"

    result = mix_clips([a, b], [1.0, 1.0], out)

    # RMS should be near target; loosely bounded since peak ceiling may attenuate.
    assert result["rms"] == pytest.approx(TARGET_RMS, rel=0.30)
    assert result["peak"] <= PEAK_CEILING + 1e-6


def test_mix_weight_attenuates_contribution(tmp_path: Path):
    a = _write_sine(tmp_path, 440.0, 1.0)
    b = _write_sine(tmp_path, 880.0, 1.0)
    out = tmp_path / "mix.wav"

    mix_clips([a, b], [1.0, 0.0], out)  # b silenced

    mixed, sr = sf.read(str(out), dtype="float32")
    mono = mixed[:, 0] if mixed.ndim == 2 else mixed
    amp_440 = _bin_amplitude(mono, sr, 440.0)
    amp_880 = _bin_amplitude(mono, sr, 880.0)

    assert amp_440 > amp_880 * 50, "880 Hz should be essentially absent when weighted 0"


def test_mix_rejects_mismatched_sample_rate(tmp_path: Path):
    sr_a = 44100
    sr_b = 48000
    t_a = np.arange(sr_a, dtype=np.float32) / sr_a
    t_b = np.arange(sr_b, dtype=np.float32) / sr_b
    a = tmp_path / "a.wav"
    b = tmp_path / "b.wav"
    sf.write(str(a), (0.5 * np.sin(2 * np.pi * 440 * t_a)).astype(np.float32), sr_a)
    sf.write(str(b), (0.5 * np.sin(2 * np.pi * 440 * t_b)).astype(np.float32), sr_b)
    out = tmp_path / "mix.wav"

    with pytest.raises(ValueError, match="sr="):
        mix_clips([a, b], [1.0, 1.0], out)


def test_mix_single_clip_still_works(tmp_path: Path):
    a = _write_sine(tmp_path, 440.0, 1.0)
    out = tmp_path / "mix.wav"

    result = mix_clips([a], [1.0], out)

    assert result["num_clips"] == 1
    assert Path(result["output_path"]).exists()


def test_mix_weights_length_mismatch_raises(tmp_path: Path):
    a = _write_sine(tmp_path, 440.0, 1.0)
    with pytest.raises(ValueError, match="weights length"):
        mix_clips([a], [1.0, 1.0], tmp_path / "mix.wav")


def test_mix_clip_window_slices_audio(tmp_path: Path):
    a = _write_sine(tmp_path, 440.0, 3.0)
    out = tmp_path / "mix.wav"

    # Take only the middle second
    result = mix_clips([a], [1.0], out, clip_windows=[(1.0, 2.0)])

    assert result["duration_sec"] == pytest.approx(1.0, abs=0.01)


def test_mix_clip_window_none_uses_full_clip(tmp_path: Path):
    a = _write_sine(tmp_path, 440.0, 2.0)
    out = tmp_path / "mix.wav"

    result = mix_clips([a], [1.0], out, clip_windows=[None])

    assert result["duration_sec"] == pytest.approx(2.0, abs=0.01)


def test_mix_clip_windows_length_mismatch_raises(tmp_path: Path):
    a = _write_sine(tmp_path, 440.0, 1.0)
    with pytest.raises(ValueError, match="clip_windows length"):
        mix_clips([a], [1.0], tmp_path / "mix.wav", clip_windows=[None, (0.0, 0.5)])


def test_mix_mix_offsets_extends_output(tmp_path: Path):
    a = _write_sine(tmp_path, 440.0, 1.0)
    b = _write_sine(tmp_path, 880.0, 1.0)
    out = tmp_path / "mix.wav"

    result = mix_clips([a, b], [1.0, 1.0], out, mix_offsets_sec=[0.0, 2.0])

    # Clip b starts at t=2, runs for 1s, so output is 3s.
    assert result["duration_sec"] == pytest.approx(3.0, abs=0.01)


def test_mix_loop_to_sec_tiles_short_clip(tmp_path: Path):
    a = _write_sine(tmp_path, 440.0, 1.0)
    out = tmp_path / "mix.wav"

    result = mix_clips([a], [1.0], out, loop_to_sec=[5.0])

    assert result["duration_sec"] == pytest.approx(5.0, abs=0.01)
    # Mid-output should still have audible content — looped, not silent.
    mixed, sr = sf.read(str(out), dtype="float32")
    mono = mixed[:, 0] if mixed.ndim == 2 else mixed
    tail = mono[int(4.0 * sr) : int(5.0 * sr)]
    tail_rms = float(np.sqrt(np.mean(tail * tail)))
    assert tail_rms > 0.05, f"looped clip tail should be audible, got rms={tail_rms}"


def test_mix_master_fade_in_smooths_start(tmp_path: Path):
    a = _write_sine(tmp_path, 440.0, 2.0)
    out = tmp_path / "mix.wav"
    sr = 44100

    mix_clips([a], [1.0], out, master_fade_in_sec=0.5)

    audio, _ = sf.read(str(out), dtype="float32")
    mono = audio[:, 0] if audio.ndim == 2 else audio
    # First 10ms RMS should be near zero (faded in)
    head = mono[: int(0.01 * sr)]
    head_rms = float(np.sqrt(np.mean(head * head)))
    # Mid-clip RMS should be much larger
    mid = mono[int(1.0 * sr) : int(1.1 * sr)]
    mid_rms = float(np.sqrt(np.mean(mid * mid)))
    assert head_rms < mid_rms * 0.2, (
        f"fade-in didn't take: head={head_rms}, mid={mid_rms}"
    )


def test_mix_master_fade_out_smooths_end(tmp_path: Path):
    a = _write_sine(tmp_path, 440.0, 2.0)
    out = tmp_path / "mix.wav"
    sr = 44100

    mix_clips([a], [1.0], out, master_fade_out_sec=0.5)

    audio, _ = sf.read(str(out), dtype="float32")
    mono = audio[:, 0] if audio.ndim == 2 else audio
    tail = mono[-int(0.01 * sr) :]
    tail_rms = float(np.sqrt(np.mean(tail * tail)))
    mid = mono[int(1.0 * sr) : int(1.1 * sr)]
    mid_rms = float(np.sqrt(np.mean(mid * mid)))
    assert tail_rms < mid_rms * 0.2, (
        f"fade-out didn't take: tail={tail_rms}, mid={mid_rms}"
    )


def test_mix_loop_then_offset_combines(tmp_path: Path):
    a = _write_sine(tmp_path, 440.0, 1.0)
    b = _write_sine(tmp_path, 880.0, 1.0)
    out = tmp_path / "mix.wav"

    result = mix_clips(
        [a, b],
        [1.0, 1.0],
        out,
        mix_offsets_sec=[0.0, 2.0],
        loop_to_sec=[3.0, 3.0],
    )

    # Clip a: looped to 3s starting at 0 → ends at 3
    # Clip b: looped to 3s starting at 2 → ends at 5
    assert result["duration_sec"] == pytest.approx(5.0, abs=0.01)
