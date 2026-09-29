"""EDIT's automation lanes on a hosted plugin, printed offline.

A print of an automated VST3 insert sends the lanes along with the file:
``POST /api/vst/process-file`` takes an ``automation`` field (a curve of each
parameter's normalized value over the file's frames), and both renderers move
the parameters block by block while the audio plays. Before this the route had
no such field, so every freeze and export printed an automated plugin with its
parameters standing still at whatever its saved state held.

The route tests drive ``tests/fake_vst_host.py`` (the ``thedaw`` renderer) and a
stand-in for pedalboard; the block-by-block application is driven through
``process_automated`` with a stand-in plugin whose output IS its parameter, so
the value each block was rendered at can be read straight off the audio.
"""

from __future__ import annotations

import io
import json
import os
import sys
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from backend.modules.vst import host as vst_host  # noqa: E402
from backend.modules.vst import live_host as lh  # noqa: E402
from backend.modules.vst import path_policy  # noqa: E402
from backend.modules.vst import router as vst_router  # noqa: E402
from backend.modules.vst.param_automation import (  # noqa: E402
    AUTOMATION_BLOCK_SIZE,
    ParamAutomation,
    automation_value_at,
    parse_param_automation,
)

FAKE_HOST = Path(__file__).resolve().parent / "fake_vst_host.py"

#: A lane from 0 at frame 0 to 1 at frame 1024, on the plugin's parameter 3.
RAMP = [{"index": 3, "name": "Cutoff", "points": [[0, 0.0], [1024, 1.0]]}]


# ---------------------------------------------------------------------------
# The wire shape
# ---------------------------------------------------------------------------


def test_an_empty_field_is_no_automation() -> None:
    assert parse_param_automation("") == []
    assert parse_param_automation("   ") == []


def test_a_curve_parses_with_its_index_name_and_points() -> None:
    [curve] = parse_param_automation(json.dumps(RAMP))
    assert curve == ParamAutomation(
        index=3, name="Cutoff", points=((0, 0.0), (1024, 1.0))
    )
    assert curve.to_host_json() == {
        "index": 3,
        "name": "Cutoff",
        "points": [[0, 0.0], [1024, 1.0]],
    }


def test_a_value_past_the_normalized_range_is_clamped() -> None:
    [curve] = parse_param_automation(
        json.dumps([{"index": 0, "points": [[0, -0.5], [10, 1.5]]}])
    )
    assert curve.points == ((0, 0.0), (10, 1.0))


@pytest.mark.parametrize(
    "body",
    [
        "{}",
        "not json",
        json.dumps([{"points": [[0, 0.5]]}]),
        json.dumps([{"index": -1, "points": [[0, 0.5]]}]),
        json.dumps([{"index": 1, "points": []}]),
        json.dumps([{"index": 1, "points": [[0.5, 0.5]]}]),
        json.dumps([{"index": 1, "points": [[10, 0.5], [5, 0.5]]}]),
        json.dumps(
            [{"index": 1, "points": [[0, 0.5]]}, {"index": 1, "points": [[0, 0.1]]}]
        ),
        json.dumps([{"index": 1, "points": [[0, "loud"]]}]),
    ],
)
def test_a_malformed_body_is_refused(body: str) -> None:
    with pytest.raises(ValueError):
        parse_param_automation(body)


def test_the_curve_is_linear_between_points_and_held_outside_them() -> None:
    points = ((100, 0.2), (200, 0.6), (300, 0.6))
    assert automation_value_at(points, 0) == 0.2
    assert automation_value_at(points, 150) == pytest.approx(0.4)
    assert automation_value_at(points, 250) == pytest.approx(0.6)
    assert automation_value_at(points, 10_000) == 0.6


# ---------------------------------------------------------------------------
# The pedalboard renderer, block by block
# ---------------------------------------------------------------------------


class _Param:
    def __init__(self, value: float) -> None:
        self.raw_value = value


class _EchoPlugin:
    """Its output is the value of its 'cutoff' parameter while each call ran."""

    reported_latency_samples = 0

    def __init__(self) -> None:
        self.parameters = {"cutoff": _Param(0.5), "resonance": _Param(0.1)}
        self.calls: list[tuple[int, bool]] = []

    def process(self, chunk, sample_rate, buffer_size=8192, reset=True):
        self.calls.append((chunk.shape[0], reset))
        return np.full_like(chunk, self.parameters["cutoff"].raw_value)


def test_each_block_renders_at_the_curve_value_at_its_start() -> None:
    plugin = _EchoPlugin()
    frames = AUTOMATION_BLOCK_SIZE * 4
    audio = np.ones((frames, 2), dtype=np.float32)
    ramp = ParamAutomation(index=7, name="Cutoff", points=((0, 0.0), (frames, 1.0)))
    notes: list[str] = []

    out = vst_host.process_automated(plugin, audio, 44100, [ramp], notes)

    assert out.shape == audio.shape
    starts = [out[i * AUTOMATION_BLOCK_SIZE, 0] for i in range(4)]
    assert starts == pytest.approx([0.0, 0.25, 0.5, 0.75])
    assert notes == []
    # Full blocks only, and the plugin is reset once, at the top.
    assert all(n == AUTOMATION_BLOCK_SIZE for n, _ in plugin.calls)
    assert [reset for _, reset in plugin.calls][:2] == [True, False]


def test_a_parameter_the_renderer_cannot_name_is_reported_and_left_alone() -> None:
    plugin = _EchoPlugin()
    audio = np.ones((AUTOMATION_BLOCK_SIZE, 2), dtype=np.float32)
    notes: list[str] = []
    stray = ParamAutomation(index=40, name="Drive", points=((0, 1.0),))

    out = vst_host.process_automated(plugin, audio, 44100, [stray], notes)

    assert np.allclose(out, 0.5)  # 'cutoff' stayed where the state put it
    assert len(notes) == 1 and "Drive" in notes[0]


def test_a_short_file_comes_back_at_its_own_length() -> None:
    plugin = _EchoPlugin()
    audio = np.ones((100, 2), dtype=np.float32)
    ramp = ParamAutomation(index=0, name="cutoff", points=((0, 0.3),))

    out = vst_host.process_automated(plugin, audio, 44100, [ramp], [])

    assert out.shape == (100, 2)
    assert np.allclose(out, 0.3)


# ---------------------------------------------------------------------------
# The route
# ---------------------------------------------------------------------------


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(vst_router.router, prefix="/api/vst")
    return TestClient(app, client=("127.0.0.1", 51000))


@pytest.fixture
def plugin_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "VST3"
    root.mkdir()
    monkeypatch.setattr(path_policy, "allowed_roots", lambda: [root.resolve()])
    path = root / "Filter.vst3"
    path.write_bytes(b"only the path is validated by the route")
    return path


@pytest.fixture
def render_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "vst_render"
    monkeypatch.setattr(vst_router, "_RENDER_DIR", root)
    return root


@pytest.fixture
def wav_bytes() -> bytes:
    buf = io.BytesIO()
    sf.write(
        buf, np.zeros((2048, 2), dtype="float32"), 44100, format="WAV", subtype="FLOAT"
    )
    return buf.getvalue()


def _post(client, plugin_file, wav_bytes, **form):
    return client.post(
        "/api/vst/process-file",
        files={"audio": ("in.wav", wav_bytes, "audio/wav")},
        data={"plugin_path": str(plugin_file), **form},
    )


def _echoes(res) -> list[str]:
    return [
        w
        for w in json.loads(res.headers.get("X-Vst-Warnings", "[]"))
        if w.startswith("echo:")
    ]


def test_our_host_is_handed_the_automation_and_renders_in_short_blocks(
    client, plugin_file, wav_bytes, render_root, monkeypatch
) -> None:
    monkeypatch.setenv(lh.HOST_ENV_VAR, str(FAKE_HOST))
    monkeypatch.setenv("FAKE_VST_HOST_RENDER_ECHO", "1")

    res = _post(
        client, plugin_file, wav_bytes, state_host="thedaw", automation=json.dumps(RAMP)
    )

    assert res.status_code == 200, res.text
    echoes = _echoes(res)
    assert f"echo: block-size={AUTOMATION_BLOCK_SIZE}" in echoes
    assert "echo: automated-params=1" in echoes
    assert (
        'echo: automation {"index":3,"points":[[0,0.0],[1024,1.0]],"name":"Cutoff"}'
        in echoes
    )


def test_a_print_with_no_automation_keeps_its_long_blocks(
    client, plugin_file, wav_bytes, render_root, monkeypatch
) -> None:
    monkeypatch.setenv(lh.HOST_ENV_VAR, str(FAKE_HOST))
    monkeypatch.setenv("FAKE_VST_HOST_RENDER_ECHO", "1")

    res = _post(client, plugin_file, wav_bytes, state_host="thedaw")

    assert res.status_code == 200, res.text
    echoes = _echoes(res)
    assert "echo: block-size=1024" in echoes
    assert not any(e.startswith("echo: automated-params") for e in echoes)


def test_pedalboard_is_handed_the_automation(
    client, plugin_file, wav_bytes, monkeypatch
) -> None:
    seen: list[list[ParamAutomation] | None] = []

    def fake_process(
        plugin_path, signal, sr, param_map, raw_state, warnings, automation=None
    ):
        seen.append(automation)
        return signal

    monkeypatch.setattr(vst_router, "process_with_plugin", fake_process)

    res = _post(client, plugin_file, wav_bytes, automation=json.dumps(RAMP))

    assert res.status_code == 200, res.text
    assert seen == [
        [ParamAutomation(index=3, name="Cutoff", points=((0, 0.0), (1024, 1.0)))]
    ]


def test_a_malformed_automation_is_a_400_and_nothing_renders(
    client, plugin_file, wav_bytes, monkeypatch
) -> None:
    calls: list[int] = []
    monkeypatch.setattr(
        vst_router, "process_with_plugin", lambda *a, **k: calls.append(1) or a[1]
    )

    res = _post(client, plugin_file, wav_bytes, automation='[{"index": 1}]')

    assert res.status_code == 400
    assert "Invalid automation" in res.json()["detail"]
    assert calls == []
