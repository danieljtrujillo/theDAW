"""Cut a library entry into shards and describe each one.

A shard is a fragment of one source (a Demucs stem, or the mix when the entry
has no stems) cut on the song's own beat grid:

* one-bar shards for every source (``beats = 4``),
* two- and four-bar aggregates (``beats = 8 / 16``) so a query can ask for a
  phrase-length piece,
* one-beat sub-shards for percussive roles (``beats = 1``), the material a
  drum lane wants.

Descriptors come from ONE STFT per source: rms, low-band fraction, spectral
centroid, mean chroma (→ ``pc_root``), 13 MFCCs, and a 16-slot onset mask
(which sixteenths inside the shard carry an onset — the rhythm fingerprint
LOOM's complement ranking uses). ``energy`` is the shard's rms percentile
within its source so "energy > 0.7" means the same thing on a quiet folk stem
and a club master. Chord symbols and lyric words are joined in when the entry
has a chord track / timed lyrics.

Beats come from the ``analysis`` row (aubio/librosa beat times); the downbeat
phase is estimated with the chimera structure code and gated on its
confidence exactly as chimera gates it.
"""

from __future__ import annotations

import json
import logging
import math
from pathlib import Path
from typing import Any, Optional

import numpy as np

log = logging.getLogger(__name__)

SHARD_VERSION = 1
SR = 22050
_HOP = 512
_N_FFT = 2048
_LOW_HZ = 200.0
_MASK_SLOTS = 16
_DOWNBEAT_MIN_CONF = 0.15

PERCUSSIVE_ROLES = {"drums", "kick", "snare", "hihat", "cymbals", "toms"}

_ROLE_KEYS: list[tuple[str, str]] = [
    ("kick", "kick"),
    ("snare", "snare"),
    ("hihat", "hihat"),
    ("hi-hat", "hihat"),
    ("hat", "hihat"),
    ("cymbal", "cymbals"),
    ("tom", "toms"),
    ("drum", "drums"),
    ("bass", "bass"),
    ("vocal", "vocals"),
    ("voice", "vocals"),
    ("guitar", "guitar"),
    ("piano", "piano"),
    ("keys", "piano"),
    ("other", "other"),
    ("mix", "mix"),
]


def role_for(stem_name: str) -> str:
    n = (stem_name or "").lower()
    for needle, role in _ROLE_KEYS:
        if needle in n:
            return role
    return "other"


def shard_id(
    entry_id: str, stem_name: str, bar_index: int, beats: int, beat_offset: int = 0
) -> str:
    tail = (
        f"{bar_index}x{beats}"
        if beat_offset == 0
        else f"{bar_index}x{beats}b{beat_offset}"
    )
    return f"{entry_id}__{stem_name}__{tail}"


# ---- loading -----------------------------------------------------------------


def _load_mono(path: Path) -> np.ndarray:
    import librosa

    y, _ = librosa.load(str(path), sr=SR, mono=True)
    return np.ascontiguousarray(np.asarray(y, dtype=np.float32))


def _beats_from_analysis(analysis: dict[str, Any]) -> tuple[float, list[float]]:
    bpm = float(analysis.get("bpm") or 0.0)
    raw = analysis.get("beats_json") or analysis.get("beats") or "[]"
    beats = json.loads(raw) if isinstance(raw, str) else list(raw)
    beats = [float(b) for b in beats if b is not None]
    beats.sort()
    return bpm, beats


def _downbeat_phase(y: np.ndarray, beats: list[float]) -> int:
    """Which beat index (mod 4) is the downbeat, or 0 below chimera's gate."""
    try:
        import librosa

        from backend.modules.chimera.structure import (
            beat_features,
            estimate_downbeat_phase,
        )

        frames = librosa.time_to_frames(np.asarray(beats), sr=SR, hop_length=_HOP)
        feats = beat_features(y, SR, frames, hop=_HOP)
        phase, conf = estimate_downbeat_phase(feats, 4)
        return int(phase) if conf >= _DOWNBEAT_MIN_CONF else 0
    except Exception as e:  # noqa: BLE001 - phase 0 is a valid fallback
        log.info("shards: downbeat phase fell back to 0 (%s)", e)
        return 0


# ---- per-source frame features -----------------------------------------------


class _Frames:
    """Frame-rate descriptors for one source, sliced by time window."""

    def __init__(self, y: np.ndarray) -> None:
        import librosa

        S = np.abs(librosa.stft(y, n_fft=_N_FFT, hop_length=_HOP))
        power = S**2
        freqs = librosa.fft_frequencies(sr=SR, n_fft=_N_FFT)
        eps = 1e-10
        total = power.sum(axis=0) + eps
        self.rms = np.sqrt(power.mean(axis=0) + eps)
        self.low_frac = power[freqs < _LOW_HZ].sum(axis=0) / total
        self.centroid = librosa.feature.spectral_centroid(S=S, sr=SR)[0]
        self.chroma = librosa.feature.chroma_stft(S=S, sr=SR)  # [12, T]
        mel = librosa.feature.melspectrogram(S=power, sr=SR, n_mels=64)
        mel_db = librosa.power_to_db(mel)
        self.mfcc = librosa.feature.mfcc(S=mel_db, n_mfcc=13)  # [13, T]
        env = librosa.onset.onset_strength(S=mel_db, sr=SR)
        self.onsets = librosa.onset.onset_detect(
            onset_envelope=env, sr=SR, hop_length=_HOP, units="time", backtrack=False
        )
        self.n_frames = int(S.shape[1])
        self.times = librosa.frames_to_time(
            np.arange(self.n_frames), sr=SR, hop_length=_HOP
        )

    def _span(self, t0: float, t1: float) -> tuple[int, int]:
        import librosa

        a = int(librosa.time_to_frames(t0, sr=SR, hop_length=_HOP))
        b = int(librosa.time_to_frames(t1, sr=SR, hop_length=_HOP))
        a = max(0, min(self.n_frames - 1, a))
        b = max(a + 1, min(self.n_frames, b))
        return a, b

    def describe(self, t0: float, t1: float) -> dict[str, Any]:
        a, b = self._span(t0, t1)
        rms = float(self.rms[a:b].mean())
        chroma = self.chroma[:, a:b].mean(axis=1)
        mfcc = self.mfcc[:, a:b].mean(axis=1)
        cmax = float(chroma.max()) if chroma.size else 0.0
        cmean = float(chroma.mean()) if chroma.size else 0.0
        pc_root = int(np.argmax(chroma)) if cmax > 1.25 * cmean + 1e-6 else -1
        slot = (t1 - t0) / _MASK_SLOTS
        mask = 0
        count = 0
        if slot > 0:
            for o in self.onsets:
                if t0 <= o < t1:
                    k = min(_MASK_SLOTS - 1, int((o - t0) / slot))
                    mask |= 1 << k
                    count += 1
        return {
            "rms_db": 20.0 * math.log10(max(rms, 1e-9)),
            "low_frac": float(self.low_frac[a:b].mean()),
            "centroid_hz": float(self.centroid[a:b].mean()),
            "onset_density": count / max(1e-6, t1 - t0),
            "onset_mask": mask,
            "pc_root": pc_root,
            "chroma_json": json.dumps([round(float(v), 4) for v in chroma]),
            "mfcc_json": json.dumps([round(float(v), 3) for v in mfcc]),
        }


# ---- joins: chords + words -----------------------------------------------------


def _load_chords(db: Any, entry_id: str) -> list[dict[str, Any]]:
    try:
        rows = db.list_notation_artifacts(entry_id, kind="chordtrack")
    except Exception:  # noqa: BLE001
        return []
    for row in rows:
        p = Path(str(row.get("path") or ""))
        if p.is_file():
            try:
                doc = json.loads(p.read_text(encoding="utf-8"))
                return list(doc.get("chords") or [])
            except Exception:  # noqa: BLE001
                continue
    return []


def _load_words(entry_dir: Path) -> list[tuple[float, str]]:
    p = entry_dir / "lyrics.json"
    if not p.is_file():
        return []
    try:
        doc = json.loads(p.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return []
    out: list[tuple[float, str]] = []
    for line in doc.get("lines") or []:
        for w in line.get("words") or []:
            s = w.get("start_ms")
            t = str(w.get("text") or "").strip()
            if s is None or not t:
                continue
            out.append((float(s) / 1000.0, t))
    out.sort()
    return out


def _chord_for(chords: list[dict[str, Any]], t0: float, t1: float) -> str:
    best, best_ov = "", 0.0
    for c in chords:
        s, e = float(c.get("startSec", 0.0)), float(c.get("endSec", 0.0))
        ov = min(e, t1) - max(s, t0)
        if ov > best_ov:
            best, best_ov = str(c.get("symbol") or ""), ov
    return best


def _words_for(words: list[tuple[float, str]], t0: float, t1: float) -> str:
    return " ".join(t for s, t in words if t0 <= s < t1)


# ---- main ---------------------------------------------------------------------


def _sources(
    db: Any, entry_id: str, audio: Path, entry_dir: Path
) -> list[tuple[str, Path]]:
    out: list[tuple[str, Path]] = []
    try:
        rows = db.list_stems(entry_id)
    except Exception:  # noqa: BLE001
        rows = []
    for r in rows:
        raw = str(r.get("audio_path") or "")
        if not raw:
            continue
        p = Path(raw)
        if not p.is_absolute():
            p = entry_dir / raw
        if p.is_file():
            out.append((str(r.get("stem_name") or "stem"), p))
    if not out:
        out.append(("mix", audio))
    return out


def extract_shards(
    db: Any, entry_id: str, audio: Path, entry_dir: Path
) -> list[dict[str, Any]]:
    """Cut + describe every source of ``entry_id`` and replace its shard rows.

    Requires an ``analysis`` row with beats; raises ``RuntimeError`` otherwise
    (the coordinator runs analysis first)."""
    analysis = db.get_analysis(entry_id)
    if not analysis:
        raise RuntimeError("no analysis row — run analysis before sharding")
    bpm, beats = _beats_from_analysis(analysis)
    if bpm <= 0 or len(beats) < 8:
        raise RuntimeError("analysis has no usable beat grid")

    from backend.modules.chimera.harmony import camelot_code

    key = analysis.get("key") or ""
    scale = analysis.get("scale") or ""
    camelot = camelot_code(key or None, scale or None) or ""
    chords = _load_chords(db, entry_id)
    words = _load_words(entry_dir)

    beat_sec = 60.0 / bpm
    # Extend the grid by one beat so the last bar has an end.
    grid = list(beats) + [beats[-1] + beat_sec]

    sources = _sources(db, entry_id, audio, entry_dir)
    rows: list[dict[str, Any]] = []
    phase: Optional[int] = None

    for stem_name, path in sources:
        try:
            y = _load_mono(path)
        except Exception as e:  # noqa: BLE001
            log.warning("shards: could not load %s (%s)", path, e)
            continue
        if phase is None:
            phase = _downbeat_phase(y, beats)
        frames = _Frames(y)
        role = role_for(stem_name)
        dur = float(y.size) / SR

        def add(
            bar_index: int, nbeats: int, t0: float, t1: float, beat_offset: int = 0
        ) -> None:
            if t1 - t0 < 0.05 or t0 >= dur:
                return
            t1 = min(t1, dur)
            d = frames.describe(t0, t1)
            rows.append(
                {
                    "id": shard_id(entry_id, stem_name, bar_index, nbeats, beat_offset),
                    "entry_id": entry_id,
                    "stem_name": stem_name,
                    "role": role,
                    "start_sec": round(t0, 5),
                    "end_sec": round(t1, 5),
                    "beats": nbeats,
                    "bar_index": bar_index,
                    "bpm": bpm,
                    "key": key,
                    "scale": scale,
                    "camelot": camelot,
                    "section": "",
                    "chord": _chord_for(chords, t0, t1),
                    "words": _words_for(words, t0, t1)
                    if role in ("vocals", "mix")
                    else "",
                    "energy": 0.0,
                    "version": SHARD_VERSION,
                    **d,
                }
            )

        first = phase or 0
        bar_starts = list(range(first, len(grid) - 4, 4))
        for bi, i in enumerate(bar_starts):
            add(bi, 4, grid[i], grid[i + 4])
            if role in PERCUSSIVE_ROLES:
                for k in range(4):
                    add(bi, 1, grid[i + k], grid[i + k + 1], beat_offset=k)
            if bi % 2 == 0 and i + 8 < len(grid):
                add(bi, 8, grid[i], grid[i + 8])
            if bi % 4 == 0 and i + 16 < len(grid):
                add(bi, 16, grid[i], grid[i + 16])

        # Energy = rms percentile among this source's one-bar shards.
        bars = [
            r
            for r in rows
            if r["stem_name"] == stem_name
            and r["entry_id"] == entry_id
            and r["beats"] == 4
        ]
        if bars:
            order = sorted(bars, key=lambda r: r["rms_db"])
            n = max(1, len(order) - 1)
            rank = {id(r): idx / n for idx, r in enumerate(order)}
            for r in bars:
                r["energy"] = round(rank[id(r)], 4)
            # Sub-shards and aggregates inherit their bar's energy.
            by_bar = {r["bar_index"]: r["energy"] for r in bars}
            for r in rows:
                if r["stem_name"] == stem_name and r["beats"] != 4:
                    r["energy"] = by_bar.get(r["bar_index"], 0.0)

    db.replace_shards(entry_id, rows)
    log.info(
        "shards: %s → %d shards from %d source(s)", entry_id, len(rows), len(sources)
    )
    return rows
