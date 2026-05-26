"""Phrase Weave: bar-aligned multi-chunk distribution across a long timeline.

For each clip, the algorithm extracts N high-energy bar-aligned chunks and
scatters them across an output timeline of at least `WEAVE_TOTAL_BARS_DEFAULT`
bars at the target BPM. At each timeline slot, at most `MAX_POLYPHONY` clips
play simultaneously. Average density is tuned so the timeline has natural
breathing room (default ~1.5 clips per slot on average).

This produces an arrangement closer to a DJ collage than a stacked mashup:
every clip appears multiple times throughout the piece, in different
positions, with controlled overlap.
"""

from __future__ import annotations

import logging
import random
from pathlib import Path
from typing import TypedDict

import numpy as np
import soundfile as sf

log = logging.getLogger(__name__)


BEATS_PER_BAR = 4

# Chunk size: how big each placement is.
WEAVE_CHUNK_BARS_MIN = 2
WEAVE_CHUNK_BARS_MAX = 32
WEAVE_CHUNK_BARS_DEFAULT = 8

# Total output length: at minimum, a song is this many bars.
WEAVE_TOTAL_BARS_MIN = 16
WEAVE_TOTAL_BARS_MAX = 256
WEAVE_TOTAL_BARS_DEFAULT = 90

MAX_POLYPHONY = 3
# Average number of clips active per slot when scheduling.
WEAVE_DENSITY_TARGET = 1.5


def bar_duration_sec(target_bpm: float, beats_per_bar: int = BEATS_PER_BAR) -> float:
    if target_bpm <= 0:
        return 0.0
    return (60.0 / target_bpm) * beats_per_bar


def scale_beats(beats_orig: list[float], stretch_ratio: float) -> list[float]:
    """Map beat positions from the source timebase to the post-stretch timebase.

    A stretch ratio R > 1 produces shorter output (faster), so an event at
    time t in the source lands at t / R in the output. Ratio of 0 or
    negative defends against bad inputs and returns the original positions.
    """
    if stretch_ratio <= 0:
        return list(beats_orig)
    return [b / stretch_ratio for b in beats_orig]


def resolve_chunk_bars(requested_bars: int) -> int:
    """Resolve the per-chunk size in bars. 0 = use default."""
    if requested_bars <= 0:
        return WEAVE_CHUNK_BARS_DEFAULT
    return max(WEAVE_CHUNK_BARS_MIN, min(WEAVE_CHUNK_BARS_MAX, requested_bars))


def resolve_total_bars(requested_bars: int) -> int:
    """Resolve the minimum total output length in bars. 0 = use default."""
    if requested_bars <= 0:
        return WEAVE_TOTAL_BARS_DEFAULT
    return max(WEAVE_TOTAL_BARS_MIN, min(WEAVE_TOTAL_BARS_MAX, requested_bars))


class ChunkCandidate(TypedDict):
    start_sec: float
    end_sec: float
    rms: float


def compute_chunk_candidates(
    audio_path: str | Path,
    beats_scaled: list[float],
    target_bpm: float,
    chunk_bars: int,
    max_candidates: int = 24,
    min_separation_bars: float = 0.5,
) -> list[ChunkCandidate]:
    """Find up to `max_candidates` non-overlapping bar-aligned chunks
    sorted by RMS energy (descending).

    Falls back to a single window covering the entire clip when the clip
    is shorter than `chunk_bars` — the caller is expected to loop in
    that case.
    """
    bar_sec = bar_duration_sec(target_bpm)
    chunk_sec = chunk_bars * bar_sec
    info = sf.info(str(audio_path))
    total_dur = float(info.duration)

    if chunk_sec <= 0 or total_dur <= 0:
        return [{"start_sec": 0.0, "end_sec": total_dur, "rms": 0.0}]

    if chunk_sec >= total_dur:
        return [{"start_sec": 0.0, "end_sec": total_dur, "rms": 0.0}]

    audio, sr = sf.read(str(audio_path), dtype="float32", always_2d=False)
    mono = audio.mean(axis=1) if audio.ndim == 2 else audio
    win_samples = int(chunk_sec * sr)

    if beats_scaled:
        candidate_starts = [
            c
            for c in beats_scaled[::BEATS_PER_BAR]
            if c >= 0 and c + chunk_sec <= total_dur
        ]
    else:
        candidate_starts = []

    # If we have no beat-aligned candidates, fall back to a stride scan.
    if not candidate_starts:
        stride_sec = max(0.5, chunk_sec / 4.0)
        n_stride = max(1, int((total_dur - chunk_sec) / stride_sec))
        candidate_starts = [
            i * stride_sec
            for i in range(n_stride + 1)
            if i * stride_sec + chunk_sec <= total_dur
        ]

    if not candidate_starts:
        return [{"start_sec": 0.0, "end_sec": min(chunk_sec, total_dur), "rms": 0.0}]

    scored: list[tuple[float, float]] = []  # (start_sec, rms)
    for c in candidate_starts:
        s = int(c * sr)
        e = min(s + win_samples, len(mono))
        if e - s < int(win_samples * 0.8):
            continue
        seg = mono[s:e]
        rms = float(np.sqrt(np.mean(seg * seg)))
        scored.append((c, rms))

    if not scored:
        return [{"start_sec": 0.0, "end_sec": min(chunk_sec, total_dur), "rms": 0.0}]

    scored.sort(key=lambda x: x[1], reverse=True)

    # Greedy non-overlapping selection.
    min_sep = max(0.1, min_separation_bars * bar_sec)
    selected: list[tuple[float, float]] = []
    for start, rms in scored:
        if any(abs(start - s) < (chunk_sec - min_sep) for s, _ in selected):
            continue
        selected.append((start, rms))
        if len(selected) >= max_candidates:
            break

    return [
        {"start_sec": float(s), "end_sec": float(s + chunk_sec), "rms": float(r)}
        for s, r in selected
    ]


def compute_chunks_sequential(
    audio_path: str | Path,
    beats_scaled: list[float],
    target_bpm: float,
    chunk_bars: int,
) -> list[ChunkCandidate]:
    """Return non-overlapping chunks walking forward through the source
    in source order. Unlike `compute_chunk_candidates` this is NOT
    RMS-filtered — every chunk_sec slice of audio is emitted so the
    natural arc of the song (intro → body → outro) is preserved when the
    scheduler picks placements.

    Returns chunks sorted by `start_sec`. If the source is shorter than
    one chunk, returns a single full-clip entry.
    """
    bar_sec = bar_duration_sec(target_bpm)
    chunk_sec = chunk_bars * bar_sec
    info = sf.info(str(audio_path))
    total_dur = float(info.duration)

    if chunk_sec <= 0 or total_dur <= 0:
        return [{"start_sec": 0.0, "end_sec": total_dur, "rms": 0.0}]

    if chunk_sec >= total_dur:
        return [{"start_sec": 0.0, "end_sec": total_dur, "rms": 0.0}]

    audio, sr = sf.read(str(audio_path), dtype="float32", always_2d=False)
    mono = audio.mean(axis=1) if audio.ndim == 2 else audio
    win_samples = int(chunk_sec * sr)

    if beats_scaled:
        downbeat_candidates = [c for c in beats_scaled[::BEATS_PER_BAR] if c >= 0]
    else:
        downbeat_candidates = []

    # Walk through, picking non-overlapping bar-aligned chunks in source order.
    chunks: list[ChunkCandidate] = []
    cursor = 0.0
    while cursor + chunk_sec <= total_dur:
        # Snap to nearest downbeat at or after cursor, if available.
        if downbeat_candidates:
            snap = next((b for b in downbeat_candidates if b >= cursor), None)
            if snap is None or snap + chunk_sec > total_dur:
                start = cursor
            else:
                start = snap
        else:
            start = cursor
        s = int(start * sr)
        e = min(s + win_samples, len(mono))
        seg = mono[s:e]
        rms = float(np.sqrt(np.mean(seg * seg))) if seg.size else 0.0
        chunks.append(
            {"start_sec": float(start), "end_sec": float(start + chunk_sec), "rms": rms}
        )
        cursor = start + chunk_sec

    if not chunks:
        chunks.append({"start_sec": 0.0, "end_sec": total_dur, "rms": 0.0})
    return chunks


class ArcPlacement(TypedDict):
    output_start_sec: float
    chunk_idx: int


def schedule_song_arc(
    chunks_per_clip: list[list[ChunkCandidate]],
    target_total_sec: float,
    chunk_sec: float,
    max_polyphony: int = MAX_POLYPHONY,
    seed: int = 0,
) -> list[list[ArcPlacement]]:
    """Map each clip's chunks to output positions in source order.

    For each clip with C chunks, picks `min(C, n_slots)` placements and
    spreads them evenly from slot 0 to slot n_slots-1. The FIRST chunk
    lands at output start, the LAST chunk lands at output end, the middle
    chunks fill in proportionally. Short clips therefore have fewer
    placements that still cover the full timeline (not bunched at the
    front).

    Polyphony cap: at every output slot, at most `max_polyphony` clips
    play. When more than `max_polyphony` clips claim a slot, intro
    placements (chunk_idx == 0) and outro placements (chunk_idx == last)
    win priority so song-arc structure is preserved; remaining ties are
    broken by a seeded shuffle.
    """
    n_clips = len(chunks_per_clip)
    if n_clips == 0 or target_total_sec <= 0 or chunk_sec <= 0:
        return [[] for _ in range(n_clips)]

    n_slots = max(1, int(target_total_sec / chunk_sec))
    rng = random.Random(seed)

    # slot -> list of (clip_idx, chunk_idx, priority, jitter)
    # priority: lower = drop first when over polyphony cap
    slot_assignments: dict[int, list[tuple[int, int, int, float]]] = {}

    for clip_idx, chunks in enumerate(chunks_per_clip):
        n_chunks = len(chunks)
        if n_chunks == 0:
            continue
        n_place = min(n_chunks, n_slots)
        if n_place == 1:
            # Single chunk → middle of the timeline so it doesn't fight
            # for intro/outro priority.
            slot_indices = [n_slots // 2]
            chunk_indices = [0]
        else:
            slot_indices = [
                round(i * (n_slots - 1) / (n_place - 1)) for i in range(n_place)
            ]
            chunk_indices = [
                round(i * (n_chunks - 1) / (n_place - 1)) for i in range(n_place)
            ]

        for placement_idx, (slot, c_idx) in enumerate(zip(slot_indices, chunk_indices)):
            is_intro = placement_idx == 0
            is_outro = placement_idx == n_place - 1
            priority = 2 if (is_intro or is_outro) else 1
            jitter = rng.random()
            slot_assignments.setdefault(slot, []).append(
                (clip_idx, c_idx, priority, jitter)
            )

    final: list[list[ArcPlacement]] = [[] for _ in range(n_clips)]
    # Process slots in order so the "fewer placements so far" tiebreaker can
    # keep redistributing fairly. Without this, a clip can be dropped at every
    # contested slot purely by random luck.
    clip_placement_count = [0] * n_clips
    for slot in sorted(slot_assignments.keys()):
        entries = slot_assignments[slot]
        if len(entries) > max_polyphony:
            entries.sort(key=lambda e: (-e[2], clip_placement_count[e[0]], e[3]))
            entries = entries[:max_polyphony]
        for clip_idx, chunk_idx, _prio, _jit in entries:
            final[clip_idx].append(
                {
                    "output_start_sec": float(slot * chunk_sec),
                    "chunk_idx": int(chunk_idx),
                }
            )
            clip_placement_count[clip_idx] += 1

    for placements in final:
        placements.sort(key=lambda p: p["output_start_sec"])

    return final


def schedule_clips_across_timeline(
    n_clips: int,
    total_sec: float,
    slot_sec: float,
    max_polyphony: int = MAX_POLYPHONY,
    density_target: float = WEAVE_DENSITY_TARGET,
    seed: int = 0,
) -> list[list[float]]:
    """Distribute N clips across the timeline as a list of slot start times.

    Returns `schedule[clip_idx]` = list of output start times in seconds.

    Each clip is given ~`density_target * n_slots / n_clips` placement
    occurrences (clamped to at least 1). Placements are spread approximately
    evenly across the timeline with a random offset per clip so clips don't
    line up rigidly. The polyphony cap is enforced as occurrences are
    placed; any rejected placement tries to fall back to an underfilled slot
    before giving up.
    """
    if n_clips <= 0 or total_sec <= 0 or slot_sec <= 0:
        return []
    if max_polyphony < 1:
        max_polyphony = 1

    n_slots = max(1, int(total_sec / slot_sec))
    per_clip_target = max(1, round(density_target * n_slots / n_clips))

    rng = random.Random(seed)
    slot_fill = [0] * n_slots
    schedule: list[list[float]] = [[] for _ in range(n_clips)]

    for clip_idx in range(n_clips):
        target = min(per_clip_target, n_slots)
        if target >= n_slots:
            candidate_slots = list(range(n_slots))
        else:
            stride = n_slots / target
            offset = rng.random() * stride
            candidate_slots = [
                int((i * stride + offset) % n_slots) for i in range(target)
            ]

        rng.shuffle(candidate_slots)
        placed: set[int] = set()
        for slot in candidate_slots:
            if slot in placed:
                continue
            if slot_fill[slot] < max_polyphony:
                slot_fill[slot] += 1
                placed.add(slot)
                schedule[clip_idx].append(slot * slot_sec)

        if len(placed) < target:
            remaining = sorted(
                (
                    s
                    for s in range(n_slots)
                    if s not in placed and slot_fill[s] < max_polyphony
                ),
                key=lambda s: slot_fill[s],
            )
            for slot in remaining[: target - len(placed)]:
                slot_fill[slot] += 1
                placed.add(slot)
                schedule[clip_idx].append(slot * slot_sec)

        schedule[clip_idx].sort()

    return schedule
