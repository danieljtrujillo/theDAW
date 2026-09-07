"""Ranking, pairing and audio cropping for the Shard Index.

Ranking is a weighted sum over descriptors the extractor already stored, so a
query over a few thousand candidates is a Python loop, not a model call:

* key       — Camelot distance to the query key (0 same, 1 neighbour, …)
* tempo     — |log2(target_bpm / shard_bpm)| after octave folding
* energy    — distance to the requested energy band
* rhythm    — Hamming similarity of the 16-slot onset masks
* novelty   — fewer kept pairings with the reference → higher

Pairing (complements) flips rhythm to AND-low / OR-high (syncopation
potential) and adds spectral complement (low_frac / centroid non-overlap).
"""

from __future__ import annotations

import io
import logging
import math
from pathlib import Path
from typing import Any, Optional

import numpy as np

log = logging.getLogger(__name__)

STRETCH_DEFAULT = 0.12  # ±12 % before a shard is considered "wrong tempo"

_NOTE_PC = {
    "C": 0,
    "C#": 1,
    "DB": 1,
    "D": 2,
    "D#": 3,
    "EB": 3,
    "E": 4,
    "F": 5,
    "F#": 6,
    "GB": 6,
    "G": 7,
    "G#": 8,
    "AB": 8,
    "A": 9,
    "A#": 10,
    "BB": 10,
    "B": 11,
}


def _popcount(x: int) -> int:
    return bin(x & 0xFFFF).count("1")


def fold_ratio(r: float) -> float:
    """Fold a tempo ratio into [1/√2, √2] by octaves (half-time / double-time)."""
    if r <= 0:
        return 1.0
    while r > math.sqrt(2):
        r /= 2.0
    while r < 1 / math.sqrt(2):
        r *= 2.0
    return r


def camelot_distance(a: str, b: str) -> Optional[int]:
    """0 same code, 1 neighbour on the wheel or relative ring, 2 two away …"""
    if not a or not b:
        return None
    try:
        na, ra = int(a[:-1]), a[-1].upper()
        nb, rb = int(b[:-1]), b[-1].upper()
    except (ValueError, IndexError):
        return None
    d = abs(na - nb) % 12
    d = min(d, 12 - d)
    return d + (0 if ra == rb else (0 if d == 0 else 1))


def key_to_camelot(key: str, scale: str) -> str:
    from backend.modules.chimera.harmony import camelot_code

    return camelot_code(key or None, scale or None) or ""


def transpose_semitones(
    from_key: str, from_scale: str, to_key: str, to_scale: str
) -> int:
    """Smallest shift (−6..6) that moves ``from`` onto ``to`` (relative keys share
    a tonic centre, so minor→major targets the relative major)."""
    a = _NOTE_PC.get((from_key or "").upper().replace("♯", "#").replace("♭", "B"))
    b = _NOTE_PC.get((to_key or "").upper().replace("♯", "#").replace("♭", "B"))
    if a is None or b is None:
        return 0
    if (from_scale or "").lower().startswith("min") and not (
        to_scale or ""
    ).lower().startswith("min"):
        a = (a + 3) % 12  # relative major of the source
    elif (to_scale or "").lower().startswith("min") and not (
        from_scale or ""
    ).lower().startswith("min"):
        b = (b + 3) % 12
    d = (b - a) % 12
    return d - 12 if d > 6 else d


# ---- ranking ---------------------------------------------------------------------


def rank_shards(
    cands: list[dict[str, Any]],
    *,
    camelot: str = "",
    bpm: Optional[float] = None,
    stretch_max: float = STRETCH_DEFAULT,
    energy: Optional[tuple[float, float]] = None,
    mask_like: Optional[int] = None,
    pair_counts: Optional[dict[str, int]] = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    scored: list[tuple[float, dict[str, Any]]] = []
    for s in cands:
        score = 0.0
        if camelot:
            d = camelot_distance(camelot, str(s.get("camelot") or ""))
            score += 0.0 if d is None else -0.35 * d
        if bpm and s.get("bpm"):
            r = fold_ratio(bpm / float(s["bpm"]))
            off = abs(math.log2(r))
            score += -2.0 * off if off <= stretch_max else -2.0 * off - 1.0
        if energy is not None:
            e = float(s.get("energy") or 0.0)
            lo, hi = energy
            if e < lo:
                score -= (lo - e) * 2.0
            elif e > hi:
                score -= (e - hi) * 2.0
        if mask_like is not None:
            same = 16 - _popcount((mask_like ^ int(s.get("onset_mask") or 0)) & 0xFFFF)
            score += 0.04 * same
        if pair_counts:
            score += (
                0.15
                if pair_counts.get(str(s["id"]), 0) == 0
                else -0.05 * pair_counts[str(s["id"])]
            )
        scored.append((score, s))
    scored.sort(key=lambda t: t[0], reverse=True)
    out = []
    for score, s in scored[:limit]:
        row = dict(s)
        row["score"] = round(score, 4)
        if bpm and s.get("bpm"):
            row["tempo_ratio"] = round(fold_ratio(bpm / float(s["bpm"])), 4)
        out.append(row)
    return out


def rank_complements(
    ref: dict[str, Any],
    cands: list[dict[str, Any]],
    *,
    pair_counts: Optional[dict[str, int]] = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Shards that would sit WELL against ``ref`` at the same time."""
    ref_mask = int(ref.get("onset_mask") or 0)
    ref_low = float(ref.get("low_frac") or 0.0)
    ref_cent = float(ref.get("centroid_hz") or 1000.0)
    ref_energy = float(ref.get("energy") or 0.5)
    ref_bpm = float(ref.get("bpm") or 0.0)
    scored: list[tuple[float, dict[str, Any]]] = []
    for s in cands:
        if (
            s.get("id") == ref.get("id")
            or s.get("entry_id") == ref.get("entry_id")
            and s.get("stem_name") == ref.get("stem_name")
        ):
            continue
        score = 0.0
        d = camelot_distance(str(ref.get("camelot") or ""), str(s.get("camelot") or ""))
        score += 0.0 if d is None else -0.4 * d
        if ref_bpm and s.get("bpm"):
            score += -2.0 * abs(math.log2(fold_ratio(ref_bpm / float(s["bpm"]))))
        m = int(s.get("onset_mask") or 0)
        both = _popcount(ref_mask & m)
        either = _popcount(ref_mask | m)
        score += 0.05 * (either - 2 * both)  # interlock: fill the other's gaps
        low_gap = abs(ref_low - float(s.get("low_frac") or 0.0))
        score += 0.6 * low_gap  # one owns the low end, the other does not
        cent = float(s.get("centroid_hz") or 1000.0)
        score += 0.25 * min(1.0, abs(math.log2(max(cent, 50.0) / max(ref_cent, 50.0))))
        score -= 0.8 * abs(ref_energy - float(s.get("energy") or 0.5))
        if pair_counts:
            n = pair_counts.get(str(s["id"]), 0)
            score += 0.15 if n == 0 else -0.05 * n
        scored.append((score, s))
    scored.sort(key=lambda t: t[0], reverse=True)
    out = []
    for score, s in scored[:limit]:
        row = dict(s)
        row["score"] = round(score, 4)
        out.append(row)
    return out


# ---- audio ------------------------------------------------------------------------


def _read_window(
    path: Path, start_sec: float, end_sec: float
) -> tuple[np.ndarray, int]:
    """Float32 ``[n, ch]`` window of ``path``. soundfile first (fast, exact),
    librosa for containers libsndfile cannot open."""
    try:
        import soundfile as sf

        info = sf.info(str(path))
        sr = int(info.samplerate)
        start = max(0, int(round(start_sec * sr)))
        frames = max(1, int(round((end_sec - start_sec) * sr)))
        data, _ = sf.read(
            str(path), start=start, frames=frames, dtype="float32", always_2d=True
        )
        return np.asarray(data, dtype=np.float32), sr
    except Exception:  # noqa: BLE001 - fall through to librosa
        import librosa

        y, sr = librosa.load(
            str(path),
            sr=None,
            mono=False,
            offset=max(0.0, start_sec),
            duration=max(0.01, end_sec - start_sec),
        )
        y = np.asarray(y, dtype=np.float32)
        if y.ndim == 1:
            y = y[:, None]
        else:
            y = y.T
        return y, int(sr)


def conform(
    y: np.ndarray, sr: int, *, rate: float = 1.0, semitones: float = 0.0
) -> np.ndarray:
    """Time-stretch by ``rate`` (>1 shorter) and/or pitch-shift, per channel."""
    import librosa

    out = []
    for ch in range(y.shape[1]):
        x = np.ascontiguousarray(y[:, ch])
        if abs(rate - 1.0) > 1e-3:
            x = librosa.effects.time_stretch(x, rate=rate)
        if abs(semitones) > 1e-3:
            x = librosa.effects.pitch_shift(x, sr=sr, n_steps=float(semitones))
        out.append(x)
    n = min(len(c) for c in out)
    return np.stack([c[:n] for c in out], axis=1).astype(np.float32)


def shard_wav_bytes(
    shard: dict[str, Any],
    source_path: Path,
    *,
    bpm: Optional[float] = None,
    semitones: float = 0.0,
    cache_dir: Optional[Path] = None,
) -> bytes:
    """WAV bytes of the shard, optionally conformed to ``bpm`` (octave-folded)
    and transposed. Conformed renders are cached on disk by (id, bpm, st)."""
    rate = 1.0
    if bpm and shard.get("bpm"):
        rate = fold_ratio(float(bpm) / float(shard["bpm"]))
        if abs(math.log2(rate)) < 0.004:
            rate = 1.0
    key = f"{shard['id']}__{(bpm or 0):.1f}__{semitones:.1f}.wav"
    if cache_dir is not None and (rate != 1.0 or abs(semitones) > 1e-3):
        cached = cache_dir / key
        if cached.is_file():
            return cached.read_bytes()
    y, sr = _read_window(
        source_path, float(shard["start_sec"]), float(shard["end_sec"])
    )
    if rate != 1.0 or abs(semitones) > 1e-3:
        y = conform(y, sr, rate=rate, semitones=semitones)
        # Pin the length to the exact conformed duration so loops stay on grid.
        if bpm:
            want = int(round(float(shard["beats"]) * 60.0 / float(bpm) * sr))
            if want > 0:
                if y.shape[0] > want:
                    y = y[:want]
                elif y.shape[0] < want:
                    y = np.concatenate(
                        [
                            y,
                            np.zeros((want - y.shape[0], y.shape[1]), dtype=np.float32),
                        ],
                        axis=0,
                    )
    import soundfile as sf

    buf = io.BytesIO()
    sf.write(buf, y, sr, format="WAV", subtype="PCM_16")
    data = buf.getvalue()
    if cache_dir is not None and (rate != 1.0 or abs(semitones) > 1e-3):
        try:
            cache_dir.mkdir(parents=True, exist_ok=True)
            (cache_dir / key).write_bytes(data)
        except OSError as e:
            log.info("shards: cache write skipped (%s)", e)
    return data
