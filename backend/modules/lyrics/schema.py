"""LyricsDoc v1: the one timed-lyrics document per library entry.

Pure models and converters, no I/O. The JSON shape is mirrored byte-for-byte
by ``frontend/src/lib/lyricsClient.ts``. Times are project-relative
milliseconds; ``None`` means untimed. ``offset_ms`` is never baked into the
stored times: the player adds it at playback and the LRC exporter writes it
as ``[offset:]``.
"""

from __future__ import annotations

import re
from typing import Literal, Optional

from pydantic import BaseModel, Field

from backend.modules.vocal.schema import TIMING_UNIT, Lyrics, Phrase, Word

DOC_VERSION = 1
ARTIFACT_KIND = "lyrics"

# "[Chorus]", "(bridge)", "[Verse 2]": a section marker, never sung.
MARKER_RE = re.compile(r"^\s*[\[\(][^\]\)]{1,40}[\]\)]\s*$")

SOURCES = (
    "",
    "manual",
    "suno",
    "tags",
    "embedded",
    "notes",
    "transcribed",
    "aligned",
    "lrc",
    "tap",
)

# A timed word or line is never shorter than this.
MIN_WORD_MS = 40


class LyricWord(BaseModel):
    text: str
    start_ms: Optional[int] = None
    end_ms: Optional[int] = None
    # What whisper heard where this word should be, when it was NOT this word
    # (ALIGN sets it; ``""`` means whisper heard nothing there). ``None`` means
    # the word matched, or no alignment has run.
    heard: Optional[str] = None


class LyricLine(BaseModel):
    text: str
    kind: Literal["lyric", "marker"] = "lyric"
    start_ms: Optional[int] = None
    end_ms: Optional[int] = None
    confidence: Optional[float] = None
    words: list[LyricWord] = Field(default_factory=list)


class LyricsStats(BaseModel):
    matched: int = 0
    total: int = 0
    asr_words: int = 0
    audio_source: str = ""
    # Words whose ``heard`` is set: the pasted text and the vocal disagree there.
    mismatched: int = 0
    # What produced the timings: "mms" (forced alignment of the user's words)
    # or "whisper" (whisper's words matched to the user's). "" = untimed.
    aligner: str = ""
    # The whisper review pass ran AND could follow the vocal well enough for
    # its differences to mean anything (else nothing is flagged).
    reviewed: bool = False


class LyricsDoc(BaseModel):
    version: int = DOC_VERSION
    entry_id: str
    timing_unit: str = TIMING_UNIT
    language: str = "en"
    source: str = ""
    text: str = ""
    offset_ms: int = 0
    lines: list[LyricLine] = Field(default_factory=list)
    stats: Optional[LyricsStats] = None
    updated_at: float = 0.0


class PutLyricsRequest(BaseModel):
    """A text-only body is the editor path (timings carry over by line diff);
    ``lines`` is the full document from the tap/nudge UI."""

    text: Optional[str] = None
    lines: Optional[list[LyricLine]] = None
    offset_ms: Optional[int] = None
    language: Optional[str] = None
    source: Optional[str] = None


class TranscribeRequest(BaseModel):
    """``language`` is a whisper code (``en``, ``es``, ``ja`` ...) or ``auto``
    to let whisper detect it; the detected code lands on the document."""

    language: str = "auto"
    isolate: bool = True
    sync_vocal: bool = False


class AlignRequest(TranscribeRequest):
    text: Optional[str] = None
    # 'mms' | 'whisper' | '' (the lyrics.aligner setting decides).
    aligner: str = ""
    # After a forced alignment, run the whisper review pass (heard flags).
    review: bool = True


class ImportRequest(BaseModel):
    format: Literal["lrc", "txt"]
    content: str


def words_for(text: str) -> list[LyricWord]:
    """Untimed whitespace tokens of a lyric line."""
    return [LyricWord(text=w) for w in text.split()]


def split_text(text: str) -> list[LyricLine]:
    """Plain text -> lines. Blank runs collapse to one blank line (leading and
    trailing blanks are dropped), marker lines are classified by MARKER_RE,
    lyric lines get untimed words."""
    lines: list[LyricLine] = []
    blank_run = False
    normalized = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    for raw in normalized.split("\n"):
        t = raw.rstrip()
        if not t.strip():
            if blank_run or not lines:
                continue
            blank_run = True
            lines.append(LyricLine(text=""))
            continue
        blank_run = False
        if MARKER_RE.match(t):
            lines.append(LyricLine(text=t.strip(), kind="marker"))
        else:
            lines.append(LyricLine(text=t, kind="lyric", words=words_for(t)))
    while lines and not lines[-1].text:
        lines.pop()
    return lines


def join_lines(lines: list[LyricLine]) -> str:
    return "\n".join(line.text for line in lines)


def to_vocal_lyrics(doc: LyricsDoc) -> Lyrics:
    """The vocal artifact's Lyrics shape: every fully timed word becomes a
    Word, every timed line a Phrase."""
    words: list[Word] = []
    phrases: list[Phrase] = []
    for line in doc.lines:
        if line.kind != "lyric":
            continue
        if line.start_ms is not None and line.end_ms is not None and line.text.strip():
            phrases.append(
                Phrase(text=line.text, start_ms=line.start_ms, end_ms=line.end_ms)
            )
        for w in line.words:
            if w.start_ms is not None and w.end_ms is not None:
                words.append(Word(text=w.text, start_ms=w.start_ms, end_ms=w.end_ms))
    return Lyrics(
        language=doc.language,
        text=doc.text,
        words=words,
        phrases=phrases,
        source=doc.source or "transcribed",
    )


def from_vocal_lyrics(entry_id: str, lyrics: Lyrics) -> LyricsDoc:
    """The reverse: phrases become lines; each word joins the phrase whose
    span covers its start, else the nearest one. Without phrases every word
    lands on one line."""
    phrases = sorted(lyrics.phrases, key=lambda p: p.start_ms)
    lines: list[LyricLine] = []
    if phrases:
        buckets: list[list[Word]] = [[] for _ in phrases]
        for w in lyrics.words:
            best = -1
            for i, p in enumerate(phrases):
                if p.start_ms <= w.start_ms <= p.end_ms:
                    best = i
                    break
            if best < 0:
                best = min(
                    range(len(phrases)),
                    key=lambda i: min(
                        abs(w.start_ms - phrases[i].start_ms),
                        abs(w.start_ms - phrases[i].end_ms),
                    ),
                )
            buckets[best].append(w)
        for p, bucket in zip(phrases, buckets):
            bucket.sort(key=lambda w: w.start_ms)
            words = [
                LyricWord(text=w.text, start_ms=w.start_ms, end_ms=w.end_ms)
                for w in bucket
            ]
            if not words:
                words = words_for(p.text)
            lines.append(
                LyricLine(
                    text=p.text,
                    kind="lyric",
                    start_ms=p.start_ms,
                    end_ms=p.end_ms,
                    confidence=1.0,
                    words=words,
                )
            )
    elif lyrics.words:
        ws = sorted(lyrics.words, key=lambda w: w.start_ms)
        lines.append(
            LyricLine(
                text=" ".join(w.text for w in ws),
                kind="lyric",
                start_ms=ws[0].start_ms,
                end_ms=ws[-1].end_ms,
                confidence=1.0,
                words=[
                    LyricWord(text=w.text, start_ms=w.start_ms, end_ms=w.end_ms)
                    for w in ws
                ],
            )
        )
    elif lyrics.text.strip():
        lines = split_text(lyrics.text)
    return LyricsDoc(
        entry_id=entry_id,
        language=lyrics.language or "en",
        source="transcribed",
        text=join_lines(lines),
        lines=lines,
    )
