"""A sheet played: a MusicXML score rendered as an expressive MIDI performance.

The score is read with partitura and handed to its performance codec
(``partitura.musicanalysis.performance_codec.decode_performance``) as one row
of expressive parameters per note:

  - ``beat_period`` (seconds per beat) follows the sheet's tempo and slows
    into every cadence: the final bar, each fermata and each double bar. Over
    the :data:`RIT_WINDOW_BARS` before a cadence the beat stretches by up to
    :data:`RIT_DEPTH` (:data:`FINAL_RIT_DEPTH` into the end), easing in along
    a power curve (:data:`RIT_CURVE`). A fermata holds its note
    :data:`FERMATA_STRETCH` times as long. The downbeat that starts a phrase
    (the first bar, the bar after a cadence, and every :data:`PHRASE_BARS`
    bars after that) leans by :data:`AGOGIC_STRESS`.
  - ``articulation_log`` (log2 of sounding length / notated length) comes from
    each note's marking (:data:`ARTICULATION_RATIO`): staccato short, tenuto
    full, a slurred note joined to the next, anything else slightly detached.
  - ``velocity`` is the printed dynamic level at the note (the same levels and
    hairpins the sheet import reads, :mod:`.expression`), plus
    :data:`ACCENT_VELOCITY` for an accent.
  - ``timing`` is zero: every note of a chord starts together.

The decoded notes are written as a MIDI whose tempo map carries the timing:
every note sits on the sheet's own beat grid (:data:`PPQ` ticks per quarter),
and a ``set_tempo`` event at each onset where the beat changes length plays
it at the performed time. A DAW that reads the file lines its bars up with
the sheet and still plays the ritardandos.
"""

from __future__ import annotations

import bisect
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

import numpy as np

from .expression import (
    ACCENT_VELOCITY_BOOST,
    LEVEL_VELOCITY,
    STRONG_ACCENT_VELOCITY_BOOST,
    Hairpin,
    SheetExpression,
    velocity_for_level,
)

log = logging.getLogger(__name__)

# Ticks per quarter in the written MIDI.
PPQ = 960
# Quarter notes per minute when the sheet prints no tempo and the caller
# gives none.
DEFAULT_QPM = 100.0
# A ritardando starts this many bars before the cadence it leads into ...
RIT_WINDOW_BARS = 1.0
# ... and stretches the beat by up to this fraction at the cadence ...
RIT_DEPTH = 0.25
# ... or this much into the end of the piece ...
FINAL_RIT_DEPTH = 0.6
# ... easing in: the stretch at a point x (0..1) through the window is
# depth * x ** RIT_CURVE.
RIT_CURVE = 2.0
# A note under a fermata lasts this many times its written length.
FERMATA_STRETCH = 1.75
# The downbeat that starts a phrase is held this fraction longer.
AGOGIC_STRESS = 0.08
# A phrase is this many bars when nothing on the sheet ends it sooner.
PHRASE_BARS = 4
# Double bar lines that end a section (MusicXML ``bar-style``).
SECTION_BARLINES = frozenset(
    {"light-light", "light-heavy", "heavy-light", "heavy-heavy"}
)
# Sounding length / notated length for each marking, strongest first.
ARTICULATION_RATIO: dict[str, float] = {
    "staccatissimo": 0.3,
    "spiccato": 0.35,
    "staccato": 0.5,
    "detached-legato": 0.75,
    "tenuto": 1.0,
}
# A note with no marking, and a note under a slur (joined to the next).
DEFAULT_ARTICULATION_RATIO = 0.9
LEGATO_ARTICULATION_RATIO = 1.0
# Velocity each accent adds.
ACCENT_VELOCITY: dict[str, int] = {
    "accent": ACCENT_VELOCITY_BOOST,
    "strong-accent": STRONG_ACCENT_VELOCITY_BOOST,
    "soft-accent": ACCENT_VELOCITY_BOOST // 2,
    "stress": ACCENT_VELOCITY_BOOST // 2,
}
# MIDI channels for the parts, in order (channel 10, index 9, is drums).
_CHANNELS = tuple(c for c in range(16) if c != 9)
_EPS = 1e-6


class PerformError(ValueError):
    """The sheet cannot be performed (unreadable, or no notes)."""


@dataclass
class _Plan:
    """What the sheet says about time, in quarters."""

    end: float
    bars: list[tuple[float, float]]
    tempi: list[tuple[float, float]]  # (quarter, qpm)
    cadences: list[tuple[float, bool]]  # (quarter, is the end)
    note_fermatas: set[float]  # onsets of notes under a fermata
    bar_fermatas: set[float]  # bar lines carrying a fermata
    phrase_starts: set[float]


def partitura_version() -> str:
    try:
        from importlib.metadata import version

        return version("partitura")
    except Exception:  # partitura missing: the route reports it
        return "unknown"


def perform_musicxml(
    source: Path, output: Path, *, qpm: Optional[float] = None
) -> dict[str, Any]:
    """Perform the MusicXML at ``source`` and write the MIDI to ``output``.

    ``qpm`` is the tempo (quarters per minute) when the sheet prints none.
    Returns a summary: ``notes``, ``tempo_events``, ``seconds``, ``qpm`` and
    ``parts``. Raises :class:`PerformError` for a sheet with nothing to play.
    """
    import partitura as pt
    from partitura.musicanalysis.performance_codec import decode_performance

    try:
        score = pt.load_musicxml(str(source), force_note_ids=True, quiet=True)
    except Exception as exc:
        raise PerformError(
            f"partitura could not read {Path(source).name}: {exc}"
        ) from exc
    parts = list(score.parts)
    notes = score.note_array() if parts else None
    if notes is None or len(notes) == 0:
        raise PerformError(f"{Path(source).name} has no notes to perform")

    lookup = _note_lookup(parts)
    plan = _plan(parts, notes, qpm)
    base_qpm = plan.tempi[0][1]

    onsets_q = notes["onset_quarter"].astype(float)
    unique_q = sorted({round(float(q), 6) for q in onsets_q})
    seconds_per_quarter = _seconds_per_quarter(plan, unique_q)

    legato_ids = _slurred_note_ids(parts)
    dynamics = [_dynamics(part) for part in parts]
    last_onset = unique_q[-1]

    params = np.zeros(
        len(notes),
        dtype=[
            ("beat_period", "f4"),
            ("velocity", "f4"),
            ("timing", "f4"),
            ("articulation_log", "f4"),
        ],
    )
    for row, note_row in enumerate(notes):
        onset = round(float(note_row["onset_quarter"]), 6)
        part_index, note = lookup[str(note_row["id"])]
        quarters_per_beat = (
            float(note_row["duration_quarter"]) / float(note_row["duration_beat"])
            if float(note_row["duration_beat"]) > _EPS
            else 1.0
        )
        params[row]["beat_period"] = seconds_per_quarter[onset] * quarters_per_beat
        velocity = dynamics[part_index].level_at(onset)
        velocity += max(
            (ACCENT_VELOCITY.get(a, 0) for a in (note.articulations or [])), default=0
        )
        params[row]["velocity"] = max(1.0, min(127.0, velocity)) / 127.0
        ratio = _articulation_ratio(note, str(note_row["id"]) in legato_ids)
        if abs(onset - last_onset) < _EPS:
            ratio = max(ratio, LEGATO_ARTICULATION_RATIO)
        params[row]["articulation_log"] = float(np.log2(ratio))

    order = np.lexsort((notes["pitch"], notes["onset_div"]))
    performed = decode_performance(
        score, params, snote_ids=[str(i) for i in notes["id"][order]]
    )

    # Where each onset was played; decode starts the first note at 0 s, so a
    # sheet that opens on a rest is moved later by the rest.
    lead = unique_q[0] * 60.0 / base_qpm
    played_at: dict[float, float] = {}
    events: list[tuple[int, float, float, int, int]] = []  # part, on, off, pitch, vel
    for pnote in performed.notes:
        part_index, _note = lookup[str(pnote["id"])]
        onset_q = round(float(_onset_quarter(notes, str(pnote["id"]))), 6)
        on = float(pnote["note_on"]) + lead
        off = float(pnote["note_off"]) + lead
        played_at.setdefault(onset_q, on)
        events.append(
            (part_index, on, off, int(pnote["midi_pitch"]), int(pnote["velocity"]))
        )

    anchors = [(0.0, 0.0)] if unique_q[0] > _EPS else []
    anchors += [(q, played_at[q]) for q in unique_q]
    end_q = max(plan.end, unique_q[-1] + _EPS)
    anchors.append(
        (
            end_q,
            anchors[-1][1] + (end_q - unique_q[-1]) * seconds_per_quarter[last_onset],
        )
    )
    tempo_map = _tempo_map(anchors)
    _write_midi(output, parts, plan, tempo_map, anchors, events)
    return {
        "ok": True,
        "path": str(output),
        "notes": len(events),
        "tempo_events": len(tempo_map),
        "seconds": round(anchors[-1][1], 3),
        "qpm": round(base_qpm, 3),
        "parts": [
            str(p.part_name or p.id or f"Part {i + 1}") for i, p in enumerate(parts)
        ],
    }


def _note_lookup(parts: list[Any]) -> dict[str, tuple[int, Any]]:
    """Note array id -> (part index, partitura note). A score of more than one
    part prefixes each id with ``P<index>_`` (``note_array_from_part_list``)."""
    lookup: dict[str, tuple[int, Any]] = {}
    for index, part in enumerate(parts):
        for note in part.notes_tied:
            key = f"P{index:02d}_{note.id}" if len(parts) > 1 else str(note.id)
            lookup[key] = (index, note)
    return lookup


def _onset_quarter(notes: Any, note_id: str) -> float:
    return float(notes["onset_quarter"][notes["id"] == note_id][0])


def _plan(parts: list[Any], notes: Any, qpm: Optional[float]) -> _Plan:
    import partitura as pt

    first = parts[0]
    quarter = first.quarter_map
    bars = [
        (float(quarter(m.start.t)), float(quarter(m.end.t)))
        for m in first.iter_all(pt.score.Measure)
    ]
    end = float(np.max(notes["onset_quarter"] + notes["duration_quarter"]))
    if not bars:
        bars = [(0.0, end)]

    tempi: list[tuple[float, float]] = []
    for tempo in first.iter_all(pt.score.Tempo):
        tempi.append(
            (float(quarter(tempo.start.t)), 60e6 / tempo.microseconds_per_quarter)
        )
    tempi.sort()
    if not tempi or tempi[0][0] > _EPS:
        tempi.insert(0, (0.0, float(qpm) if qpm and qpm > 0 else DEFAULT_QPM))

    cadences: dict[float, bool] = {round(end, 6): True}
    note_fermatas: set[float] = set()
    bar_fermatas: set[float] = set()
    for part in parts:
        to_q = part.quarter_map
        for fermata in part.iter_all(pt.score.Fermata):
            at = float(to_q(fermata.start.t))
            ref = fermata.ref
            if ref is not None and hasattr(ref, "start") and hasattr(ref, "duration"):
                # A fermata on a note: the cadence is where the note ends.
                note_fermatas.add(round(at, 6))
                at = float(to_q(ref.start.t + ref.duration_tied))
            else:
                # A fermata on a bar line holds the notes that end there.
                bar_fermatas.add(round(at, 6))
            cadences.setdefault(round(at, 6), False)
        for barline in part.iter_all(pt.score.Barline):
            if str(barline.style) in SECTION_BARLINES:
                cadences.setdefault(round(float(to_q(barline.start.t)), 6), False)

    ordered = sorted(cadences.items())
    phrase_starts: set[float] = set()
    bar_starts = [b[0] for b in bars]
    anchor_bar = 0
    boundaries = [q for q, _final in ordered]
    for index, start in enumerate(bar_starts):
        after_cadence = any(abs(start - q) < _EPS for q in boundaries)
        if index == 0 or after_cadence or index - anchor_bar >= PHRASE_BARS:
            phrase_starts.add(round(start, 6))
            anchor_bar = index
    return _Plan(
        end=end,
        bars=bars,
        tempi=tempi,
        cadences=ordered,
        note_fermatas=note_fermatas,
        bar_fermatas=bar_fermatas,
        phrase_starts=phrase_starts,
    )


def _bar_length_at(plan: _Plan, at: float) -> float:
    for start, end in plan.bars:
        if start - _EPS <= at < end + _EPS and end - start > _EPS:
            return end - start
    return 4.0


def _seconds_per_quarter(plan: _Plan, unique_q: list[float]) -> dict[float, float]:
    """Seconds per quarter from each onset to the next, with the ritardandos,
    fermatas and phrase leans applied."""
    tempo_at = [q for q, _qpm in plan.tempi]
    out: dict[float, float] = {}
    for i, q in enumerate(unique_q):
        nxt = unique_q[i + 1] if i + 1 < len(unique_q) else max(plan.end, q + _EPS)
        mid = (q + nxt) / 2.0
        qpm = plan.tempi[max(0, bisect.bisect_right(tempo_at, q + _EPS) - 1)][1]
        stretch = 1.0
        for cadence, final in plan.cadences:
            window = RIT_WINDOW_BARS * _bar_length_at(plan, cadence - _EPS)
            start = cadence - window
            if start - _EPS <= mid <= cadence + _EPS and window > _EPS:
                x = min(1.0, max(0.0, (mid - start) / window))
                depth = FINAL_RIT_DEPTH if final else RIT_DEPTH
                stretch = max(stretch, 1.0 + depth * x**RIT_CURVE)
        if q in plan.note_fermatas or any(
            q + _EPS < f <= nxt + _EPS for f in plan.bar_fermatas
        ):
            stretch *= FERMATA_STRETCH
        if q in plan.phrase_starts:
            stretch *= 1.0 + AGOGIC_STRESS
        out[q] = 60.0 / qpm * stretch
    return out


def _slurred_note_ids(parts: list[Any]) -> set[str]:
    """Note-array ids of every note a slur joins to the next (all but the
    slur's last note), in the slur's part and voice."""
    import partitura as pt

    ids: set[str] = set()
    for index, part in enumerate(parts):
        prefix = f"P{index:02d}_" if len(parts) > 1 else ""
        for slur in part.iter_all(pt.score.Slur):
            first, last = slur.start_note, slur.end_note
            if first is None or last is None:
                continue
            for note in part.notes_tied:
                if (
                    first.start.t <= note.start.t < last.start.t
                    and note.voice == first.voice
                ):
                    ids.add(f"{prefix}{note.id}")
    return ids


def _articulation_ratio(note: Any, slurred: bool) -> float:
    marks = set(note.articulations or [])
    for name, ratio in ARTICULATION_RATIO.items():
        if name in marks:
            return ratio
    return LEGATO_ARTICULATION_RATIO if slurred else DEFAULT_ARTICULATION_RATIO


def _dynamics(part: Any) -> SheetExpression:
    """A part's printed levels and hairpins as a :class:`.SheetExpression`."""
    import partitura as pt

    to_q = part.quarter_map
    expression = SheetExpression()
    for direction in part.iter_all(
        pt.score.ConstantLoudnessDirection, include_subclasses=True
    ):
        velocity = velocity_for_level(str(direction.text or ""))
        if velocity is not None:
            expression.marks.append((float(to_q(direction.start.t)), float(velocity)))
    expression.marks.sort(key=lambda m: m[0])
    for direction in part.iter_all(
        pt.score.DynamicLoudnessDirection, include_subclasses=True
    ):
        if direction.end is None:
            continue
        start = float(to_q(direction.start.t))
        end = float(to_q(direction.end.t))
        increasing = isinstance(direction, pt.score.IncreasingLoudnessDirection)
        decreasing = isinstance(direction, pt.score.DecreasingLoudnessDirection)
        if not (increasing or decreasing):
            continue
        target = next(
            (v for at, v in expression.marks if end - _EPS <= at <= end + 4.0), None
        )
        expression.wedges.append(Hairpin(start, end, 1 if increasing else -1, target))
    expression.wedges.sort(key=lambda w: w.start)
    if not expression.marks and not expression.wedges:
        expression.marks.append((0.0, float(LEVEL_VELOCITY["mf"])))
    return expression


def _tempo_map(anchors: list[tuple[float, float]]) -> list[tuple[int, int]]:
    """``(tick, microseconds per quarter)`` at each anchor where the beat
    changes length; equal neighbours are merged."""
    tempo: list[tuple[int, int]] = []
    for (q0, t0), (q1, t1) in zip(anchors, anchors[1:]):
        if q1 - q0 <= _EPS:
            continue
        mpq = int(round((t1 - t0) / (q1 - q0) * 1e6))
        mpq = max(1, min(0xFFFFFF, mpq))
        tick = int(round(q0 * PPQ))
        if tempo and tempo[-1][1] == mpq:
            continue
        if tempo and tempo[-1][0] == tick:
            tempo[-1] = (tick, mpq)
        else:
            tempo.append((tick, mpq))
    return tempo


def _tick_at(anchors: list[tuple[float, float]], seconds: float) -> int:
    """The tick a time in seconds lands on under the tempo map ``anchors``
    describes (linear between anchors, the last beat carried on after)."""
    times = [t for _q, t in anchors]
    i = bisect.bisect_right(times, seconds) - 1
    i = max(0, min(i, len(anchors) - 2))
    (q0, t0), (q1, t1) = anchors[i], anchors[i + 1]
    span = t1 - t0
    q = q0 if span <= _EPS else q0 + (seconds - t0) / span * (q1 - q0)
    return max(0, int(round(q * PPQ)))


def _write_midi(
    output: Path,
    parts: list[Any],
    plan: _Plan,
    tempo_map: list[tuple[int, int]],
    anchors: list[tuple[float, float]],
    events: list[tuple[int, float, float, int, int]],
) -> None:
    import mido
    import partitura as pt

    from backend.lib.atomic import atomic_replace, temp_sibling

    midi = mido.MidiFile(type=1, ticks_per_beat=PPQ)
    conductor: list[tuple[int, int, Any]] = [
        (0, 0, mido.MetaMessage("track_name", name="Performance", time=0))
    ]
    for tick, mpq in tempo_map:
        conductor.append((tick, 1, mido.MetaMessage("set_tempo", tempo=mpq, time=0)))
    first = parts[0]
    for signature in first.iter_all(pt.score.TimeSignature):
        tick = int(round(float(first.quarter_map(signature.start.t)) * PPQ))
        conductor.append(
            (
                tick,
                1,
                mido.MetaMessage(
                    "time_signature",
                    numerator=int(signature.beats),
                    denominator=int(signature.beat_type),
                    time=0,
                ),
            )
        )
    midi.tracks.append(_track(conductor))

    for index, part in enumerate(parts):
        channel = _CHANNELS[index % len(_CHANNELS)]
        timed: list[tuple[int, int, Any]] = [
            (
                0,
                0,
                mido.MetaMessage(
                    "track_name",
                    name=str(part.part_name or part.id or f"Part {index + 1}"),
                    time=0,
                ),
            )
        ]
        for part_index, on, off, pitch, velocity in events:
            if part_index != index:
                continue
            start = _tick_at(anchors, on)
            stop = max(start + 1, _tick_at(anchors, off))
            timed.append(
                (
                    start,
                    2,
                    mido.Message(
                        "note_on", note=pitch, velocity=velocity, channel=channel
                    ),
                )
            )
            # A note-off sorts before a note-on at the same tick, so a repeated
            # pitch is released before it sounds again.
            timed.append(
                (
                    stop,
                    1,
                    mido.Message("note_off", note=pitch, velocity=0, channel=channel),
                )
            )
        midi.tracks.append(_track(timed))

    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    scratch = temp_sibling(output)
    try:
        midi.save(str(scratch))
        atomic_replace(scratch, output)
    finally:
        scratch.unlink(missing_ok=True)


def _track(timed: list[tuple[int, int, Any]]) -> Any:
    import mido

    track = mido.MidiTrack()
    now = 0
    for tick, _rank, message in sorted(timed, key=lambda e: (e[0], e[1])):
        message.time = tick - now
        track.append(message)
        now = tick
    track.append(mido.MetaMessage("end_of_track", time=0))
    return track


def perform_to_artifact(
    db: Any,
    *,
    entry_id: str,
    source_path: Path,
    output_path: Path,
    source_ref: Optional[str],
    artifact_id: str,
    qpm: Optional[float] = None,
) -> dict[str, Any]:
    """Perform the sheet at ``source_path`` into ``output_path`` and register
    the MIDI as the entry's ``midi`` notation artifact ``artifact_id``, the
    way every export registers its file. ``ok=False`` with ``error`` when the
    sheet cannot be performed; never raises."""
    import importlib.util

    from .engine import _register_conversion

    if importlib.util.find_spec("partitura") is None:
        return {
            "ok": False,
            "engine": "partitura",
            "error": "partitura is not installed.",
        }
    try:
        summary = perform_musicxml(source_path, output_path, qpm=qpm)
    except PerformError as exc:
        return {"ok": False, "engine": "partitura", "error": str(exc)}
    except Exception as exc:  # report, never raise into the route
        log.warning("notation: perform failed for %s: %s", source_path, exc)
        return {"ok": False, "engine": "partitura", "error": repr(exc)}
    registered = _register_conversion(
        db,
        entry_id=entry_id,
        fmt="midi",
        final_path=output_path,
        source_path=source_path,
        source_ref=source_ref,
        artifact_id=artifact_id,
        engine="partitura-perform",
        engine_version=partitura_version(),
        extra_metadata={
            "performance": {
                "notes": summary["notes"],
                "tempo_events": summary["tempo_events"],
                "seconds": summary["seconds"],
                "qpm": summary["qpm"],
            }
        },
    )
    registered["performance"] = summary
    return registered
