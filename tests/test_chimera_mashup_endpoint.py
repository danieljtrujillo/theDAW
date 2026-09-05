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

from backend.modules.chimera import analysis as chimera_analysis
from backend.modules.chimera.config import probe
from backend.modules.chimera.harmony import camelot, compatible
from backend.modules.chimera.router import router
from tests.chimera_synth import beat_times, synth_track


_TOOLS = probe()
_TOOLCHAIN_READY = _TOOLS["aubio"] and _TOOLS["ffmpeg"]


@pytest.fixture(scope="module")
def client() -> TestClient:
    app = FastAPI()
    app.include_router(router, prefix="/api/chimera")
    return TestClient(app)


@pytest.fixture(scope="module", autouse=True)
def _isolated_analysis_cache(tmp_path_factory: pytest.TempPathFactory):
    """Keep the sha256 analysis cache out of data/cache/chimera: every clip
    here is synthetic, and a persisted entry would let the known_analysis
    test pass without the client's data ever being used."""
    mp = pytest.MonkeyPatch()
    mp.setattr(chimera_analysis, "CACHE_DIR", tmp_path_factory.mktemp("chimera_cache"))
    yield
    mp.undo()


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
@pytest.mark.parametrize("engine", ["v1", "v2"])
def test_mashup_weave_mode_distributes_clips_across_long_timeline(
    client: TestClient, engine: str
):
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
            "engine": engine,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()

    assert body["align_mode_used"] == "weave"
    assert body["engine_used"] == engine

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


# ---------------------------------------------------------------------------
# v2 engine contract (align_mode='weave', engine='v2')
# ---------------------------------------------------------------------------

_V1_TOP_KEYS = {
    "mix_base64",
    "mime",
    "sample_rate",
    "duration_sec",
    "target_bpm_used",
    "target_bpm_source",
    "align_mode_used",
    "per_clip",
    "warnings",
}
_V2_TOP_KEYS = {
    "engine_used",
    "harmony_mode_used",
    "arc_used",
    "phrase_bars_used",
    "total_bars_used",
    "tempo_fit_pct",
    "bar_sec",
    "target_key",
    "target_scale",
    "target_camelot",
    "prompt_hint",
    "sections",
    "seams",
    "lane_lufs",
    "master_lufs",
    "true_peak_db",
    "limiter_gr_db",
    "analysis_sources",
}
_V1_CLIP_KEYS = {
    "index",
    "label",
    "detected_bpm",
    "beats",
    "stretch_ratio",
    "stretched_duration_sec",
    "window_start_sec",
    "window_end_sec",
    "weight_used",
    "placements",
    "note",
}
_V2_CLIP_KEYS = {
    "tempo_multiplier",
    "pitch_shift_semitones",
    "key",
    "scale",
    "key_confidence",
    "key_strength",
    "camelot",
    "atonal",
    "harmonic_outlier",
    "downbeat_phase",
    "downbeat_confidence",
    "phrase_phase",
    "phrase_confidence",
    "grid_locked",
    "lock_residual_ms",
    "beats_stretched",
    "sources_used",
    "conform_engine",
    "conform_preset",
    "phrases",
}
_V1_PLACEMENT_KEYS = {
    "output_start_sec",
    "output_end_sec",
    "window_start_sec",
    "window_end_sec",
    "chunk_idx",
    "rms",
}
_V2_PLACEMENT_KEYS = {
    "clip",
    "phrase_idx",
    "lane",
    "role",
    "run_id",
    "gain_db",
    "fade_in_sec",
    "fade_out_sec",
    "nominal_start_sec",
    "nominal_end_sec",
}
_LANES = {"lead", "support"}
_ROLES = {"full", "hp", "stem_found", "stem_layer"}
_SEAM_KINDS = {"lead_switch", "drop", "support_in", "support_out"}
_TRANSITIONS = {"blend", "cut", "fade"}

_v2_gate = pytest.mark.skipif(not _TOOLCHAIN_READY, reason="aubio or ffmpeg missing")


def _wav_bytes(audio: np.ndarray, sr: int = 44100) -> bytes:
    buf = io.BytesIO()
    sf.write(
        buf, np.asarray(audio, dtype=np.float32), sr, format="WAV", subtype="FLOAT"
    )
    return buf.getvalue()


def _post_weave(client: TestClient, clips: list[tuple[str, bytes]], **fields: object):
    """POST a weave/v2 request with the fields the frontend sends; ``fields``
    override any of them (values are stringified like form data)."""
    data: dict[str, str] = {
        "target_bpm": "auto",
        "weights": json.dumps([1.0] * len(clips)),
        "align_mode": "weave",
        "out_sr": "44100",
        "weave_bars": "0",
        "weave_total_bars": "0",
        "weave_max_polyphony": "0",
        "engine": "v2",
        "harmony": "auto",
        "arc": "song",
        "use_stems": "true",
        "seed": "0",
    }
    data.update({k: str(v) for k, v in fields.items()})
    return client.post(
        "/api/chimera/mashup",
        files=[("files", (name, b, "audio/wav")) for name, b in clips],
        data=data,
    )


def _decoded_wav(body: dict) -> tuple[np.ndarray, int]:
    wav_bytes = base64.b64decode(body["mix_base64"])
    audio, sr = sf.read(io.BytesIO(wav_bytes), dtype="float32")
    return audio, sr


def _all_placements(body: dict) -> list[dict]:
    return [p for pc in body["per_clip"] for p in pc["placements"]]


@pytest.fixture(scope="module")
def three_clicks_v2(client: TestClient) -> dict:
    """One shared v2 render: three 120 BPM click tracks (48 s), auto tempo,
    sized to a 30 s generation Length. Several contract tests read it."""
    if not _TOOLCHAIN_READY:
        pytest.skip("aubio or ffmpeg missing")
    clips = [
        (f"click_{i}.wav", _click_track(120.0, duration_sec=48.0)) for i in range(3)
    ]
    r = _post_weave(client, clips, target_duration_sec=30)
    assert r.status_code == 200, r.text
    return r.json()


@_v2_gate
def test_v2_response_is_additive(three_clicks_v2: dict):
    body = three_clicks_v2
    assert _V1_TOP_KEYS <= set(body), _V1_TOP_KEYS - set(body)
    assert _V2_TOP_KEYS <= set(body), _V2_TOP_KEYS - set(body)
    assert body["engine_used"] == "v2"
    assert body["align_mode_used"] == "weave"
    assert body["harmony_mode_used"] == "auto"
    assert body["arc_used"] == "song"
    assert body["mime"] == "audio/wav" and body["sample_rate"] == 44100
    assert body["phrase_bars_used"] == 8
    assert isinstance(body["total_bars_used"], int) and body["total_bars_used"] >= 4
    assert body["bar_sec"] == pytest.approx(240.0 / body["target_bpm_used"])
    assert isinstance(body["prompt_hint"], str) and "BPM" in body["prompt_hint"]
    assert isinstance(body["seams"], list)
    assert isinstance(body["lane_lufs"], dict) and "lead" in body["lane_lufs"]
    for k in ("master_lufs", "true_peak_db", "limiter_gr_db", "tempo_fit_pct"):
        assert isinstance(body[k], float), k
    assert len(body["analysis_sources"]) == 3
    assert set(body["analysis_sources"]) <= {"client", "cache", "computed", "mixed"}

    # sections tile the timeline in order
    sections = body["sections"]
    assert sections and sections[0]["start_sec"] == pytest.approx(0.0)
    assert sections[-1]["end_sec"] == pytest.approx(body["duration_sec"], abs=1e-6)
    for a, b in zip(sections, sections[1:]):
        assert a["end_sec"] == pytest.approx(b["start_sec"], abs=1e-6)
        assert a["start_sec"] < a["end_sec"]

    assert len(body["per_clip"]) == 3
    for pc in body["per_clip"]:
        assert _V1_CLIP_KEYS <= set(pc), _V1_CLIP_KEYS - set(pc)
        assert _V2_CLIP_KEYS <= set(pc), _V2_CLIP_KEYS - set(pc)
        assert pc["sources_used"] == "full"  # no library entry ids -> no stems
        assert pc["conform_engine"] in ("rubberband", "atempo")
        assert pc["conform_preset"] in ("percussive", "tonal", "default")
        assert isinstance(pc["beats_stretched"], list) and pc["beats_stretched"]
        if pc["tempo_multiplier"] == 1.0:
            assert len(pc["beats_stretched"]) == len(pc["beats"])
        assert isinstance(pc["phrases"], list) and pc["phrases"]
        for ph in pc["phrases"]:
            assert ph["start_sec"] < ph["end_sec"]
            assert ph["section_label"] in ("intro", "build", "peak", "body", "outro")
        for p in pc["placements"]:
            assert _V1_PLACEMENT_KEYS <= set(p), _V1_PLACEMENT_KEYS - set(p)
            assert _V2_PLACEMENT_KEYS <= set(p), _V2_PLACEMENT_KEYS - set(p)
            assert p["lane"] in _LANES and p["role"] in _ROLES
            assert p["clip"] == pc["index"]
            assert p["output_start_sec"] < p["output_end_sec"]
            assert p["window_start_sec"] < p["window_end_sec"]

    audio, sr = _decoded_wav(body)
    assert sr == 44100 and audio.ndim == 2 and audio.shape[1] == 2


@_v2_gate
def test_v2_target_duration_sizes_output(three_clicks_v2: dict):
    body = three_clicks_v2
    # weave_total_bars 0 + target_duration_sec 30 -> the mashup IS the Length
    assert 29.5 <= body["duration_sec"] <= 30.5, body["duration_sec"]
    assert body["target_bpm_source"] == "median"
    assert abs(body["target_bpm_used"] - 120.0) <= 0.03 * 120.0
    assert abs(body["tempo_fit_pct"]) <= 3.0
    placements = _all_placements(body)
    assert placements
    assert max(p["output_end_sec"] for p in placements) >= 29.0
    audio, sr = _decoded_wav(body)
    assert audio.shape[0] / sr == pytest.approx(body["duration_sec"], abs=0.05)


@_v2_gate
def test_v2_click_tracks_are_atonal(three_clicks_v2: dict):
    body = three_clicks_v2
    for pc in body["per_clip"]:
        assert pc["atonal"] is True
        assert pc["pitch_shift_semitones"] == 0.0
        assert pc["harmonic_outlier"] is False
    # nothing tonal -> no target key, and the hint is tempo-only
    assert body["target_key"] is None and body["target_camelot"] is None
    assert body["prompt_hint"] == f"{int(round(body['target_bpm_used']))} BPM"


@_v2_gate
def test_v2_harmony_off_zero_shifts(client: TestClient):
    clips = [
        ("a.wav", _wav_bytes(synth_track(120.0, 16, key=("A", "minor")))),
        ("b.wav", _wav_bytes(synth_track(120.0, 16, key=("B", "major")))),
    ]
    r = _post_weave(client, clips, harmony="off", target_duration_sec=24)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["harmony_mode_used"] == "off"
    assert body["target_key"] is None and body["target_scale"] is None
    for pc in body["per_clip"]:
        assert pc["pitch_shift_semitones"] == 0.0
        assert pc["harmonic_outlier"] is False


@_v2_gate
def test_v2_octave_clip_half_time(client: TestClient):
    """A 70 BPM clip next to a 140 BPM clip plays at double time (multiplier
    2) instead of being stretched 2x. The exact beat grids are supplied as
    known_analysis so the test pins the octave logic, not the beat tracker."""
    slow = synth_track(70.0, 16, pad=False)
    fast = synth_track(140.0, 32, pad=False)
    known = [
        {"bpm": 70.0, "beats": beat_times(70.0, 16)},
        {"bpm": 140.0, "beats": beat_times(140.0, 32)},
    ]
    r = _post_weave(
        client,
        [("slow.wav", _wav_bytes(slow)), ("fast.wav", _wav_bytes(fast))],
        known_analysis=json.dumps(known),
        target_duration_sec=30,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert abs(body["target_bpm_used"] - 140.0) <= 0.03 * 140.0, body["target_bpm_used"]
    slow_pc, fast_pc = body["per_clip"]
    assert slow_pc["detected_bpm"] == pytest.approx(70.0, abs=0.5)
    assert slow_pc["tempo_multiplier"] == 2.0
    assert 0.9 <= slow_pc["stretch_ratio"] <= 1.1, slow_pc["stretch_ratio"]
    assert len(slow_pc["beats_stretched"]) == 2 * len(slow_pc["beats"])
    assert fast_pc["tempo_multiplier"] == 1.0
    assert 0.9 <= fast_pc["stretch_ratio"] <= 1.1, fast_pc["stretch_ratio"]
    # the conformed length is the source length over the (octave-aware) ratio
    assert slow_pc["stretched_duration_sec"] == pytest.approx(
        len(slow) / 44100.0 / slow_pc["stretch_ratio"], rel=1e-3
    )


@_v2_gate
def test_v2_seams_inside_timeline_with_heal_windows(client: TestClient):
    clips = [
        (f"click_{i}.wav", _click_track(120.0, duration_sec=48.0)) for i in range(3)
    ]
    r = _post_weave(client, clips, target_duration_sec=60)
    assert r.status_code == 200, r.text
    body = r.json()
    total = body["duration_sec"]
    seams = body["seams"]
    assert isinstance(seams, list)
    healed = 0.0
    for s in seams:
        assert s["kind"] in _SEAM_KINDS and s["transition"] in _TRANSITIONS
        assert 0.0 <= s["heal_start_sec"] < s["heal_end_sec"] <= total + 1e-6, s
        assert s["heal_start_sec"] <= s["sec"] <= s["heal_end_sec"], s
        assert s["clips"] and all(0 <= c < 3 for c in s["clips"])
        assert s["lanes"] and set(s["lanes"]) <= _LANES
        healed += s["heal_end_sec"] - s["heal_start_sec"]
    assert healed <= 0.35 * total + 1e-6, (healed, total)


@_v2_gate
def test_v2_beats_stretched_on_grid(client: TestClient):
    clips = [
        (f"click_{i}.wav", _click_track(120.0, duration_sec=48.0)) for i in range(3)
    ]
    r = _post_weave(client, clips, target_bpm=120, target_duration_sec=30)
    assert r.status_code == 200, r.text
    body = r.json()
    beat_sec = 60.0 / body["target_bpm_used"]
    for pc in body["per_clip"]:
        bs = np.asarray(pc["beats_stretched"], dtype=np.float64)
        assert bs.size >= 8
        # the lattice runs through the first conformed beat (a click track
        # starting at t=0 makes this the same as k * 60 / target)
        rel = bs - bs[0]
        resid = np.abs(rel - np.round(rel / beat_sec) * beat_sec)
        assert float(resid.max()) <= 0.005, (
            f"clip {pc['index']}: max grid residual {resid.max() * 1000:.1f} ms "
            f"(grid_locked={pc['grid_locked']}, note={pc['note']!r})"
        )


@_v2_gate
def test_v2_known_analysis_skips_detection(
    client: TestClient, tmp_path, monkeypatch: pytest.MonkeyPatch
):
    """Full known_analysis entries (what /analyze returned) make the mashup
    skip the beat tracker entirely; a raising key detector only degrades the
    key to None, so the request still succeeds."""
    clips = [
        (f"click_{i}.wav", _click_track(120.0, duration_sec=24.0)) for i in range(2)
    ]
    known = []
    for name, b in clips:
        p = tmp_path / name
        p.write_bytes(b)
        a = chimera_analysis.analyze_clip(p, phrase_bars=8)
        known.append(chimera_analysis.to_known_analysis(a))

    calls = {"tempo": 0, "key": 0}

    def _no_tempo(*args, **kwargs):
        calls["tempo"] += 1
        raise RuntimeError("beat tracker must not run")

    def _no_key(*args, **kwargs):
        calls["key"] += 1
        raise RuntimeError("key detector down")

    import backend.modules.analysis.key as key_mod

    monkeypatch.setattr(chimera_analysis, "detect_tempo_and_beats", _no_tempo)
    monkeypatch.setattr(key_mod, "detect_key", _no_key)

    r = _post_weave(
        client, clips, known_analysis=json.dumps(known), target_duration_sec=20
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert calls["tempo"] == 0, "known bpm/beats were not used"
    assert set(body["analysis_sources"]) <= {"client", "mixed"}
    for pc, k in zip(body["per_clip"], known):
        assert pc["detected_bpm"] == pytest.approx(k["bpm"], abs=0.5)
        assert len(pc["beats"]) == len(k["beats"])
        if k["key"] is not None:
            # a known key group is trusted as-is (the detector never runs)
            assert pc["key"] == k["key"] and pc["scale"] == k["scale"]
        else:
            # a client 'no key' means 'not analysed'; the raising detector
            # degraded to no key instead of failing the request
            assert pc["key"] is None
    if all(k["key"] is not None for k in known):
        assert calls["key"] == 0, "known key group was not used"


@pytest.mark.skipif(
    not (_TOOLCHAIN_READY and _TOOLS.get("rubberband_pitch")),
    reason="aubio, ffmpeg or rubberband pitch shifting missing",
)
def test_v2_synth_tracks_in_two_keys_shift_one_clip(client: TestClient):
    clips = [
        ("am.wav", _wav_bytes(synth_track(120.0, 16, key=("A", "minor")))),
        ("bmaj.wav", _wav_bytes(synth_track(120.0, 16, key=("B", "major")))),
    ]
    r = _post_weave(client, clips, target_duration_sec=24)
    assert r.status_code == 200, r.text
    body = r.json()
    pcs = body["per_clip"]
    for pc in pcs:
        assert pc["atonal"] is False, pc
        assert pc["key"] is not None and pc["camelot"] is not None
    assert body["target_key"] is not None and body["target_camelot"] is not None
    shifts = [abs(int(round(pc["pitch_shift_semitones"]))) for pc in pcs]
    cams = [camelot(pc["key"], pc["scale"]) for pc in pcs]
    if compatible(cams[0], cams[1]):
        assert shifts == [0, 0], shifts
    else:
        assert sorted(shifts)[0] == 0 and sorted(shifts)[1] in (1, 2), shifts
    assert not any(pc["harmonic_outlier"] for pc in pcs)
    assert "key of" in body["prompt_hint"]
