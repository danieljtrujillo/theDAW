"""MIDI stage 4.6: EDIT MIDI tracks rendered through VST3 instruments.

``host.render_instrument`` plays a part's MIDI through pedalboard's instrument
call, ``plugin(midi_messages, duration, sample_rate, num_channels)``, and
``POST /api/vst/render-midi`` renders each EDIT track through its instrument,
behind the same gate and plugin-path policy as the other VST routes.

pedalboard's plugin object is replaced by a stand-in that records what it was
handed and writes an impulse at each note-on's sample, so the tests read back
exactly where each note landed without any real plugin installed.
"""

from __future__ import annotations

import io
import json
from email.parser import BytesParser
from email.policy import default as email_policy
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.modules.vst import host as vst_host
from backend.modules.vst import path_policy, scanner
from backend.modules.vst import router as vst_router


class FakeInstrument:
    """pedalboard's VST3Plugin as the render uses it, playing MIDI as impulses."""

    is_instrument = True

    def __init__(self, path: str) -> None:
        self.path = path
        self.calls: list[dict] = []
        self.raw_state = b"default"
        self.gain = 0.5
        self.parameters = {"gain": object()}

    def __call__(self, midi_messages, duration, sample_rate, num_channels=2):
        self.calls.append(
            {
                "messages": list(midi_messages),
                "duration": duration,
                "sample_rate": sample_rate,
                "num_channels": num_channels,
            }
        )
        frames = int(round(duration * sample_rate))
        out = np.zeros((num_channels, frames), dtype=np.float32)
        for data, t in midi_messages:
            if data[0] & 0xF0 == 0x90 and data[2] > 0:
                out[:, int(round(t * sample_rate))] = data[2] / 127.0
        # Channels first, as pedalboard answers a MIDI render.
        return out


class FakeEffect(FakeInstrument):
    is_instrument = False


class FakePedalboard:
    def __init__(self) -> None:
        self.loaded: list[FakeInstrument] = []

    def load_plugin(self, path: str, plugin_name: str | None = None):
        cls = FakeEffect if "Effect" in Path(path).name else FakeInstrument
        plugin = cls(path)
        self.loaded.append(plugin)
        return plugin


@pytest.fixture
def pedalboard(monkeypatch: pytest.MonkeyPatch) -> FakePedalboard:
    fake = FakePedalboard()
    monkeypatch.setattr(vst_host, "_get_pedalboard", lambda: fake)
    return fake


@pytest.fixture
def vst3_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "VST3"
    root.mkdir()
    monkeypatch.setattr(scanner, "_default_vst3_dirs", lambda: [root])
    monkeypatch.setattr(path_policy, "allowed_roots", lambda: [root.resolve()])
    monkeypatch.setattr(scanner, "_cache_path", lambda: tmp_path / "scan.json")
    return root


@pytest.fixture
def strings(vst3_root: Path) -> Path:
    path = vst3_root / "Orchestral Strings.vst3"
    path.write_bytes(b"stand-in")
    return path


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(vst_router.router, prefix="/api/vst")
    return TestClient(app, client=("127.0.0.1", 51000))


def _parts(response) -> dict[str, bytes]:
    """The multipart answer as {part name: body}."""
    header = f"Content-Type: {response.headers['content-type']}\r\n\r\n".encode()
    message = BytesParser(policy=email_policy).parsebytes(header + response.content)
    out: dict[str, bytes] = {}
    for part in message.iter_parts():
        name = part.get_param("name", header="content-disposition")
        out[name] = part.get_payload(decode=True)
    return out


def _track(path: Path, **over) -> dict:
    body = {
        "track_id": "violins-1",
        "plugin_path": str(path),
        "duration": 2.0,
        "events": [
            {"t": 0.5, "data": [0x90, 60, 127]},
            {"t": 0.25, "data": [0xB0, 1, 90]},
            {"t": 1.0, "data": [0x80, 60, 0]},
            {"t": 1.1, "data": [0xE0, 0, 72]},
        ],
    }
    body.update(over)
    return body


# ---------------------------------------------------------------------------
# host.render_instrument
# ---------------------------------------------------------------------------


def test_render_instrument_calls_the_instrument_api_and_answers_frames_first(
    pedalboard: FakePedalboard, strings: Path
):
    messages = [(bytes([0x90, 64, 127]), 0.1), (bytes([0x80, 64, 0]), 0.2)]
    out = vst_host.render_instrument(str(strings), messages, 0.5, 1000)
    call = pedalboard.loaded[0].calls[0]
    assert call == {
        "messages": messages,
        "duration": 0.5,
        "sample_rate": 1000.0,
        "num_channels": 2,
    }
    assert out.shape == (500, 2)
    assert out[100, 0] == pytest.approx(1.0)


def test_render_instrument_refuses_an_effect(pedalboard, vst3_root: Path):
    effect = vst3_root / "Effect Reverb.vst3"
    effect.write_bytes(b"stand-in")
    with pytest.raises(ValueError, match="not an instrument"):
        vst_host.render_instrument(str(effect), [], 1.0, 1000)


def test_render_instrument_reports_a_state_the_plugin_ignored(pedalboard, strings):
    warnings: list[str] = []

    class Stubborn(FakeInstrument):
        @property
        def raw_state(self):
            return b"default"

        @raw_state.setter
        def raw_state(self, value):
            pass

    pedalboard.load_plugin = lambda path, plugin_name=None: Stubborn(path)
    vst_host.render_instrument(str(strings), [], 0.1, 1000, None, b"other", warnings)
    assert warnings and "could not be restored" in warnings[0]


@pytest.mark.parametrize(
    "data",
    [
        [],
        [0xF0, 1, 2],  # SysEx: not a channel voice message
        [0x90, 60],  # a note-on missing its velocity
        [0xC0, 5, 6],  # a program change carries one data byte
        [0x90, 200, 1],  # data bytes are 7-bit
        [True, 60, 1],
    ],
)
def test_midi_message_bytes_refuses_malformed_messages(data):
    with pytest.raises(ValueError):
        vst_host.midi_message_bytes(data)


def test_midi_message_bytes_takes_every_channel_voice_kind():
    for data in ([0x81, 1, 0], [0x9F, 1, 1], [0xA0, 1, 1], [0xB3, 64, 127]):
        assert vst_host.midi_message_bytes(data) == bytes(data)
    assert vst_host.midi_message_bytes([0xC2, 40]) == bytes([0xC2, 40])
    assert vst_host.midi_message_bytes([0xD0, 99]) == bytes([0xD0, 99])
    assert vst_host.midi_message_bytes([0xE0, 0, 64]) == bytes([0xE0, 0, 64])


# ---------------------------------------------------------------------------
# POST /api/vst/render-midi
# ---------------------------------------------------------------------------


def test_route_renders_each_track_with_its_ccs_and_bends(client, pedalboard, strings):
    response = client.post(
        "/api/vst/render-midi",
        json={
            "sample_rate": 8000,
            "tracks": [
                _track(strings),
                _track(
                    strings,
                    track_id="cellos",
                    duration=1.0,
                    events=[{"t": 0.2, "data": [0x90, 36, 64]}],
                ),
            ],
        },
    )
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("multipart/form-data")
    parts = _parts(response)
    report = json.loads(parts["report"])["tracks"]
    assert [r["track_id"] for r in report] == ["violins-1", "cellos"]
    assert [r["frames"] for r in report] == [16000, 8000]

    # Every message reached the instrument in time order, the CC and the bend included.
    first = pedalboard.loaded[0].calls[0]["messages"]
    assert [(list(d), t) for d, t in first] == [
        ([0xB0, 1, 90], 0.25),
        ([0x90, 60, 127], 0.5),
        ([0x80, 60, 0], 1.0),
        ([0xE0, 0, 72], 1.1),
    ]
    # One fresh plugin per track.
    assert len(pedalboard.loaded) == 2

    audio, rate = sf.read(io.BytesIO(parts[report[0]["part"]]), dtype="float32")
    assert rate == 8000
    assert audio.shape == (16000, 2)
    assert np.argmax(audio[:, 0]) == 4000
    cello, _ = sf.read(io.BytesIO(parts[report[1]["part"]]), dtype="float32")
    assert np.argmax(cello[:, 1]) == 1600
    assert cello[1600, 1] == pytest.approx(64 / 127, abs=1e-6)


def test_route_drops_events_past_the_end_and_plays_early_ones_at_zero(
    client, pedalboard, strings
):
    response = client.post(
        "/api/vst/render-midi",
        json={
            "sample_rate": 8000,
            "tracks": [
                _track(
                    strings,
                    duration=1.0,
                    events=[
                        {"t": -0.3, "data": [0x90, 60, 100]},
                        {"t": 1.0, "data": [0x90, 61, 100]},
                        {"t": 5.0, "data": [0x80, 60, 0]},
                    ],
                )
            ],
        },
    )
    assert response.status_code == 200, response.text
    sent = pedalboard.loaded[0].calls[0]["messages"]
    assert [(list(d), t) for d, t in sent] == [([0x90, 60, 100], 0.0)]


@pytest.mark.parametrize(
    ("patch", "status"),
    [
        ({"duration": 0}, 400),
        ({"duration": vst_router.RENDER_MIDI_MAX_SECONDS + 1}, 400),
        ({"track_id": ""}, 400),
        ({"events": [{"t": 0.1, "data": [0xF8]}]}, 400),
        ({"events": [{"t": 0.1, "data": [0x90, 60]}]}, 400),
    ],
)
def test_route_refuses_bad_tracks_before_any_plugin_loads(
    client, pedalboard, strings, patch, status
):
    response = client.post(
        "/api/vst/render-midi",
        json={"sample_rate": 8000, "tracks": [_track(strings, **patch)]},
    )
    assert response.status_code == status
    assert pedalboard.loaded == []


def test_route_refuses_bad_request_shapes(client, pedalboard, strings):
    def post(**body):
        return client.post("/api/vst/render-midi", json=body)

    assert post(tracks=[]).status_code == 400
    assert post(sample_rate=10, tracks=[_track(strings)]).status_code == 400
    assert post(channels=0, tracks=[_track(strings)]).status_code == 400
    too_many = [_track(strings)] * (vst_router.RENDER_MIDI_MAX_TRACKS + 1)
    assert post(tracks=too_many).status_code == 413
    assert pedalboard.loaded == []


def test_route_polices_the_plugin_path(client, pedalboard, strings, tmp_path):
    outside = tmp_path / "elsewhere" / "Rogue.vst3"
    outside.parent.mkdir()
    outside.write_bytes(b"stand-in")
    response = client.post("/api/vst/render-midi", json={"tracks": [_track(outside)]})
    assert response.status_code == 403
    missing = strings.parent / "Missing.vst3"
    response = client.post("/api/vst/render-midi", json={"tracks": [_track(missing)]})
    assert response.status_code == 404
    assert pedalboard.loaded == []


def test_route_names_the_track_whose_plugin_is_not_an_instrument(
    client, pedalboard, vst3_root
):
    effect = vst3_root / "Effect Reverb.vst3"
    effect.write_bytes(b"stand-in")
    response = client.post(
        "/api/vst/render-midi",
        json={"tracks": [_track(effect, track_id="horns")]},
    )
    assert response.status_code == 400
    assert "horns" in response.json()["detail"]


def test_route_carries_state_and_parameter_warnings_in_the_report(
    client, pedalboard, strings
):
    response = client.post(
        "/api/vst/render-midi",
        json={
            "sample_rate": 8000,
            "tracks": [_track(strings, params={"no such knob": 0.5})],
        },
    )
    assert response.status_code == 200, response.text
    report = json.loads(_parts(response)["report"])["tracks"][0]
    assert any("no such knob" in w for w in report["warnings"])


def test_route_refuses_a_lan_caller_without_a_pairing_token(strings, pedalboard):
    app = FastAPI()
    app.include_router(vst_router.router, prefix="/api/vst")
    lan = TestClient(app, client=("10.20.30.40", 51234))
    response = lan.post("/api/vst/render-midi", json={"tracks": [_track(strings)]})
    assert response.status_code == 403
    assert pedalboard.loaded == []


# ---------------------------------------------------------------------------
# A state our own live host captured renders through our own host
# ---------------------------------------------------------------------------

FAKE_HOST = Path(__file__).resolve().parent / "fake_vst_host.py"


@pytest.fixture
def render_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "vst_render"
    monkeypatch.setattr(vst_router, "_RENDER_DIR", root)
    return root


@pytest.fixture
def fake_host(monkeypatch: pytest.MonkeyPatch) -> None:
    from backend.modules.vst import live_host as lh

    monkeypatch.setenv(lh.HOST_ENV_VAR, str(FAKE_HOST))
    monkeypatch.setenv("FAKE_VST_HOST_RENDER_ECHO", "1")


def test_a_thedaw_state_renders_through_our_host_with_the_midi(
    client, pedalboard, strings, render_root, fake_host
):
    response = client.post(
        "/api/vst/render-midi",
        json={
            "sample_rate": 8000,
            "tracks": [
                _track(
                    strings,
                    duration=0.5,
                    raw_state="c3RhdGU=",
                    state_host="thedaw",
                    events=[
                        {"t": 0.25, "data": [0x90, 60, 127]},
                        {"t": 0.125, "data": [0xB0, 11, 90]},
                    ],
                )
            ],
        },
    )
    assert response.status_code == 200, response.text
    assert pedalboard.loaded == [], "pedalboard never sees a state our host wrote"
    parts = _parts(response)
    report = json.loads(parts["report"])["tracks"][0]
    echo = report["warnings"]
    assert "echo: state-bytes=5" in echo
    assert "echo: tail-seconds=0" in echo, "the duration already carries the release"
    assert "echo: midi-events=2" in echo
    # Frame order, each at its sample at 8 kHz.
    assert [w for w in echo if w.startswith("echo: midi ")] == [
        "echo: midi 1000 176 11 90",
        "echo: midi 2000 144 60 127",
    ]
    audio, rate = sf.read(io.BytesIO(parts[report["part"]]), dtype="float32")
    assert rate == 8000
    assert audio.shape == (4000, 2), "the host was handed the track's length of silence"
    assert report["frames"] == 4000
    assert list(render_root.iterdir()) == [], "the render's temp files are gone"


def test_a_thedaw_render_without_a_host_is_503(
    client, pedalboard, strings, render_root, monkeypatch, tmp_path
):
    from backend.modules.vst import live_host as lh

    monkeypatch.delenv(lh.HOST_ENV_VAR, raising=False)
    empty = tmp_path / "empty-root"
    empty.mkdir()
    monkeypatch.setattr(lh.paths, "PROJECT_ROOT", empty)
    response = client.post(
        "/api/vst/render-midi",
        json={"tracks": [_track(strings, state_host="thedaw")]},
    )
    assert response.status_code == 503
    assert pedalboard.loaded == [], (
        "no quiet fall back to a renderer that cannot read the state"
    )


def test_state_host_is_checked_before_anything_renders(client, pedalboard, strings):
    bad = client.post(
        "/api/vst/render-midi",
        json={"tracks": [_track(strings, state_host="elsewhere")]},
    )
    assert bad.status_code == 400
    not_b64 = client.post(
        "/api/vst/render-midi",
        json={"tracks": [_track(strings, state_host="thedaw", raw_state="!!!")]},
    )
    assert not_b64.status_code == 400
    assert pedalboard.loaded == []
