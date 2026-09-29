"""Latin lyrics: the rule-based reader (backend.modules.lyricanalysis.latin)
and everything that reads a lyric through it.

Every line here is classical or medieval public-domain Latin: Caesar, Vergil,
Ovid, Catullus, the Dies irae and the Stabat mater. The sequence tests replay
what SING does — the language picker saves ``language: "la"`` on the lyrics
document, then STUDY runs the analysis — so they fail on a build that reads
every lyric as English.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.core.jobs import create_job
from backend.modules.library import router as library_router_module
from backend.modules.lyricanalysis import devices, latin, llm
from backend.modules.lyricanalysis import router as analysis_router_module
from backend.modules.lyricanalysis import service
from backend.modules.lyricanalysis.phonetics import (
    classify_rhyme,
    language_scope,
    pronounce,
    syllabify,
)
from backend.modules.lyricanalysis.schema import LyricAnalysisDoc
from backend.modules.lyrics import router as lyrics_router_module
from backend.modules.lyrics.schema import LyricsDoc, split_text
from tests.test_library_store import _seed_generate_entry

GALLIA = "Gallia est omnis dīvīsa in partēs trēs"
ARMA = "Arma virumque canō, Trōiae quī prīmus ab ōrīs"
DIES_IRAE = "Diēs īrae, diēs illa\nsolvet saeclum in favillā,\nteste Dāvīd cum Sibyllā."


def _syllables(word: str, macronized: bool = False) -> list[str]:
    return [word[a:b] for a, b in latin.syllable_bounds(word, macronized)]


def _stress(word: str, macronized: bool = False) -> str:
    return "".join(str(s) for s in latin.read_word(word, macronized).stress)


def _latin_doc(text: str) -> LyricsDoc:
    return LyricsDoc(entry_id="t", language="la", text=text, lines=split_text(text))


def _of(devs, kind: str) -> list:
    return [d for d in devs if d.kind == kind]


# --- reading one word -------------------------------------------------------


@pytest.mark.parametrize(
    ("word", "syllables", "stress"),
    [
        # The penultimate law: a heavy penult takes the stress ...
        ("dīvīsa", ["dī", "vī", "sa"], "010"),
        ("Intrāte,", ["In", "trā", "te,"], "010"),
        ("salvēte", ["sal", "vē", "te"], "010"),
        ("dolōrōsa", ["do", "lō", "rō", "sa"], "2010"),
        # ... a light one passes it to the antepenult.
        ("Gallia", ["Gal", "li", "a"], "100"),
        ("Ītaliam", ["Ī", "ta", "li", "am"], "0100"),
        # Closed by position: two consonants, x and a doubled /j/.
        ("fenestra", ["fe", "nes", "tra"], "010"),
        ("saxum", ["sax", "um"], "10"),
        ("maior", ["mai", "or"], "10"),
        ("Trōiae", ["Trōi", "ae"], "10"),
        # A stop before a liquid leaves the syllable in front open.
        ("tenebrae", ["te", "ne", "brae"], "100"),
        # Two-syllable words are stressed on the first; so are monosyllables.
        ("partēs", ["par", "tēs"], "10"),
        ("trēs", ["trēs"], "1"),
        # qu and ngu are one consonant; h is none.
        ("quoque", ["quo", "que"], "10"),
        ("sanguis", ["san", "guis"], "10"),
        ("mihi", ["mi", "hi"], "10"),
    ],
)
def test_syllables_and_the_penultimate_law(word, syllables, stress):
    assert _syllables(word) == syllables
    assert _stress(word) == stress


def test_enclitics_pull_the_stress_onto_the_syllable_before_them():
    # "virum" is VI-rum; with -que the stress moves to -rum.
    assert _stress("virum") == "10"
    assert _stress("virumque") == "010"
    assert latin.read_word("virumque").enclitic == "que"
    # "arma" + que: the light "-ma" is stressed all the same.
    assert _stress("armaque") == "010"
    assert _stress("Lāvīniaque") == "02010"
    assert latin.read_word("vidēsne").enclitic == "ne"
    assert latin.read_word("plūsve").enclitic == "ve"
    # Words that only end in the letters keep the ordinary law.
    assert latin.read_word("itaque").enclitic == ""
    assert _stress("itaque") == "100"
    assert _stress("undique") == "100"


def test_consonantal_i_and_u():
    assert latin.pronounce("iam").phones == ("Y", "AA", "M")
    assert latin.pronounce("Iūlius").phones[:2] == ("Y", "UW")
    assert latin.pronounce("Jūlius").phones == latin.pronounce("Iūlius").phones
    assert latin.pronounce("cuius").phones == ("K", "UW", "Y", "Y", "UW", "S")
    assert latin.pronounce("iniūria").phones[:4] == ("IY", "N", "Y", "UW")
    # u as /w/ at the start of a word and between vowels; a vowel after a
    # consonant.
    assert latin.pronounce("uirumque").phones == latin.pronounce("virumque").phones
    assert latin.pronounce("nouus").phones == ("N", "OW", "W", "UW", "S")
    assert latin.pronounce("tuus").phones == ("T", "UW", "UW", "S")
    assert latin.pronounce("fuit").phones == ("F", "UW", "IY", "T")


def test_diphthongs_and_their_hiatus():
    assert latin.pronounce("Cæsar").phones == ("K", "AY", "S", "AA", "R")
    assert latin.pronounce("Caesar").phones == latin.pronounce("Cæsar").phones
    assert latin.pronounce("poena").phones[1] == "OY"
    assert latin.pronounce("laudāte").phones[1] == "AW"
    assert latin.pronounce("heu").phones == ("HH", "EH", "W")
    assert latin.pronounce("huic").phones == ("HH", "UW", "Y", "K")
    # Not diphthongs: deus, a diaeresis, a macron on either half, au + vowel.
    assert _syllables("deus") == ["de", "us"]
    assert _syllables("poëta") == ["po", "ë", "ta"]
    assert _syllables("aër") == ["a", "ër"]
    assert _syllables("pauor") == ["pa", "uor"]


def test_macrons_move_the_stress_never_the_vowels():
    marked, plain = latin.pronounce("dīvīsa"), latin.pronounce("divisa")
    assert marked.phones == plain.phones
    assert marked.stress == (0, 1, 0) and not marked.guessed
    # Without the macron the penult's length is unknown: the stress falls on
    # the antepenult and the word says it was a guess.
    assert plain.stress == (1, 0, 0) and plain.guessed
    # In a text that marks its lengths, an unmarked vowel is a short one.
    assert latin.pronounce("Gallia", True).guessed is False
    assert latin.pronounce("dominus", True).stress == (1, 0, 0)
    # A vowel before a vowel is short without being told.
    assert latin.pronounce("Gallia").guessed is False
    # Endings whose penult is always long settle a plain text too.
    assert latin.pronounce("intrate").stress == (0, 1, 0)
    assert latin.pronounce("lacrimosa").stress[-2] == 1


def test_the_church_books_acute_places_the_stress():
    assert _stress("Dóminus") == "100"
    assert _stress("María") == "010"
    assert _stress("Maria") == "100"


def test_what_a_pasted_text_carries():
    # Hyphens (sung syllables, an enclitic set off) join the word.
    assert _syllables("Ky-ri-e") == ["Ky-", "ri-", "e"]
    assert latin.pronounce("arma-que").stress == latin.pronounce("armaque").stress
    # Capitals, and inscriptional V for the vowel u.
    assert latin.pronounce("POPVLVSQVE").phones == latin.pronounce("populusque").phones
    assert latin.pronounce("SENATVS").stress == (0, 1, 0)
    assert latin.spell_vowel_u("POPVLVSQVE") == "POPULUSQUE"
    assert latin.spell_vowel_u("VENI") == "VENI"
    assert latin.spell_vowel_u("vēnī") == "vēnī"
    # Punctuation stays out of the phones and inside the last syllable.
    assert latin.pronounce("canō,").phones == ("K", "AA", "N", "OW")
    assert _syllables("canō,") == ["ca", "nō,"]
    # A mark typed as its own combining character counts the same.
    assert latin.pronounce("divīsa").stress == (0, 1, 0)
    assert latin.pronounce("2") == latin.pronounce("")


def test_the_phonetics_scope_reads_latin_and_splits_latin_syllables():
    with language_scope("la"):
        pron = pronounce("fenestra")
        assert [s.onset + (s.nucleus,) + s.coda for s in syllabify(pron)] == [
            ("F", "EH"),
            ("N", "EH", "S"),
            ("T", "R", "AA"),
        ]
        # Same letters, same vowels: a macron never breaks a rhyme.
        assert classify_rhyme(pronounce("favillā"), pronounce("illa"))[0] in (
            "end-rhyme",
            "identical-rhyme",
        )
    # Outside the scope the same word is read as English again.
    assert pronounce("fenestra") != latin.pronounce("fenestra")


# --- quantitative verse -----------------------------------------------------


def test_scansion_finds_the_classical_meters():
    assert latin.scan_line(ARMA.split()) == (
        "dactylic hexameter",
        "DDSSDS  — ∪ ∪ | — ∪ ∪ | — — | — — | — ∪ ∪ | — ×",
    )
    ovid = "Arma gravī numerō violentaque bella parābam".split()
    assert latin.scan_line(ovid)[0] == "dactylic hexameter"
    assert latin.scan_line("ēdere, māteriā conveniente modīs.".split())[0] == (
        "elegiac pentameter"
    )
    catullus = "Cui dōnō lepidum novum libellum".split()
    assert latin.scan_line(catullus)[0] == "hendecasyllable"
    # Prose is no meter.
    assert latin.scan_line(GALLIA.split()) is None


def test_verse_weights_elide_and_carry_consonants_across_words():
    # "prīmus ab ōrīs" is prī-mu-sa-bō-rīs: the s and the b move on, so
    # "-mus" and "ab" are both light.
    assert latin.verse_weights("prīmus ab ōrīs".split()) == "HLLHA"
    # "multum ille" elides the -um, "ille et" the -e.
    assert latin.verse_weights("multum ille terrīs".split()) == "HHLHA"
    assert latin.verse_weights("multum ille et".split()) == "HHA"


# --- the analysis of a Latin lyric -------------------------------------------


def test_a_prose_line_counts_its_latin_syllables_and_stresses():
    _devs, lines, _sections, stats = devices.analyse(_latin_doc(GALLIA))
    assert lines[0].syllables == 13
    assert lines[0].stress == "1001100101101"
    assert stats.guessed_pronunciations == 0


def test_the_dies_irae_is_a_rhyme_run_in_trochaic_meter():
    devs, lines, sections, _stats = devices.analyse(_latin_doc(DIES_IRAE))
    assert sections[0].scheme == "AAA"
    assert all(m.end_key == "IY L L AA" for m in lines)
    run = _of(devs, "rhyme-run")
    assert run and [s.text for s in run[0].spans] == ["illa", "villā", "byllā"]
    # The rhyme is painted on the letters that rhyme: fa|villā, Si|byllā.
    assert (run[0].spans[1].char_start, run[0].spans[2].char_start) == (2, 2)
    assert {d.detail.split(" (")[0] for d in _of(devs, "meter")} == {
        "trochaic tetrameter"
    }


def test_the_aeneid_scans_as_a_hexameter():
    devs, *_ = devices.analyse(_latin_doc(ARMA))
    meters = _of(devs, "meter")
    assert len(meters) == 1
    assert meters[0].label == "meter: dactylic hexameter"
    assert "DDSSDS" in meters[0].detail


def test_sound_devices_read_latin_sounds():
    devs, *_ = devices.analyse(_latin_doc("Vēnī, vīdī, vīcī."))
    allit = _of(devs, "alliteration")
    assert allit and allit[0].detail == "W"
    # Assonance by vowel colour: the stressed vowel of each word, whatever its
    # length — Trōiae and ōrīs ring on the same o.
    devs, *_ = devices.analyse(_latin_doc(ARMA))
    rings = {d.detail for d in _of(devs, "assonance")}
    assert "OW" in rings and "AA" in rings


def test_repetition_reads_latin_inflection_and_enclitics():
    devs, *_ = devices.analyse(_latin_doc("Lupus est homō hominī"))
    poly = _of(devs, "polyptoton")
    assert poly and [s.text for s in poly[0].spans] == ["homō", "hominī"]
    # A line opening on "-que" goes on with the sentence before it.
    text = "Ītaliam, fātō profugus, Lāvīnaque vēnit\nlītora, multum ille et terrīs"
    devs, *_ = devices.analyse(_latin_doc(text))
    assert _of(devs, "enjambment")


def test_no_english_double_meanings_on_latin_words():
    # "sum" is "some" in English, and the English pass says so; a Latin "sum"
    # is "I am", and nothing is claimed about it.
    english = devices.analyse(
        LyricsDoc(entry_id="t", text="sum", lines=split_text("sum"))
    )[0]
    assert _of(english, "dual-meaning")
    devs, *_ = devices.analyse(_latin_doc("Cōgitō ergō sum"))
    assert not [d for d in devs if d.family == "meaning"]


def test_a_quantity_pun_is_latins_own_double_meaning():
    devs, *_ = devices.analyse(_latin_doc("Mālum ēdit\nmalum vīdit"))
    puns = _of(devs, "pun")
    assert len(puns) == 1 and puns[0].label == "quantity pun: malum / mālum"
    # Without the marks the two words are one spelling and nothing is claimed.
    devs, *_ = devices.analyse(_latin_doc("Malum edit\nmalum vidit"))
    assert not _of(devs, "pun")


def test_hyphens_capitals_and_punctuation_in_a_real_text():
    _devs, lines, *_ = devices.analyse(_latin_doc("Ky-ri-e e-lei-son"))
    assert lines[0].syllables == 7
    assert lines[0].stress == "1000100"
    _devs, lines, *_ = devices.analyse(_latin_doc("SENATVS POPVLVSQVE ROMANVS"))
    assert lines[0].stress == "0102010010"


def test_the_same_text_as_english_is_read_as_english():
    english = LyricsDoc(entry_id="t", text=GALLIA, lines=split_text(GALLIA))
    _devs, lines, *_ = devices.analyse(english)
    assert lines[0].stress != "1001100101101"


# --- the sequence SING runs --------------------------------------------------


@pytest.fixture
def client(tmp_path: Path, monkeypatch) -> TestClient:
    monkeypatch.setattr(library_router_module, "_store", None)
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(tmp_path))
    monkeypatch.setenv("theDAW_LYRIC_DOCS_DIR", str(tmp_path / "notebook"))
    monkeypatch.setattr(llm, "_get_api_key", lambda pid, request_key=None: "")
    service._active_jobs.clear()
    app = FastAPI()
    app.include_router(library_router_module.router, prefix="/api/library")
    app.include_router(lyrics_router_module.router, prefix="/api/lyrics")
    app.include_router(analysis_router_module.router, prefix="/api/lyricanalysis")
    return TestClient(app)


def _seed(tmp_path: Path, client: TestClient) -> str:
    _seed_generate_entry(tmp_path, "job_latin", 0)
    ids = [e["id"] for e in client.get("/api/library/entries").json()["entries"]]
    return next(i for i in ids if i.startswith("job_latin"))


def test_picking_latin_saves_it_and_study_reads_the_lyric_as_latin(client, tmp_path):
    eid = _seed(tmp_path, client)
    # The words are pasted (the editor's text PUT) ...
    doc = client.put(f"/api/lyrics/{eid}", json={"text": GALLIA}).json()
    assert doc["language"] == "en"
    # ... then Latin is picked: the store saves the whole document with it.
    saved = client.put(
        f"/api/lyrics/{eid}",
        json={
            "lines": doc["lines"],
            "offset_ms": 0,
            "language": "la",
            "source": doc["source"],
        },
    ).json()
    assert saved["language"] == "la"
    # A reload brings it back.
    assert client.get(f"/api/lyrics/{eid}").json()["doc"]["language"] == "la"
    # STUDY's ANALYSE.
    job = create_job("lyricanalysis", "analyse")
    asyncio.run(service.run_analysis(job, eid, {}))
    assert job.status == "done", job.error
    analysis = LyricAnalysisDoc.model_validate(job.result)
    assert analysis.language == "la"
    assert analysis.pronunciation_source == "latin"
    assert analysis.lines[0].syllables == 13
    assert analysis.lines[0].stress == "1001100101101"
    body = client.get(f"/api/lyricanalysis/{eid}").json()
    assert body["stale"] is False
    # Back to English: the Latin reading no longer describes the lyric.
    client.put(
        f"/api/lyrics/{eid}",
        json={"lines": saved["lines"], "language": "en", "source": saved["source"]},
    )
    assert client.get(f"/api/lyricanalysis/{eid}").json()["stale"] is True


def test_the_scratch_pad_analyses_pasted_latin(client):
    r = client.post("/api/lyricanalysis/analyze", json={"text": ARMA, "language": "la"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["pronunciation_source"] == "latin"
    assert body["lines"][0]["syllables"] == 15


def test_a_latin_draft_keeps_its_language_into_the_song_and_back(client, tmp_path):
    eid = _seed(tmp_path, client)
    draft = client.post(
        "/api/lyricanalysis/documents",
        json={"title": "Aeneid", "text": ARMA, "language": "la"},
    ).json()
    r = client.post(
        f"/api/lyricanalysis/documents/{draft['id']}/attach",
        json={"entry_id": eid, "write_lyrics": True},
    )
    assert r.status_code == 200, r.text
    assert client.get(f"/api/lyrics/{eid}").json()["doc"]["language"] == "la"
    copy = client.post(
        "/api/lyricanalysis/documents/import", json={"entry_id": eid}
    ).json()
    assert copy["language"] == "la"


def test_the_interpretive_pass_is_told_the_lyric_is_latin(
    client, tmp_path, monkeypatch
):
    eid = _seed(tmp_path, client)
    client.put(f"/api/lyrics/{eid}", json={"text": GALLIA, "language": "la"})
    seen: dict = {}

    async def fake_chat(provider, model, api_key, prompt):
        seen["prompt"] = prompt
        return '{"devices": []}'

    monkeypatch.setattr(llm, "_get_api_key", lambda pid, request_key=None: "k")
    monkeypatch.setattr(llm, "_chat", fake_chat)
    job = create_job("lyricanalysis", "analyse")
    asyncio.run(
        service.run_analysis(
            job, eid, {"llm": True, "provider": "openai", "model": "m"}
        )
    )
    assert job.status == "done", job.error
    assert seen["prompt"].startswith("The lyric is in Latin.")
    assert "0:0 Gallia" in seen["prompt"]
