"""Key detection on clips shorter than the full chroma analysis.

librosa.feature.chroma_cqt's default range, C1..C8 at 36 bins per octave,
needs about 3 s of audio: below that its lowest octaves get an FFT longer than
what is left of the signal, librosa zero-pads it and warns ("n_fft=1024 is too
large for input signal of length=690"), and those octaves are mostly padding.
The only guard was ``y.size < 1024``, so every clip between 46 ms and 3 s
warned. detect_key now fits the analysis to the clip and scales its
confidence by how much of the 3 s the clip held.

Each test runs with UserWarnings raised as errors (librosa's "n_fft is too
large" is one). detect_key reports a chroma_cqt that raised as "no key", so the
key tests fail on such a warning through their key assertion; the sweeps record
the warnings and assert there are none.
"""

from __future__ import annotations

import asyncio
import warnings
from pathlib import Path

import numpy as np
import pytest

from backend.lib.audio_io import save_audio
from backend.modules.analysis import key as key_mod

pytestmark = pytest.mark.filterwarnings("error::UserWarning")

SR = 22050
_NAMES = key_mod._NOTE_NAMES


def _progression(tonic: int, seconds: float, sr: int = SR) -> np.ndarray:
    """I-IV-V-I in the major key on ``tonic`` (0 = C): a bass note an octave
    below each triad, four harmonics per note, one chord per quarter."""
    n = int(round(seconds * sr))
    base = 110.0 * 2.0 ** ((tonic - 9) / 12.0)  # tonic in the A2 octave
    y = np.zeros(n)
    seg = max(1, n // 4)
    for i, chord in enumerate(((0, 4, 7), (5, 9, 12), (7, 11, 14), (0, 4, 7))):
        start, stop = i * seg, n if i == 3 else (i + 1) * seg
        t = np.arange(stop - start) / sr
        notes = [(base / 2 * 2.0 ** (chord[0] / 12.0), 0.6)] + [
            (base * 2.0 ** (iv / 12.0), 0.4) for iv in chord
        ]
        for f, gain in notes:
            for h in (1, 2, 3, 4):
                y[start:stop] += gain * np.sin(2 * np.pi * f * h * t) / h
    return (y / max(1e-9, float(np.max(np.abs(y)))) * 0.8).astype(np.float32)


def _clip(tmp_path: Path, tonic: int, seconds: float, sr: int = SR) -> Path:
    path = tmp_path / f"clip-{tonic}-{seconds}-{sr}.wav"
    save_audio(path, _progression(tonic, seconds, sr)[None, :], sr)
    return path


@pytest.mark.parametrize("seconds", [0.5, 0.75, 1.0, 1.5, 2.0, 2.9])
def test_a_short_clip_gets_its_key_without_a_padded_analysis(
    tmp_path: Path, seconds: float
) -> None:
    """E major, decoded from the file the way the library analysis does."""
    result = key_mod.detect_key(_clip(tmp_path, 4, seconds))
    assert (result["key"], result["scale"]) == ("E", "major")
    confidence = result["confidence"]
    assert isinstance(confidence, float)
    assert 0.0 < confidence < 1.0


def test_confidence_grows_with_the_length_heard(tmp_path: Path) -> None:
    confidences = []
    for seconds in (0.5, 1.0, 2.0, 4.0):
        result = key_mod.detect_key(_clip(tmp_path, 7, seconds))
        assert (result["key"], result["scale"]) == ("G", "major")
        confidences.append(result["confidence"])
    assert confidences == sorted(confidences)
    assert confidences[0] < 0.25 * confidences[-1], "half a second reads as a guess"


def test_every_key_on_a_short_clip(tmp_path: Path) -> None:
    """Handed the decoded clip (y_sr), as the chimera analysis does."""
    for tonic in range(12):
        path = _clip(tmp_path, tonic, 0.8)
        y = _progression(tonic, 0.8)
        result = key_mod.detect_key(path, y_sr=(y, SR))
        assert (result["key"], result["scale"]) == (_NAMES[tonic], "major"), tonic


def test_a_clip_too_short_for_three_octaves_reports_no_key(tmp_path: Path) -> None:
    result = key_mod.detect_key(_clip(tmp_path, 0, 0.04))
    assert result == {"key": None, "scale": None, "confidence": None, "strength": None}


def test_a_long_clip_keeps_librosas_default_analysis(tmp_path: Path) -> None:
    """From about 3 s the plan is chroma_cqt's own default, so a long track's
    key and confidence are what they were before short clips were handled."""
    import librosa

    y = _progression(2, 4.0)
    path = tmp_path / "long.wav"
    save_audio(path, y[None, :], SR)
    plan = key_mod.chroma_plan(y, SR)
    assert (plan.bins_per_octave, plan.n_octaves, plan.coverage) == (36, 7, 1.0)
    assert plan.fmin == pytest.approx(librosa.note_to_hz("C1"))
    # The tuning chroma_cqt would estimate for itself at 36 bins.
    assert plan.tuning == librosa.estimate_tuning(y=y, sr=SR, bins_per_octave=36)

    result = key_mod.detect_key(path, y_sr=(y, SR))
    chroma = librosa.feature.chroma_cqt(y=y, sr=SR, hop_length=512)
    major, minor = key_mod.key_profile_scores([float(c) for c in chroma.mean(axis=1)])
    assert result["confidence"] == pytest.approx(max(major + minor))


def _librosa_top_fft(sr: int, bins: int) -> int:
    """The FFT librosa's CQT gives the top octave (C7..B7) at ``sr``, taken
    from librosa's own filter lengths."""
    import librosa

    freqs = librosa.interval_frequencies(
        n_bins=bins,
        fmin=librosa.note_to_hz("C7"),
        intervals="equal",
        bins_per_octave=bins,
    )
    lengths, _ = librosa.filters.wavelet_lengths(freqs=freqs, sr=sr)
    return int(2 ** np.ceil(np.log2(np.max(lengths))))


# The rates callers decode at, and odd native rates the analyzer meets at the
# file's own rate. 31.5 and 62 kHz are where a Q of 1 / (2**(1/b) - 1), a
# little under librosa's, rounds to a power of two below librosa's FFT. 8 kHz
# (telephone audio) is under C8's filters, so its plans stop at C7.
_RATES = [8000, 11025, 15500, 15700, 16000, 22050, 31000, 31500, 44100, 48000, 62000]


def _fft_warnings(path: Path, y: np.ndarray, sr: int, hop: int = 512) -> list[str]:
    """librosa's "n_fft is too large" warnings from one detect_key call.
    Recorded, not raised: detect_key reports a chroma_cqt failure as "no key",
    so a warning raised inside it would never reach the test."""
    with warnings.catch_warnings(record=True) as seen:
        warnings.simplefilter("always")
        key_mod.detect_key(path, y_sr=(y, sr), chroma_hop=hop)
    return [str(w.message) for w in seen if "too large" in str(w.message)]


@pytest.mark.parametrize("sr", _RATES)
@pytest.mark.parametrize("hop", [512, 2048])
def test_no_length_gets_an_fft_larger_than_itself(
    tmp_path: Path, sr: int, hop: int
) -> None:
    """Lengths on both sides of every octave boundary of both plans, with the
    boundaries taken from librosa's filter lengths, plus a stride through the
    first three seconds, at each rate and at the two hop sizes callers pass.
    librosa's own warning is the judge: it fires for any octave whose FFT is
    longer than the signal that octave runs on."""
    path = tmp_path / "x.wav"
    path.write_bytes(b"")
    lengths: set[int] = set(range(300, 3 * sr, sr // 7))
    for bins in (key_mod._SHORT_BINS_PER_OCTAVE, key_mod._FULL_BINS_PER_OCTAVE):
        fft = _librosa_top_fft(sr, bins)
        for i in range(key_mod._FULL_OCTAVES):
            edge = fft * 2**i
            lengths.update({edge - 1, edge, edge + 1})
    for n in sorted(lengths):
        y = _progression(9, n / sr, sr)
        assert _fft_warnings(path, y, sr, hop) == [], (sr, hop, n)


def test_the_31500_hz_clip_the_old_q_let_through(tmp_path: Path) -> None:
    """8192 samples at 31.5 kHz: the plan that modelled Q as 1 / (2**(1/b) - 1)
    chose 12 bins over 6 octaves there, and librosa warned "n_fft=512 is too
    large for input signal of length=256"."""
    path = tmp_path / "x.wav"
    path.write_bytes(b"")
    y = _progression(9, 8192 / 31500, 31500)
    assert _fft_warnings(path, y, 31500) == []
    result = key_mod.detect_key(path, y_sr=(y, 31500))
    assert result["key"] is not None


def test_silence_reports_no_key(tmp_path: Path) -> None:
    path = tmp_path / "x.wav"
    path.write_bytes(b"")
    y = np.zeros(SR * 2, dtype=np.float32)
    result = key_mod.detect_key(path, y_sr=(y, SR))
    assert result == {"key": None, "scale": None, "confidence": None, "strength": None}


# ── Audio sampled under C8's filters ────────────────────────────────────────
# librosa refuses a CQT whose top filter reaches past Nyquist, and C8's does
# below about 8.4 kHz (its cutoff is about 4.17 kHz at 36 bins per octave,
# 4.12 kHz at 12). The plan counted its octaves down from C8 whatever the
# rate, so at 8 kHz no candidate was accepted: the plan came out at 0 octaves
# with a coverage of 0, and every 8 kHz file analysed at its own rate (the
# analyzer's descriptors; detect_key handed y_sr) reported no key.

_LOW_RATES = [4000, 6000, 8000]


def _decoded(tmp_path: Path) -> Path:
    """A placeholder path: detect_key reads the handed-in samples, not it."""
    path = tmp_path / "x.wav"
    path.write_bytes(b"")
    return path


@pytest.mark.parametrize("sr", _LOW_RATES)
def test_audio_under_c8_reports_its_key(tmp_path: Path, sr: int) -> None:
    """C major at the file's own low rate, handed in the way the chimera
    analysis hands a decode in."""
    result = key_mod.detect_key(_decoded(tmp_path), y_sr=(_progression(0, 4.0, sr), sr))
    assert (result["key"], result["scale"]) == ("C", "major")
    confidence = result["confidence"]
    assert isinstance(confidence, float)
    assert confidence > 0.5, "a 4 s clip is a full analysis, at full confidence"


def test_an_8_khz_plan_stops_at_the_last_octave_under_nyquist() -> None:
    import librosa

    y = _progression(0, 4.0, 8000)
    plan = key_mod.chroma_plan(y, 8000)
    assert (plan.bins_per_octave, plan.n_octaves, plan.coverage) == (36, 6, 1.0)
    assert plan.fmin == pytest.approx(librosa.note_to_hz("C1"))
    # librosa accepts that range at 8 kHz: C1..C7 is under Nyquist.
    chroma = librosa.feature.chroma_cqt(
        y=y,
        sr=8000,
        fmin=plan.fmin,
        n_octaves=plan.n_octaves,
        bins_per_octave=plan.bins_per_octave,
        tuning=plan.tuning,
    )
    assert chroma.shape[0] == 12


def test_a_short_8_khz_clip_reports_its_key_at_a_lower_confidence(
    tmp_path: Path,
) -> None:
    path = _decoded(tmp_path)
    short = key_mod.detect_key(path, y_sr=(_progression(0, 1.0, 8000), 8000))
    full = key_mod.detect_key(path, y_sr=(_progression(0, 4.0, 8000), 8000))
    assert (short["key"], short["scale"]) == ("C", "major")
    short_conf, full_conf = short["confidence"], full["confidence"]
    assert isinstance(short_conf, float) and isinstance(full_conf, float)
    assert 0.0 < short_conf < full_conf, "a 1 s clip has heard less of the music"


def test_the_analyzer_reports_the_key_of_an_8_khz_file(tmp_path: Path) -> None:
    """The analyzer reads the file at its own rate (sf.read) and plans its
    chroma there."""
    from backend.modules.analyzer.descriptors import extract_descriptors

    path = tmp_path / "c-major-8k.wav"
    save_audio(path, _progression(0, 4.0, 8000)[None, :], 8000)
    bundle = asyncio.run(extract_descriptors(path))
    assert bundle["sample_rate"] == 8000
    assert bundle["mid_level"]["key"] == "C major"
    assert bundle["mid_level"]["key_confidence"] > 0.5
