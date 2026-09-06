"""The pasted-lyrics-to-whisper-times aligner (backend.modules.lyrics.align)."""

from __future__ import annotations

import random
import time

from backend.modules.lyrics.align import (
    MIN_WORD_MS,
    align_words,
    normalize_token,
    tokenize,
)
from backend.modules.lyrics.schema import (
    LyricsDoc,
    from_vocal_lyrics,
    join_lines,
    split_text,
    to_vocal_lyrics,
)

LYRIC = "Walking down the road tonight\nSinging to the stars above\n[Chorus]\nDon't stop now\nYeahhh we go"


def asr(items, step=0.5, start=1.0):
    """Sidecar-shaped words in SECONDS; items are words or (word, start, end)."""
    out = []
    t = start
    for item in items:
        if isinstance(item, tuple):
            out.append({"word": item[0], "start": item[1], "end": item[2]})
        else:
            out.append(
                {"word": item, "start": round(t, 3), "end": round(t + step * 0.8, 3)}
            )
            t += step
    return out


def _lyric_words(lines):
    return [w for ln in lines if ln.kind == "lyric" for w in ln.words]


def _asr_ms(words):
    return [(int(round(w["start"] * 1000)), int(round(w["end"] * 1000))) for w in words]


def test_exact_match_transfers_every_time():
    lines = split_text(LYRIC)
    words = asr(
        "walking down the road tonight singing to the stars above dont stop now yeahhh we go".split()
    )
    out, stats = align_words(lines, words, 60_000)
    got = [(w.start_ms, w.end_ms) for w in _lyric_words(out)]
    assert got == _asr_ms(words)
    assert stats.matched == stats.total == 16
    for ln in out:
        if ln.kind == "lyric":
            assert ln.confidence == 1.0
    marker = out[2]
    assert (
        marker.kind == "marker"
        and marker.start_ms is None
        and marker.confidence is None
    )
    assert out[0].start_ms == 1000 and out[0].end_ms == 3499  # reaches the next line


def test_substitution_insertion_deletion_keep_neighbours():
    lines = split_text("night falls on the quiet town\nwe walk home")
    # "night"->"knight", "um" inserted, "the" dropped.
    words = asr("knight falls um on quiet town we walk home".split())
    out, stats = align_words(lines, words, 30_000)
    w = _lyric_words(out)
    by = {x["word"]: x for x in words}
    assert w[1].start_ms == int(by["falls"]["start"] * 1000)
    assert w[4].start_ms == int(by["quiet"]["start"] * 1000)  # "quiet"
    assert w[5].start_ms == int(by["town"]["start"] * 1000)
    # the dropped "the" is placed between "on" and "quiet"
    assert w[2].end_ms <= w[3].start_ms <= w[4].start_ms
    assert stats.matched >= 7


def test_mismatched_words_are_flagged_with_what_whisper_heard():
    lines = split_text("night falls on the quiet town\nwe walk home")
    words = asr("night falls on the silent town we walk home".split())
    out, stats = align_words(lines, words, 30_000)
    w = _lyric_words(out)
    assert w[4].text == "quiet" and w[4].heard == "silent"
    assert all(x.heard is None for x in w if x is not w[4])
    assert stats.mismatched == 1
    # Whisper skipped a substantial word: flagged as heard nothing.
    words = asr("night falls on the town we walk home".split())
    out, stats = align_words(lines, words, 30_000)
    w = _lyric_words(out)
    assert w[4].heard == "" and stats.mismatched == 1
    # A lone stopword is never an anchor, but whisper heard it: no flag.
    assert w[3].text == "the" and w[3].heard is None
    # Lyrics for another song: every word differs.
    other = split_text("hello bright world")
    out, stats = align_words(other, asr("goodbye pale moon".split()), 30_000)
    assert [x.heard for x in _lyric_words(out)] == ["goodbye", "pale", "moon"]
    assert stats.mismatched == 3
    # Timings still transfer around a mismatch (the exact case above).
    out, _ = align_words(
        lines, asr("night falls on the silent town we walk home".split()), 30_000
    )
    w = _lyric_words(out)
    assert w[3].end_ms <= w[4].start_ms <= w[5].start_ms


def test_normalization_and_hyphens():
    assert normalize_token("Don't!") == "dont"
    assert normalize_token("Yeahhh") == "yeahh"
    assert normalize_token("Café") == "cafe"
    lines = split_text("Don't stop the sing-along Yeahhh")
    toks = [t.norm for t in tokenize(lines)]
    assert toks == ["dont", "stop", "the", "sing", "along", "yeahh"]
    words = asr("dont stop the sing along yeah".split())
    out, _ = align_words(lines, words, 20_000)
    w = _lyric_words(out)
    assert w[0].start_ms == 1000
    # hyphenated word spans both of its parts
    assert w[3].start_ms == 2500 and w[3].end_ms == 3400
    assert w[4].start_ms == 3500  # Yeahhh matched fuzzily to "yeah"


def test_repeated_chorus_maps_in_order():
    chorus = "oh we sing\nall night long\n"
    lines = split_text(chorus + chorus)
    words = asr("oh we sing all night long oh we sing all night long".split())
    out, _ = align_words(lines, words, 20_000)
    starts = [ln.start_ms for ln in out]
    assert starts == sorted(starts)
    assert starts[2] > starts[1] > starts[0]
    assert out[3].start_ms == 5500  # the second "all", not the first


def test_lone_stopword_anchor_is_rejected():
    lines = split_text("the night is long")
    # A hallucinated "the" 29 s early, then a filler word, then the real line.
    words = asr(
        [
            ("the", 1.0, 1.2),
            ("um", 2.0, 2.2),
            ("night", 30.0, 30.4),
            ("is", 30.5, 30.7),
            ("long", 30.8, 31.2),
        ]
    )
    out, _ = align_words(lines, words, 40_000)
    w = _lyric_words(out)
    assert w[1].start_ms == 30000
    assert w[0].start_ms > 20000  # not pulled 30 s early by the stray "the"
    assert w[0].end_ms <= w[1].start_ms


def test_edge_extrapolation_is_clamped():
    lines = split_text(
        "intro words before\nthe matched middle part\nand trailing words after the end"
    )
    words = asr([("matched", 10.0, 10.3), ("middle", 10.4, 10.7), ("part", 10.8, 11.1)])
    out, _ = align_words(lines, words, 12_000)
    for w in _lyric_words(out):
        assert w.start_ms is not None and w.end_ms is not None
        assert 0 <= w.start_ms <= w.end_ms <= 12_000


def test_invariants_on_noisy_1500_token_lyric():
    rng = random.Random(7)
    vocab = [
        "love",
        "night",
        "fire",
        "run",
        "gold",
        "river",
        "shadow",
        "light",
        "again",
        "forever",
        "heart",
        "stone",
    ]
    tokens = [rng.choice(vocab) for _ in range(1500)]
    text = "\n".join(" ".join(tokens[i : i + 6]) for i in range(0, 1500, 6))
    lines = split_text(text)
    asr_tokens = []
    for tok in tokens:
        r = rng.random()
        if r < 0.1:
            continue  # dropped
        if r < 0.2:
            asr_tokens.append(rng.choice(vocab))  # substituted
        else:
            asr_tokens.append(tok)
        if rng.random() < 0.05:
            asr_tokens.append("um")  # inserted
    words = asr(asr_tokens, step=0.3)
    t0 = time.perf_counter()
    out, stats = align_words(lines, words, int(words[-1]["end"] * 1000) + 5000)
    assert time.perf_counter() - t0 < 1.0
    assert stats.total == 1500
    assert stats.matched > 900
    prev_end = 0
    prev_start = 0
    for w in _lyric_words(out):
        assert w.start_ms is not None and w.end_ms is not None
        assert w.start_ms >= prev_start
        assert w.start_ms >= prev_end
        assert w.end_ms >= w.start_ms + MIN_WORD_MS
        prev_start, prev_end = w.start_ms, w.end_ms


def test_low_confidence_line_is_reinterpolated_between_good_neighbours():
    lines = split_text("first line is fine\nzzq qqz xyx\nlast line is also fine")
    words = asr("first line is fine blah blah blah last line is also fine".split())
    out, _ = align_words(lines, words, 20_000)
    assert out[0].confidence == 1.0 and out[2].confidence == 1.0
    assert out[1].confidence == 0.0
    lo = out[0].words[-1].end_ms
    hi = out[2].words[0].start_ms
    for w in out[1].words:
        assert lo <= w.start_ms <= w.end_ms <= hi


def test_empty_asr_leaves_everything_untimed():
    lines = split_text(LYRIC)
    out, stats = align_words(lines, [], 60_000)
    assert stats.matched == 0 and stats.total == 16
    assert all(w.start_ms is None for w in _lyric_words(out))
    assert all(ln.start_ms is None for ln in out)


def test_vocal_lyrics_converters_round_trip():
    lines = split_text("hello world\nsecond line")
    words = asr("hello world second line".split())
    aligned, _ = align_words(lines, words, 10_000)
    doc = LyricsDoc(
        entry_id="e", lines=aligned, text=join_lines(aligned), source="aligned"
    )
    vocal = to_vocal_lyrics(doc)
    assert [w.text for w in vocal.words] == ["hello", "world", "second", "line"]
    assert [p.text for p in vocal.phrases] == ["hello world", "second line"]
    back = from_vocal_lyrics("e", vocal)
    assert [ln.text for ln in back.lines] == ["hello world", "second line"]
    assert [w.start_ms for ln in back.lines for w in ln.words] == [
        w.start_ms for w in _lyric_words(aligned)
    ]
    assert back.source == "transcribed"
