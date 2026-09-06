"""The forced aligner's pure parts (no torch model): romanisation, token
spans per word, and placing spans back onto words and lines."""

from __future__ import annotations

from backend.modules.lyrics import forced_align as fa
from backend.modules.lyrics.schema import MIN_WORD_MS, split_text

DICT = {c: i + 1 for i, c in enumerate("abcdefghijklmnopqrstuvwxyz'")}  # 0 = blank


def test_romanize_matches_the_aligner_alphabet():
    assert fa.romanize("Don’t") == "don't"
    assert fa.romanize("Café") == "cafe"
    assert fa.romanize("naïve,") == "naive"
    assert fa.romanize("2") == ""
    assert fa.romanize("Kaleido-mind") == "kaleidomind"
    assert fa.romanize("") == ""


def test_tokenize_lines_skips_markers_and_keeps_unspellable_words_as_empty_spans():
    lines = split_text("Run with me\n[Chorus]\nGo 2 far")
    tokens, refs = fa.tokenize_lines(lines, DICT)
    assert len(refs) == 6  # run with me go 2 far
    assert [r.token_end - r.token_start for r in refs] == [3, 4, 2, 2, 0, 3]
    assert len(tokens) == 14
    assert refs[4].line_idx == 2 and refs[4].word_idx == 1  # the "2"
    # Marker line contributes nothing and shifts no indices.
    assert all(r.line_idx != 1 for r in refs)


def test_place_words_spans_words_and_spreads_the_unspellable_ones():
    lines = split_text("Run with me\nGo 2 far")
    tokens, refs = fa.tokenize_lines(lines, DICT)
    # One span per token, 100 ms apart, a 2 s hole where the "2" would be.
    spans = []
    t = 1.0
    for r in refs:
        for _ in range(r.token_end - r.token_start):
            spans.append((t, t + 0.08, 0.5))
            t += 0.1
        if r.token_end == r.token_start:
            t += 2.0
    assert len(spans) == len(tokens)
    out, placed = fa.place_words(lines, refs, spans)
    assert placed == 5
    w = [wd for ln in out for wd in ln.words]
    assert [x.text for x in w] == ["Run", "with", "me", "Go", "2", "far"]
    assert w[0].start_ms == 1000 and w[0].end_ms == 1280  # r,u,n -> 1.0..1.28
    assert (
        w[3].end_ms <= w[4].start_ms <= w[4].end_ms <= w[5].start_ms
    )  # "2" sits in the hole
    assert all(x.end_ms - x.start_ms >= MIN_WORD_MS for x in w)
    starts = [x.start_ms for x in w]
    assert starts == sorted(starts)
    assert out[0].start_ms == 1000 and out[0].end_ms == out[1].start_ms - 1
    assert out[0].confidence == 1.0 and out[1].confidence == 1.0


def test_place_words_applies_the_clock_scale():
    lines = split_text("go far")
    tokens, refs = fa.tokenize_lines(lines, DICT)
    spans = [(1.0 + 0.1 * i, 1.08 + 0.1 * i, 0.9) for i in range(len(tokens))]
    out, _ = fa.place_words(lines, refs, spans, scale=2.0)
    assert out[0].words[0].start_ms == 2000


def test_available_and_downloaded_never_raise(monkeypatch):
    assert fa.available() in (True, False)
    assert fa.model_downloaded() in (True, False)
