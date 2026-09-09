"""Deterministic device detection (backend.modules.lyricanalysis.devices).

Every fixture here is hand-written so its findings can be stated exactly, and
nothing asserts on a pronunciation only cmudict knows: the rhymes are spelled
in parallel ("night"/"light", "need it"/"seed it") so any consistent
grapheme-to-phoneme pass produces the same tail for both halves.
"""

from __future__ import annotations

from backend.modules.lyricanalysis import devices
from backend.modules.lyricanalysis.phonetics import classify_rhyme
from backend.modules.lyricanalysis.schema import (
    MEANING_KINDS,
    RHYME_KINDS,
    REPETITION_KINDS,
    SOUND_KINDS,
    STRUCTURE_KINDS,
)
from backend.modules.lyrics.schema import LyricLine, LyricsDoc, split_text

RICH = """[Verse 1]
The wind was howling in the night
I heard it calling every day
It burned inside me like a light
And blew my fears the other way
[Chorus]
We stay out here until we run
We chase the morning like the sun
"""


def _doc(text: str) -> LyricsDoc:
    return LyricsDoc(entry_id="test", text=text, lines=split_text(text))


def _kinds(devs) -> set[str]:
    return {d.kind for d in devs}


def _of(devs, kind: str) -> list:
    return [d for d in devs if d.kind == kind]


def _anchors(dev) -> list[tuple[int, int]]:
    return [(s.line, s.word) for s in dev.spans]


# --- rhyme -----------------------------------------------------------------


def test_abab_quatrain_letters_scheme_and_groups():
    doc = _doc(RICH)
    devs, lines, sections, _stats = devices.analyse(doc)
    # Lines 1-4 are the quatrain; 0 and 5 are markers.
    assert [lines[i].letter for i in (1, 2, 3, 4)] == ["A", "B", "A", "B"]
    assert [lines[i].section for i in (1, 6)] == ["Verse 1", "Chorus"]
    assert [s.name for s in sections] == ["Verse 1", "Chorus"]
    assert sections[0].scheme == "ABAB"
    # The chorus starts its own letter run, so a couplet reads AA whatever the
    # verse before it did.
    assert sections[1].scheme == "AA"
    ends = _of(devs, "end-rhyme")
    pairs = {tuple(_anchors(d)) for d in ends}
    assert ((1, 6), (3, 6)) in pairs  # night / light
    assert ((2, 5), (4, 6)) in pairs  # day / way
    night = next(d for d in ends if _anchors(d) == [(1, 6), (3, 6)])
    assert night.group == "rhyme-s0-A"
    assert night.family == "rhyme"
    assert night.confidence >= 0.5


def test_unrhymed_line_has_no_letter_but_an_x_in_the_scheme():
    doc = _doc(
        "I walked out to the night\nNobody was around\nAnd came back to the light"
    )
    _devs, lines, sections, _stats = devices.analyse(doc)
    assert [lines[i].letter for i in (0, 1, 2)] == ["A", "", "A"]
    assert sections[0].scheme == "AXA"


def test_internal_rhyme_anchors_the_two_mid_line_words():
    doc = _doc("The cat in the hat sang a song\nNothing in the world was wrong")
    devs, _lines, _sections, _stats = devices.analyse(doc)
    internal = _of(devs, "internal-rhyme")
    hit = next((d for d in internal if _anchors(d) == [(0, 1), (0, 4)]), None)
    assert hit is not None, [_anchors(d) for d in internal]
    assert [s.text for s in hit.spans] == ["cat", "hat"]
    assert hit.group == hit.group and hit.family == "rhyme"


def test_leonine_rhyme_when_a_mid_line_word_meets_the_line_ending():
    doc = _doc("The cat came back inside the hat")
    devs, _lines, _sections, _stats = devices.analyse(doc)
    leonine = _of(devs, "leonine-rhyme")
    assert leonine, _kinds(devs)
    assert _anchors(leonine[0]) == [(0, 1), (0, 6)]


def test_multisyllabic_rhyme_matches_across_a_word_boundary():
    doc = _doc("You know I need it now\nWatch me plant a seed it grows")
    devs, _lines, _sections, stats = devices.analyse(doc)
    multi = _of(devs, "multisyllabic-rhyme")
    hit = next(
        (d for d in multi if _anchors(d) == [(0, 3), (0, 4), (1, 4), (1, 5)]), None
    )
    assert hit is not None, [(_anchors(d), d.detail) for d in multi]
    assert [s.text for s in hit.spans] == ["need", "it", "seed", "it"]
    assert hit.detail.startswith("2 syllables:")
    assert hit.confidence > 0.5
    assert stats.multisyllabic_rhymes >= 1
    # The word-for-word passes must not report the same rhyme a second time.
    assert not [
        d
        for d in devs
        if d.kind == "cross-line-rhyme" and {(0, 3), (1, 4)} <= set(_anchors(d))
    ]


def test_multisyllabic_rhyme_has_to_start_on_a_stressed_syllable():
    """ "-ing up the" is a suffix plus two repeated words, not a rhyme."""
    doc = _doc("\n".join(["I was counting up the day", "And I was looking up the way"]))
    devs, _lines, _sections, _stats = devices.analyse(doc)
    labels = [d.label for d in _of(devs, "multisyllabic-rhyme")]
    assert not [lab for lab in labels if "counting" in lab and "looking" in lab], labels


def test_identical_rhyme_when_a_line_ending_repeats():
    doc = _doc("I walked into the light\nNothing ever felt so light")
    devs, lines, _sections, _stats = devices.analyse(doc)
    ident = _of(devs, "identical-rhyme")
    assert ident, _kinds(devs)
    assert _anchors(ident[0]) == [(0, 4), (1, 4)]
    assert lines[0].letter == lines[1].letter == "A"


def test_the_rhyme_gate_never_drops_a_pair_the_classifier_accepts():
    """The cheap filter in front of ``classify_rhyme`` is only allowed to drop
    pairs the real comparison would have rejected anyway.

    A test on the last syllable is not: "given" / "living" share neither its
    nucleus nor its coda and are still the slant rhyme the end-of-line pass
    reports, so a mid-line pass gated that way would disagree with itself.
    """
    words = """given living driven heaven seven eleven premise promise rhythm
        behind blind find kind mind science silence violence morning warning
        matter madder better letter water daughter city pretty little riddle
        river giver silver sister purple circle turtle music lose choose""".split()
    accepted = 0
    for i, a in enumerate(words):
        for b in words[i + 1 :]:
            ta, tb = devices._token(0, 0, a), devices._token(0, 1, b)
            kind, conf = classify_rhyme(ta.pron, tb.pron, word_a=a, word_b=b)
            wanted = kind == "identical-rhyme" or (
                kind in ("end-rhyme", "slant-rhyme")
                and conf >= devices.MIN_INTERNAL_CONF
            )
            if not wanted:
                continue
            accepted += 1
            assert devices._might_rhyme(ta, tb), (a, b, kind, conf)
    assert accepted > 20


def test_a_line_ending_in_a_dash_is_still_an_end_rhyme():
    """The word a line rhymes on is not always its last token."""
    doc = _doc(
        "\n".join(["I saw the light —", "You felt the night —", "We found the sight —"])
    )
    devs, lines, _sections, _stats = devices.analyse(doc)
    assert [m.letter for m in lines] == ["A", "A", "A"]
    # The cross-line pass is for MID-line words; it must not pick the ending up
    # and report it under its own name, colour and confidence floor.
    assert not _of(devs, "cross-line-rhyme")
    ends = _of(devs, "end-rhyme")
    assert ends
    for dev in ends:
        assert dev.label.startswith("end rhyme")
        assert dev.group.startswith("rhyme-s")


def test_a_pair_is_never_reported_under_two_kinds():
    doc = _doc(RICH)
    devs, _lines, _sections, _stats = devices.analyse(doc)
    seen: dict[tuple, str] = {}
    for dev in devs:
        if dev.family != "rhyme" or len(dev.spans) != 2:
            continue
        key = tuple(sorted(_anchors(dev)))
        assert key not in seen, f"{key} reported as {seen.get(key)} and {dev.kind}"
        seen[key] = dev.kind


# --- sound -----------------------------------------------------------------


def test_alliteration_paints_the_initial_consonant_letters():
    doc = _doc("Silly Sally sings sweetly")
    devs, _lines, _sections, _stats = devices.analyse(doc)
    allit = _of(devs, "alliteration")
    assert allit, _kinds(devs)
    hit = allit[0]
    assert _anchors(hit) == [(0, 0), (0, 1), (0, 2), (0, 3)]
    assert [s.text for s in hit.spans] == ["S", "S", "s", "s"]
    assert hit.phones == ["S"]


def test_alliteration_across_consecutive_line_openings():
    doc = _doc(
        "Broken glass upon the road\nBurning up the whole night through\nQuietly"
    )
    devs, _lines, _sections, _stats = devices.analyse(doc)
    openings = [d for d in _of(devs, "alliteration") if "line openings" in d.detail]
    assert openings
    assert _anchors(openings[0]) == [(0, 0), (1, 0)]


def test_alliteration_skips_function_words_and_paints_past_a_quote():
    doc = _doc('The thing that the "Silent" sirens sang')
    devs, _lines, _sections, _stats = devices.analyse(doc)
    allit = _of(devs, "alliteration")
    # "The / that / the" all open on DH and so does every other English line;
    # function words are out of the phonetic passes, alliteration included.
    assert [d.detail for d in allit] == ["S"], [d.detail for d in allit]
    # Pasted lyrics quote words, and the paint has to land on the letter that
    # spells the sound, not on the quote in front of it.
    assert [s.text for s in allit[0].spans] == ["S", "s", "s"]
    assert [(s.line, s.word, s.char_start) for s in allit[0].spans] == [
        (0, 4, 1),
        (0, 5, 0),
        (0, 6, 0),
    ]


def test_alliteration_is_not_one_word_said_twice():
    doc = _doc("I follow, and I follow, and I follow you")
    devs, _lines, _sections, _stats = devices.analyse(doc)
    assert not [d for d in _of(devs, "alliteration") if d.detail == "F"]


def test_assonance_uses_the_primary_stress_not_a_leading_secondary(monkeypatch):
    """ "celebration" is 2-0-1-0: the ear lands on "-ra-", never on "ce-"."""
    import backend.modules.lyricanalysis.phonetics as ph

    monkeypatch.setattr(ph, "_cmudict", object())
    monkeypatch.setattr(
        ph,
        "_CMU_TABLE",
        {
            "celebration": [
                ["S", "EH2", "L", "AH0", "B", "R", "EY1", "SH", "AH0", "N"]
            ],
            "waits": [["W", "EY1", "T", "S"]],
        },
    )
    ph.pronounce.cache_clear()
    try:
        devs, _lines, _sections, _stats = devices.analyse(_doc("celebration waits"))
    finally:
        ph.pronounce.cache_clear()
    asso = _of(devs, "assonance")
    assert [d.detail for d in asso] == ["EY"], [(d.detail, d.label) for d in asso]
    assert [s.text for s in asso[0].spans] == ["ra", "waits"]


def test_assonance_over_a_run_of_the_same_stressed_vowel():
    doc = _doc("The black cat sang fast rap")
    devs, _lines, _sections, _stats = devices.analyse(doc)
    asso = _of(devs, "assonance")
    assert asso, _kinds(devs)
    hit = max(asso, key=lambda d: len(d.spans))
    assert {s.word for s in hit.spans} == {1, 2, 3, 4, 5}
    assert len(hit.phones) == 1


def test_onomatopoeia_matches_held_letters_too():
    doc = _doc("The engine went vroooom and the bell went ding")
    devs, _lines, _sections, _stats = devices.analyse(doc)
    onom = _of(devs, "onomatopoeia")
    assert {d.detail for d in onom} == {"vroom", "ding"}
    assert {s.word for d in onom for s in d.spans} == {3, 8}


# --- repetition ------------------------------------------------------------


def test_anaphora_runs_across_a_marker_line():
    doc = _doc("[Verse]\nI will rise\nI will fall\n[Chorus]\nI will stay")
    devs, _lines, _sections, _stats = devices.analyse(doc)
    anaphora = _of(devs, "anaphora")
    assert len(anaphora) == 1
    hit = anaphora[0]
    # Markers are never sung, so they must not break the run.
    assert _anchors(hit) == [(1, 0), (1, 1), (2, 0), (2, 1), (4, 0), (4, 1)]
    assert hit.detail == "3 lines"
    assert hit.confidence == 1.0


def test_epistrophe_and_symploce_are_not_double_reported():
    doc = _doc("I saw the light\nYou saw the light")
    devs, _lines, _sections, _stats = devices.analyse(doc)
    assert _of(devs, "epistrophe")
    assert not _of(devs, "symploce")
    doc2 = _doc("We stay right here tonight\nWe leave right here tonight")
    devs2, _l, _s, _st = devices.analyse(doc2)
    assert _of(devs2, "symploce")
    assert not _of(devs2, "anaphora")
    assert not _of(devs2, "epistrophe")


def test_refrain_covers_every_word_of_every_repeat():
    doc = _doc("Never gonna stop\nSomething in the air\nNever gonna stop")
    devs, _lines, _sections, _stats = devices.analyse(doc)
    refrain = _of(devs, "refrain")
    assert len(refrain) == 1
    assert refrain[0].detail == "x2"
    assert _anchors(refrain[0]) == [(0, 0), (0, 1), (0, 2), (2, 0), (2, 1), (2, 2)]


def test_anadiplosis_epizeuxis_polyptoton_antimetabole():
    doc = _doc("I finally found the light\nlight was all I ever needed")
    devs, _l, _s, _st = devices.analyse(doc)
    anadip = _of(devs, "anadiplosis")
    assert anadip and _anchors(anadip[0]) == [(0, 4), (1, 0)]

    doc = _doc("Go go go and never stop")
    devs, _l, _s, _st = devices.analyse(doc)
    epiz = _of(devs, "epizeuxis")
    assert epiz and _anchors(epiz[0]) == [(0, 0), (0, 1), (0, 2)]
    assert epiz[0].detail == "x3"

    doc = _doc("I run the day away\nShe was running out of time")
    devs, _l, _s, _st = devices.analyse(doc)
    poly = _of(devs, "polyptoton")
    assert poly and _anchors(poly[0]) == [(0, 1), (1, 2)]
    assert [s.text for s in poly[0].spans] == ["run", "running"]

    doc = _doc("I mean what I say and I say what I mean")
    devs, _l, _s, _st = devices.analyse(doc)
    anti = _of(devs, "antimetabole")
    assert anti and _anchors(anti[0]) == [(0, 1), (0, 4), (0, 7), (0, 10)]


def test_polyptoton_does_not_stem_a_function_word_into_a_content_word():
    doc = _doc("\n".join(["I but the toast with butter", "And I let the letter fall"]))
    devs, _lines, _sections, _stats = devices.analyse(doc)
    poly = _of(devs, "polyptoton")
    # The stemmer peels "butt-" off "butter" and repairs it to "but"; that is
    # a spelling coincidence, not a shared root.
    assert not [d for d in poly if d.detail == "but"], [d.label for d in poly]


# --- structure -------------------------------------------------------------


def test_enjambment_only_when_the_sentence_runs_on():
    doc = _doc("I ran across the open field\nand never looked behind me")
    devs, _l, _s, _st = devices.analyse(doc)
    enj = _of(devs, "enjambment")
    assert enj and _anchors(enj[0]) == [(0, 5), (1, 0)]

    stopped = _doc("I stopped and stood there.\nAnd then I walked away")
    devs2, _l2, _s2, _st2 = devices.analyse(stopped)
    assert not _of(devs2, "enjambment")


def test_caesura_needs_a_mark_inside_the_line():
    doc = _doc("I stopped, and then I ran away")
    devs, _l, _s, _st = devices.analyse(doc)
    caes = _of(devs, "caesura")
    assert caes and _anchors(caes[0]) == [(0, 1)]
    assert caes[0].detail == ","
    # A mark on the last word is the end of the line, not a caesura.
    assert not _of(devices.analyse(_doc("I ran away,"))[0], "caesura")


def test_name_meter_recognises_named_feet():
    assert devices.name_meter("0101010101") == ("iamb", 5)
    assert devices.name_meter("10101010") == ("trochee", 4)
    assert devices.name_meter("001001001") == ("anapest", 3)
    assert devices.name_meter("100100100100") == ("dactyl", 4)
    # A partial final foot (catalexis) still scans.
    assert devices.name_meter("010101010") == ("iamb", 4)
    # Too short, and an all-stressed line, are both rejected.
    assert devices.name_meter("0101") is None
    assert devices.name_meter("111111") is None
    assert devices.name_meter("") is None


def test_meter_device_reports_the_foot_it_matched():
    doc = _doc("I ran away\nAll of the light")
    devs, _lines, _sections, _stats = devices.analyse(doc)
    for dev in _of(devs, "meter"):
        foot = dev.detail.split(" ")[0]
        assert foot in {
            "iambic",
            "trochaic",
            "anapestic",
            "dactylic",
            "spondaic",
        }, dev.detail


# --- spans, ids, stats -----------------------------------------------------


def test_syllable_char_bounds_splits_on_vowel_groups():
    assert devices.syllable_char_bounds("fathom", 2) == ((0, 3), (3, 6))
    assert devices.syllable_char_bounds("cat", 1) == ((0, 3),)
    assert devices.syllable_char_bounds("", 2) == ()
    assert devices.syllable_char_bounds("cat", 0) == ()
    # No usable vowel groups: fall back to an even split of the letters.
    bounds = devices.syllable_char_bounds("rhythm", 3)
    assert len(bounds) == 3
    assert bounds[0][0] == 0 and bounds[-1][1] == 6
    assert all(a <= b for a, b in bounds)


def test_every_span_points_at_a_real_word():
    doc = _doc(RICH)
    devs, _lines, _sections, _stats = devices.analyse(doc)
    assert devs
    for dev in devs:
        assert dev.spans
        for s in dev.spans:
            assert 0 <= s.line < len(doc.lines)
            line = doc.lines[s.line]
            assert line.kind == "lyric"
            assert 0 <= s.word < len(line.words)
            raw = line.words[s.word].text
            end = len(raw) if s.char_end is None else s.char_end
            assert 0 <= s.char_start <= end <= len(raw)
            assert s.text == raw[s.char_start : end]


def test_device_ids_are_stable_and_unique():
    doc = _doc(RICH)
    first, _l, _s, _st = devices.analyse(doc)
    second, _l2, _s2, _st2 = devices.analyse(_doc(RICH))
    assert [d.id for d in first] == [d.id for d in second]
    assert len({d.id for d in first}) == len(first)
    assert all(d.id and d.source == "rules" for d in first)


def test_only_deterministic_families_are_emitted():
    doc = _doc(RICH)
    devs, _l, _s, _st = devices.analyse(doc)
    allowed = set(RHYME_KINDS + SOUND_KINDS + REPETITION_KINDS + STRUCTURE_KINDS)
    assert _kinds(devs) <= allowed
    assert not (_kinds(devs) & set(MEANING_KINDS))
    assert {d.family for d in devs} <= {"rhyme", "sound", "repetition", "structure"}


def test_stats_and_metrics_line_up_with_the_document():
    doc = _doc(RICH)
    devs, lines, sections, stats = devices.analyse(doc)
    assert len(lines) == len(doc.lines)
    assert [m.line for m in lines] == list(range(len(doc.lines)))
    # Markers are never sung: no words, no syllables, no letter.
    assert lines[0].words == 0 and lines[0].syllables == 0 and lines[0].letter == ""
    assert lines[1].words == len(doc.lines[1].words)
    assert lines[1].stress and set(lines[1].stress) <= {"0", "1", "2"}
    assert lines[1].end_phones and lines[1].end_key
    assert stats.lines == 6
    assert stats.words == sum(len(ln.words) for ln in doc.lines if ln.kind == "lyric")
    assert 0.0 < stats.ttr <= 1.0
    assert stats.rhyme_density == 1.0
    assert stats.avg_syllables_per_line > 0
    assert sum(stats.devices_by_kind.values()) == len(devs)
    assert sum(stats.devices_by_family.values()) == len(devs)
    assert sum(s.lines for s in sections) == 6


# --- degenerate input ------------------------------------------------------


def test_empty_document():
    devs, lines, sections, stats = devices.analyse(LyricsDoc(entry_id="e"))
    assert devs == [] and lines == [] and sections == []
    assert stats.lines == 0 and stats.ttr == 0.0 and stats.rhyme_density == 0.0


def test_marker_only_document():
    doc = _doc("[Chorus]")
    devs, lines, sections, stats = devices.analyse(doc)
    assert devs == []
    assert len(lines) == 1 and lines[0].section == "Chorus"
    assert len(sections) == 1 and sections[0].scheme == "" and sections[0].lines == 0
    assert stats.words == 0


def test_single_line_and_lines_without_words():
    devs, lines, _sections, _stats = devices.analyse(_doc("One line only"))
    assert devs == [] or all(d.spans for d in devs)
    assert len(lines) == 1

    # A lyric line with no word list can be measured but never anchored to.
    doc = LyricsDoc(entry_id="e", lines=[LyricLine(text="hello world", words=[])])
    devs, lines, _sections, _stats = devices.analyse(doc)
    assert devs == []
    assert lines[0].words == 2 and lines[0].syllables > 0

    blank = LyricsDoc(entry_id="e", lines=[LyricLine(text="")])
    devs, lines, sections, stats = devices.analyse(blank)
    assert devs == [] and len(lines) == 1 and stats.lines == 0
    assert sections[0].scheme == ""


def test_non_ascii_and_punctuation_only_lines():
    doc = _doc("Café con leche niño\n— — —\nStraße über alles\n¿Qué pasa?")
    devs, lines, _sections, _stats = devices.analyse(doc)
    assert len(lines) == 4
    for dev in devs:
        for s in dev.spans:
            assert s.text


def test_a_very_long_line_stays_bounded():
    phrase = "the quick brown fox jumps over a lazy dog while singing softly"
    devs, lines, _sections, stats = devices.analyse(_doc(" ".join([phrase] * 40)))
    assert lines[0].words == 480
    assert stats.words == 480
    assert all(d.spans for d in devs)


def test_a_line_with_no_analysable_words_before_a_normal_one():
    """`_ends_open` reads raw text, so a CJK / emoji / punctuation-only line
    looks like an open line ending while contributing no token — enjambment
    used to index its empty token list and raise."""
    for opener in ("日本語 の 歌詞", "... !!! ---", "🎵 🎶", "— —"):
        devs, lines, _sections, _stats = devices.analyse(
            _doc(f"{opener}\nand the night goes on")
        )
        assert len(lines) == 2
        for dev in devs:
            for s in dev.spans:
                assert s.text
    # ... and the same line in the trailing position, and on both sides.
    devices.analyse(_doc("and the night goes on\n日本語 の 歌詞"))
    devices.analyse(_doc("日本語 の 歌詞\n歌詞 の 日本語"))


def test_multisyllabic_rhyme_inside_one_line():
    """A run is generated at every start offset, so on one line a pair is
    separated in sort order by the overlapping variants of its own right-hand
    run. Pairing only neighbours let the overlap guard reject every pair, and
    the internal multisyllabic rhyme — the rap line's whole point — vanished."""
    one = devices.analyse(_doc("Riding the elevation, hiding the medication"))
    two = devices.analyse(_doc("Riding the elevation\nHiding the medication"))
    kinds_one = sorted(d.detail for d in one[0] if d.kind == "multisyllabic-rhyme")
    kinds_two = sorted(d.detail for d in two[0] if d.kind == "multisyllabic-rhyme")
    assert (
        kinds_one
        == kinds_two
        == [
            "2 syllables: EY SH AH N",
            "3 syllables: AY D IH NG DH AH",
        ]
    )
    assert one[3].multisyllabic_rhymes == two[3].multisyllabic_rhymes == 2
    # The halves are the words they name, anchored to the rhyming tail only:
    # "ele|vation" / "medi|cation" is what char_start exists for.
    pair = next(d for d in one[0] if d.detail == "2 syllables: EY SH AH N")
    assert [sp.text for sp in pair.spans] == ["vation", "cation"]
    assert [(sp.line, sp.word) for sp in pair.spans] == [(0, 2), (0, 5)]
    assert [sp.char_start for sp in pair.spans] == [3, 4]


def test_a_line_with_no_multisyllabic_rhyme_reports_none():
    devs, _lines, _sections, stats = devices.analyse(
        _doc("The cat sat on the mat\nA dog ran past it flat")
    )
    assert stats.multisyllabic_rhymes == 0
    assert not [d for d in devs if d.kind == "multisyllabic-rhyme"]


# --- rhyme: the shapes a lyric actually uses -------------------------------

# 24 lines with a scheme a reader can hear, written around the failure shapes
# the rules-only matcher used to drop: -tion against -sion against -ence, a
# coda that grew or lost a consonant, one vowel step, sung g-dropping, a
# multi-word ending and a trailing ad-lib.
SCHEMED = """[Verse 1]
I was counting every hour in the station
Waiting on a word that never came, an occasion
Somebody said the city keeps its patience
Everything is fading in a conversation
I had it in my hand and then I lost it
Every single door I opened had a cost
You told me hold on, I was staring at the cold dawn
Everything I built was gone before the song
[Chorus]
So I'm runnin' and I'm hidin' from the man
Doing what I said I never said I can
Take me to the water, let me be the one
Burning like a candle underneath the sun
[Verse 2]
There's a bitter little promise on my tongue
And a premise that I traded when I was young
I remember all the reasons in the pieces
Half a million broken villains and their seasons
Give me one more reason, tell me one more season
Every kind of leaving has another meaning
Now the shoulder of the soldier that was leaning
Turned to nothing but the something I was dreaming
[Outro]
Nothing left behind me but the fire, yeah
Only what I gave away, desire, yeah
"""


def _lettered(doc, lines):
    """(lyric line count, how many of those endings landed in a rhyme class)."""
    lyric = [
        m for m, ln in zip(lines, doc.lines) if ln.kind == "lyric" and ln.text.strip()
    ]
    return len(lyric), sum(1 for m in lyric if m.letter)


def test_most_line_endings_in_a_real_lyric_find_a_rhyme():
    """The user's complaint in one assertion: "a ton of lines that it just
    couldn't detect any rhyme or reason". Before the scored comparison this
    lyric left 9 of its 22 endings with no rhyme class at all."""
    doc = _doc(SCHEMED)
    _devs, lines, _sections, stats = devices.analyse(doc)
    total, lettered = _lettered(doc, lines)
    assert total == 22
    assert lettered >= 21, [
        (m.line, m.end_key) for m in lines if m.section and not m.letter
    ]
    assert stats.rhyme_density >= 0.85


def test_the_tion_sion_ence_family_lands_in_one_rhyme_class():
    """ "station"/"occasion"/"patience" is the shape that returned ("", 0.0):
    close on both the nucleus and the tail, identical on neither."""
    doc = _doc(
        "\n".join(
            [
                "I was counting every hour in the station",
                "Waiting on a word that never came, an occasion",
                "Somebody said the city keeps its patience",
            ]
        )
    )
    _devs, lines, sections, _stats = devices.analyse(doc)
    assert sections[0].scheme == "AAA", [m.end_key for m in lines]


def test_a_line_ending_rhymes_on_a_run_of_words_not_only_the_last_one():
    """ "meant it"/"spent it" is the rhyme a reader hears; the last word alone
    is the same word twice, which says "identical rhyme: it / it"."""
    doc = _doc("Everything I said I meant it\nEvery hour of it I spent it")
    devs, lines, _sections, _stats = devices.analyse(doc)
    assert lines[0].letter == lines[1].letter == "A"
    pair = next(d for d in devs if d.family == "rhyme" and len(d.spans) == 4)
    assert [s.text for s in pair.spans] == ["meant", "it", "spent", "it"]
    assert "meant it" in pair.label and "spent it" in pair.label


def test_a_trailing_adlib_does_not_become_the_rhyme():
    """Lyric sheets end line after line on "yeah" / "oh" / "now". Reading the
    ad-lib as the rhyme makes every one of those lines rhyme with every other
    and hides the rhyme the writer actually wrote."""
    doc = _doc("I was walking on my own, yeah\nEverything I ever known, yeah")
    devs, lines, _sections, _stats = devices.analyse(doc)
    assert lines[0].letter == lines[1].letter == "A"
    ends = [d for d in devs if d.family == "rhyme" and len(d.spans) >= 2]
    assert ends, _kinds(devs)
    painted = {s.text.strip(",") for d in ends for s in d.spans}
    assert "own" in painted and "known" in painted
    # ...and the throwaway is not what the two lines were matched on.
    assert painted != {"yeah"}


def test_a_perfect_last_word_rhyme_is_never_restated_as_a_phrase():
    """The run comparison only wins by a margin, so the halves the UI paints
    stay the words a reader would point at."""
    doc = _doc(RICH)
    devs, _lines, _sections, _stats = devices.analyse(doc)
    ends = _of(devs, "end-rhyme")
    night = next(d for d in ends if _anchors(d) == [(1, 6), (3, 6)])
    assert [s.text for s in night.spans] == ["night", "light"]


def test_sung_g_dropping_rhymes_with_the_spelled_out_word():
    doc = _doc("I never stopped runnin'\nNothing ever felt like coming")
    _devs, lines, _sections, _stats = devices.analyse(doc)
    assert lines[0].letter == lines[1].letter == "A"


def test_no_rhyme_class_is_invented_for_a_lyric_that_does_not_rhyme():
    """The other half of "more robust": lifting recall must not turn every
    line into an A."""
    doc = _doc(
        "\n".join(
            [
                "The orange machine was left in the garden",
                "A whistle and a pocket full of velvet",
                "Somebody put the piano in the forest",
                "Nothing but a jacket and a torch",
            ]
        )
    )
    _devs, lines, sections, _stats = devices.analyse(doc)
    assert sections[0].scheme == "XXXX", [m.end_key for m in lines]


def test_the_scheme_is_stable_across_two_runs_of_the_same_lyric():
    first = devices.analyse(_doc(SCHEMED))
    second = devices.analyse(_doc(SCHEMED))
    assert [m.letter for m in first[1]] == [m.letter for m in second[1]]
    assert [d.id for d in first[0]] == [d.id for d in second[0]]


def test_a_shared_ad_lib_does_not_make_a_rhyme_class():
    """Four lines that do not rhyme, each ending on the same thrown-away
    "yeah". The ad-lib is the only thing they share, and sharing it is not a
    rhyme: this came back "AAAA" because the ending was classed on its last
    word, and "garden yeah" against "velvet yeah" is a perfect 1.0 that means
    only that both singers said "yeah"."""
    doc = _doc(
        "\n".join(
            [
                "The orange machine was left in the garden, yeah",
                "A whistle and a pocket full of velvet, yeah",
                "Somebody put the piano in the forest, yeah",
                "Nothing but a jacket and a torch, yeah",
            ]
        )
    )
    _devs, lines, sections, _stats = devices.analyse(doc)
    assert sections[0].scheme == "XXXX", [m.end_key for m in lines]


def test_a_real_rhyme_is_still_found_under_a_shared_ad_lib():
    """The other half: dropping the ad-lib must not drop the rhyme in front
    of it. These two lines end on "rain"/"pain" and rhyme; the two after them
    end on "garden"/"velvet" and do not."""
    doc = _doc(
        "\n".join(
            [
                "I feel it comin' down like rain, yeah",
                "I never really felt the pain, yeah",
                "The orange machine is in the garden, yeah",
                "A whistle and a pocket full of velvet, yeah",
            ]
        )
    )
    _devs, lines, sections, _stats = devices.analyse(doc)
    assert sections[0].scheme == "AAXX", [m.letter for m in lines]


def test_an_unstressed_particle_ending_still_rhymes_as_a_phrase():
    """The particle throwaway is NOT the ad-lib throwaway: "...meant it" does
    end on "it", and the rhyme is the whole phrase. Dropping every shared
    trailing word would have taken this with it."""
    doc = _doc("Said I never meant it\nBut I know I spent it")
    _devs, lines, sections, _stats = devices.analyse(doc)
    assert sections[0].scheme == "AA", [m.letter for m in lines]
