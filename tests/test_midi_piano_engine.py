"""The piano transcription engine imports, and says why when it does not.

piano_transcription_inference imports audioread at module level without
declaring it, so a venv synced from the lock never had it: the engine reported
itself unavailable with no line anywhere, and every piano stem went to
basic-pitch. Nothing here runs the model; the transcriber is replaced where a
test needs one.
"""

from __future__ import annotations

import importlib
import logging
import sys
import tomllib
import types
from pathlib import Path

import numpy as np
import pretty_midi
import pytest
import soundfile as sf

from backend.modules.midi import engine

ROOT = Path(__file__).resolve().parents[1]


def test_a_missing_piano_engine_dependency_is_logged_by_name(monkeypatch, caplog):
    """piano_transcription_inference imports audioread at module level; when it
    is absent the engine used to report False with no line anywhere, and every
    piano stem went to basic-pitch without a word."""
    real_import = importlib.import_module

    def fake_import(name, *args, **kwargs):
        if name == "piano_transcription_inference":
            raise ModuleNotFoundError("No module named 'audioread'", name="audioread")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(engine.importlib, "import_module", fake_import)
    monkeypatch.setattr(engine, "_WARNED_UNAVAILABLE", set())
    with caplog.at_level(logging.WARNING, logger=engine.log.name):
        assert engine._piano_transcription_available() is False
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1
    assert "audioread" in warnings[0].getMessage()
    assert "piano" in warnings[0].getMessage()
    assert engine.engine_unavailable_reasons()["piano_transcription_inference"] == (
        "missing module: audioread"
    )

    # Every capability poll asks again; the LOG gets the line once.
    caplog.clear()
    with caplog.at_level(logging.WARNING, logger=engine.log.name):
        assert engine._piano_transcription_available() is False
    assert [r for r in caplog.records if r.levelno == logging.WARNING] == []


def test_audioread_is_a_declared_and_locked_dependency():
    """``uv sync`` installs what the lock lists for the project, and the piano
    engine cannot import without audioread."""
    project = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    deps = project["project"]["dependencies"]
    assert any(d.replace(" ", "").startswith("audioread>=3.1.0") for d in deps)

    lock = tomllib.loads((ROOT / "uv.lock").read_text(encoding="utf-8"))
    packages = {p["name"]: p for p in lock["package"]}
    assert "audioread" in packages
    assert any(
        w["url"].endswith("-py3-none-any.whl") for w in packages["audioread"]["wheels"]
    )
    app = packages["stable-audio-3"]
    assert "audioread" in {d["name"] for d in app["dependencies"]}


def _with_audioread(monkeypatch) -> None:
    """The real audioread when the venv has it, else a module with the one
    name piano_transcription_inference reads at import. Either way the
    package's cached import is dropped so it imports again here."""
    try:
        importlib.import_module("audioread")
    except ModuleNotFoundError:
        fake = types.ModuleType("audioread")
        ffdec = types.ModuleType("audioread.ffdec")
        setattr(ffdec, "FFmpegAudioFile", object)
        setattr(fake, "ffdec", ffdec)
        monkeypatch.setitem(sys.modules, "audioread", fake)
        monkeypatch.setitem(sys.modules, "audioread.ffdec", ffdec)
    for name in list(sys.modules):
        if name.startswith("piano_transcription_inference"):
            monkeypatch.delitem(sys.modules, name)


def test_the_piano_engine_is_available_once_audioread_is_installed(monkeypatch):
    pytest.importorskip("torch")
    _with_audioread(monkeypatch)
    monkeypatch.setattr(engine, "_WARNED_UNAVAILABLE", set())
    assert engine._piano_transcription_available() is True
    assert engine._route("piano") == "piano_transcription_inference"


def test_the_piano_engine_reads_the_stem_through_the_app_audio_loader(
    monkeypatch, tmp_path: Path
):
    """The package's own loader shells out to ffmpeg through audioread for
    every file; the stem is a WAV libsndfile reads directly."""
    pytest.importorskip("torch")
    _with_audioread(monkeypatch)
    pti = importlib.import_module("piano_transcription_inference")

    wav = tmp_path / "piano.wav"
    t = np.arange(int(44100 * 1.0)) / 44100
    stereo = np.stack([np.sin(2 * np.pi * 440 * t)] * 2, axis=1) * 0.3
    sf.write(str(wav), stereo.astype(np.float32), 44100)

    def refuse(*a, **k):
        raise AssertionError("audioread/ffmpeg loader used")

    seen: dict = {}

    class FakeTranscription:
        def __init__(self, device="cpu", checkpoint_path=None, **kwargs):
            seen["device"] = device

        def transcribe(self, audio, midi_path):
            seen["audio"] = audio
            pm = pretty_midi.PrettyMIDI()
            inst = pretty_midi.Instrument(program=0)
            inst.notes.append(pretty_midi.Note(80, 69, 0.0, 0.5))
            pm.instruments.append(inst)
            pm.write(midi_path)
            return {}

    monkeypatch.setattr(pti, "load_audio", refuse)
    monkeypatch.setattr(pti, "PianoTranscription", FakeTranscription)
    monkeypatch.setattr(engine, "_ensure_piano_checkpoint", lambda: tmp_path / "x.pth")
    monkeypatch.setattr(engine, "torch_device", lambda: "cpu")

    out = tmp_path / "piano.mid"
    res = engine._run_piano_transcription(wav, out)
    assert res["ok"] is True, res
    audio = seen["audio"]
    assert audio.ndim == 1
    assert audio.dtype == np.float32
    assert abs(audio.size - pti.sample_rate) <= 2  # one second at the model's rate
    assert res["notes_count"] == 1


def test_the_settings_card_says_why_the_piano_engine_is_missing(monkeypatch):
    from backend.modules.storage import router as storage_router

    monkeypatch.setattr(
        engine,
        "engine_capabilities",
        lambda: {
            "basic_pitch": True,
            "piano_transcription_inference": False,
            "drum_onsets": True,
        },
    )
    monkeypatch.setattr(
        engine,
        "engine_unavailable_reasons",
        lambda: {"piano_transcription_inference": "missing module: audioread"},
    )
    status = storage_router._midi_provider_status()
    chip = next(
        m for m in status["models"] if m["id"] == "piano_transcription_inference"
    )
    assert chip["source"] == "missing"
    assert chip["reason"] == "missing module: audioread"
