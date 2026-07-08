"""Nominatim geocoding + Overpass venue discovery, with the throttling and
caching both providers' usage policies require.

Nominatim: max ~1 req/s, descriptive User-Agent mandatory. Overpass: shared
public instance — one query at a time, generous timeout, cache aggressively.
Every response is cached under ``data/tour_cache/`` so repeat searches of the
same region cost the providers nothing.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from pathlib import Path
from typing import Any, Optional

import httpx

from .vocab import annotate

log = logging.getLogger(__name__)

USER_AGENT = (
    "theDAW-TOUR/0.1 (https://github.com/gantasmo/theDAW; contact via repo issues)"
)
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
NOMINATIM_REVERSE_URL = "https://nominatim.openstreetmap.org/reverse"
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
OPENCHARGEMAP_URL = "https://api.openchargemap.io/v3/poi/"

GEOCODE_TTL_SEC = 30 * 24 * 3600  # places do not move
VENUES_TTL_SEC = 24 * 3600
CHARGERS_TTL_SEC = 6 * 3600  # stations change more often than venues

# Clamp a chosen bbox to this total span around its centroid, so a huge admin
# area (a whole county) or a mis-matched giant feature can't be handed to
# Overpass. 0.7 deg total span = ~24 mi each way from the centroid.
GEOCODE_MAX_SPAN_DEG = 0.7
_WATER_TYPES = {"waterway", "water", "sea", "bay", "river", "stream", "canal"}
_PLACE_TYPES = {
    "city",
    "town",
    "village",
    "hamlet",
    "municipality",
    "suburb",
    "borough",
}
# Distance rings (miles) for anchor-biased geocode ranking. A hit in a nearer
# ring always outranks one in a farther ring, so "Apple Valley" while planning
# near Barstow resolves to the CA town 29 mi away, not the higher-importance
# Minnesota one 1400 mi away. Within one ring, importance still decides (a major
# city beats a tiny same-distance hamlet). Coarse bands honor the ask to "parse
# 20-30-50-100-500 mile radii before jumping 200 miles away".
_RING_BOUNDS_MI = (50.0, 120.0, 250.0, 500.0)

PROJECT_ROOT = Path(__file__).resolve().parents[3]

# Serialize + space out calls per provider (module-level: one backend process).
_nominatim_lock = asyncio.Lock()
_overpass_lock = asyncio.Lock()
_last_call: dict[str, float] = {"nominatim": 0.0, "overpass": 0.0}
_MIN_GAP_SEC = {"nominatim": 1.1, "overpass": 2.0}


def _cache_dir() -> Path:
    d = PROJECT_ROOT / "data" / "tour_cache"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _cache_get(name: str, ttl: int) -> Optional[Any]:
    f = _cache_dir() / f"{name}.json"
    if not f.exists():
        return None
    try:
        wrapped = json.loads(f.read_text(encoding="utf-8"))
        if time.time() - float(wrapped.get("ts", 0)) > ttl:
            return None
        return wrapped.get("data")
    except Exception as exc:  # noqa: BLE001 — a corrupt cache file is just a miss
        log.warning("tour: cache read failed for %s: %s", name, exc)
        return None


def _cache_put(name: str, data: Any) -> None:
    try:
        (_cache_dir() / f"{name}.json").write_text(
            json.dumps({"ts": time.time(), "data": data}), encoding="utf-8"
        )
    except OSError as exc:
        log.warning("tour: cache write failed for %s: %s", name, exc)


async def _throttle(provider: str) -> None:
    gap = _MIN_GAP_SEC[provider]
    wait = _last_call[provider] + gap - time.monotonic()
    if wait > 0:
        await asyncio.sleep(wait)
    _last_call[provider] = time.monotonic()


class UpstreamError(RuntimeError):
    """A provider call failed; the router maps this to HTTP 502."""


class UpstreamAuthError(UpstreamError):
    """A provider rejected the key — a user-fixable config error (HTTP 4xx),
    not an upstream fault. Subclasses UpstreamError so existing catchers still
    work."""


def _http_reason(status: Optional[int]) -> str:
    """Plain-language cause for an HTTP status, so a message reads like
    "HTTP 429 (rate limited...)" instead of a bare code that means nothing."""
    return {
        400: "bad request, the query was rejected",
        401: "unauthorized, the API key was rejected",
        403: "forbidden, the API key was rejected or lacks access",
        429: "rate limited, too many requests in a short time",
        500: "the service hit an internal error",
        502: "bad gateway, the service is temporarily unreachable",
        503: "service unavailable, the server is temporarily overloaded",
        504: "gateway timeout, the server took too long to respond",
    }.get(status or 0, "unexpected response")


def _service_error(
    service: str, status: Optional[int], transient: bool
) -> UpstreamError:
    """Build a human error naming the service, the code, AND what the code means,
    plus whether it is worth retrying."""
    tail = " It is usually momentary; try again in a minute." if transient else ""
    return UpstreamError(f"{service}: HTTP {status} ({_http_reason(status)}).{tail}")


def _haversine_mi(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    import math

    r = 3958.8  # mean Earth radius, miles
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _ring(dist_mi: float) -> int:
    for i, bound in enumerate(_RING_BOUNDS_MI):
        if dist_mi <= bound:
            return i
    return len(_RING_BOUNDS_MI)


def _drop_city_token(query: str) -> Optional[str]:
    """Rewrite a "subject, city, state[/zip]" query with the middle city token
    removed, keeping subject + state. Metro city names are unreliable in OSM,
    which files addresses and venues under the actual municipality ("Las Vegas"
    is really Summerlin / Paradise / Enterprise / ...), so the city token can
    make an otherwise-valid address return zero hits. Returns None when there is
    no distinct city token to drop (fewer than three comma parts)."""
    parts = [p.strip() for p in query.split(",") if p.strip()]
    if len(parts) < 3:
        return None
    candidate = ", ".join([parts[0], *parts[2:]])
    return candidate if candidate.lower() != query.strip().lower() else None


def _pick_geocode_hit(
    hits: list[dict[str, Any]],
    ref: Optional[tuple[float, float]] = None,
) -> dict[str, Any]:
    """Choose the intended hit from Nominatim's candidates.

    Water features and non-place admin areas (counties, states, rivers) are
    always demoted so a populated place wins. Then:

    - With an ``ref`` anchor (the tour's first stop / start / map center),
      rank by distance RING to that anchor, then by importance within the ring.
      This makes an ambiguous name resolve to the NEAREST sensible place, which
      is what a tour planner wants, and it is robust to map zoom (unlike the
      soft viewbox bias, which loses to raw importance when zoomed out).
    - Without an anchor, keep Nominatim's descending-importance order (which
      correctly ranks "Reno, Nevada" above an obscure "Reno" hamlet in Italy).

    The chosen bbox is clamped afterward, so an oversized-but-correct metro is
    handled by the clamp — do NOT penalize a hit for area here."""

    def rank(item: tuple[int, dict[str, Any]]) -> tuple:
        idx, h = item
        addresstype = (h.get("addresstype") or "").lower()
        category = (h.get("category") or h.get("class") or "").lower()
        is_water = category in _WATER_TYPES or addresstype in _WATER_TYPES
        is_place = addresstype in _PLACE_TYPES
        if ref is not None:
            try:
                dist = _haversine_mi(ref[0], ref[1], float(h["lat"]), float(h["lon"]))
            except (KeyError, TypeError, ValueError):
                dist = float("inf")
            imp = float(h.get("importance", 0) or 0)
            return (is_water, not is_place, _ring(dist), -imp, dist)
        return (is_water, not is_place, idx)

    return min(enumerate(hits), key=rank)[1]


def _clamp_bbox(
    lat: float, lon: float, s: float, n: float, w: float, e: float
) -> dict[str, float]:
    """Shrink (never expand) a bbox toward the centroid so an oversized admin
    area stays under the cap and Overpass-friendly."""
    half = GEOCODE_MAX_SPAN_DEG / 2.0
    return {
        "south": max(s, lat - half),
        "north": min(n, lat + half),
        "west": max(w, lon - half),
        "east": min(e, lon + half),
    }


async def _nominatim_search(params: dict[str, Any]) -> list[dict[str, Any]]:
    """One throttled Nominatim /search call -> its hit list (never raises on an
    empty result; a bad transport or non-200 is the only failure)."""
    async with _nominatim_lock:
        await _throttle("nominatim")
        try:
            async with httpx.AsyncClient(timeout=20.0) as client:
                resp = await client.get(
                    NOMINATIM_URL,
                    params=params,
                    headers={"User-Agent": USER_AGENT},
                )
        except httpx.HTTPError as exc:
            raise UpstreamError(f"Nominatim unreachable: {exc}") from exc
    if resp.status_code != 200:
        raise _service_error(
            "Place search (Nominatim)",
            resp.status_code,
            transient=resp.status_code in (429, 502, 503, 504),
        )
    try:
        hits = resp.json()
    except json.JSONDecodeError as exc:
        raise UpstreamError(f"Nominatim response malformed: {exc}") from exc
    return hits if isinstance(hits, list) else []


async def geocode(
    query: str,
    viewbox: Optional[tuple[float, float, float, float]] = None,
    ref: Optional[tuple[float, float]] = None,
) -> dict[str, Any]:
    """Region/city/address text -> {display_name, lat, lon, bbox}. Cached ~forever.

    ``viewbox`` (west, south, east, north) softly biases toward the current map
    view. ``ref`` (lat, lon) is the tour anchor (first stop / start / map
    center): when set, the nearest sensible candidate wins, so an ambiguous name
    resolves to the place nearest the trip rather than the highest-importance
    namesake across the country. If the literal query finds nothing, one retry
    drops an unreliable metro city token (see ``_drop_city_token``) so a real
    address like "…, Las Vegas, NV" (filed under Summerlin in OSM) still lands."""
    params: dict[str, Any] = {"q": query, "format": "jsonv2", "limit": 10}
    vb_key = ""
    if viewbox:
        w, s, e, n = viewbox
        params["viewbox"] = f"{w},{s},{e},{n}"
        params["bounded"] = 0
        # Coarse rounding so nearby views share a cache entry.
        vb_key = f"|{round(w)},{round(s)},{round(e)},{round(n)}"
    ref_key = f"|r{round(ref[0], 1)},{round(ref[1], 1)}" if ref else ""
    key = (
        "geocode_v4_"
        + hashlib.sha1((query.strip().lower() + vb_key + ref_key).encode()).hexdigest()[
            :16
        ]
    )
    cached = _cache_get(key, GEOCODE_TTL_SEC)
    if cached is not None:
        return cached

    hits = await _nominatim_search(params)
    if not hits:
        # The metro city token likely poisoned the match — drop it and retry once.
        alt = _drop_city_token(query)
        if alt:
            hits = await _nominatim_search({**params, "q": alt})
    if not hits:
        raise UpstreamError(f"No match for {query!r}")

    top = _pick_geocode_hit(hits, ref)
    try:
        south, north, west, east = (float(v) for v in top["boundingbox"])
        lat, lon = float(top["lat"]), float(top["lon"])
        result = {
            "query": query,
            "display_name": top.get("display_name", query),
            "lat": lat,
            "lon": lon,
            "bbox": _clamp_bbox(lat, lon, south, north, west, east),
        }
    except (KeyError, TypeError, ValueError) as exc:
        raise UpstreamError(f"Nominatim result malformed: {exc}") from exc
    _cache_put(key, result)
    return result


async def reverse(lat: float, lon: float) -> dict[str, Any]:
    """Coords -> {city, state, county, display_name}. For venues whose OSM
    tags lack addr:city, so the itinerary groups them under a real place name
    instead of 'Unspecified'. Cached ~forever (places do not move)."""
    key = f"reverse_{lat:.4f}_{lon:.4f}"
    cached = _cache_get(key, GEOCODE_TTL_SEC)
    if cached is not None:
        return cached

    async with _nominatim_lock:
        await _throttle("nominatim")
        try:
            async with httpx.AsyncClient(timeout=20.0) as client:
                resp = await client.get(
                    NOMINATIM_REVERSE_URL,
                    params={
                        "lat": lat,
                        "lon": lon,
                        "format": "jsonv2",
                        "zoom": 14,  # town/suburb granularity
                        "addressdetails": 1,
                    },
                    headers={"User-Agent": USER_AGENT},
                )
        except httpx.HTTPError as exc:
            raise UpstreamError(f"Nominatim reverse unreachable: {exc}") from exc
    if resp.status_code != 200:
        raise _service_error(
            "Reverse geocode (Nominatim)",
            resp.status_code,
            transient=resp.status_code in (429, 502, 503, 504),
        )
    try:
        data = resp.json()
    except json.JSONDecodeError as exc:
        raise UpstreamError(f"Nominatim reverse response malformed: {exc}") from exc
    addr = data.get("address") if isinstance(data, dict) else None
    addr = addr if isinstance(addr, dict) else {}
    city = (
        addr.get("city")
        or addr.get("town")
        or addr.get("village")
        or addr.get("hamlet")
        or addr.get("municipality")
        or addr.get("suburb")
        or ""
    )
    result = {
        "city": city,
        "county": addr.get("county", ""),
        "state": addr.get("state", ""),
        "display_name": data.get("display_name", "") if isinstance(data, dict) else "",
    }
    _cache_put(key, result)
    return result


# Venue categories worth surfacing for tour booking, broadest net first.
_AMENITIES = (
    "bar",
    "pub",
    "nightclub",
    "music_venue",
    "events_venue",
    "concert_hall",
    "theatre",
    "arts_centre",
    "community_centre",
)


def _overpass_query(south: float, west: float, north: float, east: float) -> str:
    b = f"{south},{west},{north},{east}"
    # One exact-match clause per amenity value — each uses Overpass's tag index.
    # A single regex clause (amenity~"^(bar|pub|...)$") cannot use the index and
    # forces a full element scan of the bbox, which 504s on dense metros
    # (measured: regex 504 in 13s vs this union 200 in 3.4s for Reno).
    amenities = "".join(f'nwr["amenity"="{a}"]({b});' for a in _AMENITIES)
    return (
        "[out:json][timeout:60];("
        + amenities
        + f'nwr["leisure"="dance"]({b});'
        + f'nwr["landuse"="festival_grounds"]({b});'
        + ");out tags center 600;"
    )


def _category(tags: dict[str, str]) -> str:
    if tags.get("amenity"):
        return tags["amenity"]
    if tags.get("leisure") == "dance":
        return "dance"
    if tags.get("landuse") == "festival_grounds":
        return "festival_grounds"
    return "venue"


def _first(tags: dict[str, str], *keys: str) -> str:
    """First non-empty value among the given OSM tag keys (they alias the same
    thing, e.g. ``contact:phone`` vs ``phone``)."""
    for k in keys:
        val = (tags.get(k) or "").strip()
        if val:
            return val
    return ""


def _parse_venues(elements: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for el in elements:
        tags = el.get("tags") or {}
        name = (tags.get("name") or "").strip()
        if not name:
            continue  # unnamed features are useless for booking outreach
        lat = el.get("lat") or (el.get("center") or {}).get("lat")
        lon = el.get("lon") or (el.get("center") or {}).get("lon")
        if lat is None or lon is None:
            continue
        vid = f"{el.get('type', 'n')}{el.get('id', '')}"
        if vid in seen:
            continue
        seen.add(vid)

        category = _category(tags)
        city = (
            tags.get("addr:city")
            or tags.get("addr:town")
            or tags.get("addr:village")
            or ""
        )
        addr_parts = [
            tags.get("addr:housenumber", ""),
            tags.get("addr:street", ""),
            city,
        ]
        genres, vibes = annotate(name, category, tags)
        out.append(
            {
                "id": vid,
                "name": name,
                "category": category,
                "lat": float(lat),
                "lon": float(lon),
                "website": _first(tags, "website", "contact:website", "url"),
                "email": _first(tags, "email", "contact:email"),
                "phone": _first(tags, "phone", "contact:phone", "contact:mobile"),
                "instagram": _first(tags, "contact:instagram", "instagram"),
                "facebook": _first(tags, "contact:facebook", "facebook"),
                "twitter": _first(tags, "contact:twitter", "twitter", "contact:x"),
                "youtube": _first(tags, "contact:youtube", "youtube"),
                "tiktok": _first(tags, "contact:tiktok", "tiktok"),
                "soundcloud": _first(tags, "contact:soundcloud", "soundcloud"),
                "bandcamp": _first(tags, "contact:bandcamp", "bandcamp"),
                "spotify": _first(tags, "contact:spotify", "spotify"),
                "whatsapp": _first(tags, "contact:whatsapp", "whatsapp"),
                "address": " ".join(p for p in addr_parts if p),
                "city": city,
                "genres": genres,
                "vibes": vibes,
            }
        )
    return out


# The indexed union query (one exact-match clause per tag, not a full-scan
# regex) fixed the structural 504s. What remains is the public instance being
# transiently overloaded — a gateway timeout that a single short retry clears.
# This is ONE retry, not a spin loop: two attempts total, a fixed pause between.
_OVERPASS_RETRY_STATUS = {429, 502, 503, 504}
_OVERPASS_RETRY_WAIT_SEC = 4.0


async def _overpass_fetch(query: str) -> list[dict[str, Any]]:
    """POST an Overpass query and return its elements, with one bounded retry on
    a transient gateway status so a momentary overload does not surface as a hard
    failure. Call volume is kept low upstream by the grid-snapped cache."""
    last_status: Optional[int] = None
    for attempt in range(2):
        async with httpx.AsyncClient(timeout=90.0) as client:
            try:
                resp = await client.post(
                    OVERPASS_URL,
                    data={"data": query},
                    headers={"User-Agent": USER_AGENT},
                )
            except httpx.HTTPError as exc:
                raise UpstreamError(f"Overpass unreachable: {exc}") from exc
        if resp.status_code == 200:
            try:
                return resp.json().get("elements", [])
            except json.JSONDecodeError as exc:
                raise UpstreamError(f"Overpass response malformed: {exc}") from exc
        last_status = resp.status_code
        if attempt == 0 and resp.status_code in _OVERPASS_RETRY_STATUS:
            log.warning(
                "tour: Overpass HTTP %d, one retry in %.0fs",
                resp.status_code,
                _OVERPASS_RETRY_WAIT_SEC,
            )
            await asyncio.sleep(_OVERPASS_RETRY_WAIT_SEC)
            continue
        break
    # Name the venue-search service (Overpass is jargon) plus the code + cause.
    raise _service_error(
        "Venue search (Overpass)",
        last_status,
        transient=last_status in _OVERPASS_RETRY_STATUS,
    )


# Snap the queried bbox out to a coarse grid so a small pan/zoom reuses the same
# cached Overpass result instead of firing a fresh call. ~0.05 deg ~= 3.5 mi;
# the snapped box is always a superset of the request, and results are filtered
# client-side, so the slop is invisible while call volume drops sharply.
_OVERPASS_GRID_DEG = 0.05

# Coalesce identical in-flight venue fetches: a double-fire (React strict mode,
# a double-click) awaits the first call instead of issuing a second. Keyed by
# the same snapped-grid cache key, so only truly identical queries share.
_venues_inflight: dict[str, "asyncio.Task[list[dict[str, Any]]]"] = {}


def _snap_bbox(
    south: float, west: float, north: float, east: float
) -> tuple[float, float, float, float]:
    import math

    g = _OVERPASS_GRID_DEG
    return (
        math.floor(south / g) * g,
        math.floor(west / g) * g,
        math.ceil(north / g) * g,
        math.ceil(east / g) * g,
    )


async def _venues_fetch(
    key: str, s: float, w: float, n: float, e: float
) -> list[dict[str, Any]]:
    async with _overpass_lock:
        await _throttle("overpass")
        elements = await _overpass_fetch(_overpass_query(s, w, n, e))
    parsed = _parse_venues(elements)
    _cache_put(key, parsed)
    log.info(
        "tour: %d venues in snapped bbox (%.3f,%.3f,%.3f,%.3f)",
        len(parsed),
        s,
        w,
        n,
        e,
    )
    return parsed


async def venues(
    south: float, west: float, north: float, east: float
) -> list[dict[str, Any]]:
    """All named music-relevant venues in a bbox, annotated with genre/vibe
    labels. The bbox is snapped to a coarse grid so nearby searches share one
    cached Overpass result; concurrent identical fetches are coalesced."""
    s, w, n, e = _snap_bbox(south, west, north, east)
    # Version tag busts stale caches when the venue shape changes
    # (v2: added `city`; v3: added `instagram`; v4: key derives from the snapped
    # grid bbox, not the raw request; v5: added the full social/contact set).
    key = (
        "venues_"
        + hashlib.sha1(f"v5|{s:.4f},{w:.4f},{n:.4f},{e:.4f}".encode()).hexdigest()[:16]
    )
    cached = _cache_get(key, VENUES_TTL_SEC)
    if cached is not None:
        return cached

    task = _venues_inflight.get(key)
    if task is None:
        task = asyncio.ensure_future(_venues_fetch(key, s, w, n, e))
        _venues_inflight[key] = task
        task.add_done_callback(lambda _t, k=key: _venues_inflight.pop(k, None))
    return await task


# Charging stations are sampled ALONG the route, not from one big bbox: a
# single OpenChargeMap bbox call with maxresults caps at ~200 results that
# cluster in the densest metro (so a 300-mi route only showed chargers around
# one city). Instead, walk the polyline and query a radius at points spaced
# along it, then dedupe.
CHARGER_SAMPLE_SPACING_KM = 45.0  # ~28 mi between corridor samples
CHARGER_SAMPLE_RADIUS_MI = 20
CHARGER_MAX_SAMPLES = 14
CHARGER_MAX_PER_SAMPLE = 40


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    import math

    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _sample_polyline(
    geometry: list[list[float]], spacing_km: float, max_samples: int
) -> list[tuple[float, float]]:
    """Points (lat, lon) spaced ~spacing_km along a [lon,lat] polyline, always
    including the endpoints, thinned evenly to at most max_samples."""
    pts = [(c[1], c[0]) for c in geometry if len(c) >= 2]
    if not pts:
        return []
    samples = [pts[0]]
    acc = 0.0
    for (la0, lo0), (la1, lo1) in zip(pts, pts[1:]):
        acc += _haversine_km(la0, lo0, la1, lo1)
        if acc >= spacing_km:
            samples.append((la1, lo1))
            acc = 0.0
    if samples[-1] != pts[-1]:
        samples.append(pts[-1])
    if len(samples) > max_samples:
        step = len(samples) / max_samples
        samples = [samples[int(i * step)] for i in range(max_samples)]
    return samples


def _normalize_ocm(data: Any, into: dict[str, dict[str, Any]]) -> None:
    for p in data if isinstance(data, list) else []:
        ai = p.get("AddressInfo") or {}
        lat, lon = ai.get("Latitude"), ai.get("Longitude")
        if lat is None or lon is None:
            continue
        cid = str(p.get("ID", ""))
        if not cid or cid in into:
            continue
        into[cid] = {
            "id": cid,
            "name": ai.get("Title") or "Charging station",
            "town": ai.get("Town") or "",
            "lat": float(lat),
            "lon": float(lon),
            "connections": len(p.get("Connections") or []),
            "operator": (p.get("OperatorInfo") or {}).get("Title") or "",
        }


async def chargers_along(
    geometry: list[list[float]], api_key: str
) -> list[dict[str, Any]]:
    """EV charging stations sampled along a route polyline ([lon,lat] pairs),
    deduped. Even coverage of the whole corridor, not one metro's cluster."""
    samples = _sample_polyline(geometry, CHARGER_SAMPLE_SPACING_KM, CHARGER_MAX_SAMPLES)
    if not samples:
        return []

    key = (
        "chargers_v2_"
        + hashlib.sha1(
            json.dumps([(round(a, 2), round(b, 2)) for a, b in samples]).encode()
        ).hexdigest()[:16]
    )
    cached = _cache_get(key, CHARGERS_TTL_SEC)
    if cached is not None:
        return cached

    found: dict[str, dict[str, Any]] = {}
    async with httpx.AsyncClient(timeout=30.0) as client:
        for i, (lat, lon) in enumerate(samples):
            try:
                resp = await client.get(
                    OPENCHARGEMAP_URL,
                    params={
                        "key": api_key,
                        "output": "json",
                        "compact": "true",
                        "verbose": "false",
                        "maxresults": CHARGER_MAX_PER_SAMPLE,
                        "latitude": lat,
                        "longitude": lon,
                        "distance": CHARGER_SAMPLE_RADIUS_MI,
                        "distanceunit": "Miles",
                    },
                    headers={"User-Agent": USER_AGENT},
                )
            except httpx.HTTPError:
                continue  # one bad corridor sample must not fail the whole route
            # A key rejection is fatal and user-fixable; surface it on the
            # first sample rather than silently returning nothing.
            if resp.status_code in (401, 403) and i == 0:
                raise UpstreamAuthError("OpenChargeMap rejected the key — recheck it.")
            if resp.status_code != 200:
                continue
            try:
                _normalize_ocm(resp.json(), found)
            except json.JSONDecodeError:
                continue

    out = list(found.values())
    _cache_put(key, out)
    log.info("tour: %d chargers along route (%d samples)", len(out), len(samples))
    return out
