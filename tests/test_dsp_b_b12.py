"""Batch-12 T13 tests: FX-003 (Parametric EQ sends/applies all 5 bands, with
ranges matching what the pages can send) and FX-006 (Smart Export true-peak
is measured, surfaced via a valid WAV tag, and logged; Batch Export is a
single-file encode whose Jobs knob sets how many run at once)."""

from __future__ import annotations

import asyncio
import re
import shutil
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from backend.modules.delivery import router as delivery_router
from backend.modules.mastering.router import TOOLS as MASTERING_TOOLS
from backend.modules.mastering.router import _eq
from backend.modules.mastering.router import _maximizer

SR = 44100


def _needs_ffmpeg():
    if shutil.which("ffmpeg") is None:
        pytest.skip("ffmpeg not on PATH")


def _tone(seconds: float = 0.5, sr: int = SR, freq: float = 440.0) -> np.ndarray:
    t = np.linspace(0, seconds, int(sr * seconds), endpoint=False, dtype=np.float64)
    return (0.2 * np.sin(2 * np.pi * freq * t)).astype(np.float64)


def _write_wav(path: Path, sr: int = SR) -> Path:
    sf.write(str(path), _tone(sr=sr), sr, subtype="PCM_16")
    return path


# ---------------------------------------------------------------------------
# FX-003 — Parametric EQ: 5 bands, not 3
# ---------------------------------------------------------------------------


def _five_band_params() -> dict:
    return {
        "lowFreq": 80,
        "lowGain": 2.0,
        "lowMidFreq": 300,
        "lowMidGain": -3.0,
        "lowMidQ": 1.5,
        "midFreq": 1000,
        "midGain": 1.0,
        "midQ": 1.2,
        "highMidFreq": 3500,
        "highMidGain": -1.5,
        "highMidQ": 1.8,
        "highFreq": 10000,
        "highGain": 4.0,
        "outputGain": -1.0,
    }


def test_eq_filter_string_carries_all_five_bands():
    """_eq() must emit five distinct filter stages: bass, two `equalizer`
    bell stages (low-mid, high-mid), the pre-existing mid `equalizer` stage,
    and treble — not the old 3-band subset."""
    args = _eq(_five_band_params())
    assert args[0] == "-af"
    chain = args[1]
    stages = chain.split(",")

    assert any(s.startswith("bass=g=2.0:f=80") for s in stages)
    assert any(s.startswith("treble=g=4.0:f=10000") for s in stages)
    assert stages[-1] == "volume=-1.0dB"

    eq_stages = [s for s in stages if s.startswith("equalizer=")]
    assert len(eq_stages) == 3, f"expected 3 `equalizer=` bell stages, got {eq_stages}"
    freqs = {int(re.search(r"f=(\d+)", s).group(1)) for s in eq_stages}
    assert freqs == {300, 1000, 3500}

    lowmid = next(s for s in eq_stages if "f=300" in s)
    assert "w=1.5" in lowmid and "g=-3.0" in lowmid
    himid = next(s for s in eq_stages if "f=3500" in s)
    assert "w=1.8" in himid and "g=-1.5" in himid


def test_eq_missing_band_param_raises_keyerror():
    """_eq() called directly (bypassing validate_params) still needs every
    band key — it does no defaulting of its own. This is NOT what a real
    3-band caller experiences through /process: see
    test_three_band_params_fill_defaults_through_validate_params_and_render
    below, where ToolSpec.validate_params fills the missing bands from their
    declared defaults before _eq ever runs."""
    params = _five_band_params()
    del params["lowMidFreq"]
    with pytest.raises(KeyError):
        _eq(params)


def test_three_band_params_fill_defaults_through_validate_params_and_render():
    """A caller still sending only the pre-FX-003 3-band subset (low/mid/high)
    must not be rejected: validate_params fills the missing low-mid/high-mid
    keys from the ToolSpec's declared defaults, and the resulting filter
    chain still renders."""
    spec = next(t for t in MASTERING_TOOLS if t.id == "parametric_eq")
    three_band = {
        "lowFreq": 80,
        "lowGain": 2.0,
        "midFreq": 1000,
        "midGain": 1.0,
        "midQ": 1.2,
        "highFreq": 10000,
        "highGain": 4.0,
        "outputGain": -1.0,
    }
    validated = spec.validate_params(three_band)
    # The defaults for the bands this caller never mentioned must be present.
    assert validated["lowMidFreq"] == 300
    assert validated["highMidFreq"] == 3500
    rendered = _eq(validated)
    assert rendered[0] == "-af"
    stages = rendered[1].split(",")
    assert len(stages) == 6  # bass, 3x equalizer, treble, volume


def test_parametric_eq_toolspec_declares_all_five_bands():
    """The ToolSpec's declared params gate what validate_params keeps — an
    un-declared band would be silently dropped before _eq ever sees it."""
    spec = next(t for t in MASTERING_TOOLS if t.id == "parametric_eq")
    names = {p.name for p in spec.params}
    for band_param in (
        "lowFreq",
        "lowGain",
        "lowMidFreq",
        "lowMidGain",
        "lowMidQ",
        "midFreq",
        "midGain",
        "midQ",
        "highMidFreq",
        "highMidGain",
        "highMidQ",
        "highFreq",
        "highGain",
        "outputGain",
    ):
        assert band_param in names, f"{band_param} missing from parametric_eq params"
    validated = spec.validate_params(_five_band_params())
    # validate_params must round-trip every band value through to _eq unharmed.
    rendered = _eq(validated)
    assert "f=300" in rendered[1] and "f=3500" in rendered[1]


def test_parametric_eq_ranges_match_what_the_pages_can_send():
    """FX-003 audit (T13c, item 3): parametric-eq.html's Frequency/Q sliders
    are shared across all 5 bands with no per-band clamp (20-20000 Hz,
    0.1-18 Q), so a value the old, narrower per-band ranges rejected with a
    bare 400 — e.g. a low shelf dragged to 15000 Hz, or any band's Q pushed
    to 15 — was reachable from the live UI, not just a hypothetical client.
    """
    spec = next(t for t in MASTERING_TOOLS if t.id == "parametric_eq")
    by_name = {p.name: p for p in spec.params}

    # Every band's frequency must accept the page's full 20-20000 Hz range,
    # bell and shelf alike (the pages disagreed on shelf ranges too — the
    # backend now matches the wider, actually-reachable one).
    for freq_param in (
        "lowFreq",
        "lowMidFreq",
        "midFreq",
        "highMidFreq",
        "highFreq",
    ):
        p = by_name[freq_param]
        assert p.lo == 20, f"{freq_param}.lo should be 20, got {p.lo}"
        assert p.hi == 20000, f"{freq_param}.hi should be 20000, got {p.hi}"

    for q_param in ("lowMidQ", "midQ", "highMidQ"):
        p = by_name[q_param]
        assert p.lo == 0.1, f"{q_param}.lo should be 0.1, got {p.lo}"
        assert p.hi == 18, f"{q_param}.hi should be 18, got {p.hi}"

    # Values the pre-widen ranges rejected must now validate cleanly.
    wide_params = {
        "lowFreq": 15000,  # old hi was 500
        "lowGain": 0,
        "lowMidFreq": 20,  # old lo was 100
        "lowMidGain": 0,
        "lowMidQ": 15,  # old hi was 10
        "midFreq": 20000,  # old hi was 8000
        "midGain": 0,
        "midQ": 15,  # old hi was 10
        "highMidFreq": 500,  # old lo was 1000
        "highMidGain": 0,
        "highMidQ": 15,  # old hi was 10
        "highFreq": 20,  # old lo was 2000
        "highGain": 0,
        "outputGain": 0,
    }
    validated = spec.validate_params(wide_params)  # must not raise ValueError
    rendered = _eq(validated)
    assert "f=15000" in rendered[1] and "f=20" in rendered[1]


def test_midq_default_is_one_not_one_point_five():
    """Item 4: midQ's default was 1.0 before FX-003 and must stay 1.0 — the
    1.5 it briefly carried was an unrequested change."""
    spec = next(t for t in MASTERING_TOOLS if t.id == "parametric_eq")
    midq = next(p for p in spec.params if p.name == "midQ")
    assert midq.default == 1.0


FIVE_BAND_PARAM_KEYS = (
    "lowFreq",
    "lowGain",
    "lowMidFreq",
    "lowMidGain",
    "lowMidQ",
    "midFreq",
    "midGain",
    "midQ",
    "highMidFreq",
    "highMidGain",
    "highMidQ",
    "highFreq",
    "highGain",
    "outputGain",
)


def _assert_sends_all_five_bands(html_filename: str, object_pattern: str) -> None:
    html_path = (
        Path(__file__).resolve().parents[1]
        / "frontend"
        / "public"
        / "edit-modules"
        / html_filename
    )
    src = html_path.read_text(encoding="utf-8")
    m = re.search(object_pattern, src, re.S)
    assert m, f"could not find the params object literal in {html_filename}"
    body = m.group(1)
    for key in FIVE_BAND_PARAM_KEYS:
        assert re.search(rf"\b{key}\s*:", body), (
            f"{key} missing from the sent params in {html_filename}"
        )


def test_parametric_eq_html_sends_all_five_bands():
    """FX-003: the module used to build `params` from only bands 0, 2, 4
    (low/mid/high), dropping the low-mid and high-mid bands entirely."""
    _assert_sends_all_five_bands("parametric-eq.html", r"const params = \{(.*?)\};")


def test_eq_html_sends_all_five_bands():
    """FX-003: eq.html (a second, separate parametric_eq client module) had
    the identical bug — its `p` object at ~L897-901 also built from bands
    0, 2, 4 only, dropping the low-mid and high-mid bands."""
    _assert_sends_all_five_bands("eq.html", r"const p = \{(.*?)\};")


def test_parametric_eq_five_bands_render_through_ffmpeg(tmp_path: Path):
    """End-to-end: the real ffmpeg filter chain for all 5 bands must actually
    render (not just build a string that ffmpeg rejects)."""
    _needs_ffmpeg()
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from backend.modules.mastering.router import router as mastering_router

    src = _write_wav(tmp_path / "tone.wav")
    app = FastAPI()
    app.include_router(mastering_router)
    with TestClient(app) as client:
        res = client.post(
            "/process",
            data={
                "effect": "parametric_eq",
                "params": __import__("json").dumps(_five_band_params()),
                "output_format": "wav",
            },
            files={"audio": ("tone.wav", src.read_bytes(), "audio/wav")},
        )
    assert res.status_code == 200, res.text
    out = tmp_path / "eq_out.wav"
    out.write_bytes(res.content)
    assert out.stat().st_size > 0


# ---------------------------------------------------------------------------
# FX-006a — Smart Export: true-peak is measured and surfaced, not print()ed
# ---------------------------------------------------------------------------


async def _fake_render_copy(inp, out, filter_args, extra_out_args=None, timeout=600.0):
    # Stand in for the real ffmpeg subprocess: write a valid, taggable WAV
    # to `out` so the test never depends on ffmpeg being installed.
    sf.write(str(out), _tone(), SR, subtype="PCM_16")
    return out


async def _fake_measure_loudness(path, target_i=-14.0, target_lra=7.0, target_tp=-1.0):
    return {
        "input_i": -20.0,
        "input_lra": 5.0,
        "input_tp": -3.0,
        "input_thresh": -30.0,
        "target_offset": 0.0,
    }


def test_smart_export_embeds_measured_true_peak_and_logs_it(
    tmp_path: Path, monkeypatch, caplog
):
    import logging

    caplog.set_level(logging.INFO, logger="backend.modules.delivery.router")
    monkeypatch.setattr(delivery_router.ffmpeg, "render", _fake_render_copy)
    monkeypatch.setattr(
        delivery_router.audio_analysis, "measure_loudness", _fake_measure_loudness
    )

    async def _fake_verify_true_peak(path, max_tp):
        return (True, -1.23)

    monkeypatch.setattr(
        delivery_router.audio_analysis, "verify_true_peak", _fake_verify_true_peak
    )

    inp = _write_wav(tmp_path / "in.wav")
    out = tmp_path / "out.wav"
    asyncio.run(delivery_router._smart_export(inp, out, {"platform": "spotify"}))

    # 1. Surfaced in the app log (not a print() that goes nowhere).
    assert any("-1.23" in r.message for r in caplog.records)

    # 2. The file is STILL a valid RIFF/WAVE — mutagen.id3.ID3(path) on a
    #    .wav would prepend a bare ID3v2 header before the file's own bytes,
    #    corrupting the container.
    assert out.read_bytes()[:4] == b"RIFF", "WAV no longer starts with RIFF"
    import wave as stdlib_wave

    with stdlib_wave.open(str(out), "rb") as wf:
        assert wf.getnframes() > 0

    # 3. Surfaced in the delivered file's own metadata (the only channel
    #    /process actually returns to the caller) — read back the same way
    #    it was written, via mutagen.wave.WAVE.
    from mutagen.wave import WAVE

    w = WAVE(str(out))
    assert w.tags is not None
    frame = w.tags.getall("TXXX:TRUEPEAK_DBTP")
    assert frame, "TRUEPEAK_DBTP tag not embedded in the delivered file"
    assert str(frame[0].text[0]) == "-1.23"


def test_smart_export_logs_warning_when_true_peak_exceeds_ceiling(
    tmp_path: Path, monkeypatch, caplog
):
    import logging

    caplog.set_level(logging.INFO, logger="backend.modules.delivery.router")
    monkeypatch.setattr(delivery_router.ffmpeg, "render", _fake_render_copy)
    monkeypatch.setattr(
        delivery_router.audio_analysis, "measure_loudness", _fake_measure_loudness
    )

    async def _fake_verify_true_peak(path, max_tp):
        return (False, 0.5)

    monkeypatch.setattr(
        delivery_router.audio_analysis, "verify_true_peak", _fake_verify_true_peak
    )

    inp = _write_wav(tmp_path / "in.wav")
    out = tmp_path / "out.wav"
    asyncio.run(delivery_router._smart_export(inp, out, {"platform": "spotify"}))
    warnings = [r for r in caplog.records if r.levelno >= logging.WARNING]
    assert any("0.50" in r.message for r in warnings)


def test_metadata_wav_tagging_keeps_valid_riff_container(tmp_path: Path, monkeypatch):
    """_metadata had the identical ID3(path)-on-a-.wav bug as
    _embed_true_peak_tag — same fix (mutagen.wave.WAVE), same regression
    coverage."""
    monkeypatch.setattr(delivery_router.ffmpeg, "render", _fake_render_copy)

    inp = _write_wav(tmp_path / "in.wav")
    out = tmp_path / "out.wav"
    asyncio.run(
        delivery_router._metadata(inp, out, {"title": "Test Title", "artist": "Tester"})
    )

    assert out.read_bytes()[:4] == b"RIFF", "WAV no longer starts with RIFF"
    import wave as stdlib_wave

    with stdlib_wave.open(str(out), "rb") as wf:
        assert wf.getnframes() > 0

    from mutagen.wave import WAVE

    w = WAVE(str(out))
    assert w.tags is not None
    assert str(w.tags.getall("TIT2")[0].text[0]) == "Test Title"
    assert str(w.tags.getall("TPE1")[0].text[0]) == "Tester"


# ---------------------------------------------------------------------------
# FX-006b — Batch Export: single-file encode; Jobs caps the concurrency
# ---------------------------------------------------------------------------
#
# /process returns exactly one file, so Batch Export renders only the
# requested output_format (no per-call multi-format encode). Its Jobs knob
# (parallelJobs, main's 1-8, default half the machine's logical CPUs within
# that range) caps how many Batch Export renders
# run at once, server-wide, with one admission gate per event loop; every
# running render's cap holds while it runs, and 8 is the ceiling no request
# can raise.


def test_batch_export_produces_only_the_requested_file(tmp_path: Path, monkeypatch):
    """No sibling .mp3/.flac files — batch_export renders exactly one file,
    matching what /process can actually return."""

    async def _fake_render(inp, out, filter_args, extra_out_args=None, timeout=600.0):
        out.write_bytes(b"fake-render")
        return out

    monkeypatch.setattr(delivery_router.ffmpeg, "render", _fake_render)

    inp = _write_wav(tmp_path / "in.wav")
    out = tmp_path / "out.ogg"
    asyncio.run(delivery_router._batch_export(inp, out, {}))

    assert out.exists()
    siblings = {p.name for p in tmp_path.iterdir()} - {"in.wav", "out.ogg"}
    assert not siblings, f"batch_export wrote unexpected extra files: {siblings}"


def test_batch_export_concurrency_capped_across_separate_event_loops(
    tmp_path: Path, monkeypatch
):
    """T13d audit item 1: an asyncio primitive binds its wait queue to
    whichever event loop first awaits it — a SECOND `asyncio.run()` burst (a
    fresh loop) awaiting that same instance raised "Future attached to a
    different loop", which surfaced as a bare 500.

    Uses the REAL `_batch_gate()`: two separate `asyncio.run()` bursts of 4
    concurrent requests at Jobs=2 must both succeed, with the cap held at 2
    in each burst.
    """
    in_flight = 0
    max_in_flight = 0
    lock = asyncio.Lock()

    async def _tracked_render(
        inp, out, filter_args, extra_out_args=None, timeout=600.0
    ):
        nonlocal in_flight, max_in_flight
        async with lock:
            in_flight += 1
            max_in_flight = max(max_in_flight, in_flight)
        await asyncio.sleep(0.05)
        out.write_bytes(b"fake-render")
        async with lock:
            in_flight -= 1
        return out

    monkeypatch.setattr(delivery_router.ffmpeg, "render", _tracked_render)

    inp = _write_wav(tmp_path / "in.wav")
    jobs = {"parallelJobs": 2}

    async def _run_burst(tag: str):
        nonlocal max_in_flight
        max_in_flight = 0
        outs = [tmp_path / f"out_{tag}_{i}.wav" for i in range(4)]
        await asyncio.gather(
            *(delivery_router._batch_export(inp, o, jobs) for o in outs)
        )
        return outs

    # Burst 1: a fresh event loop builds `_batch_gate()`'s gate for the
    # first time.
    outs1 = asyncio.run(_run_burst("a"))
    assert max_in_flight <= 2
    assert max_in_flight >= 2, "burst 1 renders never overlapped"
    assert all(o.exists() for o in outs1)

    # Burst 2: a DIFFERENT event loop (asyncio.run always creates a new one).
    # Before the per-loop fix, this raised "Future ... attached to a different loop".
    outs2 = asyncio.run(_run_burst("b"))
    assert max_in_flight <= 2
    assert max_in_flight >= 2, "burst 2 renders never overlapped"
    assert all(o.exists() for o in outs2)


def test_batch_export_toolspec_declares_jobs_and_is_honest():
    spec = next(t for t in delivery_router.TOOLS if t.id == "batch_export")
    # main's Jobs knob, restored with main's range; its default is this
    # machine's (default_batch_jobs, tested below).
    assert [p.name for p in spec.params] == ["parallelJobs"]
    jobs = spec.params[0]
    assert (jobs.type, jobs.lo, jobs.hi, jobs.default, jobs.label) == (
        "int",
        1,
        8,
        delivery_router.default_batch_jobs(delivery_router._usable_cpus()),
        "Jobs",
    )
    assert jobs.default == delivery_router.BATCH_JOBS_DEFAULT
    # T13d audit item 2: the old name "Stems / Batch / Multiformat" claimed
    # both stem-splitting and multi-format output; neither exists.
    assert spec.name == "Batch Export (single format)"
    assert "stem" not in spec.name.lower()
    assert "multiformat" not in spec.name.lower()
    # Honesty check: batch_export neither splits stems nor encodes multiple
    # formats per call — the description must not claim it does, and it
    # says what Jobs does.
    assert "stem" not in spec.description.lower()
    assert "multiple format" not in spec.description.lower()
    assert "jobs" in spec.description.lower()


@pytest.mark.parametrize(
    ("cpus", "jobs"),
    [
        (None, 1),
        (0, 1),
        (1, 1),
        (2, 1),
        (3, 1),
        (4, 2),
        (6, 3),
        (8, 4),
        (12, 6),
        (16, 8),
        (32, 8),
        (128, 8),
    ],
)
def test_batch_export_jobs_default_is_half_the_cpus_within_the_knob(cpus, jobs) -> None:
    """One ffmpeg encode per render: half the logical CPUs (one per physical
    core on a two-threads-per-core machine), never below 1, never past the
    knob's ceiling of 8; an unknown count gets 1."""
    assert delivery_router.default_batch_jobs(cpus) == jobs


def test_batch_export_counts_the_cpus_this_process_may_use(monkeypatch) -> None:
    """The smallest count the platform offers wins over the machine's total: a
    backend pinned to 4 of 32 CPUs defaults to 2 Jobs, not 8."""
    monkeypatch.setattr(delivery_router, "_affinity_cpus", lambda: None)
    monkeypatch.setattr(
        delivery_router.os, "process_cpu_count", lambda: 4, raising=False
    )
    monkeypatch.setattr(delivery_router.os, "cpu_count", lambda: 32)
    assert delivery_router._usable_cpus() == 4
    assert delivery_router.default_batch_jobs(delivery_router._usable_cpus()) == 2

    monkeypatch.delattr(delivery_router.os, "process_cpu_count", raising=False)
    monkeypatch.setattr(
        delivery_router.os,
        "sched_getaffinity",
        lambda pid: {0, 1, 2, 3, 4, 5},
        raising=False,
    )
    assert delivery_router._usable_cpus() == 6

    monkeypatch.delattr(delivery_router.os, "sched_getaffinity", raising=False)
    assert delivery_router._usable_cpus() == 32

    monkeypatch.setattr(delivery_router, "_affinity_cpus", lambda: 3)
    assert delivery_router._usable_cpus() == 3


_REPORT_CPUS = (
    "import sys\n"
    "sys.stdin.readline()\n"
    "from backend.modules.delivery import router\n"
    "print(router._usable_cpus(), router.default_batch_jobs(router._usable_cpus()))\n"
)


def test_batch_export_on_a_backend_pinned_to_four_cpus_defaults_to_two_jobs(
    tmp_path: Path,
) -> None:
    """A real process whose affinity is cut to four CPUs after it starts (as
    ``start /affinity`` or a job object does), then asked for its count. On
    Python 3.12 for Windows neither os.process_cpu_count nor
    os.sched_getaffinity exists, so a count that ignores the mask reads the
    machine's total there."""
    import os
    import subprocess
    import sys

    psutil = pytest.importorskip("psutil")
    if not hasattr(psutil.Process(), "cpu_affinity"):
        pytest.skip("this platform has no CPU affinity")
    mine = psutil.Process().cpu_affinity()
    if len(mine) < 8:
        pytest.skip("needs at least 8 CPUs to tell 4 from the total")
    env = dict(os.environ)
    env["PYTHONPATH"] = str(Path(__file__).resolve().parents[1])
    env["theDAW_DATA_DIR"] = str(tmp_path / "data")
    env["CUDA_VISIBLE_DEVICES"] = ""
    child = subprocess.Popen(
        [sys.executable, "-c", _REPORT_CPUS],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
    )
    try:
        psutil.Process(child.pid).cpu_affinity(mine[:4])
        out, err = child.communicate("go\n", timeout=120)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=10)
    assert child.returncode == 0, err
    assert out.split() == ["4", "2"]


def test_batch_export_keeps_jobs_and_drops_the_retired_formats_key(
    tmp_path: Path, monkeypatch
):
    """An old client still sending the retired `formats` key must not error
    — validate_params drops undeclared keys — while `parallelJobs` is a
    declared param again and reaches the handler."""
    spec = next(t for t in delivery_router.TOOLS if t.id == "batch_export")
    validated = spec.validate_params({"parallelJobs": 8, "formats": "wav,mp3"})
    assert validated == {"parallelJobs": 8}

    async def _fake_render(inp, out, filter_args, extra_out_args=None, timeout=600.0):
        out.write_bytes(b"fake-render")
        return out

    monkeypatch.setattr(delivery_router.ffmpeg, "render", _fake_render)
    inp = _write_wav(tmp_path / "in.wav")
    out = tmp_path / "out.wav"
    asyncio.run(delivery_router._batch_export(inp, out, validated))
    assert out.exists()


# ---------------------------------------------------------------------------
# FX-006c — true-peak tag embedding on m4a/ogg/opus/aac (T13d audit item 3)
# ---------------------------------------------------------------------------


async def _render_real_container(tmp_path: Path, ext: str) -> Path:
    """Produce a real container of `ext` via the actual ffmpeg subprocess
    (never monkeypatched) so mutagen's format-specific readers have a
    truly valid file to open — a fabricated `b"fake-render"` blob only
    works for the generic byte-count assertions the other tests use."""
    inp = _write_wav(tmp_path / f"src_{ext}.wav")
    out = tmp_path / f"real.{ext}"
    codec_args = delivery_router.CODEC_ARGS.get(ext) or (
        ["-c:a", "aac"] if ext == "m4a" else []
    )
    await delivery_router.ffmpeg.render(inp, out, [], extra_out_args=codec_args)
    return out


def test_embed_true_peak_tag_m4a_uses_mp4_freeform_atom(tmp_path: Path):
    _needs_ffmpeg()
    out = asyncio.run(_render_real_container(tmp_path, "m4a"))
    delivery_router._embed_true_peak_tag(out, -2.5)

    from mutagen.mp4 import MP4

    f = MP4(str(out))
    assert f.tags is not None
    atom = f.tags.get(delivery_router._MP4_TRUEPEAK_ATOM)
    assert atom, "TRUEPEAK_DBTP freeform atom not embedded in the .m4a"
    assert bytes(atom[0]).decode("utf-8") == "-2.50"


def test_embed_true_peak_tag_ogg_uses_vorbis_comment(tmp_path: Path):
    _needs_ffmpeg()
    out = asyncio.run(_render_real_container(tmp_path, "ogg"))
    delivery_router._embed_true_peak_tag(out, -1.75)

    from mutagen.oggvorbis import OggVorbis

    f = OggVorbis(str(out))
    assert f.tags is not None
    assert f.tags["TRUEPEAK_DBTP"][0] == "-1.75"


def test_embed_true_peak_tag_opus_uses_vorbis_comment(tmp_path: Path):
    _needs_ffmpeg()
    out = asyncio.run(_render_real_container(tmp_path, "opus"))
    delivery_router._embed_true_peak_tag(out, -3.1)

    from mutagen.oggopus import OggOpus

    f = OggOpus(str(out))
    assert f.tags is not None
    assert f.tags["TRUEPEAK_DBTP"][0] == "-3.10"


def test_embed_true_peak_tag_aac_logs_debug_and_does_not_raise(tmp_path: Path, caplog):
    """Raw .aac is an ADTS elementary stream with no container-level tag
    format — must be skipped with a debug log, not crash or silently do
    nothing unexplained."""
    _needs_ffmpeg()
    import logging

    caplog.set_level(logging.DEBUG, logger="backend.modules.delivery.router")
    out = asyncio.run(_render_real_container(tmp_path, "aac"))
    delivery_router._embed_true_peak_tag(out, -4.0)  # must not raise
    assert any(
        "not embedded" in r.message and "ADTS" in r.message for r in caplog.records
    )


# ---------------------------------------------------------------------------
# FX-006d — _metadata: encode when the source codec doesn't fit the
# container, instead of an unconditional -c:a copy (T13d audit item 4)
# ---------------------------------------------------------------------------


def _metadata_client():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(delivery_router.router)
    return TestClient(app)


def test_metadata_wav_to_flac_encodes_instead_of_copy(tmp_path: Path):
    """A WAV (pcm_s16le) upload with output_format=flac used to send
    `-c:a copy` straight into a FLAC container — ffmpeg fails outright,
    surfacing as a 500."""
    _needs_ffmpeg()
    src = _write_wav(tmp_path / "in.wav")
    with _metadata_client() as client:
        res = client.post(
            "/process",
            data={
                "effect": "metadata",
                "params": '{"title": "T", "artist": "A"}',
                "output_format": "flac",
            },
            files={"audio": ("in.wav", src.read_bytes(), "audio/wav")},
        )
    assert res.status_code == 200, res.text
    out = tmp_path / "out.flac"
    out.write_bytes(res.content)

    from mutagen.flac import FLAC

    f = FLAC(str(out))
    assert f["title"][0] == "T"
    assert f["artist"][0] == "A"


def test_metadata_wav_to_mp3_encodes_instead_of_copy(tmp_path: Path):
    """Same bug, mp3 target: -c:a copy of raw PCM into an MP3 bitstream
    fails; must encode with libmp3lame instead."""
    _needs_ffmpeg()
    src = _write_wav(tmp_path / "in.wav")
    with _metadata_client() as client:
        res = client.post(
            "/process",
            data={
                "effect": "metadata",
                "params": '{"title": "T", "artist": "A"}',
                "output_format": "mp3",
            },
            files={"audio": ("in.wav", src.read_bytes(), "audio/wav")},
        )
    assert res.status_code == 200, res.text
    out = tmp_path / "out.mp3"
    out.write_bytes(res.content)

    from mutagen.id3 import ID3

    tags = ID3(str(out))
    assert str(tags.getall("TIT2")[0].text[0]) == "T"
    assert str(tags.getall("TPE1")[0].text[0]) == "A"


def test_metadata_wav_to_m4a_encodes_instead_of_copy(tmp_path: Path):
    """T13e audit item 2: CODEC_ARGS had no 'm4a' key at all, so the
    fallback was `CODEC_ARGS.get(ext, ["-c:a", "copy"])` == copy — same
    500 as the flac/mp3 case. T13f audit item 2: _metadata had no m4a
    tagging branch at all, so title/artist were silently dropped even once
    the 200 was fixed — must read back via mutagen.mp4.MP4."""
    _needs_ffmpeg()
    src = _write_wav(tmp_path / "in.wav")
    with _metadata_client() as client:
        res = client.post(
            "/process",
            data={
                "effect": "metadata",
                "params": '{"title": "T", "artist": "A"}',
                "output_format": "m4a",
            },
            files={"audio": ("in.wav", src.read_bytes(), "audio/wav")},
        )
    assert res.status_code == 200, res.text
    out = tmp_path / "out.m4a"
    out.write_bytes(res.content)
    from mutagen.mp4 import MP4

    f = MP4(str(out))
    assert f.info.codec.startswith("mp4a") or f.info.bitrate > 0
    assert f.tags is not None
    assert f.tags["\xa9nam"][0] == "T"
    assert f.tags["\xa9ART"][0] == "A"


def test_metadata_wav_to_ogg_encodes_and_tags(tmp_path: Path):
    """T13e audit item 2 (encode fallback) + item 6 (ogg/opus tagging was
    entirely missing from _metadata)."""
    _needs_ffmpeg()
    src = _write_wav(tmp_path / "in.wav")
    with _metadata_client() as client:
        res = client.post(
            "/process",
            data={
                "effect": "metadata",
                "params": '{"title": "T", "artist": "A"}',
                "output_format": "ogg",
            },
            files={"audio": ("in.wav", src.read_bytes(), "audio/wav")},
        )
    assert res.status_code == 200, res.text
    out = tmp_path / "out.ogg"
    out.write_bytes(res.content)

    from mutagen.oggvorbis import OggVorbis

    f = OggVorbis(str(out))
    assert f.tags is not None
    assert f.tags["title"][0] == "T"
    assert f.tags["artist"][0] == "A"


def test_metadata_wav_to_opus_encodes_and_tags(tmp_path: Path):
    """Same as the ogg case, opus target."""
    _needs_ffmpeg()
    src = _write_wav(tmp_path / "in.wav")
    with _metadata_client() as client:
        res = client.post(
            "/process",
            data={
                "effect": "metadata",
                "params": '{"title": "T", "artist": "A"}',
                "output_format": "opus",
            },
            files={"audio": ("in.wav", src.read_bytes(), "audio/wav")},
        )
    assert res.status_code == 200, res.text
    out = tmp_path / "out.opus"
    out.write_bytes(res.content)

    from mutagen.oggopus import OggOpus

    f = OggOpus(str(out))
    assert f.tags is not None
    assert f.tags["title"][0] == "T"
    assert f.tags["artist"][0] == "A"


def test_codec_args_covers_every_mime_output_format():
    """T13e audit item 2: check every output format the tool offers has an
    encode fallback — the MIME table module_base.py accepts as
    output_format must not silently fall through to a bare `-c:a copy`."""
    assert set(delivery_router.CODEC_ARGS) == {
        "wav",
        "flac",
        "mp3",
        "aac",
        "m4a",
        "opus",
        "ogg",
    }


def _codec_matrix_post(client, src: Path, quality: str, fmt: str) -> bytes:
    """What tool.html posts for Codec Matrix: a Quality value taken from the
    manifest's dropdown options, and the chosen output format."""
    spec = client.get("/tools/codec_matrix").json()
    quality_param = next(p for p in spec["params"] if p["name"] == "quality")
    assert quality in quality_param["options"]
    res = client.post(
        "/process",
        data={
            "effect": "codec_matrix",
            "params": f'{{"quality": "{quality}"}}',
            "output_format": fmt,
        },
        files={"audio": ("in.wav", src.read_bytes(), "audio/wav")},
    )
    assert res.status_code == 200, res.text
    return res.content


def test_codec_matrix_quality_max_encodes_at_the_top_setting(tmp_path: Path):
    """The Quality dropdown was declared and never read: "max" and "high"
    came back as the same file. A float master with overs picked at "max"
    now stays 32-bit float in WAV, overs intact (24-bit at "high" clips
    them), and MP3 at "max" is 320 kbps CBR (VBR q0 at "high")."""
    _needs_ffmpeg()
    import io

    from mutagen.mp3 import MP3, BitrateMode

    src = tmp_path / "in.wav"
    sf.write(str(src), 6.0 * _tone(seconds=2.0), SR, subtype="FLOAT")  # peak 1.2
    with _metadata_client() as client:
        high_wav = _codec_matrix_post(client, src, "high", "wav")
        max_wav = _codec_matrix_post(client, src, "max", "wav")
        high_mp3 = _codec_matrix_post(client, src, "high", "mp3")
        max_mp3 = _codec_matrix_post(client, src, "max", "mp3")

    orig, _ = sf.read(str(src), dtype="float32")
    assert sf.info(io.BytesIO(high_wav)).subtype == "PCM_24"
    assert sf.info(io.BytesIO(max_wav)).subtype == "FLOAT"
    kept, _ = sf.read(io.BytesIO(max_wav), dtype="float32")
    assert np.array_equal(kept, orig)
    clipped, _ = sf.read(io.BytesIO(high_wav), dtype="float32")
    assert float(np.max(np.abs(clipped))) <= 1.0 < float(np.max(np.abs(orig)))

    (tmp_path / "high.mp3").write_bytes(high_mp3)
    (tmp_path / "max.mp3").write_bytes(max_mp3)
    top = MP3(str(tmp_path / "max.mp3")).info
    assert top.bitrate == 320000
    assert top.bitrate_mode != BitrateMode.VBR
    assert MP3(str(tmp_path / "high.mp3")).info.bitrate_mode == BitrateMode.VBR


def test_codec_matrix_quality_max_encodes_a_mono_upload_to_opus(
    tmp_path: Path, monkeypatch
):
    """Quality "max" asked libopus for 510 kbps on every file, and libopus
    takes at most 256 kbps per channel, so a mono upload to Opus failed the
    render ("Invalid argument") while the same upload at "high" encoded. The
    page's sequence: a mono upload at "high", then at "max", then a stereo
    upload at "max"; every render comes back, each at the top bitrate its
    channel count allows."""
    _needs_ffmpeg()
    from mutagen.oggopus import OggOpus

    asked: list[str] = []
    real_render = delivery_router.ffmpeg.render

    async def _spy(inp, out, filter_args, extra_out_args=None, timeout=600.0):
        args = list(extra_out_args or [])
        asked.append(args[args.index("-b:a") + 1])
        return await real_render(inp, out, filter_args, extra_out_args, timeout)

    monkeypatch.setattr(delivery_router.ffmpeg, "render", _spy)
    mono = tmp_path / "mono.wav"
    sf.write(str(mono), _tone(seconds=1.0), SR, subtype="PCM_16")
    stereo = tmp_path / "stereo.wav"
    sf.write(str(stereo), np.stack([_tone(seconds=1.0)] * 2, axis=1), SR)
    with _metadata_client() as client:
        renders = [
            _codec_matrix_post(client, mono, "high", "opus"),
            _codec_matrix_post(client, mono, "max", "opus"),
            _codec_matrix_post(client, stereo, "max", "opus"),
        ]

    assert asked == ["192k", "256000", "510000"]
    for i, (data, channels) in enumerate(zip(renders, (1, 1, 2))):
        (tmp_path / f"r{i}.opus").write_bytes(data)
        assert OggOpus(str(tmp_path / f"r{i}.opus")).info.channels == channels


def test_metadata_wav_to_wav_still_copies(tmp_path: Path, monkeypatch):
    """The common case — wav in, wav out — must still take the cheap
    stream-copy path, not silently start re-encoding everything."""
    used_args: list[list[str]] = []
    real_render = delivery_router.ffmpeg.render

    async def _spy_render(inp, out, filter_args, extra_out_args=None, timeout=600.0):
        used_args.append(list(extra_out_args or []))
        return await real_render(
            inp, out, filter_args, extra_out_args=extra_out_args, timeout=timeout
        )

    _needs_ffmpeg()
    monkeypatch.setattr(delivery_router.ffmpeg, "render", _spy_render)
    inp = _write_wav(tmp_path / "in.wav")
    out = tmp_path / "out.wav"
    asyncio.run(delivery_router._metadata(inp, out, {}))
    assert used_args[0] == ["-c:a", "copy"]


# ---------------------------------------------------------------------------
# FX-006e — Smart Export: output sample rate matches the source, not
# loudnorm's internal 192k oversampling (T13d audit item 5)
# ---------------------------------------------------------------------------


def _write_wav_at_rate(path: Path, sr: int) -> Path:
    sf.write(str(path), _tone(sr=sr), sr, subtype="PCM_16")
    return path


@pytest.mark.parametrize("source_rate", [44100, 48000])
def test_smart_export_output_rate_matches_source_rate(tmp_path: Path, source_rate: int):
    _needs_ffmpeg()
    inp = _write_wav_at_rate(tmp_path / "in.wav", source_rate)
    out = tmp_path / "out.wav"
    asyncio.run(delivery_router._smart_export(inp, out, {"platform": "universal"}))

    assert sf.info(str(out)).samplerate == source_rate


# ---------------------------------------------------------------------------
# T13e audit item 1 (CRITICAL, regression): opus only accepts 48/24/16/12/8
# kHz — pinning -ar to an arbitrary source rate broke opus for 44.1k sources.
# ---------------------------------------------------------------------------


def test_smart_export_44_1k_to_opus_returns_200_at_48k(tmp_path: Path):
    _needs_ffmpeg()
    inp = _write_wav_at_rate(tmp_path / "in.wav", 44100)
    out = tmp_path / "out.opus"
    # Must not raise (previously: ffmpeg rejected -ar 44100 for libopus).
    asyncio.run(delivery_router._smart_export(inp, out, {"platform": "spotify"}))
    assert out.exists()

    from backend.modules.analysis.ffprobe import probe_file

    info = probe_file(out)
    assert info.get("_summary", {}).get("sample_rate") == 48000


def test_smart_export_48k_to_opus_stays_at_48k(tmp_path: Path):
    _needs_ffmpeg()
    inp = _write_wav_at_rate(tmp_path / "in.wav", 48000)
    out = tmp_path / "out.opus"
    asyncio.run(delivery_router._smart_export(inp, out, {"platform": "spotify"}))
    assert out.exists()

    from backend.modules.analysis.ffprobe import probe_file

    info = probe_file(out)
    assert info.get("_summary", {}).get("sample_rate") == 48000


# ---------------------------------------------------------------------------
# T13e audit item 3 (MAJOR): corrective true-peak trim after resampling
# loudnorm's oversampled output back down.
# ---------------------------------------------------------------------------


def _hot_square_wave(
    seconds: float = 0.5, sr: int = SR, freq: float = 137.0
) -> np.ndarray:
    """A near-full-scale square wave: sharp edges make ffmpeg's oversampled
    true-peak detector see real inter-sample overshoot after resampling,
    the same way a hot, transient-heavy master would."""
    t = np.linspace(0, seconds, int(sr * seconds), endpoint=False, dtype=np.float64)
    return (0.999 * np.sign(np.sin(2 * np.pi * freq * t))).astype(np.float64)


def _write_hot_wav(path: Path, sr: int) -> Path:
    sf.write(str(path), _hot_square_wave(sr=sr), sr, subtype="PCM_24")
    return path


def _read_true_peak_tag(out: Path) -> float:
    ext = out.suffix.lstrip(".").lower()
    if ext == "wav":
        from mutagen.wave import WAVE

        w = WAVE(str(out))
        return float(str(w.tags.getall("TXXX:TRUEPEAK_DBTP")[0].text[0]))
    if ext == "flac":
        from mutagen.flac import FLAC

        f = FLAC(str(out))
        return float(f["TRUEPEAK_DBTP"][0])
    if ext == "mp3":
        from mutagen.id3 import ID3

        tags = ID3(str(out))
        return float(str(tags.getall("TXXX:TRUEPEAK_DBTP")[0].text[0]))
    raise AssertionError(f"no tag reader for .{ext}")


@pytest.mark.parametrize("source_rate", [44100, 48000])
@pytest.mark.parametrize("ext", ["wav", "flac"])
def test_smart_export_corrective_trim_meets_ceiling_for_lossless(
    tmp_path: Path, source_rate: int, ext: str
):
    _needs_ffmpeg()
    inp = _write_hot_wav(tmp_path / f"hot_{source_rate}.wav", source_rate)
    out = tmp_path / f"out.{ext}"
    asyncio.run(delivery_router._smart_export(inp, out, {"platform": "spotify"}))
    assert out.exists()

    ceiling = delivery_router.PRESETS["spotify"]["tp"]
    final_tp = _read_true_peak_tag(out)
    print(
        f"[T13e item 3] {ext} @ {source_rate}Hz: final true-peak {final_tp:.2f} "
        f"dBTP, ceiling {ceiling:.2f} dBTP"
    )
    assert final_tp <= ceiling, (
        f"{ext} @ {source_rate}Hz: final true-peak {final_tp:.2f} dBTP still "
        f"exceeds ceiling {ceiling:.2f} dBTP after corrective trim"
    )


def test_smart_export_corrective_trim_reports_lossy_result(tmp_path: Path):
    """mp3 (lossy): the trim pass still runs, but a lossy encoder can
    reintroduce inter-sample peaks a linear-gain trim can't fully control —
    report the achieved number rather than hard-asserting the ceiling."""
    _needs_ffmpeg()
    inp = _write_hot_wav(tmp_path / "hot.wav", 44100)
    out = tmp_path / "out.mp3"
    asyncio.run(delivery_router._smart_export(inp, out, {"platform": "spotify"}))
    assert out.exists()

    ceiling = delivery_router.PRESETS["spotify"]["tp"]
    final_tp = _read_true_peak_tag(out)
    print(
        f"[T13e item 3] mp3 @ 44100Hz: final true-peak {final_tp:.2f} dBTP, "
        f"ceiling {ceiling:.2f} dBTP"
    )
    assert isinstance(final_tp, float)


def test_smart_export_corrective_trim_mechanism_runs_for_real_and_lowers_peak(
    tmp_path: Path, monkeypatch
):
    """The resample-overshoot the fix targets (~0.1 dB) is too small to
    reliably reproduce from any one hand-built fixture across machines/ffmpeg
    builds — the tests above already prove real hot content lands under
    ceiling. This test instead forces the FIRST detector reading to report
    "over ceiling" (real content, real file — only the pass/fail verdict is
    stubbed) so the corrective branch is guaranteed to run, and verifies with
    ffmpeg.render itself (spied, not stubbed) that a real `volume=` trim
    render executed and that a real subsequent measurement of the actual
    trimmed file is used for the final tag/log."""
    _needs_ffmpeg()
    inp = _write_hot_wav(tmp_path / "hot.wav", 44100)
    out = tmp_path / "out.wav"
    ceiling = delivery_router.PRESETS["spotify"]["tp"]

    real_verify = delivery_router.audio_analysis.verify_true_peak
    call_log: list[float] = []

    async def _first_call_claims_over_ceiling(path, max_tp):
        ok, tp = await real_verify(path, max_tp)
        call_log.append(tp)
        if len(call_log) == 1:
            return (False, max_tp + 0.5)  # force the trim branch once
        return (ok, tp)

    monkeypatch.setattr(
        delivery_router.audio_analysis,
        "verify_true_peak",
        _first_call_claims_over_ceiling,
    )

    render_calls: list[list[str]] = []
    real_render = delivery_router.ffmpeg.render

    async def _spy_render(inp_, out_, filter_args, extra_out_args=None, timeout=600.0):
        render_calls.append(list(filter_args))
        return await real_render(
            inp_, out_, filter_args, extra_out_args=extra_out_args, timeout=timeout
        )

    monkeypatch.setattr(delivery_router.ffmpeg, "render", _spy_render)

    asyncio.run(delivery_router._smart_export(inp, out, {"platform": "spotify"}))

    trim_renders = [
        fa
        for fa in render_calls
        if len(fa) >= 2 and fa[0] == "-af" and fa[1].startswith("volume=")
    ]
    assert trim_renders, "no corrective volume= trim render ran"
    assert len(call_log) >= 2, "the post-trim measurement never ran for real"

    final_tp = _read_true_peak_tag(out)
    assert final_tp <= ceiling, (
        f"real re-measurement after the real trim render still exceeds "
        f"ceiling: {final_tp:.2f} > {ceiling:.2f}"
    )


# ---------------------------------------------------------------------------
# T13f audit item 3 (MINOR): skip the post-loop re-measure when the loop
# never trimmed — a full loudness analysis on every in-spec export was pure
# waste.
# ---------------------------------------------------------------------------


def test_smart_export_skips_redundant_remeasure_when_in_spec(
    tmp_path: Path, monkeypatch
):
    """An in-spec export (no trim needed, the common case) must only call
    verify_true_peak once — reusing the loop's own measurement instead of a
    second full loudness analysis."""
    _needs_ffmpeg()
    real_verify = delivery_router.audio_analysis.verify_true_peak
    calls: list[None] = []

    async def _counted_verify(path, max_tp):
        calls.append(None)
        return await real_verify(path, max_tp)

    monkeypatch.setattr(
        delivery_router.audio_analysis, "verify_true_peak", _counted_verify
    )

    inp = _write_wav(tmp_path / "in.wav")  # gentle -20ish dBFS tone
    out = tmp_path / "out.wav"
    asyncio.run(delivery_router._smart_export(inp, out, {"platform": "universal"}))

    assert len(calls) == 1, (
        f"expected exactly 1 verify_true_peak call for an in-spec export, got {len(calls)}"
    )


def test_smart_export_still_remeasures_after_a_real_trim(tmp_path: Path, monkeypatch):
    """Correctness guard for the same optimization: when a trim DOES run,
    the post-loop re-measure must still happen — skipping it there would
    tag/log a stale (pre-trim) number."""
    _needs_ffmpeg()
    inp = _write_hot_wav(tmp_path / "hot.wav", 44100)
    out = tmp_path / "out.wav"

    real_verify = delivery_router.audio_analysis.verify_true_peak
    calls: list[None] = []

    async def _force_first_call_over_ceiling(path, max_tp):
        ok, tp = await real_verify(path, max_tp)
        calls.append(None)
        if len(calls) == 1:
            return (False, max_tp + 0.5)
        return (ok, tp)

    monkeypatch.setattr(
        delivery_router.audio_analysis,
        "verify_true_peak",
        _force_first_call_over_ceiling,
    )

    asyncio.run(delivery_router._smart_export(inp, out, {"platform": "spotify"}))

    assert len(calls) >= 2, (
        f"expected the post-trim re-measure to run for real, got {len(calls)} calls"
    )


# ---------------------------------------------------------------------------
# T13e audit item 4 (MAJOR): probe_file() must not block the event loop.
# ---------------------------------------------------------------------------


def test_smart_export_probes_off_the_event_loop(tmp_path: Path, monkeypatch):
    import threading

    import backend.modules.analysis.ffprobe as ffprobe_mod

    main_thread = threading.current_thread()
    seen: list[threading.Thread] = []

    def _fake_probe_file(path, timeout_sec=20.0):
        seen.append(threading.current_thread())
        return {"_summary": {"sample_rate": 44100, "codec": "pcm_s16le"}}

    monkeypatch.setattr(ffprobe_mod, "probe_file", _fake_probe_file)
    monkeypatch.setattr(delivery_router.ffmpeg, "render", _fake_render_copy)
    monkeypatch.setattr(
        delivery_router.audio_analysis, "measure_loudness", _fake_measure_loudness
    )

    async def _fake_verify_true_peak(path, max_tp):
        return (True, -3.0)

    monkeypatch.setattr(
        delivery_router.audio_analysis, "verify_true_peak", _fake_verify_true_peak
    )

    inp = _write_wav(tmp_path / "in.wav")
    out = tmp_path / "out.wav"
    asyncio.run(delivery_router._smart_export(inp, out, {"platform": "spotify"}))

    assert seen, "probe_file was never called"
    assert seen[0] is not main_thread, "probe_file ran on the event loop thread"


def test_metadata_probes_off_the_event_loop(tmp_path: Path, monkeypatch):
    import threading

    import backend.modules.analysis.ffprobe as ffprobe_mod

    main_thread = threading.current_thread()
    seen: list[threading.Thread] = []

    def _fake_probe_file(path, timeout_sec=20.0):
        seen.append(threading.current_thread())
        return {"_summary": {"sample_rate": 44100, "codec": "pcm_s16le"}}

    monkeypatch.setattr(ffprobe_mod, "probe_file", _fake_probe_file)

    async def _fake_render(inp, out, filter_args, extra_out_args=None, timeout=600.0):
        out.write_bytes(b"fake-render")
        return out

    monkeypatch.setattr(delivery_router.ffmpeg, "render", _fake_render)

    inp = _write_wav(tmp_path / "in.wav")
    out = tmp_path / "out.wav"
    asyncio.run(delivery_router._metadata(inp, out, {}))

    assert seen, "probe_file was never called"
    assert seen[0] is not main_thread, "probe_file ran on the event loop thread"


# ---------------------------------------------------------------------------
# T13e audit item 5 (MINOR): AIFF (big-endian PCM) must be encoded into WAV,
# never stream-copied.
# ---------------------------------------------------------------------------


def test_metadata_aiff_to_wav_encodes_not_copies(tmp_path: Path, monkeypatch):
    _needs_ffmpeg()
    used_args: list[list[str]] = []
    real_render = delivery_router.ffmpeg.render

    async def _spy_render(inp, out, filter_args, extra_out_args=None, timeout=600.0):
        used_args.append(list(extra_out_args or []))
        return await real_render(
            inp, out, filter_args, extra_out_args=extra_out_args, timeout=timeout
        )

    monkeypatch.setattr(delivery_router.ffmpeg, "render", _spy_render)

    aiff_in = tmp_path / "in.aiff"
    sf.write(str(aiff_in), _tone(), SR, format="AIFF", subtype="PCM_16")
    out = tmp_path / "out.wav"
    asyncio.run(delivery_router._metadata(aiff_in, out, {"title": "T"}))

    assert used_args[0] != ["-c:a", "copy"], (
        "AIFF (big-endian PCM) was stream-copied into a WAV container"
    )
    assert used_args[0] == delivery_router.CODEC_ARGS["wav"]

    with __import__("wave").open(str(out), "rb") as wf:
        assert wf.getnframes() > 0


def test_is_wav_copy_safe_codec():
    assert delivery_router._is_wav_copy_safe_codec("pcm_s16le") is True
    assert delivery_router._is_wav_copy_safe_codec("pcm_s24le") is True
    assert delivery_router._is_wav_copy_safe_codec("pcm_u8") is True
    assert delivery_router._is_wav_copy_safe_codec("pcm_f32le") is True
    assert delivery_router._is_wav_copy_safe_codec("pcm_s16be") is False
    assert delivery_router._is_wav_copy_safe_codec("pcm_s24be") is False
    assert delivery_router._is_wav_copy_safe_codec("mp3") is False


# ---------------------------------------------------------------------------
# T13e audit item 7 (MAJOR, outside original scope): measure_loudness must
# clamp measured_I/TP/LRA/thresh to loudnorm's own documented AVOption
# ranges, or a pathological input makes the second-pass loudnorm 500 with
# "Result too large".
# ---------------------------------------------------------------------------


async def _fake_ffmpeg_run_pathological(cmd, timeout=300):
    return (
        "frame=1 fps=0.0\n"
        "[Parsed_loudnorm_0 @ 0x0]\n"
        "{\n"
        '"input_i" : "5.500",\n'
        '"input_tp" : "120.000",\n'
        '"input_lra" : "150.000",\n'
        '"input_thresh" : "10.000",\n'
        '"output_i" : "-14.000",\n'
        '"output_tp" : "-2.000",\n'
        '"output_lra" : "7.000",\n'
        '"output_thresh" : "-24.000",\n'
        '"normalization_type" : "dynamic",\n'
        '"target_offset" : "0.000"\n'
        "}\n"
    )


def test_measure_loudness_clamps_pathological_values(tmp_path: Path, monkeypatch):
    from backend.lib import audio_analysis as audio_analysis_mod

    monkeypatch.setattr(audio_analysis_mod.ffmpeg, "run", _fake_ffmpeg_run_pathological)
    result = asyncio.run(audio_analysis_mod.measure_loudness(tmp_path / "x.wav"))
    # loudnorm's own AVOption ranges (ffmpeg -h filter=loudnorm):
    # measured_I -99..0, measured_LRA 0..99, measured_TP -99..99,
    # measured_thresh -99..0.
    assert result["input_i"] == 0.0  # clamped from 5.5
    assert result["input_lra"] == 99.0  # clamped from 150.0
    assert result["input_tp"] == 99.0  # 120.0 is in range's own ceiling of 99
    assert result["input_thresh"] == 0.0  # clamped from 10.0


# ---------------------------------------------------------------------------
# T13f audit item 1 (MAJOR): _LOUDNORM_RANGES clamped four keys but not
# `target_offset`, which every caller (delivery/router.py, mastering/router.py
# _maximizer) interpolates as `offset=`. Digital silence makes ffmpeg report
# target_offset as "inf" — no finite gain reaches a target loudness from
# -inf LUFS — and feeding "inf" into a second-pass loudnorm's offset= option
# fails with "Result too large" (a 500), on smart_export AND the maximizer.
# ---------------------------------------------------------------------------


async def _fake_ffmpeg_run_silent(cmd, timeout=300):
    return (
        "frame=1 fps=0.0\n"
        "[Parsed_loudnorm_0 @ 0x0]\n"
        "{\n"
        '"input_i" : "-99.000",\n'
        '"input_tp" : "-99.000",\n'
        '"input_lra" : "0.000",\n'
        '"input_thresh" : "-70.000",\n'
        '"output_i" : "-inf",\n'
        '"output_tp" : "-inf",\n'
        '"output_lra" : "0.000",\n'
        '"output_thresh" : "-70.000",\n'
        '"normalization_type" : "linear",\n'
        '"target_offset" : "inf"\n'
        "}\n"
    )


def test_measure_loudness_clamps_target_offset_inf(tmp_path: Path, monkeypatch):
    """The one key the previous clamp pass missed."""
    from backend.lib import audio_analysis as audio_analysis_mod

    monkeypatch.setattr(audio_analysis_mod.ffmpeg, "run", _fake_ffmpeg_run_silent)
    result = asyncio.run(audio_analysis_mod.measure_loudness(tmp_path / "x.wav"))
    assert result["target_offset"] == 99.0  # clamped from inf


def test_loudnorm_ranges_cover_every_key_fed_back_into_a_second_pass():
    """Every OTHER key loudnorm accepts from this dict, cross-checked
    against `ffmpeg -h filter=loudnorm`: only input_i/input_lra/input_tp/
    input_thresh/target_offset are ever interpolated into a subsequent
    loudnorm call (as measured_I=/measured_LRA=/measured_TP=/
    measured_thresh=/offset=, see delivery/router.py and
    mastering/router.py's _maximizer). output_i/output_tp/output_lra/
    output_thresh/normalization_type are informational-only and never fed
    back, so nothing else needs a clamp."""
    from backend.lib import audio_analysis as audio_analysis_mod

    assert set(audio_analysis_mod._LOUDNORM_RANGES) == {
        "input_i",
        "input_lra",
        "input_tp",
        "input_thresh",
        "target_offset",
    }


def test_smart_export_survives_digital_silence(tmp_path: Path):
    _needs_ffmpeg()
    silence = np.zeros(int(SR * 0.5), dtype=np.float64)
    src = tmp_path / "silence.wav"
    sf.write(str(src), silence, SR, subtype="PCM_16")
    out = tmp_path / "out.wav"
    # Must not raise (previously: 500 "Error applying option 'offset' ...
    # Result too large").
    asyncio.run(delivery_router._smart_export(src, out, {"platform": "spotify"}))
    assert out.exists()


def test_maximizer_survives_digital_silence(tmp_path: Path):
    """Same underlying measure_loudness() bug, reproduced through
    mastering/router.py's _maximizer (auditor's second repro path)."""
    _needs_ffmpeg()
    silence = np.zeros(int(SR * 0.5), dtype=np.float64)
    src = tmp_path / "silence.wav"
    sf.write(str(src), silence, SR, subtype="PCM_16")
    out = tmp_path / "out.wav"
    params = {
        "ceiling": -1.0,
        "targetLUFS": -14.0,
        "targetLRA": 9.0,
        "attack": 5.0,
        "release": 50.0,
    }
    asyncio.run(_maximizer(src, out, params))
    assert out.exists()


def test_smart_export_survives_full_scale_square_wave(tmp_path: Path):
    """Real end-to-end reproduction: a full-scale square wave previously
    made loudnorm's second pass fail with 'Result too large' because
    measured_I came back above 0 LUFS, unclamped."""
    _needs_ffmpeg()
    t = np.linspace(0, 0.5, int(SR * 0.5), endpoint=False)
    square = np.sign(np.sin(2 * np.pi * 100.0 * t)).astype(np.float64)  # exactly +-1.0
    src = tmp_path / "square.wav"
    sf.write(str(src), square, SR, subtype="PCM_16")

    out = tmp_path / "out.wav"
    # Must not raise.
    asyncio.run(delivery_router._smart_export(src, out, {"platform": "spotify"}))
    assert out.exists()
