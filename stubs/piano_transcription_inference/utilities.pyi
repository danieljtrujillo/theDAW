"""Type stubs for ``piano_transcription_inference.utilities``: the audio loader."""

from typing import Any

import numpy as np
import numpy.typing as npt

def load_audio(
    path: str,
    sr: int | None = 22050,
    mono: bool = True,
    offset: float = 0.0,
    duration: float | None = None,
    dtype: Any = ...,
    res_type: str = "kaiser_best",
    backends: Any = ...,
) -> tuple[npt.NDArray[np.float32], int]: ...
