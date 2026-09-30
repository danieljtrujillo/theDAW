"""Quest MIDI bridge — the loopMIDI-free path.

Replaces the standalone Node bridge + loopMIDI: theDAW's own backend hosts a
localhost TCP listener that the Quest app reaches over USB (``adb reverse``),
and relays MIDI to/from the browser over a WebSocket. Inbound Quest MIDI is
published to the frontend ``midiBus``; return MIDI from the browser (e.g. an
audio-reactive feed for the GANTASMO Visor) is framed back to the headset.

Everything runs on uvicorn's asyncio loop — the TCP server, the WebSocket
relay, and the broadcast are all coroutines, so there are no threads to manage.

Ports (see port_config.py): the headset dials its own port 8765, and ``adb
reverse tcp:8765 tcp:<listener>`` carries that to the listener here, 8766 by
default. A headset has one mapping per port, so reversing it takes the headset
from whichever program had it. When another program already serves the
headset's port, this bridge leaves the headset with it: status() names that
program under ``headset_holder`` and take_over() is the user's explicit way to
move the headset here.

Wire format on the TCP socket (matches QuestMidiSender / the Node bridge):
``[len:1][midi bytes…]``. Over the WebSocket each message is JSON
``{"type": "midi", "data": [status, d1, d2]}``.
"""

from __future__ import annotations

import asyncio
import errno
import logging
import os
import socket
import subprocess
import sys
from typing import Awaitable, Callable, Optional

from backend.core.adb import resolve_adb_path
from backend.lib.launch_token import child_env
from backend.modules.questmidi import port_config

log = logging.getLogger(__name__)

# The backend's own HTTP port, reversed alongside the MIDI port so a
# USB-tethered headset reaches the whole API — including the XR control-bus
# relay at ws://127.0.0.1:8600/api/xr/control/ws — on its own loopback with
# zero network setup, exactly like MIDI.
DEFAULT_HTTP_PORT = 8600
# Seconds between re-reads of who holds the headset while a browser keeps the
# bridge WebSocket open; a change goes out as a status frame (_watch_status).
HOLDER_WATCH_S = 5.0
ClientSend = Callable[[list[int]], Awaitable[None]]
StatusSend = Callable[[dict], Awaitable[None]]


def _port() -> int:
    """The listener port configured for this PC (theDAW_QUESTMIDI_HOST_PORT)."""
    return port_config.host_port()


def _device_port() -> int:
    """The port the headset dials (theDAW_QUESTMIDI_PORT)."""
    return port_config.device_port()


def _http_port() -> int:
    try:
        return int(os.getenv("theDAW_PORT") or DEFAULT_HTTP_PORT)
    except ValueError:
        return DEFAULT_HTTP_PORT


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
    port_in_use: bool = False
    # The port the listener is really bound to on this machine. Differs from
    # _port() (the configured host port) when another program already serves
    # that port number here; ``adb reverse`` maps the headset's port onto it.
    host_port: Optional[int] = None
    # The program the headset's MIDI reaches instead of this bridge, as
    # {pid, name, port, thedaw, mapped} (see _headset_holder); None while it
    # reaches this bridge or nothing.
    headset_holder: Optional[dict] = None
    # _consent_key of the program the user took the headset from with Take
    # over. A re-attach may move the headset away from that program again
    # without asking; any other program gets asked about anew.
    takeover_from: Optional[tuple[int, str]] = None
    # Bumped by every re-attach, Take over and stop. A holder read that started
    # before one of those finished is stale and is dropped.
    holder_gen: int = 0
    # Browser WebSockets that get a status frame whenever status() changes,
    # each with the last status it was sent.
    status_clients: Optional[dict[StatusSend, dict]] = None
    watch_task: Optional[asyncio.Task] = None


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
    except Exception as e:  # a broken pipe just means no Quest
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
    except Exception as e:  # the headset went away mid-read
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


# Entry points that mean "the process holding the port is another theDAW backend".
_THEDAW_ENTRY_POINTS = (
    "backend.run",
    "backend._supervisor",
    "backend._devstack",
    "backend.server",
)


def _port_holders(port: int) -> tuple[bool, bool]:
    """``(another theDAW holds it, another program holds it)`` for ``port``, on ANY
    local address. Both False when the port is free or the table is unreadable."""
    from backend.ports import holders

    thedaw = foreign = False
    for holder in holders([port]):
        if holder.pid == os.getpid():
            continue
        if any(entry in holder.cmdline for entry in _THEDAW_ENTRY_POINTS):
            thedaw = True
        else:
            foreign = True
    return thedaw, foreign


def _holder_of(port: int) -> Optional[dict]:
    """The first process other than this one listening on ``port`` here, as
    ``{pid, name, port, thedaw}``; None when nobody else listens on it.

    The listening table can hide the process: psutil gets AccessDenied for the
    whole table on macOS without root, and on Linux it reports no pid for a
    socket another user owns, so ``holders()`` comes back without it. A bind
    probe still sees the port taken, and such a holder is reported as
    ``{pid: 0, name: ""}``: some program serves the port, which one is unknown.
    """
    from backend.ports import holders

    listed = holders([port])
    for holder in listed:
        if holder.pid == os.getpid():
            continue
        return {
            "pid": holder.pid,
            "name": holder.name,
            "port": port,
            "thedaw": any(entry in holder.cmdline for entry in _THEDAW_ENTRY_POINTS),
        }
    if listed or _port_number_is_free(port):
        # Only this process listens on it, or nobody does.
        return None
    return {"pid": 0, "name": "", "port": port, "thedaw": False}


#: The addresses the free-port probe binds, in order. ``::`` is bound dual-
#: stack: on Windows it is the one bind that a listener on ``::`` refuses when
#: that listener is dual-stack too (Node's default ``listen(port)``), where an
#: IPv6-only probe of ``::`` and every IPv4 probe are let through.
_PROBE_ADDRESSES: tuple[tuple[socket.AddressFamily, str], ...] = (
    (socket.AF_INET, "0.0.0.0"),
    (socket.AF_INET, "127.0.0.1"),
    (socket.AF_INET6, "::"),
    (socket.AF_INET6, "::1"),
)
#: A probe bind that fails with one of these found no IPv6 here (the family or
#: the loopback address is switched off), so nothing can listen there either.
_NO_SUCH_ADDRESS = frozenset({errno.EADDRNOTAVAIL, errno.EAFNOSUPPORT, 10049, 10047})


def _port_number_is_free(port: int) -> bool:
    """Nobody listens on this port NUMBER, on any IPv4 or IPv6 address.

    Windows lets ``127.0.0.1:P`` be bound while another program holds
    ``0.0.0.0:P`` — no EADDRINUSE, with or without SO_EXCLUSIVEADDRUSE — and
    then hands every loopback connection to the more specific bind. That is how
    this bridge once took the localhost traffic of a server that was already
    listening on 8765 on all interfaces: its clients reached our raw TCP
    listener and saw their own server as dead. So the wildcard address is
    probed as well as ours; a bind to an address somebody holds does fail.

    The same goes for IPv6: the standalone Node bridge listens on ``::``,
    dual-stack, which no IPv4 probe notices on Windows. ``::`` and ``::1`` are
    probed too, on a machine that has IPv6.

    Elsewhere the probe sets SO_REUSEADDR, so a connection left in TIME_WAIT by
    a program that already exited does not count as a listener. Linux still
    refuses the bind while any socket listens on the port, and BSD/macOS while
    one holds the same address.
    """
    for family, host in _PROBE_ADDRESSES:
        try:
            probe = socket.socket(family, socket.SOCK_STREAM)
        except OSError:
            continue  # no IPv6 on this machine
        try:
            if family == socket.AF_INET6:
                try:
                    probe.setsockopt(
                        socket.IPPROTO_IPV6,
                        socket.IPV6_V6ONLY,
                        0 if host == "::" else 1,
                    )
                except OSError:
                    pass  # a system that fixes the option keeps its own value
            if sys.platform == "win32":
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            else:
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            probe.bind((host, port))
        except OSError as e:
            if family == socket.AF_INET6 and e.errno in _NO_SUCH_ADDRESS:
                continue
            return False
        finally:
            probe.close()
    return True


def _bind_listener(port: int) -> socket.socket:
    """A bound socket on 127.0.0.1:``port`` (0 = any free port). Exclusive on
    Windows, so no later program can bind the same address over it."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        if sys.platform == "win32":
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        sock.bind(("127.0.0.1", port))
    except OSError:
        sock.close()
        raise
    return sock


def _adb(*args: str) -> Optional[str]:
    """Run one adb command and return its stdout, or None when adb is missing
    or the command failed (no headset plugged in, the USB-debugging prompt not
    yet accepted, more than one device). Every adb call goes through here."""
    adb = _adb_path()
    if not adb:
        return None
    try:
        done = subprocess.run(
            [adb, *args],
            capture_output=True,
            text=True,
            # Named, as every backend text subprocess names it: left out,
            # Python decodes with the locale codepage (cp1252 on most Windows
            # machines) and a byte outside it raises instead of returning.
            encoding="utf-8",
            errors="replace",
            timeout=10,
            check=True,
            env=child_env(),
        )
    except Exception as e:  # expected when no headset is plugged in
        log.debug("questmidi: adb %s failed: %s", " ".join(args), e)
        return None
    return done.stdout or ""


def _run_adb_reverse(device_port: int, host_port: int) -> bool:
    """Map the headset's ``device_port`` onto this machine's ``host_port``."""
    return _adb("reverse", f"tcp:{device_port}", f"tcp:{host_port}") is not None


def _reverse_target(device_port: int) -> Optional[int]:
    """The port on this PC that the plugged-in headset's ``device_port`` is
    reversed onto; None when it has no such mapping, or no headset or adb is
    there to ask."""
    listing = _adb("reverse", "--list")
    if not listing:
        return None
    want = f"tcp:{device_port}"
    for line in listing.splitlines():
        # adb prints one mapping per line: "<transport> <headset side> <PC side>".
        parts = line.split()
        if len(parts) >= 2 and parts[-2] == want and parts[-1].startswith("tcp:"):
            try:
                return int(parts[-1][len("tcp:") :])
            except ValueError:
                return None
    return None


def _headset_holder(device_port: int, own_port: Optional[int]) -> Optional[dict]:
    """The program the headset's MIDI reaches when it is not ``own_port``,
    this bridge's listener (None while this backend has no listener).

    The headset dials ``device_port`` and adb carries that to whatever PC port
    its reverse mapping names; such a holder has ``mapped`` True. With no
    mapping, or no headset plugged in to ask, the program listening on
    ``device_port`` here counts as holding it (``mapped`` False): that is where
    every one-to-one bridge sends the headset (theDAW before the ports were
    split, and the standalone Node bridge). None when the mapping names
    ``own_port`` or nobody else listens on the port in question.
    """
    target = _reverse_target(device_port)
    port = device_port if target is None else target
    if own_port is not None and port == own_port:
        return None
    holder = _holder_of(port)
    if holder is not None:
        holder["mapped"] = target is not None
    return holder


def _own_port() -> Optional[int]:
    """This bridge's listener port; None while another theDAW's listener
    stands in for it (started with ``port_in_use``)."""
    return _s.host_port if _s.server is not None else None


def _consent_key(holder: dict) -> tuple[int, str]:
    """Which program a holder is, for Take over: its pid and name, or its port
    when the listening table could not name it (pid 0)."""
    if holder["pid"]:
        return (int(holder["pid"]), str(holder["name"]))
    return (0, f"port {holder['port']}")


def _holder_label(holder: dict) -> str:
    if holder["thedaw"]:
        return f"another theDAW (pid {holder['pid']})"
    if holder["pid"]:
        return f"{holder['name']} (pid {holder['pid']})"
    return "another program"


def _note_holder(holder: Optional[dict]) -> None:
    """Record who holds the headset, logging once per change of holder."""
    if holder is not None and holder != _s.headset_holder:
        log.info(
            "questmidi: %s serves port %d, the port the headset dials "
            "(listening on port %d here); theDAW leaves the headset with it "
            "until you press Take over (Settings > Inputs & outputs)",
            _holder_label(holder),
            _device_port(),
            holder["port"],
        )
    _s.headset_holder = holder


async def reattach_adb(*, take_over: bool = False) -> bool:
    """Re-run ``adb reverse`` (after re-plugging the headset / accepting the
    USB-debugging prompt) without restarting the listener. Reverses the MIDI
    port AND the backend HTTP port (control-bus relay) in one pass; only the
    MIDI port decides the reported ok state, matching what this bridge owns.

    While another program serves the headset's port the MIDI port is left
    alone and status() names that program. ``take_over=True`` is the user's
    Take over: the headset moves here anyway, and later re-attaches may move it
    away from that same program again without asking."""
    loop = asyncio.get_running_loop()
    _s.holder_gen += 1
    device_port = _device_port()
    host_port = _s.host_port or _port()
    holder = await loop.run_in_executor(None, _headset_holder, device_port, _own_port())
    if holder is not None and take_over:
        _s.takeover_from = _consent_key(holder)
    if holder is not None and _consent_key(holder) != _s.takeover_from:
        _note_holder(holder)
        _s.adb_reverse_ok = False
    else:
        _note_holder(None)
        _s.adb_reverse_ok = await loop.run_in_executor(
            None, _run_adb_reverse, device_port, host_port
        )
    http_port = _http_port()
    await loop.run_in_executor(None, _run_adb_reverse, http_port, http_port)
    return _s.adb_reverse_ok


async def refresh_headset_holder() -> None:
    """Re-read who the headset reaches, without touching any mapping, so
    status() shows a program that took the headset after this bridge mapped
    it. A program the user already took the headset from is only reported
    while the headset's own mapping names it; with the headset unplugged it
    is the user's settled choice, not news."""
    loop = asyncio.get_running_loop()
    gen = _s.holder_gen
    holder = await loop.run_in_executor(
        None, _headset_holder, _device_port(), _own_port()
    )
    if gen != _s.holder_gen:
        # A re-attach, Take over or stop ran meanwhile and recorded its own
        # reading; this one may predate its adb reverse.
        return
    if (
        holder is not None
        and not holder["mapped"]
        and _consent_key(holder) == _s.takeover_from
    ):
        holder = None
    _note_holder(holder)
    if holder is not None:
        _s.adb_reverse_ok = False


async def _open_listener(port: int) -> None:
    """Bind this bridge's listener: ``port`` when nobody else has that port
    number here, else any free port."""
    _thedaw, foreign_holds = _port_holders(port)
    listener: Optional[socket.socket] = None
    if not foreign_holds and _port_number_is_free(port):
        try:
            listener = _bind_listener(port)
        except OSError as e:
            if e.errno not in (errno.EADDRINUSE, errno.EACCES, 10048, 10013):
                raise
    if listener is None:
        # Another program serves this port number. Never sit beside it: take
        # any free port here; adb maps the headset's port onto whichever it is.
        listener = _bind_listener(0)
    _s.host_port = listener.getsockname()[1]
    _s.server = await asyncio.start_server(_handle_quest, sock=listener)


async def ensure_started() -> None:
    """Start the TCP listener (once) and run adb reverse. Idempotent."""
    if _s.started or _s.starting:
        return
    _s.starting = True
    try:
        port = _port()
        thedaw_holds, _foreign = _port_holders(port)
        if thedaw_holds:
            # A second theDAW instance or a --reload leftover already owns the
            # listener. Treat it as started so we don't re-attempt the bind (and
            # re-log) on every WebSocket connect; the existing listener relays
            # the headset, status() names it as the holder, and Take over gives
            # this backend a listener of its own.
            await reattach_adb()
            _s.started = True
            _s.port_in_use = True
            log.info(
                "questmidi: port %d already in use — an existing bridge "
                "owns it; not starting a second listener",
                port,
            )
            return
        await _open_listener(port)
        await reattach_adb()
        _s.started = True
        _s.port_in_use = False
        log.info(
            "questmidi: listening on 127.0.0.1:%d%s; the headset dials %d "
            "(adb reverse %s)",
            _s.host_port,
            ""
            if _s.host_port == port
            else f" (port {port} belongs to another program)",
            _device_port(),
            "ok"
            if _s.adb_reverse_ok
            else ("left with its holder" if _s.headset_holder else "not set"),
        )
    except Exception as e:  # one module's start must not take the backend down
        log.warning("questmidi: failed to start: %s", e)
    finally:
        _s.starting = False


async def take_over() -> dict:
    """The user's Take over: move the headset onto this bridge although
    another program serves its port. Nothing else calls this."""
    await ensure_started()
    try:
        if _s.started and _s.server is None:
            # Another theDAW held the listener port at start, so this backend
            # has no listener of its own yet.
            await _open_listener(_port())
            _s.port_in_use = False
        if _s.server is not None:
            await reattach_adb(take_over=True)
    except Exception as e:  # report through status(), never a 500
        log.warning("questmidi: take over failed: %s", e)
    return status()


async def stop() -> None:
    if _s.server is not None:
        _s.server.close()
        try:
            await _s.server.wait_closed()
        except Exception:
            pass
    _s.server = None
    _s.started = False
    _s.holder_gen += 1
    _s.host_port = None
    _s.headset_holder = None
    _s.takeover_from = None
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
        # The port the headset dials (theDAW_QUESTMIDI_PORT), as it always was.
        "port": _device_port(),
        "device_port": _device_port(),
        # The port the listener is bound to here, and the one configured for it.
        "host_port": _s.host_port,
        "configured_host_port": _port(),
        "port_in_use": _s.port_in_use,
        "adb_path": _adb_path(),
        "adb_reverse_ok": _s.adb_reverse_ok,
        "quest_connected": _s.quest_writer is not None,
        "quest_peer": _s.quest_peer,
        "clients": len(_s.clients),
        "headset_holder": dict(_s.headset_holder) if _s.headset_holder else None,
        "took_over": _s.takeover_from is not None,
    }


# ---- status frames: bridge -> browser -----------------------------------------


def add_status_client(send: StatusSend, sent: dict) -> None:
    """Send ``send`` a status frame whenever status() differs from ``sent``,
    the status it was last given. While any such client is connected, the
    holder is re-read every HOLDER_WATCH_S seconds, so a program that takes
    the headset mid-session reaches the LOG and Settings without a rescan."""
    if _s.status_clients is None:
        _s.status_clients = {}
    _s.status_clients[send] = sent
    if _s.watch_task is None or _s.watch_task.done():
        _s.watch_task = asyncio.get_running_loop().create_task(_watch_status())


def remove_status_client(send: StatusSend) -> None:
    if _s.status_clients is not None:
        _s.status_clients.pop(send, None)
    if not _s.status_clients and _s.watch_task is not None:
        _s.watch_task.cancel()
        _s.watch_task = None


async def push_status() -> None:
    """Send every status client the current status, if it changed for it."""
    if not _s.status_clients:
        return
    snapshot = status()
    for send, sent in list(_s.status_clients.items()):
        if sent == snapshot:
            continue
        try:
            await send(snapshot)
        except Exception:  # the socket went away; its route removes it
            continue
        if _s.status_clients is not None and send in _s.status_clients:
            _s.status_clients[send] = snapshot


async def _watch_status() -> None:
    while _s.status_clients:
        await asyncio.sleep(HOLDER_WATCH_S)
        try:
            if _s.started:
                await refresh_headset_holder()
            await push_status()
        except Exception as e:  # a failed read must not end the watch
            log.debug("questmidi: status watch: %s", e)
