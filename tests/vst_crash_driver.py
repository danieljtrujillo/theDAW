"""A backend process for tests/test_vst_plugin_crash.py.

``python tests/vst_crash_driver.py VST3_ROOT SCENARIO``, run with
``tests/fixtures/fake_pedalboard`` on PYTHONPATH, mounts the VST routes the way
``backend/server.py`` does, sends the scenario's requests in order, and prints
one line, ``RESULT <json>``, with every step's status and answer. When a
plugin takes this process down, as MT-PowerDrumKit took the backend down, that
line never appears and the exit code says how it died.
"""

from __future__ import annotations

import io
import json
import sys
from email.parser import BytesParser
from email.policy import default as email_policy
from pathlib import Path
from typing import Any, Callable

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

if sys.platform == "win32":
    import ctypes

    # A crash here must end the process, not wait behind an error dialog.
    ctypes.windll.kernel32.SetErrorMode(0x8003)

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from backend.lib import paths  # noqa: E402
from backend.modules.vst import path_policy, scanner  # noqa: E402
from backend.modules.vst import router as vst_router  # noqa: E402

RATE = 8000


def _wav(value: float = 0.5, frames: int = 800) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, np.full((frames, 2), value, dtype=np.float32), RATE, format="WAV")
    return buf.getvalue()


def _step(name: str, response, **extra: Any) -> dict:
    step = {"step": name, "status": response.status_code, **extra}
    if response.headers.get("content-type", "").startswith("application/json"):
        step["body"] = response.json()
    return step


def _report(response) -> list[dict]:
    header = f"Content-Type: {response.headers['content-type']}\r\n\r\n".encode()
    message = BytesParser(policy=email_policy).parsebytes(header + response.content)
    for part in message.iter_parts():
        if part.get_param("name", header="content-disposition") == "report":
            return json.loads(part.get_payload(decode=True))["tracks"]
    return []


def _track(root: Path, file_name: str, track_id: str) -> dict:
    return {
        "track_id": track_id,
        "plugin_path": str(root / file_name),
        "duration": 0.5,
        "events": [
            {"t": 0.25, "data": [0x90, 60, 127]},
            {"t": 0.4, "data": [0x80, 60, 0]},
        ],
    }


def render_midi(client: TestClient, root: Path) -> list[dict]:
    steps = []
    for name, file_name, track_id in (
        ("crash on load", "Segfault Drums.vst3", "drums"),
        ("healthy", "Good Synth.vst3", "keys"),
        ("crash on render", "RenderCrash Synth.vst3", "pads"),
        ("healthy again", "Good Synth.vst3", "keys"),
    ):
        response = client.post(
            "/api/vst/render-midi",
            json={"sample_rate": RATE, "tracks": [_track(root, file_name, track_id)]},
        )
        extra = {}
        if response.status_code == 200:
            extra["report"] = _report(response)
        steps.append(_step(name, response, **extra))
    return steps


def process_file(client: TestClient, root: Path) -> list[dict]:
    steps = []
    for name, file_name in (
        ("exit without answer", "Vanish Reverb.vst3"),
        ("crash on load", "Segfault Reverb.vst3"),
        ("healthy", "Good Reverb.vst3"),
    ):
        response = client.post(
            "/api/vst/process-file",
            files={"audio": ("stem.wav", _wav(), "audio/wav")},
            data={"plugin_path": str(root / file_name)},
        )
        extra = {}
        if response.status_code == 200:
            audio, _ = sf.read(io.BytesIO(response.content), dtype="float32")
            extra["peak"] = float(np.max(np.abs(audio)))
        steps.append(_step(name, response, **extra))
    return steps


def load(client: TestClient, root: Path) -> list[dict]:
    take = root / "take.wav"
    take.write_bytes(_wav())
    out = root / "take-fx.wav"

    def process(name: str, instance_id: str) -> dict:
        response = client.post(
            "/api/vst/process",
            json={
                "instance_ids": [instance_id],
                "audio_path": str(take),
                "output_path": str(out),
            },
        )
        extra = {}
        if response.status_code == 200:
            audio, _ = sf.read(out, dtype="float32")
            extra["peak"] = float(np.max(np.abs(audio)))
        return _step(name, response, **extra)

    def post_load(name: str, file_name: str, instance_id: str) -> dict:
        response = client.post(
            "/api/vst/load",
            json={"plugin_path": str(root / file_name), "instance_id": instance_id},
        )
        return _step(name, response)

    return [
        post_load("crash on load", "Segfault Synth.vst3", "bad-1"),
        post_load("healthy load", "Good Reverb.vst3", "fx-1"),
        _step(
            "set gain",
            client.put("/api/vst/param/fx-1", json={"name": "gain", "value": 0.25}),
        ),
        process("process through fx-1", "fx-1"),
        post_load(
            "load a plugin that crashes on audio", "RenderCrash Reverb.vst3", "fx-2"
        ),
        process("crash on process", "fx-2"),
        _step("list after the crash", client.get("/api/vst/plugins")),
        _step("unload fx-1", client.delete("/api/vst/unload/fx-1")),
        _step("list after unload", client.get("/api/vst/plugins")),
    ]


SCENARIOS: dict[str, Callable[[TestClient, Path], list[dict]]] = {
    "render-midi": render_midi,
    "process-file": process_file,
    "load": load,
}


def main() -> int:
    root = Path(sys.argv[1]).resolve()
    scenario = SCENARIOS[sys.argv[2]]
    scanner._default_vst3_dirs = lambda: [root]
    path_policy.allowed_roots = lambda: [root]
    app = FastAPI()
    app.include_router(vst_router.router, prefix="/api/vst")
    client = TestClient(app, client=("127.0.0.1", 51000))
    steps = scenario(client, root)
    work = paths.data_path("vst_render")
    left = sorted(p.name for p in work.iterdir()) if work.is_dir() else []
    print("RESULT " + json.dumps({"steps": steps, "left_behind": left}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
