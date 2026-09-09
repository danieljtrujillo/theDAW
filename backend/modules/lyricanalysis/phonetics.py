"""ARPABET pronunciation, syllabification and rhyme scoring.

Pure module: no I/O, no network, no model. Every phonetic device detector
(rhyme, assonance, consonance, alliteration) asks this module for phones, so
it has to answer for whatever a lyric actually contains — slang, names,
ad-libs, contractions, coinages — not just dictionary words.

Two sources, in this order:

* the CMU Pronouncing Dictionary, imported lazily and guarded (``cmudict``
  is an optional dependency; the module works without it), and
* a pure-Python letter-to-sound fallback for everything out of dictionary.

Anything the fallback produced is flagged ``Pron.guessed`` so callers can
discount it and report an honest guessed count. ``PRONUNCIATION_SOURCE``
says which source is live for this process.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass
from functools import lru_cache

__all__ = [
    "ARPABET_VOWELS",
    "PRONUNCIATION_SOURCE",
    "Pron",
    "Syllable",
    "classify_rhyme",
    "consonant_distance",
    "normalize_word",
    "pronounce",
    "rhyme_key",
    "stress_pattern",
    "syllabify",
    "syllable_count",
    "tail_key",
    "vowel_distance",
]

ARPABET_VOWELS = frozenset(
    {
        "AA",
        "AE",
        "AH",
        "AO",
        "AW",
        "AY",
        "EH",
        "ER",
        "EY",
        "IH",
        "IY",
        "OW",
        "OY",
        "UH",
        "UW",
    }
)

# The dictionary is optional and its data files are heavy, so only the import
# happens here; the ~125k-entry table is built on the first lookup that needs
# it. Same policy as the repo's other optional deps: absent is not an error.
try:  # pragma: no cover - depends on the machine's installed deps
    import cmudict as _cmudict
except Exception:  # pragma: no cover - any import failure means "use rules"
    _cmudict = None

PRONUNCIATION_SOURCE = "cmudict" if _cmudict is not None else "rules"

_CMU_TABLE: dict[str, list[list[str]]] | None = None


def _cmu_phones(word: str) -> list[str] | None:
    """First dictionary pronunciation for ``word``, still carrying stress digits."""
    global _CMU_TABLE
    if _cmudict is None:
        return None
    if _CMU_TABLE is None:
        try:
            _CMU_TABLE = dict(_cmudict.dict())
        except Exception:
            _CMU_TABLE = {}
    entry = _CMU_TABLE.get(word)
    if not entry:
        return None
    return list(entry[0])


@dataclass(frozen=True)
class Pron:
    """One pronunciation: bare ARPABET phones plus a stress digit per vowel."""

    phones: tuple[str, ...]
    stress: tuple[int, ...]
    guessed: bool


@dataclass(frozen=True)
class Syllable:
    onset: tuple[str, ...]
    nucleus: str
    coda: tuple[str, ...]
    stress: int


# ---------------------------------------------------------------------------
# Normalization
# ---------------------------------------------------------------------------

# Smart quotes and dashes arrive from pasted lyrics constantly; fold them to
# ASCII before anything else looks at the token.
_FOLD = str.maketrans(
    {
        "‘": "'",
        "’": "'",
        "ʼ": "'",
        "“": '"',
        "”": '"',
        "‐": "-",
        "‑": "-",
        "‒": "-",
        "–": "-",
        "—": "-",
        "―": "-",
    }
)
_KEEP_RE = re.compile(r"[^a-z0-9'\-]+")


def normalize_word(text: str) -> str:
    """Lowercase, drop punctuation and quotes, keep inner apostrophes/hyphens."""
    if not text:
        return ""
    folded = unicodedata.normalize("NFKD", str(text).translate(_FOLD))
    # Strip the combining marks NFKD split off, so "café" == "cafe".
    stripped = "".join(c for c in folded if not unicodedata.combining(c))
    cleaned = _KEEP_RE.sub("", stripped.lower())
    return cleaned.strip("'-")


# ---------------------------------------------------------------------------
# Letter-to-sound rules (the out-of-dictionary path)
# ---------------------------------------------------------------------------

# Words English spelling simply lies about, plus the function words and
# lyric staples that a rule set gets wrong often enough to matter. Anything
# here still counts as guessed — it is the fallback path, not a dictionary.
_EXCEPTIONS: dict[str, tuple[str, ...]] = {
    # articles, pronouns, auxiliaries
    "a": ("AH",),
    "i": ("AY",),
    "o": ("OW",),
    "e": ("IY",),
    "u": ("Y", "UW"),
    "the": ("DH", "AH"),
    "an": ("AE", "N"),
    "and": ("AE", "N", "D"),
    "of": ("AH", "V"),
    "to": ("T", "UW"),
    "into": ("IH", "N", "T", "UW"),
    "do": ("D", "UW"),
    "does": ("D", "AH", "Z"),
    "done": ("D", "AH", "N"),
    "don't": ("D", "OW", "N", "T"),
    "won't": ("W", "OW", "N", "T"),
    "can't": ("K", "AE", "N", "T"),
    "ain't": ("EY", "N", "T"),
    "is": ("IH", "Z"),
    "his": ("HH", "IH", "Z"),
    "as": ("AE", "Z"),
    "has": ("HH", "AE", "Z"),
    "was": ("W", "AA", "Z"),
    "were": ("W", "ER"),
    "are": ("AA", "R"),
    "be": ("B", "IY"),
    "been": ("B", "IH", "N"),
    "have": ("HH", "AE", "V"),
    "had": ("HH", "AE", "D"),
    "say": ("S", "EY"),
    "says": ("S", "EH", "Z"),
    "said": ("S", "EH", "D"),
    "one": ("W", "AH", "N"),
    "once": ("W", "AH", "N", "S"),
    "two": ("T", "UW"),
    "four": ("F", "AO", "R"),
    "who": ("HH", "UW"),
    "whose": ("HH", "UW", "Z"),
    "whole": ("HH", "OW", "L"),
    "what": ("W", "AH", "T"),
    "want": ("W", "AA", "N", "T"),
    "watch": ("W", "AA", "CH"),
    "water": ("W", "AO", "T", "ER"),
    "wash": ("W", "AA", "SH"),
    "where": ("W", "EH", "R"),
    "there": ("DH", "EH", "R"),
    "their": ("DH", "EH", "R"),
    "they": ("DH", "EY"),
    "them": ("DH", "EH", "M"),
    "then": ("DH", "EH", "N"),
    "than": ("DH", "AE", "N"),
    "this": ("DH", "IH", "S"),
    "that": ("DH", "AE", "T"),
    "these": ("DH", "IY", "Z"),
    "those": ("DH", "OW", "Z"),
    "thy": ("DH", "AY"),
    "thee": ("DH", "IY"),
    "your": ("Y", "AO", "R"),
    "you": ("Y", "UW"),
    "yes": ("Y", "EH", "S"),
    "us": ("AH", "S"),
    "bus": ("B", "AH", "S"),
    "gas": ("G", "AE", "S"),
    "plus": ("P", "L", "AH", "S"),
    # ad-libs and interjections, which fill lyric sheets
    "oh": ("OW",),
    "ah": ("AA",),
    "aah": ("AA",),
    "uh": ("AH",),
    "huh": ("HH", "AH"),
    "hah": ("HH", "AA"),
    "yeah": ("Y", "EH"),
    "yea": ("Y", "EY"),
    "nah": ("N", "AA"),
    "na": ("N", "AA"),
    "la": ("L", "AA"),
    "hey": ("HH", "EY"),
    "ay": ("EY",),
    "aye": ("AY",),
    "ooh": ("UW",),
    "oo": ("UW",),
    "whoa": ("W", "OW"),
    "woah": ("W", "OW"),
    "yo": ("Y", "OW"),
    "mm": ("M",),
    "hmm": ("HH", "AH", "M"),
    "shh": ("SH",),
    "ugh": ("AH", "G"),
    # -ough / -augh, which no rule set can win
    "though": ("DH", "OW"),
    "through": ("TH", "R", "UW"),
    "thought": ("TH", "AO", "T"),
    "tough": ("T", "AH", "F"),
    "rough": ("R", "AH", "F"),
    "enough": ("IH", "N", "AH", "F"),
    "cough": ("K", "AO", "F"),
    "dough": ("D", "OW"),
    "bough": ("B", "AW"),
    "laugh": ("L", "AE", "F"),
    "laughter": ("L", "AE", "F", "T", "ER"),
    "daughter": ("D", "AO", "T", "ER"),
    # silent-e liars
    "love": ("L", "AH", "V"),
    "above": ("AH", "B", "AH", "V"),
    "glove": ("G", "L", "AH", "V"),
    "dove": ("D", "AH", "V"),
    "move": ("M", "UW", "V"),
    "prove": ("P", "R", "UW", "V"),
    "lose": ("L", "UW", "Z"),
    "some": ("S", "AH", "M"),
    "come": ("K", "AH", "M"),
    "become": ("B", "IH", "K", "AH", "M"),
    "none": ("N", "AH", "N"),
    "give": ("G", "IH", "V"),
    "live": ("L", "IH", "V"),
    "gone": ("G", "AO", "N"),
    "eye": ("AY",),
    "sure": ("SH", "UH", "R"),
    "people": ("P", "IY", "P", "AH", "L"),
    "beauty": ("B", "Y", "UW", "T", "IY"),
    "beautiful": ("B", "Y", "UW", "T", "AH", "F", "AH", "L"),
    # hard g before a front vowel
    "get": ("G", "EH", "T"),
    "got": ("G", "AA", "T"),
    "getting": ("G", "EH", "T", "IH", "NG"),
    "forget": ("F", "ER", "G", "EH", "T"),
    "forgive": ("F", "ER", "G", "IH", "V"),
    "girl": ("G", "ER", "L"),
    "gift": ("G", "IH", "F", "T"),
    "begin": ("B", "IH", "G", "IH", "N"),
    "began": ("B", "IH", "G", "AE", "N"),
    "together": ("T", "AH", "G", "EH", "DH", "ER"),
    "anger": ("AE", "NG", "G", "ER"),
    "angry": ("AE", "NG", "G", "R", "IY"),
    "finger": ("F", "IH", "NG", "G", "ER"),
    "longer": ("L", "AO", "NG", "G", "ER"),
    "stronger": ("S", "T", "R", "AO", "NG", "G", "ER"),
    "younger": ("Y", "AH", "NG", "G", "ER"),
    "singer": ("S", "IH", "NG", "ER"),
    "tiger": ("T", "AY", "G", "ER"),
    # short vowels where the spelling says long, and vice versa
    "head": ("HH", "EH", "D"),
    "dead": ("D", "EH", "D"),
    "bread": ("B", "R", "EH", "D"),
    "breath": ("B", "R", "EH", "TH"),
    "death": ("D", "EH", "TH"),
    "ready": ("R", "EH", "D", "IY"),
    "heaven": ("HH", "EH", "V", "AH", "N"),
    "heavy": ("HH", "EH", "V", "IY"),
    "weather": ("W", "EH", "DH", "ER"),
    "measure": ("M", "EH", "ZH", "ER"),
    "pleasure": ("P", "L", "EH", "ZH", "ER"),
    "treasure": ("T", "R", "EH", "ZH", "ER"),
    "climb": ("K", "L", "AY", "M"),
    "great": ("G", "R", "EY", "T"),
    "break": ("B", "R", "EY", "K"),
    "steak": ("S", "T", "EY", "K"),
    "heart": ("HH", "AA", "R", "T"),
    "hear": ("HH", "IH", "R"),
    "heard": ("HH", "ER", "D"),
    "learn": ("L", "ER", "N"),
    "earth": ("ER", "TH"),
    "early": ("ER", "L", "IY"),
    "bear": ("B", "EH", "R"),
    "wear": ("W", "EH", "R"),
    "swear": ("S", "W", "EH", "R"),
    "tear": ("T", "EH", "R"),
    "year": ("Y", "IH", "R"),
    "good": ("G", "UH", "D"),
    "wood": ("W", "UH", "D"),
    "stood": ("S", "T", "UH", "D"),
    "hood": ("HH", "UH", "D"),
    "foot": ("F", "UH", "T"),
    "blood": ("B", "L", "AH", "D"),
    "flood": ("F", "L", "AH", "D"),
    "door": ("D", "AO", "R"),
    "floor": ("F", "L", "AO", "R"),
    "put": ("P", "UH", "T"),
    "push": ("P", "UH", "SH"),
    "pull": ("P", "UH", "L"),
    "full": ("F", "UH", "L"),
    "would": ("W", "UH", "D"),
    "could": ("K", "UH", "D"),
    "should": ("SH", "UH", "D"),
    "friend": ("F", "R", "EH", "N", "D"),
    "again": ("AH", "G", "EH", "N"),
    "against": ("AH", "G", "EH", "N", "S", "T"),
    "because": ("B", "IH", "K", "AO", "Z"),
    "money": ("M", "AH", "N", "IY"),
    "many": ("M", "EH", "N", "IY"),
    "any": ("EH", "N", "IY"),
    "every": ("EH", "V", "R", "IY"),
    "very": ("V", "EH", "R", "IY"),
    "woman": ("W", "UH", "M", "AH", "N"),
    "women": ("W", "IH", "M", "IH", "N"),
    "other": ("AH", "DH", "ER"),
    "mother": ("M", "AH", "DH", "ER"),
    "brother": ("B", "R", "AH", "DH", "ER"),
    "father": ("F", "AA", "DH", "ER"),
    "nothing": ("N", "AH", "TH", "IH", "NG"),
    "something": ("S", "AH", "M", "TH", "IH", "NG"),
    "anything": ("EH", "N", "IY", "TH", "IH", "NG"),
    "everything": ("EH", "V", "R", "IY", "TH", "IH", "NG"),
    "author": ("AO", "TH", "ER"),
    "method": ("M", "EH", "TH", "AH", "D"),
    # -own / -old / -ind, where the rules pick the wrong half
    "own": ("OW", "N"),
    "grown": ("G", "R", "OW", "N"),
    "known": ("N", "OW", "N"),
    "shown": ("SH", "OW", "N"),
    "blown": ("B", "L", "OW", "N"),
    "thrown": ("TH", "R", "OW", "N"),
    "know": ("N", "OW"),
    "knew": ("N", "UW"),
    "find": ("F", "AY", "N", "D"),
    "mind": ("M", "AY", "N", "D"),
    "kind": ("K", "AY", "N", "D"),
    "blind": ("B", "L", "AY", "N", "D"),
    "behind": ("B", "IH", "HH", "AY", "N", "D"),
    "child": ("CH", "AY", "L", "D"),
    "wild": ("W", "AY", "L", "D"),
    "old": ("OW", "L", "D"),
    "cold": ("K", "OW", "L", "D"),
    "gold": ("G", "OW", "L", "D"),
    "hold": ("HH", "OW", "L", "D"),
    "told": ("T", "OW", "L", "D"),
    "sold": ("S", "OW", "L", "D"),
    "both": ("B", "OW", "TH"),
    "most": ("M", "OW", "S", "T"),
    "only": ("OW", "N", "L", "IY"),
    "over": ("OW", "V", "ER"),
    "word": ("W", "ER", "D"),
    "work": ("W", "ER", "K"),
    "world": ("W", "ER", "L", "D"),
    "worth": ("W", "ER", "TH"),
    "sugar": ("SH", "UH", "G", "ER"),
    "hour": ("AW", "ER"),
    "honest": ("AA", "N", "AH", "S", "T"),
}

# Clitics carry their own phones; the stem in front keeps its own spelling.
_CLITICS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("n't", ("N", "T")),
    ("'re", ("ER",)),
    ("'ve", ("V",)),
    ("'ll", ("L",)),
    ("'m", ("M",)),
    ("'d", ("D",)),
)

# Ordered longest/most-specific first; the scanner takes the first rule that
# matches at the current letter. The word is padded with "#" on both ends so
# a rule can say "word-initial" / "word-final" as an ordinary lookaround.
_LTS_RULES: tuple[tuple[str, tuple[str, ...]], ...] = (
    # -- spelling blocks that swallow their neighbours -------------------
    (r"eigh", ("EY",)),
    (r"ough(?=t)", ("AO",)),
    (r"ough(?=#)", ("OW",)),
    (r"augh", ("AO",)),
    (r"igh", ("AY",)),
    (r"tion", ("SH", "AH", "N")),
    # Before the plain -sion: the ss/sh in "passion"/"fashion" would
    # otherwise be eaten by the doubled-consonant and sh rules further down,
    # leaving a bare "ion" that spells out as an extra syllable.
    (r"ssion", ("SH", "AH", "N")),
    (r"shion", ("SH", "AH", "N")),
    (r"ssure(?=#)", ("SH", "ER")),
    (r"(?<=[aeiou])sion", ("ZH", "AH", "N")),
    (r"sion", ("SH", "AH", "N")),
    (r"cious", ("SH", "AH", "S")),
    (r"tious", ("SH", "AH", "S")),
    (r"cial", ("SH", "AH", "L")),
    (r"tial", ("SH", "AH", "L")),
    (r"ture(?=#)", ("CH", "ER")),
    (r"sure(?=#)", ("ZH", "ER")),
    (r"ment(?=#)", ("M", "AH", "N", "T")),
    (r"ness(?=#)", ("N", "AH", "S")),
    # -- silent partners, word-initial then word-final -------------------
    (r"(?<=#)wr", ("R",)),
    (r"(?<=#)kn", ("N",)),
    (r"(?<=#)gn", ("N",)),
    (r"(?<=#)pn", ("N",)),
    (r"(?<=#)ps", ("S",)),
    (r"(?<=#)pt", ("T",)),
    (r"(?<=#)rh", ("R",)),
    (r"(?<=#)wh(?=o)", ("HH",)),
    (r"(?<=#)x", ("Z",)),
    (r"mb(?=#)", ("M",)),
    (r"mn(?=#)", ("M",)),
    (r"ign(?=#)", ("AY", "N")),
    (r"gn(?=#)", ("N",)),
    (r"bt(?=#)", ("T",)),
    (r"(?<=a)l(?=[kf])", ()),
    # -- consonant digraphs ----------------------------------------------
    (r"tch", ("CH",)),
    (r"dge", ("JH",)),
    (r"dg(?=[eiy])", ("JH",)),
    (r"qu", ("K", "W")),
    (r"wh", ("W",)),
    (r"ph", ("F",)),
    (r"sh", ("SH",)),
    (r"ch", ("CH",)),
    (r"ck", ("K",)),
    # "change", "orange": the g is soft, so the n is a plain N, not NG.
    (r"n(?=g[eiy])", ("N",)),
    (r"ng", ("NG",)),
    (r"(?<=[aeiou])the(?=#)", ("DH",)),
    (r"(?<=[aeiou])th(?=[aeiou])", ("DH",)),
    (r"th", ("TH",)),
    (r"gh(?=#)", ()),
    (r"(?<=[aeiou])gh", ()),
    (r"gh", ("G",)),
    (r"sc(?=[eiy])", ("S",)),
    # -- r-controlled vowels, before the plain teams ---------------------
    # The guard keeps an intervocalic r out of it: "very" is EH R, not ER.
    (r"air", ("EH", "R")),
    (r"are(?=#)", ("EH", "R")),
    (r"ear(?=#)", ("IH", "R")),
    (r"eer", ("IH", "R")),
    (r"ear(?![aeiouyr])", ("ER",)),
    (r"ere(?=#)", ("IH", "R")),
    (r"ire(?=#)", ("AY", "ER")),
    (r"ore(?=#)", ("AO", "R")),
    (r"ure(?=#)", ("Y", "UH", "R")),
    (r"our(?=#)", ("AW", "ER")),
    (r"oor", ("AO", "R")),
    (r"oar", ("AO", "R")),
    (r"our(?![aeiouyr])", ("ER",)),
    (r"(?<=w)ar(?![aeiouyr])", ("AO", "R")),
    (r"ar(?![aeiouyr])", ("AA", "R")),
    (r"(?<=w)or(?![aeiouyr])", ("ER",)),
    (r"or(?![aeiouyr])", ("AO", "R")),
    (r"er(?![aeiouyr])", ("ER",)),
    (r"ir(?![aeiouyr])", ("ER",)),
    (r"ur(?![aeiouyr])", ("ER",)),
    # -- vowel teams ------------------------------------------------------
    (r"eau", ("OW",)),
    (r"ai", ("EY",)),
    (r"ay", ("EY",)),
    (r"au", ("AO",)),
    (r"aw", ("AO",)),
    (r"ea", ("IY",)),
    (r"ee", ("IY",)),
    (r"(?<=c)ei", ("IY",)),
    (r"ei", ("EY",)),
    (r"eu", ("UW",)),
    (r"ew", ("UW",)),
    (r"ey", ("IY",)),
    # "pie", "tie", "die": a one-syllable -ie is AY, everywhere else IY.
    (r"(?<=#[bcdfghjklmnpqrstvwxz])ie(?=#)", ("AY",)),
    (r"ie", ("IY",)),
    (r"oa", ("OW",)),
    (r"oe(?=#)", ("OW",)),
    # "-ous"/"-us" is an ending, not a vowel team: famous, focus.
    (r"ous(?=#)", ("AH", "S")),
    (r"us(?=#)", ("AH", "S")),
    (r"oo(?=k)", ("UH",)),
    (r"oo", ("UW",)),
    (r"oi", ("OY",)),
    (r"oy", ("OY",)),
    (r"ou(?=#)", ("UW",)),
    (r"ou", ("AW",)),
    (r"ow(?=#)", ("OW",)),
    (r"ow", ("AW",)),
    (r"ue", ("UW",)),
    (r"ui", ("UW",)),
    # -- long vowels: magic e, open syllable before -le / -tion ----------
    (r"a(?=l[kl])", ("AO",)),
    (r"a(?=[bcdfgkmnpstvz]e#)", ("EY",)),
    (r"e(?=[bcdfgkmnpstvz]e#)", ("IY",)),
    (r"i(?=[bcdfgkmnpstvz]e#)", ("AY",)),
    (r"o(?=[bcdfgkmnpstvz]e#)", ("OW",)),
    (r"u(?=[bcdfgkmnpstvz]e#)", ("UW",)),
    (r"y(?=e#)", ("AY",)),
    (r"a(?=[bcdfgkpt]le#)", ("EY",)),
    (r"i(?=[bcdfgkpt]le#)", ("AY",)),
    (r"o(?=[bcdfgkpt]le#)", ("OW",)),
    (r"u(?=[bcdfgkpt]le#)", ("UW",)),
    (r"a(?=ture#)", ("EY",)),
    (r"a(?=tion)", ("EY",)),
    (r"e(?=tion)", ("IY",)),
    (r"o(?=tion)", ("OW",)),
    (r"u(?=tion)", ("UW",)),
    # -- syllabic -le, then the silent final e ---------------------------
    (r"(?<=[bcdfgkpstvz])le(?=#)", ("AH", "L")),
    (r"e(?=#)", ()),
    # -- single vowels ----------------------------------------------------
    (r"a(?=#)", ("AH",)),
    (r"a", ("AE",)),
    (r"e", ("EH",)),
    (r"i(?=#)", ("IY",)),
    (r"i", ("IH",)),
    (r"o(?=#)", ("OW",)),
    (r"o", ("AA",)),
    (r"u(?=#)", ("UW",)),
    (r"u", ("AH",)),
    (r"(?<=#)y", ("Y",)),
    # "cry", "sky", "why": a final y with no other vowel is stressed AY.
    # Spelled as fixed-width alternatives — Python has no variable lookbehind.
    (
        r"(?:(?<=#[^aeiouy])|(?<=#[^aeiouy]{2})|(?<=#[^aeiouy]{3}))y(?=#)",
        ("AY",),
    ),
    (r"y(?=#)", ("IY",)),
    (r"y(?=[aeiou])", ("Y",)),
    (r"y", ("IH",)),
    # -- consonants, doubles first ---------------------------------------
    (r"bb", ("B",)),
    (r"cc", ("K",)),
    (r"dd", ("D",)),
    (r"ff", ("F",)),
    (r"gg", ("G",)),
    (r"kk", ("K",)),
    (r"ll", ("L",)),
    (r"mm", ("M",)),
    (r"nn", ("N",)),
    (r"pp", ("P",)),
    (r"rr", ("R",)),
    (r"ss", ("S",)),
    (r"tt", ("T",)),
    (r"vv", ("V",)),
    (r"zz", ("Z",)),
    (r"c(?=[eiy])", ("S",)),
    (r"c", ("K",)),
    (r"g(?=[eiy])", ("JH",)),
    (r"g", ("G",)),
    (r"j", ("JH",)),
    (r"(?<=[aeiouy])s(?=[aeiouy])", ("Z",)),
    (r"s", ("S",)),
    (r"x", ("K", "S")),
    (r"b", ("B",)),
    (r"d", ("D",)),
    (r"f", ("F",)),
    (r"h(?=#)", ()),
    (r"h", ("HH",)),
    (r"k", ("K",)),
    (r"l", ("L",)),
    (r"m", ("M",)),
    (r"n", ("N",)),
    (r"p", ("P",)),
    (r"r", ("R",)),
    (r"t", ("T",)),
    (r"v", ("V",)),
    (r"w", ("W",)),
    (r"z", ("Z",)),
)

_COMPILED = tuple((re.compile(pattern), phones) for pattern, phones in _LTS_RULES)

_VOWEL_LETTERS = frozenset("aeiouy")
_VOICELESS = frozenset({"P", "T", "K", "F", "S", "SH", "CH", "TH", "HH"})
_SIBILANTS = frozenset({"S", "Z", "SH", "ZH", "CH", "JH"})
# he / she / we / be / me: the final e is the whole vowel, not a silent one.
_BARE_FINAL_E = re.compile(r"[bcdfghjklmnprstvwz]{1,3}e")
# "hop" + ed -> hope: one consonant after one vowel lost its silent e.
_LOST_SILENT_E = re.compile(r"[^aeiouy]?[aeiou][bcdfgklmnprstvz]")


def _has_vowel_letter(text: str) -> bool:
    return any(c in _VOWEL_LETTERS for c in text)


def _restore_silent_e(stem: str) -> str:
    """Put back the e that a suffix swallowed, for one-vowel stems only."""
    if len(stem) < 3 or sum(c in "aeiou" for c in stem) != 1:
        return stem
    return stem + "e" if _LOST_SILENT_E.fullmatch(stem[-3:]) else stem


def _peel_suffix(word: str) -> tuple[str, str] | None:
    """Split one inflectional/derivational ending off, or None.

    The stem is respelled the way it stood before the suffix was added
    (silent e restored, i put back to y) so the core rules see a real word.
    """
    for suffix, cut in (("ness", 4), ("ment", 4), ("able", 4), ("ible", 4), ("est", 3)):
        if word.endswith(suffix) and len(word) > cut + 1:
            stem = word[:-cut]
            if _has_vowel_letter(stem):
                return (stem[:-1] + "y" if stem.endswith("i") else stem, suffix)
    if word.endswith("ful") and len(word) > 4 and _has_vowel_letter(word[:-3]):
        return (word[:-3], "ful")
    if word.endswith("ing") and len(word) > 4:
        stem = _restore_silent_e(word[:-3])
        if _has_vowel_letter(stem):
            return (stem, "ing")
    if word.endswith("ly") and len(word) > 3:
        stem = word[:-2]
        if _has_vowel_letter(stem):
            return (stem[:-1] + "y" if stem.endswith("i") else stem, "ly")
    if word.endswith("ied") and len(word) > 4:
        return (word[:-3] + "y", "ed")
    if word.endswith("ed") and len(word) > 3 and word[-3] != "e":
        stem = _restore_silent_e(word[:-2])
        if _has_vowel_letter(stem):
            return (stem, "ed")
    if word.endswith("ies") and len(word) > 4:
        return (word[:-3] + "y", "s")
    # "-us"/"-ous" is a whole ending, not a plural: focus, famous, virus.
    if word.endswith("s") and not word.endswith(("ss", "us")) and len(word) > 2:
        # "boxes"/"wishes" peel the whole -es; "makes"/"goes" only the -s.
        if word.endswith("es") and (word[-3] in "sxz" or word[-4:-2] in ("ch", "sh")):
            stem = word[:-2]
        else:
            stem = word[:-1]
        if _has_vowel_letter(stem):
            return (stem, "s")
    return None


def _suffix_phones(kind: str, stem_phones: list[str]) -> tuple[str, ...]:
    last = stem_phones[-1] if stem_phones else ""
    if kind == "ed":
        if last in ("T", "D"):
            return ("IH", "D")
        return ("T",) if last in _VOICELESS else ("D",)
    if kind == "s":
        if last in _SIBILANTS:
            return ("IH", "Z")
        return ("S",) if last in _VOICELESS else ("Z",)
    return {
        "ing": ("IH", "NG"),
        "ly": ("L", "IY"),
        "ness": ("N", "AH", "S"),
        "ment": ("M", "AH", "N", "T"),
        "ful": ("F", "AH", "L"),
        "est": ("IH", "S", "T"),
        "able": ("AH", "B", "AH", "L"),
        "ible": ("AH", "B", "AH", "L"),
    }.get(kind, ())


def _lts(letters: str) -> list[str]:
    """Run the letter-to-sound rules over a bare alphabetic stem."""
    if not letters:
        return []
    if _BARE_FINAL_E.fullmatch(letters):
        return _lts(letters[:-1]) + ["IY"]
    padded = f"#{letters}#"
    out: list[str] = []
    i, end = 1, len(padded) - 1
    while i < end:
        for rx, phones in _COMPILED:
            match = rx.match(padded, i)
            if match and match.end() > i:
                out.extend(phones)
                i = match.end()
                break
        else:
            i += 1  # a character no rule covers (a digit, a stray mark)
    return out


def _rules_phones(word: str) -> list[str]:
    """Phones for one hyphen-free, apostrophe-aware token."""
    if word in _EXCEPTIONS:
        return list(_EXCEPTIONS[word])
    for clitic, phones in _CLITICS:
        if word.endswith(clitic) and len(word) > len(clitic):
            return _rules_phones(word[: -len(clitic)]) + list(phones)
    letters = word.replace("'", "")
    if not letters:
        return []
    if letters in _EXCEPTIONS:
        return list(_EXCEPTIONS[letters])
    peeled = _peel_suffix(letters)
    if peeled:
        stem, kind = peeled
        stem_phones = list(_EXCEPTIONS[stem]) if stem in _EXCEPTIONS else _lts(stem)
        if stem_phones:
            return stem_phones + list(_suffix_phones(kind, stem_phones))
    return _lts(letters)


# ---------------------------------------------------------------------------
# Syllabification
# ---------------------------------------------------------------------------

# Legal English onsets. Anything longer than one phone has to appear here for
# the maximal-onset split to hand it to the following syllable.
_ONSET_CLUSTERS = frozenset(
    {
        ("P", "R"),
        ("P", "L"),
        ("P", "Y"),
        ("B", "R"),
        ("B", "L"),
        ("B", "Y"),
        ("T", "R"),
        ("T", "W"),
        ("T", "Y"),
        ("D", "R"),
        ("D", "W"),
        ("D", "Y"),
        ("K", "R"),
        ("K", "L"),
        ("K", "W"),
        ("K", "Y"),
        ("G", "R"),
        ("G", "L"),
        ("G", "W"),
        ("F", "R"),
        ("F", "L"),
        ("F", "Y"),
        ("TH", "R"),
        ("TH", "W"),
        ("SH", "R"),
        ("HH", "Y"),
        ("V", "Y"),
        ("M", "Y"),
        ("N", "Y"),
        ("L", "Y"),
        ("S", "P"),
        ("S", "T"),
        ("S", "K"),
        ("S", "L"),
        ("S", "M"),
        ("S", "N"),
        ("S", "W"),
        ("S", "F"),
        ("S", "Y"),
        ("S", "P", "R"),
        ("S", "P", "L"),
        ("S", "P", "Y"),
        ("S", "T", "R"),
        ("S", "T", "Y"),
        ("S", "K", "R"),
        ("S", "K", "L"),
        ("S", "K", "W"),
        ("S", "K", "Y"),
        ("S", "M", "Y"),
    }
)


def _is_onset(cluster: tuple[str, ...]) -> bool:
    if not cluster:
        return True
    if len(cluster) == 1:
        return cluster[0] != "NG"
    return cluster in _ONSET_CLUSTERS


def _split_phones(
    phones: Sequence[str],
) -> list[tuple[tuple[str, ...], str, tuple[str, ...]]]:
    """Onset/nucleus/coda per syllable under the maximal-onset principle."""
    vowels = [i for i, p in enumerate(phones) if p in ARPABET_VOWELS]
    if not vowels:
        return []
    out: list[tuple[tuple[str, ...], str, tuple[str, ...]]] = []
    onset = tuple(phones[: vowels[0]])
    for n, v in enumerate(vowels):
        end = vowels[n + 1] if n + 1 < len(vowels) else len(phones)
        between = tuple(phones[v + 1 : end])
        if n + 1 < len(vowels):
            # Give the next syllable the longest legal onset it can take.
            split = len(between)
            while split > 0 and not _is_onset(between[len(between) - split :]):
                split -= 1
            coda, next_onset = (
                between[: len(between) - split],
                between[len(between) - split :],
            )
        else:
            coda, next_onset = between, ()
        out.append((onset, phones[v], coda))
        onset = next_onset
    return out


def syllabify(pron: Pron) -> list[Syllable]:
    """Split a pronunciation into syllables (maximal onset)."""
    parts = _split_phones(pron.phones)
    return [
        Syllable(
            onset=onset,
            nucleus=nucleus,
            coda=coda,
            stress=pron.stress[i] if i < len(pron.stress) else 0,
        )
        for i, (onset, nucleus, coda) in enumerate(parts)
    ]


# ---------------------------------------------------------------------------
# Stress (rules path only — the dictionary carries its own)
# ---------------------------------------------------------------------------

# Endings that pull the primary stress off the first syllable.
_TENSE_VOWELS = frozenset({"IY", "EY", "AY", "OW", "UW", "AW", "OY", "AO"})
_LAX_VOWELS = frozenset({"IH", "EH", "AH", "AE", "UH"})
_WEAK_PREFIXES = (
    "a",
    "be",
    "de",
    "re",
    "pre",
    "pro",
    "con",
    "com",
    "dis",
    "ex",
    "in",
    "im",
    "per",
    "sub",
)


def _rules_stress(word: str, nuclei: Sequence[str]) -> tuple[int, ...]:
    """Positional stress heuristic. Imperfect by design, never silent."""
    n = len(nuclei)
    if n == 0:
        return ()
    if n == 1:
        return (1,)
    primary = 0
    if word.endswith(
        ("tion", "tions", "sion", "sions", "cious", "tious", "cial", "tial")
    ):
        primary = n - 2
    elif word.endswith(
        ("ity", "ities", "ety", "ify", "ical", "ically", "ology", "ography")
    ):
        primary = max(0, n - 3)
    elif word.endswith(("ic", "ics", "ual", "ually")):
        primary = n - 2
    elif word.endswith(("ee", "eer", "ese", "ette", "esque")):
        primary = n - 1
    elif nuclei[0] in _LAX_VOWELS and nuclei[1] in _TENSE_VOWELS:
        # "believe", "astray", "about": a weak prefix in front of a long
        # vowel takes no stress. The prefix has to end the syllable to be
        # one, which is what keeps "ready" and "reason" out of here.
        for prefix in _WEAK_PREFIXES:
            if (
                word.startswith(prefix)
                and len(word) > len(prefix) + 1
                and word[len(prefix)] not in _VOWEL_LETTERS
            ):
                primary = 1
                break
    primary = max(0, min(primary, n - 1))
    stress = [0] * n
    stress[primary] = 1
    if n >= 4 and primary != 0:
        stress[0] = 2
    return tuple(stress)


# ---------------------------------------------------------------------------
# Public pronunciation API
# ---------------------------------------------------------------------------

_EMPTY = Pron(phones=(), stress=(), guessed=False)


def _from_cmu(raw: Sequence[str]) -> Pron:
    phones: list[str] = []
    stress: list[int] = []
    for token in raw:
        if token[-1].isdigit():
            phones.append(token[:-1])
            stress.append(int(token[-1]))
        else:
            phones.append(token)
    return Pron(phones=tuple(phones), stress=tuple(stress), guessed=False)


_REDUCIBLE = frozenset({"AE", "AA", "EH"})
_SONORANTS = ("R", "L", "M", "N", "NG")


def _give_it_a_beat(phones: list[str]) -> list[str]:
    """ "hmm", "skrrt", "psst": no vowel letter, but still a syllable."""
    for i in range(len(phones) - 1, -1, -1):
        if phones[i] in _SONORANTS:
            if phones[i] == "R":
                return phones[:i] + ["ER"] + phones[i + 1 :]
            return phones[:i] + ["AH"] + phones[i:]
    return phones[:1] + ["AH"] + phones[1:]


def _reduce_unstressed(phones: list[str], stress: Sequence[int]) -> list[str]:
    """Fold a full vowel in an unstressed syllable down to schwa.

    English does this everywhere ("celebration" is -LAH-, not -LEH-) and the
    rhyme keys are only comparable to the dictionary's if we do it too. An
    r-coloured coda keeps its vowel: "guitar" is not "guit-uh-r".
    """
    out: list[str] = []
    for i, (onset, nucleus, coda) in enumerate(_split_phones(phones)):
        weak = i < len(stress) and stress[i] == 0
        if weak and nucleus in _REDUCIBLE and not (coda and coda[0] == "R"):
            nucleus = "AH"
        out.extend(onset)
        out.append(nucleus)
        out.extend(coda)
    return out


def _rules_pron(word: str) -> Pron:
    parts = [p for p in word.split("-") if p.strip("'")]
    phones: list[str] = []
    for part in parts or [word]:
        phones.extend(_rules_phones(part.strip("'")))
    if not phones:
        return _EMPTY
    if not any(p in ARPABET_VOWELS for p in phones):
        phones = _give_it_a_beat(phones)
    nuclei = [p for p in phones if p in ARPABET_VOWELS]
    stress = _rules_stress(word.replace("-", "").replace("'", ""), nuclei)
    # The exception table is hand-written and already reduced; only the
    # rule-built pronunciations get second-guessed.
    if word not in _EXCEPTIONS:
        phones = _reduce_unstressed(phones, stress)
    return Pron(phones=tuple(phones), stress=stress, guessed=True)


@lru_cache(maxsize=8192)
def pronounce(word: str) -> Pron:
    """Best pronunciation for one word. Never raises; empty Pron when unpronounceable."""
    try:
        token = normalize_word(word)
        if not token:
            return _EMPTY
        raw = _cmu_phones(token)
        if raw:
            pron = _from_cmu(raw)
            if not any(p in ARPABET_VOWELS for p in pron.phones):
                # The dictionary lists "hmm", "shh", "mm" with no vowel at
                # all, which would leave them zero-syllable and rhyme-less
                # even though a lyric sings them on a beat. The nucleus is
                # ours, not the dictionary's, so the result is a guess.
                phones = tuple(_give_it_a_beat(list(pron.phones)))
                beats = sum(p in ARPABET_VOWELS for p in phones)
                return Pron(phones=phones, stress=(1,) * beats, guessed=True)
            return pron
        return _rules_pron(token)
    except Exception:
        return _EMPTY


def syllable_count(word: str) -> int:
    return len(_split_phones(pronounce(word).phones))


def stress_pattern(words: Sequence[str]) -> str:
    """One digit per syllable across the whole sequence, no separators."""
    out: list[str] = []
    for word in words:
        pron = pronounce(word)
        for syllable in syllabify(pron):
            out.append(str(syllable.stress))
    return "".join(out)


# ---------------------------------------------------------------------------
# Rhyme keys
# ---------------------------------------------------------------------------


def _stressed_vowel_index(pron: Pron) -> int | None:
    """Phone index of the last primary/secondary stressed vowel."""
    positions = [i for i, p in enumerate(pron.phones) if p in ARPABET_VOWELS]
    if not positions:
        return None
    for n in range(len(positions) - 1, -1, -1):
        if n < len(pron.stress) and pron.stress[n] in (1, 2):
            return positions[n]
    # Nothing marked (function words are all-zero in the dictionary): the
    # last vowel is still where the rhyme starts.
    return positions[-1]


def rhyme_key(pron: Pron) -> str:
    """Phones from the last stressed vowel to the end, space-joined."""
    index = _stressed_vowel_index(pron)
    if index is None:
        return ""
    return " ".join(pron.phones[index:])


def tail_key(pron: Pron, syllables: int) -> str:
    """The last ``syllables`` syllables' phones, space-joined."""
    parts = _split_phones(pron.phones)
    if not parts or syllables < 1:
        return ""
    out: list[str] = []
    for onset, nucleus, coda in parts[-syllables:]:
        out.extend(onset)
        out.append(nucleus)
        out.extend(coda)
    return " ".join(out)


# ---------------------------------------------------------------------------
# Phone distances
# ---------------------------------------------------------------------------

# (height, backness, rounding, rhoticity), each 0..1. Diphthongs sit between
# their endpoints — enough to keep EY next to IY and AH away from UW.
_VOWEL_FEATURES: dict[str, tuple[float, float, float, float]] = {
    "IY": (1.00, 0.00, 0.0, 0.0),
    "IH": (0.80, 0.15, 0.0, 0.0),
    "EY": (0.75, 0.05, 0.0, 0.0),
    "EH": (0.55, 0.10, 0.0, 0.0),
    "AE": (0.25, 0.10, 0.0, 0.0),
    "AA": (0.00, 0.85, 0.0, 0.0),
    "AO": (0.35, 0.90, 1.0, 0.0),
    "AH": (0.50, 0.50, 0.0, 0.0),
    "ER": (0.50, 0.45, 0.0, 1.0),
    "UH": (0.80, 0.85, 1.0, 0.0),
    "UW": (1.00, 1.00, 1.0, 0.0),
    "OW": (0.60, 0.95, 1.0, 0.0),
    "AW": (0.30, 0.60, 0.5, 0.0),
    "AY": (0.45, 0.40, 0.0, 0.0),
    "OY": (0.55, 0.65, 0.7, 0.0),
}

# (place 0..1 front-to-back, manner on a sonority scale, voiced).
_CONSONANT_FEATURES: dict[str, tuple[float, float, int]] = {
    "P": (0.00, 0.00, 0),
    "B": (0.00, 0.00, 1),
    "M": (0.00, 0.55, 1),
    "F": (0.15, 0.30, 0),
    "V": (0.15, 0.30, 1),
    "TH": (0.30, 0.30, 0),
    "DH": (0.30, 0.30, 1),
    "T": (0.45, 0.00, 0),
    "D": (0.45, 0.00, 1),
    "S": (0.45, 0.30, 0),
    "Z": (0.45, 0.30, 1),
    "N": (0.45, 0.55, 1),
    "L": (0.45, 0.80, 1),
    "R": (0.50, 0.80, 1),
    "SH": (0.60, 0.30, 0),
    "ZH": (0.60, 0.30, 1),
    "CH": (0.60, 0.15, 0),
    "JH": (0.60, 0.15, 1),
    "Y": (0.70, 0.95, 1),
    "K": (0.85, 0.00, 0),
    "G": (0.85, 0.00, 1),
    "NG": (0.85, 0.55, 1),
    "W": (0.90, 0.95, 1),
    "HH": (1.00, 0.30, 0),
}


def vowel_distance(a: str, b: str) -> float:
    """0.0 for the same vowel, 1.0 for unrelated (or non-vowel) phones."""
    if a == b and a in _VOWEL_FEATURES:
        return 0.0
    fa, fb = _VOWEL_FEATURES.get(a), _VOWEL_FEATURES.get(b)
    if fa is None or fb is None:
        return 1.0
    distance = (
        0.35 * abs(fa[0] - fb[0])
        + 0.30 * abs(fa[1] - fb[1])
        + 0.20 * abs(fa[2] - fb[2])
        + 0.15 * abs(fa[3] - fb[3])
    )
    return round(min(1.0, distance), 4)


def consonant_distance(a: str, b: str) -> float:
    """0.0 for the same consonant, 1.0 for unrelated (or non-consonant) phones."""
    if a == b and a in _CONSONANT_FEATURES:
        return 0.0
    fa, fb = _CONSONANT_FEATURES.get(a), _CONSONANT_FEATURES.get(b)
    if fa is None or fb is None:
        return 1.0
    distance = (
        0.45 * abs(fa[0] - fb[0])
        + 0.40 * abs(fa[1] - fb[1])
        + 0.15 * abs(fa[2] - fb[2])
    )
    return round(min(1.0, distance), 4)


def _phone_distance(a: str, b: str) -> float:
    """Distance between any two phones, vowel or consonant.

    A rhyme tail longer than one syllable carries the unstressed vowels too
    ("EY SH AH N"), so scoring the whole tail with ``consonant_distance``
    would call every vowel maximally far from itself.
    """
    if a == b:
        return 0.0
    if a in ARPABET_VOWELS and b in ARPABET_VOWELS:
        return vowel_distance(a, b)
    if a in _CONSONANT_FEATURES and b in _CONSONANT_FEATURES:
        return consonant_distance(a, b)
    return 1.0


def _tail_distance(a: tuple[str, ...], b: tuple[str, ...]) -> float:
    """How far apart two rhyme tails (everything after the nucleus) are."""
    if a == b:
        return 0.0
    length_penalty = 0.35 * abs(len(a) - len(b))
    if not a or not b:
        return min(1.0, length_penalty + 0.15)
    # Align from the right: tails share their end more often than their start.
    pairs = list(zip(reversed(a), reversed(b)))
    mean = sum(_phone_distance(x, y) for x, y in pairs) / len(pairs)
    return round(min(1.0, mean + length_penalty), 4)


# ---------------------------------------------------------------------------
# Rhyme classification
# ---------------------------------------------------------------------------

_NEAR_VOWEL = 0.45
_NEAR_TAIL = 0.5


def _key_onset(pron: Pron) -> tuple[str, ...]:
    """Onset of the syllable the rhyme key starts in."""
    index = _stressed_vowel_index(pron)
    if index is None:
        return ()
    position = 0
    for onset, _nucleus, coda in _split_phones(pron.phones):
        if position + len(onset) == index:
            return onset
        position += len(onset) + 1 + len(coda)
    return ()


def _guess_penalty(a: Pron, b: Pron) -> float:
    if a.guessed and b.guessed:
        return 0.75
    return 0.85 if (a.guessed or b.guessed) else 1.0


def _shared_tail_letters(a: str, b: str) -> int:
    count = 0
    for x, y in zip(reversed(a), reversed(b)):
        if x != y:
            break
        count += 1
    return count


def classify_rhyme(
    a: Pron, b: Pron, *, word_a: str = "", word_b: str = ""
) -> tuple[str, float]:
    """Name the rhyme between two pronunciations and score the confidence."""
    if not a.phones or not b.phones:
        return ("", 0.0)
    wa, wb = normalize_word(word_a), normalize_word(word_b)
    if wa and wa == wb:
        return ("identical-rhyme", 1.0)
    penalty = _guess_penalty(a, b)
    if a.phones == b.phones:
        return ("identical-rhyme", round(penalty, 3))

    ka, kb = rhyme_key(a), rhyme_key(b)
    if not ka or not kb:
        return ("", 0.0)
    if ka == kb:
        # Same rime, different pronunciation in front of it: the perfect rhyme.
        return ("end-rhyme", round(penalty, 3))
    onset_a, onset_b = _key_onset(a), _key_onset(b)

    parts_a, parts_b = ka.split(" "), kb.split(" ")
    nucleus_a, tail_a = parts_a[0], tuple(parts_a[1:])
    nucleus_b, tail_b = parts_b[0], tuple(parts_b[1:])
    vowel = vowel_distance(nucleus_a, nucleus_b)
    tail = _tail_distance(tail_a, tail_b)

    # Same consonant frame, swapped vowel — Owen's pararhyme.
    if nucleus_a != nucleus_b and onset_a == onset_b and tail_a == tail_b and tail_a:
        return ("pararhyme", round(max(0.35, 0.65 - 0.2 * vowel) * penalty, 3))

    near = (nucleus_a == nucleus_b and tail < _NEAR_TAIL) or (
        vowel < _NEAR_VOWEL and tail_a == tail_b
    )
    if near:
        score = min(0.9, max(0.4, 0.9 - 0.5 * (vowel + tail)))
        return ("slant-rhyme", round(score * penalty, 3))

    # Nothing rhymes; the spelling might still promise it does.
    if wa and wb and _shared_tail_letters(wa, wb) >= 2:
        return ("eye-rhyme", round(0.3 * penalty, 3))
    return ("", 0.0)
