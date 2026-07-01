"""Resolume Arena .avc composition parser.

.avc files are JSON describing an entire composition: decks, layers, clips,
audio/video sources, effects/devices, transport, and BPM. Resolume is a
primarily audio/visual tool, so the realistic extraction targets are: tempo,
layers->tracks, audio/video clips (with real source file paths and best-effort
timing), and effects/devices (native or VST). MIDI is only emitted when a clip
actually carries note data, which is uncommon in Resolume.

Resolume's JSON is inconsistent across versions: many scalar fields are wrapped
in ``{"Value": x, ...}`` objects, key casing varies ("BPM"/"bpm"), and the
layer/clip/effect containers move between schema revisions. Every access here is
guarded; uncertainty is recorded in ``project.warnings`` rather than raised.
"""

from __future__ import annotations

import json
import logging
import math
from pathlib import Path

from backend.modules.dawimport import media
from backend.modules.dawimport.models import (
    DawClip,
    DawDevice,
    DawProject,
    DawTrack,
)

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Generic helpers for Resolume's wrapped-value JSON
# ---------------------------------------------------------------------------


def _unwrap(node):
    """Resolume often wraps scalars as {"Value": x, "Default": y, ...}.

    Return the underlying scalar when ``node`` looks like such a wrapper,
    otherwise return ``node`` unchanged.
    """
    if isinstance(node, dict):
        for key in ("Value", "value", "ValueString", "valueString"):
            if key in node:
                return node[key]
    return node


def _get(d, *keys, default=None):
    """Case-insensitive dict lookup over several candidate keys."""
    if not isinstance(d, dict):
        return default
    lowered = {k.lower(): k for k in d.keys() if isinstance(k, str)}
    for key in keys:
        actual = lowered.get(key.lower())
        if actual is not None:
            return d[actual]
    return default


def _get_str(d, *keys, default=None):
    val = _unwrap(_get(d, *keys, default=default))
    if val is None:
        return default
    if isinstance(val, (str, int, float)):
        return str(val)
    return default


def _get_float(d, *keys, default=None):
    val = _unwrap(_get(d, *keys, default=None))
    if isinstance(val, bool):
        return default
    if isinstance(val, (int, float)):
        return float(val)
    if isinstance(val, str):
        try:
            return float(val.strip())
        except ValueError:
            return default
    return default


def _get_bool(d, *keys, default=None):
    val = _unwrap(_get(d, *keys, default=None))
    if isinstance(val, bool):
        return val
    if isinstance(val, (int, float)):
        return bool(val)
    if isinstance(val, str):
        return val.strip().lower() in ("true", "1", "yes", "on")
    return default


def _as_list(node):
    """Return a list of child items from either a JSON array or a wrapper.

    Resolume sometimes stores collections as a bare list, sometimes as a dict
    with a list under a generic key, sometimes as a dict whose values are the
    items themselves.
    """
    if node is None:
        return []
    if isinstance(node, list):
        return [x for x in node if x is not None]
    if isinstance(node, dict):
        for key in ("Layers", "Clips", "Effects", "Params", "Items", "List"):
            inner = _get(node, key)
            if isinstance(inner, list):
                return [x for x in inner if x is not None]
        # Fall back to dict values that are themselves dicts (item map).
        vals = [v for v in node.values() if isinstance(v, dict)]
        if vals:
            return vals
    return []


def _linear_to_db(gain: float) -> float:
    if gain <= 0.0:
        return -60.0
    return 20.0 * math.log10(gain)


def _color_to_hex(node) -> str | None:
    """Resolume colors are usually {"R":..,"G":..,"B":..,"A":..} 0..1 or 0..255."""
    val = _unwrap(node)
    if isinstance(val, str):
        s = val.strip()
        if s.startswith("#"):
            return s
        return None
    if not isinstance(val, dict):
        return None
    comps = []
    for chan in ("R", "G", "B"):
        c = _get_float(val, chan, chan.lower())
        if c is None:
            return None
        comps.append(c)
    # Normalise 0..1 floats up to 0..255.
    if all(c <= 1.0 for c in comps):
        comps = [c * 255.0 for c in comps]
    try:
        return "#" + "".join(f"{max(0, min(255, int(round(c)))):02X}" for c in comps)
    except (ValueError, TypeError):
        return None


# ---------------------------------------------------------------------------
# Effect / device extraction
# ---------------------------------------------------------------------------

_VST_HINTS = (".vst3", ".vst", ".dll", ".component", ".aaxplugin")


def _parse_effect(eff) -> DawDevice | None:
    """Turn one Resolume effect/device node into a DawDevice (best effort)."""
    if not isinstance(eff, dict):
        return None

    name = (
        _get_str(eff, "DisplayName", "displayName")
        or _get_str(eff, "Name", "name")
        or _get_str(eff, "EffectName", "effectName")
        or _get_str(eff, "PresetName", "presetName")
        or "Effect"
    )

    # A VST/plugin reference may live on the effect or in a nested plugin node.
    plugin_path = (
        _get_str(eff, "PluginPath", "pluginPath")
        or _get_str(eff, "Path", "path")
        or _get_str(eff, "FileName", "fileName")
        or _get_str(eff, "FilePath", "filePath")
    )
    plugin_node = _get(eff, "Plugin", "plugin", "VST", "vst", "Vst")
    if plugin_path is None and isinstance(plugin_node, dict):
        plugin_path = (
            _get_str(plugin_node, "Path", "path")
            or _get_str(plugin_node, "FileName", "fileName")
            or _get_str(plugin_node, "FilePath", "filePath")
        )
        if not name or name == "Effect":
            name = _get_str(plugin_node, "Name", "name") or name

    plugin_type = "builtin"
    if plugin_path and any(plugin_path.lower().endswith(ext) for ext in _VST_HINTS):
        if plugin_path.lower().endswith(".component"):
            plugin_type = "audiounit"
        else:
            plugin_type = "vst3"
    else:
        # No real on-disk plugin: treat as a native/stock effect.
        plugin_path = None

    device = DawDevice(name=name, plugin_type=plugin_type, plugin_path=plugin_path)

    # Bypass / enabled state.
    bypassed = _get_bool(eff, "Bypassed", "bypassed", "Bypass", "bypass")
    enabled = _get_bool(eff, "Enabled", "enabled", "On", "on", "Active", "active")
    if bypassed is not None:
        device.bypass = bypassed
    elif enabled is not None:
        device.bypass = not enabled

    # Parameters: best-effort name -> float.
    params_node = _get(eff, "Params", "params", "Parameters", "parameters")
    for p in _as_list(params_node):
        if not isinstance(p, dict):
            continue
        pname = _get_str(p, "Name", "name") or _get_str(p, "DisplayName", "displayName")
        pval = _get_float(p, "Value", "value")
        if pname is not None and pval is not None:
            device.parameters[pname] = pval

    # Opaque plugin-state chunk, if cheaply available and already base64-ish.
    state = _get_str(eff, "State", "state", "Chunk", "chunk", "PluginState")
    if state and isinstance(state, str) and len(state) > 8:
        device.state = state

    return device


def _collect_effects(container) -> list[DawDevice]:
    """Gather effects from any of the keys Resolume uses for an FX chain.

    ``_get`` is case-insensitive, so only the canonical key spellings are needed;
    the per-node identity check guards the rare case where two keys resolve to the
    same underlying list (which would otherwise double-count every effect).
    """
    devices: list[DawDevice] = []
    seen_nodes: list = []
    for key in ("Effects", "VideoEffects", "AudioEffects"):
        node = _get(container, key)
        if node is None or any(node is s for s in seen_nodes):
            continue
        seen_nodes.append(node)
        for eff in _as_list(node):
            dev = _parse_effect(eff)
            if dev is not None:
                devices.append(dev)
    return devices


# ---------------------------------------------------------------------------
# Clip extraction
# ---------------------------------------------------------------------------


def _collect_source_candidates(clip: dict, media_index: dict) -> list[str | None]:
    """Collect candidate audio/video source paths for a clip, best first.

    Looks at clip params (type 'file'), nested VideoClip/AudioClip source nodes,
    and the composition-level media index keyed by id. Returns every reference
    found (in priority order) so the shared resolver can pick the one that exists
    on disk or relink by filename.
    """
    candidates: list[str | None] = []

    def add(val: str | None) -> None:
        if val and val not in candidates:
            candidates.append(val)

    # 1) Explicit file param on the clip.
    params_node = _get(clip, "Params", "params")
    for p in _as_list(params_node):
        if not isinstance(p, dict):
            continue
        ptype = _get_str(p, "Type", "type")
        if ptype and ptype.lower() == "file":
            add(_get_str(p, "Value", "value"))

    # 2) Nested source node on a video/audio clip.
    for clip_key in ("VideoClip", "videoClip", "AudioClip", "audioClip", "Clip"):
        sub = _get(clip, clip_key)
        if isinstance(sub, dict):
            src = _get(
                sub, "FileInfo", "fileInfo", "Source", "source", "Media", "media"
            )
            for node in (sub, src):
                if isinstance(node, dict):
                    add(
                        _get_str(node, "FileName", "fileName")
                        or _get_str(node, "Path", "path")
                        or _get_str(node, "FilePath", "filePath")
                    )
                    media_id = _get_str(node, "MediaId", "mediaId", "Id", "id")
                    if media_id and media_id in media_index:
                        add(media_index[media_id])

    # 3) Direct path fields on the clip.
    add(
        _get_str(clip, "FileName", "fileName")
        or _get_str(clip, "Path", "path")
        or _get_str(clip, "FilePath", "filePath")
    )

    # 4) Media-id reference at the clip level.
    media_id = _get_str(clip, "MediaId", "mediaId")
    if media_id and media_id in media_index:
        add(media_index[media_id])

    return candidates


def _resolve_source_path(
    clip: dict,
    media_index: dict,
    file_index: dict[str, str],
    missing: list[str],
):
    """Resolve a clip's on-disk audio/video source path.

    Gathers every stored candidate reference, then relinks through the shared
    media resolver: an existing candidate wins; otherwise the bundled file is
    matched by filename via ``file_index``; otherwise the best reference is
    recorded in ``missing`` and returned.
    """
    candidates = _collect_source_candidates(clip, media_index)
    if not candidates:
        return None
    name = None
    for c in candidates:
        if c:
            name = Path(c).name
            break
    return media.resolve_audio(candidates, name, file_index, missing)


def _clip_timing(clip: dict, tempo: float, sample_rate: int):
    """Return (start_seconds, end_seconds) using whatever timing info exists.

    Resolume clips are triggered live and usually have no fixed timeline
    position, so this is best-effort: it reads a transport/position when present
    and otherwise falls back to a duration so the clip has nonzero length.
    """
    start = 0.0
    end = 0.0

    transport = _get(clip, "Transport", "transport")
    src = transport if isinstance(transport, dict) else clip

    # Position on the timeline (seconds preferred, else beats/samples).
    pos_sec = _get_float(src, "Position", "position", "StartTime", "startTime")
    if pos_sec is not None:
        start = pos_sec
    else:
        pos_beats = _get_float(src, "PositionBeats", "positionBeats", "StartBeats")
        if pos_beats is not None and tempo > 0:
            start = pos_beats * 60.0 / tempo
        else:
            pos_samp = _get_float(src, "PositionSamples", "positionSamples")
            if pos_samp is not None and sample_rate > 0:
                start = pos_samp / sample_rate

    # Duration / length.
    dur_sec = _get_float(src, "Duration", "duration", "Length", "length")
    if dur_sec is None:
        dur_ms = _get_float(src, "DurationMs", "durationMs", "LengthMs", "lengthMs")
        if dur_ms is not None:
            dur_sec = dur_ms / 1000.0
    if dur_sec is None:
        dur_beats = _get_float(src, "DurationBeats", "durationBeats", "LengthBeats")
        if dur_beats is not None and tempo > 0:
            dur_sec = dur_beats * 60.0 / tempo
    if dur_sec is None:
        dur_samp = _get_float(src, "DurationSamples", "durationSamples")
        if dur_samp is not None and sample_rate > 0:
            dur_sec = dur_samp / sample_rate

    if dur_sec is not None and dur_sec > 0:
        end = start + dur_sec

    return start, end


def _extract_midi_notes(clip: dict, tempo: float):
    """Extract MIDI notes if a clip carries them (rare for Resolume)."""
    notes_node = _get(clip, "Notes", "notes", "MidiNotes", "midiNotes")
    midi_node = _get(clip, "Midi", "midi", "MidiClip", "midiClip")
    if notes_node is None and isinstance(midi_node, dict):
        notes_node = _get(midi_node, "Notes", "notes")
    items = _as_list(notes_node)
    if not items:
        return None

    out = []
    for n in items:
        if not isinstance(n, dict):
            continue
        pitch = _get_float(n, "Pitch", "pitch", "Key", "key", "Note", "note")
        if pitch is None:
            continue
        start = _get_float(n, "Start", "start", "StartTime", "startTime")
        if start is None:
            sb = _get_float(n, "StartBeats", "startBeats", "Beat", "beat")
            start = (sb * 60.0 / tempo) if (sb is not None and tempo > 0) else 0.0
        dur = _get_float(n, "Duration", "duration", "Length", "length")
        if dur is None:
            db = _get_float(n, "DurationBeats", "durationBeats", "LengthBeats")
            dur = (db * 60.0 / tempo) if (db is not None and tempo > 0) else 0.0
        vel = _get_float(n, "Velocity", "velocity", "Vel", "vel")
        vel_i = int(vel) if vel is not None else 100
        out.append(
            {
                "pitch": max(0, min(127, int(round(pitch)))),
                "start": max(0.0, float(start)),
                "duration": max(0.0, float(dur)),
                "velocity": max(1, min(127, vel_i)),
            }
        )
    return out or None


# ---------------------------------------------------------------------------
# Top-level parse
# ---------------------------------------------------------------------------


def _build_media_index(comp: dict) -> dict:
    """Map media id -> file path from a composition-level media list, if any."""
    index: dict[str, str] = {}
    media_node = _get(comp, "Media", "media", "MediaPool", "mediaPool", "Sources")
    for m in _as_list(media_node):
        if not isinstance(m, dict):
            continue
        mid = _get_str(m, "Id", "id", "MediaId", "mediaId")
        path = (
            _get_str(m, "FileName", "fileName")
            or _get_str(m, "Path", "path")
            or _get_str(m, "FilePath", "filePath")
        )
        if mid and path:
            index[mid] = path
    return index


def parse_avc(path: str) -> DawProject:
    """Parse a Resolume Arena .avc composition into a DawProject.

    Keeps the public signature/contract identical to the original: raises
    ``FileNotFoundError`` for a missing file and ``ValueError`` for invalid
    JSON; all other parsing failures degrade gracefully into ``warnings``.
    """
    file_path = Path(path)
    if not file_path.is_file():
        raise FileNotFoundError(f".avc file not found: {path}")
    try:
        with open(str(file_path), "r", encoding="utf-8") as f:
            comp = json.load(f)
    except Exception as e:
        raise ValueError(f"Failed to parse .avc JSON: {e}")

    if not isinstance(comp, dict):
        raise ValueError(".avc root is not a JSON object")

    daw = DawProject(source_daw="resolume", name=file_path.stem)
    warnings = daw.warnings

    # Composition may be nested under a "Composition" wrapper.
    root = _get(comp, "Composition", "composition")
    if not isinstance(root, dict):
        root = comp

    # Version.
    ver = _get_str(comp, "Version", "version") or _get_str(root, "Version", "version")
    if ver:
        daw.source_version = ver

    # Tempo / BPM (may be nested under audio settings).
    tempo = _get_float(comp, "BPM", "bpm", "Tempo", "tempo")
    if tempo is None:
        tempo = _get_float(root, "BPM", "bpm", "Tempo", "tempo")
    if tempo is None:
        audio = _get(comp, "Audio", "audio", "AudioSettings", "audioSettings")
        if isinstance(audio, dict):
            tempo = _get_float(audio, "BPM", "bpm", "Tempo", "tempo")
    if tempo is not None and tempo > 0:
        daw.tempo = tempo
    else:
        warnings.append("No BPM found in composition; defaulting tempo to 120.")
    tempo = daw.tempo

    # Sample rate, if present.
    sr = _get_float(comp, "SampleRate", "sampleRate")
    if sr is None:
        audio = _get(comp, "Audio", "audio", "AudioSettings", "audioSettings")
        if isinstance(audio, dict):
            sr = _get_float(audio, "SampleRate", "sampleRate")
    if sr is not None and sr > 0:
        daw.sample_rate = int(sr)

    # Composition-level media index for resolving clip media-id references.
    media_index = _build_media_index(comp)

    # Filename index over the project folder so samples bundled with a project
    # authored on another machine relink by name when their stored path is gone.
    file_index = media.build_media_index(file_path.parent)

    # Layers -> tracks.
    layers_node = _get(root, "Layers", "layers")
    layers = _as_list(layers_node)
    if not layers:
        warnings.append("No layers found in composition; project has no tracks.")

    seen_plugins: set[str] = set()

    for li, layer in enumerate(layers):
        if not isinstance(layer, dict):
            continue
        layer_name = _get_str(layer, "Name", "name") or f"Layer {li + 1}"

        track = DawTrack(name=layer_name, type="audio")

        # Volume: Resolume uses opacity for video layers and/or an audio volume.
        gain = _get_float(layer, "Volume", "volume", "Audio", "AudioVolume")
        if gain is None:
            gain = _get_float(layer, "Opacity", "opacity")
        if gain is not None:
            track.volume_db = _linear_to_db(gain)

        # Mute / enabled state.
        bypassed = _get_bool(layer, "Bypassed", "bypassed", "Bypass")
        enabled = _get_bool(layer, "Enabled", "enabled", "On", "Active")
        if bypassed is not None:
            track.mute = bypassed
        elif enabled is not None:
            track.mute = not enabled

        solo = _get_bool(layer, "Solo", "solo", "Soloed", "soloed")
        if solo is not None:
            track.solo = solo

        # Color.
        color = _color_to_hex(_get(layer, "Color", "color", "Colour"))
        if color:
            track.color = color

        # Layer-level effects.
        track.devices.extend(_collect_effects(layer))

        # Clips.
        for clip in _as_list(_get(layer, "Clips", "clips")):
            if not isinstance(clip, dict):
                continue
            clip_name = (
                _get_str(clip, "Name", "name")
                or _get_str(clip, "DisplayName", "displayName")
                or "Clip"
            )
            file_ref = _resolve_source_path(
                clip, media_index, file_index, daw.missing_files
            )
            start, end = _clip_timing(clip, tempo, daw.sample_rate)
            midi_notes = _extract_midi_notes(clip, tempo)

            daw_clip = DawClip(
                name=clip_name,
                start_time=start,
                end_time=end,
                file_path=file_ref,
                midi_notes=midi_notes,
            )

            # Clip-level effects append to the track chain after layer effects.
            track.devices.extend(_collect_effects(clip))

            # Missing source files are recorded by media.resolve_audio above.

            track.clips.append(daw_clip)

        for dev in track.devices:
            if dev.plugin_path and dev.plugin_path not in seen_plugins:
                seen_plugins.add(dev.plugin_path)
                daw.plugins_used.append(dev.plugin_path)

        daw.tracks.append(track)

    if not any(c.start_time or c.end_time for t in daw.tracks for c in t.clips):
        warnings.append(
            "Clip timing unavailable: Resolume clips are triggered live and "
            "carry no fixed timeline position in this composition; clip "
            "start/end left at 0."
        )

    return daw
