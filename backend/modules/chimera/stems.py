"""Read-only access to cached Demucs stems for library clips (Chimera v2).

This module NEVER triggers separation. It only looks up stems that the
stems module already wrote for a library entry and, when a usable set is
present, sums them into the two role sources the arranger knows about:

* ``found``  = drums + bass   (the rhythmic foundation of the lead lane)
* ``layer``  = vocals + other (+ guitar / piano from 6-stem models)

Everything here is optional-with-fallback: any failure (no library, no DB,
unknown entry, missing files, unreadable WAVs, a partial set that cannot
form BOTH groups) returns ``None`` and the router silently uses the full
mix instead. Nothing raises past the public functions.

All audio written by :func:`build_role_sources` is stereo float32 WAV at
``out_sr`` in the SOURCE timebase (pre-conform) — the same timebase as the
normalized full mix, so the router can run the same conform plan over a
role source as over the full clip.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Optional

import numpy as np

log = logging.getLogger(__name__)

try:  # pragma: no cover - exercised implicitly; the fallback is for slim installs
    from backend.modules.library.router import get_store
except Exception as _import_err:  # noqa: BLE001 - any import failure degrades to "no stems"
    _IMPORT_ERROR: Optional[BaseException] = _import_err

    def get_store():  # type: ignore[misc]
        raise RuntimeError(f"library store unavailable: {_IMPORT_ERROR}")


# Stem names (lower-cased) that form each role group. Demucs 4-stem models
# emit drums / bass / vocals / other; htdemucs_6s adds guitar / piano, which
# belong with the harmonic layer so found + layer still covers the full mix.
FOUND_STEMS: tuple[str, ...] = ("drums", "bass")
LAYER_STEMS: tuple[str, ...] = ("vocals", "other", "guitar", "piano")

FOUND_FILENAME = "stems_found.wav"
LAYER_FILENAME = "stems_layer.wav"


# ---------------------------------------------------------------------------
# Lookup
# ---------------------------------------------------------------------------


def _candidate_paths(raw: str, root: Optional[Path], entry_id: str) -> list[Path]:
    """Absolute rows are used as-is. Relative rows are tried against the
    library root, the entry folder and the entry's ``stems`` folder — the
    conventions ``backend/modules/stems/engine.py`` writes
    (``<root>/<entry_id>/stems/<name>.wav``)."""
    p = Path(raw)
    if p.is_absolute() or root is None:
        return [p]
    return [
        root / p,
        root / entry_id / p,
        root / entry_id / "stems" / p.name,
    ]


def resolve_cached_stems(entry_id: Optional[str]) -> Optional[dict[str, Path]]:
    """Return ``{stem_name: absolute path}`` for the cached stems of a library
    entry, or ``None`` when the entry is unknown, has no stems, or the
    library cannot be reached. Only files that exist on disk are returned.
    Never raises and never triggers separation."""
    if not entry_id:
        return None
    try:
        store = get_store()
        db = getattr(store, "db", None)
        if db is None:
            log.info("chimera.stems: library DB disabled; no stems for %s", entry_id)
            return None
        rows: list[dict[str, Any]] = list(db.list_stems(entry_id) or [])
    except Exception as e:  # noqa: BLE001 - lookup failure degrades to the full mix
        log.info("chimera.stems: stem lookup failed for %s: %s", entry_id, e)
        return None

    root_raw = getattr(store, "root", None)
    root = Path(root_raw) if root_raw is not None else None

    out: dict[str, Path] = {}
    for row in rows:
        name = str(row.get("stem_name") or "").strip()
        raw_path = row.get("audio_path")
        if not name or not raw_path:
            continue
        for cand in _candidate_paths(str(raw_path), root, entry_id):
            try:
                if cand.is_file():
                    out[name] = cand.resolve()
                    break
            except OSError:
                continue
        else:
            log.info(
                "chimera.stems: stem %r of %s missing on disk (%s)",
                name,
                entry_id,
                raw_path,
            )
    if not out:
        return None
    log.info("chimera.stems: %s has cached stems %s", entry_id, sorted(out))
    return out


# ---------------------------------------------------------------------------
# Role sources
# ---------------------------------------------------------------------------


def _to_stereo(audio: np.ndarray) -> np.ndarray:
    arr = np.asarray(audio, dtype=np.float32)
    if arr.ndim == 1:
        arr = np.stack([arr, arr], axis=1)
    elif arr.shape[1] == 1:
        arr = np.repeat(arr, 2, axis=1)
    elif arr.shape[1] > 2:
        arr = arr[:, :2]
    return np.ascontiguousarray(arr, dtype=np.float32)


def _load_stem(path: Path, out_sr: int) -> np.ndarray:
    """Read one stem as stereo float32 ``[N, 2]`` at ``out_sr``."""
    import soundfile as sf

    audio, sr = sf.read(str(path), dtype="float32", always_2d=True)
    stereo = _to_stereo(audio)
    if int(sr) != int(out_sr):
        import librosa

        # librosa works on the last axis -> transpose to [2, N] and back.
        resampled = librosa.resample(
            stereo.T.astype(np.float32, copy=False),
            orig_sr=int(sr),
            target_sr=int(out_sr),
        )
        stereo = np.ascontiguousarray(resampled.T, dtype=np.float32)
    return stereo


def _sum_group(paths: list[Path], out_sr: int) -> np.ndarray:
    parts = [_load_stem(p, out_sr) for p in paths]
    n = max(p.shape[0] for p in parts)
    acc = np.zeros((n, 2), dtype=np.float32)
    for p in parts:
        acc[: p.shape[0]] += p
    return acc


def _pick(stems: dict[str, Path], names: tuple[str, ...]) -> list[Path]:
    lowered = {str(k).strip().lower(): v for k, v in stems.items()}
    return [lowered[n] for n in names if n in lowered]


def build_role_sources(
    stems: Optional[dict[str, Path]], work_dir: Path, out_sr: int
) -> Optional[dict[str, Path]]:
    """Sum cached stems into ``{'found': path, 'layer': path}`` WAVs.

    ``found`` = drums + bass, ``layer`` = vocals + other (+ guitar / piano).
    Each group needs at least one stem present; when EITHER group cannot be
    formed the whole thing returns ``None`` and the caller uses the full
    mix. Output WAVs are stereo float32 at ``out_sr`` in ``work_dir``.
    Never raises."""
    if not stems:
        return None
    found_paths = _pick(stems, FOUND_STEMS)
    layer_paths = _pick(stems, LAYER_STEMS)
    if not found_paths or not layer_paths:
        log.info(
            "chimera.stems: partial stem set %s cannot form both groups; using full mix",
            sorted(stems),
        )
        return None
    try:
        import soundfile as sf

        work_dir = Path(work_dir)
        work_dir.mkdir(parents=True, exist_ok=True)
        found = _sum_group(found_paths, int(out_sr))
        layer = _sum_group(layer_paths, int(out_sr))
        found_path = work_dir / FOUND_FILENAME
        layer_path = work_dir / LAYER_FILENAME
        sf.write(str(found_path), found, int(out_sr), subtype="FLOAT")
        sf.write(str(layer_path), layer, int(out_sr), subtype="FLOAT")
    except Exception as e:  # noqa: BLE001 - any DSP/IO failure degrades to the full mix
        log.warning("chimera.stems: role source build failed: %s", e)
        return None
    log.info(
        "chimera.stems: role sources built (found=%s, layer=%s, %d frames @ %d Hz)",
        [p.name for p in found_paths],
        [p.name for p in layer_paths],
        max(found.shape[0], layer.shape[0]),
        int(out_sr),
    )
    return {"found": found_path, "layer": layer_path}
