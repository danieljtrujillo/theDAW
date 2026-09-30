class Note:
    velocity: int
    pitch: int
    start: float
    end: float
    def __init__(self, velocity: int, pitch: int, start: float, end: float) -> None: ...
    def get_duration(self) -> float: ...
    @property
    def duration(self) -> float: ...

class PitchBend:
    pitch: int
    time: float
    def __init__(self, pitch: int, time: float) -> None: ...

class ControlChange:
    number: int
    value: int
    time: float
    def __init__(self, number: int, value: int, time: float) -> None: ...

class TimeSignature:
    numerator: int
    denominator: int
    time: float
    def __init__(self, numerator: int, denominator: int, time: float) -> None: ...

class KeySignature:
    key_number: int
    time: float
    def __init__(self, key_number: int, time: float) -> None: ...

class Lyric:
    text: str
    time: float
    def __init__(self, text: str, time: float) -> None: ...

class Text:
    text: str
    time: float
    def __init__(self, text: str, time: float) -> None: ...
