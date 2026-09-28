"""The composer's vocabulary, with no music21 import, so the router can mount
at startup without loading music21 (about 0.7 s) until a request needs it."""

from __future__ import annotations

PPQ = 960

SATB = ("soprano", "alto", "tenor", "bass")
DEFAULT_RANGES: dict[str, tuple[int, int]] = {
    "soprano": (60, 79),  # C4-G5
    "alto": (55, 74),  # G3-D5
    "tenor": (48, 67),  # C3-G4
    "bass": (40, 60),  # E2-C4
}

CADENCES = (
    "authentic_perfect",
    "authentic_imperfect",
    "half",
    "plagal",
    "deceptive",
    "phrygian_half",
)
FEATURES = ("seventh", "applied", "neapolitan", "italian", "french", "german")
HARMONIC_RHYTHMS = ("pulse", "bar")

RULES = (
    "parallel_fifths",
    "parallel_octaves",
    "hidden_fifths",
    "hidden_octaves",
    "voice_crossing",
    "voice_overlap",
    "spacing",
    "range",
    "unresolved_leading_tone",
    "unresolved_seventh",
)

# Counterpoint (counterpoint.py, canon.py, fugue.py).
SPECIES = (1, 2, 3, 4, 5)
MODES = (
    "major",
    "minor",
    "ionian",
    "dorian",
    "phrygian",
    "lydian",
    "mixolydian",
    "aeolian",
)
INVERTIBLE_AT = (8, 10, 12)
FUGUE_VOICES: dict[int, tuple[str, ...]] = {
    2: ("soprano", "bass"),
    3: ("soprano", "alto", "bass"),
    4: ("soprano", "alto", "tenor", "bass"),
}
COUNTERPOINT_RULES = (
    "dissonance",
    "parallel_fifths",
    "parallel_octaves",
    "direct_perfect",
    "hidden_fifths",
    "hidden_octaves",
    "accented_parallels",
    "voice_crossing",
    "voice_overlap",
    "spacing",
    "unison",
    "parallel_imperfect",
    "melodic_interval",
    "repeated_note",
    "leap_recovery",
    "consecutive_leaps",
    "eighths",
    "ficta",
    "line_range",
    "climax",
    "opening",
    "cadence",
    "rhythm",
    "broken_ties",
)
