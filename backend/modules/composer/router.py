"""FastAPI router for the composer module (prefix from module.json: ``/api/composer``).

    GET  /                  capability report
    POST /plan              a roman-numeral phrase in a key, voiced in SATB,
                            optionally in a composer's style
    POST /check             voice-leading flags for parts in ticks
    POST /continuo          a figured bass realized in four parts
    POST /form              a form's movements and sections with their harmonic plans
    POST /form/realize      the same, every chord voiced in SATB, per section
    GET  /styles            the shipped composer style profiles, one line each
    GET  /styles/{id}       one style profile in full
    POST /profile           a style profile counted from music21 corpus pieces
                            or from a composition in the library
    POST /species           species counterpoint (1-5) against a cantus firmus
    POST /canon             a two-voice canon at an interval and time lag
    POST /fugue             a fugue exposition, episodes and stretto search
    POST /invertible-check  a two-voice pair checked as written and inverted

Notes go in and come out as ``{note, tick, ticks}`` at 960 ticks to the
quarter, the piano roll's PPQ. Meter maps are the roll's own
(``[{bar, meter: {num, den, groups}}]``, frontend/src/lib/meterMap.ts).

Every route is pure computation, but a request can keep the CPU busy for a
while, so the router takes the same gates as the project routes: no call
started by a page outside theDAW (``refuse_cross_site``), and a caller that is
this machine, the desktop shell or a paired phone
(``require_loopback_launch_or_pairing_token``).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from backend.lib.cross_site import (
    refuse_cross_site,
    require_loopback_launch_or_pairing_token,
)

# music21 loads on the first request, not at startup: the engine modules are
# imported inside the handlers.
from .spec import (
    CADENCES,
    CANTUS_FIRMI,
    COUNTERPOINT_RULES,
    DEFAULT_RANGES,
    FEATURES,
    FORMS,
    FUGUE_VOICES,
    HARMONIC_RHYTHMS,
    INVERTIBLE_AT,
    MODES,
    PPQ,
    RONDO_PATTERNS,
    RULES,
    SPECIES,
)
from .stylebook import ProfileError, list_styles, load_style, style_ids

router = APIRouter(
    dependencies=[
        Depends(refuse_cross_site),
        Depends(require_loopback_launch_or_pairing_token),
    ]
)

MAX_BARS = 64
MAX_PARTS = 8
MAX_NOTES = 4096
MAX_BASS = 256
# A form's bars: a single form up to MAX_FORM_BARS, a symphony's four movements
# together up to MAX_SYMPHONY_BARS. A 200-bar sonata voices in a few seconds.
MIN_FORM_BARS = 16
MAX_FORM_BARS = 400
MAX_SYMPHONY_BARS = 800
MAX_VARIATIONS = 12
MAX_PROFILE_WORKS = 40
MAX_CANTUS = 32
MAX_SUBJECT = 32
MAX_CANON_BARS = 32
BAR_TICKS = 4 * PPQ

Cadence = Literal[
    "authentic_perfect",
    "authentic_imperfect",
    "half",
    "plagal",
    "deceptive",
    "phrygian_half",
]
Feature = Literal["seventh", "applied", "neapolitan", "italian", "french", "german"]
Mode = Literal["major", "minor"]
Form = Literal[
    "sonata",
    "rondo",
    "theme_and_variations",
    "minuet_and_trio",
    "scherzo",
    "symphony",
]
ModalMode = Literal[
    "major", "minor", "ionian", "dorian", "phrygian", "lydian", "mixolydian", "aeolian"
]
CantusPreset = Literal[
    "fux_dorian", "fux_phrygian", "fux_mixolydian", "fux_aeolian", "fux_ionian"
]


class MeterIn(BaseModel):
    num: int = Field(ge=1, le=64)
    den: Literal[1, 2, 4, 8, 16, 32]
    groups: list[int] = Field(default_factory=list)


class MeterSegmentIn(BaseModel):
    bar: int = Field(ge=0)
    meter: MeterIn


class NoteIn(BaseModel):
    note: int = Field(ge=0, le=127)
    tick: int = Field(ge=0)
    ticks: int = Field(ge=1)


class FiguredNoteIn(NoteIn):
    figure: str = Field(default="", max_length=32)


class ChordIn(BaseModel):
    tick: int = Field(ge=0)
    figure: str = Field(min_length=1, max_length=32)
    key: Optional[str] = Field(default=None, max_length=32)


Range = tuple[int, int]


class PlanRequest(BaseModel):
    key: str = Field(default="C", max_length=32)
    mode: Optional[Mode] = None
    bars: int = Field(default=8, ge=2, le=MAX_BARS)
    meter_map: list[MeterSegmentIn] = Field(default_factory=list)
    seed: int = 0
    # Unset: authentic_perfect, or drawn from the style's cadences.
    cadence: Optional[Cadence] = None
    include: list[Feature] = Field(default_factory=list)
    modulate_to: Optional[str] = Field(default=None, max_length=32)
    # Unset: "pulse", or "style" when a style is given.
    harmonic_rhythm: Optional[Literal["pulse", "bar", "style"]] = None
    ranges: Optional[dict[str, Range]] = None
    style: Optional[str] = Field(default=None, max_length=64)


class ProfileRequest(BaseModel):
    """Count a profile from ``corpus`` piece ids (``GET /api/notation/corpus``)
    or from the MusicXML sheet of the library composition ``entry_id``."""

    corpus: list[str] = Field(default_factory=list, max_length=MAX_PROFILE_WORKS)
    entry_id: Optional[str] = Field(default=None, max_length=128)
    id: str = Field(default="custom", pattern=r"^[a-z0-9_-]{1,40}$")
    name: str = Field(default="", max_length=80)
    max_bars: int = Field(default=96, ge=4, le=400)


class CheckRequest(BaseModel):
    parts: dict[str, list[NoteIn]]
    order: Optional[list[str]] = None
    key: Optional[str] = Field(default=None, max_length=32)
    mode: Optional[Mode] = None
    chords: Optional[list[ChordIn]] = None
    ranges: Optional[dict[str, Range]] = None
    meter_map: list[MeterSegmentIn] = Field(default_factory=list)
    pickup_steps: float = Field(default=0, ge=0)


class ContinuoRequest(BaseModel):
    bass: list[FiguredNoteIn] = Field(min_length=1, max_length=MAX_BASS)
    key: str = Field(default="C", max_length=32)
    mode: Optional[Mode] = None
    ranges: Optional[dict[str, Range]] = None
    meter_map: list[MeterSegmentIn] = Field(default_factory=list)
    pickup_steps: float = Field(default=0, ge=0)


class FormRequest(BaseModel):
    form: Form = "sonata"
    key: str = Field(default="C", max_length=32)
    mode: Optional[Mode] = None
    seed: int = 0
    # A symphony's bars are its four movements together.
    bars: Optional[int] = Field(default=None, ge=MIN_FORM_BARS, le=MAX_SYMPHONY_BARS)
    # One meter and tempo for a single form; a symphony's movements keep their own.
    meter: Optional[MeterIn] = None
    tempo: Optional[float] = Field(default=None, ge=20, le=300)
    rondo: Literal["ABACA", "ABACABA"] = "ABACA"
    variations: Optional[int] = Field(default=None, ge=1, le=MAX_VARIATIONS)
    harmonic_rhythm: Literal["bar", "pulse"] = "bar"
    ranges: Optional[dict[str, Range]] = None


class SpeciesRequest(BaseModel):
    cantus: Optional[list[NoteIn]] = Field(default=None, max_length=MAX_CANTUS)
    preset: Optional[CantusPreset] = None
    key: Optional[str] = Field(default=None, max_length=32)
    mode: Optional[ModalMode] = None
    species: Literal[1, 2, 3, 4, 5] = 1
    position: Literal["above", "below"] = "above"
    seed: int = 0
    invertible: Optional[Literal[8, 10, 12]] = None
    start_tick: Optional[int] = Field(default=None, ge=0)


class CanonRequest(BaseModel):
    key: str = Field(default="C", max_length=32)
    mode: Optional[ModalMode] = None
    interval: int = Field(default=5, ge=-15, le=15)
    lag: int = Field(default=BAR_TICKS, ge=PPQ, le=4 * BAR_TICKS)
    bars: int = Field(default=8, ge=4, le=MAX_CANON_BARS)
    seed: int = 0
    transposition: Literal["diatonic", "real"] = "diatonic"
    rhythm: Literal["mixed", "halves", "quarters"] = "mixed"
    start_tick: int = Field(default=0, ge=0)


class FugueRequest(BaseModel):
    key: str = Field(default="C", max_length=32)
    mode: Optional[ModalMode] = None
    voices: Literal[2, 3, 4] = 3
    subject: Optional[list[NoteIn]] = Field(default=None, max_length=MAX_SUBJECT)
    subject_start: Literal["tonic", "dominant"] = "tonic"
    seed: int = 0
    episodes: int = Field(default=1, ge=0, le=2)
    countersubject: bool = True
    start_tick: int = Field(default=0, ge=0)


class InvertibleRequest(BaseModel):
    upper: list[NoteIn] = Field(min_length=1, max_length=MAX_NOTES)
    lower: list[NoteIn] = Field(min_length=1, max_length=MAX_NOTES)
    interval: Literal[8, 10, 12] = 8
    key: Optional[str] = Field(default=None, max_length=32)
    mode: Optional[ModalMode] = None


def _meter_map(segs: list[MeterSegmentIn]) -> list[dict[str, Any]]:
    return [s.model_dump() for s in segs]


def _ranges(r: Optional[dict[str, Range]]) -> Optional[dict[str, list[int]]]:
    if r is None:
        return None
    for name, (lo, hi) in r.items():
        if not (0 <= lo <= 127 and 0 <= hi <= 127):
            raise HTTPException(422, f"range for {name} must be MIDI notes 0-127")
    return {k: [lo, hi] for k, (lo, hi) in r.items()}


@router.get("")
@router.get("/")
def health() -> dict[str, Any]:
    return {
        "module": "composer",
        "ppq": PPQ,
        "cadences": list(CADENCES),
        "include": list(FEATURES),
        "harmonic_rhythms": list(HARMONIC_RHYTHMS),
        "styles": style_ids(),
        "rules": list(RULES),
        "ranges": {k: list(v) for k, v in DEFAULT_RANGES.items()},
        "forms": list(FORMS),
        "rondo_patterns": list(RONDO_PATTERNS),
        "species": list(SPECIES),
        "modes": list(MODES),
        "invertible_at": list(INVERTIBLE_AT),
        "cantus_firmi": {k: dict(v) for k, v in CANTUS_FIRMI.items()},
        "fugue_voices": {str(k): list(v) for k, v in FUGUE_VOICES.items()},
        "counterpoint_rules": list(COUNTERPOINT_RULES),
    }


@router.post("/plan")
def plan(req: PlanRequest) -> dict[str, Any]:
    from .harmony import plan_progression

    try:
        return plan_progression(
            req.key,
            req.mode,
            bars=req.bars,
            meter_map=_meter_map(req.meter_map),
            seed=req.seed,
            cadence=req.cadence,
            include=list(req.include),
            modulate_to=req.modulate_to,
            harmonic_rhythm=req.harmonic_rhythm,
            ranges=_ranges(req.ranges),
            style=req.style,
        )
    except ValueError as e:
        # PlanError is a ValueError: too few bars, a key that is not closely
        # related, a chord no voicing reaches, a style there is no profile of.
        raise HTTPException(422, str(e)) from e


@router.get("/styles")
def styles() -> dict[str, Any]:
    """The shipped style profiles: id, name, era, whether each was counted
    from scores or authored, and its basis."""
    return {"styles": list_styles()}


@router.get("/styles/{style_id}")
def style(style_id: str) -> dict[str, Any]:
    try:
        return load_style(style_id)
    except ProfileError as e:
        raise HTTPException(404, str(e)) from e


def _entry_sheet(entry_id: str) -> tuple[Path, str]:
    """The MusicXML sheet of a library composition: the imported one when it
    has one, else its newest."""
    from backend.modules.library.router import get_store

    store = get_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    sheets = store.db.list_notation_artifacts(entry_id, kind="musicxml")
    if not sheets:
        raise HTTPException(404, f"no MusicXML sheet for entry {entry_id!r}")
    imported = [a for a in sheets if a.get("engine") == "score-import"]
    chosen = (imported or sheets)[-1]
    path = Path(str(chosen.get("path") or ""))
    if not path.is_file():
        raise HTTPException(404, f"the sheet of entry {entry_id!r} is missing on disk")
    return path, str(chosen.get("id") or entry_id)


@router.post("/profile")
def profile(req: ProfileRequest) -> dict[str, Any]:
    """A style profile counted from scores (see profile.py), in the shape of
    the shipped ones, listing the works it was counted from."""
    from .profile import profile_from_corpus, profile_from_file

    if bool(req.corpus) == bool(req.entry_id):
        raise HTTPException(422, "give corpus piece ids or an entry_id, not both")
    try:
        if req.corpus:
            from backend.modules.sheetimport.corpus import resolve

            missing = [c for c in req.corpus if resolve(c) is None]
            if missing:
                raise HTTPException(404, f"no corpus piece {missing[0]!r}")
            return profile_from_corpus(
                req.corpus, style_id=req.id, name=req.name, max_bars=req.max_bars
            )
        path, work_id = _entry_sheet(str(req.entry_id))
        return profile_from_file(
            path, work_id, style_id=req.id, name=req.name, max_bars=req.max_bars
        )
    except ProfileError as e:
        raise HTTPException(422, str(e)) from e


@router.post("/check")
def check(req: CheckRequest) -> dict[str, Any]:
    from .voiceleading import check_parts, parse_key

    if not req.parts:
        raise HTTPException(422, "no parts to check")
    if len(req.parts) > MAX_PARTS:
        raise HTTPException(422, f"at most {MAX_PARTS} parts")
    if sum(len(v) for v in req.parts.values()) > MAX_NOTES:
        raise HTTPException(422, f"at most {MAX_NOTES} notes")
    try:
        k = parse_key(req.key, req.mode) if req.key else None
        flags = check_parts(
            {
                name: [n.model_dump() for n in notes]
                for name, notes in req.parts.items()
            },
            key=k,
            chords=[c.model_dump() for c in req.chords] if req.chords else None,
            ranges=_ranges(req.ranges),
            meter_map=_meter_map(req.meter_map),
            pickup_steps=req.pickup_steps,
            order=req.order,
        )
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    return {"flags": [f.as_dict() for f in flags], "count": len(flags)}


@router.post("/continuo")
def continuo(req: ContinuoRequest) -> dict[str, Any]:
    from .continuo import realize_continuo

    try:
        return realize_continuo(
            [n.model_dump() for n in req.bass],
            req.key,
            req.mode,
            ranges=_ranges(req.ranges),
            meter_map=_meter_map(req.meter_map),
            pickup_steps=req.pickup_steps,
        )
    except ValueError as e:
        raise HTTPException(422, str(e)) from e


def _form_opts(req: FormRequest) -> dict[str, Any]:
    if req.bars is not None and req.form != "symphony" and req.bars > MAX_FORM_BARS:
        raise HTTPException(422, f"a single form is at most {MAX_FORM_BARS} bars")
    return {
        "seed": req.seed,
        "bars": req.bars,
        "meter": req.meter.model_dump() if req.meter else None,
        "tempo": req.tempo,
        "rondo": req.rondo,
        "variations": req.variations,
        "harmonic_rhythm": req.harmonic_rhythm,
    }


@router.post("/form")
def form(req: FormRequest) -> dict[str, Any]:
    from .form import plan_form

    opts = _form_opts(req)
    try:
        return plan_form(req.form, req.key, req.mode, **opts)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e


@router.post("/form/realize")
def form_realize(req: FormRequest) -> dict[str, Any]:
    from .form import realize_form

    opts = _form_opts(req)
    try:
        return realize_form(
            req.form, req.key, req.mode, ranges=_ranges(req.ranges), **opts
        )
    except ValueError as e:
        raise HTTPException(422, str(e)) from e


@router.post("/species")
def species(req: SpeciesRequest) -> dict[str, Any]:
    from .counterpoint import species_counterpoint

    if req.cantus and req.preset:
        raise HTTPException(422, "send a cantus or a preset, not both")
    if req.preset:
        preset = CANTUS_FIRMI[req.preset]
        pitches = [int(p) for p in preset["notes"]]
        key = req.key or str(preset["key"])
        start = req.start_tick or 0
    elif req.cantus:
        notes = sorted(req.cantus, key=lambda n: n.tick)
        pitches = [n.note for n in notes]
        key = req.key
        start = notes[0].tick if req.start_tick is None else req.start_tick
    else:
        raise HTTPException(422, "a cantus firmus (notes) or a preset is needed")
    try:
        return species_counterpoint(
            pitches,
            key=key,
            mode=req.mode,
            species=req.species,
            above=req.position == "above",
            seed=req.seed,
            invertible=req.invertible,
            start_tick=start,
        )
    except ValueError as e:
        # CounterpointError is a ValueError: a cantus with no stepwise close,
        # a key its notes do not fit, a search that found nothing.
        raise HTTPException(422, str(e)) from e


@router.post("/canon")
def canon(req: CanonRequest) -> dict[str, Any]:
    from .canon import write_canon

    try:
        return write_canon(
            req.key,
            req.mode,
            interval=req.interval,
            lag=req.lag,
            bars=req.bars,
            seed=req.seed,
            transposition=req.transposition,
            rhythm=req.rhythm,
            start_tick=req.start_tick,
        )
    except ValueError as e:
        raise HTTPException(422, str(e)) from e


@router.post("/fugue")
def fugue(req: FugueRequest) -> dict[str, Any]:
    from .fugue import build_fugue

    try:
        return build_fugue(
            req.key,
            req.mode,
            voices=req.voices,
            subject=[n.model_dump() for n in req.subject] if req.subject else None,
            subject_start=req.subject_start,
            seed=req.seed,
            countersubject=req.countersubject,
            episodes=req.episodes,
            start_tick=req.start_tick,
        )
    except ValueError as e:
        raise HTTPException(422, str(e)) from e


@router.post("/invertible-check")
def invertible(req: InvertibleRequest) -> dict[str, Any]:
    from .counterpoint import invertible_check

    try:
        return invertible_check(
            [n.model_dump() for n in req.upper],
            [n.model_dump() for n in req.lower],
            req.interval,
            key=req.key,
            mode=req.mode,
        )
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
