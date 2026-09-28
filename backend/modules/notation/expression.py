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
keeps it. The level curve also comes back as a CC11 (expression) curve.
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

# How far (in velocity) an onset must leave the current level's band before a
# new level is considered.
DYNAMIC_HYSTERESIS = 4.0
# How many onsets in a row must sit outside the band before the new level is
# marked. A single loud note is an accent, not a new level.
DYNAMIC_MIN_RUN = 2

# A hairpin needs this many onsets ...
RAMP_MIN_ONSETS = 4
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
    ``raw`` is the same MIDI before quantization, part for part; its note
    times give each note's sounding length and overlaps, which quantization
    rounds away. Without it the notated times are used.
    """
    counts = ExpressionCounts()
    parts = list(getattr(score, "parts", []) or [])
    raw_parts = list(getattr(raw, "parts", []) or []) if raw is not None else []
    if len(raw_parts) != len(parts):
        raw_parts = []
    for index, part in enumerate(parts):
        if _is_percussion(part):
            continue
        events = _events(part, raw_parts[index] if raw_parts else None)
        if not events:
            continue
        slurred: set[int] = set()
        if not _has(part, "Slur"):
            slurred = _add_slurs(part, events, counts)
        _add_articulations(part, events, slurred, counts)
        if not _has(part, "Dynamic") and not _has(part, "DynamicWedge"):
            _add_dynamics(part, events, counts)
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


def _pitch_key(element: Any) -> tuple[float, ...]:
    return tuple(sorted(float(p.ps) for p in element.pitches))


def _events(part: Any, raw_part: Any) -> list[_Event]:
    from music21 import chord

    flat = part.flatten()
    raw_notes: list[tuple[float, float, tuple[float, ...]]] = []
    if raw_part is not None:
        raw_flat = raw_part.flatten()
        for el in raw_flat.notes:
            onset = float(el.getOffsetBySite(raw_flat))
            raw_notes.append(
                (onset, onset + float(el.duration.quarterLength), _pitch_key(el))
            )
        raw_notes.sort()
    used: set[int] = set()
    raw_onsets = [n[0] for n in raw_notes]

    events: list[_Event] = []
    for el in flat.notes:
        if el.duration.isGrace:
            continue
        onset = float(el.getOffsetBySite(flat))
        end = onset + float(el.duration.quarterLength)
        raw_onset, raw_end = onset, end
        if raw_notes:
            key = _pitch_key(el)
            lo = bisect.bisect_left(raw_onsets, onset - MATCH_WINDOW_QL)
            hi = bisect.bisect_right(raw_onsets, onset + MATCH_WINDOW_QL)
            best = None
            for i in range(lo, hi):
                if i in used or raw_notes[i][2] != key:
                    continue
                if best is None or abs(raw_notes[i][0] - onset) < abs(
                    raw_notes[best][0] - onset
                ):
                    best = i
            if best is not None:
                used.add(best)
                raw_onset, raw_end = raw_notes[best][0], raw_notes[best][1]
        events.append(
            _Event(
                element=el,
                onset=onset,
                raw_onset=raw_onset,
                raw_end=raw_end,
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


def _insert_at(part: Any, offset: float, obj: Any) -> None:
    """Insert ``obj`` at ``offset`` of ``part``: into the part itself when it
    is flat, into the measure holding ``offset`` when it has measures."""
    from music21 import stream

    measures = list(part.getElementsByClass(stream.Measure))
    if not measures:
        part.insert(offset, obj)
        return
    for measure in measures:
        start = float(measure.getOffsetBySite(part))
        length = float(measure.duration.quarterLength)
        if start - _EPS <= offset < start + length - _EPS:
            measure.insert(offset - start, obj)
            return
    last = measures[-1]
    last.insert(max(0.0, offset - float(last.getOffsetBySite(part))), obj)


def _add_spanner(part: Any, spanner_obj: Any) -> None:
    part.insert(0, spanner_obj)


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


def _add_dynamics(part: Any, events: list[_Event], counts: ExpressionCounts) -> None:
    from music21 import dynamics

    groups = [g for g in _groups(events) if any(ev.velocity is not None for ev in g)]
    if not groups:
        return
    velocities = [
        statistics.fmean(ev.velocity for ev in g if ev.velocity is not None)
        for g in groups
    ]
    ramps = _ramps(velocities)

    def mark(index: int, level: str) -> None:
        _insert_at(part, groups[index][0].onset, dynamics.Dynamic(level))
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
            _add_spanner(part, wedge)
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


def _strong_beat(part: Any, offset: float) -> bool:
    from music21 import meter

    flat = part.flatten()
    signatures = [
        (float(ts.getOffsetBySite(flat)), ts)
        for ts in flat.getElementsByClass(meter.TimeSignature)
    ]
    ts = meter.TimeSignature("4/4")
    ts_at = 0.0
    for at, sig in sorted(signatures, key=lambda s: s[0]):
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
    # (group index, ratio, raw slot, notated slot)
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
                if (
                    len(group) == 1
                    and notated_slot <= STACCATO_FILL_MAX_QL + _EPS
                    and notated_slot > ev.element.duration.quarterLength
                    and _alone(events, ev, ev.onset + notated_slot)
                ):
                    ev.element.duration.quarterLength = notated_slot
        elif (
            ratio >= TENUTO_MIN_RATIO
            and median_ratio < TENUTO_CONTEXT_MAX_RATIO
            and _strong_beat(part, group[0].onset)
        ):
            for ev in group:
                if not _has_articulation(ev.element, "Tenuto"):
                    ev.element.articulations.append(articulations.Tenuto())
                    counts.tenuto += 1


def _has_articulation(element: Any, name: str) -> bool:
    return any(type(a).__name__ == name for a in element.articulations)


def _alone(events: list[_Event], ev: _Event, until: float) -> bool:
    """No other notated note sounds between ``ev``'s onset and ``until``."""
    for other in events:
        if other is ev:
            continue
        other_end = other.onset + float(other.element.duration.quarterLength)
        if other.onset < until - _EPS and other_end > ev.onset + _EPS:
            return False
    return True


# -- slurs ---------------------------------------------------------------------


def _add_slurs(part: Any, events: list[_Event], counts: ExpressionCounts) -> set[int]:
    """Slur each run of legato-overlapping single notes; returns the ids of
    the elements under a slur."""
    from music21 import spanner

    groups = _groups(events)
    line = [g[0] if len(g) == 1 and g[0].single else None for g in groups]
    # The latest end of every note before each group: a note still sounding
    # from further back means the line is not one voice there.
    before_end: list[float] = []
    latest = float("-inf")
    for g in groups:
        before_end.append(latest)
        latest = max([latest, *(ev.raw_end for ev in g)])

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
        _add_spanner(part, spanner.Slur(notes))
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


def raw_for(source_path: Any) -> Any:
    """The MIDI at ``source_path`` with the times it was played at, for
    :func:`add_expression`'s ``raw``; None when it cannot be read.

    music21's MIDI reader rounds every onset and length to the notation grid
    by default (``quantizePost``), so a note held for 0.4 of a beat reads as
    0.5 and its staccato is gone before anything looks at it. This read turns
    that off and lays the parts out the way :func:`.midi_read.read_midi` does,
    so its parts line up with the sheet's one for one.
    """
    from music21 import converter, stream

    from .midi_read import _flat_part

    try:
        parsed = converter.parse(str(source_path), forceSource=True, quantizePost=False)
        raw = stream.Score()
        parts = list(parsed.parts) if isinstance(parsed, stream.Score) else [parsed]
        for part in parts:
            raw.insert(0, _flat_part(part))
        return raw
    except Exception as exc:  # expression is best-effort
        log.debug("expression: could not re-read %s: %s", source_path, exc)
        return None


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

    @property
    def has_dynamics(self) -> bool:
        return bool(self.marks or self.wedges or self.accents)

    def _mark_before(self, offset: float) -> tuple[float, float]:
        """(offset, velocity) of the last level at or before ``offset``."""
        at, velocity = float("-inf"), float(LEVEL_VELOCITY[DEFAULT_LEVEL])
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
        velocity = self.level_at(offset)
        for at, accent_velocity in self.accents.items():
            if abs(at - offset) < _EPS:
                velocity = max(velocity, accent_velocity)
        velocity += _accent_boost(element)
        return int(round(max(1.0, min(127.0, velocity))))

    def cc11(self, onsets: Iterable[float]) -> list[tuple[float, int]]:
        """The level curve as ``(offset, value)`` points: one at each onset,
        and every :data:`HAIRPIN_CC_STEP_QL` through each hairpin, with
        repeated values dropped."""
        if not self.has_dynamics:
            return []
        times = set(float(t) for t in onsets)
        times.update(at for at, _v in self.marks)
        for wedge in self.wedges:
            t = wedge.start
            while t <= wedge.end + _EPS:
                times.add(round(t, 6))
                t += HAIRPIN_CC_STEP_QL
        points: list[tuple[float, int]] = []
        for t in sorted(times):
            value = int(round(max(0.0, min(127.0, self.level_at(t)))))
            if not points or points[-1][1] != value:
                points.append((t, value))
        return points


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
