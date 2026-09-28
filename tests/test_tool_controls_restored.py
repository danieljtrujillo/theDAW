"""The nine tool controls PR #207 removed, restored and wired to their DSP.

Main declared these controls and no handler read them; the PR deleted them.
Every sequence test here replays what the schema-driven tool page
(frontend/public/edit-modules/tool.html) does: GET the tool's manifest,
start every control at its manifest default, change one, POST the values to
/process, and compare the two renders. At 8039b45 the manifest has no such
control (the lookup fails) and ``validate_params`` drops the key, so two
renders that differ only in it come back identical; on main the key passed
validation and reached no handler, with the same result.

No model weights, no GPU. FFmpeg-backed renders skip when ``ffmpeg`` is not
on PATH, matching the rest of the DSP suites.
"""

from __future__ import annotations

import asyncio
import io
import json
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from fastapi import FastAPI
from fastapi.testclient import TestClient
from scipy.ndimage import uniform_filter1d
from scipy.signal import butter, fftconvolve, sosfiltfilt

from backend.lib import ffmpeg_tools
from backend.modules.creative_neural import dsp as creative_dsp
from backend.modules.creative_neural.router import router as creative_router
from backend.modules.delivery import router as delivery_router
from backend.modules.restoration import dsp as restoration_dsp
from backend.modules.restoration.router import router as restoration_router

SR = 44100
RESTORATION = "/api/edit/restoration"
CREATIVE = "/api/edit/creative-neural"
DELIVERY = "/api/edit/delivery"

needs_ffmpeg = pytest.mark.skipif(
    ffmpeg_tools.find_ffmpeg() is None, reason="no ffmpeg found"
)


@pytest.fixture(scope="module")
def client() -> TestClient:
    """The three families mounted at their module.json prefixes."""
    app = FastAPI()
    app.include_router(restoration_router, prefix=RESTORATION)
    app.include_router(creative_router, prefix=CREATIVE)
    app.include_router(delivery_router.router, prefix=DELIVERY)
    return TestClient(app)


def _page_values(client: TestClient, prefix: str, tool_id: str, **changes) -> dict:
    """What tool.html posts: every control at its manifest default, then the
    user's changes. A change to a control the manifest does not carry fails
    here, which is where 8039b45 fails."""
    r = client.get(f"{prefix}/tools/{tool_id}")
    assert r.status_code == 200, r.text
    values = {p["name"]: p["default"] for p in r.json()["params"]}
    for name, value in changes.items():
        assert name in values, f"{tool_id} has no {name!r} control in its manifest"
        values[name] = value
    return values


def _process(
    client: TestClient, prefix: str, tool_id: str, values: dict, audio: Path
) -> tuple[np.ndarray, int, str]:
    """POST /process as tool.html does (output_format wav). Returns the
    decoded render, its rate and its libsndfile subtype."""
    r = client.post(
        f"{prefix}/process",
        data={"effect": tool_id, "params": json.dumps(values), "output_format": "wav"},
        files={"audio": ("input.wav", audio.read_bytes(), "audio/wav")},
    )
    assert r.status_code == 200, r.text
    data, sr = sf.read(io.BytesIO(r.content), dtype="float32", always_2d=True)
    subtype = sf.info(io.BytesIO(r.content)).subtype
    return data, sr, subtype


def _write(path: Path, data: np.ndarray, sr: int = SR) -> Path:
    sf.write(str(path), data.astype(np.float32), sr, subtype="FLOAT")
    return path


def _band_energy(x: np.ndarray, lo: float, hi: float, sr: int = SR) -> float:
    spec = np.abs(np.fft.rfft(x))
    freqs = np.fft.rfftfreq(len(x), 1 / sr)
    return float(np.sum(spec[(freqs > lo) & (freqs < hi)] ** 2))


def _db(ratio: float) -> float:
    return float(10 * np.log10(ratio))


# ---------------------------------------------------------------------------
# Vocal Isolate & Cleanup — Denoise and Dereverb
# ---------------------------------------------------------------------------


def _noisy_tone(path: Path) -> tuple[Path, np.ndarray]:
    rng = np.random.default_rng(5)
    t = np.arange(2 * SR) / SR
    clean = 0.3 * np.sin(2 * np.pi * 440 * t)
    noisy = clean + 0.03 * rng.standard_normal(len(t))
    return _write(path, np.column_stack([noisy, noisy])), noisy


def test_vocal_isolate_denoise_knob_takes_the_noise_out(client, tmp_path):
    src, noisy = _noisy_tone(tmp_path / "noisy.wav")
    off = _page_values(client, RESTORATION, "vocal_isolate", denoiseAmount=0.0)
    on = _page_values(client, RESTORATION, "vocal_isolate", denoiseAmount=0.9)
    dry, _, _ = _process(client, RESTORATION, "vocal_isolate", off, src)
    wet, _, _ = _process(client, RESTORATION, "vocal_isolate", on, src)

    # The noise above the tone drops by well over 10 dB; the tone stays.
    hiss_drop = _db(
        _band_energy(wet[:, 0], 2000, 10000) / _band_energy(dry[:, 0], 2000, 10000)
    )
    tone_change = _db(
        _band_energy(wet[:, 0], 430, 450) / _band_energy(dry[:, 0], 430, 450)
    )
    assert hiss_drop < -10.0, hiss_drop
    assert abs(tone_change) < 1.0, tone_change
    # Denoise 0 is off: identical channels come out of the isolation as they
    # went in (0.87 * mid + 0.13 * channel, with mid == channel).
    assert np.allclose(dry[:, 0], noisy, atol=1e-6)


def _reverberant_bursts(path: Path) -> tuple[Path, list[int]]:
    rng = np.random.default_rng(9)
    n = 2 * SR
    dry = np.zeros(n)
    onsets = list(range(0, n - SR // 2, SR // 2))
    burst = np.arange(int(0.06 * SR))
    for s in onsets:
        dry[s : s + len(burst)] = (
            0.5 * np.sin(2 * np.pi * 700 * burst / SR) * np.hanning(len(burst))
        )
    tail = np.arange(int(1.2 * SR)) / SR
    rir = rng.standard_normal(len(tail)) * np.exp(-3 * np.log(10) * tail / 0.8)
    rir[0] = 3.0
    wet = fftconvolve(dry, rir)[:n]
    wet /= np.max(np.abs(wet)) * 1.25
    return _write(path, np.column_stack([wet, wet])), onsets


def _tail_to_burst_db(x: np.ndarray, onsets: list[int]) -> float:
    burst = sum(np.sum(x[s : s + int(0.06 * SR)] ** 2) for s in onsets)
    tail = sum(np.sum(x[s + int(0.15 * SR) : s + int(0.45 * SR)] ** 2) for s in onsets)
    return _db(tail / burst)


def test_vocal_isolate_dereverb_knob_shortens_the_room_tail(client, tmp_path):
    src, onsets = _reverberant_bursts(tmp_path / "room.wav")
    off = _page_values(
        client, RESTORATION, "vocal_isolate", denoiseAmount=0.0, dereverbAmount=0.0
    )
    on = _page_values(
        client, RESTORATION, "vocal_isolate", denoiseAmount=0.0, dereverbAmount=1.0
    )
    dry, _, _ = _process(client, RESTORATION, "vocal_isolate", off, src)
    wet, _, _ = _process(client, RESTORATION, "vocal_isolate", on, src)
    drop = _tail_to_burst_db(wet[:, 0], onsets) - _tail_to_burst_db(dry[:, 0], onsets)
    assert drop < -4.0, drop


def test_vocal_preprocess_caller_without_cleanup_keys_gets_plain_isolation(tmp_path):
    """backend.modules.vocal.preprocess.isolation awaits dsp.vocal_isolate
    with {"output": "vocals"} only. A missing cleanup key is off, so that
    pipeline's output is the isolation alone, as before."""
    rng = np.random.default_rng(3)
    left = 0.2 * rng.standard_normal(SR)
    right = 0.2 * rng.standard_normal(SR)
    src = _write(tmp_path / "in.wav", np.column_stack([left, right]))
    out = tmp_path / "out.wav"
    asyncio.run(restoration_dsp.vocal_isolate(src, out, {"output": "vocals"}))
    data, _ = sf.read(str(out), dtype="float32")
    mid = (left + right) / 2
    expected = 0.87 * np.column_stack([mid, mid]) + 0.13 * np.column_stack(
        [left, right]
    )
    assert np.allclose(data, expected, atol=1e-6)


def test_vocal_isolate_surround_upload_keeps_its_rear_channels(client, tmp_path):
    """A 3-channel upload used to hit a broadcasting error (a two-column
    extraction blended against three columns) and answer 500."""
    rng = np.random.default_rng(4)
    three = 0.2 * rng.standard_normal((SR, 3))
    src = _write(tmp_path / "surround.wav", three)
    values = _page_values(
        client, RESTORATION, "vocal_isolate", denoiseAmount=0.0, dereverbAmount=0.0
    )
    data, _, _ = _process(client, RESTORATION, "vocal_isolate", values, src)
    assert data.shape == (SR, 3)
    assert np.allclose(data[:, 2], three[:, 2], atol=1e-6)


# ---------------------------------------------------------------------------
# Restore All — Prompt
# ---------------------------------------------------------------------------


@needs_ffmpeg
def test_restore_all_prompt_hum_notches_the_mains(client, tmp_path):
    t = np.arange(2 * SR) / SR
    y = 0.2 * np.sin(2 * np.pi * 440 * t) + 0.2 * np.sin(2 * np.pi * 60 * t)
    src = _write(tmp_path / "hum.wav", y)
    plain = _page_values(client, RESTORATION, "restore_all", prompt="")
    asked = _page_values(
        client, RESTORATION, "restore_all", prompt="remove the 60 hz hum"
    )
    before, _, _ = _process(client, RESTORATION, "restore_all", plain, src)
    after, _, _ = _process(client, RESTORATION, "restore_all", asked, src)

    def hum_to_tone(x: np.ndarray) -> float:
        body = x[SR // 2 : -SR // 4, 0]
        return _band_energy(body, 55, 65) / _band_energy(body, 430, 450)

    assert _db(hum_to_tone(after) / hum_to_tone(before)) < -20.0
    # loudnorm still ends the chain and the length still matches the input
    assert after.shape[0] == len(y)


@needs_ffmpeg
def test_restore_all_prompt_stages_keep_the_timeline_aligned(tmp_path):
    """Every stage a prompt can add is delay-free, so an impulse lands on its
    own sample with the chain's afftdn compensation (declick is left out:
    an impulse is exactly what it removes)."""
    from backend.modules.restoration.router import _restore_all

    for sr in (44100, 48000):
        idx = sr // 2
        y = np.zeros(sr)
        y[idx] = 1.0
        src = _write(tmp_path / f"imp{sr}.wav", y, sr)
        out = tmp_path / f"out{sr}.wav"
        prompt = "rumble muddy harsh dull thin reverb hum sibilance hiss clipping"
        asyncio.run(_restore_all(src, out, {"strength": 0.5, "prompt": prompt}))
        data, out_sr = sf.read(str(out), dtype="float32")
        assert out_sr == sr
        assert len(data) == len(y)
        assert int(np.argmax(np.abs(data))) == idx


def test_restore_all_prompt_plan_reads_words_not_substrings():
    from backend.modules.restoration.router import _restore_prompt_plan

    assert _restore_prompt_plan("") == (0.0, [])
    assert _restore_prompt_plan("a human voice, popular song") == (0.0, [])
    extra_nr, stages = _restore_prompt_plan("50 Hz hum and some hiss")
    assert extra_nr == 12.0
    assert "equalizer=f=50:width_type=q:w=30:g=-30" in stages
    assert not any("f=60:" in s for s in stages)


# ---------------------------------------------------------------------------
# Breath / Mouth-Click Removal — Clicks
# ---------------------------------------------------------------------------


def _vowel_with_clicks(
    path: Path,
) -> tuple[Path, np.ndarray, list[int], tuple[int, int]]:
    rng = np.random.default_rng(11)
    t = np.arange(2 * SR) / SR
    y = sum((0.2 / k) * np.sin(2 * np.pi * 150 * k * t) for k in range(1, 14))
    y *= 0.6 + 0.4 * np.sin(2 * np.pi * 1.5 * t)
    clicks = [int(SR * s) for s in (0.21, 0.55, 0.93, 1.37, 1.71)]
    width = int(0.0015 * SR)
    for c in clicks:
        y[c : c + width] += 0.25 * rng.standard_normal(width) * np.hanning(width)
    s0, s1 = int(1.05 * SR), int(1.17 * SR)
    hiss = sosfiltfilt(
        butter(4, 4000, btype="highpass", fs=SR, output="sos"),
        rng.standard_normal(s1 - s0),
    )
    y[s0:s1] += 0.08 * hiss / np.max(np.abs(hiss))
    return _write(path, np.column_stack([y, y])), y, clicks, (s0, s1)


_HIGH = butter(4, 2500, btype="highpass", fs=SR, output="sos")


def _high_energy(x: np.ndarray, a: int, b: int) -> float:
    return float(np.sum(sosfiltfilt(_HIGH, x)[a:b] ** 2))


def test_breath_removal_clicks_knob_takes_out_mouth_clicks(client, tmp_path):
    src, _, clicks, (s0, s1) = _vowel_with_clicks(tmp_path / "clicks.wav")
    off = _page_values(
        client, RESTORATION, "breath_removal", breathReduction=0.0, clickReduction=0.0
    )
    on = _page_values(
        client, RESTORATION, "breath_removal", breathReduction=0.0, clickReduction=0.9
    )
    dry, _, _ = _process(client, RESTORATION, "breath_removal", off, src)
    wet, _, _ = _process(client, RESTORATION, "breath_removal", on, src)
    for c in clicks:
        drop = _db(
            _high_energy(wet[:, 0], c - 50, c + 120)
            / _high_energy(dry[:, 0], c - 50, c + 120)
        )
        assert drop < -10.0, (c, drop)
    # a sibilant is long, not a click: it passes untouched
    sibilant = _db(_high_energy(wet[:, 0], s0, s1) / _high_energy(dry[:, 0], s0, s1))
    assert abs(sibilant) < 0.5, sibilant


def test_vocal_preprocess_breath_removal_without_click_key_is_unchanged(tmp_path):
    """vocal.preprocess.isolation awaits dsp.breath_removal with {}. A
    missing clickReduction is off, so that pipeline removes breaths only."""
    src, y, clicks, _ = _vowel_with_clicks(tmp_path / "clicks.wav")
    out = tmp_path / "out.wav"
    asyncio.run(restoration_dsp.breath_removal(src, out, {"breathReduction": 0.0}))
    data, _ = sf.read(str(out), dtype="float32")
    assert np.allclose(data[:, 0], y, atol=1e-6)


def test_breath_removal_attenuates_every_channel_of_a_surround_file(tmp_path):
    """Only the first two channels used to get the breath gain; a third
    channel carrying the same signal came out unattenuated."""
    rng = np.random.default_rng(2)
    t = np.arange(2 * SR) / SR
    voice = 0.3 * np.sin(2 * np.pi * 200 * t) * (np.sin(2 * np.pi * 1.0 * t) > 0)
    breaths = 0.01 * rng.standard_normal(len(t)) * (np.sin(2 * np.pi * 1.0 * t) <= 0)
    mono = voice + breaths
    src = _write(tmp_path / "three.wav", np.column_stack([mono, mono, mono]))
    out = tmp_path / "out.wav"
    restoration_dsp.breath_removal_sync(src, out, {"breathReduction": 1.0})
    data, _ = sf.read(str(out), dtype="float32")
    assert not np.allclose(data[:, 0], mono, atol=1e-4), "no breath was attenuated"
    assert np.allclose(data[:, 2], data[:, 0], atol=1e-6)


# ---------------------------------------------------------------------------
# TimbreForge — Structure and Wander
# ---------------------------------------------------------------------------


def _plucks(path: Path) -> tuple[Path, np.ndarray]:
    n = 2 * SR
    y = np.zeros(n)
    for s in range(0, n, SR // 4):
        m = np.arange(min(SR // 4, n - s))
        y[s : s + len(m)] += (
            0.5 * np.sin(2 * np.pi * 330 * m / SR) * np.exp(-m / (0.04 * SR))
        )
    return _write(path, np.column_stack([y, y])), y


def _envelope(x: np.ndarray) -> np.ndarray:
    return np.sqrt(uniform_filter1d(x**2, int(0.01 * SR)))


@needs_ffmpeg
def test_timbreforge_structure_knob_keeps_the_source_attacks(client, tmp_path):
    src, y = _plucks(tmp_path / "plucks.wav")
    loose = _page_values(
        client,
        CREATIVE,
        "timbreforge",
        timbreBlend=0.8,
        structureWeight=0.0,
        latentWander=0.0,
    )
    held = _page_values(
        client,
        CREATIVE,
        "timbreforge",
        timbreBlend=0.8,
        structureWeight=1.0,
        latentWander=0.0,
    )
    shifted, _, _ = _process(client, CREATIVE, "timbreforge", loose, src)
    shaped, _, _ = _process(client, CREATIVE, "timbreforge", held, src)
    n = min(len(y), len(shifted), len(shaped))
    ref = _envelope(y[:n])
    corr_loose = np.corrcoef(_envelope(shifted[:n, 0]), ref)[0, 1]
    corr_held = np.corrcoef(_envelope(shaped[:n, 0]), ref)[0, 1]
    assert corr_held > corr_loose + 0.1, (corr_loose, corr_held)
    assert corr_held > 0.95, corr_held


def _pitch_spread_cents(x: np.ndarray) -> float:
    """Spread of a sine's pitch over the file: rising zero crossings at
    sub-sample precision, frequency averaged over 20 cycles (~45 ms)."""
    body = x[SR // 4 : -SR // 4].astype(np.float64)
    i = np.where((body[:-1] < 0) & (body[1:] >= 0))[0]
    crossings = i + body[i] / (body[i] - body[i + 1])
    freqs = 20 * SR / (crossings[20:] - crossings[:-20])
    return float(1200 * np.log2(freqs.max() / freqs.min()))


@needs_ffmpeg
def test_timbreforge_wander_knob_lets_the_pitch_drift(client, tmp_path):
    t = np.arange(2 * SR) / SR
    tone = 0.3 * np.sin(2 * np.pi * 440 * t)
    src = _write(tmp_path / "tone.wav", tone)
    still = _page_values(
        client,
        CREATIVE,
        "timbreforge",
        timbreBlend=0.5,
        structureWeight=0.0,
        latentWander=0.0,
    )
    moving = _page_values(
        client,
        CREATIVE,
        "timbreforge",
        timbreBlend=0.5,
        structureWeight=0.0,
        latentWander=1.0,
    )
    steady, _, _ = _process(client, CREATIVE, "timbreforge", still, src)
    drifting, _, _ = _process(client, CREATIVE, "timbreforge", moving, src)
    assert _pitch_spread_cents(steady[:, 0]) < 10.0
    assert _pitch_spread_cents(drifting[:, 0]) > 50.0
    # the drift bends pitch; it never moves the file's length
    assert len(drifting) == len(tone)
    # a fixed seed: the same settings render the same file
    again, _, _ = _process(client, CREATIVE, "timbreforge", moving, src)
    assert np.array_equal(again, drifting)


@needs_ffmpeg
def test_timbreforge_keeps_a_float_upload_float(client, tmp_path):
    """The shift used to render straight to the output with ffmpeg's WAV
    default, so a 32-bit float upload came back 16-bit."""
    src, _ = _plucks(tmp_path / "plucks.wav")
    values = _page_values(client, CREATIVE, "timbreforge", timbreBlend=0.8)
    _, _, subtype = _process(client, CREATIVE, "timbreforge", values, src)
    assert subtype == "FLOAT"


# ---------------------------------------------------------------------------
# TokenSynth — Prompt
# ---------------------------------------------------------------------------


def _peak_freqs(x: np.ndarray, count: int) -> set[int]:
    spec = np.abs(np.fft.rfft(x * np.hanning(len(x))))
    freqs = np.fft.rfftfreq(len(x), 1 / SR)
    return {int(round(f)) for f in freqs[np.argsort(spec)[-count:]]}


def test_tokensynth_prompt_note_sets_the_ring_carrier(client, tmp_path):
    t = np.arange(SR) / SR
    src = _write(tmp_path / "a4.wav", 0.3 * np.sin(2 * np.pi * 440 * t))
    plain = _page_values(client, CREATIVE, "tokensynth", prompt="")
    named = _page_values(client, CREATIVE, "tokensynth", prompt="steady A2")
    default_voice, _, _ = _process(client, CREATIVE, "tokensynth", plain, src)
    a2_voice, _, _ = _process(client, CREATIVE, "tokensynth", named, src)
    # A 440 Hz input ring-modulated by A2 (110 Hz) lands on 330 and 550 Hz.
    peaks = _peak_freqs(a2_voice[:, 0], 6)
    assert {330, 550} <= peaks, peaks
    assert not ({330, 550} <= _peak_freqs(default_voice[:, 0], 6))


def test_tokensynth_prompt_square_adds_odd_harmonic_sidebands(client, tmp_path):
    t = np.arange(SR) / SR
    src = _write(tmp_path / "a4.wav", 0.3 * np.sin(2 * np.pi * 440 * t))
    sine = _page_values(client, CREATIVE, "tokensynth", prompt="steady A2")
    square = _page_values(client, CREATIVE, "tokensynth", prompt="steady square A2")
    sine_out, _, _ = _process(client, CREATIVE, "tokensynth", sine, src)
    square_out, _, _ = _process(client, CREATIVE, "tokensynth", square, src)
    # the square's 3rd harmonic (330 Hz) puts sidebands at 440 +/- 330
    third = _band_energy(square_out[:, 0], 760, 780) / _band_energy(
        sine_out[:, 0], 760, 780
    )
    assert _db(third) > 20.0


def test_tokensynth_carrier_stays_in_phase_minutes_into_a_file(tmp_path):
    """A float32 time base put the carrier's phase on a 0.125 rad grid seven
    minutes in (its phase there is ~1.6e6 rad). The carrier must still be a
    clean sine at the end of a long file."""
    sr = 8000
    n = sr * 7 * 60
    src = tmp_path / "long.wav"
    sf.write(str(src), np.full(n, 0.5, dtype=np.float32), sr, subtype="FLOAT")
    out = tmp_path / "out.wav"
    creative_dsp.tokensynth(src, out, {"temperature": 1.0, "prompt": "steady"})
    data, _ = sf.read(str(out), dtype="float64")
    tail = np.arange(n - sr, n)
    ideal = np.sin(2 * np.pi * 600.0 * tail / sr)
    got = data[n - sr :] / 0.9
    assert np.max(np.abs(got - ideal)) < 1e-3


# ---------------------------------------------------------------------------
# AmbientForge — Prompt
# ---------------------------------------------------------------------------


def _centroid(x: np.ndarray, sr: int) -> float:
    spec = np.abs(np.fft.rfft(x))
    freqs = np.fft.rfftfreq(len(x), 1 / sr)
    return float(np.sum(freqs * spec) / np.sum(spec))


@needs_ffmpeg
def test_ambientforge_prompt_drone_note_puts_a_tone_under_the_bed(client, tmp_path):
    src = _write(tmp_path / "any.wav", np.zeros(SR // 2))
    plain = _page_values(client, CREATIVE, "ambientforge", duration=5.0, prompt="")
    drone = _page_values(
        client, CREATIVE, "ambientforge", duration=5.0, prompt="a slow drone on A2"
    )
    bed, sr, _ = _process(client, CREATIVE, "ambientforge", plain, src)
    toned, _, _ = _process(client, CREATIVE, "ambientforge", drone, src)

    def peak_over_floor(x: np.ndarray) -> float:
        spec = np.abs(np.fft.rfft(x.mean(axis=1)))
        freqs = np.fft.rfftfreq(len(x), 1 / sr)
        return float(
            spec[np.argmin(np.abs(freqs - 110))]
            / np.median(spec[(freqs > 80) & (freqs < 140)])
        )

    assert peak_over_floor(toned) > 50.0
    assert peak_over_floor(bed) < 10.0


@needs_ffmpeg
def test_ambientforge_prompt_colour_moves_the_spectrum(client, tmp_path):
    src = _write(tmp_path / "any.wav", np.zeros(SR // 2))
    plain = _page_values(client, CREATIVE, "ambientforge", duration=5.0, prompt="")
    deep = _page_values(
        client, CREATIVE, "ambientforge", duration=5.0, prompt="deep ocean waves"
    )
    rain = _page_values(
        client, CREATIVE, "ambientforge", duration=5.0, prompt="bright rain"
    )
    bed, sr, _ = _process(client, CREATIVE, "ambientforge", plain, src)
    ocean, _, _ = _process(client, CREATIVE, "ambientforge", deep, src)
    shower, _, _ = _process(client, CREATIVE, "ambientforge", rain, src)
    c_bed = _centroid(bed.mean(axis=1), sr)
    assert _centroid(ocean.mean(axis=1), sr) < 0.8 * c_bed
    assert _centroid(shower.mean(axis=1), sr) > 2.0 * c_bed


def test_ambientforge_empty_prompt_is_the_bed_it_always_made():
    from backend.modules.creative_neural.router import _ambient_plan

    plan = _ambient_plan("")
    assert plan["color"] == "pink"
    assert (plan["lowpass"], plan["highpass"], plan["tremolo"]) == (
        2000.0,
        40.0,
        (0.1, 0.4),
    )
    assert plan["echoes"] == ["aecho=0.8:0.9:500:0.4", "aecho=0.8:0.88:800:0.3"]
    assert plan["drone"] is None


# ---------------------------------------------------------------------------
# Batch Export — Jobs
# ---------------------------------------------------------------------------


def _count_overlap(monkeypatch) -> dict:
    """Swap ffmpeg.render for a 50 ms fake that records peak concurrency."""
    seen = {"now": 0, "max": 0}

    async def _render(inp, out, filter_args, extra_out_args=None, timeout=600.0):
        seen["now"] += 1
        seen["max"] = max(seen["max"], seen["now"])
        await asyncio.sleep(0.05)
        out.write_bytes(b"fake-render")
        seen["now"] -= 1
        return out

    monkeypatch.setattr(delivery_router.ffmpeg, "render", _render)
    return seen


@pytest.mark.parametrize("jobs", [1, 3, 6])
def test_batch_export_jobs_knob_sets_how_many_run_at_once(
    client, tmp_path, monkeypatch, jobs
):
    """A batch is a run of /process requests (one per stem or format); the
    page's Jobs value decides how many encode side by side."""
    values = _page_values(client, DELIVERY, "batch_export", parallelJobs=jobs)
    spec = next(t for t in delivery_router.TOOLS if t.id == "batch_export")
    validated = spec.validate_params(values)
    seen = _count_overlap(monkeypatch)
    src = _write(tmp_path / "in.wav", np.zeros(SR // 10))

    async def burst():
        outs = [tmp_path / f"out{i}.flac" for i in range(8)]
        await asyncio.gather(
            *(delivery_router._batch_export(src, o, validated) for o in outs)
        )

    asyncio.run(burst())
    assert seen["max"] == jobs


def test_batch_export_jobs_ceiling_is_enforced_at_the_door(client, tmp_path):
    src = _write(tmp_path / "in.wav", np.zeros(SR // 10))
    r = client.post(
        f"{DELIVERY}/process",
        data={"effect": "batch_export", "params": json.dumps({"parallelJobs": 9})},
        files={"audio": ("input.wav", src.read_bytes(), "audio/wav")},
    )
    assert r.status_code == 400
    assert "parallelJobs" in r.text


@needs_ffmpeg
def test_batch_export_with_jobs_renders_through_process(client, tmp_path):
    src = _write(
        tmp_path / "in.wav", 0.1 * np.sin(2 * np.pi * 440 * np.arange(SR) / SR)
    )
    values = _page_values(client, DELIVERY, "batch_export", parallelJobs=3)
    data, sr, _ = _process(client, DELIVERY, "batch_export", values, src)
    assert sr == SR and data.shape[0] == SR


def test_batch_export_cancelled_waiter_does_not_block_the_queue(monkeypatch, tmp_path):
    """A client that goes away while waiting leaves the queue; the request
    behind it still runs once a slot frees."""
    release = None
    started: list[str] = []

    async def _render(inp, out, filter_args, extra_out_args=None, timeout=600.0):
        started.append(out.name)
        if out.name == "a.wav":
            await release.wait()
        out.write_bytes(b"fake-render")
        return out

    monkeypatch.setattr(delivery_router.ffmpeg, "render", _render)
    src = _write(tmp_path / "in.wav", np.zeros(SR // 10))
    one = {"parallelJobs": 1}

    async def scenario():
        nonlocal release
        release = asyncio.Event()
        a = asyncio.create_task(
            delivery_router._batch_export(src, tmp_path / "a.wav", one)
        )
        await asyncio.sleep(0.01)
        b = asyncio.create_task(
            delivery_router._batch_export(src, tmp_path / "b.wav", one)
        )
        c = asyncio.create_task(
            delivery_router._batch_export(src, tmp_path / "c.wav", one)
        )
        await asyncio.sleep(0.01)
        assert started == ["a.wav"]
        b.cancel()
        await asyncio.sleep(0.01)
        release.set()
        await asyncio.wait_for(asyncio.gather(a, c), timeout=2.0)
        assert b.cancelled()
        assert delivery_router._batch_gate().running == 0

    asyncio.run(scenario())
    assert started == ["a.wav", "c.wav"]


def _held_renders(monkeypatch) -> dict:
    """Swap ffmpeg.render for a fake that holds each render until its
    ``release[name]`` event is set, and records which renders overlapped."""
    state = {"running": set(), "company": {}, "release": {}, "started": []}

    async def _render(inp, out, filter_args, extra_out_args=None, timeout=600.0):
        name = out.stem
        state["started"].append(name)
        state["running"].add(name)
        for other in state["running"]:
            state["company"].setdefault(other, set()).update(state["running"])
        event = state["release"].get(name)
        if event is not None:
            await event.wait()
        else:
            await asyncio.sleep(0.02)
        state["running"].discard(name)
        out.write_bytes(b"fake-render")
        return out

    monkeypatch.setattr(delivery_router.ffmpeg, "render", _render)
    return state


def test_batch_export_jobs_1_render_runs_alone_when_jobs_8_requests_follow(
    monkeypatch, tmp_path
):
    """One page asks for a render at Jobs=1; while it runs, another page
    sends five renders at Jobs=8. The gate checked only each arrival's own
    value, so all five joined the Jobs=1 render (six at once). Now the five
    wait for it to finish, then run side by side."""
    state = _held_renders(monkeypatch)
    src = _write(tmp_path / "in.wav", np.zeros(SR // 10))

    async def scenario():
        state["release"]["solo"] = asyncio.Event()
        solo = asyncio.create_task(
            delivery_router._batch_export(
                src, tmp_path / "solo.wav", {"parallelJobs": 1}
            )
        )
        await asyncio.sleep(0.01)
        wide = [
            asyncio.create_task(
                delivery_router._batch_export(
                    src, tmp_path / f"wide{i}.wav", {"parallelJobs": 8}
                )
            )
            for i in range(5)
        ]
        await asyncio.sleep(0.05)
        assert state["started"] == ["solo"]
        assert delivery_router._batch_gate().running == 1
        state["release"]["solo"].set()
        await asyncio.wait_for(asyncio.gather(solo, *wide), timeout=2.0)
        assert delivery_router._batch_gate().running == 0

    asyncio.run(scenario())
    assert state["company"]["solo"] == {"solo"}
    assert state["company"]["wide0"] == {f"wide{i}" for i in range(5)}


def test_batch_export_jobs_1_arrival_waits_for_the_running_renders(
    monkeypatch, tmp_path
):
    """Two Jobs=8 renders are running when a Jobs=1 render arrives, with
    another Jobs=8 render behind it. The Jobs=1 render waits until both
    finish and then runs alone; the one behind it keeps its place in line."""
    state = _held_renders(monkeypatch)
    src = _write(tmp_path / "in.wav", np.zeros(SR // 10))
    wide = {"parallelJobs": 8}

    async def scenario():
        for name in ("w0", "w1", "solo"):
            state["release"][name] = asyncio.Event()
        first = [
            asyncio.create_task(
                delivery_router._batch_export(src, tmp_path / f"{n}.wav", wide)
            )
            for n in ("w0", "w1")
        ]
        await asyncio.sleep(0.01)
        solo = asyncio.create_task(
            delivery_router._batch_export(
                src, tmp_path / "solo.wav", {"parallelJobs": 1}
            )
        )
        await asyncio.sleep(0.01)
        late = asyncio.create_task(
            delivery_router._batch_export(src, tmp_path / "late.wav", wide)
        )
        await asyncio.sleep(0.05)
        assert state["started"] == ["w0", "w1"]
        state["release"]["w0"].set()
        await asyncio.sleep(0.05)
        assert state["started"] == ["w0", "w1"]
        state["release"]["w1"].set()
        await asyncio.sleep(0.05)
        assert state["started"] == ["w0", "w1", "solo"]
        state["release"]["solo"].set()
        await asyncio.wait_for(asyncio.gather(*first, solo, late), timeout=2.0)

    asyncio.run(scenario())
    assert state["started"] == ["w0", "w1", "solo", "late"]
    assert state["company"]["solo"] == {"solo"}


# ---------------------------------------------------------------------------
# Every DSP read goes through backend/lib/audio_io.py
# ---------------------------------------------------------------------------


@needs_ffmpeg
@pytest.mark.parametrize(
    ("prefix", "tool_id"),
    [
        (RESTORATION, "vocal_isolate"),
        (RESTORATION, "breath_removal"),
        (RESTORATION, "stem_separation"),
        (RESTORATION, "spectral_repair"),
        (CREATIVE, "tokensynth"),
        (CREATIVE, "grainlab"),
        (CREATIVE, "voxsynth"),
    ],
)
def test_dsp_tools_open_an_upload_libsndfile_cannot_read(
    client, tmp_path, prefix, tool_id
):
    """/process saves every upload as input.wav whatever it holds, and these
    tools read it with soundfile or librosa directly, so an AAC file dropped
    on the page failed the render. They read through audio_io now, which
    decodes such a file with the ffmpeg CLI."""
    import subprocess

    t = np.arange(SR) / SR
    tone = 0.2 * np.sin(2 * np.pi * 440 * t)
    wav = _write(tmp_path / "tone.wav", np.column_stack([tone, tone]))
    aac = tmp_path / "tone.m4a"
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", str(wav), "-c:a", "aac", str(aac)],
        check=True,
    )
    with pytest.raises(sf.LibsndfileError):
        sf.info(str(aac))

    values = _page_values(client, prefix, tool_id)
    data, sr, _ = _process(client, prefix, tool_id, values, aac)
    assert sr == SR and data.shape[1] == 2
    assert data.shape[0] > SR // 2
    assert float(np.max(np.abs(data))) > 0.0
