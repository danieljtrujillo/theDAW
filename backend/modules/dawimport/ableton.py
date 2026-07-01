"""Ableton Live .als project parser.

.als files are gzip-compressed XML. This module decompresses and parses
the XML to extract the ARRANGEMENT view (where songs actually live): tempo,
tracks (with mix params), audio clips with real timing, MIDI notes, locators,
and VST/AU/native device references with best-effort parameter snapshots.

Live 11/12 splits a track's arrangement content between the comped main lane
(``ArrangerAutomation/Events``) and per-take "take lanes"
(``TakeLanes/.../ClipAutomation/Events``); ``_parse_clips`` merges both into one
non-overlapping lane so instruments whose part lives only in take lanes are not
dropped. Session-view (ClipSlot) clips are used only when a track has no
arrangement content at all.

Ableton clip/note timing is in BEATS; we convert to seconds via the
project tempo (sec = beats * 60 / tempo). Device chains are walked in
signal-chain order. The parser is defensive: it never raises on a missing
element/attribute, instead appending human-readable notes to
``project.warnings``.
"""

from __future__ import annotations

import gzip
import logging
import math
from pathlib import Path
from xml.etree import ElementTree as ET

from backend.modules.dawimport import media
from backend.modules.dawimport.models import (
    DawClip,
    DawControllerMapping,
    DawDevice,
    DawLocator,
    DawProject,
    DawTrack,
)

log = logging.getLogger(__name__)

_TAG_TO_TYPE = {
    "AudioTrack": "audio",
    "MidiTrack": "midi",
    "ReturnTrack": "return",
    "MasterTrack": "master",
    # Live 12 renamed the master track element to <MainTrack>; treat it the same
    # so its mixer + master effect chain (a common Sway mapping target) import.
    "MainTrack": "master",
}

# Tags that are native (stock) Ableton devices -> friendly display names.
# Anything not here that lives in a Devices container and is not a plugin
# host falls back to using its tag as the name.
_NATIVE_DEVICE_NAMES = {
    "Eq8": "EQ Eight",
    "FilterEQ3": "EQ Three",
    "Compressor2": "Compressor",
    "Compressor": "Compressor",
    "GlueCompressor": "Glue Compressor",
    "MultibandDynamics": "Multiband Dynamics",
    "Limiter": "Limiter",
    "Gate": "Gate",
    "Reverb": "Reverb",
    "Echo": "Echo",
    "Delay": "Delay",
    "PingPongDelay": "Ping Pong Delay",
    "FilterDelay": "Filter Delay",
    "Saturator": "Saturator",
    "Overdrive": "Overdrive",
    "Amp": "Amp",
    "Cabinet": "Cabinet",
    "Chorus": "Chorus",
    "Chorus2": "Chorus-Ensemble",
    "Flanger": "Flanger",
    "Phaser": "Phaser",
    "PhaserNew": "Phaser-Flanger",
    "AutoFilter": "Auto Filter",
    "AutoPan": "Auto Pan",
    "FrequencyShifter": "Frequency Shifter",
    "Resonator": "Resonator",
    "Vinyl": "Vinyl Distortion",
    "Redux": "Redux",
    "Redux2": "Redux",
    "BeatRepeat": "Beat Repeat",
    "Erosion": "Erosion",
    "Tube": "Dynamic Tube",
    "CrossDelay": "Delay",
    "StereoGain": "Utility",
    "Utility": "Utility",
    "Tuner": "Tuner",
    "Spectrum": "Spectrum",
    "Pedal": "Pedal",
    "DrumBuss": "Drum Buss",
    "Corpus": "Corpus",
    "Vocoder": "Vocoder",
    "GrainDelay": "Grain Delay",
    "Shifter": "Shifter",
    "Roar": "Roar",
    # Instruments (so MIDI tracks surface their sound source too).
    "OriginalSimpler": "Simpler",
    "MultiSampler": "Sampler",
    "InstrumentImpulse": "Impulse",
    "UltraAnalog": "Analog",
    "Operator": "Operator",
    "InstrumentVector": "Wavetable",
    "Collision": "Collision",
    "Tension": "Tension",
    "Electric": "Electric",
    "DrumGroupDevice": "Drum Rack",
    "InstrumentGroupDevice": "Instrument Rack",
    "AudioEffectGroupDevice": "Audio Effect Rack",
    "MidiEffectGroupDevice": "MIDI Effect Rack",
}

# Tags we never want to treat as a device row even though they may appear
# inside a Devices container in some schema versions.
_SKIP_DEVICE_TAGS = {"DeviceChain", "Devices", "MixerDevice", "Mixer"}

# Instrument/sampler devices (not audio effects; no live per-track engine).
_INSTRUMENT_TAGS = {
    "OriginalSimpler",
    "MultiSampler",
    "InstrumentImpulse",
    "UltraAnalog",
    "Operator",
    "InstrumentVector",
    "Collision",
    "Tension",
    "Electric",
    "InstrumentGroupDevice",
    "DrumGroupDevice",
}

# Rack containers we descend INTO (flattening their nested devices into the
# track's chain). DrumGroupDevice is kept as a single wrapper (its many cells are
# instruments, not FX, and would flood the chain), so it is not recursed.
_RACK_RECURSE_TAGS = {
    "AudioEffectGroupDevice",
    "InstrumentGroupDevice",
    "MidiEffectGroupDevice",
}
_RACK_ALL_TAGS = _RACK_RECURSE_TAGS | {"DrumGroupDevice"}


def parse_als(path: str) -> DawProject:
    """Parse an Ableton Live .als file into a DawProject."""
    file_path = Path(path)
    if not file_path.is_file():
        raise FileNotFoundError(f".als file not found: {path}")
    try:
        with gzip.open(str(file_path), "rb") as f:
            tree = ET.parse(f)
    except Exception as e:
        raise ValueError(f"Failed to decompress/parse .als file: {e}") from e

    root = tree.getroot()
    live_set = root.find("LiveSet")
    if live_set is None:
        if root.tag != "LiveSet":
            raise ValueError("Cannot find <LiveSet> in .als XML")
        live_set = root

    project = DawProject(source_daw="ableton", name=file_path.stem)

    # Source version, e.g. root attributes Creator / MajorVersion.
    project.source_version = (
        root.get("Creator")
        or root.get("MajorVersion")
        or root.get("MinorVersion")
        or ""
    )

    # Project directory: the .als usually sits inside "<Project>/" and samples
    # are referenced relative to it. Index the bundled media so clips relink by
    # filename when their stored absolute path is from another machine.
    project_dir = file_path.parent
    media_index = media.build_media_index(project_dir)

    # Tempo (parse first — note timing depends on it).
    tempo_elem = live_set.find(".//MasterTrack/Mixer/Tempo/Manual")
    if tempo_elem is None:
        tempo_elem = live_set.find(".//Tempo/Manual")
    if tempo_elem is not None:
        try:
            project.tempo = float(tempo_elem.get("Value", "120"))
        except (TypeError, ValueError):
            project.warnings.append("Could not parse tempo; defaulting to 120 BPM.")
    if project.tempo <= 0:
        project.tempo = 120.0
        project.warnings.append("Non-positive tempo; defaulting to 120 BPM.")

    # Time signature (best effort).
    num = live_set.find(".//MasterTrack//TimeSignature//Numerator")
    den = live_set.find(".//MasterTrack//TimeSignature//Denominator")
    try:
        if num is not None and den is not None:
            project.time_signature = (
                int(num.get("Value", "4")),
                int(den.get("Value", "4")),
            )
    except (TypeError, ValueError):
        pass

    # Session-view scene names (row order) for the Session tab's clip grid.
    project.scenes = _parse_scenes(live_set)

    # Tracks (regular tracks live under <Tracks>; the master is separate).
    tracks_elem = live_set.find("Tracks")
    if tracks_elem is not None:
        for track_elem in tracks_elem:
            track_type = _TAG_TO_TYPE.get(track_elem.tag)
            if track_type is None:
                continue
            try:
                track = _parse_track(
                    track_elem, track_type, project, project_dir, media_index
                )
                # Additive: the session-view clip matrix (indexed by scene/track)
                # for the Session grid. The arrangement lane on ``track.clips`` is
                # untouched; scene-tagged clips are ignored by the EDIT flow.
                track.clips.extend(
                    _parse_session_clips(
                        track_elem,
                        len(project.tracks),
                        project,
                        project_dir,
                        media_index,
                        project.scenes,
                    )
                )
                project.tracks.append(track)
            except Exception as e:  # pragma: no cover - defensive
                project.warnings.append(f"Failed to parse a {track_elem.tag}: {e}")

    # Master track (separate element; <MainTrack> in Live 12, <MasterTrack> before).
    master_elem = live_set.find("MasterTrack")
    if master_elem is None:
        master_elem = live_set.find("MainTrack")
    if master_elem is not None:
        try:
            project.tracks.append(
                _parse_track(master_elem, "master", project, project_dir, media_index)
            )
        except Exception as e:  # pragma: no cover - defensive
            project.warnings.append(f"Failed to parse MasterTrack: {e}")

    # Controller (MIDI-learn) mappings — so theDAW can auto-attach a hardware
    # controller (e.g. the Audima Sway) to the same targets the project wired.
    try:
        project.controller_mappings = _parse_controller_mappings(live_set)
    except Exception as e:  # pragma: no cover - defensive
        project.warnings.append(f"Could not parse controller mappings: {e}")

    # Locators.
    for loc_elem in live_set.iter("Locator"):
        name_e = loc_elem.find("Name")
        name = (
            name_e.get("Value", "") if name_e is not None else loc_elem.get("Name", "")
        )
        t_e = loc_elem.find("Time")
        beats = _read_float(t_e, None)
        if beats is None:
            beats = _read_float(loc_elem, None) or 0.0
            try:
                beats = float(loc_elem.get("Time", "0"))
            except (TypeError, ValueError):
                beats = 0.0
        project.locators.append(
            DawLocator(name=name, position=_beats_to_sec(beats, project.tempo))
        )

    # plugins_used summary.
    seen: list[str] = []
    for tr in project.tracks:
        for dev in tr.devices:
            if dev.name not in seen:
                seen.append(dev.name)
    project.plugins_used = seen

    return project


def _parse_track(
    track_elem,
    track_type: str,
    project: DawProject,
    project_dir: Path,
    media_index: dict[str, str],
) -> DawTrack:
    name_elem = track_elem.find(".//Name/EffectiveName")
    if name_elem is None:
        name_elem = track_elem.find(".//Name/UserName")
    name = name_elem.get("Value", "") if name_elem is not None else ""
    if not name:
        name = {"master": "Master", "return": "Return"}.get(track_type, "Track")

    # Mixer params. Ableton volume is a linear amplitude gain (1.0 = unity).
    vol_linear = _read_float(track_elem.find(".//Mixer/Volume/Manual"), 1.0)
    vol_db = _linear_to_db(vol_linear)
    pan = _read_float(track_elem.find(".//Mixer/Pan/Manual"), 0.0)

    # Mute: newer schema uses Mixer/Speaker (1 = on, so muted when 0); older
    # uses Mixer/Mute (1 = muted).
    mute = False
    speaker = track_elem.find(".//Mixer/Speaker/Manual")
    if speaker is None:
        speaker = track_elem.find(".//DeviceChain/Mixer/Speaker/Manual")
    if speaker is not None:
        mute = speaker.get("Value", "true").lower() in ("false", "0")
    else:
        mute_elem = track_elem.find(".//Mixer/Mute")
        if mute_elem is not None:
            mute = mute_elem.get("Value", "0") in ("1", "true")

    # Solo.
    solo = False
    solo_elem = track_elem.find(".//Solo") or track_elem.find(".//SoloSink")
    if solo_elem is not None:
        solo = solo_elem.get("Value", "false").lower() in ("true", "1")

    # Color.
    color = _read_color(track_elem)

    track = DawTrack(
        name=name,
        type=track_type,
        volume_db=vol_db,
        pan=pan,
        mute=mute,
        solo=solo,
        color=color,
    )

    # Clips: arrangement view first (real song), then session slots.
    track.clips = _parse_clips(track_elem, project, project_dir, media_index)

    # Devices in signal-chain order.
    track.devices = _parse_devices(track_elem, project)

    return track


# --------------------------------------------------------------------------- #
# Clips
# --------------------------------------------------------------------------- #


# Two clips count as overlapping (so only one keeps its slot on the single
# reconstructed lane) when their spans intersect by more than this, in seconds.
# A small epsilon lets clips that merely touch end-to-start coexist.
_CLIP_OVERLAP_EPS = 1e-3


def _parse_clips(
    track_elem, project: DawProject, project_dir: Path, media_index: dict[str, str]
) -> list[DawClip]:
    """Reconstruct a track's single playable lane from Ableton's clip stores.

    Live 11/12 keeps arrangement content in two places: the comped main lane
    (``MainSequencer/.../ArrangerAutomation/Events``) and per-take "take lanes"
    (``TakeLanes/.../TakeLane/ClipAutomation/Events``). The comp is what actually
    plays; take lanes are raw recorded takes scattered at the positions where
    they were captured (often far out on the timeline and overlapping). So the
    comp is authoritative: when a track has comp clips we use only those. Take
    lanes are a fallback for tracks whose part lives *only* in take lanes (no
    comp), where they are the sole content — there we keep one clip per slot
    (richest take wins) so alternates don't stack. Session-view ClipSlots are a
    last resort when a track has no arrangement content at all. theDAW's timeline
    is one lane per track, so the result is always a single non-overlapping lane.
    """
    main_seq = track_elem.find(".//DeviceChain/MainSequencer")

    placed: list[DawClip] = []
    spans: list[tuple[float, float]] = []

    def _try_add(clip: DawClip | None) -> bool:
        if clip is None:
            return False
        s, e = clip.start_time, clip.end_time
        for ps, pe in spans:
            if s < pe - _CLIP_OVERLAP_EPS and ps < e - _CLIP_OVERLAP_EPS:
                return False  # overlaps a clip already on the lane
        spans.append((s, e))
        placed.append(clip)
        return True

    # 1) Comp clips (what plays in the arrangement) — authoritative when present.
    comp = [
        _build_clip(el, project, project_dir, media_index, arrangement=True)
        for el in _arranger_clip_elements(main_seq)
    ]
    for clip in sorted((c for c in comp if c is not None), key=lambda c: c.start_time):
        _try_add(clip)

    # 2) No comp -> the track's part lives only in take lanes. Use them, keeping
    #    the richest take (most notes, then longest) when alternates overlap.
    if not placed:
        takes = [
            _build_clip(el, project, project_dir, media_index, arrangement=True)
            for el in _takelane_clip_elements(track_elem)
        ]
        takes = [c for c in takes if c is not None]
        takes.sort(
            key=lambda c: (
                c.start_time,
                -(len(c.midi_notes) if c.midi_notes else 0),
                -(c.end_time - c.start_time),
            )
        )
        for clip in takes:
            _try_add(clip)

    # 3) Session-view clips only when the track is otherwise empty.
    if not placed:
        for slot in track_elem.iter("ClipSlot"):
            for clip_elem in _iter_clip_elements(slot):
                _try_add(
                    _build_clip(
                        clip_elem, project, project_dir, media_index, arrangement=False
                    )
                )

    placed.sort(key=lambda c: c.start_time)
    return placed


def _arranger_clip_elements(main_seq):
    """Audio/MIDI clip elements in the comped arrangement lane(s).

    The comp lives under ``ArrangerAutomation/Events`` — beneath ``ClipTimeable``
    for MIDI tracks and ``Sample`` for audio tracks. Walking every
    ``ArrangerAutomation`` covers both without hard-coding the parent, and we
    filter to clip tags so device/parameter automation events are ignored.
    """
    if main_seq is None:
        return []
    out = []
    for arranger in main_seq.iter("ArrangerAutomation"):
        events = arranger.find("Events")
        if events is None:
            continue
        for el in events:
            if el.tag in ("AudioClip", "MidiClip"):
                out.append(el)
    return out


def _takelane_clip_elements(track_elem):
    """Audio/MIDI clip elements across all of a track's take lanes."""
    out = []
    for lane in track_elem.iter("TakeLane"):
        events = lane.find("ClipAutomation/Events")
        if events is None:
            continue
        for el in events:
            if el.tag in ("AudioClip", "MidiClip"):
                out.append(el)
    return out


def _iter_clip_elements(scope):
    """Yield AudioClip / MidiClip elements found under ``scope``."""
    if scope is None:
        return
    for tag in ("AudioClip", "MidiClip"):
        for el in scope.iter(tag):
            yield el


def _parse_scenes(live_set) -> list[str]:
    """Session-view scene names in row order (empty when the set has none)."""
    out: list[str] = []
    scenes_elem = live_set.find("Scenes")
    if scenes_elem is None:
        return out
    for scene in scenes_elem.findall("Scene"):
        name_e = scene.find("Name")
        out.append(name_e.get("Value", "") if name_e is not None else "")
    return out


def _parse_session_clips(
    track_elem,
    track_index: int,
    project: DawProject,
    project_dir: Path,
    media_index: dict[str, str],
    scenes: list[str],
) -> list[DawClip]:
    """Collect a track's SESSION-view clips as scene-grid cells.

    Additive to the single arrangement lane from ``_parse_clips``: each
    ``ClipSlot`` is a scene row, so the Session tab can render the clip-launch
    grid. These carry scene/slot/track indices; arrangement clips leave those
    None. The EDIT-timeline flow filters scene-tagged clips out (it uses only
    the arrangement lane), so this never disturbs the existing import.
    """
    main_seq = track_elem.find(".//DeviceChain/MainSequencer")
    slot_list = main_seq.find("ClipSlotList") if main_seq is not None else None
    if slot_list is None:
        return []
    out: list[DawClip] = []
    for slot_index, slot in enumerate(slot_list.findall("ClipSlot")):
        for clip_elem in _iter_clip_elements(slot):
            clip = _build_clip(
                clip_elem, project, project_dir, media_index, arrangement=False
            )
            if clip is None:
                continue
            clip.track_index = track_index
            clip.scene_index = slot_index
            clip.slot_index = slot_index
            clip.scene_name = scenes[slot_index] if slot_index < len(scenes) else ""
            out.append(clip)
            break  # one clip per slot
    return out


def _build_clip(
    clip_elem,
    project: DawProject,
    project_dir: Path,
    media_index: dict[str, str],
    arrangement: bool,
):
    is_midi = clip_elem.tag == "MidiClip"
    n = clip_elem.find("Name")
    cname = n.get("Value", "") if n is not None else ""
    if not cname:
        cname = "MIDI Clip" if is_midi else "Audio Clip"

    tempo = project.tempo

    # Timing (beats -> seconds).
    if arrangement:
        start_beats = _read_attr_or_child_float(clip_elem, "CurrentStart", 0.0)
        end_beats = _read_attr_or_child_float(clip_elem, "CurrentEnd", start_beats)
    else:
        # Session clip: derive a length from loop region so the clip has size.
        start_beats = 0.0
        loop_end = _read_attr_or_child_float(clip_elem, "CurrentEnd", None)
        if loop_end is None:
            loop_end = _read_loop_length(clip_elem)
        end_beats = loop_end if loop_end is not None else 4.0

    start_time = _beats_to_sec(start_beats, tempo)
    end_time = _beats_to_sec(end_beats, tempo)
    if end_time < start_time:
        end_time = start_time

    loop_start_beats = _read_attr_or_child_float(clip_elem, "LoopStart", None)
    if loop_start_beats is None:
        loop_start_beats = _read_path_float(clip_elem, "Loop/LoopStart")
    loop_end_beats = _read_attr_or_child_float(clip_elem, "LoopEnd", None)
    if loop_end_beats is None:
        loop_end_beats = _read_path_float(clip_elem, "Loop/LoopEnd")

    loop_start = (
        _beats_to_sec(loop_start_beats, tempo) if loop_start_beats is not None else None
    )
    loop_end = (
        _beats_to_sec(loop_end_beats, tempo) if loop_end_beats is not None else None
    )

    file_path = None
    midi_notes = None

    if is_midi:
        midi_notes = _parse_midi_notes(clip_elem, tempo, project)
        # An empty MIDI clip (a placeholder region with no notes) carries no
        # music; drop it so it neither clutters the timeline nor creates a
        # phantom occupied region when silent gaps are collapsed.
        if not midi_notes:
            return None
    else:
        file_path = _resolve_audio_path(clip_elem, project, project_dir, media_index)

    return DawClip(
        name=cname,
        start_time=start_time,
        end_time=end_time,
        loop_start=loop_start,
        loop_end=loop_end,
        file_path=file_path,
        midi_notes=midi_notes,
    )


def _read_loop_length(clip_elem) -> float | None:
    """Best-effort session-clip length from its loop region (in beats)."""
    ls = _read_path_float(clip_elem, "Loop/LoopStart")
    le = _read_path_float(clip_elem, "Loop/LoopEnd")
    if ls is not None and le is not None:
        return max(0.0, le - ls)
    return None


def _resolve_audio_path(
    clip_elem, project: DawProject, project_dir: Path, media_index: dict[str, str]
) -> str | None:
    """Resolve an audio clip's on-disk sample path.

    Tries, in order: any stored absolute/relative path that exists on disk; then
    a by-filename lookup in the project's media index (so a project authored on
    another machine still finds the sample that ships in its bundle). Only when
    nothing resolves is the stored path recorded as missing.
    """
    file_ref = clip_elem.find(".//SampleRef/FileRef")
    if file_ref is None:
        file_ref = clip_elem.find(".//SourceProxy/SampleRef/FileRef")
    if file_ref is None:
        file_ref = clip_elem.find(".//FileRef")
    if file_ref is None:
        return None

    candidates: list[str | None] = []

    # Absolute path (child element or, in newer schemas, attribute) and Path.
    for sub in ("AbsolutePath", "Path"):
        el = file_ref.find(sub)
        if el is not None and el.get("Value"):
            candidates.append(el.get("Value"))
        attr = file_ref.get(sub)
        if attr:
            candidates.append(attr)

    # RelativePath, both forms: a single Value attribute (Live 11/12) and the
    # older RelativePathElement Dir list. Joined to the project folder.
    rel_el = file_ref.find("RelativePath")
    if rel_el is not None and rel_el.get("Value"):
        candidates.append(str((project_dir / rel_el.get("Value")).resolve()))
    rel = _read_relative_path(file_ref)
    if rel:
        candidates.append(str((project_dir / rel).resolve()))

    # The sample's filename (for the by-name index lookup).
    name_el = file_ref.find("Name")
    base_name = name_el.get("Value") if name_el is not None else None

    # Shared resolution: on-disk candidate -> by-filename relink -> record missing.
    return media.resolve_audio(
        candidates, base_name, media_index, project.missing_files
    )


def _read_relative_path(file_ref) -> str | None:
    """Reconstruct a RelativePath from RelativePathElement Dir entries + Name."""
    parts: list[str] = []
    rel_root = file_ref.find("RelativePath")
    if rel_root is not None:
        for el in rel_root.iter("RelativePathElement"):
            d = el.get("Dir")
            if d:
                parts.append(d)
    name_el = file_ref.find("Name")
    name = name_el.get("Value") if name_el is not None else None
    if not parts and not name:
        return None
    if name:
        parts.append(name)
    return "/".join(p for p in parts if p)


# --------------------------------------------------------------------------- #
# MIDI notes
# --------------------------------------------------------------------------- #


def _parse_midi_notes(clip_elem, tempo: float, project: DawProject) -> list[dict]:
    """Extract MIDI notes from a MidiClip, beats -> seconds relative to clip."""
    notes: list[dict] = []

    notes_root = clip_elem.find("Notes")
    if notes_root is None:
        notes_root = clip_elem

    # Modern format: Notes/KeyTracks/KeyTrack with MidiKey + MidiNoteEvent.
    key_tracks = notes_root.find("KeyTracks")
    if key_tracks is not None:
        for key_track in key_tracks.iter("KeyTrack"):
            midi_key_el = key_track.find("MidiKey")
            pitch = _read_int(midi_key_el, None)
            if pitch is None:
                # Some versions nest it differently.
                pitch = _read_path_int(key_track, "MidiKey")
            ev_container = key_track.find("Notes")
            events = (
                ev_container.iter("MidiNoteEvent")
                if ev_container is not None
                else key_track.iter("MidiNoteEvent")
            )
            for ev in events:
                note = _note_from_event(ev, tempo, default_pitch=pitch)
                if note is not None:
                    notes.append(note)
        if notes:
            notes.sort(key=lambda x: x["start"])
            return notes

    # Older format: Notes/MidiNoteEvent with a @Pitch attribute.
    for ev in notes_root.iter("MidiNoteEvent"):
        note = _note_from_event(ev, tempo, default_pitch=None)
        if note is not None:
            notes.append(note)

    # Only warn when the clip actually carries note events we failed to read; an
    # empty MIDI clip (a placeholder region with no notes) is legitimate.
    if not notes and clip_elem.find(".//MidiNoteEvent") is not None:
        project.warnings.append(
            "A MIDI clip's notes could not be parsed (unknown schema)."
        )

    notes.sort(key=lambda x: x["start"])
    return notes


def _note_from_event(ev, tempo: float, default_pitch: int | None) -> dict | None:
    pitch = default_pitch
    if pitch is None:
        try:
            p = ev.get("Pitch")
            if p is not None:
                pitch = int(float(p))
        except (TypeError, ValueError):
            pitch = None
    if pitch is None:
        return None
    pitch = max(0, min(127, int(pitch)))

    time_beats = _to_float(ev.get("Time"), 0.0)
    dur_beats = _to_float(ev.get("Duration"), 0.0)
    vel = _to_float(ev.get("Velocity"), 100.0)

    velocity = max(1, min(127, int(round(vel))))
    return {
        "pitch": pitch,
        "start": _beats_to_sec(time_beats, tempo),
        "duration": _beats_to_sec(dur_beats, tempo),
        "velocity": velocity,
    }


# --------------------------------------------------------------------------- #
# Devices
# --------------------------------------------------------------------------- #


def _is_instrument_tag(tag: str) -> bool:
    return tag in _INSTRUMENT_TAGS


def _collect_device_elems(container, out: list, rack_name: str | None) -> None:
    """Flatten a Devices container into an ordered list of (device_elem, rack_name).

    Rack containers (audio/instrument/MIDI effect racks) are kept AND descended
    into, so nested effects become first-class chain entries theDAW can host and a
    controller can drive, while the rack wrapper is preserved so macro mappings
    keep a home. Drum racks are kept but not descended (their cells are
    instruments, not FX).
    """
    if container is None:
        return
    for dev in list(container):
        if dev.tag in _SKIP_DEVICE_TAGS:
            continue
        out.append((dev, rack_name))
        if dev.tag in _RACK_RECURSE_TAGS:
            un = dev.find("UserName")
            nm = (
                un.get("Value")
                if (un is not None and un.get("Value"))
                else _NATIVE_DEVICE_NAMES.get(dev.tag, _humanize_tag(dev.tag))
            )
            branches = dev.find("Branches")
            if branches is not None:
                for branch in list(branches):
                    dc = branch.find("DeviceChain")
                    inner = None
                    if dc is not None:
                        for sub in list(dc):
                            cand = sub.find("Devices")
                            if cand is not None:
                                inner = cand
                                break
                        if inner is None:
                            inner = dc.find(".//Devices")
                    _collect_device_elems(inner, out, nm)


def _flatten_device_elements(track_elem) -> list:
    """Ordered (device_elem, rack_name) for a track, racks flattened."""
    top = track_elem.find(".//DeviceChain/DeviceChain/Devices")
    if top is None:
        top = track_elem.find(".//Devices")
    out: list = []
    _collect_device_elems(top, out, None)
    return out


def _parse_devices(track_elem, project: DawProject) -> list[DawDevice]:
    """Flattened signal-chain devices (nested rack devices included, in order)."""
    devices: list[DawDevice] = []
    for dev_elem, rack_name in _flatten_device_elements(track_elem):
        dev = _parse_device(dev_elem, project)
        if dev is None:
            continue
        dev.rack = rack_name
        dev.is_rack = dev_elem.tag in _RACK_ALL_TAGS
        dev.is_instrument = _is_instrument_tag(dev_elem.tag)
        devices.append(dev)
    return devices


def _parse_device(dev_elem, project: DawProject) -> DawDevice | None:
    tag = dev_elem.tag

    # Bypass: device On/Manual (1 = on, so bypassed when 0).
    on_elem = dev_elem.find("On/Manual")
    bypass = False
    if on_elem is not None:
        bypass = on_elem.get("Value", "true").lower() in ("false", "0")

    # Plugin hosts: PluginDevice (VST3/VST), AuPluginDevice (Audio Unit).
    if tag in ("PluginDevice", "AuPluginDevice") or "Plugin" in tag:
        return _parse_plugin_device(dev_elem, tag, bypass, project)

    # Native / stock devices (and racks).
    name = _NATIVE_DEVICE_NAMES.get(tag, _humanize_tag(tag))
    # Prefer the user-given device name if present.
    user_name_el = dev_elem.find(".//UserName")
    if user_name_el is not None and user_name_el.get("Value"):
        name = user_name_el.get("Value")

    params = _extract_native_params(dev_elem)

    return DawDevice(
        name=name,
        plugin_type="builtin",
        plugin_path=None,
        parameters=params,
        bypass=bypass,
        state=None,
    )


def _parse_plugin_device(
    dev_elem, tag: str, bypass: bool, project: DawProject
) -> DawDevice:
    name = ""
    plugin_type = "vst3"
    plugin_path: str | None = None

    vst3_info = dev_elem.find(".//Vst3PluginInfo")
    vst_info = dev_elem.find(".//VstPluginInfo")
    au_info = dev_elem.find(".//AuPluginInfo")

    if vst3_info is not None:
        plugin_type = "vst3"
        name = _child_value(vst3_info, "Name") or name
        plugin_path = _plugin_path_from(vst3_info) or plugin_path
    if not name and vst_info is not None:
        # VST2 (still surfaced as a VST plugin host).
        plugin_type = "vst3"
        name = (
            _child_value(vst_info, "PlugName") or _child_value(vst_info, "Name") or name
        )
        plugin_path = _plugin_path_from(vst_info) or plugin_path
    if au_info is not None and not name:
        plugin_type = "audiounit"
        name = _child_value(au_info, "Name") or name
        plugin_path = _plugin_path_from(au_info) or plugin_path

    if tag == "AuPluginDevice":
        plugin_type = "audiounit"

    if not plugin_path:
        plugin_path = _plugin_path_from(dev_elem)

    if not name:
        # Fall back to any Name/PlugName anywhere in the device.
        for sub in ("PlugName", "Name"):
            el = dev_elem.find(f".//{sub}")
            if el is not None and el.get("Value"):
                name = el.get("Value")
                break
    if not name:
        name = "Plugin"

    if plugin_path and not Path(plugin_path).exists():
        if plugin_path not in project.missing_files:
            project.missing_files.append(plugin_path)

    return DawDevice(
        name=name,
        plugin_type=plugin_type,
        plugin_path=plugin_path,
        parameters={},
        bypass=bypass,
        state=None,
    )


def _plugin_path_from(info_elem) -> str | None:
    """Pull a plugin file path out of a *PluginInfo element."""
    if info_elem is None:
        return None
    # Direct Path child.
    for sub in ("Path", "Dir"):
        el = info_elem.find(sub)
        if el is not None and el.get("Value"):
            return el.get("Value")
    # FileRef-based path.
    file_ref = info_elem.find(".//FileRef")
    if file_ref is not None:
        for sub in ("Path", "AbsolutePath"):
            el = file_ref.find(sub)
            if el is not None and el.get("Value"):
                return el.get("Value")
    # Any Path anywhere underneath.
    el = info_elem.find(".//Path")
    if el is not None and el.get("Value"):
        return el.get("Value")
    return None


def _extract_native_params(dev_elem) -> dict[str, float]:
    """Best-effort: collect a handful of named float parameters.

    Native Ableton params look like ``<SomeParam><Manual Value="x"/></SomeParam>``.
    We grab the first ~12 direct-ish numeric Manual values to give a useful
    snapshot without bloating the payload.
    """
    params: dict[str, float] = {}
    for child in dev_elem:
        if len(params) >= 12:
            break
        if child.tag in ("On", "UserName", "LomId", "LomIdView"):
            continue
        manual = child.find("Manual")
        if manual is None:
            continue
        val = manual.get("Value")
        if val is None:
            continue
        try:
            params[child.tag] = float(val)
        except (TypeError, ValueError):
            # Non-numeric (e.g. booleans as "true"/"false").
            low = val.lower()
            if low in ("true", "false"):
                params[child.tag] = 1.0 if low == "true" else 0.0
    return params


# --------------------------------------------------------------------------- #
# Controller (MIDI-learn) mappings
# --------------------------------------------------------------------------- #


def _track_elements_in_order(live_set) -> list:
    """Track elements in the SAME order as ``DawProject.tracks`` (regular tracks
    under <Tracks>, then the MasterTrack), so a resolved index lines up."""
    order: list = []
    tracks_elem = live_set.find("Tracks")
    if tracks_elem is not None:
        for te in tracks_elem:
            if te.tag in _TAG_TO_TYPE:
                order.append(te)
    master = live_set.find("MasterTrack")
    if master is None:
        master = live_set.find("MainTrack")
    if master is not None:
        order.append(master)
    return order


def _track_display_name(track_elem, track_type: str) -> str:
    ne = track_elem.find(".//Name/EffectiveName")
    if ne is None:
        ne = track_elem.find(".//Name/UserName")
    name = ne.get("Value", "") if ne is not None else ""
    if not name:
        name = {"master": "Master", "return": "Return"}.get(track_type, "Track")
    return name


def _device_display_name(dev_elem) -> str:
    tag = dev_elem.tag
    if tag in ("PluginDevice", "AuPluginDevice"):
        for info in ("Vst3PluginInfo", "VstPluginInfo", "AuPluginInfo"):
            ie = dev_elem.find(f".//{info}")
            if ie is not None:
                nm = _child_value(ie, "Name") or _child_value(ie, "PlugName")
                if nm:
                    return nm
        for sub in ("PlugName", "Name"):
            el = dev_elem.find(f".//{sub}")
            if el is not None and el.get("Value"):
                return el.get("Value")
        return "Plugin"
    un = dev_elem.find("UserName")
    if un is not None and un.get("Value"):
        return un.get("Value")
    return _NATIVE_DEVICE_NAMES.get(tag, _humanize_tag(tag))


def _is_device_tag(tag: str) -> bool:
    if tag in _SKIP_DEVICE_TAGS:
        return False
    if tag in ("PluginDevice", "AuPluginDevice") or tag in _NATIVE_DEVICE_NAMES:
        return True
    # Catch anything else Ableton models as a device (Max for Live's
    # MxDevice*, group/rack *Device tags, …) while excluding *DeviceChain
    # containers.
    return "Device" in tag and "DeviceChain" not in tag


def _parse_controller_mappings(live_set) -> list[DawControllerMapping]:
    """Extract MIDI remote (MIDI-learn) mappings from the set.

    Ableton stores each mapping as a ``<KeyMidi>`` child of the mapped parameter:
    ``<IsNote>``, ``<Channel>`` (1..16, 0 = All), ``<NoteOrController>`` (CC# or
    note), ``<ControllerMapMode>``, and an empty ``<PersistentKeyString>`` (a
    non-empty one is a computer-key mapping, not MIDI). We resolve each mapping's
    target by walking ancestors to the enclosing device and track, so theDAW can
    re-attach a controller to the same targets on Open.
    """
    mappings: list[DawControllerMapping] = []

    # ElementTree has no parent pointers; build a child -> parent map once.
    parent: dict = {}
    for p in live_set.iter():
        for c in p:
            parent[c] = p

    track_order = _track_elements_in_order(live_set)
    track_index_by_id = {id(te): i for i, te in enumerate(track_order)}
    # Per-track flattened device-element -> index, matching DawTrack.devices order.
    track_flat_cache: dict = {}

    for km in live_set.iter("KeyMidi"):
        pks = km.find("PersistentKeyString")
        if pks is not None and (pks.get("Value") or "").strip():
            continue  # computer-key mapping, not MIDI
        num = _read_int(km.find("NoteOrController"), -1)
        if num is None or num < 0:
            continue  # unmapped placeholder
        is_note_el = km.find("IsNote")
        is_note = is_note_el is not None and (
            is_note_el.get("Value", "false").lower() in ("true", "1")
        )
        ch_raw = _read_int(km.find("Channel"), 0) or 0
        channel = ch_raw - 1 if ch_raw >= 1 else -1  # Ableton 1..16; 0 = All
        map_mode = _read_int(km.find("ControllerMapMode"), 0) or 0

        # Walk up: parameter -> (plugin param name) -> device -> track.
        param_parent = parent.get(km)
        param_name = param_parent.tag if param_parent is not None else ""
        device_name = ""
        device_elem = None
        track_name = ""
        track_index = -1
        track_elem = None
        in_mixer = False

        cur = param_parent
        while cur is not None:
            tag = cur.tag
            if tag in ("PluginFloatParameter", "PluginParameter"):
                pn = cur.find("ParameterName")
                if pn is not None and pn.get("Value"):
                    param_name = pn.get("Value")
            elif tag in ("Mixer", "MixerDevice"):
                in_mixer = True
            elif device_elem is None and _is_device_tag(tag):
                device_elem = cur
                device_name = _device_display_name(cur)
            if track_elem is None and id(cur) in track_index_by_id:
                track_elem = cur
                track_index = track_index_by_id[id(cur)]
                track_name = _track_display_name(cur, _TAG_TO_TYPE.get(tag, "audio"))
            cur = parent.get(cur)

        # Resolve the device's index within the track's flattened chain.
        device_index = -1
        if track_elem is not None and device_elem is not None:
            flat = track_flat_cache.get(id(track_elem))
            if flat is None:
                flat = {
                    id(e): i
                    for i, (e, _rk) in enumerate(_flatten_device_elements(track_elem))
                }
                track_flat_cache[id(track_elem)] = flat
            device_index = flat.get(id(device_elem), -1)

        is_macro = param_name.startswith("MacroControls")
        is_instrument_target = (
            device_elem is not None and device_elem.tag in _INSTRUMENT_TAGS
        )

        if device_name:
            kind = "device"
        elif in_mixer:
            kind = "mixer"
        else:
            kind = "unknown"

        mappings.append(
            DawControllerMapping(
                is_note=is_note,
                channel=channel,
                number=num,
                map_mode=map_mode,
                target_kind=kind,
                track_name=track_name,
                track_index=track_index,
                device_name=device_name,
                device_index=device_index,
                param_name=param_name,
                is_macro=is_macro,
                is_instrument_target=is_instrument_target,
            )
        )

    return mappings


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _read_color(track_elem) -> str | None:
    """Read a track color. Ableton stores either a hex @Color or a ColorIndex."""
    color_el = track_elem.find(".//Color")
    if color_el is not None and color_el.get("Value"):
        v = color_el.get("Value")
        # ColorIndex-style integer -> keep as a #RRGGBB-ish best effort? Ableton
        # uses a palette index, not RGB, so we surface it as a string token.
        return _color_token(v)
    ci = track_elem.find(".//ColorIndex")
    if ci is not None and ci.get("Value"):
        return _color_token(ci.get("Value"))
    # Some schemas put color on the track element directly.
    direct = track_elem.get("Color") or track_elem.get("ColorIndex")
    if direct:
        return _color_token(direct)
    return None


def _color_token(v: str | None) -> str | None:
    """Normalize a color value to a hex string when it looks like RGB."""
    if v is None:
        return None
    try:
        n = int(v)
    except (TypeError, ValueError):
        return v if v.startswith("#") else None
    if n < 0:
        return None
    # Heuristic: large values are packed RGB; small values are palette indices.
    if n > 0xFFFF:
        return f"#{n & 0xFFFFFF:06x}"
    return f"index:{n}"


def _child_value(elem, child_tag: str) -> str | None:
    if elem is None:
        return None
    el = elem.find(child_tag)
    if el is not None and el.get("Value"):
        return el.get("Value")
    return None


def _humanize_tag(tag: str) -> str:
    """Turn a CamelCase device tag into a spaced display name."""
    out = []
    for i, ch in enumerate(tag):
        if ch.isupper() and i > 0 and not tag[i - 1].isupper():
            out.append(" ")
        out.append(ch)
    return "".join(out)


def _beats_to_sec(beats: float, tempo: float) -> float:
    if tempo <= 0:
        return 0.0
    return round(beats * 60.0 / tempo, 6)


def _to_float(v, default: float) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _read_float(elem, default):
    """Read a numeric Ableton `Value` attribute, falling back to `default`."""
    if elem is None:
        return default
    try:
        return float(elem.get("Value", str(default)))
    except (TypeError, ValueError):
        return default


def _read_int(elem, default):
    if elem is None:
        return default
    try:
        return int(float(elem.get("Value")))
    except (TypeError, ValueError):
        return default


def _read_path_float(parent, path: str):
    el = parent.find(path)
    if el is None:
        return None
    try:
        return float(el.get("Value"))
    except (TypeError, ValueError):
        return None


def _read_path_int(parent, path: str):
    el = parent.find(path)
    if el is None:
        return None
    try:
        return int(float(el.get("Value")))
    except (TypeError, ValueError):
        return None


def _read_attr_or_child_float(elem, name: str, default):
    """Read ``name`` as either an attribute or a child element's @Value."""
    if elem is None:
        return default
    attr = elem.get(name)
    if attr is not None:
        try:
            return float(attr)
        except (TypeError, ValueError):
            pass
    child = elem.find(name)
    if child is not None:
        v = child.get("Value")
        if v is not None:
            try:
                return float(v)
            except (TypeError, ValueError):
                pass
    return default


def _linear_to_db(gain: float) -> float:
    """Convert a linear amplitude gain (1.0 = 0 dB) to decibels, floored at silence."""
    if gain <= 0.0:
        return -120.0
    return round(20.0 * math.log10(gain), 2)
