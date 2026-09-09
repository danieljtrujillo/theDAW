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
    pronounce_phrase,
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


@pytest.mark.parametrize(
    ("a", "b"), [("read", "ride"), ("leaves", "lives"), ("feet", "fight")]
)
def test_classify_pararhyme(a, b):
    """Owen's device: the SAME consonant frame with the vowel swapped out.

    It needs both ends — onset and coda — and it is read after slant rhyme,
    not before it, so it only claims a pair the ear does not already hear as
    a near rhyme.
    """
    kind, confidence = classify_rhyme(pronounce(a), pronounce(b), word_a=a, word_b=b)
    assert kind == "pararhyme"
    assert confidence > 0.0


@pytest.mark.parametrize(
    ("a", "b"), [("man", "men"), ("cat", "cut"), ("bit", "bet"), ("bad", "bud")]
)
def test_one_vowel_step_is_a_slant_rhyme_not_a_pararhyme(a, b):
    """These are the commonest near rhymes in pop, and they were all being
    labelled with a rare literary device because pararhyme was tested first
    and only asked for a shared onset and a shared tail."""
    kind, confidence = classify_rhyme(pronounce(a), pronounce(b), word_a=a, word_b=b)
    assert kind == "slant-rhyme", (a, b, kind, confidence)
    assert confidence >= 0.5


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
    """...but only where a dictionary exists to have been better than the guess.

    Without cmudict every word in the song is guessed, and discounting all of
    them by the same factor ranks nothing differently — it only slides the
    whole distribution under the callers' confidence floors, which is what
    made a cmudict-less machine report a fraction of the rhymes.
    """
    known_cat = Pron(phones=("K", "AE", "T"), stress=(1,), guessed=False)
    known_hat = Pron(phones=("HH", "AE", "T"), stress=(1,), guessed=False)
    guessed_hat = Pron(phones=("HH", "AE", "T"), stress=(1,), guessed=True)
    assert classify_rhyme(known_cat, known_hat) == ("end-rhyme", 1.0)
    kind, confidence = classify_rhyme(known_cat, guessed_hat)
    assert kind == "end-rhyme"
    if PRONUNCIATION_SOURCE == "cmudict":
        assert confidence < 1.0
    else:
        assert confidence == 1.0


# ---------------------------------------------------------------------------
# Phone distances and stress
# ---------------------------------------------------------------------------


def test_vowel_distance():
    assert vowel_distance("AE", "AE") == 0.0
    assert vowel_distance("EY", "IY") < 0.3  # neighbours
    assert vowel_distance("EY", "IY") < vowel_distance("EY", "AA")
    assert vowel_distance("AH", "UW") > 0.45  # not neighbours
    assert vowel_distance("EY", "IY") == vowel_distance("IY", "EY")
    assert vowel_distance("AE", "K") == 1.0  # not a vowel
    assert vowel_distance("AE", "") == 1.0
    for a in ARPABET_VOWELS:
        for b in ARPABET_VOWELS:
            assert 0.0 <= vowel_distance(a, b) <= 1.0


def test_a_diphthong_sits_between_its_endpoints_not_next_to_schwa():
    """AY travels from an AA-ish nucleus to an IH-ish glide, so those are what
    it is near. The hand-picked point-per-vowel table it replaced made AH-AY
    and EY-IH its two CLOSEST pairs — schwa nearer to a diphthong than that
    diphthong's own endpoints — and that is what scored "cut"/"kite" and
    "hit"/"hate" as 0.64 rhymes."""
    assert vowel_distance("AY", "AA") < vowel_distance("AY", "AH")
    assert vowel_distance("AY", "IY") < vowel_distance("AY", "AH")
    assert vowel_distance("AY", "AW") < vowel_distance("AY", "AH")
    # ...and the lax/tense pairs a monophthong can hide inside a glide.
    assert vowel_distance("EY", "IH") > 0.3
    assert vowel_distance("IH", "EY") > vowel_distance("IH", "EH")


def test_near_vowels_are_a_small_minority_of_the_table():
    """A distance table that calls two thirds of all vowel pairs "near" is not
    measuring anything. The old one marked 70 of its 105 pairs under its own
    0.45 near-vowel bound."""
    vowels = sorted(ARPABET_VOWELS)
    pairs = [
        vowel_distance(a, b) for i, a in enumerate(vowels) for b in vowels[i + 1 :]
    ]
    assert len(pairs) == 105
    near = [d for d in pairs if d < 0.30]
    assert len(near) / len(pairs) < 0.20, len(near)
    assert near, "no two vowels are near each other at all"


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


# ---------------------------------------------------------------------------
# The scored comparison: what "more robust" has to mean
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("a", "b"),
    [
        # Close on BOTH sides and identical on neither: the shape the old
        # exact-match gates dropped on the floor. "station"/"patience" came
        # back as ("", 0.0) and "nation"/"occasion" as an eye rhyme.
        ("nation", "occasion"),
        ("station", "patience"),
        ("action", "passion"),
        ("honest", "promise"),
        ("pieces", "reasons"),
        ("silence", "violence"),
        ("million", "villain"),
        ("listen", "kitchen"),
        ("pressure", "measure"),
    ],
)
def test_a_pair_close_on_both_sides_is_a_rhyme(a, b):
    kind, confidence = classify_rhyme(pronounce(a), pronounce(b), word_a=a, word_b=b)
    assert kind in ("end-rhyme", "slant-rhyme"), (kind, confidence)
    assert confidence >= 0.4


@pytest.mark.parametrize(
    ("a", "b"),
    [
        ("kiss", "list"),  # a coda that grew a consonant
        ("station", "patience"),  # ...one syllable deeper in
        ("world", "word"),  # ...and one that lost one
        ("mind", "time"),  # cluster simplification
        ("last", "laughed"),
    ],
)
def test_codas_of_different_lengths_are_aligned_not_shifted(a, b):
    """Right-aligning two raw phone arrays misaligns every phone the moment
    they are different lengths: "N" was compared with "S" and two near
    identical endings scored as unrelated."""
    kind, confidence = classify_rhyme(pronounce(a), pronounce(b), word_a=a, word_b=b)
    assert kind in ("end-rhyme", "slant-rhyme"), (kind, confidence)
    assert confidence >= 0.45


def test_a_weak_rhyme_degrades_to_a_low_confidence_slant_never_to_nothing():
    for a, b in (("shape", "shake"), ("air", "death"), ("bridge", "grudge")):
        kind, confidence = classify_rhyme(
            pronounce(a), pronounce(b), word_a=a, word_b=b
        )
        assert kind == "slant-rhyme", (a, b, kind)
        assert 0.0 < confidence < 1.0


def test_a_trailing_secondary_stress_does_not_hijack_the_rhyme():
    """The dictionary marks "tomorrow" AH0 M AA1 R OW2 and "shadow" AE1 D OW2,
    so reading the key off the LAST stressed vowel starts it on the throwaway
    "-ow" and "tomorrow"/"sorrow" comes back as no rhyme. Both readings are
    offered and the better one wins - which still leaves "anyway"/"day"
    rhyming on its own final foot."""
    kind, confidence = classify_rhyme(
        pronounce("tomorrow"), pronounce("sorrow"), word_a="tomorrow", word_b="sorrow"
    )
    assert kind in ("end-rhyme", "slant-rhyme")
    assert confidence >= 0.7


@needs_cmudict
def test_a_trailing_stress_is_still_a_reading_the_rhyme_can_use():
    """The other half of the same rule: offering the primary-stressed syllable
    as a second reading must not cost the trailing one, or "anyway"/"day"
    stops rhyming. Only cmudict marks the trailing stress at all."""
    assert classify_rhyme(
        pronounce("anyway"), pronounce("day"), word_a="anyway", word_b="day"
    ) == ("end-rhyme", 1.0)


def test_max_rhyme_score_never_drops_a_pair_the_classifier_accepts():
    """The cheap gate the pairwise passes use has to be a real upper bound."""
    from backend.modules.lyricanalysis.phonetics import max_rhyme_score, rhyme_nuclei

    words = """station patience nation occasion given living heaven eleven
        promise premise honest silence violence million villain listen kitchen
        summer runner better never water daughter city pretty little riddle
        cat cut man men bit bet read ride shape keep bridge grudge world word
        music window orange silver machine morning""".split()
    accepted = 0
    for i, a in enumerate(words):
        for b in words[i + 1 :]:
            pa, pb = pronounce(a), pronounce(b)
            kind, conf = classify_rhyme(pa, pb, word_a=a, word_b=b)
            if kind not in ("end-rhyme", "slant-rhyme", "identical-rhyme"):
                continue
            bound = max_rhyme_score(rhyme_nuclei(pa), rhyme_nuclei(pb))
            # The reported confidence is rounded to three places.
            assert round(bound, 3) >= conf, (a, b, kind, conf, bound)
            accepted += 1
    assert accepted > 30


# A benchmark in miniature: real perfect rhymes, real slant rhymes as songs
# use them, and genuine non-rhymes as negative controls. The point is the
# aggregate - a change that lifts recall must not wreck precision - so the
# thresholds are on the counts, not on any one pair.
_PERFECT = [
    ("cat", "hat"),
    ("night", "light"),
    ("heart", "apart"),
    ("fight", "tonight"),
    ("forget", "regret"),
    ("stay", "away"),
    ("time", "rhyme"),
    ("money", "honey"),
    ("water", "daughter"),
    ("believe", "relieve"),
    ("station", "nation"),
    ("alone", "known"),
    ("morning", "warning"),
    ("reason", "season"),
    ("trouble", "double"),
    ("lonely", "only"),
]
_SLANT = [
    ("nation", "occasion"),
    ("station", "patience"),
    ("action", "passion"),
    ("honest", "promise"),
    ("man", "men"),
    ("bit", "bet"),
    ("cat", "cut"),
    ("summer", "runner"),
    ("better", "never"),
    ("gone", "song"),
    ("heart", "dark"),
    ("world", "word"),
    ("kiss", "list"),
    ("mouth", "out"),
    ("please", "piece"),
    ("broken", "open"),
]
_NON_RHYMES = [
    ("cat", "dog"),
    ("orange", "silver"),
    ("music", "window"),
    ("table", "purple"),
    ("river", "mountain"),
    ("garden", "velvet"),
    ("whistle", "panic"),
    ("forest", "marble"),
    ("green", "black"),
    ("north", "blue"),
    ("milk", "torch"),
    ("desk", "piano"),
    ("eye", "law"),
    ("hello", "goodbye"),
    ("air", "death"),
    ("cut", "kite"),
]
_SCHEME_KINDS = ("end-rhyme", "slant-rhyme", "identical-rhyme")
# devices.MIN_SCHEME_CONF: the floor a pair has to clear to earn a letter.
_SCHEME_FLOOR = 0.5


def _makes_a_scheme(a, b):
    kind, conf = classify_rhyme(pronounce(a), pronounce(b), word_a=a, word_b=b)
    return kind in _SCHEME_KINDS and conf >= _SCHEME_FLOOR


def test_benchmark_recall_and_precision():
    perfect = [p for p in _PERFECT if _makes_a_scheme(*p)]
    slant = [p for p in _SLANT if _makes_a_scheme(*p)]
    false_positives = [p for p in _NON_RHYMES if _makes_a_scheme(*p)]
    missed = [p for p in _PERFECT + _SLANT if not _makes_a_scheme(*p)]
    assert len(perfect) == len(_PERFECT), missed
    assert len(slant) >= 14, missed
    assert len(false_positives) <= 1, false_positives


# ---------------------------------------------------------------------------
# Pronunciation robustness
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("value", [["x"], None, 42, {"a": 1}, object()])
def test_pronounce_never_raises_on_a_value_that_is_not_a_word(value):
    """It says "never raises", and the cache hashed the argument before the
    function ever ran, so a list argument raised TypeError from inside it."""
    assert isinstance(pronounce(value), Pron)


def test_pronounce_phrase_reads_a_run_of_words_as_one_stream():
    from backend.modules.lyricanalysis.phonetics import pronounce_phrase

    phrase = pronounce_phrase(["hold", "on"])
    assert phrase.phones == pronounce("hold").phones + pronounce("on").phones
    assert len(phrase.stress) == sum(p in ARPABET_VOWELS for p in phrase.phones)
    assert pronounce_phrase([]).phones == ()
    assert pronounce_phrase(["!!!"]).phones == ()
    # A phrase is guessed when any word in it was.
    assert pronounce_phrase(["skrrt", "on"]).guessed is True


@needs_cmudict
def test_a_sung_g_dropping_is_the_ing_word_behind_it():
    """A sung "runnin'" is "running" with its velar dropped. Rhyming it as a
    coinage instead threw away half a hook's rhymes."""
    assert pronounce("runnin'").phones == pronounce("running").phones
    assert pronounce("runnin").phones == pronounce("running").phones
    # cmudict lists "lovin" and "chasin" as SURNAMES (L OW V IH N, CH AE S IH
    # N), so the apostrophe has to be read BEFORE the dictionary or the sung
    # word rhymes off a name.
    assert pronounce("lovin'").phones == pronounce("loving").phones
    assert pronounce("chasin',").phones == pronounce("chasing").phones
    # Ours, not the dictionary's, so it stays flagged as a guess.
    assert pronounce("runnin'").guessed is True
    # ...and a real word ending in -in is still itself.
    assert pronounce("cabin").guessed is False
    assert pronounce("cabin").phones[-1] == "N"


def test_pronunciation_source_reports_what_actually_answered(monkeypatch):
    """A successful import is not a working dictionary: the data file can be
    unreadable, and the module then claimed "cmudict" while every word in the
    song was in fact guessed."""
    import backend.modules.lyricanalysis.phonetics as ph

    class _Broken:
        @staticmethod
        def dict():
            raise OSError("no data file")

    monkeypatch.setattr(ph, "_cmudict", _Broken)
    monkeypatch.setattr(ph, "_CMU_TABLE", None)
    monkeypatch.setattr(ph, "PRONUNCIATION_SOURCE", "cmudict")
    ph.pronounce.cache_clear()
    try:
        assert ph.pronounce("cat").guessed is True
        assert ph.pronunciation_source() == "rules"
        assert ph.PRONUNCIATION_SOURCE == "rules"
    finally:
        ph.pronounce.cache_clear()


# ---------------------------------------------------------------------------
# Rules-path stress: a weak first syllable moves the rhyme key
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("a", "b"),
    [
        ("apart", "heart"),
        ("tonight", "fight"),
        ("regret", "forget"),
        ("today", "way"),
        ("away", "day"),
        ("believe", "relieve"),
        ("insane", "rain"),
    ],
)
def test_rules_g2p_puts_the_stress_off_a_weak_first_syllable(a, b):
    """Reading "a-PART" as "A-part" moves the rhyme key a syllable too far
    left and the rhyme with "heart" disappears - which is most of why a
    machine without cmudict found so many fewer rhymes than one with it."""
    assert rhyme_key(_rules_pron(a)) == rhyme_key(_rules_pron(b)), (
        " ".join(_rules_pron(a).phones),
        " ".join(_rules_pron(b).phones),
    )


@pytest.mark.parametrize("word", ["always", "answer", "army", "pretty", "apple"])
def test_rules_g2p_keeps_the_stress_on_a_real_first_syllable(word):
    """The shift is for open prefix syllables only: "al-ways" and "an-swer"
    close theirs, "ar-my" and "pret-ty" end on a weak -y, and "ap-ple" ends on
    a schwa, which is never stressed."""
    assert _rules_pron(word).stress[0] == 1, _rules_pron(word)


# ---------------------------------------------------------------------------
# Which reading of the word the rhyme is scored on
# ---------------------------------------------------------------------------


@needs_cmudict
@pytest.mark.parametrize(
    ("a", "b"),
    [
        # The vowel the singer picked is the SECOND dictionary entry.
        ("was", "does"),  # W AH0 Z, not W AA1 Z
        ("live", "give"),  # L IH1 V, not L AY1 V
        ("route", "out"),  # R AW1 T, not R UW1 T
        ("again", "rain"),  # AH0 G EY1 N, not AH0 G EH1 N
    ],
)
def test_a_rhyme_is_found_on_the_dictionarys_other_pronunciation(a, b):
    """cmudict lists several readings per word and the singer chose one of
    them. Scoring only entry[0] decided that for them and got it wrong:
    "was"/"does" and "route"/"out" came back as no rhyme AT ALL."""
    kind, conf = classify_rhyme(pronounce(a), pronounce(b), word_a=a, word_b=b)
    assert kind == "end-rhyme", (kind, conf)


@needs_cmudict
@pytest.mark.parametrize(
    ("a", "b"), [("fire", "star"), ("hour", "far"), ("our", "car")]
)
def test_a_syllable_collapsing_reading_does_not_invent_a_rhyme(a, b):
    """The other kind of alternate entry drops a syllable - "fire" is F AY1
    ER0 and also F AY1 R - and taking it makes a two-syllable word rhyme with
    anything ending -AR. It is a different word shape, not a different vowel,
    so it is not a reading this scores on."""
    kind, conf = classify_rhyme(pronounce(a), pronounce(b), word_a=a, word_b=b)
    assert kind not in ("end-rhyme", "slant-rhyme"), (kind, conf)


@needs_cmudict
def test_a_trailing_secondary_stress_does_not_hide_the_rhyming_syllable():
    """ "nobody" is N OW1 B AA2 D IY2: its primary stress is the FIRST
    syllable and its last stress is the throwaway "-dy", so neither the
    last-stressed nor the last-primary-stressed reading is the "-body" that
    rhymes it perfectly with "somebody"."""
    kind, conf = classify_rhyme(
        pronounce("somebody"), pronounce("nobody"), word_a="somebody", word_b="nobody"
    )
    assert kind == "slant-rhyme" and conf >= 0.9, (kind, conf)


def test_an_earlier_reading_is_not_offered_off_a_primary_stress():
    """A line ending is scored as a phrase too. Let the rhyme start earlier
    than a PRIMARY stress and "in the garden" starts on the schwa of "the",
    which matches the schwa of "full of velvet" and invents a rhyme between
    two lines that do not have one."""
    a = pronounce_phrase(["in", "the", "garden"])
    b = pronounce_phrase(["full", "of", "velvet"])
    kind, conf = classify_rhyme(a, b, word_a="in the garden", word_b="full of velvet")
    assert kind not in ("end-rhyme", "slant-rhyme"), (kind, conf)
