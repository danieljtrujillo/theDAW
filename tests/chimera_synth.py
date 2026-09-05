"""Synthetic music with ground truth for the Chimera v2 tests.

NOT a test module (no ``test_`` prefix). Every v2 test imports from here so
the whole suite shares one deterministic, CPU-only signal generator.

``synth_track`` renders a stereo [N, 2] float32 "song": a kick on every beat
(accented downbeats, so the downbeat phase is recoverable), hats on the
offbeats, a triad pad following I-IV-V-I with a chord change every
``phrase_bars`` bars (phrase novelty ground truth), and amplitude steps per
section. ``beat_times`` / ``downbeat_times`` return the exact grid the audio
was rendered on (SOURCE seconds, including ``lead_in_sec``).
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import soundfile as sf

BEATS_PER_BAR = 4
_KICK_HZ = 60.0
_THUMP_HZ = 40.0
_KICK_SEC = 0.08
_KICK_AMP = 0.28  # base kick level; accented downbeat + thump stays < 0 dBFS
_HAT_SEC = 0.008
_HAT_DB = -12.0
_PAD_DB = -18.0
_DOWNBEAT_DB = 6.0

_NOTE_NAMES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
_FLATS = {"Db": "C#", "Eb": "D#", "Gb": "F#", "Ab": "G#", "Bb": "A#"}
# Degrees (semitones above the key root) for the I-IV-V-I progression.
_PROGRESSION = (0, 5, 7, 0)


def _db(x: float) -> float:
    return float(10.0 ** (x / 20.0))


def _periods(bpm: float, n_beats: int, tempo_drift_pct: float) -> np.ndarray:
    """Per-beat periods; the period grows linearly by ``tempo_drift_pct``
    over the clip (first beat nominal, last beat nominal * (1 + pct/100))."""
    p0 = 60.0 / float(bpm)
    if n_beats <= 1 or tempo_drift_pct == 0.0:
        return np.full(max(n_beats, 1), p0, dtype=np.float64)
    ramp = np.linspace(0.0, tempo_drift_pct / 100.0, n_beats, dtype=np.float64)
    return p0 * (1.0 + ramp)


def beat_times(
    bpm: float,
    bars: int,
    lead_in_sec: float = 0.0,
    tempo_drift_pct: float = 0.0,
) -> list[float]:
    """Exact beat times (SOURCE seconds) of a ``bars``-bar clip: 4 * bars
    beats starting at ``lead_in_sec``; no jitter."""
    n = int(bars) * BEATS_PER_BAR
    if n <= 0:
        return []
    per = _periods(bpm, n, tempo_drift_pct)
    starts = float(lead_in_sec) + np.concatenate(([0.0], np.cumsum(per[:-1])))
    return [float(t) for t in starts]


def downbeat_times(
    bpm: float,
    bars: int,
    lead_in_sec: float = 0.0,
    tempo_drift_pct: float = 0.0,
    downbeat_phase: int = 0,
) -> list[float]:
    """Beats whose index == ``downbeat_phase`` (mod 4)."""
    b = beat_times(bpm, bars, lead_in_sec, tempo_drift_pct)
    return b[int(downbeat_phase) % BEATS_PER_BAR :: BEATS_PER_BAR]


def _note_index(name: str) -> int:
    n = name.strip()
    n = n[0].upper() + n[1:]
    n = _FLATS.get(n, n)
    return _NOTE_NAMES.index(n)


def _note_hz(pc: int) -> float:
    """Pitch class -> frequency near A3 (220 Hz); A = pc 9."""
    return 220.0 * 2.0 ** ((pc - 9) / 12.0)


def _decaying_sine(freq_hz: float, dur_sec: float, sr: int, tau: float) -> np.ndarray:
    n = int(dur_sec * sr)
    t = np.arange(n, dtype=np.float64) / sr
    return (np.sin(2.0 * math.pi * freq_hz * t) * np.exp(-t / tau)).astype(np.float32)


def _add_at(buf: np.ndarray, start: int, x: np.ndarray) -> None:
    if start >= len(buf) or start < 0:
        return
    end = min(len(buf), start + len(x))
    buf[start:end] += x[: end - start]


def _default_levels(bars: int) -> list[tuple[int, float]]:
    return [(s, g) for s, g in ((0, 0.3), (16, 0.6), (32, 1.0), (48, 0.3)) if s < bars]


def synth_track(
    bpm: float,
    bars: int,
    sr: int = 44100,
    downbeat_phase: int = 0,
    phrase_phase: int = 0,
    phrase_bars: int = 8,
    key: tuple[str, str] = ("A", "minor"),
    section_levels: list[tuple[int, float]] | None = None,
    lead_in_sec: float = 0.0,
    hats: bool = True,
    pad: bool = True,
    tempo_drift_pct: float = 0.0,
    jitter_ms: float = 0.0,
    seed: int = 0,
) -> np.ndarray:
    """Render a synthetic stereo track ([N, 2] float32).

    * kick: 60 Hz decaying sine (80 ms) on every beat; downbeats (beat index
      == ``downbeat_phase`` mod 4) get +6 dB and an extra 40 Hz thump.
    * hats: 8 ms white-noise bursts on the offbeats at -12 dB.
    * pad: 3-sine triad (root, third per scale, fifth) at -18 dB following
      I-IV-V-I, changing every ``phrase_bars`` bars starting at bar
      ``phrase_phase`` (chord changes are the phrase-novelty ground truth).
    * ``section_levels``: ``[(start_bar, gain 0..1)]`` amplitude steps;
      default ``[(0, .3), (16, .6), (32, 1.0), (48, .3)]`` clipped to ``bars``.
    * ``lead_in_sec`` of silence is prepended; ``tempo_drift_pct`` grows the
      period linearly over the clip; ``jitter_ms`` adds per-beat uniform
      jitter (the audio only — ``beat_times`` stays the un-jittered grid).
    """
    rng = np.random.default_rng(seed)
    n_beats = int(bars) * BEATS_PER_BAR
    if n_beats <= 0:
        return np.zeros((int(lead_in_sec * sr), 2), dtype=np.float32)
    per = _periods(bpm, n_beats, tempo_drift_pct)
    grid = np.asarray(beat_times(bpm, bars, lead_in_sec, tempo_drift_pct))
    onsets = grid.copy()
    if jitter_ms > 0:
        onsets = onsets + rng.uniform(-jitter_ms, jitter_ms, size=n_beats) / 1000.0
        onsets[0] = max(onsets[0], 0.0)
    end_sec = float(grid[-1] + per[-1])
    n = int(round(end_sec * sr))
    mono = np.zeros(n, dtype=np.float32)

    # --- kicks -----------------------------------------------------------
    kick = _decaying_sine(_KICK_HZ, _KICK_SEC, sr, tau=0.02) * _KICK_AMP
    thump = _decaying_sine(_THUMP_HZ, _KICK_SEC * 1.5, sr, tau=0.03) * _KICK_AMP
    db_phase = int(downbeat_phase) % BEATS_PER_BAR
    for i, t in enumerate(onsets):
        start = int(round(t * sr))
        if i % BEATS_PER_BAR == db_phase:
            _add_at(mono, start, kick * _db(_DOWNBEAT_DB))
            _add_at(mono, start, thump)
        else:
            _add_at(mono, start, kick)

    # --- hats ------------------------------------------------------------
    if hats:
        hat_n = int(_HAT_SEC * sr)
        env = np.linspace(1.0, 0.0, hat_n, dtype=np.float32)
        for i in range(n_beats):
            burst = rng.standard_normal(hat_n).astype(np.float32) * env * _db(_HAT_DB)
            t_off = onsets[i] + per[i] / 2.0
            _add_at(mono, int(round(t_off * sr)), burst)

    # --- pad -------------------------------------------------------------
    if pad:
        root_pc = _note_index(key[0])
        minor = str(key[1]).lower().startswith("min")
        third = 3 if minor else 4
        amp = _db(_PAD_DB) / 3.0
        t_all = np.arange(n, dtype=np.float64) / sr
        # chord index per beat: bar of the beat (relative to the downbeat
        # phase), then phrase index modulo the progression
        for i in range(n_beats):
            bar = (i - db_phase) // BEATS_PER_BAR
            chord = ((bar - int(phrase_phase)) // max(1, int(phrase_bars))) % len(
                _PROGRESSION
            )
            deg = _PROGRESSION[chord]
            s0 = int(round(grid[i] * sr))
            s1 = int(round((grid[i] + per[i]) * sr)) if i + 1 < n_beats else n
            s1 = min(s1, n)
            if s1 <= s0:
                continue
            seg_t = t_all[s0:s1]
            chord_pcs = (root_pc + deg, root_pc + deg + third, root_pc + deg + 7)
            seg = np.zeros(s1 - s0, dtype=np.float64)
            for pc in chord_pcs:
                seg += np.sin(2.0 * math.pi * _note_hz(pc % 12) * seg_t)
            mono[s0:s1] += (seg * amp).astype(np.float32)

    # --- section levels ---------------------------------------------------
    levels = section_levels if section_levels is not None else _default_levels(bars)
    levels = sorted((int(s), float(g)) for s, g in levels if int(s) < bars)
    if levels:
        gain = np.full(n, levels[0][1], dtype=np.float32)
        for start_bar, g in levels:
            bi = db_phase + start_bar * BEATS_PER_BAR
            if bi <= 0:
                gain[:] = g
                continue
            if bi >= n_beats:
                continue
            s = int(round(grid[bi] * sr))
            gain[s:] = g
        mono *= gain

    return np.stack([mono, mono], axis=1).astype(np.float32)


def click_track(
    bpm: float,
    duration_sec: float,
    sr: int = 44100,
    accent_every: int = 0,
    tempo_drift_pct: float = 0.0,
    jitter_ms: float = 0.0,
    seed: int | None = None,
) -> np.ndarray:
    """Mono float32 click track mirroring the endpoint test's generator: a
    10 ms decaying noise burst on every beat. ``accent_every = 4`` adds a
    60 Hz thump on every 4th click. ``tempo_drift_pct`` / ``jitter_ms`` as in
    :func:`synth_track`. Seed defaults to ``int(bpm)`` like the endpoint test.
    """
    rng = np.random.default_rng(int(bpm) if seed is None else seed)
    click_len = int(0.01 * sr)
    click = (
        rng.standard_normal(click_len).astype(np.float32)
        * np.linspace(1.0, 0.0, click_len, dtype=np.float32)
        * 0.5
    )
    thump = _decaying_sine(_KICK_HZ, _KICK_SEC, sr, tau=0.02) * _KICK_AMP
    n = int(duration_sec * sr)
    audio = np.zeros(n, dtype=np.float32)
    p0 = 60.0 / bpm
    n_beats = int(math.ceil(duration_sec / p0)) + 2
    per = _periods(bpm, n_beats, tempo_drift_pct)
    starts = np.concatenate(([0.0], np.cumsum(per[:-1])))
    if jitter_ms > 0:
        starts = starts + rng.uniform(-jitter_ms, jitter_ms, size=n_beats) / 1000.0
        starts[0] = max(starts[0], 0.0)
    for i, t in enumerate(starts):
        if t >= duration_sec:
            break
        s = int(t * sr)
        _add_at(audio, s, click)
        if accent_every and i % accent_every == 0:
            _add_at(audio, s, thump)
    return audio


def write_wav(dir: Path, name: str, audio: np.ndarray, sr: int) -> Path:
    """Write ``audio`` (mono [N] or [N, C]) as float32 WAV and return its path."""
    p = Path(dir) / (name if name.lower().endswith(".wav") else f"{name}.wav")
    p.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(p), np.asarray(audio, dtype=np.float32), int(sr), subtype="FLOAT")
    return p


def _mono(x: np.ndarray) -> np.ndarray:
    a = np.asarray(x, dtype=np.float64)
    if a.ndim == 2:
        a = a.mean(axis=1)
    return a


def fft_peak_hz(x: np.ndarray, sr: int) -> float:
    """Frequency of the strongest spectral peak (Hann window, parabolic
    interpolation between bins). Stereo input is averaged to mono."""
    a = _mono(x)
    if a.size < 4:
        return 0.0
    w = np.hanning(a.size)
    spec = np.abs(np.fft.rfft(a * w))
    k = int(np.argmax(spec))
    if 0 < k < spec.size - 1:
        y0, y1, y2 = np.log(spec[k - 1 : k + 2] + 1e-20)
        denom = y0 - 2.0 * y1 + y2
        delta = 0.5 * (y0 - y2) / denom if denom != 0 else 0.0
    else:
        delta = 0.0
    return float((k + delta) * sr / a.size)


def rms_db(x: np.ndarray) -> float:
    """RMS level in dBFS (all channels pooled)."""
    a = np.asarray(x, dtype=np.float64)
    if a.size == 0:
        return -120.0
    return float(20.0 * np.log10(np.sqrt(np.mean(a * a)) + 1e-12))


def band_energy_db(x: np.ndarray, sr: int, lo: float, hi: float) -> float:
    """RMS-equivalent level (dBFS) of the [lo, hi] Hz band via Parseval, so a
    full-band sine of amplitude A reads ``20*log10(A/sqrt(2))`` — directly
    comparable with :func:`rms_db`. Stereo input is averaged to mono."""
    a = _mono(x)
    n = a.size
    if n == 0:
        return -120.0
    spec = np.fft.rfft(a)
    freqs = np.fft.rfftfreq(n, 1.0 / sr)
    band = (freqs >= lo) & (freqs <= hi)
    # one-sided power: |X|^2 * 2 / N^2 per bin (DC/Nyquist weight is
    # negligible for the bands the tests use)
    power = float(np.sum(np.abs(spec[band]) ** 2) * 2.0 / (n * n))
    return float(10.0 * np.log10(power + 1e-24))
