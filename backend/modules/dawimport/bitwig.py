"""Bitwig Studio project parser (.bwproject / .dawproject).

Modern Bitwig exports the open **DAWproject** standard, which is what this
parser targets. A ``.dawproject`` (and recent ``.bwproject``) is a ZIP archive
containing ``project.xml``; older ``.bwproject`` files may be gzip-compressed
XML or plain XML. All three containers are handled by sniffing the magic bytes.

The DAWproject schema (https://github.com/bitwig/dawproject) is read directly
from Bitwig's JAXB-annotated source, so element/attribute spellings here match
the reference implementation:

* ``<Project><Structure><Track contentType= name= color= id=>`` each with a
  ``<Channel role= solo=>`` holding ``<Volume unit= value=>``, ``<Pan ...>``,
  ``<Mute value=>`` and a ``<Devices>`` wrapper of ``<Vst3Plugin>`` /
  ``<Vst2Plugin>`` / ``<ClapPlugin>`` / ``<AuPlugin>`` / ``<BuiltinDevice>`` /
  ``<Equalizer>`` / ``<Compressor>`` etc. (``deviceName``, ``deviceID``,
  ``deviceVendor``, ``<Enabled value=>``, ``<State path=>``).
* ``<Arrangement><Lanes timeUnit=>`` containing per-track nested ``<Lanes
  track=IDREF>`` -> ``<Clips>`` -> ``<Clip time= duration= contentTimeUnit=>``
  whose ``content`` is ``<Notes>`` (MIDI) or ``<Warps>``/``<Audio file=>``
  (audio) or further nested ``<Lanes>``.

Time units are per-timeline (``timeUnit`` inherits down the tree, defaulting to
``beats``). Beats convert to seconds with ``sec = beats * 60 / tempo``; seconds
pass through. Audio sample paths are resolved relative to the archive's
``audio/`` folder by extracting them to a sibling cache directory so theDAW gets
a real on-disk path.

Parsing is fully defensive: every lookup is guarded and any uncertainty is
recorded in ``project.warnings`` rather than raised.
"""

from __future__ import annotations

import gzip
import logging
import math
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

from backend.modules.dawimport import media
from backend.modules.dawimport.models import (
    DawClip,
    DawDevice,
    DawLocator,
    DawProject,
    DawTrack,
)

log = logging.getLogger(__name__)

# DAWproject device elements that are concrete plug-in hosts vs native devices.
_VST3_TAGS = {"Vst3Plugin"}
_VST2_TAGS = {"Vst2Plugin"}
_AU_TAGS = {"AuPlugin"}
_CLAP_TAGS = {"ClapPlugin"}
# Stock/native device element names from the schema (BuiltinDevice + the
# explicitly modelled built-ins). Anything else with deviceName is treated as a
# plug-in if it carries a recognisable path/state, else builtin.
_BUILTIN_TAGS = {
    "BuiltinDevice",
    "Equalizer",
    "Compressor",
    "NoiseGate",
    "Limiter",
}
_DEVICE_TAGS = _VST3_TAGS | _VST2_TAGS | _AU_TAGS | _CLAP_TAGS | _BUILTIN_TAGS


def parse_bwproject(path: str) -> DawProject:
    """Parse a Bitwig ``.bwproject`` / ``.dawproject`` into a DawProject.

    Handles ZIP (DAWproject), gzip, and plain-XML containers. Never raises on
    malformed inner content; structural problems are appended to
    ``project.warnings``.
    """
    file_path = Path(path)
    if not file_path.is_file():
        raise FileNotFoundError(f"Bitwig project file not found: {path}")

    project = DawProject(source_daw="bitwig", name=file_path.stem)

    xml_bytes, zip_handle, audio_cache = _read_project_xml(file_path, project)
    if xml_bytes is None:
        project.warnings.append("Could not locate project XML inside the file.")
        return project

    try:
        root = ET.fromstring(xml_bytes)
    except Exception as e:  # noqa: BLE001 - defensive, report not raise
        project.warnings.append(f"Failed to parse project XML: {e}")
        return project

    project.source_version = root.get("version", "")

    # Index audio files bundled beside the project so external sample refs from
    # another machine relink by filename. The archive-internal extraction path
    # (below) resolves on disk directly and does not need the index.
    media_index = media.build_media_index(file_path.parent)

    _parse_transport(root, project)
    tracks_by_id = _parse_structure(root, project)
    _parse_arrangement(
        root, project, tracks_by_id, zip_handle, audio_cache, media_index
    )
    _parse_markers(root, project)

    # Dedup plugins_used preserving order.
    seen: set[str] = set()
    deduped: list[str] = []
    for p in project.plugins_used:
        if p and p not in seen:
            seen.add(p)
            deduped.append(p)
    project.plugins_used = deduped

    if zip_handle is not None:
        try:
            zip_handle.close()
        except Exception:  # noqa: BLE001
            pass

    return project


# --------------------------------------------------------------------------- #
# Container handling
# --------------------------------------------------------------------------- #


def _read_project_xml(
    file_path: Path, project: DawProject
) -> tuple[bytes | None, zipfile.ZipFile | None, Path | None]:
    """Return (xml_bytes, open_zip_or_None, audio_cache_dir_or_None).

    The open ZIP handle (when the container is a DAWproject archive) is returned
    so audio samples can be extracted lazily during clip parsing.
    """
    try:
        head = file_path.read_bytes()[:4]
    except Exception as e:  # noqa: BLE001
        project.warnings.append(f"Could not read file bytes: {e}")
        return None, None, None

    # ZIP / DAWproject (PK\x03\x04).
    if head[:2] == b"PK":
        try:
            zf = zipfile.ZipFile(str(file_path), "r")
        except Exception as e:  # noqa: BLE001
            project.warnings.append(f"File looked like a ZIP but failed to open: {e}")
            return None, None, None
        names = zf.namelist()
        inner = None
        for cand in ("project.xml", "Project.xml"):
            if cand in names:
                inner = cand
                break
        if inner is None:
            for n in names:
                if n.lower().endswith("project.xml"):
                    inner = n
                    break
        if inner is None:
            for n in names:
                if n.lower().endswith(".xml"):
                    inner = n
                    project.warnings.append(
                        f"No project.xml in archive; falling back to '{n}'."
                    )
                    break
        if inner is None:
            project.warnings.append("DAWproject archive contained no XML file.")
            try:
                zf.close()
            except Exception:  # noqa: BLE001
                pass
            return None, None, None
        try:
            data = zf.read(inner)
        except Exception as e:  # noqa: BLE001
            project.warnings.append(f"Failed to read '{inner}' from archive: {e}")
            try:
                zf.close()
            except Exception:  # noqa: BLE001
                pass
            return None, None, None
        cache = file_path.parent / f"{file_path.stem}_dawproject_audio"
        return data, zf, cache

    # gzip (\x1f\x8b).
    if head[:2] == b"\x1f\x8b":
        try:
            with gzip.open(str(file_path), "rb") as f:
                return f.read(), None, None
        except Exception as e:  # noqa: BLE001
            project.warnings.append(f"Failed to gunzip project: {e}")
            return None, None, None

    # Plain XML (or anything else; try to read as text).
    try:
        return file_path.read_bytes(), None, None
    except Exception as e:  # noqa: BLE001
        project.warnings.append(f"Failed to read plain-XML project: {e}")
        return None, None, None


# --------------------------------------------------------------------------- #
# Transport
# --------------------------------------------------------------------------- #


def _parse_transport(root: ET.Element, project: DawProject) -> None:
    transport = root.find("Transport")
    if transport is None:
        transport = root.find(".//Transport")
    if transport is None:
        project.warnings.append("No <Transport>; using default tempo 120.")
        return

    tempo_el = transport.find("Tempo")
    val = _attr_float(tempo_el, "value")
    if val and val > 0:
        project.tempo = val
    else:
        project.warnings.append("No tempo value; using default 120.")

    ts_el = transport.find("TimeSignature")
    if ts_el is not None:
        num = _attr_int(ts_el, "numerator")
        den = _attr_int(ts_el, "denominator")
        if num and den:
            project.time_signature = (num, den)


# --------------------------------------------------------------------------- #
# Structure (tracks + channels + devices)
# --------------------------------------------------------------------------- #


def _parse_structure(root: ET.Element, project: DawProject) -> dict[str, DawTrack]:
    """Parse <Structure> tracks. Returns map of track XML id -> DawTrack."""
    tracks_by_id: dict[str, DawTrack] = {}

    structure = root.find("Structure")
    if structure is None:
        structure = root.find(".//Structure")
    if structure is None:
        project.warnings.append("No <Structure> element; project has no tracks.")
        return tracks_by_id

    # Tracks can be nested (group tracks contain child <Track>s). iter() walks
    # them all; order is document order which is good enough for signal flow.
    for tr in structure.iter("Track"):
        dtrack = _parse_track(tr, project)
        project.tracks.append(dtrack)
        tid = tr.get("id")
        if tid:
            tracks_by_id[tid] = dtrack
    return tracks_by_id


def _parse_track(tr: ET.Element, project: DawProject) -> DawTrack:
    name = tr.get("name") or "Track"
    color = tr.get("color")

    channel = tr.find("Channel")
    role = channel.get("role") if channel is not None else None
    content_type = (tr.get("contentType") or "").lower()

    track_type = _map_track_type(content_type, role)

    volume_db = 0.0
    pan = 0.0
    mute = False
    solo = False
    devices: list[DawDevice] = []

    if channel is not None:
        volume_db = _read_volume_db(channel.find("Volume"))
        pan = _read_pan(channel.find("Pan"))
        mute = _read_bool_param(channel.find("Mute"))
        solo = _str_bool(channel.get("solo"))
        devices = _parse_devices(channel, project)

    return DawTrack(
        name=name,
        type=track_type,
        volume_db=volume_db,
        pan=pan,
        mute=mute,
        solo=solo,
        color=color,
        devices=devices,
    )


def _map_track_type(content_type: str, role: str | None) -> str:
    r = (role or "").lower()
    if r == "master":
        return "master"
    if r in ("effect", "submix"):
        return "return"
    if content_type == "notes":
        return "midi"
    if content_type == "audio":
        return "audio"
    # Fall back on role/content hints.
    if content_type == "tracks":
        return "audio"
    return "audio"


def _parse_devices(channel: ET.Element, project: DawProject) -> list[DawDevice]:
    devices: list[DawDevice] = []
    wrapper = channel.find("Devices")
    children = list(wrapper) if wrapper is not None else []
    for dev_el in children:
        tag = _localname(dev_el.tag)
        if tag not in _DEVICE_TAGS and not dev_el.get("deviceName"):
            continue
        dev = _parse_device(dev_el, tag, project)
        if dev is not None:
            devices.append(dev)
    return devices


def _parse_device(
    dev_el: ET.Element, tag: str, project: DawProject
) -> DawDevice | None:
    device_name = dev_el.get("deviceName") or dev_el.get("name") or tag
    vendor = dev_el.get("deviceVendor")

    # State file reference -> opaque path string (not the binary; that lives in
    # the archive). We store the relative path so theDAW can re-resolve it.
    state_path = None
    state_el = dev_el.find("State")
    if state_el is not None:
        state_path = state_el.get("path")

    if tag in _VST3_TAGS:
        plugin_type = "vst3"
        plugin_path = state_path
    elif tag in _AU_TAGS:
        plugin_type = "audiounit"
        plugin_path = state_path
    elif tag in _VST2_TAGS:
        # No dedicated vst2 enum in the model; treat as vst3 family for hosting,
        # note the real format in the device name.
        plugin_type = "vst3"
        plugin_path = state_path
        if "VST2" not in device_name.upper():
            device_name = f"{device_name} (VST2)"
    elif tag in _CLAP_TAGS:
        plugin_type = "vst3"
        plugin_path = state_path
        if "CLAP" not in device_name.upper():
            device_name = f"{device_name} (CLAP)"
    else:
        # BuiltinDevice / Equalizer / Compressor / etc. = native.
        plugin_type = "builtin"
        plugin_path = None
        if tag in ("Equalizer", "Compressor", "NoiseGate", "Limiter") and (
            not dev_el.get("deviceName")
        ):
            device_name = tag

    bypass = _device_bypass(dev_el)
    parameters = _parse_device_params(dev_el)

    label = device_name
    if vendor and plugin_type != "builtin" and vendor.lower() not in label.lower():
        project.plugins_used.append(f"{vendor} {device_name}")
    else:
        project.plugins_used.append(device_name)

    return DawDevice(
        name=label,
        plugin_type=plugin_type,
        plugin_path=plugin_path,
        parameters=parameters,
        bypass=bypass,
        state=None,
    )


def _device_bypass(dev_el: ET.Element) -> bool:
    """A device is bypassed when its <Enabled> bool param is false."""
    enabled_el = dev_el.find("Enabled")
    if enabled_el is None:
        return False
    raw = enabled_el.get("value")
    if raw is None:
        return False
    # Enabled=true -> not bypassed.
    return not _str_bool(raw)


def _parse_device_params(dev_el: ET.Element) -> dict[str, float]:
    """Best-effort name->float snapshot from <Parameters> Real/Int/Bool params."""
    params: dict[str, float] = {}
    wrapper = dev_el.find("Parameters")
    if wrapper is None:
        return params
    for p in list(wrapper):
        ptag = _localname(p.tag)
        if ptag not in (
            "RealParameter",
            "IntegerParameter",
            "BoolParameter",
            "EnumParameter",
        ):
            continue
        pname = p.get("name") or p.get("parameterID") or ptag
        raw = p.get("value")
        if raw is None:
            continue
        if ptag == "BoolParameter":
            params[pname] = 1.0 if _str_bool(raw) else 0.0
        else:
            try:
                params[pname] = float(raw)
            except (TypeError, ValueError):
                continue
    return params


# --------------------------------------------------------------------------- #
# Channel parameter readers
# --------------------------------------------------------------------------- #


def _read_volume_db(vol_el: ET.Element | None) -> float:
    """Convert a Volume RealParameter to dB respecting its declared unit."""
    if vol_el is None:
        return 0.0
    val = _attr_float(vol_el, "value")
    if val is None:
        return 0.0
    unit = (vol_el.get("unit") or "linear").lower()
    if unit == "decibel":
        return round(val, 2)
    if unit == "normalized":
        # Normalized 0..1: treat 1.0 as unity gain (linear).
        return _linear_to_db(val)
    if unit == "percent":
        return _linear_to_db(val / 100.0)
    # linear (default) and anything unknown: 1.0 == 0 dB.
    return _linear_to_db(val)


def _read_pan(pan_el: ET.Element | None) -> float:
    """Pan RealParameter -> -1..1. unit 'normalized' is 0..1 centred at 0.5."""
    if pan_el is None:
        return 0.0
    val = _attr_float(pan_el, "value")
    if val is None:
        return 0.0
    unit = (pan_el.get("unit") or "normalized").lower()
    if unit == "normalized":
        # 0 == hard left, 0.5 == centre, 1 == hard right.
        return max(-1.0, min(1.0, (val - 0.5) * 2.0))
    if unit == "percent":
        return max(-1.0, min(1.0, val / 100.0))
    return max(-1.0, min(1.0, val))


def _read_bool_param(el: ET.Element | None) -> bool:
    if el is None:
        return False
    return _str_bool(el.get("value"))


# --------------------------------------------------------------------------- #
# Arrangement (clips, notes, audio) -> tracks
# --------------------------------------------------------------------------- #


def _parse_arrangement(
    root: ET.Element,
    project: DawProject,
    tracks_by_id: dict[str, DawTrack],
    zip_handle: zipfile.ZipFile | None,
    audio_cache: Path | None,
    media_index: dict[str, str],
) -> None:
    arrangement = root.find("Arrangement")
    if arrangement is None:
        arrangement = root.find(".//Arrangement")
    if arrangement is None:
        project.warnings.append("No <Arrangement>; clips/notes not imported.")
        return

    top_lanes = arrangement.find("Lanes")
    if top_lanes is None:
        # Some exports nest differently; search any Lanes.
        top_lanes = arrangement.find(".//Lanes")
    if top_lanes is None:
        project.warnings.append("No <Lanes> under <Arrangement>; no clips found.")
        return

    tempo = project.tempo if project.tempo > 0 else 120.0
    root_unit = top_lanes.get("timeUnit") or "beats"

    # Walk every Lanes/Clips node, resolving its owning track via the nearest
    # 'track' IDREF in the lane hierarchy.
    _walk_lanes(
        top_lanes,
        owner_track=None,
        inherited_unit=root_unit,
        project=project,
        tracks_by_id=tracks_by_id,
        tempo=tempo,
        zip_handle=zip_handle,
        audio_cache=audio_cache,
        media_index=media_index,
    )


def _walk_lanes(
    lanes_el: ET.Element,
    owner_track: DawTrack | None,
    inherited_unit: str,
    project: DawProject,
    tracks_by_id: dict[str, DawTrack],
    tempo: float,
    zip_handle: zipfile.ZipFile | None,
    audio_cache: Path | None,
    media_index: dict[str, str],
) -> None:
    unit = lanes_el.get("timeUnit") or inherited_unit
    # A Lanes node may declare the track it belongs to.
    tref = lanes_el.get("track")
    if tref and tref in tracks_by_id:
        owner_track = tracks_by_id[tref]

    for child in list(lanes_el):
        ctag = _localname(child.tag)
        if ctag == "Lanes":
            _walk_lanes(
                child,
                owner_track,
                unit,
                project,
                tracks_by_id,
                tempo,
                zip_handle,
                audio_cache,
                media_index,
            )
        elif ctag == "Clips":
            target = owner_track
            ctref = child.get("track")
            if ctref and ctref in tracks_by_id:
                target = tracks_by_id[ctref]
            if target is None:
                project.warnings.append(
                    "Found <Clips> with no resolvable owning track; skipped."
                )
                continue
            clips_unit = child.get("timeUnit") or unit
            for clip_el in child.findall("Clip"):
                clip = _parse_clip(
                    clip_el,
                    clips_unit,
                    project,
                    tempo,
                    zip_handle,
                    audio_cache,
                    media_index,
                )
                if clip is not None:
                    target.clips.append(clip)


def _parse_clip(
    clip_el: ET.Element,
    parent_unit: str,
    project: DawProject,
    tempo: float,
    zip_handle: zipfile.ZipFile | None,
    audio_cache: Path | None,
    media_index: dict[str, str],
) -> DawClip | None:
    name = clip_el.get("name") or "Clip"

    time = _attr_float(clip_el, "time") or 0.0
    duration = _attr_float(clip_el, "duration")

    start_sec = _to_seconds(time, parent_unit, tempo)
    dur_sec = _to_seconds(duration, parent_unit, tempo) if duration is not None else 0.0
    end_sec = start_sec + dur_sec

    loop_start = _attr_float(clip_el, "loopStart")
    loop_end = _attr_float(clip_el, "loopEnd")
    loop_start_sec = (
        _to_seconds(loop_start, parent_unit, tempo) if loop_start is not None else None
    )
    loop_end_sec = (
        _to_seconds(loop_end, parent_unit, tempo) if loop_end is not None else None
    )

    # Content time unit governs notes/warps inside the clip.
    content_unit = clip_el.get("contentTimeUnit") or parent_unit

    file_path: str | None = None
    midi_notes: list[dict] | None = None
    warp_markers: list[dict] | None = None

    # Clip.content is the single child timeline (Notes / Audio / Warps / Lanes).
    for content in list(clip_el):
        ctag = _localname(content.tag)
        if ctag == "Notes":
            midi_notes = _parse_notes(content, content_unit, tempo)
        elif ctag == "Audio":
            file_path = _resolve_audio(
                content, project, zip_handle, audio_cache, media_index
            )
        elif ctag == "Warps":
            warp_markers = _parse_warps(content, tempo)
            # Warps wrap the real Audio content.
            inner_audio = content.find("Audio")
            if inner_audio is not None:
                file_path = _resolve_audio(
                    inner_audio, project, zip_handle, audio_cache, media_index
                )
        elif ctag == "Lanes":
            # Nested clip content (e.g. clip-in-clip); pull first Notes/Audio.
            inner_notes = content.find(".//Notes")
            if inner_notes is not None and midi_notes is None:
                midi_notes = _parse_notes(inner_notes, content_unit, tempo)
            inner_audio = content.find(".//Audio")
            if inner_audio is not None and file_path is None:
                file_path = _resolve_audio(
                    inner_audio, project, zip_handle, audio_cache, media_index
                )

    return DawClip(
        name=name,
        start_time=start_sec,
        end_time=end_sec,
        loop_start=loop_start_sec,
        loop_end=loop_end_sec,
        file_path=file_path,
        midi_notes=midi_notes,
        warp_markers=warp_markers,
    )


def _parse_notes(notes_el: ET.Element, unit: str, tempo: float) -> list[dict]:
    """Parse <Note> children into clip-relative second-based dicts."""
    out: list[dict] = []
    note_unit = notes_el.get("timeUnit") or unit
    for n in notes_el.findall("Note"):
        key = _attr_int(n, "key")
        if key is None:
            continue
        t = _attr_float(n, "time") or 0.0
        d = _attr_float(n, "duration") or 0.0
        vel = _attr_float(n, "vel")
        out.append(
            {
                "pitch": max(0, min(127, key)),
                "start": _to_seconds(t, note_unit, tempo),
                "duration": _to_seconds(d, note_unit, tempo),
                "velocity": _vel_to_midi(vel),
            }
        )
    return out


def _parse_warps(warps_el: ET.Element, tempo: float) -> list[dict]:
    """Parse <Warp> events. time is in the warps timeUnit, contentTime in
    contentTimeUnit; we record both in seconds best-effort."""
    out: list[dict] = []
    time_unit = warps_el.get("timeUnit") or "beats"
    content_unit = warps_el.get("contentTimeUnit") or "seconds"
    for w in warps_el.findall("Warp"):
        t = _attr_float(w, "time")
        ct = _attr_float(w, "contentTime")
        if t is None and ct is None:
            continue
        out.append(
            {
                "time": _to_seconds(t or 0.0, time_unit, tempo),
                "content_time": _to_seconds(ct or 0.0, content_unit, tempo),
            }
        )
    return out


def _resolve_audio(
    audio_el: ET.Element,
    project: DawProject,
    zip_handle: zipfile.ZipFile | None,
    audio_cache: Path | None,
    media_index: dict[str, str],
) -> str | None:
    """Resolve an <Audio><File path=>...> to an absolute on-disk path.

    For DAWproject archives the sample lives inside the ZIP, so it is extracted
    to a sibling cache dir the first time it is referenced. External references
    are relinked by filename against the project folder when their stored path
    came from another machine.
    """
    file_el = audio_el.find("File")
    if file_el is None:
        project.warnings.append("Audio clip had no <File>; file path unknown.")
        return None
    rel = file_el.get("path")
    if not rel:
        project.warnings.append("Audio <File> had no path attribute.")
        return None

    external = _str_bool(file_el.get("external"))

    # External / absolute on-disk reference: resolve on disk, else relink by
    # filename via the shared media index, else record as missing.
    if external or zip_handle is None:
        return media.resolve_audio(
            [rel], Path(rel).name, media_index, project.missing_files
        )

    # Inside the archive: extract to cache.
    if audio_cache is None:
        project.missing_files.append(rel)
        return None
    member = _find_zip_member(zip_handle, rel)
    if member is None:
        project.missing_files.append(rel)
        project.warnings.append(f"Audio '{rel}' not found inside archive.")
        return None
    try:
        audio_cache.mkdir(parents=True, exist_ok=True)
        out_path = audio_cache / Path(member).name
        if not out_path.is_file():
            with zip_handle.open(member) as src:
                out_path.write_bytes(src.read())
        return str(out_path.resolve())
    except Exception as e:  # noqa: BLE001
        project.warnings.append(f"Failed to extract audio '{rel}': {e}")
        project.missing_files.append(rel)
        return None


def _find_zip_member(zf: zipfile.ZipFile, rel: str) -> str | None:
    rel_norm = rel.replace("\\", "/").lstrip("/")
    names = zf.namelist()
    if rel_norm in names:
        return rel_norm
    base = rel_norm.split("/")[-1].lower()
    for n in names:
        if n.replace("\\", "/").split("/")[-1].lower() == base:
            return n
    return None


# --------------------------------------------------------------------------- #
# Markers / locators
# --------------------------------------------------------------------------- #


def _parse_markers(root: ET.Element, project: DawProject) -> None:
    tempo = project.tempo if project.tempo > 0 else 120.0
    for markers in root.iter("Markers"):
        unit = markers.get("timeUnit") or "beats"
        for m in markers.findall("Marker"):
            name = m.get("name") or ""
            t = _attr_float(m, "time") or 0.0
            color = m.get("color")
            project.locators.append(
                DawLocator(
                    name=name,
                    position=_to_seconds(t, unit, tempo),
                    color=color,
                )
            )


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _to_seconds(value: float, unit: str, tempo: float) -> float:
    u = (unit or "beats").lower()
    if u == "seconds":
        return float(value)
    if u == "beats":
        if tempo <= 0:
            return float(value)
        return float(value) * 60.0 / tempo
    # Unknown unit: assume beats (the schema default).
    if tempo <= 0:
        return float(value)
    return float(value) * 60.0 / tempo


def _vel_to_midi(vel: float | None) -> int:
    """DAWproject velocity is normalized 0..1; map to MIDI 1..127."""
    if vel is None:
        return 100
    if vel <= 0:
        return 1
    if vel <= 1.0:
        return max(1, min(127, round(vel * 127.0)))
    # Some exporters may already use 0..127.
    return max(1, min(127, round(vel)))


def _localname(tag: str) -> str:
    """Strip an XML namespace prefix from a tag (DAWproject is unnamespaced,
    but guard against namespaced variants)."""
    if "}" in tag:
        return tag.rsplit("}", 1)[1]
    return tag


def _attr_float(el: ET.Element | None, name: str) -> float | None:
    if el is None:
        return None
    raw = el.get(name)
    if raw is None:
        return None
    try:
        return float(raw)
    except (TypeError, ValueError):
        return None


def _attr_int(el: ET.Element | None, name: str) -> int | None:
    if el is None:
        return None
    raw = el.get(name)
    if raw is None:
        return None
    try:
        return int(float(raw))
    except (TypeError, ValueError):
        return None


def _str_bool(raw: str | None) -> bool:
    if raw is None:
        return False
    return raw.strip().lower() in ("true", "1", "yes")


def _linear_to_db(gain: float) -> float:
    """Convert a linear amplitude gain (1.0 = 0 dB) to decibels, floored."""
    if gain <= 0.0:
        return -120.0
    return round(20.0 * math.log10(gain), 2)
