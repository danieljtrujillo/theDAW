"""FastAPI router for the composer module (prefix from module.json: ``/api/composer``).

    GET  /           capability report
    POST /plan       a roman-numeral phrase in a key, voiced in SATB
    POST /check      voice-leading flags for parts in ticks
    POST /continuo   a figured bass realized in four parts

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

from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from backend.lib.cross_site import (
    refuse_cross_site,
    require_loopback_launch_or_pairing_token,
)

# music21 loads on the first request, not at startup: the engine modules are
# imported inside the handlers.
from .spec import CADENCES, DEFAULT_RANGES, FEATURES, HARMONIC_RHYTHMS, PPQ, RULES

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
    cadence: Cadence = "authentic_perfect"
    include: list[Feature] = Field(default_factory=list)
    modulate_to: Optional[str] = Field(default=None, max_length=32)
    harmonic_rhythm: Literal["pulse", "bar"] = "pulse"
    ranges: Optional[dict[str, Range]] = None


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
        "rules": list(RULES),
        "ranges": {k: list(v) for k, v in DEFAULT_RANGES.items()},
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
        )
    except ValueError as e:
        # PlanError is a ValueError: too few bars, a key that is not closely
        # related, a chord no voicing reaches.
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
