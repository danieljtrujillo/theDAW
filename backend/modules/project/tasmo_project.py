"""TasmoProject Pydantic model — the full project state for .tasmo files."""

from __future__ import annotations
from datetime import datetime, timezone
from pydantic import BaseModel, Field


class VstPluginState(BaseModel):
    plugin_path: str
    plugin_name: str
    parameters: dict[str, float] = {}
    preset_path: str | None = None
    instance_id: str = ""


class EffectChainNode(BaseModel):
    node_type: str  # "ffmpeg" | "vst3" | "builtin"
    effect_name: str
    parameters: dict[str, float] = {}
    bypass: bool = False
    vst_state: VstPluginState | None = None
    # Stable chain-entry id so controller mappings (and other references) keyed to
    # a specific FX slot survive a save/load round-trip.
    id: str | None = None


class Locator(BaseModel):
    id: str
    name: str
    position: float
    color: str | None = None


class AutomationPoint(BaseModel):
    time: float
    value: float
    curve_type: str = "linear"


class AutomationLane(BaseModel):
    target: str
    points: list[AutomationPoint] = []


class Clip(BaseModel):
    id: str
    name: str
    clip_type: str  # "audio" | "midi" | "generated"
    track_id: str
    start_time: float = 0.0
    end_time: float = 0.0
    loop_start: float | None = None
    loop_end: float | None = None
    audio_file: str | None = None
    audio_file_checksum: str | None = None
    sample_rate: int = 48000
    channels: int = 2
    midi_notes: list[dict] | None = None
    midi_file: str | None = None
    # Per-clip mute (the clip is skipped by playback and bounces). Defaulted so
    # .tasmo files written before this field existed still validate.
    muted: bool = False
    # Per-clip gain as a linear multiplier (1.0 = unity) and the fade lengths in
    # seconds. Applied before the track fader by both the live scheduler and every
    # offline bounce. Defaulted for the same backward-compatibility reason.
    gain: float = 1.0
    fade_in: float = 0.0
    fade_out: float = 0.0
    # Seconds into the source audio where this clip starts playing. Without this
    # a trimmed or split clip reloads with the right position and length but the
    # WRONG audio, because the full untrimmed source is embedded and playback
    # restarts it from zero. Defaulted so pre-existing .tasmo files still validate.
    offset_into_source: float = 0.0
    # Session-view (Perform tab) placement, mirroring dawimport's DawClip. None
    # on an arrangement clip. Without these the format had no way to represent a
    # clip-launch grid at all, so every session clip was discarded on save and
    # the grid was rebuilt from arrangement clips on load. Defaulted, so .tasmo
    # files written before the grid was representable still validate.
    track_index: int | None = None
    scene_index: int | None = None
    slot_index: int | None = None
    generation_prompt: str | None = None
    generation_seed: int | None = None
    generation_params: dict | None = None
    warp_markers: list[dict] | None = None
    effect_chain: list[EffectChainNode] = []


class Track(BaseModel):
    id: str
    name: str
    type: str  # "audio" | "midi" | "return" | "master" | "bus"
    color: str | None = None
    volume_db: float = 0.0
    pan: float = 0.0
    mute: bool = False
    solo: bool = False
    arm: bool = False
    order: int = 0
    clips: list[Clip] = []
    effect_chain: list[EffectChainNode] = []
    input_routing: str | None = None
    output_routing: str | None = None
    send_amounts: dict[str, float] = {}


class TasmoProject(BaseModel):
    """The complete .tasmo project model."""

    format_version: int = 1
    project_name: str = "Untitled"
    created_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    modified_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    author: str = ""
    tempo: float = 120.0
    time_signature: list[int] = [4, 4]
    sample_rate: int = 48000
    tracks: list[Track] = []
    locators: list[Locator] = []
    automation: list[AutomationLane] = []
    generation_history: list[dict] = []
    source_daw: str | None = None
    source_daw_version: str | None = None
    import_warnings: list[str] = []
    # Session-view scene names in row order, mirroring DawProject.scenes. Empty
    # for projects with no clip-launch grid. Paired with the per-clip scene
    # indices above: without both, a saved Perform grid reloaded as a generic
    # "Scene 1..N" ladder because the names had nowhere to live.
    scenes: list[str] = []
    # Persisted controller (MIDI-learn) auto-attach: the resolved Sway bindings +
    # unattached list + source project name, so reopening a saved session re-wires
    # the hardware to the same targets without re-importing the source DAW project.
    # Opaque nested shape (mirrors the frontend SwayResolveResult); see
    # swayImportResolve.ts / swayImportStore.ts.
    controller_mappings: dict | None = None
    # Persisted Perform-tab routing: the transport + per-scene launch controls and
    # the Sway-dim -> track modulation routes, so reopening a saved session in the
    # Perform tab restores the same scene-launch + modulation assignments. Opaque
    # nested shape (mirrors the frontend PerformRoutingSnapshot); see
    # performRouting.ts.
    perform_routing: dict | None = None
