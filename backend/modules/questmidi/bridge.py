"""Quest MIDI bridge — the loopMIDI-free path.

Replaces the standalone Node bridge + loopMIDI: theDAW's own backend hosts a
localhost TCP listener that the Quest app reaches over USB (``adb reverse``),
and relays MIDI to/from the browser over a WebSocket. Inbound Quest MIDI is
published to the frontend ``midiBus``; return MIDI from the browser (e.g. an
audio-reactive feed for the GANTASMO Visor) is framed back to the headset.

Everything runs on uvicorn's asyncio loop — the TCP server, the WebSocket
relay, and the broadcast are all coroutines, so there are no threads to manage.

Wire format on the TCP socket (matches QuestMidiSender / the Node bridge):
``[len:1][midi bytes…]``. Over the WebSocket each message is JSON
``{"type": "midi", "data": [status, d1, d2]}``.
"""

from __future__ import annotations

import asyncio
import logging
import os
import subprocess
from typing import Awaitable, Callable, Optional

from backend.core.adb import resolve_adb_path

log = logging.getLogger(__name__)

DEFAULT_PORT = 8765
ClientSend = Callable[[list[int]], Awaitable[None]]


def _port() -> int:
    try:
        return int(os.getenv("theDAW_QUESTMIDI_PORT") or DEFAULT_PORT)
    except ValueError:
        return DEFAULT_PORT


def _adb_path() -> Optional[str]:
    """Resolve adb: explicit env override, else PATH."""
    return resolve_adb_path(
        "theDAW_QUESTMIDI_ADB", "theDAW_ADB", "theDAW_QUESTCAST_ADB"
    )


class _State:
    server: Optional[asyncio.AbstractServer] = None
    quest_writer: Optional[asyncio.StreamWriter] = None
    quest_peer: Optional[str] = None
    clients: set[ClientSend] = set()
    adb_reverse_ok: bool = False
    started: bool = False
    starting: bool = False


_s = _State()


# ---- frontend WebSocket clients ----------------------------------------------


def add_client(send: ClientSend) -> None:
    _s.clients.add(send)


def remove_client(send: ClientSend) -> None:
    _s.clients.discard(send)


async def _broadcast(msg: list[int]) -> None:
    if not _s.clients:
        return
    dead: list[ClientSend] = []
    for send in list(_s.clients):
        try:
            await send(msg)
        except Exception:
            dead.append(send)
    for d in dead:
        _s.clients.discard(d)


# ---- return path: browser -> Quest -------------------------------------------


def send_to_quest(data: object) -> bool:
    """Frame a MIDI message and write it to the connected Quest. Returns False
    when no Quest is connected or the payload is unusable."""
    w = _s.quest_writer
    if w is None or not isinstance(data, (list, tuple)) or not data:
        return False
    n = min(len(data), 255)
    try:
        frame = bytes([n] + [int(b) & 0xFF for b in list(data)[:n]])
        w.write(frame)
        return True
    except Exception as e:  # noqa: BLE001 — a broken pipe just means no Quest
        log.debug("questmidi: send_to_quest failed: %s", e)
        return False


# ---- inbound path: Quest -> browser ------------------------------------------


async def _handle_quest(
    reader: asyncio.StreamReader, writer: asyncio.StreamWriter
) -> None:
    peer = writer.get_extra_info("peername")
    _s.quest_writer = writer
    _s.quest_peer = str(peer)
    log.info("questmidi: Quest connected %s", peer)
    buf = bytearray()
    try:
        while True:
            chunk = await reader.read(4096)
            if not chunk:
                break
            buf.extend(chunk)
            off = 0
            while off < len(buf):
                ln = buf[off]
                if off + 1 + ln > len(buf):
                    break  # wait for the rest of the frame
                if ln > 0:
                    await _broadcast(list(buf[off + 1 : off + 1 + ln]))
                off += 1 + ln
            if off:
                del buf[:off]
    except Exception as e:  # noqa: BLE001
        log.debug("questmidi: quest read error: %s", e)
    finally:
        if _s.quest_writer is writer:
            _s.quest_writer = None
            _s.quest_peer = None
        try:
            writer.close()
        except Exception:
            pass
        log.info("questmidi: Quest disconnected")


# ---- lifecycle ---------------------------------------------------------------


def _run_adb_reverse(port: int) -> bool:
    adb = _adb_path()
    if not adb:
        return False
    try:
        subprocess.run(
            [adb, "reverse", f"tcp:{port}", f"tcp:{port}"],
            capture_output=True,
            timeout=10,
            check=True,
        )
        return True
    except Exception as e:  # noqa: BLE001
        log.info("questmidi: adb reverse failed: %s", e)
        return False


async def reattach_adb() -> bool:
    """Re-run ``adb reverse`` (after re-plugging the headset / accepting the
    USB-debugging prompt) without restarting the listener."""
    loop = asyncio.get_running_loop()
    _s.adb_reverse_ok = await loop.run_in_executor(None, _run_adb_reverse, _port())
    return _s.adb_reverse_ok


async def ensure_started() -> None:
    """Start the TCP listener (once) and run adb reverse. Idempotent."""
    if _s.started or _s.starting:
        return
    _s.starting = True
    try:
        port = _port()
        await reattach_adb()
        _s.server = await asyncio.start_server(_handle_quest, "127.0.0.1", port)
        _s.started = True
        log.info(
            "questmidi: listening on 127.0.0.1:%d (adb reverse %s)",
            port,
            "ok" if _s.adb_reverse_ok else "not set",
        )
    except Exception as e:  # noqa: BLE001
        log.warning("questmidi: failed to start: %s", e)
    finally:
        _s.starting = False


async def stop() -> None:
    if _s.server is not None:
        _s.server.close()
        try:
            await _s.server.wait_closed()
        except Exception:
            pass
    _s.server = None
    _s.started = False
    if _s.quest_writer is not None:
        try:
            _s.quest_writer.close()
        except Exception:
            pass
        _s.quest_writer = None
        _s.quest_peer = None


def status() -> dict:
    return {
        "started": _s.started,
        "port": _port(),
        "adb_path": _adb_path(),
        "adb_reverse_ok": _s.adb_reverse_ok,
        "quest_connected": _s.quest_writer is not None,
        "quest_peer": _s.quest_peer,
        "clients": len(_s.clients),
    }
