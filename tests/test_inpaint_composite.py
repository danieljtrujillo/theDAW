"""The EDIT inpaint composite (backend/lib/inpaint_composite.py) and its route
through /api/generate-jobs.

The load-bearing assertion is exact equality outside the regenerated region,
not a tolerance: every kept sample is the original's sample. A change that
makes those assertions fail is the defect; do not loosen them.
"""

from __future__ import annotations

import asyncio
import inspect
import io

import numpy as np
import pytest
import torch
from fastapi import HTTPException

import backend.server as server
from backend.core.idle import get_idle_manager
from backend.lib.audio_io import load_audio_array, save_audio
from backend.lib.inpaint_composite import (
    DEFAULT_FEATHER_SEC,
    MAX_LOUDNESS_GAIN_DB,
    CompositeOptions,
    blend_weights,
    composite_inpaint,
    keep_mask_from_seconds,
)

SR = 44100
F = int(round(DEFAULT_FEATHER_SEC * SR))


def _noise(channels: int, seconds: float, seed: int, sr: int = SR) -> np.ndarray:
    rng = np.random.default_rng(seed)
    x = rng.standard_normal((channels, int(round(seconds * sr)))) * 0.25
    return np.clip(x, -0.99, 0.99).astype(np.float32)


def _mask(n: int, start: float, end: float, sr: int = SR) -> np.ndarray:
    return keep_mask_from_seconds(n, sr, start, end)


def _rms(x: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.square(x, dtype=np.float64))))


def _ramp_len(mask: np.ndarray, n: int) -> int:
    """Samples where both sources sound: the generation's weight strictly
    between 0 and 1."""
    w = blend_weights(mask, n, n, F)
    return int(np.count_nonzero((w > 0.0) & (w < 1.0)))


# ---- the composite ---------------------------------------------------------


def test_outside_the_region_is_the_original_sample_for_sample():
    original = _noise(2, 3.0, seed=1)
    generated = _noise(2, 3.0, seed=2)
    out = composite_inpaint(original, generated, SR, _mask(3 * SR, 1.0, 2.0))
    a, b = SR, 2 * SR
    np.testing.assert_array_equal(out[:, :a], original[:, :a])
    np.testing.assert_array_equal(out[:, b:], original[:, b:])
    assert out.dtype == np.float32
    assert out.shape == generated.shape


def test_the_body_of_the_region_is_the_generation():
    original = _noise(2, 3.0, seed=3)
    generated = _noise(2, 3.0, seed=4)
    out = composite_inpaint(
        original, generated, SR, _mask(3 * SR, 1.0, 2.0), match_loudness=False
    )
    a, b = SR, 2 * SR
    np.testing.assert_array_equal(out[:, a + F : b - F], generated[:, a + F : b - F])


def test_a_region_at_zero_seconds_has_no_start_ramp_and_a_full_end_ramp():
    # Nothing precedes a region at 0 s, so it starts as the generation; its end
    # edge borders kept audio and gets the whole feather, not a clamped one.
    n = 2 * SR
    original = np.full((1, n), 0.5, dtype=np.float32)
    generated = np.zeros((1, n), dtype=np.float32)
    mask = _mask(n, 0.0, 0.5)
    out = composite_inpaint(original, generated, SR, mask, match_loudness=False)
    b = int(0.5 * SR)
    np.testing.assert_array_equal(out[:, : b - F], generated[:, : b - F])
    np.testing.assert_array_equal(out[:, b:], original[:, b:])
    assert _ramp_len(mask, n) == F
    assert np.all(np.diff(out[0, b - F : b]) >= 0.0)


def test_a_region_at_the_clip_end_has_a_full_start_ramp_and_no_end_ramp():
    n = 2 * SR
    original = np.full((1, n), 0.5, dtype=np.float32)
    generated = np.zeros((1, n), dtype=np.float32)
    mask = _mask(n, 1.5, 2.0)
    out = composite_inpaint(original, generated, SR, mask, match_loudness=False)
    a = int(1.5 * SR)
    np.testing.assert_array_equal(out[:, :a], original[:, :a])
    np.testing.assert_array_equal(out[:, a + F :], generated[:, a + F :])
    assert _ramp_len(mask, n) == F
    assert np.all(np.diff(out[0, a : a + F]) <= 0.0)


def test_the_crossfade_is_equal_power():
    n = 3 * SR
    w = blend_weights(_mask(n, 1.0, 2.0), n, n, F)
    ramp = (w > 0.0) & (w < 1.0)
    assert np.count_nonzero(ramp) == 2 * F
    wo = np.sqrt(1.0 - np.square(w[ramp]))
    np.testing.assert_allclose(np.square(w[ramp]) + np.square(wo), 1.0, atol=1e-12)
    # Rising in at the start, falling out at the end, symmetric.
    a, b = SR, 2 * SR
    assert np.all(np.diff(w[a : a + F]) > 0)
    assert np.all(np.diff(w[b - F : b]) < 0)
    np.testing.assert_allclose(w[a : a + F], w[b - F : b][::-1], atol=1e-12)


def test_no_power_dip_across_either_seam():
    # Two uncorrelated sources of equal power, crossfaded equal-power, keep a
    # flat level through both ramps. A linear fade would dip ~3 dB mid-ramp.
    original = _noise(1, 4.0, seed=8)
    generated = _noise(1, 4.0, seed=9)
    out = composite_inpaint(
        original, generated, SR, _mask(4 * SR, 1.0, 3.0), match_loudness=False
    )
    sigma = _rms(original)
    win = int(0.05 * SR)
    for seam in (1.0, 3.0):
        centre = int(seam * SR)
        for off in range(-3 * win, 3 * win, win // 2):
            level = _rms(out[0, centre + off : centre + off + win])
            assert level == pytest.approx(sigma, rel=0.15), (seam, off)


def test_a_generation_longer_than_the_original_keeps_its_tail():
    original = _noise(2, 2.0, seed=10)
    generated = _noise(2, 2.5, seed=11)
    n_o, n_g = original.shape[-1], generated.shape[-1]
    out = composite_inpaint(
        original, generated, SR, _mask(n_g, 0.5, 1.5), match_loudness=False
    )
    assert out.shape[-1] == n_g
    a, b = int(0.5 * SR), int(1.5 * SR)
    np.testing.assert_array_equal(out[:, :a], original[:, :a])
    np.testing.assert_array_equal(out[:, b:n_o], original[:, b:n_o])
    np.testing.assert_array_equal(out[:, n_o:], generated[:, n_o:])


def test_a_region_running_into_the_tail_is_one_gain_and_one_ramp():
    # The region reaches the original's end and the generation runs past it:
    # region and tail are one stretch of generated audio, so the loudness
    # match scales both and no ramp sits at the original's end.
    original = _noise(1, 2.0, seed=12)
    generated = _noise(1, 2.5, seed=13) * 0.5
    n_o, n_g = original.shape[-1], generated.shape[-1]
    out = composite_inpaint(original, generated, SR, _mask(n_g, 1.5, 2.0))
    a = int(1.5 * SR)
    np.testing.assert_array_equal(out[:, :a], original[:, :a])
    gain = out[0, n_o:] / generated[0, n_o:]
    body = out[0, a + F : n_o] / generated[0, a + F : n_o]
    np.testing.assert_allclose(gain, body[0], rtol=1e-5)


def test_a_generation_shorter_than_the_original_is_never_padded():
    original = _noise(1, 2.0, seed=14)
    generated = _noise(1, 2.0, seed=15)[:, :-1]
    out = composite_inpaint(
        original, generated, SR, _mask(generated.shape[-1], 0.5, 1.5)
    )
    assert out.shape[-1] == generated.shape[-1]
    a, b = int(0.5 * SR), int(1.5 * SR)
    np.testing.assert_array_equal(out[:, :a], original[:, :a])
    np.testing.assert_array_equal(out[:, b:], original[:, b : generated.shape[-1]])


def test_a_multi_region_mask_composites_every_run():
    n = 6 * SR
    original = _noise(2, 6.0, seed=16)
    generated = _noise(2, 6.0, seed=17)
    keep = np.ones(n, dtype=np.float32)
    runs = [(0, int(0.8 * SR)), (int(2.0 * SR), int(3.0 * SR)), (int(4.5 * SR), n)]
    for a, b in runs:
        keep[a:b] = 0.0
    out = composite_inpaint(original, generated, SR, keep, match_loudness=False)
    kept = keep.astype(bool)
    np.testing.assert_array_equal(out[:, kept], original[:, kept])
    # Bodies: a run at 0 starts at once and a run at the end stops at the end;
    # every edge that borders kept audio has its full feather.
    np.testing.assert_array_equal(
        out[:, : runs[0][1] - F], generated[:, : runs[0][1] - F]
    )
    a, b = runs[1]
    np.testing.assert_array_equal(out[:, a + F : b - F], generated[:, a + F : b - F])
    a, _ = runs[2]
    np.testing.assert_array_equal(out[:, a + F :], generated[:, a + F :])


def test_the_server_mask_builder_feeds_the_composite():
    # The Chimera-style region list, through the same builder the endpoint
    # uses (min 0.5 s widening, merge), at the model rate.
    n = 10 * SR
    mask = server._build_inpaint_mask([(2.0, 2.1), (6.0, 7.0)], SR, n)
    original = _noise(1, 10.0, seed=18)
    generated = _noise(1, 10.0, seed=19)
    out = composite_inpaint(
        original, generated, SR, mask.reshape(-1).numpy(), match_loudness=False
    )
    kept = mask.reshape(-1).numpy() >= 0.5
    np.testing.assert_array_equal(out[:, kept], original[:, kept])
    assert not np.array_equal(out[:, ~kept], original[:, ~kept])


def test_an_original_at_another_rate_is_resampled_to_the_generation():
    import torchaudio

    original = _noise(2, 2.0, seed=20, sr=48000)
    generated = _noise(2, 2.0, seed=21)
    out = composite_inpaint(
        original,
        generated,
        SR,
        _mask(generated.shape[-1], 0.5, 1.5),
        original_sample_rate=48000,
        match_loudness=False,
    )
    # The generation's domain: its rate, its length.
    assert out.shape == generated.shape
    resampled = torchaudio.functional.resample(
        torch.from_numpy(original), 48000, SR
    ).numpy()
    n = min(resampled.shape[-1], out.shape[-1])
    a, b = int(0.5 * SR), int(1.5 * SR)
    np.testing.assert_array_equal(out[:, :a], resampled[:, :a])
    np.testing.assert_array_equal(out[:, b:n], resampled[:, b:n])


def test_loudness_match_brings_the_region_to_the_original_level():
    original = _noise(1, 3.0, seed=22)
    generated = _noise(1, 3.0, seed=23) * 0.7  # ~3 dB down
    out = composite_inpaint(original, generated, SR, _mask(3 * SR, 1.0, 2.0))
    a, b = SR, 2 * SR
    assert _rms(out[:, a + F : b - F]) == pytest.approx(
        _rms(original[:, a:b]), rel=0.05
    )


def test_loudness_match_is_clamped_to_six_db():
    original = _noise(1, 3.0, seed=24)
    generated = _noise(1, 3.0, seed=25) * 0.25  # ~12 dB down
    out = composite_inpaint(original, generated, SR, _mask(3 * SR, 1.0, 2.0))
    a, b = SR, 2 * SR
    limit = 10.0 ** (MAX_LOUDNESS_GAIN_DB / 20.0)
    ratio = out[0, a + F : b - F] / generated[0, a + F : b - F]
    np.testing.assert_allclose(ratio, limit, rtol=1e-5)


def test_loudness_match_skips_a_silent_original_and_can_be_turned_off():
    silent = np.zeros((1, 3 * SR), dtype=np.float32)
    generated = _noise(1, 3.0, seed=26)
    a, b = SR, 2 * SR
    out = composite_inpaint(silent, generated, SR, _mask(3 * SR, 1.0, 2.0))
    np.testing.assert_array_equal(out[:, a + F : b - F], generated[:, a + F : b - F])

    loud = _noise(1, 3.0, seed=27)
    quiet = generated * 0.5
    off = composite_inpaint(
        loud, quiet, SR, _mask(3 * SR, 1.0, 2.0), match_loudness=False
    )
    np.testing.assert_array_equal(off[:, a + F : b - F], quiet[:, a + F : b - F])


def test_a_mono_original_fills_every_channel_of_a_stereo_generation():
    original = _noise(1, 2.0, seed=28)
    generated = _noise(2, 2.0, seed=29)
    out = composite_inpaint(
        original, generated, SR, _mask(2 * SR, 0.5, 1.5), match_loudness=False
    )
    assert out.shape[0] == 2
    a, b = int(0.5 * SR), int(1.5 * SR)
    for ch in range(2):
        np.testing.assert_array_equal(out[ch, :a], original[0, :a])
        np.testing.assert_array_equal(out[ch, b:], original[0, b:])


def test_a_region_shorter_than_two_feathers_shares_it():
    original = np.full((1, 2 * SR), 0.5, dtype=np.float32)
    generated = np.zeros((1, 2 * SR), dtype=np.float32)
    a, b = SR, int(1.06 * SR)
    mask = _mask(2 * SR, 1.0, 1.06)
    out = composite_inpaint(original, generated, SR, mask, match_loudness=False)
    np.testing.assert_array_equal(out[:, :a], original[:, :a])
    np.testing.assert_array_equal(out[:, b:], original[:, b:])
    # 60 ms against a 100 ms feather: each edge gets half the region.
    assert _ramp_len(mask, 2 * SR) == (b - a) // 2 * 2


def test_an_empty_or_inverted_region_returns_the_original():
    original = _noise(2, 1.0, seed=30)
    generated = _noise(2, 1.0, seed=31)
    for start, end in [(0.5, 0.5), (0.8, 0.2)]:
        out = composite_inpaint(original, generated, SR, _mask(SR, start, end))
        np.testing.assert_array_equal(out, original)


def test_nothing_is_clipped():
    # A float round trip keeps overs; clipping is the fixed-point writer's job.
    original = (_noise(1, 1.0, seed=32) * 4.0).astype(np.float32)
    generated = (_noise(1, 1.0, seed=33) * 4.0).astype(np.float32)
    out = composite_inpaint(
        original, generated, SR, _mask(SR, 0.2, 0.8), match_loudness=False
    )
    a = int(0.2 * SR)
    np.testing.assert_array_equal(out[:, :a], original[:, :a])
    assert float(np.max(np.abs(out))) > 1.0


def test_the_mask_rounds_like_the_pipeline():
    # pipeline.generate turns seconds into samples with int(sec * sr).
    mask = keep_mask_from_seconds(SR, SR, 0.123456, 0.654321)
    zeros = np.flatnonzero(mask == 0.0)
    assert zeros[0] == int(0.123456 * SR)
    assert zeros[-1] + 1 == int(0.654321 * SR)


# ---- _generate_to_bytes ----------------------------------------------------


class _FakePipeline:
    """Returns a fixed take and records the kwargs generate() received."""

    def __init__(self, take: np.ndarray):
        self.model_config = {"sample_rate": SR}
        self.take = take
        self.calls: list[dict] = []

    def generate(self, **kwargs):
        self.calls.append(kwargs)
        return torch.from_numpy(self.take.copy())[None]


def _inpaint_args(original: np.ndarray, **extra) -> dict:
    args = {
        "prompt": "a test tone",
        "inpaint_audio": (SR, torch.from_numpy(original.copy())),
        "inpaint_mask_start_seconds": 0.5,
        "inpaint_mask_end_seconds": 1.5,
    }
    args.update(extra)
    return args


def test_generate_to_bytes_composites_and_keeps_the_rider_away_from_the_model():
    original = _noise(2, 2.0, seed=40)
    take = _noise(2, 2.0, seed=41)
    pipe = _FakePipeline(take)
    base = _inpaint_args(original, composite_original=CompositeOptions())
    audio_bytes, fmt = server._generate_to_bytes(pipe, base, "wav", None, "32f")

    assert fmt == "wav"
    assert "composite_original" not in pipe.calls[0]
    # The job's args are untouched, so the next take of a batch composites too.
    assert isinstance(base["composite_original"], CompositeOptions)
    decoded, sr = load_audio_array(audio_bytes)
    assert sr == SR
    a, b = int(0.5 * SR), int(1.5 * SR)
    np.testing.assert_array_equal(decoded[:, :a], original[:, :a])
    np.testing.assert_array_equal(decoded[:, b:], original[:, b:])

    server._generate_to_bytes(pipe, base, "wav", None, "32f")
    assert "composite_original" not in pipe.calls[1]


def test_generate_to_bytes_without_the_rider_returns_the_model_rendering():
    original = _noise(2, 2.0, seed=42)
    take = _noise(2, 2.0, seed=43)
    audio_bytes, _fmt = server._generate_to_bytes(
        _FakePipeline(take), _inpaint_args(original), "wav", None, "32f"
    )
    decoded, _sr = load_audio_array(audio_bytes)
    np.testing.assert_array_equal(decoded, take)


def test_generate_to_bytes_composites_around_a_prebuilt_mask():
    original = _noise(1, 4.0, seed=44)
    take = _noise(2, 4.0, seed=45)
    mask = server._build_inpaint_mask([(1.0, 2.0)], SR, 4 * SR)
    args = {
        "prompt": "seam",
        "inpaint_audio": (SR, torch.from_numpy(original.copy())),
        "inpaint_mask": mask,
        "composite_original": CompositeOptions(match_loudness=False),
    }
    audio_bytes, _fmt = server._generate_to_bytes(
        _FakePipeline(take), args, "wav", None, "32f"
    )
    decoded, _sr = load_audio_array(audio_bytes)
    kept = mask.reshape(-1).numpy() >= 0.5
    for ch in range(2):
        np.testing.assert_array_equal(decoded[ch, kept], original[0, kept])


def test_generate_to_bytes_uses_the_take_feather():
    # A zero feather is a hard edge: the region is the generation from its
    # first sample to its last.
    original = np.full((2, 2 * SR), 0.5, dtype=np.float32)
    take = np.zeros((2, 2 * SR), dtype=np.float32)
    args = _inpaint_args(
        original,
        composite_original=CompositeOptions(feather_sec=0.0, match_loudness=False),
    )
    audio_bytes, _fmt = server._generate_to_bytes(
        _FakePipeline(take), args, "wav", None, "32f"
    )
    decoded, _sr = load_audio_array(audio_bytes)
    a, b = int(0.5 * SR), int(1.5 * SR)
    np.testing.assert_array_equal(decoded[:, a:b], take[:, a:b])
    np.testing.assert_array_equal(decoded[:, :a], original[:, :a])
    np.testing.assert_array_equal(decoded[:, b:], original[:, b:])


# ---- the /api/generate-jobs fields -----------------------------------------


class _Upload:
    def __init__(self, data: bytes):
        self.filename = "inpaint.wav"
        self._data = data

    async def read(self) -> bytes:
        return self._data


class _Request:
    async def form(self):
        return {}


def _endpoint_kwargs(**overrides) -> dict:
    """Every generate_jobs field at its declared default, then the overrides:
    a direct call would otherwise receive the Form(...) objects themselves."""
    kwargs = {}
    for name, param in inspect.signature(server.generate_jobs).parameters.items():
        if name == "request":
            continue
        kwargs[name] = getattr(param.default, "default", param.default)
    kwargs.update(overrides)
    return kwargs


def _base_args_for(monkeypatch, **overrides) -> dict:
    seen: dict = {}

    async def fake_job(_job_id, _pipe, base_args, *_rest):
        seen.update(base_args)

    async def no_loras(_form, _job_id):
        return [], [], None

    class _Pipe:
        model_config = {"sample_rate": SR}

    monkeypatch.setattr(server, "_ensure_gpu_clear_of_magenta", lambda: None)
    monkeypatch.setattr(server, "_get_or_load_generation_pipeline", lambda _n: _Pipe())
    monkeypatch.setattr(server, "_compute_request_sample_size", lambda *_a: 2 * SR)
    monkeypatch.setattr(server, "_persist_lora_uploads", no_loras)
    monkeypatch.setattr(server, "_run_generate_job", fake_job)
    monkeypatch.setattr(server, "JOBS", {})

    buf = io.BytesIO()
    save_audio(buf, _noise(2, 2.0, seed=50), SR, format="wav", subtype="FLOAT")

    async def scenario():
        await server.generate_jobs(
            request=_Request(),
            **_endpoint_kwargs(
                prompt="fill",
                duration=2.0,
                mask_start=0.5,
                mask_end=1.5,
                inpaint_audio=_Upload(buf.getvalue()),
                **overrides,
            ),
        )
        await asyncio.sleep(0)

    asyncio.run(scenario())
    # fake_job stands in for the task that would release the hold.
    mgr = get_idle_manager()
    for tag in list(mgr.active_tags()):
        mgr.release(tag)
    return seen


def test_the_edit_field_asks_for_the_composite(monkeypatch):
    base = _base_args_for(monkeypatch, composite_original="true")
    assert base["composite_original"] == CompositeOptions()


def test_without_the_field_make_and_chimera_keep_the_model_rendering(monkeypatch):
    base = _base_args_for(monkeypatch)
    assert "composite_original" not in base


def test_the_seam_tuning_fields_reach_the_composite(monkeypatch):
    base = _base_args_for(
        monkeypatch,
        composite_original="true",
        mask_feather_sec=0.05,
        match_loudness="false",
    )
    assert base["composite_original"] == CompositeOptions(
        feather_sec=0.05, match_loudness=False
    )


def test_the_seam_tuning_alone_does_not_turn_the_composite_on(monkeypatch):
    base = _base_args_for(monkeypatch, mask_feather_sec=0.3, match_loudness="true")
    assert "composite_original" not in base


@pytest.mark.parametrize("bad", [-0.01, 0.51, float("nan"), float("inf")])
def test_a_feather_outside_its_range_is_refused(monkeypatch, bad):
    with pytest.raises(HTTPException) as exc:
        _base_args_for(monkeypatch, composite_original="true", mask_feather_sec=bad)
    assert exc.value.status_code == 400
    assert "mask_feather_sec" in exc.value.detail
    assert get_idle_manager().active_tags() == []
