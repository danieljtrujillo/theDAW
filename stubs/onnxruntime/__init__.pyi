"""Type stubs for onnxruntime (the onnxruntime-gpu 1.30 wheel), which ships no
type information for its Python API.

Only the names theDAW calls are declared: the provider query and the
inference session the MIDI engine rebuilds on the CUDA provider
(``backend/modules/midi/engine.py``). ``pyrightconfig.json`` at the repo root
names this folder as the stub path, and ``tests/test_ml_import_stubs.py``
checks every name and parameter against the installed package.
"""

from collections.abc import Sequence
from os import PathLike
from typing import Any

__version__: str

def get_available_providers() -> list[str]: ...
def get_device() -> str: ...

class SessionOptions:
    def __init__(self) -> None: ...

class RunOptions:
    def __init__(self) -> None: ...

class NodeArg:
    @property
    def name(self) -> str: ...
    @property
    def shape(self) -> list[int | str | None]: ...
    @property
    def type(self) -> str: ...

class InferenceSession:
    def __init__(
        self,
        path_or_bytes: str | bytes | PathLike[str],
        sess_options: SessionOptions | None = None,
        providers: Sequence[str | tuple[str, dict[Any, Any]]] | None = None,
        provider_options: Sequence[dict[Any, Any]] | None = None,
        **kwargs: Any,
    ) -> None: ...
    def get_providers(self) -> Sequence[str]: ...
    def get_inputs(self) -> Sequence[NodeArg]: ...
    def get_outputs(self) -> Sequence[NodeArg]: ...
    def run(
        self,
        output_names: Sequence[str] | None,
        input_feed: dict[str, Any],
        run_options: RunOptions | None = None,
    ) -> Sequence[Any]: ...
