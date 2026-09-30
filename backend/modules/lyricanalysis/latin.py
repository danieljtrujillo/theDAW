"""Latin pronunciation by rule: syllables, vowel length, stress and phones.

Latin spelling is phonemic, so a Latin word is read, never looked up. This
module reads it the restored classical way: ``c`` and ``g`` are always hard,
``v`` is /w/, consonantal ``i``/``j`` is /j/, ``ae`` is /ai/, ``oe`` is /oi/,
``au`` is /au/, ``qu`` and ``ngu`` are one consonant each.

The phones are ARPABET, so every rhyme, assonance and consonance scorer in
``phonetics`` reads a Latin word with no change. A vowel's QUALITY comes from
its letter alone (``a e i o u y`` -> ``AA EH IY OW UW IY``). A macron changes
a vowel's LENGTH, and length decides where the stress falls; it never changes
which vowel a word rings on. So a text with macrons and the same text without
them rhyme and assonate identically, and differ only where the stress needed
a length the plain text does not show.

What the reader handles, because real Latin text contains it:

* **Length marks.** A macron (or a circumflex) is a long vowel, a breve a
  short one, a diaeresis (``poëta``, ``aër``) splits what would otherwise be a
  diphthong. An acute accent is the church books' STRESS mark (``Dóminus``,
  ``María``) and places the stress directly.
* **Stress.** The penultimate law: a word of three or more syllables is
  stressed on its penult when that syllable is heavy (a long vowel, a
  diphthong, or closed by a consonant), else on the antepenult. A stop
  followed by ``l`` or ``r`` does not close the syllable before it
  (``té-ne-brae``). ``x`` and ``z`` are two consonants; ``h`` is none.
* **Enclitics.** ``-que``, ``-ne`` and ``-ve`` pull the stress onto the
  syllable in front of them (``vi-rúm-que``, ``ar-má-que``).
* **i/j and u/v.** An ``i`` opening a word before a vowel is /j/ (``iam``),
  one between vowels is a doubled /jj/ (``maior``, ``Trōia``, ``cuius``); a
  ``u`` opening a word before a vowel, or between vowels, is /w/ (``uirum``,
  ``nouus``). ``j`` and ``v`` are always consonants.
* **Everything else a pasted text carries.** Capitals, punctuation, hyphens
  (``Ky-ri-e``, ``arma-que``), the ligatures ``æ``/``œ``, and inscriptional
  capitals where ``V`` is also the vowel ``u`` (``POPVLVSQVE``).

Without macrons the length of a vowel in an open penult is unknown. A
handful of endings whose penult is long in every word that carries them
(``-ārum``, ``-ātus``, ``-ōsus``, ``-ēbam`` ...) settle most of those; the
rest are stressed on the antepenult and the word is flagged ``guessed`` so
the analysis can say how many words would read better with their macrons.
"""

from __future__ import annotations

import unicodedata
from dataclasses import dataclass
from functools import lru_cache

from .phonetics import Pron

__all__ = [
    "CONTINUATIONS",
    "FUNCTION_WORDS",
    "LANGUAGE",
    "LatinSyllable",
    "LatinWord",
    "ONOMATOPOEIA",
    "ONOMATOPOEIA_WEAK",
    "has_length_marks",
    "is_latin",
    "is_onset",
    "marked_spelling",
    "pronounce",
    "read_word",
    "scan_line",
    "spell_vowel_u",
    "split_enclitic",
    "stems",
    "syllable_bounds",
    "verse_weights",
]

LANGUAGE = "la"

# Codes a document can carry for Latin: whisper's own, the ISO 639-2 one,
# and the plain name.
_CODES = frozenset({"la", "lat", "latin"})

_MACRON = "̄"
_CIRCUMFLEX = "̂"
_BREVE = "̆"
_ACUTE = "́"
_DIAERESIS = "̈"

_LIGATURES = {"æ": "ae", "œ": "oe"}
_VOWEL_LETTERS = frozenset("aeiouy")

# A vowel's quality, by letter. Length never enters it (see the module doc).
_VOWEL_PHONE = {"a": "AA", "e": "EH", "i": "IY", "o": "OW", "u": "UW", "y": "IY"}

_STOPS = frozenset({"P", "B", "T", "D", "K", "G", "F"})
_LIQUIDS = frozenset({"L", "R"})
# One consonant spelled with two letters: qu and ngu. (The su- of suāvis is
# not here: S W is also the -s ve of "plūs-ve", and only that split changes a
# syllable's weight.)
_GLIDE_ONSETS = frozenset({("K", "W"), ("G", "W")})


def is_latin(code: str | None) -> bool:
    """Is this document language code Latin?"""
    return str(code or "").strip().lower() in _CODES


def has_length_marks(text: str) -> bool:
    """Does the text mark vowel length anywhere (a macron, circumflex or
    breve)? A text that marks some lengths marks them all, so its unmarked
    vowels are short."""
    decomposed = unicodedata.normalize("NFD", text or "")
    return any(ch in (_MACRON, _CIRCUMFLEX, _BREVE) for ch in decomposed)


def is_onset(cluster: tuple[str, ...]) -> bool:
    """Can this consonant cluster open a Latin syllable after a vowel?

    One consonant can; so can a stop before ``l`` or ``r`` (muta cum liquida,
    which is why ``sa-crum`` and ``pa-trem`` keep their first syllable open)
    and the two-letter single consonants ``qu`` and ``gu``. Everything
    else splits: ``om-nis``, ``fe-nes-tra``, ``sax-um``, ``mai-ior``.
    ``tl``/``dl`` are not onsets (``At-las``).
    """
    if not cluster:
        return True
    if len(cluster) == 1:
        return cluster[0] != "NG"
    if len(cluster) == 2:
        first, second = cluster
        if (first, second) in _GLIDE_ONSETS:
            return True
        return (
            first in _STOPS
            and second in _LIQUIDS
            and (first, second) not in (("T", "L"), ("D", "L"))
        )
    return False


# ---------------------------------------------------------------------------
# Letters
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _Letter:
    ch: str  # a-z
    pos: int  # index into the raw word
    long: bool | None  # macron/circumflex True, breve False, unmarked None
    accent: bool  # acute: the stress mark
    split: bool  # diaeresis: never the second half of a diphthong
    lig: bool = False  # half of an æ/œ ligature: always one diphthong


def _letters(raw: str) -> list[_Letter]:
    """The word's letters with their marks, each pointing back into ``raw``.

    Capitals are folded, punctuation, digits, hyphens and apostrophes are
    dropped, ``æ``/``œ`` become two letters sharing one position. A mark typed
    as its own combining character (``a`` + U+0304) lands on the letter in
    front of it, the same as a precomposed ``ā``. A word in inscriptional
    capitals that has ``V`` and no ``U`` spells both sounds with ``V``, so its
    ``v`` letters are read as ``u`` and the u/v rules decide.
    """
    rows: list[dict] = []
    last_pos = -1
    for pos, ch in enumerate(raw or ""):
        decomposed = unicodedata.normalize("NFD", ch)
        if unicodedata.combining(decomposed[0]):
            for row in rows:
                if row["pos"] == last_pos:
                    _apply_marks(row, decomposed)
            continue
        base, marks = decomposed[:1], decomposed[1:]
        low = base.lower()
        bases = _LIGATURES.get(low, low)
        if not all("a" <= b <= "z" for b in bases):
            last_pos = -1
            continue
        for b in bases:
            row = {
                "ch": b,
                "pos": pos,
                "long": None,
                "accent": False,
                "split": False,
                "lig": len(bases) > 1,
            }
            _apply_marks(row, marks)
            rows.append(row)
        last_pos = pos
    letters = [c for c in raw or "" if c.isalpha()]
    capitals = bool(letters) and not any(c.islower() for c in letters)
    spelled = {row["ch"] for row in rows}
    if capitals and "v" in spelled and "u" not in spelled:
        for row in rows:
            if row["ch"] == "v":
                row["ch"] = "u"
    return [
        _Letter(
            ch=row["ch"],
            pos=row["pos"],
            long=row["long"] if row["ch"] in _VOWEL_LETTERS else None,
            accent=row["accent"] and row["ch"] in _VOWEL_LETTERS,
            split=row["split"],
            lig=row["lig"],
        )
        for row in rows
    ]


def _apply_marks(row: dict, marks: str) -> None:
    if _MACRON in marks or _CIRCUMFLEX in marks:
        row["long"] = True
    elif _BREVE in marks:
        row["long"] = False
    if _ACUTE in marks:
        row["accent"] = True
    if _DIAERESIS in marks:
        row["split"] = True


# ---------------------------------------------------------------------------
# Enclitics
# ---------------------------------------------------------------------------

# Words that end in -que without it being the enclitic "and", whose last
# syllable before -que is light, so the enclitic rule would move their stress.
_NOT_QUE = frozenset(
    """atque neque itaque undique utique denique quoque usque absque namque
    quisque quaeque quodque quidque quicque plerumque utrimque undique
    quandoque""".split()
)
# -ne and -ve hosts are recognised by their final consonant (the stress falls
# on the same syllable either way there) or by name when they end in a vowel.
_ENCLITIC_HOST_ENDS = frozenset("stmncd")
_NE_HOSTS = frozenset("ego tu tibi ita illa ille iste ista me te se tune".split())


def _enclitic(word: str) -> str:
    """The enclitic this word ends in, or ``""``."""
    if word.endswith("que") and len(word) > 4 and word not in _NOT_QUE:
        host = word[:-3]
        if any(c in _VOWEL_LETTERS for c in host):
            return "que"
    for enc in ("ne", "ve"):
        if not word.endswith(enc) or len(word) < 4:
            continue
        host = word[:-2]
        if not any(c in _VOWEL_LETTERS for c in host):
            continue
        if host[-1] in _ENCLITIC_HOST_ENDS or (enc == "ne" and host in _NE_HOSTS):
            return enc
    return ""


def split_enclitic(word: str) -> tuple[str, str]:
    """``(host, enclitic)`` for a normalised word: ``virumque`` ->
    ``("virum", "que")``; a word with no enclitic comes back whole."""
    enc = _enclitic(word)
    return (word[: -len(enc)], enc) if enc else (word, "")


# ---------------------------------------------------------------------------
# Segmentation: letters -> phone entries
# ---------------------------------------------------------------------------

_EU_WORDS = frozenset(
    """heu eheu seu neu ceu eu euge euhoe euoe orpheus theseus perseus nereus
    peleus atreus tydeus prometheus morpheus zeus idomeneus oeneus""".split()
)
_EU_PREFIXES = ("neut", "eur", "euph", "euch", "eucha", "euan")
_EI_WORDS = frozenset("hei dein deinde deinceps".split())
_UI_WORDS = frozenset("cui huic hui cuicumque".split())
_OE_HIATUS = ("poet", "poem", "coer", "coeg", "coem", "coex", "coet", "coeu", "noe")
_I_VOWEL_WORDS = frozenset("gaius gaia caius iambus iambi iambe ion".split())
_I_VOWEL_PREFIXES = ("iamb", "ionic", "ionia")
_J_PREFIXES = ("trans", "con", "sub", "dis", "ad", "ob", "ab", "in")
_SU_GLIDE = ("suad", "suav", "suasi", "suaso", "suesc", "suet")


@dataclass
class _Entry:
    phone: str
    vowel: bool
    first: int  # first letter index this entry spells
    last: int  # one past its last letter; == first for a phone with no letter
    long: bool | None = None
    accent: bool = False


def _vowel_letter(letters: list[_Letter], k: int) -> bool:
    return 0 <= k < len(letters) and letters[k].ch in _VOWEL_LETTERS


def _diphthong(word: str, letters: list[_Letter], k: int) -> str:
    """The diphthong starting at letter ``k``, or ``""``."""
    if k + 1 >= len(letters):
        return ""
    a, b = letters[k], letters[k + 1]
    pair = a.ch + b.ch
    if a.lig and b.lig and a.pos == b.pos:
        return pair
    if b.split or a.long is not None or b.long is not None:
        return ""
    host, _enc = split_enclitic(word)
    if pair == "ae":
        return pair
    if pair == "oe":
        return "" if word.startswith(_OE_HIATUS) else pair
    if pair == "au":
        # "pauor", "cauē": a vowel after it makes the u a consonant.
        return "" if _vowel_letter(letters, k + 2) else pair
    if pair == "eu":
        if host in _EU_WORDS or word.startswith(_EU_PREFIXES):
            return pair
        return ""
    if pair == "ei":
        return pair if host in _EI_WORDS else ""
    if pair == "ui":
        return pair if host in _UI_WORDS else ""
    return ""


def _consonantal_i(
    word: str, letters: list[_Letter], k: int, prev: _Entry | None
) -> int:
    """How many /j/ phones this ``i`` spells: 0 (it is a vowel), 1 or 2."""
    here = letters[k]
    if here.split or here.long is not None or here.accent:
        return 0
    if not _vowel_letter(letters, k + 1) or letters[k + 1].ch == "i":
        return 0
    if word in _I_VOWEL_WORDS or word.startswith(_I_VOWEL_PREFIXES):
        return 0
    if k == 0:
        return 1
    if prev is not None and prev.vowel:
        # Between vowels the /j/ is doubled: mai-ior, Trōi-iae, cui-ius.
        return 2
    for prefix in _J_PREFIXES:
        if k == len(prefix) and word.startswith(prefix):
            after = letters[k + 1].ch
            if after in "uao" or (
                after == "e" and k + 2 < len(letters) and letters[k + 2].ch == "c"
            ):
                return 0 if word.startswith(("abies", "abiet")) else 1
    return 0


def _consonantal_u(letters: list[_Letter], k: int, prev: _Entry | None) -> bool:
    here = letters[k]
    if here.split or here.long is not None or here.accent:
        return False
    if not _vowel_letter(letters, k + 1):
        return False
    if k == 0:
        return True
    return prev is not None and prev.vowel


def _segment(word: str, letters: list[_Letter]) -> list[_Entry]:
    out: list[_Entry] = []
    k = 0
    n = len(letters)

    def add(phone: str, first: int, last: int, vowel: bool = False, **kw) -> None:
        out.append(_Entry(phone, vowel, first, last, **kw))

    while k < n:
        c = letters[k].ch
        nxt = letters[k + 1].ch if k + 1 < n else ""
        prev = out[-1] if out else None
        if c == "q":
            if nxt == "u":
                add("K", k, k + 2)
                add("W", k + 2, k + 2)
                k += 2
            else:
                add("K", k, k + 1)
                k += 1
            continue
        if (
            c == "g"
            and nxt == "u"
            and k > 0
            and letters[k - 1].ch == "n"
            and _vowel_letter(letters, k + 2)
        ):
            add("G", k, k + 2)
            add("W", k + 2, k + 2)
            k += 2
            continue
        if c == "s" and nxt == "u" and _vowel_letter(letters, k + 2):
            rest = "".join(x.ch for x in letters[k:])
            if rest.startswith(_SU_GLIDE):
                add("S", k, k + 2)
                add("W", k + 2, k + 2)
                k += 2
                continue
        if nxt == "h" and c in "cptr":
            add({"c": "K", "p": "F", "t": "T", "r": "R"}[c], k, k + 2)
            k += 2
            continue
        if c == "x":
            add("K", k, k + 1)
            add("S", k + 1, k + 1)
            k += 1
            continue
        if c == "z":
            if out:
                add("D", k, k + 1)
                add("Z", k + 1, k + 1)
            else:
                add("Z", k, k + 1)
            k += 1
            continue
        if c == "j":
            if prev is not None and prev.vowel and _vowel_letter(letters, k + 1):
                add("Y", k, k + 1)
                add("Y", k + 1, k + 1)
            else:
                add("Y", k, k + 1)
            k += 1
            continue
        if c == "v":
            add("W", k, k + 1)
            k += 1
            continue
        if c == "i":
            glides = _consonantal_i(word, letters, k, prev)
            if glides:
                add("Y", k, k + 1)
                if glides == 2:
                    add("Y", k + 1, k + 1)
                k += 1
                continue
        if c == "u" and _consonantal_u(letters, k, prev):
            add("W", k, k + 1)
            k += 1
            continue
        if c in _VOWEL_LETTERS:
            pair = _diphthong(word, letters, k)
            accent = letters[k].accent or (bool(pair) and letters[k + 1].accent)
            if pair in ("ae", "oe", "au", "ei"):
                phone = {"ae": "AY", "oe": "OY", "au": "AW", "ei": "EY"}[pair]
                add(phone, k, k + 2, vowel=True, long=True, accent=accent)
                k += 2
                continue
            if pair == "eu":
                add("EH", k, k + 2, vowel=True, long=True, accent=accent)
                add("W", k + 2, k + 2)
                k += 2
                continue
            if pair == "ui":
                add("UW", k, k + 2, vowel=True, long=True, accent=accent)
                add("Y", k + 2, k + 2)
                k += 2
                continue
            add(
                _VOWEL_PHONE[c],
                k,
                k + 1,
                vowel=True,
                long=letters[k].long,
                accent=letters[k].accent,
            )
            k += 1
            continue
        add(
            {
                "b": "B",
                "c": "K",
                "d": "D",
                "f": "F",
                "g": "G",
                "h": "HH",
                "k": "K",
                "l": "L",
                "m": "M",
                "n": "N",
                "p": "P",
                "r": "R",
                "s": "S",
                "t": "T",
            }.get(c, c.upper()),
            k,
            k + 1,
        )
        k += 1
    return out


# ---------------------------------------------------------------------------
# Syllables and stress
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class LatinSyllable:
    phones: tuple[str, ...]
    nucleus: str
    # The letters this syllable spells, as indices into the word's letters.
    first: int
    last: int
    # True long, False short, None not marked and not knowable from the text.
    long: bool | None
    closed: bool

    @property
    def heavy(self) -> bool | None:
        """Heavy for the stress law: a long vowel, or closed by a consonant.
        ``None`` when an open syllable's vowel length is unknown."""
        if self.closed or self.long:
            return True
        return None if self.long is None else False


@dataclass(frozen=True)
class LatinWord:
    syllables: tuple[LatinSyllable, ...]
    stress: tuple[int, ...]
    enclitic: str
    # The stress rests on a vowel length the text does not show.
    guessed: bool
    letters: tuple[_Letter, ...] = ()


def _syllabify(entries: list[_Entry]) -> list[list[_Entry]]:
    vowels = [i for i, e in enumerate(entries) if e.vowel]
    if not vowels:
        return []
    out: list[list[_Entry]] = []
    start = 0
    for n, v in enumerate(vowels):
        if n + 1 == len(vowels):
            out.append(entries[start:])
            break
        between = entries[v + 1 : vowels[n + 1]]
        phones = tuple(e.phone for e in between)
        split = len(phones)
        while split > 0 and not is_onset(phones[len(phones) - split :]):
            split -= 1
        cut = v + 1 + len(phones) - split
        out.append(entries[start:cut])
        start = cut
    return out


# Endings whose penult vowel is long in every word that carries them. Only
# asked when the text marks no lengths at all and the penult is open.
_LONG_PENULT_ENDINGS = (
    "arum",
    "orum",
    "atus",
    "ata",
    "atum",
    "ati",
    "atae",
    "ato",
    "atos",
    "atas",
    "atam",
    "atis",
    "ate",
    "amus",
    "etis",
    "ete",
    "emus",
    "abam",
    "abas",
    "abat",
    "abo",
    "abis",
    "abit",
    "ebam",
    "ebas",
    "ebat",
    "ebo",
    "ebis",
    "ebit",
    "avi",
    "avit",
    "ivi",
    "ivit",
    "evi",
    "evit",
    "erunt",
    "are",
    "ari",
    "aris",
    "arem",
    "aret",
    "ire",
    "iri",
    "irem",
    "iret",
    "osus",
    "osa",
    "osum",
    "osi",
    "osae",
    "osis",
    "osam",
    "osos",
    "osas",
    "oso",
    "onis",
    "onem",
    "ones",
    "onum",
    "oni",
    "one",
    "toris",
    "torem",
    "tores",
    "tore",
    "tori",
    "soris",
    "sorem",
    "sores",
    "alis",
    "ale",
    "alem",
    "ales",
    "elis",
    "ele",
    "elem",
    "eles",
    "anus",
    "ana",
    "anum",
    "ani",
    "anae",
    "anos",
    "anas",
    "anis",
    "ano",
    "anam",
    "enus",
    "ena",
    "enum",
    "enae",
    "enos",
    "enas",
    "enam",
    "ivus",
    "iva",
    "ivum",
    "ivae",
    "ivos",
    "ivas",
    "ivo",
    "ura",
    "urus",
    "urum",
    "urae",
    "uri",
    "uro",
    "uram",
    "uras",
    "uros",
    "utus",
    "uta",
    "utum",
    "uti",
    "utae",
    "uto",
    "udo",
)
# Genitives in -īus and the fifth declension's -ēī break the rule that a vowel
# before a vowel is short.
_LONG_BEFORE_VOWEL = frozenset(
    "illius istius ipsius unius totius solius nullius ullius alterius utrius".split()
)


def _length(
    word: str, syllable: list[_Entry], following: list[_Entry] | None, macronized: bool
) -> bool | None:
    nucleus = next(e for e in syllable if e.vowel)
    if nucleus.long is not None:
        return nucleus.long
    if following is not None and following and following[0].vowel:
        # Vowel before vowel is short, with the listed exceptions.
        if word in _LONG_BEFORE_VOWEL or (
            word.endswith("iei") and following[0].phone == "IY"
        ):
            return True
        return False
    return False if macronized else None


def _closed(syllable: list[_Entry]) -> bool:
    seen_vowel = False
    for e in syllable:
        if e.vowel:
            seen_vowel = True
            continue
        if seen_vowel and e.phone != "HH":
            return True
    return False


def _word_from(
    word: str, letters: list[_Letter], entries: list[_Entry], macronized: bool
) -> LatinWord:
    groups = _syllabify(entries)
    syllables: list[LatinSyllable] = []
    for i, group in enumerate(groups):
        nucleus = next(e for e in group if e.vowel)
        following = groups[i + 1] if i + 1 < len(groups) else None
        spelled = [e for e in group if e.last > e.first]
        syllables.append(
            LatinSyllable(
                phones=tuple(e.phone for e in group),
                nucleus=nucleus.phone,
                first=spelled[0].first if spelled else nucleus.first,
                last=spelled[-1].last if spelled else nucleus.last,
                long=_length(word, group, following, macronized),
                closed=_closed(group),
            )
        )
    n = len(syllables)
    host, enclitic = split_enclitic(word)
    guessed = False
    accented = [i for i, g in enumerate(groups) if any(e.vowel and e.accent for e in g)]
    if n == 0:
        return LatinWord((), (), enclitic, False, tuple(letters))
    if accented:
        primary = accented[0]
    elif enclitic and n >= 2:
        primary = n - 2
    elif n <= 2:
        primary = 0
    else:
        heavy = syllables[n - 2].heavy
        if heavy is None:
            heavy = host.endswith(_LONG_PENULT_ENDINGS)
            guessed = True
        primary = n - 2 if heavy else n - 3
    stress = [0] * n
    stress[primary] = 1
    if primary >= 2:
        stress[primary - 2] = 2
    return LatinWord(tuple(syllables), tuple(stress), enclitic, guessed, tuple(letters))


@lru_cache(maxsize=8192)
def read_word(raw: str, macronized: bool = False) -> LatinWord:
    """Everything this module knows about one written word."""
    letters = _letters(raw)
    word = "".join(c.ch for c in letters)
    if not word:
        return LatinWord((), (), "", False, ())
    return _word_from(word, letters, _segment(word, letters), macronized)


def pronounce(raw: str, macronized: bool = False) -> Pron:
    """The word as a ``Pron``: ARPABET phones and one stress digit per
    syllable. Never raises. ``guessed`` is set only when the stress rests on a
    vowel length the text does not mark."""
    try:
        read = read_word(str(raw), bool(macronized))
    except Exception:  # noqa: BLE001 - a word we cannot read has no phones
        return Pron(phones=(), stress=(), guessed=False)
    phones = tuple(p for s in read.syllables for p in s.phones)
    return Pron(phones=phones, stress=read.stress, guessed=read.guessed)


def spell_vowel_u(raw: str) -> str:
    """A word in inscriptional capitals with its vowel ``V`` written ``U``:
    ``POPVLVSQVE`` -> ``POPULUSQUE``, ``VENI`` stays ``VENI``. Any other word
    comes back unchanged. For a reader (the aligner) that takes ``v`` as the
    consonant it is everywhere else."""
    letters = _letters(raw)
    if not any(c.ch == "u" and raw[c.pos] in "Vv" for c in letters):
        return raw
    word = "".join(c.ch for c in letters)
    # Only a V that is a consonant on its own stays a V; the vowel, and the
    # u of qu and ngu, are written U.
    consonants = {
        letters[e.first].pos
        for e in _segment(word, letters)
        if e.phone == "W" and e.last - e.first == 1 and letters[e.first].ch == "u"
    }
    out = list(raw)
    for c in letters:
        if c.ch == "u" and c.pos not in consonants and out[c.pos] in "Vv":
            out[c.pos] = "U" if out[c.pos] == "V" else "u"
    return "".join(out)


def syllable_bounds(raw: str, macronized: bool = False) -> tuple[tuple[int, int], ...]:
    """Character bounds of each syllable inside the written word, as a
    contiguous partition of ``raw`` (leading punctuation goes with the first
    syllable, trailing with the last), so a finding can paint exactly the
    syllable it is about: ``Gal|li|a``, ``in|trā|te,``."""
    read = read_word(str(raw), bool(macronized))
    if not read.syllables:
        return ()
    starts = [0]
    for syl in read.syllables[1:]:
        starts.append(read.letters[syl.first].pos)
    bounds: list[tuple[int, int]] = []
    for i, start in enumerate(starts):
        end = starts[i + 1] if i + 1 < len(starts) else len(raw)
        bounds.append((start, max(start, end)))
    return tuple(bounds)


# ---------------------------------------------------------------------------
# Word lists the device detectors read in place of their English ones
# ---------------------------------------------------------------------------
#
# Every word here is in the form ``phonetics.normalize_word`` gives it:
# lower-case, length marks stripped.

# Prepositions, conjunctions, the forms of "to be", the personal, relative
# and weak demonstrative pronouns: excluded from the internal rhyme and sound
# passes for the reason the English list is — "et / est / in" open or ring in
# every Latin line and mean nothing there. Line endings are never filtered.
FUNCTION_WORDS = frozenset(
    """a ab ac ad an at atque aut cum de dum e ea eam ego ei eis eius eo eos
    et etiam ex hac haec hanc hic hoc huic huius iam id in inter is me mihi
    ne nec neque nisi non nos nobis ob per pro quae quam quas qui quia quibus
    quid quis quo quod quos se sed si sibi sic sub sum sumus sunt es est esse
    erat erant fuit tam te tibi tu tum ubi ut vel vos vobis enim autem vero
    nam quoque""".split()
)

# A line that ends without punctuation and is followed by one of these runs
# on into it.
CONTINUATIONS = frozenset(
    """et ac atque sed aut vel nec neque ut cum quod qui quae quia quam si nisi
    dum donec postquam ubi ne quoniam quamquam etsi in ad per de ex ab sub pro
    inter ante post propter contra sine super""".split()
)

# Words that are only ever imitative, and words with an imitative sense
# beside an ordinary one (pitched lower, as the English weak list is).
ONOMATOPOEIA = frozenset(
    """taratantara bombus bombi bombo bombum tintinnabulum tintinnabula
    tintinnat tinnit tinniunt tinnitus susurrus susurri susurrat susurrant
    susurro murmur murmura murmurat murmurant ululat ululant ululatus ululare
    ululatu coax cuculus upupa hinnit hinnitus mugit mugitus mugiunt balat
    balatus grunnit sibilat sibilus sibila crepitat crepitus clangor
    clangorem stridor stridet strident stridunt pipilat pipat crocitat""".split()
)
ONOMATOPOEIA_WEAK = frozenset(
    """fragor fragorem rugit rugitus fremit fremitus fremunt gemit gemitus
    plausus plaudit tussis singultus mussat garrit latrat latratus sonat
    sonitus strepitus strepit tonat tonitrus tonitru""".split()
)

# Inflectional endings, for polyptoton: the same word in two cases or two
# persons ("homo / homini", "nomen / nominis", "saecula / saeculorum").
# Every ending that matches is stripped, not only the longest, because a
# third-declension stem changes under its endings (hom-o, hom-in-i).
_INFLECTIONS = tuple(
    sorted(
        set(
            """a ae am arum as is ibus um us i o os orum e em es ei ebus u ua ia
            ium ius inis ini inem ine ines inum inibus onis oni onem one ones
            onum oris ori orem ore ores atis ati atem ate ates atum at ant amus
            are avit abat abant et ent emus etis ere it unt imus itis nt t s m
            re ri ur ntur tur mur or en""".split()
        ),
        key=len,
        reverse=True,
    )
)


def stems(word: str) -> set[str]:
    """Candidate roots of a normalised Latin word, enclitic removed. Two words
    are one root in two forms when their sets intersect."""
    host, _enc = split_enclitic(word)
    if len(host) < 3:
        return set()
    out = {host}
    for ending in _INFLECTIONS:
        if host.endswith(ending) and len(host) - len(ending) >= 3:
            out.add(host[: -len(ending)])
    return out


def marked_spelling(raw: str) -> str:
    """The word as written, lower-case, with its length marks and nothing
    else: ``Mālum,`` -> ``mālum``. Two words with the same letters and
    different marks are two words ("malum" evil, "mālum" apple)."""
    out: list[str] = []
    for ch in unicodedata.normalize("NFD", raw or ""):
        if unicodedata.combining(ch):
            if ch in (_MACRON, _CIRCUMFLEX, _BREVE) and out:
                out.append(ch)
            continue
        low = ch.lower()
        for b in _LIGATURES.get(low, low):
            if "a" <= b <= "z":
                out.append(b)
    return unicodedata.normalize("NFC", "".join(out))


# ---------------------------------------------------------------------------
# Quantitative verse
# ---------------------------------------------------------------------------
#
# Classical Latin verse is built from syllable WEIGHT, not stress: "Arma
# virumque canō" is a dactylic hexameter because of which syllables are heavy,
# and its stresses fall wherever the words put them. Weight needs every vowel
# length, so a line is only scanned when the text marks its lengths.

_DACTYL = ("H", "L", "L")
_SPONDEE = ("H", "H")
# The last foot of a hexameter is written S whatever its last syllable is.
_FEET_NAME = {_DACTYL: "D", _SPONDEE: "S", ("H", "X"): "S"}
_MARK = {"H": "—", "L": "∪", "X": "×"}

# Each meter is a sequence of positions; each position lists the shapes it
# may take. "X" is a syllable of either weight (the line's last, and the
# aeolic base of the hendecasyllable).
_METERS: tuple[tuple[str, tuple[tuple[tuple[str, ...], ...], ...]], ...] = (
    (
        "dactylic hexameter",
        ((_DACTYL, _SPONDEE),) * 5 + ((("H", "X"),),),
    ),
    (
        "elegiac pentameter",
        (
            (_DACTYL, _SPONDEE),
            (_DACTYL, _SPONDEE),
            (("H",),),
            (_DACTYL,),
            (_DACTYL,),
            (("X",),),
        ),
    ),
    (
        "hendecasyllable",
        ((("X", "X", "H", "L", "L", "H", "L", "H", "L", "H", "X"),),),
    ),
    (
        "sapphic hendecasyllable",
        ((("H", "L", "H", "X", "H", "L", "L", "H", "L", "H", "X"),),),
    ),
)


def _onset_count(syl: LatinSyllable) -> tuple[int, bool]:
    """How many consonants open this syllable (``qu``/``gu`` one, ``h``
    none), and whether they are a stop before a liquid."""
    onset = syl.phones[: syl.phones.index(syl.nucleus)]
    phones = [p for p in onset if p != "HH"]
    count = len(phones)
    if tuple(phones[-2:]) in _GLIDE_ONSETS:
        count -= 1
    mcl = len(phones) == 2 and is_onset(tuple(phones)) and count == 2
    return count, mcl


def _coda(syl: LatinSyllable) -> tuple[str, ...]:
    at = syl.phones.index(syl.nucleus)
    return tuple(p for p in syl.phones[at + 1 :] if p != "HH")


def verse_weights(raws: list[str]) -> str:
    """One weight per sung syllable of a line: ``H`` heavy, ``L`` light, ``A``
    either (a short vowel before a stop and a liquid, and the line's last).

    Across word boundaries: a final vowel or ``-m`` before a vowel (or ``h``)
    is elided; a final consonant before a vowel joins that vowel's syllable
    (``ab ōrīs`` is ``a-bō-rīs``); a short final vowel before two consonants
    is heavy by position.
    """
    words = [read_word(r, True) for r in raws]
    words = [w for w in words if w.syllables]
    out: list[str] = []
    for i, word in enumerate(words):
        nxt = words[i + 1] if i + 1 < len(words) else None
        n_count, n_mcl = _onset_count(nxt.syllables[0]) if nxt else (0, False)
        vowel_next = nxt is not None and n_count == 0
        n = len(word.syllables)
        for k, syl in enumerate(word.syllables):
            coda = _coda(syl)
            if k < n - 1:
                if syl.long or coda:
                    out.append("H")
                else:
                    count, mcl = _onset_count(word.syllables[k + 1])
                    out.append("A" if mcl else "L")
                continue
            if nxt is None:
                out.append("A")
            elif vowel_next and (not coda or coda == ("M",)):
                continue  # elided
            elif vowel_next:
                out.append("H" if syl.long or len(coda) > 1 else "L")
            elif syl.long or coda:
                out.append("H")
            elif n_count >= 2:
                out.append("A" if n_mcl else "H")
            else:
                out.append("L")
    return "".join(out)


def _fits(weight: str, want: str) -> bool:
    return want == "X" or weight == "A" or weight == want


def _match(
    weights: str, positions: tuple[tuple[tuple[str, ...], ...], ...]
) -> list[tuple[str, ...]] | None:
    if not positions:
        return [] if not weights else None
    for shape in positions[0]:
        if len(shape) > len(weights):
            continue
        if all(_fits(w, s) for w, s in zip(weights, shape)):
            rest = _match(weights[len(shape) :], positions[1:])
            if rest is not None:
                return [shape, *rest]
    return None


def scan_line(raws: list[str]) -> tuple[str, str] | None:
    """``(meter, scansion)`` when a line with marked vowel lengths is a
    classical meter: ``("dactylic hexameter", "DDSSDS  — ∪ ∪ | ...")``."""
    weights = verse_weights(raws)
    if len(weights) < 10:
        return None
    for name, positions in _METERS:
        feet = _match(weights, positions)
        if feet is None:
            continue
        names = "".join(_FEET_NAME.get(f, "") for f in feet)
        marks = " | ".join(" ".join(_MARK.get(w, w) for w in f) for f in feet)
        return name, f"{names}  {marks}".strip()
    return None
