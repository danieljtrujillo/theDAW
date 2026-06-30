"""Adobe Audition .sesx session parser.

.sesx files are plain (uncompressed) XML with a ``<sesx>`` root. The real
schema looks roughly like::

    <sesx version="1.1">
      <session appBuild=".." appVersion=".." sampleRate="48000" .. />
      <files>
        <file id="1" relativePath="..wav" absolutePath="C:/.." mediaHandler=".." />
      </files>
      <tracks>
        <audioTrack id=".." index="0" visible="true">
          <trackParameters>
            <name value="Drums" />
            <trackAudioParameters audioChannelType=".." >
              <volume value="1.0" /><pan value="0.0" />
            </trackAudioParameters>
            <trackControlParameters recordArmed="false" monitoring="false"
                                    soloed="false" muted="false" />
          </trackParameters>
          <audioClip id=".." name="Loop" fileID="1" startPoint="0"
                     endPoint="96000" sourceInPoint="0" sourceOutPoint="96000" />
          <rack><effect .. /></rack>
        </audioTrack>
        <midiTrack> .. <midiClip><note pitch=".." .. /></midiClip> </midiTrack>
      </tracks>
      <markers> <marker name=".." startPoint=".." /> </markers>
    </sesx>

Attribute names vary a little between Audition versions, so every read is
guarded and falls back gracefully. Time values inside clips/notes are sample
positions at the session sample rate (converted to seconds here).
"""

from __future__ import annotations

import base64
import logging
import math
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


# --------------------------------------------------------------------------- #
# small attribute helpers (never raise)
# --------------------------------------------------------------------------- #
def _attr(elem, *names: str, default: str | None = None) -> str | None:
    """Return the first present attribute among ``names`` (case-insensitive)."""
    if elem is None:
        return default
    for n in names:
        v = elem.get(n)
        if v is not None:
            return v
    # case-insensitive fallback
    lower = {k.lower(): v for k, v in elem.attrib.items()}
    for n in names:
        v = lower.get(n.lower())
        if v is not None:
            return v
    return default


def _fattr(elem, *names: str, default: float = 0.0) -> float:
    raw = _attr(elem, *names)
    if raw is None:
        return default
    try:
        return float(raw)
    except (TypeError, ValueError):
        return default


def _iattr(elem, *names: str, default: int = 0) -> int:
    return int(round(_fattr(elem, *names, default=float(default))))


def _battr(elem, *names: str, default: bool = False) -> bool:
    raw = _attr(elem, *names)
    if raw is None:
        return default
    return str(raw).strip().lower() in ("1", "true", "yes", "on")


def _child_value(parent, tag: str, *names: str, default: str | None = None):
    """Audition stores many params as ``<tag value=".."/>`` children."""
    if parent is None:
        return default
    child = parent.find(tag)
    if child is None:
        for c in parent:
            if c.tag.lower() == tag.lower():
                child = c
                break
    if child is None:
        return default
    return _attr(child, "value", *names, default=default)


def _child_float(parent, tag: str, default: float = 0.0) -> float:
    raw = _child_value(parent, tag)
    if raw is None:
        return default
    try:
        return float(raw)
    except (TypeError, ValueError):
        return default


def _linear_to_db(gain: float) -> float:
    if gain <= 0.0:
        return -120.0
    return round(20.0 * math.log10(gain), 2)


def _samples_to_sec(samples: float, sample_rate: int) -> float:
    if sample_rate <= 0:
        return 0.0
    return samples / float(sample_rate)


def _norm_color(raw: str | None) -> str | None:
    if not raw:
        return None
    raw = raw.strip()
    if raw.startswith("#"):
        return raw
    # Audition sometimes stores an integer color value.
    try:
        n = int(raw)
        return "#{:06X}".format(n & 0xFFFFFF)
    except (TypeError, ValueError):
        return raw


# --------------------------------------------------------------------------- #
# main entry point
# --------------------------------------------------------------------------- #
def parse_sesx(path: str) -> DawProject:
    """Parse an Adobe Audition .sesx file into a DawProject."""
    file_path = Path(path)
    if not file_path.is_file():
        raise FileNotFoundError(f".sesx file not found: {path}")

    try:
        tree = ET.parse(str(file_path))
    except Exception as e:
        raise ValueError(f"Failed to parse .sesx XML: {e}") from e

    root = tree.getroot()
    project = DawProject(source_daw="audition", name=file_path.stem)
    project.source_version = _attr(root, "version", default="") or ""

    session = root.find("session")
    if session is None:
        # some exports omit a dedicated <session>; fall back to root attrs
        session = root

    # ----- project-level params --------------------------------------------
    sr = _iattr(session, "sampleRate", "samplerate", default=0)
    if sr <= 0:
        sr = _iattr(root, "sampleRate", "samplerate", default=44100)
    project.sample_rate = sr if sr > 0 else 44100

    if not project.source_version:
        project.source_version = (
            _attr(session, "appVersion", "appBuild", default="") or ""
        )

    tempo = _fattr(session, "tempo", "bpm", default=0.0)
    # tempo can also live in <tempo bpm=".."/> or <transport>/<tempo>
    if tempo <= 0:
        for tag in ("tempo", "transport"):
            t = session.find(tag)
            if t is not None:
                tempo = _fattr(t, "bpm", "tempo", "value", default=0.0)
                if tempo <= 0:
                    tempo = _child_float(t, "tempo", 0.0)
                if tempo > 0:
                    break
    if tempo > 0:
        project.tempo = tempo

    _parse_time_signature(session, project)

    # ----- file id -> absolute path map ------------------------------------
    sesx_dir = file_path.parent
    # Index every audio file bundled in the project folder so clips can relink
    # by filename when the stored absolute path is from another machine.
    media_index = media.build_media_index(sesx_dir)
    id_to_path = _build_file_map(root, sesx_dir, project)

    # ----- tracks ----------------------------------------------------------
    tracks_parent = root.find("tracks")
    if tracks_parent is None:
        tracks_parent = session.find("tracks") if session is not root else None
    if tracks_parent is None:
        tracks_parent = root  # iterate everything as a last resort

    _tag_to_type = {
        "audiotrack": "audio",
        "miditrack": "midi",
        "auxtrack": "return",
        "bustrack": "return",
        "mastertrack": "master",
        "videotrack": "audio",
    }

    seen = set()
    # Iterate only direct candidate track elements to preserve order.
    for elem in tracks_parent.iter():
        ttype = _tag_to_type.get(elem.tag.lower())
        if ttype is None:
            continue
        if id(elem) in seen:
            continue
        seen.add(id(elem))
        try:
            track = _parse_track(elem, ttype, id_to_path, media_index, project)
            project.tracks.append(track)
        except Exception as e:  # noqa: BLE001 - robustness over correctness
            project.warnings.append(f"Skipped a track ({elem.tag}): {e}")

    # ----- markers ---------------------------------------------------------
    _parse_markers(root, project)

    return project


# --------------------------------------------------------------------------- #
# time signature
# --------------------------------------------------------------------------- #
def _parse_time_signature(session, project: DawProject) -> None:
    try:
        num = _iattr(session, "timeSignatureNumerator", default=0)
        den = _iattr(session, "timeSignatureDenominator", default=0)
        if num <= 0 or den <= 0:
            ts = session.find("timeSignature")
            if ts is not None:
                num = _iattr(ts, "numerator", "beatsPerBar", "value", default=num)
                den = _iattr(ts, "denominator", "noteValue", default=den)
        if num > 0 and den > 0:
            project.time_signature = (num, den)
    except Exception as e:  # noqa: BLE001
        project.warnings.append(f"Could not read time signature: {e}")


# --------------------------------------------------------------------------- #
# file list
# --------------------------------------------------------------------------- #
def _build_file_map(root, sesx_dir: Path, project: DawProject) -> dict[str, str]:
    """Map Audition file id -> best on-disk absolute path.

    Missing-file bookkeeping is deferred to ``media.resolve_audio`` at the clip
    level (which also relinks by filename), so this records the best available
    reference for each id without touching ``project.missing_files``.
    """
    id_to_path: dict[str, str] = {}
    files_parent = root.find("files")
    file_elems: list = []
    if files_parent is not None:
        file_elems = list(files_parent.iter("file"))
    if not file_elems:
        # also seen as <fileList><file ../></fileList>
        fl = root.find("fileList")
        if fl is not None:
            file_elems = list(fl.iter("file"))
    if not file_elems:
        file_elems = list(root.iter("file"))

    for fe in file_elems:
        fid = _attr(fe, "id", "fileID", "fileId")
        if fid is None:
            continue
        abs_raw = _attr(fe, "absolutePath", "path", "url")
        rel_raw = _attr(fe, "relativePath", "relpath")
        resolved = _resolve_media_path(abs_raw, rel_raw, sesx_dir)
        if resolved is not None:
            id_to_path[fid] = resolved
        else:
            # still record the best guess so clips can relink / show a name
            best = abs_raw or (str(sesx_dir / rel_raw) if rel_raw else None)
            if best:
                id_to_path[fid] = best
    return id_to_path


def _resolve_media_path(
    abs_raw: str | None, rel_raw: str | None, sesx_dir: Path
) -> str | None:
    """Return an existing absolute path, or None if nothing on disk matches."""
    candidates: list[Path] = []
    if abs_raw:
        candidates.append(Path(_strip_file_uri(abs_raw)))
    if rel_raw:
        rel = _strip_file_uri(rel_raw)
        candidates.append((sesx_dir / rel))
        # Audition companion media lives in "<name>_Recorded" / similar folders
        candidates.append((sesx_dir / Path(rel).name))
    for c in candidates:
        try:
            if c.is_file():
                return str(c.resolve())
        except OSError:
            continue
    return None


def _strip_file_uri(s: str) -> str:
    s = s.strip()
    if s.lower().startswith("file:///"):
        s = s[8:]
    elif s.lower().startswith("file://"):
        s = s[7:]
    return s


# --------------------------------------------------------------------------- #
# tracks
# --------------------------------------------------------------------------- #
def _parse_track(
    elem,
    ttype: str,
    id_to_path: dict[str, str],
    media_index: dict[str, str],
    project: DawProject,
) -> DawTrack:
    params = elem.find("trackParameters")
    if params is None:
        params = elem

    name = _child_value(params, "name", "trackName") or _attr(elem, "name") or "Track"

    audio_params = params.find("trackAudioParameters")
    if audio_params is None:
        audio_params = params

    vol_linear = _child_float(audio_params, "volume", 1.0)
    # also seen as attribute volume=".." on trackAudioParameters
    if vol_linear == 1.0:
        attr_vol = _attr(audio_params, "volume")
        if attr_vol is not None:
            try:
                vol_linear = float(attr_vol)
            except ValueError:
                pass
    pan = _child_float(audio_params, "pan", 0.0)
    if pan == 0.0:
        pan = _fattr(audio_params, "pan", default=0.0)
    # Audition pan is sometimes -100..100; normalize to -1..1
    if abs(pan) > 1.0:
        pan = max(-1.0, min(1.0, pan / 100.0))

    ctrl = params.find("trackControlParameters")
    if ctrl is None:
        ctrl = params
    mute = _battr(ctrl, "muted", "mute") or _battr(audio_params, "muted", "mute")
    solo = _battr(ctrl, "soloed", "solo") or _battr(audio_params, "soloed", "solo")

    color = _norm_color(
        _attr(elem, "color") or _child_value(params, "color") or _attr(params, "color")
    )

    track = DawTrack(
        name=name,
        type=ttype,
        volume_db=_linear_to_db(vol_linear),
        pan=pan,
        mute=mute,
        solo=solo,
        color=color,
    )

    sr = project.sample_rate
    # ----- audio clips -----------------------------------------------------
    for clip_elem in elem.iter():
        tag = clip_elem.tag.lower()
        if tag in ("audioclip", "clip") and tag != "midiclip":
            # treat as audio only when it references a file
            if _attr(clip_elem, "fileID", "fileId", "fileid") is not None or (
                tag == "audioclip"
            ):
                try:
                    track.clips.append(
                        _parse_audio_clip(
                            clip_elem, id_to_path, media_index, sr, project
                        )
                    )
                except Exception as e:  # noqa: BLE001
                    project.warnings.append(f"Skipped an audio clip: {e}")
        elif tag == "midiclip":
            try:
                track.clips.append(_parse_midi_clip(clip_elem, sr, project))
            except Exception as e:  # noqa: BLE001
                project.warnings.append(f"Skipped a MIDI clip: {e}")

    # ----- effects / devices ----------------------------------------------
    _parse_devices(elem, track, project)

    return track


def _parse_audio_clip(
    clip_elem,
    id_to_path: dict[str, str],
    media_index: dict[str, str],
    sr: int,
    project: DawProject,
) -> DawClip:
    name = _attr(clip_elem, "name", default="Clip") or "Clip"
    fid = _attr(clip_elem, "fileID", "fileId", "fileid")
    stored_path = id_to_path.get(fid) if fid is not None else None
    # Relink by filename when the stored absolute path is from another machine;
    # resolve_audio also records anything still missing on project.missing_files.
    basename = Path(stored_path).name if stored_path else None
    file_path = media.resolve_audio(
        [stored_path], basename, media_index, project.missing_files
    )

    # Timeline placement (samples).
    start_samples = _fattr(
        clip_elem, "startPoint", "start", "offset", "position", default=0.0
    )
    end_samples = _fattr(clip_elem, "endPoint", "end", default=0.0)

    if end_samples <= start_samples:
        # derive length from source in/out, or explicit length/duration
        length = _fattr(clip_elem, "length", "duration", default=0.0)
        if length <= 0:
            in_p = _fattr(clip_elem, "sourceInPoint", "sourceIn", default=0.0)
            out_p = _fattr(clip_elem, "sourceOutPoint", "sourceOut", default=0.0)
            length = max(0.0, out_p - in_p)
        end_samples = start_samples + length

    start_sec = _samples_to_sec(start_samples, sr)
    end_sec = _samples_to_sec(end_samples, sr)

    return DawClip(
        name=name,
        start_time=start_sec,
        end_time=end_sec,
        file_path=file_path,
    )


def _parse_midi_clip(clip_elem, sr: int, project: DawProject) -> DawClip:
    name = _attr(clip_elem, "name", default="MIDI Clip") or "MIDI Clip"

    start_samples = _fattr(
        clip_elem, "startPoint", "start", "offset", "position", default=0.0
    )
    end_samples = _fattr(clip_elem, "endPoint", "end", default=0.0)
    if end_samples <= start_samples:
        length = _fattr(clip_elem, "length", "duration", default=0.0)
        end_samples = start_samples + length

    start_sec = _samples_to_sec(start_samples, sr)
    end_sec = _samples_to_sec(end_samples, sr)

    notes: list[dict] = []
    for note in clip_elem.iter("note"):
        try:
            n = _parse_note(note, sr)
            if n is not None:
                notes.append(n)
        except Exception as e:  # noqa: BLE001
            project.warnings.append(f"Skipped a MIDI note: {e}")

    if end_sec <= start_sec and notes:
        last = max((n["start"] + n["duration"]) for n in notes)
        end_sec = start_sec + last

    return DawClip(
        name=name,
        start_time=start_sec,
        end_time=end_sec,
        midi_notes=notes,
    )


def _parse_note(note, sr: int) -> dict | None:
    pitch = _iattr(note, "pitch", "key", "noteNumber", default=-1)
    if pitch < 0:
        return None
    pitch = max(0, min(127, pitch))

    n_start = _fattr(note, "start", "startPoint", "position", "offset", default=0.0)
    n_dur = _fattr(note, "duration", "length", default=0.0)
    if n_dur <= 0:
        n_end = _fattr(note, "endPoint", "end", default=0.0)
        n_dur = max(0.0, n_end - n_start)

    vel = _iattr(note, "velocity", "vel", default=100)
    vel = max(1, min(127, vel if vel > 0 else 1))

    return {
        "pitch": pitch,
        "start": _samples_to_sec(n_start, sr),
        "duration": _samples_to_sec(n_dur, sr),
        "velocity": vel,
    }


# --------------------------------------------------------------------------- #
# effects / devices
# --------------------------------------------------------------------------- #
def _parse_devices(track_elem, track: DawTrack, project: DawProject) -> None:
    """Walk <rack>/<effect>/<effectSlot> elements in signal-chain order."""
    racks = list(track_elem.iter("rack"))
    effect_elems: list = []
    if racks:
        for rack in racks:
            effect_elems.extend(_iter_effect_nodes(rack))
    else:
        effect_elems = _iter_effect_nodes(track_elem)

    seen = set()
    for ee in effect_elems:
        if id(ee) in seen:
            continue
        seen.add(id(ee))
        try:
            dev = _parse_effect(ee)
            if dev is not None:
                track.devices.append(dev)
                pname = dev.plugin_path or dev.name
                if pname and pname not in project.plugins_used:
                    project.plugins_used.append(pname)
        except Exception as e:  # noqa: BLE001
            project.warnings.append(f"Skipped an effect on {track.name}: {e}")


def _iter_effect_nodes(parent) -> list:
    """Collect effect-ish child nodes (effect / effectSlot / rackEffect)."""
    out: list = []
    for el in parent.iter():
        tag = el.tag.lower()
        if tag in ("effect", "effectslot", "rackeffect", "vsteffect"):
            out.append(el)
    return out


def _parse_effect(ee) -> DawDevice | None:
    tag = ee.tag.lower()
    # An <effectSlot> may wrap the actual <effect>; unwrap one level.
    if tag == "effectslot":
        inner = ee.find("effect")
        if inner is None:
            for c in ee:
                if c.tag.lower() in ("effect", "vsteffect", "rackeffect"):
                    inner = c
                    break
        host = inner if inner is not None else ee
    else:
        host = ee

    name = (
        _attr(host, "name", "effectName", "displayName", "title")
        or _attr(host, "uid", "classID")
        or "Effect"
    )

    plugin_path = _attr(host, "pluginPath", "path", "dllPath", "vstPath", "file")
    plugin_path = _strip_file_uri(plugin_path) if plugin_path else None

    low_name = (name or "").lower()
    low_path = (plugin_path or "").lower()
    if low_path.endswith(".vst3") or low_name.endswith(".vst3"):
        ptype = "vst3"
    elif low_path.endswith(".component") or low_path.endswith(".au"):
        ptype = "audiounit"
    elif plugin_path and (low_path.endswith(".dll") or low_path.endswith(".vst")):
        ptype = "vst3"  # legacy VST hosted via the same path mechanism
    else:
        ptype = "builtin"
        plugin_path = None

    # bypass / on-off
    bypass = False
    on_raw = _attr(host, "powerState", "power", "enabled", "on")
    if on_raw is not None:
        bypass = str(on_raw).strip().lower() in ("0", "false", "off", "no")
    bypass = bypass or _battr(host, "bypass", "bypassed", default=False)

    # parameters (best-effort name->float)
    params: dict[str, float] = {}
    for p in host.iter():
        ptag = p.tag.lower()
        if ptag in ("parameter", "param", "control"):
            pname = _attr(p, "name", "id", "paramName")
            pval = _attr(p, "value", "val")
            if pname is None or pval is None:
                continue
            try:
                params[pname] = float(pval)
            except (TypeError, ValueError):
                continue

    # opaque state chunk (base64) if present and cheap to grab
    state = None
    state_raw = (
        _attr(host, "state", "chunk", "data")
        or _child_value(host, "state")
        or _child_value(host, "chunk")
    )
    if state_raw and isinstance(state_raw, str) and len(state_raw) > 0:
        state = state_raw.strip()
        # validate it looks like base64; if not, store the raw text anyway
        try:
            base64.b64decode(state, validate=True)
        except Exception:  # noqa: BLE001
            pass

    return DawDevice(
        name=name,
        plugin_type=ptype,
        plugin_path=plugin_path,
        parameters=params,
        bypass=bypass,
        state=state,
    )


# --------------------------------------------------------------------------- #
# markers
# --------------------------------------------------------------------------- #
def _parse_markers(root, project: DawProject) -> None:
    sr = project.sample_rate
    for marker in root.iter():
        tag = marker.tag.lower()
        if tag not in ("marker", "cuepoint", "cue"):
            continue
        name = _attr(marker, "name", "label", default="") or ""
        # marker position can be in samples (startPoint/sampleOffset) or seconds (time)
        pos_samples = _attr(marker, "startPoint", "sampleOffset", "start", "position")
        if pos_samples is not None:
            try:
                pos = _samples_to_sec(float(pos_samples), sr)
            except (TypeError, ValueError):
                pos = 0.0
        else:
            pos = _fattr(marker, "time", default=0.0)
        color = _norm_color(_attr(marker, "color"))
        project.locators.append(DawLocator(name=name, position=pos, color=color))
