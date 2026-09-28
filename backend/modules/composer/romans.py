"""Roman numerals for sounding chords, read against a local key.

Two jobs, shared by the style profiles (profile.py) and the SCORE chord track
(``notation/exporters/chordtrack.py``):

* **Local keys.** :func:`local_keys` runs music21's key finding over a
  window around each chord: the pitch classes sounding in the window,
  weighted by how long they sound, are correlated with the 24 rotated key
  profiles of ``music21.analysis.discrete.BellmanBudge`` (the correlation
  music21's ``analyze('key')`` makes). A Viterbi pass over the chords then
  keeps a key until another one fits clearly better, so one borrowed chord
  does not read as a modulation. On the twenty Bach chorales the corpus has
  Riemenschneider analyses for, a window of a bar each side agrees with the
  analysts' key on about three beats in four; the Krumhansl-Kessler weights
  agree on under two in three, most of the misses a dominant key read for
  the tonic.
* **Roman numerals.** :func:`chord_roman` hands a chord to music21's
  ``roman.romanNumeralFromChord`` in that key. A chord outside the key's
  scale is read again with ``preferSecondaryDominants`` so D7 in C is V7/V,
  not II7. :func:`display_figure` tidies music21's figure to the textbook
  spelling (``V65``, ``viio7``, ``Ger65``, ``V7/V``) and :func:`vocab_label`
  drops the inversion (``V65`` -> ``V7``, ``ii6`` -> ``ii``, ``bII6`` -> ``N``),
  which is how the style profiles count chords.
"""

from __future__ import annotations

import re
from functools import lru_cache
from typing import Iterable, Mapping, Sequence

import numpy as np
from music21 import chord as m21chord
from music21 import key as m21key
from music21 import pitch as m21pitch
from music21 import roman

__all__ = [
    "chord_roman",
    "display_figure",
    "key_from_index",
    "key_name",
    "local_keys",
    "vocab_label",
    "window_vectors",
]

# Tonic spellings for a key index when the music gives none (fewest accidentals).
MAJOR_TONICS = ("C", "D-", "D", "E-", "E", "F", "F#", "G", "A-", "A", "B-", "B")
MINOR_TONICS = ("C", "C#", "D", "E-", "E", "F", "F#", "G", "G#", "A", "B-", "B")

#: Correlation lost when the key changes from one chord to the next.
SWITCH_COST = 0.15
#: music21's key-profile class the windows are correlated with.
KEY_PROFILES = "BellmanBudge"

_NUMERAL = r"(?:It|Ger|Fr|Sw|N|VII|vii|VI|vi|IV|iv|V|v|III|iii|II|ii|I|i)"
_FIGURE_RE = re.compile(
    rf"^(?P<acc>[#b\-]*)(?P<num>{_NUMERAL})(?P<q>ø|o|\+|/o)?(?P<fig>[^/]*)"
    rf"(?:/(?P<sec>.+))?$"
)
_SEVENTH_FIGS = {"7", "65", "43", "42", "2", "643", "653", "642"}
_TRIAD_INVERSION = ("", "6", "64")
_SEVENTH_INVERSION = ("7", "65", "43", "42")
_AUG6 = {"It": "It6", "Ger": "Ger65", "Fr": "Fr43", "Sw": "Sw"}


# ---------------------------------------------------------------------------
# keys
# ---------------------------------------------------------------------------


@lru_cache(maxsize=1)
def _profiles() -> np.ndarray:
    """(24, 12): rows 0-11 major on C..B, rows 12-23 minor on C..B."""
    from music21 import analysis

    ks = getattr(analysis.discrete, KEY_PROFILES)()
    rows = []
    for mode in ("major", "minor"):
        w = np.asarray(ks.getWeights(mode), dtype=float)
        for tonic in range(12):
            rows.append(np.roll(w, tonic))
    return np.vstack(rows)


def correlations(vectors: np.ndarray) -> np.ndarray:
    """Pearson correlation of each (n, 12) pitch-class vector with the 24
    key profiles; a silent window correlates 0 with every key."""
    v = np.asarray(vectors, dtype=float)
    p = _profiles()
    vc = v - v.mean(axis=1, keepdims=True)
    pc = p - p.mean(axis=1, keepdims=True)
    num = vc @ pc.T
    den = np.linalg.norm(vc, axis=1, keepdims=True) * np.linalg.norm(pc, axis=1)
    with np.errstate(invalid="ignore", divide="ignore"):
        out = np.where(den > 1e-12, num / np.where(den > 1e-12, den, 1.0), 0.0)
    return out


def window_vectors(
    starts: Sequence[float],
    ends: Sequence[float],
    pcs: Sequence[int],
    lo: Sequence[float],
    hi: Sequence[float],
    weights: Sequence[float] | None = None,
) -> np.ndarray:
    """(n, 12): for each window ``[lo[i], hi[i])``, how long each pitch class
    sounds in it (times its weight) over the events ``starts``/``ends``/``pcs``."""
    s = np.asarray(starts, dtype=float)
    e = np.asarray(ends, dtype=float)
    pc = np.asarray(pcs, dtype=int) % 12
    w = np.ones_like(s) if weights is None else np.asarray(weights, dtype=float)
    a = np.asarray(lo, dtype=float)[:, None]
    b = np.asarray(hi, dtype=float)[:, None]
    out = np.zeros((len(lo), 12))
    if len(s) == 0 or len(lo) == 0:
        return out
    overlap = np.clip(np.minimum(e[None, :], b) - np.maximum(s[None, :], a), 0, None)
    overlap *= w[None, :]
    for k in range(12):
        mask = pc == k
        if mask.any():
            out[:, k] = overlap[:, mask].sum(axis=1)
    return out


def local_keys(
    vectors: np.ndarray,
    *,
    prior: int | None = None,
    prior_weight: float = 0.03,
    switch_cost: float = SWITCH_COST,
) -> list[int]:
    """The key index (0-11 major, 12-23 minor) for each window, from its
    correlation with the key profiles and a cost for changing key. ``prior``
    is a key the whole piece leans to (its signature or its global best)."""
    corr = correlations(vectors)
    n = corr.shape[0]
    if n == 0:
        return []
    if prior is not None and 0 <= prior < 24:
        corr = corr.copy()
        corr[:, prior] += prior_weight
    acc = corr[0].copy()
    back = np.zeros((n, 24), dtype=np.int64)
    for t in range(1, n):
        best = int(acc.argmax())
        switch = acc[best] - switch_cost
        stay = acc >= switch
        back[t] = np.where(stay, np.arange(24), best)
        acc = np.where(stay, acc, switch) + corr[t]
    path = [int(acc.argmax())]
    for t in range(n - 1, 0, -1):
        path.append(int(back[t][path[-1]]))
    path.reverse()
    return path


def global_key(vector: Sequence[float]) -> int:
    """The key index that fits one pitch-class vector best."""
    return int(correlations(np.asarray([vector], dtype=float))[0].argmax())


def key_from_index(
    index: int, spellings: Mapping[int, str] | None = None
) -> m21key.Key:
    """A music21 Key for a key index, its tonic spelled as the music spells
    that pitch class when ``spellings`` says (pc -> 'C#', 'D-', ...)."""
    tonic_pc = index % 12
    mode = "major" if index < 12 else "minor"
    table = MAJOR_TONICS if mode == "major" else MINOR_TONICS
    name = (spellings or {}).get(tonic_pc) or table[tonic_pc]
    # A tonic that would need a double accidental or six-plus of them reads
    # enharmonically (music21 keys stop at seven).
    try:
        k = m21key.Key(name, mode)
        if abs(k.sharps) > 7:
            raise ValueError(name)
    except Exception:
        k = m21key.Key(table[tonic_pc], mode)
    return k


def key_index(k: m21key.Key) -> int:
    return k.tonic.pitchClass + (0 if k.mode == "major" else 12)


def key_name(k: m21key.Key) -> str:
    """'G major', 'Bb minor'."""
    return f"{k.tonic.name.replace('-', 'b')} {k.mode}"


# ---------------------------------------------------------------------------
# roman numerals
# ---------------------------------------------------------------------------


def _scale_pcs(k: m21key.Key) -> set[int]:
    pcs = {p.pitchClass for p in k.getScale().getPitches()}
    if k.mode == "minor":
        tonic = k.tonic.pitchClass
        pcs |= {(tonic + 9) % 12, (tonic + 11) % 12}
    return pcs


def chord_roman(
    pitches: Iterable[m21pitch.Pitch | str], k: m21key.Key
) -> roman.RomanNumeral:
    """music21's reading of a chord in key ``k``; the lowest pitch is the bass.
    A chord with a tone outside the key is read as an applied chord when
    music21 finds one (``preferSecondaryDominants``)."""
    ch = m21chord.Chord(list(pitches))
    pcs = {p.pitchClass for p in ch.pitches}
    rn = roman.romanNumeralFromChord(ch, k)
    tonic = k.tonic.pitchClass
    if k.mode == "minor" and pcs == {tonic, (tonic + 4) % 12, (tonic + 7) % 12}:
        # A major tonic in a minor key is the tierce de Picardie: I, not V/iv.
        inv = {tonic: "", (tonic + 4) % 12: "6"}.get(ch.bass().pitchClass, "64")
        return roman.RomanNumeral("I" + inv, k)
    if not pcs <= _scale_pcs(k):
        alt = roman.romanNumeralFromChord(ch, k, preferSecondaryDominants=True)
        if "/" in alt.figure:
            rn = alt
    elif k.mode == "minor" and re.match(r"^b(VII|VI)(?![a-z])", rn.figure):
        # music21 names the natural sixth and seventh of a minor key bVI and
        # bVII from a chord, and VI and VII from a figure; the planner and
        # the textbooks write VI and VII.
        plain = roman.RomanNumeral(rn.figure[1:], k)
        if {p.pitchClass for p in plain.pitches} == pcs:
            rn = plain
    return rn


def _parse(figure: str) -> re.Match[str] | None:
    clean = re.sub(r"\[.*?\]", "", figure or "").strip()
    return _FIGURE_RE.match(clean)


def _is_seventh(fig: str) -> bool:
    return fig in _SEVENTH_FIGS or "7" in fig


def vocab_label(figure: str) -> str:
    """A figure with its inversion dropped: the chord a style profile counts.

    ``V65`` -> ``V7``, ``ii6`` -> ``ii``, ``I64`` -> ``I``, ``viio6`` ->
    ``viio``, ``iiø65`` -> ``iiø7``, ``bII6`` and ``N6`` -> ``N``, ``V65/V``
    -> ``V7/V``; the augmented sixths keep their names (``It6``, ``Ger65``,
    ``Fr43``). A figure the pattern does not know comes back as it is."""
    m = _parse(figure)
    if m is None:
        return (figure or "").strip()
    acc, num, q, fig, sec = (
        m.group("acc").replace("-", "b"),
        m.group("num"),
        (m.group("q") or "").replace("/o", "ø"),
        m.group("fig"),
        m.group("sec"),
    )
    if num in _AUG6:
        return _AUG6[num]
    seventh = _is_seventh(fig)
    if num == "N" or (acc == "b" and num == "II" and not seventh and not q):
        head = "N"
    else:
        head = f"{acc}{num}{q}{'7' if seventh else ''}"
    if sec:
        return f"{head}/{vocab_label(sec)}"
    return head


def display_figure(rn: roman.RomanNumeral) -> str:
    """The figure a player reads: music21's own when it is one of the
    textbook shapes, otherwise the chord's label with its inversion figure
    (``II75#3`` never shows; D7 in C is ``V7/V`` from :func:`chord_roman`)."""
    figure = rn.figure
    m = _parse(figure)
    if m is None:
        return figure
    fig = m.group("fig")
    if m.group("num") in _AUG6 or m.group("num") == "N":
        return figure
    if fig in _TRIAD_INVERSION or fig in _SEVENTH_INVERSION:
        return re.sub(r"\[.*?\]", "", figure).replace("-", "b")
    label = vocab_label(figure)
    head, _, sec = label.partition("/")
    try:
        inv = int(rn.inversion())
    except Exception:
        inv = 0
    if head.endswith("7"):
        head = head[:-1] + _SEVENTH_INVERSION[min(inv, 3)]
    elif head != "N":
        head = head + _TRIAD_INVERSION[min(inv, 2)]
    return f"{head}/{sec}" if sec else head
