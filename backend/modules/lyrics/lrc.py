"""LRC parsing and formatting, stdlib only.

Supports the plain ``[mm:ss.xx]`` line format, multiple tags on one line,
enhanced ``<mm:ss.xx>`` word tags, the ``[ti:]`` ``[ar:]`` ``[al:]``
``[length:]`` ``[by:]`` header tags and ``[offset:]``.

Offset sign: LRC's ``[offset:+200]`` means "show the lyrics 200 ms EARLIER",
i.e. subtract 200 from every tag. Our ``LyricsDoc.offset_ms`` is ADDED to the
player clock (positive = the lyrics arrive later), so the two are inverses:
``parse_lrc`` returns ``offset_ms = -value`` and ``format_lrc`` writes
``[offset:-offset_ms]``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional

from .schema import MARKER_RE, LyricLine, LyricWord, LyricsDoc, join_lines, words_for

TIME_RE = re.compile(r"\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]")
WORD_RE = re.compile(r"<(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?>")
_LEAD_TAGS_RE = re.compile(r"^((?:\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\])+)(.*)$")
_HEADER_RE = re.compile(r"^\[([A-Za-z]+):(.*)\]\s*$")
_HEADER_KEYS = {"ti", "ar", "al", "length", "offset", "by", "re", "ve", "au"}


@dataclass
class ParsedLrc:
    lines: list[LyricLine] = field(default_factory=list)
    offset_ms: int = 0
    tags: dict[str, str] = field(default_factory=dict)


def _tag_ms(mm: str, ss: str, frac: Optional[str]) -> int:
    ms = int(mm) * 60_000 + int(ss) * 1000
    if frac:
        # 1 digit = tenths, 2 = centiseconds, 3 = milliseconds.
        ms += int(frac) * (10 ** (3 - len(frac)))
    return ms


def _parse_body(body: str) -> tuple[str, list[LyricWord]]:
    """Split a line body into its display text and its words; enhanced
    ``<mm:ss.xx>`` tags before a chunk give that chunk's start."""
    if not WORD_RE.search(body):
        text = body.strip()
        return text, words_for(text)
    words: list[LyricWord] = []
    pos = 0
    pending_start: Optional[int] = None
    for m in WORD_RE.finditer(body):
        chunk = body[pos : m.start()].strip()
        if chunk:
            for i, tok in enumerate(chunk.split()):
                words.append(
                    LyricWord(text=tok, start_ms=pending_start if i == 0 else None)
                )
            pending_start = None
        pending_start = _tag_ms(m.group(1), m.group(2), m.group(3))
        pos = m.end()
    tail = body[pos:].strip()
    if tail:
        for i, tok in enumerate(tail.split()):
            words.append(
                LyricWord(text=tok, start_ms=pending_start if i == 0 else None)
            )
    elif pending_start is not None and words:
        # A trailing tag with no word after it marks the line end.
        words[-1].end_ms = pending_start
    # A word ends where the next timed word starts.
    for i, w in enumerate(words):
        if w.start_ms is None or w.end_ms is not None:
            continue
        for nxt in words[i + 1 :]:
            if nxt.start_ms is not None:
                w.end_ms = nxt.start_ms
                break
    text = " ".join(w.text for w in words)
    return text, words


def parse_lrc(text: str) -> ParsedLrc:
    out = ParsedLrc()
    entries: list[tuple[int, int, LyricLine]] = []  # (sort key, seq, line)
    seq = 0
    last_timed = -1
    normalized = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    for raw in normalized.split("\n"):
        line = raw.strip()
        header = _HEADER_RE.match(line)
        if (
            header
            and header.group(1).lower() in _HEADER_KEYS
            and not TIME_RE.match(line)
        ):
            key = header.group(1).lower()
            value = header.group(2).strip()
            if key == "offset":
                try:
                    out.offset_ms = -int(float(value))
                except ValueError:
                    pass
            else:
                out.tags[key] = value
            continue
        lead = _LEAD_TAGS_RE.match(line)
        if not lead:
            # Untimed text, a blank, or a malformed tag: kept as plain text.
            plain = line
            if MARKER_RE.match(plain):
                entries.append((last_timed, seq, LyricLine(text=plain, kind="marker")))
            else:
                entries.append(
                    (last_timed, seq, LyricLine(text=plain, words=words_for(plain)))
                )
            seq += 1
            continue
        starts = [
            _tag_ms(mm, ss, frac) for mm, ss, frac in TIME_RE.findall(lead.group(1))
        ]
        body_text, words = _parse_body(lead.group(2))
        kind = "marker" if MARKER_RE.match(body_text) else "lyric"
        last_timed = max(starts)
        for start in sorted(starts):
            if kind == "marker":
                entry = LyricLine(text=body_text, kind="marker", start_ms=start)
            else:
                ws = [
                    LyricWord(text=w.text, start_ms=w.start_ms, end_ms=w.end_ms)
                    for w in words
                ]
                if ws and ws[0].start_ms is None:
                    ws[0].start_ms = start
                entry = LyricLine(
                    text=body_text, kind="lyric", start_ms=start, words=ws
                )
            entries.append((start, seq, entry))
            seq += 1
    entries.sort(key=lambda e: (e[0], e[1]))
    lines = [e[2] for e in entries]
    # A timed line ends where the next timed line starts.
    timed = [i for i, ln in enumerate(lines) if ln.start_ms is not None]
    for a, b in zip(timed, timed[1:]):
        if lines[a].end_ms is None:
            lines[a].end_ms = lines[b].start_ms
        last = lines[a].words[-1] if lines[a].words else None
        if last is not None and last.start_ms is not None and last.end_ms is None:
            last.end_ms = lines[b].start_ms
    # Blank text at the very top or bottom is file padding, not a lyric.
    while lines and not lines[0].text and lines[0].start_ms is None:
        lines.pop(0)
    while lines and not lines[-1].text and lines[-1].start_ms is None:
        lines.pop()
    out.lines = lines
    return out


def ms_to_tag(ms: int, bracket: str = "[]") -> str:
    ms = max(0, int(round(ms)))
    minutes, rest = divmod(ms, 60_000)
    seconds, millis = divmod(rest, 1000)
    centi = (millis + 5) // 10
    if centi >= 100:
        centi = 99
    return f"{bracket[0]}{minutes:02d}:{seconds:02d}.{centi:02d}{bracket[1]}"


def format_lrc(
    doc: LyricsDoc,
    *,
    title: str = "",
    artist: str = "",
    duration_ms: Optional[int] = None,
    words: bool = False,
) -> str:
    out: list[str] = []
    if title:
        out.append(f"[ti:{title}]")
    if artist:
        out.append(f"[ar:{artist}]")
    if duration_ms is not None and duration_ms > 0:
        minutes, rest = divmod(int(duration_ms), 60_000)
        out.append(f"[length:{minutes:02d}:{rest // 1000:02d}]")
    if doc.offset_ms:
        out.append(f"[offset:{-int(doc.offset_ms)}]")
    for line in doc.lines:
        if line.start_ms is None:
            out.append(line.text)
            continue
        tag = ms_to_tag(line.start_ms)
        if (
            words
            and line.kind == "lyric"
            and any(w.start_ms is not None for w in line.words)
        ):
            parts = []
            for w in line.words:
                if w.start_ms is not None:
                    parts.append(f"{ms_to_tag(w.start_ms, '<>')}{w.text}")
                else:
                    parts.append(w.text)
            out.append(f"{tag}{' '.join(parts)}")
        else:
            out.append(f"{tag}{line.text}")
    return "\n".join(out) + ("\n" if out else "")


def format_txt(doc: LyricsDoc) -> str:
    return join_lines(doc.lines)
