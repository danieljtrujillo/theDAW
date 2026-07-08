"""ORS-backed tour route optimization (Slice 4).

ONE server-side call per plan: ``/optimization`` (VROOM under the hood) with
``options.g`` set, which both orders the stops AND returns the drive
geometry — jobs are the venues, one ``driving-car`` vehicle starts at the
region center (and ends there when the tour is a roundtrip). Per the VROOM
API, each step's ``duration``/``distance`` are cumulative upon arrival, so
per-leg values are consecutive deltas, and ``routes[].geometry`` is a
precision-5 encoded polyline (decoded here, no extra dependency).

The separate ``/v2/directions`` endpoint is deliberately NOT used: measured
2026-07-07, most cold directions calls hung for tens of seconds or bounced
off ORS's nginx with 502 while optimization answered the same coordinates
in about a second. One call also halves quota usage.

The public API allows ~50 jobs per optimization call; stops are capped at
``MAX_STOPS`` below that.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx

from .discovery import USER_AGENT

log = logging.getLogger(__name__)

OPTIMIZATION_URL = "https://api.openrouteservice.org/optimization"
# Fixed-order (calendar) routing: VROOM has no precedence constraints, so an
# arbitrary visiting order can't be pinned through /optimization. Directions
# with ordered waypoints is the right tool — one call returns per-leg segments
# AND the drive geometry. Re-measured 2026-07-08: 3/3 calls HTTP 200 in ~1.0s
# (the 2026-07-07 hangs were transient), and its per-leg times match /v2/matrix.
DIRECTIONS_URL = "https://api.openrouteservice.org/v2/directions/driving-car"
MAX_STOPS = 40

# The public ORS optimizer intermittently returns fast nginx 502/503/504s
# (its upstream workers briefly unavailable) that clear within seconds —
# measured 2026-07-08: identical payloads 502 for a few seconds, then 200.
# Ride out that window with more attempts over an exponential backoff
# (~22s total) rather than the earlier ~6s that could land entirely inside
# one bad window. Per-attempt timeout is unchanged.
ATTEMPTS = 5
RETRY_STATUS = {502, 503, 504}
ATTEMPT_TIMEOUT_SEC = 25.0


def _backoff_sec(attempt: int) -> float:
    # attempt is 1-based here (no sleep before the first try): 2, 4, 8, 8.
    return float(min(2**attempt, 8))


class UpstreamError(RuntimeError):
    """An ORS call failed; the router maps this to HTTP 502."""


def _ors_error(resp: httpx.Response) -> UpstreamError:
    if resp.status_code in (401, 403):
        return UpstreamError(
            "openrouteservice rejected the key — recheck it in the key panel."
        )
    if resp.status_code == 429:
        return UpstreamError(
            "openrouteservice rate/quota limit hit — wait a minute and retry."
        )
    if resp.status_code in (502, 503, 504):
        # ORS's own nginx failing to reach its workers — transient, on their
        # end. Don't surface the nginx HTML body.
        return UpstreamError(
            f"openrouteservice is temporarily unavailable "
            f"(HTTP {resp.status_code}). This is on their end and usually clears "
            f"within a minute. Try again."
        )
    detail = ""
    try:
        err = resp.json().get("error")
        detail = err.get("message", "") if isinstance(err, dict) else str(err or "")
    except Exception:  # noqa: BLE001 — non-JSON error body, fall back to raw text
        detail = resp.text[:200]
    return UpstreamError(
        f"openrouteservice returned HTTP {resp.status_code}"
        + (f": {detail}" if detail else "")
    )


async def _post_ors(url: str, body: dict, api_key: str, what: str) -> Any:
    """POST to an ORS endpoint with the shared transient-status retry/backoff.
    ``what`` names the call in logs (e.g. "optimization", "directions")."""
    last_error: UpstreamError | None = None
    async with httpx.AsyncClient(timeout=ATTEMPT_TIMEOUT_SEC) as client:
        for attempt in range(ATTEMPTS):
            if attempt:
                await asyncio.sleep(_backoff_sec(attempt))
            try:
                # httpx's timeout is per-socket-op; wrap the whole call in a
                # hard deadline so a trickled response can't hang past it.
                resp = await asyncio.wait_for(
                    client.post(
                        url,
                        json=body,
                        headers={"Authorization": api_key, "User-Agent": USER_AGENT},
                    ),
                    timeout=ATTEMPT_TIMEOUT_SEC + 5,
                )
            except (httpx.HTTPError, asyncio.TimeoutError) as exc:
                log.warning(
                    "tour: ORS %s attempt %d/%d failed: %s: %s",
                    what,
                    attempt + 1,
                    ATTEMPTS,
                    type(exc).__name__,
                    exc,
                )
                last_error = UpstreamError(
                    f"openrouteservice unreachable: {type(exc).__name__}: {exc}"
                )
                last_error.__cause__ = exc
                continue
            if resp.status_code in RETRY_STATUS:
                log.warning(
                    "tour: ORS %s attempt %d/%d got HTTP %d",
                    what,
                    attempt + 1,
                    ATTEMPTS,
                    resp.status_code,
                )
                last_error = _ors_error(resp)
                continue
            if resp.status_code != 200:
                raise _ors_error(resp)
            try:
                return resp.json()
            except ValueError as exc:
                raise UpstreamError("openrouteservice response malformed") from exc
    assert last_error is not None
    raise last_error


def _decode_polyline(encoded: str) -> list[list[float]]:
    """Standard Google polyline decoding at precision 5 (what VROOM emits),
    returned as [lon, lat] pairs ready for a GeoJSON LineString."""
    coords: list[list[float]] = []
    lat = lon = 0
    i = 0
    n = len(encoded)
    try:
        while i < n:
            for which in (0, 1):
                shift = result = 0
                while True:
                    b = ord(encoded[i]) - 63
                    i += 1
                    result |= (b & 0x1F) << shift
                    shift += 5
                    if b < 0x20:
                        break
                delta = ~(result >> 1) if result & 1 else result >> 1
                if which == 0:
                    lat += delta
                else:
                    lon += delta
            coords.append([lon / 1e5, lat / 1e5])
    except IndexError as exc:
        raise UpstreamError("openrouteservice geometry malformed") from exc
    return coords


def _step_id(step: dict) -> Any:
    # VROOM job steps carry the job id as "id" (older builds used "job").
    return step.get("id", step.get("job"))


def _ordered_label(
    idx: int, start_label: str, stops: list[dict], roundtrip: bool, npts: int
) -> str:
    """Name the waypoint at position ``idx`` in the fixed-order coordinate list
    (0 = start; last = start when roundtrip; otherwise stops[idx-1])."""
    if idx == 0 or (roundtrip and idx == npts - 1):
        return start_label
    if 1 <= idx <= len(stops):
        return stops[idx - 1]["name"]
    return start_label


async def _plan_ordered(
    start: dict, stops: list[dict], roundtrip: bool, api_key: str
) -> dict[str, Any]:
    """Route the stops in the GIVEN order (calendar mode), not an optimized one.
    ORS Directions with ordered waypoints returns per-leg segments AND the drive
    geometry in one call; VROOM can't pin an arbitrary order (no precedence)."""
    coords: list[list[float]] = [[start["lon"], start["lat"]]]
    coords += [[s["lon"], s["lat"]] for s in stops]
    if roundtrip:
        coords.append([start["lon"], start["lat"]])

    solution = await _post_ors(
        DIRECTIONS_URL, {"coordinates": coords}, api_key, "directions"
    )
    routes = solution.get("routes") or []
    if not routes:
        raise UpstreamError("openrouteservice returned no route.")
    route = routes[0]
    segments = route.get("segments") or []
    start_label = start.get("label") or "Start"
    npts = len(coords)

    # ORS returns one segment per consecutive waypoint pair (verified: 4 pts ->
    # 3 segments), each carrying that leg's distance/duration directly.
    legs: list[dict[str, Any]] = [
        {
            "from": _ordered_label(i, start_label, stops, roundtrip, npts),
            "to": _ordered_label(i + 1, start_label, stops, roundtrip, npts),
            "distance_m": float(seg.get("distance", 0)),
            "duration_s": float(seg.get("duration", 0)),
        }
        for i, seg in enumerate(segments)
    ]
    summary = route.get("summary") or {}
    return {
        "start": {"lat": start["lat"], "lon": start["lon"], "label": start_label},
        "roundtrip": roundtrip,
        "stops": list(stops),
        "legs": legs,
        "total": {
            "distance_m": float(summary.get("distance", 0)),
            "duration_s": float(summary.get("duration", 0)),
        },
        "geometry": _decode_polyline(route.get("geometry") or ""),
        "unassigned": [],
    }


async def plan(
    start: dict,
    stops: list[dict],
    roundtrip: bool,
    api_key: str,
    ordered: bool = False,
) -> dict[str, Any]:
    """Return drive geometry + per-leg times for the stops.

    ``start``: {lat, lon, label}. ``stops``: [{id, name, lat, lon}, ...].
    Returns stops, legs (from/to/distance_m/duration_s), totals, the route
    LineString coordinates ([lon, lat] pairs), and any unreachable stops. With
    ``ordered`` false the stop order is optimized (Slice 4); with it true the
    given order is kept (calendar mode, Slice 6).
    """
    if ordered:
        return await _plan_ordered(start, stops, roundtrip, api_key)

    vehicle: dict[str, Any] = {
        "id": 1,
        "profile": "driving-car",
        "start": [start["lon"], start["lat"]],
    }
    if roundtrip:
        vehicle["end"] = [start["lon"], start["lat"]]
    solution = await _post_ors(
        OPTIMIZATION_URL,
        {
            "jobs": [
                {"id": i + 1, "location": [s["lon"], s["lat"]]}
                for i, s in enumerate(stops)
            ],
            "vehicles": [vehicle],
            "options": {"g": True},
        },
        api_key,
        "optimization",
    )

    routes = solution.get("routes") or []
    if not routes:
        raise UpstreamError("openrouteservice optimizer returned no route.")
    route = routes[0]
    steps = route.get("steps") or []

    start_label = start.get("label") or "Start"

    def label_of(step: dict) -> str:
        if step.get("type") == "job":
            jid = _step_id(step)
            if isinstance(jid, int) and 1 <= jid <= len(stops):
                return stops[jid - 1]["name"]
        return start_label

    ordered_stops: list[dict] = []
    for step in steps:
        if step.get("type") != "job":
            continue
        jid = _step_id(step)
        if isinstance(jid, int) and 1 <= jid <= len(stops):
            ordered_stops.append(stops[jid - 1])
    if not ordered_stops:
        raise UpstreamError("openrouteservice optimizer assigned no stops.")

    # Carry the stop id (not just the name) so the client can correlate an
    # unreachable entry back to a removable stop even when two share a name.
    unassigned = [
        {"id": stops[u["id"] - 1].get("id", ""), "name": stops[u["id"] - 1]["name"]}
        for u in solution.get("unassigned", [])
        if isinstance(u.get("id"), int) and 1 <= u["id"] <= len(stops)
    ]

    # Step duration/distance are cumulative upon arrival — legs are deltas.
    # Without a vehicle end, ORS still appends an "end" step at the last
    # job's location (a zero-length leg) — drop it for one-way routes.
    leg_steps = steps if roundtrip else [s for s in steps if s.get("type") != "end"]
    legs: list[dict[str, Any]] = []
    for prev, step in zip(leg_steps, leg_steps[1:]):
        legs.append(
            {
                "from": label_of(prev),
                "to": label_of(step),
                "distance_m": float(step.get("distance", 0) - prev.get("distance", 0)),
                "duration_s": float(step.get("duration", 0) - prev.get("duration", 0)),
            }
        )

    geometry = _decode_polyline(route.get("geometry") or "")

    # A roundtrip loop is symmetric (same total either direction), but VROOM may
    # return it starting with the FARTHEST stop, which reads wrong ("I start in
    # Las Vegas, why is Beatty stop 1?"). Orient the loop so the stop nearest the
    # start comes first. Cost is unchanged: legs reverse with from/to swapped,
    # and the geometry reverses.
    if roundtrip and len(ordered_stops) >= 2:

        def _d2(s: dict) -> float:
            return (s["lat"] - start["lat"]) ** 2 + (s["lon"] - start["lon"]) ** 2

        if _d2(ordered_stops[-1]) < _d2(ordered_stops[0]):
            ordered_stops = ordered_stops[::-1]
            legs = [
                {
                    "from": lg["to"],
                    "to": lg["from"],
                    "distance_m": lg["distance_m"],
                    "duration_s": lg["duration_s"],
                }
                for lg in reversed(legs)
            ]
            geometry = geometry[::-1]

    return {
        "start": {
            "lat": start["lat"],
            "lon": start["lon"],
            "label": start_label,
        },
        "roundtrip": roundtrip,
        "stops": ordered_stops,
        "legs": legs,
        "total": {
            "distance_m": float(route.get("distance", 0)),
            "duration_s": float(route.get("duration", 0)),
        },
        "geometry": geometry,
        "unassigned": unassigned,
    }
