"""The Quest MIDI bridge leaves the headset with a program that already serves it.

A headset has one ``adb reverse`` mapping per port, so ``adb reverse tcp:8765
tcp:<ours>`` takes the headset from whatever program had it: the standalone
Node bridge that relays into loopMIDI, another theDAW, anything listening on
8765 here. The bridge used to run that on every start and re-attach. Now it
runs only while nobody else serves the headset's port, or after the user's
Take over, and status() names the program in the way.

Each test replays a real ordering against real sockets: the other program is a
separate process listening on a real port, so the bridge finds it the way it
finds one in the field (backend.ports.holders, or the bind probe where the
listening table hides it). Every test runs twice, once for each way such a
program listens: on 0.0.0.0, and on ``::`` dual-stack, which is what the
standalone Node bridge's ``server.listen(port)`` does on a machine with IPv6.
adb is a fake headset with the one reverse table every adb client on the PC
shares. A test "dials" the headset's port through that table and checks which
process the MIDI reached. No real adb runs, so a plugged-in headset is never
touched.
"""

from __future__ import annotations

import asyncio
import queue
import socket
import subprocess
import sys
import threading
from typing import Awaitable, Callable, Optional

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.modules.questmidi import bridge
from backend.modules.questmidi import router as questmidi_router

_PORT_ENV = (
    "theDAW_QUESTMIDI_PORT",
    "theDAW_QUESTMIDI_DEVICE_PORT",
    "theDAW_QUESTMIDI_HOST_PORT",
)
NOTE_ON = [0x90, 0x40, 0x7F]
FRAME = bytes([len(NOTE_ON), *NOTE_ON])


def _free_port() -> int:
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]
    finally:
        probe.close()


class FakeHeadset:
    """A USB headset as adb sees it: one reverse table shared by every adb
    client on the PC. Stands in for ``bridge._adb``."""

    def __init__(self) -> None:
        self.reverse: dict[int, int] = {}
        self.calls: list[tuple[str, ...]] = []
        self.plugged = True

    def adb(self, *args: str) -> Optional[str]:
        self.calls.append(args)
        if not self.plugged:
            return None  # "error: no devices/emulators found"
        if args == ("reverse", "--list"):
            return "".join(
                f"UsbFfs tcp:{device} tcp:{host}\n"
                for device, host in self.reverse.items()
            )
        if len(args) == 3 and args[0] == "reverse":
            self.reverse[int(args[1][4:])] = int(args[2][4:])
            return ""
        return None

    def midi_reversals(self, device_port: int) -> list[tuple[str, ...]]:
        """Every ``adb reverse`` this bridge ran for the headset's MIDI port."""
        want = f"tcp:{device_port}"
        return [c for c in self.calls if len(c) == 3 and c[1] == want]

    def unplug_and_replug(self) -> None:
        """adb drops every mapping when the cable is pulled."""
        self.reverse.clear()

    async def send_note(self, device_port: int) -> None:
        """The headset app sends one note-on to its own ``device_port``."""
        _reader, writer = await asyncio.open_connection(
            "127.0.0.1", self.reverse[device_port]
        )
        writer.write(FRAME)
        await writer.drain()
        await asyncio.sleep(0.2)
        writer.close()
        await writer.wait_closed()


_OTHER_BRIDGE = r"""
import os, socket, sys, threading
if sys.argv[2] == "dual-stack":
    # Node's server.listen(port): "::" with IPv4 mapped in.
    server = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
    server.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
    server.bind(("::", int(sys.argv[1])))
else:
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.bind(("0.0.0.0", int(sys.argv[1])))
server.listen()
print(server.getsockname()[1], os.getpid(), flush=True)

def serve():
    while True:
        conn, _peer = server.accept()
        data = conn.recv(64)
        print("got " + data.hex(), flush=True)
        conn.close()

threading.Thread(target=serve, daemon=True).start()
sys.stdin.read()  # exits when the test closes stdin
"""


def _has_dual_stack() -> bool:
    try:
        probe = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
    except OSError:
        return False
    try:
        probe.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        probe.bind(("::", 0))
        return True
    except OSError:
        return False
    finally:
        probe.close()


#: How another program listens: every test runs once per entry.
BINDS = [
    "ipv4",
    pytest.param(
        "dual-stack",
        # portability: needs a real IPv6 stack; the ipv4 case runs everywhere
        marks=pytest.mark.skipif(not _has_dual_stack(), reason="no IPv6 here"),
    ),
]


class OtherBridge:
    """Another program that serves the headset: a separate process listening
    on all interfaces, on 0.0.0.0 (``bind="ipv4"``) or on ``::`` dual-stack
    the way the standalone Node bridge does (``bind="dual-stack"``)."""

    def __init__(self, port: int = 0, *extra_args: str, bind: str = "ipv4") -> None:
        self.bind = bind
        self.proc = subprocess.Popen(
            [sys.executable, "-c", _OTHER_BRIDGE, str(port), bind, *extra_args],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
            encoding="utf-8",
        )
        self._lines: queue.Queue[str] = queue.Queue()
        self._pump_thread = threading.Thread(target=self._pump, daemon=True)
        self._pump_thread.start()
        port_text, pid_text = self._lines.get(timeout=20).split()
        self.port = int(port_text)
        # The process that owns the socket reports its own pid: on Windows a
        # venv's python.exe can be a launcher whose child does the work.
        self.pid = int(pid_text)

    def _pump(self) -> None:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            self._lines.put(line.strip())

    def received(self, timeout: float = 5.0) -> Optional[str]:
        try:
            return self._lines.get(timeout=timeout)
        except queue.Empty:
            return None

    def close(self) -> None:
        """Stop the process and close both pipes. The pump reads stdout to
        its end once the process exits, so it is joined before stdout is
        closed under it."""
        assert self.proc.stdin is not None and self.proc.stdout is not None
        self.proc.stdin.close()
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(timeout=10)
        self._pump_thread.join(timeout=10)
        self.proc.stdout.close()


@pytest.fixture
def headset(monkeypatch: pytest.MonkeyPatch) -> FakeHeadset:
    """A fresh bridge state, a fake headset in place of adb, and ports that
    cannot collide with a theDAW running on this machine."""
    fake = FakeHeadset()
    monkeypatch.setattr(bridge, "_s", bridge._State())
    monkeypatch.setattr(bridge, "_adb", fake.adb)
    monkeypatch.setattr(bridge, "_adb_path", lambda: "adb")
    for name in _PORT_ENV:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("theDAW_QUESTMIDI_HOST_PORT", str(_free_port()))
    monkeypatch.setenv("theDAW_PORT", str(_free_port()))
    return fake


@pytest.fixture(params=BINDS)
def other_bridge(request):
    started: list[OtherBridge] = []

    def start(port: int = 0, *extra_args: str) -> OtherBridge:
        other = OtherBridge(port, *extra_args, bind=request.param)
        started.append(other)
        return other

    yield start
    for other in started:
        other.close()


def _headset_dials(monkeypatch: pytest.MonkeyPatch, port: int) -> None:
    """Point the headset at ``port`` by theDAW_QUESTMIDI_DEVICE_PORT.
    test_a_setup_made_for_main_still_reaches_thedaw covers theDAW_QUESTMIDI_PORT."""
    monkeypatch.setenv("theDAW_QUESTMIDI_DEVICE_PORT", str(port))


async def _eventually(check: Callable[[], bool], timeout: float = 5.0) -> bool:
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if check():
            return True
        await asyncio.sleep(0.05)
    return check()


def _listen_to_bridge() -> tuple[
    list[list[int]], Callable[[list[int]], Awaitable[None]]
]:
    """A browser client of the bridge: what it receives, and its send hook."""
    got: list[list[int]] = []

    async def send(msg: list[int]) -> None:
        got.append(msg)

    return got, send


def test_the_headset_stays_with_a_bridge_that_already_serves_it(
    headset, other_bridge, monkeypatch
):
    """Sequence: the standalone bridge is on 8765 and has mapped the headset to
    itself, 1:1; then theDAW starts. theDAW must not reverse the headset."""
    other = other_bridge()
    device_port = other.port
    _headset_dials(monkeypatch, device_port)
    headset.reverse[device_port] = device_port  # the other bridge's own adb reverse

    async def scenario() -> None:
        await bridge.ensure_started()
        try:
            status = bridge.status()
            assert status["started"] is True
            assert headset.midi_reversals(device_port) == [], (
                "theDAW reversed the headset away from the program serving it"
            )
            assert headset.reverse[device_port] == device_port
            assert status["adb_reverse_ok"] is False
            assert status["took_over"] is False
            holder = status["headset_holder"]
            assert holder is not None
            assert holder["pid"] == other.pid
            assert holder["port"] == device_port
            assert holder["mapped"] is True
            assert holder["thedaw"] is False
            assert holder["name"]

            # The headset's MIDI still reaches the program that serves it.
            await headset.send_note(device_port)
            assert other.received() == "got " + FRAME.hex()
            assert bridge.status()["quest_connected"] is False
        finally:
            await bridge.stop()

    asyncio.run(scenario())


def test_a_program_on_the_headset_port_keeps_it_before_the_headset_is_mapped(
    headset, other_bridge, monkeypatch
):
    """Sequence: the headset is plugged in with no mapping yet, and a program
    listens on the headset's port number here, where a 1:1 bridge maps it."""
    other = other_bridge()
    device_port = other.port
    _headset_dials(monkeypatch, device_port)

    async def scenario() -> None:
        await bridge.ensure_started()
        try:
            assert headset.midi_reversals(device_port) == []
            holder = bridge.status()["headset_holder"]
            assert holder is not None
            assert holder["pid"] == other.pid
            assert holder["mapped"] is False
        finally:
            await bridge.stop()

    asyncio.run(scenario())


def test_take_over_moves_the_headset_and_survives_a_replug(
    headset, other_bridge, monkeypatch
):
    """Sequence: the other bridge serves the headset; theDAW starts and leaves
    it; the user presses Take over; the cable is pulled and plugged back in;
    the re-attach moves the headset to theDAW again without asking."""
    other = other_bridge()
    device_port = other.port
    _headset_dials(monkeypatch, device_port)
    headset.reverse[device_port] = device_port
    got, send = _listen_to_bridge()

    async def scenario() -> None:
        await bridge.ensure_started()
        bridge.add_client(send)
        try:
            assert bridge.status()["headset_holder"] is not None
            host_port = bridge.status()["host_port"]

            status = await bridge.take_over()
            assert headset.reverse[device_port] == host_port
            assert status["headset_holder"] is None
            assert status["took_over"] is True
            assert status["adb_reverse_ok"] is True

            await headset.send_note(device_port)
            assert await _eventually(lambda: got == [NOTE_ON]), got
            assert other.received(timeout=0.5) is None

            headset.unplug_and_replug()
            await bridge.refresh_headset_holder()
            assert bridge.status()["headset_holder"] is None, (
                "the user's settled choice was reported as a new holder"
            )
            assert await bridge.reattach_adb() is True
            assert headset.reverse[device_port] == host_port
        finally:
            bridge.remove_client(send)
            await bridge.stop()

    asyncio.run(scenario())


def test_a_program_that_takes_the_headset_later_keeps_it(
    headset, other_bridge, monkeypatch
):
    """Sequence: theDAW starts with nobody else around and maps the headset;
    later the standalone bridge starts and maps the headset to itself; then a
    re-attach runs (re-plug recovery). theDAW must not take the headset back."""
    device_port = _free_port()
    _headset_dials(monkeypatch, device_port)

    async def scenario() -> None:
        await bridge.ensure_started()
        try:
            host_port = bridge.status()["host_port"]
            assert headset.reverse[device_port] == host_port
            assert bridge.status()["adb_reverse_ok"] is True

            other = other_bridge()
            headset.reverse[device_port] = other.port  # its own adb reverse

            await bridge.refresh_headset_holder()
            holder = bridge.status()["headset_holder"]
            assert holder is not None and holder["pid"] == other.pid
            assert holder["port"] == other.port and holder["mapped"] is True
            assert bridge.status()["adb_reverse_ok"] is False

            reversals_before = len(headset.midi_reversals(device_port))
            assert await bridge.reattach_adb() is False
            assert len(headset.midi_reversals(device_port)) == reversals_before
            assert headset.reverse[device_port] == other.port

            await headset.send_note(device_port)
            assert other.received() == "got " + FRAME.hex()

            await bridge.take_over()
            assert headset.reverse[device_port] == host_port
        finally:
            await bridge.stop()

    asyncio.run(scenario())


@pytest.mark.parametrize("mapped", [False, True], ids=["listening", "mapped"])
def test_a_program_the_listening_table_hides_keeps_the_headset(
    headset, other_bridge, monkeypatch, mapped
):
    """Sequence: the standalone bridge serves the headset's port on a machine
    where psutil cannot read the listening table (macOS without root; on Linux,
    a socket another user owns); theDAW starts; the user presses Take over; the
    cable is pulled and plugged back in. theDAW must leave the headset alone
    until Take over, and afterwards re-attach without asking."""
    import backend.ports

    other = other_bridge()
    device_port = other.port
    _headset_dials(monkeypatch, device_port)
    if mapped:
        headset.reverse[device_port] = device_port
    monkeypatch.setattr(backend.ports, "holders", lambda ports: [])

    async def scenario() -> None:
        await bridge.ensure_started()
        try:
            assert headset.midi_reversals(device_port) == [], (
                "theDAW took the headset from a program psutil could not name"
            )
            holder = bridge.status()["headset_holder"]
            assert holder == {
                "pid": 0,
                "name": "",
                "port": device_port,
                "thedaw": False,
                "mapped": mapped,
            }
            assert await bridge.reattach_adb() is False
            assert headset.midi_reversals(device_port) == []

            status = await bridge.take_over()
            assert status["headset_holder"] is None
            assert headset.reverse[device_port] == status["host_port"]

            headset.unplug_and_replug()
            await bridge.refresh_headset_holder()
            assert bridge.status()["headset_holder"] is None
            assert await bridge.reattach_adb() is True
            assert headset.reverse[device_port] == status["host_port"]
        finally:
            await bridge.stop()

    asyncio.run(scenario())


def test_a_second_program_is_asked_about_anew(headset, other_bridge, monkeypatch):
    """Sequence: the user takes the headset from one program; a different
    program then maps it to itself; a re-attach leaves it with that one."""
    first = other_bridge()
    device_port = first.port
    _headset_dials(monkeypatch, device_port)
    headset.reverse[device_port] = device_port

    async def scenario() -> None:
        await bridge.ensure_started()
        try:
            await bridge.take_over()
            second = other_bridge()
            headset.reverse[device_port] = second.port
            assert await bridge.reattach_adb() is False
            assert headset.reverse[device_port] == second.port
            assert bridge.status()["headset_holder"]["pid"] == second.pid
        finally:
            await bridge.stop()

    asyncio.run(scenario())


def test_another_thedaw_keeps_the_headset_until_take_over(
    headset, other_bridge, monkeypatch
):
    """Sequence: another theDAW backend already listens on the host port and
    has mapped the headset to itself; this backend starts, then the user
    presses Take over in this backend's Settings."""
    device_port = _free_port()
    _headset_dials(monkeypatch, device_port)
    # "backend.run" on its command line is what marks a process as theDAW.
    other = other_bridge(0, "backend.run")
    monkeypatch.setenv("theDAW_QUESTMIDI_HOST_PORT", str(other.port))
    headset.reverse[device_port] = other.port

    async def scenario() -> None:
        await bridge.ensure_started()
        try:
            status = bridge.status()
            assert status["started"] is True and status["port_in_use"] is True
            assert headset.midi_reversals(device_port) == []
            holder = status["headset_holder"]
            assert holder is not None and holder["thedaw"] is True
            assert holder["pid"] == other.pid

            status = await bridge.take_over()
            assert status["port_in_use"] is False
            assert status["host_port"] not in (None, other.port)
            assert headset.reverse[device_port] == status["host_port"]
            assert status["headset_holder"] is None
        finally:
            await bridge.stop()

    asyncio.run(scenario())


def test_a_setup_made_for_main_still_reaches_thedaw(headset, monkeypatch):
    """Sequence: a setup written for main sets theDAW_QUESTMIDI_PORT to the port
    its headset app dials; this build starts. The headset must reach theDAW on
    that port, with the listener here on its own port."""
    device_port = _free_port()
    monkeypatch.setenv("theDAW_QUESTMIDI_PORT", str(device_port))
    got, send = _listen_to_bridge()

    async def scenario() -> None:
        await bridge.ensure_started()
        bridge.add_client(send)
        try:
            status = bridge.status()
            assert status["port"] == device_port
            assert status["device_port"] == device_port
            assert headset.reverse[device_port] == status["host_port"]
            await headset.send_note(device_port)
            assert await _eventually(lambda: got == [NOTE_ON]), got
        finally:
            bridge.remove_client(send)
            await bridge.stop()

    asyncio.run(scenario())


def _first_frame(ws, timeout: float = 10.0) -> dict:
    """The WebSocket's next frame; a failure, never a hang, when none comes."""
    frames: list[dict] = []
    reader = threading.Thread(target=lambda: frames.append(ws.receive_json()))
    reader.daemon = True
    reader.start()
    reader.join(timeout)
    assert frames, "the WebSocket sent no status frame"
    return frames[0]


def _frame_where(ws, check: Callable[[dict], bool], timeout: float = 10.0) -> dict:
    """The first status frame ``check`` accepts, reading frames as they come."""
    deadline = threading.Event()
    timer = threading.Timer(timeout, deadline.set)
    timer.start()
    try:
        while not deadline.is_set():
            frame = _first_frame(ws, timeout)
            if frame.get("type") == "status" and check(frame):
                return frame
    finally:
        timer.cancel()
    raise AssertionError("no status frame matched")


@pytest.fixture
def client(headset):
    app = FastAPI()
    app.include_router(questmidi_router.router, prefix="/api/questmidi")
    with TestClient(app, client=("127.0.0.1", 50000)) as test_client:
        yield test_client
        test_client.post("/api/questmidi/stop")


def test_take_over_over_http_needs_theDAW_own_ui(
    headset, other_bridge, client, monkeypatch
):
    """Sequence through the routes: the WebSocket opens and reports the holder,
    a page outside theDAW tries Take over and is refused, then theDAW's own UI
    takes over."""
    other = other_bridge()
    device_port = other.port
    _headset_dials(monkeypatch, device_port)
    headset.reverse[device_port] = device_port

    with client.websocket_connect("/api/questmidi/ws") as ws:
        frame = _first_frame(ws)
    assert frame["type"] == "status"
    assert frame["headset_holder"]["pid"] == other.pid
    assert headset.midi_reversals(device_port) == []

    refused = client.post(
        "/api/questmidi/takeover", headers={"Origin": "https://evil.example"}
    )
    assert refused.status_code == 403
    assert headset.reverse[device_port] == device_port

    status = client.get("/api/questmidi/status").json()
    assert status["headset_holder"]["pid"] == other.pid

    taken = client.post(
        "/api/questmidi/takeover", headers={"Origin": "http://localhost:5173"}
    )
    assert taken.status_code == 200
    body = taken.json()
    assert body["headset_holder"] is None
    assert body["took_over"] is True
    assert headset.reverse[device_port] == body["host_port"]


def test_a_lan_caller_cannot_move_the_headset(headset, other_bridge, monkeypatch):
    other = other_bridge()
    device_port = other.port
    _headset_dials(monkeypatch, device_port)
    headset.reverse[device_port] = device_port
    app = FastAPI()
    app.include_router(questmidi_router.router, prefix="/api/questmidi")
    with TestClient(app, client=("10.20.30.40", 50000)) as lan:
        for route in ("takeover", "reattach", "start", "stop"):
            assert lan.post(f"/api/questmidi/{route}").status_code == 403, route
    assert headset.midi_reversals(device_port) == []
    assert headset.reverse[device_port] == device_port


def test_a_lan_caller_cannot_read_who_holds_the_headset(
    headset, other_bridge, monkeypatch
):
    """Sequence: the Node bridge serves the headset; an unpaired LAN device
    polls GET /status, then opens the bridge WebSocket. Neither may run adb for
    it or hand it the holder's pid and process name."""
    other = other_bridge()
    device_port = other.port
    _headset_dials(monkeypatch, device_port)
    headset.reverse[device_port] = device_port
    app = FastAPI()
    app.include_router(questmidi_router.router, prefix="/api/questmidi")
    with TestClient(app, client=("10.20.30.40", 50000)) as lan:
        for _ in range(3):
            assert lan.get("/api/questmidi/status").status_code == 403
        assert headset.calls == [], "a LAN GET made the backend run adb"

        with lan.websocket_connect("/api/questmidi/ws") as ws:
            frame = _first_frame(ws)
        assert frame["type"] == "status"
        holder = frame["headset_holder"]
        assert holder is not None and holder["port"] == device_port
        assert holder["pid"] == 0 and holder["name"] == ""
        # The LAN caller may not stop the bridge; stop it on the app's own loop.
        lan.portal.call(bridge.stop)
    assert headset.midi_reversals(device_port) == []


def test_a_program_that_takes_the_headset_mid_session_reaches_the_open_socket(
    headset, other_bridge, client, monkeypatch
):
    """Sequence: theDAW's UI opens the bridge WebSocket with theDAW holding the
    headset; with the socket still open, the Node bridge starts and maps the
    headset to itself. The socket must carry a status frame naming it, with no
    GET /status in between."""
    monkeypatch.setattr(bridge, "HOLDER_WATCH_S", 0.1, raising=False)
    device_port = _free_port()
    _headset_dials(monkeypatch, device_port)

    with client.websocket_connect("/api/questmidi/ws") as ws:
        first = _first_frame(ws)
        assert first["headset_holder"] is None
        assert first["adb_reverse_ok"] is True

        other = other_bridge()
        headset.reverse[device_port] = other.port  # its own adb reverse

        frame = _frame_where(ws, lambda f: f["headset_holder"] is not None)
        assert frame["headset_holder"]["pid"] == other.pid
        assert frame["headset_holder"]["mapped"] is True
        assert frame["adb_reverse_ok"] is False
    assert headset.reverse[device_port] == other.port


def test_a_holder_read_that_straddles_take_over_is_dropped(
    headset, other_bridge, monkeypatch
):
    """Sequence: the holder watch starts reading the reverse table while the
    Node bridge has the headset; before that read is recorded, the user's
    Take over maps the headset to theDAW. The late read must not put the Node
    bridge back into status() as the holder."""
    other = other_bridge()
    device_port = other.port
    _headset_dials(monkeypatch, device_port)
    headset.reverse[device_port] = device_port
    real_holder = bridge._headset_holder
    read_done = threading.Event()
    release = threading.Event()
    slow = {"armed": False}

    def headset_holder(device: int, own: Optional[int]) -> Optional[dict]:
        found = real_holder(device, own)
        if slow["armed"]:
            slow["armed"] = False
            read_done.set()
            release.wait(10)
        return found

    monkeypatch.setattr(bridge, "_headset_holder", headset_holder)

    async def scenario() -> None:
        await bridge.ensure_started()
        try:
            slow["armed"] = True
            watch_read = asyncio.create_task(bridge.refresh_headset_holder())
            loop = asyncio.get_running_loop()
            assert await loop.run_in_executor(None, read_done.wait, 10)

            status = await bridge.take_over()
            assert status["headset_holder"] is None
            release.set()
            await watch_read

            status = bridge.status()
            assert status["headset_holder"] is None, (
                "a read from before Take over put the old holder back"
            )
            assert status["adb_reverse_ok"] is True
            assert headset.reverse[device_port] == status["host_port"]
        finally:
            release.set()
            await bridge.stop()

    asyncio.run(scenario())
