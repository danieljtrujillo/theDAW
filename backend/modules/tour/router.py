"""TOUR module — venue discovery + route/EV tour planning.

Follows the suno module's outbound-API conventions: keys resolve env-first,
then the in-app data file ``data/tour_keys.json`` (settable via ``POST
/config``); every third-party call happens server-side so no key ever reaches
the browser. Slice 2 adds /geocode (Nominatim), /venues (Overpass, annotated
with the genre/vibe vocabulary), and /filters (persistent presets). Later
slices added /reverse (fill a venue's city), /enrich (web search + any
assistant provider), /route (a single ORS optimization call, geometry
included), and /chargers (OpenChargeMap, sampled along the route); still to
come: /suggest-towns.

The map itself needs no key: the frontend renders MapLibre GL against
OpenFreeMap (keyless, unlimited, commercial-OK) — nothing to configure here.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import discovery, enrich, routing
from .vocab import GENRES, VIBES

log = logging.getLogger(__name__)

router = APIRouter(tags=["tour"])

PROJECT_ROOT = Path(__file__).resolve().parents[3]

# Key registry: env var name -> short id used in /status + /config payloads.
# ORS (openrouteservice) backs /route until/unless a self-hosted VROOM ships;
# OpenChargeMap backs the EV mode; GEMINI is shared with the assistant and
# only reported here (it is managed app-wide, not by this module).
_KEYS = {
    "ORS_API_KEY": "ors",
    "OPENCHARGEMAP_API_KEY": "openchargemap",
}


def _data_dir() -> Path:
    d = PROJECT_ROOT / "data"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _key_file() -> Path:
    return _data_dir() / "tour_keys.json"


def _read_key_file() -> dict[str, str]:
    f = _key_file()
    if f.exists():
        try:
            raw = json.loads(f.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                return {str(k): str(v) for k, v in raw.items() if v}
        except Exception as exc:  # noqa: BLE001 — a corrupt file must not crash the app
            log.warning("tour: failed to read key file: %s", exc)
    return {}


def read_key(env_name: str) -> Optional[str]:
    """Resolve a key: environment wins, else data/tour_keys.json."""
    env = os.getenv(env_name)
    if env and env.strip():
        return env.strip()
    stored = _read_key_file().get(_KEYS.get(env_name, env_name), "")
    return stored.strip() or None


class TourConfigBody(BaseModel):
    ors: Optional[str] = None
    openchargemap: Optional[str] = None


@router.get("/status")
def get_status() -> dict:
    """Which capabilities are ready. The map and the OSM-backed discovery
    endpoints (Nominatim/Overpass) are keyless; route optimization and EV
    chargers need their keys before their slices activate. Enrichment runs
    on ANY assistant provider — env keys count here, and keys typed into the
    assistant panel (browser localStorage) arrive per-request, so the pill
    can also be lit client-side."""
    from backend.assistant_routes import _get_api_key

    # Pool-aware (backend/key_pool.py) AND env-aware, exactly like chat.
    llm_env = any(
        bool(_get_api_key(pid, None))
        for pid in ("gemini", "openai", "anthropic", "grok", "groq", "openrouter")
    )
    return {
        "ok": True,
        "map": {"provider": "openfreemap", "keyless": True},
        "keys": {
            "ors": bool(read_key("ORS_API_KEY")),
            "openchargemap": bool(read_key("OPENCHARGEMAP_API_KEY")),
            "llm_env": llm_env,
        },
        "capabilities": {
            "geocode": True,
            "venues": True,
            "route": bool(read_key("ORS_API_KEY")),
            "chargers": bool(read_key("OPENCHARGEMAP_API_KEY")),
            "enrich": llm_env,
        },
    }


@router.get("/config")
def get_config() -> dict:
    """Masked view of the stored keys (never the values), plus whether an
    env var is overriding the file so the UI can explain a stuck value."""
    stored = _read_key_file()
    out: dict[str, dict[str, bool]] = {}
    for env_name, short in _KEYS.items():
        out[short] = {
            "configured": bool(read_key(env_name)),
            "from_env": bool((os.getenv(env_name) or "").strip()),
            "stored": bool(stored.get(short)),
        }
    return {"ok": True, "keys": out}


@router.post("/config")
def post_config(body: TourConfigBody) -> dict:
    """Store keys in data/tour_keys.json. Empty string clears a key; None
    leaves it unchanged. Env vars still win at read time."""
    stored = _read_key_file()
    for short, value in (("ors", body.ors), ("openchargemap", body.openchargemap)):
        if value is None:
            continue
        value = value.strip()
        if value:
            stored[short] = value
        else:
            stored.pop(short, None)
    try:
        _key_file().write_text(json.dumps(stored, indent=2), encoding="utf-8")
    except OSError as exc:
        raise HTTPException(
            status_code=500, detail=f"Could not save keys: {exc}"
        ) from exc
    return get_config()


# ── Slice 2: discovery + filters ───────────────────────────────────────────


@router.get("/geocode")
async def get_geocode(
    q: str,
    west: Optional[float] = None,
    south: Optional[float] = None,
    east: Optional[float] = None,
    north: Optional[float] = None,
    ref_lat: Optional[float] = None,
    ref_lon: Optional[float] = None,
) -> dict:
    """Region/city/address text -> centroid + bbox (Nominatim, cached +
    throttled). The optional west/south/east/north viewbox softly biases toward
    the current map view; the optional ref_lat/ref_lon anchor (the trip's first
    stop / start / map center) makes the NEAREST sensible match win so an
    ambiguous name resolves to the place nearest the tour, not a far namesake."""
    q = q.strip()
    if not q:
        raise HTTPException(status_code=400, detail="Empty query.")
    viewbox = None
    if (
        west is not None
        and south is not None
        and east is not None
        and north is not None
    ):
        viewbox = (west, south, east, north)
    ref = None
    if (
        ref_lat is not None
        and ref_lon is not None
        and -90.0 <= ref_lat <= 90.0
        and -180.0 <= ref_lon <= 180.0
    ):
        ref = (ref_lat, ref_lon)
    try:
        return await discovery.geocode(q, viewbox, ref)
    except discovery.UpstreamError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.get("/reverse")
async def get_reverse(lat: float, lon: float) -> dict:
    """Coords -> {city, state, county, display_name} (Nominatim reverse). Fills
    the city for a venue whose OSM tags omit addr:city."""
    if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
        raise HTTPException(status_code=400, detail="Coordinates out of range.")
    try:
        return await discovery.reverse(lat, lon)
    except discovery.UpstreamError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


class VenuesBody(BaseModel):
    south: float
    west: float
    north: float
    east: float


@router.post("/venues")
async def post_venues(body: VenuesBody) -> dict:
    """Named music-relevant venues in a bbox (Overpass, cached + throttled),
    each annotated with matched genre/vibe labels. Filtering is client-side
    so flipping chips never re-hits the provider."""
    if not (body.south < body.north and body.west < body.east):
        raise HTTPException(status_code=400, detail="Invalid bbox.")
    # Cap the area so a continent-sized request cannot hammer Overpass.
    if (body.north - body.south) * (body.east - body.west) > 4.0:
        raise HTTPException(
            status_code=400,
            detail="Region too large — search a city or metro area, not a whole state.",
        )
    try:
        found = await discovery.venues(body.south, body.west, body.north, body.east)
    except discovery.UpstreamError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"ok": True, "count": len(found), "venues": found}


class ChargersBody(BaseModel):
    # Route polyline as [lon, lat] pairs; chargers are sampled along it.
    geometry: list[list[float]]


@router.post("/chargers")
async def post_chargers(body: ChargersBody) -> dict:
    """EV charging stations sampled along a route polyline (OpenChargeMap).
    Needs the OCM key from the key panel; the key never leaves the backend."""
    api_key = read_key("OPENCHARGEMAP_API_KEY")
    if not api_key:
        raise HTTPException(
            status_code=400,
            detail="No OpenChargeMap key — add one via the key button in the TOUR header.",
        )
    if not body.geometry:
        raise HTTPException(status_code=400, detail="Empty route geometry.")
    try:
        found = await discovery.chargers_along(body.geometry, api_key)
    except discovery.UpstreamAuthError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except discovery.UpstreamError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"ok": True, "count": len(found), "chargers": found}


def _filters_file() -> Path:
    return _data_dir() / "tour_filters.json"


class FiltersBody(BaseModel):
    genres: list[str] = []
    vibes: list[str] = []


@router.get("/filters")
def get_filters() -> dict:
    """The stored preset plus the full vocabulary, so the UI builds its chips
    from the server's labels instead of duplicating the list."""
    stored: dict = {"genres": [], "vibes": []}
    f = _filters_file()
    if f.exists():
        try:
            raw = json.loads(f.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                stored["genres"] = [g for g in raw.get("genres", []) if g in GENRES]
                stored["vibes"] = [v for v in raw.get("vibes", []) if v in VIBES]
        except Exception as exc:  # noqa: BLE001 — a corrupt preset is just empty
            log.warning("tour: failed to read filters: %s", exc)
    return {
        "ok": True,
        "selected": stored,
        "available": {"genres": list(GENRES.keys()), "vibes": list(VIBES.keys())},
    }


@router.put("/filters")
def put_filters(body: FiltersBody) -> dict:
    """Persist the chip preset (portable across sessions via the backend)."""
    payload = {
        "genres": [g for g in body.genres if g in GENRES],
        "vibes": [v for v in body.vibes if v in VIBES],
    }
    try:
        _filters_file().write_text(json.dumps(payload, indent=2), encoding="utf-8")
    except OSError as exc:
        raise HTTPException(
            status_code=500, detail=f"Could not save filters: {exc}"
        ) from exc
    return {"ok": True, "selected": payload}


# ── Slice 4: route optimization (ORS) ───────────────────────────────────────


class RoutePoint(BaseModel):
    lat: float
    lon: float
    label: str = ""


class RouteStopBody(BaseModel):
    id: str = ""
    name: str
    lat: float
    lon: float
    city: str = ""


class Timeframe(BaseModel):
    start: str = ""  # ISO date (YYYY-MM-DD), empty = open-ended
    end: str = ""


class RouteBody(BaseModel):
    start: RoutePoint
    stops: list[RouteStopBody]
    roundtrip: bool = True
    timeframe: Optional[Timeframe] = None
    # Calendar mode: keep the given stop order instead of optimizing it. Dates
    # live client-side (they drive the order + feasibility display), so the
    # backend needs only this flag, not the dates themselves.
    ordered: bool = False


@router.post("/route")
async def post_route(body: RouteBody) -> dict:
    """Optimize the stop order and get drive geometry + per-leg times in a
    single ORS /optimization call. Needs the ORS key from the key panel;
    the key never leaves the backend."""
    api_key = read_key("ORS_API_KEY")
    if not api_key:
        raise HTTPException(
            status_code=400,
            detail="No openrouteservice key — add one via the key button in the TOUR header.",
        )
    if not body.stops:
        raise HTTPException(status_code=400, detail="Add at least one stop.")
    if len(body.stops) > routing.MAX_STOPS:
        raise HTTPException(
            status_code=400,
            detail=f"Too many stops — the route is capped at {routing.MAX_STOPS}.",
        )
    try:
        result = await routing.plan(
            body.start.model_dump(),
            [s.model_dump() for s in body.stops],
            body.roundtrip,
            api_key,
            body.ordered,
        )
    except routing.UpstreamError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"ok": True, **result}


# ── Slice 3: booking-contact enrichment ─────────────────────────────────────


class EnrichBody(BaseModel):
    venue: dict
    provider: str = "gemini"
    model: Optional[str] = None
    api_key: Optional[str] = None
    force: bool = False


@router.post("/enrich")
async def post_enrich(body: EnrichBody) -> dict:
    """Find a venue's booking contact: scrape its website (any assistant
    provider extracts), or Gemini google_search grounding when no site is on
    record. Cached per venue for a week; force=true refreshes."""
    try:
        result = await enrich.enrich_venue(
            body.venue, body.provider, body.model, body.api_key, body.force
        )
    except enrich.UpstreamError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"ok": True, **result}
