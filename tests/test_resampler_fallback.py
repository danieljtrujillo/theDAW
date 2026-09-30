"""High-Quality SRC, Classical Upsample and Super-Res on an ffmpeg without
libsoxr.

All three hard-coded ``aresample=resampler=soxr``. gyan.dev's "essentials"
build (the ffmpeg other audio tools bundle and put on PATH) has no libsoxr,
and there every render failed with "Requested resampling engine is
unavailable", a bare 500 from /process. ``backend.lib.resampler`` probes once
and falls back to swr at matching quality. The sequence tests force the
no-soxr answer, so they replay that machine on any machine.
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

from backend.lib import ffmpeg, ffmpeg_tools, resampler
from backend.modules.delivery import router as delivery_router
from backend.modules.enhance import router as enhance_router

needs_ffmpeg = pytest.mark.skipif(
    ffmpeg_tools.find_ffmpeg() is None, reason="no ffmpeg found"
)


@pytest.fixture
def no_soxr(monkeypatch):
    """This process's ffmpeg answers as a build without libsoxr."""
    monkeypatch.setattr(resampler, "soxr_available", lambda: False)


def _tone(path: Path, sr: int, freq: float = 1000.0, seconds: float = 1.0) -> Path:
    t = np.arange(int(sr * seconds)) / sr
    sf.write(
        str(path),
        (0.5 * np.sin(2 * np.pi * freq * t)).astype(np.float32),
        sr,
        subtype="FLOAT",
    )
    return path


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(delivery_router.router, prefix="/api/edit/delivery")
    app.include_router(enhance_router.router, prefix="/api/edit/enhance")
    return TestClient(app)


def _post(client: TestClient, prefix: str, tool: str, params: dict, src: Path):
    return client.post(
        f"{prefix}/process",
        data={"effect": tool, "params": json.dumps(params), "output_format": "wav"},
        files={"audio": ("input.wav", src.read_bytes(), "audio/wav")},
    )


@needs_ffmpeg
def test_high_quality_src_converts_without_libsoxr(no_soxr, tmp_path):
    src = _tone(tmp_path / "in.wav", 44100)
    r = _post(
        _client(), "/api/edit/delivery", "high_quality_src", {"targetSR": "48000"}, src
    )
    assert r.status_code == 200, r.text
    data, sr = sf.read(io.BytesIO(r.content), dtype="float32")
    assert sr == 48000
    assert abs(len(data) - 48000) <= 1


@needs_ffmpeg
def test_classical_upsample_converts_without_libsoxr(no_soxr, tmp_path):
    src = _tone(tmp_path / "in.wav", 44100)
    params = {"targetSR": "96000", "precision": 28}
    r = _post(_client(), "/api/edit/enhance", "classical_upsample", params, src)
    assert r.status_code == 200, r.text
    _, sr = sf.read(io.BytesIO(r.content), dtype="float32")
    assert sr == 96000


@needs_ffmpeg
@pytest.mark.parametrize("mix", [0.0, 0.5, 1.0])
def test_super_res_renders_without_libsoxr(no_soxr, tmp_path, mix):
    src = _tone(tmp_path / "in.wav", 44100)
    params = {"targetSR": "48000", "guidance": 3.5, "mix": mix}
    r = _post(_client(), "/api/edit/enhance", "super_res", params, src)
    assert r.status_code == 200, r.text
    _, sr = sf.read(io.BytesIO(r.content), dtype="float32")
    assert sr == 48000


@needs_ffmpeg
def test_swr_fallback_rejects_aliases_like_a_mastering_resampler(tmp_path):
    """96 kHz to 44.1 kHz at precision 28: flat at 20 kHz, and a 30 kHz
    tone (above the new Nyquist) folds back more than 120 dB down."""

    def level_db(freq: float) -> float:
        src = _tone(tmp_path / f"in{freq:.0f}.wav", 96000, freq, 2.0)
        out = tmp_path / f"out{freq:.0f}.wav"
        args = ["-af", f"aresample=44100:{resampler.swr_hq(28)}"]
        asyncio.run(ffmpeg.render(src, out, args, extra_out_args=["-c:a", "pcm_f32le"]))
        data, _ = sf.read(str(out), dtype="float64")
        body = data[4410:-4410]
        rms = np.sqrt(np.mean(body**2))
        return float(20 * np.log10(rms / (0.5 / np.sqrt(2)) + 1e-20))

    assert abs(level_db(20000)) < 0.1
    assert level_db(30000) < -120.0


def test_swr_quality_follows_the_precision_knob():
    """Classical Upsample's Precision knob keeps meaning something on the
    fallback: more bits, more taps and a steeper Kaiser window."""
    taps = []
    for bits in (20, 22, 24, 26, 28):
        opts = dict(kv.split("=") for kv in resampler.swr_hq(bits).split(":"))
        assert opts["resampler"] == "swr"
        taps.append((int(opts["filter_size"]), int(opts["kaiser_beta"])))
    assert taps == sorted(taps) and len(set(taps)) == 5


def test_soxr_is_used_when_this_ffmpeg_has_it(monkeypatch):
    monkeypatch.setattr(resampler, "soxr_available", lambda: True)
    assert resampler.hq_resampler(24) == "resampler=soxr:precision=24"
    args = delivery_router._hq_src({"targetSR": "48000"})
    assert args == ["-af", "aresample=resampler=soxr:precision=28", "-ar", "48000"]


def test_soxr_probe_answers_false_without_ffmpeg(monkeypatch):
    monkeypatch.setattr(
        ffmpeg_tools, "resolve", lambda force=False: ffmpeg_tools.Resolution(build=None)
    )
    assert resampler.soxr_available() is False
    assert resampler.hq_resampler(28) == resampler.swr_hq(28)


def test_soxr_follows_the_build_the_backend_runs(monkeypatch):
    """The first ffmpeg on PATH can lack libsoxr while the resolved build has
    it; the resampler asks the resolved build."""
    build = ffmpeg_tools.FFmpegBuild(
        ffmpeg="/opt/full/ffmpeg", version="test", soxr=True, rubberband=True
    )
    monkeypatch.setattr(
        ffmpeg_tools,
        "resolve",
        lambda force=False: ffmpeg_tools.Resolution(build=build),
    )
    assert resampler.hq_resampler(24) == "resampler=soxr:precision=24"


def test_a_process_before_the_startup_probe_resolves_off_the_event_loop(monkeypatch):
    """A High-Quality SRC render that arrives before the startup probe has
    chosen a build must not run that probe (several ffmpeg spawns) on the
    event loop inside the handler."""
    import threading

    order: list[tuple[str, threading.Thread]] = []
    build = ffmpeg_tools.FFmpegBuild(
        ffmpeg="/opt/full/ffmpeg", version="test", soxr=True, rubberband=True
    )

    def fake_resolve(force=False):
        # Like the real one: a cached choice answers without probing.
        if ffmpeg_tools._resolution is not None:
            return ffmpeg_tools._resolution
        order.append(("resolve", threading.current_thread()))
        res = ffmpeg_tools.Resolution(build=build)
        monkeypatch.setattr(ffmpeg_tools, "_resolution", res)
        return res

    real_hq_src = delivery_router._hq_src

    def recording_hq_src(params):
        order.append(("handler", threading.current_thread()))
        return real_hq_src(params)

    async def fake_render(*_a, **_k):
        raise ffmpeg.FFmpegError(1, "stop here")

    monkeypatch.setattr(ffmpeg_tools, "_resolution", None)
    monkeypatch.setattr(ffmpeg_tools, "resolve", fake_resolve)
    monkeypatch.setattr(ffmpeg, "render", fake_render)
    tool = next(t for t in delivery_router.TOOLS if t.id == "high_quality_src")
    monkeypatch.setattr(tool, "handler", recording_hq_src)

    buf = io.BytesIO()
    sf.write(buf, np.zeros(441, dtype=np.float32), 44100, format="WAV")
    r = _client().post(
        "/api/edit/delivery/process",
        data={
            "effect": "high_quality_src",
            "params": json.dumps({"targetSR": "48000"}),
            "output_format": "wav",
        },
        files={"audio": ("input.wav", buf.getvalue(), "audio/wav")},
    )
    assert r.status_code == 500
    assert [step for step, _ in order] == ["resolve", "handler"]
    (_, probe_thread), (_, loop_thread) = order
    assert probe_thread is not loop_thread
