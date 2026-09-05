"""Transfer whisper's word TIMES onto the user's own lyric words.

Whisper's words are never trusted as text: the pasted lyrics are the truth.
Both sides are normalized to bare tokens, ``difflib.SequenceMatcher`` finds
the in-order matching runs (anchors), a bounded fuzzy pass fills small gaps,
and every unmatched user word is placed proportionally between its
neighbouring anchors (or extrapolated at the edges). The result is monotonic
and every timed word is at least ``MIN_WORD_MS`` long. Pure and
deterministic; stdlib only.
"""

from __future__ import annotations

import re
import statistics
import unicodedata
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Any, Optional

from .schema import LyricLine, LyricsStats, LyricWord

STOPWORDS = {
    "a", "i", "an", "the", "to", "of", "in", "on", "and", "it", "is", "my",
    "me", "oh", "yeah", "na", "la",
}  # fmt: skip
MAX_TOKENS = 6000
MIN_WORD_MS = 60
FUZZY_MIN_RATIO = 0.75
FUZZY_GAP_MAX = 12
# Fallback word duration when nothing matched, ms.
DEFAULT_WORD_MS = 300
LOW_CONFIDENCE = 0.3
GOOD_CONFIDENCE = 0.6

_REPEAT_RE = re.compile(r"(.)\1{2,}")
_KEEP_RE = re.compile(r"[^a-z0-9]+")

AsrWord = dict[str, Any]


@dataclass
class Token:
    line_idx: int
    word_idx: int
    raw: str
    norm: str


@dataclass
class _Timed:
    start: int
    end: int


def normalize_token(s: str) -> str:
    """NFKD, casefold, strip accents and everything but [a-z0-9], collapse
    3+ repeated letters to 2 ("yeahhh" -> "yeahh"), drop apostrophes
    ("don't" -> "dont")."""
    decomposed = unicodedata.normalize("NFKD", s or "")
    stripped = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    low = stripped.casefold().replace("’", "").replace("'", "")
    kept = _KEEP_RE.sub("", low)
    return _REPEAT_RE.sub(lambda m: m.group(1) * 2, kept)


def tokenize(lines: list[LyricLine]) -> list[Token]:
    """Alignable tokens: lyric lines only, words split on hyphens, empty
    normalizations skipped."""
    tokens: list[Token] = []
    for li, line in enumerate(lines):
        if line.kind != "lyric" or not line.text.strip():
            continue
        for wi, word in enumerate(line.words):
            for part in word.text.split("-"):
                norm = normalize_token(part)
                if norm:
                    tokens.append(Token(li, wi, part, norm))
    return tokens


def _anchors(user: list[str], asr: list[str]) -> list[tuple[int, int]]:
    matcher = SequenceMatcher(None, user, asr, autojunk=False)
    pairs: list[tuple[int, int]] = []
    for i, j, n in matcher.get_matching_blocks():
        if n == 0:
            continue
        if n == 1 and (len(user[i]) <= 2 or user[i] in STOPWORDS):
            continue
        for k in range(n):
            pairs.append((i + k, j + k))
    return pairs


def _fuzzy_fill(
    user: list[str], asr: list[str], anchors: list[tuple[int, int]]
) -> list[tuple[int, int]]:
    bounds = [(-1, -1), *anchors, (len(user), len(asr))]
    extra: list[tuple[int, int]] = []
    for (ai, aj), (bi, bj) in zip(bounds, bounds[1:]):
        gap_user = range(ai + 1, bi)
        gap_asr = range(aj + 1, bj)
        if not (
            1 <= len(gap_user) <= FUZZY_GAP_MAX and 1 <= len(gap_asr) <= FUZZY_GAP_MAX
        ):
            continue
        cursor = gap_asr.start
        for ui in gap_user:
            if len(user[ui]) <= 2 or user[ui] in STOPWORDS:
                continue  # a stray short word is never evidence on its own
            for aj2 in range(cursor, gap_asr.stop):
                if SequenceMatcher(None, user[ui], asr[aj2]).ratio() >= FUZZY_MIN_RATIO:
                    extra.append((ui, aj2))
                    cursor = aj2 + 1
                    break
    return sorted(set(anchors) | set(extra))


def _sec_ms(sec: Any) -> int:
    return int(round(float(sec) * 1000.0))


def _spread(weights: list[int], t0: int, t1: int) -> list[_Timed]:
    """Place words proportionally to their weight across [t0, t1]."""
    total = max(1, sum(weights))
    span = max(0, t1 - t0)
    out: list[_Timed] = []
    acc = 0
    for w in weights:
        start = t0 + span * acc // total
        acc += w
        end = t0 + span * acc // total
        out.append(_Timed(start, end))
    return out


def _place_tokens(
    tokens: list[Token],
    matched: dict[int, _Timed],
    duration_ms: int,
) -> list[Optional[_Timed]]:
    """Every token gets a time: matched ones keep theirs, runs between
    anchors are spread proportionally, the edges extrapolate with the median
    matched duration."""
    n = len(tokens)
    if not matched:
        return [None] * n
    durations = [max(MIN_WORD_MS, t.end - t.start) for t in matched.values()]
    median = int(statistics.median(durations)) if durations else DEFAULT_WORD_MS
    median = max(MIN_WORD_MS, median)
    placed: list[Optional[_Timed]] = [None] * n
    for i, t in matched.items():
        placed[i] = _Timed(t.start, t.end)
    keys = sorted(matched)
    weight = [len(tok.norm) + 1 for tok in tokens]

    # Before the first anchor: walk backwards, one median per token.
    first = keys[0]
    cursor = matched[first].start
    for i in range(first - 1, -1, -1):
        end = cursor
        start = max(0, end - median)
        placed[i] = _Timed(start, max(start, end))
        cursor = start
    # Between anchors.
    for a, b in zip(keys, keys[1:]):
        if b - a <= 1:
            continue
        run = list(range(a + 1, b))
        spread = _spread([weight[i] for i in run], matched[a].end, matched[b].start)
        for i, t in zip(run, spread):
            placed[i] = t
    # After the last anchor: forwards, one median per token while the song
    # has room, else spread across whatever room is left.
    last = keys[-1]
    cursor = matched[last].end
    tail = list(range(last + 1, n))
    if tail:
        limit = (
            max(duration_ms, cursor) if duration_ms > 0 else cursor + median * len(tail)
        )
        if cursor + median * len(tail) <= limit:
            for i in tail:
                placed[i] = _Timed(cursor, cursor + median)
                cursor += median
        else:
            spread = _spread([weight[i] for i in tail], cursor, limit)
            for i, t in zip(tail, spread):
                placed[i] = t
    return placed


def _enforce(placed: list[Optional[_Timed]]) -> None:
    """Monotonic starts, ``end >= start + MIN_WORD_MS``, ``end <= next.start``
    (pushing the next start when it has to)."""
    prev: Optional[_Timed] = None
    timed = [t for t in placed if t is not None]
    for idx, t in enumerate(timed):
        if prev is not None and t.start < prev.start:
            t.start = prev.start
        if prev is not None and t.start < prev.end:
            # The previous word must end where this one starts; give it its
            # minimum and move this start out if that overlapped.
            prev.end = max(prev.start + MIN_WORD_MS, min(prev.end, t.start))
            if t.start < prev.end:
                t.start = prev.end
        if t.end < t.start + MIN_WORD_MS:
            t.end = t.start + MIN_WORD_MS
        if idx + 1 < len(timed):
            nxt = timed[idx + 1]
            if nxt.start < t.end:
                if nxt.start >= t.start + MIN_WORD_MS:
                    t.end = nxt.start
                else:
                    nxt.start = t.end
        prev = t


def _clamp(placed: list[Optional[_Timed]], duration_ms: int) -> None:
    """Nothing may end after the song; a word squeezed against the end
    keeps its minimum length by starting earlier."""
    if duration_ms <= 0:
        return
    for t in placed:
        if t is None:
            continue
        if t.end > duration_ms:
            t.end = duration_ms
        if t.start > t.end - MIN_WORD_MS:
            t.start = max(0, t.end - MIN_WORD_MS)
        if t.end < t.start:
            t.end = t.start


def align_words(
    lines: list[LyricLine], asr_words: list[AsrWord], duration_ms: int
) -> tuple[list[LyricLine], LyricsStats]:
    """Return copies of ``lines`` with word and line timings transferred from
    ``asr_words`` (sidecar shape: ``{word, start, end}`` in SECONDS), plus
    the match statistics."""
    out = [line.model_copy(deep=True) for line in lines]
    tokens = tokenize(out)
    asr: list[tuple[str, int, int]] = []
    for w in asr_words or []:
        norm = normalize_token(str(w.get("word") or ""))
        if not norm or w.get("start") is None or w.get("end") is None:
            continue
        asr.append((norm, _sec_ms(w["start"]), _sec_ms(w["end"])))
    stats = LyricsStats(matched=0, total=len(tokens), asr_words=len(asr_words or []))
    if not tokens or not asr:
        for line in out:
            line.confidence = (
                None if line.kind != "lyric" or not line.text.strip() else 0.0
            )
        return out, stats

    user_norms = [t.norm for t in tokens][:MAX_TOKENS]
    asr_norms = [a[0] for a in asr][:MAX_TOKENS]
    anchors = _fuzzy_fill(user_norms, asr_norms, _anchors(user_norms, asr_norms))
    matched: dict[int, _Timed] = {}
    for ui, aj in anchors:
        matched[ui] = _Timed(asr[aj][1], asr[aj][2])
    stats.matched = len(matched)

    if duration_ms <= 0:
        duration_ms = max(a[2] for a in asr)
    placed = _place_tokens(tokens, matched, duration_ms)
    _enforce(placed)
    _clamp(placed, duration_ms)

    # Tokens -> words (a hyphenated word spans its parts) -> lines.
    per_word: dict[tuple[int, int], list[_Timed]] = {}
    per_line_total: dict[int, int] = {}
    per_line_matched: dict[int, int] = {}
    for i, tok in enumerate(tokens):
        per_line_total[tok.line_idx] = per_line_total.get(tok.line_idx, 0) + 1
        if i in matched:
            per_line_matched[tok.line_idx] = per_line_matched.get(tok.line_idx, 0) + 1
        t = placed[i]
        if t is not None:
            per_word.setdefault((tok.line_idx, tok.word_idx), []).append(t)
    for li, line in enumerate(out):
        if line.kind != "lyric" or not line.text.strip():
            line.confidence = None
            continue
        for wi, word in enumerate(line.words):
            spans = per_word.get((li, wi))
            if spans:
                word.start_ms = min(s.start for s in spans)
                word.end_ms = max(s.end for s in spans)
            else:
                word.start_ms = None
                word.end_ms = None
        total = per_line_total.get(li, 0)
        line.confidence = (per_line_matched.get(li, 0) / total) if total else 0.0

    _finish_lines(out)
    _reinterpolate_weak_lines(out)
    _finish_lines(out)
    return out, stats


def _timed_words(line: LyricLine) -> list[LyricWord]:
    return [w for w in line.words if w.start_ms is not None and w.end_ms is not None]


def _finish_lines(lines: list[LyricLine]) -> None:
    """Line spans from their words; a line reaches to the next timed line."""
    lyric_idx = [
        i for i, ln in enumerate(lines) if ln.kind == "lyric" and _timed_words(ln)
    ]
    for pos, i in enumerate(lyric_idx):
        words = _timed_words(lines[i])
        lines[i].start_ms = words[0].start_ms
        end = words[-1].end_ms or (words[0].start_ms or 0) + MIN_WORD_MS
        if pos + 1 < len(lyric_idx):
            nxt = _timed_words(lines[lyric_idx[pos + 1]])[0].start_ms or end
            end = max(end, nxt - 1)
        lines[i].end_ms = end
    for i, ln in enumerate(lines):
        if i not in lyric_idx:
            ln.start_ms = None
            ln.end_ms = None


def _reinterpolate_weak_lines(lines: list[LyricLine]) -> None:
    """A line that barely matched between two lines that matched well is
    re-spread wholesale between them (its own anchors were probably noise).
    The confidence stays as measured."""
    lyric_idx = [
        i for i, ln in enumerate(lines) if ln.kind == "lyric" and ln.text.strip()
    ]
    for pos in range(1, len(lyric_idx) - 1):
        i = lyric_idx[pos]
        line = lines[i]
        if line.confidence is None or line.confidence >= LOW_CONFIDENCE:
            continue
        prev = lines[lyric_idx[pos - 1]]
        nxt = lines[lyric_idx[pos + 1]]
        if (prev.confidence or 0.0) < GOOD_CONFIDENCE or (
            nxt.confidence or 0.0
        ) < GOOD_CONFIDENCE:
            continue
        prev_words = _timed_words(prev)
        next_words = _timed_words(nxt)
        if not prev_words or not next_words or not line.words:
            continue
        t0 = prev_words[-1].end_ms or 0
        t1 = next_words[0].start_ms or t0
        if t1 - t0 < MIN_WORD_MS * len(line.words):
            continue
        spread = _spread([len(w.text) + 1 for w in line.words], t0, t1)
        for word, t in zip(line.words, spread):
            word.start_ms = t.start
            word.end_ms = max(t.end, t.start + MIN_WORD_MS)
