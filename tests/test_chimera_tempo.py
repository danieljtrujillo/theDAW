"""Unit tests for backend.modules.chimera.tempo (pure math, no audio)."""

from __future__ import annotations

import numpy as np
import pytest

from backend.modules.chimera.tempo import (
    BEATS_PER_BAR,
    bar_duration_sec,
    choose_octave,
    fit_beat_grid,
    fit_tempo_to_duration,
    fold_bpm,
    rebuild_beats,
    resolve_target_bpm_v2,
)
from tests.chimera_synth import beat_times


def test_reexports_from_weave():
    assert BEATS_PER_BAR == 4
    assert bar_duration_sec(120.0) == pytest.approx(2.0)


def test_fold_bpm_octaves():
    assert fold_bpm(60.0) == pytest.approx(120.0)
    assert fold_bpm(200.0) == pytest.approx(100.0)
    assert fold_bpm(100.0) == pytest.approx(100.0)
    assert fold_bpm(30.0) == pytest.approx(120.0)
    assert fold_bpm(160.0) == pytest.approx(80.0)


def test_choose_octave_half_time():
    assert choose_octave(70.0, 140.0) == (2.0, pytest.approx(1.0))
    assert choose_octave(200.0, 100.0) == (0.5, pytest.approx(1.0))
    m, ratio = choose_octave(100.0, 128.0)
    assert m == 1.0
    assert ratio == pytest.approx(1.28)


def test_choose_octave_ties_prefer_unity():
    # 100 -> 141.42 is exactly halfway (in log space) between m=1 and m=2
    m, _ = choose_octave(100.0, 100.0 * 2**0.5)
    assert m == 1.0


def test_rebuild_beats_double_inserts_midpoints():
    period = 60.0 / 70.0
    beats = [i * period for i in range(8)]
    out = rebuild_beats(beats, 2.0)
    assert len(out) == 16
    spacing = np.diff(out)
    assert np.allclose(spacing, 60.0 / 140.0, atol=1e-9)
    assert out[0] == pytest.approx(beats[0])
    assert out[-1] == pytest.approx(beats[-1] + period / 2.0)


def test_rebuild_beats_half_keeps_phase_with_larger_onset():
    beats = [i * 0.3 for i in range(10)]
    odd = set(beats[1::2])

    def onset(t: float) -> float:
        return 1.0 if t in odd else 0.1

    assert rebuild_beats(beats, 0.5, onset) == beats[1::2]
    assert rebuild_beats(beats, 0.5, None) == beats[0::2]
    assert rebuild_beats(beats, 1.0) == beats
    with pytest.raises(ValueError):
        rebuild_beats(beats, 3.0)


def test_resolve_target_median_ignores_octave_errors():
    bpm, source = resolve_target_bpm_v2(None, None, [70.0, 140.0, 138.0], [1, 1, 1])
    assert source == "median"
    assert 138.0 <= bpm <= 140.0


def test_resolve_target_median_is_weighted():
    bpm, source = resolve_target_bpm_v2(None, None, [100.0, 130.0], [1.0, 3.0])
    assert source == "median"
    assert bpm == pytest.approx(130.0)
    # weights clamp at 0.05, never negative
    bpm, _ = resolve_target_bpm_v2(None, None, [100.0, 130.0], [-5.0, 1.0])
    assert bpm == pytest.approx(130.0)


def test_resolve_base_and_user_paths():
    assert resolve_target_bpm_v2(None, 1, [70.0, 141.0], [1, 1]) == (141.0, "base_clip")
    assert resolve_target_bpm_v2(99.0, None, [70.0, 141.0], [1, 1]) == (99.0, "user")
    # base wins over user
    assert resolve_target_bpm_v2(99.0, 0, [70.0, 141.0], [1, 1]) == (70.0, "base_clip")
    with pytest.raises(ValueError):
        resolve_target_bpm_v2(None, 0, [None, 141.0], [1, 1])
    with pytest.raises(ValueError):
        resolve_target_bpm_v2(None, 5, [120.0], [1])
    assert resolve_target_bpm_v2(None, None, [None, None], [1, 1]) == (
        120.0,
        "fallback",
    )


def _dirty_beats(
    jitter_ms: float, drop_pct: float = 5.0, spurious: int = 3, seed: int = 7
) -> tuple[list[float], list[float], float]:
    rng = np.random.default_rng(seed)
    clean = beat_times(120.0, 16, lead_in_sec=0.0)  # 64 beats at 0.5 s
    period = 0.5
    n_drop = int(round(len(clean) * drop_pct / 100.0))
    drop = set(rng.choice(len(clean) - 2, size=n_drop, replace=False) + 1)
    kept = [t for i, t in enumerate(clean) if i not in drop]
    jittered = [t + rng.uniform(-jitter_ms, jitter_ms) / 1000.0 for t in kept]
    # spurious onsets sit well off the grid (0.3 .. 0.4 of a period late)
    extra = [
        clean[int(i)] + period * float(rng.uniform(0.3, 0.4))
        for i in rng.choice(len(clean) - 1, size=spurious, replace=False)
    ]
    return sorted(jittered + extra), extra, period


def test_fit_beat_grid_recovers_period_and_phase():
    beats, extra, period = _dirty_beats(jitter_ms=4.0)
    grid = fit_beat_grid(beats, 120.0)
    assert grid["period_sec"] == pytest.approx(period, rel=0.002)
    phase_err = (grid["phase_sec"] + period / 2.0) % period - period / 2.0
    assert abs(phase_err) < 0.005
    assert grid["steady"] is True
    assert grid["confidence"] > 0.9
    assert grid["drift_pct"] < 0.2
    for t in extra:
        assert t not in grid["kept_beats"]
    assert len(grid["kept_beats"]) == len(beats) - len(extra)


def test_fit_beat_grid_flags_unsteady():
    # +/-75 ms uniform jitter = 15% of the 500 ms period -> cv ~ 0.12
    beats, _, _ = _dirty_beats(jitter_ms=75.0)
    grid = fit_beat_grid(beats, 120.0)
    assert grid["steady"] is False
    assert grid["cv"] > 0.08
    assert grid["confidence"] < 0.92


def test_fit_beat_grid_reports_drift_against_nominal():
    beats = beat_times(120.0, 16, tempo_drift_pct=4.0)
    grid = fit_beat_grid(beats, 120.0)
    # average period over a 0..4% ramp is ~2% above nominal
    assert 1.0 < grid["drift_pct"] < 3.5


def test_fit_beat_grid_short_list_low_confidence():
    grid = fit_beat_grid([0.0, 0.5, 1.0, 1.5], 120.0)
    assert grid["confidence"] == 0.0
    assert grid["steady"] is False
    assert grid["kept_beats"] == [0.0, 0.5, 1.0, 1.5]
    assert grid["period_sec"] == pytest.approx(0.5)
    assert grid["phase_sec"] == pytest.approx(0.0)
    empty = fit_beat_grid([], None)
    assert empty["period_sec"] == pytest.approx(0.5)
    assert empty["kept_beats"] == []


def test_fit_tempo_to_duration_exact():
    bpm, bars, pct = fit_tempo_to_duration(120.0, 110.0)
    assert (bpm, bars, pct) == (pytest.approx(120.0), 55, pytest.approx(0.0))
    bpm, bars, pct = fit_tempo_to_duration(120.0, 111.0)
    assert bars == 56
    assert bpm == pytest.approx(121.08, abs=0.01)
    assert pct == pytest.approx(0.9, abs=0.01)


def test_fit_tempo_respects_max_pct():
    # 100.6 s at 120 BPM is 50.3 bars; rounding to 50 needs a -0.6% nudge,
    # which a 0.5% budget refuses -> keep the tempo, floor the bars.
    assert fit_tempo_to_duration(120.0, 100.6, max_pct=0.5) == (120.0, 50, 0.0)
    # 9 s at 120 BPM is 4.5 bars; rounding up needs +11% -> floor to 4, pct 0
    assert fit_tempo_to_duration(120.0, 9.0) == (120.0, 4, 0.0)
    # never fewer than 4 bars
    assert fit_tempo_to_duration(120.0, 3.0)[1] == 4
