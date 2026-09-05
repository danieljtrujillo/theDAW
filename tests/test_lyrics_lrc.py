"""LRC parse / format round trips (backend.modules.lyrics.lrc)."""

from __future__ import annotations

from backend.modules.lyrics import lrc
from backend.modules.lyrics.schema import LyricsDoc, join_lines, split_text

# Keep this text identical to the fixture in
# frontend/src/components/layout/sing/singSync.test.ts.
FIXTURE_LRC = """[ti:Test Song]
[ar:Someone]
[offset:-200]
[00:12.34]First line here
[01:02.345]Second line later
[00:30.00][00:45.00]Repeated line
[00:20.00]<00:20.00>Hello <00:20.50>world
[Chorus]
An untimed line
[xx]malformed line

[00:50.00]After blank
"""

FIXTURE_TXT = """First line here
Second line later

[Chorus]
(bridge)
Don't stop now
"""


def _timed(lines):
    return [ln for ln in lines if ln.start_ms is not None]


def test_parse_values_and_expansion():
    parsed = lrc.parse_lrc(FIXTURE_LRC)
    assert parsed.tags == {"ti": "Test Song", "ar": "Someone"}
    # LRC offset -200 (show later) == our +200 (added to the clock).
    assert parsed.offset_ms == 200
    starts = [ln.start_ms for ln in _timed(parsed.lines)]
    assert starts == sorted(starts)
    assert starts == [12340, 20000, 30000, 45000, 50000, 62345]
    by_start = {ln.start_ms: ln for ln in _timed(parsed.lines)}
    assert by_start[12340].text == "First line here"
    assert by_start[62345].text == "Second line later"
    assert by_start[30000].text == by_start[45000].text == "Repeated line"
    hello = by_start[20000]
    assert hello.text == "Hello world"
    assert [w.start_ms for w in hello.words] == [20000, 20500]
    assert hello.words[0].end_ms == 20500
    # A timed line ends where the next one starts.
    assert by_start[12340].end_ms == 20000


def test_parse_keeps_untimed_markers_blanks_and_malformed_lines():
    parsed = lrc.parse_lrc(FIXTURE_LRC)
    texts = [ln.text for ln in parsed.lines]
    marker = next(ln for ln in parsed.lines if ln.text == "[Chorus]")
    assert marker.kind == "marker"
    assert marker.start_ms is None
    untimed = next(ln for ln in parsed.lines if ln.text == "An untimed line")
    assert untimed.kind == "lyric" and untimed.start_ms is None
    assert [w.text for w in untimed.words] == ["An", "untimed", "line"]
    malformed = next(ln for ln in parsed.lines if ln.text.startswith("[xx]"))
    assert malformed.kind == "lyric" and malformed.start_ms is None
    assert "" in texts  # the blank line survives


def test_format_then_parse_round_trips_within_10ms():
    parsed = lrc.parse_lrc(FIXTURE_LRC)
    doc = LyricsDoc(
        entry_id="e1",
        offset_ms=parsed.offset_ms,
        lines=parsed.lines,
        text=join_lines(parsed.lines),
    )
    text = lrc.format_lrc(
        doc, title="Test Song", artist="Someone", duration_ms=90_000, words=True
    )
    assert "[ti:Test Song]" in text
    assert "[ar:Someone]" in text
    assert "[length:01:30]" in text
    assert "[offset:-200]" in text
    again = lrc.parse_lrc(text)
    assert again.offset_ms == 200
    a = [ln.start_ms for ln in _timed(parsed.lines)]
    b = [ln.start_ms for ln in _timed(again.lines)]
    assert len(a) == len(b)
    assert all(abs(x - y) <= 10 for x, y in zip(a, b))
    hello_a = next(ln for ln in parsed.lines if ln.text == "Hello world")
    hello_b = next(ln for ln in again.lines if ln.text == "Hello world")
    assert [w.start_ms for w in hello_b.words] == [w.start_ms for w in hello_a.words]
    # Blank lines and untimed text survive the trip.
    assert "" in [ln.text for ln in again.lines]
    assert any(ln.text == "An untimed line" for ln in again.lines)


def test_header_tags_only_when_given_and_txt_is_joined_text():
    lines = split_text(FIXTURE_TXT)
    doc = LyricsDoc(entry_id="e1", lines=lines, text=join_lines(lines))
    out = lrc.format_lrc(doc)
    assert (
        "[ti:" not in out
        and "[ar:" not in out
        and "[length:" not in out
        and "[offset:" not in out
    )
    assert lrc.format_txt(doc) == join_lines(lines)
    assert (
        lrc.format_txt(doc)
        == "First line here\nSecond line later\n\n[Chorus]\n(bridge)\nDon't stop now"
    )


def test_split_text_markers_and_blank_runs():
    lines = split_text("\n\nFirst\n\n\n\nSecond\n[Chorus]\n(bridge)\nlast word\n\n")
    assert [ln.text for ln in lines] == [
        "First",
        "",
        "Second",
        "[Chorus]",
        "(bridge)",
        "last word",
    ]
    assert [ln.kind for ln in lines] == [
        "lyric",
        "lyric",
        "lyric",
        "marker",
        "marker",
        "lyric",
    ]
    assert [w.text for w in lines[-1].words] == ["last", "word"]


def test_ms_to_tag_formats_centiseconds():
    assert lrc.ms_to_tag(12340) == "[00:12.34]"
    assert lrc.ms_to_tag(62345) == "[01:02.35]"
    assert lrc.ms_to_tag(62344) == "[01:02.34]"
    assert lrc.ms_to_tag(20500, "<>") == "<00:20.50>"
    assert lrc.ms_to_tag(59999) == "[00:59.99]"
