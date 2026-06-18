"""Quest stitch bridge — clean stitched passthrough -> VJ, over adb reverse.

The Quest app (``GantasmoStitchStreamer``) MediaCodec-encodes the stitched
passthrough RenderTexture to H.264 and pushes the NAL units over a localhost TCP
socket. ``adb reverse tcp:PORT tcp:PORT`` tunnels that to the PC (the same trick
``QuestMidiSender`` uses). This module hosts the TCP listener on uvicorn's
asyncio loop, re-frames each packet into the SAME WebSocket wire format the
``questcast`` relay uses, and fans it out to the VJ — so the VJ's existing
WebCodecs decoder (``useQuestCast``) is reused verbatim for a new source.

Why this exists separately from questcast/delinQuest: delinQuest mirrors the
whole Quest *display* (scrcpy), which carries the MR scene + MIDI surface the
performer is looking at. This carries ONLY the clean stitch.

Wire format on the TCP socket (Quest -> here):
    [u32 frameLen LE][u8 type][u8 keyframe][f64 ptsUs LE][payload]
    frameLen counts the 10-byte header + payload (everything after the u32).
    type 0 = codec config (Annex-B SPS/PPS), 1 = data NALs, 2 = meta (JSON {w,h,fps,codec}).

Wire format on the WebSocket (here -> browser), IDENTICAL to questcast:
    - first text message: {"type":"metadata","codec":"h264","width":..,"height":..}
    - binary frames: [u8 type(0=config,1=data)][u8 keyframe][6 pad][f64 ptsUs LE][...H.264]
    - the latest config packet is replayed to late-joining clients.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import struct
import subprocess
from typing import Any, Optional

from fastapi import WebSocket

from backend.core.adb import resolve_adb_path

log = logging.getLogger(__name__)

DEFAULT_PORT = 8940

# Quest -> here packet types.
_T_CONFIG = 0
_T_DATA = 1
_T_META = 2


def _port() -> int:
    try:
        return int(os.getenv("theDAW_QUESTSTITCH_PORT") or DEFAULT_PORT)
    except ValueError:
        return DEFAULT_PORT


def _adb_path() -> Optional[str]:
    """Resolve adb the same way questmidi/questcast do, so all three share one adb."""
    return resolve_adb_path(
        "theDAW_QUESTSTITCH_ADB", "theDAW_QUESTMIDI_ADB", "theDAW_ADB"
    )


class _State:
    server: Optional[asyncio.AbstractServer] = None
    quest_peer: Optional[str] = None
    clients: set[WebSocket] = set()
    adb_reverse_ok: bool = False
    started: bool = False
    starting: bool = False
    # Last config packet (already in browser wire format) for late joiners.
    last_config: Optional[bytes] = None
    # Source dimensions reported by the Quest's meta packet.
    width: Optional[int] = None
    height: Optional[int] = None
    fps: Optional[int] = None
    # Rolling counters for diagnostics.
    frames: int = 0
    keyframes: int = 0


_s = _State()


# ---- browser WebSocket clients -----------------------------------------------


def metadata_message() -> str:
    return json.dumps(
        {
            "type": "metadata",
            "codec": "h264",
            "width": _s.width,
            "height": _s.height,
        }
    )


async def add_client(ws: WebSocket) -> None:
    """Register a browser client and prime it with metadata + last config."""
    _s.clients.add(ws)
    try:
        await ws.send_text(metadata_message())
        if _s.last_config is not None:
            await ws.send_bytes(_s.last_config)
    except Exception:  # noqa: BLE001 — client went away immediately
        _s.clients.discard(ws)


def remove_client(ws: WebSocket) -> None:
    _s.clients.discard(ws)


async def _broadcast_bytes(frame: bytes) -> None:
    if not _s.clients:
        return
    dead: list[WebSocket] = []
    for ws in list(_s.clients):
        try:
            await ws.send_bytes(frame)
        except Exception:  # noqa: BLE001
            dead.append(ws)
    for d in dead:
        _s.clients.discard(d)


async def _broadcast_text(msg: str) -> None:
    if not _s.clients:
        return
    dead: list[WebSocket] = []
    for ws in list(_s.clients):
        try:
            await ws.send_text(msg)
        except Exception:  # noqa: BLE001
            dead.append(ws)
    for d in dead:
        _s.clients.discard(d)


# ---- Quest -> browser frame translation --------------------------------------


def _browser_frame(
    packet_type: int, keyframe: int, pts_us: float, payload: bytes
) -> bytes:
    """Pack one H.264 packet into the questcast browser wire format
    ([u8 type][u8 keyframe][6 pad][f64 ptsUs LE][...h264])."""
    header = bytearray(16)
    header[0] = 1 if packet_type == _T_DATA else 0
    header[1] = 1 if keyframe else 0
    struct.pack_into("<d", header, 8, float(pts_us))
    return bytes(header) + payload


async def _on_packet(
    packet_type: int, keyframe: int, pts_us: float, payload: bytes
) -> None:
    if packet_type == _T_META:
        try:
            meta = json.loads(payload.decode("utf-8"))
            _s.width = int(meta.get("w")) if meta.get("w") else _s.width
            _s.height = int(meta.get("h")) if meta.get("h") else _s.height
            _s.fps = int(meta.get("fps")) if meta.get("fps") else _s.fps
        except Exception as e:  # noqa: BLE001
            log.debug("queststitch: bad meta packet: %s", e)
            return
        await _broadcast_text(metadata_message())
        return

    frame = _browser_frame(packet_type, keyframe, pts_us, payload)
    if packet_type == _T_CONFIG:
        _s.last_config = frame
    else:
        _s.frames += 1
        if keyframe:
            _s.keyframes += 1
    await _broadcast_bytes(frame)


# ---- inbound TCP from the Quest ----------------------------------------------


async def _handle_quest(
    reader: asyncio.StreamReader, writer: asyncio.StreamWriter
) -> None:
    peer = writer.get_extra_info("peername")
    _s.quest_peer = str(peer)
    log.info("queststitch: Quest connected %s", peer)
    try:
        while True:
            header = await reader.readexactly(4)
            (body_len,) = struct.unpack("<I", header)
            if body_len < 10 or body_len > 8_000_000:
                log.warning(
                    "queststitch: implausible frame len %d, dropping peer", body_len
                )
                break
            body = await reader.readexactly(body_len)
            packet_type = body[0]
            keyframe = body[1]
            (pts_us,) = struct.unpack_from("<d", body, 2)
            payload = body[10:]
            await _on_packet(packet_type, keyframe, pts_us, payload)
    except asyncio.IncompleteReadError:
        pass  # Quest disconnected mid-frame
    except Exception as e:  # noqa: BLE001
        log.debug("queststitch: quest read error: %s", e)
    finally:
        if _s.quest_peer == str(peer):
            _s.quest_peer = None
            # Keep last_config across a Quest TCP blip: the encoder does not re-emit
            # SPS/PPS on reconnect, so dropping it here would strand a VJ that joins
            # before the streamer's per-keyframe config resend lands. A new config
            # packet overwrites it in _on_packet when the stream genuinely changes.
        try:
            writer.close()
        except Exception:
            pass
        log.info("queststitch: Quest disconnected")


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
        log.info("queststitch: adb reverse failed: %s", e)
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
            "queststitch: listening on 127.0.0.1:%d (adb reverse %s)",
            port,
            "ok" if _s.adb_reverse_ok else "not set",
        )
    except Exception as e:  # noqa: BLE001
        log.warning("queststitch: failed to start: %s", e)
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
    _s.quest_peer = None
    _s.last_config = None


def status() -> dict[str, Any]:
    return {
        "started": _s.started,
        "port": _port(),
        "adb_path": _adb_path(),
        "adb_reverse_ok": _s.adb_reverse_ok,
        "quest_connected": _s.quest_peer is not None,
        "quest_peer": _s.quest_peer,
        "clients": len(_s.clients),
        "width": _s.width,
        "height": _s.height,
        "fps": _s.fps,
        "frames": _s.frames,
        "keyframes": _s.keyframes,
        "have_config": _s.last_config is not None,
    }
