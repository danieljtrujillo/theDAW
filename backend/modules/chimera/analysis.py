"""Per-clip analysis for Chimera v2: ONE ``ClipAnalysis`` per clip, merged
from the client's ``known_analysis``, the sha256 disk cache and freshly
computed values.

This is the only place in the v2 engine that decodes audio (22.05 kHz mono,
and only when at least one field is missing). The field groups are:

* tempo      -- ``bpm`` / ``beats`` (aubio via :mod:`detect`, librosa fallback)
* key        -- ``key`` / ``scale`` / ``key_confidence`` / ``key_strength``
* material   -- ``percussive_ratio`` / ``low_band_fraction`` / ``lufs``
* structure  -- ``bars`` / downbeat + phrase phase (:mod:`structure`)

``duration_sec`` / ``samplerate`` ALWAYS come from the normalized file on
disk, never from the client. ``grid`` is always re-fitted (cheap). The cache
lives at ``data/cache/chimera/<sha256>.json`` (created lazily, never
evicted). Every time in seconds here is SOURCE time (pre-conform).
"""

from __future__ import annotations

import json
import logging
import math
import os
import tempfile
from pathlib import Path
from typing import Any, Mapping, Optional

import numpy as np
import soundfile as sf

from backend.modules.chimera import structure, tempo
from backend.modules.chimera.detect import detect_tempo_and_beats
from backend.modules.chimera.types import BarFeature, BeatGrid, ClipAnalysis, Phrase

__all__ = [
    "CACHE_DIR",
    "CACHE_VERSION",
    "ANALYSIS_SR",
    "DEFAULT_PHRASE_BARS",
    "analyze_clip",
    "cache_get",
    "cache_put",
    "empty_analysis",
    "fallback_phrases",
    "material_profile",
    "phrases_for",
    "sanitize_known",
    "to_known_analysis",
]

log = logging.getLogger(__name__)

CACHE_DIR = Path(__file__).resolve().parents[3] / "data" / "cache" / "chimera"
CACHE_VERSION = 2
ANALYSIS_SR = 22050
DEFAULT_PHRASE_BARS = 8
KEY_CHROMA_HOP = 2048

# Tonal gate (a clip below any of these is arranged as atonal: no pitch
# shift, never counted by the harmony solver).
TONAL_MIN_STRENGTH = 0.15
TONAL_MIN_CONFIDENCE = 0.45
TONAL_MAX_PERCUSSIVE = 0.7

# The detected BPM is replaced by 60 / fitted period when the grid is this
# confident and steady and the two agree within this fraction up to an
# octave (the BPM then follows the beat list's octave).
BPM_REFINE_MIN_CONFIDENCE = 0.5
BPM_REFINE_MAX_DEV = 0.08

_MATERIAL_MAX_SEC = 90.0
_LOW_BAND_HZ = 150.0
_HPSS_KERNEL = 31
_N_FFT = 2048
_HOP = 512
_DB_FLOOR = -120.0
_LUFS_MIN_SEC = 1.0

_KEY_FIELDS = ("key", "scale", "key_confidence", "key_strength")
_MATERIAL_FIELDS = ("percussive_ratio", "low_band_fraction", "lufs")
_STRUCTURE_FIELDS = (
    "bars",
    "downbeat_phase",
    "downbeat_confidence",
    "phrase_phase",
    "phrase_confidence",
)
# Fields whose provenance decides ClipAnalysis.source.
_SOURCE_FIELDS = ("bpm", "key", "percussive_ratio", "bars")

_STR_FIELDS = ("key", "scale", "entry_id", "sha256")
_FLOAT_FIELDS = (
    "key_confidence",
    "key_strength",
    "downbeat_confidence",
    "phrase_confidence",
    "lufs",
    "percussive_ratio",
    "low_band_fraction",
    "duration_sec",
    "confidence",
)
_INT_FIELDS = ("downbeat_phase", "phrase_phase", "phrase_bars", "samplerate")
# Client-supplied values that are never trusted for the analysis itself.
_CLIENT_IGNORED = ("duration_sec", "samplerate", "confidence", "sha256", "entry_id")
_KEY_DONE = "key_detected"


# --------------------------------------------------------------------------
# validation
# --------------------------------------------------------------------------


def _num(v: Any) -> Optional[float]:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    f = float(v)
    return f if math.isfinite(f) else None


def _int(v: Any) -> Optional[int]:
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return int(v)
    if isinstance(v, float) and math.isfinite(v) and float(v).is_integer():
        return int(v)
    return None


def _float_list(v: Any, n: Optional[int] = None) -> Optional[list[float]]:
    if not isinstance(v, list) or (n is not None and len(v) != n):
        return None
    out: list[float] = []
    for x in v:
        f = _num(x)
        if f is None:
            return None
        out.append(f)
    return out


def _clean_bar(b: Any) -> Optional[BarFeature]:
    if not isinstance(b, dict):
        return None
    bar = _int(b.get("bar"))
    start = _num(b.get("start_sec"))
    rms_db = _num(b.get("rms_db"))
    low_frac = _num(b.get("low_frac"))
    density = _num(b.get("onset_density"))
    centroid = _num(b.get("centroid_hz"))
    chroma = _float_list(b.get("chroma"), 12)
    mfcc = _float_list(b.get("mfcc"), 13)
    if None in (bar, start, rms_db, low_frac, density, centroid, chroma, mfcc):
        return None
    return {
        "bar": int(bar),  # type: ignore[arg-type]
        "start_sec": float(start),  # type: ignore[arg-type]
        "rms_db": float(rms_db),  # type: ignore[arg-type]
        "low_frac": float(low_frac),  # type: ignore[arg-type]
        "onset_density": float(density),  # type: ignore[arg-type]
        "centroid_hz": float(centroid),  # type: ignore[arg-type]
        "chroma": chroma,  # type: ignore[typeddict-item]
        "mfcc": mfcc,  # type: ignore[typeddict-item]
    }


def sanitize_known(entry: Any) -> Optional[dict[str, Any]]:
    """Validate one ``known_analysis`` entry (or a cache payload).

    Keeps only recognised keys with the right types: ``bpm`` + ``beats``
    (as a pair; ``bpm > 0`` and a non-empty numeric list), the string
    fields ``key`` / ``scale`` / ``entry_id`` / ``sha256``, the finite float
    and int fields, and ``bars`` (a non-empty list of valid ``BarFeature``
    dicts). Returns ``None`` when nothing usable is present.
    """
    if not isinstance(entry, dict):
        return None
    out: dict[str, Any] = {}
    bpm = _num(entry.get("bpm"))
    beats = _float_list(entry.get("beats"))
    if bpm is not None and bpm > 0 and beats:
        out["bpm"] = float(bpm)
        out["beats"] = beats
    for k in _STR_FIELDS:
        v = entry.get(k)
        if isinstance(v, str) and v.strip():
            out[k] = v.strip()
    for k in _FLOAT_FIELDS:
        v = _num(entry.get(k))
        if v is not None:
            out[k] = v
    for k in _INT_FIELDS:
        v = _int(entry.get(k))
        if v is not None:
            out[k] = v
    bars = entry.get("bars")
    if isinstance(bars, list) and bars:
        cleaned = [_clean_bar(b) for b in bars]
        if all(b is not None for b in cleaned):
            out["bars"] = cleaned
    return out or None


# --------------------------------------------------------------------------
# cache
# --------------------------------------------------------------------------


def _cache_path(sha: str) -> Path:
    return CACHE_DIR / f"{sha}.json"


def cache_get(sha: Optional[str]) -> Optional[dict[str, Any]]:
    """Cached analysis payload for ``sha`` (version-checked), else ``None``.
    Corrupt or unreadable files are ignored."""
    if not sha:
        return None
    p = _cache_path(sha)
    try:
        with open(p, encoding="utf-8") as f:
            payload = json.load(f)
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as e:
        log.info("chimera analysis cache: ignoring %s (%s)", p.name, e)
        return None
    if not isinstance(payload, dict) or payload.get("v") != CACHE_VERSION:
        return None
    return payload


def cache_put(sha: Optional[str], payload: Mapping[str, Any]) -> None:
    """Atomically write ``payload`` (plus ``v``/``sha256``) for ``sha``.
    Creates ``data/cache/chimera`` on first use; failures are logged."""
    if not sha:
        return
    data = dict(payload)
    data["v"] = CACHE_VERSION
    data["sha256"] = sha
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(
            prefix=f".{sha[:12]}-", suffix=".tmp", dir=CACHE_DIR
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(data, f, separators=(",", ":"))
            os.replace(tmp_name, _cache_path(sha))
        except BaseException:
            try:
                os.unlink(tmp_name)
            except OSError:
                pass
            raise
    except (OSError, TypeError, ValueError) as e:
        log.warning("chimera analysis cache: could not write %s: %s", sha[:12], e)


# --------------------------------------------------------------------------
# features
# --------------------------------------------------------------------------


def _mono(y: np.ndarray) -> np.ndarray:
    a = np.asarray(y, dtype=np.float32)
    if a.ndim == 2:
        a = a.mean(axis=1).astype(np.float32)
    return np.ascontiguousarray(a)


def _rms_db(y: np.ndarray) -> float:
    a = np.asarray(y, dtype=np.float64)
    if a.size == 0:
        return _DB_FLOOR
    rms = float(np.sqrt(np.mean(a * a)))
    return float(max(_DB_FLOOR, 20.0 * math.log10(max(rms, 1e-6))))


def _integrated_lufs(y: np.ndarray, sr: int) -> float:
    """pyloudnorm integrated loudness, falling back to RMS dBFS when the
    clip is too short or the meter gates it to -inf."""
    yy = _mono(y)
    if yy.size >= int(_LUFS_MIN_SEC * sr):
        try:
            import warnings

            import pyloudnorm as pyln

            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                v = float(pyln.Meter(int(sr)).integrated_loudness(yy))
            if math.isfinite(v):
                return float(max(_DB_FLOOR, v))
        except Exception as e:  # pragma: no cover - defensive
            log.debug("pyloudnorm failed (%s); using rms", e)
    return _rms_db(yy)


def material_profile(y: np.ndarray, sr: int) -> tuple[float, float, float]:
    """``(percussive_ratio, low_band_fraction, lufs)`` of ``y`` (mono).

    HPSS (kernel 31) over the first 90 s: ``percussive_ratio = P^2 /
    (H^2 + P^2)``; ``low_band_fraction`` is the < 150 Hz share of the STFT
    power; ``lufs`` is the integrated loudness of the WHOLE clip (RMS dBFS
    when pyloudnorm cannot gate it).
    """
    import librosa

    yy = _mono(y)
    lufs = _integrated_lufs(yy, sr)
    seg = yy[: int(_MATERIAL_MAX_SEC * sr)]
    if seg.size < _N_FFT:
        return 0.5, 0.0, lufs
    S = np.abs(librosa.stft(seg, n_fft=_N_FFT, hop_length=_HOP))
    power = S.astype(np.float64) ** 2
    total = float(power.sum())
    if total <= 0.0:
        return 0.5, 0.0, lufs
    H, P = librosa.decompose.hpss(S, kernel_size=_HPSS_KERNEL)
    eh = float(np.sum(H.astype(np.float64) ** 2))
    ep = float(np.sum(P.astype(np.float64) ** 2))
    perc = ep / (eh + ep) if (eh + ep) > 0 else 0.5
    freqs = librosa.fft_frequencies(sr=sr, n_fft=_N_FFT)
    low = float(power[freqs < _LOW_BAND_HZ].sum())
    return (
        float(min(1.0, max(0.0, perc))),
        float(min(1.0, max(0.0, low / total))),
        float(lufs),
    )


def _decode(path: Path) -> tuple[np.ndarray, int]:
    import librosa

    y, sr = librosa.load(str(path), sr=ANALYSIS_SR, mono=True)
    return np.asarray(y, dtype=np.float32), int(sr)


# --------------------------------------------------------------------------
# tempo pass: detector cross-check + grid coherence
# --------------------------------------------------------------------------


def _grid_octave(grid: BeatGrid, bpm: float) -> Optional[float]:
    """Multiplier ``m`` in (1, 0.5, 2) with ``60 / period ~= m * bpm`` within
    ``BPM_REFINE_MAX_DEV``, else ``None`` (beats and BPM disagree)."""
    period = float(grid.get("period_sec") or 0.0)
    if bpm <= 0 or period <= 0:
        return None
    grid_bpm = 60.0 / period
    for m in (1.0, 0.5, 2.0):
        if abs(grid_bpm / (m * bpm) - 1.0) <= BPM_REFINE_MAX_DEV:
            return m
    return None


def _coverage(grid: BeatGrid, duration: float) -> float:
    """Fraction of the clip the kept beats span at the fitted period."""
    period = float(grid.get("period_sec") or 0.0)
    if duration <= 0 or period <= 0:
        return 0.0
    return min(1.0, len(grid.get("kept_beats") or []) * period / duration)


def _beats_acceptable(det: Mapping[str, Any], grid: BeatGrid, duration: float) -> bool:
    bpm = det.get("bpm")
    return bool(
        bpm
        and len(det.get("beats") or []) >= 8
        and float(grid["confidence"]) >= BPM_REFINE_MIN_CONFIDENCE
        and _grid_octave(grid, float(bpm)) is not None
        and _coverage(grid, duration) >= 0.5
    )


def _beats_quality(det: Mapping[str, Any], grid: BeatGrid, duration: float) -> float:
    if not det.get("bpm") or not det.get("beats"):
        return 0.0
    return _coverage(grid, duration) * float(grid["confidence"])


def _nominal_grid(bpm: float, beats: list[float]) -> BeatGrid:
    """Grid at exactly ``60 / bpm`` anchored on the first beat; confidence
    0.3 (structure synthesises bars from it) but never ``steady`` (no lock)."""
    return {
        "period_sec": 60.0 / float(bpm),
        "phase_sec": float(beats[0]) if beats else 0.0,
        "drift_pct": 0.0,
        "cv": 1.0,
        "confidence": 0.3,
        "kept_beats": [float(b) for b in beats],
        "steady": False,
    }


def _tempo_pass(
    path: Path, y: np.ndarray, sr: int, duration: float
) -> tuple[dict[str, Any], BeatGrid]:
    """Tempo + beats with a tracker cross-check.

    ``detect_tempo_and_beats`` (aubio first) is the source of truth for the
    BPM; its beat list is accepted when it is dense (covers >= 50 % of the
    clip), fits a confident grid and agrees with the BPM up to an octave.
    Otherwise the librosa tracker is run on the shared decode and its list
    replaces aubio's when it is acceptable or simply better (aubio returns a
    sparse, irregular list for a bare click track, for instance).
    """
    from backend.modules.chimera.detect import _detect_librosa

    det: dict[str, Any] = dict(detect_tempo_and_beats(path, y_sr=(y, sr)))
    grid = tempo.fit_beat_grid(det["beats"], det["bpm"])
    if _beats_acceptable(det, grid, duration):
        return det, grid
    try:
        alt: dict[str, Any] = dict(_detect_librosa(path, y_sr=(y, sr)))
    except Exception as e:  # pragma: no cover - defensive
        log.info(
            "chimera analysis: librosa cross-check failed for %s: %s", path.name, e
        )
        return det, grid
    alt_grid = tempo.fit_beat_grid(alt["beats"], alt["bpm"])
    if _beats_acceptable(alt, alt_grid, duration) or _beats_quality(
        alt, alt_grid, duration
    ) > _beats_quality(det, grid, duration):
        log.info(
            "chimera analysis: %s beat list from the first tracker rejected "
            "(%d beats, grid conf %.2f, coverage %.2f); using librosa "
            "(%d beats, grid conf %.2f, coverage %.2f)",
            path.name,
            len(det["beats"]),
            grid["confidence"],
            _coverage(grid, duration),
            len(alt["beats"]),
            alt_grid["confidence"],
            _coverage(alt_grid, duration),
        )
        return alt, alt_grid
    return det, grid


def _file_info(path: Path) -> Optional[tuple[float, int]]:
    try:
        info = sf.info(str(path))
    except Exception as e:
        log.info("chimera analysis: sf.info failed for %s (%s)", path.name, e)
        return None
    sr = int(info.samplerate)
    frames = int(info.frames)
    return (float(frames) / float(sr) if sr > 0 else 0.0), sr


# --------------------------------------------------------------------------
# main entry
# --------------------------------------------------------------------------


def empty_analysis(norm_path: Path | str) -> ClipAnalysis:
    """A beatless, atonal ``ClipAnalysis`` for a clip whose analysis failed
    (duration still read from disk when possible)."""
    info = _file_info(Path(norm_path))
    duration, sr = info if info else (0.0, 0)
    return {
        "bpm": None,
        "beats": [],
        "confidence": 0.0,
        "duration_sec": float(duration),
        "samplerate": int(sr),
        "key": None,
        "scale": None,
        "key_confidence": None,
        "key_strength": None,
        "lufs": _DB_FLOOR,
        "percussive_ratio": 0.5,
        "low_band_fraction": 0.0,
        "grid": tempo.fit_beat_grid([], None),
        "downbeat_phase": 0,
        "downbeat_confidence": 0.0,
        "phrase_phase": 0,
        "phrase_confidence": 0.0,
        "bars": [],
        "tonal": False,
        "source": "computed",
    }


def _is_tonal(vals: Mapping[str, Any]) -> bool:
    key = vals.get("key")
    if not key:
        return False
    strength = vals.get("key_strength")
    conf = vals.get("key_confidence")
    perc = vals.get("percussive_ratio")
    return bool(
        float(strength or 0.0) >= TONAL_MIN_STRENGTH
        and float(conf or 0.0) >= TONAL_MIN_CONFIDENCE
        and float(0.5 if perc is None else perc) < TONAL_MAX_PERCUSSIVE
    )


def analyze_clip(
    norm_path: Path | str,
    *,
    known: Optional[Mapping[str, Any]] = None,
    sha: Optional[str] = None,
    phrase_bars: int = DEFAULT_PHRASE_BARS,
    need_structure: bool = True,
) -> ClipAnalysis:
    """Build the ``ClipAnalysis`` for one normalized clip.

    1. start from the sha256 cache (when ``sha``), then overlay the client's
       ``known`` fields (``bpm`` + ``beats``, key group, material group,
       structure group; ``duration_sec`` is ALWAYS read from the file);
    2. decode at 22.05 kHz mono ONLY when a field group is missing;
    3. compute the missing groups (tempo -> key -> material -> structure);
    4. re-fit the beat grid (always), reconcile the phrase phase with
       ``phrase_bars`` (cheap, from the bar table);
    5. ``tonal`` = key present, strength >= 0.15, confidence >= 0.45 and
       percussive_ratio < 0.7; ``source`` in client|cache|computed|mixed;
    6. write the cache when anything was computed.
    """
    path = Path(norm_path)
    P = max(1, int(phrase_bars))
    vals: dict[str, Any] = {}
    src: dict[str, str] = {}

    cached = cache_get(sha) if sha else None
    if cached:
        clean = sanitize_known(cached) or {}
        for k, v in clean.items():
            if k in ("sha256", "entry_id"):
                continue
            vals[k] = v
            src[k] = "cache"
        if cached.get(_KEY_DONE):
            # a cached "no key found" is a result, not a gap
            for k in _KEY_FIELDS:
                vals.setdefault(k, None)
                src.setdefault(k, "cache")
    if known:
        clean = sanitize_known(known) or {}
        for k, v in clean.items():
            if k in _CLIENT_IGNORED:
                continue
            vals[k] = v
            src[k] = "client"
        if "key" in clean:
            # the client's key group replaces the cached one wholesale so a
            # cached strength never describes a different winner
            for k in _KEY_FIELDS:
                if k not in clean:
                    vals.pop(k, None)
                    src.pop(k, None)
    if ("bpm" in vals) != ("beats" in vals):
        vals.pop("bpm", None)
        vals.pop("beats", None)
        src.pop("bpm", None)
        src.pop("beats", None)

    info = _file_info(path)
    y: Optional[np.ndarray] = None
    sr = ANALYSIS_SR
    if info is None:
        y, sr = _decode(path)
        duration = float(y.size) / float(sr) if sr > 0 else 0.0
        samplerate = int(sr)
    else:
        duration, samplerate = info

    need_tempo = "bpm" not in vals
    # a key without its strength cannot pass the tonal gate: redo the group
    need_key = "key" not in src or (
        vals.get("key") is not None and vals.get("key_strength") is None
    )
    need_material = any(k not in vals for k in _MATERIAL_FIELDS)
    need_struct = need_structure and (
        "bars" not in vals or "downbeat_phase" not in vals
    )
    computed: list[str] = []

    if y is None and (need_tempo or need_key or need_material or need_struct):
        y, sr = _decode(path)

    grid: Optional[BeatGrid] = None
    if need_tempo:
        assert y is not None
        det, grid = _tempo_pass(path, y, sr, duration)
        vals["bpm"] = det["bpm"]
        vals["beats"] = [float(b) for b in det["beats"]]
        vals["confidence"] = float(det["confidence"])
        src["bpm"] = src["beats"] = "computed"
        computed.append("tempo")
    elif "confidence" not in vals:
        vals["confidence"] = 1.0

    if need_key:
        assert y is not None
        from backend.modules.analysis.key import detect_key

        try:
            ki = detect_key(path, y_sr=(y, sr), chroma_hop=KEY_CHROMA_HOP)
        except Exception as e:
            log.warning(
                "chimera analysis: key detection failed for %s: %s", path.name, e
            )
            ki = {"key": None, "scale": None, "confidence": None, "strength": None}
        vals["key"] = ki.get("key")
        vals["scale"] = ki.get("scale")
        vals["key_confidence"] = ki.get("confidence")
        vals["key_strength"] = ki.get("strength")
        for k in _KEY_FIELDS:
            src[k] = "computed"
        computed.append("key")

    if need_material:
        assert y is not None
        try:
            perc, low_frac, lufs = material_profile(y, sr)
        except Exception as e:
            log.warning(
                "chimera analysis: material profile failed for %s: %s", path.name, e
            )
            perc, low_frac, lufs = 0.5, 0.0, _rms_db(y)
        vals["percussive_ratio"] = perc
        vals["low_band_fraction"] = low_frac
        vals["lufs"] = lufs
        for k in _MATERIAL_FIELDS:
            src[k] = "computed"
        computed.append("material")

    beats = [float(b) for b in (vals.get("beats") or [])]
    bpm = vals.get("bpm")
    if grid is None:
        grid = tempo.fit_beat_grid(beats, float(bpm) if bpm else None)
    bpm_raw = bpm
    if bpm and beats:
        m = _grid_octave(grid, float(bpm))
        if (
            m is not None
            and grid["confidence"] >= BPM_REFINE_MIN_CONFIDENCE
            and grid["steady"]
        ):
            # The detector's BPM is a smoothed estimate (aubio reads a 124
            # BPM synth as 125.8) and may even sit an octave away from its
            # own beat list; the fitted period IS the beat list, and every
            # downstream step (octave choice, bar table, grid lock) is keyed
            # to the beats, so the BPM follows them.
            bpm = 60.0 / float(grid["period_sec"])
            vals["bpm"] = bpm
        elif m is None:
            # beats and BPM disagree by a non-octave factor: the beat list
            # is junk for grid purposes; synthesise a nominal grid from the
            # BPM so the bar table is at least the right size (no lock).
            grid = _nominal_grid(float(bpm), beats)

    if need_struct:
        assert y is not None
        st = structure.analyze_structure(y, sr, grid, P)
        vals["bars"] = st["bars"]
        vals["downbeat_phase"] = int(st["downbeat_phase"])
        vals["downbeat_confidence"] = float(st["downbeat_confidence"])
        vals["phrase_phase"] = int(st["phrase_phase"])
        vals["phrase_confidence"] = float(st["phrase_confidence"])
        vals["phrase_bars"] = P
        for k in _STRUCTURE_FIELDS:
            src[k] = "computed"
        computed.append("structure")
    elif need_structure and (
        "phrase_phase" not in vals
        or int(vals.get("phrase_bars", DEFAULT_PHRASE_BARS)) != P
    ):
        # the bar table is phrase-length agnostic; only the phase depends on P
        q, q_conf = structure.estimate_phrase_phase(vals.get("bars") or [], P)
        vals["phrase_phase"] = int(q)
        vals["phrase_confidence"] = float(q_conf)
        vals["phrase_bars"] = P

    for k, default in (
        ("bars", []),
        ("downbeat_phase", 0),
        ("downbeat_confidence", 0.0),
        ("phrase_phase", 0),
        ("phrase_confidence", 0.0),
        ("lufs", _DB_FLOOR),
        ("percussive_ratio", 0.5),
        ("low_band_fraction", 0.0),
        ("key", None),
        ("scale", None),
        ("key_confidence", None),
        ("key_strength", None),
    ):
        vals.setdefault(k, default)

    origins = {src[k] for k in _SOURCE_FIELDS if k in src}
    if computed:
        origins.add("computed")
    if len(origins) == 1:
        source = origins.pop()
    elif not origins:
        source = "computed"
    else:
        source = "mixed"

    result: ClipAnalysis = {
        "bpm": float(bpm) if bpm else None,
        "beats": beats,
        "confidence": float(vals.get("confidence", 0.0)),
        "duration_sec": float(duration),
        "samplerate": int(samplerate),
        "key": vals.get("key"),
        "scale": vals.get("scale"),
        "key_confidence": vals.get("key_confidence"),
        "key_strength": vals.get("key_strength"),
        "lufs": float(vals["lufs"]),
        "percussive_ratio": float(vals["percussive_ratio"]),
        "low_band_fraction": float(vals["low_band_fraction"]),
        "grid": grid,
        "downbeat_phase": int(vals["downbeat_phase"]),
        "downbeat_confidence": float(vals["downbeat_confidence"]),
        "phrase_phase": int(vals["phrase_phase"]),
        "phrase_confidence": float(vals["phrase_confidence"]),
        "bars": list(vals["bars"]),
        "tonal": _is_tonal(vals),
        "source": source,  # type: ignore[typeddict-item]
    }
    log.info(
        "chimera analysis: %s bpm=%s (raw %s) beats=%d key=%s %s (conf %s, "
        "strength %s) perc=%.2f lufs=%.1f bars=%d downbeat=%d (%.2f) "
        "phrase=%d (%.2f) grid conf=%.2f steady=%s source=%s computed=%s",
        path.name,
        f"{result['bpm']:.2f}" if result["bpm"] else None,
        f"{float(bpm_raw):.2f}" if bpm_raw else None,
        len(beats),
        result["key"],
        result["scale"],
        None if result["key_confidence"] is None else f"{result['key_confidence']:.2f}",
        None if result["key_strength"] is None else f"{result['key_strength']:.2f}",
        result["percussive_ratio"],
        result["lufs"],
        len(result["bars"]),
        result["downbeat_phase"],
        result["downbeat_confidence"],
        result["phrase_phase"],
        result["phrase_confidence"],
        grid["confidence"],
        grid["steady"],
        source,
        computed or "-",
    )

    if sha and computed:
        payload = _cache_payload(result, P)
        payload[_KEY_DONE] = "key" in src
        cache_put(sha, payload)
    return result


def _cache_payload(a: ClipAnalysis, phrase_bars: int) -> dict[str, Any]:
    """Everything in ``ClipAnalysis`` except the derived ``grid`` / ``tonal``
    / ``source`` (beats included: they let an ``entry_id``-only request skip
    the detector next time)."""
    return {
        "bpm": a["bpm"],
        "beats": list(a["beats"]),
        "confidence": a["confidence"],
        "duration_sec": a["duration_sec"],
        "samplerate": a["samplerate"],
        "key": a["key"],
        "scale": a["scale"],
        "key_confidence": a["key_confidence"],
        "key_strength": a["key_strength"],
        "lufs": a["lufs"],
        "percussive_ratio": a["percussive_ratio"],
        "low_band_fraction": a["low_band_fraction"],
        "downbeat_phase": a["downbeat_phase"],
        "downbeat_confidence": a["downbeat_confidence"],
        "phrase_phase": a["phrase_phase"],
        "phrase_confidence": a["phrase_confidence"],
        "phrase_bars": int(phrase_bars),
        "bars": list(a["bars"]),
    }


# --------------------------------------------------------------------------
# phrase tables
# --------------------------------------------------------------------------


def phrases_for(
    a: ClipAnalysis | Mapping[str, Any],
    phrase_bars: int,
    y_sr: Optional[tuple[np.ndarray, int]] = None,
) -> list[Phrase]:
    """Phrase table (SOURCE seconds) for ``a`` at ``phrase_bars`` bars per
    phrase: ``structure.build_phrases`` over the bar table. Pass ``y_sr`` to
    get integrated LUFS per phrase; without audio the bar RMS is used."""
    bars = list(a.get("bars") or [])
    if not bars:
        return []
    grid = a.get("grid")
    bar_sec: Optional[float] = None
    if grid and float(grid.get("confidence") or 0.0) >= 0.3:
        period = float(grid.get("period_sec") or 0.0)
        if period > 0:
            bar_sec = period * structure.BEATS_PER_BAR
    y, sr = y_sr if y_sr is not None else (None, None)
    return structure.build_phrases(
        bars,
        int(a.get("phrase_phase") or 0),
        int(phrase_bars),
        y,
        sr,
        bar_sec=bar_sec,
    )


def fallback_phrases(
    duration_sec: float,
    bar_sec_source: float,
    phrase_bars: int,
    lufs: float,
) -> list[Phrase]:
    """Phrase table for a clip WITHOUT a beat grid: bars of ``bar_sec_source``
    seconds from the clip start (SOURCE time), all at the clip's LUFS, so the
    arranger can still place it (v1 also kept beatless clips)."""
    if duration_sec <= 0 or bar_sec_source <= 0:
        return []
    n_bars = int(math.floor(duration_sec / bar_sec_source + 1e-9))
    if n_bars <= 0:
        n_bars = 1
    level = float(lufs) if math.isfinite(float(lufs)) else _DB_FLOOR
    bars: list[BarFeature] = [
        {
            "bar": i,
            "start_sec": float(i * bar_sec_source),
            "rms_db": level,
            "low_frac": 0.0,
            "onset_density": 0.0,
            "centroid_hz": 0.0,
            "chroma": [0.0] * 12,
            "mfcc": [0.0] * 13,
        }
        for i in range(n_bars)
    ]
    return structure.build_phrases(bars, 0, int(phrase_bars), bar_sec=bar_sec_source)


# --------------------------------------------------------------------------
# /analyze echo
# --------------------------------------------------------------------------


def to_known_analysis(a: ClipAnalysis | Mapping[str, Any]) -> dict[str, Any]:
    """What ``POST /api/chimera/analyze`` returns so the client can echo it
    back verbatim inside ``known_analysis``."""
    grid = a.get("grid") or {}
    return {
        "bpm": a.get("bpm"),
        "beats": list(a.get("beats") or []),
        "duration_sec": a.get("duration_sec"),
        "key": a.get("key"),
        "scale": a.get("scale"),
        "key_confidence": a.get("key_confidence"),
        "key_strength": a.get("key_strength"),
        "downbeat_phase": int(a.get("downbeat_phase") or 0),
        "downbeat_confidence": float(a.get("downbeat_confidence") or 0.0),
        "phrase_phase": int(a.get("phrase_phase") or 0),
        "phrase_confidence": float(a.get("phrase_confidence") or 0.0),
        "lufs": float(a.get("lufs", _DB_FLOOR)),
        "percussive_ratio": float(a.get("percussive_ratio", 0.5)),
        "low_band_fraction": float(a.get("low_band_fraction", 0.0)),
        "bars": list(a.get("bars") or []),
        "beat_grid": {
            "period_sec": float(grid.get("period_sec", 0.0)),
            "phase_sec": float(grid.get("phase_sec", 0.0)),
            "confidence": float(grid.get("confidence", 0.0)),
            "steady": bool(grid.get("steady", False)),
        },
    }
