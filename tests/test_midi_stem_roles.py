"""Stem-to-MIDI conversion by stem role.

A separation hands the MIDI runner a bass, a vocal, a guitar, a piano, an
"other" stem and, from a 12-stem run, the five LARSNET kit parts. Each one is
a different instrument and is transcribed and written as one:

* basic-pitch runs with settings for the role (range, thresholds, note
  length), and a bass or lead vocal comes out one note at a time;
* each pitched file carries a General MIDI program for its role and no pitch
  wheel where chords sound;
* every kit part goes to the drum engine and comes out on the General MIDI
  voice of that part, on channel 10.

Everything runs on synthetic audio or a mocked engine; no GPU is needed.
"""

from __future__ import annotations

import inspect
from collections.abc import Callable
from pathlib import Path

import mido
import numpy as np
import pretty_midi
import pytest
import soundfile as sf

from backend.modules.midi import engine
from backend.modules.midi import runner as runner_module
from backend.modules.midi.drums import GM, transcribe_drums
from backend.modules.midi.engine import (
    BASIC_PITCH_ROLE_SETTINGS,
    basic_pitch_settings,
    convert_to_midi,
    hint_for_stem,
    monophonic_line,
    role_for_stem,
)

SR = 22050
KIT_PARTS = ("kick", "snare", "toms", "hihat", "cymbals")


# --------------------------------------------------------------------------
# Synthetic audio
# --------------------------------------------------------------------------


def _noise(rng: np.random.Generator, n: int, lo: float | None, hi: float | None):
    spec = np.fft.rfft(rng.standard_normal(n))
    freqs = np.fft.rfftfreq(n, d=1.0 / SR)
    mask = np.ones_like(freqs, dtype=bool)
    if lo is not None:
        mask &= freqs >= lo
    if hi is not None:
        mask &= freqs < hi
    spec[~mask] = 0.0
    out = np.fft.irfft(spec, n=n)
    return out / (np.std(out) + 1e-9)


def _decay(n: int, tau: float) -> np.ndarray:
    t = np.arange(n) / SR
    env = np.exp(-t / tau)
    fade = max(1, int(0.01 * SR))
    env[-fade:] *= np.linspace(1.0, 0.0, fade)
    return env


def _kick(rng):
    n = int(0.08 * SR)
    return 0.9 * _decay(n, 0.03) * np.sin(2 * np.pi * 60.0 * np.arange(n) / SR)


def _snare(rng):
    n = int(0.06 * SR)
    return 0.35 * _decay(n, 0.025) * _noise(rng, n, 200.0, 3000.0)


def _tom(freq: float):
    def make(rng):
        n = int(0.3 * SR)
        return 0.8 * _decay(n, 0.12) * np.sin(2 * np.pi * freq * np.arange(n) / SR)

    return make


def _closed_hat(rng):
    n = int(0.008 * SR)
    return 0.25 * np.linspace(1.0, 0.2, n) * _noise(rng, n, 7000.0, None)


def _open_hat(rng):
    n = int(0.45 * SR)
    return 0.25 * _decay(n, 0.4) * _noise(rng, n, 7000.0, None)


def _crash(rng):
    n = int(1.2 * SR)
    return 0.4 * _decay(n, 0.8) * _noise(rng, n, 300.0, None)


Hit = tuple[float, Callable[[np.random.Generator], np.ndarray]]


def _render(path: Path, hits: list[Hit], seconds: float) -> Path:
    rng = np.random.default_rng(7)
    buf = np.zeros(int(seconds * SR), dtype=np.float64)
    for t, make in hits:
        sig = make(rng)
        i = int(round(t * SR))
        n = min(sig.size, buf.size - i)
        buf[i : i + n] += sig[:n]
    sf.write(str(path), buf.astype(np.float32), SR)
    return path


def _kit_part(path: Path, part: str) -> tuple[Path, int]:
    """One LARSNET-style part stem and the number of hits in it."""
    hits: list[Hit]
    if part == "kick":
        hits = [(0.1 + 0.5 * i, _kick) for i in range(6)]
    elif part == "snare":
        hits = [(0.35 + 0.5 * i, _snare) for i in range(6)]
    elif part == "toms":
        hits = [
            (0.1 + 0.6 * i, _tom(freq))
            for i, freq in enumerate((240.0, 150.0, 90.0, 240.0, 150.0, 90.0))
        ]
    elif part == "hihat":
        hits = [
            (0.1 + 0.5 * i, _open_hat if i % 3 == 2 else _closed_hat) for i in range(6)
        ]
    else:
        hits = [(0.1, _crash), (1.6, _crash)]
    return _render(path, hits, 3.8), len(hits)


def _drum_notes(path: Path) -> list[tuple[int, int]]:
    """``(channel, pitch)`` for every note-on in a MIDI file."""
    out = []
    for track in mido.MidiFile(str(path)).tracks:
        for msg in track:
            if msg.type == "note_on" and msg.velocity > 0:
                out.append((msg.channel, msg.note))
    return out


def _wav(tmp_path: Path, name: str = "stem.wav") -> Path:
    path = tmp_path / name
    sf.write(str(path), np.zeros(SR, dtype=np.float32), SR)
    return path


# --------------------------------------------------------------------------
# basic-pitch settings per role, one note at a time for bass and lead vocal
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("name", "role"),
    [
        ("bass", "bass"),
        ("vocals", "vocals"),
        ("vocals_lead", "vocals"),
        ("vocals_back", "backing_vocals"),
        ("vocals_backing", "backing_vocals"),
        ("guitar", "guitar"),
        ("piano", "piano"),
        ("Keys", "piano"),
        ("other", "other"),
        ("no_vocals", "mix"),
        ("kick", "kick"),
        ("snare", "snare"),
        ("toms", "toms"),
        ("hihat", "hihat"),
        ("cymbals", "cymbals"),
        ("drums", "drums"),
        ("Bass Drum", "kick"),
        ("", None),
        (None, None),
        ("field recording", None),
    ],
)
def test_role_for_stem_reads_the_separation_names(name, role):
    assert role_for_stem(name) == role


def test_each_pitched_role_has_settings_that_fit_its_instrument():
    bass = basic_pitch_settings("bass")
    vocals = basic_pitch_settings("vocals")
    guitar = basic_pitch_settings("guitar")
    piano = basic_pitch_settings("piano")
    other = basic_pitch_settings("other")
    for s in (bass, vocals, guitar, piano, other):
        assert s.minimum_frequency is not None and s.maximum_frequency is not None
        assert s.minimum_frequency < s.maximum_frequency
        assert 0.0 < s.frame_threshold < 1.0 and 0.0 < s.onset_threshold < 1.0
        assert s.minimum_note_length_ms > 0
    # A four-string bass reaches E1 (41.2 Hz) and no bass part sits above ~G4.
    assert bass.minimum_frequency <= 41.2 and bass.maximum_frequency <= 450.0
    # A singer's range, low bass voice (E2) to soprano top (C6).
    assert vocals.minimum_frequency <= 82.4 and vocals.maximum_frequency >= 1046.5
    # Standard tuning low E (82.4 Hz) to the 24th fret of the high E.
    assert guitar.minimum_frequency <= 82.4 and guitar.maximum_frequency >= 1318.5
    # The whole keyboard, A0 to C8.
    assert piano.minimum_frequency <= 27.5 and piano.maximum_frequency >= 4186.0
    assert bass.monophonic and vocals.monophonic
    assert not guitar.monophonic and not piano.monophonic and not other.monophonic
    assert not basic_pitch_settings("backing_vocals").monophonic


def test_the_full_mix_keeps_the_library_defaults():
    mix = basic_pitch_settings(None)
    assert mix is basic_pitch_settings("mix")
    assert mix.onset_threshold == 0.5
    assert mix.frame_threshold == 0.3
    assert mix.minimum_note_length_ms == pytest.approx(127.70)
    assert mix.minimum_frequency is None and mix.maximum_frequency is None
    assert mix.program == 4  # the program basic-pitch has always written
    assert not mix.monophonic


class _FakePredict:
    """basic_pitch.inference.predict: records its settings, returns notes.

    Every call is bound against the installed ``predict`` signature, so a
    renamed parameter fails here and not in the user's LOG."""

    def __init__(self, real, notes):
        self.signature = inspect.signature(real)
        self.notes = notes
        self.calls: list[dict] = []

    def __call__(self, audio_path, model_or_model_path, **kwargs):
        self.signature.bind(audio_path, model_or_model_path, **kwargs)
        self.calls.append(kwargs)
        return {}, pretty_midi.PrettyMIDI(), list(self.notes)


@pytest.fixture
def fake_basic_pitch(monkeypatch):
    inference = pytest.importorskip("basic_pitch.inference")
    real = inference.predict
    monkeypatch.setattr(engine, "_load_basic_pitch_model", lambda: object())

    def install(notes):
        fake = _FakePredict(real, notes)
        monkeypatch.setattr(inference, "predict", fake)
        return fake

    return install


# A chord (no bends on its notes survive), then one bent note on its own,
# then a plain note. The old file left the wheel where the bent note ended,
# so the plain note after it sounded a third of a semitone sharp.
CHORD_THEN_BEND = [
    (0.0, 1.0, 60, 0.7, [1] * 20),
    (0.0, 1.0, 64, 0.6, [0] * 20),
    (0.0, 1.0, 67, 0.6, None),
    (1.2, 1.8, 62, 0.8, [1, 1, 1, 3, 4, 4, 1, 1]),
    (2.0, 2.5, 60, 0.7, [1, 1, 1, 1]),
    (2.6, 3.0, 64, 0.7, None),
]


@pytest.mark.parametrize("role", ["bass", "vocals", "guitar", "piano", "other"])
def test_each_role_runs_basic_pitch_with_its_own_settings(
    fake_basic_pitch, tmp_path: Path, role
):
    fake = fake_basic_pitch(CHORD_THEN_BEND)
    res = engine._run_basic_pitch(_wav(tmp_path), tmp_path / "out.mid", role=role)
    assert res["ok"] is True, res
    s = BASIC_PITCH_ROLE_SETTINGS[role]
    (call,) = fake.calls
    assert call["onset_threshold"] == s.onset_threshold
    assert call["frame_threshold"] == s.frame_threshold
    assert call["minimum_note_length"] == s.minimum_note_length_ms
    assert call["minimum_frequency"] == s.minimum_frequency
    assert call["maximum_frequency"] == s.maximum_frequency


def test_the_full_mix_runs_basic_pitch_with_its_defaults(fake_basic_pitch, tmp_path):
    fake = fake_basic_pitch(CHORD_THEN_BEND)
    res = convert_to_midi(
        _wav(tmp_path), tmp_path / "full.mid", hint="generic", auto_install=False
    )
    assert res["ok"] is True, res
    (call,) = fake.calls
    assert call["onset_threshold"] == 0.5
    assert call["frame_threshold"] == 0.3
    assert call["minimum_note_length"] == pytest.approx(127.70)
    assert call["minimum_frequency"] is None
    assert call["maximum_frequency"] is None
    pm = pretty_midi.PrettyMIDI(str(tmp_path / "full.mid"))
    assert [i.program for i in pm.instruments] == [4]
    assert len(pm.instruments[0].notes) == len(CHORD_THEN_BEND)
    # A mix is chords: a channel-wide wheel would bend every one of them.
    assert _pitchwheels(tmp_path / "full.mid") == []


def _overlaps(notes) -> list:
    ordered = sorted(notes, key=lambda n: n.start)
    return [
        (a.pitch, b.pitch)
        for a, b in zip(ordered, ordered[1:])
        if b.start < a.end - 1e-6
    ]


def test_a_bass_line_keeps_the_fundamental_one_note_at_a_time():
    notes = [
        (0.00, 0.50, 33, 0.60, None),  # A1
        (0.01, 0.50, 45, 0.50, None),  # its octave, struck with it
        (0.10, 0.40, 52, 0.35, None),  # a harmonic starting under it
        (0.50, 1.00, 36, 0.65, None),  # C2
        (0.52, 0.90, 48, 0.40, None),  # its octave
        (0.95, 1.50, 40, 0.60, None),  # E2, played legato into C2's tail
    ]
    line = monophonic_line(notes, pick="lowest", min_len=0.07)
    assert [n[2] for n in line] == [33, 36, 40]
    for a, b in zip(line, line[1:]):
        assert b[0] >= a[1]
    assert line[1][1] == pytest.approx(0.95)  # C2 ends where E2 starts


def test_a_lead_vocal_keeps_the_loudest_line_one_note_at_a_time():
    notes = [
        (0.00, 0.50, 60, 0.70, None),
        (0.02, 0.50, 72, 0.40, None),  # octave error struck with it
        (0.45, 1.00, 62, 0.70, None),  # the next sung note, legato
        (0.60, 0.90, 74, 0.30, None),  # its octave, quieter, inside it
        (1.10, 1.40, 55, 0.20, None),  # a quiet low note on its own
    ]
    line = monophonic_line(notes, pick="loudest", min_len=0.1)
    assert [n[2] for n in line] == [60, 62, 55]
    assert line[0][1] == pytest.approx(0.45)


# basic-pitch's own note events (bass settings, CPU) for the legato bass line
# of _legato_bass_wav, A1 B1 C2 D2 E2 D2 C2 B1, each note ringing a moment
# into the next, the B1 played softly. The D2 after the C2 is read at 0.50
# (basic-pitch gave 0.55) to stand for a softer stroke. At each change
# basic-pitch re-strikes the ringing note a few milliseconds before the new
# one (A1 at 0.453 under B1 at 0.488), and it reads C2's twelfth as F#3 (54),
# a semitone flat.
LEGATO_BASS_EVENTS = [
    (0.058, 0.290, 33, 0.59, None),
    (0.151, 0.395, 52, 0.38, None),
    (0.186, 0.267, 45, 0.32, None),
    (0.290, 0.453, 33, 0.69, None),
    (0.453, 0.557, 33, 0.40, None),
    (0.488, 0.801, 35, 0.48, None),
    (0.894, 1.022, 36, 0.57, None),
    (0.917, 1.196, 55, 0.33, None),
    (1.022, 1.335, 36, 0.64, None),
    (1.289, 1.625, 38, 0.50, None),
    (1.358, 1.556, 57, 0.29, None),
    (1.695, 1.823, 40, 0.61, None),
    (1.707, 1.846, 59, 0.40, None),
    (1.753, 1.834, 52, 0.38, None),
    (1.823, 2.079, 40, 0.70, None),
    (2.079, 2.277, 40, 0.41, None),
    (2.091, 2.428, 38, 0.54, None),
    (2.138, 2.254, 57, 0.37, None),
    (2.405, 2.486, 36, 0.25, None),
    (2.486, 2.637, 36, 0.59, None),
    (2.521, 2.788, 55, 0.34, None),
    (2.637, 2.846, 36, 0.73, None),
    (2.846, 3.078, 36, 0.40, None),
    (2.939, 3.043, 54, 0.35, None),
    (3.078, 3.287, 35, 0.71, None),
    (3.299, 3.612, 35, 0.62, None),
]
LEGATO_BASS_LINE = [33, 35, 36, 38, 40, 38, 36, 35]


def _runs(pitches) -> list[int]:
    """Pitches with repeats of the same note collapsed: basic-pitch splits a
    long note where its onset activation rises again."""
    out: list[int] = []
    for p in pitches:
        if not out or out[-1] != p:
            out.append(p)
    return out


def test_a_legato_bass_line_keeps_every_note_it_plays():
    """The soft B1 starts 35 ms after basic-pitch re-strikes the ringing A1;
    a lowest-note rule applied to that pair dropped the B1. The soft D2
    starts under the C2 it follows and rings past it; a quieter-and-higher
    rule dropped it too. The F#3 inside the C2 is its twelfth."""
    line = monophonic_line(LEGATO_BASS_EVENTS, pick="lowest", min_len=0.07)
    assert _runs(n[2] for n in line) == LEGATO_BASS_LINE
    for a, b in zip(line, line[1:]):
        assert b[0] >= a[1]


def test_a_bass_double_stop_keeps_its_root_and_a_late_tail_does_not_win():
    notes = [
        # A root and its fifth struck together, the fifth ringing longer:
        # both sound on, so the root is the line's note.
        (0.00, 0.50, 33, 0.60, None),
        (0.01, 0.60, 40, 0.55, None),
        # B1 played, and a short tail of the A1 re-read just after its onset.
        (1.00, 1.40, 35, 0.50, None),
        (1.02, 1.08, 33, 0.40, None),
    ]
    line = monophonic_line(notes, pick="lowest", min_len=0.07)
    assert [n[2] for n in line] == [33, 35]


def _legato_bass_wav(path: Path) -> Path:
    """The line of :data:`LEGATO_BASS_EVENTS` rendered with its harmonics."""
    parts = [
        (55.0, 0.8),
        (61.74, 0.35),
        (65.41, 0.8),
        (73.42, 0.3),
        (82.41, 0.8),
        (73.42, 0.35),
        (65.41, 0.8),
        (61.74, 0.3),
    ]
    step = 0.4
    t = np.arange(int(SR * (0.8 + step * len(parts)))) / SR
    y = np.zeros_like(t)
    for i, (f, amp) in enumerate(parts):
        start = 0.1 + i * step
        seg = (t >= start) & (t < start + step + 0.25)
        tt = t[seg] - start
        env = np.minimum(1.0, tt / 0.005) * np.exp(-tt / 0.5)
        env = np.where(tt > step, env * np.exp(-(tt - step) / 0.05), env)
        y[seg] += (
            amp
            * env
            * (
                0.6 * np.sin(2 * np.pi * f * tt)
                + 0.3 * np.sin(2 * np.pi * 2 * f * tt)
                + 0.15 * np.sin(2 * np.pi * 3 * f * tt)
            )
        )
    sf.write(str(path), y.astype(np.float32), SR)
    return path


def test_a_real_legato_bass_stem_keeps_every_note_it_plays(monkeypatch, tmp_path: Path):
    """basic-pitch itself on the legato line, through the stem conversion."""
    pytest.importorskip("basic_pitch.inference")
    monkeypatch.setattr(engine, "onnx_providers", lambda: ["CPUExecutionProvider"])
    monkeypatch.setattr(engine, "_basic_pitch_model", None)
    wav = _legato_bass_wav(tmp_path / "bass.wav")
    out = tmp_path / "bass.mid"
    res = convert_to_midi(wav, out, hint="generic", role="bass", auto_install=False)
    assert res["ok"] is True, res
    notes = sorted(
        pretty_midi.PrettyMIDI(str(out)).instruments[0].notes, key=lambda n: n.start
    )
    assert _overlaps(notes) == []
    assert _runs(n.pitch for n in notes) == LEGATO_BASS_LINE


def _wheel_at_each_note_on(path: Path) -> list[tuple[int, int]]:
    """``(note, wheel value)`` at every note-on, walking the file in order."""
    mid = mido.MidiFile(str(path))
    wheel = {}
    out = []
    for msg in mido.merge_tracks(mid.tracks):
        if msg.type == "pitchwheel":
            wheel[msg.channel] = msg.pitch
        elif msg.type == "note_on" and msg.velocity > 0:
            out.append((msg.note, wheel.get(msg.channel, 0)))
    return out


def _pitchwheels(path: Path) -> list:
    return [
        m for t in mido.MidiFile(str(path)).tracks for m in t if m.type == "pitchwheel"
    ]


def _programs(path: Path) -> list[int]:
    return [
        m.program
        for t in mido.MidiFile(str(path)).tracks
        for m in t
        if m.type == "program_change"
    ]


@pytest.mark.parametrize(
    ("role", "gm_name"),
    [
        ("guitar", "Acoustic Guitar (steel)"),
        ("piano", "Acoustic Grand Piano"),
        ("other", "String Ensemble 1"),
        ("backing_vocals", "Choir Aahs"),
    ],
)
def test_a_polyphonic_stem_writes_its_program_and_no_pitch_wheel(
    fake_basic_pitch, tmp_path: Path, role, gm_name
):
    fake_basic_pitch(CHORD_THEN_BEND)
    out = tmp_path / f"{role}.mid"
    res = engine._run_basic_pitch(_wav(tmp_path), out, role=role)
    assert res["ok"] is True, res
    programs = _programs(out)
    assert len(programs) == 1
    assert pretty_midi.program_to_instrument_name(programs[0]) == gm_name
    assert _pitchwheels(out) == []
    pm = pretty_midi.PrettyMIDI(str(out))
    assert len(pm.instruments[0].notes) == len(CHORD_THEN_BEND)  # chords kept
    assert all(m[0] != 9 for m in _drum_notes(out))  # never the drum channel


@pytest.mark.parametrize(
    ("role", "gm_name"),
    [("bass", "Electric Bass (finger)"), ("vocals", "Voice Oohs")],
)
def test_a_monophonic_stem_bends_one_note_and_hands_the_wheel_back(
    fake_basic_pitch, tmp_path: Path, role, gm_name
):
    fake_basic_pitch(CHORD_THEN_BEND)
    out = tmp_path / f"{role}.mid"
    res = engine._run_basic_pitch(_wav(tmp_path), out, role=role)
    assert res["ok"] is True, res
    (program,) = _programs(out)
    assert pretty_midi.program_to_instrument_name(program) == gm_name
    pm = pretty_midi.PrettyMIDI(str(out))
    assert _overlaps(pm.instruments[0].notes) == []
    # The bent note (62) bends: its movement, centred on the note, reaches
    # a semitone.
    wheels = _pitchwheels(out)
    assert wheels, "the bent note lost its bend"
    assert max(abs(m.pitch) for m in wheels) >= 4096
    # Every note that carries no movement of its own starts on a centred wheel.
    for note, wheel in _wheel_at_each_note_on(out):
        if note != 62:
            assert wheel == 0, (note, wheel)
    # And the file ends with the wheel centred.
    assert wheels[-1].pitch == 0


def test_a_stem_written_through_the_runner_keeps_its_program_after_the_tempo_stamp(
    fake_basic_pitch, tmp_path: Path
):
    fake_basic_pitch(CHORD_THEN_BEND)
    out = tmp_path / "bass.mid"
    res = convert_to_midi(
        _wav(tmp_path), out, hint="generic", role="bass", auto_install=False, bpm=97.0
    )
    assert res["ok"] is True, res
    assert res["tempo_bpm"] == 97.0
    pm = pretty_midi.PrettyMIDI(str(out))
    assert pretty_midi.program_to_instrument_name(pm.instruments[0].program) == (
        "Electric Bass (finger)"
    )
    assert abs(float(pm.get_tempo_changes()[1][0]) - 97.0) < 0.5
    assert _overlaps(pm.instruments[0].notes) == []


def _bass_line_wav(path: Path) -> Path:
    """A1, C2, E2, A2 with their harmonics, half a second each."""
    t = np.arange(int(SR * 2.2)) / SR
    y = np.zeros_like(t)
    for i, f in enumerate((55.0, 65.41, 82.41, 110.0)):
        seg = (t >= 0.1 + i * 0.5) & (t < 0.1 + i * 0.5 + 0.45)
        tt = t[seg] - (0.1 + i * 0.5)
        env = np.minimum(1.0, tt / 0.01) * np.exp(-tt / 0.6)
        y[seg] += env * (
            0.6 * np.sin(2 * np.pi * f * tt)
            + 0.3 * np.sin(2 * np.pi * 2 * f * tt)
            + 0.15 * np.sin(2 * np.pi * 3 * f * tt)
        )
    sf.write(str(path), y.astype(np.float32), SR)
    return path


def test_a_real_bass_stem_comes_out_as_its_bass_line(monkeypatch, tmp_path: Path):
    """basic-pitch itself, on the CPU: the harmonics it reports over a bass
    note are gone and the four notes of the line are there."""
    pytest.importorskip("basic_pitch.inference")
    monkeypatch.setattr(engine, "onnx_providers", lambda: ["CPUExecutionProvider"])
    monkeypatch.setattr(engine, "_basic_pitch_model", None)
    wav = _bass_line_wav(tmp_path / "bass.wav")
    out = tmp_path / "bass.mid"
    res = convert_to_midi(wav, out, hint="generic", role="bass", auto_install=False)
    assert res["ok"] is True, res
    pm = pretty_midi.PrettyMIDI(str(out))
    notes = pm.instruments[0].notes
    assert _overlaps(notes) == []
    pitches = {n.pitch for n in notes}
    assert {33, 36, 40, 45} <= pitches
    assert pitches <= {33, 36, 40, 45}


# --------------------------------------------------------------------------
# Every kit part goes to the drum engine, on its own voice
# --------------------------------------------------------------------------


@pytest.mark.parametrize("name", [*KIT_PARTS, "drums", "Hi-Hat", "Tom 1", "Crash"])
def test_every_percussive_stem_routes_to_the_drum_engine(name):
    assert hint_for_stem(name) == "drums"


PART_PITCHES = {
    "kick": {GM["kick"]},
    "snare": {GM["snare"]},
    "toms": {GM["tom_low"], GM["tom_mid"], GM["tom_high"]},
    "hihat": {GM["hihat_closed"], GM["hihat_open"]},
    "cymbals": {GM["crash"], GM["ride"]},
}


@pytest.mark.parametrize("part", KIT_PARTS)
def test_a_kit_part_is_written_on_its_own_voice_on_channel_10(tmp_path: Path, part):
    wav, hits = _kit_part(tmp_path / f"{part}.wav", part)
    out = tmp_path / f"{part}.mid"
    res = convert_to_midi(wav, out, hint="drums", role=part, auto_install=False)
    assert res["ok"] is True, res
    assert res["engine"] == "drum-onsets"
    notes = _drum_notes(out)
    assert len(notes) == hits
    assert {ch for ch, _ in notes} == {9}  # MIDI channel 10
    assert {p for _, p in notes} <= PART_PITCHES[part]


def test_toms_are_voiced_by_their_pitch(tmp_path: Path):
    wav, _ = _kit_part(tmp_path / "toms.wav", "toms")
    out = tmp_path / "toms.mid"
    res = transcribe_drums(wav, out, part="toms")
    assert res["ok"] is True, res
    pitches = [p for _, p in _drum_notes(out)]
    high, mid, low = GM["tom_high"], GM["tom_mid"], GM["tom_low"]
    assert pitches == [high, mid, low, high, mid, low]


def test_a_hihat_part_tells_open_from_closed(tmp_path: Path):
    wav, _ = _kit_part(tmp_path / "hihat.wav", "hihat")
    out = tmp_path / "hihat.mid"
    res = transcribe_drums(wav, out, part="hihat")
    assert res["ok"] is True, res
    closed, open_ = GM["hihat_closed"], GM["hihat_open"]
    assert [p for _, p in _drum_notes(out)] == [closed, closed, open_] * 2


def test_bleed_from_the_rest_of_the_kit_is_not_written_on_a_part(tmp_path: Path):
    """A LARSNET kick part carries the snare faintly between the kicks; those
    are not kicks."""

    def faint_snare(rng):
        return 0.02 * _snare(rng)

    hits = [(0.1 + 0.5 * i, _kick) for i in range(6)]
    hits += [(0.35 + 0.5 * i, faint_snare) for i in range(6)]
    wav = _render(tmp_path / "kick.wav", hits, 3.8)
    out = tmp_path / "kick.mid"
    res = transcribe_drums(wav, out, part="kick")
    assert res["ok"] is True, res
    notes = _drum_notes(out)
    assert len(notes) == 6
    assert {p for _, p in notes} == {GM["kick"]}


def test_a_twelve_stem_entry_writes_each_kit_part_through_the_drum_engine(
    monkeypatch, tmp_path: Path
):
    """convert_entry on the files a 12-stem run leaves: the five kit parts
    never reach basic-pitch, and the bass does, as a bass."""
    from backend.modules.library.db import LibraryDB

    pitched: list[tuple[str, object]] = []

    def fake_basic_pitch(audio_path, output_path, *, role=None):
        pitched.append((Path(audio_path).stem, role))
        pm = pretty_midi.PrettyMIDI()
        pm.instruments.append(pretty_midi.Instrument(program=0))
        pm.write(str(output_path))
        return {"ok": True, "engine": "basic_pitch", "engine_version": "x"}

    monkeypatch.setattr(engine, "_run_basic_pitch", fake_basic_pitch)
    monkeypatch.setattr(engine, "_basic_pitch_available", lambda: True)

    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track"})
    stems_dir = tmp_path / "entry" / "stems"
    stems_dir.mkdir(parents=True)
    counts = {}
    for part in KIT_PARTS:
        wav, counts[part] = _kit_part(stems_dir / f"{part}.wav", part)
        db.add_stem(
            stem_id=f"track__{part}",
            entry_id="track",
            stem_name=part,
            audio_path=str(wav),
        )
    bass = _wav(stems_dir, "bass.wav")
    db.add_stem(
        stem_id="track__bass", entry_id="track", stem_name="bass", audio_path=str(bass)
    )
    full = _wav(tmp_path, "full.wav")

    summary = runner_module.convert_entry(
        db, "track", full, tmp_path / "entry", from_stems=True, auto_install=False
    )
    assert summary["status"] == "complete", summary
    assert sorted(pitched, key=str) == sorted(
        [("full", None), ("bass", "bass")], key=str
    )
    rows = {r["source_ref"]: r for r in db.list_midis("track") if r["source"] == "stem"}
    for part in KIT_PARTS:
        row = rows[f"track__{part}"]
        assert row["engine"] == "drum-onsets"
        notes = _drum_notes(Path(row["midi_path"]))
        assert len(notes) == counts[part]
        assert {ch for ch, _ in notes} == {9}
        assert {p for _, p in notes} <= PART_PITCHES[part]
