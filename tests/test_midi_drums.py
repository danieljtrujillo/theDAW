"""Tests for the model-free drum-stem transcription engine.

A synthetic 8-second kit at 120 BPM is rendered with numpy and written with
soundfile (both base dependencies), so the whole path — librosa onsets,
spectral rules, pretty_midi write — runs for real with no model weights and
no network. Ground-truth onset times are kept so timing can be asserted.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pretty_midi  # type: ignore[import]
import pytest
import soundfile as sf  # type: ignore[import]

from backend.modules.midi import drums
from backend.modules.midi.drums import GM, transcribe_drums
from backend.modules.midi.engine import (
    _route,
    convert_to_midi,
    engine_capabilities,
    hint_for_stem,
)

SR = 22050
BPM = 120.0
BEAT = 60.0 / BPM  # 0.5 s
OFFSET = 0.1  # the first hit is not at t=0 so every onset has a silent lead-in
DURATION = 8.0 + 2 * OFFSET  # 16 beats at 120 BPM fit after the lead-in


def _place(buf: np.ndarray, t: float, sig: np.ndarray) -> None:
    i = int(round(t * SR))
    n = min(sig.size, buf.size - i)
    if n > 0:
        buf[i : i + n] += sig[:n]


def _bandpass_noise(
    rng: np.random.Generator, n: int, lo: float | None, hi: float | None
) -> np.ndarray:
    """White noise shaped in the frequency domain to ``[lo, hi)`` Hz."""
    noise = rng.standard_normal(n)
    spec = np.fft.rfft(noise)
    freqs = np.fft.rfftfreq(n, d=1.0 / SR)
    mask = np.ones_like(freqs, dtype=bool)
    if lo is not None:
        mask &= freqs >= lo
    if hi is not None:
        mask &= freqs < hi
    spec[~mask] = 0.0
    out = np.fft.irfft(spec, n=n)
    return out / (np.std(out) + 1e-9)


def _kick(rng: np.random.Generator) -> np.ndarray:
    n = int(0.080 * SR)
    t = np.arange(n) / SR
    env = np.exp(-t / 0.030)
    fade = int(0.020 * SR)  # no hard cut at the tail (a real kick does not click)
    env[-fade:] *= 0.5 * (1.0 + np.cos(np.linspace(0.0, np.pi, fade)))
    return 0.9 * env * np.sin(2 * np.pi * 60.0 * t)


def _snare(rng: np.random.Generator) -> np.ndarray:
    n = int(0.060 * SR)
    t = np.arange(n) / SR
    env = np.exp(-t / 0.025)
    return 0.35 * env * _bandpass_noise(rng, n, 200.0, 3000.0)


def _hat(rng: np.random.Generator) -> np.ndarray:
    n = int(0.008 * SR)
    env = np.linspace(1.0, 0.2, n)
    return 0.25 * env * _bandpass_noise(rng, n, 7000.0, None)


def _crash(rng: np.random.Generator) -> np.ndarray:
    """Long broadband wash; a cymbal has essentially nothing below ~400 Hz."""
    n = int(0.600 * SR)
    t = np.arange(n) / SR
    env = np.exp(-t / 0.40)
    env[-int(0.02 * SR) :] *= np.linspace(1.0, 0.0, int(0.02 * SR))
    return 0.8 * env * _bandpass_noise(rng, n, 400.0, None)


def synth_kit(path: Path) -> dict[str, list[float]]:
    """Render the fixture to ``path`` and return ground-truth onsets per voice."""
    rng = np.random.default_rng(7)
    buf = np.zeros(int(DURATION * SR), dtype=np.float64)
    truth: dict[str, list[float]] = {
        "kick": [],
        "snare": [],
        "hihat_closed": [],
        "crash": [],
    }
    n_beats = int((DURATION - OFFSET) / BEAT)  # 16
    beats = [OFFSET + k * BEAT for k in range(n_beats)]
    assert len(beats) == 16
    for k, t in enumerate(beats):
        _place(buf, t, _kick(rng))
        truth["kick"].append(t)
        if k % 4 in (1, 3):
            _place(buf, t, _snare(rng))
            truth["snare"].append(t)
    for k in range(2 * n_beats):
        t = OFFSET + k * BEAT / 2.0
        if t + 0.01 < DURATION:
            _place(buf, t, _hat(rng))
            truth["hihat_closed"].append(t)
    _place(buf, 4.0, _crash(rng))
    truth["crash"].append(4.0)
    peak = float(np.max(np.abs(buf))) or 1.0
    buf = (buf / peak) * 0.95
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), buf.astype(np.float32), SR, subtype="FLOAT")
    truth["beats"] = beats
    return truth


@pytest.fixture(scope="module")
def kit(tmp_path_factory: pytest.TempPathFactory) -> tuple[Path, dict]:
    wav = tmp_path_factory.mktemp("drums") / "drums.wav"
    truth = synth_kit(wav)
    return wav, truth


@pytest.fixture(scope="module")
def transcribed(kit: tuple[Path, dict]) -> tuple[dict, Path, dict]:
    wav, truth = kit
    out = wav.parent / "drums.mid"
    res = transcribe_drums(wav, out, bpm=BPM)
    return res, out, truth


def _starts_for(midi_path: Path, pitch: int) -> list[float]:
    pm = pretty_midi.PrettyMIDI(str(midi_path))
    return sorted(
        n.start for inst in pm.instruments for n in inst.notes if n.pitch == pitch
    )


def _max_offset(found: list[float], truth: list[float]) -> float:
    """Largest distance from a ground-truth onset to its nearest detection."""
    found_arr = np.asarray(found)
    return max(float(np.min(np.abs(found_arr - t))) for t in truth)


# --------------------------------------------------------------------------


def test_transcribe_reports_ok_and_engine(transcribed):
    res, out, _ = transcribed
    assert res["ok"] is True, res
    assert res["engine"] == "drum-onsets"
    assert res["engine_version"] == "1"
    assert res["bpm"] == BPM
    assert res["notes_count"] == sum(res["per_class"].values())
    assert res["onsets"] > 0
    assert out.is_file()


def test_per_class_counts_match_the_fixture(transcribed):
    res, _, truth = transcribed
    per = res["per_class"]
    assert abs(per.get("kick", 0) - len(truth["kick"])) <= 1, per
    assert abs(per.get("snare", 0) - len(truth["snare"])) <= 1, per
    assert per.get("hihat_closed", 0) >= 24, per
    assert per.get("crash", 0) >= 1, per


def test_midi_has_one_drum_instrument_on_gm_pitches(transcribed):
    _, out, _ = transcribed
    pm = pretty_midi.PrettyMIDI(str(out))
    assert len(pm.instruments) == 1
    inst = pm.instruments[0]
    assert inst.is_drum is True
    assert inst.notes, "no notes written"
    pitches = {n.pitch for n in inst.notes}
    assert pitches <= set(GM.values()), pitches
    tempi = pm.get_tempo_changes()[1]
    assert tempi.size >= 1 and abs(float(tempi[0]) - BPM) < 0.5


def test_kick_and_snare_timing_within_30ms(transcribed):
    _, out, truth = transcribed
    kicks = _starts_for(out, GM["kick"])
    snares = _starts_for(out, GM["snare"])
    assert _max_offset(kicks, truth["kick"]) <= 0.030
    assert _max_offset(snares, truth["snare"]) <= 0.030


def test_velocity_range_and_note_length(transcribed):
    _, out, _ = transcribed
    pm = pretty_midi.PrettyMIDI(str(out))
    for n in pm.instruments[0].notes:
        assert 40 <= n.velocity <= 127
        assert abs((n.end - n.start) - drums.RULES["note_len_sec"]) < 1e-6


def test_beats_grid_quantises_only_nearby_onsets(kit):
    wav, truth = kit
    out = wav.parent / "drums_grid.mid"
    res = transcribe_drums(wav, out, bpm=BPM, beats=truth["beats"])
    assert res["ok"] is True, res
    grid_step = BEAT / 4.0
    kicks = _starts_for(out, GM["kick"])
    for start in kicks:
        k = (start - OFFSET) / grid_step
        assert abs(k - round(k)) < 1e-6, start


def test_quantise_helper_keeps_far_onsets():
    grid = np.array([0.0, 0.5, 1.0, 1.5])
    assert drums._quantise_to_grid(0.51, grid, 0.025) == pytest.approx(0.5)
    assert drums._quantise_to_grid(0.56, grid, 0.025) == pytest.approx(0.56)
    assert drums._quantise_to_grid(1.74, grid, 0.025) == pytest.approx(1.75)
    assert drums._quantise_to_grid(0.3, np.array([0.5]), 0.025) == 0.3


def test_bpm_is_estimated_when_not_given(kit):
    wav, _ = kit
    out = wav.parent / "drums_nobpm.mid"
    res = transcribe_drums(wav, out)
    assert res["ok"] is True
    bpm = float(res["bpm"])
    assert bpm > 0
    # librosa may pick 120 or an octave of it; either is a real tempo map.
    assert any(abs(bpm - c) < 5.0 for c in (60.0, 120.0, 240.0)), bpm


def test_missing_audio_returns_error(tmp_path: Path):
    res = transcribe_drums(tmp_path / "nope.wav", tmp_path / "nope.mid")
    assert res["ok"] is False
    assert "audio not found" in res["error"]


def test_silence_yields_empty_but_valid_midi(tmp_path: Path):
    wav = tmp_path / "silence.wav"
    sf.write(str(wav), np.zeros(SR * 2, dtype=np.float32), SR)
    out = tmp_path / "silence.mid"
    res = transcribe_drums(wav, out, bpm=100.0)
    assert res["ok"] is True
    assert res["notes_count"] == 0
    assert res["per_class"] == {}
    # pretty_midi drops a note-less instrument on write; the file is still a
    # valid, parseable SMF with the requested tempo and no notes.
    pm = pretty_midi.PrettyMIDI(str(out))
    assert sum(len(i.notes) for i in pm.instruments) == 0
    assert abs(float(pm.get_tempo_changes()[1][0]) - 100.0) < 0.5


# --------------------------------------------------------------------------
# engine.py integration


def test_engine_capabilities_advertise_drum_onsets():
    assert engine_capabilities()["drum_onsets"] is True


def test_hint_drums_routes_to_drum_onsets():
    assert hint_for_stem("drums") == "drums"
    assert hint_for_stem("Drums") == "drums"
    assert hint_for_stem("drum_kit") == "drums"
    assert hint_for_stem("vocals") == "generic"
    assert _route("drums") == "drum_onsets"


def test_convert_to_midi_with_drums_hint_uses_drum_engine(kit):
    wav, truth = kit
    out = wav.parent / "via_engine.mid"
    res = convert_to_midi(
        wav, out, hint="drums", auto_install=False, bpm=BPM, beats=truth["beats"]
    )
    assert res["ok"] is True, res
    assert res["engine"] == "drum-onsets"
    assert res["notes_count"] > 0
    pm = pretty_midi.PrettyMIDI(str(out))
    assert pm.instruments[0].is_drum is True


def test_convert_entry_routes_drum_stem_to_drum_engine(kit, tmp_path: Path):
    """A 'drums' stem row lands in ``midis`` with engine 'drum-onsets' and the
    entry's analysis tempo (bpm + beats) is used for the tempo map. The full
    track needs a pitched engine and may fail; the stem must not."""
    from backend.modules.library.db import LibraryDB
    from backend.modules.midi.runner import convert_entry

    wav, truth = kit
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track"})
    db.upsert_analysis("track", {"bpm": 97.0, "beats": truth["beats"]})
    db.add_stem(
        stem_id="track__drums",
        entry_id="track",
        stem_name="drums",
        audio_path=str(wav),
    )
    entry_dir = tmp_path / "entry"
    entry_dir.mkdir()

    summary = convert_entry(
        db, "track", wav, entry_dir, from_stems=True, auto_install=False
    )
    drum_result = next(r for r in summary["results"] if r["target"] == "drums")
    assert drum_result["ok"] is True, drum_result
    assert drum_result["engine"] == "drum-onsets"
    assert drum_result["bpm"] == 97.0
    assert summary["successes"] >= 1

    rows = {r["source_ref"]: r for r in db.list_midis("track") if r["source"] == "stem"}
    row = rows["track__drums"]
    assert row["engine"] == "drum-onsets"
    assert row["engine_version"] == "1"
    assert row["notes_count"] > 0
    pm = pretty_midi.PrettyMIDI(row["midi_path"])
    assert pm.instruments[0].is_drum is True
    assert abs(float(pm.get_tempo_changes()[1][0]) - 97.0) < 0.5
