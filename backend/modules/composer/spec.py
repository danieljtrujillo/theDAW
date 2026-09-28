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

FORMS = (
    "sonata",
    "rondo",
    "theme_and_variations",
    "minuet_and_trio",
    "scherzo",
    "symphony",
)
RONDO_PATTERNS = ("ABACA", "ABACABA")

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
