"""The Quest MIDI bridge never shares its port number with another program.

Windows lets ``127.0.0.1:P`` be bound while another program holds ``0.0.0.0:P``
and then routes every loopback connection to the more specific bind. The bridge
once took 127.0.0.1:8765 that way, under a server already listening on 8765 on
all interfaces: that server's localhost clients reached the bridge's raw TCP
listener instead and saw their own server as dead. A server on ``::``
dual-stack (Node's ``server.listen(port)``) is let through the same way, and
no IPv4 probe notices it.

The other program's socket is opened in this process, so the listening table
(which skips this process) cannot name it and only the bind probe can.
"""

from __future__ import annotations

import asyncio
import socket

import pytest

from backend.modules.questmidi import bridge


def _free_port() -> int:
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]
    finally:
        probe.close()


def _dual_stack_available() -> bool:
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


def _foreign_listener(bind: str) -> socket.socket:
    if bind == "dual-stack":
        sock = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
        sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        sock.bind(("::", 0))
    else:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.bind(("0.0.0.0", 0))
    sock.listen()
    return sock


@pytest.mark.parametrize(
    "bind",
    [
        "ipv4",
        pytest.param(
            "dual-stack",
            # portability: needs a real IPv6 stack; the ipv4 case runs everywhere
            marks=pytest.mark.skipif(
                not _dual_stack_available(), reason="no IPv6 here"
            ),
        ),
    ],
)
def test_bridge_moves_aside_when_another_program_serves_its_port(monkeypatch, bind):
    foreign = _foreign_listener(bind)
    foreign.settimeout(5)
    port = foreign.getsockname()[1]
    device_port = _free_port()
    monkeypatch.setattr(bridge, "_s", bridge._State())
    monkeypatch.delenv("theDAW_QUESTMIDI_DEVICE_PORT", raising=False)
    monkeypatch.setenv("theDAW_QUESTMIDI_HOST_PORT", str(port))
    monkeypatch.setenv("theDAW_QUESTMIDI_PORT", str(device_port))
    monkeypatch.setattr(bridge, "_adb_path", lambda: None)  # no headset in a test run

    async def scenario() -> None:
        await bridge.ensure_started()
        try:
            status = bridge.status()
            assert status["started"] is True
            assert status["configured_host_port"] == port, (
                "the configured host port is still reported"
            )
            assert status["device_port"] == device_port, (
                "the headset still dials its own port"
            )
            assert status["host_port"] not in (None, port), (
                "listening beside the other program"
            )

            # The bridge answers on its own port...
            _reader, writer = await asyncio.open_connection(
                "127.0.0.1", status["host_port"]
            )
            writer.close()
            await writer.wait_closed()

            # ...and a localhost client of the OTHER program still reaches that program.
            loop = asyncio.get_running_loop()
            accepted = loop.run_in_executor(None, foreign.accept)
            _reader, writer = await asyncio.open_connection("127.0.0.1", port)
            conn, _peer = await asyncio.wait_for(accepted, timeout=5)
            conn.close()
            writer.close()
            await writer.wait_closed()
            assert bridge.status()["quest_connected"] is False
        finally:
            await bridge.stop()

    try:
        asyncio.run(scenario())
    finally:
        foreign.close()


def test_bridge_keeps_its_own_port_when_it_is_free(monkeypatch):
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()
    monkeypatch.setattr(bridge, "_s", bridge._State())
    monkeypatch.delenv("theDAW_QUESTMIDI_DEVICE_PORT", raising=False)
    monkeypatch.setenv("theDAW_QUESTMIDI_HOST_PORT", str(port))
    monkeypatch.setenv("theDAW_QUESTMIDI_PORT", str(_free_port()))
    monkeypatch.setattr(bridge, "_adb_path", lambda: None)

    async def scenario() -> None:
        await bridge.ensure_started()
        try:
            assert bridge.status()["host_port"] == port
        finally:
            await bridge.stop()

    asyncio.run(scenario())
