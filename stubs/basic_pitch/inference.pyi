"""Type stubs for ``basic_pitch.inference``: the model wrapper, the
prediction theDAW runs (``predict``, whose note events it writes itself) and
the file-to-file ``predict_and_save``."""

import enum
import pathlib
from collections.abc import Sequence
from typing import Any

import numpy as np
import numpy.typing as npt
import pretty_midi

class Model:
    class MODEL_TYPES(enum.Enum):
        TENSORFLOW = 1
        COREML = 2
        TFLITE = 3
        ONNX = 4

    model_type: Model.MODEL_TYPES
    # A TensorFlow, Core ML, TFLite signature runner or ONNX Runtime session,
    # by `model_type`; theDAW swaps in its own CUDA session for ONNX.
    model: Any
    def __init__(self, model_path: pathlib.Path | str) -> None: ...
    def predict(
        self, x: npt.NDArray[np.float32]
    ) -> dict[str, npt.NDArray[np.float32]]: ...

def predict(
    audio_path: pathlib.Path | str,
    model_or_model_path: Model | pathlib.Path | str = ...,
    onset_threshold: float = 0.5,
    frame_threshold: float = 0.3,
    minimum_note_length: float = 127.70,
    minimum_frequency: float | None = None,
    maximum_frequency: float | None = None,
    multiple_pitch_bends: bool = False,
    melodia_trick: bool = True,
    debug_file: pathlib.Path | None = None,
    midi_tempo: float = 120,
) -> tuple[
    dict[str, Any],
    pretty_midi.PrettyMIDI,
    list[tuple[float, float, int, float, list[int] | None]],
]: ...
def predict_and_save(
    audio_path_list: Sequence[pathlib.Path | str],
    output_directory: pathlib.Path | str,
    save_midi: bool,
    sonify_midi: bool,
    save_model_outputs: bool,
    save_notes: bool,
    model_or_model_path: Model | str | pathlib.Path,
    onset_threshold: float = 0.5,
    frame_threshold: float = 0.3,
    minimum_note_length: float = 127.70,
    minimum_frequency: float | None = None,
    maximum_frequency: float | None = None,
    multiple_pitch_bends: bool = False,
    melodia_trick: bool = True,
    debug_file: pathlib.Path | None = None,
    sonification_samplerate: int = 44100,
    midi_tempo: float = 120,
) -> None: ...
