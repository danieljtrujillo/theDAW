"""Reaper .RPP project parser via reaproj.

Uses the reaproj library (pip) for object-model parsing of .RPP files. reaproj's
high-level API only exposes a thin slice (track name, item position/length/source
path), so this parser drops down to the raw ``rpp.Element`` tree exposed on
``Track.element`` / ``Item.element`` to recover MIDI notes, real audio-clip
timing, track mix params, and the full effect/device chain.

If reaproj is not installed a minimal regex fallback reads track names only.

Timing convention (shared by all DAW importers): ``DawClip.start_time`` /
``end_time`` are SECONDS on the project timeline. REAPER item POSITION/LENGTH
are already in seconds, so no conversion is needed. MIDI ``E`` lines carry delta
ticks; ticks are converted to seconds via the source ticks-per-quarter-note and
the project tempo (sec = ticks / tpqn * 60 / tempo). MIDI note ``start`` is
relative to the clip.
"""

from __future__ import annotations

import logging
import math
from pathlib import Path

from backend.modules.dawimport import media
from backend.modules.dawimport.models import (
    DawClip,
    DawDevice,
    DawLocator,
    DawProject,
    DawTrack,
)

log = logging.getLogger(__name__)

_DEFAULT_TPQN = 960
_AUDIO_SOURCE_TYPES = {"WAVE", "FLAC", "MP3", "AIFF", "OGG", "WAVPACK", "VORBIS"}


def parse_rpp(path: str) -> DawProject:
    """Parse a Reaper .RPP file into a DawProject."""
    file_path = Path(path)
    if not file_path.is_file():
        raise FileNotFoundError(f".RPP file not found: {path}")

    try:
        from reaproj import Project
    except ImportError:
        log.warning("reaproj not installed; falling back to minimal RPP parser")
        return _parse_rpp_minimal(path)

    daw = DawProject(source_daw="reaper", name=file_path.stem)

    try:
        project = Project.load(str(file_path))
    except Exception as e:  # noqa: BLE001 - never raise on a malformed file
        log.warning("reaproj failed to load %s: %s; using minimal parser", path, e)
        minimal = _parse_rpp_minimal(path)
        minimal.warnings.append(f"reaproj load failed ({e}); parsed track names only")
        return minimal

    root = project.element

    # --- project meta -----------------------------------------------------
    daw.source_version = _attrib_str(root, 1)
    daw.tempo = _project_tempo(root, daw)
    daw.time_signature = _project_time_sig(root, daw.time_signature)
    daw.sample_rate = _project_sample_rate(root, daw.sample_rate)

    plugins_seen: list[str] = []

    # Index the project folder so samples authored on another machine relink by
    # filename to the copy bundled alongside the .RPP.
    media_index = media.build_media_index(file_path.parent)

    # --- tracks -----------------------------------------------------------
    for track in project.tracks:
        try:
            daw.tracks.append(
                _parse_track(track, project, daw, plugins_seen, media_index)
            )
        except Exception as e:  # noqa: BLE001
            daw.warnings.append(f"Failed to parse a track: {e}")

    daw.plugins_used = plugins_seen

    # --- markers + regions as locators ------------------------------------
    try:
        for region in getattr(project, "regions", []):
            daw.locators.append(
                DawLocator(
                    name=str(getattr(region, "name", "") or ""),
                    position=_safe_float(getattr(region, "start", 0.0), 0.0),
                )
            )
        for marker in getattr(project, "markers", []):
            daw.locators.append(
                DawLocator(
                    name=str(getattr(marker, "name", "") or ""),
                    position=_safe_float(getattr(marker, "position", 0.0), 0.0),
                )
            )
    except Exception as e:  # noqa: BLE001
        daw.warnings.append(f"Failed to parse markers/regions: {e}")

    return daw


# ---------------------------------------------------------------------------
# Track / item parsing
# ---------------------------------------------------------------------------


def _parse_track(
    track,
    project,
    daw: DawProject,
    plugins_seen: list[str],
    media_index: dict[str, str],
) -> DawTrack:
    el = getattr(track, "element", None)
    name = (getattr(track, "name", "") or "").strip() or "Track"

    volume_db = 0.0
    pan = 0.0
    mute = False
    solo = False
    color = None
    is_midi = False

    if el is not None:
        volpan = _leaf(el, "VOLPAN")
        if volpan is not None:
            vol_lin = _tok_float(volpan, 1, 1.0)
            volume_db = _linear_to_db(vol_lin)
            pan = max(-1.0, min(1.0, _tok_float(volpan, 2, 0.0)))

        mutesolo = _leaf(el, "MUTESOLO")
        if mutesolo is not None:
            mute = _tok_float(mutesolo, 1, 0.0) != 0.0
            solo = _tok_float(mutesolo, 2, 0.0) != 0.0

        peakcol = _leaf(el, "PEAKCOL")
        if peakcol is not None:
            color = _reaper_color_to_hex(peakcol[1] if len(peakcol) > 1 else None)

    clips: list[DawClip] = []
    items = getattr(track, "items", []) or []
    for item in items:
        try:
            clip, clip_is_midi = _parse_item(item, project, daw, media_index)
            if clip is not None:
                clips.append(clip)
                is_midi = is_midi or clip_is_midi
        except Exception as e:  # noqa: BLE001
            daw.warnings.append(f"Failed to parse item on track '{name}': {e}")

    devices: list[DawDevice] = []
    if el is not None:
        fxchain = el.find("FXCHAIN")
        if fxchain is not None:
            devices = _parse_fxchain(fxchain, plugins_seen)

    return DawTrack(
        name=name,
        type="midi" if is_midi else "audio",
        volume_db=volume_db,
        pan=pan,
        mute=mute,
        solo=solo,
        color=color,
        clips=clips,
        devices=devices,
    )


def _parse_item(item, project, daw: DawProject, media_index: dict[str, str]):
    """Return (DawClip | None, is_midi). Timing is in timeline seconds."""
    el = getattr(item, "element", None)

    position = _safe_float(getattr(item, "position", None), 0.0)
    length = _safe_float(getattr(item, "length", None), 0.0)
    soffs = _safe_float(getattr(item, "soffs", None), 0.0)

    name = "Item"
    file_path = None
    midi_notes = None
    is_midi = False

    if el is not None:
        name_leaf = _leaf(el, "NAME")
        if name_leaf is not None and len(name_leaf) > 1:
            name = name_leaf[1] or name

        source = el.find("SOURCE")
        if source is not None:
            src_type = _attrib_str(source, 0).upper()
            if src_type == "MIDI" or src_type == "MIDIPOOL":
                is_midi = True
                midi_notes = _parse_midi_notes(source, daw.tempo)
            elif src_type in _AUDIO_SOURCE_TYPES or src_type == "":
                file_path = _resolve_audio_path(item, source, project, daw, media_index)
            else:
                # Unknown source type (e.g. video / sub-project). Try a file path.
                file_path = _resolve_audio_path(item, source, project, daw, media_index)

    clip = DawClip(
        name=name,
        start_time=position,
        end_time=position + length,
        file_path=file_path,
        midi_notes=midi_notes,
    )
    # soffs is the in-source start offset; surface it as loop_start for callers
    # that care about trim, without affecting timeline placement.
    if soffs:
        clip.loop_start = soffs
    return clip, is_midi


def _resolve_audio_path(item, source, project, daw: DawProject, media_index):
    """Resolve the on-disk sample path, relinking by filename when the stored
    absolute path is from another machine. Misses go to project.missing_files."""
    candidates: list[str | None] = []
    name = None

    # Prefer reaproj's resolver (handles project-relative paths).
    try:
        sp = getattr(item, "source_path", None)
        if sp is not None:
            candidates.append(str(Path(sp)))
    except Exception:  # noqa: BLE001
        pass

    file_leaf = _leaf(source, "FILE")
    if file_leaf is not None and len(file_leaf) > 1 and file_leaf[1]:
        raw = Path(file_leaf[1])
        name = raw.name
        try:
            candidates.append(str(project.resolve(raw)))
        except Exception:  # noqa: BLE001
            candidates.append(str(raw))

    if not [c for c in candidates if c]:
        return None

    return media.resolve_audio(candidates, name, media_index, daw.missing_files)


# ---------------------------------------------------------------------------
# MIDI note extraction
# ---------------------------------------------------------------------------


def _parse_midi_notes(source, tempo: float) -> list[dict]:
    """Decode REAPER inline MIDI ``E``/``e`` event lines into note dicts.

    Each event line is ``["E", delta_ticks, status_hex, note_hex, vel_hex]``.
    Delta ticks accumulate. Status 0x9n with velocity > 0 is note-on; 0x8n, or
    0x9n with velocity 0, is note-off. Notes are paired by (channel, pitch).
    Times are seconds relative to the clip start.
    """
    tpqn = _DEFAULT_TPQN
    hasdata = _leaf(source, "HASDATA")
    if hasdata is not None and len(hasdata) > 2:
        try:
            cand = int(hasdata[2])
            if cand > 0:
                tpqn = cand
        except (ValueError, TypeError):
            pass

    safe_tempo = tempo if tempo and tempo > 0 else 120.0
    sec_per_tick = 60.0 / safe_tempo / float(tpqn)

    notes: list[dict] = []
    open_notes: dict[tuple[int, int], tuple[float, int]] = {}
    abs_ticks = 0

    for child in source:
        if not isinstance(child, list) or not child:
            continue
        tag = child[0]
        if tag not in ("E", "e"):
            continue
        if len(child) < 5:
            continue
        try:
            delta = int(child[1])
            status = int(child[2], 16)
            data1 = int(child[3], 16)
            data2 = int(child[4], 16)
        except (ValueError, TypeError):
            continue

        abs_ticks += delta
        msg = status & 0xF0
        channel = status & 0x0F

        if msg == 0x90 and data2 > 0:
            # note-on
            open_notes[(channel, data1)] = (abs_ticks * sec_per_tick, data2)
        elif msg == 0x80 or (msg == 0x90 and data2 == 0):
            # note-off
            key = (channel, data1)
            start_info = open_notes.pop(key, None)
            if start_info is None:
                continue
            start_sec, velocity = start_info
            end_sec = abs_ticks * sec_per_tick
            duration = max(0.0, end_sec - start_sec)
            notes.append(
                {
                    "pitch": int(max(0, min(127, data1))),
                    "start": float(start_sec),
                    "duration": float(duration),
                    "velocity": int(max(1, min(127, velocity))),
                }
            )

    # Any still-open notes (missing note-off) get a zero-length tail.
    for (_channel, pitch), (start_sec, velocity) in open_notes.items():
        notes.append(
            {
                "pitch": int(max(0, min(127, pitch))),
                "start": float(start_sec),
                "duration": 0.0,
                "velocity": int(max(1, min(127, velocity))),
            }
        )

    notes.sort(key=lambda n: (n["start"], n["pitch"]))
    return notes


# ---------------------------------------------------------------------------
# Effect / device chain
# ---------------------------------------------------------------------------


def _parse_fxchain(fxchain, plugins_seen: list[str]) -> list[DawDevice]:
    """Walk an FXCHAIN element, preserving signal-chain order.

    A ``BYPASS <on> <wet> <auto>`` leaf precedes each effect block. The first
    BYPASS token is 0 (active) or 1 (bypassed).
    """
    devices: list[DawDevice] = []
    pending_bypass = False

    for child in fxchain:
        if isinstance(child, list) and child:
            if child[0] == "BYPASS":
                # BYPASS applies to the NEXT fx block.
                pending_bypass = _tok_float(child, 1, 0.0) != 0.0
            continue

        tag_attr = getattr(child, "tag", None)
        tag = str(tag_attr) if tag_attr is not None else ""
        device = None
        if tag == "VST":
            device = _parse_vst(child, pending_bypass)
        elif tag == "JS":
            device = _parse_js(child, pending_bypass)
        elif tag == "AU":
            device = _parse_au(child, pending_bypass)
        elif tag in ("CLAP", "LV2", "DX"):
            device = _parse_generic_fx(child, tag, pending_bypass)

        if device is not None:
            devices.append(device)
            if device.name not in plugins_seen:
                plugins_seen.append(device.name)
            pending_bypass = False

    return devices


def _parse_vst(el, bypass: bool) -> DawDevice:
    """``<VST "display" dll/vst3 0 "" id "">`` followed by an opaque chunk."""
    attrib = list(getattr(el, "attrib", []) or [])
    display = attrib[0] if attrib else "VST"
    dll = attrib[1] if len(attrib) > 1 else ""
    name = _clean_vst_name(display)

    plugin_type = "audiounit" if _is_au_name(display) else "vst3"
    plugin_path = dll if dll else None

    state = _capture_fx_state(el)

    return DawDevice(
        name=name,
        plugin_type=plugin_type,
        plugin_path=plugin_path,
        parameters={},
        bypass=bypass,
        state=state,
    )


def _parse_js(el, bypass: bool) -> DawDevice:
    """JesuSonic / stock-script effect -> builtin."""
    attrib = list(getattr(el, "attrib", []) or [])
    script = attrib[0] if attrib else "JS"
    name = _js_display_name(script)
    return DawDevice(
        name=name,
        plugin_type="builtin",
        plugin_path=None,
        parameters={},
        bypass=bypass,
        state=None,
    )


def _parse_au(el, bypass: bool) -> DawDevice:
    attrib = list(getattr(el, "attrib", []) or [])
    display = attrib[0] if attrib else "AU"
    name = _clean_vst_name(display)
    return DawDevice(
        name=name,
        plugin_type="audiounit",
        plugin_path=attrib[1] if len(attrib) > 1 and attrib[1] else None,
        parameters={},
        bypass=bypass,
        state=_capture_fx_state(el),
    )


def _parse_generic_fx(el, tag: str, bypass: bool) -> DawDevice:
    attrib = list(getattr(el, "attrib", []) or [])
    display = attrib[0] if attrib else tag
    name = _clean_vst_name(display)
    return DawDevice(
        name=name,
        plugin_type="vst3",
        plugin_path=attrib[1] if len(attrib) > 1 and attrib[1] else None,
        parameters={},
        bypass=bypass,
        state=_capture_fx_state(el),
    )


def _capture_fx_state(el) -> str | None:
    """Concatenate the opaque base64 chunk lines inside an fx block (best-effort)."""
    chunks: list[str] = []
    for child in el:
        if isinstance(child, str):
            chunks.append(child.strip())
        elif isinstance(child, list) and len(child) == 1 and isinstance(child[0], str):
            chunks.append(child[0].strip())
    payload = "".join(c for c in chunks if c)
    return payload or None


# ---------------------------------------------------------------------------
# Project-level leaf helpers
# ---------------------------------------------------------------------------


def _project_tempo(root, daw: DawProject) -> float:
    tempo_leaf = _leaf(root, "TEMPO")
    if tempo_leaf is not None and len(tempo_leaf) > 1:
        try:
            t = float(tempo_leaf[1])
            if t > 0:
                return t
        except (ValueError, TypeError):
            daw.warnings.append("Could not parse TEMPO; defaulting to 120 BPM")
    return 120.0


def _project_time_sig(root, default: tuple[int, int]) -> tuple[int, int]:
    tempo_leaf = _leaf(root, "TEMPO")
    if tempo_leaf is not None and len(tempo_leaf) > 3:
        try:
            num = int(float(tempo_leaf[2]))
            den = int(float(tempo_leaf[3]))
            if num > 0 and den > 0:
                return (num, den)
        except (ValueError, TypeError):
            pass
    return default


def _project_sample_rate(root, default: int) -> int:
    sr_leaf = _leaf(root, "SAMPLERATE")
    if sr_leaf is not None and len(sr_leaf) > 1:
        try:
            sr = int(float(sr_leaf[1]))
            if sr > 0:
                return sr
        except (ValueError, TypeError):
            pass
    return default


# ---------------------------------------------------------------------------
# Generic tree / conversion helpers
# ---------------------------------------------------------------------------


def _leaf(element, key):
    """Return the first leaf list ``[key, ...]`` directly under ``element``."""
    try:
        for child in element:
            if isinstance(child, list) and child and child[0] == key:
                return child
    except TypeError:
        return None
    return None


def _attrib_str(element, index: int) -> str:
    attrib = getattr(element, "attrib", None)
    if attrib is None:
        return ""
    try:
        return str(attrib[index])
    except (IndexError, TypeError):
        return ""


def _tok_float(tokens, index: int, default: float) -> float:
    try:
        return float(tokens[index])
    except (IndexError, ValueError, TypeError):
        return default


def _safe_float(value, default: float) -> float:
    if value is None:
        return default
    try:
        return float(value)
    except (ValueError, TypeError):
        return default


def _linear_to_db(linear: float) -> float:
    try:
        if linear <= 0:
            return -150.0
        return 20.0 * math.log10(linear)
    except (ValueError, TypeError):
        return 0.0


def _reaper_color_to_hex(value) -> str | None:
    """REAPER stores colors as native ints with 0x1000000 ('enabled') flag set.

    On Windows the low 24 bits are 0x00BBGGRR. Return ``#RRGGBB`` or None.
    """
    if value is None:
        return None
    try:
        raw = int(value)
    except (ValueError, TypeError):
        return None
    if raw == 0:
        return None
    raw &= 0xFFFFFF
    blue = (raw >> 16) & 0xFF
    green = (raw >> 8) & 0xFF
    red = raw & 0xFF
    return f"#{red:02x}{green:02x}{blue:02x}"


def _clean_vst_name(display: str) -> str:
    """Strip REAPER's "VST3: " / "VSTi: " / "AU: " prefix and trailing vendor."""
    name = (display or "").strip()
    for prefix in (
        "VST3i: ",
        "VST3: ",
        "VSTi: ",
        "VST: ",
        "AUi: ",
        "AU: ",
        "CLAPi: ",
        "CLAP: ",
    ):
        if name.startswith(prefix):
            name = name[len(prefix) :]
            break
    # Drop a trailing " (Vendor)" qualifier if present.
    if name.endswith(")") and " (" in name:
        name = name[: name.rfind(" (")].strip()
    return name or "Plugin"


def _is_au_name(display: str) -> bool:
    d = (display or "").strip()
    return d.startswith("AU:") or d.startswith("AUi:")


def _js_display_name(script: str) -> str:
    """Map a JS script path to a readable name, e.g. 'analysis/hpf' -> 'hpf'."""
    s = (script or "").strip()
    if not s:
        return "JS Effect"
    base = s.replace("\\", "/").rsplit("/", 1)[-1]
    return base or s


# ---------------------------------------------------------------------------
# Fallback
# ---------------------------------------------------------------------------


def _parse_rpp_minimal(path: str) -> DawProject:
    """Minimal fallback parser — reads track names from raw text only."""
    daw = DawProject(source_daw="reaper", name=Path(path).stem)
    daw.warnings.append("Using minimal RPP parser (track names only)")
    try:
        text = Path(path).read_text(encoding="utf-8", errors="replace")
    except Exception as e:  # noqa: BLE001
        raise ValueError(f"Cannot read .RPP file: {e}")
    import re

    for m in re.finditer(r'<TRACK[^\n]*\n\s*NAME\s+"([^"]*)"', text):
        daw.tracks.append(DawTrack(name=m.group(1), type="audio"))
    return daw
