"""Unit tests for the Unity note-chart exporter.

music21 and pretty_midi are declared dependencies, so these run the real export
against synthetic MIDI written into ``tmp_path``, the same way
``tests/test_notation.py`` exercises the MIDI to MusicXML path.

The assertions are shaped around what breaks the consumer rather than what is
easy to check: Unity reads the chart with ``JsonUtility``, which cannot
represent ``null``, and the scene walks one monotonic cursor per part.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterator

import pretty_midi  # type: ignore[import]

from backend.modules.notation.exporters.notechart import (
    DRUM_VOICES,
    SCHEMA,
    SCHEMA_VERSION,
    build_notechart,
    write_notechart,
)

_SCALE = [60, 62, 64, 65, 67, 69, 71, 72]


def _write_scale_midi(path: Path, *, tempo: float = 120.0, shift: float = 0.0) -> None:
    """Write a tiny C-major scale as a Standard MIDI File.

    ``shift`` displaces every onset, which is how a "raw" performance is
    simulated against the quantized engraving.
    """
    pm = pretty_midi.PrettyMIDI(initial_tempo=tempo)
    inst = pretty_midi.Instrument(program=0)
    for i, pitch in enumerate(_SCALE):
        start = i * 0.5 + shift
        inst.notes.append(
            pretty_midi.Note(velocity=100, pitch=pitch, start=start, end=start + 0.5)
        )
    pm.instruments.append(inst)
    path.parent.mkdir(parents=True, exist_ok=True)
    pm.write(str(path))


def _events(chart: dict[str, Any]) -> Iterator[dict[str, Any]]:
    for part in chart["parts"]:
        for event in part["events"]:
            yield event


def _find_null(value: Any, path: str = "$") -> str:
    """Path of the first JSON null, or ``""``. JsonUtility hands Unity a null
    reference for a null string field, which throws on first use."""
    if value is None:
        return path
    if isinstance(value, dict):
        for key, item in value.items():
            found = _find_null(item, f"{path}.{key}")
            if found:
                return found
    elif isinstance(value, list):
        for index, item in enumerate(value):
            found = _find_null(item, f"{path}[{index}]")
            if found:
                return found
    return ""


def test_chart_round_trips_and_is_jsonutility_safe(tmp_path: Path):
    midi_path = tmp_path / "midi" / "scale.mid"
    _write_scale_midi(midi_path)
    output = tmp_path / "notation" / "scale.notechart.json"

    result = write_notechart(
        midi_path,
        output,
        title="Scale",
        artist="GANTASMO",
        entry_id="track",
        audio_duration_sec=4.0,
    )
    assert result["ok"] is True, result
    assert result["schema_version"] == SCHEMA_VERSION

    written = Path(result["path"])
    assert written.is_file()
    chart = json.loads(written.read_text(encoding="utf-8"))

    assert chart["schema"] == SCHEMA
    assert chart["schemaVersion"] == SCHEMA_VERSION
    assert chart["parts"], "a chart with no parts renders nothing"

    # No null anywhere in the document.
    assert _find_null(chart) == ""

    # The tempo map is the only thing that makes beats and seconds agree.
    assert chart["tempoMap"], "tempo map must never be empty"
    assert chart["tempoMap"][0]["timeBeats"] == 0.0

    events = list(_events(chart))
    assert events, "a chart with no events is not a chart"
    for event in events:
        # Both onsets ship on every event: layout uses the quantized value,
        # judging uses the raw one.
        assert "onsetSec" in event and "onsetSecRaw" in event
        assert isinstance(event["onsetSec"], (int, float))
        assert isinstance(event["onsetSecRaw"], (int, float))

    for part in chart["parts"]:
        onsets = [event["onsetSec"] for event in part["events"]]
        assert onsets == sorted(onsets), "events must arrive in time order"
        ticks = [event["onsetTicks"] for event in part["events"]]
        assert ticks == sorted(ticks)


def test_chart_reads_the_actual_tempo(tmp_path: Path):
    """The arrangement route writes 100 BPM, so 120 must never be assumed."""
    midi_path = tmp_path / "midi" / "slow.mid"
    _write_scale_midi(midi_path, tempo=100.0)

    chart = build_notechart(
        midi_path,
        title="Slow Scale",
        artist="GANTASMO",
        entry_id="track",
    )

    assert chart["tempoMap"][0]["bpm"] == 100.0
    assert chart["tempoMap"][0]["secPerBeat"] == 0.6

    # Score time is audio time: the notes were written 0.5 s apart, which at
    # 100 BPM is 5/6 of a quarter, so onsetSec has to come back in seconds and
    # not in beats. That ratio also makes quantize split part of the scale into
    # tied fragments, so the note count is a floor rather than an equality.
    notes = [e for e in _events(chart) if not e["isRest"]]
    assert len(notes) >= len(_SCALE)
    assert notes[0]["onsetSec"] == 0.0
    for event in notes:
        expected = event["onsetBeats"] * 0.6
        assert abs(event["onsetSec"] - expected) < 1e-6


def test_events_carry_engraving_fields(tmp_path: Path):
    midi_path = tmp_path / "midi" / "scale.mid"
    _write_scale_midi(midi_path)

    chart = build_notechart(
        midi_path, title="Scale", artist="GANTASMO", entry_id="track"
    )

    notes = [e for e in _events(chart) if not e["isRest"]]
    first = notes[0]
    # C4 in treble: diatonicNoteNum 29 against Clef.lowestLine 31 is one ledger
    # line below the staff.
    assert first["midi"] == 60
    assert first["step"] == "C"
    assert first["octave"] == 4
    assert first["diatonicNoteNum"] == 29
    assert first["staffStep"] == -2
    assert first["ledgerLines"] == 1
    assert first["ledgerBelow"] is True
    assert first["glyphCodepoint"] > 0
    assert first["noteheadGlyph"] == "noteheadBlack"

    clefs = chart["parts"][0]["clefs"]
    assert clefs and clefs[0]["lowestLineDiatonic"] == 31
    assert clefs[0]["glyph"] == "gClef"

    # Every hit-bearing event has a real length; a zero-length event cannot be
    # struck and cannot be seen.
    for event in notes:
        if event["isGrace"] or event["tie"] in ("continue", "stop"):
            continue
        assert event["durationSec"] > 0

    assert chart["stats"]["noteCount"] == len(_SCALE)
    assert chart["stats"]["partCount"] == len(chart["parts"])
    assert chart["stats"]["measureCount"] == len(chart["measures"])
    assert "meanAbsRawDeviationSec" in chart["stats"]


def test_raw_onsets_come_from_the_unquantized_midi(tmp_path: Path):
    """Without the raw pairing the groove is gone and judging punishes the
    player, so the exporter has to say which of the two it actually has."""
    quantized = tmp_path / "midi" / "grid.mid"
    performed = tmp_path / "midi" / "played.mid"
    _write_scale_midi(quantized)
    _write_scale_midi(performed, shift=0.03)

    chart = build_notechart(
        quantized,
        title="Scale",
        artist="GANTASMO",
        entry_id="track",
        raw_midi_path=performed,
        raw_midi_artifact_id="played__artifact_midi",
    )

    quant = chart["quantization"]
    assert quant["rawIsQuantized"] is False
    assert quant["matchedRawEvents"] == len(_SCALE)
    assert quant["unmatchedRawEvents"] == 0
    assert abs(quant["meanAbsRawDeviationSec"] - 0.03) < 1e-3

    notes = [e for e in _events(chart) if not e["isRest"]]
    assert all(abs(e["onsetSecRaw"] - e["onsetSec"] - 0.03) < 1e-3 for e in notes)
    # Raw beats track raw seconds, so both units stay usable.
    assert all(e["onsetBeatsRaw"] > e["onsetBeats"] for e in notes)


def test_missing_raw_midi_is_reported_not_faked(tmp_path: Path):
    midi_path = tmp_path / "midi" / "scale.mid"
    _write_scale_midi(midi_path)

    chart = build_notechart(
        midi_path, title="Scale", artist="GANTASMO", entry_id="track"
    )

    assert chart["quantization"]["rawIsQuantized"] is True
    assert chart["source"]["rawMidiArtifactId"] == ""
    for event in _events(chart):
        assert event["onsetSecRaw"] == event["onsetSec"]


def test_grace_notes_and_rests_survive_the_walk(tmp_path: Path):
    """Grace notes are quarterLength 0 and rests have no ``.beams`` attribute;
    both used to be able to take the walk down."""
    from music21 import metadata, note, stream  # type: ignore[import]

    part = stream.Part()
    measure = stream.Measure(number=1)
    measure.append(note.Rest(quarterLength=1.0))
    grace = note.Note("D5", quarterLength=0.5).getGrace()
    measure.append(grace)
    measure.append(note.Note("C4", quarterLength=1.0))
    measure.append(note.Note("E4", quarterLength=2.0))
    part.append(measure)
    score = stream.Score()
    score.insert(0, metadata.Metadata())
    score.insert(0, part)

    source = tmp_path / "notation" / "graces.musicxml"
    source.parent.mkdir(parents=True, exist_ok=True)
    score.write("musicxml", fp=str(source))

    chart = build_notechart(source, title="Graces", artist="GANTASMO", entry_id="track")

    assert chart["stats"]["restCount"] >= 1
    assert chart["stats"]["graceCount"] >= 1
    rests = [e for e in _events(chart) if e["isRest"]]
    assert rests[0]["beam"] == ""
    assert rests[0]["glyph"].startswith("rest")
    assert rests[0]["staffStep"] == 4

    graces = [e for e in _events(chart) if e["isGrace"]]
    assert graces, "the grace note was dropped"
    for grace_event in graces:
        assert grace_event["durationSec"] > 0
        assert grace_event["durationSec"] <= 0.08
        assert grace_event["durationTicks"] > 0

    assert _find_null(chart) == ""


def test_empty_source_never_reports_success(tmp_path: Path):
    from music21 import stream  # type: ignore[import]

    source = tmp_path / "notation" / "silence.musicxml"
    source.parent.mkdir(parents=True, exist_ok=True)
    score = stream.Score()
    score.insert(0, stream.Part())
    score.write("musicxml", fp=str(source))

    result = write_notechart(
        source,
        tmp_path / "notation" / "silence.notechart.json",
        title="Silence",
        artist="GANTASMO",
        entry_id="track",
    )
    assert result["ok"] is False
    assert not (tmp_path / "notation" / "silence.notechart.json").exists()


def test_events_carry_beatsaber_fields(tmp_path: Path):
    """The Beat Saber mapping rides on every event as additive ints so the
    ``.dat`` writer and the web highway's blocks skin read the same notes."""
    midi_path = tmp_path / "midi" / "scale.mid"
    _write_scale_midi(midi_path)

    chart = build_notechart(
        midi_path, title="Scale", artist="GANTASMO", entry_id="track"
    )

    assert chart["schemaVersion"] == 1
    assert _find_null(chart) == ""
    assert chart["stats"]["beatSaberCandidates"] > 0

    seen_candidate = False
    for event in _events(chart):
        for key in ("bsLine", "bsLayer", "bsColor", "bsCut", "bsMinDifficulty"):
            assert key in event, key
            assert isinstance(event[key], int) and not isinstance(event[key], bool)
        assert 0 <= event["bsLine"] <= 3
        assert 0 <= event["bsLayer"] <= 2
        assert event["bsColor"] in (0, 1)
        assert 0 <= event["bsCut"] <= 8
        assert -1 <= event["bsMinDifficulty"] <= 4
        if event["isRest"]:
            assert event["bsMinDifficulty"] == -1
        elif event["bsMinDifficulty"] >= 0:
            seen_candidate = True
        # Pitched material never carries a drum voice.
        assert event["drumVoice"] == ""
    assert seen_candidate


def _write_kit_midi(path: Path) -> None:
    """Kick on every beat, snare on 2 and 4, closed hat on every beat, one open
    hat: a General MIDI drum track flagged ``is_drum``."""
    pm = pretty_midi.PrettyMIDI(initial_tempo=120.0)
    kit = pretty_midi.Instrument(program=0, is_drum=True, name="Drums")
    for i in range(8):
        start = i * 0.5
        pitch = 36 if i % 2 == 0 else 38
        kit.notes.append(
            pretty_midi.Note(velocity=100, pitch=pitch, start=start, end=start + 0.1)
        )
        kit.notes.append(
            pretty_midi.Note(velocity=90, pitch=42, start=start, end=start + 0.1)
        )
    kit.notes.append(pretty_midi.Note(velocity=90, pitch=46, start=4.0, end=4.1))
    pm.instruments.append(kit)
    path.parent.mkdir(parents=True, exist_ok=True)
    pm.write(str(path))


def _assert_percussion_chart(chart: dict[str, Any]) -> None:
    assert _find_null(chart) == ""
    assert len(chart["parts"]) == 1
    part = chart["parts"][0]
    assert part["isPercussion"] is True
    assert part["clefs"][0]["sign"] == "percussion"
    assert part["clefs"][0]["glyph"] == "unpitchedPercussionClef1"

    notes = [e for e in part["events"] if not e["isRest"]]
    assert len(notes) == 17
    voices = {e["drumVoice"] for e in notes}
    assert voices == {"kick", "snare", "hihat"}
    assert all(e["drumVoice"] in DRUM_VOICES for e in notes)
    for event in part["events"]:
        if event["isRest"]:
            assert event["drumVoice"] == ""

    kicks = [e for e in notes if e["drumVoice"] == "kick"]
    snares = [e for e in notes if e["drumVoice"] == "snare"]
    hats = [e for e in notes if e["drumVoice"] == "hihat"]
    assert len(kicks) == 4 and len(snares) == 4 and len(hats) == 9

    # midi carries the GM kit pitch recovered from the staff position + head.
    assert {e["midi"] for e in kicks} == {36}
    assert {e["midi"] for e in snares} == {38}
    assert {e["midi"] for e in hats} == {42, 46}
    # Kick F4 (first space) and snare C5 (third space) on a treble-positioned
    # percussion staff: staffStep 1 and 5.
    assert {e["staffStep"] for e in kicks} == {1}
    assert {e["staffStep"] for e in snares} == {5}
    assert {e["step"] for e in kicks} == {"F"} and {e["octave"] for e in kicks} == {4}

    # Heads: kick/snare keep the duration head, hats are x / circle-x.
    assert {e["noteheadGlyph"] for e in kicks + snares} == {"noteheadBlack"}
    closed = [e for e in hats if e["midi"] == 42]
    opened = [e for e in hats if e["midi"] == 46]
    assert {e["noteheadGlyph"] for e in closed} == {"noteheadXBlack"}
    assert {e["noteheadCodepoint"] for e in closed} == {0xE0A9}
    assert len(opened) == 1
    assert opened[0]["noteheadGlyph"] == "noteheadCircleX"
    assert opened[0]["noteheadCodepoint"] == 0xE0B3
    # x heads have no composite note glyph, so the bare head is the glyph.
    assert {e["glyph"] for e in closed} == {"noteheadXBlack"}
    # Unpitched heads never show an accidental.
    assert all(e["accidental"] == "" and e["accidentalGlyph"] == "" for e in notes)

    # Drums are never Beat Saber blocks (the drums skin owns them).
    assert {e["bsMinDifficulty"] for e in part["events"]} == {-1}
    assert chart["stats"]["beatSaberCandidates"] == 0
    assert chart["stats"]["percussionPartCount"] == 1
    assert chart["stats"]["drumHitCount"] == 17
    assert chart["stats"]["noteCount"] == 17

    # Simultaneous hits are chord members of one PercussionChord.
    assert chart["stats"]["chordCount"] >= 8
    onsets = [e["onsetSec"] for e in part["events"]]
    assert onsets == sorted(onsets)


def test_percussion_part_from_engraved_drum_staff(tmp_path: Path):
    """A MusicXML percussion staff (PercussionClef + <unpitched> + <notehead>)
    charts as a percussion part with drum voices and real head glyphs."""
    from backend.modules.notation.arrangers.percussion import build_percussion_score

    midi_path = tmp_path / "midi" / "drums.mid"
    _write_kit_midi(midi_path)
    source = tmp_path / "notation" / "drums.musicxml"
    source.parent.mkdir(parents=True, exist_ok=True)
    build_percussion_score(midi_path, title="Drums").write("musicxml", fp=str(source))

    chart = build_notechart(source, title="Drums", artist="GANTASMO", entry_id="track")
    _assert_percussion_chart(chart)
    assert chart["source"]["sourceFormat"] == "musicxml"


def test_percussion_part_from_drum_midi_matches_the_sheet(tmp_path: Path):
    """A kit MIDI charts through the percussion arranger, so the chart is the
    staff MAKE SHEET engraves rather than a pitched F2/F#3 reading of channel
    10. Raw pairing still lands on the kit pitches."""
    midi_path = tmp_path / "midi" / "drums.mid"
    _write_kit_midi(midi_path)

    chart = build_notechart(
        midi_path,
        title="Drums",
        artist="GANTASMO",
        entry_id="track",
        raw_midi_path=midi_path,
        raw_midi_artifact_id="drums_mid",
    )
    _assert_percussion_chart(chart)
    assert chart["source"]["sourceFormat"] == "midi"
    assert chart["quantization"]["matchedRawEvents"] == 17
    assert chart["quantization"]["unmatchedRawEvents"] == 0
