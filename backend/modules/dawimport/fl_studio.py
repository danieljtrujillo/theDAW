"""FL Studio .flp project parser via pyflp.

Uses the pyflp library (pip, demberto) to parse FL Studio project files in
Image-Line's NEM binary format. pyflp exposes a parsed object model through
``pyflp.parse(path)`` (the package has no path-taking ``Project`` constructor).

This parser reaches past the channel rack into patterns, arrangements and the
mixer so it can recover real timeline timing, MIDI notes and effect chains:

* MIDI notes come from ``project.patterns`` (PPQ-based positions/lengths) and
  are attached to the playlist items that reference each pattern, offset to the
  item's timeline position and clamped to the item length.
* Audio clips come from playlist items that reference Sampler channels; the
  on-disk ``sample_path`` becomes the clip ``file_path``.
* Tracks are built from arrangement tracks (real timing). If no arrangement is
  present we fall back to a flat channel-rack mapping.
* Effects come from the mixer: each channel's ``insert`` index is matched to a
  mixer insert, whose slots become the track's devices in signal-chain order.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable
from pathlib import Path
from typing import cast

from backend.modules.dawimport import media
from backend.modules.dawimport.models import DawClip, DawDevice, DawProject, DawTrack

log = logging.getLogger(__name__)

# FL Studio channel pan/volume are unsigned ints 0..12800.
_CH_PAN_CENTER = 6400.0
# Default channel volume; nonlinear knob, 10000 == 0 dB (100%), 12800 == max.
_CH_VOL_DEFAULT = 10000.0


def parse_flp(path: str) -> DawProject:
    """Parse an FL Studio .flp file into a DawProject."""
    file_path = Path(path)
    if not file_path.is_file():
        raise FileNotFoundError(f".flp file not found: {path}")

    try:
        import pyflp
    except ImportError as e:
        raise ImportError(
            "pyflp is required for FL Studio .flp parsing. Install: pip install pyflp"
        ) from e

    flp = pyflp.parse(str(file_path))
    daw = DawProject(source_daw="fl_studio", name=file_path.stem)

    _read_header(flp, daw)

    ppq = _safe_int(getattr(flp, "ppq", None), default=96) or 96
    tempo = daw.tempo or 120.0

    # Index every audio file bundled beside the .flp so samples authored on
    # another machine relink by filename instead of dropping out as missing.
    media_index = media.build_media_index(file_path.parent)

    # Map each channel iid -> info dict we resolve once and reuse across the
    # arrangement / fallback paths.
    channels = _index_channels(flp, daw, media_index)

    # Map insert index -> list[DawDevice] (signal-chain order). Channels route
    # to an insert via Channel.insert (RoutedTo); we attach those devices to the
    # track built from the channel.
    insert_devices = _index_mixer(flp, daw)

    built = False
    try:
        built = _build_from_arrangements(flp, daw, ppq, tempo, channels, insert_devices)
    except Exception as e:  # noqa: BLE001 - never raise on malformed arrangement data
        daw.warnings.append(f"Error reading arrangements, falling back to rack: {e}")

    if not built:
        try:
            _build_from_rack(daw, channels, insert_devices)
        except Exception as e:  # noqa: BLE001
            daw.warnings.append(f"Error building fallback tracks from rack: {e}")

    daw.plugins_used = sorted(
        {
            dev.name
            for trk in daw.tracks
            for dev in trk.devices
            if dev.plugin_type == "vst3" and dev.name
        }
    )
    return daw


# --------------------------------------------------------------------------- #
# Header / project-level fields
# --------------------------------------------------------------------------- #


def _read_header(flp: object, daw: DawProject) -> None:
    title = _safe_attr(flp, "title")
    if isinstance(title, str) and title:
        daw.name = title

    version = _safe_attr(flp, "version")
    if version is not None:
        try:
            daw.source_version = str(version)
        except Exception:  # noqa: BLE001
            pass

    tempo = _safe_attr(flp, "tempo")
    if tempo is not None:
        try:
            daw.tempo = float(cast("str | float | int", tempo))
        except (TypeError, ValueError):
            daw.warnings.append("Could not read project tempo; defaulting to 120.")

    # Time signature lives on arrangements.time_signature in pyflp.
    try:
        arrs = _safe_attr(flp, "arrangements")
        ts = getattr(arrs, "time_signature", None) if arrs is not None else None
        if ts is not None:
            num = _safe_int(getattr(ts, "num", None))
            beat = _safe_int(getattr(ts, "beat", None))
            if num and beat:
                daw.time_signature = (num, beat)
    except Exception:  # noqa: BLE001
        pass


# --------------------------------------------------------------------------- #
# Channels
# --------------------------------------------------------------------------- #


def _index_channels(
    flp: object, daw: DawProject, media_index: dict[str, str]
) -> dict[int, dict]:
    """Build iid -> channel-info dict for samplers and instruments.

    Each entry: ``{"name", "type", "sample_path", "device", "volume_db",
    "pan", "mute", "color", "insert"}``.
    """
    from pyflp.channel import Instrument, Sampler

    out: dict[int, dict] = {}
    channels = _safe_attr(flp, "channels")
    if channels is None:
        daw.warnings.append("Project has no channel rack.")
        return out

    try:
        iterator = list(cast("Iterable[object]", channels))
    except Exception as e:  # noqa: BLE001
        daw.warnings.append(f"Could not iterate channel rack: {e}")
        return out

    for ch in iterator:
        try:
            iid = _safe_int(getattr(ch, "iid", None))
            if iid is None:
                continue
            name = (
                _safe_attr(ch, "display_name")
                or _safe_attr(ch, "name")
                or f"Channel {iid}"
            )
            info: dict = {
                "name": str(name),
                "type": "midi",
                "sample_path": None,
                "device": None,
                "volume_db": _channel_volume_db(ch),
                "pan": _norm_channel_pan(getattr(ch, "pan", None)),
                "mute": not bool(_safe_attr(ch, "enabled", default=True)),
                "color": _color_hex(getattr(ch, "color", None)),
                "insert": _safe_int(getattr(ch, "insert", None)),
            }

            if isinstance(ch, Sampler):
                info["type"] = "audio"
                sp = _safe_attr(ch, "sample_path")
                if sp is not None:
                    sp_str = str(sp)
                    if sp_str and sp_str != ".":
                        if "%FLStudioFactoryData%" in sp_str:
                            # Factory sample: keep the token path, skip relink.
                            info["sample_path"] = sp_str
                        else:
                            info["sample_path"] = media.resolve_audio(
                                [sp_str],
                                Path(sp_str).name,
                                media_index,
                                daw.missing_files,
                            )
            elif isinstance(ch, Instrument):
                info["type"] = "midi"
                info["device"] = _device_from_channel_plugin(ch, str(name))

            out[iid] = info
        except Exception as e:  # noqa: BLE001
            daw.warnings.append(f"Skipped a channel due to parse error: {e}")
    return out


def _device_from_channel_plugin(ch: object, fallback_name: str) -> DawDevice | None:
    """Build a DawDevice for an Instrument channel's generator plugin."""
    from pyflp.plugin import VSTPlugin

    plugin = _safe_attr(ch, "plugin")
    if plugin is None:
        return None

    if isinstance(plugin, VSTPlugin):
        name = _safe_attr(plugin, "name") or fallback_name
        ppath = _safe_attr(plugin, "plugin_path")
        return DawDevice(
            name=str(name),
            plugin_type="vst3",
            plugin_path=str(ppath) if ppath else None,
            parameters=_vst_params(plugin),
            bypass=False,
            state=_b64_state(_safe_attr(plugin, "state")),
        )

    # Native FL generator (BooBass, Plucked, FruitKick, ...) or a wrapper we
    # could not type. Use the channel's internal/display name as the device name.
    name = (
        _safe_attr(ch, "internal_name")
        or _safe_attr(ch, "display_name")
        or fallback_name
    )
    return DawDevice(name=str(name), plugin_type="builtin")


def _channel_volume_db(ch: object) -> float:
    """Convert FL channel volume (0..12800, nonlinear, 10000==0 dB) to dB."""
    import math

    raw = _safe_int(getattr(ch, "volume", None))
    if raw is None:
        return 0.0
    if raw <= 0:
        return -120.0
    # Best-effort: treat 10000 as unity (0 dB) and scale linearly in amplitude.
    gain = raw / _CH_VOL_DEFAULT
    try:
        return round(20.0 * math.log10(gain), 2)
    except ValueError:
        return -120.0


# --------------------------------------------------------------------------- #
# Mixer / effects
# --------------------------------------------------------------------------- #


def _index_mixer(flp: object, daw: DawProject) -> dict[int, list[DawDevice]]:
    """Build insert-index -> list[DawDevice] for every mixer insert.

    The key matches ``Channel.insert`` semantics: 0 == master, 1..N user
    inserts (pyflp exposes ``Insert.iid`` as -1 for "current", 0 for master,
    counting up from there).
    """
    out: dict[int, list[DawDevice]] = {}
    mixer = _safe_attr(flp, "mixer")
    if mixer is None:
        return out

    try:
        inserts = list(cast("Iterable[object]", mixer))
    except Exception as e:  # noqa: BLE001
        daw.warnings.append(f"Could not iterate mixer inserts: {e}")
        return out

    for insert in inserts:
        try:
            iid = _safe_int(getattr(insert, "iid", None))
            if iid is None:
                continue
            insert_bypassed = bool(_safe_attr(insert, "bypassed", default=False))
            devices: list[DawDevice] = []
            try:
                slots = list(cast("Iterable[object]", insert))
            except Exception:  # noqa: BLE001
                slots = []
            for slot in slots:
                dev = _device_from_slot(slot, insert_bypassed)
                if dev is not None:
                    devices.append(dev)
            if devices:
                out[iid] = devices
        except Exception as e:  # noqa: BLE001
            daw.warnings.append(f"Skipped a mixer insert due to parse error: {e}")
    return out


def _device_from_slot(slot: object, insert_bypassed: bool) -> DawDevice | None:
    """Build a DawDevice from a mixer effect slot (None for empty slots)."""
    from pyflp.plugin import VSTPlugin

    plugin = _safe_attr(slot, "plugin")
    if plugin is None:
        return None

    slot_enabled = _safe_attr(slot, "enabled")
    # ``enabled`` may be None when no mixer-params event exists; treat as on.
    enabled = True if slot_enabled is None else bool(slot_enabled)
    bypass = insert_bypassed or not enabled

    if isinstance(plugin, VSTPlugin):
        name = _safe_attr(plugin, "name") or _safe_attr(slot, "name") or "VST Effect"
        ppath = _safe_attr(plugin, "plugin_path")
        return DawDevice(
            name=str(name),
            plugin_type="vst3",
            plugin_path=str(ppath) if ppath else None,
            parameters=_vst_params(plugin),
            bypass=bypass,
            state=_b64_state(_safe_attr(plugin, "state")),
        )

    # Native FL effect (Fruity Reverb 2, Fruity Balance, Soundgoodizer, ...).
    name = _safe_attr(slot, "name") or _safe_attr(slot, "internal_name") or "Effect"
    return DawDevice(
        name=str(name),
        plugin_type="builtin",
        parameters=_native_params(plugin),
        bypass=bypass,
    )


def _vst_params(plugin: object) -> dict[str, float]:
    """Best-effort numeric params for a VST plugin (mostly MIDI/IO knobs)."""
    params: dict[str, float] = {}
    midi = _safe_attr(plugin, "midi")
    if midi is not None:
        for key in ("input", "output", "pb_range"):
            val = _safe_int(getattr(midi, key, None))
            if val is not None:
                params[f"midi_{key}"] = float(val)
    return params


def _native_params(plugin: object) -> dict[str, float]:
    """Best-effort numeric params snapshot for a native FL plugin."""
    params: dict[str, float] = {}
    candidate_attrs = (
        "volume",
        "pan",
        "pre",
        "post",
        "mix",
        "threshold",
        "amount",
        "pre_amp",
        "pre_band",
        "post_gain",
        "post_filter",
        "color",
        "dry",
        "decay",
        "bass",
        "mid",
        "high",
        "stereo_separation",
        "phase_offset",
        "send_to",
    )
    for attr in candidate_attrs:
        if not hasattr(plugin, attr):
            continue
        val = _safe_attr(plugin, attr)
        if isinstance(val, bool):
            params[attr] = 1.0 if val else 0.0
        elif isinstance(val, (int, float)):
            params[attr] = float(val)
    return params


# --------------------------------------------------------------------------- #
# Patterns (MIDI notes)
# --------------------------------------------------------------------------- #


def _index_patterns(
    flp: object, daw: DawProject, ppq: int, tempo: float
) -> dict[int, dict]:
    """Build pattern-iid -> ``{"name", "notes"}`` where notes are clip-relative.

    Each note dict is shaped ``{"pitch", "start", "duration", "velocity"}`` with
    ``start``/``duration`` in SECONDS relative to the pattern's own zero, and
    pitch/velocity clamped to MIDI range.
    """
    out: dict[int, dict] = {}
    patterns = _safe_attr(flp, "patterns")
    if patterns is None:
        return out

    try:
        plist = list(cast("Iterable[object]", patterns))
    except Exception as e:  # noqa: BLE001
        daw.warnings.append(f"Could not iterate patterns: {e}")
        return out

    for pat in plist:
        try:
            iid = _safe_int(getattr(pat, "iid", None))
            if iid is None:
                continue
            notes: list[dict] = []
            try:
                note_iter = list(getattr(pat, "notes", []) or [])
            except Exception:  # noqa: BLE001
                note_iter = []
            for note in note_iter:
                nd = _note_to_dict(note, ppq, tempo)
                if nd is not None:
                    notes.append(nd)
            out[iid] = {
                "name": _safe_attr(pat, "name") or f"Pattern {iid}",
                "notes": notes,
            }
        except Exception as e:  # noqa: BLE001
            daw.warnings.append(f"Skipped a pattern due to parse error: {e}")
    return out


def _note_to_dict(note: object, ppq: int, tempo: float) -> dict | None:
    """Convert a pyflp Note into the shared clip-relative note dict."""
    try:
        # Note.key is a string ("C5"); the raw 0-131 int is in the item mapping.
        pitch_raw = None
        try:
            pitch_raw = note["key"]  # type: ignore[index]
        except Exception:  # noqa: BLE001
            pitch_raw = None
        if pitch_raw is None:
            return None
        pitch = int(pitch_raw)
        # FL keys are 0..131 (C0..B10); MIDI is 0..127. Clamp to MIDI range.
        pitch = max(0, min(127, pitch))

        pos_ticks = _safe_int(getattr(note, "position", None), default=0) or 0
        len_ticks = _safe_int(getattr(note, "length", None), default=0) or 0
        vel = _safe_int(getattr(note, "velocity", None), default=100) or 100
        # FL velocity range is 0..128; clamp to MIDI 1..127.
        vel = max(1, min(127, vel))

        start = _ticks_to_sec(pos_ticks, ppq, tempo)
        duration = _ticks_to_sec(len_ticks, ppq, tempo)
        if duration <= 0.0:
            # Step-sequencer notes report length 0; give them a short default.
            duration = _ticks_to_sec(ppq // 4 or 1, ppq, tempo)

        return {
            "pitch": pitch,
            "start": round(start, 6),
            "duration": round(duration, 6),
            "velocity": vel,
        }
    except Exception:  # noqa: BLE001
        return None


# --------------------------------------------------------------------------- #
# Arrangement / timeline build
# --------------------------------------------------------------------------- #


def _build_from_arrangements(
    flp: object,
    daw: DawProject,
    ppq: int,
    tempo: float,
    channels: dict[int, dict],
    insert_devices: dict[int, list[DawDevice]],
) -> bool:
    """Build DawTracks from arrangement tracks (real timeline timing).

    Returns ``True`` if at least one track was produced.
    """
    from pyflp.arrangement import ChannelPLItem, PatternPLItem

    arrs = _safe_attr(flp, "arrangements")
    if arrs is None:
        return False

    patterns = _index_patterns(flp, daw, ppq, tempo)

    try:
        arr_list = list(cast("Iterable[object]", arrs))
    except Exception as e:  # noqa: BLE001
        daw.warnings.append(f"Could not iterate arrangements: {e}")
        return False

    produced = 0
    for arr in arr_list:
        try:
            arr_name = _safe_attr(arr, "name") or "Arrangement"
            tracks = list(getattr(arr, "tracks", []) or [])
        except Exception as e:  # noqa: BLE001
            daw.warnings.append(f"Could not read tracks for an arrangement: {e}")
            continue

        for t_idx, track in enumerate(tracks):
            try:
                items = list(track)
            except Exception:  # noqa: BLE001
                items = []
            if not items:
                continue

            clips: list[DawClip] = []
            track_type = "audio"
            track_inserts: set[int] = set()
            used_channel_devices: list[DawDevice] = []
            saw_midi = False
            saw_audio = False

            for item in items:
                try:
                    pos_ticks = (
                        _safe_int(getattr(item, "position", None), default=0) or 0
                    )
                    len_ticks = _safe_int(getattr(item, "length", None), default=0) or 0
                    start = _ticks_to_sec(pos_ticks, ppq, tempo)
                    end = start + _ticks_to_sec(len_ticks, ppq, tempo)

                    if isinstance(item, ChannelPLItem):
                        clip = _audio_clip_from_item(
                            item,
                            channels,
                            start,
                            end,
                            track_inserts,
                            used_channel_devices,
                        )
                        if clip is not None:
                            clips.append(clip)
                            saw_audio = True
                    elif isinstance(item, PatternPLItem):
                        clip = _midi_clip_from_item(
                            item,
                            patterns,
                            ppq,
                            tempo,
                            start,
                            end,
                        )
                        if clip is not None:
                            clips.append(clip)
                            saw_midi = True
                except Exception as e:  # noqa: BLE001
                    daw.warnings.append(f"Skipped a playlist item: {e}")

            if not clips:
                continue

            if saw_midi and not saw_audio:
                track_type = "midi"
            elif saw_audio and not saw_midi:
                track_type = "audio"
            else:
                track_type = "midi" if saw_midi else "audio"

            devices = _collect_track_devices(
                track_inserts, insert_devices, used_channel_devices
            )

            name = _safe_attr(track, "name")
            if not name:
                name = f"{arr_name} Track {t_idx + 1}"

            daw.tracks.append(
                DawTrack(
                    name=str(name),
                    type=track_type,
                    color=_color_hex(getattr(track, "color", None)),
                    mute=not bool(_safe_attr(track, "enabled", default=True)),
                    clips=clips,
                    devices=devices,
                )
            )
            produced += 1

    return produced > 0


def _audio_clip_from_item(
    item: object,
    channels: dict[int, dict],
    start: float,
    end: float,
    track_inserts: set[int],
    used_channel_devices: list[DawDevice],
) -> DawClip | None:
    """Build an audio (or generator) clip from a ChannelPLItem."""
    ch = _safe_attr(item, "channel")
    iid = _safe_int(getattr(ch, "iid", None)) if ch is not None else None
    info = channels.get(iid) if iid is not None else None

    name = "Audio Clip"
    file_path = None
    midi_notes = None
    if info is not None:
        name = info.get("name") or name
        file_path = info.get("sample_path")
        ins = info.get("insert")
        if ins is not None:
            track_inserts.add(ins)
        dev = info.get("device")
        if dev is not None and dev not in used_channel_devices:
            used_channel_devices.append(dev)

    return DawClip(
        name=str(name),
        start_time=round(start, 6),
        end_time=round(end, 6),
        file_path=file_path,
        midi_notes=midi_notes,
    )


def _midi_clip_from_item(
    item: object,
    patterns: dict[int, dict],
    ppq: int,
    tempo: float,
    start: float,
    end: float,
) -> DawClip | None:
    """Build a MIDI clip from a PatternPLItem.

    Notes are stored clip-relative. ``offsets`` (start, end) trim the visible
    region of the pattern; we shift notes by the start offset and keep notes
    that fall within the item length.
    """
    pat = _safe_attr(item, "pattern")
    pat_iid = _safe_int(getattr(pat, "iid", None)) if pat is not None else None
    pinfo = patterns.get(pat_iid) if pat_iid is not None else None

    name = "Pattern"
    src_notes: list[dict] = []
    if pinfo is not None:
        name = pinfo.get("name") or name
        src_notes = pinfo.get("notes") or []

    # offsets are in PPQ ticks (start, end) measured from the pattern start.
    start_off_sec = 0.0
    try:
        offsets = _safe_attr(item, "offsets")
        if offsets and isinstance(offsets, (tuple, list)) and len(offsets) >= 1:
            start_off_ticks = float(offsets[0]) if offsets[0] is not None else 0.0
            start_off_sec = _ticks_to_sec(start_off_ticks, ppq, tempo)
    except Exception:  # noqa: BLE001
        start_off_sec = 0.0

    clip_len_sec = end - start
    notes_out: list[dict] = []
    for nd in src_notes:
        try:
            rel = nd["start"] - start_off_sec
            if rel < -1e-6:
                continue
            if clip_len_sec > 0 and rel > clip_len_sec + 1e-6:
                continue
            notes_out.append(
                {
                    "pitch": nd["pitch"],
                    "start": round(max(0.0, rel), 6),
                    "duration": nd["duration"],
                    "velocity": nd["velocity"],
                }
            )
        except Exception:  # noqa: BLE001
            continue

    return DawClip(
        name=str(name),
        start_time=round(start, 6),
        end_time=round(end, 6),
        midi_notes=notes_out,
    )


def _collect_track_devices(
    track_inserts: set[int],
    insert_devices: dict[int, list[DawDevice]],
    channel_devices: list[DawDevice],
) -> list[DawDevice]:
    """Combine generator devices and mixer-insert effects for one track."""
    devices: list[DawDevice] = list(channel_devices)
    for ins in sorted(track_inserts):
        for dev in insert_devices.get(ins, []):
            devices.append(dev)
    return devices


# --------------------------------------------------------------------------- #
# Fallback: flat channel-rack mapping (no arrangement timing)
# --------------------------------------------------------------------------- #


def _build_from_rack(
    daw: DawProject,
    channels: dict[int, dict],
    insert_devices: dict[int, list[DawDevice]],
) -> None:
    """Map each channel to a DawTrack when no arrangement timing is available."""
    if not channels:
        daw.warnings.append("No channels and no arrangement timing; project is empty.")
        return

    for info in channels.values():
        clips: list[DawClip] = []
        devices: list[DawDevice] = []

        dev = info.get("device")
        if dev is not None:
            devices.append(dev)
        ins = info.get("insert")
        if ins is not None:
            devices.extend(insert_devices.get(ins, []))

        if info.get("type") == "audio" and info.get("sample_path"):
            clips.append(
                DawClip(
                    name=info["name"],
                    start_time=0.0,
                    end_time=0.0,
                    file_path=info["sample_path"],
                )
            )

        daw.tracks.append(
            DawTrack(
                name=info["name"],
                type=info.get("type", "midi"),
                volume_db=info.get("volume_db", 0.0),
                pan=info.get("pan", 0.0),
                mute=info.get("mute", False),
                color=info.get("color"),
                clips=clips,
                devices=devices,
            )
        )


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _ticks_to_sec(ticks: float, ppq: int, tempo: float) -> float:
    """Convert PPQ ticks to seconds: sec = ticks / PPQ * 60 / tempo."""
    if ppq <= 0 or tempo <= 0:
        return 0.0
    return float(ticks) / float(ppq) * 60.0 / float(tempo)


def _norm_channel_pan(value: object) -> float:
    """Normalise FL channel pan (0..12800, centre 6400) to -1..1."""
    v = _safe_int(value)
    if v is None:
        return 0.0
    return max(-1.0, min(1.0, (v - _CH_PAN_CENTER) / _CH_PAN_CENTER))


def _color_hex(value: object) -> str | None:
    """Convert a pyflp RGBA color to a #rrggbb hex string."""
    if value is None:
        return None
    try:
        r = int(getattr(value, "red"))
        g = int(getattr(value, "green"))
        b = int(getattr(value, "blue"))
        return f"#{r:02x}{g:02x}{b:02x}"
    except Exception:  # noqa: BLE001
        return None


def _b64_state(value: object) -> str | None:
    """Encode an opaque plugin-state blob as base64, if present and bytes."""
    if not isinstance(value, (bytes, bytearray)):
        return None
    if not value:
        return None
    try:
        import base64

        return base64.b64encode(bytes(value)).decode("ascii")
    except Exception:  # noqa: BLE001
        return None


def _safe_attr(obj: object, name: str, default: object = None) -> object:
    """getattr that swallows pyflp descriptor exceptions (AttributeError/KeyError)."""
    try:
        val = getattr(obj, name, default)
        return val
    except Exception:  # noqa: BLE001
        return default


def _safe_int(value: object, default: int | None = None) -> int | None:
    if value is None:
        return default
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default
