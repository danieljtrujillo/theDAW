"""Style profiles: the shipped JSON holds to the schema, the extracted ones say
which works they were counted from and the authored ones say they were not,
the Bach chorales count like Bach chorales, and the roman-numeral reading
under them agrees with human analyses.

Pure music21 + numpy; no model, no GPU.
"""

from __future__ import annotations

import json

import pytest

from backend.modules.composer import profile as P
from backend.modules.composer.romans import (
    chord_roman,
    display_figure,
    key_from_index,
    local_keys,
    vocab_label,
    window_vectors,
)
from backend.modules.composer.spec import CADENCES

EXTRACTED = ("bach", "handel", "haydn", "mozart", "beethoven")
AUTHORED = ("brahms", "tchaikovsky", "debussy", "stravinsky", "bartok")


def _doc(style_id: str) -> dict:
    path = P.STYLES_DIR / f"{style_id}.json"
    return json.loads(path.read_text(encoding="utf-8"))


@pytest.mark.parametrize("style_id", EXTRACTED + AUTHORED)
def test_every_shipped_profile_validates_against_the_schema(style_id: str) -> None:
    doc = _doc(style_id)
    assert P.validate_profile(doc) == []
    assert doc["id"] == style_id
    assert set(doc["cadences"]) == set(CADENCES)


def test_the_styles_folder_holds_exactly_the_ten_composers() -> None:
    ids = sorted(p.stem for p in P.STYLES_DIR.glob("*.json"))
    assert ids == sorted(EXTRACTED + AUTHORED)
    assert sorted(P.style_ids()) == ids


@pytest.mark.parametrize("style_id", EXTRACTED)
def test_an_extracted_profile_lists_the_corpus_works_it_counted(style_id: str) -> None:
    from music21 import corpus

    doc = _doc(style_id)
    assert doc["source"] == "extracted"
    assert doc["works"] and doc["sample"]["works"] == len(doc["works"])
    assert doc["sample"]["bars"] > 0 and doc["sample"]["harmonies"] > 0
    assert doc["sample"]["available"] >= len(doc["works"])
    assert "selection" in doc["sample"]
    # Every work is a music21 corpus piece of that composer.
    for work in doc["works"]:
        assert work.split("/")[0] == style_id
        assert corpus.getWork(work)


@pytest.mark.parametrize("style_id", AUTHORED)
def test_an_authored_profile_says_so_and_claims_no_works(style_id: str) -> None:
    doc = _doc(style_id)
    assert doc["source"] == "authored"
    assert doc["works"] == [] and doc["sample"]["works"] == 0
    assert doc["basis"].startswith("authored from")
    assert "\n" not in doc["basis"]


def test_the_bach_chorales_cadence_v_to_i_and_change_chord_every_beat() -> None:
    doc = _doc("bach")
    assert doc["orchestration"] == "satb_choir"
    assert all(w.startswith("bach/") for w in doc["works"])
    top = max(doc["cadences"], key=doc["cadences"].get)
    assert top == "authentic_perfect"
    assert doc["harmonic_rhythm"]["chords_per_pulse"] >= 1.0
    major = doc["vocabulary"]["major"]
    assert list(major)[:2] == ["I", "V"]
    assert doc["texture"]["voices"] >= 3.5
    assert doc["texture"]["homophony"] > 0.5


def test_a_debussy_profile_leans_plagal_and_modal_where_bach_leans_dominant() -> None:
    bach, debussy = _doc("bach"), _doc("debussy")
    assert debussy["cadences"]["plagal"] > bach["cadences"]["plagal"]
    assert debussy["vocabulary"]["major"].get("bVII", 0) > bach["vocabulary"][
        "major"
    ].get("bVII", 0)
    assert debussy["vocabulary"]["major"]["V"] < bach["vocabulary"]["major"]["V"]


def test_extracting_two_chorales_makes_a_valid_profile_that_names_them() -> None:
    from music21 import corpus

    works = ["bach/bwv66.6", "bach/bwv269"]
    doc = P.extract_profile(
        [(w, corpus.parse(w)) for w in works], style_id="two", name="Two chorales"
    )
    assert P.validate_profile(doc) == []
    assert doc["works"] == works and doc["source"] == "extracted"
    assert doc["orchestration"] == "satb_choir"
    assert doc["meter"]["meters"] == pytest.approx(
        {"3/4": doc["meter"]["meters"]["3/4"], "4/4": doc["meter"]["meters"]["4/4"]}
    )
    assert sum(doc["cadences"].values()) == pytest.approx(1.0, abs=0.01)


def test_a_score_with_no_notes_cannot_be_profiled() -> None:
    from music21 import stream

    with pytest.raises(P.ProfileError):
        P.extract_profile([("empty", stream.Score())], style_id="x", name="x")


def test_validate_profile_names_what_is_wrong() -> None:
    doc = _doc("bach")
    broken = dict(doc, source="guessed", orchestration="kazoo band")
    errors = P.validate_profile(broken)
    assert any("source" in e for e in errors)
    assert any("orchestration" in e for e in errors)
    authored_with_works = dict(_doc("debussy"), works=["debussy/clair_de_lune"])
    assert any("lists no works" in e for e in P.validate_profile(authored_with_works))


# ---------------------------------------------------------------------------
# the reading underneath
# ---------------------------------------------------------------------------


def test_chord_sets_and_non_chord_tones() -> None:
    assert (
        P.is_chord({0, 4, 7}) and P.is_chord({7, 11, 2, 5}) and P.is_chord({7, 11, 5})
    )
    assert not P.is_chord({0, 2, 4}) and not P.is_chord({0, 7})
    # C E G with a passing D as long as the chord tones: the D goes.
    assert P.reduce_to_chord({0: 1.0, 2: 0.5, 4: 1.0, 7: 1.0}, 0) == {0, 4, 7}
    assert P.reduce_to_chord({0: 1.0, 2: 1.0}, 0) is None


def test_vocabulary_labels_drop_the_inversion() -> None:
    assert vocab_label("V65") == "V7"
    assert vocab_label("ii6") == "ii"
    assert vocab_label("I64") == "I"
    assert vocab_label("viio6") == "viio"
    assert vocab_label("bII6") == "N" and vocab_label("N6") == "N"
    assert vocab_label("V65/V") == "V7/V"
    assert vocab_label("It6") == "It6" and vocab_label("Ger65") == "Ger65"


def test_roman_numerals_in_the_local_key() -> None:
    from music21 import key

    g = key.Key("G")
    figures = [
        display_figure(chord_roman(ps, g))
        for ps in (
            ["G2", "B3", "D4", "G4"],
            ["C3", "E4", "G4", "C5"],
            ["D3", "F#4", "A4", "C5"],
            ["G2", "B3", "D4", "G4"],
        )
    ]
    assert figures == ["I", "IV", "V7", "I"]
    c = key.Key("C")
    assert chord_roman(["D3", "F#4", "A4", "C5"], c).figure == "V7/V"
    a = key.Key("a")
    assert chord_roman(["F3", "A3", "C4"], a).figure == "VI"
    assert chord_roman(["A2", "C#4", "E4"], a).figure == "I"  # Picardy third


def test_local_keys_follow_a_modulation_and_ignore_one_borrowed_chord() -> None:
    c_major = [(0, 4, 7), (5, 9, 0), (7, 11, 2), (0, 4, 7)]
    g_major = [(7, 11, 2), (0, 4, 7), (2, 6, 9), (7, 11, 2)]
    chords = c_major * 3 + [(5, 8, 0)] + c_major + g_major * 4
    starts, ends, pcs = [], [], []
    for i, triad in enumerate(chords):
        for pc in triad:
            starts.append(float(i))
            ends.append(float(i + 1))
            pcs.append(pc)
    centers = [i + 0.5 for i in range(len(chords))]
    vec = window_vectors(
        starts, ends, pcs, [c - 4 for c in centers], [c + 4 for c in centers]
    )
    keys = local_keys(vec)
    names = [str(key_from_index(k)) for k in keys]
    assert names[:17] == ["C major"] * 17
    assert names[-6:] == ["G major"] * 6


def test_chord_roots_agree_with_the_riemenschneider_analyses() -> None:
    """music21's corpus ships human roman-numeral analyses of Bach chorales;
    the profile's reading finds the analysts' chord root on most beats."""
    import bisect

    from music21 import corpus, key, roman

    agree = total = 0
    for number in (1, 2, 3, 6):
        name = list(
            corpus.chorales.Iterator(
                number, number, numberingSystem="riemenschneider", returnType="filename"
            )
        )[0]
        rows = P.harmonic_analysis(corpus.parse(name))
        starts = [r["start"] for r in rows]
        truth = corpus.parse(f"bach/choraleAnalyses/riemenschneider{number:03d}.rntxt")
        for rn in truth.flatten().getElementsByClass(roman.RomanNumeral):
            i = bisect.bisect_right(
                starts, float(rn.getOffsetInHierarchy(truth)) + 1e-6
            )
            if i == 0:
                continue
            row = rows[i - 1]
            tonic, mode = row["key"].split()
            k = key.Key(tonic.replace("b", "-"), mode)
            mine = roman.RomanNumeral(row["figure"], k).root()
            total += 1
            agree += mine.pitchClass == rn.root().pitchClass
    assert total > 150
    assert agree / total >= 0.75
