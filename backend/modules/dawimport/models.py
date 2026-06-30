"""DAW-agnostic intermediate model for imported projects.

All three DAW parsers (Ableton, Reaper, Logic) produce this same structure,
which mapping.py then converts into a TasmoProject for use in theDAW.
"""

from __future__ import annotations
from dataclasses import dataclass, field


@dataclass
class DawDevice:
    """One effect/instrument device on a track (or, later, a clip).

    ``plugin_type`` is "vst3" | "audiounit" | "builtin". For VST/AU devices,
    ``plugin_path`` is the full on-disk path (so theDAW can re-host it);
    builtin/native devices leave it None and rely on ``name`` for mapping.
    ``parameters`` is a best-effort name->value snapshot. ``state`` optionally
    carries an opaque base64 plugin-state chunk for later exact restoration.
    Devices are stored in signal-chain order.
    """

    name: str
    plugin_type: str  # "vst3" | "audiounit" | "builtin"
    plugin_path: str | None = None
    parameters: dict[str, float] = field(default_factory=dict)
    bypass: bool = False
    state: str | None = None


@dataclass
class DawClip:
    """One clip on a track.

    Timing convention (ALL importers): ``start_time``/``end_time`` are in
    SECONDS on the project timeline (parsers convert beats via tempo, samples
    via sample rate, etc.). ``midi_notes`` is a list of dicts shaped
    ``{"pitch": int 0-127, "start": float seconds RELATIVE to the clip,
    "duration": float seconds, "velocity": int 1-127}``. ``file_path`` is the
    absolute on-disk audio sample path for audio clips (None for pure MIDI).
    """

    name: str
    start_time: float
    end_time: float
    loop_start: float | None = None
    loop_end: float | None = None
    file_path: str | None = None
    midi_notes: list[dict] | None = None
    warp_markers: list[dict] | None = None


@dataclass
class DawTrack:
    name: str
    type: str  # "audio" | "midi" | "return" | "master"
    volume_db: float = 0.0
    pan: float = 0.0
    mute: bool = False
    solo: bool = False
    color: str | None = None
    clips: list[DawClip] = field(default_factory=list)
    devices: list[DawDevice] = field(default_factory=list)


@dataclass
class DawLocator:
    name: str
    position: float
    color: str | None = None


@dataclass
class DawProject:
    """DAW-agnostic intermediate representation."""

    source_daw: str  # "ableton" | "reaper" | "logic"
    source_version: str = ""
    name: str = "Imported Project"
    tempo: float = 120.0
    time_signature: tuple[int, int] = (4, 4)
    sample_rate: int = 44100
    tracks: list[DawTrack] = field(default_factory=list)
    locators: list[DawLocator] = field(default_factory=list)
    plugins_used: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    missing_files: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        from dataclasses import asdict

        return asdict(self)
