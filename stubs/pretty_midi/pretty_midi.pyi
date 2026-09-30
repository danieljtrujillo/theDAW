from collections.abc import Callable
from os import PathLike
from typing import IO

import mido
import numpy as np
import numpy.typing as npt

from .containers import KeySignature, Lyric, Text, TimeSignature
from .instrument import Instrument

MAX_TICK: float

class PrettyMIDI:
    instruments: list[Instrument]
    key_signature_changes: list[KeySignature]
    time_signature_changes: list[TimeSignature]
    lyrics: list[Lyric]
    text_events: list[Text]
    resolution: int
    def __init__(
        self,
        midi_file: str | PathLike[str] | IO[bytes] | None = None,
        resolution: int = 220,
        initial_tempo: float = 120.0,
        charset: str = "latin1",
        mido_object: mido.MidiFile | None = None,
    ) -> None: ...
    def get_tempo_changes(
        self,
    ) -> tuple[npt.NDArray[np.float64], npt.NDArray[np.float64]]: ...
    def get_end_time(self) -> float: ...
    def estimate_tempi(
        self,
    ) -> tuple[npt.NDArray[np.float64], npt.NDArray[np.float64]]: ...
    def estimate_tempo(self) -> float: ...
    def get_beats(self, start_time: float = 0.0) -> npt.NDArray[np.float64]: ...
    def estimate_beat_start(
        self, candidates: int = 10, tolerance: float = 0.025
    ) -> float: ...
    def get_downbeats(self, start_time: float = 0.0) -> npt.NDArray[np.float64]: ...
    def get_onsets(self) -> npt.NDArray[np.float64]: ...
    def get_piano_roll(
        self,
        fs: float = 100,
        times: npt.ArrayLike | None = None,
        pedal_threshold: int | None = 64,
    ) -> npt.NDArray[np.float64]: ...
    def get_intervals_and_pitches(
        self,
    ) -> tuple[npt.NDArray[np.float64], npt.NDArray[np.int_]]: ...
    def get_pitch_class_histogram(
        self,
        use_duration: bool = False,
        use_velocity: bool = False,
        normalize: bool = True,
    ) -> npt.NDArray[np.float64]: ...
    def get_pitch_class_transition_matrix(
        self, normalize: bool = False, time_thresh: float = 0.05
    ) -> npt.NDArray[np.float64]: ...
    def get_chroma(
        self,
        fs: float = 100,
        times: npt.ArrayLike | None = None,
        pedal_threshold: int | None = 64,
    ) -> npt.NDArray[np.float64]: ...
    def synthesize(
        self,
        fs: int = 44100,
        wave: Callable[[npt.NDArray[np.float64]], npt.NDArray[np.float64]] = ...,
        normalize: bool = True,
    ) -> npt.NDArray[np.float64]: ...
    def fluidsynth(
        self,
        fs: int | None = None,
        synthesizer: object | None = None,
        sfid: int = 0,
        sf2_path: str | None = None,
        normalize: bool = True,
    ) -> npt.NDArray[np.float64]: ...
    def tick_to_time(self, tick: int) -> float: ...
    def time_to_tick(self, time: float) -> int: ...
    def adjust_times(
        self, original_times: npt.ArrayLike, new_times: npt.ArrayLike
    ) -> None: ...
    def crop(self, start_time: float = 0.0, end_time: float | None = None) -> None: ...
    def remove_invalid_notes(self) -> None: ...
    def write(self, filename: str | PathLike[str] | IO[bytes]) -> None: ...
