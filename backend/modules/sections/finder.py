"""Find a song's sections on its own bar grid.

Input: a mono signal, the bar grid (each bar's start and end in seconds) and,
when the entry has them, its stems. Output: sections that start on bar lines,
each with a repeat letter (A, B, A'), a role (intro, verse, chorus, drop,
break, bridge, outro), a name, and the confidence of the boundary it starts on.

How:

  1. per-bar features from one STFT of the mix: chroma (harmony), MFCC 1-12
     (timbre), loudness, spectral flux (onset density), and the activity of
     each stem (or, with no stems, of the percussive, low and harmonic parts
     of an HPSS split). Every feature is in absolute units, so a drone that
     never changes has distances near zero and finds no boundary
  2. a bar-by-bar affinity matrix (self-similarity) over two-bar context
  3. boundary novelty from three readings: the Foote contrast of the affinity
     matrix at 2-, 4- and 8-bar scales (change), the structure-feature
     novelty of the time-lag recurrence matrix (where a repetition starts or
     stops), and the change in which stems play
  4. peaks of that novelty above a local threshold, at least two bars apart,
     are the boundaries; each is a bar index, so it is on a bar line
  5. sections are compared bar against bar (the diagonal of the affinity
     matrix) and by their mean features; a close match takes the earlier
     section's letter, a looser one takes it with a prime (A')
  6. roles come from energy (loudness and how many stems play), repetition,
     position and the drum and vocal stems

numpy + librosa only. No model, no network.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass
from typing import Any, Optional, Sequence

import numpy as np

log = logging.getLogger(__name__)

SECTIONS_VERSION = 1
SR = 22050
HOP = 512
N_FFT = 2048

#: Roles a section can take, in the order the UI offers them.
ROLES: tuple[str, ...] = (
    "intro",
    "verse",
    "chorus",
    "drop",
    "break",
    "bridge",
    "outro",
)
ROLE_TITLES = {r: r.capitalize() for r in ROLES}

MIN_SECTION_BARS = 2
# The finder's reach in seconds (Scale turns it into bars): the shortest
# section, the Foote kernel half-widths, the local threshold's window and the
# span the stem change compares.
_MIN_SECTION_SEC = 4.0
_SCALE_SEC = (4.3, 8.5, 17.0)
_WINDOW_SEC = 17.0
_STEM_SPAN_SEC = 4.3
_CELL_SEC = 2.0  # the features are read over spans of about this length
_CHROMA_MIN_HZ = 90.0  # keeps kick and sub fundamentals out of the chroma
_LOW_HZ = 250.0
_MFCC_SCALE = 20.0  # an MFCC change of 20 counts as one unit
_DB_SCALE = 6.0  # a loudness change of 6 dB counts as one unit
_SIGMA_FLOOR = 0.35  # distances below this read as the same bar
_ACTIVE_SPAN_DB = 18.0  # a stem this far under its loud level reads half on
_ABSENT_BELOW_MIX_DB = 36.0  # a stem this far under the mix is bleed, not a part
_NOVELTY_FLOOR = 0.06  # a boundary must contrast at least this much
_SAME_LETTER = 0.55  # section similarity for the same letter
_EXACT_REPEAT = 0.9  # ... and for a repeat with no prime
_EPS = 1e-9

_DRUM_NAMES = ("drum", "kick", "snare", "hat", "perc", "cymbal", "tom")
_VOCAL_NAMES = ("vocal", "voice", "vox")


@dataclass
class BarFeatures:
    """Per-bar tables for ``n`` bars."""

    chroma: np.ndarray  # [n, 12], each bar's max is 1 (0 for silence)
    timbre: np.ndarray  # [n, 12] MFCC 1..12
    loud_db: np.ndarray  # [n]
    flux: np.ndarray  # [n] mean onset strength
    activity: np.ndarray  # [n, k] 0..1 per stem (or HPSS part)
    stem_names: list[str]
    stems_are_parts: bool  # True when the activity columns are HPSS parts


# ---- grid ---------------------------------------------------------------------


def time_grid(duration: float, bar_sec: float = 2.0) -> list[tuple[float, float]]:
    """Fixed windows when no beat grid can be read: a drone, a spoken piece,
    a file too short to track."""
    if duration <= 0:
        return []
    n = max(1, int(round(duration / bar_sec)))
    step = duration / n
    return [(i * step, (i + 1) * step) for i in range(n)]


def bars_from_beats(
    beats: Sequence[float], beats_per_bar: int = 4, phase: int = 0
) -> list[tuple[float, float]]:
    """Group beat times into bars from ``phase``; the last bar ends one beat
    after the last full group."""
    b = sorted(float(t) for t in beats)
    if len(b) < beats_per_bar + 1:
        return []
    step = float(np.median(np.diff(b))) if len(b) > 1 else 0.5
    grid = b + [b[-1] + step]
    out: list[tuple[float, float]] = []
    for i in range(phase, len(grid) - beats_per_bar, beats_per_bar):
        out.append((grid[i], grid[i + beats_per_bar]))
    return out


def complete_grid(
    bars: Sequence[tuple[float, float]], duration: float
) -> list[tuple[float, float]]:
    """``bars`` sorted, with every gap longer than half a bar filled by bars
    of the gap's length divided evenly (a rhythm analysis leaves out the
    stretches it could not read), and the tail after the last bar filled the
    same way when it holds a bar or more."""
    b = sorted((float(a), float(c)) for a, c in bars if c > a)
    if not b:
        return []
    med = float(np.median([c - a for a, c in b]))
    out: list[tuple[float, float]] = []
    for a, c in b:
        if out and a - out[-1][1] > 0.5 * med:
            g0 = out[-1][1]
            n = max(1, int(round((a - g0) / med)))
            step = (a - g0) / n
            out.extend((g0 + i * step, g0 + (i + 1) * step) for i in range(n))
        if out and a < out[-1][1]:
            a = out[-1][1]
            if c - a < 0.25 * med:
                continue
        out.append((a, c))
    tail = duration - out[-1][1]
    if tail >= med:
        g0 = out[-1][1]
        n = int(tail // med)
        out.extend((g0 + i * med, g0 + (i + 1) * med) for i in range(n))
    return out


# ---- features -------------------------------------------------------------------


def _frame_spans(bars: Sequence[tuple[float, float]], n_frames: int) -> np.ndarray:
    """``[n, 2]`` frame index spans, each at least one frame."""
    out = np.zeros((len(bars), 2), dtype=np.int64)
    for i, (t0, t1) in enumerate(bars):
        a = int(math.floor(t0 * SR / HOP))
        b = int(math.ceil(t1 * SR / HOP))
        a = max(0, min(n_frames - 1, a))
        b = max(a + 1, min(n_frames, b))
        out[i] = (a, b)
    return out


def _bar_mean(x: np.ndarray, spans: np.ndarray) -> np.ndarray:
    """Mean of ``x`` (``[T]`` or ``[d, T]``) over each span."""
    if x.ndim == 1:
        c = np.concatenate([[0.0], np.cumsum(x, dtype=np.float64)])
        return (c[spans[:, 1]] - c[spans[:, 0]]) / (spans[:, 1] - spans[:, 0])
    c = np.concatenate(
        [np.zeros((x.shape[0], 1)), np.cumsum(x, axis=1, dtype=np.float64)], axis=1
    )
    return ((c[:, spans[:, 1]] - c[:, spans[:, 0]]) / (spans[:, 1] - spans[:, 0])).T


def _bar_peak_db(p: np.ndarray, spans: np.ndarray) -> np.ndarray:
    """Each span's level as the 90th percentile of its frame power, in dB: a
    drum stem is loud on its hits and near silent between them, and its mean
    power would read it far under a pad of the same loudness."""
    out = np.empty(len(spans))
    for i, (a, b) in enumerate(spans):
        out[i] = float(np.percentile(p[a:b], 90)) if b > a else 0.0
    return _power_db(out)


def _power_db(p: np.ndarray) -> np.ndarray:
    return 10.0 * np.log10(np.maximum(p, 1e-12))


def _activity(bar_db: np.ndarray, mix_ref_db: float) -> np.ndarray:
    """0..1 per bar: 1 near the part's own loud level, 0 far under it, and 0
    everywhere for a part that is only bleed under the mix."""
    ref = float(np.percentile(bar_db, 95)) if bar_db.size else -120.0
    act = np.clip((bar_db - (ref - 2 * _ACTIVE_SPAN_DB + 6.0)) / _ACTIVE_SPAN_DB, 0, 1)
    present = np.clip((ref - (mix_ref_db - _ABSENT_BELOW_MIX_DB)) / 12.0, 0.0, 1.0)
    act = act * present
    act[bar_db < -70.0] = 0.0
    return act


def bar_features(
    y: np.ndarray,
    bars: Sequence[tuple[float, float]],
    stems: Optional[dict[str, np.ndarray]] = None,
) -> BarFeatures:
    """Per-bar features of ``y`` (mono, ``SR``) and its stems."""
    import librosa

    y = np.asarray(y, dtype=np.float32)
    if y.size < N_FFT:
        y = np.pad(y, (0, N_FFT - y.size))
    S = np.abs(librosa.stft(y, n_fft=N_FFT, hop_length=HOP))
    power = S**2
    n_frames = int(S.shape[1])
    spans = _frame_spans(bars, n_frames)
    freqs = librosa.fft_frequencies(sr=SR, n_fft=N_FFT)

    frame_power = power.mean(axis=0)
    loud_db = _power_db(_bar_mean(frame_power, spans))
    mix_ref = float(np.percentile(loud_db, 95)) if loud_db.size else -120.0
    peak_db = _bar_peak_db(frame_power, spans)
    mix_peak_ref = float(np.percentile(peak_db, 95)) if peak_db.size else -120.0

    chroma_power = power.copy()
    chroma_power[freqs < _CHROMA_MIN_HZ] = 0.0
    chroma = librosa.feature.chroma_stft(S=chroma_power, sr=SR, norm=None)
    bar_chroma = _bar_mean(chroma, spans)
    peak = bar_chroma.max(axis=1, keepdims=True)
    # A silent bar has no harmony: its chroma is all zero, not noise scaled up.
    audible = (loud_db > mix_ref - 50.0)[:, None]
    bar_chroma = np.where(
        audible & (peak > _EPS), bar_chroma / np.maximum(peak, _EPS), 0.0
    )

    mel = librosa.feature.melspectrogram(S=power, sr=SR, n_mels=64)
    mel_db = librosa.power_to_db(mel, ref=1.0, top_db=None)
    mfcc = librosa.feature.mfcc(S=mel_db, n_mfcc=13)[1:]
    timbre = _bar_mean(mfcc, spans)
    env = librosa.onset.onset_strength(S=np.maximum(mel_db, -100.0), sr=SR)
    flux = _bar_mean(np.asarray(env, dtype=np.float64)[:n_frames], spans)

    names: list[str] = []
    cols: list[np.ndarray] = []
    parts = False
    if stems:
        for name, s in stems.items():
            s = np.asarray(s, dtype=np.float32)
            if s.size == 0:
                continue
            rms = librosa.feature.rms(y=s, frame_length=N_FFT, hop_length=HOP)[0]
            if rms.size < n_frames:
                rms = np.pad(rms, (0, n_frames - rms.size))
            # rms^2 is the mean square; the mix's frame power is the mean
            # |X|^2 over bins, which is N_FFT / 2 times larger for one signal.
            level = rms[:n_frames] ** 2 * (N_FFT / 2)
            names.append(name)
            cols.append(_activity(_bar_peak_db(level, spans), mix_peak_ref))
    if not cols:
        parts = True
        # HPSS on every other frame and bin: four times cheaper, and a bar's
        # activity does not need the full resolution.
        small = S[::2, ::2]
        f_small = freqs[::2]
        H, P = librosa.decompose.hpss(small, kernel_size=(15, 17))
        hp = H**2
        half = np.maximum(spans // 2, 0)
        half[:, 1] = np.maximum(half[:, 0] + 1, np.minimum(half[:, 1], small.shape[1]))
        half[:, 0] = np.minimum(half[:, 0], small.shape[1] - 1)
        low = f_small < _LOW_HZ
        for name, p in (
            ("percussive", (P**2).mean(axis=0)),
            ("low", hp[low].sum(axis=0) / f_small.size),
            ("harmonic", hp[~low].sum(axis=0) / f_small.size),
        ):
            names.append(name)
            cols.append(_activity(_bar_peak_db(p, half), mix_peak_ref))
    activity = np.stack(cols, axis=1) if cols else np.zeros((len(bars), 0))
    return BarFeatures(
        chroma=bar_chroma,
        timbre=timbre,
        loud_db=loud_db,
        flux=flux,
        activity=activity,
        stem_names=names,
        stems_are_parts=parts,
    )


def feature_matrix(f: BarFeatures) -> np.ndarray:
    """``[n, d]`` in absolute units: one unit is a clear change of that kind."""
    flux = np.log2(np.maximum(f.flux, _EPS) / max(float(np.median(f.flux)), _EPS)) / 2.0
    # Silence has no flux worth reading.
    flux = np.clip(flux, -2.0, 2.0)
    loud = np.clip(f.loud_db, float(np.max(f.loud_db)) - 60.0, None) / _DB_SCALE
    stem_w = 1.2 if not f.stems_are_parts else 0.9
    return np.concatenate(
        [
            f.chroma * 0.8,
            f.timbre / _MFCC_SCALE,
            (loud - loud.mean())[:, None] * 0.7,
            flux[:, None] * 0.5,
            f.activity * stem_w,
        ],
        axis=1,
    )


def _embed(x: np.ndarray, context: int = 2) -> np.ndarray:
    """Each bar with the ``context - 1`` bars after it (the last bars repeat)."""
    n = x.shape[0]
    idx = np.minimum(np.arange(n)[:, None] + np.arange(context)[None, :], n - 1)
    return x[idx].reshape(n, -1) / math.sqrt(context)


def _distances(x: np.ndarray) -> np.ndarray:
    sq = (x**2).sum(axis=1)
    d2 = np.maximum(sq[:, None] + sq[None, :] - 2.0 * x @ x.T, 0.0)
    return np.sqrt(d2)


def affinity(x: np.ndarray) -> tuple[np.ndarray, float]:
    """Affinity ``exp(-d^2 / 2 sigma^2)`` with sigma from neighbouring bars
    (mostly bars of one section), floored so a static piece reads as one."""
    d = _distances(x)
    n = x.shape[0]
    adj = np.diag(d, 1) if n > 1 else np.zeros(1)
    sigma = max(1.5 * float(np.median(adj)) if adj.size else 0.0, _SIGMA_FLOOR)
    return np.exp(-(d**2) / (2 * sigma**2)), sigma


# ---- novelty --------------------------------------------------------------------


@dataclass(frozen=True)
class Scale:
    """The finder's reach in bars, set from the bar length so a grid read at
    two beats a bar looks as far, in seconds, as one read at four."""

    min_bars: int  # the shortest section
    halves: tuple[int, ...]  # Foote kernel half-widths
    window: int  # half-width of the local threshold's window
    stem_span: int  # bars either side the stem change compares

    @staticmethod
    def of(bar_sec: float) -> "Scale":
        b = max(0.25, float(bar_sec))

        def bars(sec: float) -> int:
            return max(1, int(round(sec / b)))

        min_bars = max(MIN_SECTION_BARS, bars(_MIN_SECTION_SEC))
        halves = tuple(sorted({max(2, bars(s)) for s in _SCALE_SEC}))
        return Scale(
            min_bars, halves, max(4, bars(_WINDOW_SEC)), max(2, bars(_STEM_SPAN_SEC))
        )


DEFAULT_SCALE = Scale(MIN_SECTION_BARS, (2, 4, 8), 8, 2)


def foote_novelty(
    a: np.ndarray, half: int, min_bars: int = MIN_SECTION_BARS
) -> np.ndarray:
    """Contrast at each bar line ``i`` (the boundary before bar ``i``): the
    mean affinity inside the ``half`` bars either side, off the diagonal,
    less the mean across."""
    n = a.shape[0]
    nov = np.zeros(n)

    def inside(block: np.ndarray) -> float:
        k = block.shape[0]
        if k < 2:
            return 1.0
        return float((block.sum() - np.trace(block)) / (k * k - k))

    for i in range(min_bars, n - min_bars + 1):
        lo, hi = max(0, i - half), min(n, i + half)
        within = 0.5 * (inside(a[lo:i, lo:i]) + inside(a[i:hi, i:hi]))
        cross = float(a[lo:i, i:hi].mean())
        nov[i] = max(0.0, within - cross)
    return nov


def structure_novelty(x: np.ndarray, a: np.ndarray, smooth: float = 1.0) -> np.ndarray:
    """Serra's structure features: where the pattern of repetitions changes.
    Rows of the time-lag recurrence matrix, smoothed over time; the novelty
    at ``i`` is how far row ``i`` is from row ``i - 1``. 0..1."""
    from scipy.ndimage import gaussian_filter1d

    n = x.shape[0]
    if n < 6:
        return np.zeros(n)
    d = _distances(x)
    k = max(2, int(round(0.1 * n)))
    near = np.zeros((n, n), dtype=bool)
    for i in range(n):
        order = [j for j in np.argsort(d[i]) if abs(j - i) > 1][:k]
        near[i, order] = True
    rec = np.where(near & near.T, a, 0.0)
    lag = np.zeros((n, n))
    for i in range(n):
        lag[i] = np.roll(rec[i], -i)
    lag = gaussian_filter1d(lag, sigma=smooth, axis=0, mode="nearest")
    nov = np.zeros(n)
    nov[1:] = np.sqrt(((lag[1:] - lag[:-1]) ** 2).sum(axis=1))
    top = float(nov.max())
    return nov / top if top > _EPS else nov


def stem_novelty(act: np.ndarray, span: int = 2) -> np.ndarray:
    """How much the set of playing stems changes at each bar line: the mean
    absolute change of the ``span`` bars either side. 0..1."""
    n = act.shape[0]
    nov = np.zeros(n)
    if act.shape[1] == 0:
        return nov
    for i in range(1, n):
        left = act[max(0, i - span) : i].mean(axis=0)
        right = act[i : min(n, i + span)].mean(axis=0)
        nov[i] = float(np.abs(right - left).mean())
    return nov


def boundary_novelty(
    a: np.ndarray,
    xe: np.ndarray,
    ae: np.ndarray,
    act: np.ndarray,
    scale: Scale = DEFAULT_SCALE,
) -> np.ndarray:
    """The combined novelty, in affinity-contrast units. The Foote contrast
    reads the plain bar affinity ``a`` (a two-bar context would move every
    change a bar early); the repetition reading takes the two-bar context
    ``xe`` / ``ae``, where a repeated progression is a repeated path."""
    n = a.shape[0]
    m = scale.min_bars
    curves = [foote_novelty(a, h, m) for h in scale.halves if n >= 2 * m]
    foote = np.mean(curves, axis=0) if curves else np.zeros(n)
    top = float(foote.max())
    sf = structure_novelty(xe, ae, smooth=max(1.0, m / 2))
    nov = foote + 0.35 * top * sf + 0.5 * stem_novelty(act, scale.stem_span)
    nov[:m] = 0.0
    if n > m:
        nov[n - m + 1 :] = 0.0
    return nov


def pick_boundaries(
    nov: np.ndarray, scale: Scale = DEFAULT_SCALE
) -> list[tuple[int, float]]:
    """Local maxima above a local threshold, strongest first, at least
    ``scale.min_bars`` apart. Returns ``(bar, strength)`` in bar order."""
    n = nov.size
    m = scale.min_bars
    if n < 2 * m:
        return []
    cands: list[tuple[int, float]] = []
    for i in range(m, n - m + 1):
        v = float(nov[i])
        if v < _NOVELTY_FLOOR:
            continue
        if v < float(nov[max(0, i - 1) : min(n, i + 2)].max()):
            continue
        win = nov[max(0, i - scale.window) : min(n, i + scale.window + 1)]
        if v < float(np.median(win)) + 0.5 * float(np.std(win)):
            continue
        cands.append((i, v))
    cands.sort(key=lambda t: t[1], reverse=True)
    taken: list[tuple[int, float]] = []
    for i, v in cands:
        if all(abs(i - j) >= m for j, _ in taken):
            taken.append((i, v))
    taken.sort()
    return taken


def boundary_confidence(strength: float, strongest: float) -> float:
    """0..1: the boundary against the song's strongest, and against a clear
    absolute contrast (0.25), whichever says less."""
    rel = strength / max(strongest, _EPS)
    absolute = strength / 0.25
    return round(float(min(1.0, rel, absolute) ** 0.5), 3)


# ---- letters --------------------------------------------------------------------


def section_similarity(
    a: np.ndarray, x: np.ndarray, sigma: float, s1: tuple[int, int], s2: tuple[int, int]
) -> float:
    """0..1: the best bar-by-bar alignment of the shorter section inside the
    longer, averaged with the affinity of their mean features."""
    (a0, a1), (b0, b1) = s1, s2
    la, lb = a1 - a0, b1 - b0
    if la > lb:
        (a0, a1), (b0, b1), la, lb = (b0, b1), (a0, a1), lb, la
    best = 0.0
    for off in range(0, lb - la + 1):
        k = np.arange(la)
        best = max(best, float(a[a0 + k, b0 + off + k].mean()))
    ma, mb = x[a0:a1].mean(axis=0), x[b0:b1].mean(axis=0)
    mean_aff = math.exp(-float(((ma - mb) ** 2).sum()) / (2 * sigma**2))
    # A much shorter section matching part of a longer one is a looser match.
    fit = la / lb
    return (0.5 * best + 0.5 * mean_aff) * (0.75 + 0.25 * fit)


def letter_name(i: int) -> str:
    s = ""
    i += 1
    while i > 0:
        i, r = divmod(i - 1, 26)
        s = chr(65 + r) + s
    return s


def letter_thresholds(sim: np.ndarray) -> tuple[float, float]:
    """``(same letter, exact repeat)`` for this song. A song whose sections
    all sound alike (one mix, one kit, one key) raises the bar to its own
    upper range, so only its closest pairs share a letter."""
    n = sim.shape[0]
    same = _SAME_LETTER
    if n >= 8:
        off = sim[~np.eye(n, dtype=bool)]
        same = max(same, float(np.percentile(off, 75)))
    return same, max(_EXACT_REPEAT, min(0.95, same + 0.1))


def assign_letters(
    spans: list[tuple[int, int]], a: np.ndarray, x: np.ndarray, sigma: float
) -> tuple[list[str], list[int], list[float], list[float]]:
    """Letters in time order: ``(letters, group index, similarity to the
    group's first section, contrast)``, where contrast is one less the
    section's best match anywhere in the song. A new group takes the next letter; a repeat
    whose match is loose, or whose length differs by more than a quarter, is
    primed (A')."""
    n = len(spans)
    sim = np.eye(n)
    for i in range(n):
        for j in range(i + 1, n):
            sim[i, j] = sim[j, i] = section_similarity(a, x, sigma, spans[i], spans[j])
    same, exact = letter_thresholds(sim)
    firsts: list[int] = []  # section index of each group's first member
    letters: list[str] = []
    groups: list[int] = []
    sims: list[float] = []
    for j, span in enumerate(spans):
        best_g, best_s = -1, 0.0
        for g, first in enumerate(firsts):
            if sim[first, j] > best_s:
                best_g, best_s = g, float(sim[first, j])
        if best_g >= 0 and best_s >= same:
            first = spans[firsts[best_g]]
            la, lb = first[1] - first[0], span[1] - span[0]
            varied = best_s < exact or abs(la - lb) > max(1, 0.25 * max(la, lb))
            base = letter_name(best_g)
            letters.append(base + "'" if varied else base)
            groups.append(best_g)
            sims.append(round(best_s, 3))
        else:
            firsts.append(j)
            letters.append(letter_name(len(firsts) - 1))
            groups.append(len(firsts) - 1)
            sims.append(1.0)
    others = sim - np.eye(n) * 2.0
    contrast = [
        round(1.0 - float(others[j].max()), 3) if n > 1 else 1.0 for j in range(n)
    ]
    return letters, groups, sims, contrast


# ---- roles ----------------------------------------------------------------------


def _column(f: BarFeatures, needles: Sequence[str]) -> Optional[np.ndarray]:
    idx = [
        i for i, n in enumerate(f.stem_names) if any(k in n.lower() for k in needles)
    ]
    if f.stems_are_parts and needles is _DRUM_NAMES:
        idx = [i for i, n in enumerate(f.stem_names) if n == "percussive"]
    if not idx:
        return None
    return f.activity[:, idx].max(axis=1)


def assign_roles(
    spans: list[tuple[int, int]],
    groups: list[int],
    f: BarFeatures,
    contrast: Optional[Sequence[float]] = None,
) -> tuple[list[str], list[float]]:
    """A role per section, and each section's energy (0..1). ``contrast`` is
    how unlike every other section each one is (1 - its best match)."""
    n = len(spans)
    loud = f.loud_db
    # Loudness against the song's loud level: 12 dB under it reads 0, so two
    # loud sections a few dB apart stay apart however quiet the intro is.
    hi = float(np.percentile(loud, 95))
    loud_n = np.clip(1.0 - (hi - loud) / 12.0, 0.0, 1.0)
    # Density counts the instruments, not the voice: a sung verse over a
    # light kit is not more energetic than the same band's drop without it.
    inst = [
        i
        for i, n in enumerate(f.stem_names)
        if f.stems_are_parts or not any(k in n.lower() for k in _VOCAL_NAMES)
    ]
    dens = f.activity[:, inst].mean(axis=1) if inst else np.zeros(len(loud))
    lf = np.log(np.maximum(f.flux, _EPS))
    f_lo, f_hi = float(np.percentile(lf, 5)), float(np.percentile(lf, 95))
    flux_n = np.clip((lf - f_lo) / max(f_hi - f_lo, 0.3), 0.0, 1.0)
    drums = _column(f, _DRUM_NAMES)
    vocals = None if f.stems_are_parts else _column(f, _VOCAL_NAMES)

    def mean(v: Optional[np.ndarray], s: tuple[int, int]) -> float:
        return float(v[s[0] : s[1]].mean()) if v is not None else 0.0

    energy = [
        0.5 * mean(loud_n, s) + 0.25 * mean(dens, s) + 0.25 * mean(flux_n, s)
        for s in spans
    ]
    if n == 1:
        return ["verse"], [round(energy[0], 3)]
    e = np.asarray(energy)
    e_lo, e_hi = float(e.min()), float(e.max())
    e_mid = float(np.median(e))
    roles = ["verse"] * n

    # The chorus (or drop): the most energetic group that comes back, else the
    # most energetic section when it stands clear of the rest.
    counts: dict[int, int] = {}
    for g in groups:
        counts[g] = counts.get(g, 0) + 1
    group_energy = {
        g: float(np.mean([e[j] for j in range(n) if groups[j] == g])) for g in counts
    }
    # A group that comes back is a little more likely the chorus than one
    # section of the same energy that never does.
    best = max(counts, key=lambda g: group_energy[g] + 0.03 * min(2, counts[g] - 1))
    chorus_g: Optional[int] = None
    if group_energy[best] >= e_mid - 0.02 and (
        counts[best] >= 2 or group_energy[best] > e_mid + 0.05
    ):
        chorus_g = best
    # A quieter member of that group (the chorus played down) is not a chorus.
    chorus = [j for j in range(n) if groups[j] == chorus_g and e[j] >= e_mid - 0.02]
    for j in chorus:
        drop = (
            vocals is not None
            and mean(vocals, spans[j]) < 0.35
            and drums is not None
            and mean(drums, spans[j]) > 0.5
        )
        roles[j] = "drop" if drop else "chorus"

    first_chorus = min(chorus) if chorus else n
    quiet = e_lo + 0.35 * (e_hi - e_lo)
    drum_mid = float(np.median(drums)) if drums is not None else 0.0
    for j in range(n):
        if j in chorus:
            continue
        s = spans[j]
        low = e[j] <= quiet and e_hi - e_lo > 0.08
        drumless = drums is not None and drum_mid > 0.5 and mean(drums, s) < 0.3
        # An opening or closing section is the intro or outro when it is
        # quieter than the song, and either never comes back or is clearly
        # quieter (an opening verse that returns is a verse).
        once = counts[groups[j]] == 1
        if (
            j == 0
            and n >= 3
            and e[j] < max(e_mid, float(e[1:].mean()))
            and (once or e[j] < e_mid - 0.1)
        ):
            roles[j] = "intro"
        elif (
            j == n - 1
            and n >= 3
            and e[j] < max(e_mid, float(e[:-1].mean()))
            and (once or e[j] < e_mid - 0.1)
        ):
            roles[j] = "outro"
        elif 0 < j < n - 1 and (low or drumless):
            roles[j] = "break"
    # The bridge: of the sections heard once, after the first chorus and
    # before the last section, the one least like the rest of the song.
    bridge = [
        j
        for j in range(1, n - 1)
        if roles[j] == "verse" and counts[groups[j]] == 1 and j > first_chorus
    ]
    if bridge and contrast is not None:
        roles[max(bridge, key=lambda j: contrast[j])] = "bridge"
    return roles, [round(float(v), 3) for v in energy]


def section_names(roles: list[str]) -> list[str]:
    """ "Verse", "Chorus", "Verse 2", ...: a role that comes back is numbered."""
    seen: dict[str, int] = {}
    out = []
    for r in roles:
        seen[r] = seen.get(r, 0) + 1
        title = ROLE_TITLES.get(r, r.capitalize())
        out.append(title if seen[r] == 1 else f"{title} {seen[r]}")
    return out


# ---- entry point ----------------------------------------------------------------


def analysis_cells(
    bars: Sequence[tuple[float, float]], target: float = _CELL_SEC
) -> tuple[list[tuple[float, float]], list[Optional[int]]]:
    """The spans the features are read over, about ``target`` seconds each,
    and for each the bar it starts (None when it starts inside a bar).

    A grid read at two beats a bar (or a fast bar) is read two or more bars a
    cell, so each cell holds a whole drum pattern; a free-time bar of seven
    seconds is read in parts, so a change inside it is still seen. Every
    boundary is moved to a bar line before it is reported."""
    cells: list[tuple[float, float]] = []
    starts: list[Optional[int]] = []
    open_cell: Optional[list[float]] = None
    for i, (t0, t1) in enumerate(bars):
        length = t1 - t0
        if length > 1.5 * target:
            if open_cell is not None:
                cells.append((open_cell[0], open_cell[1]))
                open_cell = None
            k = max(2, int(round(length / target)))
            step = length / k
            for j in range(k):
                cells.append((t0 + j * step, t0 + (j + 1) * step))
                starts.append(i if j == 0 else None)
            continue
        if open_cell is None or open_cell[1] - open_cell[0] >= 0.75 * target:
            if open_cell is not None:
                cells.append((open_cell[0], open_cell[1]))
            open_cell = [t0, t1]
            starts.append(i)
        else:
            open_cell[1] = t1
    if open_cell is not None:
        cells.append((open_cell[0], open_cell[1]))
    return cells, starts


def _snap_to_bar_lines(
    picked: list[tuple[int, float]],
    cells: list[tuple[float, float]],
    starts: list[Optional[int]],
) -> list[tuple[int, float]]:
    """Each picked cell moved to the nearest cell that starts a bar; two that
    land on one bar line keep the stronger. Returns ``(cell, strength)``."""
    lines = [c for c, b in enumerate(starts) if b is not None]
    best: dict[int, float] = {}
    for c, v in picked:
        if starts[c] is None:
            c = min(lines, key=lambda k: abs(cells[k][0] - cells[c][0]))
        if c == 0:
            continue
        best[c] = max(v, best.get(c, 0.0))
    return sorted(best.items())


def find_sections(
    y: np.ndarray,
    bars: Sequence[tuple[float, float]],
    *,
    duration: Optional[float] = None,
    stems: Optional[dict[str, np.ndarray]] = None,
) -> dict[str, Any]:
    """Sections of ``y`` (mono, ``SR``) on ``bars``. See the module comment."""
    dur = float(duration if duration is not None else y.size / SR)
    bars = complete_grid(bars, dur)
    if not bars:
        bars = time_grid(dur)
    if not bars:
        return {
            "sections": [],
            "boundaries": [],
            "novelty": [],
            "stems": [],
            "bars": [],
        }
    cells, starts = analysis_cells(bars)
    n = len(cells)
    f = bar_features(y, cells, stems)
    x = feature_matrix(f)
    a1, sigma1 = affinity(x)
    xe = _embed(x)
    ae, _ = affinity(xe)
    scale = Scale.of(float(np.median([c1 - c0 for c0, c1 in cells])))
    nov = (
        boundary_novelty(a1, xe, ae, f.activity, scale)
        if n >= 2 * scale.min_bars
        else np.zeros(n)
    )
    picked = _snap_to_bar_lines(pick_boundaries(nov, scale), cells, starts)
    strongest = max((v for _, v in picked), default=0.0)
    cuts = [0] + [c for c, _ in picked] + [n]
    spans = [(cuts[k], cuts[k + 1]) for k in range(len(cuts) - 1)]
    letters, groups, sims, contrast = assign_letters(spans, a1, x, sigma1)
    roles, energy = assign_roles(spans, groups, f, contrast)
    names = section_names(roles)
    strength = dict(picked)
    first_of: dict[int, int] = {}
    for k, g in enumerate(groups):
        first_of.setdefault(g, k)

    def bar_of(cell: int) -> int:
        return int(starts[cell]) if starts[cell] is not None else 0

    sections = []
    for k, (c0, c1) in enumerate(spans):
        b0 = bar_of(c0)
        b1 = bar_of(c1) if c1 < n else len(bars)
        start = bars[b0][0]
        end = bars[b1][0] if b1 < len(bars) else max(bars[-1][1], dur)
        stems_on = {
            name: round(float(f.activity[c0:c1, c].mean()), 3)
            for c, name in enumerate(f.stem_names)
        }
        sections.append(
            {
                "index": k,
                "start_sec": round(start, 4),
                "end_sec": round(end, 4),
                "start_bar": b0,
                "bars": b1 - b0,
                "letter": letters[k],
                "role": roles[k],
                "name": names[k],
                "confidence": 1.0
                if k == 0
                else boundary_confidence(strength[c0], strongest),
                "repeat_of": None if first_of[groups[k]] == k else first_of[groups[k]],
                "similarity": sims[k],
                "energy": energy[k],
                "stems": stems_on,
            }
        )
    boundaries = [
        {
            "bar": bar_of(c),
            "sec": round(cells[c][0], 4),
            "confidence": boundary_confidence(v, strongest),
        }
        for c, v in picked
    ]
    return {
        "sections": sections,
        "boundaries": boundaries,
        "novelty": [
            [round(c0, 3), round(float(v), 4)] for (c0, _), v in zip(cells, nov)
        ],
        "stems": f.stem_names,
        "stems_are_parts": f.stems_are_parts,
        "bars": [[round(t0, 4), round(t1, 4)] for t0, t1 in bars],
    }
