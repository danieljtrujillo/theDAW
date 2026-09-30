"""The vocal prepare reads its notes the way a vocal stem is converted.

The prepare isolates a vocal and hands it to basic-pitch for the melody the
SING tab draws. It ran with basic-pitch's defaults, a full-mix reading: every
octave error and overtone basic-pitch reports came through as a note sung at
the same time. It now runs with the vocal role's settings and keeps one note
at a time, as the MIDI runner does for a vocal stem. basic-pitch's predict is
replaced; its signature is checked against the installed package.
"""

from __future__ import annotations

import asyncio
import inspect
from pathlib import Path

import numpy as np
import pretty_midi
import pytest
import soundfile as sf

from backend.core.jobs import Job
from backend.modules.midi import engine
from backend.modules.midi.engine import BASIC_PITCH_ROLE_SETTINGS
from backend.modules.vocal import service
from backend.modules.vocal.schema import Timing

SR = 22050

# A sung C4 with basic-pitch's octave error struck with it, then D4 sung
# legato into its tail with the D5 overtone sounding inside it.
SUNG = [
    (0.00, 0.50, 60, 0.70, None),
    (0.02, 0.50, 72, 0.40, None),
    (0.45, 1.00, 62, 0.70, None),
    (0.60, 0.90, 74, 0.30, None),
]


def _prepare(monkeypatch, tmp_path: Path) -> Job:
    wav = tmp_path / "take.wav"
    sf.write(str(wav), np.zeros(SR, dtype=np.float32), SR)
    monkeypatch.setattr(engine, "_load_basic_pitch_model", lambda: object())
    monkeypatch.setattr(engine, "_basic_pitch_available", lambda: True)
    monkeypatch.setattr(service, "_resolve_path", lambda asset_id: wav)
    monkeypatch.setattr(service.f0_curve, "compute_f0_curve", lambda p: None)
    monkeypatch.setattr(service.segments_step, "detect_segments", lambda p: [])
    monkeypatch.setattr(service, "_context", lambda p: Timing())
    monkeypatch.setattr(service, "_persist", lambda *a, **k: None)
    monkeypatch.setattr(service, "_artifacts", {})
    job = Job(id="prepare", module="vocal", label="prepare")
    asyncio.run(
        service.run_prepare(
            job, {"asset_id": "take", "isolate": False, "cleanup": False}
        )
    )
    return job


def test_the_vocal_prepare_reads_a_melody_one_note_at_a_time(
    monkeypatch, tmp_path: Path
):
    inference = pytest.importorskip("basic_pitch.inference")
    signature = inspect.signature(inference.predict)
    calls: list[dict] = []

    def predict(audio_path, model_or_model_path, **kwargs):
        signature.bind(audio_path, model_or_model_path, **kwargs)
        calls.append(kwargs)
        return {}, pretty_midi.PrettyMIDI(), list(SUNG)

    monkeypatch.setattr(inference, "predict", predict)
    job = _prepare(monkeypatch, tmp_path)
    assert job.status == "done", job.error

    vocal = BASIC_PITCH_ROLE_SETTINGS["vocals"]
    (call,) = calls
    assert call["minimum_frequency"] == vocal.minimum_frequency
    assert call["maximum_frequency"] == vocal.maximum_frequency
    assert call["onset_threshold"] == vocal.onset_threshold

    notes = job.result["notes"]
    assert [n["pitch"] for n in notes] == [60, 62]
    assert notes[0]["end_ms"] <= notes[1]["start_ms"]
