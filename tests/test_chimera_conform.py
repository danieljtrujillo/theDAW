"""Unit tests for backend.modules.chimera.conform.

``plan_conform``, ``lock_to_grid`` and ``beats_stretched`` are pure numpy and
run everywhere. ``render_run`` / ``conform_run`` spawn ffmpeg and are gated on
``probe()`` (ffmpeg + librubberband; the pitch test also needs
``rubberband_pitch``). All signals come from ``tests/chimera_synth.py``.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from backend.modules.chimera.config import probe
from backend.modules.chimera.conform import (
    MARGIN_BARS,
    beats_stretched,
    conform_run,
    lock_to_grid,
    plan_conform,
    render_run,
)
from tests.chimera_synth import click_track, fft_peak_hz, write_wav

_TOOLS = probe()
_FFMPEG = bool(_TOOLS["ffmpeg"])
_RUBBERBAND = _FFMPEG and bool(_TOOLS["librubberband"])
_RUBBERBAND_PITCH = _RUBBERBAND and bool(_TOOLS.get("rubberband_pitch"))

SR = 44100


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------


def _analysis(
    bpm: float | None,
    percussive_ratio: float = 0.5,
    grid: dict | None = None,
    beats: list[float] | None = None,
) -> dict:
    """Minimal ClipAnalysis-shaped dict (only the keys conform.py reads)."""
    return {
        "bpm": bpm,
        "beats": beats or [],
        "percussive_ratio": percussive_ratio,
        "grid": grid,
    }


def _grid(
    kept_beats: list[float], confidence: float = 0.9, steady: bool = True
) -> dict:
    return {
        "period_sec": 0.5,
        "phase_sec": kept_beats[0] if kept_beats else 0.0,
        "drift_pct": 0.0,
        "cv": 1.0 - confidence,
        "confidence": confidence,
        "kept_beats": kept_beats,
        "steady": steady,
    }


def _click_onsets(
    audio: np.ndarray, sr: int, thr: float = 1e-3, gap: int = 64
) -> np.ndarray:
    """Onset times (s) of every click: first sample above ``thr`` after at
    least ``gap`` quiet samples. Exact to the sample on the synthetic clicks
    (the generator writes silence between bursts, and a cubic Hermite of
    zeros is exactly zero)."""
    mono = audio if audio.ndim == 1 else audio.mean(axis=1)
    idx = np.flatnonzero(np.abs(mono) > thr)
    if idx.size == 0:
        return np.zeros(0)
    keep = np.concatenate(([True], np.diff(idx) > gap))
    return idx[keep] / float(sr)


def _sine(
    freq_hz: float, duration_sec: float, sr: int = SR, amp: float = 0.5
) -> np.ndarray:
    t = np.arange(int(duration_sec * sr), dtype=np.float64) / sr
    mono = (amp * np.sin(2.0 * np.pi * freq_hz * t)).astype(np.float32)
    return np.stack([mono, mono], axis=1)


# --------------------------------------------------------------------------
# plan_conform
# --------------------------------------------------------------------------


def test_plan_conform_presets():
    perc = plan_conform(_analysis(120.0, percussive_ratio=0.8), 120.0, 0)
    assert perc["preset"] == "percussive"
    assert perc["rb_options"] == {
        "transients": "crisp",
        "detector": "percussive",
        "window": "short",
    }

    tonal = plan_conform(_analysis(120.0, percussive_ratio=0.1), 120.0, 0)
    assert tonal["preset"] == "tonal"
    assert tonal["rb_options"] == {
        "transients": "smooth",
        "detector": "soft",
        "window": "long",
        "smoothing": "on",
    }

    default = plan_conform(_analysis(120.0, percussive_ratio=0.45), 120.0, 0)
    assert default["preset"] == "default"
    assert default["rb_options"] == {"transients": "mixed", "detector": "compound"}

    # 70 BPM clip against a 140 target: double-time octave, no stretch.
    half = plan_conform(_analysis(70.0), 140.0, 0)
    assert half["tempo_multiplier"] == 2.0
    assert half["ratio"] == pytest.approx(1.0)
    assert half["note"] is None

    # plain ratio
    plain = plan_conform(_analysis(100.0), 125.0, 0)
    assert plain["tempo_multiplier"] == 1.0
    assert plain["ratio"] == pytest.approx(1.25)


def test_plan_conform_no_bpm_and_clamp():
    none = plan_conform(_analysis(None), 120.0, 0)
    assert none["ratio"] == 1.0
    assert none["tempo_multiplier"] == 1.0
    assert none["note"] == "no BPM; not stretched"
    assert none["lock"] is False

    # choose_octave folds first (120 vs 30 -> m 0.5, ratio 0.5: in range),
    # so only a target beyond a factor of 4 needs the clamp
    edge = plan_conform(_analysis(120.0), 30.0, 0)
    assert edge["ratio"] == pytest.approx(0.5)
    assert edge["note"] is None
    wild = plan_conform(_analysis(120.0), 20.0, 0)
    assert wild["ratio"] == 0.5
    assert wild["note"] is not None and "clamped" in wild["note"]


def test_plan_conform_formant_and_lock_rules():
    no_shift = plan_conform(_analysis(120.0), 120.0, 0, is_layer_source=True)
    assert "formant" not in no_shift["rb_options"]

    full_shift = plan_conform(_analysis(120.0), 120.0, 2, is_layer_source=False)
    assert "formant" not in full_shift["rb_options"]
    assert full_shift["semitones"] == 2

    layer_shift = plan_conform(_analysis(120.0), 120.0, -1, is_layer_source=True)
    assert layer_shift["rb_options"]["formant"] == "preserved"

    beats = [0.5 * k for k in range(16)]
    good = _analysis(120.0, grid=_grid(beats, confidence=0.9, steady=True))
    assert plan_conform(good, 120.0, 0)["lock"] is True
    assert plan_conform(good, 120.0, 0, grid_lock="off")["lock"] is False
    weak = _analysis(120.0, grid=_grid(beats, confidence=0.4, steady=True))
    assert plan_conform(weak, 120.0, 0)["lock"] is False
    wobbly = _analysis(120.0, grid=_grid(beats, confidence=0.9, steady=False))
    assert plan_conform(wobbly, 120.0, 0)["lock"] is False


# --------------------------------------------------------------------------
# lock_to_grid (pure numpy)
# --------------------------------------------------------------------------


def test_lock_to_grid_lands_beats():
    # 1.0 % tempo drift (needs ~1 % of rate correction at the tail, inside
    # the 1.5 % cap) plus 1 ms per-beat jitter at beat-tracker-noise scale.
    audio = click_track(120.0, 30.0, SR, tempo_drift_pct=1.0, jitter_ms=1.0, seed=7)
    stereo = np.stack([audio, audio], axis=1)
    onsets_in = _click_onsets(stereo, SR)
    assert onsets_in.size == 60
    # Sanity: the raw clicks really do drift off the 0.5 s grid.
    raw_err = np.abs(onsets_in - np.round(onsets_in / 0.5) * 0.5)
    assert raw_err.max() > 0.1

    locked, report = lock_to_grid(stereo, SR, list(onsets_in), 0.5, 0.0)
    assert report["applied"] is True
    assert report["n_beats"] == 60
    assert report["max_rate_dev_used"] <= 0.015 + 1e-9
    assert report["max_rate_dev_used"] >= 0.005  # the drift was actually corrected
    assert report["intervals_clipped"] == 0

    onsets_out = _click_onsets(locked, SR)
    assert onsets_out.size == 60
    k = np.round(onsets_out / 0.5)
    err_ms = np.abs(onsets_out - k * 0.5) * 1000.0
    assert err_ms.max() < 3.0, f"max landing error {err_ms.max():.2f} ms"
    # every grid line 0..59 is hit exactly once
    assert np.array_equal(np.sort(k.astype(int)), np.arange(60))
    # the run got shorter by the accumulated drift (~0.15 s), nothing wilder
    assert -250.0 < report["length_delta_ms"] < -50.0


def test_lock_to_grid_identity_when_on_grid():
    audio = click_track(120.0, 10.0, SR)
    stereo = np.stack([audio, audio], axis=1)
    rng = np.random.default_rng(3)
    beats = [0.5 * k + float(rng.uniform(-0.001, 0.001)) for k in range(20)]
    out, report = lock_to_grid(stereo, SR, beats, 0.5, 0.0)
    assert report["applied"] is False
    assert report["reason"] == "already on grid"
    assert out is stereo
    assert np.array_equal(out, stereo)


def test_lock_to_grid_skips_on_large_residual():
    audio = click_track(120.0, 10.0, SR)
    stereo = np.stack([audio, audio], axis=1)
    beats = [0.5 * k + 0.1 for k in range(20)]  # 100 ms off every grid line
    out, report = lock_to_grid(stereo, SR, beats, 0.5, 0.0)
    assert report["applied"] is False
    assert "residual" in report["reason"]
    assert report["median_residual_ms"] == pytest.approx(100.0, abs=0.5)
    assert out is stereo

    # too few beats also skips
    few, report2 = lock_to_grid(stereo, SR, [0.0, 0.52, 1.0, 1.55], 0.5, 0.0)
    assert report2["applied"] is False
    assert "too few" in report2["reason"]
    assert few is stereo


def test_lock_preserves_pitch():
    audio = _sine(440.0, 30.0)
    rng = np.random.default_rng(11)
    beats = [0.5 * k + float(rng.uniform(-0.006, 0.006)) for k in range(60)]
    locked, report = lock_to_grid(audio, SR, beats, 0.5, 0.0)
    assert report["applied"] is True
    assert report["max_rate_dev_used"] <= 0.015 + 1e-9
    peak = fft_peak_hz(locked, SR)
    assert abs(peak - 440.0) / 440.0 < 0.003, f"peak {peak:.3f} Hz"
    # a mild resampler: no clipping, level intact
    assert np.abs(locked).max() <= 0.5 * 1.02
    assert abs(locked.shape[0] - audio.shape[0]) < SR * 0.02


def test_lock_to_grid_origin_is_exact():
    """The beat nearest ``origin_sec`` lands exactly on it, so a run's
    phrase start stays where the schedule put it."""
    audio = click_track(120.0, 20.0, SR, tempo_drift_pct=1.0)
    stereo = np.stack([audio, audio], axis=1)
    onsets = _click_onsets(stereo, SR)
    origin = float(onsets[20])  # pretend beat 20 is the phrase start
    # grid anchored so that origin is k*0.5 for k=20 -> grid origin 20*0.5
    grid_origin = 10.0
    locked, report = lock_to_grid(stereo, SR, list(onsets), 0.5, grid_origin)
    assert report["applied"] is True
    out = _click_onsets(locked, SR)
    nearest = out[np.argmin(np.abs(out - grid_origin))]
    assert abs(nearest - grid_origin) * 1000.0 < 1.0
    assert origin != grid_origin  # it really moved


# --------------------------------------------------------------------------
# beats_stretched
# --------------------------------------------------------------------------


def test_beats_stretched_on_grid():
    rng = np.random.default_rng(5)
    # 100 BPM clip: beats every 0.6 s with 10 ms tracker noise
    kept = [0.6 * k + float(rng.uniform(-0.01, 0.01)) for k in range(40)]
    a = _analysis(100.0, grid=_grid(kept, confidence=0.9, steady=True))
    plan = plan_conform(a, 120.0, 0)  # ratio 1.2 -> conformed beats every 0.5 s
    assert plan["ratio"] == pytest.approx(1.2)
    assert plan["lock"] is True

    on_grid = beats_stretched(a, plan, 0.5)
    assert len(on_grid) == 40
    for k, t in enumerate(on_grid):
        assert abs(t - k * 0.5) < 1e-9

    unlocked = plan_conform(a, 120.0, 0, grid_lock="off")
    raw = beats_stretched(a, unlocked, 0.5)
    assert raw == pytest.approx([b / 1.2 for b in kept])
    assert any(abs(t - round(t / 0.5) * 0.5) > 1e-4 for t in raw)

    # explicit beats override (e.g. octave-rebuilt list) wins over the grid
    override = beats_stretched(a, plan, 0.5, beats=[0.0, 0.61, 1.19])
    assert override == pytest.approx([0.0, 0.5, 1.0])

    # no grid -> falls back to a.beats
    no_grid = _analysis(100.0, beats=[0.0, 0.6, 1.2])
    p2 = plan_conform(no_grid, 120.0, 0)
    assert p2["lock"] is False
    assert beats_stretched(no_grid, p2, 0.5) == pytest.approx([0.0, 0.5, 1.0])


# --------------------------------------------------------------------------
# render_run / conform_run (ffmpeg)
# --------------------------------------------------------------------------


@pytest.mark.skipif(not _RUBBERBAND, reason="ffmpeg with librubberband missing")
def test_render_run_span_and_ratio(tmp_path: Path):
    src = write_wav(tmp_path, "sine440", _sine(440.0, 10.0), SR)
    plan = plan_conform(_analysis(100.0, percussive_ratio=0.1), 125.0, 0)
    assert plan["ratio"] == pytest.approx(1.25)
    audio, t0, result = render_run(src, tmp_path / "out.wav", plan, 2.0, 6.0, 0.0)
    assert result["engine"] == "rubberband"
    assert result["span_used"] == (2.0, 6.0)
    assert t0 == pytest.approx(2.0 / 1.25)
    assert audio.ndim == 2 and audio.shape[1] == 2
    length = audio.shape[0] / SR
    assert length == pytest.approx(3.2, rel=0.02), f"length {length:.3f}"
    assert abs(fft_peak_hz(audio, SR) - 440.0) / 440.0 < 0.01


@pytest.mark.skipif(not _RUBBERBAND_PITCH, reason="rubberband pitch option missing")
def test_render_run_span_and_pitch(tmp_path: Path):
    src = write_wav(tmp_path, "sine440", _sine(440.0, 10.0), SR)
    plan = plan_conform(_analysis(100.0, percussive_ratio=0.1), 125.0, 2)
    audio, t0, result = render_run(src, tmp_path / "out.wav", plan, 2.0, 6.0, 0.0)
    assert result["engine"] == "rubberband"
    assert result["pitch_semitones_used"] == 2.0
    assert t0 == pytest.approx(1.6)
    length = audio.shape[0] / SR
    assert length == pytest.approx(3.2, rel=0.02), f"length {length:.3f}"
    peak = fft_peak_hz(audio, SR)
    expected = 440.0 * 2 ** (2 / 12)  # 493.88 Hz
    assert abs(peak - expected) / expected < 0.01, f"peak {peak:.2f} Hz"


@pytest.mark.skipif(not _FFMPEG, reason="ffmpeg missing")
def test_conform_run_geometry_and_lock(tmp_path: Path):
    # 120 BPM clicks, 16 s; the run covers SOURCE bars 1..3 (2 s .. 6 s).
    audio = click_track(120.0, 16.0, SR, tempo_drift_pct=0.8)
    src = write_wav(tmp_path, "clicks", np.stack([audio, audio], axis=1), SR)
    onsets = list(_click_onsets(audio, SR))
    a = _analysis(120.0, percussive_ratio=0.9, grid=_grid(onsets))
    plan = plan_conform(a, 120.0, 0)
    assert plan["ratio"] == pytest.approx(1.0)
    assert plan["lock"] is True

    run = {
        "run_id": 3,
        "clip": 0,
        "lane": "lead",
        "role": "full",
        "first_phrase": 0,
        "last_phrase": 0,
        "output_start_sec": 10.0,
        "output_end_sec": 14.0,
        "src_start_sec": 2.0,
        "src_end_sec": 6.0,
        "fade_in_sec": 0.0,
        "fade_out_sec": 0.0,
        "gain_db": 0.0,
    }
    beat_sec = 0.5
    ra = conform_run(src, tmp_path / "work", plan, run, beat_sec, None, onsets, SR)

    assert ra["run_id"] == 3
    assert ra["kind"] == "full"
    assert ra["audio"].ndim == 2 and ra["audio"].shape[1] == 2
    margin = MARGIN_BARS * 4 * beat_sec  # one target bar = 2 s (ratio 1)
    # t0 = output_start - (src_start/ratio - span_start/ratio) = 10 - 2
    assert ra["t0_sec"] == pytest.approx(10.0 - margin)
    # span 0..8 s at ratio 1 -> ~8 s of audio (rubberband/atempo are not
    # sample-exact; grid lock trims the drift)
    length = ra["audio"].shape[0] / SR
    assert length == pytest.approx(8.0, abs=0.25)
    assert ra["lock_report"]["stretch"]["engine"] in ("rubberband", "atempo")
    assert ra["lock_report"]["stretch"]["span_used"] == pytest.approx([0.0, 8.0])
    assert ra["lock_report"]["origin_sec"] == pytest.approx(2.0)
    assert (tmp_path / "work" / "run003_full.wav").exists()

    # lock_report is either applied (drift corrected) or a documented skip
    assert isinstance(ra["locked"], bool)
    assert ra["lock_report"]["n_beats"] >= 8
    if ra["locked"]:
        out = _click_onsets(ra["audio"], SR)
        # the click at the phrase start (SOURCE 2 s -> ARRAY 2 s) is on the grid
        near = out[np.argmin(np.abs(out - 2.0))]
        assert abs(near - 2.0) * 1000.0 < 15.0


@pytest.mark.skipif(not _FFMPEG, reason="ffmpeg missing")
def test_conform_run_lock_off_returns_render_untouched(tmp_path: Path):
    audio = click_track(120.0, 8.0, SR)
    src = write_wav(tmp_path, "clicks", np.stack([audio, audio], axis=1), SR)
    onsets = list(_click_onsets(audio, SR))
    a = _analysis(120.0, grid=_grid(onsets))
    plan = plan_conform(a, 120.0, 0, grid_lock="off")
    run = {
        "run_id": 0,
        "output_start_sec": 0.0,
        "src_start_sec": 0.0,
        "src_end_sec": 4.0,
    }
    ra = conform_run(src, tmp_path / "work", plan, run, 0.5, None, onsets, SR)
    assert ra["locked"] is False
    assert ra["lock_report"]["reason"] == "lock disabled by plan"
    # span start clamps at 0, so no pre-roll: t0 == output_start
    assert ra["t0_sec"] == pytest.approx(0.0)
    assert ra["lock_report"]["stretch"]["span_used"][0] == 0.0
