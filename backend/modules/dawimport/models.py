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
    # Set when this device was flattened out of a rack (the rack's display name),
    # so the chain can show grouping and macro mappings keep their context.
    rack: str | None = None
    # True for instrument/sampler devices (they are not audio effects and have no
    # live per-track engine in theDAW; a controller mapping into one is reported).
    is_instrument: bool = False
    # True for a rack container itself (its nested devices follow it, flattened).
    is_rack: bool = False


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
class DawControllerMapping:
    """One MIDI remote (MIDI-learn) mapping stored in the project.

    A physical MIDI control -- a CC or note on a channel -- bound to a target
    parameter, so theDAW can auto-attach a controller (e.g. the Audima Sway) to
    the same tracks/effects the project wired it to. Channel is 0-indexed
    (0..15); ``channel == -1`` means the mapping is omni ("All" channels in the
    source DAW). ``is_note`` distinguishes a note mapping from a CC mapping.
    ``target_kind`` is "mixer" (track volume/pan/mute/send), "device" (a device
    parameter), or "unknown". ``track_index`` indexes into ``DawProject.tracks``
    (-1 when it could not be resolved).
    """

    is_note: bool
    channel: int
    number: int
    map_mode: int = 0
    target_kind: str = "unknown"
    track_name: str = ""
    track_index: int = -1
    device_name: str = ""
    # Index of the target device within DawTrack.devices (the flattened chain),
    # -1 when it could not be resolved. Lets the frontend attach unambiguously.
    device_index: int = -1
    param_name: str = ""
    # True when the mapped parameter is a rack macro (MacroControls.N) — the
    # frontend fans it out to the params the macro modulates.
    is_macro: bool = False
    # True when the target is an instrument-internal parameter (no theDAW engine).
    is_instrument_target: bool = False


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
    controller_mappings: list[DawControllerMapping] = field(default_factory=list)
    plugins_used: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    missing_files: list[str] = field(default_factory=list)

    def collapse_silent_gaps(
        self, min_gap_sec: float = 8.0, keep_gap_sec: float = 1.0
    ) -> float:
        """Remove long silent stretches from the arrangement timeline.

        Some imported projects span many minutes of mostly-empty time (e.g.
        Ableton sets with leftover recorded takes stranded far out on the
        timeline). This shifts every clip earlier so the music plays
        back-to-back, while preserving each clip's position RELATIVE to every
        other clip across all tracks, so the mix stays in sync. Occupied spans
        within ``min_gap_sec`` of each other are treated as one block and never
        drift apart; only gaps longer than that collapse, each down to
        ``keep_gap_sec``, and the first block is moved to t=0. Tight projects
        (no oversized gaps, no lead-in silence) are left unchanged. MIDI notes
        are clip-relative, so they need no adjustment. Returns seconds removed.
        """
        timed = [c for t in self.tracks for c in t.clips if c.end_time > c.start_time]
        if not timed:
            return 0.0

        # Merge occupied spans across ALL tracks into blocks.
        intervals = sorted((c.start_time, c.end_time) for c in timed)
        blocks: list[list[float]] = []
        for s, e in intervals:
            if blocks and s <= blocks[-1][1] + min_gap_sec:
                blocks[-1][1] = max(blocks[-1][1], e)
            else:
                blocks.append([s, e])

        # Assign each block a left-shift offset; first block lands at t=0.
        offsets: list[tuple[float, float, float]] = []
        cursor = 0.0
        for bs, be in blocks:
            offsets.append((bs, be, bs - cursor))
            cursor += (be - bs) + keep_gap_sec

        original_end = blocks[-1][1]
        new_end = cursor - keep_gap_sec
        removed = original_end - new_end
        if removed <= 1.0:
            return 0.0  # nothing meaningful to collapse

        def _shift(t: float) -> float:
            for bs, be, off in offsets:
                if bs - 1e-6 <= t <= be + 1e-6:
                    return t - off
            for bs, be, off in offsets:  # in a collapsed gap -> next block start
                if t < bs:
                    return bs - off
            bs, be, off = offsets[-1]  # past the last block
            return be - off

        for t in self.tracks:
            for c in t.clips:
                if c.end_time > c.start_time:
                    c.start_time = _shift(c.start_time)
                    c.end_time = _shift(c.end_time)
        for loc in self.locators:
            loc.position = _shift(loc.position)

        return removed

    def to_dict(self) -> dict:
        from dataclasses import asdict

        return asdict(self)
