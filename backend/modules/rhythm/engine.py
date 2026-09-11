"""Rhythm analysis for music whose meter does not sit still.

A tempo curve, beats that follow it, a METER MAP — the time signature per
segment, with the grouping of an additive meter (7 as 2+2+3) — downbeats and
bars, per-bar syncopation (Longuet-Higgins & Lee, WNBD, off-beat ratio, swing),
and polymeter: layers that keep their own bar length, plus cross-rhythms
(3:2, 4:3 …) read off the tempogram.

Everything is numpy + librosa on a mono 22.05 kHz signal, so it runs wherever
the library analysis runs. No model, no network.

The shape of the problem: ``chimera.detect`` and ``chimera.structure`` assume
ONE tempo and ONE fixed ``beats_per_bar``. Metamorphic music breaks both. So:

  1. multi-band onset strength (low / mid / high / broad) from one STFT
  2. a local tempo curve from the tempogram, octave-folded and smoothed, cut
     into tempo runs where it steps (runs under 8 s fold into their
     neighbours — a drumless intro is not a tempo change); beats are tracked
     AGAINST that curve, so they follow a change instead of averaging it away
  3. per-beat evidence: an ACCENT score (peak low-band level, broad level,
     chroma novelty, low-band onset — where bars start) and a FEATURE matrix
     (band onsets, levels, rms, mfcc, chroma — what each beat sounds like)
  4. meter per sliding window: for every bar length L in 2..12 and every
     grouping of L into 2s and 3s, how well does an L-periodic bar explain
     the window? Four readings agree or not: the accent variance an L-phase
     grouping explains, the accent autocorrelation at lag L, the correlation
     with the grouping's accent template, and — the strongest cue on a real
     mix — how similar each beat is to the beat one bar later (the drum
     pattern repeats every bar; at lag 2 a kick beat meets a snare beat).
     A prior over common meters breaks ties, and a phrase guard keeps a
     two-bar pattern from being called 8/4
  5. windows -> runs with hysteresis -> the meter map; downbeats from each
     segment's phase; bars from downbeats. If nothing fits at the tracked beat
     level, the same is tried at double tempo — a fast 7/8 is often tracked
     at the quarter, where its bar is 3.5 beats long and no meter fits
  6. subdivision per segment (simple vs compound, sixteenths present) from
     where onsets fall inside beats -> denominator and beat unit
  7. syncopation per bar on the metrical grid the segment implies
  8. polymeter per layer (stems when given, else low/mid/high bands) and
     cross-rhythm ratios from the tempogram
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional

import numpy as np

log = logging.getLogger(__name__)

RHYTHM_VERSION = 2

SR = 22050
_HOP = 512
_N_FFT = 2048
_N_MELS = 64
_BAND_EDGES = (0, 8, 24, 64)  # mel bins: low ~<260 Hz, mid ~260-1100, high
_MIN_DURATION_SEC = 4.0
_TG_WIN = 384  # tempogram window in frames: ~8.9 s at hop 512 / 22.05 kHz
_TEMPO_SMOOTH_SEC = 2.0
_TEMPO_STEP = 0.04  # a sustained local-tempo step this large starts a run
_TEMPO_STEP_MIN_SEC = 3.0
_TEMPO_RUN_MIN_SEC = 8.0  # shorter runs fold into a neighbour
L_MIN, L_MAX = 2, 16  # at the tracked beat; finer levels go to 32
METER_WINDOW_BEATS = 48
_METER_STRIDE_BEATS = 4
_MIN_RUN_WINDOWS = 4
_UNDECIDED_CONF = 0.08  # a window this unsure inherits the running meter
_PHRASE_GUARD_RATIO = 0.85  # a divisor keeping this much evidence is the bar
_LEVEL_RETRY_BELOW = 0.2  # mean window confidence below which 2x tempo is tried
_LEVEL_RETRY_GAIN = 0.2  # ... and how much better a finer level must read
_LEVEL_GOOD = 0.35  # a level reading this well needs no finer level
_PRIOR_WEIGHT = 0.15  # the prior is a tie-breaker, added to the evidence
_UNSURE_CONF = 0.12  # a composite reading this unsure yields to the low band
_TATUM_MIN_REL = 0.5  # of the band's strongest tempogram peak
_TATUM_MAX_BPM = 640.0
_TATUM_MIN_PROM = 0.1  # of the band's maximum: a pulse, not the envelope's own width
_EQUAL_DOWNBEAT_TOL = 0.3  # of the profile's span: downbeats this alike are one bar
_HOP_FINE = 128  # for grids over _FINE_GRID_FROM_BPM: a sixteenth at 120 is 5.38
_N_FFT_FINE = 512  # a 23 ms window, so a hat's flux lands in a frame or two
# frames at hop 512 and the DP rounds it to 5 — a grid 7 % fast that never locks
_FINE_GRID_FROM_BPM = 200.0
_MIN_OCCUPANCY = 0.6  # of a grid's positions must carry an onset, or it is too fine
_POLY_MIN_BARS = 4  # a polymeter is claimed against a bar that has settled
_TOP_K_GROUPING = 12  # bar lengths that get the grouping search per window
_SCALE_FLOOR = 0.25  # of the median row spread: a flatter row barely counts
_PHASE_FLIP_RATIO = 1.15  # low-band mass the half-beat grid needs to take the beat
_SPAN_SHIFT = 0.25  # of a beat: feature spans start this early, so a kick
# a frame either side of its beat still lands in that beat's span
_BOUNDARY_SEARCH_BEATS = 24  # either side of a meter change, for the refinement
# Similarity rows after per-window scaling: low and broad energy carry the
# bar (kick, bass, the whole kit), mid/high and timbre support it — a melody
# cycling in 3 over 4/4 drums is louder than the kick in its own band and
# must not move the bar.
_ROW_WEIGHTS = np.asarray([2.0, 0.7, 0.7, 1.5] + [0.5] * 13, dtype=np.float64)
_LOW_ROW_WEIGHTS = np.asarray([2.0, 1.5], dtype=np.float64)  # low, broad
_LOW_LEAD_CONF = 0.3  # the low band's own bar overrides a multiple of it from here
_SEGMENT_MIN_CONF = 0.15  # below this, no polymeter / cross-rhythm claims
_UNCERTAIN_CONF = 0.1  # a segment under this is a guess, and says so
_POLY_MIN_CONF = 0.4
_CROSS_MIN_REL = 0.6  # of the tempogram profile's peak
_CROSS_PEAK_TOL = 0.06
_EPS = 1e-9

# How common a bar length is; multiplies the data score. Keeps 4 ahead of 2 and
# 8 when the evidence alone cannot tell them apart, without ever overriding a
# clear 7 or 5. 2 sits low on purpose: on four-on-the-floor nothing separates
# beats 1 and 3, the bias-corrected 2-phase reading then edges the 4-phase one,
# and the bar is still 4/4 by every convention — 2/4 has to be unmistakable.
_METER_PRIOR: dict[int, float] = {
    2: 0.6,
    3: 0.9,
    4: 1.0,
    5: 0.8,
    6: 0.85,
    7: 0.8,
    8: 0.7,
    9: 0.7,
    10: 0.6,
    11: 0.6,
    12: 0.7,
}

# The same, when the tracked beat is a dotted quarter (each beat splits in
# three): a 2-beat bar is 6/8 and common, 4 is 12/8, 3 is 9/8.
_METER_PRIOR_COMPOUND: dict[int, float] = {
    2: 1.0,
    3: 0.9,
    4: 0.95,
    5: 0.7,
    6: 0.65,
    7: 0.6,
    8: 0.55,
    9: 0.5,
    10: 0.5,
    11: 0.5,
    12: 0.5,
}


def _prior(length: int, compound: bool) -> float:
    """How common a bar length is. Past the tables an odd length is a real
    possibility (13, 19, 23 …) and an even one is usually two bars of half its
    length — the phrase guard reduces it, the prior keeps it from winning."""
    table = _METER_PRIOR_COMPOUND if compound else _METER_PRIOR
    if length in table:
        return table[length]
    return 0.55 if length % 2 else 0.4


def _l_max_for(mult: int) -> int:
    """Longest bar tried at a level: 16 tracked beats, 24 eighths, 32 sixteenths."""
    return min(32, 8 * int(mult) + 8)


_CROSS_RATIOS: tuple[tuple[str, float], ...] = (
    ("3:2", 1.5),
    ("2:3", 2.0 / 3.0),
    ("4:3", 4.0 / 3.0),
    ("3:4", 0.75),
    ("5:4", 1.25),
    ("4:5", 0.8),
    ("5:3", 5.0 / 3.0),
    ("3:5", 0.6),
)


# --------------------------------------------------------------------------
# small numerics
# --------------------------------------------------------------------------


def _zscore(x: np.ndarray) -> np.ndarray:
    x = np.asarray(x, dtype=np.float64)
    sd = float(x.std())
    return (x - x.mean()) / sd if sd > _EPS else np.zeros_like(x)


def _robust(x: np.ndarray, floor: float) -> np.ndarray:
    """Centre and scale, with the spread floored: ``(x - mean) / (std + floor)``.
    A plain z-score blows a nearly flat row up to unit variance, and on a beat
    grid the only variation left in a flat row is the ±1-frame quantization of
    the beat window — a periodic artefact that then reads as meter."""
    x = np.asarray(x, dtype=np.float64)
    return (x - x.mean()) / (float(x.std()) + floor)


def _scale_rows(m: np.ndarray, rel_floor: float = _SCALE_FLOOR) -> np.ndarray:
    """Rows centred and scaled by ``std + floor``, the floor a fraction of the
    median row spread, so rows with real beat-to-beat structure carry the
    cosine and flat ones barely register."""
    m = np.asarray(m, dtype=np.float64)
    sd = m.std(axis=1, keepdims=True)
    live = sd[sd > _EPS]
    floor = rel_floor * float(np.median(live)) if live.size else 1.0
    return (m - m.mean(axis=1, keepdims=True)) / (sd + floor + _EPS)


def _clamp(x: float) -> float:
    return float(max(0.0, min(1.0, x)))


def _corr(a: np.ndarray, b: np.ndarray) -> float:
    a = a - a.mean()
    b = b - b.mean()
    d = math.sqrt(float((a * a).sum()) * float((b * b).sum()))
    return float((a * b).sum() / d) if d > _EPS else 0.0


def _autocorr(s: np.ndarray, lag: int) -> float:
    if lag <= 0 or lag >= s.size:
        return 0.0
    a, b = s[:-lag], s[lag:]
    d = math.sqrt(float((a * a).sum()) * float((b * b).sum()))
    return float((a * b).sum() / d) if d > _EPS else 0.0


def _effect_size(score: np.ndarray, k: int) -> float:
    """Bias-corrected fraction of the per-beat score variance explained by
    grouping beats into ``k`` phases (epsilon-squared, clamped to [0, 1]).
    ~1 when the k-periodic structure is real, ~0 for noise — where the raw
    eta-squared would still read ``(k-1)/(n-1)``."""
    n = score.size
    if n < 2 * k:
        return 0.0
    mean = score.mean()
    total = float(np.sum((score - mean) ** 2))
    if total <= 1e-12:
        return 0.0
    between = 0.0
    for p in range(k):
        grp = score[p::k]
        if grp.size:
            between += grp.size * float((grp.mean() - mean) ** 2)
    within = max(0.0, total - between)
    eps_sq = (between - (k - 1) * within / float(n - k)) / total
    return float(max(0.0, min(1.0, eps_sq)))


def _cos_dist(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    num = np.sum(a * b, axis=0)
    den = np.linalg.norm(a, axis=0) * np.linalg.norm(b, axis=0) + _EPS
    return 1.0 - num / den


def _lag_similarity(features: np.ndarray, lag: int) -> float:
    """How alike each beat is to the beat ``lag`` beats later: minus the mean
    squared distance between their (scaled) feature vectors. Distance, not
    cosine — a plain beat's centred vector is nearly zero and its DIRECTION is
    frame jitter, which cosine reads as a periodicity of its own; two plain
    beats are simply close, at any lag."""
    b = features.shape[1]
    if lag <= 0 or lag >= b:
        return -np.inf
    d = features[:, :-lag] - features[:, lag:]
    return -float(np.mean(np.sum(d * d, axis=0)))


# --------------------------------------------------------------------------
# meter templates
# --------------------------------------------------------------------------


@lru_cache(maxsize=None)
def groupings(beats_per_bar: int) -> tuple[tuple[int, ...], ...]:
    """Every composition of ``beats_per_bar`` into 2s and 3s, in order — the
    additive groupings a bar of that length can have (7 -> 2+2+3, 2+3+2,
    3+2+2). 4 is 2+2; 2 and 3 are themselves."""
    out: list[tuple[int, ...]] = []

    def rec(rem: int, acc: list[int]) -> None:
        if rem == 0:
            out.append(tuple(acc))
            return
        for part in (2, 3):
            if part <= rem:
                rec(rem - part, acc + [part])

    rec(int(beats_per_bar), [])
    return tuple(out) or ((int(beats_per_bar),),)


def _template(grouping: tuple[int, ...]) -> np.ndarray:
    """Accent hierarchy of a grouping: 1.0 on the downbeat, 0.6 on every other
    group start, 0.25 elsewhere."""
    t = np.full(sum(grouping), 0.25, dtype=np.float64)
    pos = 0
    for i, part in enumerate(grouping):
        t[pos] = 1.0 if i == 0 else 0.6
        pos += part
    return t


def best_grouping(prof: np.ndarray) -> tuple[tuple[int, ...], int, float]:
    """``(grouping, phase, template_corr)`` for a bar whose per-beat accent
    profile is ``prof``: the downbeat phase and the tiling of the bar into 2s
    and 3s whose group starts sit on the strongest accents (the downbeat
    weighted 1.0, other group starts 0.6). Dynamic programming over the bar,
    so 23 costs a few hundred operations, not the 265 compositions of 23."""
    length = int(prof.size)
    best_v, best_phase, best_g = -np.inf, 0, (length,)
    for phase in range(length):
        r = np.roll(prof, -phase)
        value = [-np.inf] * (length + 1)
        choice = [0] * (length + 1)
        value[length] = 0.0
        for i in range(length - 1, -1, -1):
            w = 1.0 if i == 0 else 0.6
            for part in (2, 3):
                j = i + part
                if j <= length and value[j] > -np.inf:
                    v = w * float(r[i]) + value[j]
                    if v > value[i]:
                        value[i], choice[i] = v, part
        if value[0] > best_v:
            g: list[int] = []
            i = 0
            while i < length and choice[i]:
                g.append(choice[i])
                i += choice[i]
            if sum(g) == length:
                best_v, best_phase, best_g = value[0], phase, tuple(g)
    tc = max(0.0, _corr(np.roll(prof, -best_phase), _template(best_g)))
    return best_g, best_phase, tc


@dataclass(frozen=True)
class MeterFit:
    beats_per_bar: int
    grouping: tuple[int, ...]
    phase: int  # beat index within the window (mod beats_per_bar) of the downbeat
    score: float  # prior-weighted
    data: float  # the evidence alone, in [0, 1]
    effect: float
    autocorr: float
    template_corr: float
    similarity: float
    profile: tuple[float, ...] = ()  # mean accent per phase, downbeat at ``phase``


def fit_meter(
    accents: np.ndarray,
    features: Optional[np.ndarray] = None,
    l_min: int = L_MIN,
    l_max: int = L_MAX,
    *,
    compound: bool = False,
    row_weights: Optional[np.ndarray] = None,
) -> list[MeterFit]:
    """Score every bar length in ``[l_min, l_max]`` against a window.

    ``accents`` is the per-beat accent score; ``features`` (optional, [D, B])
    the per-beat feature matrix whose lag-L self-similarity is the fourth
    reading. ``data`` weighs the readings (0.30 effect, 0.25 autocorr, 0.15
    template, 0.30 similarity — or 0.45 / 0.35 / 0.20 without features);
    ``score`` multiplies in the prior — the compound one when each tracked
    beat splits in three, where a 2-beat bar is 6/8. The grouping search
    (``best_grouping``) runs for the ``_TOP_K_GROUPING`` best lengths by the
    cheaper readings; the rest keep a plain 2s-then-3 grouping and no template
    credit.
    """
    s = np.asarray(accents, dtype=np.float64)
    lengths = [
        length for length in range(int(l_min), int(l_max) + 1) if s.size >= 2 * length
    ]
    if not lengths:
        return []
    sims: dict[int, float] = {}
    if features is not None and features.ndim == 2 and features.shape[1] == s.size:
        feats = _scale_rows(features)
        if row_weights is not None and row_weights.size == feats.shape[0]:
            feats = feats * row_weights[:, None]
        sims = {length: _lag_similarity(feats, length) for length in lengths}
        sims = {k: v for k, v in sims.items() if np.isfinite(v)}
        lo, hi = (min(sims.values()), max(sims.values())) if sims else (0.0, 0.0)
        span = hi - lo
        sims = {k: (v - lo) / span if span > _EPS else 0.0 for k, v in sims.items()}

    cheap: list[tuple[int, np.ndarray, float, float, float]] = []
    for length in lengths:
        prof = np.asarray([s[p::length].mean() for p in range(length)])
        eff = _effect_size(s, length)
        ac = max(0.0, _autocorr(s, length))
        sim = sims.get(length, 0.0) if sims else 0.0
        cheap.append((length, prof, eff, ac, sim))
    rank = sorted(
        cheap,
        key=lambda c: (
            -(
                0.30 * c[2] + 0.25 * c[3] + 0.30 * c[4]
                if sims
                else 0.45 * c[2] + 0.35 * c[3]
            )
        ),
    )
    searched = {c[0] for c in rank[:_TOP_K_GROUPING]}

    fits: list[MeterFit] = []
    for length, prof, eff, ac, sim in cheap:
        if length in searched:
            grouping, phase, tc = best_grouping(prof)
        else:
            grouping, phase, tc = groupings(length)[0], int(np.argmax(prof)), 0.0
        if sims:
            data = 0.30 * eff + 0.25 * ac + 0.15 * tc + 0.30 * sim
        else:
            data = 0.45 * eff + 0.35 * ac + 0.20 * tc
        fits.append(
            MeterFit(
                length,
                grouping,
                phase,
                data + _PRIOR_WEIGHT * _prior(length, compound),
                data,
                eff,
                ac,
                tc,
                sim,
                tuple(float(v) for v in prof),
            )
        )
    return fits


def _one_downbeat(best: MeterFit, fits: list[MeterFit]) -> MeterFit:
    """One bar, one downbeat. A 4/4 whose melody cycles in 3 is 12-periodic —
    the melody's onsets even leak into the low band — and 12 explains more
    variance than 4. But its profile has downbeats of equal strength at 0, 4
    and 8, and a bar with three equal downbeats is three bars. For each divisor
    of the winning length: if the profile's values at that spacing from the
    downbeat are all accents (above the mean) and alike (spread within
    ``_EQUAL_DOWNBEAT_TOL`` of the profile's span), the bar is the divisor. A
    real 12/8 keeps its 12: the downbeat at +6 dB stands over group starts at
    +3, half the span apart."""
    length = best.beats_per_bar
    prof = np.asarray(best.profile, dtype=np.float64)
    if prof.size != length or length < 4:
        return best
    span = float(prof.max() - prof.min())
    if span <= _EPS:
        return best
    by_len = {f.beats_per_bar: f for f in fits}
    mean = float(prof.mean())
    for d in range(2, length):
        if length % d or d not in by_len:
            continue
        downbeats = prof[[(best.phase + k * d) % length for k in range(length // d)]]
        if (
            float(downbeats.min()) >= mean
            and float(downbeats.max() - downbeats.min()) <= _EQUAL_DOWNBEAT_TOL * span
        ):
            return by_len[d]
    return best


def pick_meter(
    fits: list[MeterFit], *, tie_penalty: bool = True
) -> tuple[Optional[MeterFit], float]:
    """The winning fit and a confidence in [0, 1].

    The score — evidence plus a small prior, so the prior breaks ties and never
    outvotes a bar that explains the accents completely — picks a candidate. Every divisor of it that keeps
    ``_PHRASE_GUARD_RATIO`` of its evidence is the same pattern read with a
    shorter bar, and the bar is the shortest cycle that explains the accents:
    among the candidate and those divisors the best SCORE wins — so 8 becomes
    4 (a two-bar fill is 8-periodic, the bar is still 4), 6 becomes 2 in 6/8,
    and 4 stays 4 over a 2 that explains as much, because 4/4 is the
    convention when nothing separates them.

    Confidence is the top-two margin against bar lengths COPRIME to the winner.
    A length sharing a factor with the true bar (6 against 4, 9 against 6)
    explains part of the pattern by construction — the duple alternation, the
    triple — so it always scores well and says nothing about whether the bar
    is right; multiples and divisors are the same reading at another level.
    When such a related length all but ties the winner the reading IS
    ambiguous (4 against 6 in a hemiola) and the confidence is halved. The
    whole thing is then scaled by how much evidence the winner has at all.
    """
    if not fits:
        return None, 0.0
    top = max(fits, key=lambda f: f.score)
    family = [top] + [
        f
        for f in fits
        if 1 < f.beats_per_bar < top.beats_per_bar
        and top.beats_per_bar % f.beats_per_bar == 0
        and f.data >= top.data * _PHRASE_GUARD_RATIO
    ]
    best = max(family, key=lambda f: (f.score, -f.beats_per_bar))
    best = _one_downbeat(best, fits)
    length = best.beats_per_bar
    unrelated = [f.data for f in fits if math.gcd(f.beats_per_bar, length) == 1]
    related = [
        f.score
        for f in fits
        if f.beats_per_bar != length
        and math.gcd(f.beats_per_bar, length) > 1
        and length % f.beats_per_bar != 0
        and f.beats_per_bar % length != 0
    ]
    second = max(unrelated, default=0.0)
    margin = (best.data - second) / (abs(best.data) + abs(second) + _EPS)
    # A related length that all but ties (4 against 6 in a hemiola) halves the
    # confidence — unless the caller reads the rhythm section alone, whose job
    # is the bar: a melody cycling in 3 over 4/4 drums makes 6 tie 4 in the
    # mix, and that ambiguity is the polymeter to report, not a reason to
    # doubt the drums.
    penalty = (
        0.5 if tie_penalty and any(r >= 0.9 * best.score for r in related) else 1.0
    )
    conf = _clamp(margin) * _clamp(best.data / 0.6) * penalty
    return best, float(conf)


# --------------------------------------------------------------------------
# front end: onsets, tempo curve, beats
# --------------------------------------------------------------------------


def _onset_envelopes(y: np.ndarray, sr: int) -> tuple[np.ndarray, np.ndarray]:
    """``(env [4, T], band_power [3, T])``: low / mid / high / broad onset
    strength from one STFT, and the linear power per frame of the low, mid and
    high bands — what a beat's ENERGY is read from, alignment be damned."""
    import librosa

    S = np.abs(librosa.stft(y, n_fft=_N_FFT, hop_length=_HOP))
    mel = librosa.feature.melspectrogram(S=S**2, sr=sr, n_mels=_N_MELS)
    channels = [
        slice(_BAND_EDGES[0], _BAND_EDGES[1]),
        slice(_BAND_EDGES[1], _BAND_EDGES[2]),
        slice(_BAND_EDGES[2], _BAND_EDGES[3]),
        slice(_BAND_EDGES[0], _BAND_EDGES[3]),
    ]
    env = librosa.onset.onset_strength_multi(
        S=librosa.power_to_db(mel), sr=sr, hop_length=_HOP, channels=channels
    )
    band_power = np.stack(
        [
            mel[channels[0]].sum(axis=0),
            mel[channels[1]].sum(axis=0),
            mel[channels[2]].sum(axis=0),
        ]
    )
    return np.asarray(env, dtype=np.float64), np.asarray(band_power, dtype=np.float64)


def _fold_octaves(local: np.ndarray, reference: float) -> np.ndarray:
    """Pull per-frame tempo estimates that sit an octave off ``reference`` back
    to it. The tempogram peaks at 2x and 1/2x too, and a frame-wise argmax
    hops between them."""
    out = local.astype(np.float64).copy()
    for _ in range(3):
        out = np.where(out > 1.55 * reference, out / 2.0, out)
        out = np.where(out < 0.65 * reference, out * 2.0, out)
    return out


def _tempo_runs(curve: np.ndarray, frame_sec: float) -> list[tuple[int, int, float]]:
    """``(start_frame, end_frame, bpm)`` runs of the smoothed local tempo. A new
    run starts where the curve leaves the current run's tempo by more than
    ``_TEMPO_STEP`` for at least ``_TEMPO_STEP_MIN_SEC``; runs shorter than
    ``_TEMPO_RUN_MIN_SEC`` then fold into the neighbour they are closer to."""
    n = int(curve.size)
    if n == 0:
        return []
    min_frames = max(1, int(round(_TEMPO_STEP_MIN_SEC / frame_sec)))
    step = math.log(1.0 + _TEMPO_STEP)
    runs: list[tuple[int, int, float]] = []
    start = 0
    ref = float(np.median(curve[: min(n, min_frames)]))
    i = 0
    while i < n:
        if abs(math.log(max(curve[i], _EPS) / ref)) > step:
            j = i
            while j < n and abs(math.log(max(curve[j], _EPS) / ref)) > step:
                j += 1
            if j - i >= min_frames:
                runs.append((start, i, float(np.median(curve[start:i]))))
                start = i
                ref = float(np.median(curve[i:j]))
            i = j
            continue
        i += 1
    runs.append((start, n, float(np.median(curve[start:n]))))

    min_run = int(round(_TEMPO_RUN_MIN_SEC / frame_sec))
    changed = True
    while changed and len(runs) > 1:
        changed = False
        for k, (a, b, bpm) in enumerate(runs):
            if b - a >= min_run:
                continue
            # Fold into the neighbour whose tempo is closer; the neighbour's
            # tempo stands (it is the one with enough music behind it).
            cands = []
            if k > 0:
                cands.append((abs(math.log(bpm / runs[k - 1][2])), k - 1))
            if k + 1 < len(runs):
                cands.append((abs(math.log(bpm / runs[k + 1][2])), k + 1))
            _, into = min(cands)
            lo, hi = min(k, into), max(k, into)
            merged = (runs[lo][0], runs[hi][1], runs[into][2])
            runs = runs[:lo] + [merged] + runs[hi + 1 :]
            changed = True
            break
    return runs


def _track_beats(
    oenv: np.ndarray,
    sr: int,
    bpm_curve: np.ndarray,
    fallback_bpm: float,
    hop: int = _HOP,
) -> np.ndarray:
    """Beat frames from the DP tracker, following a per-frame tempo curve.
    Falls back to one tempo if this librosa cannot take an array."""
    import librosa

    try:
        _, frames = librosa.beat.beat_track(
            onset_envelope=oenv,
            sr=sr,
            hop_length=hop,
            bpm=bpm_curve,
            trim=False,
            units="frames",
        )
    except Exception as e:  # pragma: no cover - depends on the librosa build
        log.info("rhythm: per-frame tempo not accepted by beat_track (%s)", e)
        _, frames = librosa.beat.beat_track(
            onset_envelope=oenv,
            sr=sr,
            hop_length=hop,
            bpm=float(fallback_bpm),
            trim=False,
            units="frames",
        )
    return np.asarray(frames, dtype=np.int64)


def _unit(x: np.ndarray) -> np.ndarray:
    m = float(np.max(x)) if x.size else 0.0
    return x / m if m > _EPS else x


def _mass_at(env: np.ndarray, frames: np.ndarray) -> float:
    """Onset mass at ``frames``, a frame either side allowed."""
    n = env.size
    f = frames[(frames >= 0) & (frames < n)]
    if f.size == 0:
        return 0.0
    lo = np.clip(f - 1, 0, n - 1)
    hi = np.clip(f + 1, 0, n - 1)
    return float(np.sum(np.maximum(np.maximum(env[lo], env[f]), env[hi])))


def _snap_to_peaks(
    beat_frames: np.ndarray, env: np.ndarray, radius: int = 2
) -> np.ndarray:
    """Move each beat to the strongest frame of ``env`` within ``radius`` frames.
    The tracker and the phase shift place beats to the frame, and onsets are
    detected at envelope peaks; a one-frame gap between the two grids is a 0.05
    error in every sub-beat phase — enough to read a triplet swing (2.0) as
    2.5. On one grid the phases are exact to the hop."""
    n = env.size
    out = beat_frames.astype(np.int64).copy()
    for i, f in enumerate(out):
        lo, hi = max(0, f - radius), min(n, f + radius + 1)
        if hi > lo:
            out[i] = lo + int(np.argmax(env[lo:hi]))
    return np.unique(out)


def _occupancy(frames: np.ndarray, env: np.ndarray) -> float:
    """The share of a grid's positions that carry an onset of their own: mass
    within a frame of the position at least 1.5x the mass at the midpoints on
    either side, and not noise. A contrast, not a level — kicks on the group
    starts are several times a hat, and a level threshold reads only them. A
    grid twice as fine as the music (sixteenths over eighth-note hats) leaves
    every other position no louder than the gaps around it, and reads 0.5."""
    n = env.size
    f = np.sort(frames[(frames >= 0) & (frames < n)])
    if f.size < 6:
        return 0.0

    def mass(idx: np.ndarray) -> np.ndarray:
        lo = np.clip(idx - 1, 0, n - 1)
        hi = np.clip(idx + 1, 0, n - 1)
        return np.maximum(np.maximum(env[lo], env[np.clip(idx, 0, n - 1)]), env[hi])

    at = mass(f)
    mids = mass((f[:-1] + f[1:]) // 2)
    floor = 0.05 * float(at.max()) if at.size else 0.0
    inner = at[1:-1]
    gaps = np.maximum(mids[:-1], mids[1:])
    occupied = (inner >= 1.5 * gaps) & (inner > floor)
    return float(np.mean(occupied)) if inner.size else 0.0


def _align_phase(beat_frames: np.ndarray, low_power: np.ndarray) -> np.ndarray:
    """Put the beats where the low end hits. Spectral flux makes a broadband
    hat outweigh a kick, so the tracker readily locks onto hats — on the
    off-beat, or on the swung eighth two thirds through — and the period is
    right while the phase is not. Of the grid's fractional offsets (twelfths of
    a beat), the one sitting on clearly the most low-band POWER is the beat.
    Power, not flux: a hat out of silence is a large dB step in the low bands
    too, but it has no low-band energy to speak of."""
    if beat_frames.size < 3:
        return beat_frames
    period = float(np.median(np.diff(beat_frames)))
    if period < 2:
        return beat_frames
    n = low_power.size
    base = _mass_at(low_power, beat_frames)
    best_shift, best_mass = 0, base
    for k in range(1, 12):
        shift = int(round(k * period / 12.0))
        if shift <= 0 or shift >= period:
            continue
        cand = beat_frames + shift
        mass = _mass_at(low_power, cand[cand < n])
        if mass > best_mass:
            best_shift, best_mass = shift, mass
    if best_shift == 0 or best_mass <= _PHASE_FLIP_RATIO * base:
        return beat_frames
    shifted = beat_frames + best_shift
    lead = beat_frames[0] + best_shift - int(round(period))
    if lead >= 0:
        shifted = np.concatenate([[lead], shifted])
    log.debug("rhythm: beats moved by %d frames onto the low-band grid", best_shift)
    return shifted[shifted < n].astype(np.int64)


def _beat_energies(band_power: np.ndarray, spans: np.ndarray) -> np.ndarray:
    """[4, B] dB: low / mid / high / broad energy of each beat, the band power
    summed over the beat's span. A sum over the span does not care where the
    frames fall against the transient; a peak level does — a kick's sampled
    peak swings several dB with sub-frame alignment, and since the beat period
    is not a whole number of frames that swing is periodic, and reads as
    meter (a 6-beat cycle at 100 bpm, 5.5 at 128)."""
    n = band_power.shape[1]
    spans = np.clip(np.asarray(spans, dtype=np.int64), 0, n)
    period = int(round(float(np.median(np.diff(spans))))) if spans.size > 1 else 1
    ends = np.append(spans[1:], min(n, spans[-1] + max(1, period)))
    cs = np.concatenate([np.zeros((3, 1)), np.cumsum(band_power, axis=1)], axis=1)
    e = cs[:, ends] - cs[:, spans]  # [3, B]
    # The SUM, not the mean: a hit's energy is the same whether its span is 5
    # or 6 frames, and dividing by the span would manufacture a 2-cycle on a
    # fine grid rounded to whole frames. (A sustained pad does the opposite,
    # by 0.8 dB; the accents this feeds are about hits.)
    e = np.concatenate([e, e.sum(axis=0, keepdims=True)], axis=0)
    db = 10.0 * np.log10(np.maximum(e, 1e-12))
    # A beat in digital silence (a trailing beat past the last hit, a gap) is
    # -120 dB — one such outlier owns the variance of the whole row and
    # flattens every real contrast in it. 60 dB under the row's loudest beat is
    # as quiet as a beat needs to be.
    return np.maximum(db, db.max(axis=1, keepdims=True) - 60.0)


def _accents(f: dict[str, np.ndarray], energies: np.ndarray) -> np.ndarray:
    """Per-beat accent score: where bars start. Low-band energy first (the kick,
    the bass), broad energy next, chroma novelty last — a melody cycling in 3
    over 4/4 drums does not move the bar. Each term is floored (1 dB, 0.05 of
    cosine distance) so a flat one cannot be inflated into evidence."""
    low_db, broad_db = energies[0], energies[3]
    b = low_db.size
    chroma = np.asarray(f["chroma"], dtype=np.float64)
    c = np.zeros(b, dtype=np.float64)
    if chroma.ndim == 2 and chroma.shape[1] == b and b > 1:
        c[1:] = _cos_dist(chroma[:, 1:], chroma[:, :-1])
    return (
        1.0 * _robust(low_db, 1.0)
        + 0.5 * _robust(broad_db, 1.0)
        + 0.35 * _robust(c, 0.05)
    )


def _feature_matrix(f: dict[str, np.ndarray], energies: np.ndarray) -> np.ndarray:
    """[17, B]: what each beat sounds like, for the lag similarity — the four
    band energies and the 13 MFCCs, weighted by ``_ROW_WEIGHTS`` after the fit
    scales each row per window. Chroma is left out: on percussive music it is
    noise, and harmonic rhythm repeats at the phrase more than the bar."""
    return np.concatenate([energies, np.asarray(f["mfcc"], dtype=np.float64)], axis=0)


# --------------------------------------------------------------------------
# meter map
# --------------------------------------------------------------------------


@dataclass
class _Window:
    start: int
    center: int
    fit: Optional[MeterFit]
    conf: float


def _pick_window(
    accents: np.ndarray,
    features: np.ndarray,
    low_accents: np.ndarray,
    low_features: np.ndarray,
    compound: bool,
    l_max: int = L_MAX,
) -> tuple[Optional[MeterFit], float]:
    """One window's bar, read twice. The composite hears everything — and a
    melody cycling in 3 over 4/4 drums makes it 12-periodic, so 12 (or 6) wins
    on the evidence. The rhythm section sets the bar: when the low band alone
    reads a bar that divides the composite's, with some confidence, the low
    band's bar stands and the melody's cycle is a polymeter to report."""
    fit, conf = pick_meter(
        fit_meter(
            accents, features, l_max=l_max, compound=compound, row_weights=_ROW_WEIGHTS
        )
    )
    low_fit, low_conf = pick_meter(
        fit_meter(
            low_accents,
            low_features,
            l_max=l_max,
            compound=compound,
            row_weights=_LOW_ROW_WEIGHTS,
        ),
        tie_penalty=False,
    )
    if low_fit is not None and low_conf >= _LOW_LEAD_CONF:
        # The composite cannot decide (a melody's cycle and the drums' bar
        # share no small multiple): the rhythm section's reading stands.
        if fit is None or conf < _UNSURE_CONF:
            return low_fit, low_conf
        if low_fit.beats_per_bar == fit.beats_per_bar:
            # Two independent readings agree: the confidence is the stronger.
            return fit, max(conf, low_conf)
        if (
            low_fit.beats_per_bar < fit.beats_per_bar
            and fit.beats_per_bar % low_fit.beats_per_bar == 0
        ):
            return low_fit, max(low_conf, conf)
    return fit, conf


def _fit_windows(
    accents: np.ndarray,
    features: np.ndarray,
    low_accents: np.ndarray,
    low_features: np.ndarray,
    window: int,
    stride: int,
    *,
    compound: bool = False,
    l_max: int = L_MAX,
) -> list[_Window]:
    b = accents.size
    out: list[_Window] = []
    if b <= window:
        fit, conf = _pick_window(
            accents, features, low_accents, low_features, compound, l_max
        )
        return [_Window(0, b // 2, fit, conf)]
    starts = list(range(0, b - window + 1, stride))
    if starts[-1] != b - window:
        starts.append(b - window)
    for st in starts:
        sl = slice(st, st + window)
        fit, conf = _pick_window(
            accents[sl],
            features[:, sl],
            low_accents[sl],
            low_features[:, sl],
            compound,
            l_max,
        )
        out.append(_Window(st, st + window // 2, fit, conf))
    return out


@dataclass
class _Segment:
    start_beat: int
    end_beat: int
    beats_per_bar: int
    grouping: tuple[int, ...]
    phase: int  # absolute beat index class (mod beats_per_bar) of the downbeats
    confidence: float


def _labels(windows: list[_Window]) -> list[int]:
    """One bar length per window. A window too unsure to say inherits the
    running label — it may not open a segment of its own."""
    labels: list[int] = []
    current: Optional[int] = None
    for w in windows:
        if w.fit is not None and (w.conf >= _UNDECIDED_CONF or current is None):
            current = w.fit.beats_per_bar
        labels.append(current if current is not None else 0)
    # Leading undecided windows take the first decided label.
    first = next((label for label in labels if label), 0)
    return [label or first for label in labels]


def _runs(windows: list[_Window]) -> list[tuple[int, list[_Window]]]:
    """``(bar length, windows)`` runs of consecutive windows with the same label;
    runs shorter than ``_MIN_RUN_WINDOWS`` are absorbed by their predecessor
    (or successor, at the start)."""
    labels = _labels(windows)
    if not windows or not any(labels):
        return []
    runs: list[tuple[int, list[_Window]]] = [(labels[0], [windows[0]])]
    for w, label in zip(windows[1:], labels[1:]):
        if label == runs[-1][0]:
            runs[-1][1].append(w)
        else:
            runs.append((label, [w]))
    changed = True
    while changed and len(runs) > 1:
        changed = False
        for k, (label, ws) in enumerate(runs):
            if len(ws) >= _MIN_RUN_WINDOWS:
                continue
            into = k - 1 if k > 0 else k + 1
            lo, hi = min(k, into), max(k, into)
            merged = (runs[into][0], runs[lo][1] + runs[hi][1])
            runs = runs[:lo] + [merged] + runs[hi + 1 :]
            changed = True
            break
    return runs


def _phase_vote(run: list[_Window], length: int) -> tuple[int, tuple[int, ...]]:
    votes: dict[int, float] = {}
    group_votes: dict[tuple[int, ...], float] = {}
    for w in run:
        if w.fit is None or w.fit.beats_per_bar != length:
            continue
        cls = (w.start + w.fit.phase) % length
        votes[cls] = votes.get(cls, 0.0) + max(w.conf, 1e-3)
        group_votes[w.fit.grouping] = group_votes.get(w.fit.grouping, 0.0) + max(
            w.conf, 1e-3
        )
    phase = max(votes.items(), key=lambda kv: kv[1])[0] if votes else 0
    grouping = (
        max(group_votes.items(), key=lambda kv: kv[1])[0]
        if group_votes
        else groupings(length)[0]
    )
    return phase, grouping


def _snap_to_class(beat: int, cls: int, length: int, lo: int, hi: int) -> int:
    """The beat nearest ``beat`` that is ≡ cls (mod length), clamped to
    [lo, hi]."""
    base = beat - ((beat - cls) % length)
    cands = [c for c in (base, base + length) if lo <= c <= hi]
    if not cands:
        return max(lo, min(hi, beat))
    return min(cands, key=lambda c: abs(c - beat))


def _refine_boundary(
    accents: np.ndarray,
    start: int,
    end: int,
    guess: int,
    old_len: int,
    new_len: int,
    new_cls: int,
) -> int:
    """The beat where the old meter stops explaining the accents and the new
    one starts: among candidates on the new meter's downbeat class within
    ``_BOUNDARY_SEARCH_BEATS`` of ``guess``, the split whose two halves are best
    explained by their own bar lengths (variance explained, length-weighted).
    A window that straddles a change keeps reading the old meter until most of
    it is new, so the guess from window centres runs late by up to half a
    window; this puts the change back where the accents change."""
    lo = max(start + old_len, guess - _BOUNDARY_SEARCH_BEATS)
    hi = min(end - new_len, guess + _BOUNDARY_SEARCH_BEATS)
    first = lo + ((new_cls - lo) % new_len)
    cands = list(range(first, hi + 1, new_len))
    if not cands:
        return _snap_to_class(guess, new_cls, new_len, start + 1, end)
    best, best_score = cands[0], -1.0
    for b in cands:
        before = _effect_size(accents[start:b], old_len) * (b - start)
        after = _effect_size(accents[b:end], new_len) * (end - b)
        score = before + after
        if score > best_score:
            best, best_score = b, score
    return best


def _segments(
    windows: list[_Window], n_beats: int, accents: Optional[np.ndarray] = None
) -> list[_Segment]:
    runs = _runs(windows)
    if not runs:
        return []
    segs: list[_Segment] = []
    start = 0
    for i, (length, run) in enumerate(runs):
        phase, grouping = _phase_vote(run, length)
        if i + 1 < len(runs):
            nxt_len, nxt_run = runs[i + 1]
            mid = (run[-1].center + nxt_run[0].center) // 2
            nxt_phase, _ = _phase_vote(nxt_run, nxt_len)
            # The next run's own far edge bounds the search for this boundary.
            far = (
                (nxt_run[-1].center + runs[i + 2][1][0].center) // 2
                if i + 2 < len(runs)
                else n_beats
            )
            if accents is not None:
                end = _refine_boundary(
                    accents, start, min(far, n_beats), mid, length, nxt_len, nxt_phase
                )
            else:
                end = _snap_to_class(mid, nxt_phase, nxt_len, start + 1, n_beats)
        else:
            end = n_beats
        conf = float(
            np.mean(
                [w.conf for w in run if w.fit and w.fit.beats_per_bar == length]
                or [0.0]
            )
        )
        segs.append(_Segment(start, end, length, grouping, phase, conf))
        start = end
    # A segment shorter than two of its own bars is a boundary artefact; it
    # joins the more confident neighbour, which keeps its meter.
    changed = True
    while changed and len(segs) > 1:
        changed = False
        for k, seg in enumerate(segs):
            if seg.end_beat - seg.start_beat >= max(2 * seg.beats_per_bar, 8):
                continue
            cands = [j for j in (k - 1, k + 1) if 0 <= j < len(segs)]
            into = max(cands, key=lambda j: segs[j].confidence)
            host = segs[into]
            lo, hi = min(k, into), max(k, into)
            merged = _Segment(
                segs[lo].start_beat,
                segs[hi].end_beat,
                host.beats_per_bar,
                host.grouping,
                host.phase,
                host.confidence,
            )
            segs = segs[:lo] + [merged] + segs[hi + 1 :]
            changed = True
            break
    return segs


# --------------------------------------------------------------------------
# subdivision, syncopation
# --------------------------------------------------------------------------


def _beat_phases(
    onsets: np.ndarray, strengths: np.ndarray, beats: np.ndarray, lo: int, hi: int
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """For onsets inside beats ``lo..hi-1``: ``(phase in [0,1), strength, beat
    index)``."""
    if hi - lo < 1 or onsets.size == 0:
        return np.zeros(0), np.zeros(0), np.zeros(0, dtype=np.int64)
    last = beats[-1] - beats[-2] if beats.size > 1 else 0.5
    ends = np.append(beats[1:], beats[-1] + last)
    idx = np.searchsorted(beats, onsets, side="right") - 1
    keep = (idx >= lo) & (idx < hi)
    idx = idx[keep]
    o = onsets[keep]
    dur = np.maximum(ends[idx] - beats[idx], _EPS)
    return (o - beats[idx]) / dur, strengths[keep], idx


def _subdivision(phases: np.ndarray, strengths: np.ndarray) -> dict[str, Any]:
    """Simple vs compound from where off-beat onsets fall inside the beat, and
    whether sixteenths are in play. Compound needs BOTH thirds to carry the
    off-beat mass outright, not merely to edge out the half."""
    off = (phases > 0.1) & (phases < 0.9)
    p, s = phases[off], strengths[off]
    total = float(s.sum())
    if total <= _EPS:
        return {"kind": "simple", "confidence": 0.0, "sixteenths": False}
    m_half = float(s[np.abs(p - 0.5) < 0.07].sum())
    m_first = float(s[np.abs(p - 1 / 3) < 0.07].sum())
    m_second = float(s[np.abs(p - 2 / 3) < 0.07].sum())
    m_third = m_first + m_second
    m_quarter = float(s[(np.abs(p - 0.25) < 0.06) | (np.abs(p - 0.75) < 0.06)].sum())
    # Both thirds have to be there: swung eighths sit on the second third
    # alone, and that is 4/4 with swing, not 12/8.
    compound = (
        m_third >= 0.4 * total
        and m_half < 0.5 * m_third
        and min(m_first, m_second) >= 0.2 * m_third
    )
    conf = abs(m_third - m_half) / (m_third + m_half + _EPS)
    return {
        "kind": "compound" if compound else "simple",
        "confidence": float(min(1.0, conf)),
        "sixteenths": bool(not compound and m_quarter >= 0.3 * total),
    }


def _swing(phases: np.ndarray, beat_idx: np.ndarray) -> tuple[Optional[float], float]:
    """Swing ratio (long eighth / short eighth; 1 straight, 2 triplet) from beats
    with exactly one off-beat onset in the swing range."""
    if phases.size == 0:
        return None, 0.0
    ratios: list[float] = []
    for b in np.unique(beat_idx):
        ph = phases[(beat_idx == b) & (phases > 0.1) & (phases < 0.9)]
        if ph.size == 1 and 0.4 <= ph[0] <= 0.8:
            ratios.append(float(ph[0] / (1.0 - ph[0])))
    if len(ratios) < 4:
        return None, 0.0
    return float(np.median(ratios)), float(min(1.0, len(ratios) / 16.0))


def _metrical_weights(grouping: tuple[int, ...], q: int) -> np.ndarray:
    """Weights per grid position of one bar: 4 bar start, 3 group start, 2 beat,
    1 the beat's main subdivision, 0 the rest."""
    length = sum(grouping)
    w = np.zeros(length * q, dtype=np.float64)
    if q == 2:
        w[1::2] = 1
    elif q == 4:
        w[2::4] = 1
    elif q == 3:
        w[1::3] = 1
        w[2::3] = 1
    w[0::q] = 2
    pos = 0
    for part in grouping:
        w[pos * q] = 3
        pos += part
    w[0] = 4
    return w


def _bar_syncopation(
    positions: np.ndarray, saliences: np.ndarray, weights: np.ndarray, q: int
) -> dict[str, float]:
    """LHL (a note on a weak position followed by silence on a stronger one,
    weighted by salience, per note, /4), WNBD on onsets (1 / distance to the
    nearest beat, per note, /4), and the share of onset salience off the beat."""
    n = weights.size
    if positions.size == 0:
        return {"lhl": 0.0, "wnbd": 0.0, "offbeat_ratio": 0.0, "onsets": 0}
    occupied: dict[int, float] = {}
    for p, s in zip(positions.tolist(), saliences.tolist()):
        p = int(max(0, min(n - 1, p)))
        occupied[p] = max(occupied.get(p, 0.0), float(s))
    ps = sorted(occupied)
    lhl = 0.0
    for i, p in enumerate(ps):
        nxt = ps[i + 1] if i + 1 < len(ps) else n
        if nxt - p <= 1:
            continue
        rest = float(weights[p + 1 : nxt].max())
        if rest > weights[p]:
            lhl += occupied[p] * (rest - weights[p])
    wnbd = 0.0
    for p in ps:
        d = min(p % q, q - (p % q)) / q
        wnbd += 0.0 if d == 0 else 1.0 / d
    total = sum(occupied.values())
    off = sum(v for p, v in occupied.items() if weights[p] < 2)
    return {
        "lhl": float(lhl / len(ps) / 4.0),
        "wnbd": float(wnbd / len(ps) / 4.0),
        "offbeat_ratio": float(off / total) if total > _EPS else 0.0,
        "onsets": len(ps),
    }


# --------------------------------------------------------------------------
# polymeter, cross-rhythms
# --------------------------------------------------------------------------


def _poly_relation(length: int, seg_len: int, den: int) -> Optional[tuple[str, str]]:
    """``(relation, label)`` for a layer bar of ``length`` positions against a
    segment bar of ``seg_len`` positions on one grid whose note value is
    ``den``, or None when it is the same meter at another level."""
    if length == seg_len or seg_len % length == 0 or length % seg_len == 0:
        return None
    return f"{length}:{seg_len}", f"{length}/{den} against {seg_len}/{den}"


def _polymeter(
    layers: dict[str, np.ndarray],
    segs: list[_Segment],
    *,
    den: int = 4,
    l_max: int = L_MAX,
) -> list[dict[str, Any]]:
    """Per segment and layer: a bar length of its own that is neither the
    segment's nor the same meter at another level. Only claimed against a
    segment whose own meter is trusted. ``den`` is the level's note value."""
    out: list[dict[str, Any]] = []
    for si, seg in enumerate(segs):
        # Gated on length, not on the segment's confidence: a layer cycling in
        # 3 over 4/4 drums is exactly what lowers the bar's confidence, and
        # that ambiguity is the finding.
        if seg.end_beat - seg.start_beat < _POLY_MIN_BARS * seg.beats_per_bar:
            continue
        for name, acc in layers.items():
            chunk = acc[seg.start_beat : seg.end_beat]
            if chunk.size < 2 * L_MIN:
                continue
            fit, conf = pick_meter(fit_meter(_zscore(chunk), l_max=l_max))
            if fit is None or conf < _POLY_MIN_CONF:
                continue
            length = fit.beats_per_bar
            if length == seg.beats_per_bar:
                cls = (seg.start_beat + fit.phase) % length
                offset = (cls - seg.phase) % length
                if offset == 0:
                    continue
                relation, label = f"displaced:+{offset}", f"the same bar, {offset} late"
            else:
                rel = _poly_relation(length, seg.beats_per_bar, den)
                if rel is None:
                    continue
                relation, label = rel
            out.append(
                {
                    "segment": si,
                    "layer": name,
                    "beats_per_bar": length,
                    "grouping": list(fit.grouping),
                    "relation": relation,
                    "label": label,
                    "level": f"x{den // 4}" if den > 4 else "tracked",
                    "confidence": round(conf, 3),
                    "segment_confidence": round(seg.confidence, 3),
                }
            )
    return out


def _polymeter_finer(
    layers: dict[str, np.ndarray],
    times: np.ndarray,
    segs: list[_Segment],
    seg_times: list[tuple[float, float]],
    *,
    ratio: int,
    den_seg: int,
) -> list[dict[str, Any]]:
    """The same, on a grid ``ratio`` times finer than the segments' — where a
    layer's bar that is not a whole number of the segment's beats (7/8 against
    5/4: 3.5 quarters) becomes one (7 against 10 eighths)."""
    out: list[dict[str, Any]] = []
    den = den_seg * ratio
    for si, seg in enumerate(segs):
        if seg.end_beat - seg.start_beat < _POLY_MIN_BARS * seg.beats_per_bar:
            continue
        t0, t1 = seg_times[si]
        lo = int(np.searchsorted(times, t0))
        hi = int(np.searchsorted(times, t1))
        seg_len = seg.beats_per_bar * ratio
        for name, acc in layers.items():
            chunk = acc[lo:hi]
            if chunk.size < 2 * L_MIN:
                continue
            fit, conf = pick_meter(fit_meter(_zscore(chunk), l_max=_l_max_for(ratio)))
            if fit is None or conf < _POLY_MIN_CONF:
                continue
            length = fit.beats_per_bar
            if length % ratio == 0:
                continue  # a whole number of the segment's beats: read at the level above
            rel = _poly_relation(length, seg_len, den)
            if rel is None:
                continue
            relation, _ = rel
            out.append(
                {
                    "segment": si,
                    "layer": name,
                    "beats_per_bar": length,
                    "grouping": list(fit.grouping),
                    "relation": relation,
                    "label": f"{length}/{den} against {seg.beats_per_bar}/{den_seg}",
                    "level": f"x{ratio}",
                    "confidence": round(conf, 3),
                    "segment_confidence": round(seg.confidence, 3),
                }
            )
    return out


def _cross_rhythms(
    tg: np.ndarray, sr: int, frames: tuple[int, int], bpm: float
) -> list[dict[str, Any]]:
    """Tempogram peaks at non-octave ratios of the tracked tempo. A ratio counts
    when the profile there is a local peak and carries ``_CROSS_MIN_REL`` of the
    profile's own maximum; strengths are relative to that maximum, so they are
    comparable across segments and never above 1."""
    import librosa

    lo, hi = frames
    if hi <= lo or bpm <= 0:
        return []
    strength = tg[:, lo:hi].mean(axis=1)
    freqs = librosa.tempo_frequencies(tg.shape[0], sr=sr, hop_length=_HOP)
    ok = np.isfinite(freqs) & (freqs > 0)
    f, s = freqs[ok], strength[ok]
    order = np.argsort(f)
    f, s = f[order], s[order]
    peak = float(s.max()) if s.size else 0.0
    if peak <= _EPS:
        return []

    def at(b: float) -> float:
        if b < f[0] or b > f[-1]:
            return 0.0
        return float(np.interp(b, f, s))

    out = []
    for label, ratio in _CROSS_RATIOS:
        b = bpm * ratio
        here = at(b)
        rel = here / peak
        is_peak = here >= at(b * (1 - _CROSS_PEAK_TOL)) and here >= at(
            b * (1 + _CROSS_PEAK_TOL)
        )
        if rel >= _CROSS_MIN_REL and is_peak:
            out.append({"ratio": label, "bpm": round(b, 2), "strength": round(rel, 3)})
    out.sort(key=lambda c: -c["strength"])
    return out[:2]


# --------------------------------------------------------------------------
# the analysis
# --------------------------------------------------------------------------


def _base_den(tracked_bpm: float) -> int:
    """The note value of the tracked beat: a pulse over 160 a minute is read
    as eighths, otherwise quarters."""
    return 8 if tracked_bpm > 160 else 4


def _den_for_rate(grid_bpm: float) -> int:
    """The note value of a grid from its own rate: sixteenths past 320 a
    minute, eighths past 160, quarters below."""
    return 16 if grid_bpm > 320 else 8 if grid_bpm > 160 else 4


def _time_signature(
    length: int,
    grouping: tuple[int, ...],
    subdivision: str,
    bpm: float,
    den: Optional[int] = None,
) -> dict[str, Any]:
    """Numerator / denominator / beat unit. Read on a tatum grid (``den``
    given: 8 for eighths, 16 for sixteenths) the positions ARE the unit and 19
    sixteenths is 19/16. At the tracked beat a compound beat is a dotted
    quarter (2 beats of triplets -> 6/8); a fast pulse of five or more is
    eighths (7 at 190 -> 7/8, 13 at 240 -> 13/8); otherwise the tracked beat is
    the quarter."""
    units = {4: "quarter", 8: "eighth", 16: "sixteenth", 32: "thirty-second"}
    if den is not None:
        num, unit = length, units.get(den, f"1/{den}")
    elif subdivision == "compound":
        num, den, unit = 3 * length, 8, "dotted-quarter"
    elif bpm > 160 and length >= 5:
        num, den, unit = length, 8, "eighth"
    else:
        num, den, unit = length, 4, "quarter"
    label = f"{num}/{den}"
    if len(grouping) > 1 and grouping != (2, 2):
        label += " (" + "+".join(str(g) for g in grouping) + ")"
    return {"numerator": num, "denominator": den, "beat_unit": unit, "label": label}


def _tatum_curve(
    tg: np.ndarray, sr: int, runs: list[tuple[int, int, float]], n_frames: int
) -> tuple[Optional[np.ndarray], Optional[float]]:
    """The tatum — the fastest strong pulse above the beat, hats on eighths or
    sixteenths — per tempo run, as a per-frame tempo curve and its median.

    An additive meter's felt beats are uneven (3+3+3+2 eighths), and a beat
    tracker averages them into a pulse that is not there (87 bpm for 11/8 at
    240); the tatum is the only regular grid, and the bar is a whole number of
    tatums. In the autocorrelation tempogram a pulse train peaks at its own
    period and every multiple (its tempo and every sub-tempo), so the fastest
    peak that carries ``_TATUM_MIN_REL`` of the band's maximum is the tatum.
    The peak's lag is refined by parabolic interpolation: at 480 a minute a
    lag is five frames and a whole frame is a 20 % error."""
    import librosa
    from scipy.signal import find_peaks

    freqs = librosa.tempo_frequencies(tg.shape[0], sr=sr, hop_length=_HOP)
    curve = np.zeros(n_frames, dtype=np.float64)
    found: list[float] = []
    for a, b, run_bpm in runs:
        if b <= a:
            continue
        prof = tg[:, a:b].mean(axis=1)
        lo, hi = 1.5 * run_bpm, min(_TATUM_MAX_BPM, 6.0 * run_bpm)
        band = np.where(np.isfinite(freqs) & (freqs > lo) & (freqs <= hi))[0]
        if band.size < 3:
            continue
        top = float(prof[band].max())
        floor = _TATUM_MIN_REL * top
        # Peaks with prominence: the autocorrelation is high at every lag
        # inside the onset envelope's own width (a few frames), and that
        # bump at the fast edge of the band is not a pulse.
        lo_i, hi_i = int(band.min()), int(band.max())
        a0 = max(0, lo_i - 3)
        pk, _props = find_peaks(prof[a0 : hi_i + 4], prominence=_TATUM_MIN_PROM * top)
        peaks = [
            int(q + a0) for q in pk if lo_i <= q + a0 <= hi_i and prof[q + a0] >= floor
        ]
        if not peaks:
            continue
        i = min(peaks)  # smallest lag: the fastest tempo
        # parabolic refinement of the lag
        y0, y1, y2 = float(prof[i - 1]), float(prof[i]), float(prof[i + 1])
        denom = y0 - 2.0 * y1 + y2
        lag = i + (0.5 * (y0 - y2) / denom if abs(denom) > _EPS else 0.0)
        tatum = 60.0 * sr / (_HOP * max(lag, 1.0))
        # Snap to a whole multiple of the run's beat when it is within 6 %;
        # the grid then stays a subdivision of the beat, not a rival to it.
        for k in (2, 3, 4, 5, 6):
            if abs(tatum / run_bpm - k) <= 0.06 * k:
                tatum = k * run_bpm
                break
        curve[a:b] = tatum
        found.append(tatum)
    if not found:
        return None, None
    med = float(np.median(found))
    curve[curve <= 0] = med
    return curve, med


def _slope_bpm(times: np.ndarray, fallback: float) -> float:
    """Tempo from the span of the beats, not from a median of frame-quantized
    intervals (which lands on 18, 19 or 20 frames and reads 143, 136 or 129)."""
    if times.size < 2 or times[-1] <= times[0]:
        return fallback
    return 60.0 * (times.size - 1) / float(times[-1] - times[0])


def _meter_quality(
    accents: np.ndarray,
    features: np.ndarray,
    low_accents: np.ndarray,
    low_features: np.ndarray,
    *,
    compound: bool = False,
    mult: int = 1,
) -> tuple[list[_Window], float]:
    """Windows scale with the level: the same span of music holds twice the
    eighths, so the window holds twice the positions — and a longer bar fits."""
    windows = _fit_windows(
        accents,
        features,
        low_accents,
        low_features,
        METER_WINDOW_BEATS * mult,
        _METER_STRIDE_BEATS * mult,
        compound=compound,
        l_max=_l_max_for(mult),
    )
    confs = [w.conf for w in windows if w.fit is not None]
    return windows, float(np.mean(confs)) if confs else 0.0


def _dominant_length(windows: list[_Window]) -> int:
    """The bar length most of the windows' confidence sits on; 0 when none."""
    votes: dict[int, float] = {}
    for w in windows:
        if w.fit is not None:
            votes[w.fit.beats_per_bar] = votes.get(w.fit.beats_per_bar, 0.0) + w.conf
    return max(votes.items(), key=lambda kv: kv[1])[0] if votes else 0


def analyze_rhythm(
    y: np.ndarray,
    sr: int,
    *,
    stems: Optional[dict[str, np.ndarray]] = None,
) -> dict[str, Any]:
    """The full analysis of a mono signal. ``stems`` (name -> mono at ``sr``)
    give the polymeter pass real layers; without them it reads the low / mid /
    high bands."""
    import librosa
    from scipy.signal import medfilt

    from backend.modules.chimera.structure import beat_features

    y = np.asarray(y, dtype=np.float32)
    if y.ndim == 2:
        y = y.mean(axis=1)
    duration = float(y.size) / float(sr) if sr else 0.0
    if y.size == 0 or duration < _MIN_DURATION_SEC:
        return _empty(sr, duration, "too short")

    env, band_power = _onset_envelopes(y, sr)
    low_power = band_power[0]
    oenv = env[3]  # the broad stream: onsets for subdivision and syncopation
    # Low-band onsets from the low band's POWER rising, not its dB flux: a
    # broadband hat out of silence is a huge dB step in every band, the low
    # ones included, and out-shouts the kick in flux terms. In power the
    # kick has no rival.
    low_env = _unit(np.maximum(0.0, np.diff(low_power, prepend=low_power[:1])))
    # The pulse is tracked on broad flux + low-band onsets, so a kick counts
    # as much as a hat.
    track_env = _unit(env[3]) + low_env
    n_frames = int(oenv.size)
    frame_sec = _HOP / float(sr)

    # --- tempo curve ------------------------------------------------------
    tg = librosa.feature.tempogram(
        onset_envelope=track_env, sr=sr, hop_length=_HOP, win_length=_TG_WIN
    )
    global_bpm = float(
        np.atleast_1d(
            librosa.feature.tempo(
                onset_envelope=track_env, sr=sr, hop_length=_HOP, tg=tg
            )
        )[0]
    )
    if not np.isfinite(global_bpm) or global_bpm <= 0:
        return _empty(sr, duration, "no tempo")
    local = np.atleast_1d(
        librosa.feature.tempo(
            onset_envelope=track_env, sr=sr, hop_length=_HOP, tg=tg, aggregate=None
        )
    ).astype(np.float64)
    if local.size != n_frames:
        local = np.full(n_frames, global_bpm)
    local = _fold_octaves(local, global_bpm)
    k = int(round(_TEMPO_SMOOTH_SEC / frame_sec)) | 1
    smooth = (
        medfilt(local, kernel_size=min(k, (n_frames - 1) | 1))
        if n_frames > 3
        else local
    )
    tempo_runs = _tempo_runs(smooth, frame_sec)
    # Beats follow the piecewise tempo the runs describe: steady inside a run,
    # stepping at a change, never smeared across it.
    bpm_curve = np.empty(n_frames, dtype=np.float64)
    for a, b, bpm in tempo_runs:
        bpm_curve[a:b] = bpm
    beat_frames = _snap_to_peaks(
        _align_phase(_track_beats(track_env, sr, bpm_curve, global_bpm), low_power),
        track_env,
    )
    if beat_frames.size < 2 * L_MIN:
        return _empty(sr, duration, "too few beats")

    # --- onsets: subdivision reads them, and it is read before the fit ------
    onset_frames = np.asarray(
        librosa.onset.onset_detect(
            onset_envelope=oenv, sr=sr, hop_length=_HOP, units="frames", backtrack=False
        ),
        dtype=np.int64,
    )
    onset_times = librosa.frames_to_time(onset_frames, sr=sr, hop_length=_HOP)
    onset_strength = oenv[np.clip(onset_frames, 0, n_frames - 1)]
    # The low band on its own: syncopation is the low end pushing against
    # the pulse, and a hat on every beat would fill every rest in the mix.
    low_frames = np.asarray(
        librosa.onset.onset_detect(
            onset_envelope=low_env,
            sr=sr,
            hop_length=_HOP,
            units="frames",
            backtrack=False,
        ),
        dtype=np.int64,
    )
    low_times = librosa.frames_to_time(low_frames, sr=sr, hop_length=_HOP)
    low_strength = low_env[np.clip(low_frames, 0, n_frames - 1)]

    # --- evidence, meter — at the tracked level, then at 2x if nothing fits ---
    hires: dict[str, np.ndarray] = {}

    def fine_envelopes() -> dict[str, np.ndarray]:
        """Onset envelopes at hop 128 with a 23 ms window, for the fast grids,
        computed once when first needed: at hop 512 a sixteenth at 120 bpm is
        5.38 frames, the DP rounds the period to 5, and the grid runs 7 % fast
        and never locks; and with a 93 ms window a hat's flux smears over
        sixteen hop-128 frames, so no position stands out from the gaps.
        ``onset_strength`` is told the window: librosa pads the envelope by
        ``n_fft // (2 * hop)`` frames to undo the STFT's centering and assumes
        2048 unless told, which put the flux 35 ms behind the band power."""
        if not hires:
            spec = np.abs(librosa.stft(y, n_fft=_N_FFT_FINE, hop_length=_HOP_FINE))
            mel = librosa.feature.melspectrogram(S=spec**2, sr=sr, n_mels=_N_MELS)
            env_hi = librosa.onset.onset_strength(
                S=librosa.power_to_db(mel),
                sr=sr,
                hop_length=_HOP_FINE,
                n_fft=_N_FFT_FINE,
            )
            low_hi = mel[_BAND_EDGES[0] : _BAND_EDGES[1]].sum(axis=0)
            hires["track"] = _unit(np.asarray(env_hi, dtype=np.float64)) + _unit(
                np.maximum(0.0, np.diff(low_hi, prepend=low_hi[:1]))
            )
            hires["low_power"] = np.asarray(low_hi, dtype=np.float64)
        return hires

    def grid_for(curve: np.ndarray, grid_bpm: float) -> tuple[np.ndarray, float]:
        """A beat grid tracked by the same DP against ``curve``, phase-aligned
        to the low band and snapped to onset peaks — at hop 128 when the grid
        is fast enough for hop 512 to misround its period."""
        if grid_bpm <= _FINE_GRID_FROM_BPM:
            grid = _snap_to_peaks(
                _align_phase(_track_beats(track_env, sr, curve, grid_bpm), low_power),
                track_env,
            )
            return grid, _occupancy(grid, track_env)
        h = fine_envelopes()
        n_hi = h["track"].size
        k = _HOP // _HOP_FINE
        curve_hi = np.repeat(curve, k)[:n_hi]
        if curve_hi.size < n_hi:
            tail = curve_hi[-1] if curve_hi.size else grid_bpm
            curve_hi = np.concatenate([curve_hi, np.full(n_hi - curve_hi.size, tail)])
        frames_hi = _track_beats(h["track"], sr, curve_hi, grid_bpm, hop=_HOP_FINE)
        frames_hi = _snap_to_peaks(_align_phase(frames_hi, h["low_power"]), h["track"])
        # Occupancy on the envelope the grid was tracked against: at hop 512 a
        # frame either side of a sixteenth already reaches the next hat.
        occ = _occupancy(frames_hi, h["track"])
        return np.unique(np.round(frames_hi * _HOP_FINE / _HOP).astype(np.int64)), occ

    def level_of(
        frames: np.ndarray, name: str, ratio: int, den: Optional[int]
    ) -> dict[str, Any]:
        # Feature spans start a quarter beat early: a kick a frame either
        # side of its beat then lands in that beat's span, not the one
        # before, and the per-beat features stop depending on jitter.
        shift = max(1, int(round(_SPAN_SHIFT * float(np.median(np.diff(frames))))))
        spans = np.maximum(0, frames - shift)
        f = beat_features(y, sr, spans)
        en = _beat_energies(band_power, spans)
        t = librosa.frames_to_time(frames, sr=sr, hop_length=_HOP).astype(np.float64)
        compound = False
        if den is None:
            ph, st, _ = _beat_phases(onset_times, onset_strength, t, 0, t.size)
            compound = _subdivision(ph, st)["kind"] == "compound"
        acc = _accents(f, en)
        mat = _feature_matrix(f, en)
        # The low band on its own: the rhythm section's bar (see _pick_window).
        low_acc = _robust(en[0], 1.0)
        low_mat = en[[0, 3]]
        win, q = _meter_quality(
            acc, mat, low_acc, low_mat, compound=compound, mult=ratio
        )
        period = (
            float(np.median(np.diff(frames))) * frame_sec if frames.size > 1 else 0.0
        )
        return {
            "name": name,
            "ratio": ratio,
            "den": den,
            "frames": frames,
            "spans": spans,
            "energies": en,
            "feats": f,
            "accents": acc,
            "matrix": mat,
            "windows": win,
            "quality": q,
            "period_sec": period,
        }

    def bar_seconds(lv: dict[str, Any]) -> float:
        dom = _dominant_length(lv["windows"])
        return dom * lv["period_sec"] if dom else float("inf")

    base_bpm = _slope_bpm(
        librosa.frames_to_time(beat_frames, sr=sr, hop_length=_HOP), global_bpm
    )
    chosen = level_of(beat_frames, "tracked", 1, None)
    level_log: list[dict[str, Any]] = [
        {
            "level": "tracked",
            "grid_bpm": round(base_bpm, 2),
            "positions": int(beat_frames.size),
            "quality": round(chosen["quality"], 3),
            "dominant": _dominant_length(chosen["windows"]),
            "bar_sec": round(bar_seconds(chosen), 3),
            "accepted": True,
        }
    ]

    # The tracked beat first. Then the tatum grids — the fastest strong pulse in
    # the tempogram, and half of it when that is four to a beat — tried while
    # the reading is poor. A finer level is taken only when it reads an ODD bar
    # (an even one is the coarser bar in more positions) and either reads
    # clearly better, or reads a SHORTER bar about as well: 13/8 at the quarter
    # is a two-bar 13/4, and the bar is the shortest cycle that explains the
    # accents.
    tatum_curve, tatum_bpm = _tatum_curve(tg, sr, tempo_runs, n_frames)
    candidates: list[tuple[str, np.ndarray, float, int]] = []
    if tatum_curve is not None and tatum_bpm is not None and tatum_bpm > 1.5 * base_bpm:
        ratio = max(2, int(round(tatum_bpm / max(base_bpm, _EPS))))
        if ratio >= 4:
            candidates.append(
                ("tatum/2", tatum_curve / 2.0, tatum_bpm / 2.0, ratio // 2)
            )
        candidates.append(("tatum", tatum_curve, tatum_bpm, ratio))
    for name, curve, grid_bpm, ratio in candidates:
        if chosen["quality"] >= _LEVEL_GOOD:
            break
        grid, occ = grid_for(curve, grid_bpm)
        entry: dict[str, Any] = {
            "level": name,
            "grid_bpm": round(grid_bpm, 2),
            "positions": int(grid.size),
            "occupancy": round(occ, 3),
            "accepted": False,
        }
        level_log.append(entry)
        if grid.size < 4 * L_MIN or occ < _MIN_OCCUPANCY:
            entry["rejected"] = "too fine: empty positions"
            continue  # nothing there on half the positions: finer than the music
        finer = level_of(grid, name, ratio, _den_for_rate(grid_bpm))
        dominant = _dominant_length(finer["windows"])
        # A level that is itself a guess (under 0.15) is easy to beat; a reading
        # that replaces one has to be a reading — a shorter bar at a lower
        # quality than that is noise finding noise.
        gain = _LEVEL_RETRY_GAIN if chosen["quality"] >= 0.15 else 0.1
        better = finer["quality"] > chosen["quality"] + gain
        shorter = bar_seconds(finer) < 0.9 * bar_seconds(chosen) and finer[
            "quality"
        ] >= max(0.15, 0.6 * chosen["quality"])
        entry.update(
            quality=round(finer["quality"], 3),
            dominant=dominant,
            bar_sec=round(bar_seconds(finer), 3),
            better=bool(better),
            shorter=bool(shorter),
        )
        if dominant % 2 == 1 and (better or shorter):
            chosen = finer
            entry["accepted"] = True
    level = str(chosen["name"])
    finer_den: Optional[int] = chosen["den"]
    ratio = int(chosen["ratio"])
    beat_frames = chosen["frames"]
    accents = chosen["accents"]
    energies = chosen["energies"]
    spans = chosen["spans"]
    windows, quality = chosen["windows"], chosen["quality"]
    beats = librosa.frames_to_time(beat_frames, sr=sr, hop_length=_HOP).astype(
        np.float64
    )
    n_beats = int(beats.size)
    period = float(np.median(np.diff(beats))) if n_beats > 1 else 0.5
    beat_ends = np.append(beats[1:], beats[-1] + period)
    tracked_bpm = base_bpm

    segs = _segments(windows, n_beats, accents)
    if not segs:
        return _empty(sr, duration, "no meter")

    # --- per segment: downbeats, bars, subdivision, signature, syncopation ---
    downbeats: list[float] = []
    bars: list[dict[str, Any]] = []
    meter_map: list[dict[str, Any]] = []
    lhl_curve: list[float] = []
    swing_ratios: list[tuple[float, float]] = []
    for si, seg in enumerate(segs):
        length = seg.beats_per_bar
        grid_rate = _slope_bpm(
            beats[seg.start_beat : seg.end_beat], tracked_bpm * ratio
        )
        # The musical tempo: a grid of sixteenths at 480 is 120 to the quarter.
        seg_bpm = grid_rate * 4.0 / finer_den if finer_den else grid_rate
        phases, strengths, bidx = _beat_phases(
            onset_times, onset_strength, beats, seg.start_beat, seg.end_beat
        )
        if finer_den is not None:
            # At eighths or sixteenths the positions are the smallest unit:
            # no subdivision to read, no swing to measure, the grid is 1:1.
            sub = {"kind": "simple", "confidence": 0.0, "sixteenths": False}
            q = 1
        else:
            sub = _subdivision(phases, strengths)
            q = 3 if sub["kind"] == "compound" else (4 if sub["sixteenths"] else 2)
            if sub["kind"] == "simple":
                sw, sw_conf = _swing(phases, bidx)
                if sw is not None:
                    swing_ratios.append((sw, sw_conf))
        sig = _time_signature(length, seg.grouping, sub["kind"], seg_bpm, finer_den)
        weights = _metrical_weights(seg.grouping, q)
        first_db = seg.start_beat + ((seg.phase - seg.start_beat) % length)
        db_idx = list(range(first_db, seg.end_beat, length))
        downbeats.extend(float(beats[i]) for i in db_idx)
        first_bar_index = len(bars)
        for j, b0 in enumerate(db_idx):
            b1 = min(db_idx[j + 1] if j + 1 < len(db_idx) else seg.end_beat, n_beats)
            t0 = float(beats[b0])
            t1 = float(beat_ends[b1 - 1]) if b1 - 1 < n_beats else t0 + period * length

            def grid(times: np.ndarray, strength: np.ndarray):
                in_bar = (times >= t0) & (times < t1)
                o = times[in_bar]
                st = strength[in_bar]
                if not o.size:
                    return np.zeros(0, dtype=int), np.zeros(0)
                bi = np.clip(np.searchsorted(beats, o, side="right") - 1, b0, b1 - 1)
                frac = (o - beats[bi]) / np.maximum(beat_ends[bi] - beats[bi], _EPS)
                pos = (bi - b0) * q + np.round(frac * q).astype(int)
                return np.clip(pos, 0, weights.size - 1), st / (st.max() + _EPS)

            broad_sync = _bar_syncopation(
                *grid(onset_times, onset_strength), weights, q
            )
            low_sync = _bar_syncopation(*grid(low_times, low_strength), weights, q)
            sync = {
                "lhl": low_sync["lhl"],
                "wnbd": broad_sync["wnbd"],
                "offbeat_ratio": broad_sync["offbeat_ratio"],
                "onsets": broad_sync["onsets"],
                "low_onsets": low_sync["onsets"],
            }
            lhl_curve.append(sync["lhl"])
            bars.append(
                {
                    "index": len(bars),
                    "segment": si,
                    "start_sec": round(t0, 4),
                    "end_sec": round(t1, 4),
                    "beats": int(b1 - b0),
                    "time_signature": sig["label"],
                    "syncopation": {
                        k: (round(v, 4) if isinstance(v, float) else v)
                        for k, v in sync.items()
                    },
                }
            )
        meter_map.append(
            {
                "segment": si,
                "start_sec": round(float(beats[seg.start_beat]), 4),
                "end_sec": round(float(beat_ends[min(seg.end_beat, n_beats) - 1]), 4),
                "start_beat": seg.start_beat,
                "end_beat": seg.end_beat,
                "start_bar": first_bar_index,
                "bars": len(db_idx),
                "beats_per_bar": length,
                "grouping": list(seg.grouping),
                "time_signature": sig["label"],
                "numerator": sig["numerator"],
                "denominator": sig["denominator"],
                "beat_unit": sig["beat_unit"],
                "level": level,
                "subdivision": sub["kind"],
                "subdivision_confidence": round(sub["confidence"], 3),
                "sixteenths": sub["sixteenths"],
                "bpm": round(seg_bpm, 2),
                "confidence": round(seg.confidence, 3),
                "uncertain": bool(seg.confidence < _UNCERTAIN_CONF),
            }
        )

    # --- polymeter: per band (and per stem, when given) ----------------------
    layers: dict[str, np.ndarray] = {
        "low": energies[0],
        "mid": energies[1],
        "high": energies[2],
    }
    if stems:
        for name, stem in stems.items():
            stem = np.asarray(stem, dtype=np.float32)
            if stem.ndim == 2:
                stem = stem.mean(axis=1)
            if stem.size < y.size // 2:
                continue
            _, stem_power = _onset_envelopes(stem[: y.size], sr)
            sf = beat_features(stem[: y.size], sr, spans)
            layers[f"stem:{name}"] = _accents(sf, _beat_energies(stem_power, spans))
    den_base = finer_den or _base_den(base_bpm)
    # The finer grid first: a layer whose bar is not a whole number of the
    # segment's beats (7/8 against 5/4: 3.5 quarters) becomes one there (7
    # against 10 eighths). The tatum grid when there is one, else twice the
    # beat. Energies only — no beat_features — so it costs one DP pass.
    finer_entries: list[dict[str, Any]] = []
    fine_curve: Optional[np.ndarray] = None
    fine_ratio = 2
    if tatum_curve is not None and tatum_bpm is not None and level != "tatum":
        chosen_rate = base_bpm * ratio
        fine_ratio = max(2, int(round(tatum_bpm / max(chosen_rate, _EPS))))
        fine_curve = tatum_curve
    elif level == "tracked":
        fine_curve = bpm_curve * 2.0
    if fine_curve is not None:
        fine, fine_occ = grid_for(fine_curve, float(np.median(fine_curve)))
        # A tatum grid with empty positions is finer than the music: halve it
        # (sixteenths found where the hats play eighths).
        while fine.size >= 4 * L_MIN and fine_occ < _MIN_OCCUPANCY and fine_ratio >= 4:
            fine_ratio //= 2
            fine_curve = fine_curve / 2.0
            fine, fine_occ = grid_for(fine_curve, float(np.median(fine_curve)))
        if fine.size >= 4 * L_MIN and fine_occ >= _MIN_OCCUPANCY:
            fine_shift = max(
                1, int(round(_SPAN_SHIFT * float(np.median(np.diff(fine)))))
            )
            fine_en = _beat_energies(band_power, np.maximum(0, fine - fine_shift))
            fine_layers = {"low": fine_en[0], "mid": fine_en[1], "high": fine_en[2]}
            fine_times = librosa.frames_to_time(fine, sr=sr, hop_length=_HOP)
            seg_times = [(m["start_sec"], m["end_sec"]) for m in meter_map]
            finer_entries = _polymeter_finer(
                fine_layers,
                fine_times,
                segs,
                seg_times,
                ratio=fine_ratio,
                den_seg=den_base,
            )
    covered = {(e["segment"], e["layer"]) for e in finer_entries}
    polymeter = finer_entries + [
        e
        for e in _polymeter(layers, segs, den=den_base, l_max=_l_max_for(ratio))
        if (e["segment"], e["layer"]) not in covered
    ]
    cross: list[dict[str, Any]] = []
    for si, seg in enumerate(segs):
        if seg.confidence < _SEGMENT_MIN_CONF:
            continue
        f0 = int(beat_frames[seg.start_beat])
        f1 = int(beat_frames[min(seg.end_beat, n_beats) - 1])
        for c in _cross_rhythms(tg, sr, (f0, f1), meter_map[si]["bpm"]):
            cross.append({"segment": si, **c})

    # --- tempo report --------------------------------------------------------
    times = librosa.frames_to_time(np.arange(n_frames), sr=sr, hop_length=_HOP)
    step = max(1, int(round(1.0 / frame_sec)))
    curve = [
        [round(float(times[i]), 3), round(float(smooth[i]), 2)]
        for i in range(0, n_frames, step)
    ]
    tempo_segments = [
        {
            "start_sec": round(float(times[a]), 3),
            "end_sec": round(float(times[min(b, n_frames) - 1]), 3),
            "bpm": round(bpm, 2),
        }
        for a, b, bpm in tempo_runs
    ]
    bpm_min, bpm_max = float(smooth.min()), float(smooth.max())

    lhl_arr = np.asarray(lhl_curve, dtype=np.float64)
    peak_bars = (
        [int(i) for i in np.argsort(-lhl_arr)[:4] if lhl_arr[i] > 0]
        if lhl_arr.size
        else []
    )
    swing = None
    swing_conf = 0.0
    if swing_ratios:
        swing = float(np.median([r for r, _ in swing_ratios]))
        swing_conf = float(max(c for _, c in swing_ratios))

    result: dict[str, Any] = {
        "version": RHYTHM_VERSION,
        "sr": int(sr),
        "duration_sec": round(duration, 3),
        "tempo": {
            "bpm": round(tracked_bpm, 2),
            "global_bpm": round(global_bpm, 2),
            "range_bpm": [round(bpm_min, 2), round(bpm_max, 2)],
            "stable": bool(
                len(tempo_runs) == 1 and (bpm_max - bpm_min) / max(bpm_min, _EPS) < 0.05
            ),
            "segments": tempo_segments,
            "curve": curve,
            "level": level,
            "tatum_bpm": round(tatum_bpm, 2) if tatum_bpm else None,
        },
        "beats": [round(float(t), 4) for t in beats],
        "downbeats": [round(t, 4) for t in downbeats],
        "meter_map": meter_map,
        "bars": bars,
        "syncopation": {
            "mean_lhl": round(float(lhl_arr.mean()), 4) if lhl_arr.size else 0.0,
            "max_lhl": round(float(lhl_arr.max()), 4) if lhl_arr.size else 0.0,
            "mean_offbeat_ratio": (
                round(
                    float(np.mean([b["syncopation"]["offbeat_ratio"] for b in bars])),
                    4,
                )
                if bars
                else 0.0
            ),
            "peak_bars": peak_bars,
            "curve": [round(v, 4) for v in lhl_curve],
            "swing_ratio": round(swing, 3) if swing is not None else None,
            "swing_confidence": round(swing_conf, 3),
        },
        "polymeter": polymeter,
        "cross_rhythms": cross,
        "diagnostics": {
            "n_beats": n_beats,
            "n_onsets": int(onset_times.size),
            "meter_window_beats": METER_WINDOW_BEATS,
            "meter_quality": round(quality, 3),
            "windows": len(windows),
            "levels": level_log,
        },
    }
    result["summary"] = summarize(result)
    return result


def _empty(sr: int, duration: float, reason: str) -> dict[str, Any]:
    return {
        "version": RHYTHM_VERSION,
        "sr": int(sr),
        "duration_sec": round(duration, 3),
        "tempo": {
            "bpm": None,
            "global_bpm": None,
            "range_bpm": None,
            "stable": False,
            "segments": [],
            "curve": [],
            "level": "none",
        },
        "beats": [],
        "downbeats": [],
        "meter_map": [],
        "bars": [],
        "syncopation": {
            "mean_lhl": 0.0,
            "max_lhl": 0.0,
            "mean_offbeat_ratio": 0.0,
            "peak_bars": [],
            "curve": [],
            "swing_ratio": None,
            "swing_confidence": 0.0,
        },
        "polymeter": [],
        "cross_rhythms": [],
        "diagnostics": {"reason": reason},
        "summary": f"No rhythm analysis: {reason}.",
    }


def summarize(r: dict[str, Any]) -> str:
    """One paragraph a person (or the assistant) can read."""
    mm = r.get("meter_map") or []
    if not mm:
        return "No meter could be read."
    parts = []
    for seg in mm:
        span = f"{seg['start_sec']:.1f}-{seg['end_sec']:.1f}s"
        mark = "?" if seg.get("uncertain") else ""
        parts.append(
            f"{mark}{seg['time_signature']} at {seg['bpm']:.0f} bpm "
            f"({seg['bars']} bars, {span}, conf {seg['confidence']:.2f})"
        )
    text = "Meter: " + " -> ".join(parts) + "."
    if any(seg.get("uncertain") for seg in mm):
        text += " (? = a guess: the accents there fit no bar length well.)"
    t = r.get("tempo") or {}
    if t.get("segments") and len(t["segments"]) > 1:
        text += " Tempo changes: " + ", ".join(
            f"{s['bpm']:.0f} from {s['start_sec']:.1f}s" for s in t["segments"]
        )
        text += "."
    s = r.get("syncopation") or {}
    if s.get("mean_lhl") is not None:
        text += f" Syncopation (LHL) mean {s['mean_lhl']:.2f}, max {s['max_lhl']:.2f}"
        if s.get("peak_bars"):
            text += " at bars " + ", ".join(str(b) for b in s["peak_bars"])
        text += "."
    if s.get("swing_ratio"):
        text += f" Swing ratio {s['swing_ratio']:.2f}."
    poly = sorted(r.get("polymeter") or [], key=lambda p: -p["confidence"])[:3]
    if poly:
        text += " Polymeter: " + "; ".join(
            f"{p['layer']} keeps {p.get('label') or str(p['beats_per_bar']) + ' (' + p['relation'] + ')'}"
            for p in poly
        )
        text += "."
    cross = sorted(r.get("cross_rhythms") or [], key=lambda c: -c["strength"])[:3]
    if cross:
        text += " Cross-rhythms: " + ", ".join(
            f"{c['ratio']} ({c['strength']:.2f})" for c in cross
        )
        text += "."
    return text


def analyze_file(
    path: str | Path, *, stems: Optional[dict[str, str | Path]] = None
) -> dict[str, Any]:
    """Decode ``path`` (any format librosa/soundfile reads, Opus included) to
    mono 22.05 kHz and analyze it. ``stems`` maps layer names to files."""
    import librosa

    y, sr = librosa.load(str(path), sr=SR, mono=True)
    stem_arrays: Optional[dict[str, np.ndarray]] = None
    if stems:
        stem_arrays = {}
        for name, p in stems.items():
            try:
                s, _ = librosa.load(str(p), sr=SR, mono=True)
                stem_arrays[str(name)] = s
            except Exception as e:  # noqa: BLE001 — one bad stem must not sink the run
                log.info("rhythm: stem %s unreadable (%s)", name, e)
    return analyze_rhythm(y, int(sr), stems=stem_arrays)
