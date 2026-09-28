"""The sheet importer's sustain pedal, and the parts after a piano's staves.

A MusicXML ``<pedal>`` mark was dropped on import: a piano score came into the
roll with no pedal at all. music21 reads the marks as PedalMark spanners, but
after repeats are played out those spanners point at notes the expanded score
no longer holds, and a pedal inside a repeat is there once. The importer now
reads the marks from the file's own directions and gives each part controller
64 (``controls``) on every pass of its measures.

music21 splits a part with two staves into two PartStaffs, so every part after
a piano sat one index past its ``<part>``: a drum part after a piano read the
piano's (empty) kit keys, and a note whose instrument the file names fell back
to the drum-set staff position (a hand clap came in as a side stick).
"""

from __future__ import annotations

from pathlib import Path

import pytest

PPQ = 960
BAR = 2 * PPQ  # 2/4

PIANO_AND_DRUMS = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
  <part-list>
    <score-part id="P1"><part-name>Piano</part-name></score-part>
    <score-part id="P2"><part-name>Drums</part-name>
      <score-instrument id="P2-I36"><instrument-name>Bass Drum</instrument-name></score-instrument>
      <score-instrument id="P2-I39"><instrument-name>Hand Clap</instrument-name></score-instrument>
      <midi-instrument id="P2-I36"><midi-channel>10</midi-channel><midi-unpitched>37</midi-unpitched></midi-instrument>
      <midi-instrument id="P2-I39"><midi-channel>10</midi-channel><midi-unpitched>40</midi-unpitched></midi-instrument>
    </score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>2</divisions><key><fifths>0</fifths></key><time><beats>2</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>
      <barline location="left"><bar-style>heavy-light</bar-style><repeat direction="forward"/></barline>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
      <backup><duration>4</duration></backup>
      <direction placement="below"><direction-type><pedal type="start" line="yes"/></direction-type><staff>2</staff></direction>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration><voice>5</voice><type>half</type><staff>2</staff></note>
    </measure>
    <measure number="2">
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
      <direction placement="below"><direction-type><pedal type="change" line="yes"/></direction-type><staff>2</staff></direction>
      <note><pitch><step>F</step><octave>5</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
      <backup><duration>4</duration></backup>
      <note><pitch><step>G</step><octave>2</octave></pitch><duration>4</duration><voice>5</voice><type>half</type><staff>2</staff></note>
      <direction placement="below"><direction-type><pedal type="stop" line="yes"/></direction-type><staff>2</staff></direction>
      <barline location="right"><bar-style>light-heavy</bar-style><repeat direction="backward"/></barline>
    </measure>
    <measure number="3">
      <direction placement="below"><direction-type><pedal type="sostenuto" line="yes"/></direction-type><staff>2</staff></direction>
      <note><pitch><step>G</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>half</type><staff>1</staff></note>
      <direction placement="below"><direction-type><pedal type="stop" line="yes"/></direction-type><staff>2</staff></direction>
      <backup><duration>4</duration></backup>
      <direction placement="below"><direction-type><pedal type="start" line="no"/></direction-type><offset sound="yes">1</offset><staff>2</staff></direction>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration><voice>5</voice><type>half</type><staff>2</staff></note>
      <direction placement="below"><direction-type><pedal type="stop" line="no"/></direction-type><offset>2</offset><staff>2</staff></direction>
    </measure>
  </part>
  <part id="P2">
    <measure number="1">
      <attributes><divisions>1</divisions><time><beats>2</beats><beat-type>4</beat-type></time><clef><sign>percussion</sign></clef></attributes>
      <barline location="left"><bar-style>heavy-light</bar-style><repeat direction="forward"/></barline>
      <note><unpitched><display-step>F</display-step><display-octave>4</display-octave></unpitched><duration>1</duration><instrument id="P2-I36"/><type>quarter</type></note>
      <note><unpitched><display-step>C</display-step><display-octave>5</display-octave></unpitched><duration>1</duration><instrument id="P2-I39"/><type>quarter</type><notehead>x</notehead></note>
    </measure>
    <measure number="2">
      <note><rest/><duration>2</duration><type>half</type></note>
      <barline location="right"><bar-style>light-heavy</bar-style><repeat direction="backward"/></barline>
    </measure>
    <measure number="3">
      <note><rest/><duration>2</duration><type>half</type></note>
    </measure>
  </part>
</score-partwise>
"""


@pytest.fixture(scope="module")
def piano_and_drums(tmp_path_factory: pytest.TempPathFactory) -> dict:
    from backend.modules.sheetimport.parser import parse_score_path

    path: Path = tmp_path_factory.mktemp("sheet") / "pedal.musicxml"
    path.write_text(PIANO_AND_DRUMS, encoding="utf-8")
    return parse_score_path(str(path))


def test_the_repeat_is_played_out(piano_and_drums: dict) -> None:
    # Bars 1-2 twice, then bar 3: the right hand's first C5 at 0 and again at 3840.
    right = piano_and_drums["tracks"][0]
    assert [(n["tick"], n["pitch"]) for n in right["notes"]] == [
        (0, 72),
        (960, 74),
        (BAR, 76),
        (BAR + 960, 77),
        (2 * BAR, 72),
        (2 * BAR + 960, 74),
        (3 * BAR, 76),
        (3 * BAR + 960, 77),
        (4 * BAR, 79),
    ]


def test_the_sustain_pedal_is_controller_64_on_every_pass(
    piano_and_drums: dict,
) -> None:
    right, left = piano_and_drums["tracks"][0], piano_and_drums["tracks"][1]
    change = PPQ // 16  # a 64th note
    expected = [
        # Bar 1: down where the left hand starts.
        (0, 127),
        # Bar 2: the change after E5 lifts it and puts it down a 64th later; the stop at the bar's end.
        (BAR + 960, 0),
        (BAR + 960 + change, 127),
        (2 * BAR, 0),
        # The repeat: bar 1 again puts it down where the stop lifted it, so it goes down a 64th later.
        (2 * BAR + change, 127),
        (3 * BAR + 960, 0),
        (3 * BAR + 960 + change, 127),
        (4 * BAR, 0),
        # Bar 3: the sostenuto pedal and its stop change nothing; the start sounds at its
        # <offset sound="yes"> (an eighth in); the stop's plain <offset> only places it on the page.
        (4 * BAR + 480, 127),
        (5 * BAR, 0),
    ]
    for staff in (right, left):
        assert [(c["tick"], c["value"]) for c in staff["controls"]] == expected
        assert all(c["controller"] == 64 for c in staff["controls"])
    assert piano_and_drums["pedal_marks"] == 3, (
        "start, change and start, counted once for the two staves"
    )


def test_a_part_after_a_pianos_staves_keeps_its_own_kit_keys(
    piano_and_drums: dict,
) -> None:
    drums = next(t for t in piano_and_drums["tracks"] if t["name"] == "Drums")
    assert drums["percussion"] is True
    # The file names bass drum 36 and hand clap 39 (<midi-unpitched> 37 and 40, 1-based), on both passes.
    assert [(n["tick"], n["pitch"]) for n in drums["notes"]] == [
        (0, 36),
        (960, 39),
        (2 * BAR, 36),
        (2 * BAR + 960, 39),
    ]
    assert "controls" not in drums, "the piano's pedal is the piano's"
    assert piano_and_drums["unmapped_unpitched"] == 0


def test_part_sources_follow_the_staves() -> None:
    from backend.modules.sheetimport.parser import _part_sources

    class P:
        def __init__(self, id_: str) -> None:
            self.id = id_

    # music21 names a split part's staves after the part and keeps any other part's own id (here its name).
    parts = [P("P1-Staff1"), P("P1-Staff2"), P("Drums"), P("P3")]
    assert _part_sources(parts, ["P1", "P2", "P3"]) == [0, 0, 1, 2]
    assert _part_sources(
        [P("Flute"), P("P2-Staff1"), P("P2-Staff2")], ["P1", "P2"]
    ) == [0, 1, 1]
    assert _part_sources([P("A"), P("B")], ["P1"]) == [0, None]
    assert _part_sources([P("A")], []) == [None]
