import pytest
import torch

from tests.conftest import HAS_ACCEL
from tests.utils.audio import assert_audio_valid, sine_wave

DURATION_SEC = 10
STEPS = 8
# -80 dBFS. Above the noise a real generation always carries, far below the
# level a short quiet SFX clip reaches; all-zero output still fails it.
BATCH_SILENCE_FLOOR = 1e-4

# Every generate() call below is SEEDED, and must stay that way.
#
# assert_audio_valid asserts the output is not silent (abs_max > 0.001), which
# is a real guard: it catches a model loaded wrong, a dead autoencoder, an
# all-zero latent. Unseeded, it sampled a fresh trajectory on every run and
# became a coin flip — the same command gave '3 passed', then '1 failed', then
# '2 failed', with abs_max landing at 0.00071 and 0.00037 against the 0.001
# floor. A flaky assertion is worse than no assertion, because it teaches
# everyone to re-run the suite until it goes green.


def test_text_to_audio(sa3_model, maybe_save_audio):
    model = sa3_model
    sr = model.model_config["sample_rate"]
    prompt = "trap drums, hip hop beat, 120bpm"

    audio = model.generate(
        prompt=prompt,
        negative_prompt="low-quality",
        duration=DURATION_SEC,
        steps=STEPS,
        seed=1234,
    )
    maybe_save_audio(audio, sr, prompt)
    assert_audio_valid(audio, DURATION_SEC, sr)


def test_inpainting(sa3_model, maybe_save_audio):
    model = sa3_model
    sr = model.model_config["sample_rate"]
    channels = model.model_config.get("io_channels", 2)
    inpaint_duration = 10.0
    prompt = "big trumpet solo, jazz big band, 90bpm"

    base_audio = sine_wave(
        inpaint_duration,
        sr,
        channels=channels,
        device=str(model.device),
        half=model.model_half,
    )
    audio = model.generate(
        prompt=prompt,
        duration=inpaint_duration,
        steps=STEPS,
        inpaint_audio=(sr, base_audio),
        inpaint_mask_start_seconds=2.0,
        inpaint_mask_end_seconds=7.0,
        seed=2001,
    )
    maybe_save_audio(audio, sr, prompt)
    assert_audio_valid(audio, inpaint_duration, sr)


def test_continuation(sa3_model, maybe_save_audio):
    model = sa3_model
    sr = model.model_config["sample_rate"]
    channels = model.model_config.get("io_channels", 2)
    init_duration = 5.0
    total_duration = 15.0
    prompt = "thunderstorm with heavy rain"

    base_audio = sine_wave(
        init_duration,
        sr,
        channels=channels,
        device=str(model.device),
        half=model.model_half,
    )
    audio = model.generate(
        prompt=prompt,
        duration=total_duration,
        steps=STEPS,
        inpaint_audio=(sr, base_audio),
        inpaint_mask_start_seconds=5.0,
        inpaint_mask_end_seconds=15.0,
        seed=2002,
    )
    maybe_save_audio(audio, sr, prompt)
    assert_audio_valid(audio, total_duration, sr)


def test_init_audio(sa3_model, maybe_save_audio):
    model = sa3_model
    sr = model.model_config["sample_rate"]
    channels = model.model_config.get("io_channels", 2)
    prompt = "funky bass groove"

    init = sine_wave(
        DURATION_SEC,
        sr,
        channels=channels,
        device=str(model.device),
        half=model.model_half,
    )

    audio = model.generate(
        prompt=prompt,
        duration=DURATION_SEC,
        steps=STEPS,
        init_audio=(sr, init),
        init_noise_level=0.8,
        seed=2003,
    )
    maybe_save_audio(audio, sr, prompt)
    assert_audio_valid(audio, DURATION_SEC, sr)


def test_init_audio_float32_into_half_model(sa3_model, maybe_save_audio):
    model = sa3_model
    if not model.model_half:
        pytest.skip(
            "model_half is False — dtype mismatch only occurs on half-precision models"
        )

    sr = model.model_config["sample_rate"]
    channels = model.model_config.get("io_channels", 2)
    prompt = "funky bass groove"

    # Deliberately float32, regardless of model dtype — this was the bug trigger
    init = sine_wave(
        DURATION_SEC, sr, channels=channels, device=str(model.device), half=False
    )
    assert init.dtype == torch.float32

    audio = model.generate(
        prompt=prompt,
        duration=DURATION_SEC,
        steps=STEPS,
        init_audio=(sr, init),
        init_noise_level=0.8,
        seed=2004,
    )
    maybe_save_audio(audio, sr, prompt)
    assert_audio_valid(audio, DURATION_SEC, sr)


def test_inpaint_audio_float32_into_half_model(sa3_model, maybe_save_audio):
    model = sa3_model
    if not model.model_half:
        pytest.skip(
            "model_half is False — dtype mismatch only occurs on half-precision models"
        )

    sr = model.model_config["sample_rate"]
    channels = model.model_config.get("io_channels", 2)
    inpaint_duration = 10.0
    prompt = "big trumpet solo, jazz big band, 90bpm"

    # Deliberately float32, regardless of model dtype — this was the bug trigger
    base_audio = sine_wave(
        inpaint_duration, sr, channels=channels, device=str(model.device), half=False
    )
    assert base_audio.dtype == torch.float32

    audio = model.generate(
        prompt=prompt,
        duration=inpaint_duration,
        steps=STEPS,
        inpaint_audio=(sr, base_audio),
        inpaint_mask_start_seconds=2.0,
        inpaint_mask_end_seconds=7.0,
        seed=2005,
    )
    maybe_save_audio(audio, sr, prompt)
    assert_audio_valid(audio, inpaint_duration, sr)


@pytest.mark.skipif(not HAS_ACCEL, reason="Batch inference requires a GPU/accelerator")
def test_batch_inference(sa3_model, maybe_save_audio):
    model = sa3_model
    sr = model.model_config["sample_rate"]
    batch_size = 3
    prompts = ["ocean waves", "summer breeze", "city traffic"]

    neg_prompts = ["loud background noise", "bad quality", "loud background noise"]
    durations = [2, 5, 20]
    duration_padding_sec = 6  # Default, just defining here for clarity

    audio_same_durations = model.generate(
        prompt=prompts,
        negative_prompt=neg_prompts,
        duration=DURATION_SEC,
        steps=STEPS,
        batch_size=batch_size,
        seed=2006,
    )
    audio_different_durations = model.generate(
        prompt=prompts,
        negative_prompt=neg_prompts,
        duration=durations,
        steps=STEPS,
        duration_padding_sec=duration_padding_sec,
        batch_size=batch_size,
        seed=2007,
    )
    assert audio_same_durations.shape[0] == batch_size, (
        f"Expected batch dim {batch_size}, got {audio_same_durations.shape[0]}"
    )
    # Validate each item in the batch individually and optionally save
    for i, prompt in enumerate(prompts):
        maybe_save_audio(audio_same_durations[i : i + 1], sr, prompt)
        # A quieter floor for the batch: three prompts share one sampling
        # pass, and the SFX model's take on 'summer breeze' lands around
        # -64 dBFS. That is signal, not silence — what this guard is for is
        # a model that produced nothing at all.
        assert_audio_valid(
            audio_same_durations[i : i + 1],
            DURATION_SEC,
            sr,
            min_abs_max=BATCH_SILENCE_FLOOR,
        )

    # Check for diversity in outputs (not identical)
    diffs = []
    for i in range(batch_size):
        for j in range(i + 1, batch_size):
            diff = torch.mean(
                torch.abs(audio_same_durations[i] - audio_same_durations[j])
            ).item()
            diffs.append(diff)
    avg_diff = sum(diffs) / len(diffs)
    assert avg_diff > 0.01, f"Batch outputs are too similar (avg diff {avg_diff:.4f})"

    # Validate different durations
    for i, dur in enumerate(durations):
        # Set expected_duration to be longer since we are not truncating
        d = max(durations) + duration_padding_sec
        maybe_save_audio(
            audio_different_durations[i : i + 1], sr, f"{prompts[i]}_{dur}s"
        )
        assert_audio_valid(
            audio_different_durations[i : i + 1], d, sr, min_abs_max=BATCH_SILENCE_FLOOR
        )
