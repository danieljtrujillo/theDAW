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
    doc = _doc("\n".join(["I saw the light —", "You felt the night —"]))
    devs, lines, _sections, _stats = devices.analyse(doc)
    assert [m.letter for m in lines] == ["A", "A"]
    # The cross-line pass is for MID-line words; it must not pick the ending up
    # and report it under its own name, colour and confidence floor.
    assert not _of(devs, "cross-line-rhyme")
    ends = _of(devs, "end-rhyme")
    assert ends
    for dev in ends:
        assert dev.label.startswith("end rhyme")
        assert dev.group.startswith("rhyme-s")
    # A third line on the same rhyme makes it a run, and a run replaces the
    # pairs inside it — the ending is still the word in front of the dash.
    devs, _l, _s, _st = devices.analyse(
        _doc(
            "\n".join(
                ["I saw the light —", "You felt the night —", "We found the sight —"]
            )
        )
    )
    runs = _of(devs, "rhyme-run")
    assert len(runs) == 1 and not _of(devs, "end-rhyme"), _kinds(devs)
    assert [s.text for s in runs[0].spans] == ["light", "night", "sight"]


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


def test_assonance_hears_the_colour_not_the_symbol():
    """ "sleep / lift / green / mist" is one vowel colour and four symbols.

    The exact-vowel pass reports the IY pair and the IH pair and nothing that
    joins them, because IY and IH are 0.44 apart on the RHYME scale — which is
    the right distance for a rhyme and the wrong one for assonance.
    """
    doc = _doc("Sleep lifts the green city drifting in the mist")
    devs, _lines, _sections, _stats = devices.analyse(doc)
    near = [d for d in _of(devs, "assonance") if "~" in d.detail]
    assert near, [d.detail for d in _of(devs, "assonance")]
    hit = max(near, key=lambda d: len(d.spans))
    assert {"IY", "IH"} <= set(hit.phones)
    # A near run is a softer claim than an exact one and has to look like it.
    assert hit.confidence < 1.0
    assert all(
        d.confidence == 1.0 for d in _of(devs, "assonance") if "~" not in d.detail
    )


def test_a_colour_run_may_not_drift_across_the_vowel_space():
    """Every member is measured against every other, never against its neighbour.

    Chained neighbour to neighbour, "green / grin / grand / grunt" walks from
    IY to AH one comfortable step at a time and comes out as one run.
    """
    doc = _doc("The green grin was grand and grunt")
    devs, _lines, _sections, _stats = devices.analyse(doc)
    for dev in _of(devs, "assonance"):
        vowels = set(dev.phones)
        assert not ({"IY", "AH"} <= vowels), dev.detail


def test_assonance_carries_over_a_line_break():
    doc = _doc("I keep the green machine\nSleep was all it needed")
    devs, _lines, _sections, _stats = devices.analyse(doc)
    across = [d for d in _of(devs, "assonance") if "across the line break" in d.detail]
    assert across, [d.detail for d in _of(devs, "assonance")]
    assert len({s.line for s in across[0].spans}) == 2


def test_consonance_joins_a_family_not_only_a_phone():
    """S and Z are one sound wearing two hats: "dogs" ends in Z."""
    doc = _doc("Rivers of glass and razors in the dust")
    devs, _lines, _sections, _stats = devices.analyse(doc)
    family = [d for d in _of(devs, "consonance") if "~" in d.detail]
    assert family, [d.detail for d in _of(devs, "consonance")]
    assert set(family[0].phones) == {"S", "Z"}
    assert family[0].confidence < 0.8


def test_alliteration_runs_past_the_light_words_in_between():
    """The gap is counted in words that could have CARRIED the sound.

    "went over there and" is four words no consonant run can be built from, so
    charging them against the run's budget cut one hiss into two halves with
    nothing reported in the middle.
    """
    devs, _lines, _sections, _stats = devices.analyse(
        _doc("Silly Sally went over there and sang softly")
    )
    allit = [d for d in _of(devs, "alliteration") if d.detail == "S"]
    assert len(allit) == 1, [d.label for d in allit]
    assert _anchors(allit[0]) == [(0, 0), (0, 1), (0, 6), (0, 7)]


def test_alliteration_runs_on_through_the_line_break():
    """A hiss does not stop at the end of a line, so the pass cannot either."""
    devs, _lines, _sections, _stats = devices.analyse(
        _doc("The silver city slept in silence\nSoftly the sea sang its psalm")
    )
    allit = [d for d in _of(devs, "alliteration") if d.detail == "S"]
    assert len(allit) == 1, [d.label for d in allit]
    assert len(allit[0].spans) == 8
    assert {s.line for s in allit[0].spans} == {0, 1}


def test_alliteration_joins_a_family_not_only_a_phone():
    """T and D open one sound wearing two hats, the way S and Z close one."""
    devs, _lines, _sections, _stats = devices.analyse(
        _doc("Tender days and dusty towns and dimming light")
    )
    family = [d for d in _of(devs, "alliteration") if "~" in d.detail]
    assert family, [d.detail for d in _of(devs, "alliteration")]
    assert set(family[0].phones) == {"T", "D"}
    # A family run is the softer claim and has to look like it.
    assert family[0].confidence < 1.0


def test_consonance_runs_on_through_the_line_break():
    devs, _lines, _sections, _stats = devices.analyse(
        _doc("The silver city slept in silence\nSoftly the sea sang its psalm")
    )
    across = [d for d in _of(devs, "consonance") if len({s.line for s in d.spans}) > 1]
    assert across, [d.label for d in _of(devs, "consonance")]


def test_a_sound_run_is_not_the_whole_song():
    """The reach, stated. Four lines is a quatrain and a thing a writer holds
    on purpose; six is every /s/ in the song wearing one label."""
    doc = _doc(
        "Sing the song sweet\nSell the same soul\nSee the silver sea\n"
        "Say the softest sound\nSit the silent star\nSeek the sunken ship"
    )
    devs, _lines, _sections, _stats = devices.analyse(doc)
    # LYRIC lines, not document lines: a marker or a blank between two lines of
    # a verse costs a run nothing.
    prepared, _sects = devices._prepare(doc)
    lyric = [ln.index for ln in prepared if ln.is_lyric]
    runs = [d for d in devs if d.kind == "alliteration" and "openings" not in d.detail]
    assert runs
    for dev in runs:
        first, last = min(s.line for s in dev.spans), max(s.line for s in dev.spans)
        reach = sum(1 for i in lyric if first <= i <= last)
        assert reach <= devices.SOUND_LINE_REACH + 1, f"{dev.label}: {reach} lines"
    # ...and one of them does reach the four the ceiling allows.
    assert max(len({s.line for s in d.spans}) for d in runs) == 4


def test_a_sound_run_is_not_broken_by_a_section_marker():
    """A marker is never sung, so it cannot interrupt a sound either — the
    same rule the repetition passes have always followed."""
    devs, _lines, _sections, _stats = devices.analyse(
        _doc("[Verse 1]\nI keep the green machine\n[Chorus]\nSleep was all it needed")
    )
    across = [d for d in _of(devs, "assonance") if "across the line break" in d.detail]
    assert across, [d.detail for d in _of(devs, "assonance")]
    assert {s.line for s in across[0].spans} == {1, 3}


def test_sibilance_covers_the_whole_hiss_not_the_best_window():
    """The window is how the density is measured, not how far it may reach.

    Thirteen sibilant words reported as the best six of them threw away seven
    words of what the writer actually did.
    """
    devs, _lines, _sections, _stats = devices.analyse(
        _doc("She sells sea shells, so she surely sings sweet silly songs since Sunday")
    )
    sib = _of(devs, "sibilance")
    assert len(sib) == 1, [d.label for d in sib]
    assert [s.word for s in sib[0].spans] == list(range(13))
    assert "of the run" in sib[0].detail


def test_sibilance_can_fire_twice_on_one_line():
    """Two hisses a whole window apart are two things the ear heard, not one
    thing with a hole in it."""
    devs, _lines, _sections, _stats = devices.analyse(
        _doc(
            "Sister sings so soft, then a big bad dog barked at me, and Cass sees six sad seas"
        )
    )
    sib = _of(devs, "sibilance")
    assert len(sib) == 2, [d.label for d in sib]
    assert [s.word for s in sib[0].spans] == [0, 1, 2, 3]
    assert [s.word for s in sib[1].spans] == [13, 14, 15, 16, 17]


def test_plosive_reaches_past_the_window_too():
    """Both density detectors share one pass, so both have to grow."""
    devs, _lines, _sections, _stats = devices.analyse(
        _doc("Tender days and dusty towns and dimming light")
    )
    plos = _of(devs, "plosive")
    assert plos, _kinds(devs)
    assert len(plos[0].spans) > devices.DENSITY_WINDOW


def test_a_long_run_is_named_by_its_ends_not_by_all_of_it():
    """A label has to say where a long run ENDS. The pane clips one past 90
    characters, and a clipped label hides exactly that."""
    devs, _lines, _sections, _stats = devices.analyse(
        _doc("She sells sea shells, so she surely sings sweet silly songs since Sunday")
    )
    sib = _of(devs, "sibilance")[0]
    assert len(sib.spans) == 13
    assert sib.label == "sibilance: She / sells / sea / shells, / … / Sunday"
    assert len(sib.label) <= 90


def test_a_hiss_carries_on_through_the_line_break():
    """The density passes read the same one axis the other sound passes read.

    A hiss that ends one line and opens the next is one thing the ear followed;
    reading the lyric line by line reported it as two halves of itself.
    """
    devs, _lines, _sections, _stats = devices.analyse(
        _doc("She sells sea shells\nSo she surely sings")
    )
    sib = _of(devs, "sibilance")
    assert len(sib) == 1, [d.label for d in sib]
    assert _anchors(sib[0]) == [
        (0, 0),
        (0, 1),
        (0, 2),
        (0, 3),
        (1, 0),
        (1, 1),
        (1, 2),
        (1, 3),
    ]
    assert "across the line break" in sib[0].detail


def test_two_hisses_a_line_of_something_else_apart_are_still_two():
    """The reach is a budget, not an invitation: a line of other material
    between two hisses is exactly the gap that makes them two findings."""
    devs, _lines, _sections, _stats = devices.analyse(
        _doc(
            "Silver sunlight settles slow\n"
            "Wandering over the lonely mountain\n"
            "So the summer sings"
        )
    )
    sib = _of(devs, "sibilance")
    assert len(sib) == 2, [d.label for d in sib]
    assert {s.line for s in sib[0].spans} == {0}
    assert {s.line for s in sib[1].spans} == {2}


def test_a_density_finding_never_reports_a_ratio_under_its_own_floor():
    """``min_ratio`` is what makes the finding a claim that the sound is DENSE
    rather than that it is present, so it has to hold over the span the finding
    covers — not only over the six-word window that found it."""
    floors = {
        "sibilance": devices.SIBILANCE_MIN_RATIO,
        "plosive": devices.PLOSIVE_MIN_RATIO,
    }
    for text in (RICH, SCHEMED, BALLAD, CALLBACK, LONG_ABAB):
        devs, _lines, _sections, _stats = devices.analyse(_doc(text))
        for dev in devs:
            floor = floors.get(dev.kind)
            if floor is None:
                continue
            reported = int(dev.detail.split("phones, ")[1].split("%")[0])
            assert reported >= round(floor * 100), (dev.detail, dev.label)


def test_a_hiss_that_would_dilute_itself_stops_instead_of_thinning_out():
    """Asked for a floor the whole run cannot hold, the pass has to come back
    with the dense stretch inside it rather than with the long thin one — that
    is the guarantee that lets a finding reach across a line at all."""
    lines, _sects = devices._prepare(
        _doc("She sells sea shells, so she surely sings sweet silly songs since Sunday")
    )
    whole = devices._Out()
    devices._emit_density(
        lines,
        whole,
        "sibilance",
        devices._SIBILANTS,
        devices.SIBILANCE_MIN_COUNT,
        devices.SIBILANCE_MIN_RATIO,
    )
    assert [len(d.spans) for d in whole.devices] == [13]
    assert whole.devices[0].detail == "18 phones, 39% of the run"
    # ...and 39% is under a floor of 45%, so at that floor the same lyric comes
    # back as the half of it that is really that dense.
    strict = devices._Out()
    devices._emit_density(
        lines,
        strict,
        "sibilance",
        devices._SIBILANTS,
        devices.SIBILANCE_MIN_COUNT,
        0.45,
    )
    assert [[s.text for s in d.spans] for d in strict.devices] == [
        ["She", "sells", "sea", "shells", "so", "she"]
    ]
    assert strict.devices[0].detail == "8 phones, 50% of the run"


# --- double meanings -------------------------------------------------------


def test_homophone_play_is_found_when_both_spellings_are_written():
    doc = _doc("I sold my sole for a soul I could keep")
    devs, _lines, _sections, _stats = devices.analyse(doc)
    puns = _of(devs, "pun")
    assert puns, _kinds(devs)
    assert [s.text for s in puns[0].spans] == ["sole", "soul"]
    assert puns[0].family == "meaning" and puns[0].source == "rules"


def test_a_heteronym_is_reported_with_both_of_its_senses():
    doc = _doc("The record shows I record every night")
    devs, _lines, _sections, _stats = devices.analyse(doc)
    hits = [d for d in devs if d.label.startswith("heteronym: record")]
    assert hits, [d.label for d in devs if d.family == "meaning"]
    assert "the disc" in hits[0].detail and "to capture" in hits[0].detail
    assert [s.word for s in hits[0].spans] == [1, 4]


def test_a_second_sense_used_twice_outranks_one_used_once():
    doc = _doc("They said the bars would hold me\nSo I put the bars on wax")
    devs, _lines, _sections, _stats = devices.analyse(doc)
    twice = [d for d in devs if d.group == "sense-bars"]
    once = [d for d in devs if d.group == "sense-hold"]
    assert twice and once
    assert twice[0].kind == "double-entendre" and once[0].kind == "dual-meaning"
    assert twice[0].confidence > once[0].confidence


def test_function_words_never_carry_a_meaning_finding():
    """ "to" sounds like "two" in every English sentence ever written."""
    doc = _doc("I went to the show for the night")
    devs, _lines, _sections, _stats = devices.analyse(doc)
    words = {s.text.lower() for d in devs if d.family == "meaning" for s in d.spans}
    assert not (words & {"to", "for", "the"}), words


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
    """The rules pass emits what it can PROVE, in every family.

    ``meaning`` is no longer LLM-only: a homophone play, a heteronym and a
    word with a second sense are facts about the language, not readings of the
    lyric, so the deterministic pass finds them. What it must never emit is
    the interpretive half of the family — metaphor, irony, imagery and the
    rest are the model's to propose, and a rule claiming one would be a guess
    wearing a rule's confidence.
    """
    doc = _doc(RICH)
    devs, _l, _s, _st = devices.analyse(doc)
    checkable = {"pun", "double-entendre", "dual-meaning"}
    allowed = set(RHYME_KINDS + SOUND_KINDS + REPETITION_KINDS + STRUCTURE_KINDS)
    assert _kinds(devs) <= allowed | checkable
    assert not (_kinds(devs) & (set(MEANING_KINDS) - checkable))
    assert {d.family for d in devs} <= {
        "rhyme",
        "sound",
        "repetition",
        "structure",
        "meaning",
    }
    assert all(d.source == "rules" for d in devs)


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


# --- shape of a scheme over distance ---------------------------------------
#
# Every fixture below was tuned by running it: the thresholds in devices.py are
# the numbers that make these findings come out the way a reader would say them
# out loud. Each rhyme is spelled in parallel, so the assertions hold with and
# without cmudict and a machine with no dictionary sees the same shapes.

MONORHYME = """[Verse 1]
I been up in the booth every night
Counting all the shadows in the light
Nobody could tell me I was right
Every little word another bite
Holding up a candle pulling tight
Watching how the city turn to white
Everything I wanted in my sight
Told 'em that I'd never lose a fight
"""

CALLBACK = """[Verse 1]
I was driving through the city in the rain
Every window looking back at me the same
Nothing in the mirror but the ache again
Somebody was calling out my name
[Chorus]
And I hold on to the fire
Everything I ever wanted, taking me higher
[Verse 2]
Now the morning came around and took the day
Left me with a pocket full of nothing left to say
Every little promise was another thing to pay
Sitting on the corner where the children used to play
Counting up the hours that I gave away
Nobody ever told me it would end this way
And the only thing I kept was my desire
Burning like the ashes of a wire
"""

BALLAD = """[Verse 1]
The river runs beside the road
It carries every stone away
I left my heavy winter coat
And walked into the empty day
[Verse 2]
A candle in the window burns
It flickers like a passing bird
The quiet of the evening turns
And nobody has said a word
[Verse 3]
I found a letter in the snow
The ink had faded into blue
There was a name I used to know
And every line of it was true
"""

BOOKENDED = """[Verse 1]
I left the door wide open in the rain
Nobody came to find me in the dark
A single light was burning in the park
And every night I hear the midnight train
"""

CHAINED = """[Verse 1]
I keep the little letters hanging on the wall
The morning came around and took the light
Every single word you said before the fall
Nothing in the water and the sky was green
There was never any reason for the call
I remember every summer that we lost
You were standing in the middle of it all
Somebody said the city never sleeps
Everything I ever wanted was too tall
There was a photograph I never kept
And I was only counting up the days
Every night I hear it in the hall
"""

LONG_ABAB = """[Verse 1]
I walk beside the river in the rain
It carries all the pieces to the sea
And every step I take feels like a chain
There's nothing in the water left for me
The sky is opening above the lane
As quiet as a bird inside a tree
I never heard the whistle of the train
And nobody was waiting there to see
Somebody left a candle in the drain
And now the only quiet is a plea
"""

MULTI_CALLBACK = """[Chorus]
You know I really need it now
Nothing in the quiet little room
[Verse 2]
I was walking past the river with my collar up
Every single window on the avenue was bright
Somebody was selling out the corner for a dime
Nobody was listening to anything at all
There was a radio repeating what the city said
Only in the morning did the traffic ever move
Counting all the numbers on the meter as I drive
And I never really wanted anybody here
[Chorus]
Watch me plant a seed it grows
Nothing in the quiet little room
"""

_SHAPE_KINDS = {"rhyme-run", "rhyme-chain", "callback", "bookend"}


def test_a_monorhyme_verse_is_one_run_not_a_pile_of_pairs():
    """Eight lines on one rhyme used to come back as seven unrelated pairs and
    nothing at all that said "eight"."""
    devs, _lines, sections, stats = devices.analyse(_doc(MONORHYME))
    assert sections[0].scheme == "AAAAAAAA"
    runs = _of(devs, "rhyme-run")
    assert len(runs) == 1, _kinds(devs)
    run = runs[0]
    assert [s.text for s in run.spans] == [
        "night",
        "light",
        "right",
        "bite",
        "tight",
        "white",
        "sight",
        "fight",
    ]
    assert run.detail == "8 consecutive lines: AY T"
    assert run.label == "rhyme run: night / light / right / … / fight"
    assert run.group == "rhyme-s0-A" and run.family == "rhyme"
    # ...and the pairs it is made of are not listed underneath it.
    assert not _of(devs, "end-rhyme")
    assert stats.devices_by_kind["rhyme-run"] == 1


def test_a_run_counts_lyric_lines_so_a_marker_does_not_break_it():
    """Consecutive means consecutive LYRIC lines. Nobody sings the marker or
    the blank line under it, so neither one interrupts the run."""
    doc = _doc(
        "[Verse 1]\nI saw it in the light\nYou felt it in the night\n\n"
        "[Chorus]\nWe found it in the sight\n"
    )
    devs, _lines, _sections, _stats = devices.analyse(doc)
    runs = _of(devs, "rhyme-run")
    assert len(runs) == 1, _kinds(devs)
    assert [(s.line, s.text) for s in runs[0].spans] == [
        (1, "light"),
        (2, "night"),
        (5, "sight"),
    ]
    assert runs[0].detail == "3 consecutive lines: AY T"


def test_a_hook_rhyme_returning_in_a_later_verse_is_a_callback():
    """The headline. The chorus rhymes on "-ire", the verse spends six lines
    somewhere else, and then "-ire" comes back — which is what a listener
    actually notices, and the one thing no windowed pass can see."""
    devs, _lines, _sections, _stats = devices.analyse(_doc(CALLBACK))
    calls = _of(devs, "callback")
    assert len(calls) == 1, _kinds(devs)
    hit = calls[0]
    assert [(s.line, s.text) for s in hit.spans] == [(7, "higher"), (15, "sire")]
    assert hit.detail == "returns after 6 lines: Chorus → Verse 2"
    # Coloured as the class that established it, so the UI paints the return in
    # the chorus's colour.
    assert hit.group == "rhyme-s1-A" and hit.family == "rhyme"


def test_the_verse_under_that_callback_is_reported_as_its_own_run():
    devs, _lines, _sections, _stats = devices.analyse(_doc(CALLBACK))
    runs = _of(devs, "rhyme-run")
    assert len(runs) == 1, _kinds(devs)
    assert runs[0].detail == "6 consecutive lines: EY"
    assert [s.text for s in runs[0].spans] == [
        "day",
        "say",
        "pay",
        "play",
        "way",
        "way",
    ]


def test_a_multisyllabic_tail_returns_from_further_than_the_pairwise_pass_looks():
    """ "need it" / "seed it", nine lines apart and mid-line at the far end.
    The multisyllabic pass stops at MULTI_LINE_WINDOW, so nothing looked."""
    devs, _lines, _sections, _stats = devices.analyse(_doc(MULTI_CALLBACK))
    calls = _of(devs, "callback")
    assert len(calls) == 1, _kinds(devs)
    hit = calls[0]
    assert [s.text for s in hit.spans] == ["need", "it", "seed", "it"]
    assert hit.detail == "2 syllables returning after 9 lines back in Chorus: IY D IH T"
    assert hit.spans[2].line - hit.spans[0].line > devices.MULTI_LINE_WINDOW


def test_a_rhyme_threaded_through_a_verse_with_gaps_is_a_chain():
    devs, _lines, _sections, _stats = devices.analyse(_doc(CHAINED))
    chains = _of(devs, "rhyme-chain")
    assert len(chains) == 1, _kinds(devs)
    hit = chains[0]
    assert [(s.line, s.text) for s in hit.spans] == [
        (1, "wall"),
        (3, "fall"),
        (5, "call"),
        (7, "all"),
        (9, "tall"),
        (12, "hall"),
    ]
    assert hit.detail == "6 lines across 12: AO L"
    assert hit.group == "rhyme-s0-A"
    # A chain is not a run: no two of those lines are next to each other.
    assert not _of(devs, "rhyme-run")


def test_a_section_that_opens_and_closes_on_one_rhyme_is_a_bookend():
    devs, _lines, sections, _stats = devices.analyse(_doc(BOOKENDED))
    assert sections[0].scheme == "ABBA"
    ends = _of(devs, "bookend")
    assert len(ends) == 1, _kinds(devs)
    hit = ends[0]
    assert [(s.line, s.text) for s in hit.spans] == [(1, "rain"), (4, "train")]
    assert hit.detail == "Verse 1 opens and closes on EY N"
    assert hit.group == "rhyme-s0-A"
    # The couplet inside the envelope is still an ordinary pair.
    pairs = _of(devs, "end-rhyme")
    assert len(pairs) == 1
    assert [s.text for s in pairs[0].spans] == ["dark", "park"]


def test_an_ordinary_abab_ballad_lights_up_no_shape_at_all():
    """The other half of the tuning, and the reason the shapes are cut on a
    stricter floor than the scheme letters are: the classifier is happy to call
    "bird" a slant rhyme of "burns", so every stanza here is one class, and a
    shape read straight off those classes would report three four-line
    monorhyme runs in a plain ABAB ballad."""
    devs, _lines, sections, _stats = devices.analyse(_doc(BALLAD))
    assert [s.scheme for s in sections] == ["ABAB", "AAAA", "AAAA"]
    assert not _kinds(devs) & _SHAPE_KINDS


def test_sustained_abab_over_ten_lines_is_still_not_a_chain():
    """Five members every other line is exactly what alternation looks like, so
    it takes a sixth, or the same five spread wider, to read as a thread."""
    devs, _lines, sections, _stats = devices.analyse(_doc(LONG_ABAB))
    assert sections[0].scheme == "ABABABABAB"
    assert not _kinds(devs) & _SHAPE_KINDS
    assert len(_of(devs, "end-rhyme")) == 8


def test_a_run_replaces_its_pairs_but_never_the_multisyllabic_detail():
    """The relationship, stated. A run says everything its end-rhyme pairs say,
    so they go; it says nothing about the multisyllabic rhyme inside it, which
    is the best finding in the pane, so that stays."""
    devs, _lines, _sections, _stats = devices.analyse(_doc(SCHEMED))
    run = next(
        d
        for d in _of(devs, "rhyme-run")
        if [s.text for s in d.spans] == ["meaning", "leaning", "dreaming"]
    )
    inside = {s.line for s in run.spans}
    assert not [
        d
        for d in devs
        if d.kind in ("end-rhyme", "slant-rhyme")
        and {s.line for s in d.spans} <= inside
    ]
    multi = next(
        d
        for d in _of(devs, "multisyllabic-rhyme")
        if [s.text for s in d.spans] == ["meaning", "leaning"]
    )
    assert multi.group == run.group


def test_no_shape_is_reported_twice_under_two_kinds():
    """The module's precedence rule, over the shape fixtures. A callback and a
    bookend name exactly two endings, which is the shape a pairwise rhyme
    device has, so they claim the pair out of the same set every other detector
    reads and nothing lists those two words twice."""
    for name, text in (
        ("monorhyme", MONORHYME),
        ("callback", CALLBACK),
        ("ballad", BALLAD),
        ("bookended", BOOKENDED),
        ("chained", CHAINED),
        ("multi-callback", MULTI_CALLBACK),
    ):
        devs, _lines, _sections, _stats = devices.analyse(_doc(text))
        seen: dict[tuple, str] = {}
        for dev in devs:
            if dev.family != "rhyme" or len(dev.spans) != 2:
                continue
            key = tuple(sorted(_anchors(dev)))
            assert key not in seen, f"{name}: {key} is {seen[key]} and {dev.kind}"
            seen[key] = dev.kind


def test_shape_findings_are_stable_and_land_on_real_words():
    for text in (MONORHYME, CALLBACK, CHAINED, BOOKENDED, MULTI_CALLBACK):
        doc = _doc(text)
        first, _lines, _sections, _stats = devices.analyse(doc)
        second, _l2, _s2, _st2 = devices.analyse(_doc(text))
        assert [d.id for d in first] == [d.id for d in second]
        assert _kinds(first) & _SHAPE_KINDS
        for dev in first:
            for s in dev.spans:
                line = doc.lines[s.line]
                assert line.kind == "lyric"
                assert 0 <= s.word < len(line.words)
                raw = line.words[s.word].text
                end = len(raw) if s.char_end is None else s.char_end
                assert s.text == raw[s.char_start : end]


# --- shapes: the three ways they came apart under review --------------------

# A strand that crosses back from a section's second rhyme class into its
# first. "crew"/"you" are one class (same rime), "say"/"key" are another, and
# "say" is close enough to "you" for the strand pass to join them — so the
# strand acquires its members out of order unless the walk is by line.
CROSSED_CLASSES = """[Bridge]
There is nothing like a crew
Nobody was waiting for the line
I never really thought about the say
There is nothing like a part
Nobody was waiting for the choir
She told me it was only key
There is nothing like a view
You can keep the promise of the snow
[Chorus]
Everything I ever wanted to be grey
Nothing that I said to you was ever true
Somebody was calling out for you today
I could hear it in the rain and in the dew
"""

# Seven lines on one rhyme with a single drifting line in the middle of it, so
# the run stops short of the section's last line. The old end-to-end test then
# let the verse be announced as a bookend of itself.
DRIFTING_MONORHYME = """[Verse]
I came up out the basement with a plan
Told my mother I would be a better man
Every dollar that I stacked was in a can
Kept it quiet like a whisper in a fan
Never folded when the pressure overran
Wrote the whole of it in ink and not in sand
Now they calling me the one that never ran
"""

# A line whose last word is a particle the singer throws away, with another
# particle in front of it. Stepping back onto "for" offers the preposition as
# the line's ending, and cmudict's stressed F AO R rhymes it perfectly with
# "door".
PARTICLE_ENDING = """[Verse]
I have been standing outside of the door
I told you that I would be waiting for you
"""

# The rule the guard above must not touch: two lines that throw away DIFFERENT
# ad-libs still end on the words in front of them, and those words rhyme.
AD_LIB_ENDING = """I never wanted it to end this way, yeah
Nothing that I ever heard them say, now
"""


def _shapes(devs):
    return [d for d in devs if d.kind in _SHAPE_KINDS]


def test_a_shape_never_paints_its_spans_backwards_through_the_lyric():
    """Strands are walked in line order, so every distance in the shape pass is
    measured against a list that runs forwards. Read off the rhyme classes as
    they come — grouped by section, then by first appearance — a strand that
    crosses from a section's second class back into its first collects its
    members out of order, and the chain it produces steps backwards through
    the song."""
    devs, _lines, _sections, _stats = devices.analyse(_doc(CROSSED_CLASSES))
    for dev in _shapes(devs):
        lines = list(dict.fromkeys(s.line for s in dev.spans))
        assert lines == sorted(lines), f"{dev.kind}: {dev.label} {lines}"


def test_every_shape_measures_a_span_at_least_as_wide_as_its_members():
    """The arithmetic that goes wrong first when a strand is out of order: a
    chain's "N lines across M" needs M >= N, a run's count has to be the number
    of lines it actually paints, and a callback cannot return after fewer than
    one line."""
    import re

    for text in (CROSSED_CLASSES, DRIFTING_MONORHYME, MONORHYME, CALLBACK, CHAINED):
        devs, _lines, _sections, _stats = devices.analyse(_doc(text))
        for dev in _shapes(devs):
            lines = {s.line for s in dev.spans}
            chain = re.match(r"(\d+) lines across (\d+)", dev.detail)
            if chain:
                assert int(chain.group(2)) >= int(chain.group(1)) == len(lines)
            run = re.match(r"(\d+) consecutive lines", dev.detail)
            if run:
                assert int(run.group(1)) == len(lines)
            back = re.search(r"returns after (-?\d+) lines", dev.detail)
            if back:
                assert int(back.group(1)) >= 1


def test_a_monorhyme_verse_is_not_also_a_bookend_of_itself():
    """A bookend is a claim about an envelope, and there is no envelope when
    the rhyme is everywhere in between. The run stops at the drifting line, so
    the section is not a run end to end — but a run on the same strand still
    reaches the verse's first line, and that is what settles it."""
    devs, _lines, sections, _stats = devices.analyse(_doc(DRIFTING_MONORHYME))
    assert not _of(devs, "bookend"), [d.label for d in _shapes(devs)]
    run = _of(devs, "rhyme-run")
    assert len(run) == 1
    # Exactly the shape the end-to-end test could not see: the run opens the
    # section and stops before it closes, so the two ends are still a pair.
    painted = {s.line for s in run[0].spans}
    assert min(painted) == 1 and len(sections[0].scheme) == 7
    assert 7 not in painted
    # The genuine envelope is untouched: nothing on that strand runs or chains.
    book = _of(devices.analyse(_doc(BOOKENDED))[0], "bookend")
    assert len(book) == 1


def test_a_line_never_ends_on_the_particle_in_front_of_its_ad_lib():
    """A line that trails off "...waiting for you" does not end on "for".

    cmudict keeps a stressed F AO R for it, so offering the preposition as the
    ending scores a perfect rhyme against "door" — an end rhyme painted on a
    function word, and a 1.0 the shape pass has no reason to distrust.
    """
    devs, _lines, _sections, _stats = devices.analyse(_doc(PARTICLE_ENDING))
    assert not [d for d in devs if d.family == "rhyme"], [
        (d.kind, d.label) for d in devs if d.family == "rhyme"
    ]
    # The ad-lib rule it guards is still in force: a real word in front of the
    # throwaway is still offered, and still rhymes.
    kept, _l, lines, _st = devices.analyse(_doc(AD_LIB_ENDING))
    assert lines[0].scheme == "AA"
    pair = _of(kept, "end-rhyme")
    assert len(pair) == 1
    assert [s.text for s in pair[0].spans] == ["way", "say"]


# One line sung four times: the commonest shape in a pop chorus, and every
# ending in it is the same word.
REPEATED_HOOK = """[Chorus]
I will not be going home tonight
I will not be going home tonight
I will not be going home tonight
I will not be going home tonight
"""


def test_a_line_sung_again_is_a_refrain_and_never_a_run_or_a_bookend():
    """The rule the callback pass already followed, applied to the other three
    shapes: a rhyme that is only there because the whole LINE came back belongs
    to the repetition passes.

    Left alone it hands the pane its loudest rhyme finding — "4 consecutive
    lines" — for a chorus with one line in it, and then, with the run gone, a
    bookend that opens and closes on the same word.
    """
    devs, _lines, _sections, _stats = devices.analyse(_doc(REPEATED_HOOK))
    assert not _kinds(devs) & _SHAPE_KINDS, [d.label for d in _shapes(devs)]
    refrain = _of(devs, "refrain")
    assert len(refrain) == 1 and refrain[0].detail == "x4"
    # ...and the pairs the dropped run was holding do not fall back out
    # underneath the refrain as three rows of "tonight / tonight".
    assert not _of(devs, "identical-rhyme")


def test_a_repeated_line_never_swallows_the_real_rhyme_beside_it():
    """Only the pairs that END on a repeat are claimed. The line that closes
    the hook is new, so the rhyme it makes is still reported."""
    devs, _lines, _sections, _stats = devices.analyse(
        _doc("""[Hook]
Say my name
Say my name
Say my name
Nothing in the world could feel the same
""")
    )
    assert not _of(devs, "rhyme-run"), [d.label for d in _shapes(devs)]
    rhymed = [d for d in devs if d.family == "rhyme"]
    assert rhymed, _kinds(devs)
    for dev in rhymed:
        assert {s.text for s in dev.spans} == {"name", "same"}, dev.label
