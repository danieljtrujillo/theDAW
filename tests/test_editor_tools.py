"""The editor-tools module's HTTP surface, against audio synthesized in-test.

Nothing here is committed as a binary: every fixture is numpy written through
``backend/lib/audio_io.py`` into ``tmp_path``. The ground truth is therefore
exact — we know where every click sits, and what frequency the tone is — which
is what lets these assertions be tight (onsets to 20 ms, pitch to 1 %).

The four endpoints, and what each test pins:

* ``POST /analyze``       tempo within 2 BPM, an onset on every click, the
                          levels and the key of a pure tone
* ``POST /detect-tempo``  the same tempo as ``/analyze`` reports
* ``POST /compare-timing`` MIDI authored 50 ms late reads as a -0.05 s offset
                          (sign is audio - MIDI), from JSON onsets or an upload
* ``POST /stretch``       duration scales by the ratio, pitch does not move
"""

from __future__ import annotations

import json
import math
import tempfile
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.lib import ffmpeg as ffmpeg_lib
from backend.lib.audio_io import load_audio_array, save_audio
from backend.modules.editor_tools.router import _suffix_of, router

SR = 44100
BPM = 120.0
TONE_HZ = 440.0


# ---------------------------------------------------------------- fixtures


def _kick(sr: int = SR) -> np.ndarray:
    """One click: a 60 Hz body that decays to silence plus a 2 ms transient.

    The decay is windowed to zero at the end on purpose — an abruptly
    truncated tail is itself a step, and the onset detector reads those steps
    as extra onsets that no beat explains.
    """
    n = int(0.18 * sr)
    t = np.arange(n) / sr
    fade = np.minimum(1.0, (n - np.arange(n)) / (0.01 * sr))
    body = np.sin(2 * np.pi * 60.0 * t) * np.exp(-t * 45.0) * fade
    transient = np.zeros(n, dtype=np.float32)
    k = int(0.002 * sr)
    transient[:k] = np.linspace(1.0, 0.0, k)
    return (0.8 * body + 0.5 * transient).astype(np.float32)


def click_track(
    seconds: float = 8.0, bpm: float = BPM, sr: int = SR, lead_sec: float = 0.5
) -> tuple[np.ndarray, list[float]]:
    """A four-on-the-floor click track and the exact time of every click.

    ``lead_sec`` keeps the first click off the very first frame: an onset in
    the detector's warm-up window is never reported, and a beat at t=0 would
    make the first click untestable rather than late.
    """
    y = np.zeros(int(sr * seconds), dtype=np.float32)
    hit = _kick(sr)
    period = 60.0 / bpm
    clicks: list[float] = []
    t, i = lead_sec, 0
    while t + 0.2 < seconds:
        clicks.append(t)
        start = int(round(t * sr))
        y[start : start + hit.size] += (1.0 if i % 4 == 0 else 0.6) * hit
        t += period
        i += 1
    y /= max(1e-9, float(np.abs(y).max()))
    return (y * 0.9).astype(np.float32), clicks


def tone(seconds: float = 3.0, hz: float = TONE_HZ, sr: int = SR) -> np.ndarray:
    t = np.arange(int(sr * seconds)) / sr
    return (0.5 * np.sin(2 * np.pi * hz * t)).astype(np.float32)


def _wav(tmp_path: Path, name: str, mono: np.ndarray, sr: int = SR) -> Path:
    path = tmp_path / name
    save_audio(path, mono[None, :], sr)
    return path


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(router, prefix="/api/editor-tools")
    return TestClient(app)


def _upload(path: Path) -> dict:
    return {"file": (path.name, path.read_bytes(), "audio/wav")}


def _peak_hz(audio: np.ndarray, sr: int) -> float:
    mono = audio.mean(axis=0)
    spectrum = np.abs(np.fft.rfft(mono * np.hanning(mono.size)))
    return float(np.fft.rfftfreq(mono.size, 1.0 / sr)[int(np.argmax(spectrum))])


# ---------------------------------------------------------------- /analyze


def test_analyze_reads_the_tempo_and_puts_an_onset_on_every_click(tmp_path: Path):
    y, clicks = click_track()
    wav = _wav(tmp_path, "click.wav", y)

    r = _client().post("/api/editor-tools/analyze", files=_upload(wav))
    assert r.status_code == 200, r.text
    body = r.json()

    assert abs(body["tempo"]["bpm"] - BPM) <= 2.0, body["tempo"]
    assert 0.0 <= body["tempo"]["confidence"] <= 1.0
    assert len(body["tempo"]["beats"]) >= len(clicks) - 1

    onsets = body["onsets"]
    assert onsets, "a click track must produce onsets"
    worst = max(min(abs(o - c) for o in onsets) for c in clicks)
    assert worst <= 0.020, f"worst click-to-onset error {worst * 1000:.1f} ms"


def test_analyze_reports_the_clip_levels_and_shape(tmp_path: Path):
    y, _ = click_track()
    wav = _wav(tmp_path, "click.wav", y)

    body = _client().post("/api/editor-tools/analyze", files=_upload(wav)).json()

    assert body["sampleRate"] == SR
    assert body["channels"] == 1
    assert abs(body["durationSec"] - 8.0) < 0.01
    # The synth normalizes to 0.9 full scale: 20*log10(0.9) = -0.915 dB.
    assert abs(body["peakDb"] - (-0.915)) < 0.05
    assert body["rmsDb"] < body["peakDb"]


def test_analyze_names_the_key_of_a_pure_a440(tmp_path: Path):
    wav = _wav(tmp_path, "tone.wav", tone())

    key = _client().post("/api/editor-tools/analyze", files=_upload(wav)).json()["key"]

    assert key is not None
    assert key["root"] == "A"
    assert key["scale"] in ("major", "minor")
    assert 0.0 <= key["confidence"] <= 1.0


def test_analyze_retimes_the_clip_when_given_a_sample_rate_hint(tmp_path: Path):
    """The hint overrides the header, it does not resample: the same samples
    read at half the rate are a clip of twice the length."""
    wav = _wav(tmp_path, "tone.wav", tone(seconds=2.0))

    body = (
        _client()
        .post(
            "/api/editor-tools/analyze",
            files=_upload(wav),
            data={"sample_rate_hint": str(SR // 2)},
        )
        .json()
    )

    assert body["sampleRate"] == SR // 2
    assert abs(body["durationSec"] - 4.0) < 0.01


def test_analyze_rejects_a_sample_rate_hint_that_is_not_a_sample_rate(tmp_path: Path):
    wav = _wav(tmp_path, "tone.wav", tone(seconds=1.0))

    r = _client().post(
        "/api/editor-tools/analyze", files=_upload(wav), data={"sample_rate_hint": "3"}
    )

    assert r.status_code == 400, r.text


def test_analyze_rejects_a_file_no_decoder_can_open(tmp_path: Path):
    junk = tmp_path / "junk.wav"
    junk.write_bytes(b"not audio at all")

    r = _client().post("/api/editor-tools/analyze", files=_upload(junk))

    assert r.status_code == 400, r.text


# ----------------------------------------------------------- /detect-tempo


def test_detect_tempo_returns_the_same_reading_as_analyze(tmp_path: Path):
    y, _ = click_track()
    wav = _wav(tmp_path, "click.wav", y)
    c = _client()

    full = c.post("/api/editor-tools/analyze", files=_upload(wav)).json()["tempo"]
    r = c.post("/api/editor-tools/detect-tempo", files=_upload(wav))

    assert r.status_code == 200, r.text
    assert r.json() == full
    assert set(r.json()) == {"bpm", "confidence", "beats"}


def test_detect_tempo_falls_back_below_the_rhythm_engines_four_second_floor(
    tmp_path: Path,
):
    """``rhythm.analyze_file`` refuses anything under 4 s. A clip tool cannot:
    two seconds of audio is an ordinary selection in the editor, so the
    reading falls through to librosa's beat tracker."""
    y, _ = click_track(seconds=2.5)
    wav = _wav(tmp_path, "short.wav", y)

    tempo = _client().post("/api/editor-tools/detect-tempo", files=_upload(wav)).json()

    assert tempo["bpm"] is not None
    assert abs(tempo["bpm"] - BPM) <= 2.0


# ---------------------------------------------------------- /compare-timing


def test_compare_timing_reads_midi_authored_fifty_milliseconds_late():
    """Sign is audio - MIDI, so notes that sit late read NEGATIVE: the offset
    is what you would add to the MIDI, and these notes must move earlier."""
    onsets = [0.5 + 0.5 * i for i in range(8)]
    notes = [t + 0.05 for t in onsets]

    r = _client().post(
        "/api/editor-tools/compare-timing",
        json={"onsets": onsets, "noteStartsSec": notes},
    )

    assert r.status_code == 200, r.text
    body = r.json()
    assert abs(body["medianOffsetSec"] - (-0.05)) < 1e-6
    assert abs(body["meanOffsetSec"] - (-0.05)) < 1e-6
    assert body["matched"] == 8
    assert body["unmatchedNotes"] == 0
    assert [p["noteSec"] for p in body["perNote"]] == notes
    assert all(abs(p["deltaSec"] - (-0.05)) < 1e-6 for p in body["perNote"])


def test_compare_timing_leaves_a_note_with_no_onset_in_range_unmatched():
    r = _client().post(
        "/api/editor-tools/compare-timing",
        json={"onsets": [1.0, 2.0], "noteStartsSec": [1.02, 5.0], "maxMatchSec": 0.12},
    )

    body = r.json()
    assert body["matched"] == 1
    assert body["unmatchedNotes"] == 1
    assert body["perNote"][1] == {"noteSec": 5.0, "onsetSec": None, "deltaSec": None}


def test_compare_timing_never_matches_two_notes_to_one_onset():
    r = _client().post(
        "/api/editor-tools/compare-timing",
        json={"onsets": [1.0], "noteStartsSec": [1.01, 1.05], "maxMatchSec": 0.12},
    )

    body = r.json()
    assert body["matched"] == 1
    assert body["unmatchedNotes"] == 1
    # Greedy takes the closest pair first: 1.01 wins the only onset.
    assert body["perNote"][0]["onsetSec"] == 1.0
    assert body["perNote"][1]["onsetSec"] is None


def test_compare_timing_detects_the_onsets_itself_when_given_audio(tmp_path: Path):
    y, clicks = click_track()
    wav = _wav(tmp_path, "click.wav", y)
    notes = [t + 0.05 for t in clicks]

    r = _client().post(
        "/api/editor-tools/compare-timing",
        files=_upload(wav),
        data={"noteStartsSec": json.dumps(notes), "maxMatchSec": "0.12"},
    )

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["matched"] == len(notes)
    assert body["unmatchedNotes"] == 0
    assert abs(body["medianOffsetSec"] - (-0.05)) < 0.02


def test_compare_timing_rejects_a_match_window_that_is_not_a_number():
    """A bad window is the client's mistake, not a server fault: without the
    guard ``float("wide")`` escapes the handler as a 500."""
    r = _client().post(
        "/api/editor-tools/compare-timing",
        json={"onsets": [1.0], "noteStartsSec": [1.0], "maxMatchSec": "wide"},
    )

    assert r.status_code == 400, r.text


def test_compare_timing_needs_either_onsets_or_a_file():
    r = _client().post(
        "/api/editor-tools/compare-timing", json={"noteStartsSec": [1.0]}
    )

    assert r.status_code == 400, r.text


# ---------------------------------------------------------------- /stretch


def test_stretch_scales_duration_by_the_ratio_and_leaves_pitch_alone(tmp_path: Path):
    """The user's case: audio cut to a 120 BPM arrangement, warped onto MIDI
    authored at 99 BPM. Duration grows by 120/99; A440 stays A440."""
    wav = _wav(tmp_path, "tone.wav", tone(seconds=3.0))
    ratio = 120.0 / 99.0

    r = _client().post(
        "/api/editor-tools/stretch", files=_upload(wav), data={"ratio": str(ratio)}
    )

    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("audio/wav")
    audio, sr = load_audio_array(r.content, format="wav")
    duration = audio.shape[1] / sr
    assert math.isclose(duration, 3.0 * ratio, rel_tol=0.01)
    assert math.isclose(_peak_hz(audio, sr), TONE_HZ, rel_tol=0.01)


def test_stretch_derives_the_ratio_from_a_source_and_target_bpm(tmp_path: Path):
    wav = _wav(tmp_path, "tone.wav", tone(seconds=3.0))

    r = _client().post(
        "/api/editor-tools/stretch",
        files=_upload(wav),
        data={"source_bpm": "120", "target_bpm": "99"},
    )

    assert r.status_code == 200, r.text
    audio, sr = load_audio_array(r.content, format="wav")
    assert math.isclose(audio.shape[1] / sr, 3.0 * (120.0 / 99.0), rel_tol=0.01)


def test_stretch_chains_atempo_stages_for_an_extreme_ratio(tmp_path: Path):
    """atempo only accepts 0.5..2.0 per stage; a 4x stretch needs two."""
    wav = _wav(tmp_path, "tone.wav", tone(seconds=3.0))

    r = _client().post(
        "/api/editor-tools/stretch", files=_upload(wav), data={"ratio": "4"}
    )

    assert r.status_code == 200, r.text
    assert r.headers["X-Stretch-Filter"].count("atempo=") == 2
    audio, sr = load_audio_array(r.content, format="wav")
    assert math.isclose(audio.shape[1] / sr, 12.0, rel_tol=0.01)
    assert math.isclose(_peak_hz(audio, sr), TONE_HZ, rel_tol=0.01)


def test_stretch_rejects_a_ratio_outside_the_supported_range(tmp_path: Path):
    wav = _wav(tmp_path, "tone.wav", tone(seconds=1.0))
    c = _client()

    for bad in ("10", "0.1", "0"):
        r = c.post("/api/editor-tools/stretch", files=_upload(wav), data={"ratio": bad})
        assert r.status_code == 400, (bad, r.status_code, r.text)


def test_stretch_needs_a_ratio_or_a_bpm_pair(tmp_path: Path):
    wav = _wav(tmp_path, "tone.wav", tone(seconds=1.0))

    r = _client().post("/api/editor-tools/stretch", files=_upload(wav))

    assert r.status_code == 400, r.text


# ------------------------------------------------------------------ mount


def test_the_module_mounts_itself_at_the_editor_tools_prefix():
    """The loader discovers modules by ``module.json`` — nothing outside this
    directory registers the router, so the manifest is the mount."""
    from fastapi import FastAPI as _FastAPI

    from backend.modules.loader import load_modules

    modules_dir = Path(__file__).resolve().parents[1] / "backend" / "modules"
    app = _FastAPI()
    manifests = load_modules(app, modules_dir)

    assert app.state.module_load_errors.get("editor_tools") is None
    manifest = next(m for m in manifests if m["name"] == "editor_tools")
    assert manifest["api_prefix"] == "/api/editor-tools"

    health = TestClient(app).get("/api/editor-tools/")
    assert health.status_code == 200, health.text
    assert health.json()["module"] == "editor_tools"


def test_compare_timing_declares_both_of_its_request_shapes():
    """One path, two content types — the dispatch is manual, so the schema
    T13's tool registration reads has to be declared by hand."""
    app = FastAPI()
    app.include_router(router, prefix="/api/editor-tools")

    paths = app.openapi()["paths"]
    assert "/api/editor-tools/analyze" in paths
    assert "/api/editor-tools/detect-tempo" in paths
    assert "/api/editor-tools/stretch" in paths
    body = paths["/api/editor-tools/compare-timing"]["post"]["requestBody"]
    assert set(body["content"]) == {"application/json", "multipart/form-data"}


# ------------------------------------------------- staging and sanitisation


#: A filename that tries to climb out of the staging directory AND to break
#: out of the quoted ``Content-Disposition`` value at the same time.
_HOSTILE_FILENAME = '../../../etc/pa"ss;rm -rf .wav'

#: Every endpoint that stages an upload on disk, with the form fields it needs
#: to reach a 200 on a valid file.
_UPLOADING_ENDPOINTS = {
    "analyze": {},
    "compare-timing": {"noteStartsSec": "[1.0]"},
    "detect-tempo": {},
    "stretch": {"ratio": "1.5"},
}


@pytest.fixture
def staging(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Pin the router's ``tempfile.mkdtemp`` root under ``tmp_path``.

    A leaked staging directory is otherwise invisible — it lands in the system
    temp directory among everything else and nothing fails.
    """
    root = tmp_path / "staging"
    root.mkdir()
    monkeypatch.setattr(tempfile, "tempdir", str(root))
    return root


def _leaked(staging_root: Path) -> list[str]:
    return sorted(
        p.name for p in staging_root.iterdir() if p.name.startswith("editor_tools_")
    )


@pytest.mark.parametrize("endpoint", sorted(_UPLOADING_ENDPOINTS))
def test_every_uploading_endpoint_removes_its_staging_directory(
    tmp_path: Path, staging: Path, endpoint: str
):
    wav = _wav(tmp_path, "tone.wav", tone(seconds=3.0))

    r = _client().post(
        f"/api/editor-tools/{endpoint}",
        files=_upload(wav),
        data=_UPLOADING_ENDPOINTS[endpoint],
    )

    assert r.status_code == 200, r.text
    assert _leaked(staging) == []


@pytest.mark.parametrize("endpoint", sorted(_UPLOADING_ENDPOINTS))
def test_every_uploading_endpoint_removes_its_staging_directory_after_a_failure(
    tmp_path: Path, staging: Path, endpoint: str
):
    """The cleanup sits in a ``finally``; an undecodable upload must not leave
    the staged bytes on disk, and must read as the client's error (400)."""
    junk = tmp_path / "junk.wav"
    junk.write_bytes(b"not audio at all")

    r = _client().post(
        f"/api/editor-tools/{endpoint}",
        files=_upload(junk),
        data=_UPLOADING_ENDPOINTS[endpoint],
    )

    assert r.status_code == 400, r.text
    assert _leaked(staging) == []


def test_analyze_keeps_a_traversing_filename_inside_the_staging_directory(
    tmp_path: Path, staging: Path
):
    """Only the extension is ever taken from ``filename``; the rest cannot
    steer where the bytes land."""
    wav = _wav(tmp_path, "tone.wav", tone(seconds=3.0))

    r = _client().post(
        "/api/editor-tools/analyze",
        files={"file": (_HOSTILE_FILENAME, wav.read_bytes(), "audio/wav")},
    )

    assert r.status_code == 200, r.text
    assert _leaked(staging) == []
    # Nothing climbed out: tmp_path still holds only the fixture and the
    # staging root, and the staging root is empty.
    assert sorted(p.name for p in tmp_path.iterdir()) == ["staging", "tone.wav"]
    assert list(staging.iterdir()) == []


def test_stretch_sanitises_a_traversing_quote_bearing_filename(
    tmp_path: Path, staging: Path
):
    """The upload's name is echoed in ``Content-Disposition``; a quote there
    would break out of the quoted value, and a separator would name a path."""
    wav = _wav(tmp_path, "tone.wav", tone(seconds=1.0))

    r = _client().post(
        "/api/editor-tools/stretch",
        files={"file": (_HOSTILE_FILENAME, wav.read_bytes(), "audio/wav")},
        data={"ratio": "1.5"},
    )

    assert r.status_code == 200, r.text
    disposition = r.headers["content-disposition"]
    assert disposition.startswith('attachment; filename="')
    name = disposition.split('filename="', 1)[1].rstrip('"')
    assert name.endswith("_stretched.wav")
    stem = name[: -len("_stretched.wav")]
    assert stem, "the sanitised stem must not be empty"
    assert set(stem) <= set(
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_"
    )
    assert _leaked(staging) == []


def test_stretch_reports_an_undecodable_upload_as_a_client_error(tmp_path: Path):
    """ffmpeg exiting non-zero on the INPUT is the client's bad file, not a
    server fault. A timeout keeps its 500."""
    junk = tmp_path / "junk.wav"
    junk.write_bytes(b"not audio at all")

    r = _client().post(
        "/api/editor-tools/stretch", files=_upload(junk), data={"ratio": "1.5"}
    )

    assert r.status_code == 400, r.text


def test_compare_timing_rejects_non_finite_times():
    """``json.loads`` accepts ``NaN``/``Infinity``; letting them through puts
    a bare ``NaN`` token in the response, which is not valid JSON."""
    c = _client()
    bodies = [
        '{"onsets": [NaN], "noteStartsSec": [1.0]}',
        '{"onsets": [1.0], "noteStartsSec": [Infinity]}',
        '{"onsets": [1.0], "noteStartsSec": [-Infinity]}',
        '{"onsets": [1.0], "noteStartsSec": [1.0], "maxMatchSec": NaN}',
    ]
    for body in bodies:
        r = c.post(
            "/api/editor-tools/compare-timing",
            content=body,
            headers={"content-type": "application/json"},
        )
        assert r.status_code == 400, (body, r.status_code, r.text)


def test_stretch_keeps_a_server_error_for_a_render_timeout(
    tmp_path: Path, staging: Path, monkeypatch: pytest.MonkeyPatch
):
    """The other half of the split: a timeout is this server failing to do
    work it accepted, so it stays a 500 — and still cleans up after itself."""
    wav = _wav(tmp_path, "tone.wav", tone(seconds=1.0))

    async def _timed_out(*args, **kwargs):
        raise ffmpeg_lib.FFmpegError(-1, "timed out after 300.0s")

    monkeypatch.setattr(ffmpeg_lib, "render", _timed_out)

    r = _client().post(
        "/api/editor-tools/stretch", files=_upload(wav), data={"ratio": "1.5"}
    )

    assert r.status_code == 500, r.text
    assert _leaked(staging) == []


@pytest.mark.parametrize(
    "filename,expected",
    [
        ("clip.wav", ".wav"),
        # A quote is a legal filename character on POSIX and illegal on
        # Windows; without the strip the staged path is unwritable on one
        # platform and shell-metacharacter-bearing on the other.
        ('tone.w"a v', ".wav"),
        ("../../../etc/passwd", ".bin"),
        ("no-extension", ".bin"),
        ("", ".bin"),
        ("clip." + "x" * 40, "." + "x" * 10),
    ],
)
def test_the_staged_extension_is_alphanumeric_and_bounded(filename: str, expected: str):
    """Reaching for the private helper on purpose: this is the whole defence
    against a client-chosen filename steering the staged path, and driving it
    through HTTP only proves the cases the running platform happens to reject.
    """
    assert _suffix_of(SimpleNamespace(filename=filename)) == expected


def _stretch_with_render_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, returncode: int, stderr: str
) -> int:
    """POST a valid clip to ``/stretch`` with ``render`` failing as given."""
    wav = _wav(tmp_path, "tone.wav", tone(seconds=1.0))

    async def _failing(*args, **kwargs):
        raise ffmpeg_lib.FFmpegError(returncode, stderr)

    monkeypatch.setattr(ffmpeg_lib, "render", _failing)
    r = _client().post(
        "/api/editor-tools/stretch", files=_upload(wav), data={"ratio": "1.5"}
    )
    return r.status_code


@pytest.mark.parametrize(
    "stderr",
    [
        "[in#0] Error opening input: Invalid data found when processing input",
        "[aist#0:0] Could not find codec parameters for stream 0",
        "Error opening input file input.xyz.",
    ],
)
def test_stretch_maps_each_input_decode_report_to_a_client_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, stderr: str
):
    assert _stretch_with_render_error(tmp_path, monkeypatch, 1, stderr) == 400


@pytest.mark.parametrize(
    "returncode,stderr",
    [
        # ffmpeg ran and failed for a reason that is not the upload's fault.
        (1, "Error while opening encoder: No space left on device"),
        (1, "Conversion failed!"),
        # POSIX: a signalled child can surface as -1 too; unrelated stderr.
        (-1, "Killed"),
        # The lib's own sentinel for a zero exit with no output file.
        (-1, "ffmpeg produced no output"),
    ],
)
def test_stretch_keeps_a_server_error_for_a_failure_that_is_not_the_input(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, returncode: int, stderr: str
):
    assert _stretch_with_render_error(tmp_path, monkeypatch, returncode, stderr) == 500


def test_stretch_treats_a_run_that_used_up_its_timeout_as_a_timeout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """Classified by elapsed time against the timeout WE passed, not only by
    the lib's message: a run that consumed its whole budget is a timeout even
    if whatever it printed last looks like a decode complaint."""
    import backend.modules.editor_tools.router as editor_router

    monkeypatch.setattr(editor_router, "_STRETCH_TIMEOUT_SEC", 0.0)
    status = _stretch_with_render_error(
        tmp_path, monkeypatch, 1, "Invalid data found when processing input"
    )

    assert status == 500


def test_stretch_lets_the_libs_timeout_message_win_over_decode_text(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """Precedence, pinned: whatever else the stderr says, the lib's own
    timeout report is a timeout. Elapsed time here is far under the budget,
    so only the message can make this a 500."""
    stderr = "timed out after 300.0s; Invalid data found when processing input"

    assert _stretch_with_render_error(tmp_path, monkeypatch, 1, stderr) == 500


def test_stretch_needs_ffmpeg_to_have_exited_before_blaming_the_input(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """A decode complaint from a child that did not exit normally — a POSIX
    signal death, or the lib's -1 sentinel — is not evidence about the
    upload: the process was stopped, it did not reject the file."""
    stderr = "Error opening input: Invalid data found when processing input"

    assert _stretch_with_render_error(tmp_path, monkeypatch, -1, stderr) == 500
