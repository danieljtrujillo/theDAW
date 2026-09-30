"""A VST3 plugin that crashes takes down its own process, never the backend.

MT-PowerDrumKit 2.1.5.1 ends whatever process loads it with 0xC0000005. The
backend used to load plugins itself for every pedalboard render
(``/api/vst/render-midi``), insert (``/api/vst/process-file``) and
``/api/vst/load`` instance, so that one plugin took the whole server down.

The route tests run a real backend process (``tests/vst_crash_driver.py``)
against ``tests/fixtures/fake_pedalboard``, whose "Segfault" plugins read
address 0 while loading: a genuine access violation, not an exception. The
backend must answer each crash with a 502 naming the plugin, then keep
serving the next request.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import psutil
import pytest

from backend.modules.vst import isolation

TESTS = Path(__file__).resolve().parent
REPO_ROOT = TESTS.parent
DRIVER = TESTS / "vst_crash_driver.py"
FAKE_PEDALBOARD = TESTS / "fixtures" / "fake_pedalboard"

#: What a crash on this platform is reported as.
CRASH_WORDS = (
    "exit code 0xC0000005, an access violation"
    if sys.platform == "win32"
    else "signal SIGSEGV"
)


def _env_with_fake_pedalboard(data_dir: Path) -> dict[str, str]:
    env = dict(os.environ)
    existing = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = str(FAKE_PEDALBOARD) + (
        os.pathsep + existing if existing else ""
    )
    env["theDAW_DATA_DIR"] = str(data_dir)
    return env


@pytest.fixture
def vst3_root(tmp_path: Path) -> Path:
    root = tmp_path / "VST3"
    root.mkdir()
    for name in (
        "Segfault Drums.vst3",
        "Segfault Reverb.vst3",
        "Segfault Synth.vst3",
        "Vanish Reverb.vst3",
        "RenderCrash Synth.vst3",
        "RenderCrash Reverb.vst3",
        "Good Synth.vst3",
        "Good Reverb.vst3",
        "Hang Reverb.vst3",
        "Chatty Reverb.vst3",
    ):
        (root / name).write_bytes(b"stand-in")
    return root


def _run_backend(scenario: str, vst3_root: Path, tmp_path: Path) -> dict:
    """Run the scenario in a backend process of its own; its RESULT line."""
    proc = subprocess.run(
        [sys.executable, str(DRIVER), str(vst3_root), scenario],
        cwd=str(REPO_ROOT),
        env=_env_with_fake_pedalboard(tmp_path / "data"),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=300,
    )
    lines = [line for line in proc.stdout.splitlines() if line.startswith("RESULT ")]
    assert proc.returncode == 0 and lines, (
        f"the backend process died during {scenario!r}: "
        f"{isolation.describe_exit(proc.returncode)}. "
        f"stderr: {proc.stderr[-1500:]}"
    )
    return json.loads(lines[-1][len("RESULT ") :])


def _by_step(result: dict) -> dict[str, dict]:
    return {step["step"]: step for step in result["steps"]}


def test_an_instrument_that_crashes_while_loading_leaves_render_midi_serving(
    vst3_root: Path, tmp_path: Path
):
    result = _run_backend("render-midi", vst3_root, tmp_path)
    steps = _by_step(result)

    crashed = steps["crash on load"]
    assert crashed["status"] == 502
    detail = crashed["body"]["detail"]
    assert detail.startswith("Track drums: ")
    assert "'Segfault Drums' crashed while rendering" in detail
    assert CRASH_WORDS in detail
    assert "theDAW kept running" in detail

    # The next print, on the same server, renders.
    healthy = steps["healthy"]
    assert healthy["status"] == 200, healthy
    assert healthy["report"][0]["frames"] == 4000

    # A plugin that loads and then crashes mid-render is reported the same way.
    mid = steps["crash on render"]
    assert mid["status"] == 502
    assert "'RenderCrash Synth' crashed" in mid["body"]["detail"]
    assert steps["healthy again"]["status"] == 200
    assert result["left_behind"] == [], "every job's files are removed"


def test_an_insert_that_crashes_or_vanishes_leaves_process_file_serving(
    vst3_root: Path, tmp_path: Path
):
    steps = _by_step(_run_backend("process-file", vst3_root, tmp_path))

    vanished = steps["exit without answer"]
    assert vanished["status"] == 502
    assert (
        "'Vanish Reverb' crashed while processing audio" in (vanished["body"]["detail"])
    )
    assert "it exited without answering" in vanished["body"]["detail"]

    segfault = steps["crash on load"]
    assert segfault["status"] == 502
    assert "'Segfault Reverb' crashed" in segfault["body"]["detail"]
    assert CRASH_WORDS in segfault["body"]["detail"]

    healthy = steps["healthy"]
    assert healthy["status"] == 200, healthy
    assert healthy["peak"] == pytest.approx(0.25), "0.5 in, through a 0.5 gain"


def test_a_loaded_instance_that_crashes_leaves_the_registry_and_the_server_up(
    vst3_root: Path, tmp_path: Path
):
    result = _run_backend("load", vst3_root, tmp_path)
    steps = _by_step(result)

    crashed = steps["crash on load"]
    assert crashed["status"] == 502
    assert "'Segfault Synth' crashed while loading" in crashed["body"]["detail"]

    loaded = steps["healthy load"]
    assert loaded["status"] == 200, loaded
    assert loaded["body"]["plugin_name"] == "Good Reverb"
    assert loaded["body"]["parameters"]["gain"]["value"] == pytest.approx(0.5)

    assert steps["set gain"]["status"] == 200
    assert steps["set gain"]["body"]["value"] == pytest.approx(0.25)
    # The instance keeps its parameter between requests: it lives on in its worker.
    assert steps["process through fx-1"]["status"] == 200
    assert steps["process through fx-1"]["peak"] == pytest.approx(0.125)

    assert steps["load a plugin that crashes on audio"]["status"] == 200
    on_audio = steps["crash on process"]
    assert on_audio["status"] == 502
    assert (
        "'RenderCrash Reverb' crashed while processing audio"
        in (on_audio["body"]["detail"])
    )

    listed = steps["list after the crash"]["body"]
    assert [entry["instance_id"] for entry in listed] == ["fx-1"]
    assert steps["unload fx-1"]["status"] == 200
    assert steps["list after unload"]["body"] == []
    assert result["left_behind"] == [], "every worker's files are removed"


# ---------------------------------------------------------------------------
# The worker itself, driven from this process
# ---------------------------------------------------------------------------


@pytest.fixture
def fake_children(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Workers started from this process import the stand-in pedalboard."""
    env = _env_with_fake_pedalboard(tmp_path / "data")
    monkeypatch.setenv("PYTHONPATH", env["PYTHONPATH"])
    monkeypatch.setenv("theDAW_DATA_DIR", env["theDAW_DATA_DIR"])
    yield tmp_path / "data"
    isolation.stop_all()


def _workers() -> list[psutil.Process]:
    found = []
    for child in psutil.Process().children(recursive=True):
        try:
            if "backend.modules.vst.plugin_worker" in " ".join(child.cmdline()):
                found.append(child)
        except psutil.Error:
            continue
    return found


def test_a_render_that_hangs_is_stopped_at_its_timeout(
    vst3_root: Path, fake_children: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setattr(isolation, "JOB_TIMEOUT_BASE_SECONDS", 3.0)
    monkeypatch.setattr(isolation, "JOB_SECONDS_PER_AUDIO_SECOND", 0.0)
    started = time.monotonic()
    with pytest.raises(isolation.PluginTimedOut, match="'Hang Reverb' did not finish"):
        isolation.process_with_plugin(
            str(vst3_root / "Hang Reverb.vst3"),
            np.zeros((100, 2), dtype=np.float32),
            8000,
        )
    assert time.monotonic() - started < 30
    assert _workers() == [], "the hung worker was killed"


def test_a_load_that_hangs_is_stopped_and_never_registered(
    vst3_root: Path, fake_children: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setattr(isolation, "LOAD_TIMEOUT_SECONDS", 3.0)
    with pytest.raises(isolation.PluginTimedOut, match="did not finish loading"):
        isolation.load_plugin(str(vst3_root / "Hang Reverb.vst3"), "slow")
    with pytest.raises(KeyError):
        isolation.get_instance("slow")
    assert _workers() == []


def test_a_plugin_that_prints_cannot_garble_its_instance_answers(
    vst3_root: Path, fake_children: Path
):
    """The chatty plugin writes to stdout from Python and from fd 1, while it
    loads and while it processes; every answer still reaches the backend."""
    instance = isolation.load_plugin(str(vst3_root / "Chatty Reverb.vst3"), "chatty")
    assert instance.parameters["gain"]["value"] == pytest.approx(0.5)
    instance.set_parameter("gain", 0.5)
    out = isolation.process_chain(
        ["chatty"], np.full((64, 2), 0.5, dtype=np.float32), 8000
    )
    assert np.allclose(out, 0.25)
    with pytest.raises(KeyError, match="Unknown parameter"):
        instance.set_parameter("no such knob", 0.1)
    pid = instance.pid
    isolation.unload_plugin("chatty")
    assert not psutil.pid_exists(pid) or psutil.Process(pid).status() == (
        psutil.STATUS_ZOMBIE
    )
    assert list((fake_children / "vst_render").iterdir()) == []


def test_a_worker_ends_when_the_backend_goes_away(vst3_root: Path, fake_children):
    """Its stdin closing, which is what the backend's exit does, ends it."""
    instance = isolation.load_plugin(str(vst3_root / "Good Reverb.vst3"), "orphan")
    proc = psutil.Process(instance.pid)
    instance._proc.stdin.close()
    proc.wait(timeout=15)
    with pytest.raises(isolation.PluginProcessError):
        _ = instance.parameters
    with pytest.raises(KeyError):
        isolation.get_instance("orphan")


@pytest.mark.parametrize(
    ("code", "words"),
    [
        (0xC0000005, "exit code 0xC0000005, an access violation"),
        (0xC0000409, "exit code 0xC0000409, a stack buffer overrun"),
        (-11, "signal SIGSEGV"),
        (0, "it exited without answering"),
        (3, "exit code 3"),
        (None, "it did not exit"),
    ],
)
def test_exit_statuses_read_as_words(code, words):
    assert isolation.describe_exit(code) == words
