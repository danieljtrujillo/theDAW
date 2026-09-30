"""``POST /api/vst/process-file`` rendered through our own native host.

The route grew one optional form field, ``state_host``. Absent or
``pedalboard`` it runs today's pedalboard code path; ``thedaw`` sends the
upload through ``thedaw-vst-host --render``. These tests drive the second
branch against ``tests/fake_vst_host.py`` (which copies ``--in`` to ``--out``
and honours the ``FAKE_VST_HOST_*`` env overrides), so no native binary and no
real plugin is needed.

The rule the tests exist to protect: the ``thedaw`` branch NEVER falls back to
pedalboard. A missing host is 503, a non-zero exit is 502 — never quietly
different audio.
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.datastructures import UploadFile as StarletteUploadFile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from backend.modules.vst import live_host as lh  # noqa: E402
from backend.modules.vst import path_policy  # noqa: E402
from backend.modules.vst import router as vst_router  # noqa: E402

FAKE_HOST = Path(__file__).resolve().parent / "fake_vst_host.py"


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(vst_router.router, prefix="/api/vst")
    # The VST routes are loopback-gated (T03): TestClient's default peer is
    # "testclient", which is not loopback, so name a real loopback peer the
    # way tests/test_vst_b12.py does.
    return TestClient(app, client=("127.0.0.1", 51000))


@pytest.fixture
def vst3_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """An allowed VST3 root (R5-2, extended to ``/process-file``).

    ``path_policy.allowed_roots`` is patched directly, the same thing
    ``tests/test_vst_path_policy.py`` does.
    """
    root = tmp_path / "VST3"
    root.mkdir()
    monkeypatch.setattr(path_policy, "allowed_roots", lambda: [root.resolve()])
    return root


@pytest.fixture
def plugin_file(vst3_root: Path) -> Path:
    path = vst3_root / "Vinyl.vst3"
    path.write_bytes(b"only the path is validated by the route")
    return path


@pytest.fixture
def wav_bytes() -> bytes:
    signal = np.linspace(-0.5, 0.5, 480, dtype="float32").reshape(-1, 2)
    buf = io.BytesIO()
    sf.write(buf, signal, 48000, format="WAV", subtype="FLOAT")
    return buf.getvalue()


@pytest.fixture
def render_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Keep every temp render out of the real app data directory."""
    root = tmp_path / "vst_render"
    monkeypatch.setattr(vst_router, "_RENDER_DIR", root)
    return root


@pytest.fixture
def fake_host(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(lh.HOST_ENV_VAR, str(FAKE_HOST))


@pytest.fixture
def no_host(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """No host anywhere: env unset AND the built path pointed at an empty dir."""
    monkeypatch.delenv(lh.HOST_ENV_VAR, raising=False)
    empty = tmp_path / "empty-root"
    empty.mkdir()
    monkeypatch.setattr(lh.paths, "PROJECT_ROOT", empty)


@pytest.fixture
def pedalboard_spy(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    """Records every pedalboard call so 'no silent fallback' is provable."""
    calls: list[dict] = []

    def fake_process(plugin_path, signal, sr, param_map, raw_state, warnings):
        calls.append({"plugin_path": plugin_path, "raw_state": raw_state})
        return signal * 0.0 + 0.25

    monkeypatch.setattr(vst_router, "process_with_plugin", fake_process)
    return calls


def _post(client, plugin_file, wav_bytes, **form):
    return client.post(
        "/api/vst/process-file",
        files={"audio": ("in.wav", wav_bytes, "audio/wav")},
        data={"plugin_path": str(plugin_file), **form},
    )


# ---------------------------------------------------------------------------
# The default path must stay exactly what it was
# ---------------------------------------------------------------------------


def test_absent_state_host_still_runs_pedalboard(
    client, plugin_file, wav_bytes, pedalboard_spy
):
    resp = _post(client, plugin_file, wav_bytes)

    assert resp.status_code == 200
    assert resp.headers["content-type"] == "audio/wav"
    assert len(pedalboard_spy) == 1
    audio, _sr = sf.read(io.BytesIO(resp.content), dtype="float32", always_2d=True)
    assert np.allclose(audio, 0.25)


def test_pedalboard_state_host_runs_pedalboard(
    client, plugin_file, wav_bytes, pedalboard_spy
):
    resp = _post(client, plugin_file, wav_bytes, state_host="pedalboard")

    assert resp.status_code == 200
    assert len(pedalboard_spy) == 1


def test_an_unknown_state_host_is_rejected(
    client, plugin_file, wav_bytes, pedalboard_spy
):
    resp = _post(client, plugin_file, wav_bytes, state_host="reaper")

    assert resp.status_code == 400
    assert "state_host" in resp.json()["detail"]
    assert pedalboard_spy == []


# ---------------------------------------------------------------------------
# thedaw: render through our host
# ---------------------------------------------------------------------------


def test_thedaw_returns_what_the_host_rendered(
    client, plugin_file, wav_bytes, fake_host, render_root, pedalboard_spy
):
    resp = _post(client, plugin_file, wav_bytes, state_host="thedaw")

    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"] == "audio/wav"
    # The fake host copies --in to --out, so the body proves the bytes went
    # through the host and came back, not through pedalboard.
    assert resp.content == wav_bytes
    assert pedalboard_spy == []


def test_thedaw_hands_the_host_the_decoded_raw_state(
    client, plugin_file, wav_bytes, fake_host, render_root, monkeypatch
):
    monkeypatch.setenv("FAKE_VST_HOST_RENDER_ECHO", "1")
    blob = b"\x00\x01\x02state bytes\xff"

    resp = _post(
        client,
        plugin_file,
        wav_bytes,
        state_host="thedaw",
        raw_state=base64.b64encode(blob).decode("ascii"),
        plugin_name="Vinyl",
    )

    assert resp.status_code == 200, resp.text
    warnings = json.loads(resp.headers["X-Vst-Warnings"])
    assert f"echo: state-bytes={len(blob)}" in warnings
    assert "echo: plugin-name=Vinyl" in warnings


def test_thedaw_rejects_raw_state_that_is_not_base64(
    client, plugin_file, wav_bytes, fake_host, render_root, pedalboard_spy
):
    resp = _post(
        client, plugin_file, wav_bytes, state_host="thedaw", raw_state="not base64!!"
    )

    assert resp.status_code == 400
    assert "raw_state" in resp.json()["detail"]
    assert pedalboard_spy == []


def test_thedaw_forwards_the_hosts_warnings(
    client, plugin_file, wav_bytes, fake_host, render_root, monkeypatch
):
    monkeypatch.setenv(
        "FAKE_VST_HOST_RENDER_WARNINGS",
        json.dumps(["the plugin changed its latency during the render"]),
    )

    resp = _post(client, plugin_file, wav_bytes, state_host="thedaw")

    assert resp.status_code == 200, resp.text
    warnings = json.loads(resp.headers["X-Vst-Warnings"])
    assert "the plugin changed its latency during the render" in warnings
    assert "X-Vst-Warnings" in resp.headers["Access-Control-Expose-Headers"]


def test_thedaw_cleans_up_its_temp_files(
    client, plugin_file, wav_bytes, fake_host, render_root
):
    resp = _post(client, plugin_file, wav_bytes, state_host="thedaw")

    assert resp.status_code == 200, resp.text
    assert list(render_root.glob("*")) == []


# ---------------------------------------------------------------------------
# Failures: loud, never a fallback
# ---------------------------------------------------------------------------


def test_thedaw_without_a_host_binary_is_503_with_the_reason(
    client, plugin_file, wav_bytes, no_host, render_root, pedalboard_spy
):
    resp = _post(client, plugin_file, wav_bytes, state_host="thedaw")

    assert resp.status_code == 503
    assert "thedaw-vst-host" in resp.json()["detail"]
    assert pedalboard_spy == []


def test_thedaw_non_zero_exit_is_502_with_the_meaning_and_the_log_tail(
    client, plugin_file, wav_bytes, fake_host, render_root, monkeypatch, pedalboard_spy
):
    monkeypatch.setenv("FAKE_VST_HOST_EXIT_CODE", "7")
    monkeypatch.setenv("FAKE_VST_HOST_EXIT_MESSAGE", "fake-host: RIFF header is junk")

    resp = _post(client, plugin_file, wav_bytes, state_host="thedaw")

    assert resp.status_code == 502
    detail = resp.json()["detail"]
    assert "exit code 7" in detail
    # The documented meaning of 7, plus what the host actually said.
    assert "could not be read" in detail
    assert "RIFF header is junk" in detail
    assert pedalboard_spy == []


def test_thedaw_missing_plugin_is_still_a_404_before_any_spawn(
    client, vst3_root, wav_bytes, fake_host, render_root, pedalboard_spy
):
    # Inside the allowed root (so this exercises the "not found" branch, not
    # the R5-2 containment check) but never created.
    resp = _post(client, vst3_root / "Nope.vst3", wav_bytes, state_host="thedaw")

    assert resp.status_code == 404
    assert pedalboard_spy == []


# ---------------------------------------------------------------------------
# F5a1: never block the event loop, bounded kill, no leaks, size caps
# ---------------------------------------------------------------------------


def test_thedaw_render_does_not_block_the_event_loop(
    client, plugin_file, wav_bytes, fake_host, render_root, monkeypatch
):
    """The render must run off the event loop thread, so a second request is
    served while the first is still stuck inside the (blocked) subprocess
    call.

    ``Popen`` itself is wrapped rather than making the fake host slow,
    because ``tests/fake_vst_host.py`` has no delay hook for ``--render`` and
    is not in this ticket's write set. Only the first ``communicate()`` call
    blocks (on a real ``threading.Event``), so the second, concurrent render
    proceeds against the real fake host normally.
    """
    real_popen = vst_router.subprocess.Popen
    entered = threading.Event()
    release = threading.Event()
    call_count = {"n": 0}

    class BlockingPopen:
        def __init__(self, *args, **kwargs):
            self._inner = real_popen(*args, **kwargs)

        def communicate(self, timeout=None):
            call_count["n"] += 1
            if call_count["n"] == 1:
                entered.set()
                release.wait(timeout=10)
            return self._inner.communicate(timeout=timeout)

        def __getattr__(self, name):
            return getattr(self._inner, name)

    monkeypatch.setattr(vst_router.subprocess, "Popen", BlockingPopen)

    with client:
        slow_result: dict[str, object] = {}

        def run_slow():
            slow_result["resp"] = _post(
                client, plugin_file, wav_bytes, state_host="thedaw"
            )

        slow_thread = threading.Thread(target=run_slow)
        slow_thread.start()
        assert entered.wait(timeout=5), "the render never reached communicate()"

        fast_start = time.monotonic()
        fast_resp = _post(client, plugin_file, wav_bytes, state_host="thedaw")
        fast_elapsed = time.monotonic() - fast_start

        release.set()
        slow_thread.join(timeout=10)

    assert fast_resp.status_code == 200, fast_resp.text
    assert fast_elapsed < 2.0, (
        f"the fast request waited {fast_elapsed:.3f}s behind the slow one — "
        "the event loop was blocked"
    )
    assert not slow_thread.is_alive(), "the slow render never finished"
    assert slow_result["resp"].status_code == 200, slow_result["resp"].text


def test_thedaw_render_timeout_kills_the_child_and_returns_promptly(
    client, plugin_file, wav_bytes, fake_host, render_root, monkeypatch, pedalboard_spy
):
    """A timeout must kill the child and wait for it with a BOUNDED timeout,
    never the unbounded wait ``subprocess.run`` performs internally after a
    kill (review R5 nit #10).
    """
    real_popen = vst_router.subprocess.Popen
    kill_called = threading.Event()
    communicate_timeouts: list[float | None] = []

    class TimeoutOncePopen:
        def __init__(self, *args, **kwargs):
            self._inner = real_popen(*args, **kwargs)
            self._calls = 0

        def communicate(self, timeout=None):
            communicate_timeouts.append(timeout)
            self._calls += 1
            if self._calls == 1:
                raise subprocess.TimeoutExpired(cmd="thedaw-vst-host", timeout=timeout)
            return self._inner.communicate(timeout=timeout)

        def kill(self):
            kill_called.set()
            self._inner.kill()

        def __getattr__(self, name):
            return getattr(self._inner, name)

    monkeypatch.setattr(vst_router.subprocess, "Popen", TimeoutOncePopen)
    monkeypatch.setattr(vst_router, "RENDER_TIMEOUT_SECONDS", 0.01)

    started = time.monotonic()
    resp = _post(client, plugin_file, wav_bytes, state_host="thedaw")
    elapsed = time.monotonic() - started

    assert resp.status_code == 502
    assert "did not finish" in resp.json()["detail"]
    assert kill_called.is_set(), "the timed-out child was never killed"
    assert len(communicate_timeouts) == 2, "expected one retry after the kill"
    assert communicate_timeouts[0] == vst_router.RENDER_TIMEOUT_SECONDS
    # The post-kill wait must be its own short, bounded timeout — never None
    # (unbounded) and never the full render timeout again.
    assert communicate_timeouts[1] == vst_router.RENDER_KILL_WAIT_SECONDS
    assert communicate_timeouts[1] < 30
    assert elapsed < 5.0, f"the request took {elapsed:.3f}s — a wait wasn't bounded"
    assert pedalboard_spy == []


def test_thedaw_cleans_up_temp_dir_on_timeout(
    client, plugin_file, wav_bytes, fake_host, render_root, monkeypatch
):
    real_popen = vst_router.subprocess.Popen

    class AlwaysTimesOutPopen:
        def __init__(self, *args, **kwargs):
            self._inner = real_popen(*args, **kwargs)

        def communicate(self, timeout=None):
            raise subprocess.TimeoutExpired(cmd="thedaw-vst-host", timeout=timeout)

        def __getattr__(self, name):
            return getattr(self._inner, name)

    monkeypatch.setattr(vst_router.subprocess, "Popen", AlwaysTimesOutPopen)

    resp = _post(client, plugin_file, wav_bytes, state_host="thedaw")

    assert resp.status_code == 502
    assert list(render_root.glob("*")) == []


def test_thedaw_cleans_up_temp_dir_on_unexpected_exception(
    client, plugin_file, wav_bytes, fake_host, render_root, monkeypatch
):
    """A failure mid-stage (not a timeout, not a non-zero exit) must still
    remove the temp render directory — the cleanup is a ``finally`` around
    the whole render, not a happy-path-only step.
    """
    real_write_bytes = Path.write_bytes

    def flaky_write_bytes(self: Path, data: bytes):
        if self.name == "state.bin":
            raise OSError("disk is full")
        return real_write_bytes(self, data)

    monkeypatch.setattr(Path, "write_bytes", flaky_write_bytes)

    resp = _post(
        client,
        plugin_file,
        wav_bytes,
        state_host="thedaw",
        raw_state=base64.b64encode(b"some state").decode("ascii"),
    )

    assert resp.status_code == 500
    assert list(render_root.glob("*")) == []


def test_thedaw_oserror_detail_has_no_absolute_path(
    client, plugin_file, wav_bytes, fake_host, tmp_path, monkeypatch
):
    """``str(OSError)`` includes the failing path (via ``repr(filename)``,
    which escapes Windows backslashes — a naive ``str(path) in detail`` check
    would miss the leak); the client must only see the reason (review R5
    item #6, ``live_host._os_reason``). The directory's distinctive name is
    checked instead, since that substring survives any backslash escaping.
    """
    blocked = tmp_path / "blocked-render-dir"
    blocked.write_bytes(b"not a directory")
    monkeypatch.setattr(vst_router, "_RENDER_DIR", blocked)

    resp = _post(client, plugin_file, wav_bytes, state_host="thedaw")

    assert resp.status_code == 500
    detail = resp.json()["detail"]
    assert blocked.name not in detail
    assert "WinError" not in detail
    assert "Errno" not in detail


def test_thedaw_scrubs_absolute_paths_from_the_warnings_header(
    client, plugin_file, wav_bytes, fake_host, render_root, monkeypatch
):
    """A warning the host echoes back must not leak the server's temp-file
    layout into ``X-Vst-Warnings`` (review R5 item #11).
    """
    fixed_work = render_root / "render-fixed"
    fixed_work.mkdir(parents=True)

    def fake_mkdtemp(prefix="", dir=None):
        return str(fixed_work)

    monkeypatch.setattr(vst_router.tempfile, "mkdtemp", fake_mkdtemp)
    in_path = fixed_work / "in.wav"
    monkeypatch.setenv(
        "FAKE_VST_HOST_RENDER_WARNINGS",
        json.dumps([f"clipped samples while reading {in_path}"]),
    )

    resp = _post(client, plugin_file, wav_bytes, state_host="thedaw")

    assert resp.status_code == 200, resp.text
    warnings = json.loads(resp.headers["X-Vst-Warnings"])
    assert not any(str(in_path) in w for w in warnings)
    assert any("in.wav" in w for w in warnings)


def test_thedaw_rejects_an_oversized_upload(
    client, plugin_file, wav_bytes, fake_host, render_root, monkeypatch, pedalboard_spy
):
    monkeypatch.setenv("THEDAW_VST_RENDER_MAX_BYTES", str(len(wav_bytes) - 1))

    resp = _post(client, plugin_file, wav_bytes, state_host="thedaw")

    assert resp.status_code == 413
    assert pedalboard_spy == []
    assert list(render_root.glob("*")) == []


def test_thedaw_rejects_an_oversized_raw_state(
    client, plugin_file, wav_bytes, fake_host, render_root, monkeypatch, pedalboard_spy
):
    monkeypatch.setattr(vst_router, "_RENDER_MAX_RAW_STATE_CHARS", 8)
    blob = base64.b64encode(b"far more than eight base64 characters").decode("ascii")

    resp = _post(client, plugin_file, wav_bytes, state_host="thedaw", raw_state=blob)

    assert resp.status_code == 413
    assert pedalboard_spy == []


# ---------------------------------------------------------------------------
# F5a1 audit follow-up: stderr must be scrubbed too, the upload must stream
# to disk instead of being buffered whole, and its OSError path must use
# _os_reason like every other one in this branch
# ---------------------------------------------------------------------------


def test_thedaw_scrubs_absolute_paths_from_a_non_zero_exit_error(
    client, plugin_file, wav_bytes, fake_host, render_root, monkeypatch, pedalboard_spy
):
    """The warnings header is scrubbed (review R5 item #11), but the host's
    stderr used to reach the client verbatim in the non-zero-exit 502 detail
    — and stderr is exactly where the host logs a complaint about the
    absolute ``--in`` path it was launched with.
    """
    fixed_work = render_root / "render-fixed"
    fixed_work.mkdir(parents=True)

    def fake_mkdtemp(prefix="", dir=None):
        return str(fixed_work)

    monkeypatch.setattr(vst_router.tempfile, "mkdtemp", fake_mkdtemp)
    in_path = fixed_work / "in.wav"
    monkeypatch.setenv("FAKE_VST_HOST_EXIT_CODE", "7")
    monkeypatch.setenv(
        "FAKE_VST_HOST_EXIT_MESSAGE", f"fake-host: could not read {in_path}"
    )

    resp = _post(client, plugin_file, wav_bytes, state_host="thedaw")

    assert resp.status_code == 502
    detail = resp.json()["detail"]
    assert str(in_path) not in detail
    assert "in.wav" in detail
    assert pedalboard_spy == []


def test_read_upload_capped_writes_accepted_chunks_before_raising(
    tmp_path, monkeypatch
):
    """The pre-fix implementation capped the READ but still built one whole
    ``bytes`` object in memory before anything touched disk (review R5 item
    #7's actual defect). This proves the fix: the chunk that fit under the
    cap is already sitting on disk by the time ``_UploadTooLarge`` is raised
    for the chunk that doesn't, so nothing extra is held in memory only to be
    thrown away.
    """
    monkeypatch.setattr(vst_router, "_UPLOAD_READ_CHUNK_BYTES", 10)
    dest = tmp_path / "in.wav"
    chunk_a = b"a" * 10
    chunk_b = b"b" * 10

    class _FakeUpload:
        def __init__(self, chunks: list[bytes]) -> None:
            self._chunks = list(chunks)

        async def read(self, size: int) -> bytes:
            return self._chunks.pop(0) if self._chunks else b""

    upload = _FakeUpload([chunk_a, chunk_b])

    with pytest.raises(vst_router._UploadTooLarge):
        asyncio.run(vst_router._read_upload_capped(upload, max_bytes=15, dest=dest))

    assert dest.read_bytes() == chunk_a


def test_thedaw_oserror_while_reading_the_upload_uses_os_reason(
    client, plugin_file, wav_bytes, fake_host, render_root, monkeypatch, pedalboard_spy
):
    """Every other OSError site in the thedaw branch was routed through
    ``_os_reason`` (review R5 item #6); the upload-read failure path was the
    one the earlier sweep missed and still leaked raw ``str(OSError)`` —
    errno and filename included.

    Patches Starlette's own ``UploadFile`` (not ``fastapi.UploadFile``): the
    object FastAPI hands the route is the one Starlette's multipart parser
    built — ``fastapi.UploadFile._validate`` only casts it for typing, it
    never constructs one — so that is the class whose ``read`` actually runs.
    """

    async def broken_read(self, size: int = -1) -> bytes:
        raise OSError(9, "fake I/O failure", "in.wav")

    monkeypatch.setattr(StarletteUploadFile, "read", broken_read)

    resp = _post(client, plugin_file, wav_bytes, state_host="thedaw")

    assert resp.status_code == 400
    detail = resp.json()["detail"]
    assert "fake I/O failure" in detail
    assert "Errno" not in detail
    assert "in.wav" not in detail
    assert pedalboard_spy == []
    assert list(render_root.glob("*")) == []
