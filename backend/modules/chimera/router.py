from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import statistics
import tempfile
import time
from pathlib import Path
from typing import Any, Optional

import numpy as np
import soundfile as sf
from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from . import analysis, arrange, conform, master, render, stems, tempo
from .config import probe
from .detect import detect_tempo_and_beats
from .harmony import KeyInput, camelot_code, choose_target_key, prompt_hint
from .mix import mix_clips
from .stretch import normalize_to_target, stretch_audio
from .types import ClipAnalysis, RunAudio
from .weave import (
    BEATS_PER_BAR,
    MAX_POLYPHONY,
    bar_duration_sec,
    compute_chunks_sequential,
    resolve_chunk_bars,
    resolve_total_bars,
    scale_beats,
    schedule_song_arc,
)

log = logging.getLogger(__name__)

router = APIRouter()

# Cap on how many ffmpeg / librosa workers run at once during a mashup. ffmpeg
# is itself multi-threaded, so a small cap parallelizes the per-clip decode /
# stretch / detect (and, for the v2 engine, the per-run conforms) without
# thrashing the box.
_MASHUP_CONCURRENCY = 3

_ENGINES = ("v2", "v1")
_HARMONY_MODES = ("auto", "off")
_ARCS = ("song", "rise", "flat")
_GRID_LOCK_MODES = ("auto", "off")
_MAX_PITCH_SHIFT_CAP = 3


@router.get("/probe")
def chimera_probe():
    """Return toolchain availability so the frontend can show a status indicator."""
    return probe()


@router.post("/probe/refresh")
def chimera_probe_refresh():
    """Force a re-detection (useful after installing ffmpeg/aubio without a restart)."""
    return probe(force=True)


async def _save_upload(upload: UploadFile, path: Path) -> str:
    """Stream an upload to ``path`` and return the sha256 of its bytes."""
    h = hashlib.sha256()
    with open(path, "wb") as f:
        while chunk := await upload.read(1 << 20):
            f.write(chunk)
            h.update(chunk)
    return h.hexdigest()


@router.post("/analyze")
async def chimera_analyze(file: UploadFile = File(...)) -> dict[str, Any]:
    """Analyze ONE uploaded clip: BPM + per-beat times + musical key, plus the
    v2 structure / material fields the client echoes back in known_analysis.

    Powers the Chimera stack's analyze-on-add (BPM/key badges and the CRISPR
    DNA beat rungs) for clips that have no library entry. Runs the full
    ``analysis.analyze_clip`` (sha256-cached under data/cache/chimera) so a
    later mashup of the same bytes skips every detector.
    """
    with tempfile.TemporaryDirectory(prefix="chimera_an_") as tmpdir:
        tmp = Path(tmpdir)
        suffix = Path(file.filename or "").suffix or ".bin"
        raw_path = tmp / f"raw{suffix}"
        sha = await _save_upload(file, raw_path)

        # Normalize to wav when ffmpeg is around (lets aubio open it on
        # Windows); otherwise run the detector on the raw file and rely on
        # its librosa fallback for compressed formats.
        detect_path = raw_path
        if probe()["ffmpeg"]:
            norm_path = tmp / "norm.wav"
            try:
                normalize_to_target(
                    raw_path, norm_path, target_sr=44100, target_channels=2
                )
                detect_path = norm_path
            except RuntimeError:
                detect_path = raw_path

        try:
            a = await asyncio.to_thread(
                analysis.analyze_clip,
                detect_path,
                known=None,
                sha=sha,
                phrase_bars=analysis.DEFAULT_PHRASE_BARS,
            )
        except Exception as e:
            raise HTTPException(400, f"could not analyze {file.filename!r}: {e}") from e

        body: dict[str, Any] = {
            "bpm": a["bpm"],
            "beats": a["beats"],
            "duration_sec": a["duration_sec"],
            "confidence": a["confidence"],
            "samplerate": a["samplerate"],
            "key": a["key"],
            "scale": a["scale"],
            "key_confidence": a["key_confidence"],
        }
        body.update(analysis.to_known_analysis(a))
        body["sha256"] = sha
        return body


def _parse_target_bpm(raw: str) -> Optional[float]:
    if raw is None:
        return None
    s = raw.strip().lower()
    if s in ("", "auto"):
        return None
    try:
        v = float(s)
    except ValueError:
        raise HTTPException(400, f"target_bpm must be a number or 'auto', got {raw!r}")
    if v <= 0:
        return None
    return v


def _parse_enum(raw: Optional[str], allowed: tuple[str, ...], name: str) -> str:
    v = (raw or "").strip().lower()
    if v not in allowed:
        raise HTTPException(400, f"unknown {name}: {raw!r} (expected one of {allowed})")
    return v


def _parse_bool(raw: Optional[str], default: bool = True) -> bool:
    v = (raw or "").strip().lower()
    if not v:
        return default
    if v in ("1", "true", "yes", "on"):
        return True
    if v in ("0", "false", "no", "off"):
        return False
    raise HTTPException(400, f"expected a boolean, got {raw!r}")


def _parse_known_analysis(raw: str, n: int) -> list[Optional[dict[str, Any]]]:
    """Client-supplied per-clip analysis (from analyze-on-add).

    A JSON array aligned with the uploaded files; entries are dicts or null.
    v1 shape: {bpm, beats[], duration_sec}. v2 adds the optional keys key,
    scale, key_confidence, key_strength, entry_id, downbeat_phase,
    downbeat_confidence, phrase_phase, phrase_confidence, lufs,
    percussive_ratio, low_band_fraction, bars, sha256 (types validated,
    unknown keys dropped). An entry carrying only those extras (no valid
    bpm/beats pair) is kept as a partial dict without ``bpm`` so the v2
    engine can still resolve cached analysis and stems from ``entry_id``.
    """
    if not raw:
        return [None] * n
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as e:
        raise HTTPException(400, f"known_analysis must be JSON: {e}")
    if not isinstance(parsed, list) or len(parsed) != n:
        raise HTTPException(400, f"known_analysis must be a list of length {n}")
    return [analysis.sanitize_known(entry) for entry in parsed]


def _known_for_v1(
    known_list: list[Optional[dict[str, Any]]],
) -> list[Optional[dict[str, Any]]]:
    """v1 only trusts entries with a valid bpm + beats pair."""
    return [
        k if (k is not None and k.get("bpm") and k.get("beats")) else None
        for k in known_list
    ]


def _parse_weights(raw: str, n: int) -> list[float]:
    if not raw:
        return [1.0] * n
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as e:
        raise HTTPException(400, f"weights must be a JSON array, got {raw!r}: {e}")
    if not isinstance(parsed, list):
        raise HTTPException(
            400, f"weights must be a JSON array, got {type(parsed).__name__}"
        )
    if len(parsed) != n:
        raise HTTPException(400, f"weights length {len(parsed)} != file count {n}")
    return [float(w) for w in parsed]


def _resolve_target_bpm(
    user_target: Optional[float],
    base_index: Optional[int],
    detected: list[Optional[float]],
) -> tuple[float, str]:
    """Returns (target_bpm, source)."""
    if base_index is not None:
        if base_index < 0 or base_index >= len(detected):
            raise HTTPException(
                400, f"base_index {base_index} out of range [0, {len(detected)})"
            )
        b = detected[base_index]
        if b is None:
            raise HTTPException(
                400, f"base_index {base_index} clip has no detected BPM"
            )
        return float(b), "base_clip"
    if user_target is not None:
        return float(user_target), "user"
    valid = [b for b in detected if b is not None]
    if valid:
        return float(statistics.median(valid)), "median"
    return 120.0, "fallback"


# ---------------------------------------------------------------------------
# v1 engine (start / downbeat / weave with engine='v1'): the pre-v2 code path,
# moved here unchanged apart from the additive ``engine_used`` response key.
# ---------------------------------------------------------------------------


async def _mashup_v1(
    tmp: Path,
    files: list[UploadFile],
    norm_paths: list[Path],
    known_list: list[Optional[dict[str, Any]]],
    weight_list: list[float],
    user_target: Optional[float],
    base_index: Optional[int],
    align_mode: str,
    out_sr: int,
    weave_bars: int,
    weave_total_bars: int,
    weave_max_polyphony: int,
    sem: asyncio.Semaphore,
    tools: dict[str, Any],
    warnings: list[str],
) -> dict[str, Any]:
    n_files = len(files)

    # 2) Use client-supplied analysis (from analyze-on-add) when present and
    #    only run the detector on clips without it, CONCURRENTLY — duration
    #    always comes from the normalized file on disk, never the client.
    detections: list[dict[str, Any]] = [None] * n_files  # type: ignore[list-item]

    async def _detect(i: int) -> None:
        p = norm_paths[i]
        ka = known_list[i]
        if ka is not None:
            info = sf.info(str(p))
            detections[i] = {
                "bpm": float(ka["bpm"]),
                "beats": [float(b) for b in ka["beats"]],
                "confidence": 1.0,
                "samplerate": int(info.samplerate),
                "duration_sec": float(info.frames) / float(info.samplerate),
            }
        else:
            async with sem:
                detections[i] = await asyncio.to_thread(detect_tempo_and_beats, p)

    await asyncio.gather(*(_detect(i) for i in range(n_files)))
    detected_bpms: list[Optional[float]] = [d["bpm"] for d in detections]

    target_bpm_used, target_bpm_source = _resolve_target_bpm(
        user_target, base_index, detected_bpms
    )
    if target_bpm_source == "fallback":
        warnings.append("No clip had a detectable BPM; using 120 as fallback.")

    # 3) Time-stretch every clip to the target BPM, CONCURRENTLY.
    stretched_paths: list[Path] = [tmp / f"stretched_{i}.wav" for i in range(n_files)]
    stretch_meta: list[dict[str, Any]] = [None] * n_files  # type: ignore[list-item]

    async def _stretch(i: int) -> None:
        det = detections[i]
        if det["bpm"] is None or det["bpm"] <= 0:
            ratio = 1.0
        else:
            ratio = target_bpm_used / det["bpm"]
        async with sem:
            try:
                stretch_meta[i] = await asyncio.to_thread(
                    stretch_audio, norm_paths[i], stretched_paths[i], ratio
                )
            except RuntimeError as e:
                raise HTTPException(500, f"stretch failed for clip {i}: {e}") from e

    await asyncio.gather(*(_stretch(i) for i in range(n_files)))

    for i, result in enumerate(stretch_meta):
        if result["engine"] == "atempo" and tools["librubberband"]:
            warnings.append(
                f"Clip {i}: rubberband unavailable at stretch time; used atempo."
            )
        elif result["engine"] == "atempo" and not tools["librubberband"]:
            if i == 0:
                warnings.append(
                    "ffmpeg lacks librubberband; using atempo fallback for all clips."
                )

    n_clips = len(stretched_paths)
    clip_windows: list[tuple[float, float] | None] = [None] * n_clips
    mix_offsets_sec: list[float] = [0.0] * n_clips
    loop_to_sec: list[float | None] = [None] * n_clips
    stretched_durations: list[float] = []
    for sp in stretched_paths:
        stretched_durations.append(float(sf.info(str(sp)).duration))

    # weave-only: per original clip, list of placement metadata for the response
    placements_per_clip: list[list[dict[str, Any]]] = [[] for _ in range(n_clips)]

    # Inputs that flow into mix_clips. For start/downbeat these are the
    # original per-clip lists. For weave we rebuild them with one entry
    # per scheduled placement (so the same source file may appear many
    # times with different windows + offsets).
    mix_paths: list[Path] = list(stretched_paths)
    mix_weights: list[float] = list(weight_list)
    mix_windows: list[tuple[float, float] | None] = clip_windows
    mix_offsets: list[float] = mix_offsets_sec
    mix_loops: list[float | None] = loop_to_sec

    if align_mode == "downbeat":
        for i, (det, sm) in enumerate(zip(detections, stretch_meta)):
            beats = det["beats"]
            if not beats:
                continue
            ratio = sm["ratio_used"] if sm["ratio_used"] > 0 else 1.0
            first_beat_stretched = beats[0] / ratio
            clip_windows[i] = (first_beat_stretched, stretched_durations[i])

    elif align_mode == "weave":
        chunk_bars = resolve_chunk_bars(weave_bars)
        bar_sec = bar_duration_sec(target_bpm_used)
        chunk_sec = chunk_bars * bar_sec

        # Total length is the base clip's stretched duration when one is
        # selected (so the song arc maps onto the user's reference);
        # otherwise fall back to the user/auto weave_total_bars setting.
        if base_index is not None and 0 <= base_index < len(stretched_durations):
            total_sec_target = stretched_durations[base_index]
            total_bars = max(1, int(total_sec_target / bar_sec))
            length_source = f"base clip ({files[base_index].filename!r})"
        else:
            total_bars = resolve_total_bars(weave_total_bars)
            total_sec_target = total_bars * bar_sec
            length_source = "weave_total_bars" if weave_total_bars > 0 else "default"

        # Per-clip chunk list IN SOURCE ORDER — every contiguous chunk
        # is emitted so the natural arc (intro/body/outro) is available
        # to the scheduler.
        clip_chunks_seq: list[list[dict[str, Any]]] = []
        for i, (det, sm) in enumerate(zip(detections, stretch_meta)):
            ratio = sm["ratio_used"] if sm["ratio_used"] > 0 else 1.0
            beats_stretched = scale_beats(det["beats"], ratio)
            seq = compute_chunks_sequential(
                stretched_paths[i],
                beats_stretched,
                target_bpm_used,
                chunk_bars,
            )
            clip_chunks_seq.append(list(seq))

        polyphony_cap = (
            weave_max_polyphony if weave_max_polyphony > 0 else MAX_POLYPHONY
        )
        polyphony_cap = max(1, min(8, int(polyphony_cap)))
        arc_schedule = schedule_song_arc(
            clip_chunks_seq,
            total_sec_target,
            chunk_sec,
            max_polyphony=polyphony_cap,
        )

        expanded_paths: list[Path] = []
        expanded_weights: list[float] = []
        expanded_windows: list[tuple[float, float] | None] = []
        expanded_offsets: list[float] = []
        expanded_loops: list[float | None] = []

        for clip_idx, placements in enumerate(arc_schedule):
            chunks = clip_chunks_seq[clip_idx]
            if not placements:
                warnings.append(
                    f"Clip {clip_idx} ({files[clip_idx].filename!r}) got no "
                    "timeline slots; increase weave_total_bars or decrease weave_bars"
                )
                continue
            if not chunks:
                continue
            for placement in placements:
                chunk = chunks[placement["chunk_idx"]]
                expanded_paths.append(stretched_paths[clip_idx])
                expanded_weights.append(weight_list[clip_idx])
                expanded_windows.append((chunk["start_sec"], chunk["end_sec"]))
                expanded_offsets.append(placement["output_start_sec"])
                chunk_dur_actual = chunk["end_sec"] - chunk["start_sec"]
                expanded_loops.append(
                    chunk_sec if chunk_dur_actual < chunk_sec * 0.95 else None
                )
                placements_per_clip[clip_idx].append(
                    {
                        "output_start_sec": float(placement["output_start_sec"]),
                        "output_end_sec": float(
                            placement["output_start_sec"] + chunk_sec
                        ),
                        "window_start_sec": float(chunk["start_sec"]),
                        "window_end_sec": float(chunk["end_sec"]),
                        "chunk_idx": int(placement["chunk_idx"]),
                        "rms": float(chunk.get("rms", 0.0)),
                    }
                )

        if expanded_paths:
            mix_paths = expanded_paths
            mix_weights = expanded_weights
            mix_windows = expanded_windows
            mix_offsets = expanded_offsets
            mix_loops = expanded_loops
            total_placements = len(expanded_paths)
            last_end = max(o + chunk_sec for o in expanded_offsets)
            warnings.append(
                f"Phrase Weave (song arc): {chunk_bars} bars/chunk ({chunk_sec:.2f}s), "
                f"{total_bars} bars total from {length_source} ({total_sec_target:.2f}s), "
                f"{total_placements} placements across {n_clips} clips, "
                f"polyphony cap {polyphony_cap}, "
                f"final length {last_end:.2f}s"
            )
        else:
            warnings.append(
                "Phrase Weave produced no placements; check that clips have "
                "enough audio for the chunk size"
            )

    # Chunk-level micro-fades prevent clicks at placement boundaries;
    # master fade gives the mashup a smooth in/out instead of an abrupt
    # cold start and a sudden silence at the end.
    if align_mode == "weave":
        chunk_fade = 0.05
        master_fade_in = 1.5
        master_fade_out = 2.0
    else:
        chunk_fade = 0.0
        master_fade_in = 0.0
        master_fade_out = 0.0

    final = tmp / "final.wav"
    mix_result = mix_clips(
        mix_paths,
        mix_weights,
        final,
        out_sr=out_sr,
        clip_windows=mix_windows,
        mix_offsets_sec=mix_offsets,
        loop_to_sec=mix_loops,
        chunk_fade_sec=chunk_fade,
        master_fade_in_sec=master_fade_in,
        master_fade_out_sec=master_fade_out,
    )

    with open(final, "rb") as f:
        mix_bytes = f.read()
    mix_b64 = base64.b64encode(mix_bytes).decode("ascii")

    per_clip: list[dict[str, Any]] = []
    for i, (upload, det, sm, sp) in enumerate(
        zip(files, detections, stretch_meta, stretched_paths)
    ):
        info = sf.info(str(sp))
        note_bits: list[str] = []
        if sm["clamped"]:
            note_bits.append(f"ratio clamped to {sm['ratio_used']:.3f}")
        if sm["note"] and sm["note"] not in note_bits:
            note_bits.append(sm["note"])
        if det["bpm"] is None:
            note_bits.append("no beats detected; chunks picked by RMS")

        placements = placements_per_clip[i]
        if placements:
            window_start = placements[0]["window_start_sec"]
            window_end = placements[0]["window_end_sec"]
        else:
            window = clip_windows[i]
            window_start = window[0] if window is not None else 0.0
            window_end = window[1] if window is not None else float(info.duration)

        per_clip.append(
            {
                "index": i,
                "label": upload.filename or f"clip_{i}",
                "detected_bpm": det["bpm"],
                "beats": det["beats"],
                "stretch_ratio": sm["ratio_used"],
                "stretched_duration_sec": info.duration,
                "window_start_sec": window_start,
                "window_end_sec": window_end,
                "weight_used": weight_list[i],
                "placements": placements,
                "note": "; ".join(note_bits) if note_bits else None,
            }
        )

    return {
        "mix_base64": mix_b64,
        "mime": "audio/wav",
        "sample_rate": out_sr,
        "duration_sec": mix_result["duration_sec"],
        "target_bpm_used": target_bpm_used,
        "target_bpm_source": target_bpm_source,
        "align_mode_used": align_mode,
        "engine_used": "v1",
        "per_clip": per_clip,
        "warnings": warnings,
    }


# ---------------------------------------------------------------------------
# v2 engine (align_mode='weave', engine='v2'): analysis -> tempo/harmony ->
# arrangement -> per-run conform -> render -> master.
# ---------------------------------------------------------------------------


def _beats_stretched(
    beats_src: list[float],
    plan: dict[str, Any],
    beat_sec: float,
    grid: Optional[dict[str, Any]],
) -> list[float]:
    """CONFORMED beat times for the response: ``beats / ratio``, snapped to
    the grid lattice ``origin + k * beat_sec`` (origin = the fitted grid's
    phase in CONFORMED time, which every phrase start sits on) when the
    plan locks to the grid."""
    ratio = float(plan.get("ratio") or 1.0)
    arr = np.asarray(beats_src, dtype=np.float64) / ratio
    if plan.get("lock") and beat_sec > 0 and arr.size:
        origin = float((grid or {}).get("phase_sec") or 0.0) / ratio
        arr = origin + np.round((arr - origin) / beat_sec) * beat_sec
    return [float(t) for t in arr]


def _median(values: list[float]) -> Optional[float]:
    vals = [float(v) for v in values if v is not None and np.isfinite(v)]
    return float(statistics.median(vals)) if vals else None


async def _mashup_v2(
    tmp: Path,
    files: list[UploadFile],
    norm_paths: list[Path],
    raw_bytes_sha: list[str],
    known_list: list[Optional[dict[str, Any]]],
    weight_list: list[float],
    user_target: Optional[float],
    base_index: Optional[int],
    opts: dict[str, Any],
    out_sr: int,
    sem: asyncio.Semaphore,
    tools: dict[str, Any],
    warnings: list[str],
) -> dict[str, Any]:
    n = len(files)
    labels = [f.filename or f"clip_{i}" for i, f in enumerate(files)]
    phrase_bars = resolve_chunk_bars(int(opts["weave_bars"]))
    polyphony_cap = (
        int(opts["weave_max_polyphony"])
        if int(opts["weave_max_polyphony"]) > 0
        else MAX_POLYPHONY
    )
    polyphony_cap = max(1, min(8, polyphony_cap))
    if base_index is not None and (base_index < 0 or base_index >= n):
        raise HTTPException(400, f"base_index {base_index} out of range [0, {n})")

    # 1) per-clip analysis (client known -> cache -> computed), under the sem
    analyses: list[ClipAnalysis] = [None] * n  # type: ignore[list-item]

    async def _analyze(i: int) -> None:
        async with sem:
            try:
                analyses[i] = await asyncio.to_thread(
                    analysis.analyze_clip,
                    norm_paths[i],
                    known=known_list[i],
                    sha=raw_bytes_sha[i],
                    phrase_bars=phrase_bars,
                )
            except Exception as e:
                log.warning("chimera v2: analysis failed for clip %d: %s", i, e)
                warnings.append(
                    f"Clip {i} ({labels[i]!r}): analysis failed ({e}); "
                    "treated as beatless"
                )
                analyses[i] = await asyncio.to_thread(
                    analysis.empty_analysis, norm_paths[i]
                )

    await asyncio.gather(*(_analyze(i) for i in range(n)))

    # 2) target tempo + per-clip octave
    detected: list[Optional[float]] = [a["bpm"] for a in analyses]
    try:
        target0, target_bpm_source = tempo.resolve_target_bpm_v2(
            user_target, base_index, detected, weight_list
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    if target_bpm_source == "fallback":
        warnings.append("No clip had a detectable BPM; using 120 as fallback.")

    base_len: Optional[float] = None
    if base_index is not None:
        ab = analyses[base_index]
        if ab["bpm"]:
            _m, r0 = tempo.choose_octave(float(ab["bpm"]), target0)
            base_len = float(ab["duration_sec"]) / (r0 or 1.0)
        else:
            base_len = float(ab["duration_sec"])

    # 3) timeline (may nudge the tempo <= 3% when it came from the median)
    tl = arrange.resolve_timeline(
        target0,
        target_bpm_source,
        float(opts["target_duration_sec"]),
        int(opts["weave_total_bars"]),
        base_len,
        phrase_bars,
    )
    target_bpm = float(tl["bpm"])
    bar_sec = bar_duration_sec(target_bpm)
    beat_sec = bar_sec / BEATS_PER_BAR
    if abs(float(tl["tempo_fit_pct"])) > 1e-9:
        warnings.append(
            f"Tempo nudged {tl['tempo_fit_pct']:+.2f}% to {target_bpm:.2f} BPM so "
            f"{tl['total_bars']} whole bars fit the requested length"
        )

    # 4) harmony
    key_inputs: list[KeyInput] = []
    for i, a in enumerate(analyses):
        key_inputs.append(
            {
                "key": a["key"],
                "scale": a["scale"],
                "key_confidence": a["key_confidence"],
                "key_strength": a["key_strength"],
                "tonal": bool(a["tonal"]),
                "weight": float(weight_list[i]),
                "is_base": base_index is not None and i == base_index,
            }
        )
    hplan = choose_target_key(
        key_inputs, max_shift=int(opts["max_pitch_shift"]), mode=opts["harmony"]
    )
    for i, ch in enumerate(hplan["per_clip"]):
        if ch["outlier"]:
            warnings.append(
                f"Clip {i} ({labels[i]!r}): key {analyses[i]['key']} "
                f"{analyses[i]['scale']} ({ch['camelot']}) cannot reach "
                f"{hplan['target_camelot']} within {opts['max_pitch_shift']} "
                "semitones; left unshifted (harmonic outlier)"
            )

    # 5) conform plans at the FINAL tempo (ratio includes the octave choice)
    plans_full: list[dict[str, Any]] = []
    beats_eff: list[list[float]] = []
    lock_beats: list[list[float]] = []
    for i, a in enumerate(analyses):
        semis = int(hplan["per_clip"][i]["shift_semitones"])
        plan = conform.plan_conform(
            a, target_bpm, semis, is_layer_source=False, grid_lock=opts["grid_lock"]
        )
        plans_full.append(dict(plan))
        m = float(plan["tempo_multiplier"])
        beats_eff.append(tempo.rebuild_beats(a["beats"], m))
        grid = a["grid"] or {}
        kept = list(grid.get("kept_beats") or []) or list(a["beats"])
        lock_beats.append(tempo.rebuild_beats(kept, m))

    # 6) cached stems for library clips (never separates; silent fallback)
    stem_sources: list[Optional[dict[str, Path]]] = [None] * n
    if bool(opts["use_stems"]):

        async def _stems(i: int) -> None:
            entry_id = (known_list[i] or {}).get("entry_id")
            if not entry_id:
                return
            async with sem:
                found = await asyncio.to_thread(stems.resolve_cached_stems, entry_id)
                if not found:
                    return
                srcs = await asyncio.to_thread(
                    stems.build_role_sources, found, tmp / f"clip_{i}", out_sr
                )
            if srcs is None:
                warnings.append(
                    f"Clip {i} ({labels[i]!r}): cached stems incomplete, using full mix"
                )
                return
            stem_sources[i] = srcs

        await asyncio.gather(*(_stems(i) for i in range(n)))

    plans_layer: list[Optional[dict[str, Any]]] = []
    for i, a in enumerate(analyses):
        if stem_sources[i] is None:
            plans_layer.append(None)
            continue
        semis = int(hplan["per_clip"][i]["shift_semitones"])
        plans_layer.append(
            dict(
                conform.plan_conform(
                    a,
                    target_bpm,
                    semis,
                    is_layer_source=True,
                    grid_lock=opts["grid_lock"],
                )
            )
        )

    # 7) phrase tables + arrangement
    clip_inputs: list[arrange.ClipPlanInput] = []
    for i, a in enumerate(analyses):
        phrases = analysis.phrases_for(a, phrase_bars)
        if not phrases:
            ratio = float(plans_full[i]["ratio"]) or 1.0
            phrases = analysis.fallback_phrases(
                float(a["duration_sec"]), bar_sec * ratio, phrase_bars, a["lufs"]
            )
            if phrases:
                warnings.append(
                    f"Clip {i} ({labels[i]!r}): no usable beat grid; phrases cut "
                    f"every {phrase_bars} bars from the clip start"
                )
        bars = a["bars"] or []
        centroid = float(np.mean([b["centroid_hz"] for b in bars])) if bars else 0.0
        grid = a["grid"] or {}
        clip_inputs.append(
            {
                "index": i,
                "phrases": phrases,
                "weight": float(weight_list[i]),
                "is_base": base_index is not None and i == base_index,
                "tonal": bool(a["tonal"]),
                "harmonic_outlier": bool(hplan["per_clip"][i]["outlier"]),
                "downbeat_confidence": float(a["downbeat_confidence"]),
                "steady": bool(grid.get("steady", False)),
                "has_stems": stem_sources[i] is not None,
                "ratio": float(plans_full[i]["ratio"]),
                "centroid_hz": centroid,
            }
        )

    sched = arrange.plan_timeline(
        clip_inputs,
        tl,
        bar_sec,
        beat_sec,
        polyphony_cap=polyphony_cap,
        arc=opts["arc"],
        transition_bars=float(opts["transition_bars"]),
        seed=int(opts["seed"]),
    )
    heal_min_sec = max(0.5, float(opts["heal_margin_bars"]) * bar_sec)
    sched["seams"] = arrange.seam_budget(
        sched["seams"], float(sched["total_sec"]), min_sec=heal_min_sec
    )
    warnings.extend(sched["warnings"])
    if not sched["runs"]:
        raise HTTPException(
            400,
            "Phrase Weave produced no placements; the clips have no usable audio",
        )

    # 8) per-run conform (stretch + pitch + grid lock), under the sem
    jobs: list[tuple[dict[str, Any], Path, dict[str, Any], str]] = []
    for run in sched["runs"]:
        i = int(run["clip"])
        role = str(run["role"])
        srcs = stem_sources[i]
        layer_plan = plans_layer[i]
        if role in ("full", "hp") or srcs is None or layer_plan is None:
            jobs.append((run, norm_paths[i], plans_full[i], "full"))
        elif role == "stem_found":
            jobs.append((run, srcs["found"], plans_full[i], "found"))
            jobs.append((run, srcs["layer"], layer_plan, "layer"))
        else:  # stem_layer (support)
            jobs.append((run, srcs["layer"], layer_plan, "layer"))

    run_audio: dict[int, list[RunAudio]] = {}
    work_dir = tmp / "runs"
    # Pre/post-roll must cover the longest crossfade tail the renderer will
    # slice (a shaky-clip blend is 2 bars; the conform default is 1).
    max_tail_sec = max(
        [
            max(float(r.get("fade_in_sec", 0.0)), float(r.get("fade_out_sec", 0.0)))
            for r in sched["runs"]
        ]
        + [0.0]
    )
    margin_bars = max(conform.MARGIN_BARS, max_tail_sec / bar_sec + 0.25)

    async def _conform(job: tuple[dict[str, Any], Path, dict[str, Any], str]) -> None:
        run, src_path, plan, kind = job
        i = int(run["clip"])
        async with sem:
            try:
                ra = await asyncio.to_thread(
                    conform.conform_run,
                    src_path,
                    work_dir,
                    plan,
                    run,
                    beat_sec,
                    None,
                    lock_beats[i],
                    out_sr,
                    kind,
                    margin_bars=margin_bars,
                )
            except HTTPException:
                raise
            except Exception as e:
                raise HTTPException(
                    500, f"stretch failed for clip {i} (run {run['run_id']}): {e}"
                ) from e
        run_audio.setdefault(int(run["run_id"]), []).append(ra)

    await asyncio.gather(*(_conform(job) for job in jobs))

    # 9) render + master in one thread
    final = tmp / "final.wav"
    clip_weights = {i: float(w) for i, w in enumerate(weight_list)}

    def _render_and_master() -> tuple[render.RenderResult, master.MasterReport]:
        rr = render.render_timeline(sched, run_audio, out_sr, clip_weights=clip_weights)
        rep = master.finalize(rr["audio"], out_sr, beat_sec, bar_sec, final)
        return rr, rep

    rr, rep = await asyncio.to_thread(_render_and_master)
    warnings.extend(rr["warnings"])

    with open(final, "rb") as f:
        mix_b64 = base64.b64encode(f.read()).decode("ascii")

    # 10) response: every v1 key with its v1 meaning + the additive v2 keys
    runs_by_clip: dict[int, list[dict[str, Any]]] = {}
    for run in sched["runs"]:
        runs_by_clip.setdefault(int(run["clip"]), []).append(run)
    atempo_clips: list[int] = []
    per_clip: list[dict[str, Any]] = []
    for i, a in enumerate(analyses):
        plan = plans_full[i]
        ratio = float(plan["ratio"]) or 1.0
        ras: list[RunAudio] = [
            ra
            for run in runs_by_clip.get(i, [])
            for ra in run_audio.get(int(run["run_id"]), [])
        ]
        placements: list[dict[str, Any]] = sorted(
            (dict(p) for p in sched["placements"] if int(p["clip"]) == i),
            key=lambda p: (p["output_start_sec"], p["nominal_start_sec"]),
        )
        for p in placements:
            p["gain_db"] = float(rr["run_gains_db"].get(int(p["run_id"]), 0.0))
        stretched_duration = float(a["duration_sec"]) / ratio
        if placements:
            window_start = float(placements[0]["window_start_sec"])
            window_end = float(placements[0]["window_end_sec"])
        else:
            window_start, window_end = 0.0, stretched_duration

        stretch_reports = [ra["lock_report"].get("stretch", {}) for ra in ras]
        engines = {str(s.get("engine")) for s in stretch_reports if s}
        conform_engine = (
            "atempo"
            if "atempo" in engines
            else ("rubberband" if engines or tools.get("librubberband") else "atempo")
        )
        if "atempo" in engines:
            atempo_clips.append(i)
        pitch_used = (
            float(stretch_reports[0].get("pitch_semitones_used", 0.0))
            if stretch_reports
            else float(plan["semitones"])
        )
        if int(plan["semitones"]) != 0 and pitch_used == 0.0 and stretch_reports:
            warnings.append(
                f"Clip {i} ({labels[i]!r}): pitch shift of {plan['semitones']:+d} st "
                "unavailable (atempo engine); key left unshifted"
            )
        locked_any = any(bool(ra["locked"]) for ra in ras)
        lock_residual = _median(
            [
                ra["lock_report"].get("median_residual_ms")
                for ra in ras
                if ra["lock_report"].get("median_residual_ms") is not None
            ]
        )

        note_bits: list[str] = []
        if plan.get("note"):
            note_bits.append(str(plan["note"]))
        for s in stretch_reports:
            nt = s.get("note")
            if nt and nt not in note_bits:
                note_bits.append(str(nt))
        if a["bpm"] is None:
            note_bits.append("no beats detected; phrases cut from the clip start")
        if plan.get("lock") and ras and not locked_any:
            reasons = {
                str(ra["lock_report"].get("reason"))
                for ra in ras
                if ra["lock_report"].get("reason")
            }
            if reasons:
                note_bits.append("grid lock skipped: " + "; ".join(sorted(reasons)))
        if not placements:
            note_bits.append("not placed on the timeline")

        ch = hplan["per_clip"][i]
        phrases_out = [
            {
                "idx": int(ph["idx"]),
                "start_sec": float(ph["start_sec"]) / ratio,
                "end_sec": float(ph["end_sec"]) / ratio,
                "bars": int(ph["bars"]),
                "lufs": float(ph["lufs"]),
                "energy": float(ph["energy"]),
                "section_label": ph["section_label"],
            }
            for ph in clip_inputs[i]["phrases"]
        ]
        per_clip.append(
            {
                # v1 keys
                "index": i,
                "label": labels[i],
                "detected_bpm": a["bpm"],
                "beats": list(a["beats"]),
                "stretch_ratio": ratio,
                "stretched_duration_sec": stretched_duration,
                "window_start_sec": window_start,
                "window_end_sec": window_end,
                "weight_used": float(weight_list[i]),
                "placements": placements,
                "note": "; ".join(note_bits) if note_bits else None,
                # v2 additive
                "tempo_multiplier": float(plan["tempo_multiplier"]),
                "pitch_shift_semitones": pitch_used,
                "key": a["key"],
                "scale": a["scale"],
                "key_confidence": a["key_confidence"],
                "key_strength": a["key_strength"],
                "camelot": ch["camelot"] or camelot_code(a["key"], a["scale"]),
                "atonal": bool(ch["atonal"]) or not a["tonal"],
                "harmonic_outlier": bool(ch["outlier"]),
                "downbeat_phase": int(a["downbeat_phase"]),
                "downbeat_confidence": float(a["downbeat_confidence"]),
                "phrase_phase": int(a["phrase_phase"]),
                "phrase_confidence": float(a["phrase_confidence"]),
                "grid_locked": locked_any,
                "lock_residual_ms": lock_residual,
                "beats_stretched": _beats_stretched(
                    beats_eff[i], plan, beat_sec, a["grid"]
                ),
                "sources_used": "stems" if stem_sources[i] is not None else "full",
                "conform_engine": conform_engine,
                "conform_preset": plan["preset"],
                "phrases": phrases_out,
            }
        )

    for i in atempo_clips:
        if tools.get("librubberband"):
            warnings.append(
                f"Clip {i}: rubberband unavailable at stretch time; used atempo."
            )
    if atempo_clips and not tools.get("librubberband"):
        warnings.append(
            "ffmpeg lacks librubberband; using atempo fallback for all clips."
        )

    length_source = str(tl["length_source"])
    if length_source == "base clip" and base_index is not None:
        length_source = f"base clip ({files[base_index].filename!r})"
    warnings.append(
        f"Phrase Weave ({opts['arc']} arc): {phrase_bars} bars/chunk "
        f"({phrase_bars * bar_sec:.2f}s), {tl['total_bars']} bars total from "
        f"{length_source} ({sched['total_sec']:.2f}s), "
        f"{len(sched['placements'])} placements across {n} clips, "
        f"polyphony cap {polyphony_cap}, "
        f"final length {rep['duration_sec']:.2f}s, engine v2"
    )

    return {
        # v1 keys
        "mix_base64": mix_b64,
        "mime": "audio/wav",
        "sample_rate": out_sr,
        "duration_sec": float(rep["duration_sec"]),
        "target_bpm_used": target_bpm,
        "target_bpm_source": target_bpm_source,
        "align_mode_used": "weave",
        "per_clip": per_clip,
        "warnings": warnings,
        # v2 additive
        "engine_used": "v2",
        "harmony_mode_used": opts["harmony"],
        "arc_used": opts["arc"],
        "phrase_bars_used": int(phrase_bars),
        "total_bars_used": int(tl["total_bars"]),
        "tempo_fit_pct": float(tl["tempo_fit_pct"]),
        "bar_sec": float(bar_sec),
        "target_key": hplan["target_key"],
        "target_scale": hplan["target_scale"],
        "target_camelot": hplan["target_camelot"],
        "prompt_hint": prompt_hint(target_bpm, hplan),
        "sections": list(sched["sections"]),
        "seams": list(sched["seams"]),
        "lane_lufs": dict(rr["lane_lufs"]),
        "master_lufs": float(rep["lufs_integrated"]),
        "true_peak_db": float(rep["true_peak_db"]),
        "limiter_gr_db": float(rep["limiter_gr_db"]),
        "analysis_sources": [a["source"] for a in analyses],
    }


@router.post("/mashup")
async def chimera_mashup(
    files: list[UploadFile] = File(...),
    target_bpm: str = Form("auto"),
    base_index: Optional[int] = Form(None),
    weights: str = Form(""),
    align_mode: str = Form("start"),
    out_sr: int = Form(44100),
    weave_bars: int = Form(0),
    weave_total_bars: int = Form(0),
    weave_max_polyphony: int = Form(0),
    known_analysis: str = Form(""),
    # v2 additive fields (only consulted for align_mode='weave')
    engine: str = Form("v2"),
    harmony: str = Form("auto"),
    max_pitch_shift: int = Form(2),
    arc: str = Form("song"),
    target_duration_sec: float = Form(0.0),
    transition_bars: float = Form(0.0),
    use_stems: str = Form("true"),
    grid_lock: str = Form("auto"),
    seed: int = Form(0),
    heal_margin_bars: float = Form(0.5),
) -> dict[str, Any]:
    t_start = time.perf_counter()
    tools = probe()
    if not tools["aubio"] or not tools["ffmpeg"]:
        raise HTTPException(
            503,
            detail={
                "error": "Chimera toolchain not available",
                "install_hint": tools["install_hint"],
                "toolchain": tools,
            },
        )

    if not files:
        raise HTTPException(400, "No files uploaded")
    if align_mode not in ("start", "downbeat", "weave"):
        raise HTTPException(400, f"unknown align_mode: {align_mode!r}")

    user_target = _parse_target_bpm(target_bpm)
    weight_list = _parse_weights(weights, len(files))
    known_list = _parse_known_analysis(known_analysis, len(files))
    engine_used = _parse_enum(engine, _ENGINES, "engine")
    opts: dict[str, Any] = {
        "harmony": _parse_enum(harmony, _HARMONY_MODES, "harmony"),
        "arc": _parse_enum(arc, _ARCS, "arc"),
        "grid_lock": _parse_enum(grid_lock, _GRID_LOCK_MODES, "grid_lock"),
        "max_pitch_shift": max(0, min(_MAX_PITCH_SHIFT_CAP, int(max_pitch_shift))),
        "target_duration_sec": max(0.0, float(target_duration_sec or 0.0)),
        "transition_bars": max(0.0, float(transition_bars or 0.0)),
        "use_stems": _parse_bool(use_stems, True),
        "seed": int(seed),
        "heal_margin_bars": max(0.0, float(heal_margin_bars or 0.0)),
        "weave_bars": int(weave_bars),
        "weave_total_bars": int(weave_total_bars),
        "weave_max_polyphony": int(weave_max_polyphony),
    }
    if align_mode != "weave":
        engine_used = "v1"

    log.info(
        "chimera mashup start: %d file(s), mode=%s, engine=%s, target_bpm=%s, "
        "base_index=%s, weave_bars=%d, total_bars=%d, target_duration=%.1fs, "
        "harmony=%s, arc=%s",
        len(files),
        align_mode,
        engine_used,
        target_bpm,
        base_index,
        opts["weave_bars"],
        opts["weave_total_bars"],
        opts["target_duration_sec"],
        opts["harmony"],
        opts["arc"],
    )

    warnings: list[str] = []

    with tempfile.TemporaryDirectory(prefix="chimera_") as tmpdir:
        tmp = Path(tmpdir)

        n_files = len(files)
        sem = asyncio.Semaphore(max(1, min(_MASHUP_CONCURRENCY, n_files)))

        # 1) Read each upload to disk (sequential async I/O — fast), then
        #    decode/normalize them CONCURRENTLY (each ffmpeg call runs in a
        #    worker thread so they no longer block the event loop one-by-one).
        raw_info: list[tuple[Path, str]] = []
        raw_shas: list[str] = []
        for i, upload in enumerate(files):
            suffix = Path(upload.filename or "").suffix or ".bin"
            raw_path = tmp / f"raw_{i}{suffix}"
            raw_shas.append(await _save_upload(upload, raw_path))
            raw_info.append((raw_path, upload.filename or f"clip {i}"))

        norm_paths: list[Path] = [tmp / f"norm_{i}.wav" for i in range(n_files)]

        async def _normalize(i: int) -> None:
            async with sem:
                try:
                    await asyncio.to_thread(
                        normalize_to_target,
                        raw_info[i][0],
                        norm_paths[i],
                        target_sr=out_sr,
                        target_channels=2,
                    )
                except RuntimeError as e:
                    raise HTTPException(
                        400, f"could not decode {raw_info[i][1]!r}: {e}"
                    ) from e

        await asyncio.gather(*(_normalize(i) for i in range(n_files)))

        if engine_used == "v2":
            body = await _mashup_v2(
                tmp,
                files,
                norm_paths,
                raw_shas,
                known_list,
                weight_list,
                user_target,
                base_index,
                opts,
                out_sr,
                sem,
                tools,
                warnings,
            )
        else:
            body = await _mashup_v1(
                tmp,
                files,
                norm_paths,
                _known_for_v1(known_list),
                weight_list,
                user_target,
                base_index,
                align_mode,
                out_sr,
                weave_bars,
                weave_total_bars,
                weave_max_polyphony,
                sem,
                tools,
                warnings,
            )

    log.info(
        "chimera mashup done: %d file(s), mode=%s, engine=%s, target %.2f BPM (%s), "
        "%.2fs of audio, %d warning(s), %.1fs elapsed",
        len(files),
        body["align_mode_used"],
        body["engine_used"],
        float(body["target_bpm_used"]),
        body["target_bpm_source"],
        float(body["duration_sec"]),
        len(body["warnings"]),
        time.perf_counter() - t_start,
    )
    return body
