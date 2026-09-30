"""Type stubs for ``piano_transcription_inference.inference``."""

from typing import Any

import numpy as np
import numpy.typing as npt
import torch

class PianoTranscription:
    def __init__(
        self,
        model_type: str = "Note_pedal",
        checkpoint_path: str | None = None,
        segment_samples: int = 160000,
        device: str | torch.device = ...,
    ) -> None: ...
    def transcribe(
        self, audio: npt.NDArray[np.float32], midi_path: str | None
    ) -> dict[str, Any]: ...
