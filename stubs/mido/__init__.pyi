"""Type stubs for mido 1.3, which ships no type information.

Only the top-level names theDAW uses are declared: reading and writing MIDI
files, their tracks and messages, and the tempo and tick conversions
(``backend/modules/midi/engine.py``, ``backend/modules/vocal/convert.py`` and
the tests that build MIDI files). A message's fields depend on its type
(``note`` on a note_on, ``tempo`` on a set_tempo), and mido stores them per
instance, so they read through ``__getattr__``; ``type`` and ``time`` are on
every message. ``tests/test_ml_import_stubs.py`` checks every name and
parameter against the installed package.
"""

from collections.abc import Iterator
from os import PathLike
from typing import IO, Any, Self

# mido's BaseMessage (mido.messages.messages) is not exported at the top level,
# so the fields every message shares sit on this stub-only base.
class _MessageFields:
    is_meta: bool
    type: str
    time: int | float
    def __getattr__(self, name: str) -> Any: ...

class Message(_MessageFields):
    def __init__(self, type: str, skip_checks: bool = False, **args: Any) -> None: ...
    def copy(self, skip_checks: bool = False, **overrides: Any) -> Self: ...

class MetaMessage(_MessageFields):
    def __init__(self, type: str, skip_checks: bool = False, **kwargs: Any) -> None: ...
    def copy(self, **overrides: Any) -> Self: ...

class MidiTrack(list[Message | MetaMessage]):
    @property
    def name(self) -> str: ...
    @name.setter
    def name(self, name: str) -> None: ...

class MidiFile:
    filename: str | None
    type: int
    ticks_per_beat: int
    tracks: list[MidiTrack]
    def __init__(
        self,
        filename: str | PathLike[str] | None = None,
        file: IO[bytes] | None = None,
        type: int = 1,
        ticks_per_beat: int = 480,
        charset: str = "latin1",
        debug: bool = False,
        clip: bool = False,
        tracks: list[MidiTrack] | None = None,
    ) -> None: ...
    @property
    def length(self) -> float: ...
    def save(
        self, filename: str | PathLike[str] | None = None, file: IO[bytes] | None = None
    ) -> None: ...
    def __iter__(self) -> Iterator[Message | MetaMessage]: ...

def bpm2tempo(bpm: float, time_signature: tuple[int, int] = (4, 4)) -> int: ...
def tempo2bpm(tempo: float, time_signature: tuple[int, int] = (4, 4)) -> float: ...
def tick2second(tick: float, ticks_per_beat: int, tempo: float) -> float: ...
def second2tick(second: float, ticks_per_beat: int, tempo: float) -> int: ...
