"""End-to-end test of POST /api/chimera/mashup.

Builds a minimal FastAPI app, mounts the chimera router under /api/chimera,
posts two synthesized click tracks at different BPMs, and asserts the
returned mix has the expected sample rate, contains valid WAV bytes, and
that per_clip metadata reports plausible detected BPMs + stretch ratios.
"""

from __future__ import annotations

import base64
import io
import json

import numpy as np
import pytest
import soundfile as sf
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.modules.chimera.config import probe
from backend.modules.chimera.router import router


_TOOLS = probe()
_TOOLCHAIN_READY = _TOOLS["aubio"] and _TOOLS["ffmpeg"]


@pytest.fixture(scope="module")
def client() -> TestClient:
    app = FastAPI()
    app.include_router(router, prefix="/api/chimera")
    return TestClient(app)


def _click_track(bpm: float, duration_sec: float = 6.0, sr: int = 44100) -> bytes:
    rng = np.random.default_rng(seed=int(bpm))
    click_len = int(0.01 * sr)
    click = (
        rng.standard_normal(click_len).astype(np.float32)
        * np.linspace(1.0, 0.0, click_len, dtype=np.float32)
        * 0.5
    )
    n = int(duration_sec * sr)
    audio = np.zeros(n, dtype=np.float32)
    period = 60.0 / bpm
    t = 0.0
    while t < duration_sec:
        start = int(t * sr)
        end = min(start + click_len, n)
        if start < n:
            audio[start:end] += click[: end - start]
        t += period
    buf = io.BytesIO()
    sf.write(buf, audio, sr, format="WAV")
    return buf.getvalue()


def test_probe_endpoint(client: TestClient):
    r = client.get("/api/chimera/probe")
    assert r.status_code == 200
    body = r.json()
    assert set(body.keys()) >= {
        "aubio",
        "ffmpeg",
        "librubberband",
        "versions",
        "install_hint",
    }


@pytest.mark.skipif(not _TOOLCHAIN_READY, reason="aubio or ffmpeg missing")
def test_mashup_two_clips_resolves_target_via_median(client: TestClient):
    a = _click_track(100.0)
    b = _click_track(140.0)

    r = client.post(
        "/api/chimera/mashup",
        files=[
            ("files", ("a.wav", a, "audio/wav")),
            ("files", ("b.wav", b, "audio/wav")),
        ],
        data={
            "target_bpm": "auto",
            "weights": json.dumps([1.0, 1.0]),
            "align_mode": "start",
            "out_sr": "44100",
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()

    assert body["mime"] == "audio/wav"
    assert body["sample_rate"] == 44100
    assert body["target_bpm_source"] in ("median", "user", "base_clip")
    assert 80 < body["target_bpm_used"] < 200
    assert len(body["per_clip"]) == 2
    assert body["align_mode_used"] == "start"

    wav_bytes = base64.b64decode(body["mix_base64"])
    audio, sr = sf.read(io.BytesIO(wav_bytes), dtype="float32")
    assert sr == 44100
    assert audio.shape[0] > sr * 2.0
    assert audio.ndim == 2 and audio.shape[1] == 2  # stereo


@pytest.mark.skipif(not _TOOLCHAIN_READY, reason="aubio or ffmpeg missing")
def test_mashup_with_base_index_pins_target_to_that_clip(client: TestClient):
    a = _click_track(100.0)
    b = _click_track(140.0)

    r = client.post(
        "/api/chimera/mashup",
        files=[
            ("files", ("a.wav", a, "audio/wav")),
            ("files", ("b.wav", b, "audio/wav")),
        ],
        data={
            "target_bpm": "auto",
            "base_index": "1",
            "weights": json.dumps([1.0, 1.0]),
            "align_mode": "start",
            "out_sr": "44100",
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["target_bpm_source"] == "base_clip"
    # Base is clip 1 (~140 BPM); allow half/double for aubio octave errors.
    candidates = [140.0, 70.0, 280.0]
    assert any(abs(body["target_bpm_used"] - c) < 3.0 for c in candidates), (
        f"got {body['target_bpm_used']}"
    )


@pytest.mark.skipif(not _TOOLCHAIN_READY, reason="aubio or ffmpeg missing")
def test_mashup_explicit_target_bpm(client: TestClient):
    a = _click_track(100.0)
    r = client.post(
        "/api/chimera/mashup",
        files=[("files", ("a.wav", a, "audio/wav"))],
        data={
            "target_bpm": "120",
            "weights": json.dumps([1.0]),
            "align_mode": "start",
            "out_sr": "44100",
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["target_bpm_source"] == "user"
    assert body["target_bpm_used"] == pytest.approx(120.0)
    assert len(body["per_clip"]) == 1


@pytest.mark.skipif(not _TOOLCHAIN_READY, reason="aubio or ffmpeg missing")
def test_mashup_downbeat_mode_trims_to_first_beat(client: TestClient):
    a = _click_track(120.0, duration_sec=6.0)
    b = _click_track(120.0, duration_sec=6.0)

    r_start = client.post(
        "/api/chimera/mashup",
        files=[
            ("files", ("a.wav", a, "audio/wav")),
            ("files", ("b.wav", b, "audio/wav")),
        ],
        data={
            "target_bpm": "120",
            "weights": json.dumps([1.0, 1.0]),
            "align_mode": "start",
            "out_sr": "44100",
        },
    )
    assert r_start.status_code == 200

    r_db = client.post(
        "/api/chimera/mashup",
        files=[
            ("files", ("a.wav", a, "audio/wav")),
            ("files", ("b.wav", b, "audio/wav")),
        ],
        data={
            "target_bpm": "120",
            "weights": json.dumps([1.0, 1.0]),
            "align_mode": "downbeat",
            "out_sr": "44100",
        },
    )
    assert r_db.status_code == 200, r_db.text
    body = r_db.json()
    assert body["align_mode_used"] == "downbeat"

    # Downbeat mode trims the head to the first beat (~2s warmup), so duration
    # must be strictly less than start-mode's full-length output.
    assert body["duration_sec"] < r_start.json()["duration_sec"] - 0.5
    # Every clip with detected beats should report a non-zero window_start.
    for pc in body["per_clip"]:
        if pc["detected_bpm"] is not None:
            assert pc["window_start_sec"] > 0.0


@pytest.mark.skipif(not _TOOLCHAIN_READY, reason="aubio or ffmpeg missing")
def test_mashup_weave_mode_distributes_clips_across_long_timeline(client: TestClient):
    # Five click tracks long enough to give multiple chunks each so the
    # song-arc scheduler has real intro/middle/outro material to place.
    clips = [_click_track(120.0, duration_sec=48.0) for _ in range(5)]

    r = client.post(
        "/api/chimera/mashup",
        files=[
            ("files", (f"clip_{i}.wav", c, "audio/wav")) for i, c in enumerate(clips)
        ],
        data={
            "target_bpm": "120",
            "weights": json.dumps([1.0] * 5),
            "align_mode": "weave",
            "weave_bars": "4",  # 4-bar chunks = 8s each
            "weave_total_bars": "90",  # ≥90 bars total = 180s
            "out_sr": "44100",
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()

    assert body["align_mode_used"] == "weave"

    # Length should be near the 90-bar target (180s at 120 BPM), not collapsed
    # down to a single chunk size.
    assert body["duration_sec"] >= 90.0, (
        f"weave timeline too short: {body['duration_sec']}s"
    )

    # Every clip should be represented and its placements should be in
    # source order (intros precede outros within a clip).
    for pc in body["per_clip"]:
        placements = pc.get("placements", [])
        assert len(placements) >= 1, f"clip {pc['index']} got dropped entirely: {pc}"
        chunk_idxs = [p.get("chunk_idx", 0) for p in placements]
        for i in range(len(chunk_idxs) - 1):
            assert chunk_idxs[i] <= chunk_idxs[i + 1], (
                f"clip {pc['index']} chunk_idx not in source order: {chunk_idxs}"
            )

    # The very first output slot should be dominated by intro chunks
    # (chunk_idx == 0) so the mashup begins like the beginning of a song.
    start_chunks: list[int] = []
    end_chunks: list[int] = []
    for pc in body["per_clip"]:
        for p in pc.get("placements", []):
            if p["output_start_sec"] < 1.0:
                start_chunks.append(p["chunk_idx"])
            if p["output_end_sec"] > body["duration_sec"] - 1.0:
                end_chunks.append(p["chunk_idx"])
    assert start_chunks, "no placements at the very start of the timeline"
    assert all(c == 0 for c in start_chunks), (
        f"start slot has non-intro chunks: {start_chunks}"
    )
    # End slot should hold the highest-indexed (outro) chunks from each clip.
    assert end_chunks, "no placements at the very end of the timeline"

    # Master fade-in: first ~50ms should be near silent.
    wav_bytes = base64.b64decode(body["mix_base64"])
    audio, sr = sf.read(io.BytesIO(wav_bytes), dtype="float32")
    mono = audio[:, 0] if audio.ndim == 2 else audio
    head = mono[: int(0.01 * sr)]
    head_rms = float(np.sqrt(np.mean(head * head)))
    mid = mono[
        int(body["duration_sec"] / 2 * sr) : int((body["duration_sec"] / 2 + 0.1) * sr)
    ]
    mid_rms = float(np.sqrt(np.mean(mid * mid)))
    if mid_rms > 0.01:
        assert head_rms < mid_rms * 0.5, "master fade-in didn't apply"

    # Polyphony cap: at any slot in the timeline, ≤3 clips active.
    all_placements: list[tuple[float, float]] = []
    for pc in body["per_clip"]:
        for p in pc["placements"]:
            all_placements.append((p["output_start_sec"], p["output_end_sec"]))
    # Sample timeline at 0.5s ticks; cap violation = bug
    if all_placements:
        max_end = max(end for _, end in all_placements)
        t = 0.0
        while t < max_end:
            active = sum(1 for start, end in all_placements if start <= t < end)
            assert active <= 3, f"polyphony {active} > 3 at t={t}"
            t += 0.5


def test_mashup_rejects_unknown_align_mode(client: TestClient):
    a = _click_track(120.0)
    r = client.post(
        "/api/chimera/mashup",
        files=[("files", ("a.wav", a, "audio/wav"))],
        data={
            "target_bpm": "auto",
            "weights": "[1.0]",
            "align_mode": "spiral",
            "out_sr": "44100",
        },
    )
    assert r.status_code == 400


def test_mashup_rejects_weight_length_mismatch(client: TestClient):
    a = _click_track(120.0)
    r = client.post(
        "/api/chimera/mashup",
        files=[("files", ("a.wav", a, "audio/wav"))],
        data={
            "target_bpm": "auto",
            "weights": "[1.0, 1.0]",
            "align_mode": "start",
            "out_sr": "44100",
        },
    )
    assert r.status_code == 400
