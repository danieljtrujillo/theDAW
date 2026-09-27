from collections.abc import Callable

import numpy as np
import numpy.typing as npt

from .containers import ControlChange, Note, PitchBend

class Instrument:
    program: int
    is_drum: bool
    name: str
    notes: list[Note]
    pitch_bends: list[PitchBend]
    control_changes: list[ControlChange]
    def __init__(self, program: int, is_drum: bool = False, name: str = "") -> None: ...
    def get_onsets(self) -> npt.NDArray[np.float64]: ...
    def get_piano_roll(
        self,
        fs: float = 100,
        times: npt.ArrayLike | None = None,
        pedal_threshold: int | None = 64,
    ) -> npt.NDArray[np.float64]: ...
    def get_chroma(
        self,
        fs: float = 100,
        times: npt.ArrayLike | None = None,
        pedal_threshold: int | None = 64,
    ) -> npt.NDArray[np.float64]: ...
    def get_end_time(self) -> float: ...
    def get_pitch_class_histogram(
        self,
        use_duration: bool = False,
        use_velocity: bool = False,
        normalize: bool = False,
    ) -> npt.NDArray[np.float64]: ...
    def get_pitch_class_transition_matrix(
        self, normalize: bool = False, time_thresh: float = 0.05
    ) -> npt.NDArray[np.float64]: ...
    def remove_invalid_notes(self) -> None: ...
    def synthesize(
        self,
        fs: int = 44100,
        wave: Callable[[npt.NDArray[np.float64]], npt.NDArray[np.float64]] = ...,
    ) -> npt.NDArray[np.float64]: ...
    def fluidsynth(
        self,
        fs: int | None = None,
        synthesizer: object | None = None,
        sfid: int = 0,
        sf2_path: str | None = None,
    ) -> npt.NDArray[np.float64]: ...
