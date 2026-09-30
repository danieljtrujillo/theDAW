"""``POST /api/sway/vst-render``: the cockpit's track VST chain, rendered by theDAW.

The embedded SwayCommand cockpit has no plugin host. Its track panel holds a
chain of VST3 plugins, each with 0..1 slider positions and the state its
window captured, and RENDER asks theDAW for a wet file it then plays under
the track's wet / dry mix. These replay that call with a stand-in for the
worker-isolated plugin run (``process_with_plugin``), so no plugin, no worker
and no pedalboard is needed, and prove the chain order, the tail, the answer
shape the cockpit reads, the reuse of an unchanged render, and the refusals.
The two tests at the end cover the one thing the render adds to the VST
module: parameters applied as raw 0..1 positions, the cockpit's convention.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import quote

import numpy as np
import pytest
import soundfile as sf
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.lib import known_paths
from backend.modules.project import media_access
from backend.modules.sway import router as sway_api
from backend.modules.sway import vst_render
from backend.modules.vst import host, path_policy, plugin_worker
from backend.modules.vst.isolation import PluginCrashed

SR = 8000
ROUTE = "/api/sway/vst-render"


@pytest.fixture()
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setenv("theDAW_DATA_DIR", str(data))
    known_paths.set_store_path_for_tests(tmp_path / "known_paths.json")
    monkeypatch.setattr(
        media_access, "_ROOTS_STATE", tmp_path / "clip_audio_roots.json"
    )
    monkeypatch.setattr(media_access, "_session_roots", [])
    monkeypatch.setattr(media_access, "_stand_ins", {})
    monkeypatch.delenv("theDAW_MEDIA_ROOTS", raising=False)

    vst3 = tmp_path / "VST3"
    vst3.mkdir()
    monkeypatch.setattr(path_policy, "allowed_roots", lambda: [vst3.resolve()])
    for name in ("Gain.vst3", "Echo.vst3", "Crash.vst3"):
        (vst3 / name).write_bytes(b"only the path is validated by the route")

    calls: list[dict] = []

    def fake_process(
        plugin_path,
        audio,
        sample_rate,
        params=None,
        raw_state=None,
        warnings=None,
        raw_params=None,
    ):
        name = Path(plugin_path).stem
        calls.append(
            {
                "name": name,
                "raw_params": raw_params,
                "raw_state": raw_state,
                "frames": int(audio.shape[0]),
                "sample_rate": sample_rate,
            }
        )
        if name == "Crash":
            raise PluginCrashed("Crash", "processing audio", 0xC0000005)
        if name == "Echo" and warnings is not None:
            warnings.append("parameter 'time' not applied: Unknown parameter: time")
        gain = float((raw_params or {}).get("gain", 0.5))
        return np.asarray(audio, dtype=np.float32) * np.float32(gain)

    monkeypatch.setattr(sway_api, "process_with_plugin", fake_process)

    app = FastAPI()
    app.include_router(sway_api.router, prefix="/api/sway")
    # The route is loopback-gated: TestClient's default peer is "testclient",
    # which is not loopback, so name a real loopback peer the way
    # tests/test_vst_render_host.py does.
    client = TestClient(app, client=("127.0.0.1", 51000))

    # A clip inside the data folder: one of clip-audio's roots.
    uploads = data / "uploads"
    uploads.mkdir()
    song = uploads / "song.wav"
    sf.write(song, np.full((SR, 2), 0.25, dtype=np.float32), SR, subtype="FLOAT")

    yield SimpleNamespace(
        client=client, data=data, song=song, vst3=vst3, calls=calls, tmp=tmp_path
    )
    known_paths.set_store_path_for_tests(None)


def _chain(env, *names: str, **first: object) -> list[dict]:
    plugins = [{"path": str(env.vst3 / f"{n}.vst3")} for n in names]
    plugins[0].update(first)
    return plugins


def test_the_chain_runs_in_order_with_the_tail_and_answers_the_cockpits_shape(env):
    body = {
        "input": str(env.song),
        "plugins": _chain(env, "Gain", "Echo", params={"gain": 0.5}, rawState="AAEC"),
        "tail": 2,
    }
    r = env.client.post(ROUTE, json=body)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["ok"] is True and d["cached"] is False
    assert d["sampleRate"] == SR
    assert d["seconds"] == pytest.approx(3.0), "one second of song plus the tail"
    out = Path(d["output"])
    assert out.is_file() and out.parent == env.data / "sway-renders"

    # Order, and what each plugin was handed.
    assert [c["name"] for c in env.calls] == ["Gain", "Echo"]
    assert env.calls[0]["raw_params"] == {"gain": 0.5}
    assert env.calls[0]["raw_state"] == "AAEC"
    assert env.calls[1]["raw_params"] is None and env.calls[1]["raw_state"] is None
    assert all(c["frames"] == 3 * SR for c in env.calls), "the tail is appended first"
    assert all(c["sample_rate"] == SR for c in env.calls)

    # Gain at 0.5 then Echo at its default 0.5; the tail stays silent.
    audio, sr = sf.read(out, dtype="float32", always_2d=True)
    assert sr == SR and audio.shape == (3 * SR, 2)
    assert float(audio[:SR].max()) == pytest.approx(0.25 * 0.5 * 0.5)
    assert float(np.abs(audio[SR:]).max()) == 0.0
    assert sf.info(str(out)).subtype == "FLOAT"

    # A warning names its plugin.
    assert d["warnings"] == [
        "Echo: parameter 'time' not applied: Unknown parameter: time"
    ]

    # clip-audio may serve it (the data folder is a root) and theDAW remembers it.
    assert media_access.resolve_media_path(d["output"]) == out.resolve()
    assert known_paths.find_servable(d["output"]) == str(out)


def test_an_unchanged_chain_reuses_its_render(env):
    body = {
        "input": str(env.song),
        "plugins": _chain(env, "Gain", params={"gain": 0.5}),
    }
    first = env.client.post(ROUTE, json=body).json()
    again = env.client.post(ROUTE, json=body).json()
    assert again["output"] == first["output"] and again["cached"] is True
    assert len(env.calls) == 1, "the second call rendered nothing"

    moved = env.client.post(
        ROUTE, json={**body, "plugins": _chain(env, "Gain", params={"gain": 0.75})}
    ).json()
    assert moved["output"] != first["output"] and len(env.calls) == 2

    env.song.write_bytes(env.song.read_bytes() + b"\0")
    rewritten = env.client.post(ROUTE, json=body).json()
    assert rewritten["output"] != first["output"], "a rewritten input gets a new key"


def test_inputs_the_cockpit_holds(env, monkeypatch):
    plugins = _chain(env, "Gain")

    def post(input_value: str):
        return env.client.post(ROUTE, json={"input": input_value, "plugins": plugins})

    # The URL clip-audio served a scene's media from.
    assert (
        post(f"/api/project/clip-audio?path={quote(str(env.song))}").status_code == 200
    )
    # A library entry theDAW handed the cockpit by URL.
    monkeypatch.setattr(
        sway_api, "_library_audio_path", lambda eid: env.song if eid == "e1" else None
    )
    assert post("/api/library/audio/e1.wav").status_code == 200
    assert post("/api/library/audio/nope").status_code == 403
    # A file picked in the browser has no path theDAW can read.
    assert post("swaydrop:/3/beat.wav").status_code == 403
    # Files outside every root, or gone, refuse with the one answer.
    elsewhere = env.tmp / "elsewhere.wav"
    sf.write(elsewhere, np.zeros((SR, 1), dtype=np.float32), SR)
    outside = post(str(elsewhere))
    missing = post(str(env.data / "uploads" / "gone.wav"))
    assert outside.status_code == 403 and missing.status_code == 403
    assert outside.json()["detail"] == missing.json()["detail"]
    assert "elsewhere" not in outside.text


def test_refusals_before_any_plugin_runs(env):
    song = str(env.song)
    r = env.client.post(ROUTE, json={"input": song, "plugins": []})
    assert r.status_code == 422
    for tail in (-1, 999):
        r = env.client.post(
            ROUTE, json={"input": song, "plugins": _chain(env, "Gain"), "tail": tail}
        )
        assert r.status_code == 422, tail
    stray = env.tmp / "Stray.vst3"
    stray.write_bytes(b"outside the allowed roots")
    r = env.client.post(ROUTE, json={"input": song, "plugins": [{"path": str(stray)}]})
    assert r.status_code == 403
    assert "Stray" not in r.text
    r = env.client.post(
        ROUTE, json={"input": song, "plugins": [{"path": str(env.song)}]}
    )
    assert r.status_code == 400, "not a .vst3"
    assert env.calls == []


def test_a_plugin_that_crashes_is_a_502_naming_it(env):
    r = env.client.post(
        ROUTE, json={"input": str(env.song), "plugins": _chain(env, "Gain", "Crash")}
    )
    assert r.status_code == 502
    assert "'Crash'" in r.json()["detail"]
    assert [c["name"] for c in env.calls] == ["Gain", "Crash"]
    assert not list((env.data / "sway-renders").glob("*.wav")), "nothing half-written"


def test_the_pure_parts(tmp_path: Path):
    chain = [
        {"path": "C:\\VST3\\A.vst3", "params": {"b": 1.0, "a": 0.5}, "rawState": None}
    ]
    key = vst_render.render_key("C:\\x\\song.wav", 10, 100, chain, 3.0)
    assert len(key) == 64
    assert key == vst_render.render_key("c:\\X\\SONG.WAV", 10, 100, chain, 3.0), (
        "case-insensitive path"
    )
    assert key != vst_render.render_key("C:\\x\\song.wav", 11, 100, chain, 3.0), "mtime"
    assert key != vst_render.render_key("C:\\x\\song.wav", 10, 100, chain, 4.0), "tail"
    assert key != vst_render.render_key(
        "C:\\x\\song.wav", 10, 100, [{**chain[0], "rawState": "AA"}], 3.0
    )
    assert key != vst_render.render_key(
        "C:\\x\\song.wav", 10, 100, chain + chain, 3.0
    ), "chain length"
    assert vst_render.chain_signature(chain) == [
        ["C:\\VST3\\A.vst3", {"a": 0.5, "b": 1.0}, ""]
    ]

    audio = np.ones((SR, 2), dtype=np.float32)
    tailed = vst_render.with_tail(audio, SR, 0.5)
    assert tailed.shape == (SR + SR // 2, 2) and tailed.dtype == np.float32
    assert float(tailed[SR:].sum()) == 0.0
    assert vst_render.with_tail(audio, SR, 0) is audio

    for value in (
        None,
        "",
        "   ",
        "swaydrop:/1/a.wav",
        "SWAYPROJECT:/x.sway",
        "/api/other",
        4,
    ):
        assert vst_render.resolve_input(value) is None, value
    stem = tmp_path / "stem.wav"
    stem.write_bytes(b"RIFF")
    assert (
        vst_render.resolve_input(
            "/api/library/stems/s9/audio", stem_audio=lambda sid: stem
        )
        == stem
    )
    assert vst_render.resolve_input("/api/library/stems/s9/audio") is None, (
        "no lookup, no file"
    )
    assert (
        vst_render.resolve_input(
            "http://localhost:8600/api/library/audio/e2", library_audio=lambda eid: stem
        )
        == stem
    )
    assert (
        vst_render.resolve_input(
            "/api/library/audio/e2", library_audio=lambda eid: tmp_path / "gone.wav"
        )
        is None
    )


class _Param:
    def __init__(self) -> None:
        self.raw_value = 0.5


class _Plugin:
    def __init__(self) -> None:
        self.parameters = {"gain": _Param(), "mix": _Param()}
        self.gain = 1.0
        self.mix = 1.0
        self.raw_state = b"default"

    def __call__(self, audio, sample_rate):
        return audio


def test_raw_params_reach_the_plugin_as_positions(tmp_path: Path, monkeypatch):
    """The cockpit stores 0..1 slider positions; ``raw_params`` sets each
    parameter's ``raw_value``, where ``params`` would set its own units."""
    plugin = _Plugin()
    monkeypatch.setattr(host, "_get_pedalboard", lambda: object())
    monkeypatch.setattr(host, "load_plugin_file", lambda pb, path: plugin)
    fake = tmp_path / "Fake.vst3"
    fake.write_bytes(b"x")
    warnings: list[str] = []
    host.process_with_plugin(
        str(fake),
        np.zeros((4, 2), dtype=np.float32),
        SR,
        params={"gain": 2.0},
        raw_params={"mix": 0.25, "Gain": 0.75, "nope": 0.1, "gain ": 7.0},
        warnings=warnings,
    )
    assert plugin.gain == 2.0, "params set the attribute, in its own units"
    assert plugin.parameters["mix"].raw_value == 0.25
    assert plugin.parameters["gain"].raw_value == 0.75, "raw params normalize the name"
    assert [w.split(":")[0] for w in warnings] == [
        "parameter 'nope' not applied",
        "parameter 'gain ' not applied",
    ], "an unknown name and a position outside 0..1 are reported, never dropped"


def test_the_worker_job_carries_raw_params(tmp_path: Path, monkeypatch):
    seen: dict = {}

    def capture(
        plugin_path,
        audio,
        sample_rate,
        params,
        raw_state,
        warnings,
        raw_params=None,
        automation=None,
    ):
        seen.update(
            path=plugin_path,
            params=params,
            raw_params=raw_params,
            raw_state=raw_state,
            automation=automation,
        )
        return audio * np.float32(2.0)

    monkeypatch.setattr(host, "process_with_plugin", capture)
    job = tmp_path / "job"
    job.mkdir()
    (job / plugin_worker.JOB_FILE).write_text(
        json.dumps(
            {
                "kind": "process",
                "plugin_path": "C:\\VST3\\Fake.vst3",
                "sample_rate": SR,
                "params": None,
                "raw_params": {"gain": 0.2},
            }
        ),
        encoding="utf-8",
    )
    np.save(job / plugin_worker.INPUT_AUDIO_FILE, np.ones((3, 2), dtype=np.float32))
    (job / plugin_worker.STATE_TEXT_FILE).write_text("AAEC", encoding="utf-8")
    assert plugin_worker.run_job(job) == 0
    assert (
        json.loads((job / plugin_worker.RESULT_FILE).read_text(encoding="utf-8"))["ok"]
        is True
    )
    assert seen == {
        "path": "C:\\VST3\\Fake.vst3",
        "params": None,
        "raw_params": {"gain": 0.2},
        "raw_state": "AAEC",
        "automation": None,
    }
    assert float(np.load(job / plugin_worker.OUTPUT_AUDIO_FILE).max()) == 2.0
