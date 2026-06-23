"""Lazy package root.

Importing ``stable_audio_3`` (or a lightweight submodule such as
``stable_audio_3.model_configs``) must NOT pull in the full torch model graph —
that import costs several seconds and was forcing the backend to load torch at
server-import time even when no model is in use. The two model classes are
therefore exposed lazily via PEP 562 ``__getattr__``: they load only when first
referenced (``from stable_audio_3 import StableAudioModel`` or
``stable_audio_3.StableAudioModel``). This changes import *timing* only — the
classes and their behavior are unchanged.
"""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from stable_audio_3.model import AutoencoderModel as AutoencoderModel
    from stable_audio_3.model import StableAudioModel as StableAudioModel

__all__ = ["AutoencoderModel", "StableAudioModel"]


def __getattr__(name: str):
    if name in ("AutoencoderModel", "StableAudioModel"):
        from stable_audio_3 import model

        globals()["AutoencoderModel"] = model.AutoencoderModel
        globals()["StableAudioModel"] = model.StableAudioModel
        return globals()[name]
    raise AttributeError(f"module 'stable_audio_3' has no attribute {name!r}")
