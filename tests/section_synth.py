"""Synthetic songs with a KNOWN form — ground truth for the section finder.

A song is a list of :class:`Part` s. Each part is a whole number of 4/4 bars
with its own chord progression (one chord a bar, cycling), drum pattern, bass
and lead. Rendered as a mix plus the four stems a separation would give
(drums, bass, other, vocals), all mono at 22.05 kHz, so the tests can run the
finder with and without stems on the same audio.

Drum patterns:
  * ``none``  — no drums
  * ``light`` — kick on 1 and 3, closed hat on the eighths
  * ``full``  — kick on every beat, snare on 2 and 4, hats on the sixteenths
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

SR = 22050

# One chord a bar, as MIDI notes.
AM_F_C_G = ((57, 60, 64), (53, 57, 60), (48, 52, 55), (55, 59, 62))
F_G_EM_AM = ((65, 69, 72), (67, 71, 74), (64, 67, 71), (69, 72, 76))
DM_BB = ((62, 65, 69), (58, 62, 65))
E_DRONE = ((52, 59, 64),)
C_FM = ((60, 64, 67, 72), (53, 56, 60, 65))


@dataclass(frozen=True)
class Part:
    bars: int
    chords: tuple[tuple[int, ...], ...]
    drums: str = "none"
    bass: bool = False
    lead: bool = False
    level_db: float = 0.0
    bright: bool = False  # a brighter pad (more partials)


def _hz(midi: float) -> float:
    return 440.0 * 2.0 ** ((midi - 69) / 12.0)


def _pad(notes: tuple[int, ...], sec: float, bright: bool) -> np.ndarray:
    n = int(sec * SR)
    t = np.arange(n) / SR
    out = np.zeros(n)
    partials = 6 if bright else 3
    for m in notes:
        f = _hz(m)
        for k in range(1, partials + 1):
            out += np.sin(2 * math.pi * f * k * t) / (k * 1.3)
    env = np.minimum(1.0, t / 0.05) * np.minimum(1.0, (sec - t) / 0.05)
    return (out * env / (len(notes) * 2.5)).astype(np.float32)


def _hit(freq: float, sec: float, tau: float, noise: bool, seed: int) -> np.ndarray:
    n = int(sec * SR)
    t = np.arange(n) / SR
    if noise:
        x = np.random.default_rng(seed).standard_normal(n)
    else:
        x = np.sin(2 * math.pi * freq * t * (1 + 0.5 * np.exp(-t / 0.01)))
    return (x * np.exp(-t / tau)).astype(np.float32)


def _add(buf: np.ndarray, at: float, x: np.ndarray, gain: float) -> None:
    i = int(round(at * SR))
    if i >= buf.size:
        return
    j = min(buf.size, i + x.size)
    buf[i:j] += gain * x[: j - i]


def render(
    parts: list[Part], bpm: float = 120.0
) -> tuple[np.ndarray, dict[str, np.ndarray], list[float]]:
    """``(mix, stems, beat_times)`` of the song."""
    beat = 60.0 / bpm
    bar = 4 * beat
    total_bars = sum(p.bars for p in parts)
    n = int(round(total_bars * bar * SR)) + SR // 2
    stems = {
        k: np.zeros(n, dtype=np.float32) for k in ("drums", "bass", "other", "vocals")
    }
    kick = _hit(55.0, 0.18, 0.05, False, 0)
    snare = _hit(0.0, 0.15, 0.04, True, 1)
    hat = _hit(0.0, 0.03, 0.008, True, 2)
    t0 = 0.0
    for p in parts:
        g = 10 ** (p.level_db / 20.0)
        for b in range(p.bars):
            at = t0 + b * bar
            chord = p.chords[b % len(p.chords)]
            _add(stems["other"], at, _pad(chord, bar, p.bright), 0.5 * g)
            if p.bass:
                root = min(chord) - 24
                for e in range(8):
                    _add(
                        stems["bass"],
                        at + e * beat / 2,
                        _pad((root,), beat / 2 * 0.9, False),
                        0.9 * g,
                    )
            if p.lead:
                for q in range(4):
                    note = chord[(q + b) % len(chord)] + 12
                    tt = np.arange(int(beat * 0.9 * SR)) / SR
                    f = _hz(note) * (1 + 0.01 * np.sin(2 * math.pi * 5.5 * tt))
                    tone = np.sin(2 * math.pi * np.cumsum(f) / SR).astype(np.float32)
                    tone *= np.minimum(1.0, tt / 0.03).astype(np.float32)
                    _add(stems["vocals"], at + q * beat, tone, 0.25 * g)
            if p.drums == "light":
                for q in (0, 2):
                    _add(stems["drums"], at + q * beat, kick, 0.8 * g)
                for e in range(8):
                    _add(stems["drums"], at + e * beat / 2, hat, 0.15 * g)
            elif p.drums == "full":
                for q in range(4):
                    _add(stems["drums"], at + q * beat, kick, 0.9 * g)
                for q in (1, 3):
                    _add(stems["drums"], at + q * beat, snare, 0.5 * g)
                for s in range(16):
                    _add(stems["drums"], at + s * beat / 4, hat, 0.2 * g)
        t0 += p.bars * bar
    mix = sum(stems.values())
    peak = float(np.abs(mix).max()) or 1.0
    scale = 0.8 / peak
    mix = (mix * scale).astype(np.float32)
    stems = {k: (v * scale).astype(np.float32) for k, v in stems.items()}
    beats = [i * beat for i in range(total_bars * 4)]
    return mix, stems, beats


def bars_of(parts: list[Part], bpm: float = 120.0) -> list[tuple[float, float]]:
    bar = 240.0 / bpm
    total = sum(p.bars for p in parts)
    return [(i * bar, (i + 1) * bar) for i in range(total)]


def starts_of(parts: list[Part]) -> list[int]:
    """The bar each part starts on."""
    out, at = [], 0
    for p in parts:
        out.append(at)
        at += p.bars
    return out
