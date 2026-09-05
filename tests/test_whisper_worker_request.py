"""The sidecar forwards only whitelisted decoding knobs, and the worker
passes them to faster-whisper. No venv, no model, no subprocess."""

from __future__ import annotations

import asyncio
import io
import json
import os
import sys
import types
from pathlib import Path

from backend.modules.vocal.transcription import sidecar, worker


class _FakeProc:
    def __init__(self, sink: dict):
        self.sink = sink
        self.returncode = 0

    async def communicate(self, data: bytes):
        self.sink["request"] = json.loads(data.decode("utf-8"))
        return b'{"ok": true, "language": "en", "text": "", "segments": []}\n', b""

    def kill(self) -> None:  # pragma: no cover - never reached
        pass


def _run(monkeypatch, extra=None) -> dict:
    sink: dict = {}
    monkeypatch.setattr(sidecar, "ensure_ready", lambda cfg=None: {"critical_ok": True})

    async def fake_exec(*args, **kwargs):
        return _FakeProc(sink)

    monkeypatch.setattr(sidecar.asyncio, "create_subprocess_exec", fake_exec)
    res = asyncio.run(sidecar.transcribe(Path("song.wav"), "en", extra=extra))
    assert res["ok"] is True
    return sink["request"]


def test_sidecar_request_without_extra_is_the_historical_shape(monkeypatch):
    req = _run(monkeypatch)
    assert set(req) == {"audio", "language", "model", "device", "compute_type"}
    assert req["language"] == "en"


def test_sidecar_forwards_only_whitelisted_extra_keys(monkeypatch):
    req = _run(
        monkeypatch,
        extra={
            "initial_prompt": "x",
            "vad_filter": False,
            "beam_size": None,
            "bogus": 1,
        },
    )
    assert req["initial_prompt"] == "x"
    assert req["vad_filter"] is False
    assert "beam_size" not in req  # None keeps the worker default
    assert "bogus" not in req


def test_worker_passes_knobs_to_faster_whisper(monkeypatch, capsys):
    calls: dict = {}

    class FakeModel:
        def __init__(self, *args, **kwargs):
            calls["init"] = (args, kwargs)

        def transcribe(self, audio, **kwargs):
            calls["transcribe"] = kwargs
            return [], None

    fake = types.ModuleType("faster_whisper")
    fake.WhisperModel = FakeModel
    monkeypatch.setitem(sys.modules, "faster_whisper", fake)
    request = {
        "audio": "song.wav",
        "language": "en",
        "model": "small",
        "device": "cpu",
        "compute_type": "int8",
        "initial_prompt": "walking down the road",
        "condition_on_previous_text": False,
        "vad_filter": False,
        "beam_size": 3,
    }
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(request)))
    assert worker.main() == 0
    out = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert out["ok"] is True
    kw = calls["transcribe"]
    assert kw["initial_prompt"] == "walking down the road"
    assert kw["condition_on_previous_text"] is False
    assert kw["vad_filter"] is False
    assert kw["beam_size"] == 3
    assert kw["word_timestamps"] is True


def test_worker_defaults_when_knobs_are_absent(monkeypatch, capsys):
    calls: dict = {}

    class FakeModel:
        def __init__(self, *args, **kwargs):
            pass

        def transcribe(self, audio, **kwargs):
            calls["transcribe"] = kwargs
            return [], None

    fake = types.ModuleType("faster_whisper")
    fake.WhisperModel = FakeModel
    monkeypatch.setitem(sys.modules, "faster_whisper", fake)
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({"audio": "song.wav"})))
    assert worker.main() == 0
    kw = calls["transcribe"]
    assert kw["initial_prompt"] is None
    assert kw["condition_on_previous_text"] is True
    assert kw["vad_filter"] is True
    assert kw["beam_size"] == 5


# ---- GPU by default, CPU fallback ---------------------------------------------------


def _clear_env(monkeypatch):
    for k in (
        "theDAW_WHISPER_DEVICE",
        "theDAW_WHISPER_COMPUTE",
        "theDAW_WHISPER_MODEL",
    ):
        monkeypatch.delenv(k, raising=False)


def test_config_prefers_the_gpu_when_cuda_is_available(monkeypatch):
    _clear_env(monkeypatch)
    monkeypatch.setattr(sidecar, "cuda_available", lambda: True)
    cfg = sidecar.resolve_config()
    assert (
        cfg.device == "cuda"
        and cfg.compute_type == "float16"
        and cfg.model == "large-v3"
    )
    assert cfg.wants_cuda


def test_config_is_cpu_int8_small_without_cuda(monkeypatch):
    _clear_env(monkeypatch)
    monkeypatch.setattr(sidecar, "cuda_available", lambda: False)
    cfg = sidecar.resolve_config()
    assert cfg.device == "cpu" and cfg.compute_type == "int8" and cfg.model == "small"
    assert not cfg.wants_cuda


def test_config_env_overrides_win(monkeypatch):
    _clear_env(monkeypatch)
    monkeypatch.setattr(sidecar, "cuda_available", lambda: True)
    monkeypatch.setenv("theDAW_WHISPER_DEVICE", "cpu")
    monkeypatch.setenv("theDAW_WHISPER_MODEL", "medium")
    cfg = sidecar.resolve_config()
    assert cfg.device == "cpu" and cfg.model == "medium" and cfg.compute_type == "int8"


def test_worker_env_hands_the_cuda_lib_dirs_to_the_child(monkeypatch):
    _clear_env(monkeypatch)
    monkeypatch.setattr(sidecar, "cuda_available", lambda: True)
    monkeypatch.setattr(
        sidecar, "cuda_lib_dirs", lambda exe: ["/x/cublas/bin", "/x/cudnn/bin"]
    )
    env = sidecar.worker_env(sidecar.resolve_config())
    assert env[sidecar.LIB_DIRS_ENV].split(os.pathsep) == [
        "/x/cublas/bin",
        "/x/cudnn/bin",
    ]
    if sys.platform != "win32":
        assert env["LD_LIBRARY_PATH"].startswith("/x/cublas/bin")
    monkeypatch.setattr(sidecar, "cuda_available", lambda: False)
    assert sidecar.LIB_DIRS_ENV not in sidecar.worker_env(sidecar.resolve_config())


def test_worker_falls_back_to_cpu_when_cuda_fails(monkeypatch, capsys):
    calls: list = []

    class FakeModel:
        def __init__(self, size, device="cpu", compute_type="int8"):
            self.device = device
            self.compute_type = compute_type

        def transcribe(self, audio, **kwargs):
            calls.append((self.device, self.compute_type))
            if self.device == "cuda":
                raise RuntimeError("CUDA driver version is insufficient")
            return [], None

    fake = types.ModuleType("faster_whisper")
    fake.WhisperModel = FakeModel
    monkeypatch.setitem(sys.modules, "faster_whisper", fake)
    req = {
        "audio": "song.wav",
        "language": "auto",
        "device": "cuda",
        "compute_type": "float16",
    }
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(req)))
    assert worker.main() == 0
    captured = capsys.readouterr()
    out = json.loads(captured.out.strip().splitlines()[-1])
    assert out["ok"] is True and out["device_used"] == "cpu"
    assert calls == [("cuda", "float16"), ("cpu", "int8")]
    assert "retrying on cpu" in captured.err


def test_worker_auto_language_is_detection(monkeypatch, capsys):
    calls: dict = {}

    class FakeModel:
        def __init__(self, *a, **k):
            pass

        def transcribe(self, audio, **kwargs):
            calls.update(kwargs)
            return [], types.SimpleNamespace(language="es")

    fake = types.ModuleType("faster_whisper")
    fake.WhisperModel = FakeModel
    monkeypatch.setitem(sys.modules, "faster_whisper", fake)
    monkeypatch.setattr(
        sys, "stdin", io.StringIO(json.dumps({"audio": "s.wav", "language": "auto"}))
    )
    assert worker.main() == 0
    assert calls["language"] is None
    out = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert out["language"] == "es"
