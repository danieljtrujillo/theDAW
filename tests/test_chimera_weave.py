"""Unit tests for backend.modules.chimera.weave."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from backend.modules.chimera.weave import (
    BEATS_PER_BAR,
    MAX_POLYPHONY,
    WEAVE_CHUNK_BARS_DEFAULT,
    WEAVE_TOTAL_BARS_DEFAULT,
    bar_duration_sec,
    compute_chunk_candidates,
    compute_chunks_sequential,
    resolve_chunk_bars,
    resolve_total_bars,
    scale_beats,
    schedule_clips_across_timeline,
    schedule_song_arc,
)


def _synth_two_region_track(
    quiet_dur_sec: float,
    loud_dur_sec: float,
    bpm: float = 120.0,
    sr: int = 44100,
) -> tuple[np.ndarray, list[float]]:
    """Builds a track that's quiet then loud, with beat markers at the BPM grid.

    Returns (audio_mono, beat_times_sec). Beats are evenly spaced from t=0.
    """
    total = quiet_dur_sec + loud_dur_sec
    n = int(total * sr)
    audio = np.zeros(n, dtype=np.float32)

    # Loud half = full-amplitude sine
    t = np.arange(int(loud_dur_sec * sr), dtype=np.float32) / sr
    loud = 0.7 * np.sin(2 * np.pi * 440.0 * t).astype(np.float32)
    loud_start = int(quiet_dur_sec * sr)
    audio[loud_start : loud_start + len(loud)] += loud

    # Quiet half = very low-amplitude sine (not silence, so RMS is non-zero)
    tq = np.arange(int(quiet_dur_sec * sr), dtype=np.float32) / sr
    audio[: len(tq)] += 0.005 * np.sin(2 * np.pi * 440.0 * tq).astype(np.float32)

    # Beat grid
    period = 60.0 / bpm
    beats: list[float] = []
    t_cur = 0.0
    while t_cur < total:
        beats.append(t_cur)
        t_cur += period

    return audio, beats


def test_bar_duration_sec_basic():
    assert bar_duration_sec(120.0) == pytest.approx(2.0)
    assert bar_duration_sec(60.0) == pytest.approx(4.0)
    assert bar_duration_sec(0.0) == 0.0


def test_scale_beats_speedup_compresses_positions():
    beats = [0.0, 0.5, 1.0, 1.5]
    out = scale_beats(beats, stretch_ratio=2.0)
    assert out == pytest.approx([0.0, 0.25, 0.5, 0.75])


def test_scale_beats_slowdown_expands_positions():
    out = scale_beats([0.0, 1.0, 2.0], stretch_ratio=0.5)
    assert out == pytest.approx([0.0, 2.0, 4.0])


def test_scale_beats_zero_ratio_returns_originals():
    beats = [0.0, 1.0, 2.0]
    assert scale_beats(beats, 0.0) == beats


def test_resolve_chunk_bars_zero_returns_default():
    assert resolve_chunk_bars(0) == WEAVE_CHUNK_BARS_DEFAULT


def test_resolve_chunk_bars_clamps_to_range():
    assert resolve_chunk_bars(1) >= 2  # min
    assert resolve_chunk_bars(1000) <= 32  # max


def test_resolve_chunk_bars_honors_in_range():
    assert resolve_chunk_bars(8) == 8


def test_resolve_total_bars_zero_returns_default():
    assert resolve_total_bars(0) == WEAVE_TOTAL_BARS_DEFAULT


def test_resolve_total_bars_clamps_to_range():
    assert resolve_total_bars(1) >= 16  # min
    assert resolve_total_bars(10000) <= 256  # max


def test_schedule_distributes_clips_across_timeline():
    # 5 clips, 180s total, 16s chunks → ~11 slots
    schedule = schedule_clips_across_timeline(
        n_clips=5, total_sec=180.0, slot_sec=16.0, max_polyphony=3, seed=42
    )
    assert len(schedule) == 5
    # With density 1.5 and 11 slots / 5 clips, each clip gets ~3 placements
    for clip_occurrences in schedule:
        assert len(clip_occurrences) >= 2, "every clip should get multiple slots"
        assert len(clip_occurrences) <= 11


def test_schedule_respects_polyphony_cap_at_every_slot():
    schedule = schedule_clips_across_timeline(
        n_clips=8, total_sec=120.0, slot_sec=10.0, max_polyphony=3, seed=42
    )
    # Count occurrences per slot
    slot_counts: dict[float, int] = {}
    for occurrences in schedule:
        for t in occurrences:
            slot_counts[t] = slot_counts.get(t, 0) + 1
    for slot, count in slot_counts.items():
        assert count <= 3, f"slot {slot} has polyphony {count} > 3"


def test_schedule_returns_empty_for_zero_clips():
    assert schedule_clips_across_timeline(0, 100.0, 10.0) == []


def test_schedule_returns_empty_for_zero_total():
    assert schedule_clips_across_timeline(3, 0.0, 10.0) == []


def test_schedule_seed_is_deterministic():
    a = schedule_clips_across_timeline(4, 100.0, 10.0, seed=7)
    b = schedule_clips_across_timeline(4, 100.0, 10.0, seed=7)
    assert a == b


def test_max_polyphony_constant_is_three():
    # Locking in the user's "up to 3 overlaps max" requirement.
    assert MAX_POLYPHONY == 3


def test_compute_chunk_candidates_returns_multiple_high_energy_chunks(tmp_path):
    sr = 44100
    bpm = 120.0
    # 32s = 16 bars at 120 BPM. Three loud regions interleaved with quiet.
    n = int(32 * sr)
    audio = np.zeros(n, dtype=np.float32)
    t = np.arange(n, dtype=np.float32) / sr
    base_sine = 0.7 * np.sin(2 * np.pi * 440.0 * t).astype(np.float32)
    quiet = 0.005 * base_sine
    audio[:] = quiet
    # Loud sections at 4-12s, 16-22s, 24-30s
    audio[int(4 * sr) : int(12 * sr)] = base_sine[int(4 * sr) : int(12 * sr)]
    audio[int(16 * sr) : int(22 * sr)] = base_sine[int(16 * sr) : int(22 * sr)]
    audio[int(24 * sr) : int(30 * sr)] = base_sine[int(24 * sr) : int(30 * sr)]

    wav = tmp_path / "three_loud.wav"
    sf.write(str(wav), audio, sr)

    beats = [i * (60.0 / bpm) for i in range(64)]  # 32s of beat markers
    candidates = compute_chunk_candidates(
        wav, beats, bpm, chunk_bars=4, max_candidates=10
    )

    assert len(candidates) >= 2, f"expected multiple chunks, got {len(candidates)}"
    # They should be sorted by RMS descending
    for i in range(len(candidates) - 1):
        assert candidates[i]["rms"] >= candidates[i + 1]["rms"]
    # Chunks shouldn't overlap
    for i in range(len(candidates)):
        for j in range(i + 1, len(candidates)):
            a, b = candidates[i], candidates[j]
            overlaps = not (
                a["end_sec"] <= b["start_sec"] or b["end_sec"] <= a["start_sec"]
            )
            assert not overlaps, f"chunks {i} and {j} overlap"


def test_compute_chunk_candidates_handles_short_clip(tmp_path: Path):
    sr = 44100
    audio = (
        0.5 * np.sin(2 * np.pi * 440 * np.arange(sr, dtype=np.float32) / sr)
    ).astype(np.float32)
    wav = tmp_path / "short.wav"
    sf.write(str(wav), audio, sr)

    # 8 bars at 120 BPM = 16s, but the clip is only 1s
    candidates = compute_chunk_candidates(wav, [0.0, 0.5], 120.0, chunk_bars=8)

    assert len(candidates) == 1
    assert candidates[0]["start_sec"] == 0.0
    assert candidates[0]["end_sec"] == pytest.approx(1.0, abs=0.01)


def test_compute_chunk_candidates_no_beats_falls_back_to_stride(tmp_path: Path):
    sr = 44100
    bpm = 120.0
    audio, _ = _synth_two_region_track(
        quiet_dur_sec=8.0, loud_dur_sec=8.0, bpm=bpm, sr=sr
    )
    wav = tmp_path / "no_beats.wav"
    sf.write(str(wav), audio, sr)

    candidates = compute_chunk_candidates(wav, [], bpm, chunk_bars=4, max_candidates=3)

    assert len(candidates) >= 1
    # The highest-RMS chunk should be in the loud region (after 8s)
    assert candidates[0]["start_sec"] >= 6.0
    assert candidates[0]["rms"] > 0.1


def test_beats_per_bar_constant_is_four():
    # Locking in the assumption so a future change is intentional.
    assert BEATS_PER_BAR == 4


def test_compute_chunks_sequential_returns_chunks_in_source_order(tmp_path: Path):
    # Three contiguous loud regions of equal length; chunks should come out
    # in source order regardless of RMS.
    sr = 44100
    bpm = 120.0
    n = int(24 * sr)
    audio = np.zeros(n, dtype=np.float32)
    t = np.arange(n, dtype=np.float32) / sr
    base = 0.7 * np.sin(2 * np.pi * 440.0 * t).astype(np.float32)
    audio[: int(8 * sr)] = base[: int(8 * sr)] * 0.4  # quietest intro
    audio[int(8 * sr) : int(16 * sr)] = (
        base[int(8 * sr) : int(16 * sr)] * 1.0
    )  # loud middle
    audio[int(16 * sr) :] = base[int(16 * sr) :] * 0.6  # mid outro

    wav = tmp_path / "three_section.wav"
    sf.write(str(wav), audio, sr)
    beats = [i * (60.0 / bpm) for i in range(48)]

    chunks = compute_chunks_sequential(wav, beats, bpm, chunk_bars=4)

    # 24s / 8s (4 bars at 120 BPM) = 3 non-overlapping chunks
    assert len(chunks) == 3
    # In source order
    for i in range(len(chunks) - 1):
        assert chunks[i]["start_sec"] < chunks[i + 1]["start_sec"]
    # First chunk is from clip start, last is from clip end
    assert chunks[0]["start_sec"] == 0.0
    assert chunks[-1]["end_sec"] == pytest.approx(24.0, abs=0.1)


def test_schedule_song_arc_intro_lands_at_start_and_outro_at_end():
    # 3 clips each with 5 chunks; timeline expects 10 slots.
    chunks_per_clip = [
        [
            {"start_sec": float(i) * 8.0, "end_sec": float(i + 1) * 8.0, "rms": 0.5}
            for i in range(5)
        ]
        for _ in range(3)
    ]
    schedule = schedule_song_arc(
        chunks_per_clip, target_total_sec=80.0, chunk_sec=8.0, max_polyphony=3, seed=1
    )
    # Every clip's first placement should be its chunk #0 (intro)
    for clip_placements in schedule:
        assert clip_placements, "expected placements for each clip"
        # In source order
        for i in range(len(clip_placements) - 1):
            assert (
                clip_placements[i]["chunk_idx"] <= clip_placements[i + 1]["chunk_idx"]
            )
        # First chunk lands near start
        assert clip_placements[0]["chunk_idx"] == 0
        assert clip_placements[0]["output_start_sec"] == 0.0
        # Last chunk lands near end
        assert clip_placements[-1]["chunk_idx"] == 4  # last chunk
        assert clip_placements[-1]["output_start_sec"] == pytest.approx(72.0, abs=0.01)


def test_schedule_song_arc_short_clip_scatters_across_timeline():
    # One full-length clip (10 chunks) + one short clip (3 chunks).
    # Timeline = 10 slots. The short clip's 3 chunks should appear at slot
    # 0, 4 or 5, and 9 — spread across the full timeline, not bunched at
    # the front.
    chunks_per_clip = [
        [
            {"start_sec": float(i) * 8.0, "end_sec": float(i + 1) * 8.0, "rms": 0.5}
            for i in range(10)
        ],
        [
            {"start_sec": float(i) * 8.0, "end_sec": float(i + 1) * 8.0, "rms": 0.5}
            for i in range(3)
        ],
    ]
    schedule = schedule_song_arc(
        chunks_per_clip, target_total_sec=80.0, chunk_sec=8.0, max_polyphony=3, seed=1
    )
    short_placements = schedule[1]
    assert len(short_placements) == 3
    starts = [p["output_start_sec"] for p in short_placements]
    # First placement at slot 0, last placement at the final slot
    assert starts[0] == 0.0
    assert starts[-1] == pytest.approx(72.0, abs=0.01)
    # Middle placement should be in the middle of the timeline (slot 4 or 5)
    mid = starts[1]
    assert 24.0 <= mid <= 48.0, f"middle placement bunched: {starts}"


def test_schedule_song_arc_respects_polyphony_cap():
    # 8 clips, 5 slots — slots will be oversubscribed; cap should hold.
    chunks_per_clip = [
        [
            {"start_sec": float(i) * 8.0, "end_sec": float(i + 1) * 8.0, "rms": 0.5}
            for i in range(5)
        ]
        for _ in range(8)
    ]
    schedule = schedule_song_arc(
        chunks_per_clip, target_total_sec=40.0, chunk_sec=8.0, max_polyphony=3, seed=7
    )
    slot_counts: dict[float, int] = {}
    for clip_placements in schedule:
        for p in clip_placements:
            slot_counts[p["output_start_sec"]] = (
                slot_counts.get(p["output_start_sec"], 0) + 1
            )
    for slot, count in slot_counts.items():
        assert count <= 3, f"slot {slot} has polyphony {count} > 3"
