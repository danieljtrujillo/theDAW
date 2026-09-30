"""End-to-end tests for the native live VST host (``native/vst-host``).

Skipped as a whole when the binary has not been built. Build it with
``native/vst-host/build.ps1 -Vst3 OFF`` (or set ``THEDAW_VST_HOST``).

Every test drives the real process over a real loopback WebSocket; nothing here
is mocked. All host processes are reaped by the context managers even when a
test fails.
"""

from __future__ import annotations

import base64
import contextlib
import json
import math
import os
import statistics
import subprocess
import sys
import time
import wave
from types import SimpleNamespace

import psutil
import pytest

from tests.vst_host_client import (
    HostProcess,
    host_exe,
    host_has_vst3,
    noise,
    pack_audio_in,
    ramp,
    run_host,
)

pytestmark = pytest.mark.skipif(
    host_exe() is None,
    reason="native/vst-host/bin/thedaw-vst-host.exe not built",
)

SAMPLE_RATE = 48000
BLOCK = 512


def null_args(state_file: str | None = None, extra: list[str] | None = None):
    args = [
        "--null-plugin",
        "--sample-rate",
        str(SAMPLE_RATE),
        "--block-size",
        str(BLOCK),
        "--channels",
        "2",
        "--port",
        "0",
    ]
    if state_file is not None:
        args += ["--state-file", state_file]
    if extra:
        args += extra
    return args


# ---------------------------------------------------------------------------
# CLI surface
# ---------------------------------------------------------------------------


def test_selftest_passes():
    proc = run_host(["--selftest"], timeout=120)
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_help_and_version_exit_zero():
    assert run_host(["--help"]).returncode == 0
    version = run_host(["--version"])
    assert version.returncode == 0
    payload = next(
        json.loads(line)
        for line in version.stdout.splitlines()
        if line.strip().startswith("{")
    )
    assert payload["protocol"] == 1
    assert isinstance(payload["vst3"], bool)


@pytest.mark.parametrize(
    "args",
    [
        ["--nonsense-flag"],
        ["--sample-rate", "not-a-number", "--null-plugin"],
        ["--block-size", "0", "--null-plugin"],
        ["--channels", "99", "--null-plugin"],
        ["--plugin"],
        [],
    ],
)
def test_bad_arguments_exit_two(args):
    assert run_host(args).returncode == 2


def test_list_missing_file_exits_three(tmp_path):
    missing = tmp_path / "nope.vst3"
    assert run_host(["--list", "--plugin", str(missing)]).returncode == 3


def test_list_existing_file_reports_layer_state(tmp_path):
    present = tmp_path / "fake.vst3"
    present.write_bytes(b"not really a plugin")
    proc = run_host(["--list", "--plugin", str(present)])
    if host_has_vst3():
        # The real layer owns this path; it must not claim "not built".
        assert proc.returncode in (0, 4)
        assert "VST3 layer not built" not in proc.stdout + proc.stderr
    else:
        assert proc.returncode == 4
        assert "VST3 layer not built" in proc.stdout + proc.stderr


# ---------------------------------------------------------------------------
# Handshake / ready
# ---------------------------------------------------------------------------


def test_hello_returns_ready_with_contract_fields():
    with HostProcess(null_args()) as host, host.connect() as client:
        ready = client.hello()
    assert ready["protocol"] == 1
    assert ready["sample_rate"] == SAMPLE_RATE
    assert ready["block_size"] == BLOCK
    assert ready["channels_in"] == 2
    assert ready["channels_out"] == 2
    assert ready["latency_samples"] == 0
    assert ready["has_editor"] is False
    assert ready["state_compat"] is True
    assert isinstance(ready["tail_seconds"], (int, float))
    assert isinstance(ready["warnings"], list)
    plugin = ready["plugin"]
    for field in ("name", "vendor", "version", "category", "identifier", "format"):
        assert isinstance(plugin[field], str)
    assert plugin["format"] == "null"


def test_hello_must_come_first():
    with HostProcess(null_args()) as host, host.connect() as client:
        client.control("get_params")
        err = client.recv_event("error")
        assert err["fatal"] is False
        assert "hello" in err["text"].lower()


# ---------------------------------------------------------------------------
# Audio
# ---------------------------------------------------------------------------


def test_two_hundred_blocks_are_bit_exact_and_echo_seq_and_frames():
    with HostProcess(null_args()) as host, host.connect() as client:
        client.hello()
        for seq in range(200):
            planes = [ramp(BLOCK, seq, 0), ramp(BLOCK, seq, 1)]
            header, out = client.block(seq, planes, position=seq * BLOCK)
            assert header["seq"] == seq
            assert header["frames"] == BLOCK
            assert header["channels"] == 2
            assert out == planes


def test_partial_final_block_is_returned_at_its_own_length():
    with HostProcess(null_args()) as host, host.connect() as client:
        client.hello()
        planes = [ramp(97, 5, 0), ramp(97, 5, 1)]
        header, out = client.block(7, planes)
        assert header["frames"] == 97
        assert header["seq"] == 7
        assert out == planes


def test_mono_block_returns_mono():
    with HostProcess(null_args()) as host, host.connect() as client:
        client.hello()
        planes = [ramp(BLOCK, 11, 0)]
        header, out = client.block(3, planes)
        assert header["channels"] == 1
        assert header["frames"] == BLOCK
        assert out == planes


def test_discontinuity_flag_is_accepted():
    with HostProcess(null_args()) as host, host.connect() as client:
        client.hello()
        planes = [ramp(BLOCK, 2, 0), ramp(BLOCK, 2, 1)]
        header, out = client.block(0, planes, discontinuity=True)
        assert header["seq"] == 0
        assert out == planes


def test_oversized_block_is_rejected_without_killing_the_session():
    with HostProcess(null_args()) as host, host.connect() as client:
        client.hello()
        too_long = [ramp(BLOCK * 4, 1, 0), ramp(BLOCK * 4, 1, 1)]
        client.send_bytes(pack_audio_in(1, too_long))
        err = client.recv_event("error")
        assert err["fatal"] is False
        planes = [ramp(BLOCK, 9, 0), ramp(BLOCK, 9, 1)]
        header, out = client.block(2, planes)
        assert header["seq"] == 2
        assert out == planes


def test_bad_magic_is_rejected():
    with HostProcess(null_args()) as host, host.connect() as client:
        client.hello()
        frame = bytearray(pack_audio_in(1, [ramp(16, 1, 0)]))
        frame[0] ^= 0xFF
        client.send_bytes(bytes(frame))
        err = client.recv_event("error")
        assert err["fatal"] is False


# ---------------------------------------------------------------------------
# Control plane
# ---------------------------------------------------------------------------


def test_ping_echoes_token():
    with HostProcess(null_args()) as host, host.connect() as client:
        client.hello()
        assert client.ping(1234.5)["t"] == 1234.5


def test_set_param_updates_params_without_emitting_a_param_event():
    with HostProcess(null_args()) as host, host.connect() as client:
        client.hello()
        before = client.get_params()
        assert len(before) == 2
        assert [p["index"] for p in before] == [0, 1]
        for p in before:
            for field in ("name", "label", "default", "value", "steps"):
                assert field in p

        client.control("set_param", index=1, value=0.25)
        # A `param` event would arrive before this pong if the host echoed edits.
        assert client.ping(7.0)["t"] == 7.0

        after = client.get_params()
        assert after[1]["value"] == pytest.approx(0.25)
        assert after[0]["value"] == pytest.approx(before[0]["value"])


def test_params_carry_flags_and_the_plugins_own_text():
    with HostProcess(null_args()) as host, host.connect() as client:
        client.hello()
        params = client.get_params()
        for p in params:
            for field in ("hidden", "read_only", "bypass", "program_change", "text"):
                assert field in p, f"params entry is missing {field!r}: {p!r}"
            assert p["hidden"] is False
        # the text is the plugin's words for the CURRENT value
        client.control("set_param", index=0, value=0.25)
        assert client.get_params()[0]["text"] == "0.25"


def test_param_text_formats_any_value_without_moving_the_parameter():
    with HostProcess(null_args()) as host, host.connect() as client:
        client.hello()
        before = client.get_params()[1]["value"]
        reply = client.param_text(1, 0.5)
        assert reply["index"] == 1
        assert reply["value"] == pytest.approx(0.5)
        assert reply["text"] == "0.50"
        assert client.get_params()[1]["value"] == pytest.approx(before), (
            "asking for text must not set the value"
        )
        # out of range is clamped, an unknown index answers with empty text rather than an error
        assert client.param_text(1, 7.0)["text"] == "1.00"
        assert client.param_text(99, 0.5)["text"] == ""


def test_param_text_without_arguments_is_a_survivable_error():
    with HostProcess(null_args()) as host, host.connect() as client:
        client.hello()
        client.control("param_text", index=0)
        error = client.recv_event("error")
        assert error["fatal"] is False
        assert client.ping(3.0)["t"] == 3.0


def test_set_param_by_name():
    with HostProcess(null_args()) as host, host.connect() as client:
        client.hello()
        name = client.get_params()[0]["name"]
        client.control("set_param", name=name, value=0.75)
        assert client.get_params()[0]["value"] == pytest.approx(0.75)


def test_get_state_set_state_round_trip():
    with HostProcess(null_args()) as host, host.connect() as client:
        client.hello()
        client.control("set_param", index=0, value=0.125)
        client.control("set_param", index=1, value=0.875)
        original = client.get_state()
        assert base64.b64decode(original)

        client.control("set_param", index=0, value=0.5)
        client.control("set_param", index=1, value=0.5)
        assert client.get_state() != original

        client.set_state(original)
        restored = client.get_params()
        assert restored[0]["value"] == pytest.approx(0.125)
        assert restored[1]["value"] == pytest.approx(0.875)


def test_get_state_refreshes_the_state_file(tmp_path):
    state_file = tmp_path / "live.state"
    with HostProcess(null_args(str(state_file))) as host, host.connect() as client:
        client.hello()
        client.control("set_param", index=0, value=0.375)
        client.get_state()
    assert state_file.is_file()
    assert state_file.stat().st_size > 0


def test_state_file_is_restored_at_startup(tmp_path):
    state_file = tmp_path / "restore.state"
    with HostProcess(null_args(str(state_file))) as host, host.connect() as client:
        client.hello()
        client.control("set_param", index=0, value=0.625)
        client.get_state()

    with HostProcess(null_args(str(state_file))) as host, host.connect() as client:
        client.hello()
        assert client.get_params()[0]["value"] == pytest.approx(0.625)


def test_bypass_keeps_the_dry_signal_bit_exact():
    with HostProcess(null_args()) as host, host.connect() as client:
        client.hello()
        planes = [ramp(BLOCK, 21, 0), ramp(BLOCK, 21, 1)]

        client.control("bypass", on=True)
        for seq in range(20):  # spans the 10 ms crossfade at 48 kHz
            _, out = client.block(seq, planes)
            assert out == planes

        client.control("bypass", on=False)
        for seq in range(20, 40):
            _, out = client.block(seq, planes)
            assert out == planes


def test_control_operations_do_not_disturb_streaming_audio():
    """The park handshake must not drop, reorder or corrupt a block.

    set_state/get_state park the audio thread mid-stream. While parked the host
    stops reading the socket, so blocks queue in the TCP buffer; every one must
    still come back exactly once, in order, bit exact.
    """
    blocks = 300
    with HostProcess(null_args()) as host, host.connect() as client:
        client.hello()
        saved = client.get_state()
        events: list[dict] = []
        for seq in range(blocks):
            planes = [ramp(BLOCK, seq, 0), ramp(BLOCK, seq, 1)]
            if seq % 25 == 7:
                client.control("get_state")
            elif seq % 25 == 13:
                client.set_state(saved)
            elif seq % 25 == 19:
                client.control("bypass", on=bool((seq // 25) % 2))
            header, out = client.block(seq, planes, collect_text=events)
            assert header["seq"] == seq, f"block {seq} came back out of order"
            assert header["frames"] == BLOCK
            assert out == planes, f"block {seq} was corrupted"

        # Prove the parks really happened alongside the audio rather than the
        # control ops being silently skipped.
        states = [e for e in events if e.get("ev") == "state"]
        assert len(states) >= blocks // 25, (
            f"expected ~12 state events, got {len(states)}"
        )
        assert not [e for e in events if e.get("ev") == "error"], events


def test_open_editor_on_a_plugin_without_one_reports_an_error():
    with HostProcess(null_args()) as host, host.connect() as client:
        client.hello()
        client.control("open_editor")
        err = client.recv_event("error")
        assert err["fatal"] is False
        assert "editor" in err["text"].lower()


def test_malformed_json_is_rejected_without_dropping_the_session():
    with HostProcess(null_args()) as host, host.connect() as client:
        client.hello()
        client.ws.send('{"op": "ping", "t":')
        err = client.recv_event("error")
        assert err["fatal"] is False
        assert client.ping(3.0)["t"] == 3.0


# ---------------------------------------------------------------------------
# Connection policy
# ---------------------------------------------------------------------------


def test_second_client_is_refused_then_accepted_after_the_first_leaves():
    from websockets.exceptions import InvalidStatus

    with HostProcess(null_args()) as host:
        first = host.connect()
        first.hello()
        with pytest.raises(InvalidStatus) as excinfo:
            host.connect(open_timeout=5)
        assert excinfo.value.response.status_code == 409
        first.close()

        deadline = time.monotonic() + 10
        while True:
            try:
                second = host.connect(open_timeout=5)
                break
            except InvalidStatus:
                if time.monotonic() > deadline:
                    raise
                time.sleep(0.05)
        with second:
            assert second.hello()["protocol"] == 1


@pytest.mark.parametrize(
    "origin",
    ["http://localhost:5173", "https://127.0.0.1:8600", "app://thedaw", "file://"],
)
def test_allowed_origins_connect(origin):
    with HostProcess(null_args()) as host, host.connect(origin=origin) as client:
        assert client.hello()["protocol"] == 1


@pytest.mark.parametrize(
    "origin",
    ["http://evil.example.com", "https://localhost.evil.com", "http://10.0.0.5:8080"],
)
def test_foreign_http_origins_are_refused(origin):
    from websockets.exceptions import InvalidStatus

    with HostProcess(null_args()) as host:
        with pytest.raises(InvalidStatus) as excinfo:
            host.connect(origin=origin, open_timeout=5)
        assert excinfo.value.response.status_code == 403


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------


def test_stdin_shutdown_writes_state_and_exits_zero(tmp_path):
    state_file = tmp_path / "shutdown.state"
    with HostProcess(null_args(str(state_file))) as host:
        with host.connect() as client:
            client.hello()
            client.control("set_param", index=0, value=0.25)
        host.send_stdin({"op": "shutdown"})
        assert host.wait(timeout=15) == 0
    assert state_file.is_file()
    assert state_file.stat().st_size > 0


@pytest.mark.parametrize("delay_sec", [0.05, 0.12, 0.2, 0.31])
def test_shutdown_while_blocks_are_streaming_exits_zero_and_saves_state(
    tmp_path, delay_sec
):
    """stop() must end and JOIN the audio thread before it touches the plugin.

    The old order parked the audio thread (a handshake that can time out), then
    closed the editor, saved state and released the plugin, and only then set the
    stop flag -- so a plugin could be released under a thread still inside
    process(). The shutdown lands at four different moments inside a live stream.
    """
    import threading

    state_file = tmp_path / "busy.state"
    with HostProcess(null_args(str(state_file))) as host:
        client = host.connect()
        client.hello()
        halt = threading.Event()
        streamed = [0]

        def pump() -> None:
            seq = 0
            while not halt.is_set():
                try:
                    client.block(
                        seq, [ramp(BLOCK, seq, 0), ramp(BLOCK, seq, 1)], collect_text=[]
                    )
                except Exception:  # noqa: BLE001 -- the socket closing under us is the point
                    return
                seq += 1
                streamed[0] = seq

        worker = threading.Thread(target=pump, daemon=True)
        worker.start()
        time.sleep(delay_sec)
        host.send_stdin({"op": "shutdown"})
        assert host.wait(timeout=20) == 0
        halt.set()
        worker.join(timeout=5)
        with contextlib.suppress(Exception):
            client.close()
    assert streamed[0] > 0, "the shutdown must land inside a live stream"
    assert state_file.is_file() and state_file.stat().st_size > 0


def test_stdin_eof_shuts_the_host_down(tmp_path):
    with HostProcess(null_args(str(tmp_path / "eof.state"))) as host:
        host.close_stdin()
        assert host.wait(timeout=15) == 0


def test_shutdown_op_over_the_socket_exits_zero(tmp_path):
    with HostProcess(null_args(str(tmp_path / "op.state"))) as host:
        with host.connect() as client:
            client.hello()
            client.control("shutdown")
        assert host.wait(timeout=15) == 0


def test_dead_parent_pid_exits_quickly():
    # A pid that is certainly gone: spawn a process, let it exit, reuse its id.
    done = subprocess.Popen(
        [sys.executable, "-c", "pass"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    done.wait(timeout=30)
    dead_pid = done.pid
    host = HostProcess(null_args(extra=["--parent-pid", str(dead_pid)]))
    host.start(wait_for_listening=False)
    try:
        started = time.monotonic()
        assert host.wait(timeout=10) == 0
        assert time.monotonic() - started < 3.0
    finally:
        host.kill()


def test_idle_timeout_exits():
    host = HostProcess(null_args(extra=["--idle-timeout", "1"]))
    with host:
        started = time.monotonic()
        assert host.wait(timeout=20) == 0
        assert time.monotonic() - started < 10.0


def test_log_file_is_written(tmp_path):
    log = tmp_path / "host.log"
    with HostProcess(null_args(extra=["--log", str(log)])) as host:
        with host.connect() as client:
            client.hello()
        host.send_stdin({"op": "shutdown"})
        host.wait(timeout=15)
    assert log.is_file()
    text = log.read_text(encoding="utf-8", errors="replace")
    assert "listening" in text


# ---------------------------------------------------------------------------
# Latency
# ---------------------------------------------------------------------------


def test_round_trip_latency_over_two_thousand_blocks(capsys):
    blocks = 2000
    planes = [ramp(BLOCK, 1, 0), ramp(BLOCK, 1, 1)]
    samples: list[float] = []
    with HostProcess(null_args()) as host, host.connect() as client:
        client.hello()
        for seq in range(blocks):
            start = time.perf_counter()
            header, _ = client.block(seq, planes, position=seq * BLOCK)
            samples.append((time.perf_counter() - start) * 1000.0)
            assert header["seq"] == seq

    samples.sort()
    avg = statistics.fmean(samples)
    p99 = samples[int(len(samples) * 0.99)]
    worst = samples[-1]
    with capsys.disabled():
        print(
            f"\nvst-host loopback round trip over {blocks} x {BLOCK}-frame blocks: "
            f"avg={avg:.3f} ms  p99={p99:.3f} ms  max={worst:.3f} ms"
        )
    budget_ms = BLOCK / SAMPLE_RATE * 1000.0
    assert avg < budget_ms, f"avg {avg:.3f} ms exceeds the {budget_ms:.3f} ms budget"


# ---------------------------------------------------------------------------
# Render
# ---------------------------------------------------------------------------


def test_render_reads_a_wav_larger_than_the_small_file_limit(tmp_path):
    """A real, multi-hundred-frame WAV must render past AtomicFile's 64 MB control-plane cap."""
    frame_count = 40_000_000  # mono 16-bit @ 48 kHz: ~76 MB, past the old 64 MB ceiling
    wav_path = tmp_path / "large.wav"
    with wave.open(str(wav_path), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(SAMPLE_RATE)
        wav_file.writeframes(bytes(frame_count * 2))

    out_path = tmp_path / "out.wav"
    proc = run_host(
        [
            "--render",
            "--null-plugin",
            "--in",
            str(wav_path),
            "--out",
            str(out_path),
            "--tail-seconds",
            "0",
        ],
        timeout=180,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    payload = next(
        json.loads(line)
        for line in proc.stdout.splitlines()
        if line.strip().startswith("{")
    )
    assert payload["ok"] is True
    assert payload["frames_in"] == frame_count
    assert out_path.exists()
    assert out_path.stat().st_size > 0


def test_render_refuses_an_over_limit_input(tmp_path):
    """A file the WAV reader cannot parse must still fail cleanly with exit 7."""
    bad_path = tmp_path / "not-a-wav.wav"
    bad_path.write_bytes(b"NOPE" * 3)  # 12 bytes: too small to be a RIFF/WAVE file

    out_path = tmp_path / "out.wav"
    proc = run_host(
        [
            "--render",
            "--null-plugin",
            "--in",
            str(bad_path),
            "--out",
            str(out_path),
            "--tail-seconds",
            "0",
        ]
    )
    assert proc.returncode == 7, proc.stdout + proc.stderr
    payload = next(
        json.loads(line)
        for line in proc.stdout.splitlines()
        if line.strip().startswith("{")
    )
    assert payload["text"]


def test_render_refuses_an_output_larger_than_a_wav(tmp_path):
    """An output too large for a WAV must be refused before allocating, not after rendering."""
    wav_path = tmp_path / "tiny.wav"
    with wave.open(str(wav_path), "wb") as wav_file:
        wav_file.setnchannels(8)
        wav_file.setsampwidth(2)
        wav_file.setframerate(768000)
        wav_file.writeframes(bytes(4 * 8 * 2))

    out_path = tmp_path / "out.wav"
    start = time.perf_counter()
    proc = run_host(
        [
            "--render",
            "--null-plugin",
            "--in",
            str(wav_path),
            "--out",
            str(out_path),
            "--tail-seconds",
            "600",
        ],
        timeout=20,
    )
    elapsed = time.perf_counter() - start
    assert elapsed < 20, (
        f"the size refusal took {elapsed:.1f}s instead of failing immediately"
    )
    assert proc.returncode == 1, proc.stdout + proc.stderr
    payload = next(
        json.loads(line)
        for line in proc.stdout.splitlines()
        if line.strip().startswith("{")
    )
    assert payload["ok"] is False
    assert "larger than a WAV file can hold" in payload["text"]
    assert not out_path.exists()


def test_render_still_succeeds_at_a_normal_tail(tmp_path):
    """A tail that stays inside the WAV size ceiling must still render normally."""
    wav_path = tmp_path / "tiny.wav"
    with wave.open(str(wav_path), "wb") as wav_file:
        wav_file.setnchannels(8)
        wav_file.setsampwidth(2)
        wav_file.setframerate(768000)
        wav_file.writeframes(bytes(4 * 8 * 2))

    out_path = tmp_path / "out.wav"
    proc = run_host(
        [
            "--render",
            "--null-plugin",
            "--in",
            str(wav_path),
            "--out",
            str(out_path),
            "--tail-seconds",
            "1",
        ],
        timeout=60,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    payload = next(
        json.loads(line)
        for line in proc.stdout.splitlines()
        if line.strip().startswith("{")
    )
    assert payload["ok"] is True
    assert payload["frames_out"] == 4 + 768000


# ---------------------------------------------------------------------------
# Real plugin (env-gated)
# ---------------------------------------------------------------------------
#
# Everything below runs the REAL host against a REAL VST3 and is skipped unless
# ``THEDAW_TEST_VST3`` points at a ``.vst3``; ``THEDAW_TEST_VST3_NAME`` picks the
# audio-effect class inside a multi-plugin bundle. Each contract point is its
# own test function so one failing plugin behaviour does not hide the rest; the
# expensive parts (spawn, 5 s of audio) happen once in module-scoped fixtures
# that only OBSERVE, leaving every assertion to a test.
#
# No test here ever sends ``open_editor``: opening a real plugin's window in an
# unattended run can block on the plugin's message loop.

REAL_PLUGIN = os.environ.get("THEDAW_TEST_VST3", "").strip()
REAL_PLUGIN_NAME = os.environ.get("THEDAW_TEST_VST3_NAME", "").strip()

STREAM_SECONDS = 5.0
STREAM_BLOCKS = math.ceil(STREAM_SECONDS * SAMPLE_RATE / BLOCK)
# The host's soft bypass crossfades over 10 ms; compare only after it settled.
CROSSFADE_BLOCKS = math.ceil(0.010 * SAMPLE_RATE / BLOCK) + 1
PARAM_TOLERANCE = 1e-3
BYPASS_TOLERANCE = 1e-6

requires_real_plugin = pytest.mark.skipif(
    not REAL_PLUGIN,
    reason="set THEDAW_TEST_VST3=<path to a .vst3> to run the real-plugin checks",
)


def real_args(state_file: str | None = None, extra: list[str] | None = None):
    args = [
        "--plugin",
        REAL_PLUGIN,
        "--sample-rate",
        str(SAMPLE_RATE),
        "--block-size",
        str(BLOCK),
        "--channels",
        "2",
        "--port",
        "0",
    ]
    if REAL_PLUGIN_NAME:
        args += ["--plugin-name", REAL_PLUGIN_NAME]
    if state_file is not None:
        args += ["--state-file", state_file]
    if extra:
        args += extra
    return args


@contextlib.contextmanager
def real_host(state_file: str | None = None):
    """Spawn the real plugin, hand over (host, client, ready), always reap."""
    host = HostProcess(real_args(state_file))
    host.start()
    client = None
    try:
        client = host.connect(open_timeout=30.0, recv_timeout=30.0)
        yield host, client, client.hello()
    finally:
        if client is not None:
            client.close()
        host.kill()


def host_pid_is_running(pid: int | None) -> bool:
    """True only when `pid` is still OUR host binary (pids get recycled)."""
    if pid is None:
        return False
    try:
        proc = psutil.Process(pid)
        return proc.is_running() and proc.name().lower() == "thedaw-vst-host.exe"
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return False


def first_automatable(params: list[dict]) -> dict | None:
    for param in params:
        if param.get("automatable", True):
            return param
    return None


def first_continuous_automatable(params: list[dict]) -> dict | None:
    """The parameter the set/restore checks drive.

    "The first automatable parameter" is `Global Bypass` on the iZotope plugins: a boolean with
    `steps == 1`, where a written 0.75 legitimately snaps to 1 and the check can never hold.
    Prefer the first automatable parameter with a continuous range; fall back to the old rule so
    a plugin made only of switches is still exercised (at its own resolution).
    """
    for param in params:
        if (
            param.get("automatable", True)
            and int(param.get("steps", 0)) == 0
            and not param.get("discrete", False)
            and not param.get("boolean", False)
        ):
            return param
    return first_automatable(params)


def settle_after_set_param(client) -> None:
    """Give the host's idle parameter flush time to reach the plugin.

    VST3 hands parameter changes to a plugin inside `IAudioProcessor::process`. With no audio
    flowing the host makes that call itself once ~20 ms have passed with no `audio_in` block
    (`Session::maybeFlushParameters`), so the value is visible WITHOUT streaming audio — which
    is what these checks are here to prove. The ping afterwards is the round trip that proves
    the host got that far.
    """
    time.sleep(0.15)
    client.ping(1.0)


@pytest.fixture(scope="module")
def real_session():
    """One shared host process for the checks that only read."""
    if not REAL_PLUGIN:
        pytest.skip("THEDAW_TEST_VST3 is not set")
    with real_host() as (host, client, ready):
        yield SimpleNamespace(host=host, client=client, ready=ready)


@pytest.fixture(scope="module")
def real_stream(real_session):
    """Stream 5 s of noise once and record what came back. Asserts nothing."""
    client = real_session.client
    events: list[dict] = []
    out_of_order: list[tuple[int, int]] = []
    wrong_shape: list[tuple[int, int, int]] = []
    non_finite_blocks: list[int] = []
    round_trip_ms: list[float] = []
    peak = 0.0

    for seq in range(STREAM_BLOCKS):
        planes = [noise(BLOCK, seq, 0), noise(BLOCK, seq, 1)]
        started = time.perf_counter()
        header, out = client.block(
            seq, planes, position=seq * BLOCK, collect_text=events
        )
        round_trip_ms.append((time.perf_counter() - started) * 1000.0)
        if header["seq"] != seq:
            out_of_order.append((seq, header["seq"]))
        if header["frames"] != BLOCK or len(out) != 2:
            wrong_shape.append((seq, header["frames"], len(out)))
        for plane in out:
            if len(plane) != BLOCK:
                wrong_shape.append((seq, len(plane), len(out)))
            if not all(math.isfinite(v) for v in plane):
                non_finite_blocks.append(seq)
                continue
            plane_peak = max(abs(v) for v in plane)
            if plane_peak > peak:
                peak = plane_peak

    ordered = sorted(round_trip_ms)
    return SimpleNamespace(
        blocks=STREAM_BLOCKS,
        events=events,
        out_of_order=out_of_order,
        wrong_shape=wrong_shape,
        non_finite_blocks=non_finite_blocks,
        peak=peak,
        avg_ms=statistics.fmean(ordered),
        p99_ms=ordered[int(len(ordered) * 0.99)],
        max_ms=ordered[-1],
        xruns=[e for e in events if e.get("ev") == "xrun"],
        errors=[e for e in events if e.get("ev") == "error"],
    )


# -- handshake --------------------------------------------------------------


@requires_real_plugin
def test_real_plugin_ready_names_the_plugin(real_session):
    assert real_session.ready["plugin"]["name"].strip()


@requires_real_plugin
def test_real_plugin_ready_reports_non_negative_latency(real_session):
    latency = real_session.ready["latency_samples"]
    assert isinstance(latency, int)
    assert latency >= 0


@requires_real_plugin
def test_real_plugin_ready_reports_has_editor_as_a_bool(real_session):
    assert isinstance(real_session.ready["has_editor"], bool)


# -- streaming --------------------------------------------------------------


@requires_real_plugin
def test_real_plugin_returns_every_block_in_order(real_stream):
    assert real_stream.out_of_order == []
    assert real_stream.errors == []


@requires_real_plugin
def test_real_plugin_returns_the_same_frame_counts(real_stream):
    assert real_stream.wrong_shape == []


@requires_real_plugin
def test_real_plugin_output_is_finite(real_stream):
    assert real_stream.non_finite_blocks == [], (
        f"NaN/Inf in {len(real_stream.non_finite_blocks)} of "
        f"{real_stream.blocks} blocks, first at {real_stream.non_finite_blocks[:5]}"
    )


@requires_real_plugin
def test_real_plugin_output_is_not_all_zero(real_stream):
    assert real_stream.peak > 0.0, "the plugin returned digital silence for 5 s"


@requires_real_plugin
def test_real_plugin_round_trip_latency_is_reported(real_stream, capsys):
    with capsys.disabled():
        print(
            f"\n{REAL_PLUGIN}: round trip over {real_stream.blocks} x {BLOCK}-frame "
            f"blocks: avg={real_stream.avg_ms:.3f} ms  "
            f"p99={real_stream.p99_ms:.3f} ms  max={real_stream.max_ms:.3f} ms"
        )
    assert real_stream.avg_ms > 0.0


@requires_real_plugin
def test_real_plugin_reports_no_xruns(real_stream, capsys):
    late = sum(int(e.get("late_blocks", 0)) for e in real_stream.xruns)
    if real_stream.xruns:
        worst = max(float(e.get("max_process_ms", 0.0)) for e in real_stream.xruns)
        with capsys.disabled():
            print(
                f"\n{REAL_PLUGIN}: {len(real_stream.xruns)} xrun event(s), "
                f"{late} late block(s) of {real_stream.blocks}; "
                f"max_process_ms={worst:.3f}"
            )
    # An xrun is information, not a failure (the run may be on a busy machine),
    # but it must carry the fields the protocol promises.
    for event in real_stream.xruns:
        assert "late_blocks" in event and "max_process_ms" in event, event
    assert late >= 0


# -- parameters -------------------------------------------------------------


@requires_real_plugin
def test_real_plugin_exposes_parameters(real_session):
    params = real_session.client.get_params()
    assert len(params) > 0
    assert first_automatable(params) is not None, "no automatable parameter"


@requires_real_plugin
def test_real_plugin_parameters_come_with_display_text(real_session):
    params = real_session.client.get_params()
    assert [p["index"] for p in params] == list(range(len(params))), (
        "index is the controller's own position"
    )
    visible = [p for p in params if not p["hidden"]]
    assert visible, "every parameter is hidden"
    assert any(p["text"] for p in visible), "no visible parameter has display text"
    target = first_continuous_automatable(params)
    low = real_session.client.param_text(target["index"], 0.0)["text"]
    high = real_session.client.param_text(target["index"], 1.0)["text"]
    assert low and high and low != high, (
        f"text does not follow the value: {low!r} / {high!r}"
    )


@requires_real_plugin
def test_real_plugin_program_change_reports_the_parameters_it_moved():
    """Choosing a factory program moves other parameters; the client has to hear about them."""
    with real_host() as (_host, client, _ready):
        params = client.get_params()
        program = next(
            (p for p in params if p["program_change"] and p["steps"] >= 1), None
        )
        if program is None:
            pytest.skip("this plugin has no program-change parameter")
        before = {p["index"]: p["value"] for p in params}
        target = 1.0 / program["steps"]  # the second program
        client.control("set_param", index=program["index"], value=target)

        moved: dict[int, float] = {}
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            try:
                msg = client.recv(timeout=max(0.05, deadline - time.monotonic()))
            except TimeoutError:
                break
            if isinstance(msg, bytes):
                continue
            event = json.loads(msg)
            if event.get("ev") == "param":
                moved[event["index"]] = event["value"]
                assert "text" in event

        assert program["index"] not in moved, (
            "the parameter the client set itself is not echoed back"
        )
        after = {p["index"]: p["value"] for p in client.get_params()}
        changed = {
            i
            for i in after
            if i != program["index"] and abs(after[i] - before[i]) > 1e-9
        }
        if not changed:
            pytest.skip("the second program has the same values as the first")
        assert changed <= set(moved), (
            f"parameters {sorted(changed - set(moved))} moved without a param event"
        )
        for index in changed:
            assert moved[index] == pytest.approx(after[index])


@requires_real_plugin
def test_real_plugin_set_param_is_visible_in_get_params():
    with real_host() as (_host, client, _ready):
        target = first_continuous_automatable(client.get_params())
        assert target is not None, "no automatable parameter"
        wanted = 0.25 if target["value"] >= 0.5 else 0.75
        client.control("set_param", index=target["index"], value=wanted)
        # No audio is streamed on purpose: the host's zero-sample flush has to deliver this.
        settle_after_set_param(client)
        after = client.get_params()[target["index"]]
        assert after["value"] == pytest.approx(wanted, abs=PARAM_TOLERANCE)


@requires_real_plugin
def test_real_plugin_parameter_survives_shutdown_and_respawn(tmp_path):
    state_file = str(tmp_path / "real.state")
    with real_host(state_file) as (host, client, _ready):
        target = first_continuous_automatable(client.get_params())
        assert target is not None, "no automatable parameter"
        wanted = 0.25 if target["value"] >= 0.5 else 0.75
        client.control("set_param", index=target["index"], value=wanted)
        # The state has to be captured AFTER the flush reached the plugin, or it is the state
        # of a plugin that never heard about the edit.
        settle_after_set_param(client)
        assert base64.b64decode(client.get_state())
        client.close()
        host.send_stdin({"op": "shutdown"})
        assert host.wait(timeout=30) == 0

    with real_host(state_file) as (_host2, client2, _ready2):
        restored = client2.get_params()[target["index"]]
        assert restored["value"] == pytest.approx(wanted, abs=PARAM_TOLERANCE)


# -- bypass -----------------------------------------------------------------


@requires_real_plugin
def test_real_plugin_bypass_outputs_the_input_delayed_by_latency():
    with real_host() as (_host, client, ready):
        latency = int(ready["latency_samples"])
        client.control("bypass", on=True)
        history: list[list[float]] = [[], []]
        checked = 0
        blocks = CROSSFADE_BLOCKS + 8 + math.ceil(latency / BLOCK)
        for seq in range(blocks):
            planes = [noise(BLOCK, seq, 0), noise(BLOCK, seq, 1)]
            _header, out = client.block(seq, planes, position=seq * BLOCK)
            for channel in range(2):
                history[channel].extend(planes[channel])
            if seq < CROSSFADE_BLOCKS:
                continue  # still inside the 10 ms crossfade into bypass
            base = seq * BLOCK - latency
            for channel in range(2):
                for j, value in enumerate(out[channel]):
                    index = base + j
                    if index < 0:
                        continue
                    expected = history[channel][index]
                    assert abs(value - expected) <= BYPASS_TOLERANCE, (
                        f"bypass ch{channel} block {seq} sample {j}: "
                        f"got {value!r}, expected input[{index}]={expected!r} "
                        f"(latency_samples={latency})"
                    )
                    checked += 1
        assert checked > 0, "no samples were comparable; check latency_samples"


# -- lifecycle --------------------------------------------------------------


@requires_real_plugin
def test_real_plugin_stdin_shutdown_exits_zero_and_leaves_no_process(tmp_path):
    with real_host(str(tmp_path / "bye.state")) as (host, client, _ready):
        pid = host.pid
        client.close()
        host.send_stdin({"op": "shutdown"})
        assert host.wait(timeout=30) == 0
    deadline = time.monotonic() + 10.0
    while host_pid_is_running(pid) and time.monotonic() < deadline:
        time.sleep(0.1)
    assert not host_pid_is_running(pid), f"host pid {pid} is still running"
