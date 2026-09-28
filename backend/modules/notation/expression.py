"""Expression marks between a performance and a sheet, in both directions.

**MIDI to sheet** (:func:`add_expression`). A MIDI carries how the notes were
played: a velocity per note, and when each note starts and stops. A sheet
prints that as marks. The engraved score gets:

  - a dynamic mark (``ppp`` .. ``fff``) where the playing level changes. The
    level of an onset is the band its velocity falls in (:data:`LEVEL_FLOORS`).
    A new level is marked only when the velocity leaves the current band by
    :data:`DYNAMIC_HYSTERESIS` and stays out for :data:`DYNAMIC_MIN_RUN`
    onsets, so a line that jitters around a band edge prints one mark.
  - a crescendo or diminuendo hairpin over a run of at least
    :data:`RAMP_MIN_ONSETS` onsets whose velocity climbs (or falls) through at
    least :data:`RAMP_MIN_SPAN`. The hairpin carries the level it starts from
    and the level it arrives at; the bands it passes through are not marked.
  - staccato on a note that sounds for less than :data:`STACCATO_MAX_RATIO` of
    its slot (the time to the next onset in its part). The notated note is
    lengthened to fill the slot, up to :data:`STACCATO_FILL_MAX_QL`, so the
    sheet prints a dotted quarter where a player would read one, and not a
    sixteenth and three rests.
  - tenuto on a note held for :data:`TENUTO_MIN_RATIO` of its slot or more on
    a strong beat, in a line otherwise played detached (median ratio under
    :data:`TENUTO_CONTEXT_MAX_RATIO`). In a line held full everywhere every
    downbeat would qualify, which marks nothing.
  - a slur over a run of single notes where each note is still sounding when
    the next starts (legato overlap), in a line with nothing else sounding.
    The notated notes in the run are trimmed to end where the next begins.

A part that already carries dynamics, hairpins or slurs (a MusicXML source) is
left with its own; percussion parts are skipped. ``options["expression"]``
turns the pass off for one export (:func:`expression_enabled`).

**Sheet to MIDI** (:func:`read_sheet_expression`). The sheet import reads the
printed marks back as playing: a dynamic sets the velocity of the notes after
it (:data:`LEVEL_VELOCITY`), a hairpin moves the velocity from its start level
to the level it arrives at, an accent adds :data:`ACCENT_VELOCITY_BOOST`, and
staccato (:data:`ARTICULATION_LENGTH_SCALE`) shortens the note. A note that
carries its own velocity (a sheet this app engraved writes one on every note)
keeps it. A hairpin also comes back as a CC11 (expression) curve that shapes
the level between its two ends (:meth:`SheetExpression.cc11`).
"""

from __future__ import annotations

import bisect
import logging
import statistics
from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping, Optional

log = logging.getLogger(__name__)

# The per-export option that turns this pass on or off (default on).
EXPRESSION_OPTION = "expression"

# ---------------------------------------------------------------------------
# Dynamic levels
# ---------------------------------------------------------------------------

LEVELS = ("ppp", "pp", "p", "mp", "mf", "f", "ff", "fff")

# The velocity each printed level plays at.
LEVEL_VELOCITY: dict[str, int] = {
    "ppp": 16,
    "pp": 32,
    "p": 48,
    "mp": 64,
    "mf": 80,
    "f": 96,
    "ff": 112,
    "fff": 127,
}

# The lowest velocity of each level's band: halfway between neighbouring level
# velocities, so a level printed from a velocity plays back in the same band.
LEVEL_FLOORS: tuple[tuple[float, str], ...] = (
    (0.0, "ppp"),
    (24.0, "pp"),
    (40.0, "p"),
    (56.0, "mp"),
    (72.0, "mf"),
    (88.0, "f"),
    (104.0, "ff"),
    (119.5, "fff"),
)

# Onset velocities are smoothed by a running median over this many onsets
# before any level or hairpin is read from them, so one loud or soft note
# (an accent, a transcription glitch) moves nothing.
DYNAMIC_SMOOTH_ONSETS = 5
# How far (in velocity) an onset must leave the current level's band before a
# new level is considered.
DYNAMIC_HYSTERESIS = 4.0
# How many onsets in a row must sit outside the band before the new level is
# marked.
DYNAMIC_MIN_RUN = 3

# A hairpin needs this many onsets ...
RAMP_MIN_ONSETS = 6
# ... climbing (or falling) by at least this much velocity overall ...
RAMP_MIN_SPAN = 16.0
# ... with no step going the other way by more than this.
RAMP_TOLERANCE = 3.0

# ---------------------------------------------------------------------------
# Articulation (MIDI to sheet)
# ---------------------------------------------------------------------------

# Sounding length / slot below this prints staccato.
STACCATO_MAX_RATIO = 0.5
# A staccato note is notated as long as its slot when the slot is at most this
# many quarters; a longer slot keeps the notated rest.
STACCATO_FILL_MAX_QL = 1.0
# Sounding length / slot at or above this, on a strong beat, prints tenuto ...
TENUTO_MIN_RATIO = 0.95
# ... when the line around it is played detached (its median ratio is below
# this).
TENUTO_CONTEXT_MAX_RATIO = 0.85
# A beat whose accent weight (music21 ``TimeSignature.getAccentWeight``) is at
# least this is strong: beat 1 (1.0) and beat 3 of 4/4 (0.5).
STRONG_BEAT_MIN_WEIGHT = 0.5
# A note whose next onset is further away than this has no slot to judge
# articulation by (it ends a phrase).
ARTICULATION_MAX_SLOT_QL = 2.0
# A legato overlap is at most this long; a longer one is two voices.
LEGATO_MAX_OVERLAP_QL = 0.5
# How far a quantized note may have moved from the MIDI note it came from.
MATCH_WINDOW_QL = 0.5

# ---------------------------------------------------------------------------
# Sheet to MIDI
# ---------------------------------------------------------------------------

# The level before the first printed dynamic of a sheet that has some.
DEFAULT_LEVEL = "mf"
# Velocity an accent adds, and a strong accent (marcato).
ACCENT_VELOCITY_BOOST = 16
STRONG_ACCENT_VELOCITY_BOOST = 24
# Velocity of a sforzando-type mark on its own note (the level is unchanged).
SFORZANDO_LEVEL = "f"
SFORZANDO_MARKS = frozenset({"sf", "sfz", "sffz", "fz", "rf", "rfz", "sfp", "sfpp"})
# Sounding length / notated length per articulation.
ARTICULATION_LENGTH_SCALE: dict[str, float] = {
    "Staccato": 0.5,
    "Staccatissimo": 0.25,
    "Spiccato": 0.25,
    "DetachedLegato": 0.75,
}
# A hairpin with no printed level after it arrives this many levels away.
HAIRPIN_DEFAULT_STEPS = 1
# A printed level this close after a hairpin's end is the level it arrives at.
HAIRPIN_TARGET_WINDOW_QL = 4.0
# The CC11 curve is sampled this often inside a hairpin.
HAIRPIN_CC_STEP_QL = 0.25
# CC11 at full expression: the note's velocity plays as it is.
CC11_FULL = 127

_EPS = 1e-6


def expression_enabled(options: Optional[Mapping[str, Any]]) -> bool:
    """``options["expression"]`` as a bool; on when absent. ``False``, ``0``,
    ``"off"``, ``"false"`` and ``"no"`` turn it off."""
    value = (options or {}).get(EXPRESSION_OPTION, True)
    if isinstance(value, str):
        return value.strip().lower() not in ("off", "false", "no", "0", "")
    return bool(value)


def level_for_velocity(velocity: float) -> str:
    """The printed level whose band holds ``velocity``."""
    floors = [floor for floor, _level in LEVEL_FLOORS]
    idx = bisect.bisect_right(floors, float(velocity)) - 1
    return LEVEL_FLOORS[max(0, idx)][1]


def velocity_for_level(level: str) -> Optional[int]:
    """The velocity a printed level plays at, or None for a mark that is not a
    level (``sf``, ``fp``, text)."""
    return LEVEL_VELOCITY.get(str(level).strip().lower())


def _band(level: str) -> tuple[float, float]:
    idx = LEVELS.index(level)
    low = LEVEL_FLOORS[idx][0]
    high = LEVEL_FLOORS[idx + 1][0] if idx + 1 < len(LEVEL_FLOORS) else 128.0
    return low, high


def _outside(velocity: float, level: str) -> int:
    """+1 when ``velocity`` is above ``level``'s band by the hysteresis, -1
    when below it by the hysteresis, else 0."""
    low, high = _band(level)
    if velocity >= high + DYNAMIC_HYSTERESIS:
        return 1
    if velocity < low - DYNAMIC_HYSTERESIS:
        return -1
    return 0


# ---------------------------------------------------------------------------
# MIDI to sheet
# ---------------------------------------------------------------------------


@dataclass
class _Event:
    element: Any
    onset: float  # notated offset in the part
    raw_onset: float  # when the note was played
    raw_end: float
    velocity: Optional[float]
    single: bool  # one note, not a chord


@dataclass
class ExpressionCounts:
    dynamics: int = 0
    hairpins: int = 0
    staccato: int = 0
    tenuto: int = 0
    slurs: int = 0

    def as_dict(self) -> dict[str, int]:
        return {
            "dynamics": self.dynamics,
            "hairpins": self.hairpins,
            "staccato": self.staccato,
            "tenuto": self.tenuto,
            "slurs": self.slurs,
        }


def add_expression(score: Any, *, raw: Any = None) -> dict[str, int]:
    """Print the dynamics, hairpins, staccato, tenuto and slurs a MIDI's
    playing implies onto ``score``, in place. Returns how many of each.

    ``score`` is the music21 score about to be written (flat parts, as
    :func:`.midi_read.read_midi` and ``quantize`` leave them, or measured).
    ``raw`` is how the same MIDI was played, part for part: a list with one
    list of ``(onset, end, pitch)`` (quarters, MIDI pitch) per part, as
    :func:`raw_for` reads it. Its note times give each note's sounding length
    and overlaps, which quantization rounds away. Without it, or when its part
    count differs from the score's, the notated times are used.
    """
    counts = ExpressionCounts()
    parts = list(getattr(score, "parts", []) or [])
    raw_parts: list[Any] = list(raw) if isinstance(raw, list) else []
    if len(raw_parts) != len(parts):
        raw_parts = []
    for index, part in enumerate(parts):
        if _is_percussion(part):
            continue
        events = _events(part, raw_parts[index] if raw_parts else None)
        if not events:
            continue
        placer = _Placer(part)
        slurred: set[int] = set()
        if not _has(part, "Slur"):
            slurred = _add_slurs(placer, events, counts)
        _add_articulations(part, events, slurred, counts)
        if not _has(part, "Dynamic") and not _has(part, "DynamicWedge"):
            _add_dynamics(placer, events, counts)
    return counts.as_dict()


def _is_percussion(part: Any) -> bool:
    from music21 import clef

    flat = part.flatten()
    if flat.getElementsByClass(clef.PercussionClef):
        return True
    return bool(flat.getElementsByClass(("Unpitched", "PercussionChord")))


def _has(part: Any, class_name: str) -> bool:
    return bool(part.flatten().getElementsByClass(class_name))


def _velocity(element: Any) -> Optional[float]:
    from music21 import chord

    if element.hasVolumeInformation() and element.volume.velocity is not None:
        return float(element.volume.velocity)
    if isinstance(element, chord.ChordBase):
        heads = [
            float(n.volume.velocity)
            for n in element.notes
            if n.hasVolumeInformation() and n.volume.velocity is not None
        ]
        if heads:
            return sum(heads) / len(heads)
    return None


def _events(
    part: Any, raw_part: Optional[list[tuple[float, float, int]]]
) -> list[_Event]:
    """The part's notes and chords in onset order, each with the times it was
    played at: every pitch of it matched to the nearest unused played note of
    that pitch within :data:`MATCH_WINDOW_QL`."""
    from music21 import chord

    flat = part.flatten()
    by_pitch: dict[int, list[tuple[float, float]]] = {}
    for onset, end, pitch in raw_part or []:
        by_pitch.setdefault(int(pitch), []).append((float(onset), float(end)))
    for played in by_pitch.values():
        played.sort()
    onsets_of = {pitch: [n[0] for n in played] for pitch, played in by_pitch.items()}
    used: set[tuple[int, int]] = set()

    events: list[_Event] = []
    for el in flat.notes:
        if el.duration.isGrace:
            continue
        onset = float(el.getOffsetBySite(flat))
        end = onset + float(el.duration.quarterLength)
        matched: list[tuple[float, float]] = []
        for p in el.pitches:
            pitch = int(round(p.ps))
            played = by_pitch.get(pitch)
            if not played:
                continue
            starts = onsets_of[pitch]
            lo = bisect.bisect_left(starts, onset - MATCH_WINDOW_QL)
            hi = bisect.bisect_right(starts, onset + MATCH_WINDOW_QL)
            best = min(
                (i for i in range(lo, hi) if (pitch, i) not in used),
                key=lambda i: abs(starts[i] - onset),
                default=None,
            )
            if best is not None:
                used.add((pitch, best))
                matched.append(played[best])
        events.append(
            _Event(
                element=el,
                onset=onset,
                raw_onset=min((m[0] for m in matched), default=onset),
                raw_end=max((m[1] for m in matched), default=end),
                velocity=_velocity(el),
                single=not isinstance(el, chord.ChordBase),
            )
        )
    events.sort(key=lambda e: (e.onset, e.raw_onset))
    return events


def _groups(events: list[_Event]) -> list[list[_Event]]:
    """Events that start together (same notated onset), in onset order."""
    groups: list[list[_Event]] = []
    for ev in events:
        if groups and abs(groups[-1][0].onset - ev.onset) < _EPS:
            groups[-1].append(ev)
        else:
            groups.append([ev])
    return groups


class _Placer:
    """Puts marks into a part: at an offset of the part itself when it is
    flat, into the measure holding the offset when it has measures. Inserted
    unsorted (``ignoreSort``) with the measures looked up once: sorting the
    part again after every mark made a long transcription take minutes."""

    def __init__(self, part: Any) -> None:
        from music21 import stream

        self.part = part
        self.measures = [
            (float(m.getOffsetBySite(part)), m)
            for m in part.getElementsByClass(stream.Measure)
        ]
        self.starts = [start for start, _m in self.measures]

    def mark(self, offset: float, obj: Any) -> None:
        if not self.measures:
            self.part.insert(offset, obj, ignoreSort=True)
            return
        i = max(0, bisect.bisect_right(self.starts, offset + _EPS) - 1)
        start, measure = self.measures[i]
        measure.insert(max(0.0, offset - start), obj, ignoreSort=True)

    def spanner(self, spanner_obj: Any) -> None:
        self.part.insert(0, spanner_obj, ignoreSort=True)


# -- dynamics ----------------------------------------------------------------


def _ramps(velocities: list[float]) -> dict[int, tuple[int, int]]:
    """Runs of onsets whose velocity climbs or falls: ``{start: (end, +1|-1)}``."""
    ramps: dict[int, tuple[int, int]] = {}
    n = len(velocities)
    i = 0
    while i < n - 1:
        step = velocities[i + 1] - velocities[i]
        if abs(step) < _EPS:
            i += 1
            continue
        direction = 1 if step > 0 else -1
        j = i + 1
        while j + 1 < n and (velocities[j + 1] - velocities[j]) * direction >= -(
            RAMP_TOLERANCE
        ):
            j += 1
        # End on the loudest (softest) onset reached, not on a plateau after it.
        run = velocities[i : j + 1]
        peak = max(run) if direction > 0 else min(run)
        j = i + run.index(peak)
        span = (velocities[j] - velocities[i]) * direction
        if j - i + 1 >= RAMP_MIN_ONSETS and span >= RAMP_MIN_SPAN:
            ramps[i] = (j, direction)
            i = j + 1
        else:
            i += 1
    return ramps


def _smoothed(values: list[float]) -> list[float]:
    """A centred running median over :data:`DYNAMIC_SMOOTH_ONSETS` values
    (shorter at the ends)."""
    half = DYNAMIC_SMOOTH_ONSETS // 2
    return [
        float(statistics.median(values[max(0, i - half) : i + half + 1]))
        for i in range(len(values))
    ]


def _add_dynamics(
    placer: _Placer, events: list[_Event], counts: ExpressionCounts
) -> None:
    from music21 import dynamics

    groups = [g for g in _groups(events) if any(ev.velocity is not None for ev in g)]
    if not groups:
        return
    velocities = _smoothed(
        [
            statistics.fmean(ev.velocity for ev in g if ev.velocity is not None)
            for g in groups
        ]
    )
    ramps = _ramps(velocities)

    def mark(index: int, level: str) -> None:
        placer.mark(groups[index][0].onset, dynamics.Dynamic(level))
        counts.dynamics += 1

    current: Optional[str] = None
    i = 0
    n = len(groups)
    while i < n:
        if i in ramps:
            j, direction = ramps[i]
            start_level = level_for_velocity(velocities[i])
            end_level = level_for_velocity(velocities[j])
            if start_level != current:
                mark(i, start_level)
            wedge = dynamics.Crescendo() if direction > 0 else dynamics.Diminuendo()
            wedge.addSpannedElements([groups[k][0].element for k in range(i, j + 1)])
            placer.spanner(wedge)
            counts.hairpins += 1
            if end_level != start_level:
                mark(j, end_level)
            current = end_level
            i = j + 1
            continue
        if current is None:
            current = level_for_velocity(velocities[i])
            mark(i, current)
            i += 1
            continue
        side = _outside(velocities[i], current)
        if side:
            run = velocities[i : i + DYNAMIC_MIN_RUN]
            persists = (
                len(run) == DYNAMIC_MIN_RUN
                and all(_outside(v, current) == side for v in run)
                and not any(k in ramps for k in range(i + 1, i + DYNAMIC_MIN_RUN))
            )
            if persists:
                current = level_for_velocity(statistics.median(run))
                mark(i, current)
        i += 1


# -- articulation --------------------------------------------------------------


def _time_signatures(part: Any) -> list[tuple[float, Any]]:
    """The part's time signatures at their offsets, in order; 4/4 at 0 when
    it has none there."""
    from music21 import meter

    flat = part.flatten()
    signatures = sorted(
        (
            (float(ts.getOffsetBySite(flat)), ts)
            for ts in flat.getElementsByClass(meter.TimeSignature)
        ),
        key=lambda s: s[0],
    )
    if not signatures or signatures[0][0] > _EPS:
        signatures.insert(0, (0.0, meter.TimeSignature("4/4")))
    return signatures


def _strong_beat(signatures: list[tuple[float, Any]], offset: float) -> bool:
    ts_at, ts = signatures[0]
    for at, sig in signatures:
        if at <= offset + _EPS:
            ts, ts_at = sig, at
    bar = float(ts.barDuration.quarterLength) or 4.0
    in_bar = (offset - ts_at) % bar
    try:
        weight = float(ts.getAccentWeight(in_bar, forcePositionMatch=True))
    except Exception:  # an off-grid position has no weight
        weight = 0.0
    return weight >= STRONG_BEAT_MIN_WEIGHT


def _add_articulations(
    part: Any, events: list[_Event], slurred: set[int], counts: ExpressionCounts
) -> None:
    from music21 import articulations

    groups = _groups(events)
    notated_before = _latest_end_before(groups, notated=True)
    signatures: Optional[list[tuple[float, Any]]] = None
    # (group index, ratio, notated slot)
    judged: list[tuple[int, float, float]] = []
    for gi in range(len(groups) - 1):
        group, following = groups[gi], groups[gi + 1]
        raw_onset = min(ev.raw_onset for ev in group)
        raw_next = min(ev.raw_onset for ev in following)
        slot = raw_next - raw_onset
        if slot <= _EPS or slot > ARTICULATION_MAX_SLOT_QL:
            continue
        sounding = max(ev.raw_end for ev in group) - raw_onset
        judged.append((gi, sounding / slot, following[0].onset - group[0].onset))
    if not judged:
        return
    median_ratio = statistics.median(r for _gi, r, _slot in judged)

    for gi, ratio, notated_slot in judged:
        group = groups[gi]
        if any(id(ev.element) in slurred for ev in group):
            continue
        if ratio < STACCATO_MAX_RATIO:
            for ev in group:
                if not _has_articulation(ev.element, "Staccato"):
                    ev.element.articulations.append(articulations.Staccato())
                    counts.staccato += 1
                # Filled only where nothing else sounds: one note in its
                # onset, nothing held over it, and the slot ends at the next
                # onset.
                if (
                    len(group) == 1
                    and notated_slot <= STACCATO_FILL_MAX_QL + _EPS
                    and notated_slot > ev.element.duration.quarterLength
                    and notated_before[gi] <= ev.onset + _EPS
                ):
                    ev.element.duration.quarterLength = notated_slot
        elif ratio >= TENUTO_MIN_RATIO and median_ratio < TENUTO_CONTEXT_MAX_RATIO:
            if signatures is None:
                signatures = _time_signatures(part)
            if not _strong_beat(signatures, group[0].onset):
                continue
            for ev in group:
                if not _has_articulation(ev.element, "Tenuto"):
                    ev.element.articulations.append(articulations.Tenuto())
                    counts.tenuto += 1


def _has_articulation(element: Any, name: str) -> bool:
    return any(type(a).__name__ == name for a in element.articulations)


def _latest_end_before(groups: list[list[_Event]], *, notated: bool) -> list[float]:
    """For each onset group, the latest end of any note in the groups before
    it (notated or played times): a note still sounding from further back
    means the line is not one voice there."""
    out: list[float] = []
    latest = float("-inf")
    for group in groups:
        out.append(latest)
        for ev in group:
            end = (
                ev.onset + float(ev.element.duration.quarterLength)
                if notated
                else ev.raw_end
            )
            latest = max(latest, end)
    return out


# -- slurs ---------------------------------------------------------------------


def _add_slurs(
    placer: _Placer, events: list[_Event], counts: ExpressionCounts
) -> set[int]:
    """Slur each run of legato-overlapping single notes; returns the ids of
    the elements under a slur."""
    from music21 import spanner

    groups = _groups(events)
    line = [g[0] if len(g) == 1 and g[0].single else None for g in groups]
    before_end = _latest_end_before(groups, notated=False)

    def legato(k: int) -> bool:
        a, b = line[k], line[k + 1]
        if a is None or b is None:
            return False
        overlap = a.raw_end - b.raw_onset
        return (
            _EPS < overlap <= LEGATO_MAX_OVERLAP_QL
            and a.raw_end <= b.raw_end + _EPS
            and before_end[k] <= b.raw_onset + _EPS
        )

    slurred: set[int] = set()
    k = 0
    while k < len(groups) - 1:
        if not legato(k):
            k += 1
            continue
        start = k
        while k < len(groups) - 1 and legato(k):
            k += 1
        run = [line[i] for i in range(start, k + 1)]
        notes = [ev.element for ev in run if ev is not None]
        placer.spanner(spanner.Slur(notes))
        counts.slurs += 1
        for ev, nxt in zip(run, run[1:]):
            assert ev is not None and nxt is not None
            slurred.add(id(ev.element))
            gap = nxt.onset - ev.onset
            if gap > _EPS and ev.element.duration.quarterLength > gap:
                ev.element.duration.quarterLength = gap
        last = run[-1]
        if last is not None:
            slurred.add(id(last.element))
    return slurred


def raw_for(source_path: Any) -> Optional[list[list[tuple[float, float, int]]]]:
    """The notes of the MIDI at ``source_path`` at the times they were played,
    one ``(onset, end, pitch)`` list per track that has notes (quarters), for
    :func:`add_expression`'s ``raw``; None when it cannot be read.

    music21's MIDI reader rounds every onset and length to the notation grid
    (``quantizePost``), so a note held for 0.4 of a beat reads as 0.5 and its
    staccato is gone before anything looks at it. This reads the file with
    mido, which rounds nothing. music21 makes one part of each track with
    notes, in file order, so the lists line up with the sheet's parts; when a
    file's parts come out differently :func:`add_expression` ignores them.
    """
    import mido

    try:
        midi = mido.MidiFile(str(source_path))
    except Exception as exc:  # expression is best-effort
        log.debug("expression: could not re-read %s: %s", source_path, exc)
        return None
    per_quarter = float(midi.ticks_per_beat or 480)
    parts: list[list[tuple[float, float, int]]] = []
    for track in midi.tracks:
        now = 0
        sounding: dict[tuple[int, int], list[int]] = {}
        notes: list[tuple[float, float, int]] = []
        for message in track:
            now += message.time
            if message.type == "note_on" and message.velocity > 0:
                sounding.setdefault((message.channel, message.note), []).append(now)
            elif message.type in ("note_on", "note_off"):
                started = sounding.get((message.channel, message.note))
                if started:
                    start = started.pop(0)
                    notes.append(
                        (start / per_quarter, now / per_quarter, int(message.note))
                    )
        if notes:
            parts.append(sorted(notes))
    return parts


def apply_to_export(score: Any, source_path: Any) -> None:
    """The engine's hook: :func:`add_expression` on a MIDI's score before it is
    written, with the MIDI read again for the times it was played at
    (:func:`raw_for`). Does nothing for a source that is not a MIDI. Never
    raises: a sheet without marks is better than no sheet."""
    from .midi_read import is_midi

    if not is_midi(source_path):
        return
    try:
        counts = add_expression(score, raw=raw_for(source_path))
        log.debug("expression: %s -> %s", source_path, counts)
    except Exception as exc:  # expression is best-effort
        log.warning("expression: marks skipped for %s: %s", source_path, exc)


# ---------------------------------------------------------------------------
# Sheet to MIDI
# ---------------------------------------------------------------------------


@dataclass
class Hairpin:
    """A printed hairpin from ``start`` to ``end`` (quarters). ``target`` is
    the velocity it arrives at, None for one level up (down) from where it
    starts."""

    start: float
    end: float
    direction: int  # +1 crescendo, -1 diminuendo
    target: Optional[float] = None


@dataclass
class SheetExpression:
    """The playing a part's printed marks ask for."""

    marks: list[tuple[float, float]] = field(default_factory=list)
    wedges: list[Hairpin] = field(default_factory=list)
    accents: dict[float, float] = field(default_factory=dict)
    #: The velocity before the first printed level.
    default: float = float(LEVEL_VELOCITY[DEFAULT_LEVEL])

    @property
    def has_dynamics(self) -> bool:
        return bool(self.marks or self.wedges or self.accents)

    def use_levels(
        self,
        marks: Iterable[tuple[float, float]],
        accents: Mapping[float, float],
        default: float,
    ) -> None:
        """Play the printed levels and sforzandos at velocities another
        reader gave them, and aim each hairpin that ends on a printed level at
        that level's new velocity."""
        self.marks = sorted((float(o), float(v)) for o, v in marks)
        self.accents = {float(o): float(v) for o, v in accents.items()}
        self.default = float(default)
        for wedge in self.wedges:
            wedge.target = next(
                (
                    velocity
                    for at, velocity in self.marks
                    if wedge.end - _EPS <= at <= wedge.end + HAIRPIN_TARGET_WINDOW_QL
                ),
                None,
            )

    def _mark_before(self, offset: float) -> tuple[float, float]:
        """(offset, velocity) of the last level at or before ``offset``."""
        at, velocity = float("-inf"), self.default
        for mark_at, mark_velocity in self.marks:
            if mark_at <= offset + _EPS:
                at, velocity = mark_at, mark_velocity
            else:
                break
        return at, velocity

    def level_at(self, offset: float) -> float:
        """The velocity the printed dynamics give ``offset``."""
        mark_at, velocity = self._mark_before(offset)
        for wedge in self.wedges:
            if wedge.start - _EPS <= offset <= wedge.end + _EPS:
                start_velocity = self.level_at(wedge.start - 2 * _EPS)
                if abs(wedge.start - self._mark_before(wedge.start)[0]) < _EPS:
                    start_velocity = self._mark_before(wedge.start)[1]
                target = self._target(wedge, start_velocity)
                span = wedge.end - wedge.start
                t = 1.0 if span <= _EPS else (offset - wedge.start) / span
                return start_velocity + (target - start_velocity) * t
            if wedge.end < offset and wedge.start >= mark_at - _EPS:
                # The hairpin ended after the last printed level: it arrived.
                start_velocity = self._mark_before(wedge.start)[1]
                velocity = self._target(wedge, start_velocity)
        return velocity

    def _start_velocity(self, wedge: Hairpin) -> float:
        """The level ``wedge`` starts from: a level printed on its first note,
        else the level just before it."""
        mark_at, mark_velocity = self._mark_before(wedge.start)
        if abs(wedge.start - mark_at) < _EPS:
            return mark_velocity
        return self.level_at(wedge.start - 2 * _EPS)

    def _hairpin_at(self, offset: float) -> Optional[Hairpin]:
        """The hairpin a note at ``offset`` is played inside: from its start
        up to, not including, its end. A note on the end plays the level the
        hairpin arrived at."""
        for wedge in self.wedges:
            if wedge.start - _EPS <= offset < wedge.end - _EPS:
                return wedge
        return None

    def note_level(self, offset: float) -> float:
        """The velocity a note at ``offset`` plays at before its accents: the
        printed level, and inside a hairpin the louder of the level it starts
        from and the level it arrives at. :meth:`cc11` brings the heard level
        down from there along the hairpin."""
        wedge = self._hairpin_at(offset)
        if wedge is None:
            return self.level_at(offset)
        start_velocity = self._start_velocity(wedge)
        return max(start_velocity, self._target(wedge, start_velocity))

    def _target(self, wedge: Hairpin, start_velocity: float) -> float:
        if wedge.target is not None:
            return wedge.target
        idx = LEVELS.index(level_for_velocity(start_velocity))
        idx = min(
            len(LEVELS) - 1, max(0, idx + HAIRPIN_DEFAULT_STEPS * wedge.direction)
        )
        return float(LEVEL_VELOCITY[LEVELS[idx]])

    def velocity(self, element: Any, offset: float) -> int:
        """The velocity the marks give a note at ``offset``: the level, the
        sforzando on that onset, and the note's accents."""
        velocity = self.note_level(offset)
        for at, accent_velocity in self.accents.items():
            if abs(at - offset) < _EPS:
                velocity = max(velocity, accent_velocity)
        velocity += _accent_boost(element)
        return int(round(max(1.0, min(127.0, velocity))))

    def cc11(self, onsets: Iterable[float]) -> list[tuple[float, int]]:
        """The hairpins as a CC11 (expression) curve of ``(offset, value)``
        points, with repeated values dropped; no points for a part that
        prints no hairpin.

        A synth plays a note at ``velocity x CC11 / 127``, so the printed
        dynamics are applied exactly once only when one of the two carries
        them and the other stays neutral. The velocity carries the printed
        levels (:meth:`note_level`), and CC11 stays at 127 wherever a level
        holds: a mark is played by velocity alone, and a part with no hairpin
        gets no CC11, however late its first mark comes. A hairpin is the one
        place the level moves while a note sounds, which velocity cannot do:
        every note inside it plays at the louder end's velocity, and CC11
        runs from ``127 x start / louder`` to ``127 x arrival / louder``,
        sampled every :data:`HAIRPIN_CC_STEP_QL`, so the heard level moves
        from the start level to the arrival level along the printed hairpin.
        A crescendo's CC11 starts below 127 and rises to it; a diminuendo's
        starts at 127 and falls. CC11 returns to 127 on the first onset at or
        after the hairpin's end, where the arrival level is the velocity
        again. Taking the louder end keeps CC11 at or under 127, the most it
        can send; taking the level at each note's onset instead would apply
        the hairpin twice, once in each note's velocity and again in CC11."""
        if not self.wedges:
            return []
        ordered = sorted(set(float(t) for t in onsets))
        values: dict[float, int] = {}
        wedges = sorted(self.wedges, key=lambda w: w.start)
        for index, wedge in enumerate(wedges):
            span = wedge.end - wedge.start
            if span <= _EPS:
                continue
            start_velocity = self._start_velocity(wedge)
            target = self._target(wedge, start_velocity)
            louder = max(start_velocity, target, 1.0)
            step = 0
            while True:
                t = wedge.start + step * HAIRPIN_CC_STEP_QL
                if t >= wedge.end - _EPS:
                    break
                level = start_velocity + (target - start_velocity) * (
                    (t - wedge.start) / span
                )
                values[round(t, 6)] = _cc11_value(level, louder)
                step += 1
            after_index = bisect.bisect_left(ordered, wedge.end - _EPS)
            if after_index == len(ordered):
                continue
            after = ordered[after_index]
            following = wedges[index + 1] if index + 1 < len(wedges) else None
            if following is not None and following.start <= after + _EPS:
                # The next hairpin starts there and writes its own value.
                continue
            values[round(after, 6)] = CC11_FULL
        points: list[tuple[float, int]] = []
        for t in sorted(values):
            if not points or points[-1][1] != values[t]:
                points.append((t, values[t]))
        return points


def _cc11_value(level: float, louder: float) -> int:
    """CC11 that plays a note of velocity ``louder`` at ``level``."""
    return int(round(max(0.0, min(float(CC11_FULL), CC11_FULL * level / louder))))


def _accent_boost(element: Any) -> int:
    boost = 0
    for articulation in getattr(element, "articulations", []) or []:
        name = type(articulation).__name__
        if name == "StrongAccent":
            boost = max(boost, STRONG_ACCENT_VELOCITY_BOOST)
        elif name == "Accent":
            boost = max(boost, ACCENT_VELOCITY_BOOST)
    return boost


def length_scale(element: Any) -> float:
    """How much of its notated length a note sounds, by its articulation."""
    scale = 1.0
    for articulation in getattr(element, "articulations", []) or []:
        scale = min(
            scale, ARTICULATION_LENGTH_SCALE.get(type(articulation).__name__, 1.0)
        )
    return scale


def read_sheet_expression(part: Any) -> SheetExpression:
    """The printed dynamics and hairpins of a music21 part, as a
    :class:`SheetExpression`. Offsets are in quarters from the part's start,
    the same offsets ``part.flatten()`` gives its notes."""
    from music21 import dynamics

    flat = part.flatten()
    expression = SheetExpression()
    for mark in flat.getElementsByClass(dynamics.Dynamic):
        at = float(mark.getOffsetBySite(flat))
        value = str(mark.value or "").strip().lower()
        velocity = velocity_for_level(value)
        if velocity is not None:
            expression.marks.append((at, float(velocity)))
        elif value in SFORZANDO_MARKS:
            expression.accents[at] = float(LEVEL_VELOCITY[SFORZANDO_LEVEL])
        elif value == "fp":
            expression.accents[at] = float(LEVEL_VELOCITY["f"])
            expression.marks.append((at + _EPS * 10, float(LEVEL_VELOCITY["p"])))
    expression.marks.sort(key=lambda m: m[0])

    offsets_of = _offsets_by_origin(flat)
    for wedge in flat.getElementsByClass(dynamics.DynamicWedge):
        spanned = wedge.getSpannedElements()
        if not spanned:
            continue
        starts = offsets_of.get(id(spanned[0]), [])
        ends = offsets_of.get(id(spanned[-1]), [])
        direction = -1 if isinstance(wedge, dynamics.Diminuendo) else 1
        for start in starts:
            end = min((e for e in ends if e >= start - _EPS), default=None)
            if end is None:
                continue
            if end - start <= _EPS:
                end = start + float(spanned[-1].duration.quarterLength)
            target = next(
                (
                    velocity
                    for at, velocity in expression.marks
                    if end - _EPS <= at <= end + HAIRPIN_TARGET_WINDOW_QL
                ),
                None,
            )
            expression.wedges.append(Hairpin(start, end, direction, target))
    expression.wedges.sort(key=lambda w: w.start)
    return expression


def _offsets_by_origin(flat: Any) -> dict[int, list[float]]:
    """Every offset each note of ``flat`` sits at, keyed by the id of the note
    and of each note it was copied from. A spanner keeps pointing at the notes
    it was read with, and ``expandRepeats`` plays copies of them (once per
    time through a repeat)."""
    offsets: dict[int, list[float]] = {}
    for el in flat.notes:
        at = float(el.getOffsetBySite(flat))
        seen: set[int] = set()
        origin: Any = el
        while origin is not None and id(origin) not in seen:
            seen.add(id(origin))
            offsets.setdefault(id(origin), []).append(at)
            origin = getattr(getattr(origin, "derivation", None), "origin", None)
    for found in offsets.values():
        found.sort()
    return offsets
