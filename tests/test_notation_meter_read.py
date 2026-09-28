"""Meter-true MIDI reading, the per-bar grid, and the orchestra's percussion.

theDAW's roll writes each bar's grouping and its pickup as text events beside
the time signatures (frontend/src/lib/midi.ts ``meterEventMetas``). These
files are written here the same way, with mido, and read back through the
notation module. No model, no GPU.
"""

from __future__ import annotations

from pathlib import Path
from typing import Iterable, Optional

import mido
import pytest
from music21 import clef, layout, meter, stream

from backend.modules.notation.arrangers.percussion import (
    ORCHESTRAL_PERCUSSION,
    PITCHED_PERCUSSION,
    build_percussion_part,
    build_percussion_score,
)
from backend.modules.notation.bar_lines import spec_of, time_signature
from backend.modules.notation.grid import best_divisor, is_exact, quantize_score
from backend.modules.notation.midi_read import read_midi, read_midi_meters

PPQ = 480

# One signature: (tick, numerator, denominator, groups or None).
Signature = tuple[int, int, int, Optional[list[int]]]
# One note: (tick, pitch, length in ticks).
Note = tuple[int, int, int]


def _track(
    name: str,
    notes: Iterable[Note] = (),
    *,
    channel: int = 0,
    program: Optional[int] = None,
    signatures: Iterable[Signature] = (),
    pickup_steps: Optional[float] = None,
    texts: bool = True,
) -> mido.MidiTrack:
    """A track as theDAW writes it: its name, every signature followed by its
    ``theDAW:groups=`` text and (tick 0) its ``theDAW:pickup=`` text, then the
    notes."""
    events: list[tuple[int, int, mido.Message | mido.MetaMessage]] = []
    for tick, num, den, groups in signatures:
        events.append(
            (
                tick,
                0,
                mido.MetaMessage("time_signature", numerator=num, denominator=den),
            )
        )
        if texts and groups:
            events.append(
                (
                    tick,
                    1,
                    mido.MetaMessage(
                        "text", text="theDAW:groups=" + "+".join(map(str, groups))
                    ),
                )
            )
        if texts and tick == 0 and pickup_steps is not None:
            text = f"theDAW:pickup={pickup_steps:g}"
            events.append((tick, 2, mido.MetaMessage("text", text=text)))
    if program is not None:
        events.append(
            (0, 3, mido.Message("program_change", program=program, channel=channel))
        )
    for start, pitch, length in notes:
        on = mido.Message("note_on", note=pitch, velocity=90, channel=channel)
        off = mido.Message("note_off", note=pitch, velocity=0, channel=channel)
        events.append((start, 5, on))
        events.append((start + length, 4, off))
    events.sort(key=lambda e: (e[0], e[1]))
    track = mido.MidiTrack()
    track.append(mido.MetaMessage("track_name", name=name, time=0))
    last = 0
    for tick, _rank, message in events:
        message.time = tick - last
        last = tick
        track.append(message)
    track.append(mido.MetaMessage("end_of_track", time=0))
    return track


def _write(path: Path, *tracks: mido.MidiTrack) -> Path:
    midi = mido.MidiFile(type=1, ticks_per_beat=PPQ)
    for track in tracks:
        midi.tracks.append(track)
    path.parent.mkdir(parents=True, exist_ok=True)
    midi.save(str(path))
    return path


def _conductor(
    signatures: Iterable[Signature], *, pickup_steps: Optional[float] = 0
) -> mido.MidiTrack:
    track = _track("Tempo", signatures=signatures, pickup_steps=pickup_steps)
    track.insert(1, mido.MetaMessage("set_tempo", tempo=500_000, time=0))
    return track


def _measures(part) -> list:
    return list(part.getElementsByClass(stream.Measure))


def _groups(ts) -> list[int]:
    return [int(p.numerator) for p in ts.beamSequence]


def _accent_groups(ts) -> list[int]:
    return [int(p.numerator) for p in ts.accentSequence]


# --------------------------------------------------------------------------
# A. meter-true reading
# --------------------------------------------------------------------------


@pytest.mark.parametrize("groups", [[2, 2, 3], [3, 2, 2]])
def test_seven_eight_with_groups_and_a_pickup_reads_back_as_written(
    tmp_path: Path, groups: list[int]
) -> None:
    """A roll in 7/8 grouped ``groups`` with a one-quarter pickup: a short 1/4
    at tick 0 carrying ``theDAW:pickup=4``, the 7/8 where bar 1 starts. It
    reads as a pickup bar of 7/8 padded by the 2.5 quarters the pickup does
    not fill, bar 0, then 7/8 bars beamed and accented by ``groups``."""
    pickup_ticks = PPQ  # four 16th steps
    notes = [(0, 72, PPQ)] + [
        (pickup_ticks + i * 240, 60 + i % 5, 240) for i in range(14)
    ]
    path = _write(
        tmp_path / "roll.mid",
        _conductor([(0, 1, 4, None), (pickup_ticks, 7, 8, groups)], pickup_steps=4),
        _track("Piano", notes),
    )

    meters = read_midi_meters(path)
    assert meters is not None and meters.roll and meters.pickup_holds()

    score = read_midi(path, cache=False)
    part = score.parts[0]
    measures = _measures(part)
    assert len(measures) == 3
    pickup = measures[0]
    assert pickup.number == 0
    assert float(pickup.paddingLeft) == pytest.approx(2.5)
    ts = pickup.timeSignature
    assert ts is not None and ts.ratioString == "7/8"
    assert _groups(ts) == groups
    assert _accent_groups(ts) == groups
    assert ts.beatCount == 3
    # The pickup holds the one quarter note; bar 1 starts with the eighths.
    assert [(float(n.offset), n.nameWithOctave) for n in pickup.notes] == [(0.0, "C5")]
    assert measures[1].number == 1
    assert float(measures[1].offset) == pytest.approx(1.0)
    assert [float(n.offset) for n in measures[1].notes][:3] == [0.0, 0.5, 1.0]
    # No 1/4 bar survives: every signature in the part is the grouped 7/8.
    specs = {spec_of(t) for t in part.recurse().getElementsByClass(meter.TimeSignature)}
    assert specs == {f"7/8 {'+'.join(map(str, groups))}"}
    assert is_exact(score)


def test_roll_midi_is_read_at_its_exact_ticks(tmp_path: Path) -> None:
    """A roll's note a fifth of a quarter in stays a fifth of a quarter in:
    the file is parsed with ``quantizePost=False`` and the grid leaves it."""
    path = _write(
        tmp_path / "fifths.mid",
        _conductor([(0, 4, 4, None)]),
        _track("Lead", [(0, 60, 96), (96, 62, 96), (192, 64, 96)]),
    )
    score = read_midi(path, cache=False)
    assert is_exact(score)
    onsets = [float(n.offset) for n in score.parts[0].notes]
    assert onsets == pytest.approx([0.0, 0.2, 0.4])
    assert quantize_score(score) is score


def test_a_file_without_theDAW_texts_is_not_exact(tmp_path: Path) -> None:
    path = _write(
        tmp_path / "plain.mid",
        _track("Tempo", signatures=[(0, 4, 4, None)], texts=False),
        _track("Lead", [(0, 60, 480)]),
    )
    meters = read_midi_meters(path)
    assert meters is not None and not meters.roll
    assert not is_exact(read_midi(path, cache=False))


def test_signatures_on_a_later_track_are_read(tmp_path: Path) -> None:
    """A file whose signatures sit on a note track, not the first track,
    still states them."""
    path = _write(
        tmp_path / "late.mid",
        _track("Lead", [(0, 60, 480)], signatures=[(0, 5, 4, [3, 2])], texts=True),
    )
    meters = read_midi_meters(path)
    assert meters is not None
    assert [(m.tick, m.num, m.den, m.groups) for m in meters.marks] == [
        (0, 5, 4, (3, 2))
    ]
    ts = (
        read_midi(path, cache=False).parts[0].getElementsByClass(meter.TimeSignature)[0]
    )
    assert ts.ratioString == "5/4" and _groups(ts) == [3, 2]


def test_time_signature_spec_round_trips() -> None:
    ts = time_signature("7/8 3+2+2")
    assert ts.ratioString == "7/8"
    assert spec_of(ts) == "7/8 3+2+2"
    assert spec_of(time_signature("4/4")) == "4/4"


# --------------------------------------------------------------------------
# A. the per-bar divisor
# --------------------------------------------------------------------------


def _points(onsets: Iterable[float], length: float) -> list[float]:
    out: list[float] = []
    for onset in onsets:
        out += [onset, onset + length]
    return out


def test_best_divisor_picks_three_for_triplets() -> None:
    triplets = [i / 3 for i in range(12)]
    assert best_divisor(_points(triplets, 1 / 3)) == 3


def test_best_divisor_picks_five_for_quintuplets() -> None:
    quintuplets = [i / 5 for i in range(20)]
    assert best_divisor(_points(quintuplets, 1 / 5)) == 5


def test_best_divisor_keeps_sixteenths_on_four() -> None:
    sixteenths = [i / 4 for i in range(16)]
    assert best_divisor(_points(sixteenths, 1 / 4)) == 4


def _flat_score(onsets: list[float], length: float, ratio: str = "4/4"):
    from music21 import note

    part = stream.Part()
    part.insert(0, time_signature(ratio))
    for i, onset in enumerate(onsets):
        head = note.Note(60 + i % 7)
        head.duration.quarterLength = length
        part.insert(onset, head)
    score = stream.Score()
    score.insert(0, part)
    return score


def test_quantize_score_puts_a_triplet_bar_on_thirds() -> None:
    """Triplet eighths played a little early or late land on thirds of a
    quarter, and a duple bar after them stays on sixteenths."""
    jitter = [0.02, -0.015, 0.01, -0.02, 0.015, -0.01]
    triplets = [i / 3 + jitter[i % 6] for i in range(12)]
    duple = [4.0 + i * 0.25 + (0.01 if i % 2 else -0.01) for i in range(16)]
    score = _flat_score(triplets + duple, 0.2)
    out = quantize_score(score)
    onsets = [float(n.offset) for n in out.parts[0].notes]
    assert onsets[:12] == pytest.approx([i / 3 for i in range(12)])
    assert onsets[12:] == pytest.approx([4.0 + i * 0.25 for i in range(16)])


def test_quantize_score_puts_quintuplets_on_fifths() -> None:
    fives = [i / 5 + (0.012 if i % 2 else -0.012) for i in range(20)]
    out = quantize_score(_flat_score(fives, 0.2))
    assert [float(n.offset) for n in out.parts[0].notes] == pytest.approx(
        [i / 5 for i in range(20)]
    )


def test_quantize_score_leaves_an_exact_score_alone(tmp_path: Path) -> None:
    """A roll's notes (exact, off any grid the divisors know) come back as
    they went in."""
    notes = [(0, 60, 137), (137, 62, 211), (348, 64, 100)]
    path = _write(
        tmp_path / "roll.mid", _conductor([(0, 4, 4, None)]), _track("Lead", notes)
    )
    score = read_midi(path, cache=False)
    before = [(float(n.offset), float(n.quarterLength)) for n in score.parts[0].notes]
    after = quantize_score(score)
    assert [
        (float(n.offset), float(n.quarterLength)) for n in after.parts[0].notes
    ] == before


# --------------------------------------------------------------------------
# A. the drum staff carries every time signature
# --------------------------------------------------------------------------


def _mixed_meter_drums(tmp_path: Path, *, signatures_on_drum_track: bool) -> Path:
    # 4/4 (one bar), 7/8 3+2+2 (two bars), 5/4 3+2 (one bar), 3/4 (one bar).
    signatures: list[Signature] = [
        (0, 4, 4, None),
        (4 * PPQ, 7, 8, [3, 2, 2]),
        (11 * PPQ, 5, 4, [3, 2]),
        (16 * PPQ, 3, 4, None),
    ]
    hits = [(i * PPQ // 2, 42, 120) for i in range(38)] + [
        (i * PPQ, 36, 120) for i in range(19)
    ]
    if signatures_on_drum_track:
        # The first track states no meter; pretty_midi reads only that one.
        return _write(
            tmp_path / "drums_late.mid",
            _track("Tempo"),
            _track("Kit", hits, channel=9, signatures=signatures, pickup_steps=0),
        )
    return _write(
        tmp_path / "drums.mid",
        _conductor(signatures),
        _track("Kit", hits, channel=9),
    )


@pytest.mark.parametrize("signatures_on_drum_track", [False, True])
def test_drum_staff_carries_every_time_signature(
    tmp_path: Path, signatures_on_drum_track: bool
) -> None:
    path = _mixed_meter_drums(
        tmp_path, signatures_on_drum_track=signatures_on_drum_track
    )
    part = build_percussion_part(path)
    stated = [
        (float(m.offset), spec_of(m.timeSignature))
        for m in _measures(part)
        if m.timeSignature is not None
    ]
    assert stated == [
        (0.0, "4/4"),
        (4.0, "7/8 3+2+2"),
        (11.0, "5/4 3+2"),
        (16.0, "3/4"),
    ]


def test_drum_staff_opens_on_the_pickup(tmp_path: Path) -> None:
    path = _write(
        tmp_path / "pickup_drums.mid",
        _conductor([(0, 1, 4, None), (PPQ, 4, 4, None)], pickup_steps=4),
        _track("Kit", [(0, 38, 240), (PPQ, 36, 240), (2 * PPQ, 38, 240)], channel=9),
    )
    part = build_percussion_part(path)
    first = _measures(part)[0]
    assert first.number == 0
    assert float(first.paddingLeft) == pytest.approx(3.0)
    assert first.timeSignature.ratioString == "4/4"


# --------------------------------------------------------------------------
# B. orchestral percussion
# --------------------------------------------------------------------------


def test_each_orchestral_percussion_voice_gets_its_own_named_staff(
    tmp_path: Path,
) -> None:
    """Four instruments GM has no unique pitch for arrive on tracks named for
    them; triangle, tambourine and wood block arrive by their GM pitch on the
    kit track, beside a kick that stays on the kit staff."""
    by_track = [
        _track(name, [(0, pitch, 240), (PPQ, pitch, 240)], channel=9)
        for name, pitch in (
            ("Bass Drum", 35),
            ("Suspended Cymbal", 49),
            ("Clash Cymbals", 49),
            ("Tam-tam", 52),
        )
    ]
    kit = _track(
        "Kit",
        [
            (0, 36, 240),
            (0, 81, 240),
            (PPQ, 54, 240),
            (2 * PPQ, 76, 240),
            (2 * PPQ, 36, 240),
        ],
        channel=9,
    )
    path = _write(
        tmp_path / "orchestra_perc.mid", _conductor([(0, 4, 4, None)]), *by_track, kit
    )

    score = build_percussion_score(path, title="Percussion", orchestral=True)
    parts = {part.partName: part for part in score.parts}
    for voice in ORCHESTRAL_PERCUSSION.values():
        assert voice.name in parts, (voice.name, list(parts))
        part = parts[voice.name]
        assert part.partAbbreviation == voice.short
        held = part.recurse().getElementsByClass("Instrument").first()
        assert held.instrumentName == voice.name
        assert held.instrumentAbbreviation == voice.short
        lines = part.recurse().getElementsByClass(layout.StaffLayout).first()
        assert lines is not None and lines.staffLines == 1
        assert (
            part.recurse().getElementsByClass(clef.PercussionClef).first() is not None
        )
        assert len(part.recurse().notes) >= 1
    # The kick is left on the kit staff, alone.
    kit_part = parts["Drums"]
    kit_heads = {
        (u.displayStep, u.displayOctave)
        for element in kit_part.recurse().notes
        for u in (element.notes if hasattr(element, "notes") else [element])
    }
    assert kit_heads == {("F", 4)}
    assert len(score.parts) == len(ORCHESTRAL_PERCUSSION) + 1


def test_a_plain_drum_score_keeps_one_kit_staff(tmp_path: Path) -> None:
    path = _write(
        tmp_path / "kit.mid",
        _conductor([(0, 4, 4, None)]),
        _track("Kit", [(0, 36, 240), (0, 81, 240)], channel=9),
    )
    score = build_percussion_score(path, title="Drums")
    assert [p.partName for p in score.parts] == ["Drums"]


def test_timpani_and_mallets_engrave_as_pitched_parts(tmp_path: Path) -> None:
    tracks = [
        _track(
            voice.name,
            [(0, (voice.low + voice.high) // 2, PPQ)],
            channel=i,
            program=voice.program,
        )
        for i, voice in enumerate(PITCHED_PERCUSSION.values())
    ]
    path = _write(tmp_path / "mallets.mid", _conductor([(0, 4, 4, None)]), *tracks)
    score = read_midi(path, cache=False)
    by_program = {}
    for part in score.parts:
        held = part.getElementsByClass("Instrument").first()
        by_program[held.midiProgram] = (part, held)
    for voice in PITCHED_PERCUSSION.values():
        part, held = by_program[voice.program]
        assert held.instrumentName == voice.name
        assert held.instrumentAbbreviation == voice.short
        # Pitched: real notes, not unpitched heads.
        assert all(n.isNote for n in part.notes)
        octaves = (
            0 if held.transposition is None else held.transposition.semitones // 12
        )
        assert octaves == voice.octaves_up
        first_clef = part.getElementsByClass(clef.Clef).first()
        if voice.clef == "bass":
            assert isinstance(first_clef, clef.BassClef)
        elif voice.clef == "treble":
            assert isinstance(first_clef, clef.TrebleClef)
