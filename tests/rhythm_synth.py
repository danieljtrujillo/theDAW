"""Synthetic music with a KNOWN, CHANGING meter — ground truth for the rhythm
engine tests.

Builds on tests/chimera_synth.py's primitives (kick, thump, hat, decaying
sine) but frees the bar: each :class:`MeterSegment` has its own tempo, bar
length, grouping and subdivision, and segments follow one another the way a
metamorphic piece does. Accent hierarchy per bar: downbeat kick +6 dB with a
40 Hz thump, group-start kicks +3 dB, other beats plain, hats on the
subdivisions at -12 dB.

Optional layers per segment:
  * ``beat_hits`` — which beats carry a kick (default all); with
    ``offbeat_hits`` (eighth positions within the bar) this makes syncopated
    patterns whose beats are silent after an off-beat note.
  * ``swing`` — 0 straight .. 1 triplet swing (off-beat hat at 2/3).
  * ``poly_cycle`` — a 440 Hz blip every N beats, its own cycle across the
    bar line (a 3 over a 4).
  * ``cross_pulse`` — a click every ``cross_pulse`` beats (1.5 -> a dotted
    quarter against the quarter: 3:2 hemiola).

Rendered at any sample rate; the tests use 22.05 kHz so no resample is needed.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np

from tests.chimera_synth import (
    _HAT_DB,
    _HAT_SEC,
    _KICK_AMP,
    _KICK_HZ,
    _KICK_SEC,
    _THUMP_HZ,
    _add_at,
    _db,
    _decaying_sine,
)

_DOWNBEAT_DB = 6.0
_GROUP_DB = 3.0
_BLIP_HZ = 440.0
_BLIP_SEC = 0.12
_BLIP_DB = -8.0
_CROSS_DB = -6.0


def default_grouping(beats_per_bar: int) -> tuple[int, ...]:
    """2s then the remainder: 7 -> (2, 2, 3), 5 -> (2, 3), 4 -> (2, 2),
    3 -> (3,), 2 -> (2,)."""
    if beats_per_bar <= 3:
        return (beats_per_bar,)
    parts: list[int] = []
    rem = beats_per_bar
    while rem > 3:
        parts.append(2)
        rem -= 2
    parts.append(rem)
    return tuple(parts)


@dataclass(frozen=True)
class MeterSegment:
    """Frozen (and so hashable): the tests memoize analyses per segment tuple."""

    bpm: float
    beats_per_bar: int
    bars: int
    grouping: tuple[int, ...] | None = None
    compound: bool = False
    swing: float = 0.0
    beat_hits: tuple[int, ...] | None = None
    offbeat_hits: tuple[int, ...] = ()
    poly_cycle: int = 0
    cross_pulse: float = 0.0
    hats: bool = True
    # Hats on the beats instead of the off-beats: a pulse reference in the high
    # band that leaves the low band free to push against it.
    hat_on_beat: bool = False
    # "beats": a kick on every position (the position IS the felt beat).
    # "groups": the positions are the tatum (eighths, sixteenths): a hat ON
    # every position, kicks on the group starts only, and the felt beats are
    # the uneven groups, the way 19/16 as 3+3+3+3+3+2+2 is actually played.
    # (With "beats", hats sit between the positions unless hat_on_beat.)
    pulse: str = "beats"


def meter_track(
    segments: list[MeterSegment],
    sr: int = 22050,
    seed: int = 0,
    lead_in_sec: float = 0.0,
    tail_sec: float = 0.5,
) -> tuple[np.ndarray, dict[str, Any]]:
    """Render the segments back to back. Returns ``(mono float32, truth)`` with
    ``truth = {beats, downbeats, bars: [(start, end, beats_per_bar)],
    segments: [{start_sec, end_sec, bpm, beats_per_bar, grouping, compound}]}``
    all in seconds."""
    rng = np.random.default_rng(seed)
    events: list[tuple[float, str, float]] = []  # (time, kind, gain)
    truth: dict[str, Any] = {"beats": [], "downbeats": [], "bars": [], "segments": []}
    t = float(lead_in_sec)
    global_beat = 0
    for seg in segments:
        per = 60.0 / seg.bpm
        length = seg.beats_per_bar
        g = seg.grouping or default_grouping(length)
        assert sum(g) == length, f"grouping {g} does not sum to {length}"
        group_starts = {int(x) for x in np.cumsum((0,) + g[:-1])}
        if seg.beat_hits is not None:
            hits = set(seg.beat_hits)
        elif seg.pulse == "groups":
            hits = set(group_starts)
        else:
            hits = set(range(length))
        seg_start = t
        for _bar in range(seg.bars):
            bar_start = t
            for b in range(length):
                truth["beats"].append(t)
                if b == 0:
                    truth["downbeats"].append(t)
                if b in hits:
                    if b == 0:
                        events.append((t, "kick", _db(_DOWNBEAT_DB)))
                        events.append((t, "thump", 1.0))
                    elif b in group_starts:
                        events.append((t, "kick", _db(_GROUP_DB)))
                    else:
                        events.append((t, "kick", 1.0))
                if seg.hats and (seg.hat_on_beat or seg.pulse == "groups"):
                    events.append((t, "hat", 1.0))
                elif seg.hats:
                    if seg.compound:
                        for k in (1, 2):
                            events.append((t + per * k / 3.0, "hat", 1.0))
                    else:
                        off = 0.5 + seg.swing * (2.0 / 3.0 - 0.5)
                        events.append((t + per * off, "hat", 1.0))
                if seg.poly_cycle and global_beat % seg.poly_cycle == 0:
                    events.append((t, "blip", 1.0))
                t += per
                global_beat += 1
            for p in seg.offbeat_hits:
                events.append((bar_start + p * per / 2.0, "kick", 1.0))
            if seg.cross_pulse:
                n_cross = int(np.floor(length / seg.cross_pulse))
                for k in range(n_cross):
                    events.append((bar_start + k * seg.cross_pulse * per, "cross", 1.0))
            truth["bars"].append((bar_start, t, length))
        truth["segments"].append(
            {
                "start_sec": seg_start,
                "end_sec": t,
                "bpm": seg.bpm,
                "beats_per_bar": length,
                "grouping": tuple(g),
                "compound": seg.compound,
            }
        )

    n = int(round((t + tail_sec) * sr))
    mono = np.zeros(n, dtype=np.float32)
    kick = _decaying_sine(_KICK_HZ, _KICK_SEC, sr, tau=0.02) * _KICK_AMP
    thump = _decaying_sine(_THUMP_HZ, _KICK_SEC * 1.5, sr, tau=0.03) * _KICK_AMP
    blip = _decaying_sine(_BLIP_HZ, _BLIP_SEC, sr, tau=0.04) * _db(_BLIP_DB)
    hat_n = int(_HAT_SEC * sr)
    hat_env = np.linspace(1.0, 0.0, hat_n, dtype=np.float32)
    click_n = int(0.01 * sr)
    click_env = np.linspace(1.0, 0.0, click_n, dtype=np.float32)
    for time, kind, gain in events:
        s = int(round(time * sr))
        if s >= n:
            continue
        if kind == "kick":
            _add_at(mono, s, kick * gain)
        elif kind == "thump":
            _add_at(mono, s, thump * gain)
        elif kind == "hat":
            burst = (
                rng.standard_normal(hat_n).astype(np.float32) * hat_env * _db(_HAT_DB)
            )
            _add_at(mono, s, burst * gain)
        elif kind == "blip":
            _add_at(mono, s, blip * gain)
        elif kind == "cross":
            burst = (
                rng.standard_normal(click_n).astype(np.float32)
                * click_env
                * _db(_CROSS_DB)
            )
            _add_at(mono, s, burst * gain)
    peak = float(np.abs(mono).max())
    if peak > 0.98:
        mono *= 0.98 / peak
    return mono, truth
