"""Regression tests for the idle-gate acquire/release contract (BE-001, BE-002).

A leaked tag is invisible at the call site and permanent: ``is_idle()`` returns
False for the rest of the process, so auto-analysis, auto-stems, auto-midi,
auto-score and the notation backfill never run again. These tests drive the two
endpoints that took a hold into failure and assert the gate came back open.
"""

from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException

import backend.server as server
from backend.core.idle import IdleManager, get_idle_manager, idle_hold


@pytest.fixture
def gate():
    """The process-wide manager, emptied before and after so a leak in one test
    cannot mask (or cause) a failure in another."""
    mgr = get_idle_manager()
    for tag in list(mgr.active_tags()):
        mgr.release(tag)
    yield mgr
    for tag in list(mgr.active_tags()):
        mgr.release(tag)


# ---- idle_hold contract -----------------------------------------------------


def test_idle_hold_releases_on_success():
    m = IdleManager(default_min_idle_seconds=0.0)
    with idle_hold("work", m):
        assert m.active_tags() == ["work"]
    assert m.active_tags() == []


def test_idle_hold_releases_on_exception():
    m = IdleManager(default_min_idle_seconds=0.0)
    with pytest.raises(RuntimeError):
        with idle_hold("work", m):
            raise RuntimeError("boom")
    assert m.active_tags() == []


def test_idle_hold_releases_on_early_return():
    m = IdleManager(default_min_idle_seconds=0.0)

    def early():
        with idle_hold("work", m):
            return "out"

    assert early() == "out"
    assert m.active_tags() == []


def test_idle_hold_keeps_hold_after_hand_off():
    m = IdleManager(default_min_idle_seconds=0.0)
    with idle_hold("work", m) as hold:
        hold.hand_off()
    assert m.active_tags() == ["work"]
    m.release("work")
    assert m.active_tags() == []


def test_idle_hold_hand_off_survives_a_later_raise():
    """Once handed off the tag belongs to the other owner, even if the rest of
    the block blows up: releasing here would un-gate a running job."""
    m = IdleManager(default_min_idle_seconds=0.0)
    with pytest.raises(RuntimeError):
        with idle_hold("work", m) as hold:
            hold.hand_off()
            raise RuntimeError("after hand-off")
    assert m.active_tags() == ["work"]


# ---- BE-001: POST /api/model/load ------------------------------------------


def test_preload_model_releases_gate_when_the_load_fails(gate, monkeypatch):
    def boom(_name):
        raise RuntimeError("checkpoint is corrupt")

    monkeypatch.setattr(server, "_ensure_gpu_clear_of_magenta", lambda: None)
    monkeypatch.setattr(server, "_get_or_load_generation_pipeline", boom)

    with pytest.raises(RuntimeError):
        asyncio.run(server.preload_model(model="small"))

    assert gate.active_tags() == []


def test_preload_model_releases_gate_on_success(gate, monkeypatch):
    monkeypatch.setattr(server, "_ensure_gpu_clear_of_magenta", lambda: None)
    monkeypatch.setattr(server, "_get_or_load_generation_pipeline", lambda _n: object())

    result = asyncio.run(server.preload_model(model="small"))

    assert result["loaded"] is True
    assert gate.active_tags() == []


# ---- BE-002: POST /api/generate-jobs ---------------------------------------


class _FakeRequest:
    """Only ``form()`` is reached before the failure points under test."""

    def __init__(self, values: dict | None = None):
        self._values = values or {}

    async def form(self):
        return self._values


def _generate_kwargs(**overrides) -> dict:
    """Every field the handler touches before it spawns the job, as real values
    rather than the ``Form(...)`` defaults a direct call would otherwise get."""
    kwargs = {
        "model_name": "small",
        "prompt": "a test tone",
        "negative_prompt": "",
        "duration": 10.0,
        "steps": 8,
        "cfg_scale": 1.0,
        "seed": -1,
        "batch_size": 1,
        "init_noise_level": 1.0,
        "init_audio_type": "Audio",
        "file_format": "wav",
        "file_naming": "verbose",
        "custom_name": "",
        "mask_start": 0.0,
        "mask_end": 0.0,
        "sampler_type": None,
        "sigma_max": 1.0,
        "duration_padding_sec": 6.0,
        "apg_scale": 1.0,
        "cfg_rescale": 0.0,
        "cfg_norm_threshold": 0.0,
        "cfg_interval_min": 0.0,
        "cfg_interval_max": 1.0,
        "dist_shift_type": None,
        "logsnr_anchor_length": 2000,
        "logsnr_anchor_logsnr": -6.2,
        "logsnr_rate": 1.0,
        "logsnr_end": 2.0,
        "flux_min_len": 256,
        "flux_max_len": 4096,
        "flux_alpha_min": 1.15,
        "flux_alpha_max": 4.5,
        "full_base_shift": 0.5,
        "full_max_shift": 1.15,
        "full_min_len": 256,
        "full_max_len": 4096,
        "inversion_steps": 8,
        "inversion_gamma": 0.5,
        "inversion_unconditional": "false",
        "cut_to_duration": "true",
        "init_audio": None,
        "inpaint_audio": None,
    }
    kwargs.update(overrides)
    return kwargs


@pytest.fixture
def generate_ok(monkeypatch):
    """Patch the handler's pre-task work to succeed, so each test can break
    exactly one step and see what the gate does."""
    monkeypatch.setattr(server, "_ensure_gpu_clear_of_magenta", lambda: None)
    monkeypatch.setattr(server, "_get_or_load_generation_pipeline", lambda _n: object())
    monkeypatch.setattr(server, "_compute_request_sample_size", lambda *_a: 441000)

    async def no_loras(_form, _job_id):
        return [], [], None

    monkeypatch.setattr(server, "_persist_lora_uploads", no_loras)
    return monkeypatch


def test_generate_jobs_releases_gate_when_the_model_load_fails(gate, generate_ok):
    def boom(_name):
        raise HTTPException(404, "local checkpoint no longer resolves")

    generate_ok.setattr(server, "_get_or_load_generation_pipeline", boom)

    with pytest.raises(HTTPException):
        asyncio.run(server.generate_jobs(request=_FakeRequest(), **_generate_kwargs()))

    assert gate.active_tags() == []


def test_generate_jobs_releases_gate_when_lora_persist_fails(gate, generate_ok):
    """The late failure the backlog names: the hold is taken ~100 lines before
    the task that would release it, so a LoRA write error used to strand it."""

    async def boom(_form, _job_id):
        raise OSError("no space left on device")

    generate_ok.setattr(server, "_persist_lora_uploads", boom)

    with pytest.raises(OSError):
        asyncio.run(server.generate_jobs(request=_FakeRequest(), **_generate_kwargs()))

    assert gate.active_tags() == []


def test_generate_jobs_releases_gate_when_the_upload_is_bad(gate, generate_ok):
    class _BadUpload:
        filename = "broken.wav"

    async def boom(_upload):
        raise HTTPException(400, "could not decode audio")

    generate_ok.setattr(server, "_load_audio_upload", boom)

    with pytest.raises(HTTPException):
        asyncio.run(
            server.generate_jobs(
                request=_FakeRequest(),
                **_generate_kwargs(init_audio=_BadUpload()),
            )
        )

    assert gate.active_tags() == []


def test_generate_jobs_hands_the_hold_to_the_job(gate, generate_ok):
    """On the happy path the endpoint must NOT release: the job it spawned is
    still running and releases the same tag from its own finally."""
    started = asyncio.Event()

    async def fake_job(job_id, *_args, **_kwargs):
        started.set()
        await asyncio.sleep(0)
        get_idle_manager().release("generate")

    generate_ok.setattr(server, "_run_generate_job", fake_job)

    async def scenario():
        response = await server.generate_jobs(
            request=_FakeRequest(), **_generate_kwargs()
        )
        # The task has not run yet; the hold must still be standing.
        held_at_return = gate.active_tags()
        await asyncio.wait_for(started.wait(), timeout=2.0)
        for _ in range(50):
            if not gate.active_tags():
                break
            await asyncio.sleep(0.01)
        return response, held_at_return

    response, held_at_return = asyncio.run(scenario())

    assert response["job"]["id"]
    assert held_at_return == ["generate"]
    assert gate.active_tags() == []
