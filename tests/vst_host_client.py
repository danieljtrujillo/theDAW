"""Test client for the native live VST host (``thedaw-vst-host.exe``).

Speaks the wire protocol from ``docs/design/vst-live-protocol.md``: binary audio
frames and JSON control messages over a loopback WebSocket, plus the process
lifecycle (spawn, read the ``listening`` line, stdin shutdown).

Used by ``tests/test_vst_host_native.py``; kept free of pytest imports so it can
also be driven from a REPL when poking at a real plugin.
"""

from __future__ import annotations

import json
import os
import queue
import random
import struct
import subprocess
import sys
import threading
import time
from array import array
from pathlib import Path
from typing import Any

from websockets.sync.client import connect as ws_connect

# ---------------------------------------------------------------------------
# Wire format
# ---------------------------------------------------------------------------

MAGIC = 0x4C545356  # "VSTL"
TYPE_AUDIO_IN = 0
TYPE_AUDIO_OUT = 1

FLAG_PLAYING = 1 << 0
FLAG_DISCONTINUITY = 1 << 1

PROTOCOL = 1

# magic u32 | type u8 | channels u8 | flags u16 | seq u32 | frames u32
# | position f64 | tempo f64  -> 32 bytes, little-endian, packed
_HEADER = struct.Struct("<IBBHIIdd")
HEADER_SIZE = _HEADER.size

_MAX_MESSAGE_BYTES = 16 * 1024 * 1024


def _f32_bytes(values: list[float]) -> bytes:
    buf = array("f", values)
    if sys.byteorder != "little":  # pragma: no cover - x86/arm64 are LE
        buf.byteswap()
    return buf.tobytes()


def _f32_list(raw: bytes) -> list[float]:
    buf = array("f")
    buf.frombytes(raw)
    if sys.byteorder != "little":  # pragma: no cover - x86/arm64 are LE
        buf.byteswap()
    return list(buf)


def pack_audio_in(
    seq: int,
    channels: list[list[float]],
    *,
    playing: bool = True,
    discontinuity: bool = False,
    position: float = 0.0,
    tempo: float = 0.0,
) -> bytes:
    """Build one ``audio_in`` binary message from planar float channels."""
    if not channels:
        raise ValueError("at least one channel is required")
    frames = len(channels[0])
    if any(len(c) != frames for c in channels):
        raise ValueError("all channels must have the same frame count")
    flags = (FLAG_PLAYING if playing else 0) | (
        FLAG_DISCONTINUITY if discontinuity else 0
    )
    head = _HEADER.pack(
        MAGIC, TYPE_AUDIO_IN, len(channels), flags, seq, frames, position, tempo
    )
    body = b"".join(_f32_bytes(c) for c in channels)
    return head + body


def unpack_audio_out(data: bytes) -> tuple[dict[str, Any], list[list[float]]]:
    """Split an ``audio_out`` binary message into its header and channels."""
    if len(data) < HEADER_SIZE:
        raise ValueError(f"short audio frame: {len(data)} bytes")
    magic, ftype, channels, flags, seq, frames, position, tempo = _HEADER.unpack_from(
        data, 0
    )
    if magic != MAGIC:
        raise ValueError(f"bad magic 0x{magic:08X}")
    if ftype != TYPE_AUDIO_OUT:
        raise ValueError(f"expected audio_out, got type {ftype}")
    expected = HEADER_SIZE + channels * frames * 4
    if len(data) != expected:
        raise ValueError(f"expected {expected} bytes, got {len(data)}")
    planes: list[list[float]] = []
    off = HEADER_SIZE
    step = frames * 4
    for _ in range(channels):
        planes.append(_f32_list(data[off : off + step]))
        off += step
    header = {
        "type": ftype,
        "channels": channels,
        "flags": flags,
        "seq": seq,
        "frames": frames,
        "position": position,
        "tempo": tempo,
    }
    return header, planes


# ---------------------------------------------------------------------------
# Locating the binary
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_EXE = REPO_ROOT / "native" / "vst-host" / "bin" / "thedaw-vst-host.exe"


def host_exe() -> Path | None:
    """Return the host binary path, or None when it has not been built."""
    env = os.environ.get("THEDAW_VST_HOST")
    candidate = Path(env) if env else DEFAULT_EXE
    return candidate if candidate.is_file() else None


def run_host(args: list[str], timeout: float = 30.0) -> subprocess.CompletedProcess:
    """Run the host binary to completion (for ``--selftest``/``--list``/...)."""
    exe = host_exe()
    if exe is None:
        raise RuntimeError("host binary not built")
    return subprocess.run(
        [str(exe), *args],
        capture_output=True,
        text=True,
        timeout=timeout,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )


def host_has_vst3() -> bool:
    """True when the binary was compiled with the VST3 layer linked in."""
    proc = run_host(["--version"])
    for line in proc.stdout.splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                return bool(json.loads(line).get("vst3"))
            except json.JSONDecodeError:
                continue
    raise RuntimeError(f"--version printed no JSON line: {proc.stdout!r}")


# ---------------------------------------------------------------------------
# Process lifecycle
# ---------------------------------------------------------------------------


# Events the host may send at any moment (protocol: docs/design/vst-live-protocol.md). A real
# plugin answers a parameter change with a `param` echo, reports latency changes and editor
# resizes on its own schedule — a reply waiter has to step over them.
UNSOLICITED = ("xrun", "warning", "param", "latency", "editor")


class HostProcess:
    """Spawns the host, reads its ``listening`` line, and always reaps it."""

    def __init__(self, args: list[str], *, ready_timeout: float = 30.0) -> None:
        exe = host_exe()
        if exe is None:
            raise RuntimeError("host binary not built")
        self.args = [str(exe), *args]
        self.ready_timeout = ready_timeout
        self.proc: subprocess.Popen[str] | None = None
        self.port: int | None = None
        self.pid: int | None = None
        self.stdout_lines: list[str] = []
        self.stderr_lines: list[str] = []
        self._stdout_q: queue.Queue[str | None] = queue.Queue()

    # -- lifecycle ---------------------------------------------------------
    def start(self, *, wait_for_listening: bool = True) -> HostProcess:
        self.proc = subprocess.Popen(
            self.args,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        threading.Thread(target=self._pump_stdout, daemon=True).start()
        threading.Thread(target=self._pump_stderr, daemon=True).start()
        if wait_for_listening:
            self._await_listening()
        return self

    def _pump_stdout(self) -> None:
        assert self.proc is not None and self.proc.stdout is not None
        for line in self.proc.stdout:
            self.stdout_lines.append(line.rstrip("\r\n"))
            self._stdout_q.put(line.rstrip("\r\n"))
        self._stdout_q.put(None)

    def _pump_stderr(self) -> None:
        assert self.proc is not None and self.proc.stderr is not None
        for line in self.proc.stderr:
            self.stderr_lines.append(line.rstrip("\r\n"))

    def _await_listening(self) -> None:
        deadline = time.monotonic() + self.ready_timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"no listening line; stderr={self.stderr_lines}")
            try:
                line = self._stdout_q.get(timeout=remaining)
            except queue.Empty:
                raise TimeoutError(
                    f"no listening line; stderr={self.stderr_lines}"
                ) from None
            if line is None:
                raise RuntimeError(
                    f"host exited before listening; rc={self.returncode()} "
                    f"stderr={self.stderr_lines}"
                )
            if not line.startswith("{"):
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if msg.get("ev") == "listening":
                self.port = int(msg["port"])
                self.pid = int(msg["pid"])
                return

    @property
    def url(self) -> str:
        if self.port is None:
            raise RuntimeError("host is not listening")
        return f"ws://127.0.0.1:{self.port}"

    def returncode(self) -> int | None:
        return None if self.proc is None else self.proc.poll()

    def send_stdin(self, obj: dict[str, Any]) -> None:
        assert self.proc is not None and self.proc.stdin is not None
        self.proc.stdin.write(json.dumps(obj) + "\n")
        self.proc.stdin.flush()

    def close_stdin(self) -> None:
        if self.proc is not None and self.proc.stdin is not None:
            self.proc.stdin.close()

    def wait(self, timeout: float = 10.0) -> int:
        assert self.proc is not None
        return self.proc.wait(timeout=timeout)

    def kill(self) -> None:
        if self.proc is None or self.proc.poll() is not None:
            return
        self.proc.kill()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:  # pragma: no cover - last resort
            pass

    def connect(self, **kwargs: Any) -> HostClient:
        return HostClient(self.url, **kwargs)

    def __enter__(self) -> HostProcess:
        return self.start()

    def __exit__(self, *exc: object) -> None:
        self.kill()
        if self.proc is not None:
            for stream in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
                if stream is not None:
                    try:
                        stream.close()
                    except OSError:  # pragma: no cover - already closed
                        pass


# ---------------------------------------------------------------------------
# WebSocket client
# ---------------------------------------------------------------------------


class HostClient:
    """One live connection to a host process."""

    def __init__(
        self,
        url: str,
        *,
        origin: str | None = None,
        open_timeout: float = 10.0,
        recv_timeout: float = 10.0,
    ) -> None:
        kwargs: dict[str, Any] = {
            "open_timeout": open_timeout,
            "max_size": _MAX_MESSAGE_BYTES,
            # The host advertises no extensions, so do not offer one.
            "compression": None,
        }
        if origin is not None:
            kwargs["origin"] = origin  # type: ignore[assignment]
        # websockets 17 wants the connection used as a context manager; this
        # class owns the lifetime instead, so enter it here and exit in close().
        self._connection = ws_connect(url, **kwargs)
        self.ws = self._connection.__enter__()
        self.recv_timeout = recv_timeout

    # -- raw ---------------------------------------------------------------
    def send_json(self, obj: dict[str, Any]) -> None:
        self.ws.send(json.dumps(obj))

    def send_bytes(self, payload: bytes) -> None:
        self.ws.send(payload)

    def recv(self, timeout: float | None = None) -> str | bytes:
        return self.ws.recv(timeout=self.recv_timeout if timeout is None else timeout)

    # -- typed -------------------------------------------------------------
    def recv_event(
        self, ev: str, timeout: float | None = None, *, allow: tuple[str, ...] = ()
    ) -> dict[str, Any]:
        """Wait for a text event named `ev`, skipping events listed in `allow`."""
        deadline = time.monotonic() + (
            self.recv_timeout if timeout is None else timeout
        )
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"timed out waiting for {ev!r}")
            msg = self.recv(timeout=remaining)
            if isinstance(msg, bytes):
                raise AssertionError(f"expected text {ev!r}, got {len(msg)} bytes")
            obj = json.loads(msg)
            if obj.get("ev") == ev:
                return obj
            if obj.get("ev") in allow:
                continue
            raise AssertionError(f"expected {ev!r}, got {obj!r}")

    def hello(self) -> dict[str, Any]:
        self.send_json({"op": "hello", "protocol": PROTOCOL})
        return self.recv_event("ready")

    def control(self, op: str, **fields: Any) -> None:
        self.send_json({"op": op, **fields})

    def ping(self, token: float) -> dict[str, Any]:
        self.control("ping", t=token)
        return self.recv_event("pong", allow=UNSOLICITED)

    def get_params(self) -> list[dict[str, Any]]:
        self.control("get_params")
        return self.recv_event("params", allow=UNSOLICITED)["list"]

    def param_text(self, index: int, value: float) -> dict[str, Any]:
        """The plugin's own display string for `value` of parameter `index`."""
        self.control("param_text", index=index, value=value)
        return self.recv_event("param_text", allow=UNSOLICITED)

    def get_state(self) -> str:
        self.control("get_state")
        return self.recv_event("state", allow=UNSOLICITED)["state_b64"]

    def set_state(self, state_b64: str) -> None:
        self.control("set_state", state_b64=state_b64)

    def block(
        self,
        seq: int,
        channels: list[list[float]],
        *,
        collect_text: list[dict[str, Any]] | None = None,
        **kwargs: Any,
    ) -> tuple[dict[str, Any], list[list[float]]]:
        """Send one block and wait for the matching ``audio_out``.

        Text events that arrive in between are skipped. Pass `collect_text` to
        capture them instead of rejecting the unexpected ones -- needed when
        control operations run while audio is streaming.
        """
        self.send_bytes(pack_audio_in(seq, channels, **kwargs))
        while True:
            msg = self.recv()
            if isinstance(msg, bytes):
                return unpack_audio_out(msg)
            obj = json.loads(msg)
            if collect_text is not None:
                collect_text.append(obj)
                continue
            if obj.get("ev") in ("xrun", "warning", "param", "latency"):
                continue
            raise AssertionError(f"unexpected text during audio: {obj!r}")

    def close(self) -> None:
        try:
            self._connection.__exit__(None, None, None)
        except Exception:  # pragma: no cover - socket already gone
            pass

    def __enter__(self) -> HostClient:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


# ---------------------------------------------------------------------------
# Signal helpers
# ---------------------------------------------------------------------------


def ramp(frames: int, seed: int, channel: int = 0) -> list[float]:
    """Deterministic, exactly representable float32 test signal."""
    base = (seed * 7919 + channel * 104729) % 4096
    return [((base + i) % 4096) / 4096.0 - 0.5 for i in range(frames)]


def noise(frames: int, seed: int, channel: int = 0) -> list[float]:
    """Deterministic broadband noise in [-0.5, 0.5), exact in float32.

    Real plugins need a signal with content across the spectrum (a ramp is
    nearly DC over one block), but the test still has to be reproducible and
    survive the float32 round trip unchanged, so the values are whole
    multiples of 1/4096 drawn from a seeded PRNG rather than raw floats.
    """
    rng = random.Random((seed * 1_000_003) ^ (channel * 7_919))
    return [rng.randrange(4096) / 4096.0 - 0.5 for _ in range(frames)]
