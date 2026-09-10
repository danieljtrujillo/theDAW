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
  Every pairwise rhyme pass is bounded by a line or by a small line window; the
  sound passes read the lyric as one axis and are bounded by a gap in carrier
  positions and a ceiling on how many lines one run may cross. The matches that
  can be found by grouping (rhyme classes, multisyllabic tails, alliteration,
  refrains) are found with a dict, not a loop over pairs.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field

from ..lyrics.schema import LyricsDoc
from . import meaning
from .phonetics import (
    ARPABET_VOWELS,
    Pron,
    Syllable,
    classify_rhyme,
    consonant_family,
    max_rhyme_score,
    normalize_word,
    pronounce,
    pronounce_phrase,
    rhyme_key,
    rhyme_nuclei,
    stress_pattern,
    syllabify,
    tail_key,
    vowel_colour_distance,
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
# Two alliterating words may sit at most 3 apart. The distance is counted in
# words that could have CARRIED the sound, not in words on the page: function
# words are never members of a run, so they must not spend its budget either.
# "Silly Sally went over there and sang softly" is one hiss with three light
# words inside it, and counting those made it two.
ALLITERATION_GAP = 3
# Assonance and consonance tolerate one more carrier of distance: the vowel
# colour of a line survives a longer gap than a hard initial consonant does.
ASSONANCE_GAP = 4
CONSONANCE_GAP = 4
# Consonance is everywhere in English, so it needs three carriers to count.
CONSONANCE_MIN = 3
# Assonance on the COLOUR of a vowel rather than on the symbol. Two tiers,
# because "sleep / green" and "sleep / lift" are both assonance and only one
# of them is exact: a near run has to say which it is. Distances are
# ``vowel_colour_distance``, which is the rhyme distance with the length
# penalty turned down — see phonetics for why that is the right measure here.
ASSONANCE_CLOSE = 0.26
ASSONANCE_LOOSE = 0.36
# A near run may not DRIFT: every member is within the tier of the run's
# anchor, so "green / grin / grand / grunt" cannot walk from IY to AH one
# comfortable step at a time and be reported as one vowel.
ASSONANCE_MIN_NEAR = 3
# Sound carries over a line break as readily as it carries across a comma, so
# the sound passes read the lyric as one axis rather than line by line. A run
# may cross this many breaks: four lines is the quatrain, which is as far as a
# writer holds one vowel or one hiss on purpose, and past it the run stops
# being something the ear followed and starts being every /s/ in the song.
SOUND_LINE_REACH = 3
# A break puts the next line's first carrier this many positions from the last
# one before it — exactly ALLITERATION_GAP, the tightest of the three. So a
# sound that ends one line and opens the next is one sound, and one that has to
# reach into the middle of the next line to find its partner is not.
SOUND_LINE_COST = 3
# Consonance grouped by family (S/Z, T/D, M/N/NG …) rather than by phone.
CONSONANCE_NEAR_MIN = 3
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

# --- shape of a scheme over distance ---------------------------------------
#
# A run, a chain, a callback and a bookend are claims about the SHAPE of a
# scheme, and a shape is a far stronger statement than a scheme letter: a
# letter says "these two endings are in the same class", a run says "eight
# lines in a row are one rhyme". So the shapes are cut from their own,
# stricter grouping, and the floor comes from measuring the two populations
# rather than from taste. Adjacent endings of an ordinary ABAB stanza score
# 0.57-0.68 against each other (burns/bird 0.571, bird/turns 0.608,
# snow/blue 0.664, rain/same 0.678) while the drifting-but-real chains a
# reader does hear start at 0.77 (pieces/seasons 0.773, occasion/patience
# 0.784, meaning/dreaming 0.845). 0.75 is the gap between them.
SHAPE_MIN_CONF = 0.75
# Three consecutive lyric lines is where a couplet stops being a couplet and
# starts being a monorhyme run.
RUN_MIN_LINES = 3
# A chain is one rhyme threaded through a stretch it does not own, so it has
# to say something sustained ABAB does not already say. Alternation gives one
# member every other line, so five members inside ten lines is exactly ABAB and
# is not reported; it takes a sixth member, or the same five spread wider, to
# read as a thread.
CHAIN_MIN_MEMBERS = 5
CHAIN_MIN_SPAN = 11
# Lyric lines of other material between two occurrences before the return
# reads as a callback rather than as the scheme still running. Inside one
# section that takes a real dormancy — most sections are not even this long.
# Across a section boundary the boundary is itself half the evidence, so four
# lines of somewhere else is enough: that is a hook rhyme coming back in the
# verse, which is what a songwriter means by the word.
CALLBACK_MIN_GAP = 8
CALLBACK_SECTION_GAP = 4
# ...and you cannot come back to something you never set up. The rhyme has to
# have been ESTABLISHED before it went quiet — at least two lines close
# together — or a lyric that recycles a dozen rhyme sounds reports a callback
# at every reappearance and drowns the two that mean something. On a 400-line
# lyric of scattered rhymes that one condition takes the count from 231 to 87,
# and the cap below takes it the rest of the way.
CALLBACK_MIN_ESTABLISHED = 2
# A rhyme that goes quiet and comes back a dozen times is not making callbacks,
# it is the song's spine — and a long lyric recycling a handful of rhyme
# families produces exactly that. Past this many returns the strand is left
# uncut and the chain pass reports it once, as the thread it actually is; on a
# 400-line lyric built from sixteen rhyme families that turns 152 findings
# into 10.
CALLBACK_MAX_RETURNS = 2
# A bookend needs a section long enough for the return to be an envelope: two
# lines is a couplet and three is the ordinary ABA turn.
BOOKEND_MIN_LINES = 4
# A shape lists at most this many of its members in its label; a twenty-line
# run must not paste twenty words into a tooltip.
SHAPE_LABEL_WORDS = 4
# The same for a sound run, which now reaches as far as the ear does: the pane
# clips a label past 90 characters, and a clipped label hides the very thing a
# long run is reported for — where it ends.
SOUND_LABEL_WORDS = 5

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
class _Strand:
    """One rhyme followed across the whole lyric, for shape detection only.

    A scheme class is per section and joins on ``MIN_SCHEME_CONF``; a strand is
    global and joins on ``SHAPE_MIN_CONF``. Both of those differences are the
    point. Global, because the thing a listener notices is the hook's rhyme
    coming back in verse three, and the letters restart at every marker.
    Stricter, because "burns / bird / turns / word" is one class — every pair
    of them is a slant rhyme of something — but two strands, which is what a
    reader means when they say that stanza is ABAB.
    """

    members: list[_Ending] = field(default_factory=list)
    # Lyric-line ordinal of each member. Dormancy is counted in lines that are
    # actually sung: a "[Chorus]" marker and the blank line under it are not
    # two lines of silence, they are none.
    order: list[int] = field(default_factory=list)
    # The words each member really rhymes ON, which is not always its last word
    # ("...on my way, yeah").
    rtoks: list[list[_Tok]] = field(default_factory=list)
    # The scheme-class group each member came from, so a shape can be coloured
    # as the class it describes. Empty for a class that never earned a letter:
    # ``_class_group`` gives all of those in a section the same placeholder,
    # and colouring a shape with it would tie it to an unrelated rhyme.
    groups: list[str] = field(default_factory=list)
    # How well each member matched the one before it; a shape reports the
    # weakest link it contains.
    confs: list[float] = field(default_factory=list)


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


def _elide(parts: list[str], keep: int) -> list[str]:
    """The first few, an ellipsis, and the last. A label has to say where a
    long finding ENDS — that is most of what makes it long — so the middle is
    what goes, never the tail."""
    if len(parts) <= keep:
        return parts
    return parts[: keep - 1] + ["…", parts[-1]]


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
    # word in front is offered as an ending of its own — but only when that
    # word is one a line CAN end on. Stepping back onto another particle
    # ("...nothing like a you", "...waiting for you") offers the bare article
    # or preposition as the ending, and cmudict keeps a stressed variant of
    # exactly those words: "a" is AH but also EY, "for" is F ER but also
    # F AO R. Against any line in that rhyme family they then score a perfect
    # 1.0, so the pane paints an end rhyme on a preposition, and the shape
    # pass — which trusts a 1.0 well past SHAPE_MIN_CONF — welds two unrelated
    # rhymes into one chain.
    throwaway = len(words) > 1 and _is_throwaway(last)
    if throwaway and not _is_throwaway(words[-2]):
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


def _multi_buckets(lines: list[_Line]) -> dict[tuple[int, str], list[tuple[_Run, str]]]:
    """Every run of words in the lyric, bucketed by the tail it could rhyme on.

    Built once and read twice: by ``_emit_multisyllabic`` for the pairs inside
    its window, and by ``_emit_multi_callbacks`` for the ones outside it.
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
    return buckets


def _emit_multisyllabic(
    buckets: dict[tuple[int, str], list[tuple[_Run, str]]],
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


def _emit_end_rhymes(
    classes: list[_RhymeClass],
    out: _Out,
    used: set,
    covered: set[tuple[int, int]],
) -> None:
    """The pairwise scheme rhymes, minus the ones a shape already reported.

    ``covered`` holds the line pairs the run/chain/callback/bookend pass has
    put inside a shape. A shape says everything the pair says and then some —
    an eight-line run IS its seven pairs — so re-listing them underneath it
    would only bury the finding that matters.
    """
    for cls in classes:
        if len(cls.members) < 2:
            continue
        group = _class_group(cls)
        rep = cls.members[0]
        for a, b in zip(cls.members, cls.members[1:]):
            if (a.line, b.line) in covered:
                continue
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


# --- shape of a scheme over distance ---------------------------------------
#
# Everything above reports a PAIR. A scheme also has a shape, and the shape is
# what a listener actually hears: eight lines in a row on one rhyme, a class
# threaded through a whole verse, the hook's rhyme coming back two sections
# later. None of that is visible pair by pair, and the windows the pairwise
# passes are bounded by cannot see that far by design.


def _lyric_order(lines: list[_Line]) -> dict[int, int]:
    """Position of each lyric line among the lyric lines.

    Every distance in this section is counted here rather than in document line
    numbers, so a "[Chorus]" marker and the blank line under it never make a
    rhyme look dormant — nobody sings them.
    """
    order: dict[int, int] = {}
    for line in lines:
        if line.is_lyric:
            order[line.index] = len(order)
    return order


def _repeated_lines(lines: list[_Line]) -> set[int]:
    """Lyric lines that are a word-for-word repeat of an earlier one.

    A rhyme that comes back because its whole LINE came back is a refrain, and
    the repetition passes own it. Reporting it as a callback as well puts one
    finding on every reappearance of the chorus — four of them in an ordinary
    verse/chorus song — and buries the return that happens on new words.
    """
    seen: set[tuple[str, ...]] = set()
    out: set[int] = set()
    for line in lines:
        if not line.is_lyric or not line.seq:
            continue
        key = tuple(line.seq)
        if key in seen:
            out.add(line.index)
        seen.add(key)
    return out


def _ending_nuclei(ending: _Ending) -> tuple[str, ...]:
    """Every stressed vowel any of this ending's runs could rhyme from."""
    seen: list[str] = []
    for _toks, pron in ending.runs:
        seen.extend(rhyme_nuclei(pron))
    return tuple(dict.fromkeys(seen))


def _strands(classes: list[_RhymeClass], order: dict[int, int]) -> list[_Strand]:
    """Re-cut the scheme classes into globally threaded, tightly matched strands.

    Cost: an ending is only ever compared against the LAST member of a strand,
    never against another line, and ``max_rhyme_score`` over the ending's whole
    run of final words is a sound upper bound on that comparison — so a strand
    that could not clear the floor is skipped without pronouncing anything.
    Class membership is already computed, so the pass is linear in class
    members times strands, the same order as the class pass that produced them,
    and nothing here is quadratic in lines.

    The endings are walked in LINE order, not class order. ``classes`` is
    grouped by section and then by first appearance, so taking it as it comes
    hands a strand its members out of order the moment one crosses from a
    section's second class back into its first — and every distance in this
    section is then measured against a scrambled list: a run cannot be seen
    across the scramble, ``_callback_gap`` goes negative, the covered pairs
    come out reversed so ``_emit_end_rhymes`` stops suppressing them, and the
    shape paints its spans backwards through the lyric. It also makes the
    "newest first" rule below mean what it says — the last place a rhyme was
    heard is only a strand's last member when the walk is chronological.
    """
    strands: list[_Strand] = []
    by_key: dict[str, _Strand] = {}
    nuclei: dict[int, tuple[str, ...]] = {}
    flat = sorted(
        (
            (ending, _class_group(cls) if cls.letter else "")
            for cls in classes
            for ending in cls.members
        ),
        key=lambda pair: pair[0].line,
    )
    for ending, group in flat:
        nuclei[ending.line] = mine = _ending_nuclei(ending)
        # Same rime, same strand — but never for an ending that only looks
        # the same because both lines threw away the same ad-lib.
        key = "" if ending.throwaway else ending.tok.rkey
        strand = by_key.get(key) if key else None
        toks = list(ending.runs[0][0])
        conf = 1.0
        if strand is None:
            # Newest first: a rhyme returns to the last place it was heard.
            for cand in reversed(strands):
                last = cand.members[-1]
                if max_rhyme_score(nuclei[last.line], mine) < SHAPE_MIN_CONF:
                    continue
                kind, score, toks_a, toks_b = _match_endings(last, ending)
                if kind not in _SCHEME_KINDS or score < SHAPE_MIN_CONF:
                    continue
                strand, toks, conf = cand, toks_b, score
                if len(cand.members) == 1:
                    # The strand's first member was painted on its own last
                    # word for want of anything to compare it against; now
                    # we know which words it really rhymes on.
                    cand.rtoks[0] = toks_a
                break
        if strand is None:
            strand = _Strand()
            strands.append(strand)
        if key and key not in by_key:
            by_key[key] = strand
        strand.members.append(ending)
        strand.order.append(order[ending.line])
        strand.rtoks.append(toks)
        strand.groups.append(group)
        strand.confs.append(conf)
    return strands


def _shape_spans(strand: _Strand, idx: list[int]) -> list[Span]:
    spans: list[Span] = []
    for i in idx:
        toks = strand.rtoks[i]
        spans.extend(_run_spans(toks, toks[-1].rkey))
    return spans


def _shape_label(kind: str, strand: _Strand, idx: list[int]) -> str:
    words = [" ".join(t.raw for t in strand.rtoks[i]) for i in idx]
    return _label(kind, _elide(words, SHAPE_LABEL_WORDS))


def _weakest(strand: _Strand, idx: list[int]) -> float:
    """A shape is only as strong as the weakest join it contains."""
    return min((strand.confs[i] for i in idx[1:]), default=1.0)


def _fresh(strand: _Strand, idx: list[int], repeats: set[int]) -> int:
    """Members that are not there because their whole line came back.

    "Hold on, hold on" three times is a refrain and the repetition passes
    already say so; counting those lines towards a monorhyme run announces the
    most ordinary shape in pop music as the pane's strongest rhyme finding.
    """
    return sum(1 for i in idx if strand.members[i].line not in repeats)


def _cover_repeats(
    strand: _Strand, idx: list[int], covered: set[tuple[int, int]], repeats: set[int]
) -> None:
    """Claim the pairs a dropped shape held only because a line repeated.

    The refrain owns them, so they must not fall back out as three rows of
    "identical rhyme: tonight / tonight". A pair that ends on a line the singer
    had not sung before is a real rhyme and is left alone.
    """
    for i, j in zip(idx, idx[1:]):
        if strand.members[j].line in repeats:
            covered.add((strand.members[i].line, strand.members[j].line))


def _strand_group(strand: _Strand, idx: list[int]) -> str:
    """The colour a shape shares with the rhyme class it describes.

    A shape can be anchored on a class of one line — a hook rhyme that returns
    once in a later verse is exactly that — and such a class has no letter and
    so no group of its own. Then the strand is named after the rhyme itself,
    which is stable across runs and unique to that sound.
    """
    for i in idx:
        if strand.groups[i]:
            return strand.groups[i]
    key = strand.rtoks[idx[0]][-1].rkey or "?"
    return f"rhyme-thread-{hashlib.blake2s(key.encode(), digest_size=4).hexdigest()}"


def _callback_where(lines: list[_Line], a: int, b: int) -> str:
    """The sections a callback links, for the tooltip.

    Compared by section INDEX, never by name: a song has two "[Chorus]"
    markers and they are two different sections, which is exactly the case a
    callback is most worth reporting.
    """
    la, lb = lines[a], lines[b]
    if la.section_idx == lb.section_idx:
        return f" in {la.section}" if la.section else ""
    if la.section == lb.section:
        return f" back in {la.section}" if la.section else ""
    return f": {la.section or 'the opening'} → {lb.section or 'the outro'}"


def _callback_gap(strand: _Strand, i: int, lines: list[_Line]) -> int:
    """Lyric lines of silence before member ``i``, when that silence is a return.

    Zero when the rhyme never went away and the scheme simply carried on.
    """
    gap = strand.order[i] - strand.order[i - 1] - 1
    if gap < CALLBACK_SECTION_GAP:
        return 0
    crossed = (
        lines[strand.members[i - 1].line].section_idx
        != lines[strand.members[i].line].section_idx
    )
    return gap if crossed or gap >= CALLBACK_MIN_GAP else 0


def _bookend_pairs(
    strands: list[_Strand],
    at: dict[int, tuple[int, int]],
    lines: list[_Line],
    sects: list[_Sect],
    repeats: set[int],
) -> dict[tuple[int, int], tuple[int, int, int, float]]:
    """Sections whose first and last lyric line rhyme, as (strand, i, j, score).

    The two endings have to rhyme with EACH OTHER, not merely share a strand: a
    strand can be held together through its middle, and "the section opens and
    closes on the same sound" is a claim about those two lines alone.

    And it has to close on a new line. A chorus that is one line sung four
    times does open and close on one rhyme, on one WORD in fact, which is why
    the repetition passes call it a refrain and this one says nothing.
    """
    found: dict[tuple[int, int], tuple[int, int, int, float]] = {}
    for sect in sects:
        anchored = [i for i in sect.lyric_lines if lines[i].anchored]
        if len(sect.lyric_lines) < BOOKEND_MIN_LINES or len(anchored) < 2:
            continue
        first, last = anchored[0], anchored[-1]
        if last in repeats:
            continue
        a, b = at.get(first), at.get(last)
        if a is None or b is None or a[0] != b[0]:
            continue
        strand = strands[a[0]]
        kind, conf, _ta, _tb = _match_endings(
            strand.members[a[1]], strand.members[b[1]]
        )
        if kind in _SCHEME_KINDS and conf >= SHAPE_MIN_CONF:
            found[(first, last)] = (a[0], a[1], b[1], conf)
    return found


def _emit_stretch(
    strand: _Strand,
    si: int,
    lo: int,
    hi: int,
    out: _Out,
    covered: set[tuple[int, int]],
    extents: dict[int, list[tuple[int, int]]],
    repeats: set[int],
) -> None:
    """Runs, and the chain, inside one uninterrupted stretch of a strand.

    Each shape records the LINE RANGE it spans, per strand, so the bookend
    pass can tell an envelope from a section this rhyme already saturates.
    """
    # Consecutive means consecutive LYRIC lines: a marker or a blank between
    # two lines of a verse does not break the run, because nobody sings it.
    runs: list[tuple[int, int]] = []
    start = lo
    for i in range(lo + 1, hi + 2):
        if i <= hi and strand.order[i] - strand.order[i - 1] == 1:
            continue
        if i - start >= RUN_MIN_LINES:
            runs.append((start, i - 1))
        start = i
    for a, b in runs:
        idx = list(range(a, b + 1))
        if _fresh(strand, idx, repeats) < RUN_MIN_LINES:
            _cover_repeats(strand, idx, covered, repeats)
            continue
        key = strand.rtoks[b][-1].rkey
        count = b - a + 1
        out.add(
            "rhyme-run",
            _shape_spans(strand, idx),
            label=_shape_label("rhyme-run", strand, idx),
            detail=f"{count} consecutive lines{f': {key}' if key else ''}",
            phones=key.split(),
            confidence=_weakest(strand, idx),
            group=_strand_group(strand, idx),
        )
        for i in range(a, b):
            covered.add((strand.members[i].line, strand.members[i + 1].line))
        extents.setdefault(si, []).append(
            (strand.members[a].line, strand.members[b].line)
        )
    span = strand.order[hi] - strand.order[lo] + 1
    # A stretch that is one solid run is already reported as that run; calling
    # it a chain as well would be the same sentence twice.
    if runs and runs[0] == (lo, hi):
        return
    if hi - lo + 1 < CHAIN_MIN_MEMBERS or span < CHAIN_MIN_SPAN:
        return
    idx = list(range(lo, hi + 1))
    if _fresh(strand, idx, repeats) < CHAIN_MIN_MEMBERS:
        _cover_repeats(strand, idx, covered, repeats)
        return
    key = strand.rtoks[hi][-1].rkey
    out.add(
        "rhyme-chain",
        _shape_spans(strand, idx),
        label=_shape_label("rhyme-chain", strand, idx),
        detail=f"{len(idx)} lines across {span}{f': {key}' if key else ''}",
        phones=key.split(),
        confidence=_weakest(strand, idx),
        group=_strand_group(strand, idx),
    )
    for i in range(lo, hi):
        covered.add((strand.members[i].line, strand.members[i + 1].line))
    extents.setdefault(si, []).append(
        (strand.members[lo].line, strand.members[hi].line)
    )


def _emit_scheme_shapes(
    strands: list[_Strand],
    lines: list[_Line],
    sects: list[_Sect],
    repeats: set[int],
    out: _Out,
    used: set,
) -> tuple[set[tuple[int, int]], set[tuple[int, int]]]:
    """Runs, chains, callbacks and bookends, laid out so they cannot smother.

    A callback CUTS its strand: a rhyme that goes dormant for a verse and comes
    back is two stretches with a callback between them, never one long chain.
    Runs and chains are then found inside a stretch, and a chain is not
    reported when the stretch is already one solid run. A bookend is dropped
    when a run or chain on the SAME strand already reaches either of its two
    lines: "the section opens and closes on one rhyme" is worth saying about
    an envelope and worth nothing about a section that is soaked in the sound
    anyway. A seven-line monorhyme verse with one drifting line in it is
    exactly that — the run stops at the drift, so an end-to-end test misses
    it and the verse is announced as a bookend of itself.

    A run or a chain built out of a line the singer simply sang again is a
    refrain, and the repetition passes own it — so it is not reported, and it
    still claims the repeated pairs so they do not fall back out underneath the
    refrain as identical rhymes.

    A callback and a bookend name exactly TWO endings, which is the same shape
    a pairwise rhyme device has, so they take the pair out of ``used`` like any
    other detector and nothing reports those two words twice. A run and a chain
    name three or more, so they claim nothing there — the multisyllabic detail
    inside a rap run is the best finding in the pane and must survive it — and
    suppress only the pairwise END rhymes they contain, through ``covered``.

    Returns those covered line pairs, and the pairs reported as callbacks so
    the multisyllabic callback pass does not repeat them.
    """
    covered: set[tuple[int, int]] = set()
    callback_pairs: set[tuple[int, int]] = set()
    extents: dict[int, list[tuple[int, int]]] = {}
    at: dict[int, tuple[int, int]] = {}
    for si, strand in enumerate(strands):
        for i, member in enumerate(strand.members):
            at[member.line] = (si, i)
    # Bookends are decided first so a section that opens and closes on one
    # rhyme reads as an envelope rather than as a rhyme that went away and came
    # back: it never went anywhere, the section did.
    bookends = _bookend_pairs(strands, at, lines, sects, repeats)

    for si, strand in enumerate(strands):
        n = len(strand.members)
        if n < 2:
            continue
        returns = [(i, _callback_gap(strand, i, lines)) for i in range(1, n)]
        returns = [(i, gap) for i, gap in returns if gap]
        if len(returns) > CALLBACK_MAX_RETURNS:
            _emit_stretch(strand, si, 0, n - 1, out, covered, extents, repeats)
            continue
        cuts = [0]
        for i, gap in returns:
            # Members since the last cut: how well the rhyme was established
            # before it went quiet.
            established = i - cuts[-1]
            cuts.append(i)
            pair = (strand.members[i - 1].line, strand.members[i].line)
            if established < CALLBACK_MIN_ESTABLISHED or pair in bookends:
                continue
            if pair[1] in repeats:
                continue
            idx = [i - 1, i]
            key = strand.rtoks[i][-1].rkey
            where = _callback_where(lines, pair[0], pair[1])
            out.add(
                "callback",
                _shape_spans(strand, idx),
                label=_shape_label("callback", strand, idx),
                detail=f"returns after {gap} lines{where}",
                phones=key.split(),
                confidence=strand.confs[i],
                group=_strand_group(strand, idx),
            )
            covered.add(pair)
            callback_pairs.add(pair)
            for ta in strand.rtoks[i - 1]:
                for tb in strand.rtoks[i]:
                    used.add(_pair_key(ta, tb))
        cuts.append(n)
        for lo, hi in zip(cuts, cuts[1:]):
            _emit_stretch(strand, si, lo, hi - 1, out, covered, extents, repeats)

    for (first, last), (si, ia, ib, conf) in bookends.items():
        if any(lo <= first <= hi or lo <= last <= hi for lo, hi in extents.get(si, ())):
            continue
        strand = strands[si]
        idx = [ia, ib]
        key = strand.rtoks[ib][-1].rkey
        name = lines[first].section
        out.add(
            "bookend",
            _shape_spans(strand, idx),
            label=_shape_label("bookend", strand, idx),
            detail=f"{name or 'the section'} opens and closes on {key or 'one rhyme'}",
            phones=key.split(),
            confidence=conf,
            group=_strand_group(strand, idx),
        )
        covered.add((first, last))
        for ta in strand.rtoks[ia]:
            for tb in strand.rtoks[ib]:
                used.add(_pair_key(ta, tb))
    return covered, callback_pairs


def _emit_multi_callbacks(
    buckets: dict[tuple[int, str], list[tuple[_Run, str]]],
    lines: list[_Line],
    order: dict[int, int],
    out: _Out,
    used: set,
    callback_pairs: set[tuple[int, int]],
    repeats: set[int],
    ending_group: dict[int, str],
    ends: dict[int, int],
) -> None:
    """A multisyllabic tail coming back from further off than the pairwise pass looks.

    ``_emit_multisyllabic`` stops at ``MULTI_LINE_WINDOW`` lines, which is the
    right bound when every run in a bucket is paired against every other one.
    The callback is the one case worth looking past it, and looking is cheap:
    the buckets are already built, one run is kept per line, and the walk over
    what is left is linear. ``CALLBACK_MIN_GAP`` puts the two halves further
    apart than that window ever reaches, so the two passes can never claim the
    same pair.
    """
    for (n, key), runs in sorted(buckets.items(), key=lambda kv: -kv[0][0]):
        if len(runs) < 2:
            continue
        # A bucket holds the same tail at every start offset, so one run per
        # line — the longest, which is the one a reader would point at.
        best: dict[int, tuple[_Run, str]] = {}
        for entry in runs:
            keep = best.get(entry[0].line)
            if keep is None or entry[0].syllables > keep[0].syllables:
                best[entry[0].line] = entry
        picked = [best[ln] for ln in sorted(best)]
        for (left, ltail), (right, rtail) in zip(picked, picked[1:]):
            gap = order[right.line] - order[left.line] - 1
            if gap < CALLBACK_MIN_GAP:
                continue
            if (left.line, right.line) in callback_pairs or right.line in repeats:
                continue
            left_cov = _tail_covered(left, n)
            right_cov = _tail_covered(right, n)
            if not left_cov or not right_cov:
                continue
            # The same words again are a refrain, and the repetition passes own
            # it; a callback is the sound coming back on different words.
            if [t.norm for t, _ in left_cov] == [t.norm for t, _ in right_cov]:
                continue
            pair = _pair_key(left_cov[-1][0], right_cov[-1][0])
            if pair in used:
                continue
            for la, _ in left_cov:
                for rb, _ in right_cov:
                    used.add(_pair_key(la, rb))
            ga = ending_group.get(left.line, "")
            at_ends = (
                ends.get(left.line) == left.end and ends.get(right.line) == right.end
            )
            if ga and at_ends and ending_group.get(right.line, "") == ga:
                group = ga
            else:
                digest = hashlib.blake2s(str(pair).encode(), digest_size=4)
                group = f"multi-{digest.hexdigest()}"
            where = _callback_where(lines, left.line, right.line)
            # Identical tails including the onset repeat a sound rather than
            # rhyme against it, and a guessed pronunciation is softer than a
            # looked-up one — both exactly as the pairwise pass weighs them.
            conf = 0.85 if ltail == rtail else 1.0
            if any(t.pron.guessed for t, _ in left_cov + right_cov):
                conf -= 0.15
            out.add(
                "callback",
                _tail_spans(left_cov) + _tail_spans(right_cov),
                label=_label(
                    "callback",
                    [
                        " ".join(t.raw for t, _ in left_cov),
                        " ".join(t.raw for t, _ in right_cov),
                    ],
                ),
                detail=f"{n} syllables returning after {gap} lines{where}: {key}",
                phones=key.split(),
                # Scored the same way the pairwise multisyllabic pass scores
                # its own matches, so the two agree about the same sound.
                confidence=conf,
                group=group,
            )
            callback_pairs.add((left.line, right.line))


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


def _sound_axis(
    lines: list[_Line], *, every_word: bool = False
) -> list[tuple[_Tok, int]]:
    """Every word a sound run could be built from, on one reading axis.

    A hiss does not stop at the end of a line, so a pass looking for one cannot
    either: the lyric lines are laid end to end, with a break standing
    SOUND_LINE_COST positions wide. That is what keeps a run that ends one line
    and opens the next joined while one that would have to reach a whole line's
    width apart stays two findings.

    Positions count only the words that can CARRY a sound. Function words are
    already excluded from every phonetic pass — "the / that / there" opens on
    DH in every other English line — so counting them here would let them spend
    a gap budget they can never be members of.

    ``every_word`` is the density passes' axis. Sibilance and plosives are a
    claim about a PROPORTION of the phones a listener hears, and a listener
    hears the /s/ of "is" and the /t/ of "it" — leaving those words out would
    make them members of neither the run nor the total it is measured against,
    which quietly changes what SIBILANCE_MIN_RATIO is a ratio of. A break costs
    the same either way.
    """
    axis: list[tuple[_Tok, int]] = []
    pos = 0
    started = False
    for line in lines:
        if not line.is_lyric or not line.anchored:
            continue
        if started:
            # The ordinary step to the next word is already one of them.
            pos += SOUND_LINE_COST - 1
        started = True
        for tok in line.toks:
            if not every_word and tok.norm in _NOISE_WORDS:
                continue
            axis.append((tok, pos))
            pos += 1
    return axis


@dataclass(frozen=True)
class _Hit:
    """One word considered as a consonant, and where it sits on the axis."""

    tok: _Tok
    pos: int


def _sound_runs(hits: list[_Hit], gap: int) -> list[list[_Hit]]:
    """Split hits on the reading axis into the runs a listener would hear.

    A run closes when the next hit sits further than ``gap`` carriers from the
    last one, or when taking it would spread the run past SOUND_LINE_REACH
    breaks. The word that closes a run opens the next one, so a hit is never
    dropped at a boundary — that was how one sound came back as two halves with
    the middle missing.
    """
    runs: list[list[_Hit]] = []
    cur: list[_Hit] = []
    on_lines: set[int] = set()
    for hit in hits:
        far = bool(cur) and hit.pos - cur[-1].pos > gap
        deep = hit.tok.line not in on_lines and len(on_lines) > SOUND_LINE_REACH
        if cur and (far or deep):
            if len(cur) >= 2:
                runs.append(cur)
            cur = []
            on_lines = set()
        cur.append(hit)
        on_lines.add(hit.tok.line)
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
    """Repeated word-initial consonants, along the line and on through the break.

    Grouped by phone and then by FAMILY, the way consonance already is: "time /
    dime" and "pale / bale" open on one sound a listener hears as one, and an
    exact-phone pass reads them as nothing. The family run is the softer claim
    and names the two phones it joined. S and SH stay apart — they are separate
    families, and that particular hiss belongs to the sibilance pass.
    """
    by_phone: dict[str, list[_Hit]] = {}
    by_family: dict[str, list[_Hit]] = {}
    phone_at: dict[tuple[int, int], str] = {}
    for tok, pos in _sound_axis(lines):
        phone = _alliterating_phone(tok)
        if not phone:
            continue
        hit = _Hit(tok=tok, pos=pos)
        by_phone.setdefault(phone, []).append(hit)
        by_family.setdefault(consonant_family(phone), []).append(hit)
        phone_at[(tok.line, tok.index)] = phone

    seen: set[tuple[tuple[int, int], ...]] = set()
    for phone, hits in sorted(by_phone.items()):
        for run in _sound_runs(hits, ALLITERATION_GAP):
            toks = [h.tok for h in run]
            # The same word again is repetition, not alliteration.
            if len({t.norm for t in toks}) < 2:
                continue
            seen.add(tuple((t.line, t.index) for t in toks))
            out.add(
                "alliteration",
                [_onset_span(t) for t in toks],
                label=_label(
                    "alliteration", _elide([t.raw for t in toks], SOUND_LABEL_WORDS)
                ),
                detail=phone,
                phones=[phone],
                group=f"allit-{toks[0].line}-{phone}-{toks[0].index}",
            )
    for family, hits in sorted(by_family.items()):
        for run in _sound_runs(hits, ALLITERATION_GAP):
            toks = [h.tok for h in run]
            key = tuple((t.line, t.index) for t in toks)
            if key in seen or len({t.norm for t in toks}) < 2:
                continue
            members = list(dict.fromkeys(phone_at[k] for k in key))
            # One phone across the whole run is the exact pass's finding,
            # reached by a different road; two or more is the family one.
            if len(members) < 2:
                continue
            seen.add(key)
            out.add(
                "alliteration",
                [_onset_span(t) for t in toks],
                label=_label(
                    "alliteration", _elide([t.raw for t in toks], SOUND_LABEL_WORDS)
                ),
                detail=" ~ ".join(members),
                phones=members,
                confidence=0.7,
                group=f"allit-{toks[0].line}-{family}-fam-{toks[0].index}",
            )

    # A whole line opening on the sound the line before it opened on is its own
    # claim — a pattern of first words rather than a run through them — and the
    # pass above cannot make it: a line's width usually puts two openers out of
    # each other's reach.
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
                label=_label(
                    "alliteration", _elide([t.raw for t in openers], SOUND_LABEL_WORDS)
                ),
                detail=f"{phone} (line openings)",
                phones=[phone],
                confidence=0.8,
                group=f"allit-open-{lyric[i].index}-{phone}",
            )
            i = j + 1
        else:
            i += 1


@dataclass
class _Carrier:
    """One word considered as a vowel: which word, which vowel, where on the
    reading axis it sits. The whole lyric lies on one axis, so a position is
    not simply a word index."""

    tok: _Tok
    vowel: str
    pos: int


def _carriers(axis: list[tuple[_Tok, int]]) -> list[_Carrier]:
    """The words of the lyric that can carry a vowel run, in reading order."""
    out: list[_Carrier] = []
    for tok, pos in axis:
        vowel = _stressed_vowel(tok)
        if vowel:
            out.append(_Carrier(tok=tok, vowel=vowel, pos=pos))
    return out


def _colour_runs(
    carriers: list[_Carrier], tolerance: float, gap: int
) -> list[list[_Carrier]]:
    """Runs of words ringing on one vowel COLOUR, within ``tolerance``.

    Every member is measured against the run's ANCHOR, never against the one
    before it. Chaining neighbour to neighbour lets a run drift the length of
    the vowel space one comfortable step at a time — "green / grin / grand /
    grunt" comes out as a single IY run — and a run that drifts is not a
    finding, it is an artefact of the walk.

    The carriers arrive on one axis for the whole lyric, so a run reaches
    through a line break; SOUND_LINE_REACH is what stops it reaching through
    the whole song.
    """
    runs: list[list[_Carrier]] = []
    for i, anchor in enumerate(carriers):
        run = [anchor]
        on_lines = {anchor.tok.line}
        for j in range(i + 1, len(carriers)):
            other = carriers[j]
            if other.pos - run[-1].pos > gap:
                break
            # Carriers arrive in reading order, so once a candidate is a break
            # too far every candidate after it is too.
            if other.tok.line not in on_lines and len(on_lines) > SOUND_LINE_REACH:
                break
            # Within tolerance of EVERY member, not merely of the anchor: two
            # vowels a tolerance either side of it are twice that far from
            # each other, and a run has to be one colour throughout.
            if all(
                vowel_colour_distance(m.vowel, other.vowel) <= tolerance for m in run
            ):
                run.append(other)
                on_lines.add(other.tok.line)
        if len(run) >= 2:
            runs.append(run)
    # Keep only the runs nothing longer already contains: the walk above starts
    # one at every word, so a four-word run also produced the three-word run
    # inside it.
    runs.sort(key=lambda r: (-len(r), r[0].pos))
    kept: list[list[_Carrier]] = []
    for run in runs:
        members = {(c.tok.line, c.tok.index) for c in run}
        if any(members <= {(c.tok.line, c.tok.index) for c in k} for k in kept):
            continue
        kept.append(run)
    return sorted(kept, key=lambda r: r[0].pos)


def _assonance_detail(run: list[_Carrier]) -> tuple[str, list[str], float]:
    """What the run rings on, the phones behind it, and how exact it is."""
    vowels = list(dict.fromkeys(c.vowel for c in run))
    if len(vowels) == 1:
        return vowels[0], vowels, 0.0
    spread = max(vowel_colour_distance(a, b) for a in vowels for b in vowels if a != b)
    return " ~ ".join(vowels), vowels, spread


def _emit_assonance_run(
    run: list[_Carrier],
    out: _Out,
    used: set,
    *,
    group: str,
) -> None:
    toks = [c.tok for c in run]
    # A bare pair that the rhyme pass already reported is that rhyme, not a
    # separate finding. Longer runs stand on their own.
    if len(toks) == 2 and _pair_key(toks[0], toks[1]) in used:
        return
    if len({(t.line, t.index) for t in toks}) < 2:
        return
    detail, vowels, spread = _assonance_detail(run)
    # Exactness is the confidence: one vowel is 1.0, and a run held together
    # at the edge of the loose tier reads as the guess it is.
    confidence = round(max(0.45, 1.0 - spread * 1.5), 3)
    if len({t.line for t in toks}) > 1:
        detail = f"{detail} (across the line break)"
        confidence = round(confidence * 0.9, 3)
    out.add(
        "assonance",
        [_vowel_span(t) for t in toks],
        label=_label("assonance", _elide([t.raw for t in toks], SOUND_LABEL_WORDS)),
        detail=detail,
        phones=vowels,
        confidence=confidence,
        group=group,
    )


def _emit_assonance(lines: list[_Line], out: _Out, used: set) -> None:
    """Vowel runs along the lyric, exact tier first.

    Assonance is a claim about the colour of a vowel, and English writes one
    colour with several symbols — "sleep" and "lift" ring together and IY/IH
    are 0.44 apart on the rhyme scale — so the exact pass runs first and the
    near tiers pick up only what it could not see. Any near run already covered
    word-for-word by an exact one is dropped, so the same play is not reported
    twice.

    All three tiers read the lyric as one axis. A vowel a writer holds through
    a quatrain was one thing they did, and reporting it as the first two lines
    of itself says less than the lyric does.
    """
    carriers = _carriers(_sound_axis(lines))
    seen: set[tuple[tuple[int, int], ...]] = set()

    def members(run: list[_Carrier]) -> tuple[tuple[int, int], ...]:
        return tuple(sorted((c.tok.line, c.tok.index) for c in run))

    for tier, tolerance in (
        ("exact", 0.0),
        ("close", ASSONANCE_CLOSE),
        ("loose", ASSONANCE_LOOSE),
    ):
        for run in _colour_runs(carriers, tolerance, ASSONANCE_GAP):
            if tier != "exact" and len(run) < ASSONANCE_MIN_NEAR:
                continue
            key = members(run)
            if key in seen:
                continue
            seen.add(key)
            anchor = run[0].tok
            _emit_assonance_run(
                run,
                out,
                used,
                group=f"asso-{anchor.line}-{run[0].vowel}-{anchor.index}-{tier}",
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
    """Repeated consonants away from the word's start.

    Grouped by FAMILY, not by phone: /s/ and /z/ are one sound wearing two
    hats ("dogs" ends in Z), and so are T/D, P/B, F/V and the nasals. An
    exact-phone pass reads "rivers of glass" as nothing and a writer hears it
    as one hiss. The exact runs still come out at full confidence; a family
    run is softer, and names the two phones it actually joined.

    Both passes read the lyric as one axis: a consonant carried on through a
    line break is one finding, and reading line by line reported it as two.
    """
    by_phone: dict[str, list[_Hit]] = {}
    by_family: dict[str, list[_Hit]] = {}
    phones_at: dict[tuple[str, int, int], list[str]] = {}
    for tok, pos in _sound_axis(lines):
        hit = _Hit(tok=tok, pos=pos)
        # Away from the word's start: an initial consonant is alliteration.
        for phone in dict.fromkeys(tok.phones[1:]):
            if phone in ARPABET_VOWELS:
                continue
            by_phone.setdefault(phone, []).append(hit)
            family = consonant_family(phone)
            fam = by_family.setdefault(family, [])
            if not fam or fam[-1].pos != pos:
                fam.append(hit)
            phones_at.setdefault((family, tok.line, tok.index), []).append(phone)

    seen: set[tuple[tuple[int, int], ...]] = set()
    for phone, hits in sorted(by_phone.items()):
        for run in _sound_runs(hits, CONSONANCE_GAP):
            if len(run) < CONSONANCE_MIN:
                continue
            toks = [h.tok for h in run]
            seen.add(tuple((t.line, t.index) for t in toks))
            out.add(
                "consonance",
                [_span(t) for t in toks],
                label=_label(
                    "consonance", _elide([t.raw for t in toks], SOUND_LABEL_WORDS)
                ),
                detail=phone,
                phones=[phone],
                confidence=0.8,
                group=f"cons-{toks[0].line}-{phone}-{toks[0].index}",
            )
    for family, hits in sorted(by_family.items()):
        for run in _sound_runs(hits, CONSONANCE_GAP):
            toks = [h.tok for h in run]
            key = tuple((t.line, t.index) for t in toks)
            if len(run) < CONSONANCE_NEAR_MIN or key in seen:
                continue
            members = list(
                dict.fromkeys(p for k in key for p in phones_at.get((family, *k), []))
            )
            # One phone across the whole run is the exact pass's finding,
            # reached by a different road; two or more is the family one.
            if len(members) < 2:
                continue
            seen.add(key)
            out.add(
                "consonance",
                [_span(t) for t in toks],
                label=_label(
                    "consonance", _elide([t.raw for t in toks], SOUND_LABEL_WORDS)
                ),
                detail=" ~ ".join(members),
                phones=members,
                confidence=0.62,
                group=f"cons-{toks[0].line}-{family}-fam-{toks[0].index}",
            )


# --- double meanings -------------------------------------------------------


def _meaning_occurrences(lines: list[_Line]) -> dict[str, list[_Tok]]:
    """Every content word of the lyric, keyed by its normalised spelling."""
    out: dict[str, list[_Tok]] = {}
    for line in lines:
        if not line.is_lyric or not line.anchored:
            continue
        for tok in line.toks:
            if tok.norm and len(tok.norm) > 1 and tok.phones:
                out.setdefault(tok.norm, []).append(tok)
    return out


def _emit_homophone_play(occurrences: dict[str, list[_Tok]], out: _Out) -> None:
    """Two spellings in the lyric that sound the same.

    The strongest double meaning there is, and the only one a dictionary can
    prove: "sole"/"soul", "their"/"there", "wait"/"weight". Every occurrence
    of both words goes in one finding, so the wire joins all of them.
    """
    words = sorted(occurrences)
    for i, first in enumerate(words):
        for second in words[i + 1 :]:
            # A word and its own plural are not a pun, and neither is a pair
            # the ear cannot separate from ordinary repetition.
            if first in second or second in first:
                continue
            if not meaning.same_sound(first, second):
                continue
            toks = sorted(
                occurrences[first] + occurrences[second],
                key=lambda t: (t.line, t.index),
            )
            phones = " ".join(toks[0].phones)
            out.add(
                "pun",
                [_span(t) for t in toks],
                label=_label("homophone", [first, second]),
                detail=f"same sound, two words — /{phones}/",
                phones=list(toks[0].phones),
                confidence=meaning.HOMOPHONE_PLAY_CONF,
                group=f"homophone-{first}-{second}",
            )


def _emit_heteronyms(occurrences: dict[str, list[_Tok]], out: _Out) -> None:
    """One spelling the reader can say two ways, meaning two things.

    "The record shows" / "record it": which one is sung is a choice, and the
    rhyme moves with it, so the fork is worth putting on the page.
    """
    for word, toks in sorted(occurrences.items()):
        glosses = meaning.heteronym_glosses(word)
        if not glosses:
            continue
        readings = meaning.heteronym_readings(word)
        detail = f"{glosses[0]} / {glosses[1]}"
        if readings:
            detail = f"{detail} — /{'/ /'.join(readings[:2])}/"
        out.add(
            "dual-meaning",
            [_span(t) for t in toks],
            label=f"heteronym: {word}",
            detail=detail,
            phones=list(toks[0].phones),
            confidence=meaning.HETERONYM_CONF,
            group=f"heteronym-{word}",
        )


def _emit_double_senses(occurrences: dict[str, list[_Tok]], out: _Out) -> None:
    """Words carrying a second sense, and the same word used twice.

    The repeat is the real finding — one word meaning two things in two places
    is the oldest pun there is — so it is the one that clears the pane's floor.
    A single use is a nudge, pitched under the floor on purpose.
    """
    for word, toks in sorted(occurrences.items()):
        glosses = meaning.double_sense_glosses(word)
        if not glosses or word in _NOISE_WORDS:
            continue
        spread = toks[-1].line - toks[0].line
        repeated = len(toks) > 1 and spread <= meaning.REPEAT_LINE_WINDOW
        out.add(
            "double-entendre" if repeated else "dual-meaning",
            [_span(t) for t in toks],
            label=(
                f"{word}, twice — two senses"
                if repeated
                else f"{word} carries two senses"
            ),
            detail=f"{glosses[0]} / {glosses[1]}",
            confidence=(
                meaning.DOUBLE_SENSE_REPEAT_CONF
                if repeated
                else meaning.DOUBLE_SENSE_CONF
            ),
            group=f"sense-{word}",
        )


def _emit_homophone_echoes(occurrences: dict[str, list[_Tok]], out: _Out) -> None:
    """One half of a homophone pair, with the other half absent.

    Not a play the lyric makes — a play it is standing next to. Pitched below
    the floor: it belongs to the writer hunting for one, not to the reader.
    """
    for word, toks in sorted(occurrences.items()):
        # Function words are excluded here and nowhere else in this pass: "to"
        # sounds like "two" in every English sentence ever written, and saying
        # so on every line buries the play the lyric is actually making.
        if word in _NOISE_WORDS:
            continue
        partners = [p for p in meaning.homophone_partners(word) if p not in occurrences]
        if not partners:
            continue
        out.add(
            "dual-meaning",
            [_span(t) for t in toks],
            label=f"{word} sounds like {' / '.join(partners)}",
            detail="the other spelling is not in the lyric — the ear cannot tell them apart",
            confidence=meaning.HOMOPHONE_ECHO_CONF,
            group=f"echo-{word}",
        )


def _emit_double_meanings(lines: list[_Line], out: _Out) -> None:
    """The meaning findings that are facts about the language, not readings.

    The interpretive ones — metaphor, irony, imagery — still need the optional
    LLM pass. These four do not, so they run on every analysis.
    """
    occurrences = _meaning_occurrences(lines)
    if not occurrences:
        return
    _emit_homophone_play(occurrences, out)
    _emit_heteronyms(occurrences, out)
    _emit_double_senses(occurrences, out)
    _emit_homophone_echoes(occurrences, out)


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
    every phone in the window).

    The window is how the density is MEASURED, not how far the finding may
    reach: a thirteen-word hiss is thirteen words, and reporting the best six
    of them threw away the rest of what the writer did. Every window that
    clears both thresholds keeps its carriers, and windows that reach one
    another are one finding.

    Those windows are cut from the same axis the other sound passes read, so a
    hiss that ends one line and opens the next is one finding instead of two
    halves of one. Distance between carriers is measured in positions on that
    axis, where a line break costs SOUND_LINE_COST rather than a whole line's
    width, and SOUND_LINE_REACH bounds how many breaks one finding may cross —
    two hisses a whole window apart are still two things the ear heard.

    A finding may only grow while it stays DENSE, which is what the reach would
    otherwise cost: join two hisses across a stretch of quiet words and the
    percentage the finding reports drops under the floor that admitted either
    half of it. So the ratio is re-measured over the span the joined finding
    actually covers, and a join that would dilute it starts a new finding
    instead. Nothing is lost that way, because every finding is at least one
    whole window that cleared both floors on its own.
    """
    axis = _sound_axis(lines, every_word=True)
    if not axis:
        return
    # Prefix sums: every question this pass asks is "how much of this stretch
    # is the sound", and re-walking a slice to answer it makes the pass
    # quadratic in the length of the lyric.
    totals = [0]
    counts = [0]
    for tok, _pos in axis:
        totals.append(totals[-1] + len(tok.phones))
        counts.append(counts[-1] + sum(1 for p in tok.phones if p in wanted))

    def measure(lo: int, hi: int) -> tuple[int, int]:
        """Carrier phones and total phones over ``axis[lo:hi]``."""
        return counts[hi] - counts[lo], totals[hi] - totals[lo]

    groups: list[list[int]] = []
    on_lines: set[int] = set()
    hi = 0
    for lo in range(len(axis)):
        # A window is DENSITY_WINDOW positions wide, not that many entries.
        # Inside a line those are the same thing; at a break they are not, and
        # that difference is the whole of how a window comes to straddle one.
        while hi < len(axis) and axis[hi][1] - axis[lo][1] < DENSITY_WINDOW:
            hi += 1
        count, total = measure(lo, hi)
        if total < 6 or count < min_count or count < min_ratio * total:
            continue
        picked = [
            k for k in range(lo, hi) if any(p in wanted for p in axis[k][0].phones)
        ]
        cur = groups[-1] if groups else []
        if cur:
            last = cur[-1]
            gap = max(0, axis[picked[0]][1] - axis[last][1])
            reach = on_lines | {axis[k][0].line for k in picked}
            joined, spanned = measure(cur[0], max(last, picked[-1]) + 1)
            if (
                gap <= DENSITY_WINDOW
                and len(reach) <= SOUND_LINE_REACH + 1
                and joined >= min_ratio * spanned
            ):
                cur.extend(k for k in picked if k > last)
                on_lines = reach
                continue
        groups.append(picked)
        on_lines = {axis[k][0].line for k in picked}

    for carriers in groups:
        toks = [axis[k][0] for k in carriers]
        # Over the span the finding covers, edge to edge — not over the window
        # that found it. Both floors hold here by construction: the group is
        # built out of whole windows that cleared them, and a join that would
        # not have is a group of its own.
        count, total = measure(carriers[0], carriers[-1] + 1)
        ratio = count / total
        detail = f"{count} phones, {round(ratio * 100)}% of the run"
        if len({t.line for t in toks}) > 1:
            detail = f"{detail} (across the line break)"
        out.add(
            kind,
            [_span(t) for t in toks],
            label=_label(kind, _elide([t.raw for t in toks], SOUND_LABEL_WORDS)),
            detail=detail,
            phones=sorted({p for t in toks for p in t.phones if p in wanted}),
            confidence=min(1.0, 0.6 + ratio),
            group=f"{kind}-{toks[0].line}-{toks[0].index}",
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
    #
    # The shape pass goes first, ahead of even the multisyllabic one, for the
    # two-ending shapes: a callback IS a pair, and "liar / desire returns after
    # six lines" says everything "2 syllables: AY ER" says and then the thing
    # that matters. The three-or-more shapes claim nothing in that chain — the
    # multisyllabic rhymes inside a rap run are the best findings in the pane —
    # and suppress only the pairwise end rhymes they contain, via ``covered``.
    used: set = set()
    order = _lyric_order(lines)
    repeats = _repeated_lines(lines)
    covered, callback_pairs = _emit_scheme_shapes(
        _strands(classes, order), lines, sects, repeats, out, used
    )
    buckets = _multi_buckets(lines)
    _emit_multisyllabic(buckets, out, used, ending_group, ends)
    _emit_multi_callbacks(
        buckets, lines, order, out, used, callback_pairs, repeats, ending_group, ends
    )
    _emit_end_rhymes(classes, out, used, covered)
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
    _emit_double_meanings(lines, out)

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
