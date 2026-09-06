"""Forced alignment: time the user's OWN lyric words against the vocal.

Whisper transcribes, and on sung, effected, harmonised vocals it transcribes
badly (a 0.6-0.9 word error rate on the songs in this library), so timing
built on matching its words to the lyric sheet leaves most lines untimed or
guessed. When the words are already known, the right tool is a CTC forced
aligner: it never guesses words, it only asks "where in this audio is this
exact character sequence" and answers for every word, in order.

torchaudio ships one: ``MMS_FA`` (Meta's multilingual wav2vec2 CTC aligner,
romanised labels, 1.2 GB, downloaded to the torch hub cache on first use).
The model's attention is quadratic in time, so a song is run as 30-second
windows with a one-second overlap on each side, the windows' emissions are
concatenated (overlap trimmed), and ONE ``forced_align`` over the whole
emission sequence places every token. On a GPU the whole song takes a few
seconds; the CPU takes a minute or two.

Words the romaniser cannot spell (digits, non-Latin script the model's
uroman labels do not cover) get no tokens and are spread between their
timed neighbours. Everything torch-related is imported inside functions so
this module is cheap to import and testable without the model.
"""

from __future__ import annotations

import logging
import re
import threading
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional

from .align import _finish_lines, _spread
from .schema import MIN_WORD_MS, LyricLine, LyricsStats

log = logging.getLogger(__name__)

CHUNK_SEC = 30.0
OVERLAP_SEC = 1.0
ALIGNER_NAME = "mms"
_KEEP_RE = re.compile(r"[^a-z']")
_APOS_RE = re.compile(r"[’‘`´]")

_model_lock = threading.Lock()
_model: Optional[tuple[Any, dict[str, int], int, str]] = None


def available() -> bool:
    """torchaudio with the MMS aligner bundle and forced_align. Never raises."""
    try:
        import torchaudio  # noqa: F401
        import torchaudio.functional as F
        from torchaudio.pipelines import MMS_FA  # noqa: F401

        return hasattr(F, "forced_align") and hasattr(F, "merge_tokens")
    except Exception:  # noqa: BLE001
        return False


def model_downloaded() -> bool:
    """Is the aligner checkpoint already in the torch hub cache? (The first
    align downloads 1.2 GB; the job message says so when this is False.)"""
    try:
        import torch
        from torchaudio.pipelines import MMS_FA

        name = Path(str(getattr(MMS_FA, "_path", "model.pt"))).name
        return (Path(torch.hub.get_dir()) / "checkpoints" / name).is_file()
    except Exception:  # noqa: BLE001
        return False


def romanize(word: str) -> str:
    """A lyric word as the aligner spells it: accents stripped, lower-case,
    only a-z and the apostrophe kept ("Don't" -> "don't", "Café" -> "cafe",
    "2" -> "")."""
    decomposed = unicodedata.normalize("NFKD", word or "")
    stripped = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return _KEEP_RE.sub("", _APOS_RE.sub("'", stripped).casefold())


@dataclass
class _WordRef:
    line_idx: int
    word_idx: int
    token_start: int
    token_end: int  # exclusive; == token_start when the word has no tokens


def tokenize_lines(
    lines: list[LyricLine], dictionary: dict[str, int]
) -> tuple[list[int], list[_WordRef]]:
    """Every lyric word, in order, as aligner label ids; a word whose
    romanisation has no labels gets an empty span."""
    tokens: list[int] = []
    refs: list[_WordRef] = []
    for li, line in enumerate(lines):
        if line.kind != "lyric" or not line.text.strip():
            continue
        for wi, word in enumerate(line.words):
            ids = [dictionary[c] for c in romanize(word.text) if c in dictionary]
            refs.append(_WordRef(li, wi, len(tokens), len(tokens) + len(ids)))
            tokens.extend(ids)
    return tokens, refs


def _load_model(device: str):
    """The aligner, loaded once per process and kept on ``device``."""
    global _model
    with _model_lock:
        if _model is not None and _model[3] == device:
            return _model
        import torchaudio

        bundle = torchaudio.pipelines.MMS_FA
        model = bundle.get_model(with_star=False).to(device).eval()
        dictionary = bundle.get_dict(star=None)
        _model = (model, dictionary, int(bundle.sample_rate), device)
        log.info("lyrics.forced_align: MMS aligner loaded on %s", device)
        return _model


def _emissions(model, wav, sr: int, device: str):
    """Log-probabilities for the whole song, window by window."""
    import torch

    win = int(CHUNK_SEC * sr)
    ovl = int(OVERLAP_SEC * sr)
    n = wav.shape[1]
    pieces = []
    frames_per_sample: Optional[float] = None
    pos = 0
    with torch.inference_mode():
        while pos < n:
            a = max(0, pos - ovl)
            b = min(n, pos + win + ovl)
            emission, _ = model(wav[:, a:b].to(device))
            emission = torch.log_softmax(emission, dim=-1)[0].cpu()
            if frames_per_sample is None:
                frames_per_sample = emission.shape[0] / float(b - a)
            lead = int(round((pos - a) * frames_per_sample))
            keep = int(round(min(win, n - pos) * frames_per_sample))
            pieces.append(emission[lead : lead + keep])
            pos += win
    return torch.cat(pieces, 0)


def _load_audio(path: Path, sample_rate: int):
    import torchaudio

    wav, sr = torchaudio.load(str(path))
    wav = wav.mean(0, keepdim=True)
    if sr != sample_rate:
        wav = torchaudio.functional.resample(wav, sr, sample_rate)
    peak = float(wav.abs().max()) if wav.numel() else 0.0
    if peak > 0:
        wav = wav / peak * 0.9
    return wav


def place_words(
    lines: list[LyricLine],
    refs: list[_WordRef],
    spans: list[tuple[float, float, float]],
    scale: float = 1.0,
) -> tuple[list[LyricLine], int]:
    """Copy the token spans (seconds: start, end, score) onto the words:
    a word spans its first to last token; a word with no tokens is spread
    between its timed neighbours. Returns the timed lines and how many
    words the aligner itself placed."""
    out = [line.model_copy(deep=True) for line in lines]
    for line in out:
        for word in line.words:
            word.start_ms = None
            word.end_ms = None
    placed = 0
    timed: list[tuple[int, int, int]] = []  # (ref index, start_ms, end_ms)
    for i, ref in enumerate(refs):
        if ref.token_end <= ref.token_start:
            continue
        seg = spans[ref.token_start : ref.token_end]
        if not seg:
            continue
        start = int(round(seg[0][0] * 1000.0 * scale))
        end = int(round(seg[-1][1] * 1000.0 * scale))
        timed.append((i, start, max(end, start + MIN_WORD_MS)))
        placed += 1
    # Words the aligner could not spell: spread between the timed neighbours.
    timed_idx = {i for i, _, _ in timed}
    by_ref: dict[int, tuple[int, int]] = {i: (s, e) for i, s, e in timed}
    gaps: list[list[int]] = []
    cur: list[int] = []
    for i in range(len(refs)):
        if i in timed_idx:
            if cur:
                gaps.append(cur)
                cur = []
        else:
            cur.append(i)
    if cur:
        gaps.append(cur)
    for gap in gaps:
        prev = max((i for i in timed_idx if i < gap[0]), default=None)
        nxt = min((i for i in timed_idx if i > gap[-1]), default=None)
        if prev is None and nxt is None:
            break
        t0 = (
            by_ref[prev][1]
            if prev is not None
            else max(0, by_ref[nxt][0] - MIN_WORD_MS * 4 * len(gap))
        )
        t1 = (
            by_ref[nxt][0]
            if nxt is not None
            else by_ref[prev][1] + MIN_WORD_MS * 4 * len(gap)
        )
        if t1 <= t0:
            t1 = t0 + MIN_WORD_MS * len(gap)
        weights = [
            len(lines[refs[i].line_idx].words[refs[i].word_idx].text) + 1 for i in gap
        ]
        for i, t in zip(gap, _spread(weights, t0, t1)):
            by_ref[i] = (t.start, max(t.end, t.start + MIN_WORD_MS))
    # Monotonic, non-overlapping, at least MIN_WORD_MS each.
    last_end = 0
    for i in range(len(refs)):
        if i not in by_ref:
            continue
        s, e = by_ref[i]
        s = max(s, last_end)
        e = max(e, s + MIN_WORD_MS)
        by_ref[i] = (s, e)
        last_end = s  # the next word may start where this one starts (chords of words are rare; keep order)
    for i, ref in enumerate(refs):
        if i not in by_ref:
            continue
        word = out[ref.line_idx].words[ref.word_idx]
        word.start_ms, word.end_ms = by_ref[i]
    for line in out:
        if line.kind == "lyric" and line.text.strip():
            line.confidence = (
                1.0
                if line.words and all(w.start_ms is not None for w in line.words)
                else None
            )
    _finish_lines(out)
    return out, placed


def align_lines(
    audio_path: Path,
    lines: list[LyricLine],
    *,
    duration_ms: int = 0,
    scale: float = 1.0,
    device: Optional[str] = None,
    progress: Optional[Callable[[str], None]] = None,
) -> tuple[list[LyricLine], LyricsStats]:
    """Time ``lines`` against ``audio_path``. ``scale`` maps the aligned
    file's clock onto the song's (a resampled stem). Blocking: run it in a
    thread, on the GPU lane."""
    import torch
    import torchaudio.functional as F

    dev = device or ("cuda" if torch.cuda.is_available() else "cpu")
    if progress and not model_downloaded():
        progress("downloading the aligner model (1.2 GB, once)")
    model, dictionary, sample_rate, dev = _load_model(dev)
    tokens, refs = tokenize_lines(lines, dictionary)
    if not tokens:
        raise ValueError("no alignable words: the lyrics have no Latin letters")
    if progress:
        progress(f"listening to the vocal ({ALIGNER_NAME} aligner on {dev})")
    wav = _load_audio(audio_path, sample_rate)
    emission = _emissions(model, wav, sample_rate, dev)
    targets = torch.tensor([tokens], dtype=torch.int32)
    aligned, scores = F.forced_align(emission.unsqueeze(0), targets, blank=0)
    token_spans = F.merge_tokens(aligned[0], scores.exp()[0])
    seconds_per_frame = (wav.shape[1] / float(sample_rate)) / max(1, emission.shape[0])
    spans = [
        (ts.start * seconds_per_frame, ts.end * seconds_per_frame, float(ts.score))
        for ts in token_spans
    ]
    if len(spans) != len(tokens):
        raise RuntimeError(
            f"aligner returned {len(spans)} spans for {len(tokens)} tokens"
        )
    out, placed = place_words(lines, refs, spans, scale)
    stats = LyricsStats(
        matched=placed, total=len(refs), asr_words=0, aligner=ALIGNER_NAME
    )
    if duration_ms > 0:
        for line in out:
            for word in line.words:
                if word.end_ms is not None and word.end_ms > duration_ms:
                    word.end_ms = duration_ms
                    if (
                        word.start_ms is not None
                        and word.start_ms > duration_ms - MIN_WORD_MS
                    ):
                        word.start_ms = max(0, duration_ms - MIN_WORD_MS)
        _finish_lines(out)
    return out, stats


__all__ = [
    "ALIGNER_NAME",
    "align_lines",
    "available",
    "model_downloaded",
    "place_words",
    "romanize",
    "tokenize_lines",
]
