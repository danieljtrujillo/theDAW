"""The sheet importer on a real string quartet, and on the notation it used to
get wrong.

A score came in on the 16th grid with its FIRST time signature and FIRST tempo
alone: a quartet movement that changes meter four times and tempo three times
opened in one meter at one tempo, a triplet was rounded to 16ths, chord symbols
came in as one-step chords, unpitched percussion was dropped, grace notes sat
on their principal note's step for one step, and trills and mordents were not
played. The importer now returns 960 PPQ ticks, every time signature with the
pickup, every tempo mark, the registry instrument of each part, kit keys for
unpitched notes, timed grace notes, played-out ornaments and dynamics as
velocity.

The quartet is bars 530-640 of Beethoven's Op. 132 from music21's corpus
(``tests/fixtures/quartet``, written by ``scripts/make_quartet_fixture.py``).
"""

from __future__ import annotations

from pathlib import Path

import pytest

FIXTURE = Path(__file__).parent / "fixtures" / "quartet" / "op132_m530-640.mxl"
PPQ = 960


@pytest.fixture(scope="module")
def quartet() -> dict:
    from backend.modules.sheetimport.parser import parse_score_path

    return parse_score_path(str(FIXTURE))


def test_each_part_is_on_its_registry_instrument(quartet: dict) -> None:
    tracks = quartet["tracks"]
    assert [t["name"] for t in tracks] == [
        "Violin I",
        "Violin II",
        "Viola",
        "Violoncello",
    ]
    assert [t["instrument"] for t in tracks] == ["violin", "violin", "viola", "cello"]
    assert [t["program"] for t in tracks] == [40, 40, 41, 42]
    assert [t["percussion"] for t in tracks] == [False] * 4


def test_notes_come_back_on_the_rolls_960_ppq_clock(quartet: dict) -> None:
    from music21 import converter

    assert quartet["ppq"] == PPQ
    score = converter.parse(str(FIXTURE))
    for track, part in zip(quartet["tracks"], score.parts):
        for n in track["notes"]:
            assert (
                isinstance(n["tick"], int)
                and isinstance(n["ticks"], int)
                and n["ticks"] >= 1
            )
            assert n["step"] == n["tick"] / 240 and n["length"] == max(
                1 / 240, n["ticks"] / 240
            )
        # Every onset the score writes on a whole tick is in the part at that
        # tick (a grace note's principal moves later by its graces, so only
        # notes with no grace before them are held to their written place).
        written = {
            round(float(el.offset) * PPQ)
            for el in part.flatten().stripTies().notes
            if not el.duration.isGrace
            and float(el.offset) * PPQ == round(float(el.offset) * PPQ)
        }
        onsets = {n["tick"] for n in track["notes"]}
        missing = [t for t in sorted(written) if t not in onsets]
        assert len(missing) <= 30, f"{track['name']}: onsets moved {missing[:10]}"


def test_every_time_signature_comes_back_at_its_bar(quartet: dict) -> None:
    # Bars 530-541 are 4/4, 542-594 3/8, 595-625 4/4, and 626 on 3/8.
    four, three_eight = 4 * PPQ, 3 * PPQ // 2
    at_542 = 12 * four
    at_595 = at_542 + 53 * three_eight
    at_626 = at_595 + 31 * four
    assert [(s["tick"], s["num"], s["den"]) for s in quartet["time_signatures"]] == [
        (0, 4, 4),
        (at_542, 3, 8),
        (at_595, 4, 4),
        (at_626, 3, 8),
    ]
    assert quartet["pickup_ticks"] == 0
    assert quartet["time_signature"] == [4, 4], (
        "the first signature stays for older readers"
    )


def test_every_tempo_mark_comes_back(quartet: dict) -> None:
    four, three_eight = 4 * PPQ, 3 * PPQ // 2
    at_542 = 12 * four
    at_595 = at_542 + 53 * three_eight
    at_626 = at_595 + 31 * four
    marks = [(t["tick"], t["bpm"], t["text"], t["implicit"]) for t in quartet["tempos"]]
    # "Andante" and "Molto Adagio" are words, which music21 reads as 72 and 40;
    # "andantino" carries a metronome number: a dotted eighth at 80 is 60 quarters a minute.
    assert marks == [
        (at_542, 72.0, "Andante", True),
        (at_595, 40.0, "Molto Adagio", True),
        (at_626, 60.0, "andantino", False),
    ]
    assert quartet["bpm"] == 120.0, "no mark at bar 530: the score starts at 120"


def test_grace_notes_take_time_before_their_principal(quartet: dict) -> None:
    from music21 import converter, expressions

    score = converter.parse(str(FIXTURE))
    assert quartet["grace_notes"] > 0
    # The first grace note of each part: it sounds on the beat for a 32nd, and
    # the note it leads into starts that much later, shortened by as much.
    checked = 0
    for track, part in zip(quartet["tracks"], score.parts):
        seq = list(part.flatten().stripTies().notes)
        for i, el in enumerate(seq):
            if not el.duration.isGrace or el.isChord:
                continue
            group = [el]
            j = i + 1
            while j < len(seq) and seq[j].duration.isGrace:
                group.append(seq[j])
                j += 1
            principal = seq[j] if j < len(seq) else None
            if (
                principal is None
                or principal.isChord
                or abs(float(principal.offset) - float(el.offset)) > 1e-9
            ):
                continue
            # A principal with a trill is played out in 32nds; its timing is the ornament test's.
            if any(isinstance(e, expressions.Ornament) for e in principal.expressions):
                continue
            at = round(float(el.offset) * PPQ)
            each = min(
                PPQ // 8, round(float(principal.quarterLength) * PPQ * 0.5 / len(group))
            )
            by_tick = {(n["tick"], n["pitch"]): n for n in track["notes"]}
            first = by_tick.get((at, int(el.pitch.midi)))
            assert first is not None and first["ticks"] == each, (
                f"{track['name']}: grace at {at}"
            )
            lead = by_tick.get((at + each * len(group), int(principal.pitch.midi)))
            assert lead is not None, (
                f"{track['name']}: the principal starts after its graces"
            )
            assert lead["ticks"] == round(
                float(principal.quarterLength) * PPQ
            ) - each * len(group)
            checked += 1
            break
    assert checked >= 2


def test_trills_are_played_out_on_the_notes_of_the_key(quartet: dict) -> None:
    from music21 import converter, expressions, key

    score = converter.parse(str(FIXTURE))
    assert quartet["ornaments"] > 0
    checked = 0
    for track, part in zip(quartet["tracks"], score.parts):
        flat = part.flatten().stripTies()
        for el in flat.notes:
            if el.isChord or el.duration.isGrace:
                continue
            trills = [e for e in el.expressions if isinstance(e, expressions.Trill)]
            if not trills:
                continue
            at = round(float(el.offset) * PPQ)
            end = at + round(float(el.quarterLength) * PPQ)
            played = sorted(
                (n["tick"], n["pitch"]) for n in track["notes"] if at <= n["tick"] < end
            )
            pitches = {p for _, p in played}
            # The trill alternates the note with the next note of the key, above it.
            trills[0].resolveOrnamentalPitches(
                el, keySig=el.getContextByClass(key.KeySignature)
            )
            neighbours = {int(p.midi) for p in trills[0].ornamentalPitches}
            assert int(el.pitch.midi) in pitches
            assert neighbours & pitches, (
                f"{track['name']}: trill at {at} played {played[:6]}"
            )
            assert len(played) >= 4
            checked += 1
            break
    assert checked >= 1


SYNTHETIC = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
  <part-list>
    <score-part id="P1"><part-name>Flute</part-name>
      <score-instrument id="P1-I1"><instrument-name>Flute</instrument-name></score-instrument>
      <midi-instrument id="P1-I1"><midi-channel>1</midi-channel><midi-program>74</midi-program></midi-instrument>
    </score-part>
    <score-part id="P2"><part-name>Drum Set</part-name>
      <score-instrument id="P2-I36"><instrument-name>Bass Drum</instrument-name></score-instrument>
      <score-instrument id="P2-I39"><instrument-name>Snare</instrument-name></score-instrument>
      <score-instrument id="P2-I43"><instrument-name>Closed Hi-Hat</instrument-name></score-instrument>
      <midi-instrument id="P2-I36"><midi-channel>10</midi-channel><midi-program>1</midi-program><midi-unpitched>37</midi-unpitched></midi-instrument>
      <midi-instrument id="P2-I39"><midi-channel>10</midi-channel><midi-program>1</midi-program><midi-unpitched>39</midi-unpitched></midi-instrument>
      <midi-instrument id="P2-I43"><midi-channel>10</midi-channel><midi-program>1</midi-program><midi-unpitched>43</midi-unpitched></midi-instrument>
    </score-part>
    <score-part id="P3"><part-name>Snare Drum</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="0" implicit="yes">
      <attributes><divisions>4</divisions><key><fifths>1</fifths></key><time><beats>3</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
      <direction placement="above"><direction-type><words>Allegro</words></direction-type></direction>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type></note>
    </measure>
    <measure number="1">
      <harmony><root><root-step>G</root-step></root><kind>major</kind></harmony>
      <direction placement="below"><direction-type><dynamics><p/></dynamics></direction-type></direction>
      <note><grace slash="yes"/><pitch><step>A</step><octave>5</octave></pitch><type>eighth</type></note>
      <note><pitch><step>G</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type></note>
      <direction placement="below"><direction-type><dynamics><sfz/></dynamics></direction-type></direction>
      <note><pitch><step>B</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type></note>
      <direction placement="above"><direction-type><words>Molto adagio</words></direction-type><offset>-1</offset></direction>
      <note><pitch><step>C</step><octave>6</octave></pitch><duration>4</duration><type>quarter</type></note>
    </measure>
    <measure number="2">
      <attributes><time><beats>2+2+3</beats><beat-type>8</beat-type></time></attributes>
      <direction placement="above"><direction-type><metronome><beat-unit>eighth</beat-unit><per-minute>240</per-minute></metronome></direction-type><sound tempo="120"/></direction>
      <direction placement="below"><direction-type><dynamics><ff/></dynamics></direction-type></direction>
      <note><pitch><step>A</step><octave>5</octave></pitch><duration>6</duration><type>quarter</type><dot/><notations><ornaments><trill-mark/></ornaments></notations></note>
      <note><pitch><step>F</step><alter>1</alter><octave>5</octave></pitch><duration>4</duration><type>quarter</type><notations><ornaments><mordent/></ornaments></notations></note>
      <note><pitch><step>G</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type><notations><ornaments><turn/></ornaments></notations></note>
    </measure>
  </part>
  <part id="P2">
    <measure number="0" implicit="yes">
      <attributes><divisions>4</divisions><time><beats>3</beats><beat-type>4</beat-type></time><clef><sign>percussion</sign></clef></attributes>
      <note><unpitched><display-step>C</display-step><display-octave>5</display-octave></unpitched><duration>4</duration><instrument id="P2-I39"/><type>quarter</type></note>
    </measure>
    <measure number="1">
      <note><unpitched><display-step>F</display-step><display-octave>4</display-octave></unpitched><duration>4</duration><instrument id="P2-I36"/><type>quarter</type></note>
      <note><unpitched><display-step>G</display-step><display-octave>5</display-octave></unpitched><duration>4</duration><instrument id="P2-I43"/><type>quarter</type><notehead>x</notehead></note>
      <note><unpitched><display-step>A</display-step><display-octave>5</display-octave></unpitched><duration>4</duration><type>quarter</type><notehead>x</notehead></note>
    </measure>
    <measure number="2">
      <attributes><time><beats>2+2+3</beats><beat-type>8</beat-type></time></attributes>
      <note><unpitched><display-step>F</display-step><display-octave>4</display-octave></unpitched><duration>14</duration><type>half</type><dot/><dot/></note>
    </measure>
  </part>
  <part id="P3">
    <measure number="0" implicit="yes">
      <attributes><divisions>4</divisions><time><beats>3</beats><beat-type>4</beat-type></time><clef><sign>percussion</sign></clef><staff-details><staff-lines>1</staff-lines></staff-details></attributes>
      <note><unpitched><display-step>E</display-step><display-octave>4</display-octave></unpitched><duration>4</duration><type>quarter</type></note>
    </measure>
    <measure number="1">
      <note><rest/><duration>12</duration><type>half</type><dot/></note>
    </measure>
    <measure number="2">
      <attributes><time><beats>2+2+3</beats><beat-type>8</beat-type></time></attributes>
      <note><rest/><duration>14</duration><type>half</type><dot/><dot/></note>
    </measure>
  </part>
</score-partwise>
"""


@pytest.fixture(scope="module")
def synthetic(tmp_path_factory: pytest.TempPathFactory) -> dict:
    from backend.modules.sheetimport.parser import parse_score_path

    path = tmp_path_factory.mktemp("sheet") / "notation.musicxml"
    path.write_text(SYNTHETIC, encoding="utf-8")
    return parse_score_path(str(path))


def _notes(result: dict, name: str) -> list[tuple[int, int, int, int]]:
    track = next(t for t in result["tracks"] if t["name"] == name)
    return [(n["tick"], n["ticks"], n["pitch"], n["velocity"]) for n in track["notes"]]


def test_a_pickup_and_an_additive_meter(synthetic: dict) -> None:
    assert synthetic["pickup_ticks"] == PPQ, "a one-beat pickup before bar 1"
    assert [
        (s["tick"], s["num"], s["den"], s["groups"])
        for s in synthetic["time_signatures"]
    ] == [
        (0, 3, 4, []),
        (4 * PPQ, 7, 8, [2, 2, 3]),
    ]


def test_tempo_words_and_metronome_marks(synthetic: dict) -> None:
    # "Allegro" is music21's 132; "Molto adagio" sits a 16th left of its note
    # on the page (its direction's <offset>), which music21 turns into a 16th
    # early, and lands back on the note (tick 2880); an eighth at 240 is 120 quarters.
    assert [(t["tick"], t["bpm"], t["implicit"]) for t in synthetic["tempos"]] == [
        (0, 132.0, True),
        (2880, 40.0, True),
        (4 * PPQ, 120.0, False),
    ]
    assert synthetic["bpm"] == 132.0


def test_chord_symbols_are_not_notes(synthetic: dict) -> None:
    assert synthetic["chord_symbols_skipped"] == 1
    flute = _notes(synthetic, "Flute")
    # A G major chord symbol at bar 1 would have put G, B and D at tick 960.
    assert not any(
        t == PPQ and p in (67, 71, 74) and n > 0 for t, n, p, _ in flute if p != 79
    )


def test_grace_notes_ornaments_and_dynamics(synthetic: dict) -> None:
    flute = _notes(synthetic, "Flute")
    # The pickup before any dynamic keeps 90.
    assert flute[0] == (0, PPQ, 74, 90)
    # The slashed grace A5: a 32nd on the beat at p (44), and G5 after it, shortened by as much.
    assert flute[1] == (PPQ, 120, 81, 44)
    assert flute[2] == (PPQ + 120, PPQ - 120, 79, 44)
    # The sforzando marks B5 alone; C5 after it is back at p.
    assert flute[3] == (2 * PPQ, PPQ, 83, 89)
    assert flute[4] == (3 * PPQ, PPQ, 84, 44)
    # Bar 2 at ff (108): the trill on A5 alternates with B5 (the key's next note up) in 32nds,
    # the mordent on F#5 dips to E5, the turn on G5 goes A5 G5 F#5 G5.
    bar2 = [x for x in flute if x[0] >= 4 * PPQ]
    trill = [p for t, _, p, _ in bar2 if t < 4 * PPQ + 3 * PPQ // 2]
    assert trill == [81, 83] * 6
    assert all(v == 108 for *_, v in bar2)
    mordent = [
        p for t, _, p, _ in bar2 if 4 * PPQ + 3 * PPQ // 2 <= t < 4 * PPQ + 5 * PPQ // 2
    ]
    assert mordent == [78, 76, 78]
    turn = [p for t, _, p, _ in bar2 if t >= 4 * PPQ + 5 * PPQ // 2]
    assert turn == [81, 79, 78, 79]
    assert synthetic["grace_notes"] == 1 and synthetic["ornaments"] == 3


def test_unpitched_notes_land_on_kit_keys(synthetic: dict) -> None:
    drums = next(t for t in synthetic["tracks"] if t["name"] == "Drum Set")
    assert drums["percussion"] is True and drums["instrument"] == "drum-kit"
    # The file's own <midi-unpitched> (1-based) names snare 38, bass drum 36,
    # closed hi-hat 42; the A5 x names no instrument and reads as the drum-set
    # crash (49); the last F4 names none and takes the bass drum the file gives F4.
    assert [p for _, _, p, _ in _notes(synthetic, "Drum Set")] == [38, 36, 42, 49, 36]
    # A snare drum part with no MIDI instrument plays its registry key, 38.
    snare = next(t for t in synthetic["tracks"] if t["name"] == "Snare Drum")
    assert snare["instrument"] == "snare-drum" and snare["percussion"] is True
    assert [p for _, _, p, _ in _notes(synthetic, "Snare Drum")] == [38]
    assert synthetic["unpitched"] == 6 and synthetic["unmapped_unpitched"] == 0
