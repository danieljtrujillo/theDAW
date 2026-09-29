"""Unit tests for the chord track builder (``gantasmo.chordtrack``).

Both sources run against deterministic synthetic fixtures written into
``tmp_path``: a music21 lead sheet with ``<harmony>`` symbols for the harmony
path, and numpy-synthesised triads (C major then G major) written with
soundfile for the chroma path. No model weights, no network.

The assertions follow what breaks the consumer: the SCORE chord strip animates
from ``startSec``/``endSec`` and reads ``kind``/``pitchClasses`` for colour and
diagrams, and a ``null`` anywhere would fail the TS type guard.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np
import pytest
import soundfile as sf

from backend.modules.notation.exporters import chordtrack as chordtrack_module
from backend.modules.notation.exporters.chordtrack import (
    SCHEMA,
    SCHEMA_VERSION,
    build_chordtrack,
    write_chordtrack,
)

_SR = 22050


# --------------------------------------------------------------------------
# fixtures
# --------------------------------------------------------------------------


def _find_null(value: Any, path: str = "$") -> str:
    """Path of the first JSON null, or ``""``."""
    if value is None:
        return path
    if isinstance(value, dict):
        for key, item in value.items():
            found = _find_null(item, f"{path}.{key}")
            if found:
                return found
    elif isinstance(value, list):
        for index, item in enumerate(value):
            found = _find_null(item, f"{path}[{index}]")
            if found:
                return found
    return ""


def _write_lead_sheet(
    path: Path,
    figures: list[tuple[float, str]],
    *,
    bpm: float = 90.0,
    key_name: str = "C",
    quarters: int = 16,
) -> Path:
    """A one-part lead sheet: ``quarters`` quarter notes plus chord symbols at
    the given quarter offsets (music21 figures, ``-`` spells flats)."""
    from music21 import harmony, key, meter, note, stream, tempo

    score = stream.Score()
    part = stream.Part()
    part.append(tempo.MetronomeMark(number=bpm))
    part.append(meter.TimeSignature("4/4"))
    part.append(key.Key(key_name))
    for offset, figure in figures:
        part.insert(offset, harmony.ChordSymbol(figure))
    for beat in range(quarters):
        n = note.Note("C4")
        n.quarterLength = 1.0
        part.insert(float(beat), n)
    score.insert(0, part)
    path.parent.mkdir(parents=True, exist_ok=True)
    score.write("musicxml", fp=str(path))
    return path


def _triad(midis: list[int], seconds: float) -> np.ndarray:
    t = np.arange(int(_SR * seconds)) / _SR
    out = np.zeros_like(t)
    for midi in midis:
        freq = 440.0 * 2 ** ((midi - 69) / 12)
        # Fundamental plus an octave-below doubling, as a plucked chord has.
        out += np.sin(2 * np.pi * freq * t) + 0.5 * np.sin(2 * np.pi * (freq / 2) * t)
    return out / (len(midis) * 1.5)


@pytest.fixture(scope="module")
def c_then_g_wav(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """8 s at 22050 Hz: C major (0-4 s) then G major (4-8 s)."""
    path = tmp_path_factory.mktemp("chroma") / "x.wav"
    audio = np.concatenate(
        [_triad([60, 64, 67], 4.0), _triad([67, 71, 74], 4.0)]
    ).astype(np.float32)
    sf.write(str(path), audio, _SR)
    return path


@pytest.fixture
def analysis_row() -> dict[str, Any]:
    return {
        "bpm": 120,
        "beats_json": json.dumps([i * 0.5 for i in range(16)]),
        "key": "C",
        "scale": "major",
    }


# --------------------------------------------------------------------------
# harmony source
# --------------------------------------------------------------------------


def test_harmony_timing_kinds_and_contiguity(tmp_path: Path):
    sheet = _write_lead_sheet(
        tmp_path / "lead.musicxml",
        [(0.0, "C"), (4.0, "G7"), (8.0, "Am"), (12.0, "F")],
        bpm=90.0,
    )
    doc = build_chordtrack(
        entry_id="e",
        audio_path=None,
        analysis_row=None,
        lead_sheet_path=sheet,
        method="harmony",
    )

    assert doc["schema"] == SCHEMA
    assert doc["schemaVersion"] == SCHEMA_VERSION
    assert doc["source"] == {
        "entryId": "e",
        "method": "harmony",
        "sourceArtifactId": "",
    }
    assert _find_null(doc) == ""

    chords = doc["chords"]
    assert len(chords) == 4
    sec_per_quarter = 60.0 / 90.0
    expected_starts = [
        0.0,
        4 * sec_per_quarter,
        8 * sec_per_quarter,
        12 * sec_per_quarter,
    ]
    for chord, expected in zip(chords, expected_starts):
        assert chord["startSec"] == pytest.approx(expected, abs=1e-6)
    for earlier, later in zip(chords, chords[1:]):
        assert earlier["endSec"] == pytest.approx(later["startSec"], abs=1e-9)
    assert chords[-1]["endSec"] == pytest.approx(16 * sec_per_quarter, abs=1e-6)

    assert [c["kind"] for c in chords] == [
        "major",
        "dominant-seventh",
        "minor",
        "major",
    ]
    assert [c["rootPc"] for c in chords] == [0, 7, 9, 5]
    assert [c["symbol"] for c in chords] == ["C", "G7", "Am", "F"]
    assert chords[0]["pitchClasses"] == [0, 4, 7]
    assert chords[1]["pitchClasses"][0] == 7 and set(chords[1]["pitchClasses"]) == {
        7,
        11,
        2,
        5,
    }
    assert all(c["bassPc"] == -1 for c in chords)
    assert all(c["confidence"] == 1.0 for c in chords)
    assert [c["id"] for c in chords] == [0, 1, 2, 3]
    assert [c["measure"] for c in chords] == [1, 2, 3, 4]
    assert [c["startBeat"] for c in chords] == [0.0, 4.0, 8.0, 12.0]

    timing = doc["timing"]
    assert timing["bpm"] == pytest.approx(90.0)
    assert timing["beatsPerBar"] == 4
    assert timing["durationSec"] == pytest.approx(16 * sec_per_quarter, abs=1e-6)
    assert timing["beats"][:3] == pytest.approx(
        [0.0, sec_per_quarter, 2 * sec_per_quarter]
    )
    assert timing["downbeats"][:2] == pytest.approx([0.0, 4 * sec_per_quarter])
    assert doc["key"] == {"tonic": "C", "mode": "major", "confidence": 1.0}
    assert doc["stats"]["chordCount"] == 4
    assert doc["stats"]["distinctSymbols"] == 4
    assert doc["stats"]["meanConfidence"] == pytest.approx(1.0)


def test_harmony_spells_flats_in_flat_keys_and_reads_slash_bass(tmp_path: Path):
    sheet = _write_lead_sheet(
        tmp_path / "lead.musicxml",
        [(0.0, "F"), (4.0, "B-"), (8.0, "C7/E"), (12.0, "F")],
        key_name="F",
    )
    doc = build_chordtrack(
        entry_id="e",
        audio_path=None,
        analysis_row=None,
        lead_sheet_path=sheet,
        method="harmony",
    )
    symbols = [c["symbol"] for c in doc["chords"]]
    assert symbols[1] == "Bb"
    assert "A#" not in " ".join(symbols)
    assert doc["chords"][1]["root"] == "Bb"
    assert doc["chords"][1]["rootPc"] == 10
    assert doc["chords"][2]["symbol"] == "C7/E"
    assert doc["chords"][2]["bassPc"] == 4
    assert doc["chords"][2]["rootPc"] == 0
    assert doc["key"]["tonic"] == "F"


def test_harmony_reads_roman_numerals_in_the_local_key(tmp_path: Path):
    sheet = _write_lead_sheet(
        tmp_path / "lead.musicxml",
        [(0.0, "G"), (4.0, "C"), (8.0, "D7"), (12.0, "G")],
        key_name="G",
    )
    doc = build_chordtrack(
        entry_id="e",
        audio_path=None,
        analysis_row=None,
        lead_sheet_path=sheet,
        method="harmony",
    )
    assert [c["roman"] for c in doc["chords"]] == ["I", "IV", "V7", "I"]
    assert {c["romanKey"] for c in doc["chords"]} == {"G major"}
    assert _find_null(doc) == ""


def test_roman_numerals_follow_inversions_applied_chords_and_minor(tmp_path: Path):
    sheet = _write_lead_sheet(
        tmp_path / "lead.musicxml",
        [(0.0, "C"), (4.0, "A7/C#"), (8.0, "Dm"), (12.0, "G7/B"), (16.0, "C")],
        quarters=20,
    )
    doc = build_chordtrack(
        entry_id="e",
        audio_path=None,
        analysis_row=None,
        lead_sheet_path=sheet,
        method="harmony",
    )
    assert [c["roman"] for c in doc["chords"]] == ["I", "V65/ii", "ii", "V65", "I"]
    minor = _write_lead_sheet(
        tmp_path / "minor.musicxml",
        [(0.0, "Am"), (4.0, "Dm"), (8.0, "E7"), (12.0, "Am")],
        key_name="a",
    )
    doc = build_chordtrack(
        entry_id="e",
        audio_path=None,
        analysis_row=None,
        lead_sheet_path=minor,
        method="harmony",
    )
    assert [c["roman"] for c in doc["chords"]] == ["i", "iv", "V7", "i"]
    assert doc["chords"][0]["romanKey"] == "A minor"


def test_chroma_chords_carry_romans_in_the_analysed_key(
    c_then_g_wav: Path, analysis_row: dict[str, Any]
):
    doc = build_chordtrack(
        entry_id="e",
        audio_path=c_then_g_wav,
        analysis_row=analysis_row,
        lead_sheet_path=None,
        method="chroma",
    )
    by_root = {c["rootPc"]: c for c in doc["chords"]}
    assert by_root[0]["roman"] == "I" and by_root[0]["romanKey"] == "C major"
    assert by_root[7]["roman"] == "V"


def test_harmony_merges_repeated_symbols(tmp_path: Path):
    sheet = _write_lead_sheet(
        tmp_path / "lead.musicxml",
        [(0.0, "C"), (4.0, "C"), (8.0, "G"), (12.0, "G")],
    )
    doc = build_chordtrack(
        entry_id="e",
        audio_path=None,
        analysis_row=None,
        lead_sheet_path=sheet,
        method="harmony",
    )
    assert [c["symbol"] for c in doc["chords"]] == ["C", "G"]
    assert doc["chords"][0]["endSec"] == pytest.approx(doc["chords"][1]["startSec"])


def test_harmony_without_symbols_raises(tmp_path: Path):
    sheet = _write_lead_sheet(tmp_path / "plain.musicxml", [])
    with pytest.raises(ValueError):
        build_chordtrack(
            entry_id="e",
            audio_path=None,
            analysis_row=None,
            lead_sheet_path=sheet,
            method="harmony",
        )


def test_unknown_method_or_resolution_is_rejected(tmp_path: Path):
    with pytest.raises(ValueError):
        build_chordtrack(
            entry_id="e",
            audio_path=None,
            analysis_row=None,
            lead_sheet_path=None,
            method="magic",
        )
    with pytest.raises(ValueError):
        build_chordtrack(
            entry_id="e",
            audio_path=None,
            analysis_row=None,
            lead_sheet_path=None,
            resolution="phrase",
        )


# --------------------------------------------------------------------------
# chroma source
# --------------------------------------------------------------------------


def test_chroma_with_analysis_row_finds_c_then_g(
    c_then_g_wav: Path, analysis_row: dict[str, Any]
):
    doc = build_chordtrack(
        entry_id="e",
        audio_path=c_then_g_wav,
        analysis_row=analysis_row,
        lead_sheet_path=None,
        method="chroma",
    )
    assert doc["source"]["method"] == "chroma"
    assert _find_null(doc) == ""
    chords = doc["chords"]
    assert len(chords) >= 2

    first = chords[0]
    assert first["startSec"] == 0.0
    assert first["rootPc"] == 0
    assert first["kind"] == "major"
    assert first["symbol"] == "C"
    assert first["pitchClasses"] == [0, 4, 7]

    g_chords = [c for c in chords if c["rootPc"] == 7]
    assert g_chords, "expected a G chord in the second half"
    assert abs(g_chords[0]["startSec"] - 4.0) <= 0.6

    for chord in chords:
        assert 0.0 < chord["confidence"] <= 1.0
    for earlier, later in zip(chords, chords[1:]):
        assert earlier["endSec"] == pytest.approx(later["startSec"])
    assert chords[-1]["endSec"] == pytest.approx(8.0, abs=1e-3)

    timing = doc["timing"]
    assert timing["bpm"] == pytest.approx(120.0)
    assert timing["beats"] == pytest.approx([i * 0.5 for i in range(16)])
    assert timing["downbeats"] == pytest.approx([0.0, 2.0, 4.0, 6.0])
    assert timing["durationSec"] == pytest.approx(8.0, abs=1e-3)
    assert doc["key"]["tonic"] == "C" and doc["key"]["mode"] == "major"


def test_chroma_without_analysis_row_uses_beat_tracker(c_then_g_wav: Path):
    doc = build_chordtrack(
        entry_id="e",
        audio_path=c_then_g_wav,
        analysis_row=None,
        lead_sheet_path=None,
        method="chroma",
    )
    assert _find_null(doc) == ""
    assert len(doc["chords"]) >= 2
    assert doc["timing"]["bpm"] > 0
    assert len(doc["timing"]["beats"]) >= 2
    assert doc["key"] == {"tonic": "", "mode": "", "confidence": 0.0}
    roots = [c["rootPc"] for c in doc["chords"]]
    assert 0 in roots and 7 in roots


def test_chroma_bar_resolution_changes_on_downbeats(
    c_then_g_wav: Path, analysis_row: dict[str, Any]
):
    doc = build_chordtrack(
        entry_id="e",
        audio_path=c_then_g_wav,
        analysis_row=analysis_row,
        lead_sheet_path=None,
        method="chroma",
        resolution="bar",
    )
    downbeats = doc["timing"]["downbeats"]
    assert doc["chords"][0]["startSec"] == 0.0
    for chord in doc["chords"][1:]:
        assert any(abs(chord["startSec"] - d) < 1e-6 for d in downbeats), chord
    assert len(doc["chords"]) >= 2


def test_chroma_without_sevenths_only_emits_triads(
    c_then_g_wav: Path, analysis_row: dict[str, Any]
):
    doc = build_chordtrack(
        entry_id="e",
        audio_path=c_then_g_wav,
        analysis_row=analysis_row,
        lead_sheet_path=None,
        method="chroma",
        include_sevenths=False,
    )
    assert {c["kind"] for c in doc["chords"]} <= {"major", "minor", "none"}


def test_chroma_needs_audio():
    with pytest.raises(ValueError):
        build_chordtrack(
            entry_id="e",
            audio_path=None,
            analysis_row=None,
            lead_sheet_path=None,
            method="chroma",
        )


# --------------------------------------------------------------------------
# no chord (N.C.): contrast and silence, never a lifted chroma floor
# --------------------------------------------------------------------------


def _partials(midis: list[int], seconds: float, drive: float = 0.0) -> np.ndarray:
    """Sawtooth-like tones (12 partials each); ``drive`` > 0 clips them through
    tanh, the way an overdriven guitar adds its own harmonics."""
    t = np.arange(int(_SR * seconds)) / _SR
    out = np.zeros_like(t)
    for midi in midis:
        freq = 440.0 * 2 ** ((midi - 69) / 12)
        for k in range(1, 13):
            if freq * k < _SR / 2:
                out += np.sin(2 * np.pi * freq * k * t) / k
    out /= len(midis)
    return np.tanh(out * drive) / np.tanh(drive) if drive else out


def _noise(seconds: float, seed: int, tilt: float = 0.5) -> np.ndarray:
    """Seeded noise with a 1/f**tilt power spectrum (0 white, 1 pink)."""
    rng = np.random.default_rng(seed)
    n = int(_SR * seconds)
    spectrum = np.fft.rfft(rng.standard_normal(n))
    freqs = np.fft.rfftfreq(n, 1.0 / _SR)
    freqs[0] = freqs[1]
    return np.fft.irfft(spectrum / freqs ** (tilt / 2.0), n)


def _kit(seconds: float, seed: int = 11) -> np.ndarray:
    """An unpitched drum kit at 120 bpm: a noise thump on 1, a noise snare on
    3, a hi-hat on every eighth."""
    rng = np.random.default_rng(seed)
    n = int(_SR * seconds)
    out = np.zeros(n)
    t = np.arange(int(0.15 * _SR)) / _SR
    kick = np.cumsum(rng.standard_normal(len(t))) * np.exp(-t * 40)
    kick = (kick - kick.mean()) / np.abs(kick - kick.mean()).max()
    snare = rng.standard_normal(len(t)) * np.exp(-t * 25)
    hat = np.diff(rng.standard_normal(len(t) + 1)) * np.exp(-t * 80) * 0.5
    for eighth in range(int(seconds / 0.25) + 1):
        start = int(eighth * 0.25 * _SR)
        end = min(n, start + len(t))
        if end <= start:
            continue
        hit = hat + (kick if eighth % 4 == 0 else snare if eighth % 4 == 2 else 0.0)
        out[start:end] += hit[: end - start]
    return out


def _at_db(signal: np.ndarray, dbfs: float) -> np.ndarray:
    """``signal`` scaled to an RMS of ``dbfs``."""
    return signal / np.sqrt(np.mean(signal**2)) * 10 ** (dbfs / 20)


def _chroma_track(
    tmp_path: Path, audio: np.ndarray, key: tuple[str, str] = ("F", "minor")
) -> dict[str, Any]:
    """Write ``audio`` and build its chord track from the chroma, with an
    analysis row of 120 bpm beats and ``key``, as the route passes it."""
    path = tmp_path / "mix.wav"
    sf.write(str(path), audio.astype(np.float32), _SR)
    beats = [i * 0.5 for i in range(int(len(audio) / _SR / 0.5))]
    row = {
        "bpm": 120,
        "beats_json": json.dumps(beats),
        "key": key[0],
        "scale": key[1],
    }
    return build_chordtrack(
        entry_id="e",
        audio_path=path,
        analysis_row=row,
        lead_sheet_path=None,
        method="chroma",
    )


def _nc_seconds(doc: dict[str, Any], start: float = 0.0, end: float = 1e9) -> float:
    """Seconds of N.C. inside [start, end]."""
    return sum(
        max(0.0, min(end, c["endSec"]) - max(start, c["startSec"]))
        for c in doc["chords"]
        if c["symbol"] == "N.C."
    )


def test_dense_power_chord_reads_its_chord_not_nc(tmp_path: Path):
    # An overdriven F5 (F2 C3 F3 C4) under a noise wash 3 dB louder than it and
    # a drum kit: the wash lifts every pitch class, which is what a dense full
    # mix does to the chroma. The flat no-chord template used to outscore every
    # chord here and the whole track read N.C.
    seconds = 8.0
    audio = (
        _at_db(_partials([41, 48, 53, 60], seconds, drive=4.0), -12)
        + _at_db(_noise(seconds, seed=1), -9)
        + _at_db(_kit(seconds), -12)
    )
    doc = _chroma_track(tmp_path, audio)
    assert _nc_seconds(doc) == 0.0, [c["symbol"] for c in doc["chords"]]
    for chord in doc["chords"]:
        assert chord["rootPc"] == 5, chord["symbol"]
        assert 0 in chord["pitchClasses"], chord["symbol"]


@pytest.mark.parametrize(
    "voicing",
    [
        pytest.param([53, 55, 60, 65], id="Fsus2"),
        pytest.param([53, 58, 60, 65], id="Fsus4"),
    ],
)
def test_dense_sus_chord_reads_a_chord_not_nc(tmp_path: Path, voicing: list[int]):
    # A sus chord over its root in the bass, under the same wash and kit: no
    # third to speak of, still a chord on F with its fifth.
    seconds = 8.0
    audio = (
        _at_db(_partials(voicing, seconds, drive=2.0), -12)
        + _at_db(_partials([41], seconds), -18)
        + _at_db(_noise(seconds, seed=2), -9)
        + _at_db(_kit(seconds), -12)
    )
    doc = _chroma_track(tmp_path, audio)
    assert _nc_seconds(doc) == 0.0, [c["symbol"] for c in doc["chords"]]
    for chord in doc["chords"]:
        assert {5, 0} <= set(chord["pitchClasses"]), chord["symbol"]


@pytest.mark.parametrize("quiet", ["digital silence", "room tone"])
def test_silence_around_a_chord_reads_nc(tmp_path: Path, quiet: str):
    # Room tone is what a recording holds before the music: a -90 dBFS hiss
    # and a -75 dBFS mains hum at 60 Hz. The hum is a pitch, and it used to
    # read as a chord (B major seventh) where nothing plays.
    edge = 2.0
    if quiet == "room tone":
        t = np.arange(int(_SR * edge)) / _SR
        still = _at_db(_noise(edge, seed=7, tilt=0.0), -90) + _at_db(
            np.sin(2 * np.pi * 60.0 * t), -75
        )
    else:
        still = np.zeros(int(_SR * edge))
    audio = np.concatenate([still, _at_db(_partials([60, 64, 67], 4.0), -14), still])
    doc = _chroma_track(tmp_path, audio, key=("C", "major"))

    assert {c["symbol"] for c in doc["chords"]} == {"N.C.", "C"}
    assert _nc_seconds(doc, 0.0, edge) >= edge - 0.5
    assert _nc_seconds(doc, 6.0, 8.0) >= edge - 0.5
    assert _nc_seconds(doc, 2.5, 5.5) == 0.0
    assert [c["symbol"] for c in doc["chords"]] == ["N.C.", "C", "N.C."]


@pytest.mark.parametrize(
    "texture",
    [
        pytest.param(lambda s: _at_db(_noise(s, seed=4, tilt=0.0), -20), id="white"),
        pytest.param(lambda s: _at_db(_noise(s, seed=5, tilt=1.0), -20), id="pink"),
        pytest.param(lambda s: _at_db(_kit(s), -12), id="drum kit"),
        pytest.param(
            lambda s: _at_db(_kit(s), -12) + _at_db(_noise(s, seed=6), -20),
            id="drum kit and wash",
        ),
    ],
)
def test_unpitched_texture_reads_nc(tmp_path: Path, texture: Any):
    doc = _chroma_track(tmp_path, texture(8.0))
    assert [c["symbol"] for c in doc["chords"]] == ["N.C."]
    assert 0.0 < doc["chords"][0]["confidence"] <= 1.0


def test_drum_break_between_chords_reads_nc(tmp_path: Path):
    audio = np.concatenate(
        [
            _at_db(_partials([60, 64, 67], 4.0), -14),
            _at_db(_kit(6.0), -12),
            _at_db(_partials([55, 59, 62], 4.0), -14),
        ]
    )
    doc = _chroma_track(tmp_path, audio, key=("C", "major"))
    assert _nc_seconds(doc, 4.0, 10.0) >= 5.0
    assert doc["chords"][0]["symbol"] == "C"
    assert doc["chords"][-1]["symbol"] == "G"


def _chord_over_floor(floor: float) -> np.ndarray:
    """One beat of chroma: F minor's F, Ab and C over ``floor`` on the other
    nine pitch classes (L1-normalised, as the pooling leaves it)."""
    column = np.full(12, floor)
    column[5], column[8], column[0] = 1.0, 0.8, 0.9
    return column / column.sum()


def _decode(labels: list[tuple[int, str]], log_emission: np.ndarray) -> list[int]:
    stay = chordtrack_module._STAY_PROB
    switch = (1.0 - stay) / (len(labels) - 1)
    return chordtrack_module._viterbi(log_emission, stay, switch)


@pytest.mark.parametrize("floor", [0.1, 0.3, 0.5, 0.6])
def test_a_lifted_chroma_floor_keeps_the_chord(floor: float):
    pooled = np.tile(_chord_over_floor(floor), (16, 1))
    labels, log_emission, _ = chordtrack_module._emissions(
        pooled, np.ones(16), True, 5, "minor"
    )
    path = _decode(labels, log_emission)
    assert {labels[s] for s in path} <= {(5, "minor"), (5, "minor-seventh")}, [
        labels[s] for s in path
    ]


def test_the_lifted_floor_outscores_every_chord_on_a_flat_template():
    # Why the flat template read N.C. over a dense mix: with the chord tones
    # at not quite twice the floor, the flat profile is closer by cosine than
    # any chord template.
    column = _chord_over_floor(0.6)
    labels, templates = chordtrack_module._templates(True)
    chords = [i for i, (_, kind) in enumerate(labels) if kind != "N"]
    templates = templates[chords]
    unit = column / np.linalg.norm(column)
    flat = np.full(12, 1.0 / np.sqrt(12.0))
    assert float(unit @ flat) > float((templates @ unit).max()) + 0.25


def test_flat_or_silent_beats_read_nc():
    chord = _chord_over_floor(0.1)
    flat = np.full(12, 1.0 / 12.0)
    pooled = np.vstack([chord] * 4 + [flat] * 4 + [chord] * 4 + [chord] * 4)
    presence = np.array([1.0] * 12 + [0.0] * 4)
    labels, log_emission, confidence = chordtrack_module._emissions(
        pooled, presence, True, 5, "minor"
    )
    path = _decode(labels, log_emission)
    kinds = [labels[s][1] for s in path]
    assert kinds[:4] == ["minor"] * 4
    assert kinds[4:8] == ["N"] * 4
    assert kinds[8:12] == ["minor"] * 4
    assert kinds[12:] == ["N"] * 4
    no_chord = confidence[:, -1]
    assert no_chord[4:8] == pytest.approx([1.0] * 4)
    assert no_chord[12:] == pytest.approx([1.0] * 4)
    assert (no_chord[:4] < 0.5).all()


def test_presence_is_zero_for_true_silence_and_one_for_music():
    levels = np.array([-200.0, -95.0, -75.0, -40.0, -20.0, -14.0, -12.0])
    presence = chordtrack_module._presence(levels)
    # -200 and -95 dBFS: digital silence and dither, under the absolute floor.
    assert presence[:2] == pytest.approx([0.0, 0.0])
    # -75 dBFS: over the absolute floor, but 62 dB under the loud beats.
    assert presence[2] == pytest.approx(0.0)
    # Anything a mix plays at keeps all of its chord evidence.
    assert presence[3:] == pytest.approx([1.0] * 4)


# --------------------------------------------------------------------------
# auto selection
# --------------------------------------------------------------------------


def test_auto_prefers_lead_sheet_with_two_or_more_symbols(
    tmp_path: Path, c_then_g_wav: Path
):
    sheet = _write_lead_sheet(tmp_path / "lead.musicxml", [(0.0, "D"), (8.0, "A")])
    doc = build_chordtrack(
        entry_id="e",
        audio_path=c_then_g_wav,
        analysis_row=None,
        lead_sheet_path=sheet,
        method="auto",
        source_artifact_id="lead-1",
    )
    assert doc["source"]["method"] == "harmony"
    assert doc["source"]["sourceArtifactId"] == "lead-1"
    assert [c["symbol"] for c in doc["chords"]] == ["D", "A"]


def test_auto_falls_back_to_chroma_when_lead_sheet_is_bare(
    tmp_path: Path, c_then_g_wav: Path, analysis_row: dict[str, Any]
):
    sheet = _write_lead_sheet(tmp_path / "plain.musicxml", [])
    doc = build_chordtrack(
        entry_id="e",
        audio_path=c_then_g_wav,
        analysis_row=analysis_row,
        lead_sheet_path=sheet,
        method="auto",
    )
    assert doc["source"]["method"] == "chroma"
    assert doc["chords"][0]["rootPc"] == 0


def test_auto_with_no_sources_raises():
    with pytest.raises(ValueError):
        build_chordtrack(
            entry_id="e",
            audio_path=None,
            analysis_row=None,
            lead_sheet_path=None,
            method="auto",
        )


# --------------------------------------------------------------------------
# writer
# --------------------------------------------------------------------------


def test_write_chordtrack_round_trips(tmp_path: Path):
    sheet = _write_lead_sheet(
        tmp_path / "lead.musicxml", [(0.0, "C"), (4.0, "G7"), (8.0, "Am"), (12.0, "F")]
    )
    output = tmp_path / "notation" / "song__chords.chordtrack.json"
    result = write_chordtrack(
        output,
        entry_id="e",
        audio_path=None,
        analysis_row=None,
        lead_sheet_path=sheet,
        method="harmony",
    )
    assert result["ok"] is True
    assert result["engine"] == "chordtrack"
    assert result["method"] == "harmony"
    assert result["stats"]["chordCount"] == 4
    assert Path(result["path"]) == output
    on_disk = json.loads(output.read_text(encoding="utf-8"))
    assert on_disk["schema"] == SCHEMA
    assert on_disk["schemaVersion"] == SCHEMA_VERSION
    assert _find_null(on_disk) == ""
    assert "null" not in output.read_text(encoding="utf-8")


def test_write_chordtrack_refuses_an_empty_result(tmp_path: Path):
    sheet = _write_lead_sheet(tmp_path / "plain.musicxml", [])
    output = tmp_path / "notation" / "song__chords.chordtrack.json"
    result = write_chordtrack(
        output,
        entry_id="e",
        audio_path=None,
        analysis_row=None,
        lead_sheet_path=sheet,
        method="harmony",
    )
    assert result["ok"] is False
    assert "error" in result
    assert not output.exists()


# --------------------------------------------------------------------------
# route (W2 router spec: POST /api/notation/{entry_id}/chords)
# --------------------------------------------------------------------------


# notation_client: the library and notation routers on a tmp library root
# (tests/conftest.py).


def test_chords_route_404s_without_sources(notation_client: Any, tmp_path: Path):
    from tests.test_library_store import _seed_generate_entry

    item_dir = _seed_generate_entry(tmp_path, "job_chords", 0)
    # No audio on disk and no lead sheet registered: nothing to derive from.
    (item_dir / "output.wav").unlink()

    r = notation_client.post(
        "/api/notation/job_chords_00/chords", json={"source": "chroma"}
    )
    assert r.status_code == 404
    assert "audio" in str(r.json().get("detail", "")).lower()

    r = notation_client.post(
        "/api/notation/job_chords_00/chords", json={"source": "harmony"}
    )
    assert r.status_code == 404
    assert "lead sheet" in str(r.json().get("detail", "")).lower()

    r = notation_client.post("/api/notation/no-such-entry/chords", json={})
    assert r.status_code == 404
