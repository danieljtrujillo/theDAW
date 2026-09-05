"""Unit tests for backend.modules.chimera.structure on synthetic tracks.

Every signal comes from tests/chimera_synth.py (deterministic, CPU-only);
the beat grid is fitted from the generator's exact beat times with
tempo.fit_beat_grid, so the structure code sees the same SOURCE grid the
router would hand it. Audio is rendered at 44.1 kHz and resampled to the
22.05 kHz mono the analysis stage works on.
"""

from __future__ import annotations

from functools import lru_cache

import librosa
import numpy as np
import pytest

from backend.modules.chimera import structure as st
from backend.modules.chimera.tempo import fit_beat_grid
from backend.modules.chimera.types import BarFeature, BeatGrid
from tests.chimera_synth import beat_times, click_track, synth_track

SR = 22050
BPM = 120.0
BAR_SEC = 2.0


def _to_analysis_rate(stereo: np.ndarray) -> np.ndarray:
    mono = stereo.mean(axis=1)
    return librosa.resample(mono, orig_sr=44100, target_sr=SR).astype(np.float32)


@lru_cache(maxsize=None)
def _track(
    bars: int,
    downbeat_phase: int = 0,
    phrase_phase: int = 0,
    lead_in_sec: float = 0.0,
    levels: tuple[tuple[int, float], ...] | None = None,
) -> tuple[np.ndarray, BeatGrid]:
    y = synth_track(
        BPM,
        bars,
        downbeat_phase=downbeat_phase,
        phrase_phase=phrase_phase,
        lead_in_sec=lead_in_sec,
        section_levels=list(levels) if levels is not None else None,
    )
    grid = fit_beat_grid(beat_times(BPM, bars, lead_in_sec), BPM)
    return _to_analysis_rate(y), grid


def _fake_bars(n: int, bar_sec: float = BAR_SEC) -> list[BarFeature]:
    return [
        {
            "bar": i,
            "start_sec": i * bar_sec,
            "rms_db": -20.0,
            "low_frac": 0.5,
            "onset_density": 1.0,
            "centroid_hz": 1000.0,
            "chroma": [1.0] + [0.0] * 11,
            "mfcc": [-100.0] + [0.0] * 12,
        }
        for i in range(n)
    ]


# --------------------------------------------------------------------------
# beat grid -> beat times
# --------------------------------------------------------------------------


def test_beat_frames_from_grid_synthesises_exact_grid():
    grid = fit_beat_grid(beat_times(BPM, 8, 1.3), BPM)
    n = int(SR * (1.3 + 8 * BAR_SEC))
    times, frames = st.beat_frames_from_grid(grid, n, SR)
    assert times.size == 32
    assert times[0] == pytest.approx(1.3, abs=1e-6)
    assert np.allclose(np.diff(times), 0.5, atol=1e-6)
    assert frames.dtype.kind == "i"
    assert np.all(np.diff(frames) > 0)
    assert times[-1] < n / SR


def test_beat_frames_from_grid_uses_kept_beats_when_unsure():
    kept = [0.1, 0.62, 1.05, 1.61, 2.0, 2.49, 3.02, 3.5]
    grid: BeatGrid = {
        "period_sec": 0.5,
        "phase_sec": 0.1,
        "drift_pct": 0.0,
        "cv": 0.8,
        "confidence": 0.2,
        "kept_beats": kept + [99.0],
        "steady": False,
    }
    times, frames = st.beat_frames_from_grid(grid, SR * 4, SR)
    assert times.tolist() == kept  # the out-of-range beat is dropped
    assert frames.size == len(kept)


# --------------------------------------------------------------------------
# downbeat phase
# --------------------------------------------------------------------------


@pytest.mark.parametrize("p", [0, 1, 2, 3])
def test_downbeat_phase_recovered(p: int):
    y, grid = _track(48, downbeat_phase=p, lead_in_sec=1.3)
    times, frames = st.beat_frames_from_grid(grid, len(y), SR)
    assert times.size == 192
    feats = st.beat_features(y, SR, frames)
    assert feats["low"].shape == (192,)
    assert feats["chroma"].shape == (12, 192)
    assert feats["mfcc"].shape == (13, 192)
    phase, conf = st.estimate_downbeat_phase(feats)
    assert phase == p
    assert conf > 0.2

    res = st.analyze_structure(y, SR, grid, 8)
    assert res["downbeat_phase"] == p
    assert res["downbeat_confidence"] == pytest.approx(conf)
    assert res["beat_times"] == pytest.approx(times.tolist())


def test_downbeat_confidence_low_on_flat_click_track():
    y = click_track(BPM, 40.0, sr=SR)  # identical click every beat, no accents
    grid = fit_beat_grid([0.5 * k for k in range(80)], BPM)
    times, frames = st.beat_frames_from_grid(grid, len(y), SR)
    _phase, conf = st.estimate_downbeat_phase(st.beat_features(y, SR, frames))
    assert conf < 0.15

    res = st.analyze_structure(y, SR, grid, 8)
    assert res["downbeat_phase"] == 0  # gated
    assert res["downbeat_confidence"] < 0.15


def test_downbeat_found_on_accented_click_track():
    y = click_track(BPM, 40.0, sr=SR, accent_every=4)
    grid = fit_beat_grid([0.5 * k for k in range(80)], BPM)
    _times, frames = st.beat_frames_from_grid(grid, len(y), SR)
    phase, conf = st.estimate_downbeat_phase(st.beat_features(y, SR, frames))
    assert phase == 0
    assert conf > 0.2


def test_downbeat_phase_too_few_beats_is_neutral():
    y, grid = _track(1)
    _times, frames = st.beat_frames_from_grid(grid, len(y), SR)
    assert st.estimate_downbeat_phase(st.beat_features(y, SR, frames)) == (0, 0.0)


# --------------------------------------------------------------------------
# phrase phase
# --------------------------------------------------------------------------


@pytest.mark.parametrize("q", [0, 3, 5])
def test_phrase_phase_recovered(q: int):
    # chord changes every 8 bars from bar q, and the section levels step on
    # the same phrase boundaries (as sections do in real arrangements)
    levels = ((q, 0.3), (q + 16, 0.6), (q + 32, 1.0))
    y, grid = _track(48, phrase_phase=q, levels=levels)
    res = st.analyze_structure(y, SR, grid, 8)
    assert len(res["bars"]) == 48
    assert res["phrase_phase"] == q
    assert res["phrase_confidence"] > 0.5


def test_phrase_phase_needs_two_phrases():
    assert st.estimate_phrase_phase(_fake_bars(15), 8) == (0, 0.0)
    assert st.estimate_phrase_phase(_fake_bars(16), 0) == (0, 0.0)


# --------------------------------------------------------------------------
# bar table
# --------------------------------------------------------------------------


def test_bar_features_count_and_low_frac():
    # first 24 bars kick only, last 24 bars kick + hats + pad, one grid
    kick_only = synth_track(BPM, 24, hats=False, pad=False, section_levels=[(0, 1.0)])
    full = synth_track(BPM, 24, hats=True, pad=True, section_levels=[(0, 1.0)])
    y = _to_analysis_rate(np.concatenate([kick_only, full]))
    grid = fit_beat_grid(beat_times(BPM, 48), BPM)
    res = st.analyze_structure(y, SR, grid, 8)
    bars = res["bars"]
    assert len(bars) == 48
    assert [b["bar"] for b in bars] == list(range(48))
    assert [b["start_sec"] for b in bars] == pytest.approx(
        [i * BAR_SEC for i in range(48)], abs=1e-6
    )
    for b in bars:
        assert len(b["chroma"]) == 12
        assert len(b["mfcc"]) == 13
        assert 0.0 <= b["low_frac"] <= 1.0
        assert b["onset_density"] >= 0.0
        assert b["centroid_hz"] > 0.0
        assert np.isfinite(b["rms_db"])
    low_kick = [b["low_frac"] for b in bars[:24]]
    low_full = [b["low_frac"] for b in bars[24:]]
    assert min(low_kick) > max(low_full)
    # hats double the onset count per beat
    dens_kick = np.mean([b["onset_density"] for b in bars[:24]])
    dens_full = np.mean([b["onset_density"] for b in bars[24:]])
    assert dens_full > dens_kick
    # the kick-only half also has a lower centroid
    assert np.mean([b["centroid_hz"] for b in bars[:24]]) < np.mean(
        [b["centroid_hz"] for b in bars[24:]]
    )


def test_bar_features_honour_downbeat_phase():
    y, grid = _track(8, downbeat_phase=2)
    times, frames = st.beat_frames_from_grid(grid, len(y), SR)
    feats = st.beat_features(y, SR, frames)
    bars = st.bar_features(y, SR, feats, times, 2)
    assert len(bars) == 7  # beats 0-1 are an anacrusis, beats 30-31 a tail
    assert bars[0]["start_sec"] == pytest.approx(times[2])
    assert st.bar_features(y, SR, feats, times, 0)[0]["start_sec"] == pytest.approx(0.0)


# --------------------------------------------------------------------------
# phrase table
# --------------------------------------------------------------------------


def test_build_phrases_covers_clip_without_overlap():
    phrases = st.build_phrases(_fake_bars(44), 0, 8)
    assert [p["bars"] for p in phrases] == [8, 8, 8, 8, 8, 4]
    assert [p["idx"] for p in phrases] == list(range(6))
    assert phrases[0]["start_sec"] == 0.0
    assert phrases[-1]["end_sec"] == pytest.approx(44 * BAR_SEC)
    for a, b in zip(phrases, phrases[1:]):
        assert b["start_sec"] == pytest.approx(a["end_sec"])
        assert b["start_bar"] == a["start_bar"] + a["bars"]
    for p in phrases:
        assert p["bars"] >= 4
        assert p["end_sec"] - p["start_sec"] == pytest.approx(p["bars"] * BAR_SEC)
        assert p["energy"] == 0.0
        assert p["lufs"] == pytest.approx(-20.0)  # rms fallback without audio


def test_build_phrases_remainders():
    # leading remainder >= 4 bars becomes phrase 0; trailing < 4 dropped
    p5 = st.build_phrases(_fake_bars(48), 5, 8)
    assert [p["bars"] for p in p5] == [5, 8, 8, 8, 8, 8]
    assert p5[0]["start_bar"] == 0
    assert p5[1]["start_bar"] == 5
    # leading remainder < 4 dropped; trailing remainder >= 4 kept
    p3 = st.build_phrases(_fake_bars(48), 3, 8)
    assert [p["bars"] for p in p3] == [8, 8, 8, 8, 8, 5]
    assert p3[0]["start_bar"] == 3
    assert p3[0]["start_sec"] == pytest.approx(3 * BAR_SEC)
    # a clip shorter than one phrase still yields one phrase
    short = st.build_phrases(_fake_bars(3), 0, 8)
    assert len(short) == 1 and short[0]["bars"] == 3
    assert st.build_phrases([], 0, 8) == []


def test_phrase_energy_orders_with_section_levels():
    y, grid = _track(48)  # default levels .3 / .6 / 1.0 at bars 0 / 16 / 32
    res = st.analyze_structure(y, SR, grid, 8)
    phrases = st.build_phrases(res["bars"], res["phrase_phase"], 8, y=y, sr=SR)
    assert len(phrases) == 6
    labels = [p["section_label"] for p in phrases]
    assert labels[0] == "intro"
    assert labels.count("peak") == 1
    peak = next(p for p in phrases if p["section_label"] == "peak")
    assert peak["lufs"] - phrases[0]["lufs"] > 6.0
    lufs = [p["lufs"] for p in phrases]
    # levels only ever rise in this track (chord content wobbles ~0.1 dB)
    assert all(b >= a - 0.5 for a, b in zip(lufs, lufs[1:]))
    assert set(labels) <= {"intro", "build", "peak", "body", "outro"}
    # pyloudnorm path: integrated loudness differs from the rms fallback
    no_audio = st.build_phrases(res["bars"], res["phrase_phase"], 8)
    assert all(np.isfinite(p["lufs"]) for p in no_audio)


# --------------------------------------------------------------------------
# orchestration
# --------------------------------------------------------------------------


def test_analyze_structure_never_raises_on_silence():
    y = np.zeros(SR * 10, dtype=np.float32)
    res = st.analyze_structure(y, SR, fit_beat_grid([], None), 8)
    assert res["downbeat_phase"] == 0 and res["downbeat_confidence"] == 0.0
    assert res["phrase_phase"] == 0 and res["phrase_confidence"] == 0.0
    assert res["bars"] == [] and res["beat_times"] == []

    # silence with a confident grid still yields a plain bar table
    res2 = st.analyze_structure(y, SR, fit_beat_grid(beat_times(BPM, 5), BPM), 8)
    assert len(res2["bars"]) == 5
    assert res2["downbeat_phase"] == 0
    assert all(np.isfinite(b["rms_db"]) for b in res2["bars"])

    # stereo input and an empty array are tolerated too
    stereo = np.zeros((SR * 4, 2), dtype=np.float32)
    assert st.analyze_structure(stereo, SR, fit_beat_grid([], None), 8)["bars"] == []
    assert (
        st.analyze_structure(np.zeros(0, np.float32), SR, fit_beat_grid([], None), 8)[
            "bars"
        ]
        == []
    )


def test_analyze_structure_falls_back_when_features_fail(monkeypatch):
    y, grid = _track(8)

    def boom(*_a, **_k):
        raise RuntimeError("synthetic failure")

    monkeypatch.setattr(st, "beat_features", boom)
    res = st.analyze_structure(y, SR, grid, 8)
    assert res["downbeat_confidence"] == 0.0
    assert len(res["bars"]) == 8  # plain 4-beat grouping
    assert res["bars"][0]["chroma"] == [0.0] * 12
    assert len(res["beat_times"]) == 32
