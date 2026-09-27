"""Type stubs for pretty_midi 0.2.11, which ships no type information.

The package star-imports its five modules; these stubs mirror that layout and
re-export the public names each module defines. ``pyrightconfig.json`` at the
repo root names this folder as the stub path.
"""

from .constants import (
    DRUM_MAP as DRUM_MAP,
    INSTRUMENT_CLASSES as INSTRUMENT_CLASSES,
    INSTRUMENT_MAP as INSTRUMENT_MAP,
)
from .containers import (
    ControlChange as ControlChange,
    KeySignature as KeySignature,
    Lyric as Lyric,
    Note as Note,
    PitchBend as PitchBend,
    Text as Text,
    TimeSignature as TimeSignature,
)
from .instrument import Instrument as Instrument
from .pretty_midi import MAX_TICK as MAX_TICK, PrettyMIDI as PrettyMIDI
from .utilities import (
    drum_name_to_note_number as drum_name_to_note_number,
    hz_to_note_number as hz_to_note_number,
    instrument_name_to_program as instrument_name_to_program,
    key_name_to_key_number as key_name_to_key_number,
    key_number_to_key_name as key_number_to_key_name,
    key_number_to_mode_accidentals as key_number_to_mode_accidentals,
    mode_accidentals_to_key_number as mode_accidentals_to_key_number,
    note_name_to_number as note_name_to_number,
    note_number_to_drum_name as note_number_to_drum_name,
    note_number_to_hz as note_number_to_hz,
    note_number_to_name as note_number_to_name,
    pitch_bend_to_semitones as pitch_bend_to_semitones,
    program_to_instrument_class as program_to_instrument_class,
    program_to_instrument_name as program_to_instrument_name,
    qpm_to_bpm as qpm_to_bpm,
    semitones_to_pitch_bend as semitones_to_pitch_bend,
)

__version__: str
