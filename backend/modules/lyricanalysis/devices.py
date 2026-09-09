"""Deterministic literary-device detectors over a timed lyrics document.

Pure functions, no I/O: ``analyse(doc)`` walks a ``LyricsDoc`` once and returns
every device the words themselves can prove — rhyme, sound, repetition and
structure. The interpretive ``meaning`` family is never produced here; that is
the optional LLM pass's job.

Everything is anchored in ``LyricsDoc`` coordinates (``line``/``word`` indices
into ``doc.lines[line].words``) so the SING tab can paint a finding onto the
same spans the karaoke already highlights, without re-tokenising anything.

Two rules run through the whole module:

* **Determinism.** No randomness, no ``id()``, no clock. A device's id is a
  digest of its kind, its detail and its span coordinates, so the same lyric
  always produces the same ids and the frontend can use them as React keys.
* **Cost.** A song is thousands of words, and everything phonetic is pairwise.
  Every pairwise pass is bounded by a line or by a small line window, and the
  matches that can be found by grouping (rhyme classes, multisyllabic tails,
  alliteration, refrains) are found with a dict, not a loop over pairs.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field

from ..lyrics.schema import LyricsDoc
from .phonetics import (
    ARPABET_VOWELS,
    Pron,
    Syllable,
    classify_rhyme,
    max_rhyme_score,
    normalize_word,
    pronounce,
    pronounce_phrase,
    rhyme_key,
    rhyme_nuclei,
    stress_pattern,
    syllabify,
    tail_key,
)
from .schema import (
    FAMILY_OF,
    AnalysisStats,
    Device,
    LineMetrics,
    SectionSummary,
    Span,
)

# --- tuning ----------------------------------------------------------------
#
# Every number here is a noise/cost trade-off, not a fact about poetry. They
# are constants rather than literals so a future "sensitivity" setting has one
# place to turn.

# A mid-line word is compared with the mid-line words of the next 2 lyric
# lines. Two is enough for the couplet-and-a-half shapes rappers actually use;
# three starts matching across a whole verse and the findings stop meaning
# anything.
CROSS_LINE_WINDOW = 2
# Inside a line, a word is compared with the next 12 words (plus the line's own
# ending, always, for leonine rhyme). That keeps a pathologically long line
# linear instead of quadratic.
INTERNAL_WORD_WINDOW = 12
# Two alliterating words may sit at most 3 apart (2 words between them).
ALLITERATION_GAP = 3
# Assonance and consonance tolerate one more word of distance: the vowel colour
# of a line survives a longer gap than a hard initial consonant does.
ASSONANCE_GAP = 4
CONSONANCE_GAP = 4
# Consonance is everywhere in English, so it needs three carriers to count.
CONSONANCE_MIN = 3
# A multisyllabic run is at most 4 words long and its tail at most 4 syllables;
# beyond that the key is so specific it only ever matches itself.
MULTI_RUN_WORDS = 4
MULTI_MAX_SYLLABLES = 4
# Two halves of a multisyllabic rhyme must be within 8 lines of each other.
MULTI_LINE_WINDOW = 8
# Sibilance/plosive density is measured over a sliding window of 6 words.
DENSITY_WINDOW = 6
SIBILANCE_MIN_COUNT = 4
SIBILANCE_MIN_RATIO = 0.18
PLOSIVE_MIN_COUNT = 5
PLOSIVE_MIN_RATIO = 0.22
# Pararhyme and eye rhyme are scheme claims, so they are only looked for
# between line endings, within 3 lines of each other.
ENDING_PAIR_WINDOW = 3
# Polyptoton pairs must be within 4 lyric lines to read as deliberate.
POLYPTOTON_LINE_WINDOW = 4

# A line ending is compared as a RUN of final words, not only as its last
# word: sung lines rhyme on phrases ("hold on" / "cold dawn", "meant it" /
# "spent it") and on the word before a trailing ad-lib ("...on my way, yeah").
END_RUN_WORDS = 3
END_RUN_SYLLABLES = 5
# A longer run has to beat the plain last word by this much to be preferred,
# so an ordinary end rhyme is never relabelled as a phrase.
END_RUN_MARGIN = 0.08
# Trailing words a line does not really end on. Everything here is either an
# ad-lib or a particle that carries no stress of its own, and a lyric sheet is
# full of them; the rhyme is on the word in front.
_TRAILING_FILLER = frozenset(
    """oh ooh ooo woah whoa yeah yea ah aah uh huh hey ay yo na nah la mm mmm
    hmm now though again y'all babe baby man girl boy love ya""".split()
)

# Confidence floors, per kind, for the pairwise passes. A perfect match always
# passes; the near misses have to earn it.
MIN_SCHEME_CONF = 0.5
MIN_INTERNAL_CONF = 0.6
MIN_CROSS_LINE_CONF = 0.8
_MIN_CONF = {"slant-rhyme": 0.5, "pararhyme": 0.3, "eye-rhyme": 0.3}

# classify_rhyme kinds that put two line endings in the same scheme class.
# Pararhyme and eye rhyme are real devices but they do not make an "A".
_SCHEME_KINDS = frozenset({"end-rhyme", "slant-rhyme", "identical-rhyme"})

_VOWEL_LETTERS = frozenset("aeiouy")
# Letter pairs that spell a single consonant phone, for painting an onset.
_ONSET_DIGRAPHS = frozenset(
    {"sh", "ch", "th", "ph", "wh", "kn", "wr", "gn", "qu", "ps"}
)
_SIBILANTS = frozenset({"S", "Z", "SH", "ZH", "CH", "JH"})
_PLOSIVES = frozenset({"P", "B", "T", "D", "K", "G"})

# Function words are excluded from the *internal* phonetic passes only. Line
# endings are never filtered — "you"/"do" at the ends of two lines is a rhyme,
# but the same pair mid-line fires on almost every rap bar and means nothing.
_NOISE_WORDS = frozenset(
    """a an the of to and in it is on at as or if be am are was were do does did
    my me you your his her its our their that this these those with for from by
    we he she they us him them not no so up out but who what when then than
    there here""".split()
)

# Words that carry a sentence on past a line break, so a line ending without
# punctuation before one of these is enjambed rather than end-stopped.
_CONTINUATIONS = frozenset(
    """and but or nor yet so for to of in on at by with from into onto through
    that which who whom whose when while where as like than till until unless
    because though although if before after upon over under across around
    against about""".split()
)

# Terminal punctuation. A comma counts: it is a syntactic break, and treating
# it as one keeps enjambment meaning "the sentence runs on" rather than "the
# line has no full stop".
_END_STOP = frozenset(".?!;:,…")
# Marks strong enough to be a caesura when they land inside the line.
_CAESURA_MARKS = ("—", "–", "...", "…", ";", ":", ",", ".", "!", "?")
_TRAILING_TRIM = "\"'’”)]}»"

# Named feet, longest first so a three-syllable foot is preferred over a
# coincidental two-syllable reading of the same line.
_FEET = (
    ("anapest", "001"),
    ("dactyl", "100"),
    ("iamb", "01"),
    ("trochee", "10"),
    ("spondee", "11"),
)
_FOOT_ADJECTIVE = {
    "anapest": "anapestic",
    "dactyl": "dactylic",
    "iamb": "iambic",
    "trochee": "trochaic",
    "spondee": "spondaic",
}
_METER_LENGTHS = {
    3: "trimeter",
    4: "tetrameter",
    5: "pentameter",
    6: "hexameter",
    7: "heptameter",
    8: "octameter",
}

# Onomatopoeia is a lexicon, not a computation. Split in two: words that are
# only ever imitative, and words with a common non-imitative sense ("pop",
# "crack") that get a lower confidence so the UI's floor slider can drop them.
_ONOMATOPOEIA = frozenset(
    """achoo baa bam bang beep blip bloop boing bonk boom brrr bzz cackle caw
    cheep chime chirp chomp chug clang clank clatter click clink clip-clop
    clunk cock-a-doodle-doo conk crackle creak croak crunch cuckoo ding
    ding-dong dong fizz flutter gargle giggle glug gong grunt gurgle hiccup
    hiss honk hoo howl hum jangle jingle kaboom kapow kerplunk meow moo mumble
    murmur neigh oink patter peep phew ping pitter plink plop plunk pow psst
    puff purr quack rattle ribbit rumble rustle screech shh shush sizzle slosh
    slurp splash splat splutter sputter squawk squeak squeal squelch squish
    swish swoosh thud thump thwack tick ticktock tinkle toot tweet twang
    ululate vroom wham whimper whir whirr whish whoosh whomp woof yelp yowl
    zap zing zoom""".split()
)
_ONOMATOPOEIA_WEAK = frozenset(
    """bark bash boo buzz chatter clap clash cough crack crash cry drip gasp
    groan growl gulp knock moan pant pop rap rip roar scream shriek sigh slam
    slap smack snap sniff snore stutter tap thunder wail whack whine whisper
    whistle zip""".split()
)

# Suffixes the conservative stemmer will strip, longest first.
_SUFFIXES = (
    "ness",
    "ment",
    "ings",
    "ing",
    "ies",
    "ied",
    "est",
    "ers",
    "ful",
    "ly",
    "ed",
    "er",
    "es",
    "'s",
    "s",
)


# --- token and line records ------------------------------------------------


@dataclass(frozen=True)
class _Tok:
    """One word of one line, with everything phonetic already resolved."""

    line: int
    index: int
    raw: str
    norm: str
    pron: Pron
    syls: tuple[Syllable, ...]
    # Character bounds of each syllable inside ``raw``, so a device that covers
    # part of a word can be painted without splitting the karaoke word.
    bounds: tuple[tuple[int, int], ...]
    # ``rhyme_key`` of this word, resolved once: every pairwise pass asks for
    # it, and the vowels it could start on are what gate those passes.
    rkey: str
    nuclei: tuple[str, ...]

    @property
    def key_nucleus(self) -> str:
        return self.rkey.partition(" ")[0]

    @property
    def nsyl(self) -> int:
        return len(self.syls)

    @property
    def phones(self) -> tuple[str, ...]:
        return self.pron.phones


@dataclass
class _Line:
    index: int
    kind: str
    text: str
    toks: list[_Tok]
    # A lyric line with words we can anchor a span to. A line whose ``words``
    # list is empty still gets metrics, but no device may point at it — the
    # indices would be out of range and the UI would paint nothing.
    anchored: bool
    is_lyric: bool
    section: str
    section_idx: int
    # Normalised word sequence + the original word index of each entry, for the
    # repetition passes (which compare words, not sounds).
    seq: list[str] = field(default_factory=list)
    seq_idx: list[int] = field(default_factory=list)


@dataclass
class _Sect:
    name: str
    start_line: int
    end_line: int
    lyric_lines: list[int] = field(default_factory=list)


@dataclass(frozen=True)
class _Ending:
    """How a line ends, and every run of final words it could rhyme on.

    A lyric line rhymes on a phrase at least as often as on a word — "hold
    on" / "cold dawn", "meant it" / "spent it" — and a lyric sheet ends line
    after line on an ad-lib the singer throws away. Comparing only the last
    token reported the throwaway as the rhyme, or reported nothing.
    """

    line: int
    tok: _Tok
    runs: tuple[tuple[tuple[_Tok, ...], Pron], ...]
    # The line ends on a word it does not really end on. Such an ending may
    # never be classed on its last word alone: four lines that all end
    # "..., yeah" share that word without sharing a rhyme.
    throwaway: bool = False


@dataclass
class _RhymeClass:
    section_idx: int
    letter: str
    members: list[_Ending] = field(default_factory=list)


@dataclass
class _Run:
    """A run of consecutive words considered as one phone stream."""

    line: int
    start: int
    end: int  # inclusive
    toks: tuple[_Tok, ...]
    syllables: int


# --- small helpers ---------------------------------------------------------


def _monotonic(starts: list[int], limit: int) -> list[int]:
    out: list[int] = []
    prev = -1
    for s in starts:
        s = max(min(int(s), limit), prev + 1)
        out.append(s)
        prev = s
    return out


def syllable_char_bounds(raw: str, count: int) -> tuple[tuple[int, int], ...]:
    """Character bounds of each syllable inside a written word.

    Orthography and phonology do not line up, so this is an approximation and
    is only ever used to paint part of a word. When the word's vowel-letter
    groups agree with the phonetic syllable count we split just before each
    group (giving one consonant to the following onset, the way "fa-thom"
    reads); otherwise the letters are divided evenly.
    """
    if count <= 0 or not raw:
        return ()
    if count == 1:
        return ((0, len(raw)),)
    groups: list[tuple[int, int]] = []
    i = 0
    while i < len(raw):
        # A word-initial "y" is a consonant ("yellow"), anywhere else a vowel.
        if raw[i].lower() in _VOWEL_LETTERS and not (i == 0 and raw[i].lower() == "y"):
            j = i
            while j < len(raw) and raw[j].lower() in _VOWEL_LETTERS:
                j += 1
            groups.append((i, j))
            i = j
        else:
            i += 1
    if len(groups) == count:
        starts = [0]
        for g in groups[1:]:
            s = g[0]
            if s - 1 > starts[-1]:
                s -= 1
            starts.append(s)
    else:
        step = len(raw) / count
        starts = [int(round(k * step)) for k in range(count)]
    starts = _monotonic(starts, len(raw))
    bounds: list[tuple[int, int]] = []
    for k in range(count):
        start = starts[k]
        end = starts[k + 1] if k + 1 < count else len(raw)
        bounds.append((start, max(start, end)))
    return tuple(bounds)


def _token(line: int, index: int, raw: str, pron: Pron | None = None) -> _Tok:
    norm = normalize_word(raw)
    # The word AS WRITTEN, not the normalised token: the apostrophe of
    # "runnin'" is what tells the phonetics it is the -ing word.
    p = pronounce(raw) if pron is None else pron
    syls = tuple(syllabify(p))
    return _Tok(
        line=line,
        index=index,
        raw=raw,
        norm=norm,
        pron=p,
        syls=syls,
        bounds=syllable_char_bounds(raw, len(syls)),
        rkey=rhyme_key(p),
        nuclei=rhyme_nuclei(p),
    )


def _word_end(raw: str) -> int | None:
    """Where the word proper ends, or ``None`` when it ends where it ends.

    A painted rhyme should not include the comma after it, and the karaoke
    word carries its punctuation, so spans stop at the last real character.
    """
    k = len(raw)
    while k > 0 and not (raw[k - 1].isalnum() or raw[k - 1] in "'’"):
        k -= 1
    return None if k in (0, len(raw)) else k


def _span(
    tok: _Tok, char_start: int = 0, char_end: int | None = None, *, whole: bool = False
) -> Span:
    end = char_end
    if end is None and not whole:
        end = _word_end(tok.raw)
    text = tok.raw[char_start : len(tok.raw) if end is None else end]
    return Span(
        line=tok.line,
        word=tok.index,
        char_start=char_start,
        char_end=end,
        text=text,
    )


def _rhyme_span(tok: _Tok, key: str) -> Span:
    """Paint only the rhyming tail when the key covers part of the word."""
    covered = sum(1 for p in key.split() if p in ARPABET_VOWELS)
    n = tok.nsyl
    if 0 < covered < n and len(tok.bounds) == n:
        return _span(tok, char_start=tok.bounds[n - covered][0])
    return _span(tok)


def _label(kind: str, parts: list[str]) -> str:
    name = kind.replace("-", " ")
    return f"{name}: {' / '.join(parts)}" if parts else name


def _letter(i: int) -> str:
    """0 -> A, 25 -> Z, 26 -> AA. Long songs do run past 26 classes."""
    out = ""
    n = i
    while True:
        out = chr(ord("A") + (n % 26)) + out
        n = n // 26 - 1
        if n < 0:
            break
    return out


def _pair_key(a: _Tok, b: _Tok) -> tuple[tuple[int, int], tuple[int, int]]:
    left = (a.line, a.index)
    right = (b.line, b.index)
    return (left, right) if left <= right else (right, left)


def _rhymeable(tok: _Tok, *, internal: bool) -> bool:
    if not tok.phones or tok.nsyl < 1 or len(tok.norm) < 2:
        return False
    return not (internal and tok.norm in _NOISE_WORDS)


def _might_rhyme(a: _Tok, b: _Tok) -> bool:
    """Cheap gate in front of ``classify_rhyme`` for the pairwise passes.

    ``max_rhyme_score`` is the best score two words could reach given only
    their stressed vowels, and every other term in the real comparison can
    only take that score down — so a pair below the floor here cannot clear
    the floor there, and skipping it is free. That soundness is the whole
    point: an ad-hoc gate on "the last syllable" drops slant rhymes like
    "given"/"livin'" that the end-of-line pass then reports anyway, and the
    two passes disagree with each other.
    """
    return max_rhyme_score(a.nuclei, b.nuclei) >= MIN_INTERNAL_CONF


class _Out:
    """Collects devices and hands out stable ids."""

    def __init__(self) -> None:
        self.devices: list[Device] = []
        self._ids: set[str] = set()

    def add(
        self,
        kind: str,
        spans: list[Span],
        *,
        label: str = "",
        detail: str = "",
        phones: tuple[str, ...] | list[str] = (),
        confidence: float = 1.0,
        group: str = "",
    ) -> Device | None:
        if not spans:
            return None
        raw = "|".join(
            [kind, detail]
            + [f"{s.line}:{s.word}:{s.char_start}:{s.char_end}" for s in spans]
        )
        did = (
            f"{kind}-{hashlib.blake2s(raw.encode('utf-8'), digest_size=5).hexdigest()}"
        )
        if did in self._ids:
            n = 2
            while f"{did}-{n}" in self._ids:
                n += 1
            did = f"{did}-{n}"
        self._ids.add(did)
        dev = Device(
            id=did,
            kind=kind,
            family=FAMILY_OF[kind],
            label=label or _label(kind, [s.text for s in spans]),
            group=group,
            spans=spans,
            detail=detail,
            phones=list(phones),
            confidence=round(float(confidence), 3),
            source="rules",
        )
        self.devices.append(dev)
        return dev


# --- preparation -----------------------------------------------------------


def _prepare(doc: LyricsDoc) -> tuple[list[_Line], list[_Sect]]:
    lines: list[_Line] = []
    sects: list[_Sect] = []
    cur: _Sect | None = None
    for i, ln in enumerate(getattr(doc, "lines", None) or []):
        text = ln.text or ""
        is_marker = ln.kind == "marker"
        if is_marker:
            name = text.strip().strip("[](){}").strip()
            cur = _Sect(name=name, start_line=i, end_line=i)
            sects.append(cur)
        elif cur is None:
            # Everything before the first marker is one unnamed section.
            cur = _Sect(name="", start_line=i, end_line=i)
            sects.append(cur)
        cur.end_line = i
        words = list(ln.words or [])
        anchored = bool(words)
        # A marker is never sung, so it is never pronounced either. A lyric
        # line with no ``words`` still gets metrics off its text, but nothing
        # may anchor a span to it — the indices would not exist.
        raws = (
            [] if is_marker else ([w.text for w in words] if anchored else text.split())
        )
        toks = [_token(i, j, raw) for j, raw in enumerate(raws)]
        is_lyric = not is_marker and bool(text.strip()) and bool(toks)
        line = _Line(
            index=i,
            kind=ln.kind,
            text=text,
            toks=toks,
            anchored=anchored and not is_marker,
            is_lyric=is_lyric,
            section=cur.name,
            section_idx=len(sects) - 1,
        )
        for t in toks:
            if t.norm:
                line.seq.append(t.norm)
                line.seq_idx.append(t.index)
        lines.append(line)
        if is_lyric:
            cur.lyric_lines.append(i)
    return lines, sects


def _line_ending(line: _Line) -> _Tok | None:
    """The last word of the line that has a pronunciation at all."""
    for t in reversed(line.toks):
        if t.phones:
            return t
    return None


def _final_words(line: _Line) -> list[_Tok]:
    """The line's trailing run of pronounceable words, in order."""
    toks = line.toks
    end = len(toks) - 1
    while end >= 0 and not toks[end].phones:
        end -= 1
    if end < 0:
        return []
    start = end
    while start > 0 and toks[start - 1].phones:
        start -= 1
    return toks[start : end + 1]


def _is_throwaway(tok: _Tok) -> bool:
    """A word a line does not really end on: an ad-lib or an unstressed particle.

    One predicate, because two places have to agree about it. ``_ending``
    uses it to offer the word in front as an ending of its own, and
    ``_match_endings`` uses it to refuse to call two lines rhymed just
    because they end on the same one.
    """
    return tok.norm in _TRAILING_FILLER or (tok.nsyl == 1 and tok.norm in _NOISE_WORDS)


def _runs_ending_at(
    words: list[_Tok], stop: int
) -> list[tuple[tuple[_Tok, ...], Pron]]:
    out: list[tuple[tuple[_Tok, ...], Pron]] = []
    for k in range(1, min(END_RUN_WORDS, stop + 1) + 1):
        toks = tuple(words[stop + 1 - k : stop + 1])
        if sum(t.nsyl for t in toks) > END_RUN_SYLLABLES:
            break
        pron = toks[0].pron if k == 1 else pronounce_phrase([t.raw for t in toks])
        if pron.phones:
            out.append((toks, pron))
    return out


def _ending(line: _Line) -> _Ending | None:
    words = _final_words(line)
    if not words:
        return None
    runs = _runs_ending_at(words, len(words) - 1)
    last = words[-1]
    # "...on my way, yeah": the line does not really end on the ad-lib, so the
    # word in front is offered as an ending of its own.
    throwaway = len(words) > 1 and _is_throwaway(last)
    if throwaway:
        runs.extend(_runs_ending_at(words, len(words) - 2))
    if not runs:
        return None
    return _Ending(line=line.index, tok=last, runs=tuple(runs), throwaway=throwaway)


def _run_words(toks: tuple[_Tok, ...]) -> str:
    return " ".join(t.norm for t in toks)


def _match_endings(a: _Ending, b: _Ending) -> tuple[str, float, list[_Tok], list[_Tok]]:
    """Best rhyme between two line endings, over their runs of final words.

    The plain last word is the baseline and a longer or shifted run only wins
    by ``END_RUN_MARGIN``, so a rhyme that is already there is never restated
    as a phrase — the halves the UI paints stay the words a reader would
    point at.
    """
    base_a, base_b = a.runs[0], b.runs[0]
    kind, conf = classify_rhyme(
        base_a[1], base_b[1], word_a=base_a[0][0].norm, word_b=base_b[0][0].norm
    )
    best = (kind, conf, list(base_a[0]), list(base_b[0]))
    # Two lines ending on the same throwaway word ("...meant it" / "...spent
    # it", "..., yeah" / "..., yeah") are not rhyming on it; they are saying
    # it twice. A longer run then only has to be a real rhyme to win, instead
    # of having to beat a 1.0 it can never beat. Testing only _NOISE_WORDS
    # here let every ad-lib through: "yeah" and "now" are _TRAILING_FILLER,
    # so four unrhymed lines that all ended ", yeah" came back as "AAAA".
    weak = kind == "identical-rhyme" and _is_throwaway(base_a[0][-1])
    # The two kinds of throwaway part company here. An unstressed particle is
    # still part of the line ("...meant it" DOES end on "it", and the rhyme is
    # the phrase). An ad-lib is not: the line ends on the word in front of it,
    # so every run that still carries the ad-lib rhymes on the ad-lib and on
    # nothing else — "garden yeah" against "velvet yeah" is a perfect 1.0 that
    # means only that both singers said "yeah".
    shared = base_a[0][-1].norm if weak else ""
    drop_shared = bool(shared) and shared in _TRAILING_FILLER
    if weak:
        # The shared throwaway is not an answer, it is the absence of one.
        # Leaving it as the fallback meant two lines that shared an ad-lib and
        # nothing else still came back "identical-rhyme, 1.0" whenever no
        # longer run rhymed — which is every pair of unrhymed lines that ends
        # ", yeah". If no real run wins below, these endings do not rhyme.
        best = ("", 0.0, list(base_a[0]), list(base_b[0]))
    floor = MIN_SCHEME_CONF if weak else conf + END_RUN_MARGIN
    if floor > 1.0:
        # No run could clear the margin, so there is nothing to look for —
        # and this is the common case, an ordinary end rhyme.
        return best
    ceiling = 0.0 if weak else conf
    for toks_a, pron_a in a.runs:
        for toks_b, pron_b in b.runs:
            if toks_a is base_a[0] and toks_b is base_b[0]:
                continue
            if drop_shared and toks_a[-1].norm == shared and toks_b[-1].norm == shared:
                continue
            # A single-word run is NOT skipped under ``weak``: when the
            # throwaway is an ad-lib the real ending is the single word in
            # front of it ("...in the garden, yeah" ends on "garden"), and
            # skipping it by length was what stopped those words from ever
            # being compared. The baseline pair itself is already excluded
            # above, and a run that loses simply fails the floor.
            # Growing the run on ONE side only, when both still end on the
            # same word, adds a consonant to one rime and matches nothing:
            # "it" against "spent it" scores a perfect rhyme and means
            # nothing at all.
            if len(toks_a) != len(toks_b) and toks_a[-1].norm == toks_b[-1].norm:
                continue
            words_a, words_b = _run_words(toks_a), _run_words(toks_b)
            # The same phrase again is a refrain, and the repetition passes
            # own it.
            if len(toks_a) > 1 and words_a == words_b:
                continue
            other, score = classify_rhyme(
                pron_a, pron_b, word_a=words_a, word_b=words_b
            )
            if not other or score < floor or score <= ceiling:
                continue
            ceiling = score
            best = (other, score, list(toks_a), list(toks_b))
    return best


# --- rhyme -----------------------------------------------------------------


def _rhyme_classes(lines: list[_Line], sects: list[_Sect]) -> list[_RhymeClass]:
    """Group line endings into scheme classes, one letter run per section.

    Letters restart at A in every section so a chorus reads "ABAB" whatever the
    verse before it did. Exact keys are found with a dict; only a line whose key
    is new is compared against the section's class representatives, so this is
    linear in lines times classes-in-this-section, not lines squared.
    """
    classes: list[_RhymeClass] = []
    for si, sect in enumerate(sects):
        section_classes: list[_RhymeClass] = []
        by_key: dict[str, _RhymeClass] = {}
        for idx in sect.lyric_lines:
            line = lines[idx]
            if not line.anchored:
                continue
            ending = _ending(line)
            if ending is None:
                continue
            # The exact-key shortcut says "same last word, same class" without
            # consulting _match_endings at all — which is right for a real
            # repeated ending and wrong for a throwaway one, where the shared
            # word is exactly what does NOT make the rhyme. Those endings take
            # the slow path so the ad-lib logic in _match_endings can run.
            key = "" if ending.throwaway else ending.tok.rkey
            cls = by_key.get(key) if key else None
            if cls is None:
                for cand in section_classes:
                    # Against the class's first member AND its most recent one:
                    # a rhyme chain drifts ("pieces" / "seasons" / "meaning" /
                    # "dreaming"), and testing only the representative dropped
                    # the far end of every chain out of its own scheme letter.
                    against = [cand.members[0]]
                    if cand.members[-1] is not cand.members[0]:
                        against.append(cand.members[-1])
                    for member in against:
                        kind, conf, _ta, _tb = _match_endings(member, ending)
                        if kind in _SCHEME_KINDS and conf >= MIN_SCHEME_CONF:
                            cls = cand
                            break
                    if cls is not None:
                        break
            if cls is None:
                cls = _RhymeClass(section_idx=si, letter="")
                section_classes.append(cls)
            if key and key not in by_key:
                by_key[key] = cls
            cls.members.append(ending)
        # Letters go to the classes that actually rhyme, in order of first
        # appearance; a line that rhymes with nothing keeps an empty letter.
        n = 0
        for cls in section_classes:
            if len(cls.members) >= 2:
                cls.letter = _letter(n)
                n += 1
        classes.extend(section_classes)
    return classes


def _class_group(cls: _RhymeClass) -> str:
    return f"rhyme-s{cls.section_idx}-{cls.letter or 'x'}"


def _positional_kind(a: _Tok, b: _Tok, ends: dict[int, int]) -> str:
    """Where the two rhyming words sit, which is what names the device.

    Precedence between kinds is resolved by the caller: a pair is claimed by
    the most specific detector that can see it, in this order —
    multisyllabic-rhyme, identical-rhyme, then these positional kinds, then
    pararhyme, then eye-rhyme. Every claimed pair goes into ``used`` and no
    later detector may report it again.
    """
    a_end = ends.get(a.line) == a.index
    b_end = ends.get(b.line) == b.index
    if a_end and b_end:
        return "end-rhyme"
    if a.line == b.line:
        return "leonine-rhyme" if (a_end or b_end) else "internal-rhyme"
    return "cross-line-rhyme"


def _tail_rhyme_key(syls: tuple[Syllable, ...], n: int) -> str:
    """The rhyming part of the last ``n`` syllables: from their first vowel on.

    ``tail_key`` gives the whole tail *including* the onset the tail starts
    with — and that onset is precisely what has to DIFFER for two runs to
    rhyme rather than repeat. So the bucket key drops it, and ``tail_key`` is
    then used to check that the onsets really are different.
    """
    tail = syls[-n:]
    parts: list[str] = [tail[0].nucleus, *tail[0].coda]
    for syl in tail[1:]:
        parts.extend(syl.onset)
        parts.append(syl.nucleus)
        parts.extend(syl.coda)
    return " ".join(parts)


def _tail_covered(run: _Run, n: int) -> list[tuple[_Tok, int]]:
    """The words of a run's ``n``-syllable tail, with how much of each is in it."""
    remaining = n
    covered: list[tuple[_Tok, int]] = []
    for tok in reversed(run.toks):
        if remaining <= 0:
            break
        if tok.nsyl == 0:
            continue
        take = min(remaining, tok.nsyl)
        covered.append((tok, take))
        remaining -= take
    covered.reverse()
    return covered


def _emit_multisyllabic(
    lines: list[_Line],
    out: _Out,
    used: set,
    ending_group: dict[int, str],
    ends: dict[int, int],
) -> None:
    """Rhymes matched over a run of words, not word for word.

    "hard to fathom" / "cardboard patterns" only rhymes if the run is treated
    as one phone stream, so the unit here is a window of up to
    ``MULTI_RUN_WORDS`` consecutive words and the match is made by keying that
    stream's tail in a dict — never by comparing runs pairwise.
    """
    buckets: dict[tuple[int, str], list[tuple[_Run, str]]] = {}
    for line in lines:
        if not line.is_lyric or not line.anchored:
            continue
        toks = line.toks
        for start in range(len(toks)):
            phones: list[str] = []
            stress: list[int] = []
            run: list[_Tok] = []
            nsyl = 0
            for k in range(start, min(start + MULTI_RUN_WORDS, len(toks))):
                t = toks[k]
                if not t.phones:
                    break
                phones.extend(t.phones)
                stress.extend(t.pron.stress)
                run.append(t)
                nsyl += t.nsyl
                if nsyl < 2:
                    continue
                pron = Pron(
                    phones=tuple(phones),
                    stress=tuple(stress),
                    guessed=any(w.pron.guessed for w in run),
                )
                syls = tuple(syllabify(pron))
                record = _Run(
                    line=line.index,
                    start=start,
                    end=k,
                    toks=tuple(run),
                    syllables=nsyl,
                )
                for n in range(2, min(len(syls), MULTI_MAX_SYLLABLES) + 1):
                    # A rhyme starts ON a stressed vowel; that is what makes it
                    # audible as a rhyme instead of as a shared ending. Without
                    # this, "counting up the" matches "looking up the" on
                    # "-ing up the" — one unstressed suffix and two words that
                    # are simply repeated — and half the multisyllabic findings
                    # in an ordinary lyric are that shape.
                    if syls[-n].stress <= 0:
                        continue
                    key = _tail_rhyme_key(syls, n)
                    if key:
                        buckets.setdefault((n, key), []).append(
                            (record, tail_key(pron, n))
                        )
    # Longest tail first, so the most specific claim on a pair wins.
    for (n, key), runs in sorted(buckets.items(), key=lambda kv: -kv[0][0]):
        if len(runs) < 2:
            continue
        runs = sorted(runs, key=lambda r: (r[0].line, r[0].end, r[0].start))
        # Not `zip(runs, runs[1:])`: a run is generated at every start offset,
        # so a same-line pair is separated in this order by the overlapping
        # variants of its own right-hand run ("elevation" | "elevation, hiding
        # the medication" | "hiding the medication"). Pairing only neighbours
        # made the overlap guard below reject every pair in turn, and an
        # internal multisyllabic rhyme — the whole point of the device in a rap
        # line — was never reported at all. Each left run now scans forward to
        # its first non-overlapping partner; `used` keeps the claim to one.
        for i, (left, ltail) in enumerate(runs):
            for right, rtail in runs[i + 1 :]:
                if right.line - left.line > MULTI_LINE_WINDOW:
                    break
                if left.line == right.line and right.start <= left.end:
                    continue
                left_cov = _tail_covered(left, n)
                right_cov = _tail_covered(right, n)
                if not left_cov or not right_cov:
                    continue
                # The same words again are a repeat, not a rhyme — and it is the
                # matched TAIL that has to differ, not the run that carries it.
                if [t.norm for t, _ in left_cov] == [t.norm for t, _ in right_cov]:
                    continue
                pair = _pair_key(left_cov[-1][0], right_cov[-1][0])
                if pair in used:
                    continue
                # The whole tail is claimed, not just its last word, so the
                # word-for-word passes cannot report the same rhyme again.
                for la, _ in left_cov:
                    for rb, _ in right_cov:
                        used.add(_pair_key(la, rb))
                spans = _tail_spans(left_cov) + _tail_spans(right_cov)
                # When both halves land on line endings of the same scheme class,
                # the UI should colour them as that class, not as a one-off pair.
                ga = ending_group.get(left.line, "")
                at_ends = (
                    ends.get(left.line) == left.end
                    and ends.get(right.line) == right.end
                )
                if ga and at_ends and ending_group.get(right.line, "") == ga:
                    group = ga
                else:
                    digest = hashlib.blake2s(str(pair).encode(), digest_size=4)
                    group = f"multi-{digest.hexdigest()}"
                guessed = any(t.pron.guessed for t, _ in left_cov + right_cov)
                # Identical tails including the onset are a repeat of the same
                # sound rather than a rhyme against it; still worth showing, but
                # not at full confidence.
                conf = 0.85 if ltail == rtail else 1.0
                if guessed:
                    conf -= 0.15
                out.add(
                    "multisyllabic-rhyme",
                    spans,
                    label=_label(
                        "multisyllabic-rhyme",
                        [
                            " ".join(t.raw for t, _ in left_cov),
                            " ".join(t.raw for t, _ in right_cov),
                        ],
                    ),
                    detail=f"{n} syllables: {key}",
                    phones=key.split(),
                    confidence=conf,
                    group=group,
                )
                # One claim per left run; the rest of the bucket keeps scanning.
                break


def _tail_spans(covered: list[tuple[_Tok, int]]) -> list[Span]:
    """Spans for a tail's words.

    The first word of a tail is often only half in it ("card-BOARD PATTERNS"),
    which is exactly what ``char_start`` is for.
    """
    spans: list[Span] = []
    for tok, take in covered:
        if take < tok.nsyl and len(tok.bounds) == tok.nsyl:
            spans.append(_span(tok, char_start=tok.bounds[tok.nsyl - take][0]))
        else:
            spans.append(_span(tok))
    return spans


def _run_spans(toks: list[_Tok], key: str) -> list[Span]:
    """Paint a matched ending: the rhyming tail of one word, or a whole run."""
    if len(toks) == 1:
        return [_rhyme_span(toks[0], key)]
    return [_span(t) for t in toks]


def _emit_end_rhymes(classes: list[_RhymeClass], out: _Out, used: set) -> None:
    for cls in classes:
        if len(cls.members) < 2:
            continue
        group = _class_group(cls)
        rep = cls.members[0]
        for a, b in zip(cls.members, cls.members[1:]):
            kind, conf, toks_a, toks_b = _match_endings(a, b)
            if kind not in _SCHEME_KINDS:
                # This member joined the class through the representative
                # rather than through its neighbour; pair it with what it
                # actually matched, so the reported halves really do rhyme.
                kind, conf, toks_a, toks_b = _match_endings(rep, b)
                if kind not in _SCHEME_KINDS:
                    continue
            pair = _pair_key(toks_a[-1], toks_b[-1])
            if pair in used:
                continue
            for ta in toks_a:
                for tb in toks_b:
                    used.add(_pair_key(ta, tb))
            key = toks_b[-1].rkey
            detail = f"{cls.letter}: {key}" if key else cls.letter
            out.add(
                kind,
                _run_spans(toks_a, toks_a[-1].rkey) + _run_spans(toks_b, key),
                label=_label(
                    kind,
                    [
                        " ".join(t.raw for t in toks_a),
                        " ".join(t.raw for t in toks_b),
                    ],
                ),
                detail=detail,
                phones=key.split(),
                confidence=conf,
                group=group,
            )


def _emit_ending_pairs(
    lines: list[_Line], sects: list[_Sect], out: _Out, used: set
) -> None:
    """Pararhyme and eye rhyme between line endings.

    Both are scheme-level claims — "read"/"ride", "love"/"move" — and looking
    for them mid-line produces nothing but noise, so they are only checked
    between endings within ``ENDING_PAIR_WINDOW`` lines of each other.
    """
    for sect in sects:
        endings: list[_Tok] = []
        for idx in sect.lyric_lines:
            line = lines[idx]
            if not line.anchored:
                continue
            tok = _line_ending(line)
            if tok is not None:
                endings.append(tok)
        for i, a in enumerate(endings):
            for b in endings[i + 1 : i + 1 + ENDING_PAIR_WINDOW]:
                pair = _pair_key(a, b)
                if pair in used:
                    continue
                kind, conf = classify_rhyme(
                    a.pron, b.pron, word_a=a.norm, word_b=b.norm
                )
                if kind not in ("pararhyme", "eye-rhyme"):
                    continue
                if conf < _MIN_CONF.get(kind, 0.0):
                    continue
                used.add(pair)
                out.add(
                    kind,
                    [_span(a), _span(b)],
                    label=_label(kind, [a.raw, b.raw]),
                    detail=" ".join(b.phones),
                    phones=list(b.phones),
                    confidence=conf,
                    group=f"{kind}-{a.line}-{b.line}",
                )


def _emit_internal_rhymes(
    lines: list[_Line], out: _Out, used: set, ends: dict[int, int]
) -> None:
    """Internal and leonine rhyme, inside one line."""
    for line in lines:
        if not line.is_lyric or not line.anchored:
            continue
        toks = line.toks
        n = len(toks)
        for i in range(n):
            a = toks[i]
            if not _rhymeable(a, internal=True):
                continue
            # The window keeps a very long line linear; the line's own ending
            # is always compared so leonine rhyme is never missed.
            targets = list(range(i + 1, min(i + 1 + INTERNAL_WORD_WINDOW, n)))
            if n - 1 not in targets and n - 1 > i:
                targets.append(n - 1)
            for j in targets:
                b = toks[j]
                if not _rhymeable(b, internal=True) or not _might_rhyme(a, b):
                    continue
                pair = _pair_key(a, b)
                if pair in used:
                    continue
                kind, conf = classify_rhyme(
                    a.pron, b.pron, word_a=a.norm, word_b=b.norm
                )
                if kind == "identical-rhyme" and a.norm == b.norm:
                    # A repeated word inside a line is epizeuxis/repetition,
                    # not a rhyme the reader hears as one.
                    continue
                if kind in ("end-rhyme", "slant-rhyme"):
                    if conf < MIN_INTERNAL_CONF:
                        continue
                    kind = _positional_kind(a, b, ends)
                elif kind == "identical-rhyme":
                    pass
                else:
                    continue
                used.add(pair)
                key = b.rkey
                out.add(
                    kind,
                    [_rhyme_span(a, a.rkey), _rhyme_span(b, key)],
                    label=_label(kind, [a.raw, b.raw]),
                    detail=key,
                    phones=key.split(),
                    confidence=conf,
                    group=f"internal-{a.line}-{a.index}-{b.index}",
                )


def _emit_cross_line_rhymes(
    lines: list[_Line], out: _Out, used: set, ends: dict[int, int]
) -> None:
    """A mid-line word rhyming with a mid-line word a line or two away.

    Bounded by CROSS_LINE_WINDOW (2 lyric lines) and by the confidence floor,
    which is higher here than inside a line: across lines the ear needs the
    match to be clean for it to land at all.
    """
    lyric = [ln for ln in lines if ln.is_lyric and ln.anchored]

    def _mids(ln: _Line) -> list[_Tok]:
        # "mid-line" means "not the word the line rhymes on", which is not the
        # same as "not the last token": a line ending in a dash or an ellipsis
        # carries its ending one token earlier, and pairing those here would
        # report an end rhyme under the cross-line pass's name and colour.
        end = ends.get(ln.index)
        return [t for t in ln.toks if t.index != end and _rhymeable(t, internal=True)]

    for i, line in enumerate(lyric):
        mids = _mids(line)
        if not mids:
            continue
        for other in lyric[i + 1 : i + 1 + CROSS_LINE_WINDOW]:
            for b in _mids(other):
                for a in mids:
                    if not _might_rhyme(a, b):
                        continue
                    pair = _pair_key(a, b)
                    if pair in used:
                        continue
                    kind, conf = classify_rhyme(
                        a.pron, b.pron, word_a=a.norm, word_b=b.norm
                    )
                    if kind not in ("end-rhyme", "slant-rhyme"):
                        continue
                    if conf < MIN_CROSS_LINE_CONF:
                        continue
                    used.add(pair)
                    key = b.rkey
                    named = _positional_kind(a, b, ends)
                    out.add(
                        named,
                        [_rhyme_span(a, a.rkey), _rhyme_span(b, key)],
                        label=_label(named, [a.raw, b.raw]),
                        detail=key,
                        phones=key.split(),
                        confidence=conf,
                        group=f"cross-{a.line}-{a.index}-{b.line}-{b.index}",
                    )


# --- sound -----------------------------------------------------------------


def _initial_consonant(tok: _Tok) -> str:
    if not tok.phones:
        return ""
    first = tok.phones[0]
    return "" if first in ARPABET_VOWELS else first


def _stressed_syllable(tok: _Tok) -> int:
    """Index of the syllable the ear actually lands on.

    Primary before secondary, because a word can carry its secondary stress
    FIRST — "celebration" is 2-0-1-0 and "understand" is 2-0-1 — and taking
    the first non-zero would group them under "ce" and "un" instead of the
    "-ra-" and "-stand" a listener hears.
    """
    for want in (1, 2):
        for k, syl in enumerate(tok.syls):
            if syl.stress == want:
                return k
    return 0


def _stressed_vowel(tok: _Tok) -> str:
    return tok.syls[_stressed_syllable(tok)].nucleus if tok.syls else ""


def _chain(positions: list[int], gap: int) -> list[list[int]]:
    """Split sorted positions into runs where neighbours are within ``gap``."""
    runs: list[list[int]] = []
    cur: list[int] = []
    for p in positions:
        if cur and p - cur[-1] > gap:
            if len(cur) >= 2:
                runs.append(cur)
            cur = []
        cur.append(p)
    if len(cur) >= 2:
        runs.append(cur)
    return runs


def _onset_bounds(raw: str) -> tuple[int, int]:
    """Where the letters spelling the *first* consonant phone sit in ``raw``.

    Pasted lyrics open words with quotes and brackets — ``"Silent``, ``'Cause``,
    ``(sing)`` — and the phones are read from the word inside them, so the paint
    has to start at the first real character or it marks the punctuation
    instead of the sound. Two letters for the digraphs that spell one phone
    ("sh", "kn"), one otherwise: "string" alliterates on S, not on "str".
    """
    start = 0
    while start < len(raw) and not raw[start].isalnum():
        start += 1
    if start >= len(raw):
        return (0, min(1, len(raw)))
    wide = raw[start : start + 2].lower() in _ONSET_DIGRAPHS and len(raw) - start > 2
    return (start, start + (2 if wide else 1))


def _onset_span(tok: _Tok) -> Span:
    start, end = _onset_bounds(tok.raw)
    return _span(tok, start, end)


def _alliterating_phone(tok: _Tok) -> str:
    """The initial consonant a word can alliterate ON, or ``""``.

    Function words are excluded here for the same reason they are excluded
    from assonance and consonance: "the / that / there / the" opens on DH in
    every other English line and reporting it buries the findings that mean
    something.
    """
    return "" if tok.norm in _NOISE_WORDS else _initial_consonant(tok)


def _emit_alliteration(lines: list[_Line], out: _Out) -> None:
    for line in lines:
        if not line.is_lyric or not line.anchored:
            continue
        by_phone: dict[str, list[int]] = {}
        for j, tok in enumerate(line.toks):
            phone = _alliterating_phone(tok)
            if phone:
                by_phone.setdefault(phone, []).append(j)
        for phone, positions in sorted(by_phone.items()):
            for run in _chain(positions, ALLITERATION_GAP):
                toks = [line.toks[j] for j in run]
                # The same word again is repetition, not alliteration.
                if len({t.norm for t in toks}) < 2:
                    continue
                out.add(
                    "alliteration",
                    [_onset_span(t) for t in toks],
                    label=_label("alliteration", [t.raw for t in toks]),
                    detail=phone,
                    phones=[phone],
                    group=f"allit-{line.index}-{phone}-{run[0]}",
                )
    # The same consonant opening consecutive lines is alliteration across the
    # break, which the per-line pass above cannot see.
    lyric = [ln for ln in lines if ln.is_lyric and ln.anchored and ln.toks]
    i = 0
    while i < len(lyric) - 1:
        phone = _alliterating_phone(lyric[i].toks[0])
        if not phone:
            i += 1
            continue
        j = i
        while j + 1 < len(lyric) and _alliterating_phone(lyric[j + 1].toks[0]) == phone:
            j += 1
        openers = [ln.toks[0] for ln in lyric[i : j + 1]]
        if j > i and len({t.norm for t in openers}) >= 2:
            spans = [_onset_span(t) for t in openers]
            out.add(
                "alliteration",
                spans,
                label=_label("alliteration", [t.raw for t in openers]),
                detail=f"{phone} (line openings)",
                phones=[phone],
                confidence=0.8,
                group=f"allit-open-{lyric[i].index}-{phone}",
            )
            i = j + 1
        else:
            i += 1


def _emit_assonance(lines: list[_Line], out: _Out, used: set) -> None:
    for line in lines:
        if not line.is_lyric or not line.anchored:
            continue
        by_vowel: dict[str, list[int]] = {}
        for j, tok in enumerate(line.toks):
            if tok.norm in _NOISE_WORDS:
                continue
            vowel = _stressed_vowel(tok)
            if vowel:
                by_vowel.setdefault(vowel, []).append(j)
        for vowel, positions in sorted(by_vowel.items()):
            for run in _chain(positions, ASSONANCE_GAP):
                toks = [line.toks[j] for j in run]
                # A bare pair that the rhyme pass already reported is that
                # rhyme, not a separate finding. Longer runs stand on their own.
                if len(toks) == 2 and _pair_key(toks[0], toks[1]) in used:
                    continue
                spans = [_vowel_span(t) for t in toks]
                out.add(
                    "assonance",
                    spans,
                    label=_label("assonance", [t.raw for t in toks]),
                    detail=vowel,
                    phones=[vowel],
                    group=f"asso-{line.index}-{vowel}-{run[0]}",
                )


def _vowel_span(tok: _Tok) -> Span:
    """Paint the stressed syllable when we can locate it, else the word.

    Same syllable ``_stressed_vowel`` grouped the word by, so the paint and
    the reported vowel can never disagree.
    """
    if tok.nsyl > 1 and len(tok.bounds) == tok.nsyl:
        start, end = tok.bounds[_stressed_syllable(tok)]
        return _span(tok, char_start=start, char_end=end)
    return _span(tok)


def _emit_consonance(lines: list[_Line], out: _Out) -> None:
    for line in lines:
        if not line.is_lyric or not line.anchored:
            continue
        by_phone: dict[str, list[int]] = {}
        for j, tok in enumerate(line.toks):
            if tok.norm in _NOISE_WORDS:
                continue
            # Away from the word's start: an initial consonant is alliteration.
            for phone in dict.fromkeys(tok.phones[1:]):
                if phone not in ARPABET_VOWELS:
                    by_phone.setdefault(phone, []).append(j)
        for phone, positions in sorted(by_phone.items()):
            for run in _chain(positions, CONSONANCE_GAP):
                if len(run) < CONSONANCE_MIN:
                    continue
                toks = [line.toks[j] for j in run]
                out.add(
                    "consonance",
                    [_span(t) for t in toks],
                    label=_label("consonance", [t.raw for t in toks]),
                    detail=phone,
                    phones=[phone],
                    confidence=0.8,
                    group=f"cons-{line.index}-{phone}-{run[0]}",
                )


def _emit_density(
    lines: list[_Line],
    out: _Out,
    kind: str,
    wanted: frozenset[str],
    min_count: int,
    min_ratio: float,
) -> None:
    """Sibilance and plosives: a density claim, not a pairwise one.

    Both consonant groups are common enough that any two occurrences mean
    nothing, so what fires is a window of DENSITY_WINDOW words in which the
    group is both frequent (``min_count`` phones) and dense (``min_ratio`` of
    every phone in the window). One device per line, at the best window.
    """
    for line in lines:
        if not line.is_lyric or not line.anchored:
            continue
        toks = line.toks
        best: tuple[float, int, list[_Tok]] | None = None
        limit = max(1, len(toks) - DENSITY_WINDOW + 1)
        for start in range(limit):
            chunk = toks[start : start + DENSITY_WINDOW]
            total = sum(len(t.phones) for t in chunk)
            if total < 6:
                continue
            count = sum(1 for t in chunk for p in t.phones if p in wanted)
            ratio = count / total
            if count < min_count or ratio < min_ratio:
                continue
            carriers = [t for t in chunk if any(p in wanted for p in t.phones)]
            if best is None or ratio > best[0]:
                best = (ratio, count, carriers)
        if best is None:
            continue
        ratio, count, carriers = best
        out.add(
            kind,
            [_span(t) for t in carriers],
            label=_label(kind, [t.raw for t in carriers]),
            detail=f"{count} phones, {round(ratio * 100)}% of the window",
            phones=sorted({p for t in carriers for p in t.phones if p in wanted}),
            confidence=min(1.0, 0.6 + ratio),
            group=f"{kind}-{line.index}",
        )


def _collapse(word: str, keep: int) -> str:
    out: list[str] = []
    run = 0
    prev = ""
    for ch in word:
        if ch == prev:
            run += 1
        else:
            run = 1
            prev = ch
        if run <= keep:
            out.append(ch)
    return "".join(out)


def _emit_onomatopoeia(lines: list[_Line], out: _Out) -> None:
    for line in lines:
        if not line.is_lyric or not line.anchored:
            continue
        for tok in line.toks:
            # "boooom" and "buzzz" are the same words with the letter held.
            forms = (tok.norm, _collapse(tok.norm, 2), _collapse(tok.norm, 1))
            hit = next((f for f in forms if f in _ONOMATOPOEIA), "")
            conf = 1.0
            if not hit:
                hit = next((f for f in forms if f in _ONOMATOPOEIA_WEAK), "")
                conf = 0.7
            if not hit:
                continue
            out.add(
                "onomatopoeia",
                [_span(tok)],
                label=_label("onomatopoeia", [tok.raw]),
                detail=hit,
                phones=list(tok.phones),
                confidence=conf,
                group=f"onom-{hit}",
            )


# --- repetition ------------------------------------------------------------


def _lcp(a: list[str], b: list[str]) -> int:
    n = 0
    for x, y in zip(a, b):
        if x != y:
            break
        n += 1
    return n


def _lcs(a: list[str], b: list[str]) -> int:
    """Length of the longest common *suffix*."""
    n = 0
    for x, y in zip(reversed(a), reversed(b)):
        if x != y:
            break
        n += 1
    return n


def _runs_of_shared_edge(lyric: list[_Line], edge: str) -> list[tuple[int, int, int]]:
    """Maximal runs of consecutive lyric lines sharing an opening or closing.

    Returns ``(first, last, words)`` as indices into ``lyric``. Longest match
    wins: the run grows while every line in it still shares at least one word,
    and the reported width is the shared prefix/suffix across the whole run.
    """
    measure = _lcp if edge == "start" else _lcs
    runs: list[tuple[int, int, int]] = []
    i = 0
    while i < len(lyric) - 1:
        width = measure(lyric[i].seq, lyric[i + 1].seq)
        if width == 0:
            i += 1
            continue
        j = i + 1
        while j + 1 < len(lyric):
            nxt = min(width, measure(lyric[i].seq, lyric[j + 1].seq))
            if nxt == 0:
                break
            width = nxt
            j += 1
        runs.append((i, j, width))
        i = j
    return runs


def _edge_spans(lyric: list[_Line], first: int, last: int, width: int, edge: str):
    spans: list[Span] = []
    words: list[str] = []
    for k in range(first, last + 1):
        line = lyric[k]
        picks = line.seq_idx[:width] if edge == "start" else line.seq_idx[-width:]
        for wi in picks:
            spans.append(_span(line.toks[wi]))
        chosen = line.seq[:width] if edge == "start" else line.seq[-width:]
        words = list(chosen)
    return spans, words


def _emit_repetition_edges(lyric: list[_Line], out: _Out) -> None:
    starts = _runs_of_shared_edge(lyric, "start")
    ends = _runs_of_shared_edge(lyric, "end")
    end_ranges = {(f, last): w for f, last, w in ends}
    for first, last, width in starts:
        both = end_ranges.get((first, last))
        # Symploce is the same lines doing both at once; when the two runs
        # cover different line ranges they stay two separate devices.
        if both:
            spans, opening = _edge_spans(lyric, first, last, width, "start")
            tail_spans, closing = _edge_spans(lyric, first, last, both, "end")
            out.add(
                "symploce",
                spans + tail_spans,
                label=_label(
                    "symploce", [" ".join(opening) + " … " + " ".join(closing)]
                ),
                detail=f"{last - first + 1} lines",
                confidence=1.0,
                group=f"symploce-{lyric[first].index}",
            )
            continue
        spans, opening = _edge_spans(lyric, first, last, width, "start")
        out.add(
            "anaphora",
            spans,
            label=_label("anaphora", [" ".join(opening)]),
            detail=f"{last - first + 1} lines",
            confidence=_edge_confidence(last - first + 1, width),
            group=f"anaphora-{lyric[first].index}",
        )
    for first, last, width in ends:
        if (first, last) in {(f, stop) for f, stop, _ in starts}:
            continue
        spans, closing = _edge_spans(lyric, first, last, width, "end")
        out.add(
            "epistrophe",
            spans,
            label=_label("epistrophe", [" ".join(closing)]),
            detail=f"{last - first + 1} lines",
            confidence=_edge_confidence(last - first + 1, width),
            group=f"epistrophe-{lyric[first].index}",
        )


def _edge_confidence(lines: int, width: int) -> float:
    """Two lines sharing one word is weak; three lines or two words is not."""
    if lines >= 3 or width >= 2:
        return 1.0
    return 0.6


def _emit_anadiplosis(lyric: list[_Line], out: _Out) -> None:
    for a, b in zip(lyric, lyric[1:]):
        if not a.seq or not b.seq or a.seq[-1] != b.seq[0]:
            continue
        if len(a.seq[-1]) < 2:
            continue
        out.add(
            "anadiplosis",
            [_span(a.toks[a.seq_idx[-1]]), _span(b.toks[b.seq_idx[0]])],
            label=_label("anadiplosis", [a.seq[-1]]),
            detail=a.seq[-1],
            group=f"anadip-{a.index}",
        )


def _emit_epizeuxis(lyric: list[_Line], out: _Out) -> None:
    for line in lyric:
        i = 0
        while i < len(line.seq) - 1:
            j = i
            while j + 1 < len(line.seq) and line.seq[j + 1] == line.seq[i]:
                j += 1
            if j > i and len(line.seq[i]) >= 1:
                toks = [line.toks[w] for w in line.seq_idx[i : j + 1]]
                out.add(
                    "epizeuxis",
                    [_span(t) for t in toks],
                    label=_label("epizeuxis", [line.seq[i]]),
                    detail=f"x{j - i + 1}",
                    group=f"epiz-{line.index}-{i}",
                )
                i = j + 1
            else:
                i += 1


def _stems(word: str) -> set[str]:
    """Candidate roots of a word, for polyptoton only.

    Deliberately conservative and dependency-free: strip one known suffix, and
    offer the obvious spelling repairs (``carries`` -> ``carry``, ``running``
    -> ``run``, ``making`` -> ``make``) as alternatives rather than guessing
    which one is right. A pair counts as polyptoton when their candidate sets
    intersect.
    """
    if len(word) < 3:
        return set()
    out = {word}
    for suf in _SUFFIXES:
        if not word.endswith(suf):
            continue
        base = word[: -len(suf)]
        if len(base) < 3:
            continue
        out.add(base)
        if suf in ("ies", "ied"):
            out.add(base + "y")
        if suf in ("ing", "ed", "er", "est"):
            out.add(base + "e")
            # doubled consonant before the suffix: runn -> run
            if len(base) >= 3 and base[-1] == base[-2] and base[-1] not in "aeiou":
                out.add(base[:-1])
        break
    return {s for s in out if len(s) >= 3}


def _emit_polyptoton(lyric: list[_Line], out: _Out) -> None:
    # Dict-keyed by candidate stem: no pairwise pass over the song's words.
    by_stem: dict[str, list[tuple[_Line, int, str]]] = {}
    for line in lyric:
        for k, word in enumerate(line.seq):
            # Function words are out of this pass too: the stemmer cannot tell
            # "but" from the "butt-" it peels off "butter", and "do / does /
            # did" is grammar rather than a figure worth pointing at.
            if word in _NOISE_WORDS:
                continue
            for stem in _stems(word):
                by_stem.setdefault(stem, []).append((line, k, word))
    seen: set[tuple[tuple[int, int], tuple[int, int]]] = set()
    for stem, hits in sorted(by_stem.items()):
        if len(hits) < 2:
            continue
        for (la, ka, wa), (lb, kb, wb) in zip(hits, hits[1:]):
            if wa == wb:
                continue
            if abs(lb.index - la.index) > POLYPTOTON_LINE_WINDOW:
                continue
            ta = la.toks[la.seq_idx[ka]]
            tb = lb.toks[lb.seq_idx[kb]]
            key = _pair_key(ta, tb)
            if key in seen:
                continue
            seen.add(key)
            out.add(
                "polyptoton",
                [_span(ta), _span(tb)],
                label=_label("polyptoton", [wa, wb]),
                detail=stem,
                confidence=0.8,
                group=f"poly-{stem}",
            )


def _emit_antimetabole(lyric: list[_Line], out: _Out) -> None:
    """A B … B A, inside one line or across a line pair."""
    windows: list[list[_Line]] = [[ln] for ln in lyric]
    windows += [[a, b] for a, b in zip(lyric, lyric[1:])]
    seen: set[tuple] = set()
    for window in windows:
        flat: list[tuple[_Line, int, str]] = []
        for line in window:
            for k, word in enumerate(line.seq):
                if len(word) >= 3 and word not in _NOISE_WORDS:
                    flat.append((line, k, word))
        # Only words that actually repeat can take part, so the pair loop below
        # runs over a handful of candidates, never the whole window.
        firsts: dict[str, int] = {}
        lasts: dict[str, int] = {}
        for pos, (_ln, _k, word) in enumerate(flat):
            firsts.setdefault(word, pos)
            lasts[word] = pos
        repeated = [w for w in firsts if lasts[w] > firsts[w]]
        # A hook can repeat a dozen words; cap the pair loop so a pathological
        # line cannot turn this into a quadratic pass.
        if len(repeated) < 2 or len(repeated) > 12:
            continue
        for a in repeated:
            for b in repeated:
                if a == b:
                    continue
                if not (firsts[a] < firsts[b] and lasts[b] < lasts[a]):
                    continue
                positions = (firsts[a], firsts[b], lasts[b], lasts[a])
                toks = [
                    flat[p][0].toks[flat[p][0].seq_idx[flat[p][1]]] for p in positions
                ]
                key = tuple((t.line, t.index) for t in toks)
                if key in seen:
                    continue
                seen.add(key)
                out.add(
                    "antimetabole",
                    [_span(t) for t in toks],
                    label=_label("antimetabole", [a, b, b, a]),
                    detail=f"{a} {b} … {b} {a}",
                    group=f"anti-{key[0][0]}-{a}-{b}",
                )


def _emit_refrain(lyric: list[_Line], out: _Out) -> None:
    by_text: dict[str, list[_Line]] = {}
    for line in lyric:
        if len(line.seq) < 2:
            continue
        by_text.setdefault(" ".join(line.seq), []).append(line)
    for text, hits in sorted(by_text.items()):
        if len(hits) < 2:
            continue
        spans: list[Span] = []
        for line in hits:
            spans.extend(_span(line.toks[w]) for w in line.seq_idx)
        out.add(
            "refrain",
            spans,
            label=_label("refrain", [hits[0].text.strip()]),
            detail=f"x{len(hits)}",
            group=f"refrain-{hashlib.blake2s(text.encode(), digest_size=4).hexdigest()}",
        )


# --- structure -------------------------------------------------------------


def _ends_open(text: str) -> bool:
    stripped = text.rstrip().rstrip(_TRAILING_TRIM).rstrip()
    return bool(stripped) and stripped[-1] not in _END_STOP


def _emit_enjambment(lyric: list[_Line], out: _Out) -> None:
    for a, b in zip(lyric, lyric[1:]):
        # `_ends_open` reads the raw text, so a line of CJK, emoji or bare
        # punctuation passes it while contributing no analysable token at all —
        # both index lists have to be checked, not just `b.seq`.
        if not _ends_open(a.text) or not a.seq_idx or not b.seq or not b.seq_idx:
            continue
        first_raw = b.toks[b.seq_idx[0]].raw
        starts_sentence = first_raw[:1].isupper() and b.seq[0] not in _CONTINUATIONS
        if starts_sentence:
            continue
        out.add(
            "enjambment",
            [_span(a.toks[a.seq_idx[-1]]), _span(b.toks[b.seq_idx[0]])],
            label=_label("enjambment", [a.seq[-1], b.seq[0]]),
            detail="the sentence runs on past the break",
            confidence=0.8 if first_raw[:1].isupper() else 1.0,
            group=f"enj-{a.index}",
        )


def _emit_caesura(lyric: list[_Line], out: _Out) -> None:
    for line in lyric:
        if len(line.toks) < 3:
            continue
        for j, tok in enumerate(line.toks[1:-1], start=1):
            raw = tok.raw.rstrip(_TRAILING_TRIM)
            mark = next((m for m in _CAESURA_MARKS if raw.endswith(m)), "")
            if not mark:
                continue
            out.add(
                "caesura",
                [_span(tok, whole=True)],
                label=_label("caesura", [tok.raw]),
                detail=mark,
                confidence=1.0 if mark not in (",",) else 0.8,
                group=f"caes-{line.index}-{j}",
            )


def name_meter(stress: str) -> tuple[str, int] | None:
    """``('iamb', 5)`` when a stress string is a named foot repeated 3+ times.

    Secondary stress reads as stressed for scansion. A final partial foot is
    allowed (catalexis). An all-stressed line is rejected: with a guessed
    pronunciation that is a G2P artefact far more often than it is spondaic
    meter.
    """
    s = (stress or "").replace("2", "1")
    if len(s) < 6 or set(s) == {"1"}:
        return None
    for name, foot in _FEET:
        feet = len(s) // len(foot)
        if feet < 3:
            continue
        whole = foot * feet
        if s.startswith(whole) and foot.startswith(s[len(whole) :]):
            return name, feet
    return None


def _emit_meter(lyric: list[_Line], metrics: dict[int, LineMetrics], out: _Out) -> None:
    for line in lyric:
        m = metrics.get(line.index)
        if m is None:
            continue
        named = name_meter(m.stress)
        if named is None:
            continue
        foot, feet = named
        length = _METER_LENGTHS.get(feet, f"{feet} feet")
        out.add(
            "meter",
            [_span(t) for t in line.toks],
            label=_label("meter", [f"{_FOOT_ADJECTIVE[foot]} {length}"]),
            detail=f"{_FOOT_ADJECTIVE[foot]} {length} ({feet} x {foot}) {m.stress}",
            confidence=0.9,
            group=f"meter-{foot}",
        )


# --- metrics and stats -----------------------------------------------------


def _line_metrics(lines: list[_Line]) -> list[LineMetrics]:
    out: list[LineMetrics] = []
    for line in lines:
        tok = _line_ending(line) if line.is_lyric else None
        stress = stress_pattern([t.norm for t in line.toks]) if line.toks else ""
        out.append(
            LineMetrics(
                line=line.index,
                letter="",
                syllables=sum(t.nsyl for t in line.toks),
                words=len(line.toks),
                stress=stress,
                end_key=tok.rkey if tok else "",
                end_phones=list(tok.phones) if tok else [],
                section=line.section,
            )
        )
    return out


def _sections(
    lines: list[_Line], sects: list[_Sect], metrics: list[LineMetrics]
) -> list[SectionSummary]:
    by_line = {m.line: m for m in metrics}
    out: list[SectionSummary] = []
    for sect in sects:
        letters = []
        syllables = 0
        for idx in sect.lyric_lines:
            m = by_line.get(idx)
            if m is None:
                continue
            # A line that rhymes with nothing is "X" in the scheme string, the
            # usual notation; its LineMetrics letter stays empty.
            letters.append(m.letter or "X")
            syllables += m.syllables
        out.append(
            SectionSummary(
                name=sect.name,
                start_line=sect.start_line,
                end_line=sect.end_line,
                scheme="".join(letters),
                lines=len(sect.lyric_lines),
                syllables=syllables,
            )
        )
    return out


def _stats(
    lines: list[_Line],
    devices: list[Device],
    rhymed_lines: set[int],
) -> AnalysisStats:
    lyric = [ln for ln in lines if ln.is_lyric]
    words = [t for ln in lyric for t in ln.toks]
    norms = [t.norm for t in words if t.norm]
    unique = set(norms)
    syllables = sum(t.nsyl for t in words)
    by_kind: dict[str, int] = {}
    by_family: dict[str, int] = {}
    for dev in devices:
        by_kind[dev.kind] = by_kind.get(dev.kind, 0) + 1
        by_family[dev.family] = by_family.get(dev.family, 0) + 1
    n_lines = len(lyric)
    return AnalysisStats(
        lines=n_lines,
        words=len(words),
        syllables=syllables,
        unique_words=len(unique),
        ttr=round(len(unique) / len(norms), 4) if norms else 0.0,
        rhyme_density=round(len(rhymed_lines) / n_lines, 4) if n_lines else 0.0,
        multisyllabic_rhymes=by_kind.get("multisyllabic-rhyme", 0),
        avg_syllables_per_line=round(syllables / n_lines, 3) if n_lines else 0.0,
        guessed_pronunciations=len(
            {t.norm for t in words if t.norm and t.pron.guessed}
        ),
        devices_by_kind=by_kind,
        devices_by_family=by_family,
    )


# --- entry point -----------------------------------------------------------


def analyse(
    doc: LyricsDoc,
) -> tuple[list[Device], list[LineMetrics], list[SectionSummary], AnalysisStats]:
    """Every rules-based finding in one pass over a lyrics document."""
    lines, sects = _prepare(doc)
    metrics = _line_metrics(lines)
    by_line = {m.line: m for m in metrics}
    out = _Out()

    # Rhyme classes first: the scheme letters are what every rhyme device is
    # grouped by, and the multisyllabic pass needs the groups before it emits.
    classes = _rhyme_classes(lines, sects)
    rhymed_lines: set[int] = set()
    ending_group: dict[int, str] = {}
    for cls in classes:
        if len(cls.members) < 2:
            continue
        for member in cls.members:
            by_line[member.line].letter = cls.letter
            rhymed_lines.add(member.line)
            ending_group[member.line] = _class_group(cls)

    ends: dict[int, int] = {}
    for line in lines:
        tok = _line_ending(line) if line.anchored else None
        if tok is not None:
            ends[line.index] = tok.index

    # Precedence: a word pair is claimed once, by the most specific detector
    # that can see it — multisyllabic, then the scheme pairs (end/identical),
    # then pararhyme and eye rhyme between endings, then the positional
    # internal kinds, then cross-line.
    used: set = set()
    _emit_multisyllabic(lines, out, used, ending_group, ends)
    _emit_end_rhymes(classes, out, used)
    _emit_ending_pairs(lines, sects, out, used)
    _emit_internal_rhymes(lines, out, used, ends)
    _emit_cross_line_rhymes(lines, out, used, ends)

    _emit_alliteration(lines, out)
    _emit_assonance(lines, out, used)
    _emit_consonance(lines, out)
    _emit_density(
        lines, out, "sibilance", _SIBILANTS, SIBILANCE_MIN_COUNT, SIBILANCE_MIN_RATIO
    )
    _emit_density(
        lines, out, "plosive", _PLOSIVES, PLOSIVE_MIN_COUNT, PLOSIVE_MIN_RATIO
    )
    _emit_onomatopoeia(lines, out)

    # The repetition and structure passes compare words, not sounds, and only
    # ever look at lyric lines — markers are never sung, so a "[Chorus]" line
    # between two verses must not break an anaphora that runs across it.
    lyric = [ln for ln in lines if ln.is_lyric and ln.anchored]
    _emit_repetition_edges(lyric, out)
    _emit_anadiplosis(lyric, out)
    _emit_epizeuxis(lyric, out)
    _emit_polyptoton(lyric, out)
    _emit_antimetabole(lyric, out)
    _emit_refrain(lyric, out)

    _emit_enjambment(lyric, out)
    _emit_caesura(lyric, out)
    _emit_meter(lyric, by_line, out)

    devices = sorted(
        out.devices,
        key=lambda d: (
            d.spans[0].line if d.spans else 1 << 30,
            d.spans[0].word if d.spans else 0,
            d.kind,
            d.id,
        ),
    )
    return (
        devices,
        metrics,
        _sections(lines, sects, metrics),
        _stats(lines, devices, rhymed_lines),
    )
