"""Unit tests for backend.modules.chimera.render and .master.

Sines and noise only: deterministic, CPU-only, no ffmpeg / models.
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from backend.modules.chimera import master, render
from backend.modules.chimera.config import probe
from tests.chimera_synth import band_energy_db, rms_db

SR = 44100


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------


def _sine(freq_hz: float, dur_sec: float, amp: float = 0.5, sr: int = SR) -> np.ndarray:
    t = np.arange(int(round(dur_sec * sr)), dtype=np.float64) / sr
    return (amp * np.sin(2.0 * math.pi * freq_hz * t)).astype(np.float32)


def _stereo(mono: np.ndarray) -> np.ndarray:
    return np.stack([mono, mono], axis=1).astype(np.float32)


def _pink(dur_sec: float, level_db: float, seed: int, sr: int = SR) -> np.ndarray:
    """Stereo pink noise at ``level_db`` dBFS RMS."""
    rng = np.random.default_rng(seed)
    n = int(dur_sec * sr)
    white = rng.standard_normal(n)
    spec = np.fft.rfft(white)
    f = np.fft.rfftfreq(n, 1.0 / sr)
    spec[1:] /= np.sqrt(f[1:])
    spec[0] = 0.0
    x = np.fft.irfft(spec, n)
    x /= np.sqrt(np.mean(x * x))
    x *= 10.0 ** (level_db / 20.0)
    return _stereo(x.astype(np.float32))


def _sched(
    total_sec: float,
    runs: list[dict],
    seams: list[dict] | None = None,
    bar_sec: float = 2.0,
    beat_sec: float = 0.5,
) -> dict:
    return {
        "total_sec": total_sec,
        "total_bars": int(round(total_sec / bar_sec)),
        "bar_sec": bar_sec,
        "beat_sec": beat_sec,
        "phrase_bars": 4,
        "n_slots": len(runs),
        "slot_bars": [4] * len(runs),
        "contour": [0.5] * len(runs),
        "density": [1] * len(runs),
        "lead_by_slot": [0] * len(runs),
        "runs": runs,
        "placements": [],
        "seams": seams or [],
        "sections": [],
        "warnings": [],
    }


def _run(
    run_id: int,
    clip: int,
    lane: str,
    out_start: float,
    out_end: float,
    fade_in: float = 0.0,
    fade_out: float = 0.0,
    role: str | None = None,
    first_phrase: int = 0,
    last_phrase: int = 0,
) -> dict:
    return {
        "run_id": run_id,
        "clip": clip,
        "lane": lane,
        "role": role or ("full" if lane == "lead" else "hp"),
        "first_phrase": first_phrase,
        "last_phrase": last_phrase,
        "output_start_sec": out_start,
        "output_end_sec": out_end,
        "src_start_sec": 0.0,
        "src_end_sec": out_end - out_start,
        "fade_in_sec": fade_in,
        "fade_out_sec": fade_out,
        "gain_db": 0.0,
    }


def _ra(run_id: int, audio: np.ndarray, t0: float, kind: str = "full") -> dict:
    return {
        "run_id": run_id,
        "kind": kind,
        "audio": audio,
        "t0_sec": t0,
        "locked": False,
        "lock_report": {},
    }


def _seam(sec: float, kind: str, transition: str, bars: float, clips: list[int]):
    return {
        "sec": sec,
        "kind": kind,
        "transition": transition,
        "bars": bars,
        "heal_start_sec": sec - 0.5,
        "heal_end_sec": sec + 0.5,
        "clips": clips,
        "lanes": ["lead"],
    }


def _win(x: np.ndarray, t0: float, t1: float, sr: int = SR) -> np.ndarray:
    return x[int(round(t0 * sr)) : int(round(t1 * sr))]


# --------------------------------------------------------------------------
# render primitives
# --------------------------------------------------------------------------


def test_equal_power_crossfade_holds_level():
    rng = np.random.default_rng(1)
    n = SR
    a = rng.standard_normal(n).astype(np.float32) * 0.3
    b = rng.standard_normal(n).astype(np.float32) * 0.3
    plateau = rms_db(a)

    ep = a * render.equal_power(n, "out") + b * render.equal_power(n, "in")
    lin = a * np.linspace(1.0, 0.0, n, dtype=np.float32) + b * np.linspace(
        0.0, 1.0, n, dtype=np.float32
    )

    k = 10
    seg = n // k
    ep_levels = [rms_db(ep[i * seg : (i + 1) * seg]) for i in range(k)]
    lin_levels = [rms_db(lin[i * seg : (i + 1) * seg]) for i in range(k)]
    for lvl in ep_levels:
        assert abs(lvl - plateau) <= 1.5, (ep_levels, plateau)
    # A linear crossfade of uncorrelated material dips ~3 dB at the centre;
    # that is why the renderer uses equal-power curves.
    assert plateau - min(lin_levels) > 2.5, (lin_levels, plateau)


def test_lr4_hp_removes_lows():
    dur = 4.0
    x = _stereo(_sine(50.0, dur, 0.3) + _sine(1000.0, dur, 0.3))
    hp = render.lr4(x, SR, 150.0, "hp")
    core = slice(int(0.5 * SR), int(3.5 * SR))
    assert (
        band_energy_db(x[core], SR, 48, 52) - band_energy_db(hp[core], SR, 48, 52) >= 24
    )
    assert (
        abs(
            band_energy_db(x[core], SR, 995, 1005)
            - band_energy_db(hp[core], SR, 995, 1005)
        )
        <= 0.5
    )

    freqs = [30.0, 60.0, 120.0, 150.0, 300.0, 1000.0, 3000.0, 10000.0]
    multi = _stereo(sum(_sine(f, dur, 0.08) for f in freqs))
    low, high = render.split_bands(multi, SR, 120.0)
    lp = render.lr4(multi, SR, 120.0, "lp")
    hp2 = render.lr4(multi, SR, 120.0, "hp")
    for f in freqs:
        ref = band_energy_db(multi[core], SR, f - 2, f + 2)
        assert abs(band_energy_db((lp + hp2)[core], SR, f - 2, f + 2) - ref) <= 0.5, f
        assert abs(band_energy_db((low + high)[core], SR, f - 2, f + 2) - ref) <= 0.5, f


def test_measure_lufs_fallback_and_meter():
    sine = _stereo(_sine(1000.0, 2.0, 0.1))
    v = render.measure_lufs(sine, SR)
    assert -25.0 < v < -19.0  # -20 dBFS RMS sine, K-weighted ~ -20 LUFS
    short = render.measure_lufs(sine[: int(0.2 * SR)], SR)
    assert short == pytest.approx(rms_db(sine[: int(0.2 * SR)]) - 3.0, abs=0.2)
    assert math.isfinite(render.measure_lufs(np.zeros((SR, 2), np.float32), SR))


@pytest.mark.parametrize("level_db", [-30.0, -10.0])
@pytest.mark.parametrize("lane", ["lead", "support"])
def test_run_gain_targets_lane_lufs(level_db: float, lane: str):
    x = _pink(4.0, level_db, seed=7)
    measured = render.measure_lufs(x, SR)
    target = render.LEAD_LUFS if lane == "lead" else render.SUPPORT_LUFS
    g = render.run_gain_db(measured, lane, 1.0)
    assert abs(g) <= render.GAIN_CLAMP_DB
    wanted = target - measured
    if abs(wanted) <= render.GAIN_CLAMP_DB:
        after = render.measure_lufs(x * 10 ** (g / 20), SR)
        assert abs(after - target) <= 1.0, (after, target)
    else:
        assert g == pytest.approx(math.copysign(render.GAIN_CLAMP_DB, wanted))
    # weight folds in as 20 log10(weight), floor at 0.05
    assert render.run_gain_db(target, lane, 0.5) == pytest.approx(20 * math.log10(0.5))
    # weight 0 floors at 0.05 (-26 dB), which the +/- 12 dB clamp then catches
    assert render.run_gain_db(target, lane, 0.0) == pytest.approx(-render.GAIN_CLAMP_DB)


def test_duck_dips_on_kicks():
    dur = 3.0
    n = int(dur * SR)
    side = np.zeros(n, dtype=np.float32)
    kick_t = np.arange(int(0.08 * SR)) / SR
    kick = (np.sin(2 * math.pi * 60 * kick_t) * np.exp(-kick_t / 0.02)).astype(
        np.float32
    )
    onsets = [0.5, 1.0, 1.5, 2.0]
    for t in onsets:
        s = int(t * SR)
        side[s : s + kick.size] += kick
    layer = _stereo(_sine(1000.0, dur, 0.3))
    env = render.envelope_low_band(_stereo(side), SR, 150.0)
    ducked = render.duck(layer, env, 3.0)

    def gain_db(t0: float, t1: float) -> float:
        return rms_db(_win(ducked, t0, t1)) - rms_db(_win(layer, t0, t1))

    assert abs(gain_db(0.1, 0.4)) < 0.05  # no sidechain: unity
    for t in onsets:
        # deepest point within 15 ms of the onset (a 60 Hz kick peaks at ~4 ms)
        dips = [gain_db(t + k * 0.001, t + (k + 1) * 0.001) for k in range(15)]
        assert min(dips) <= -2.5, (t, dips)
        assert gain_db(t + 0.2, t + 0.21) > -1.0, t  # released to < 1/3 depth
        assert gain_db(t + 0.3, t + 0.31) > -0.5, t
    assert abs(gain_db(0.45, 0.49)) < 0.1  # fully recovered before the next


def test_polarity_flip_detected():
    a = _stereo(_sine(60.0, 0.5, 0.4))
    assert render.polarity_flip_needed(a, -a) is True
    assert render.polarity_flip_needed(a, a) is False
    assert render.polarity_flip_needed(np.zeros_like(a), a) is False


# --------------------------------------------------------------------------
# render_timeline
# --------------------------------------------------------------------------


def test_contiguous_run_is_sample_exact():
    total = 8.0
    src = _pink(10.0, -18.0, seed=3)
    run = _run(0, 0, "lead", 0.0, total, first_phrase=0, last_phrase=1)
    sched = _sched(total, [run])
    rr = render.render_timeline(sched, {0: [_ra(0, src, 0.0)]}, SR)
    out = rr["audio"]
    assert out.shape == (int(total * SR), 2)
    g = 10 ** (rr["run_gains_db"][0] / 20)
    # no seams, run spans the whole timeline: every sample is source * gain
    assert np.allclose(out, src[: out.shape[0]] * g, atol=1e-6)
    assert rr["seams_rendered"] == 0
    assert abs(rr["lane_lufs"]["lead"] - render.LEAD_LUFS) <= 1.0


def test_render_timeline_respects_total_sec_and_fades_only_at_seams():
    total = 6.0
    lead_src = _pink(10.0, -18.0, seed=5)  # longer than the timeline
    sup_src = _stereo(_sine(3000.0, 4.0, 0.3))
    lead = _run(0, 0, "lead", 0.0, total)
    sup = _run(1, 1, "support", 2.0, 4.0, fade_in=0.5, fade_out=0.5, role="hp")
    seams = [
        {**_seam(2.0, "support_in", "fade", 1.0, [1]), "lanes": ["support"]},
        {**_seam(4.0, "support_out", "fade", 1.0, [1]), "lanes": ["support"]},
    ]
    sched = _sched(total, [lead, sup], seams)
    rr = render.render_timeline(
        sched, {0: [_ra(0, lead_src, 0.0)], 1: [_ra(1, sup_src, 1.0)]}, SR
    )
    out = rr["audio"]
    assert out.shape[0] == int(total * SR)

    # lead interior untouched (only gain), even next to the support tails
    g = 10 ** (rr["run_gains_db"][0] / 20)
    lead_only = _win(out, 0.2, 1.4)
    assert np.allclose(lead_only, _win(lead_src, 0.2, 1.4) * g, atol=1e-6)
    lead_only_end = _win(out, 4.6, 5.9)
    assert np.allclose(lead_only_end, _win(lead_src, 4.6, 5.9) * g, atol=1e-6)

    # support audible only in [1.5, 4.5], rising through its fade-in
    # (the allclose checks above already prove the support is silent outside
    # [1.5, 4.5]; the pink lead has its own floor in the 3 kHz bin, so the
    # envelope checks compare windows where the support is present)
    hi = lambda t0, t1: band_energy_db(_win(out, t0, t1), SR, 2990, 3010)  # noqa: E731
    assert hi(1.5, 1.6) < hi(1.9, 2.0) - 6
    assert hi(2.5, 3.0) > hi(1.9, 2.0) - 1.5
    assert hi(4.4, 4.5) < hi(3.9, 4.0) - 6
    assert abs(rr["lane_lufs"]["support"] - render.SUPPORT_LUFS) <= 6.0
    assert rr["seams_rendered"] == 0  # support fades are not lead seams


def test_bass_swap_hard_switches_sub():
    total = 16.0
    bar, beat = 2.0, 0.5
    a_src = _stereo(_sine(60.0, 10.0, 0.3) + _sine(2000.0, 10.0, 0.2))
    b_src = _stereo(_sine(80.0, 10.0, 0.3) + _sine(3000.0, 10.0, 0.2))
    run_a = _run(0, 0, "lead", 0.0, 8.0, fade_out=bar)
    run_b = _run(1, 1, "lead", 8.0, total, fade_in=bar)
    seams = [_seam(8.0, "lead_switch", "blend", 1.0, [0, 1])]
    sched = _sched(total, [run_a, run_b], seams, bar_sec=bar, beat_sec=beat)
    rr = render.render_timeline(
        sched, {0: [_ra(0, a_src, 0.0)], 1: [_ra(1, b_src, 6.0)]}, SR
    )
    out = rr["audio"]
    assert rr["seams_rendered"] == 1

    def band(t0: float, t1: float, f: float) -> float:
        return band_energy_db(_win(out, t0, t1), SR, f - 3, f + 3)

    # sub of the outgoing lead is gone right after the 1-beat swap window
    assert band(5.0, 7.5, 60.0) - band(8.4, 10.0, 60.0) >= 20.0
    # sub of the incoming lead is absent before the swap, present after (an
    # 80 Hz tone leaks through the 120 Hz LR4 high band at -15.7 dB, and that
    # band is still fading in over the first half of its pre-roll)
    assert band(6.0, 7.0, 80.0) < band(8.4, 10.0, 80.0) - 20.0
    # highs blend: both leads' highs present across the L-bar crossfade
    assert band(8.0, 8.8, 2000.0) > band(5.0, 7.0, 2000.0) - 6.0
    assert band(8.0, 8.8, 3000.0) > band(10.0, 12.0, 3000.0) - 6.0
    # incoming highs are quiet at the very start of its pre-roll
    assert band(6.0, 6.3, 3000.0) < band(10.0, 12.0, 3000.0) - 10.0


def test_polarity_inverted_lead_is_flipped_at_blend():
    total = 16.0
    bar, beat = 2.0, 0.5
    base = _sine(60.0, 16.0, 0.3) + _sine(2000.0, 16.0, 0.2)
    a_src = _stereo(base)
    b_src = _stereo(-base)  # same material, inverted
    run_a = _run(0, 0, "lead", 0.0, 8.0, fade_out=bar)
    run_b = _run(1, 1, "lead", 8.0, total, fade_in=bar)
    seams = [_seam(8.0, "lead_switch", "blend", 1.0, [0, 1])]
    sched = _sched(total, [run_a, run_b], seams, bar_sec=bar, beat_sec=beat)
    rr = render.render_timeline(
        sched, {0: [_ra(0, a_src, 0.0)], 1: [_ra(1, b_src, 0.0)]}, SR
    )
    assert any("polarity inverted" in w for w in rr["warnings"])
    out = rr["audio"]
    # after the flip the swap window sums constructively, not to silence
    assert (
        band_energy_db(_win(out, 7.8, 8.2), SR, 57, 63)
        > band_energy_db(_win(out, 4.0, 6.0), SR, 57, 63) - 6.0
    )


def test_stem_roles_pick_found_plus_layer_for_lead_and_layer_for_support():
    total = 4.0
    found = _stereo(_sine(100.0, 5.0, 0.3))
    layer = _stereo(_sine(2500.0, 5.0, 0.3))
    lead = _run(0, 0, "lead", 0.0, total, role="stem_found")
    sup = _run(1, 1, "support", 0.0, total, role="stem_layer")
    sched = _sched(total, [lead, sup])
    rr = render.render_timeline(
        sched,
        {
            0: [_ra(0, found, 0.0, "found"), _ra(0, layer, 0.0, "layer")],
            1: [_ra(1, found, 0.0, "found"), _ra(1, layer, 0.0, "layer")],
        },
        SR,
    )
    out = rr["audio"]
    assert band_energy_db(_win(out, 1, 3), SR, 97, 103) > -40
    assert band_energy_db(_win(out, 1, 3), SR, 2497, 2503) > -40
    # a support with only a full buffer degrades to hp and still renders
    rr2 = render.render_timeline(
        sched, {0: [_ra(0, found, 0.0)], 1: [_ra(1, found, 0.0)]}, SR
    )
    assert any("using the full mix" in w for w in rr2["warnings"])
    assert rr2["audio"].shape[0] == int(total * SR)


# --------------------------------------------------------------------------
# master
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "sub_hz,min_drop_db",
    [
        # 60 Hz is one octave under the 120 Hz LR4 crossover: -24.6 dB leaks
        # through the (stereo) high band by construction
        (60.0, 20.0),
        (40.0, 30.0),
    ],
)
def test_mono_low(sub_hz: float, min_drop_db: float):
    dur = 4.0
    left = _sine(sub_hz, dur, 0.3) + _sine(3000.0, dur, 0.2)
    right = -_sine(sub_hz, dur, 0.3)
    x = np.stack([left, right], axis=1)
    y = master.mono_low(x, SR)
    core = slice(int(0.5 * SR), int(3.5 * SR))
    side_before = (x[:, 0] - x[:, 1]) * 0.5
    side_after = (y[:, 0] - y[:, 1]) * 0.5
    assert (
        band_energy_db(side_before[core], SR, 20, 120)
        - band_energy_db(side_after[core], SR, 20, 120)
        >= min_drop_db
    )
    assert (
        abs(
            band_energy_db(side_before[core], SR, 2995, 3005)
            - band_energy_db(side_after[core], SR, 2995, 3005)
        )
        <= 0.5
    )
    mid_after = (y[:, 0] + y[:, 1]) * 0.5
    assert band_energy_db(mid_after[core], SR, sub_hz - 3, sub_hz + 3) < -60


@pytest.mark.parametrize("engine", ["numpy", "pedalboard-forced-fallback"])
def test_limit_ceiling_and_transparency(engine: str, monkeypatch: pytest.MonkeyPatch):
    kwargs: dict = {}
    if engine == "pedalboard-forced-fallback":

        def _boom(*_a, **_k):
            raise ImportError("no pedalboard")

        monkeypatch.setattr(master, "_limit_pedalboard", _boom)
        kwargs["engine"] = "pedalboard"
    t = np.arange(int(2 * SR)) / SR
    square = _stereo(np.sign(np.sin(2 * math.pi * 100 * t)).astype(np.float32))
    y, gr = master.limit(square, SR, **kwargs)
    assert y.shape == square.shape
    assert 20 * math.log10(float(np.max(np.abs(y)))) <= -0.9
    assert gr >= 0.9
    sine = _stereo(_sine(440.0, 2.0, 0.1))
    y2, gr2 = master.limit(sine, SR, **kwargs)
    assert abs(rms_db(y2) - rms_db(sine)) <= 0.01
    assert gr2 == pytest.approx(0.0, abs=1e-6)
    assert np.allclose(y2, sine, atol=1e-6)


def test_limit_numpy_release_recovers():
    burst = np.zeros(int(2 * SR), dtype=np.float32)
    burst[int(0.5 * SR) : int(0.52 * SR)] = 1.0
    x = _stereo(burst + _sine(440.0, 2.0, 0.1))
    y, _ = master._limit_numpy(x, SR, -1.0, 120.0)
    assert float(np.max(np.abs(y))) <= 10 ** (-0.9 / 20)
    # 0.5 s after the burst the gain is back within 0.2 dB of unity
    assert abs(rms_db(_win(y, 1.0, 1.5)) - rms_db(_win(x, 1.0, 1.5))) <= 0.2


@pytest.mark.skipif(not probe()["pedalboard"], reason="pedalboard not installed")
def test_limit_pedalboard_engine_runs():
    sine = _stereo(_sine(440.0, 1.0, 0.5))
    y, gr = master.limit(sine, SR, engine="pedalboard")
    assert y.shape == sine.shape and np.all(np.isfinite(y))
    assert float(np.max(np.abs(y))) <= master.HARD_CLIP
    assert gr >= 0.0


def test_loudness_normalize_within_1_lu():
    x = _pink(6.0, -30.0, seed=11)
    y, gain_db = master.loudness_normalize(x, SR)
    assert abs(render.measure_lufs(y, SR) - master.TARGET_LUFS) <= 1.0
    assert abs(gain_db) <= master.NORMALIZE_CLAMP_DB
    loud = _pink(6.0, -2.0, seed=12)
    y2, g2 = master.loudness_normalize(loud, SR)
    assert g2 < 0 and abs(render.measure_lufs(y2, SR) - master.TARGET_LUFS) <= 1.0


def test_master_fades_bar_synced():
    beat, bar = 0.5, 2.0
    x = np.ones((int(6 * SR), 2), dtype=np.float32)
    y = master.master_fades(x, SR, beat, bar)
    assert y is x
    n_in, n_out = int(beat * SR), int(bar * SR)
    assert y[0, 0] < 0.01
    assert y[n_in // 2, 0] == pytest.approx(math.sin(math.pi / 4), abs=0.01)
    assert y[n_in + 10, 0] == 1.0
    assert y[-n_out - 10, 0] == 1.0
    assert y[-n_out // 2, 0] == pytest.approx(math.cos(math.pi / 4), abs=0.01)
    assert y[-1, 0] < 0.01


def test_finalize_writes_pcm16_and_reports(tmp_path: Path):
    beat, bar = 0.5, 2.0
    x = _pink(8.0, -28.0, seed=21)
    out = tmp_path / "final.wav"
    rep = master.finalize(x, SR, beat, bar, out)
    info = sf.info(str(out))
    assert info.subtype == "PCM_16" and info.channels == 2 and info.samplerate == SR
    assert rep["duration_sec"] == pytest.approx(8.0, abs=1e-3)
    assert rep["true_peak_db"] <= 0.5  # inter-sample peaks stay near the ceiling
    assert rep["limiter_gr_db"] >= 0.0
    assert (
        abs(rep["lufs_integrated"] - master.TARGET_LUFS) <= 2.0
    )  # fades cost a little
    audio, _ = sf.read(str(out), dtype="float32")
    head = audio[: int(0.01 * SR)]
    mid = audio[int(4.0 * SR) : int(4.1 * SR)]
    assert rms_db(head) < rms_db(mid) - 6.0  # 1-beat fade-in keeps the head quiet
    assert rms_db(audio[-int(0.05 * SR) :]) < rms_db(mid) - 12.0
