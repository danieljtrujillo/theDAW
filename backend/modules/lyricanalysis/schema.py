"""LyricAnalysisDoc v1: the one literary-analysis document per library entry.

Pure models, no I/O. The JSON shape is mirrored byte-for-byte by
``frontend/src/lib/lyricAnalysisClient.ts``.

Every finding is anchored to the *lyrics* document it was derived from, using
``LyricsDoc`` coordinates: ``line`` indexes ``doc.lines``, ``word`` indexes
``doc.lines[line].words``. That is what lets the SING tab paint a device onto
the same word spans the karaoke already highlights, and the SCORE strip put it
under the right bar — no re-tokenising on the frontend, ever.

A finding may cover part of a word (the second half of a multisyllabic rhyme,
one syllable of an internal rhyme), so a span carries character offsets into
``word.text`` as well.
"""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field

DOC_VERSION = 1
ARTIFACT_KIND = "lyricanalysis"
DOC_FILENAME = "lyric_analysis.json"

# Bumped whenever the detectors change what they emit, so a stored document
# from an older build is reported stale and can be recomputed. 2: the sound
# passes read the lyric as one axis, so a run of alliteration, assonance,
# consonance or density reaches as far as the ear does instead of stopping at
# the end of a line or at the edge of a six-word window.
ANALYZER_VERSION = 2

# --- device taxonomy -------------------------------------------------------
#
# ``family`` groups devices for the UI (one filter row and one colour ramp per
# family); ``kind`` is the specific device. Deterministic families are computed
# from the words themselves and are reproducible; ``meaning`` is interpretive
# and only ever populated by the optional LLM pass.

DeviceFamily = Literal["rhyme", "sound", "repetition", "structure", "meaning"]

RHYME_KINDS = (
    "end-rhyme",  # line-final rhyme, the thing the scheme letters describe
    "internal-rhyme",  # two rhyming words inside one line
    "leonine-rhyme",  # a mid-line word rhyming with that line's last word
    "cross-line-rhyme",  # mid-line word rhyming with a mid-line word nearby
    "multisyllabic-rhyme",  # >= 2 syllables matching across a run of words
    "slant-rhyme",  # near miss: shared nucleus or near-identical coda
    "pararhyme",  # same consonant frame, different vowel (read / ride)
    "identical-rhyme",  # the same word, or a homophone, rhymed with itself
    "eye-rhyme",  # spelling rhymes, sound does not (love / move)
    # --- shape of a scheme over distance, not a single pair ---
    "rhyme-run",  # N consecutive lines on one rhyme class (a monorhyme run)
    "rhyme-chain",  # one class threaded across a long stretch, gaps included
    "callback",  # a class returning after a long gap, or in a later section
    "bookend",  # a section's first and last line rhyming with each other
)

SOUND_KINDS = (
    "alliteration",  # repeated word-initial consonant
    "assonance",  # repeated stressed vowel
    "consonance",  # repeated consonant away from the word's start
    "sibilance",  # a run of s/z/sh/zh/ch/jh
    "plosive",  # a run of p/b/t/d/k/g
    "onomatopoeia",
)

REPETITION_KINDS = (
    "anaphora",  # consecutive lines opening with the same words
    "epistrophe",  # consecutive lines closing with the same words
    "symploce",  # both at once
    "anadiplosis",  # a line ends on the word the next line starts with
    "epizeuxis",  # a word repeated back to back
    "polyptoton",  # the same root in a different form (run / running)
    "antimetabole",  # A B ... B A
    "refrain",  # a whole line repeated
)

STRUCTURE_KINDS = (
    "enjambment",  # the sentence runs on past the line break
    "caesura",  # a strong break inside the line
    "meter",  # a line whose stress pattern fits a named foot
)

MEANING_KINDS = (
    "pun",
    "double-entendre",
    "dual-meaning",
    "metaphor",
    "simile",
    "personification",
    "hyperbole",
    "understatement",
    "oxymoron",
    "paradox",
    "irony",
    "imagery",
    "symbolism",
    "motif",
    "metonymy",
    "synecdoche",
    "allusion",
    "apostrophe",
    "juxtaposition",
)

DEVICE_KINDS = (
    RHYME_KINDS + SOUND_KINDS + REPETITION_KINDS + STRUCTURE_KINDS + MEANING_KINDS
)

FAMILY_OF: dict[str, str] = {
    **{k: "rhyme" for k in RHYME_KINDS},
    **{k: "sound" for k in SOUND_KINDS},
    **{k: "repetition" for k in REPETITION_KINDS},
    **{k: "structure" for k in STRUCTURE_KINDS},
    **{k: "meaning" for k in MEANING_KINDS},
}


class Span(BaseModel):
    """One highlighted stretch of a lyric, in ``LyricsDoc`` coordinates.

    ``char_start``/``char_end`` are offsets into ``word.text`` (``char_end``
    ``None`` means "to the end of the word"), so a device can mark the ``-ation``
    of ``celebration`` without splitting the karaoke word.
    """

    line: int
    word: int
    char_start: int = 0
    char_end: Optional[int] = None
    # The literal text this span covers, denormalised so the UI can render a
    # findings list without walking back into the lyrics document.
    text: str = ""


class Device(BaseModel):
    """One detected literary device.

    Devices that are two halves of the same thing (the two words of a rhyme,
    every line of an anaphora) share a ``group``; the UI paints one colour per
    group and lets you step between its spans.
    """

    id: str
    kind: str
    family: str
    # Human label for the findings list, e.g. "internal rhyme: chasing / racing".
    label: str
    group: str = ""
    spans: list[Span] = Field(default_factory=list)
    # Why the detector fired: the shared phone tail, the repeated vowel, the
    # foot name — short enough to sit in a tooltip.
    detail: str = ""
    # ARPABET phones backing a phonetic device, for the "show me the sounds" view.
    phones: list[str] = Field(default_factory=list)
    # 1.0 for an exact match; lower for slant rhymes and for anything the LLM
    # proposed. The UI has a confidence floor slider.
    confidence: float = 1.0
    source: Literal["rules", "llm"] = "rules"


class LineMetrics(BaseModel):
    """Per-line numbers the rhyme map and the meter view are drawn from."""

    line: int
    # Rhyme-scheme letter for this line's ending: "A", "B", ... "" when the line
    # is untimed, a marker, or rhymes with nothing.
    letter: str = ""
    syllables: int = 0
    words: int = 0
    # One character per syllable: "1" primary, "2" secondary, "0" unstressed.
    stress: str = ""
    # The rhyme key this line ended on (phones from the last stressed vowel).
    end_key: str = ""
    end_phones: list[str] = Field(default_factory=list)
    # Section this line belongs to, from the lyrics document's own markers
    # ("[Chorus]"), so the scheme can be read per section.
    section: str = ""


class SectionSummary(BaseModel):
    """A marker-delimited block of the lyric and its scheme."""

    name: str
    start_line: int
    end_line: int
    # "ABAB", "AABB", "AAAA" ... one letter per lyric line in the section.
    scheme: str = ""
    lines: int = 0
    syllables: int = 0


class AnalysisStats(BaseModel):
    lines: int = 0
    words: int = 0
    syllables: int = 0
    unique_words: int = 0
    # Type/token ratio: distinct words over total words, the usual crude
    # vocabulary-richness number.
    ttr: float = 0.0
    # Share of lines whose ending rhymes with at least one other line.
    rhyme_density: float = 0.0
    # Rhymes spanning two or more syllables — the thing that separates a rap
    # scheme from a nursery rhyme.
    multisyllabic_rhymes: int = 0
    avg_syllables_per_line: float = 0.0
    # Words with no dictionary pronunciation, which the phonetic detectors had
    # to guess at. High counts mean the rhyme findings are softer than they look.
    guessed_pronunciations: int = 0
    devices_by_kind: dict[str, int] = Field(default_factory=dict)
    devices_by_family: dict[str, int] = Field(default_factory=dict)


class LlmPass(BaseModel):
    """Provenance of the interpretive pass, when one ran."""

    provider: str = ""
    model: str = ""
    ran_at: float = 0.0
    # Set when the pass was asked for but could not run (no key, bad JSON).
    error: str = ""


class LyricAnalysisDoc(BaseModel):
    version: int = DOC_VERSION
    analyzer_version: int = ANALYZER_VERSION
    entry_id: str
    language: str = "en"
    # ``LyricsDoc.updated_at`` this analysis was computed from. When the stored
    # lyrics move past it, the analysis is stale and the UI says so.
    source_updated_at: float = 0.0
    # Hash of the lyric text the analysis actually read. Derived (unsaved)
    # lyrics never set ``updated_at``, so for those the timestamp stays 0.0 and
    # could never detect a change; the hash is what makes them go stale. Empty
    # on a document written before this field existed, and then the timestamp
    # is used instead rather than declaring every old analysis stale.
    source_text_hash: str = ""
    # The pronunciation source actually used: "cmudict", "rules", or "mixed".
    pronunciation_source: str = "rules"
    devices: list[Device] = Field(default_factory=list)
    lines: list[LineMetrics] = Field(default_factory=list)
    sections: list[SectionSummary] = Field(default_factory=list)
    # Whole-lyric scheme, sections joined by a space: "ABAB CDCD EFEF".
    scheme: str = ""
    stats: AnalysisStats = Field(default_factory=AnalysisStats)
    llm: Optional[LlmPass] = None
    updated_at: float = 0.0


# --- requests --------------------------------------------------------------


# --- the writer's own marks --------------------------------------------------
#
# A detector is a reader with a dictionary, and it will always miss things a
# writer hears: a rhyme that only works in delivery, a callback across a whole
# song, a pun the phonetics cannot see. Marks are the writer's answer to that —
# they sit beside the detected devices, they are never overwritten by a re-run,
# and a `reject` mark suppresses a finding the engine got wrong.

MARK_VERDICTS = ("mark", "confirm", "reject")


class LyricMark(BaseModel):
    """One annotation a writer made on their own lyric."""

    id: str
    # A device kind when the writer is naming one ("internal-rhyme"), or "" for
    # a free note. Unknown kinds are allowed: the writer may hear something the
    # taxonomy has no word for.
    kind: str = ""
    label: str = ""
    # Marks sharing a group are one thing — the members of a rhyme the writer
    # picked out by hand.
    group: str = ""
    spans: list[Span] = Field(default_factory=list)
    note: str = ""
    # "mark": the writer's own annotation, shown alongside the analysis.
    # "confirm": the engine missed this and it IS real — kept as ground truth.
    # "reject": the engine found this and it is wrong — suppressed on display.
    verdict: Literal["mark", "confirm", "reject"] = "mark"
    # For a reject, the `Device.id` being rejected, so a re-run can suppress it
    # again even though device ids are regenerated.
    target_group: str = ""
    created_at: float = 0.0
    updated_at: float = 0.0


class PutLyricMarksRequest(BaseModel):
    """Replace the whole mark set for a document — the editor owns the list."""

    marks: list[LyricMark] = Field(default_factory=list)


class AnalyzeTextRequest(BaseModel):
    """Stateless analysis of pasted text, with no library entry involved."""

    text: str = ""
    language: str = "en"


class RunRequest(BaseModel):
    """Analyse a library entry's timed lyrics, optionally with the LLM pass."""

    force: bool = False
    llm: bool = False
    provider: str = ""
    model: str = ""
    api_key: str = ""


# --- standalone lyric documents ---------------------------------------------
#
# A lyric written in the LYRIC tab belongs to no library entry: it is a page in
# a notebook, and only becomes a song's lyrics when the writer says so. These
# live in their own directory (``documents.py``), not in an entry folder, and
# carry their own analysis beside them.

LYRIC_DOCUMENT_VERSION = 1


class LyricDocument(BaseModel):
    """One standalone lyric draft."""

    version: int = LYRIC_DOCUMENT_VERSION
    id: str
    title: str = ""
    text: str = ""
    language: str = "en"
    # The library entry this draft was last saved into. Empty while it belongs
    # to no song — which is the whole point of the notebook.
    entry_id: str = ""
    created_at: float = 0.0
    updated_at: float = 0.0


class LyricDocumentSummary(BaseModel):
    """A row of the document switcher: enough to pick one without loading it."""

    id: str
    title: str = ""
    updated_at: float = 0.0
    created_at: float = 0.0
    # Lyric lines only — markers and blanks are not counted, so the number
    # matches the one the analysis reports.
    lines: int = 0
    words: int = 0
    # ``None`` when the draft is attached to nothing.
    entry_id: Optional[str] = None
    # An analysis has been stored for this document at least once.
    analyzed: bool = False


class CreateLyricDocumentRequest(BaseModel):
    title: str = ""
    text: str = ""
    language: str = "en"
    entry_id: str = ""


class UpdateLyricDocumentRequest(BaseModel):
    """Every field is optional: the editor PUTs only what it changed. Passing
    ``entry_id`` as an empty string detaches the draft from its song."""

    title: Optional[str] = None
    text: Optional[str] = None
    language: Optional[str] = None
    entry_id: Optional[str] = None


class AttachLyricDocumentRequest(BaseModel):
    entry_id: str = ""
    # Also write the draft into that entry's own lyrics document, through the
    # lyrics service, so SING sees the words immediately.
    write_lyrics: bool = False


class ImportLyricDocumentRequest(BaseModel):
    """Start a new document from an entry's existing lyrics."""

    entry_id: str = ""
    title: str = ""
