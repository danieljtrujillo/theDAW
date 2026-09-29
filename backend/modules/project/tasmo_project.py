"""TasmoProject Pydantic model — the full project state for .tasmo files."""

from __future__ import annotations
import math
from datetime import datetime, timezone
from pydantic import BaseModel, Field, field_validator, model_validator


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


class Loop(BaseModel):
    """The transport's cycle region, in timeline seconds.

    ``enabled`` is stored separately from the bounds so turning the loop off
    does not throw the region away — that is how the editor holds it
    (``loopEnabled`` / ``loopStart`` / ``loopEnd``), and a file that flattened
    the two would reopen with the user's region gone.
    """

    enabled: bool = False
    start_sec: float = 0.0
    end_sec: float = 0.0


class AutomationPoint(BaseModel):
    time: float
    value: float
    curve_type: str = "linear"


class AutomationLane(BaseModel):
    target: str
    points: list[AutomationPoint] = []


class ChainVst(BaseModel):
    """The plugin identity on a master-chain entry (frontend ``VstNode``).

    ``raw_state`` is the opaque base64 blob the plugin's native editor produced.
    It is what makes a hosted VST worth persisting at all — the dialed-in sound
    — and it is the reason the master chains are NOT stored as
    ``EffectChainNode``: that model carries a ``VstPluginState.parameters``
    snapshot and has nowhere to put an opaque state blob.
    """

    plugin_path: str = ""
    plugin_name: str = ""
    raw_state: str | None = None
    # Which host captured raw_state ("thedaw", the live host, or "pedalboard"):
    # a print goes back through the host that captured it. None: the default.
    state_host: str | None = None


class ChainEntry(BaseModel):
    """One insert on the MASTER bus, in the shape the editor holds it.

    Mirrors ``ChainEntry`` in ``frontend/src/state/effectChainStore.ts`` field
    for field, because both master chains ARE ``ChainEntry[]`` in the store and
    a lossy translation is what would make a reloaded master sound different
    from the one the user saved. ``id`` is required and stable: automation lanes
    key off it (``AutomationLaneTarget.entry_id``), so a chain that reloaded
    with fresh ids would reload with its automation pointing at nothing.

    Per-track and per-bus chains keep using ``EffectChainNode`` — that shape is
    the .tasmo interchange node (bypass/parameters/vst_state), written by DAW
    importers as well as by theDAW. This one is theDAW's own live rack.
    """

    id: str
    effect: str
    params: dict[str, float] = {}
    enabled: bool = True
    vst: ChainVst | None = None
    label: str | None = None


class AutomationLaneTarget(BaseModel):
    """What an editor automation lane writes to (frontend ``AutomationTarget``).

    ``kind`` is "trackVolume" | "trackPan" | "trackFx" | "masterFx" |
    "trackMidiCc"; the other three name the track, the chain entry and the
    effect parameter the kind needs (for "trackMidiCc", ``param_key`` is the
    MIDI controller number). Not validated here on purpose, exactly as
    ``FollowAction`` is not: storage stays tolerant so a hand-edited or older file still loads, and the
    app is the strict half — the reader drops a lane whose target names a track
    or a chain entry the loaded project does not have, rather than restoring a
    lane that writes nowhere.
    """

    kind: str = ""
    track_id: str | None = None
    entry_id: str | None = None
    param_key: str | None = None


class EditorAutomationPoint(BaseModel):
    """One breakpoint: timeline seconds -> value, in the param's own units.

    ``curve`` shapes the segment that STARTS here, in [-1, 1]; None (the only
    form a lane written before curves existed has) means linear. Named ``t`` /
    ``v`` / ``curve`` after the frontend's ``AutomationPoint``, which is the
    only thing that reads them.
    """

    t: float
    v: float
    curve: float | None = None


class EditorAutomationLane(BaseModel):
    """One automated parameter's breakpoints (frontend ``AutomationLane``).

    Distinct from ``AutomationLane`` above, which is the flat importer shape
    (``target`` as one string, ``time``/``value``/``curve_type`` points) carried
    on ``TasmoProject.automation``. This one is the EDIT session's lane: a
    structured target the editor can resolve back to a fader, a knob or an FX
    parameter, and the points the lane editor draws.
    """

    id: str
    target: AutomationLaneTarget = Field(default_factory=AutomationLaneTarget)
    points: list[EditorAutomationPoint] = []
    enabled: bool = True

    @model_validator(mode="after")
    def _check_points(self) -> EditorAutomationLane:
        """Structural sanity only — a lane that cannot be sampled is corrupt.

        The points are a CURVE, read by walking neighbouring pairs, so:

        - they ASCEND strictly by ``t``. Two points at the same time describe a
          segment with no length, and a backwards pair describes one that runs
          the wrong way; a sampler has no reading of either.
        - ``t``, ``v`` and ``curve`` are FINITE. JSON has no NaN but msgpack
          does, and a NaN ``t`` compares false against everything: it would slip
          past the ascending check and then sample nowhere.

        An EMPTY lane is valid and kept — ``clearAutomationLane`` leaves exactly
        that, a lane the user emptied but did not delete.

        Raised as ``ValueError`` so the message surfaces through pydantic's
        ValidationError the way ``Clip._check_comp`` reports a bad comp.
        """
        previous: float | None = None
        for index, point in enumerate(self.points):
            if not math.isfinite(point.t) or not math.isfinite(point.v):
                raise ValueError(
                    f"Invalid automation lane {self.id!r}: point {index} has a "
                    f"non-finite t/v"
                )
            if point.curve is not None and not math.isfinite(point.curve):
                raise ValueError(
                    f"Invalid automation lane {self.id!r}: point {index} has a "
                    f"non-finite curve"
                )
            if previous is not None and point.t <= previous:
                raise ValueError(
                    f"Invalid automation lane {self.id!r}: points must ascend by "
                    f"t (point {index} is at {point.t}, after {previous})"
                )
            previous = point.t
        return self


class FollowAfter(BaseModel):
    """When a clip's follow action comes due.

    Two forms, kept in one model so the field is a plain nested object in the
    JSON: a musical distance from the clip's start (``bars`` + ``beats``), or a
    number of times the clip has played (``plays``). All three default to None
    so a half-written entry still validates; the frontend reads ``plays`` first
    and falls back to bars/beats (``lib/followAction.ts``).
    """

    bars: float | None = None
    beats: float | None = None
    plays: float | None = None


class FollowAction(BaseModel):
    """What a Session-grid clip does to its column once it has played.

    ``a`` is the action ("stop" | "next" | "prev" | "first" | "last" | "any" |
    "other" | "again"), ``b`` an optional second action, and ``chance`` the
    probability of ``a`` (the rest is ``b``; with no ``b`` the rule is
    one-sided). The action names are NOT validated here on purpose: storage is
    tolerant so an older or hand-edited file still loads, and the app is the
    strict half — ``parseFollowAction`` turns anything it cannot act on into no
    rule at all rather than into some other rule.
    """

    after: FollowAfter = Field(default_factory=FollowAfter)
    a: str = ""
    b: str | None = None
    chance: float = 1.0


class Take(BaseModel):
    """One alternate recording of a clip — a second pass over the same bars.

    Takes hang off the CLIP rather than a parallel track, because a clip in this
    format already names its own audio: an alternate take is simply another
    audio file on the same clip. ``audio_file`` is stored exactly like
    ``Clip.audio_file`` (an absolute path when linked, ``audio/<name>`` when
    embedded), so nothing new has to understand how take bytes are carried.

    ``offset_into_source`` and ``source_duration`` are per take because two
    passes are not the same length and are not trimmed at the same point. The
    take the clip is currently playing is mirrored onto the clip's own fields
    (``audio_file`` / ``offset_into_source`` / ...) — that invariant is what
    lets every reader that knows nothing about takes keep working. See
    ``frontend/src/lib/clipComp.ts`` for the model these mirror.
    """

    id: str
    name: str = ""
    audio_file: str | None = None
    mime_type: str = ""
    offset_into_source: float = 0.0
    source_duration: float = 0.0


class CompRegion(BaseModel):
    """One stretch of a comped clip, in CLIP-relative seconds.

    A comp is the choice of which take plays where, as an ordered list of
    boundaries: region ``i`` runs from its own ``start_sec`` to region
    ``i+1``'s, and the last one runs to the clip's end. There is no stored
    segment object — the boundary list IS the comp — and ``crossfade_sec`` is
    the fade across this region's LEADING boundary (0 = a butt cut; meaningless
    on the first region, whose boundary is the clip head).
    """

    start_sec: float = 0.0
    take_index: int = 0
    crossfade_sec: float = 0.0


class SongTime(BaseModel):
    """Where an audio clip's audio sits in a library song's own time.

    ``entry_id`` is the library entry whose analysis (tempo, beats, downbeats,
    meter) describes the audio: the entry itself for library audio, the song a
    stem was separated from for a stem. A second of the clip's audio is
    ``offset_sec + second * rate`` seconds of that song, so a beat match that
    stretched the audio still reads the song's beats at the right places.
    ``bpm`` is the song's analysed tempo when it was known.
    """

    entry_id: str
    bpm: float | None = None
    offset_sec: float = 0.0
    rate: float = 1.0

    @field_validator("offset_sec")
    @classmethod
    def _finite_offset(cls, v: float) -> float:
        if not math.isfinite(v):
            raise ValueError("song_time.offset_sec must be finite")
        return v

    @field_validator("rate")
    @classmethod
    def _positive_rate(cls, v: float) -> float:
        if not math.isfinite(v) or v <= 0:
            raise ValueError("song_time.rate must be a finite number above 0")
        return v

    @field_validator("bpm")
    @classmethod
    def _positive_bpm(cls, v: float | None) -> float | None:
        if v is None:
            return None
        return v if math.isfinite(v) and v > 0 else None


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
    # Each note is a dict. midi_notes are the notes as they sound (note, step,
    # length, velocity, and tick / ticks at 960 to the quarter when the note has
    # them), each looping lane's repeats written out, which playback renders
    # once. An imported DAW clip carries only these. A piano-roll clip saved by
    # theDAW stores each note once where it can: only midi_notes when its roll
    # notes play as written (no lanes, no bends), only roll_notes when unrolling
    # them across the clip's lanes gives the played notes (the reader then
    # rebuilds midi_notes), and both when neither rebuilds the other.
    midi_notes: list[dict] | None = None
    midi_file: str | None = None
    # A piano-roll clip's own notes, the same keys plus "lane" when a note sits
    # in one of the clip's polymeter lanes; the roll loads these. A note in
    # either list may also carry "tick"/"ticks" (its place and length at 960
    # PPQ, written while they agree with step/length), "channel" (1-16) and
    # "expr" ({pressure, timbre, pitch_bend}). Every key past the first four is
    # optional, so .tasmo files written before lanes existed still validate,
    # with None, and a reader that knows only the first four still gets a
    # playable note.
    roll_notes: list[dict] | None = None
    # Piano-roll clips: the grid length in 16th-note steps, the time signatures
    # by bar ([{bar, meter: {num, den, groups}}]), the steps before bar 0 and
    # the polymeter lanes ([{id, name, cycle_steps}]) the clip was bounced with.
    # A lane limited to part of the clip adds span_start and span_end (steps;
    # span_end None = the clip's end). A lane after A may also carry its own
    # time: "meter_map" (the same shape as the clip's, from the lane's bar 1)
    # and "tuplet" ({n, m}: n of its notes in the time of m of the roll's).
    # All of these are optional keys of the lane dict, so a lane written
    # before them loads in the roll's time over the whole clip.
    # Defaulted, so .tasmo files written before the roll had a meter still
    # validate and load with all four as None.
    total_steps: float | None = None
    meter_map: list[dict] | None = None
    pickup_steps: float | None = None
    lanes: list[dict] | None = None
    # Piano-roll clips: each lane's pitch bend ([{lane, range, points: [{step,
    # value, shape}]}], shape left out when linear, range in semitones).
    # Defaulted, so .tasmo files written before the roll had pitch bend still
    # validate and load with None.
    roll_bends: list[dict] | None = None
    # Piano-roll clips: the tempo map ([{beat, bpm, curve, fermata}], beat in
    # quarter notes from the clip's first step, curve "linear" when the tempo
    # ramps to the next event and left out for a step, fermata {beats, stretch}
    # on a hold instead of a tempo change). Written only when the clip changes
    # tempo; source_bpm is its first tempo. Defaulted, so .tasmo files written
    # before the roll had a tempo map still validate and load with None.
    tempo_map: list[dict] | None = None
    # Piano-roll clips: the ruler's named markers ([{id, tick, name, kind,
    # origin}], tick in 960ths of a quarter note from the clip's first step,
    # kind "section" or "movement", origin "form" only on a marker a FORM
    # section wrote at a song build). Written only when the clip has markers.
    # Defaulted, so .tasmo files written before the roll had markers still
    # validate and load with None.
    roll_markers: list[dict] | None = None
    # Piano-roll clips: the roll part the clip holds ({doc, id, order, name,
    # program, bank, channel, color, mute, solo, instrument_id}). ``doc`` is
    # shared by the clips of every part bounced from one roll, so opening one
    # clip in the roll opens them all, one part each; program and channel are
    # None when the part follows the roll's voice or takes the next free
    # channel. Defaulted, so .tasmo files written before the roll had parts
    # still validate and each roll clip opens as one part.
    roll_part: dict | None = None
    # MIDI clips: the GM program (0-127) the clip plays through when it has one
    # of its own (None = its track's, then the global instrument) and the
    # program its embedded audio was rendered with. source_bpm, on any clip: the
    # tempo a MIDI clip's notes were written at, or the tempo an audio clip was
    # tagged with (stretch-to-tempo reads it). Without them a saved arrangement
    # reopened with every part on the global instrument and every clip at the
    # project tempo. Defaulted, so .tasmo files written before these existed
    # still validate and load with None.
    instrument_program: int | None = None
    rendered_program: int | None = None
    # MIDI clips: whether the embedded audio was rendered on the General MIDI
    # drum channel (rendered_program then names the kit). Defaulted, so older
    # files load as rendered on a melodic channel.
    rendered_percussion: bool = False
    # MIDI clips with embedded audio: whether that render was out of date when
    # saved (its notes, tempo, lanes, bends or grid had changed and the
    # re-render had not landed), so the clip reopens with a stale render that
    # EDIT renders again instead of printing old notes; and whether EDIT made
    # the render only because the clip could not play live (no instrument, or
    # past the last live channel), so it is dropped once the clip plays live.
    # Defaulted, so older files open their renders as current and kept.
    render_stale: bool = False
    render_auto: bool = False
    # MIDI clips: the bank select (1-127) the clip's own program is chosen in
    # (a piano-roll part's Bank) and the bank its embedded audio was rendered
    # in; None for bank 0, the General MIDI set. Defaulted, so older files load
    # every clip in bank 0 as before.
    instrument_bank: int | None = None
    rendered_bank: int | None = None
    # MIDI clips: the sound bank (a user SF2/SF3/DLS bank's id, see
    # backend/modules/soundfonts) the clip's own program is picked from, with
    # instrument_bank its bank select inside that bank. None is the bundled
    # General MIDI bank. Defaulted, so older files load every clip on the
    # bundled bank, the sound they were saved with.
    instrument_bank_id: str | None = None
    source_bpm: float | None = None
    # Audio clips: the tempo the audio plays at after a beat match or a
    # stretch (EDIT's SYNC and BPM readout read it), and the library entry the
    # clip was dropped from (its analysis, beats and stems are keyed on it).
    # Without them a reopened clip lost its tempo and SYNC skipped it.
    # Defaulted, so older .tasmo files still validate.
    bpm: float | None = None
    library_entry_id: str | None = None
    # Audio clips from a library song or one of its stems: the song whose
    # rhythm analysis times the audio, and where the audio sits in that song's
    # time (see SongTime). EDIT's SYNC reads the song's tempo and beats through
    # it and "Use song tempo" lines the arrangement's bars up with the song's
    # downbeats. Defaulted, so older .tasmo files still validate.
    song_time: SongTime | None = None
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
    # What this cell does to its column once it has played for a set period —
    # the other half of what a clip-launch grid is. Placement alone reopened a
    # saved set with every column playing one clip forever, because the rule
    # that moved it on lived only in the browser tab. Defaulted to None, so
    # .tasmo files written before follow actions existed still validate.
    follow_action: FollowAction | None = None
    generation_prompt: str | None = None
    generation_seed: int | None = None
    generation_params: dict | None = None
    warp_markers: list[dict] | None = None
    # Alternate recordings of this clip, the comp across them, and which take
    # the clip's OWN fields currently mirror. Defaulted exactly like
    # `warp_markers` above, so a .tasmo written before takes existed still
    # validates and loads with all three as None — and no format_version bump
    # comes with them, because a reader that ignores the keys still gets a
    # correct project: the clip plays its active take, which is what its own
    # `audio_file` / `offset_into_source` already name.
    takes: list[Take] | None = None
    comp: list[CompRegion] | None = None
    active_take_index: int | None = None
    effect_chain: list[EffectChainNode] = []

    @model_validator(mode="after")
    def _check_comp(self) -> Clip:
        """A comp that cannot be played is a corrupt file, not a tolerable one.

        The rules, all structural, each one something a downstream reader would
        otherwise have to guess its way out of:

        - the regions ASCEND by ``start_sec``. The list is a boundary list, so
          an out-of-order (or duplicated) start describes a region with no
          length or a boundary that goes backwards — there is no reading of it.
        - every ``take_index`` names a take that exists. A comp region pointing
          past the end of ``takes`` selects audio that is not in the file.
        - ``start_sec`` and ``crossfade_sec`` are FINITE. JSON has no NaN, but
          msgpack does, and a NaN boundary compares false against everything:
          it would slip past the ascending check and then place a segment
          nowhere.
        - ``active_take_index`` names a take that exists, when there are takes.
          It says which take the clip's own ``audio_file`` mirrors, so an index
          past the end makes the clip's audio and its take list disagree about
          what is playing.

        Raised as ``ValueError`` so the message surfaces through pydantic's
        ValidationError the same way ``TasmoFile`` reports a bad archive.
        """
        take_count = len(self.takes or [])
        active = self.active_take_index
        if active is not None and take_count > 0 and not 0 <= active < take_count:
            raise ValueError(
                f"Invalid clip {self.id!r}: active_take_index {active} names no "
                f"take, the clip has {take_count}"
            )
        comp = self.comp
        if not comp:
            return self
        previous: float | None = None
        for index, region in enumerate(comp):
            if not math.isfinite(region.start_sec) or not math.isfinite(
                region.crossfade_sec
            ):
                raise ValueError(
                    f"Invalid clip {self.id!r}: comp region {index} has a "
                    f"non-finite start_sec/crossfade_sec"
                )
            if previous is not None and region.start_sec <= previous:
                raise ValueError(
                    f"Invalid clip {self.id!r}: comp regions must ascend by "
                    f"start_sec (region {index} starts at {region.start_sec}, "
                    f"after {previous})"
                )
            previous = region.start_sec
            if not 0 <= region.take_index < take_count:
                raise ValueError(
                    f"Invalid clip {self.id!r}: comp region {index} names take "
                    f"{region.take_index}, but the clip has {take_count} take(s)"
                )
        return self


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
    # The GM program (0-127) this track's MIDI clips play through when a clip
    # has none of its own; None = the global instrument.
    instrument_program: int | None = None
    # A drum track: its MIDI clips play and render on the General MIDI drum
    # channel, and instrument_program picks the kit. Defaulted, so .tasmo files
    # written before it existed load every track as melodic.
    is_percussion: bool = False
    # The reverb send (CC 91, 0-127) this track's MIDI channels open with;
    # None leaves the synth's own. Defaulted, so older files load without one.
    synth_reverb_send: int | None = None
    # The sound bank the track's program is picked from and its bank select
    # there (None: the bundled General MIDI bank, bank 0). Defaulted, so older
    # files load every track on the bundled bank.
    instrument_bank: int | None = None
    instrument_bank_id: str | None = None
    # Where the track's live MIDI also goes: {port_id, port_label, channel,
    # clock}. None keeps the track's MIDI inside theDAW. Opaque, like
    # perform_routing: the frontend reads it (projectImport trackMidiOutOf).
    midi_out: dict | None = None
    # How many channels notes with per-note expression rotate across (0-15);
    # None is the frontend's default.
    mpe_channels: int | None = None
    # The track plays through its MIDI out port alone, with no instrument of
    # theDAW's. Defaulted, so older files load every track on its instrument.
    external_only: bool = False
    # The track's VST3 instrument slot (frontend EditorTrack.instrument): the
    # plugin its MIDI plays through ahead of its inserts, with its captured
    # state, in the master chains' entry shape so raw_state is kept. None:
    # the track plays on the soundfont synths, as in every older file.
    instrument: ChainEntry | None = None
    # How that instrument is told a note's articulation: "keyswitch" (a note
    # from C0 up just before it) or "uacc" (Spitfire's UACC on CC 32). None:
    # keyswitch, as in every older file. Opaque here; the frontend checks it.
    articulation_switch: str | None = None
    # Arrangement folders: the folder track this track sits in (None = the
    # root), whether this track IS a folder (a row that holds no clips), and
    # whether a folder shows its children. Hierarchy only; routing is
    # output_routing's. Not validated here, exactly as FollowAction is not: the
    # reader resets a parent that names no folder or closes a loop. All
    # defaulted, so .tasmo files written before these existed load flat.
    parent_track_id: str | None = None
    is_folder: bool = False
    collapsed: bool = False


class Bus(BaseModel):
    """A mix bus: a summing point with its own insert rack, fader and mute.

    A bus is NOT a ``Track`` with ``type="bus"``. A track carries clips, arm,
    pan, solo and an order in the arrangement; a bus carries none of those, and
    writing one as a track meant every loader had to filter the arrangement by
    type and then invent the missing fields. The frontend's ``EditorBus`` is
    this shape exactly (``state/editorStore.ts``).

    Where the bus sits in the signal flow is ``output_routing`` — the id of the
    bus it feeds, or ``None`` for the master — matching ``Track.output_routing``.
    ``volume`` is a LINEAR fader multiplier (1.0 = unity), not dB like
    ``Track.volume_db``, because the editor's bus strip is a 0..1 fader.

    ``effect_chain`` is named to match ``Track`` and ``Clip`` rather than the
    frontend's ``fxChain``: one .tasmo file should not spell the same list two
    ways.
    """

    id: str
    name: str
    volume: float = 1.0
    mute: bool = False
    output_routing: str | None = None
    effect_chain: list[EffectChainNode] = []


class RollVoice(BaseModel):
    """The piano roll's own voice: the GM program (0-127) a roll with no linked
    EDIT clip auditions and bounces with, set from the Vocal2MIDI panel. None
    follows the global instrument picker. The reader keeps a whole program
    0-127 and reads anything else as None."""

    program: int | None = None

    @field_validator("program", mode="before")
    @classmethod
    def _whole_gm_program(cls, v: object) -> int | None:
        """A whole number 0-127 (a JSON 48.0 is 48), else None.

        A hand-edited or damaged ``program`` (40.5, 200, "strings", true) is a
        roll that follows the picker, the same reading the frontend gives it
        (projectClient gmProgramOf). Rejecting it would refuse the whole
        project over one setting.
        """
        if isinstance(v, bool):
            return None
        if isinstance(v, float) and v.is_integer():
            v = int(v)
        if isinstance(v, int) and 0 <= v <= 127:
            return v
        return None


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
    # The EDIT arrangement's tempo map ([{beat, bpm, curve, fermata}], beat in
    # quarter notes from timeline second 0, curve "linear" on a ramp, fermata
    # {beats, stretch} on a hold) and meter map ([{bar, meter: {num, den,
    # groups}}], bar 0 at timeline second 0): the shapes a piano-roll clip's
    # tempo_map and meter_map use. `tempo` stays the start tempo and
    # `time_signature` bar 1's meter, so a reader that knows only those opens
    # the song at its start. None means the file was written before the
    # arrangement had maps, and the reader uses `tempo` and `time_signature`.
    tempo_map: list[dict] | None = None
    meter_map: list[dict] | None = None
    sample_rate: int = 48000
    tracks: list[Track] = []
    # Mix buses. Empty for a project that routes everything straight to the
    # master, and absent entirely from files written before buses existed —
    # which is why it is defaulted rather than required. Paired with
    # `Track.output_routing` (the id of the bus a track feeds, or None for the
    # master) and `Track.send_amounts` (bus id -> linear send gain): without the
    # list, both of those could only ever name a bus that had nowhere to live,
    # so a saved project reloaded with every edge collapsed onto the master.
    buses: list[Bus] = []
    locators: list[Locator] = []
    # The transport's cycle region. None for a project that has none, and absent
    # entirely from files written before the loop was persisted — defaulted for
    # exactly the reason `buses` is. Paired with `locators`, which carries the
    # timeline markers: both are per-project document state the editor clears on
    # load, so without them a saved session reopened with no markers and no loop.
    loop: Loop | None = None
    automation: list[AutomationLane] = []
    # The MASTER bus's two insert chains and the EDIT session's automation lanes
    # — the last of the session state a .tasmo could not carry. Without them a
    # saved project reopened with the master rack and the master VST chain still
    # holding the PREVIOUS project's plugins (the editor does not clear them on
    # load) and with every automation lane gone (it does clear those).
    #
    # None and [] mean DIFFERENT things here, which is why all three are
    # `| None` rather than defaulted lists like `buses`:
    #   None — the file says nothing, i.e. it was written before this existed.
    #          The reader leaves the live state alone, so a legacy project opens
    #          exactly as it always did.
    #   []   — the file says this project HAS no master FX / master VSTs / lanes.
    #          The reader clears, so the previous project's master rack does not
    #          bleed into this one.
    # Every save from here on writes all three, so only files written before
    # this are ever None. No format_version bump: a reader that ignores
    # the keys still gets a correct project, one with an unprocessed master.
    master_fx_chain: list[ChainEntry] | None = None
    master_vst_chain: list[ChainEntry] | None = None
    automation_lanes: list[EditorAutomationLane] | None = None
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
    # The piano roll's own voice (see RollVoice). None means the file was
    # written before it was saved, and the reader leaves the live roll voice
    # alone; RollVoice(program=None) says this project's roll follows the
    # picker, and the reader sets it so.
    roll_voice: RollVoice | None = None
    # The project tuning: {reference_hz, temperament, root, scala?} (the
    # frontend's state/tuningStore tuningToTasmo). None is A = 440 in equal
    # temperament, and what every file written before it reads as.
    tuning: dict | None = None
