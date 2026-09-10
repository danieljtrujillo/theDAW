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
    "RhymeScore",
    "Syllable",
    "classify_rhyme",
    "consonant_distance",
    "consonant_family",
    "homophone_key",
    "max_rhyme_score",
    "normalize_word",
    "pronounce",
    "pronounce_phrase",
    "pronunciation_source",
    "rhyme_key",
    "rhyme_score",
    "stress_pattern",
    "syllabify",
    "syllable_count",
    "tail_key",
    "pronunciations",
    "vowel_colour_distance",
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


def _cmu_table() -> dict[str, list[list[str]]]:
    """The dictionary, built once. Empty when it could not be read.

    A successful *import* is not a working dictionary: the data file can be
    missing or unreadable, and the build then throws on the first lookup. When
    that happens every word is in fact guessed, so ``PRONUNCIATION_SOURCE`` is
    corrected here rather than left claiming a source that never answered.
    """
    global _CMU_TABLE, PRONUNCIATION_SOURCE
    if _CMU_TABLE is None:
        try:
            _CMU_TABLE = dict(_cmudict.dict()) if _cmudict is not None else {}
        except Exception:
            _CMU_TABLE = {}
        if not _CMU_TABLE:
            PRONUNCIATION_SOURCE = "rules"
    return _CMU_TABLE


def pronunciation_source() -> str:
    """``"cmudict"`` or ``"rules"``, resolved for real (the table is built)."""
    _cmu_table()
    return PRONUNCIATION_SOURCE


def _cmu_phones(word: str) -> list[str] | None:
    """First dictionary pronunciation for ``word``, still carrying stress digits."""
    if _cmudict is None:
        return None
    entry = _cmu_table().get(word)
    if not entry:
        return None
    return list(entry[0])


# How many of the dictionary's alternate readings to carry. cmudict lists up
# to four; the tail of that list is dialect trivia, and every extra reading
# multiplies the pairwise rhyme comparison.
_MAX_ALTERNATES = 2


def _cmu_alternates(word: str) -> tuple[Pron, ...]:
    """The dictionary's pronunciations of ``word`` after the first.

    "was" is W AA1 Z *and* W AH0 Z, "live" is L AY1 V *and* L IH1 V, "route"
    is R UW1 T *and* R AW1 T. Taking entry[0] and dropping the rest decided
    which word the singer sang, and got it wrong often enough to return no
    rhyme at all for "was"/"does" and "route"/"out".

    Only readings of the SAME LENGTH as the first are taken. The dictionary's
    other kind of alternate collapses a syllable — "fire" is F AY1 ER0 and
    also F AY1 R, "hour" is AW1 ER0 and also AW1 R — and that reading is not
    a different vowel, it is a different word shape: it makes a two-syllable
    word monosyllabic and rhyme with anything ending -AR, which put
    "fire"/"star" on screen as a slant rhyme at 0.505. The variants worth
    having swap a vowel and keep the shape: was, live, again, route, been.
    """
    if _cmudict is None:
        return ()
    entry = _cmu_table().get(word)
    if not entry or len(entry) < 2:
        return ()
    beats = sum(1 for p in entry[0] if p[:2] in ARPABET_VOWELS)
    out: list[Pron] = []
    for raw in entry[1:]:
        alt = _from_cmu(raw)
        if len(alt.stress) == beats and any(p in ARPABET_VOWELS for p in alt.phones):
            out.append(alt)
        if len(out) >= _MAX_ALTERNATES:
            break
    return tuple(out)


@dataclass(frozen=True)
class Pron:
    """One pronunciation: bare ARPABET phones plus a stress digit per vowel."""

    phones: tuple[str, ...]
    stress: tuple[int, ...]
    guessed: bool
    # The dictionary's OTHER pronunciations of the same word, if it has any.
    # A singer picks one per performance and the rhyme is built on whichever
    # one they picked: "again" is AH0 G EH1 N *or* AH0 G EY1 N, and only the
    # second rhymes with "rain". Scoring the first entry alone threw the
    # other readings away and reported no rhyme at all. Everything that is
    # not rhyme scoring — syllables, stress, spans — still uses this Pron's
    # own phones, so a variant never moves a painted span. Variants carry no
    # variants of their own.
    variants: tuple[Pron, ...] = ()


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
    # High-frequency lyric words the letter-to-sound rules mis-spell, and whose
    # rhymes therefore went missing on a machine without cmudict.
    "away": ("AH", "W", "EY"),
    "honey": ("HH", "AH", "N", "IY"),
    "soul": ("S", "OW", "L"),
    "hurt": ("HH", "ER", "T"),
    "awake": ("AH", "W", "EY", "K"),
    "aware": ("AH", "W", "EH", "R"),
    "sorrow": ("S", "AA", "R", "OW"),
    "tomorrow": ("T", "AH", "M", "AA", "R", "OW"),
    "borrow": ("B", "AA", "R", "OW"),
    "narrow": ("N", "AE", "R", "OW"),
    "forever": ("F", "ER", "EH", "V", "ER"),
    "whatever": ("W", "AH", "T", "EH", "V", "ER"),
    "another": ("AH", "N", "AH", "DH", "ER"),
    "remember": ("R", "IH", "M", "EH", "M", "B", "ER"),
    "forward": ("F", "AO", "R", "W", "ER", "D"),
    "toward": ("T", "AO", "R", "D"),
    "wonder": ("W", "AH", "N", "D", "ER"),
    "wonderful": ("W", "AH", "N", "D", "ER", "F", "AH", "L"),
    "worry": ("W", "ER", "IY"),
    "hurry": ("HH", "ER", "IY"),
    "carry": ("K", "AE", "R", "IY"),
    "sorry": ("S", "AA", "R", "IY"),
    "story": ("S", "T", "AO", "R", "IY"),
    "pretty": ("P", "R", "IH", "T", "IY"),
    "promise": ("P", "R", "AA", "M", "AH", "S"),
    "premise": ("P", "R", "EH", "M", "AH", "S"),
    "silence": ("S", "AY", "L", "AH", "N", "S"),
    "violence": ("V", "AY", "AH", "L", "AH", "N", "S"),
    "patience": ("P", "EY", "SH", "AH", "N", "S"),
    "million": ("M", "IH", "L", "Y", "AH", "N"),
    "villain": ("V", "IH", "L", "AH", "N"),
    "prison": ("P", "R", "IH", "Z", "AH", "N"),
    "rhythm": ("R", "IH", "DH", "AH", "M"),
    "shoulder": ("SH", "OW", "L", "D", "ER"),
    "soldier": ("S", "OW", "L", "JH", "ER"),
    "trouble": ("T", "R", "AH", "B", "AH", "L"),
    "double": ("D", "AH", "B", "AH", "L"),
    "struggle": ("S", "T", "R", "AH", "G", "AH", "L"),
    "kitchen": ("K", "IH", "CH", "AH", "N"),
    "listen": ("L", "IH", "S", "AH", "N"),
    "reason": ("R", "IY", "Z", "AH", "N"),
    "season": ("S", "IY", "Z", "AH", "N"),
    "danger": ("D", "EY", "N", "JH", "ER"),
    "stranger": ("S", "T", "R", "EY", "N", "JH", "ER"),
    "desire": ("D", "IH", "Z", "AY", "ER"),
    "higher": ("HH", "AY", "ER"),
    "quiet": ("K", "W", "AY", "AH", "T"),
    "lonely": ("L", "OW", "N", "L", "IY"),
    "occasion": ("AH", "K", "EY", "ZH", "AH", "N"),
    "engine": ("EH", "N", "JH", "AH", "N"),
    "machine": ("M", "AH", "SH", "IY", "N"),
    "guitar": ("G", "IH", "T", "AA", "R"),
    "piano": ("P", "IY", "AE", "N", "OW"),
    "mountain": ("M", "AW", "N", "T", "AH", "N"),
    "candle": ("K", "AE", "N", "D", "AH", "L"),
    "cost": ("K", "AO", "S", "T"),
    "lost": ("L", "AO", "S", "T"),
    "laughed": ("L", "AE", "F", "T"),
    "young": ("Y", "AH", "NG"),
    "tongue": ("T", "AH", "NG"),
    "song": ("S", "AO", "NG"),
    "along": ("AH", "L", "AO", "NG"),
    "belong": ("B", "IH", "L", "AO", "NG"),
    "wrong": ("R", "AO", "NG"),
    "strong": ("S", "T", "R", "AO", "NG"),
}

# Words whose stress the positional heuristic gets wrong, where getting it
# wrong moves the rhyme key onto the wrong syllable and the rhyme disappears.
_STRESS_EXCEPTIONS: dict[str, tuple[int, ...]] = {
    "tomorrow": (0, 1, 0),
    "enough": (0, 1),
    "forget": (0, 1),
    "forgive": (0, 1),
    "because": (0, 1),
    "again": (0, 1),
    "against": (0, 1),
    "become": (0, 1),
    "begin": (0, 1),
    "began": (0, 1),
    "sorrow": (1, 0),
    "borrow": (1, 0),
    "narrow": (1, 0),
    "forever": (0, 1, 0),
    "whatever": (0, 1, 0),
    "another": (0, 1, 0),
    "remember": (0, 1, 0),
    "together": (0, 1, 0),
    "wonderful": (1, 0, 0),
    "occasion": (0, 1, 0),
    "machine": (0, 1),
    "guitar": (0, 1),
    "piano": (0, 1, 0),
    "desire": (0, 1),
    "violence": (1, 0, 0),
    "villain": (1, 0),
    "million": (1, 0),
    "engine": (1, 0),
    "mountain": (1, 0),
    "quiet": (1, 0),
    "premise": (1, 0),
    "promise": (1, 0),
    "prison": (1, 0),
    "pretty": (1, 0),
    "belong": (0, 1),
    "along": (0, 1),
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
    # "away", "awake", "aware": the a and the w are in different syllables, so
    # the aw team must not swallow them into one AO.
    (r"(?<=#)a(?=w[aeiou])", ("AH",)),
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
    (r"y(?=[bcdfgkmnpstvz]e#)", ("AY",)),
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
    "to",
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


def _has_weak_prefix(
    word: str, parts: Sequence[tuple[tuple[str, ...], str, tuple[str, ...]]]
) -> bool:
    """The word opens on an unstressable prefix syllable.

    The prefix has to END the syllable — it is followed by a consonant letter —
    which is what keeps "ready" and "reason" out of here. A bare "a-" needs
    more than that: it is a prefix in "a-part" and "a-way", and is simply the
    first letter in "al-ways" and "an-swer", and only the open syllable tells
    them apart.
    """
    for prefix in _WEAK_PREFIXES:
        if (
            word.startswith(prefix)
            and len(word) > len(prefix) + 1
            and word[len(prefix)] not in _VOWEL_LETTERS
        ):
            return not (len(prefix) == 1 and parts and parts[0][2])
    return False


def _rules_stress(word: str, phones: Sequence[str]) -> tuple[int, ...]:
    """Positional stress heuristic. Imperfect by design, never silent."""
    parts = _split_phones(phones)
    n = len(parts)
    if n == 0:
        return ()
    if n == 1:
        return (1,)
    fixed = _STRESS_EXCEPTIONS.get(word)
    if fixed and len(fixed) == n:
        return fixed
    nuclei = [nucleus for _onset, nucleus, _coda in parts]
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
    elif _has_weak_prefix(word, parts) and (
        nuclei[0] in _LAX_VOWELS and nuclei[1] in _TENSE_VOWELS
    ):
        # "believe", "insane", "about": a weak prefix in front of a long vowel
        # takes no stress.
        primary = 1
    elif _has_weak_prefix(word, parts) and _shifts_off_the_prefix(word, parts):
        # The same shift for the far more common shape the tense-vowel test
        # missed — "apart", "tonight", "regret", "across" all put a plain short
        # vowel in the stressed syllable, and reading them as PREFIX-stressed
        # moved the rhyme key one syllable too far left, which is why
        # "apart"/"heart" and "regret"/"forget" came back as non-rhymes.
        primary = 1
    primary = max(0, min(primary, n - 1))
    stress = [0] * n
    stress[primary] = 1
    if n >= 4 and primary != 0:
        stress[0] = 2
    return tuple(stress)


def _shifts_off_the_prefix(
    word: str, parts: Sequence[tuple[tuple[str, ...], str, tuple[str, ...]]]
) -> bool:
    """Can the second syllable carry the primary stress instead of the first?

    Only when the prefix syllable is genuinely open ("a-part", not "al-ways")
    and the syllable after it is heavy — it closes on a consonant or holds a
    long vowel — and is not a schwa, which is never stressed ("ap-ple",
    "ta-ble"). A two-syllable word ending in -y keeps its first-syllable
    stress ("pret-ty", "ar-my").
    """
    if len(parts) < 2 or parts[0][2]:
        return False
    _onset, nucleus, coda = parts[1]
    if nucleus == "AH":
        return False
    # A final -y spelling a weak /i/ keeps the stress in front of it
    # ("pret-ty", "ar-my"); a final -y spelling a real vowel does not
    # ("to-day", "re-ply").
    if len(parts) == 2 and word.endswith(("y", "ie")) and nucleus in ("IY", "IH"):
        return False
    return bool(coda) or nucleus in _TENSE_VOWELS


# ---------------------------------------------------------------------------
# Public pronunciation API
# ---------------------------------------------------------------------------

_EMPTY = Pron(phones=(), stress=(), guessed=False)

# "runnin'," "lovin'" — the g-dropping apostrophe, with the line's punctuation
# allowed to follow it.
_G_DROPPED = re.compile(r"in'[^A-Za-z0-9']*$", re.IGNORECASE)


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
    stress = _rules_stress(word.replace("-", "").replace("'", ""), phones)
    # The exception table is hand-written and already reduced; only the
    # rule-built pronunciations get second-guessed.
    if word not in _EXCEPTIONS:
        phones = _reduce_unstressed(phones, stress)
    return Pron(phones=tuple(phones), stress=stress, guessed=True)


@lru_cache(maxsize=8192)
def _pronounce_token(token: str, g_dropped: bool = False) -> Pron:
    """The lookup itself, on an already-normalised token."""
    try:
        if g_dropped:
            # The apostrophe in "lovin'" is the singer telling us this is
            # "loving". Taken before the dictionary, because cmudict lists
            # "lovin" and "chasin" as SURNAMES — L OW V IH N, CH AE S IH N —
            # and rhyming the sung word off those is worse than guessing.
            restored = _restore_dropped_g(token)
            if restored is not None:
                return Pron(
                    phones=restored.phones, stress=restored.stress, guessed=True
                )
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
            return Pron(
                phones=pron.phones,
                stress=pron.stress,
                guessed=False,
                variants=_cmu_alternates(token),
            )
        restored = _restore_dropped_g(token)
        if restored is not None:
            # "runnin", "cappin", "wishin" with the apostrophe left off: still
            # the -ing word, and rhyming it as a coinage instead threw away
            # half a hook's rhymes. Ours, so still a guess.
            return Pron(phones=restored.phones, stress=restored.stress, guessed=True)
        return _rules_pron(token)
    except Exception:
        return _EMPTY


def _restore_dropped_g(token: str) -> Pron | None:
    """The ``-ing`` word behind a sung ``-in'``, or ``None``.

    Only reached for tokens the dictionary does not know as themselves, and
    only trusted when it *does* know the restored spelling — "cabin" and
    "satin" are real words, so the guess is never made blind.
    """
    if not token.endswith("in") or len(token) < 5:
        return None
    raw = _cmu_phones(token + "g")
    return _from_cmu(raw) if raw else None


def pronounce(word: str) -> Pron:
    """Best pronunciation for one word.

    Never raises — including on a value that is not a string at all, which the
    cache would otherwise refuse to hash before this function ever ran.

    Pass the word AS WRITTEN: the trailing apostrophe of "runnin'" is dropped
    by normalisation and is the only thing that says the word is g-dropped.
    """
    try:
        text = str(word)
        token = normalize_word(text)
        dropped = _G_DROPPED.search(text.translate(_FOLD)) is not None
    except Exception:
        return _EMPTY
    return _pronounce_token(token, dropped) if token else _EMPTY


# The cache lives on the private worker; callers (and tests) reset it here.
pronounce.cache_clear = _pronounce_token.cache_clear  # type: ignore[attr-defined]
pronounce.cache_info = _pronounce_token.cache_info  # type: ignore[attr-defined]


def pronounce_phrase(words: Sequence[str]) -> Pron:
    """One pronunciation for a run of words, read as a single phone stream.

    Line endings rhyme as phrases — "hold on" / "cold dawn", "to me" / "for
    me" — so the run has to be pronounceable as a unit, not only word by word.
    """
    phones: list[str] = []
    stress: list[int] = []
    guessed = False
    for word in words:
        pron = pronounce(word)
        if not pron.phones:
            continue
        phones.extend(pron.phones)
        stress.extend(pron.stress)
        guessed = guessed or pron.guessed
    if not phones:
        return _EMPTY
    return Pron(phones=tuple(phones), stress=tuple(stress), guessed=guessed)


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

# A vowel is a TRAJECTORY, not a point: (start, end, tenseness, rhoticity),
# where each endpoint is (height 0=low..1=high, backness 0=front..1=back,
# rounding). A monophthong starts and ends in the same place; a diphthong
# travels from its nucleus to its glide target, which is what "diphthongs sit
# between their endpoints" has to mean if it is to mean anything — AY starts
# where AA is and ends where IH is.
#
# Tenseness (length) is the fourth dimension and it is doing real work: it is
# the ONLY thing that separates a lax IH from the front-and-high EY glide it
# otherwise sits inside, and without it "hit"/"hate" scores like a rhyme.
# The earlier table was a hand-picked point per vowel, and it made AH-AY and
# EY-IH its two closest pairs — schwa nearer to a diphthong than that
# diphthong's own endpoints, which is what put "cut"/"kite" on screen.
_VowelRow = tuple[float, float, float, float, float, float, float, float]
_VOWEL_FEATURES: dict[str, _VowelRow] = {
    # start (h, b, r)      end (h, b, r)         tense  rhotic
    "IY": (1.00, 0.00, 0.0, 1.00, 0.00, 0.0, 1.00, 0.0),
    "IH": (0.75, 0.15, 0.0, 0.75, 0.15, 0.0, 0.15, 0.0),
    "EH": (0.40, 0.15, 0.0, 0.40, 0.15, 0.0, 0.15, 0.0),
    "AE": (0.10, 0.20, 0.0, 0.10, 0.20, 0.0, 0.15, 0.0),
    "AA": (0.00, 0.90, 0.0, 0.00, 0.90, 0.0, 0.80, 0.0),
    "AO": (0.15, 0.90, 0.4, 0.15, 0.90, 0.4, 0.85, 0.0),
    "AH": (0.42, 0.52, 0.0, 0.42, 0.52, 0.0, 0.00, 0.0),
    "ER": (0.45, 0.45, 0.0, 0.45, 0.45, 0.0, 0.70, 1.0),
    "UH": (0.70, 0.80, 1.0, 0.70, 0.80, 1.0, 0.20, 0.0),
    "UW": (1.00, 0.95, 1.0, 1.00, 0.95, 1.0, 1.00, 0.0),
    "EY": (0.55, 0.10, 0.0, 0.85, 0.10, 0.0, 1.00, 0.0),
    "OW": (0.50, 0.85, 1.0, 0.85, 0.90, 1.0, 1.00, 0.0),
    "AY": (0.02, 0.75, 0.0, 0.80, 0.15, 0.0, 1.00, 0.0),
    "AW": (0.02, 0.75, 0.0, 0.80, 0.85, 1.0, 1.00, 0.0),
    "OY": (0.30, 0.90, 1.0, 0.80, 0.15, 0.0, 1.00, 0.0),
}

# How the vowel distance is built. The two endpoints share the geometric
# term (which therefore reaches 1.0 on its own, so two maximally distant
# vowels really do score 1.0); tenseness and rhoticity are added on top,
# because a lax vowel and a tense one are far apart however close their
# formants are — that, and nothing else, is what separates "hit" from "hate".
_V_START = 0.62
_V_END = 0.38
_V_TENSE = 0.30
_V_RHOTIC = 0.22


def _point_distance(
    a: tuple[float, float, float], b: tuple[float, float, float]
) -> float:
    return 0.55 * abs(a[0] - b[0]) + 0.30 * abs(a[1] - b[1]) + 0.15 * abs(a[2] - b[2])


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
    shape = _V_START * _point_distance(fa[0:3], fb[0:3]) + _V_END * _point_distance(
        fa[3:6], fb[3:6]
    )
    distance = shape + _V_TENSE * abs(fa[6] - fb[6]) + _V_RHOTIC * abs(fa[7] - fb[7])
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


# Assonance is about the COLOUR of a vowel, not about its length.
#
# ``vowel_distance`` above weights tenseness heavily and it is right to: it is
# the only thing separating "hit" from "hate", and without it the rhyme
# classifier calls those a rhyme. But a lyric that runs "sleep / lift / green
# / hill" is assonating on one front-high colour, and a rhyme-grade distance
# scores IY/IH at 0.44 — further apart than AA/AY — so a whole family of the
# vowel play a writer actually hears comes back as nothing at all.
#
# So the colour distance is the same geometry with the length penalty turned
# most of the way down. Rhyme keeps the strict one; assonance uses this.
_V_COLOUR_TENSE = 0.08


def vowel_colour_distance(a: str, b: str) -> float:
    """0.0 for the same vowel, 1.0 for unrelated — length nearly ignored.

    The assonance twin of :func:`vowel_distance`. Use it wherever the question
    is "do these two words ring on the same vowel", and the strict one
    wherever the question is "do these two words rhyme".
    """
    if a == b and a in _VOWEL_FEATURES:
        return 0.0
    fa, fb = _VOWEL_FEATURES.get(a), _VOWEL_FEATURES.get(b)
    if fa is None or fb is None:
        return 1.0
    shape = _V_START * _point_distance(fa[0:3], fb[0:3]) + _V_END * _point_distance(
        fa[3:6], fb[3:6]
    )
    distance = (
        shape + _V_COLOUR_TENSE * abs(fa[6] - fb[6]) + _V_RHOTIC * abs(fa[7] - fb[7])
    )
    return round(min(1.0, distance), 4)


# Consonance the way a writer hears it: /s/ and /z/ are one sound wearing two
# hats ("dogs" ends in Z), and so are T/D, P/B, K/G, F/V, CH/JH, SH/ZH, TH/DH.
# Grouping the nasals together is the same move one step further out — "time"
# / "line" / "sing" ring together and no exact-phone pass can see it.
_CONSONANT_FAMILIES: tuple[tuple[str, ...], ...] = (
    ("P", "B"),
    ("T", "D"),
    ("K", "G"),
    ("F", "V"),
    ("S", "Z"),
    ("SH", "ZH"),
    ("CH", "JH"),
    ("TH", "DH"),
    ("M", "N", "NG"),
    ("L", "R"),
)

_CONSONANT_FAMILY_OF: dict[str, str] = {
    phone: family[0] for family in _CONSONANT_FAMILIES for phone in family
}


def consonant_family(phone: str) -> str:
    """The consonant's family head, or the phone itself when it has none.

    Two consonants in one family are near enough for consonance; the phone is
    still reported, so a finding says S where the word has an S.
    """
    return _CONSONANT_FAMILY_OF.get(phone, phone)


def homophone_key(pron: "Pron") -> str:
    """A pronunciation reduced to what a listener hears, stress dropped.

    Two spellings with the same key are homophones — "their"/"there",
    "right"/"write", "sole"/"soul" — which is the one kind of double meaning
    a dictionary can prove rather than guess at.
    """
    return " ".join(pron.phones)


def pronunciations(word: str) -> tuple["Pron", ...]:
    """Every dictionary reading of ``word``, best first.

    A word with two readings that differ in their vowels or their stress is a
    heteronym — "record", "live", "bow", "desert" — and a heteronym is a word
    carrying two meanings, which is exactly what the meaning pass looks for.
    Falls back to the single sounded-out reading when the dictionary has none.
    """
    first = pronounce(word)
    if not first.phones:
        return ()
    key = normalize_word(word)
    return (first, *_cmu_alternates(key)) if key else (first,)


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


def _gap_cost(phone: str) -> float:
    """What it costs for a phone to be present on one side and absent on the other.

    Sung English drops and simplifies final consonants constantly — "hold"
    for "holds", "an' " for "and", the /t/ off "last" — and a rhyme survives
    all of it, so those phones are cheap to lose. Everything else is dear.
    """
    return _CHEAP_GAP if phone in _DROPPABLE else _GAP


def _cluster_distance(a: Sequence[str], b: Sequence[str]) -> float:
    """0..1 distance between two consonant clusters, by best alignment.

    Right-aligning the raw arrays (what this used to do) misaligns every phone
    the moment the two are different lengths: "N" against "N S" compared the
    N with the S and called two near-identical endings unrelated. An edit
    alignment costs the *insertion* instead, which is what actually happened.
    """
    if tuple(a) == tuple(b):
        return 0.0
    n, m = len(a), len(b)
    if n == 0 and m == 0:
        return 0.0
    prev = [0.0] * (m + 1)
    for j in range(1, m + 1):
        prev[j] = prev[j - 1] + _gap_cost(b[j - 1])
    for i in range(1, n + 1):
        cur = [prev[0] + _gap_cost(a[i - 1])]
        for j in range(1, m + 1):
            cur.append(
                min(
                    prev[j - 1] + _phone_distance(a[i - 1], b[j - 1]),
                    prev[j] + _gap_cost(a[i - 1]),
                    cur[j - 1] + _gap_cost(b[j - 1]),
                )
            )
        prev = cur
    return min(1.0, prev[m] / max(n, m))


def _coda_distance(a: Sequence[str], b: Sequence[str]) -> float:
    """Coda distance with the step a listener actually hears.

    Coda identity is close to categorical in rhyme: "cat"/"hat" is a rhyme
    and "cat"/"cap" is audibly not, even though P and T are one feature
    apart. So any mismatch at all pays a fixed step before the graded part.
    """
    if tuple(a) == tuple(b):
        return 0.0
    return min(1.0, _CODA_STEP + (1.0 - _CODA_STEP) * _cluster_distance(a, b))


# ---------------------------------------------------------------------------
# Rhyme classification
# ---------------------------------------------------------------------------
#
# Rhyme is neither binary nor one-dimensional, and the old chain of
# exact-match gates ("same nucleus OR same tail, else nothing") dropped every
# pair that was close on both and identical on neither — "station"/"patience"
# came back as no rhyme at all. What follows scores five dimensions instead:
# the stressed nucleus, the coda under it, the unstressed syllables after it,
# how many syllables each side brings, and whether the onsets differ (a rhyme
# wants them to). The kind is then read off the score, so a weak rhyme
# degrades to a low-confidence slant rhyme rather than to nothing.

# The nucleus is the rhyme. Squaring its agreement is what stops a pair that
# merely shares a coda ("read"/"ride") from riding in on the coda alone.
_NUCLEUS_EXPONENT = 1.6
# The rest of the rime is a weaker but still real requirement.
_RIME_EXPONENT = 1.0
# Weights inside one unstressed tail syllable: its onset, nucleus and coda.
_TAIL_ONSET = 0.35
_TAIL_NUCLEUS = 0.40
_TAIL_CODA = 0.25
# A tail onset is a consonant in the middle of the rhyme, so like a coda it
# pays a step for being different at all.
_ONSET_STEP = 0.30
_CODA_STEP = 0.15
# An unstressed vowel that is not the same vowel is a real mismatch, not a
# fraction of one: "-shun" against "-cher" is what makes "nation"/"nature"
# assonance rather than a rhyme.
_TAIL_VOWEL_STEP = 0.25
# One side has a syllable the other does not: the rhymes are different shapes.
_MISSING_SYLLABLE = 0.75
# One side stresses a tail syllable the other leaves weak.
_STRESS_MISMATCH = 0.15
# Two rhyming words normally begin differently; when they do not, what is
# being heard is closer to the same sound twice.
_SAME_ONSET_FACTOR = 0.94
_GAP = 0.60
_CHEAP_GAP = 0.35
_DROPPABLE = frozenset({"T", "D", "S", "Z"})

# Nucleus, coda and tail all matched: the same rime read off a different
# syllable than the stress digits pointed at.
_PERFECT_SCORE = 0.995
# A score at or above this is a rhyme a scheme can be built on; below it the
# pair is still reported, but as a weak slant rhyme the UI's floor can hide.
SLANT_STRONG = 0.5
# Below this there is not enough left to call it a rhyme at all.
SLANT_FLOOR = 0.34


@dataclass(frozen=True)
class RhymeScore:
    """The scored comparison behind a rhyme kind, kept for the tooltip."""

    score: float
    nucleus: float
    coda: float
    tail: float
    same_onset: bool
    syllables_a: int
    syllables_b: int


@dataclass(frozen=True)
class _Rime:
    """A pronunciation seen from its last stressed vowel onwards."""

    onset: tuple[str, ...]
    nucleus: str
    coda: tuple[str, ...]
    tail: tuple[Syllable, ...]

    @property
    def syllables(self) -> int:
        return 1 + len(self.tail)


def _key_syllable(pron: Pron) -> int | None:
    """Index of the syllable the rhyme key starts in."""
    parts = _split_phones(pron.phones)
    if not parts:
        return None
    for n in range(len(parts) - 1, -1, -1):
        if n < len(pron.stress) and pron.stress[n] in (1, 2):
            return n
    # Nothing marked (function words are all-zero in the dictionary): the last
    # syllable is still where the rhyme starts.
    return len(parts) - 1


def _rime_at(pron: Pron, index: int) -> _Rime:
    syllables = syllabify(pron)
    head = syllables[index]
    return _Rime(
        onset=head.onset,
        nucleus=head.nucleus,
        coda=head.coda,
        tail=tuple(syllables[index + 1 :]),
    )


def _rime(pron: Pron) -> _Rime | None:
    index = _key_syllable(pron)
    return None if index is None else _rime_at(pron, index)


# Anchors times dictionary readings is a product, and the pairwise score is
# that product on both sides, so it is capped rather than left to grow.
_MAX_RIME_CANDIDATES = 8


def _anchors(pron: Pron) -> list[_Rime]:
    """Every syllable of ONE reading that the rhyme could start on.

    The dictionary marks a trailing SECONDARY stress on a whole class of
    words — "tomorrow" is AH0 M AA1 R OW2, "shadow" is AE1 D OW2 — and
    reading the key off the last stressed vowel then starts it on the final
    "-ow", so "tomorrow"/"sorrow" and "shadow"/"window" came back as no rhyme
    at all.

    Offering only the last-stressed and last-PRIMARY-stressed syllables was
    not enough: "nobody" is N OW1 B AA2 D IY2, whose primary is the first
    syllable and whose last stress is the throwaway "-dy", so the "-body"
    reading that rhymes it perfectly with "somebody" was offered by neither
    and the pair came back an eye-rhyme. Every EARLIER stressed syllable is
    offered instead, and only when the default anchor is the artifact — a
    SECONDARY stress. That condition is the whole of it: a primary-stressed
    anchor is where the word really is stressed and needs no second opinion.

    Offering earlier readings unconditionally is wrong, and quietly so. A
    line ending is scored as a phrase too, and "in the garden" carries a
    primary on "gar-": let the rhyme start earlier and it starts on the
    schwa of "the", which matches the schwa of "of" in "full of velvet" and
    invents a rhyme between two lines that do not have one.
    """
    index = _key_syllable(pron)
    if index is None:
        return []
    syllables = syllabify(pron)
    picks = [index]
    if index < len(pron.stress) and pron.stress[index] == 2:
        for n in range(index - 1, -1, -1):
            if n < len(pron.stress) and pron.stress[n] in (1, 2):
                picks.append(n)
    return [
        _Rime(
            onset=syllables[n].onset,
            nucleus=syllables[n].nucleus,
            coda=syllables[n].coda,
            tail=tuple(syllables[n + 1 :]),
        )
        for n in picks
    ]


@lru_cache(maxsize=4096)
def _rime_candidates(pron: Pron) -> tuple[_Rime, ...]:
    """Every rime this word could plausibly be rhymed from.

    Both axes of "which sound did the singer actually make": which syllable
    the rhyme starts on (see ``_anchors``) and which of the dictionary's
    readings of the word is being sung (see ``Pron.variants``). Duplicates
    collapse — most alternates differ somewhere the rime never sees — so the
    cap is rarely reached.
    """
    out: list[_Rime] = []
    seen: set[_Rime] = set()
    for reading in (pron, *pron.variants):
        for rime in _anchors(reading):
            if rime in seen:
                continue
            seen.add(rime)
            out.append(rime)
            if len(out) >= _MAX_RIME_CANDIDATES:
                return tuple(out)
    return tuple(out)


def _syllable_distance(a: Syllable, b: Syllable) -> float:
    onset = _cluster_distance(a.onset, b.onset)
    if a.onset != b.onset:
        onset = min(1.0, _ONSET_STEP + (1.0 - _ONSET_STEP) * onset)
    nucleus = vowel_distance(a.nucleus, b.nucleus)
    if a.nucleus != b.nucleus:
        nucleus = min(1.0, _TAIL_VOWEL_STEP + (1.0 - _TAIL_VOWEL_STEP) * nucleus)
    distance = (
        _TAIL_ONSET * onset
        + _TAIL_NUCLEUS * nucleus
        + _TAIL_CODA * _coda_distance(a.coda, b.coda)
    )
    if (a.stress > 0) != (b.stress > 0):
        distance += _STRESS_MISMATCH
    return min(1.0, distance)


def _tail_distance(a: tuple[Syllable, ...], b: tuple[Syllable, ...]) -> float:
    """Whole SYLLABLES against whole syllables, never raw phones against phones.

    Aligning the phone arrays from the right (what this used to do) shifts
    every phone as soon as the two tails differ in length: "-SH AH N" against
    "-SH AH N S" compared N with S and AH with N and called two near
    identical endings unrelated. Syllable units keep each onset, nucleus and
    coda together, and the extra S is then one cheap insertion inside one
    syllable's coda.

    Both anchors are tried — from the stressed nucleus forward, and from the
    end of the word backwards — because an extra syllable can be inserted at
    either end: "si-LENCE" against "vi-o-LENCE" only lines up from the end.
    """
    width = max(len(a), len(b))
    if width == 0:
        return 0.0
    return min(_aligned(a, b, width), _aligned(a[::-1], b[::-1], width))


def _aligned(a: tuple[Syllable, ...], b: tuple[Syllable, ...], width: int) -> float:
    total = 0.0
    for i in range(width):
        if i < len(a) and i < len(b):
            total += _syllable_distance(a[i], b[i])
        else:
            total += _MISSING_SYLLABLE
    return total / width


def rhyme_score(a: Pron, b: Pron) -> RhymeScore | None:
    """Score how much of a rhyme two pronunciations make, 0..1.

    Each side may offer more than one reading of where its rhyme starts; the
    pair is scored on the best of them, which is what "degrade gracefully"
    means here — no reading is silently the only one tried.
    """
    best: RhymeScore | None = None
    for ra in _rime_candidates(a):
        for rb in _rime_candidates(b):
            scored = _score_rimes(ra, rb)
            if best is None or scored.score > best.score:
                best = scored
    return best


def _score_rimes(ra: _Rime, rb: _Rime) -> RhymeScore:
    nucleus = vowel_distance(ra.nucleus, rb.nucleus)
    coda = _coda_distance(ra.coda, rb.coda)
    tail = _tail_distance(ra.tail, rb.tail)
    # Coda and tail are one weighted mean, not two independent terms: a pair
    # with no tail at all ("air"/"death") lives or dies on its coda, while a
    # pair whose whole "-SH AH N" matches ("action"/"passion") is barely hurt
    # by one extra consonant under the stress. Two open stressed syllables
    # contribute no coda at all rather than a free perfect match, so
    # "nation"/"nature" is judged on the syllable that actually differs.
    width = max(len(ra.tail), len(rb.tail))
    coda_weight = 1.0 if (ra.coda or rb.coda) else 0.0
    span = coda_weight + width
    rime = (coda * coda_weight + tail * width) / span if span else 0.0
    score = (1.0 - nucleus) ** _NUCLEUS_EXPONENT * (1.0 - rime) ** _RIME_EXPONENT
    same_onset = ra.onset == rb.onset and bool(ra.onset)
    if same_onset:
        score *= _SAME_ONSET_FACTOR
    return RhymeScore(
        score=round(score, 4),
        nucleus=nucleus,
        coda=coda,
        tail=tail,
        same_onset=same_onset,
        syllables_a=ra.syllables,
        syllables_b=rb.syllables,
    )


def rhyme_nuclei(pron: Pron) -> tuple[str, ...]:
    """Every stressed vowel this word could be rhymed from."""
    return tuple(dict.fromkeys(r.nucleus for r in _rime_candidates(pron)))


def max_rhyme_score(a: Sequence[str], b: Sequence[str]) -> float:
    """The best score two words could reach given only their stressed vowels.

    Every other term in ``rhyme_score`` can only take the score down, so this
    is a sound upper bound — which is what makes it usable as the cheap gate
    in front of the pairwise passes without them ever dropping a pair the
    real comparison would have accepted. Both sides pass every nucleus they
    could rhyme from, because the real comparison tries all of them.
    """
    best = 0.0
    for na in a:
        for nb in b:
            if not na or not nb:
                continue
            best = max(best, (1.0 - vowel_distance(na, nb)) ** _NUCLEUS_EXPONENT)
    return best


def _guess_penalty(a: Pron, b: Pron) -> float:
    """Discount a rhyme whose phones were guessed rather than looked up.

    Only where a dictionary is actually installed. Without one every word in
    the song is a guess, and discounting all of them by the same factor
    ranks nothing differently — it just slides the whole distribution under
    the callers' confidence floors, which is what made a cmudict-less machine
    report a fraction of the rhymes a cmudict machine did.
    """
    if PRONUNCIATION_SOURCE != "cmudict":
        return 1.0
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


def _is_pararhyme(a: _Rime, b: _Rime) -> bool:
    """Owen's device: the same consonant FRAME with the vowel swapped out.

    Both ends have to be identical — "read"/"ride", "leaves"/"lives". The old
    test asked only for a shared onset and a shared tail, which every
    one-syllable pair with a matching coda satisfies, so "man"/"men" and
    "cat"/"cut" were labelled with a rare literary device instead of being
    called the plain slant rhymes they are. Those now score above
    ``SLANT_STRONG`` and never reach here.
    """
    if a.nucleus == b.nucleus:
        return False
    if not (a.onset or a.coda):
        return False
    return a.onset == b.onset and a.coda == b.coda and a.tail == b.tail


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

    scored = rhyme_score(a, b)
    if scored is None:
        return ("", 0.0)
    confidence = round(scored.score * penalty, 3)
    if scored.score >= _PERFECT_SCORE:
        # The keys differ only because the dictionary put the stress
        # somewhere this reading did not: nucleus, coda and tail all match.
        return ("end-rhyme", round(penalty, 3))
    if scored.score >= SLANT_STRONG:
        return ("slant-rhyme", confidence)

    # Below the scheme-making line a shared consonant frame is the more
    # specific claim, so pararhyme is read here and not before slant.
    ra, rb = _rime(a), _rime(b)
    if ra is not None and rb is not None and _is_pararhyme(ra, rb):
        return ("pararhyme", max(0.3, confidence))
    if scored.score >= SLANT_FLOOR:
        return ("slant-rhyme", confidence)

    # Nothing rhymes; the spelling might still promise it does.
    if wa and wb and _shared_tail_letters(wa, wb) >= 2:
        return ("eye-rhyme", round(0.3 * penalty, 3))
    return ("", 0.0)
