/** TOUR workspace — venue discovery on a dark vector map.
 *
 * Slice 1: MapLibre GL against OpenFreeMap (keyless, unlimited) in a warmed
 * tab, so the instance survives tab switches. Slice 2: region search
 * (Nominatim via /api/tour/geocode), venue discovery (Overpass via
 * /api/tour/venues, server-annotated with genre/vibe labels), persistent
 * filter chips (/api/tour/filters), a virtualized venue list, and map
 * markers. Filtering is purely client-side — flipping chips never re-hits
 * the providers. Slice 3: per-venue booking-contact enrichment
 * (/api/tour/enrich). Slice 4: a route itinerary — add venues as stops,
 * optimize the drive order (/api/tour/route, ORS), draw the route on the
 * map, and list per-leg drive times. Slice 5: an explicit start point +
 * date window, and the itinerary grouped by city while building (the
 * optimized result stays a flat drive order).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './tourMap.css';
import { List, type ListImperativeAPI, type RowComponentProps } from 'react-window';
import {
  Check,
  ChevronRight,
  Facebook,
  Globe,
  Instagram,
  KeyRound,
  Mail,
  MessageCircle,
  Music2,
  Music4,
  Phone,
  Plus,
  Search,
  Twitter,
  X,
  Youtube,
  type LucideIcon,
} from 'lucide-react';
import {
  enrichVenue,
  fetchChargers,
  fetchTourConfig,
  fetchTourStatus,
  fetchTourFilters,
  fetchVenues,
  geocodeRegion,
  optimizeTourRoute,
  pickEnrichProvider,
  reverseGeocode,
  saveTourConfig,
  saveTourFilters,
  type TourCharger,
  type TourConfig,
  type TourEnrichment,
  type TourRoute,
  type TourStatus,
  type TourVenue,
} from '../lib/tourClient';

const MAP_STYLE = 'https://tiles.openfreemap.org/styles/dark';
const MARKER_CAP = 400;
const ROW_HEIGHT = 46;
// Mirrors the backend cap (routing.MAX_STOPS) — ORS limits jobs/waypoints.
const ROUTE_STOP_CAP = 40;
// Nominal daily driving budget for the calendar-mode feasibility check: a leg
// is flagged "tight" when its drive can't fit in the days between show dates at
// this pace. Slice 7 makes this an explicit, user-tunable filter.
const CALENDAR_DAILY_DRIVE_HOURS = 10;

const fmtDur = (s: number): string => {
  const m = Math.round(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};
const fmtMiles = (meters: number): string => `${(meters / 1609.344).toFixed(1)} mi`;

// An OSM contact tag may be a full URL or a bare handle; normalize to a URL.
const handleUrl = (host: string, v: string): string =>
  /^https?:\/\//i.test(v) ? v : `https://${host}/${v.replace(/^@/, '')}`;

// Every contact channel a venue can carry, in a stable render order. `external`
// links open in a new tab; tel:/mailto: navigate in place.
const CONTACT_CHANNELS: Array<{
  key: keyof TourVenue;
  icon: LucideIcon;
  label: string;
  href: (v: string) => string;
  external: boolean;
}> = [
  { key: 'website', icon: Globe, label: 'Website', href: (v) => v, external: true },
  { key: 'email', icon: Mail, label: 'Email', href: (v) => `mailto:${v}`, external: false },
  { key: 'phone', icon: Phone, label: 'Call', href: (v) => `tel:${v}`, external: false },
  { key: 'whatsapp', icon: MessageCircle, label: 'WhatsApp', href: (v) => `https://wa.me/${v.replace(/[^0-9]/g, '')}`, external: true },
  { key: 'instagram', icon: Instagram, label: 'Instagram', href: (v) => handleUrl('instagram.com', v), external: true },
  { key: 'facebook', icon: Facebook, label: 'Facebook', href: (v) => handleUrl('facebook.com', v), external: true },
  { key: 'twitter', icon: Twitter, label: 'X / Twitter', href: (v) => handleUrl('x.com', v), external: true },
  { key: 'youtube', icon: Youtube, label: 'YouTube', href: (v) => handleUrl('youtube.com', v), external: true },
  { key: 'tiktok', icon: Music2, label: 'TikTok', href: (v) => handleUrl('tiktok.com', v), external: true },
  { key: 'soundcloud', icon: Music4, label: 'SoundCloud', href: (v) => handleUrl('soundcloud.com', v), external: true },
  { key: 'bandcamp', icon: Music4, label: 'Bandcamp', href: (v) => (/^https?:\/\//i.test(v) ? v : `https://${v}`), external: true },
  { key: 'spotify', icon: Music4, label: 'Spotify', href: (v) => v, external: true },
];

/** Every contact/social channel a venue carries, whichever exist. */
const ContactLinks: React.FC<{ v: TourVenue }> = ({ v }) => (
  <span className="flex shrink-0 flex-wrap items-center gap-1">
    {CONTACT_CHANNELS.map(({ key, icon: Icon, label, href, external }) => {
      const value = v[key];
      if (typeof value !== 'string' || !value) return null;
      return (
        <a
          key={key}
          href={href(value)}
          {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}
          aria-label={`${label} for ${v.name}`}
          className="text-zinc-400 hover:text-lime-300"
        >
          <Icon className="h-3 w-3" />
        </a>
      );
    })}
  </span>
);

export const TourView: React.FC = () => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const chargerMarkersRef = useRef<maplibregl.Marker[]>([]);
  const filtersSaveTimer = useRef<number | null>(null);
  const listRef = useRef<ListImperativeAPI>(null);
  // Latest sorted venue array, read by selectVenue to scroll the list without
  // making the (stable) callback depend on it.
  const sortedRef = useRef<TourVenue[]>([]);
  // Bumped whenever the route inputs change; an in-flight optimize whose token
  // no longer matches discards its (now stale) result instead of installing it.
  const optimizeToken = useRef(0);

  const [status, setStatus] = useState<TourStatus | null>(null);
  const [mapError, setMapError] = useState('');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [regionName, setRegionName] = useState('');
  const [movedSinceSearch, setMovedSinceSearch] = useState(false);
  const [venues, setVenues] = useState<TourVenue[]>([]);
  const [availGenres, setAvailGenres] = useState<string[]>([]);
  const [availVibes, setAvailVibes] = useState<string[]>([]);
  const [selGenres, setSelGenres] = useState<Set<string>>(new Set());
  const [selVibes, setSelVibes] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState('');
  const [sortMode, setSortMode] = useState<'relevance' | 'name' | 'type'>('relevance');
  const [regionCenter, setRegionCenter] = useState<{ lat: number; lon: number; label: string } | null>(null);

  // ── Route itinerary (Slice 4) ──────────────────────────────────────────────
  const [routeStops, setRouteStops] = useState<TourVenue[]>([]);
  const [roundtrip, setRoundtrip] = useState(true);
  // Slice 6 — calendar mode: 'optimize' lets the solver reorder stops for the
  // shortest drive; 'calendar' keeps the user's date order and flags legs that
  // don't fit between consecutive show dates. `stopDates` maps a stop id -> its
  // ISO show date.
  const [routeMode, setRouteMode] = useState<'optimize' | 'calendar'>('optimize');
  const [stopDates, setStopDates] = useState<Record<string, string>>({});
  const [routeBusy, setRouteBusy] = useState(false);
  const [routeError, setRouteError] = useState('');
  const [route, setRoute] = useState<TourRoute | null>(null);
  // 'ev' overlays charging stations along the drawn route; 'gas' hides them.
  const [energyMode, setEnergyMode] = useState<'gas' | 'ev'>('gas');
  const [chargers, setChargers] = useState<TourCharger[]>([]);
  const [chargersMsg, setChargersMsg] = useState('');

  // ── Trip setup (Slice 5): explicit start point + date window ───────────────
  // Explicit start is distinct from the map's region center; when unset the
  // route falls back to region center, then to the first stop (Slice 4 behavior).
  const [startPoint, setStartPoint] = useState<{ lat: number; lon: number; label: string } | null>(null);
  const [startQuery, setStartQuery] = useState('');
  const [startBusy, setStartBusy] = useState(false);
  const [startError, setStartError] = useState('');
  const [dateStart, setDateStart] = useState('');
  const [dateEnd, setDateEnd] = useState('');
  const [collapsedCities, setCollapsedCities] = useState<Set<string>>(new Set());

  // ── Boot: module status + persisted filter preset ─────────────────────────
  useEffect(() => {
    let dead = false;
    fetchTourStatus()
      .then((s) => { if (!dead) setStatus(s); })
      .catch(() => { /* backend not up yet — pills stay neutral */ });
    fetchTourFilters()
      .then((f) => {
        if (dead) return;
        setAvailGenres(f.available.genres);
        setAvailVibes(f.available.vibes);
        setSelGenres(new Set(f.selected.genres));
        setSelVibes(new Set(f.selected.vibes));
      })
      .catch(() => { /* chips render once the backend answers a later mount */ });
    return () => { dead = true; };
  }, []);

  // ── Map lifecycle ──────────────────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el || mapRef.current) return;
    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container: el,
        style: MAP_STYLE,
        center: [-98.5, 39.8], // continental US overview until a region is chosen
        zoom: 3.6,
        attributionControl: { compact: true },
      });
    } catch (e) {
      setMapError(e instanceof Error ? e.message : String(e));
      return;
    }
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.on('error', (e) => {
      console.warn('[tour] map error:', e.error?.message ?? e);
    });
    // Reveal "search this area" only after a USER pan/zoom (which carries an
    // originalEvent); our own fitBounds/flyTo moves have none, so they don't
    // trigger it.
    map.on('moveend', (e) => {
      if ((e as { originalEvent?: unknown }).originalEvent) setMovedSinceSearch(true);
    });
    mapRef.current = map;

    // The warmed-tab pattern hides this view with display:none; MapLibre needs
    // an explicit resize when the container becomes visible or changes size.
    const ro = new ResizeObserver(() => {
      if (el.clientWidth > 0 && el.clientHeight > 0) map.resize();
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      for (const m of markersRef.current) m.remove();
      for (const m of chargerMarkersRef.current) m.remove();
      markersRef.current = [];
      chargerMarkersRef.current = [];
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Current map view as [west,south,east,north] to bias geocoding toward what
  // the user is looking at (so "Apple Valley" resolves to the one on screen).
  const currentViewbox = useCallback((): [number, number, number, number] | undefined => {
    const map = mapRef.current;
    if (!map) return undefined;
    const b = map.getBounds();
    return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  }, []);

  // Geocode anchor: the tour's first stop, else the explicit start point, else
  // the map CENTER (robust to zoom, unlike the bounds). The backend ranks
  // candidates by distance to this anchor, so an ambiguous name resolves to the
  // place NEAREST the trip instead of a far higher-importance namesake.
  const currentRef = useCallback((): [number, number] | undefined => {
    const first = routeStops[0];
    if (first) return [first.lat, first.lon];
    if (startPoint) return [startPoint.lat, startPoint.lon];
    const c = mapRef.current?.getCenter();
    return c ? [c.lat, c.lng] : undefined;
  }, [routeStops, startPoint]);

  // ── Search: geocode -> fit map -> fetch venues ────────────────────────────
  const runSearch = useCallback(async (q: string) => {
    const text = q.trim();
    if (!text || busy) return;
    setBusy(true);
    setSearchError('');
    try {
      const geo = await geocodeRegion(text, currentViewbox(), currentRef());
      const short = geo.display_name.split(',').slice(0, 2).join(',');
      setRegionName(short);
      setRegionCenter({ lat: geo.lat, lon: geo.lon, label: short });
      mapRef.current?.fitBounds(
        new maplibregl.LngLatBounds(
          [geo.bbox.west, geo.bbox.south],
          [geo.bbox.east, geo.bbox.north],
        ),
        { padding: 48, duration: 800 },
      );
      const res = await fetchVenues(geo.bbox);
      setVenues(res.venues);
      setSelectedId('');
      setMovedSinceSearch(false);
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : String(e));
      setVenues([]);
    } finally {
      setBusy(false);
    }
  }, [busy, currentViewbox, currentRef]);

  // ── Search the current map viewport (no geocode) ──────────────────────────
  const searchArea = useCallback(async () => {
    const map = mapRef.current;
    if (!map || busy) return;
    const b = map.getBounds();
    const bbox = {
      south: b.getSouth(),
      west: b.getWest(),
      north: b.getNorth(),
      east: b.getEast(),
    };
    // Mirror the backend's area cap (/venues rejects > 4.0 sq deg).
    if ((bbox.north - bbox.south) * (bbox.east - bbox.west) > 4.0) {
      setSearchError('Zoom in to search — the visible area is too large.');
      return;
    }
    setBusy(true);
    setSearchError('');
    try {
      const res = await fetchVenues(bbox);
      setVenues(res.venues);
      setSelectedId('');
      setRegionName('Map area');
      setMovedSinceSearch(false);
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : String(e));
      setVenues([]);
    } finally {
      setBusy(false);
    }
  }, [busy]);

  // ── Filters: toggle + debounced persist ──────────────────────────────────
  const persistFilters = useCallback((genres: Set<string>, vibes: Set<string>) => {
    if (filtersSaveTimer.current !== null) window.clearTimeout(filtersSaveTimer.current);
    filtersSaveTimer.current = window.setTimeout(() => {
      void saveTourFilters([...genres], [...vibes]).catch(() => { /* preset is a nicety */ });
    }, 800);
  }, []);

  const toggleChip = useCallback((kind: 'genre' | 'vibe', label: string) => {
    const update = (prev: Set<string>) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    };
    if (kind === 'genre') {
      setSelGenres((prev) => {
        const next = update(prev);
        persistFilters(next, selVibes);
        return next;
      });
    } else {
      setSelVibes((prev) => {
        const next = update(prev);
        persistFilters(selGenres, next);
        return next;
      });
    }
  }, [persistFilters, selGenres, selVibes]);

  const filtered = useMemo(() => {
    if (selGenres.size === 0 && selVibes.size === 0) return venues;
    return venues.filter((v) => {
      const genreOk = selGenres.size === 0 || v.genres.some((g) => selGenres.has(g));
      const vibeOk = selVibes.size === 0 || v.vibes.some((x) => selVibes.has(x));
      return genreOk && vibeOk;
    });
  }, [venues, selGenres, selVibes]);

  const sorted = useMemo(() => {
    if (sortMode === 'relevance') return filtered;
    const arr = [...filtered];
    if (sortMode === 'name') arr.sort((a, b) => a.name.localeCompare(b.name));
    else arr.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
    return arr;
  }, [filtered, sortMode]);
  sortedRef.current = sorted;

  // Inclusive day count of the trip window (both endpoints count). Shown as
  // immediate feedback; feasibility against this window lands with the
  // calendar/filter slices.
  const tripDays = useMemo(() => {
    if (!dateStart || !dateEnd) return 0;
    const ms = new Date(dateEnd).getTime() - new Date(dateStart).getTime();
    return Number.isFinite(ms) && ms >= 0 ? Math.round(ms / 86_400_000) + 1 : 0;
  }, [dateStart, dateEnd]);

  // Select a venue: highlight it in the list (scroll into view) and, from a
  // list click, fly the map to it. Stable — reads the latest sorted array
  // via ref so it isn't recreated on every filter/sort change.
  const selectVenue = useCallback((v: TourVenue, fly: boolean) => {
    setSelectedId(v.id);
    if (fly) mapRef.current?.flyTo({ center: [v.lon, v.lat], zoom: 14.5, duration: 700 });
    const idx = sortedRef.current.findIndex((s) => s.id === v.id);
    if (idx >= 0) listRef.current?.scrollToRow({ index: idx, align: 'smart', behavior: 'smooth' });
  }, []);

  const focusVenue = useCallback((v: TourVenue) => selectVenue(v, true), [selectVenue]);

  // ── Map markers: plain venue dots + distinct route-stop markers ────────────
  // The marker set is the visible venues UNION the route stops (so the whole
  // itinerary shows even if a stop came from a different search / is filtered
  // out). Route stops render larger and, once optimized, numbered in order.
  const routeIds = useMemo(() => new Set(routeStops.map((s) => s.id)), [routeStops]);

  const markerSet = useMemo(() => {
    const m = new Map<string, TourVenue>();
    for (const v of filtered.slice(0, MARKER_CAP)) m.set(v.id, v);
    for (const s of routeStops) m.set(s.id, s);
    return [...m.values()];
  }, [filtered, routeStops]);

  const routeOrder = useMemo(() => {
    const m = new Map<string, number>();
    if (route) route.stops.forEach((s, i) => m.set(s.id, i + 1));
    return m;
  }, [route]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    for (const m of markersRef.current) m.remove();
    markersRef.current = [];
    for (const v of markerSet) {
      const inRoute = routeIds.has(v.id);
      const order = routeOrder.get(v.id);
      const el = document.createElement('div');
      if (inRoute) {
        el.style.cssText =
          'display:flex;align-items:center;justify-content:center;width:18px;height:18px;' +
          'border-radius:50%;background:#a3e635;border:2px solid #0a080f;' +
          'box-shadow:0 0 8px rgba(163,230,53,.9);color:#0a080f;cursor:pointer;' +
          'font:700 10px/1 system-ui,sans-serif;';
        if (order) el.textContent = String(order);
      } else {
        el.style.cssText =
          'width:9px;height:9px;border-radius:50%;background:rgba(163,230,53,.65);' +
          'border:1.5px solid #0a080f;cursor:pointer;';
      }
      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([v.lon, v.lat])
        .setPopup(
          new maplibregl.Popup({ closeButton: false, offset: 12, className: 'tour-popup' })
            .setText(v.name),
        )
        .addTo(map);
      el.addEventListener('click', () => selectVenue(v, false));
      markersRef.current.push(marker);
    }
  }, [markerSet, routeIds, routeOrder, selectVenue]);

  // ── Route: add/remove stops, optimize, draw ───────────────────────────────
  // Any change to the stop set / roundtrip flag invalidates a drawn route AND
  // aborts an in-flight optimize (so its stale result is discarded on arrival).
  const invalidateRoute = useCallback(() => {
    setRoute(null);
    optimizeToken.current += 1;
  }, []);

  // OSM venues often lack an addr:city tag; reverse-geocode the coords so the
  // itinerary groups the stop under its real place name, not "Unspecified".
  // Best-effort and cached server-side; on failure the stop stays ungrouped.
  const fillCity = useCallback(async (v: TourVenue) => {
    if (v.city) return;
    try {
      const r = await reverseGeocode(v.lat, v.lon);
      if (!r.city) return;
      const patch = (s: TourVenue) => (s.id === v.id && !s.city ? { ...s, city: r.city } : s);
      setRouteStops((prev) => prev.map(patch));
      setVenues((prev) => prev.map(patch));
    } catch {
      /* reverse geocode is a nicety — leave the stop under "Unspecified" */
    }
  }, []);

  const toggleRouteStop = useCallback((v: TourVenue) => {
    const exists = routeStops.some((s) => s.id === v.id);
    if (!exists && routeStops.length >= ROUTE_STOP_CAP) {
      // No change to the stop set — leave the drawn route intact.
      setRouteError(`Route is capped at ${ROUTE_STOP_CAP} stops.`);
      return;
    }
    setRouteError('');
    invalidateRoute();
    setRouteStops((prev) =>
      prev.some((s) => s.id === v.id)
        ? prev.filter((s) => s.id !== v.id)
        : [...prev, v],
    );
    if (!exists && !v.city) void fillCity(v);
  }, [routeStops, invalidateRoute, fillCity]);

  const removeRouteStop = useCallback((id: string) => {
    setRouteError('');
    invalidateRoute();
    setRouteStops((prev) => prev.filter((s) => s.id !== id));
  }, [invalidateRoute]);

  const clearRoute = useCallback(() => {
    setRouteStops([]);
    setRouteError('');
    invalidateRoute();
  }, [invalidateRoute]);

  const setRoundtripMode = useCallback((next: boolean) => {
    setRoundtrip(next);
    invalidateRoute();
  }, [invalidateRoute]);

  // Route stops grouped by city, preserving first-seen order (for the
  // pre-optimize itinerary view; the optimized result stays a flat drive order).
  const stopsByCity = useMemo(() => {
    const groups = new Map<string, TourVenue[]>();
    for (const s of routeStops) {
      const key = s.city || 'Unspecified';
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(s);
    }
    return [...groups.entries()];
  }, [routeStops]);

  const toggleCity = useCallback((city: string) => {
    setCollapsedCities((prev) => {
      const next = new Set(prev);
      if (next.has(city)) next.delete(city);
      else next.add(city);
      return next;
    });
  }, []);

  // ── Trip start point (Slice 5): geocode a place as the route origin ────────
  const setStart = useCallback(async (q: string) => {
    const text = q.trim();
    if (!text || startBusy) return;
    setStartBusy(true);
    setStartError('');
    try {
      const geo = await geocodeRegion(text, currentViewbox(), currentRef());
      const label = geo.display_name.split(',').slice(0, 2).join(',');
      setStartPoint({ lat: geo.lat, lon: geo.lon, label });
      setStartQuery('');
      invalidateRoute();
    } catch (e) {
      setStartError(e instanceof Error ? e.message : String(e));
    } finally {
      setStartBusy(false);
    }
  }, [startBusy, invalidateRoute, currentViewbox, currentRef]);

  const clearStart = useCallback(() => {
    setStartPoint(null);
    setStartError('');
    invalidateRoute();
  }, [invalidateRoute]);

  const changeRouteMode = useCallback((m: 'optimize' | 'calendar') => {
    setRouteMode(m);
    invalidateRoute();
  }, [invalidateRoute]);

  const setStopDate = useCallback((id: string, date: string) => {
    setStopDates((prev) => ({ ...prev, [id]: date }));
    invalidateRoute();
  }, [invalidateRoute]);

  // Calendar mode visits stops in date order: dated stops first (by date), then
  // any undated stops in their existing order.
  const calendarStops = useMemo(
    () =>
      routeStops
        .map((s, i) => ({ s, i, d: stopDates[s.id] || '' }))
        .sort((a, b) => {
          if (a.d && b.d) return a.d < b.d ? -1 : a.d > b.d ? 1 : a.i - b.i;
          if (a.d) return -1;
          if (b.d) return 1;
          return a.i - b.i;
        })
        .map((x) => x.s),
    [routeStops, stopDates],
  );

  const runOptimize = useCallback(async () => {
    if (routeBusy || routeStops.length === 0) return;
    const token = ++optimizeToken.current;
    setRouteBusy(true);
    setRouteError('');
    try {
      const ordered = routeMode === 'calendar';
      const stopsForRoute = ordered ? calendarStops : routeStops;
      const first = stopsForRoute[0];
      const start =
        startPoint ??
        regionCenter ??
        { lat: first.lat, lon: first.lon, label: first.name };
      const r = await optimizeTourRoute(
        start,
        stopsForRoute.map((v) => ({ id: v.id, name: v.name, lat: v.lat, lon: v.lon, city: v.city })),
        roundtrip,
        (dateStart || dateEnd) ? { start: dateStart, end: dateEnd } : undefined,
        ordered,
      );
      // The stop set changed while this request was in flight — drop the result.
      if (optimizeToken.current !== token) return;
      setRoute(r);
      if (r.geometry.length > 1) {
        const bounds = r.geometry.reduce(
          (acc, c) => acc.extend(c),
          new maplibregl.LngLatBounds(r.geometry[0], r.geometry[0]),
        );
        mapRef.current?.fitBounds(bounds, { padding: 56, duration: 800 });
      }
    } catch (e) {
      if (optimizeToken.current === token) {
        setRouteError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      // Only one optimize is ever in flight (the button is disabled while
      // busy), so this request always owns the busy flag.
      setRouteBusy(false);
    }
  }, [routeBusy, routeStops, roundtrip, regionCenter, startPoint, dateStart, dateEnd, routeMode, calendarStops]);

  // Calendar feasibility for the leg arriving at stop index `i`: compare its
  // drive time to the days between the previous show date (or the tour start
  // date for the first leg) and this stop's date, at a nominal daily driving
  // budget. 'tight' = the drive doesn't fit; null = not enough dates to judge.
  const legFeasibility = useCallback(
    (i: number): 'ok' | 'tight' | null => {
      if (!route || routeMode !== 'calendar' || i >= route.stops.length) return null;
      const arrive = stopDates[route.stops[i].id];
      const depart = i === 0 ? dateStart : stopDates[route.stops[i - 1].id];
      if (!depart || !arrive) return null;
      const gapDays = (new Date(arrive).getTime() - new Date(depart).getTime()) / 86_400_000;
      const driveHours = route.legs[i] ? route.legs[i].duration_s / 3600 : 0;
      if (gapDays <= 0) return driveHours > 0.1 ? 'tight' : 'ok';
      return driveHours <= gapDays * CALENDAR_DAILY_DRIVE_HOURS ? 'ok' : 'tight';
    },
    [route, routeMode, stopDates, dateStart],
  );

  // Draw (or clear) the optimized route line on the map.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const src = map.getSource('tour-route') as maplibregl.GeoJSONSource | undefined;
      if (!route) {
        if (map.getLayer('tour-route-line')) map.removeLayer('tour-route-line');
        if (src) map.removeSource('tour-route');
        return;
      }
      const data: GeoJSON.Feature<GeoJSON.LineString> = {
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: route.geometry },
      };
      if (src) {
        src.setData(data);
      } else {
        map.addSource('tour-route', { type: 'geojson', data });
        map.addLayer({
          id: 'tour-route-line',
          type: 'line',
          source: 'tour-route',
          paint: { 'line-color': '#a3e635', 'line-width': 3, 'line-opacity': 0.75 },
        });
      }
    };
    if (map.isStyleLoaded()) {
      apply();
      return;
    }
    // isStyleLoaded() is transiently false during tile loads (e.g. right after
    // the fitBounds that optimize/search trigger). 'load' fires only once per
    // map lifetime, so deferring to it would silently drop this draw/clear;
    // 'idle' re-fires whenever the map settles. Clean up if route changes first.
    const onIdle = () => apply();
    map.once('idle', onIdle);
    return () => { map.off('idle', onIdle); };
  }, [route]);

  // ── EV mode: charging stations along the drawn route ──────────────────────
  useEffect(() => {
    if (energyMode !== 'ev' || !route || route.geometry.length === 0) {
      setChargers([]);
      setChargersMsg('');
      return;
    }
    let dead = false;
    setChargersMsg('Finding chargers...');
    fetchChargers(route.geometry)
      .then((r) => {
        if (dead) return;
        setChargers(r.chargers);
        setChargersMsg(r.chargers.length === 0 ? 'No charging stations found on this route.' : '');
      })
      .catch((e) => {
        if (dead) return;
        setChargers([]);
        setChargersMsg(e instanceof Error ? e.message : String(e));
      });
    return () => { dead = true; };
  }, [energyMode, route]);

  // Charger markers (cyan, distinct from lime venue/route markers).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    for (const m of chargerMarkersRef.current) m.remove();
    chargerMarkersRef.current = [];
    for (const c of chargers) {
      const el = document.createElement('div');
      el.style.cssText =
        'display:flex;align-items:center;justify-content:center;width:15px;height:15px;' +
        'border-radius:3px;background:#22d3ee;border:1.5px solid #0a080f;' +
        'box-shadow:0 0 6px rgba(34,211,238,.85);cursor:pointer;';
      el.innerHTML =
        '<svg viewBox="0 0 24 24" width="10" height="10" fill="#0a080f" aria-hidden="true">' +
        '<path d="M13 2 3 14h7l-1 8 10-12h-7z"/></svg>';
      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([c.lon, c.lat])
        .setPopup(
          new maplibregl.Popup({ closeButton: false, offset: 12, className: 'tour-popup' })
            .setText(`${c.name} · ${c.connections} plug${c.connections === 1 ? '' : 's'}`),
        )
        .addTo(map);
      chargerMarkersRef.current.push(marker);
    }
  }, [chargers]);

  // ── Enrichment (per selected venue) ───────────────────────────────────────
  const [enrichBusy, setEnrichBusy] = useState(false);
  const [enrichments, setEnrichments] = useState<Record<string, TourEnrichment>>({});
  const [enrichError, setEnrichError] = useState('');

  const selectedVenue = useMemo(
    () => venues.find((v) => v.id === selectedId) ?? null,
    [venues, selectedId],
  );

  const runEnrich = useCallback(async (v: TourVenue) => {
    if (enrichBusy) return;
    setEnrichBusy(true);
    setEnrichError('');
    try {
      const pick = pickEnrichProvider();
      const result = await enrichVenue(v, pick);
      setEnrichments((prev) => ({ ...prev, [v.id]: result }));
    } catch (e) {
      setEnrichError(e instanceof Error ? e.message : String(e));
    } finally {
      setEnrichBusy(false);
    }
  }, [enrichBusy]);

  // ── Keys popover (ORS / OpenChargeMap — zero-terminal setup) ──────────────
  const [keysOpen, setKeysOpen] = useState(false);
  const [keyCfg, setKeyCfg] = useState<TourConfig | null>(null);
  const [orsInput, setOrsInput] = useState('');
  const [ocmInput, setOcmInput] = useState('');
  const [keysSaving, setKeysSaving] = useState(false);
  const [keysMsg, setKeysMsg] = useState('');

  const openKeys = useCallback(() => {
    setKeysOpen((prev) => !prev);
    setKeysMsg('');
    fetchTourConfig().then(setKeyCfg).catch(() => { /* backend down — inputs still render */ });
  }, []);

  const saveKeys = useCallback(async () => {
    if (keysSaving) return;
    setKeysSaving(true);
    setKeysMsg('');
    try {
      // Only send fields the user actually typed; blank means unchanged.
      const cfg = await saveTourConfig({
        ors: orsInput.trim() || undefined,
        openchargemap: ocmInput.trim() || undefined,
      });
      setKeyCfg(cfg);
      setOrsInput('');
      setOcmInput('');
      setKeysMsg('Saved.');
      setStatus(await fetchTourStatus());
    } catch (e) {
      setKeysMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setKeysSaving(false);
    }
  }, [keysSaving, orsInput, ocmInput]);

  const caps = status?.capabilities;

  return (
    <div className="h-full min-h-0 flex flex-col bg-[#0a080f]">
      <div className="relative flex items-center gap-3 px-3 py-1.5 border-b border-white/8 shrink-0">
        <span className="text-[11px] font-black uppercase tracking-widest text-lime-200">Tour</span>
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => { e.preventDefault(); void runSearch(query); }}
        >
          <label htmlFor="tour-region" className="sr-only">Search a region or city</label>
          <input
            id="tour-region"
            name="tour-region"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="city or region..."
            className="w-56 rounded border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-zinc-200 placeholder:text-zinc-600 focus:border-lime-500/50 focus:outline-none"
          />
          <button
            type="submit"
            disabled={busy || !query.trim()}
            className="flex items-center gap-1 rounded border border-lime-500/40 bg-lime-500/10 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-lime-200 disabled:opacity-40"
          >
            <Search className="h-3 w-3" aria-hidden="true" />
            {busy ? 'Searching' : 'Search'}
          </button>
        </form>
        {searchError ? (
          <span className="min-w-0 truncate text-[10px] text-red-400" title={searchError}>{searchError}</span>
        ) : regionName ? (
          <span className="min-w-0 truncate text-[10px] text-zinc-500" title={regionName}>{regionName}</span>
        ) : null}
        <div className="ml-auto flex items-center gap-1.5">
          <StatusPill label="Map" ok />
          <StatusPill label="Venues" ok={caps?.venues} />
          <StatusPill label="Routes" ok={caps?.route} />
          <StatusPill label="EV" ok={caps?.chargers} />
          <StatusPill label="Enrich" ok={caps?.enrich} />
          <button
            type="button"
            onClick={openKeys}
            aria-expanded={keysOpen}
            aria-controls="tour-keys-panel"
            aria-label="Service keys"
            title="Service keys (routes, EV chargers)"
            className={`rounded border px-1.5 py-1 ${
              keysOpen
                ? 'border-lime-500/50 bg-lime-500/15 text-lime-200'
                : 'border-white/10 bg-white/5 text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <KeyRound className="h-3 w-3" aria-hidden="true" />
          </button>
        </div>
        {keysOpen && (
          <div
            id="tour-keys-panel"
            className="absolute right-2 top-full z-20 mt-1 w-80 rounded-lg border border-white/10 bg-[#110e1a] p-3 shadow-xl"
          >
            <KeyField
              id="tour-key-ors"
              label="openrouteservice"
              hint="powers route optimization — free key at account.heigit.org"
              state={keyCfg?.keys?.ors}
              value={orsInput}
              onChange={setOrsInput}
            />
            <div className="mt-2">
              <KeyField
                id="tour-key-ocm"
                label="OpenChargeMap"
                hint="powers EV charger stops — free key at openchargemap.org"
                state={keyCfg?.keys?.openchargemap}
                value={ocmInput}
                onChange={setOcmInput}
              />
            </div>
            <div className="mt-2.5 flex items-center gap-2">
              <button
                type="button"
                disabled={keysSaving || (!orsInput.trim() && !ocmInput.trim())}
                onClick={() => void saveKeys()}
                className="rounded border border-lime-500/40 bg-lime-500/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-lime-200 disabled:opacity-40"
              >
                {keysSaving ? 'Saving...' : 'Save'}
              </button>
              {keysMsg && <span className="text-[10px] text-zinc-400">{keysMsg}</span>}
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-1 min-h-0">
        <aside className="flex w-72 shrink-0 flex-col border-r border-white/8">
          <div className="space-y-1.5 border-b border-white/8 px-2.5 py-2">
            <div className="flex items-center gap-1.5">
              <span className="w-9 shrink-0 text-[9px] font-bold uppercase tracking-wider text-zinc-400">Start</span>
              {startPoint ? (
                <>
                  <span className="min-w-0 flex-1 truncate text-[10px] text-zinc-200" title={startPoint.label}>
                    {startPoint.label}
                  </span>
                  <button
                    type="button"
                    aria-label="Clear start point"
                    onClick={clearStart}
                    className="shrink-0 text-zinc-400 hover:text-red-400"
                  >
                    <X className="h-2.5 w-2.5" aria-hidden="true" />
                  </button>
                </>
              ) : (
                <form
                  className="flex min-w-0 flex-1 items-center gap-1"
                  onSubmit={(e) => { e.preventDefault(); void setStart(startQuery); }}
                >
                  <label htmlFor="tour-start" className="sr-only">Tour start point</label>
                  <input
                    id="tour-start"
                    name="tour-start"
                    type="text"
                    value={startQuery}
                    onChange={(e) => setStartQuery(e.target.value)}
                    placeholder="home base (city/address)"
                    className="min-w-0 flex-1 rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px] text-zinc-200 placeholder:text-zinc-500 focus:border-lime-500/50 focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={startBusy || !startQuery.trim()}
                    className="shrink-0 rounded border border-lime-500/40 bg-lime-500/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-lime-200 disabled:opacity-40"
                  >
                    {startBusy ? '...' : 'Set'}
                  </button>
                </form>
              )}
            </div>
            {startError && <p className="text-[9px] leading-snug text-red-400">{startError}</p>}
            <div className="flex items-center gap-1.5">
              <span className="w-9 shrink-0 text-[9px] font-bold uppercase tracking-wider text-zinc-400">Dates</span>
              <label htmlFor="tour-date-start" className="sr-only">Tour start date</label>
              <input
                id="tour-date-start"
                name="tour-date-start"
                type="date"
                value={dateStart}
                max={dateEnd || undefined}
                onChange={(e) => setDateStart(e.target.value)}
                className="min-w-0 flex-1 rounded border border-white/10 bg-white/5 px-1 py-0.5 text-[10px] text-zinc-200 focus:border-lime-500/50 focus:outline-none scheme-dark"
              />
              <span className="shrink-0 text-[9px] text-zinc-500">to</span>
              <label htmlFor="tour-date-end" className="sr-only">Tour end date</label>
              <input
                id="tour-date-end"
                name="tour-date-end"
                type="date"
                value={dateEnd}
                min={dateStart || undefined}
                onChange={(e) => setDateEnd(e.target.value)}
                className="min-w-0 flex-1 rounded border border-white/10 bg-white/5 px-1 py-0.5 text-[10px] text-zinc-200 focus:border-lime-500/50 focus:outline-none scheme-dark"
              />
              {tripDays > 0 && (
                <span className="shrink-0 text-[9px] uppercase tracking-wider text-lime-300/80">
                  {tripDays}d
                </span>
              )}
            </div>
          </div>
          <div className="border-b border-white/8 px-2.5 py-2">
            <ChipRow kind="genre" labels={availGenres} selected={selGenres} onToggle={toggleChip} />
            <div className="mt-1.5">
              <ChipRow kind="vibe" labels={availVibes} selected={selVibes} onToggle={toggleChip} />
            </div>
          </div>
          {routeStops.length > 0 && (
            <div className="border-b border-white/8 px-2.5 py-2">
              <div className="flex items-center gap-2">
                <span className="text-[9px] font-black uppercase tracking-widest text-lime-200">
                  Route · {routeStops.length}
                </span>
                <div
                  role="group"
                  aria-label="Route mode"
                  className="ml-auto flex overflow-hidden rounded border border-white/10"
                >
                  {(['optimize', 'calendar'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      aria-pressed={routeMode === m}
                      onClick={() => changeRouteMode(m)}
                      className={`px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider transition-colors ${
                        routeMode === m
                          ? 'bg-lime-500/20 text-lime-200'
                          : 'text-zinc-500 hover:text-zinc-300'
                      }`}
                    >
                      {m === 'optimize' ? 'Optimize' : 'Calendar'}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  aria-label="Clear route"
                  onClick={clearRoute}
                  className="text-zinc-400 hover:text-zinc-200"
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              </div>
              <div className="mt-1.5 flex items-center gap-2">
                <span className="flex items-center gap-1.5">
                  <input
                    id="tour-roundtrip"
                    name="tour-roundtrip"
                    type="checkbox"
                    checked={roundtrip}
                    onChange={(e) => setRoundtripMode(e.target.checked)}
                    className="h-3 w-3 accent-lime-400"
                  />
                  <label htmlFor="tour-roundtrip" className="text-[9px] uppercase tracking-wider text-zinc-400">
                    roundtrip
                  </label>
                </span>
                <button
                  type="button"
                  disabled={routeBusy}
                  onClick={() => void runOptimize()}
                  className="ml-auto rounded border border-lime-500/40 bg-lime-500/10 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-lime-200 disabled:opacity-40"
                >
                  {routeBusy
                    ? routeMode === 'calendar'
                      ? 'Building...'
                      : 'Routing...'
                    : routeMode === 'calendar'
                      ? 'Build'
                      : 'Optimize'}
                </button>
              </div>
              {route && (
                <p className="mt-1 truncate text-[9px] uppercase tracking-wider text-zinc-400">
                  from {route.start.label}
                </p>
              )}
              {route ? (
                // Routed: drive order + per-leg times. Calendar mode also shows
                // each stop's date and flags any leg that can't fit before it.
                <ol className="mt-1 max-h-40 overflow-y-auto">
                  {route.stops.map((s, i) => {
                    const feas = legFeasibility(i);
                    return (
                      <li key={s.id} className="flex items-center gap-1.5 py-0.5">
                        <span className="w-4 shrink-0 text-right text-[9px] font-bold text-lime-300/80">{i + 1}</span>
                        <span className="min-w-0 flex-1 truncate text-[10px] text-zinc-300">
                          {s.name}
                          {routeMode === 'calendar' && stopDates[s.id] && (
                            <span className="ml-1 text-[8px] text-zinc-500">{stopDates[s.id]}</span>
                          )}
                        </span>
                        {feas === 'tight' && (
                          <span
                            title="This drive may not fit before the show date"
                            className="shrink-0 rounded bg-amber-500/15 px-1 text-[8px] font-bold uppercase tracking-wider text-amber-400"
                          >
                            tight
                          </span>
                        )}
                        {route.legs[i] && (
                          <span className="shrink-0 text-[9px] text-zinc-400">
                            {fmtDur(route.legs[i].duration_s)} · {fmtMiles(route.legs[i].distance_m)}
                          </span>
                        )}
                        <button
                          type="button"
                          aria-label={`Remove ${s.name} from route`}
                          onClick={() => removeRouteStop(s.id)}
                          className="shrink-0 text-zinc-400 hover:text-red-400"
                        >
                          <X className="h-2.5 w-2.5" aria-hidden="true" />
                        </button>
                      </li>
                    );
                  })}
                </ol>
              ) : routeMode === 'calendar' ? (
                // Calendar: one date input per stop, listed in date order.
                <div className="mt-1 max-h-40 overflow-y-auto">
                  {calendarStops.map((s) => (
                    <div key={s.id} className="flex items-center gap-1.5 py-0.5">
                      <label htmlFor={`tour-stop-date-${s.id}`} className="sr-only">
                        Show date for {s.name}
                      </label>
                      <input
                        id={`tour-stop-date-${s.id}`}
                        name={`tour-stop-date-${s.id}`}
                        type="date"
                        value={stopDates[s.id] ?? ''}
                        min={dateStart || undefined}
                        max={dateEnd || undefined}
                        onChange={(e) => setStopDate(s.id, e.target.value)}
                        className="w-28 shrink-0 rounded border border-white/10 bg-white/5 px-1 py-0.5 text-[9px] text-zinc-200 focus:border-lime-500/50 focus:outline-none scheme-dark"
                      />
                      <span className="min-w-0 flex-1 truncate text-[10px] text-zinc-300">{s.name}</span>
                      {s.city && (
                        <span className="shrink-0 truncate text-[8px] uppercase tracking-wider text-zinc-500">
                          {s.city}
                        </span>
                      )}
                      <button
                        type="button"
                        aria-label={`Remove ${s.name} from route`}
                        onClick={() => removeRouteStop(s.id)}
                        className="shrink-0 text-zinc-400 hover:text-red-400"
                      >
                        <X className="h-2.5 w-2.5" aria-hidden="true" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                // Building the itinerary: grouped by city (collapsible).
                <div className="mt-1 max-h-40 overflow-y-auto">
                  {stopsByCity.map(([city, group]) => {
                    const collapsed = collapsedCities.has(city);
                    return (
                      <div key={city}>
                        <button
                          type="button"
                          onClick={() => toggleCity(city)}
                          aria-expanded={!collapsed}
                          className="flex w-full items-center gap-1 py-0.5 text-left"
                        >
                          <ChevronRight
                            className={`h-2.5 w-2.5 shrink-0 text-zinc-400 transition-transform ${collapsed ? '' : 'rotate-90'}`}
                            aria-hidden="true"
                          />
                          <span className="min-w-0 flex-1 truncate text-[9px] font-bold uppercase tracking-wider text-zinc-300">
                            {city}
                          </span>
                          <span className="shrink-0 text-[9px] text-zinc-400">{group.length}</span>
                        </button>
                        {!collapsed &&
                          group.map((s) => (
                            <div key={s.id} className="flex items-center gap-1.5 py-0.5 pl-3.5">
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-[10px] text-zinc-300">{s.name}</span>
                                {(s.address || s.phone) && (
                                  <span className="block truncate text-[8px] uppercase tracking-wider text-zinc-500">
                                    {s.address || s.phone}
                                  </span>
                                )}
                              </span>
                              <ContactLinks v={s} />
                              <button
                                type="button"
                                aria-label={`Remove ${s.name} from route`}
                                onClick={() => removeRouteStop(s.id)}
                                className="shrink-0 text-zinc-400 hover:text-red-400"
                              >
                                <X className="h-2.5 w-2.5" aria-hidden="true" />
                              </button>
                            </div>
                          ))}
                      </div>
                    );
                  })}
                </div>
              )}
              {route && (
                <div className="mt-1 border-t border-white/8 pt-1">
                  {route.roundtrip && route.legs.length > route.stops.length && (
                    <p className="flex justify-between text-[9px] text-zinc-400">
                      <span className="uppercase tracking-wider">back to start</span>
                      <span>
                        {fmtDur(route.legs[route.legs.length - 1].duration_s)} · {fmtMiles(route.legs[route.legs.length - 1].distance_m)}
                      </span>
                    </p>
                  )}
                  <p className="flex justify-between text-[10px] font-bold text-zinc-200">
                    <span className="uppercase tracking-wider">total</span>
                    <span>{fmtDur(route.total.duration_s)} · {fmtMiles(route.total.distance_m)}</span>
                  </p>
                  {route.unassigned.map((u) => (
                    <p key={u.id || u.name} className="mt-0.5 flex items-center gap-1 text-[9px] leading-snug text-amber-400">
                      <span className="min-w-0 flex-1 truncate">unreachable: {u.name}</span>
                      {u.id && (
                        <button
                          type="button"
                          aria-label={`Remove ${u.name} from route`}
                          onClick={() => removeRouteStop(u.id)}
                          className="shrink-0 text-amber-400/80 hover:text-red-400"
                        >
                          <X className="h-2.5 w-2.5" aria-hidden="true" />
                        </button>
                      )}
                    </p>
                  ))}
                </div>
              )}
              {route && (
                <div className="mt-1.5 flex items-center gap-2 border-t border-white/8 pt-1.5">
                  <span className="text-[9px] uppercase tracking-wider text-zinc-400">energy</span>
                  <div className="flex overflow-hidden rounded border border-white/10">
                    {(['gas', 'ev'] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        aria-pressed={energyMode === m}
                        onClick={() => setEnergyMode(m)}
                        className={`px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${
                          energyMode === m
                            ? 'bg-lime-500/20 text-lime-200'
                            : 'text-zinc-400 hover:text-zinc-200'
                        }`}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                  {energyMode === 'ev' && (
                    <span className="ml-auto min-w-0 truncate text-[9px] text-cyan-300" title={chargersMsg}>
                      {chargersMsg || `${chargers.length} chargers`}
                    </span>
                  )}
                </div>
              )}
              {routeError && (
                <p className="mt-1 text-[10px] leading-snug text-red-400">{routeError}</p>
              )}
            </div>
          )}
          <div className="flex items-center gap-2 px-2.5 py-1">
            <span className="min-w-0 flex-1 truncate text-[9px] uppercase tracking-widest text-zinc-400">
              {venues.length === 0
                ? 'search a region to find venues'
                : `${filtered.length} of ${venues.length} venues`}
            </span>
            {venues.length > 0 && (
              <>
                <label htmlFor="tour-sort" className="sr-only">Sort venues</label>
                <select
                  id="tour-sort"
                  name="tour-sort"
                  value={sortMode}
                  onChange={(e) => setSortMode(e.target.value as 'relevance' | 'name' | 'type')}
                  className="shrink-0 rounded border border-white/10 bg-[#17131f] px-1 py-0.5 text-[9px] uppercase tracking-wider text-zinc-300 scheme-dark focus:border-lime-500/50 focus:outline-none"
                >
                  <option value="relevance">relevance</option>
                  <option value="name">A-Z</option>
                  <option value="type">type</option>
                </select>
              </>
            )}
          </div>
          <div className="flex-1 min-h-0">
            {sorted.length > 0 && (
              <List
                listRef={listRef}
                rowComponent={VenueRow}
                rowCount={sorted.length}
                rowHeight={ROW_HEIGHT}
                rowProps={{ venues: sorted, selectedId, onFocus: focusVenue, routeIds, onToggleRoute: toggleRouteStop }}
                overscanCount={8}
                style={{ height: '100%' }}
              />
            )}
          </div>
          {selectedVenue && (
            <div className="shrink-0 border-t border-white/8 px-2.5 py-2">
              <div className="flex items-start gap-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11px] font-bold text-zinc-100">{selectedVenue.name}</span>
                  <span className="block truncate text-[9px] uppercase tracking-wider text-zinc-400">
                    {selectedVenue.category.replace(/_/g, ' ')}
                    {selectedVenue.city ? ` · ${selectedVenue.city}` : ''}
                  </span>
                  {selectedVenue.address && (
                    <span className="block truncate text-[9px] text-zinc-500">{selectedVenue.address}</span>
                  )}
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  <ContactLinks v={selectedVenue} />
                  <button
                    type="button"
                    disabled={enrichBusy}
                    onClick={() => void runEnrich(selectedVenue)}
                    className="rounded border border-lime-500/40 bg-lime-500/10 px-2 py-1 text-[9px] font-bold uppercase tracking-wider text-lime-200 disabled:opacity-40"
                  >
                    {enrichBusy ? 'Finding...' : 'Find booking info'}
                  </button>
                </span>
              </div>
              {enrichError && (
                <p className="mt-1.5 text-[10px] leading-snug text-red-400">{enrichError}</p>
              )}
              {enrichments[selectedVenue.id] && (
                <EnrichResult data={enrichments[selectedVenue.id]} />
              )}
            </div>
          )}
        </aside>

        <div className="relative flex-1 min-h-0">
          {/* Explicit h/w, NOT `absolute inset-0`: maplibre's stylesheet sets
              `.maplibregl-map { position: relative }` and, loading after
              Tailwind, wins the tie — which turns inset-0 into a no-op and
              collapses the container to 0 height (black tab). */}
          <div ref={containerRef} className="h-full w-full" />
          {movedSinceSearch && !mapError && (
            <button
              type="button"
              onClick={() => void searchArea()}
              disabled={busy}
              className="absolute left-1/2 top-2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full border border-lime-500/40 bg-[#110e1a]/90 px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-lime-200 shadow-lg backdrop-blur disabled:opacity-40"
            >
              <Search className="h-3 w-3" aria-hidden="true" />
              {busy ? 'Searching...' : 'Search this area'}
            </button>
          )}
          {mapError && (
            <div className="absolute inset-0 grid place-items-center bg-[#0a080f]">
              <p className="max-w-100 text-center text-[11px] leading-relaxed text-zinc-400">
                The map could not start (WebGL unavailable): {mapError}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

type VenueRowProps = {
  venues: TourVenue[];
  selectedId: string;
  onFocus: (v: TourVenue) => void;
  routeIds: Set<string>;
  onToggleRoute: (v: TourVenue) => void;
};

/* The row is a flex of siblings (focus button + action links + route toggle),
   NOT links nested inside one big button — interactive-inside-interactive is
   invalid HTML and breaks keyboard/AT navigation. */
function VenueRow({ index, style, venues, selectedId, onFocus, routeIds, onToggleRoute }: RowComponentProps<VenueRowProps>) {
  const v = venues[index];
  if (!v) return null;
  const active = v.id === selectedId;
  const inRoute = routeIds.has(v.id);
  return (
    <div style={style} className="px-1.5">
      <div
        className={`flex h-10.5 w-full items-center gap-2 rounded-md border px-2 ${
          active
            ? 'border-lime-500/40 bg-lime-500/10'
            : 'border-transparent hover:border-white/10 hover:bg-white/5'
        }`}
      >
        <button type="button" onClick={() => onFocus(v)} className="min-w-0 flex-1 text-left">
          <span className="block truncate text-[11px] text-zinc-200">{v.name}</span>
          <span className="block truncate text-[9px] uppercase tracking-wider text-zinc-400">
            {v.category.replace(/_/g, ' ')}
            {v.address ? ` · ${v.address}` : ''}
          </span>
        </button>
        <span className="flex shrink-0 items-center gap-1">
          <ContactLinks v={v} />
          <button
            type="button"
            onClick={() => onToggleRoute(v)}
            aria-label={inRoute ? `Remove ${v.name} from route` : `Add ${v.name} to route`}
            className={inRoute ? 'text-lime-300' : 'text-zinc-500 hover:text-lime-300'}
          >
            {inRoute ? <Check className="h-3 w-3" aria-hidden="true" /> : <Plus className="h-3 w-3" aria-hidden="true" />}
          </button>
        </span>
      </div>
    </div>
  );
}

const KeyField: React.FC<{
  id: string;
  label: string;
  hint: string;
  state?: { configured: boolean; from_env: boolean };
  value: string;
  onChange: (v: string) => void;
}> = ({ id, label, hint, state, value, onChange }) => (
  <div>
    <label htmlFor={id} className="flex items-baseline justify-between text-[10px]">
      <span className="font-bold uppercase tracking-wider text-zinc-300">{label}</span>
      <span className="text-[9px] text-zinc-400">
        {state?.from_env ? 'set by env (env wins)' : state?.configured ? 'configured' : 'not set'}
      </span>
    </label>
    <input
      id={id}
      name={id}
      type="password"
      autoComplete="off"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={state?.configured ? 'configured — paste to replace' : 'paste key...'}
      className="mt-1 w-full rounded border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-zinc-200 placeholder:text-zinc-600 focus:border-lime-500/50 focus:outline-none"
    />
    <p className="mt-0.5 text-[9px] leading-snug text-zinc-400">{hint}</p>
  </div>
);

const EnrichResult: React.FC<{ data: TourEnrichment }> = ({ data }) => {
  const rows: Array<[string, React.ReactNode]> = [];
  if (data.booking_email) {
    rows.push(['email', <a key="e" href={`mailto:${data.booking_email}`} className="text-lime-300 hover:underline">{data.booking_email}</a>]);
  }
  if (data.booking_form_url) {
    rows.push(['form', <a key="f" href={data.booking_form_url} target="_blank" rel="noreferrer" className="truncate text-lime-300 hover:underline">{data.booking_form_url}</a>]);
  }
  if (data.phone) rows.push(['phone', data.phone]);
  if (data.contact_name) rows.push(['contact', data.contact_name]);
  if (data.submission_notes) rows.push(['notes', data.submission_notes]);
  return (
    <div className="mt-1.5 rounded border border-white/8 bg-white/3 px-2 py-1.5">
      {rows.length === 0 ? (
        <p className="text-[10px] text-zinc-500">No booking contact found.</p>
      ) : (
        rows.map(([label, value]) => (
          <p key={label} className="flex min-w-0 gap-1.5 text-[10px] leading-relaxed">
            <span className="w-11 shrink-0 uppercase tracking-wider text-zinc-400">{label}</span>
            <span className="min-w-0 flex-1 wrap-break-word text-zinc-300">{value}</span>
          </p>
        ))
      )}
      <p className="mt-0.5 text-[8px] uppercase tracking-widest text-zinc-400">
        {data.confidence} confidence · {data.provider}{data.cached ? ' · cached' : ''}
      </p>
    </div>
  );
};

const ChipRow: React.FC<{
  kind: 'genre' | 'vibe';
  labels: string[];
  selected: Set<string>;
  onToggle: (kind: 'genre' | 'vibe', label: string) => void;
}> = ({ kind, labels, selected, onToggle }) => (
  <div className="flex flex-wrap gap-1">
    {labels.map((label) => {
      const on = selected.has(label);
      return (
        <button
          key={label}
          type="button"
          aria-pressed={on}
          onClick={() => onToggle(kind, label)}
          className={`rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${
            on
              ? 'border-lime-500/50 bg-lime-500/15 text-lime-200'
              : 'border-white/10 bg-white/5 text-zinc-500 hover:text-zinc-300'
          }`}
        >
          {label}
        </button>
      );
    })}
  </div>
);

/** Capability chip: lit when the backing service/key is ready, dim otherwise.
 *  Undefined (status not fetched yet) renders neutral. */
const StatusPill: React.FC<{ label: string; ok?: boolean }> = ({ label, ok }) => (
  <span
    className={
      ok === undefined
        ? 'rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-zinc-500'
        : ok
          ? 'rounded-full border border-lime-500/40 bg-lime-500/10 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-lime-200'
          : 'rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-zinc-600'
    }
    title={ok === false ? `${label}: needs a key — add it via the key button` : undefined}
  >
    {label}
  </span>
);
