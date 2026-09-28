"""Parse notated scores into piano-roll note batches.

Uses music21 (a core dependency). Every note comes back on the piano roll's
own clock, 960 ticks to the quarter note (:data:`PPQ`), the resolution the roll
stores and a MIDI export writes, so a triplet, a quintuplet or a septuplet
keeps the tick it has in the score:

    tick  = offset_in_quarters   * PPQ
    ticks = duration_in_quarters * PPQ   (>= 1)

``step`` and ``length`` (16th notes, ``tick / 240``) ride beside them for
readers that count steps. Offsets are in quarter notes, so the grid lines up
whatever the score's metronome marks say.

The score's time comes back whole: every time signature at its tick
(``time_signatures``, additive groupings such as 2+2+3/8 included), the pickup
before bar 1 (``pickup_ticks``), and every tempo mark (``tempos``), on the
note onset or bar line nearest where the score puts it (within an eighth;
else on the nearest 32nd): a metronome mark with a number is exact;
a mark without one, or a tempo word (Allegro, Andante, Presto...), takes the
tempo music21 reads for the word and says so (``implicit``). A word music21
does not read as a tempo is not one. ``bpm`` and ``time_signature`` (the first
of each) stay for older readers.

Each part is one track with the instrument the score names from the orchestral
registry (:func:`backend.modules.notation.instruments.match_music21`), its
General MIDI program and whether it is percussion. On the way in:

- chord symbols (``<harmony>``) are left out: they are for players to read,
  not notes to play;
- unpitched percussion notes land on kit keys: the key the file itself gives
  the note's instrument (MusicXML ``<midi-unpitched>``), else the key of the
  part's registry instrument (a snare drum part is key 38), else the drum-set
  staff position (bass drum on F4, snare on C5, hi-hat as an x on G5...);
- grace notes get time: a group of them sounds on the beat, a 32nd each and
  together at most half of the note they lead into, which starts that much
  later; a MusicXML ``steal-time-previous`` puts them before the beat;
- ornaments are played out with music21 (trills, mordents, turns, tremolos and
  their kin), on the notes of the key the note sits in;
- dynamics set the velocity of the notes after them (pp 32, p 44, mf 70, f 89,
  ff 108, from music21's volume scalars), a sforzando only the notes it
  marks; a note's own velocity in the file wins, and a note before any
  dynamic keeps 90, as before.

Every pitch is the pitch that sounds. A part for a transposing instrument is
written at the pitch its player reads, which its ``<transpose>`` puts a whole
step above the sound for a B-flat clarinet or trumpet, a minor third above for
a clarinet in A, a fifth above for a horn in F, an octave below for a piccolo
and an octave above for a contrabass. A sheet an older build of the app wrote
holds those parts at the pitch they sound (see
:mod:`backend.modules.notation.sheet_pitch`). The roll plays what it holds.
"""

from __future__ import annotations

import copy
import logging
import tempfile
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional
from xml.etree import ElementTree

log = logging.getLogger(__name__)

# Symbolic formats music21 can read that we treat as "sheet" sources. MIDI is
# included so the endpoint is complete; the frontend parses .mid locally and only
# routes true notation formats here.
SHEET_SUFFIXES = (".musicxml", ".mxl", ".xml", ".abc", ".krn", ".mid", ".midi")

#: Ticks to the quarter note: the piano roll's own resolution.
PPQ = 960
#: 16th-note grid — one quarter note is four steps.
STEPS_PER_QUARTER = 4
TICKS_PER_STEP = PPQ // STEPS_PER_QUARTER

#: The longest a grace note lasts, in quarter notes (a 32nd).
GRACE_QL = 0.125
#: The most of its principal note a group of grace notes takes.
GRACE_SHARE = 0.5
#: The velocity of a note no dynamic reaches.
DEFAULT_VELOCITY = 90
#: A tempo mark lands on the note onset or bar line nearest it within an
#: eighth note (TEMPO_ANCHOR_TICKS), else on the nearest 32nd
#: (TEMPO_SNAP_TICKS): a MusicXML direction's <offset> only places its words
#: on the page, yet music21 moves the mark by it, which put an "Andante" four
#: ticks before its bar line and a word written a 16th left of its note a 16th
#: early.
TEMPO_ANCHOR_TICKS = PPQ // 2
TEMPO_SNAP_TICKS = PPQ // 8
#: A tempo when the score marks none at its start.
DEFAULT_BPM = 120.0

#: Dynamics that mark one attack rather than a level: they set the velocity of
#: the notes they sit on, and the level after them is the one before (a
#: forte-piano's is piano).
_MOMENTARY_DYNAMICS = {
    "sf",
    "sfz",
    "sffz",
    "fz",
    "rfz",
    "rf",
    "sfp",
    "sfpp",
    "fp",
    "pf",
}
_AFTER_MOMENTARY = {"sfp": "p", "sfpp": "pp", "fp": "p", "pf": "f"}

#: Drum-set staff positions (five-line percussion staff, standard drum-set
#: notation) to General MIDI drum keys, by (display step, octave, notehead);
#: a notehead of None matches any.
_DRUM_SET_POSITIONS: dict[tuple[str, int, Optional[str]], int] = {
    ("F", 4, None): 36,  # bass drum
    ("E", 4, None): 35,  # second bass drum
    ("D", 4, "x"): 44,  # hi-hat with the foot
    ("D", 4, None): 44,
    ("A", 4, None): 41,  # floor tom
    ("B", 4, None): 45,  # low tom
    ("C", 5, "x"): 37,  # side stick
    ("C", 5, None): 38,  # snare
    ("D", 5, None): 47,  # mid tom
    ("E", 5, None): 48,  # high tom
    ("F", 5, "x"): 51,  # ride cymbal
    ("F", 5, None): 51,
    ("G", 5, "circle-x"): 46,  # open hi-hat
    ("G", 5, "x"): 42,  # closed hi-hat
    ("G", 5, None): 42,
    ("A", 5, "x"): 49,  # crash cymbal
    ("A", 5, None): 49,
    ("B", 5, "x"): 57,  # second crash
}
#: The key an unpitched note takes when nothing else names one: the snare.
_FALLBACK_KIT_KEY = 38


def _fmt_for_suffix(suffix: str) -> str:
    s = suffix.lower().lstrip(".")
    if s in ("musicxml", "mxl", "xml"):
        return "musicxml"
    if s == "abc":
        return "abc"
    if s == "krn":
        return "humdrum"
    if s in ("mid", "midi"):
        return "midi"
    return s or "musicxml"


def _part_instrument(part: Any) -> dict[str, Any]:
    """The instrument a score part names, as the roll's part takes it.

    ``instrument`` is the orchestral registry id
    (:func:`backend.modules.notation.instruments.match_music21`: the part's or
    instrument's name, else its music21 class, else its MIDI program), or None.
    ``program`` is the registry record's General MIDI program, else the
    music21 instrument's own, else None. ``percussion`` is True for an
    unpitched percussion part or one on MIDI channel 10, which the roll puts
    on the percussion channel.
    """
    from backend.modules.notation.instruments import match_music21

    try:
        inst = part.getInstrument(returnDefault=False)
    except Exception:  # noqa: BLE001 - a bare stream has no instrument to read
        inst = None
    if inst is None:
        return {"instrument": None, "program": None, "percussion": False}
    record = match_music21(inst)
    own_program = getattr(inst, "midiProgram", None)
    program = record.program if record is not None else own_program
    channel = getattr(inst, "midiChannel", None)
    percussion = bool(
        (record is not None and record.percussion)
        or type(inst).__name__ == "UnpitchedPercussion"
        or channel == 9
    )
    return {
        "instrument": record.id if record is not None else None,
        "program": int(program) if program is not None else None,
        "percussion": percussion,
    }


def _part_kit_key(part: Any) -> Optional[int]:
    """The kit key a one-instrument percussion part plays (a snare drum part's
    38): its registry record's, else music21's General MIDI percussion key."""
    from backend.modules.notation.instruments import match_music21

    try:
        inst = part.getInstrument(returnDefault=False)
    except Exception:  # noqa: BLE001 - a bare stream has no instrument to read
        return None
    if inst is None:
        return None
    record = match_music21(inst)
    if record is not None and record.kit_pitch is not None:
        return int(record.kit_pitch)
    if record is not None and record.id == "drum-kit":
        return None
    key = getattr(inst, "percMapPitch", None)
    return int(key) if isinstance(key, int) else None


# ── MusicXML unpitched keys ─────────────────────────────────────────────────


def _musicxml_root(src: Path) -> Optional[ElementTree.Element]:
    """The ``<score-partwise>`` of a MusicXML or compressed .mxl file, or None."""
    suffix = src.suffix.lower()
    try:
        if suffix == ".mxl":
            with zipfile.ZipFile(src) as zf:
                name = None
                if "META-INF/container.xml" in zf.namelist():
                    container = ElementTree.fromstring(
                        zf.read("META-INF/container.xml")
                    )
                    for el in container.iter():
                        if el.tag.endswith("rootfile") and el.get("full-path"):
                            name = el.get("full-path")
                            break
                if name is None:
                    name = next(
                        (
                            n
                            for n in zf.namelist()
                            if n.lower().endswith((".xml", ".musicxml"))
                            and not n.startswith("META-INF")
                        ),
                        None,
                    )
                if name is None:
                    return None
                return ElementTree.fromstring(zf.read(name))
        if suffix in (".musicxml", ".xml"):
            return ElementTree.parse(src).getroot()
    except (OSError, zipfile.BadZipFile, ElementTree.ParseError, KeyError) as exc:
        log.debug("sheetimport: no MusicXML percussion keys from %s: %s", src.name, exc)
    return None


def _unpitched_keys(src: Path) -> list[dict[tuple[str, int, Optional[str]], int]]:
    """For each ``<part>`` of a MusicXML file, in order: the kit key of each
    unpitched staff position, by (display step, octave, notehead) and by
    (display step, octave, None), read from the note's ``<instrument>`` and
    that instrument's ``<midi-unpitched>`` (1-based in the file). A part that
    has one unpitched instrument gives it to notes that name none."""
    root = _musicxml_root(src)
    if root is None:
        return []
    keys_by_instrument: dict[str, int] = {}
    part_instruments: dict[str, list[int]] = {}
    for score_part in root.iter("score-part"):
        pid = score_part.get("id") or ""
        own: list[int] = []
        for mi in score_part.iter("midi-instrument"):
            unpitched = mi.findtext("midi-unpitched")
            if unpitched is None:
                continue
            try:
                key = int(unpitched.strip()) - 1
            except ValueError:
                continue
            if 0 <= key <= 127:
                keys_by_instrument[mi.get("id") or ""] = key
                own.append(key)
        part_instruments[pid] = own
    out: list[dict[tuple[str, int, Optional[str]], int]] = []
    for part in root.iter("part"):
        pid = part.get("id") or ""
        only = part_instruments.get(pid, [])
        mapping: dict[tuple[str, int, Optional[str]], int] = {}
        for n in part.iter("note"):
            unp = n.find("unpitched")
            if unp is None:
                continue
            step = (unp.findtext("display-step") or "").strip().upper()
            try:
                octave = int((unp.findtext("display-octave") or "").strip())
            except ValueError:
                continue
            inst = n.find("instrument")
            key = (
                keys_by_instrument.get(inst.get("id") or "")
                if inst is not None
                else None
            )
            if key is None and len(only) == 1:
                key = only[0]
            if key is None or not step:
                continue
            head = (n.findtext("notehead") or "normal").strip()
            mapping.setdefault((step, octave, head), key)
            mapping.setdefault((step, octave, None), key)
        out.append(mapping)
    return out


def _unpitched_key(
    el: Any,
    file_keys: dict[tuple[str, int, Optional[str]], int],
    part_key: Optional[int],
) -> tuple[int, bool]:
    """The kit key of an unpitched note, and whether anything named it (False
    means the snare was the last resort)."""
    step = str(getattr(el, "displayStep", "") or "").upper()
    try:
        octave = int(getattr(el, "displayOctave", 4))
    except (TypeError, ValueError):
        octave = 4
    head = str(getattr(el, "notehead", "normal") or "normal")
    stored = getattr(el, "storedInstrument", None)
    stored_key = getattr(stored, "percMapPitch", None) if stored is not None else None
    for candidate in (
        file_keys.get((step, octave, head)),
        file_keys.get((step, octave, None)),
        stored_key if isinstance(stored_key, int) else None,
        part_key,
        _DRUM_SET_POSITIONS.get((step, octave, head)),
        _DRUM_SET_POSITIONS.get((step, octave, None)),
    ):
        if candidate is not None and 0 <= int(candidate) <= 127:
            return int(candidate), True
    return _FALLBACK_KIT_KEY, False


# ── time: signatures, pickup, tempo marks ───────────────────────────────────


def _tick(ql: float) -> int:
    return max(0, int(round(float(ql) * PPQ)))


def _signature_groups(ts: Any) -> list[int]:
    """An additive signature's groups in units of its denominator (2+2+3/8 is
    [2, 2, 3]); [] for a signature that is not additive."""
    seq = getattr(ts, "displaySequence", None)
    try:
        terms = [seq[i] for i in range(len(seq))] if seq is not None else []
    except (TypeError, IndexError):
        return []
    if len(terms) < 2:
        return []
    den = int(ts.denominator)
    groups: list[int] = []
    for term in terms:
        try:
            units = int(term.numerator) * den / int(term.denominator)
        except (AttributeError, TypeError, ZeroDivisionError):
            return []
        if units != int(units) or units < 1:
            return []
        groups.append(int(units))
    return groups if sum(groups) == int(ts.numerator) else []


def _time_signatures(flat: Any) -> list[dict[str, Any]]:
    """Every time signature of a part at its tick, a repeat of the one before left out."""
    from music21 import meter

    out: list[dict[str, Any]] = []
    for ts in flat.getElementsByClass(meter.TimeSignature):
        try:
            entry = {
                "tick": _tick(ts.offset),
                "num": int(ts.numerator),
                "den": int(ts.denominator),
                "groups": _signature_groups(ts),
                "measure": getattr(ts, "measureNumber", None),
            }
        except (TypeError, ValueError, AttributeError):
            continue
        if out and out[-1]["tick"] == entry["tick"]:
            out[-1] = entry
            continue
        if out and (out[-1]["num"], out[-1]["den"], out[-1]["groups"]) == (
            entry["num"],
            entry["den"],
            entry["groups"],
        ):
            continue
        out.append(entry)
    return out or [{"tick": 0, "num": 4, "den": 4, "groups": [], "measure": None}]


def _pickup_ql(part: Any) -> float:
    """Quarter notes before bar 1: the first measure's length when it is an
    anacrusis (music21 pads it on the left, or it is shorter than its bar)."""
    from music21 import stream

    measures = (
        part.getElementsByClass(stream.Measure)
        if hasattr(part, "getElementsByClass")
        else []
    )
    first = measures.first() if hasattr(measures, "first") else None
    if first is None:
        return 0.0
    try:
        bar = float(first.barDuration.quarterLength)
        padding = float(getattr(first, "paddingLeft", 0) or 0)
        if padding > 1e-9 and padding < bar:
            return bar - padding
        length = float(first.duration.quarterLength)
        if first.number == 0 and 0 < length < bar - 1e-9:
            return length
    except (AttributeError, TypeError, ValueError):
        return 0.0
    return 0.0


def _tempo_word(text: str) -> Optional[float]:
    """The tempo music21 reads for a tempo word (Allegro 132, Andante 72), or None."""
    from music21 import tempo

    words = str(text or "").strip()
    if not words:
        return None
    try:
        mark = tempo.MetronomeMark(text=words)
        return (
            float(mark.number)
            if mark.number is not None and mark.numberImplicit
            else None
        )
    except Exception:  # noqa: BLE001 - a word music21 cannot read is not a tempo
        return None


def _anchor(tick: int, anchors: list[int]) -> int:
    """``tick`` moved to the nearest of ``anchors`` (sorted note onsets and bar
    lines) within TEMPO_ANCHOR_TICKS, else to the nearest 32nd."""
    import bisect

    i = bisect.bisect_left(anchors, tick)
    near = [
        a
        for a in (
            anchors[i - 1] if i > 0 else None,
            anchors[i] if i < len(anchors) else None,
        )
        if a is not None
    ]
    best = min(near, key=lambda a: abs(a - tick), default=None)
    if best is not None and abs(best - tick) <= TEMPO_ANCHOR_TICKS:
        return best
    return int(round(tick / TEMPO_SNAP_TICKS)) * TEMPO_SNAP_TICKS


def _tempo_marks(
    flats: list[Any], anchors: Optional[list[int]] = None
) -> list[dict[str, Any]]:
    """Every tempo mark of the score at its tick, in tick order: a metronome
    mark with a number exactly (``implicit`` False); a mark without one, or a
    tempo word, at the tempo music21 reads for its words (``implicit`` True).
    Each lands on the note onset or bar line nearest it (:func:`_anchor`). At
    one tick a number beats a word and the first part beats the others; a mark
    that repeats the tempo before it is left out."""
    from music21 import expressions, tempo

    found: dict[int, dict[str, Any]] = {}
    anchor_ticks = sorted(set(anchors or []))

    def offer(tick: int, bpm: float, text: str, implicit: bool) -> None:
        if not (bpm > 0):
            return
        tick = _anchor(tick, anchor_ticks)
        held = found.get(tick)
        if held is None or (held["implicit"] and not implicit):
            found[tick] = {
                "tick": tick,
                "bpm": round(float(bpm), 3),
                "text": text,
                "implicit": implicit,
            }

    for flat in flats:
        words_at: dict[int, str] = {}
        for te in flat.getElementsByClass(expressions.TextExpression):
            words_at.setdefault(_tick(te.offset), str(te.content or ""))
        for mm in flat.getElementsByClass(tempo.MetronomeMark):
            tick = _tick(mm.offset)
            text = str(mm.text or "")
            if mm.number is not None and not mm.numberImplicit:
                try:
                    bpm = float(mm.getQuarterBPM() or mm.number)
                except Exception:  # noqa: BLE001 - fall back to the raw number
                    bpm = float(mm.number)
                offer(tick, bpm, text, False)
                continue
            implicit = _tempo_word(text) or _tempo_word(words_at.get(tick, ""))
            if implicit is not None:
                offer(tick, implicit, text or words_at.get(tick, ""), True)
        for tick, words in words_at.items():
            implicit = _tempo_word(words)
            if implicit is not None:
                offer(tick, implicit, words, True)
    out: list[dict[str, Any]] = []
    for mark in sorted(found.values(), key=lambda m: m["tick"]):
        if out and abs(out[-1]["bpm"] - mark["bpm"]) < 1e-9:
            continue
        out.append(mark)
    return out


# ── notes ───────────────────────────────────────────────────────────────────


@dataclass(eq=False)
class _Event:
    """One note or chord of a part on its way out: where and how long in
    quarter notes, what it sounds, and what music21 says about it. Compared by
    identity, so two grace notes alike are still two."""

    offset: float
    length: float
    pitches: list[int]
    velocity: int
    grace: bool = False
    before_beat: bool = False
    element: Any = None
    ornaments: list[Any] = field(default_factory=list)


def _dynamic_velocity(value: str, scalar: float) -> int:
    return max(1, min(127, int(round(float(scalar) * 127))))


def _velocity_timeline(flat: Any) -> tuple[list[tuple[float, int]], dict[float, int]]:
    """A part's dynamic levels as (offset, velocity) in offset order, and the
    velocity of each momentary accent (sf, sfz, fp...) by offset."""
    from music21 import dynamics

    levels: list[tuple[float, int]] = []
    accents: dict[float, int] = {}
    for d in flat.getElementsByClass(dynamics.Dynamic):
        value = str(getattr(d, "value", "") or "")
        try:
            vel = _dynamic_velocity(value, d.volumeScalar)
        except (TypeError, ValueError):
            continue
        off = float(d.offset)
        if value in _MOMENTARY_DYNAMICS:
            accents[off] = vel
            after = _AFTER_MOMENTARY.get(value)
            if after:
                levels.append(
                    (
                        off,
                        _dynamic_velocity(after, dynamics.Dynamic(after).volumeScalar),
                    )
                )
            continue
        levels.append((off, vel))
    levels.sort(key=lambda x: x[0])
    return levels, accents


def _level_at(levels: list[tuple[float, int]], offset: float) -> int:
    """The dynamic level in force at ``offset``: the last one at or before it, else DEFAULT_VELOCITY."""
    vel = DEFAULT_VELOCITY
    lo, hi = 0, len(levels)
    while lo < hi:
        mid = (lo + hi) // 2
        if levels[mid][0] <= offset + 1e-9:
            lo = mid + 1
        else:
            hi = mid
    if lo > 0:
        vel = levels[lo - 1][1]
    return vel


def _place_graces(events: list[_Event]) -> tuple[list[_Event], int]:
    """Give each group of grace notes its time before the note it leads into:
    on the beat, a 32nd each and together at most half of that note, which
    starts that much later (before the beat when the file says so). A grace
    note with no note after it keeps a 32nd where it is."""
    out: list[_Event] = []
    pending: list[_Event] = []
    count = 0
    for ev in events:
        if ev.grace:
            pending.append(ev)
            continue
        if pending:
            group = [g for g in pending if abs(g.offset - ev.offset) < 1e-9]
            for g in pending:
                if g not in group:
                    g.length = GRACE_QL
                    out.append(g)
            if group:
                each = min(GRACE_QL, ev.length * GRACE_SHARE / len(group))
                if any(g.before_beat for g in group):
                    start = max(0.0, ev.offset - each * len(group))
                    for i, g in enumerate(group):
                        g.offset = start + i * each
                        g.length = each
                        out.append(g)
                else:
                    for i, g in enumerate(group):
                        g.offset = ev.offset + i * each
                        g.length = each
                        out.append(g)
                    ev.offset += each * len(group)
                    ev.length -= each * len(group)
                count += len(group)
            pending = []
        out.append(ev)
    for g in pending:
        g.length = GRACE_QL
        out.append(g)
        count += 1
    return out, count


def _realize_ornament(ev: _Event) -> Optional[list[_Event]]:
    """``ev`` played out through its first ornament (music21's realization, on
    the notes of the key it sits in), fitted to the time it has now; None
    when it has none or music21 cannot play it out."""
    from music21 import key

    if not ev.ornaments or ev.element is None:
        return None
    orn = ev.ornaments[0]
    try:
        n = copy.deepcopy(ev.element)
        n.quarterLength = max(ev.length, GRACE_QL)
        ks = ev.element.getContextByClass(key.KeySignature)
        pre, main, post = orn.realize(n, keySig=ks)
        seq = list(pre) + ([main] if main is not None else []) + list(post)
    except Exception as exc:  # noqa: BLE001 - an ornament music21 cannot realize plays as its note
        log.debug("sheetimport: ornament %s not realized: %s", type(orn).__name__, exc)
        return None
    total = sum(float(x.quarterLength) for x in seq)
    if not seq or total <= 0:
        return None
    scale = ev.length / total
    out: list[_Event] = []
    at = ev.offset
    for x in seq:
        length = float(x.quarterLength) * scale
        out.append(
            _Event(
                offset=at,
                length=length,
                pitches=[int(x.pitch.midi)],
                velocity=ev.velocity,
            )
        )
        at += length
    return out


def parse_score_bytes(data: bytes, filename: str) -> dict[str, Any]:
    """Parse uploaded score bytes. Writes to a temp file with the original
    suffix so music21 detects the format (and can unzip .mxl)."""
    suffix = Path(filename).suffix.lower() or ".musicxml"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tf:
        tf.write(data)
        tmp = Path(tf.name)
    try:
        return parse_score_path(str(tmp), display_name=Path(filename).stem)
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass


def parse_score_path(path: str, display_name: str | None = None) -> dict[str, Any]:
    """Parse a score on disk into a piano-roll note batch."""
    src = Path(path)
    if not src.exists():
        raise FileNotFoundError(f"Score not found: {path}")

    try:
        from music21 import chord as m21chord
        from music21 import converter, expressions, harmony
        from music21 import key as m21key
        from music21 import note as m21note
    except ImportError as e:  # pragma: no cover - music21 is a declared dependency
        raise RuntimeError("music21 is not installed") from e

    score = converter.parse(str(src))
    # A sheet engraved here prints its tempo as a whole number and carries the
    # exact tempo in <sound tempo>, which music21 does not read back.
    from backend.modules.notation.sheet_pitch import mark_legacy_sounding_pitch
    from backend.modules.notation.tempo_marks import restore_sounding_tempi

    restore_sounding_tempi(score, src)

    # music21 marks a part that carries a <transpose> as written pitch; move its
    # notes, and its key signatures, to the pitch they sound. A sheet an older
    # build of the app wrote holds sounding pitch under its <transpose>, and is
    # marked so the move leaves it alone.
    mark_legacy_sounding_pitch(score, src)
    score.toSoundingPitch(inPlace=True)

    # The pickup is read before repeats are played out, from the score as written.
    written_parts = list(getattr(score, "parts", []) or [])
    pickup = _pickup_ql(written_parts[0]) if written_parts else 0.0

    # Play out repeats / D.C. / D.S. so the imported roll matches the full piece.
    try:
        expanded = score.expandRepeats()
        if expanded is not None:
            score = expanded
    except Exception as exc:  # noqa: BLE001 - not every score defines repeats
        log.debug("sheetimport: expandRepeats skipped for %s: %s", src.name, exc)

    flat = score.flatten()

    # Per-part tracks; fall back to the whole score as a single part.
    parts = list(getattr(score, "parts", []) or [])
    if not parts:
        parts = [score]
    part_flats = [p.flatten() for p in parts]

    # Every time signature (the first part's: the roll has one meter map; the
    # whole score's when that part has none) and every tempo mark, each mark on
    # the note onset or bar line it belongs to.
    from music21 import meter as m21meter

    ts_source = (
        part_flats[0]
        if part_flats[0].getElementsByClass(m21meter.TimeSignature)
        else flat
    )
    time_signatures = _time_signatures(ts_source)
    anchors = [
        _tick(el.offset)
        for pf in part_flats
        for el in pf.notes
        if not el.duration.isGrace
    ]
    try:
        from music21 import stream as m21stream

        anchors += [
            _tick(m.offset) for m in parts[0].getElementsByClass(m21stream.Measure)
        ]
    except Exception:  # noqa: BLE001 - a bare stream has no measures; onsets anchor alone
        pass
    tempos = _tempo_marks(part_flats, anchors)
    bpm = next((t["bpm"] for t in tempos if t["tick"] == 0), DEFAULT_BPM)
    time_sig = [time_signatures[0]["num"], time_signatures[0]["den"]]

    # Key signature (informational).
    detected_key = ""
    try:
        ksigs = list(flat.getElementsByClass(m21key.KeySignature))
        if ksigs:
            first = ksigs[0]
            as_key = first.asKey() if hasattr(first, "asKey") else None
            detected_key = str(as_key) if as_key is not None else str(first)
    except Exception:  # noqa: BLE001 - key detection is best-effort
        detected_key = ""

    # The file's own kit keys, read from its XML only when an unpitched note needs them.
    file_keys: Optional[list[dict[tuple[str, int, Optional[str]], int]]] = None

    def keys_of(part_index: int) -> dict[tuple[str, int, Optional[str]], int]:
        nonlocal file_keys
        if file_keys is None:
            file_keys = _unpitched_keys(src)
        return file_keys[part_index] if part_index < len(file_keys) else {}

    tracks: list[dict[str, Any]] = []
    total_notes = 0
    stats = {
        "grace_notes": 0,
        "ornaments": 0,
        "chord_symbols_skipped": 0,
        "unpitched": 0,
        "unmapped_unpitched": 0,
    }
    for idx, part in enumerate(parts):
        # Strip ties so a note held across a barline (or any tie) becomes ONE
        # sustained note event, not several re-articulated ones — otherwise the
        # roll would re-attack every tied note and change the sound.
        try:
            pflat = part.flatten().stripTies()
        except Exception as exc:  # noqa: BLE001 - stripTies is best-effort
            log.debug("sheetimport: stripTies skipped for part %d: %s", idx, exc)
            pflat = part.flatten()
        try:
            name = str(getattr(part, "partName", "") or "")
        except Exception:  # noqa: BLE001
            name = ""

        levels, accents = _velocity_timeline(pflat)
        part_kit = _part_kit_key(part)
        events: list[_Event] = []
        # Note, Chord and Unpitched elements; a ChordSymbol is a Chord too.
        for el in pflat.notes:
            if isinstance(el, harmony.Harmony):
                # A chord symbol is read by players, not played: it is not a note.
                stats["chord_symbols_skipped"] += 1
                continue
            off = float(el.offset)
            if off < 0:
                continue
            if isinstance(el, m21chord.ChordBase):
                # A chord, or a percussion chord of unpitched strokes.
                pitches: list[int] = []
                for sub in el.notes:
                    if isinstance(sub, m21note.Unpitched):
                        k, named = _unpitched_key(sub, keys_of(idx), part_kit)
                        stats["unpitched"] += 1
                        stats["unmapped_unpitched"] += 0 if named else 1
                        pitches.append(k)
                    else:
                        pitches.append(int(sub.pitch.midi))
            elif isinstance(el, m21note.Unpitched):
                k, named = _unpitched_key(el, keys_of(idx), part_kit)
                stats["unpitched"] += 1
                stats["unmapped_unpitched"] += 0 if named else 1
                pitches = [k]
            elif isinstance(el, m21note.Note):
                pitches = [int(el.pitch.midi)]
            else:
                continue
            vel: Optional[int] = None
            try:
                if el.volume is not None and el.volume.velocity is not None:
                    vel = int(el.volume.velocity)
            except Exception:  # noqa: BLE001 - many scores carry no velocity
                vel = None
            if vel is None:
                vel = next(
                    (v for o, v in accents.items() if abs(o - off) < 1e-9), None
                ) or _level_at(levels, off)
            grace = bool(el.duration.isGrace)
            steal_previous = (
                getattr(el.duration, "stealTimePrevious", None) if grace else None
            )
            ornaments = (
                [e for e in el.expressions if isinstance(e, expressions.Ornament)]
                if isinstance(el, m21note.Note) and not grace
                else []
            )
            events.append(
                _Event(
                    offset=off,
                    length=float(el.duration.quarterLength or 0),
                    pitches=pitches,
                    velocity=max(1, min(127, vel)),
                    grace=grace,
                    before_beat=bool(steal_previous),
                    element=el,
                    ornaments=ornaments,
                )
            )

        placed, graces = _place_graces(events)
        stats["grace_notes"] += graces
        played: list[_Event] = []
        for ev in placed:
            realized = _realize_ornament(ev) if ev.ornaments else None
            if realized:
                stats["ornaments"] += 1
                played.extend(realized)
            else:
                played.append(ev)

        notes_out: list[dict[str, Any]] = []
        for ev in played:
            tick = _tick(ev.offset)
            ticks = max(1, int(round(ev.length * PPQ)))
            for midi in ev.pitches:
                notes_out.append(
                    {
                        "pitch": int(midi),
                        "tick": tick,
                        "ticks": ticks,
                        "step": tick / TICKS_PER_STEP,
                        "length": max(1.0 / TICKS_PER_STEP, ticks / TICKS_PER_STEP),
                        "velocity": ev.velocity,
                    }
                )
        notes_out.sort(key=lambda n: (n["tick"], n["pitch"]))
        total_notes += len(notes_out)
        tracks.append(
            {
                "name": name or f"Part {idx + 1}",
                "notes": notes_out,
                **_part_instrument(part),
            }
        )

    return {
        "ok": True,
        "name": display_name or src.stem,
        "format": _fmt_for_suffix(src.suffix),
        "bpm": round(float(bpm), 3),
        "time_signature": time_sig,
        "detected_key": detected_key,
        "track_count": len(tracks),
        "note_count": total_notes,
        "tracks": tracks,
        "steps_per_quarter": STEPS_PER_QUARTER,
        "ppq": PPQ,
        "time_signatures": time_signatures,
        "pickup_ticks": _tick(pickup),
        "tempos": tempos,
        **stats,
    }
