"""The phonetics engine (backend.modules.lyricanalysis.phonetics).

``cmudict`` is an OPTIONAL dependency, so every assertion here has to hold on
the letter-to-sound fallback too — the values below were chosen to be true of
both sources. The two tests that genuinely need the dictionary are skipped
when it is absent.
"""

from __future__ import annotations

import pytest

from backend.modules.lyricanalysis.phonetics import (
    ARPABET_VOWELS,
    PRONUNCIATION_SOURCE,
    Pron,
    classify_rhyme,
    consonant_distance,
    normalize_word,
    pronounce,
    rhyme_key,
    stress_pattern,
    syllabify,
    syllable_count,
    tail_key,
    vowel_distance,
)

# The rules G2P is the out-of-dictionary path. Naming it directly is the only
# way to exercise it on a machine that HAS cmudict installed.
from backend.modules.lyricanalysis.phonetics import _rules_pron

needs_cmudict = pytest.mark.skipif(
    PRONUNCIATION_SOURCE != "cmudict", reason="cmudict is not installed"
)

ARPABET_CONSONANTS = frozenset(
    "B CH D DH F G HH JH K L M N NG P R S SH T TH V W Y Z ZH".split()
)


def phones(word):
    return " ".join(pronounce(word).phones)


# ---------------------------------------------------------------------------
# normalize_word / pronounce
# ---------------------------------------------------------------------------


def test_normalize_word_keeps_inner_apostrophes_and_hyphens():
    assert normalize_word("  “Don't,”  ") == "don't"
    assert normalize_word("Rock-'n'-Roll!") == "rock-'n'-roll"
    assert normalize_word("'cause") == "cause"
    assert normalize_word("goin'") == "goin"
    assert normalize_word("café") == "cafe"
    assert normalize_word("") == ""
    assert normalize_word("!!!") == ""


@pytest.mark.parametrize("token", ["", "   ", "!!!", "…", "—"])
def test_pronounce_returns_an_empty_pron_for_junk(token):
    pron = pronounce(token)
    assert pron.phones == ()
    assert pron.stress == ()
    assert pron.guessed is False


# Coinages no pronouncing dictionary can have; the rules G2P must answer.
@pytest.mark.parametrize("word", ["skrrt", "drippin", "bussin", "zaddy", "gyaru"])
def test_pronounce_flags_the_guessed_path(word):
    pron = pronounce(word)
    assert pron.guessed is True
    assert pron.phones
    assert set(pron.phones) <= ARPABET_VOWELS | ARPABET_CONSONANTS
    # One stress digit per vowel, in phone order.
    assert len(pron.stress) == sum(p in ARPABET_VOWELS for p in pron.phones)
    assert set(pron.stress) <= {0, 1, 2}


@needs_cmudict
def test_pronounce_prefers_the_dictionary():
    cat = pronounce("cat")
    assert cat.phones == ("K", "AE", "T")
    assert cat.stress == (1,)
    assert cat.guessed is False


@needs_cmudict
def test_pronounce_falls_back_for_words_the_dictionary_lacks():
    assert pronounce("skrrt").guessed is True


def test_pronounce_is_cached():
    assert pronounce("bridge") is pronounce("bridge")


# ---------------------------------------------------------------------------
# syllabify / syllable_count
# ---------------------------------------------------------------------------


def test_syllabify_takes_the_maximal_onset():
    # "astray" is AH.STREY, not AHS.TREY — STR is a legal onset, so it all
    # goes to the second syllable and the first one has no coda at all.
    first, second = syllabify(pronounce("astray"))
    assert first.coda == ()
    assert second.onset == ("S", "T", "R")
    assert second.nucleus == "EY"
    assert second.coda == ()


def test_syllabify_splits_onset_nucleus_coda():
    (only,) = syllabify(pronounce("splash"))
    assert only.onset == ("S", "P", "L")
    assert only.nucleus == "AE"
    assert only.coda == ("SH",)


def test_syllabify_hands_a_single_consonant_to_the_next_syllable():
    first, second = syllabify(pronounce("little"))
    assert (first.onset, first.nucleus, first.coda) == (("L",), "IH", ())
    assert (second.onset, second.nucleus, second.coda) == (("T",), "AH", ("L",))


def test_syllabify_carries_the_stress_digit():
    syllables = syllabify(pronounce("dedication"))
    assert len(syllables) == 4
    assert syllables[2].nucleus == "EY"
    assert syllables[2].stress in (1, 2)
    assert syllables[3].nucleus == "AH"
    assert syllables[3].stress == 0


def test_syllabify_of_an_empty_pron_is_empty():
    assert syllabify(Pron(phones=(), stress=(), guessed=False)) == []


@pytest.mark.parametrize(
    ("word", "count"),
    [
        ("cat", 1),
        ("make", 1),  # silent e
        ("cake", 1),
        ("walked", 1),  # -ed as /t/
        ("played", 1),  # -ed as /d/
        ("wanted", 2),  # -ed as /ɪd/
        ("little", 2),  # syllabic -le
        ("table", 2),
        ("candle", 2),
        ("rain", 1),  # vowel teams
        ("queen", 1),
        ("boat", 1),
        ("quickly", 2),
        ("running", 2),
        ("movement", 2),
        ("happiness", 3),
        ("dedication", 4),
        ("", 0),
        ("!!!", 0),
    ],
)
def test_syllable_count(word, count):
    assert syllable_count(word) == count


# ---------------------------------------------------------------------------
# rhyme_key / tail_key
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("a", "b"),
    [
        ("cat", "hat"),
        ("nation", "station"),
        ("believe", "relieve"),
        ("bright", "night"),
    ],
)
def test_rhyme_key_matches_for_perfect_rhymes(a, b):
    assert rhyme_key(pronounce(a)) == rhyme_key(pronounce(b))


@pytest.mark.parametrize(
    ("a", "b"), [("cat", "dog"), ("nation", "nature"), ("believe", "belong")]
)
def test_rhyme_key_differs_for_non_rhymes(a, b):
    assert rhyme_key(pronounce(a)) != rhyme_key(pronounce(b))


def test_rhyme_key_starts_at_the_last_stressed_vowel():
    assert rhyme_key(pronounce("cat")) == "AE T"
    assert rhyme_key(pronounce("station")) == "EY SH AH N"
    assert rhyme_key(pronounce("dedication")) == "EY SH AH N"


def test_rhyme_key_is_empty_without_a_vowel():
    assert rhyme_key(Pron(phones=("S", "T"), stress=(), guessed=True)) == ""
    assert rhyme_key(Pron(phones=(), stress=(), guessed=False)) == ""


def test_tail_key_matches_a_multisyllabic_rhyme():
    # "dedication"/"medication" rhyme three syllables deep: -DICATION.
    a, b = pronounce("dedication"), pronounce("medication")
    assert tail_key(a, 3) == tail_key(b, 3)
    assert tail_key(a, 3).endswith("K EY SH AH N")
    assert tail_key(a, 1) == tail_key(b, 1) == "SH AH N"


def test_tail_key_counts_whole_syllables_including_their_onsets():
    # celebration/dedication share -ATION, but the syllable in front of it
    # differs (BREY vs KEY), so a two-syllable tail must not match.
    assert tail_key(pronounce("celebration"), 1) == tail_key(pronounce("dedication"), 1)
    assert tail_key(pronounce("celebration"), 2) != tail_key(pronounce("dedication"), 2)


def test_tail_key_edges():
    assert tail_key(pronounce("cat"), 9) == "K AE T"  # more than the word has
    assert tail_key(pronounce("cat"), 0) == ""
    assert tail_key(Pron(phones=(), stress=(), guessed=False), 2) == ""


# ---------------------------------------------------------------------------
# classify_rhyme
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("a", "b"), [("cat", "hat"), ("nation", "station"), ("believe", "relieve")]
)
def test_classify_end_rhyme(a, b):
    kind, confidence = classify_rhyme(pronounce(a), pronounce(b), word_a=a, word_b=b)
    assert kind == "end-rhyme"
    assert confidence >= 0.7


def test_classify_identical_rhyme_for_the_same_word():
    assert classify_rhyme(
        pronounce("Cat"), pronounce("cat!"), word_a="Cat", word_b="cat!"
    ) == ("identical-rhyme", 1.0)


def test_classify_identical_rhyme_for_the_same_pronunciation():
    kind, confidence = classify_rhyme(
        pronounce("bare"), pronounce("bear"), word_a="bare", word_b="bear"
    )
    assert kind == "identical-rhyme"
    assert confidence >= 0.7


@pytest.mark.parametrize(
    ("a", "b"), [("shape", "keep"), ("bridge", "grudge"), ("shape", "shake")]
)
def test_classify_slant_rhyme(a, b):
    kind, confidence = classify_rhyme(pronounce(a), pronounce(b), word_a=a, word_b=b)
    assert kind == "slant-rhyme"
    assert 0.3 <= confidence <= 0.9


@pytest.mark.parametrize(("a", "b"), [("read", "ride"), ("cat", "cut"), ("bad", "bud")])
def test_classify_pararhyme(a, b):
    kind, confidence = classify_rhyme(pronounce(a), pronounce(b), word_a=a, word_b=b)
    assert kind == "pararhyme"
    assert confidence > 0.0


@pytest.mark.parametrize(("a", "b"), [("love", "move"), ("though", "tough")])
def test_classify_eye_rhyme(a, b):
    kind, confidence = classify_rhyme(pronounce(a), pronounce(b), word_a=a, word_b=b)
    assert kind == "eye-rhyme"
    assert confidence < 0.4


def test_eye_rhyme_needs_the_spelling():
    # Without the words there is nothing to see, and the phones say no.
    assert classify_rhyme(pronounce("love"), pronounce("move")) == ("", 0.0)


@pytest.mark.parametrize(
    ("a", "b"), [("cat", "dog"), ("orange", "silver"), ("music", "window")]
)
def test_classify_no_rhyme(a, b):
    assert classify_rhyme(pronounce(a), pronounce(b), word_a=a, word_b=b) == ("", 0.0)


def test_multisyllabic_tails_are_not_scored_as_all_consonant():
    """A rhyme tail carries unstressed vowels; they have to score as vowels.

    "runner"/"summer" share -ER and differ by one nasal. Scoring the tail
    with the consonant metric alone called the two identical ER phones
    maximally distant, which demoted a plain slant rhyme to an eye-rhyme.
    """
    kind, confidence = classify_rhyme(
        pronounce("runner"), pronounce("summer"), word_a="runner", word_b="summer"
    )
    assert kind == "slant-rhyme"
    assert confidence >= 0.5
    for a, b in (("better", "never"), ("action", "passion")):
        assert (
            classify_rhyme(pronounce(a), pronounce(b), word_a=a, word_b=b)[0]
            == "slant-rhyme"
        )
    # ...and the non-rhymes stay non-rhymes.
    for a, b in (("cat", "dog"), ("orange", "silver"), ("music", "window")):
        assert classify_rhyme(pronounce(a), pronounce(b), word_a=a, word_b=b) == (
            "",
            0.0,
        )


@pytest.mark.parametrize("word", ["hmm", "hm", "hmmm", "mm", "shh", "sh"])
def test_adlibs_get_a_beat_from_either_source(word):
    """cmudict lists these with no vowel at all; a sung ad-lib still has one."""
    pron = pronounce(word)
    assert any(p in ARPABET_VOWELS for p in pron.phones), pron
    assert len(pron.stress) == sum(p in ARPABET_VOWELS for p in pron.phones)
    assert syllable_count(word) == 1
    assert rhyme_key(pron)
    assert pron.guessed is True  # the nucleus is ours, not the dictionary's


def test_stress_pattern_keeps_one_digit_per_sung_syllable():
    assert stress_pattern(["oh", "yeah", "hmm", "i", "know"]) == "11111"


def test_classify_needs_two_pronunciations():
    empty = Pron(phones=(), stress=(), guessed=False)
    assert classify_rhyme(empty, pronounce("cat")) == ("", 0.0)
    assert classify_rhyme(pronounce("cat"), empty) == ("", 0.0)


def test_confidence_drops_when_a_pronunciation_was_guessed():
    known_cat = Pron(phones=("K", "AE", "T"), stress=(1,), guessed=False)
    known_hat = Pron(phones=("HH", "AE", "T"), stress=(1,), guessed=False)
    guessed_hat = Pron(phones=("HH", "AE", "T"), stress=(1,), guessed=True)
    assert classify_rhyme(known_cat, known_hat) == ("end-rhyme", 1.0)
    kind, confidence = classify_rhyme(known_cat, guessed_hat)
    assert kind == "end-rhyme"
    assert confidence < 1.0


# ---------------------------------------------------------------------------
# Phone distances and stress
# ---------------------------------------------------------------------------


def test_vowel_distance():
    assert vowel_distance("AE", "AE") == 0.0
    assert vowel_distance("EY", "IY") < 0.2  # neighbours
    assert vowel_distance("AH", "UW") > 0.45  # not neighbours
    assert vowel_distance("EY", "IY") == vowel_distance("IY", "EY")
    assert vowel_distance("AE", "K") == 1.0  # not a vowel
    assert vowel_distance("AE", "") == 1.0
    for a in ARPABET_VOWELS:
        for b in ARPABET_VOWELS:
            assert 0.0 <= vowel_distance(a, b) <= 1.0


def test_consonant_distance():
    assert consonant_distance("T", "T") == 0.0
    # Voicing alone is a smaller step than place plus manner.
    assert consonant_distance("T", "D") < consonant_distance("T", "M")
    assert consonant_distance("S", "Z") < consonant_distance("S", "G")
    assert consonant_distance("T", "AE") == 1.0
    assert consonant_distance("T", "") == 1.0
    for a in ARPABET_CONSONANTS:
        for b in ARPABET_CONSONANTS:
            assert 0.0 <= consonant_distance(a, b) <= 1.0


def test_stress_pattern():
    assert stress_pattern(["cat", "hat"]) == "11"
    assert stress_pattern([]) == ""
    assert stress_pattern(["!!!"]) == ""
    pattern = stress_pattern(["dedication"])
    assert len(pattern) == 4
    assert set(pattern) <= {"0", "1", "2"}
    assert "1" in pattern


# ---------------------------------------------------------------------------
# The rules G2P in isolation — this is the path that runs without cmudict,
# and the one every out-of-dictionary lyric word takes.
# ---------------------------------------------------------------------------

RULES_G2P = [
    # consonant digraphs
    ("thin", "TH IH N"),
    ("shop", "SH AA P"),
    ("chip", "CH IH P"),
    ("phone", "F OW N"),
    ("sing", "S IH NG"),
    ("back", "B AE K"),
    ("quick", "K W IH K"),
    ("when", "W EH N"),
    ("write", "R AY T"),
    ("knee", "N IY"),
    ("gnome", "N OW M"),
    ("thumb", "TH AH M"),
    ("lamb", "L AE M"),
    ("bother", "B AA DH ER"),
    ("high", "HH AY"),
    ("catch", "K AE CH"),
    ("badge", "B AE JH"),
    ("sign", "S AY N"),
    # vowel teams
    ("rain", "R EY N"),
    ("day", "D EY"),
    ("tree", "T R IY"),
    ("piece", "P IY S"),
    ("boat", "B OW T"),
    ("moon", "M UW N"),
    ("book", "B UH K"),
    ("loud", "L AW D"),
    ("snow", "S N OW"),
    ("coin", "K OY N"),
    ("toy", "T OY"),
    ("cause", "K AO Z"),
    ("saw", "S AO"),
    ("blue", "B L UW"),
    ("fruit", "F R UW T"),
    ("few", "F UW"),
    # r-controlled vowels
    ("car", "K AA R"),
    ("her", "HH ER"),
    ("bird", "B ER D"),
    ("turn", "T ER N"),
    ("for", "F AO R"),
    ("hair", "HH EH R"),
    ("fire", "F AY ER"),
    ("more", "M AO R"),
    ("cure", "K Y UH R"),
    # magic e
    ("cake", "K EY K"),
    ("bike", "B AY K"),
    ("phase", "F EY Z"),
    # soft vs hard c and g
    ("cent", "S EH N T"),
    ("city", "S IH T IY"),
    ("cat", "K AE T"),
    ("cup", "K AH P"),
    ("gem", "JH EH M"),
    ("gym", "JH IH M"),
    ("go", "G OW"),
    # doubled consonants
    ("happy", "HH AE P IY"),
    ("funny", "F AH N IY"),
    # syllabic -le
    ("table", "T EY B AH L"),
    ("little", "L IH T AH L"),
    ("candle", "K AE N D AH L"),
    # y as a vowel, stressed and unstressed
    ("try", "T R AY"),
    ("myth", "M IH TH"),
    # suffixes
    ("nation", "N EY SH AH N"),
    ("vision", "V IH ZH AH N"),
    # -ssion/-shion: the doubled consonant and the sh digraph must not eat
    # the s and leave a bare "ion" spelling out as an extra syllable.
    ("passion", "P AE SH AH N"),
    ("mission", "M IH SH AH N"),
    ("fashion", "F AE SH AH N"),
    ("pressure", "P R EH SH ER"),
    ("precious", "P R EH SH AH S"),
    ("cautious", "K AO SH AH S"),
    ("walked", "W AO K T"),
    ("played", "P L EY D"),
    ("wanted", "W AA N T IH D"),
    ("boxes", "B AA K S IH Z"),
    ("going", "G OW IH NG"),
    ("quickly", "K W IH K L IY"),
    ("darkness", "D AA R K N AH S"),
    ("movement", "M UW V M AH N T"),
]


@pytest.mark.parametrize(("word", "expected"), RULES_G2P)
def test_rules_g2p_spells_out(word, expected):
    pron = _rules_pron(normalize_word(word))
    assert " ".join(pron.phones) == expected
    assert pron.guessed is True


def test_rules_g2p_realises_ed_three_ways():
    assert _rules_pron("walked").phones[-1] == "T"  # after a voiceless stem
    assert _rules_pron("played").phones[-1] == "D"  # after a voiced one
    assert _rules_pron("wanted").phones[-2:] == ("IH", "D")  # after /t/ or /d/


@pytest.mark.parametrize(
    "word",
    [
        "skrrt",
        "yeet",
        "bussin",
        "finna",
        "drippy",
        "sheesh",
        "rizz",
        "zaddy",
        "bando",
        "cappin",
        "hmm",
        "y'all",
        "rock-n-roll",
    ],
)
def test_rules_g2p_answers_for_anything_a_lyric_contains(word):
    pron = _rules_pron(normalize_word(word))
    assert pron.phones, f"{word} produced no phones"
    assert set(pron.phones) <= ARPABET_VOWELS | ARPABET_CONSONANTS
    assert any(p in ARPABET_VOWELS for p in pron.phones), f"{word} has no nucleus"
    assert len(pron.stress) == sum(p in ARPABET_VOWELS for p in pron.phones)
    assert 1 in pron.stress
    assert pron.guessed is True


def test_rules_g2p_agrees_with_itself_on_rhymes():
    # The fallback is the only source on a machine without cmudict, so the
    # rhyme findings still have to hold when it is what answered.
    for a, b in (("cat", "hat"), ("nation", "station"), ("bright", "night")):
        assert rhyme_key(_rules_pron(a)) == rhyme_key(_rules_pron(b))
        kind, _ = classify_rhyme(_rules_pron(a), _rules_pron(b), word_a=a, word_b=b)
        assert kind == "end-rhyme"


def test_dictionary_path_reads_stress_digits(monkeypatch):
    """Cover the cmudict branch on a machine that does not have cmudict."""
    import backend.modules.lyricanalysis.phonetics as ph

    monkeypatch.setattr(ph, "_cmudict", object())
    monkeypatch.setattr(
        ph,
        "_CMU_TABLE",
        {"orangutan": [["ER0", "AE1", "NG", "AH0", "T", "AE2", "N"]]},
    )
    ph.pronounce.cache_clear()
    try:
        pron = ph.pronounce("Orangutan!")
        assert pron.guessed is False
        assert pron.phones == ("ER", "AE", "NG", "AH", "T", "AE", "N")
        assert pron.stress == (0, 1, 0, 2)
        assert ph.rhyme_key(pron) == "AE N"
        # A miss in the table still falls through to the rules.
        assert ph.pronounce("skrrt").guessed is True
    finally:
        ph.pronounce.cache_clear()
