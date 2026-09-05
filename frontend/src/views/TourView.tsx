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
 * date window. Slice 6: calendar mode (keep show-date order, flag legs that
 * do not fit).
 *
 * The left rail is a five-step workflow (views/tour/RailStep): 1 Where (region
 * search + home base) -> 2 When (dates, optional) -> 3 What (filters) ->
 * 4 Venues (results, Add to route) -> 5 Route (stops, order, optimize /
 * calendar, totals). Steps auto-open/close on the transitions that matter
 * (a search collapses Where and reveals Venues; the first stop opens Route);
 * the user can toggle any step by hand at any time.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './tourMap.css';
import { List, type ListImperativeAPI } from 'react-window';
import {
  ChevronDown,
  ChevronUp,
  KeyRound,
  MapPin,
  Plus,
  Route,
  Search,
  X,
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
import { RailStep, type StepState } from './tour/RailStep';
import { ChipGroup } from './tour/ChipGroup';
import { ContactLinks } from './tour/ContactLinks';
import { VenueRow } from './tour/VenueRow';

const MAP_STYLE = 'https://tiles.openfreemap.org/styles/dark';
const MARKER_CAP = 400;
const ROW_HEIGHT = 48;
// Mirrors the backend cap (routing.MAX_STOPS) — ORS limits jobs/waypoints.
const ROUTE_STOP_CAP = 40;
// Nominal daily driving budget for the calendar-mode feasibility check: a leg
// is flagged "tight" when its drive can't fit in the days between show dates at
// this pace. Slice 7 makes this an explicit, user-tunable filter.
const CALENDAR_DAILY_DRIVE_HOURS = 10;
// First-use guide: example regions a new user can search with one click.
const GUIDE_EXAMPLES = ['Austin, TX', 'Los Angeles', 'Nashville', 'Berlin'];

/** Rail steps, in workflow order. */
type StepId = 'where' | 'when' | 'what' | 'venues' | 'route';

// Shared control styles for the rail (12 px fields, 11 px buttons).
const INPUT_CLS =
  'rounded border border-white/10 bg-white/5 px-2 py-1.5 text-[12px] text-zinc-100 placeholder:text-zinc-600 focus:border-lime-500/50 focus:outline-none';
const BTN_PRIMARY_CLS =
  'flex shrink-0 items-center gap-1 rounded border border-lime-500/40 bg-lime-500/15 px-2.5 py-1.5 text-[11px] font-bold text-lime-100 hover:bg-lime-500/25 disabled:opacity-40';
const BTN_GHOST_CLS =
  'shrink-0 rounded border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-zinc-300 hover:border-white/20 hover:text-zinc-100 disabled:opacity-40';
const ICON_BTN_CLS = 'shrink-0 rounded p-0.5 text-zinc-500 hover:text-zinc-200 disabled:opacity-30 disabled:hover:text-zinc-500';

const fmtDur = (s: number): string => {
  const m = Math.round(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};
const fmtMiles = (meters: number): string => `${(meters / 1609.344).toFixed(1)} mi`;
// ISO date -> "May 3" for collapsed-step summaries.
const fmtDate = (iso: string): string => {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

/** Dashed empty/error/guidance note used inside rail steps. */
const RailNote: React.FC<{ tone?: 'muted' | 'warn' | 'error'; children: React.ReactNode }> = ({ tone = 'muted', children }) => (
  <p
    role={tone === 'error' ? 'alert' : undefined}
    className={`rounded-md border border-dashed px-3 py-2.5 text-[11px] leading-snug ${
      tone === 'error'
        ? 'border-red-500/30 text-red-300'
        : tone === 'warn'
          ? 'border-amber-500/30 text-amber-200/90'
          : 'border-white/10 text-zinc-500'
    }`}
  >
    {children}
  </p>
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

  // ── First-use guide (empty state over the basemap) ─────────────────────────
  // Shown until a region has been found (or the user dismisses it): says what
  // the tab is, what to do first, and offers the first action right there.
  const [guideDismissed, setGuideDismissed] = useState(false);
  const [guideQuery, setGuideQuery] = useState('');

  // ── Rail workflow state ───────────────────────────────────────────────────
  // Hovered venue (list row <-> map marker sync); '' when nothing is hovered.
  const [hoverId, setHoverId] = useState('');
  // Which steps are expanded. Where + Venues open on first paint so a new user
  // sees the primary action and what will appear below it.
  const [openSteps, setOpenSteps] = useState<Set<StepId>>(() => new Set(['where', 'venues']));
  // Polite live-region text for stop reordering (screen readers).
  const [announce, setAnnounce] = useState('');
  const markerElsRef = useRef<Map<string, HTMLElement>>(new Map());

  const toggleStep = useCallback((id: StepId) => {
    setOpenSteps((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  // After a successful search the region is settled: fold Where down to its
  // summary and make sure the results step is visible.
  const revealVenues = useCallback(() => {
    setOpenSteps((prev) => {
      const next = new Set(prev);
      next.delete('where');
      next.add('venues');
      return next;
    });
  }, []);

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
      revealVenues();
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : String(e));
      setVenues([]);
    } finally {
      setBusy(false);
    }
  }, [busy, currentViewbox, currentRef, revealVenues]);

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
      revealVenues();
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : String(e));
      setVenues([]);
    } finally {
      setBusy(false);
    }
  }, [busy, revealVenues]);

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
    const els = new Map<string, HTMLElement>();
    markerElsRef.current = els;
    for (const v of markerSet) {
      const inRoute = routeIds.has(v.id);
      const order = routeOrder.get(v.id);
      const el = document.createElement('div');
      el.className = inRoute ? 'tour-marker tour-marker--stop' : 'tour-marker';
      if (inRoute && order) el.textContent = String(order);
      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([v.lon, v.lat])
        .setPopup(
          new maplibregl.Popup({ closeButton: false, offset: 12, className: 'tour-popup' })
            .setText(v.name),
        )
        .addTo(map);
      el.addEventListener('click', () => selectVenue(v, false));
      el.addEventListener('mouseenter', () => setHoverId(v.id));
      el.addEventListener('mouseleave', () => setHoverId(''));
      els.set(v.id, el);
      markersRef.current.push(marker);
    }
  }, [markerSet, routeIds, routeOrder, selectVenue]);

  // Mirror the hovered / selected list row on its marker without rebuilding
  // the marker set (which can be 400 elements).
  useEffect(() => {
    for (const [id, el] of markerElsRef.current) {
      el.classList.toggle('is-hover', id === hoverId);
      el.classList.toggle('is-selected', id === selectedId);
    }
  }, [hoverId, selectedId, markerSet]);

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


  // ── Rail helpers: reorder stops, clear filters/dates, auto-open Route ─────
  // Swap a stop with its neighbour IN THE DISPLAYED LIST (routeStops, or the
  // date-sorted calendarStops) and write that order back. In calendar mode a
  // dated stop snaps back to its date position, so its buttons are disabled.
  const moveStop = useCallback((list: TourVenue[], i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    const next = [...list];
    [next[i], next[j]] = [next[j], next[i]];
    setRouteStops(next);
    setAnnounce(`${next[j].name} moved to position ${j + 1} of ${next.length}`);
    invalidateRoute();
  }, [invalidateRoute]);

  const clearFilters = useCallback(() => {
    setSelGenres(new Set());
    setSelVibes(new Set());
    persistFilters(new Set(), new Set());
  }, [persistFilters]);

  const clearDates = useCallback(() => {
    setDateStart('');
    setDateEnd('');
  }, []);

  // The Route step stays folded until the first stop exists, then opens; it
  // folds again when the last stop goes. Manual toggles in between are kept.
  const hadStops = useRef(false);
  useEffect(() => {
    const has = routeStops.length > 0;
    if (has === hadStops.current) return;
    hadStops.current = has;
    setOpenSteps((prev) => {
      const next = new Set(prev);
      if (has) next.add('route');
      else next.delete('route');
      return next;
    });
  }, [routeStops.length]);

  const caps = status?.capabilities;
  // Undefined until /status answers — never gate on a not-yet-known capability.
  const venuesOffline = caps ? !caps.venues : false;
  const routeOffline = caps ? !caps.route : false;
  const filterCount = selGenres.size + selVibes.size;

  // The step the user should work on next, top to bottom.
  const activeStep: StepId = !regionName ? 'where' : routeStops.length === 0 ? 'venues' : 'route';
  const stepState = (id: StepId, done: boolean, optional = false): StepState =>
    done ? 'done' : id === activeStep ? 'active' : optional ? 'optional' : 'todo';
  const whereState = stepState('where', !!regionName);
  const whenState = stepState('when', !!(dateStart && dateEnd), true);
  const whatState = stepState('what', filterCount > 0, true);
  const venuesState = stepState('venues', routeStops.length > 0);
  const routeState = stepState('route', !!route);

  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const whereSummary = regionName
    ? `${regionName}${startPoint ? ` · from ${startPoint.label}` : ''}`
    : 'Search a city or region to begin';
  const whenSummary = dateStart && dateEnd
    ? `${fmtDate(dateStart)} - ${fmtDate(dateEnd)} · ${plural(tripDays, 'day')}`
    : dateStart
      ? `From ${fmtDate(dateStart)}`
      : dateEnd
        ? `Until ${fmtDate(dateEnd)}`
        : 'Any dates';
  const whatSummary = filterCount > 0
    ? `${plural(filterCount, 'filter')}${venues.length ? ` · ${filtered.length} of ${venues.length} venues` : ''}`
    : venues.length ? `No filters · ${plural(venues.length, 'venue')}` : 'No filters';
  const venuesSummary = venues.length
    ? `${plural(sorted.length, 'venue')} · ${routeStops.length} added`
    : 'Nothing yet — search first';
  const routeSummary = routeStops.length === 0
    ? 'Add a venue to start'
    : route
      ? `${plural(routeStops.length, 'stop')} · ${fmtDur(route.total.duration_s)} · ${fmtMiles(route.total.distance_m)}`
      : `${plural(routeStops.length, 'stop')} · not routed yet`;

  const displayedStops = routeMode === 'calendar' ? calendarStops : routeStops;
  const routeButtonLabel = routeBusy
    ? 'Routing...'
    : routeMode === 'calendar'
      ? route ? 'Rebuild from dates' : 'Build from dates'
      : route ? 'Optimize again' : 'Optimize drive';

  return (
    <div className="h-full min-h-0 flex flex-col bg-[#0a080f]">
      <div className="relative flex items-center gap-3 px-3 py-1.5 border-b border-white/8 shrink-0">
        <span className="text-[11px] font-black uppercase tracking-widest text-lime-200">Tour</span>
        <span className="min-w-0 truncate text-[11px] text-zinc-500">
          Find venues, pick stops, route the drive.
        </span>
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
        <aside
          aria-label="Tour planner"
          className="flex w-80 shrink-0 flex-col overflow-x-hidden overflow-y-auto border-r border-white/8"
        >
          {/* ── 1 · Where ──────────────────────────────────────────────── */}
          <RailStep
            n={1}
            id="tour-step-where"
            title="Where"
            helper="Search a city or region. Venues there appear in step 4."
            state={whereState}
            open={openSteps.has('where')}
            onToggle={() => toggleStep('where')}
            summary={whereSummary}
          >
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => { e.preventDefault(); void runSearch(query); }}
            >
              <label htmlFor="tour-region" className="sr-only">City or region</label>
              <input
                id="tour-region"
                name="tour-region"
                type="text"
                autoComplete="off"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="City or region, e.g. Austin, TX"
                className={`min-w-0 flex-1 ${INPUT_CLS}`}
              />
              <button type="submit" disabled={busy || !query.trim()} className={BTN_PRIMARY_CLS}>
                <Search className="h-3 w-3" aria-hidden="true" />
                {busy ? 'Searching...' : 'Search'}
              </button>
            </form>
            {searchError ? (
              <div className="mt-2"><RailNote tone="error">{searchError}</RailNote></div>
            ) : venuesOffline ? (
              <div className="mt-2">
                <RailNote tone="warn">Venue search is offline — start the backend, then search again.</RailNote>
              </div>
            ) : regionName && !busy ? (
              <p className="mt-2 text-[11px] leading-snug text-zinc-400">
                Showing <span className="text-zinc-200">{regionName}</span> · {plural(venues.length, 'venue')}.
                Pan the map and use &ldquo;Search this area&rdquo; to look elsewhere.
              </p>
            ) : null}

            <div className="mt-3">
              <p className="mb-1 text-[11px] text-zinc-400">
                Home base <span className="text-zinc-600">(optional)</span>
              </p>
              {startPoint ? (
                <div className="flex items-center gap-2 rounded border border-white/10 bg-white/5 px-2 py-1.5">
                  <MapPin className="h-3 w-3 shrink-0 text-lime-300" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate text-[12px] text-zinc-100" title={startPoint.label}>
                    {startPoint.label}
                  </span>
                  <button type="button" aria-label="Clear home base" onClick={clearStart} className={ICON_BTN_CLS}>
                    <X className="h-3 w-3" aria-hidden="true" />
                  </button>
                </div>
              ) : (
                <form
                  className="flex items-center gap-2"
                  onSubmit={(e) => { e.preventDefault(); void setStart(startQuery); }}
                >
                  <label htmlFor="tour-start" className="sr-only">Home base city or address</label>
                  <input
                    id="tour-start"
                    name="tour-start"
                    type="text"
                    autoComplete="off"
                    value={startQuery}
                    onChange={(e) => setStartQuery(e.target.value)}
                    placeholder="City or address"
                    className={`min-w-0 flex-1 ${INPUT_CLS}`}
                  />
                  <button type="submit" disabled={startBusy || !startQuery.trim()} className={BTN_GHOST_CLS}>
                    {startBusy ? '...' : 'Set'}
                  </button>
                </form>
              )}
              {startError && <p role="alert" className="mt-1 text-[11px] leading-snug text-red-400">{startError}</p>}
              <p className="mt-1 text-[10px] leading-snug text-zinc-600">
                Where the drive starts{roundtrip ? ' and ends' : ''}. Without one, the route starts at the searched region.
              </p>
            </div>
          </RailStep>

          {/* ── 2 · When ───────────────────────────────────────────────── */}
          <RailStep
            n={2}
            id="tour-step-when"
            title="When"
            helper="Optional. Show dates in step 5 must fall inside this window."
            state={whenState}
            open={openSteps.has('when')}
            onToggle={() => toggleStep('when')}
            summary={whenSummary}
            meta={whenState === 'optional' ? 'optional' : undefined}
          >
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label htmlFor="tour-date-start" className="mb-1 block text-[11px] text-zinc-400">From</label>
                <input
                  id="tour-date-start"
                  name="tour-date-start"
                  type="date"
                  value={dateStart}
                  max={dateEnd || undefined}
                  onChange={(e) => setDateStart(e.target.value)}
                  className={`w-full scheme-dark ${INPUT_CLS}`}
                />
              </div>
              <div>
                <label htmlFor="tour-date-end" className="mb-1 block text-[11px] text-zinc-400">To</label>
                <input
                  id="tour-date-end"
                  name="tour-date-end"
                  type="date"
                  value={dateEnd}
                  min={dateStart || undefined}
                  onChange={(e) => setDateEnd(e.target.value)}
                  className={`w-full scheme-dark ${INPUT_CLS}`}
                />
              </div>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <span className="min-w-0 flex-1 text-[11px] text-zinc-400">
                {tripDays > 0 ? `${plural(tripDays, 'day')} on the road.` : 'Leave blank for an open-ended trip.'}
              </span>
              {(dateStart || dateEnd) && (
                <button type="button" onClick={clearDates} className={BTN_GHOST_CLS}>Clear dates</button>
              )}
            </div>
          </RailStep>

          {/* ── 3 · What ───────────────────────────────────────────────── */}
          <RailStep
            n={3}
            id="tour-step-what"
            title="What"
            helper="Narrow the list. Filters apply instantly and are remembered."
            state={whatState}
            open={openSteps.has('what')}
            onToggle={() => toggleStep('what')}
            summary={whatSummary}
            meta={venues.length > 0 ? `${filtered.length} of ${venues.length}` : filterCount === 0 ? 'optional' : undefined}
            actions={
              filterCount > 0 ? (
                <button type="button" onClick={clearFilters} className={BTN_GHOST_CLS}>Clear filters</button>
              ) : undefined
            }
          >
            <div className="space-y-3">
              <ChipGroup
                id="tour-genre"
                label="Genre"
                labels={availGenres}
                selected={selGenres}
                onToggle={(l) => toggleChip('genre', l)}
                empty="Genres load once the backend answers."
              />
              <ChipGroup
                id="tour-vibe"
                label="Venue type"
                labels={availVibes}
                selected={selVibes}
                onToggle={(l) => toggleChip('vibe', l)}
                empty="Venue types load once the backend answers."
              />
              <div role="group" aria-labelledby="tour-energy-label">
                <p id="tour-energy-label" className="mb-1 text-[11px] text-zinc-400">Energy</p>
                <div className="flex gap-1">
                  {(['gas', 'ev'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      aria-pressed={energyMode === m}
                      onClick={() => setEnergyMode(m)}
                      className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                        energyMode === m
                          ? 'border-lime-500/50 bg-lime-500/15 text-lime-200'
                          : 'border-white/10 bg-white/5 text-zinc-400 hover:border-white/20 hover:text-zinc-200'
                      }`}
                    >
                      {m === 'gas' ? 'Gas' : 'EV'}
                    </button>
                  ))}
                </div>
                <p className="mt-1 text-[10px] leading-snug text-zinc-600">
                  EV adds charging stations along the route once it is built.
                </p>
              </div>
            </div>
            {venues.length > 0 && (
              <p className="mt-3 text-[11px] text-zinc-400">
                Showing <span className="text-zinc-200">{filtered.length}</span> of {venues.length} venues.
              </p>
            )}
          </RailStep>

          {/* ── 4 · Venues ─────────────────────────────────────────────── */}
          <RailStep
            n={4}
            id="tour-step-venues"
            title="Venues"
            helper="Click a name to fly there. Add makes it a stop in step 5."
            state={venuesState}
            open={openSteps.has('venues')}
            onToggle={() => toggleStep('venues')}
            summary={venuesSummary}
            meta={venues.length > 0 ? String(sorted.length) : undefined}
            grow
          >
            {venues.length > 0 && (
              <div className="mb-2 flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[11px] text-zinc-400">
                  {sorted.length} of {venues.length}{filterCount > 0 ? ' match your filters' : ' venues'}
                </span>
                <label htmlFor="tour-sort" className="text-[11px] text-zinc-500">Sort</label>
                <select
                  id="tour-sort"
                  name="tour-sort"
                  value={sortMode}
                  onChange={(e) => setSortMode(e.target.value as 'relevance' | 'name' | 'type')}
                  className="shrink-0 rounded border border-white/10 bg-[#17131f] px-1.5 py-1 text-[11px] text-zinc-200 scheme-dark focus:border-lime-500/50 focus:outline-none"
                >
                  <option value="relevance">Relevance</option>
                  <option value="name">Name A-Z</option>
                  <option value="type">Type</option>
                </select>
              </div>
            )}
            <div className="min-h-24 flex-1" role="region" aria-label="Venue results">
              {busy ? (
                <RailNote>Searching {query.trim() || 'the map area'}...</RailNote>
              ) : sorted.length > 0 ? (
                <List
                  listRef={listRef}
                  rowComponent={VenueRow}
                  rowCount={sorted.length}
                  rowHeight={ROW_HEIGHT}
                  rowProps={{
                    venues: sorted,
                    selectedId,
                    hoverId,
                    routeIds,
                    onFocus: focusVenue,
                    onHover: setHoverId,
                    onToggleRoute: toggleRouteStop,
                  }}
                  overscanCount={8}
                  style={{ height: '100%' }}
                />
              ) : venues.length > 0 ? (
                <RailNote>
                  No venues match your filters.{' '}
                  <button type="button" onClick={clearFilters} className="text-lime-300 underline-offset-2 hover:underline">
                    Clear filters
                  </button>
                </RailNote>
              ) : searchError ? (
                <RailNote tone="error">The search failed — see step 1 for the reason, then try again.</RailNote>
              ) : regionName ? (
                <RailNote>
                  No venues found in {regionName}. Try a larger city, or zoom the map and use &ldquo;Search this area&rdquo;.
                </RailNote>
              ) : (
                <RailNote>
                  Venues from your search will list here — name, type, address and contact links — each with an
                  <span className="mx-1 inline-flex items-center gap-0.5 rounded-full border border-white/15 px-1 text-zinc-300">
                    <Plus className="h-2.5 w-2.5" aria-hidden="true" />Add
                  </span>
                  button to make it a stop.
                </RailNote>
              )}
            </div>
            {selectedVenue && (
              <div className="mt-2 shrink-0 rounded-md border border-lime-500/25 bg-lime-500/5 px-2.5 py-2">
                <div className="flex items-start gap-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] font-bold text-zinc-100">{selectedVenue.name}</span>
                    <span className="block truncate text-[10px] text-zinc-400">
                      {selectedVenue.category.replace(/_/g, ' ')}
                      {selectedVenue.city ? ` · ${selectedVenue.city}` : ''}
                    </span>
                    {selectedVenue.address && (
                      <span className="block truncate text-[10px] text-zinc-500">{selectedVenue.address}</span>
                    )}
                  </span>
                  <button
                    type="button"
                    aria-label="Close venue details"
                    onClick={() => setSelectedId('')}
                    className={ICON_BTN_CLS}
                  >
                    <X className="h-3 w-3" aria-hidden="true" />
                  </button>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <ContactLinks v={selectedVenue} />
                  <button
                    type="button"
                    onClick={() => toggleRouteStop(selectedVenue)}
                    aria-pressed={routeIds.has(selectedVenue.id)}
                    className={`ml-auto ${BTN_GHOST_CLS}`}
                  >
                    {routeIds.has(selectedVenue.id) ? 'Remove stop' : 'Add stop'}
                  </button>
                  <button
                    type="button"
                    disabled={enrichBusy}
                    onClick={() => void runEnrich(selectedVenue)}
                    className={BTN_PRIMARY_CLS}
                  >
                    {enrichBusy ? 'Finding...' : 'Find booking info'}
                  </button>
                </div>
                {enrichError && (
                  <p role="alert" className="mt-1.5 text-[11px] leading-snug text-red-400">{enrichError}</p>
                )}
                {enrichments[selectedVenue.id] && (
                  <EnrichResult data={enrichments[selectedVenue.id]} />
                )}
              </div>
            )}
          </RailStep>

          {/* ── 5 · Route ──────────────────────────────────────────────── */}
          <RailStep
            n={5}
            id="tour-step-route"
            title="Route"
            helper="Order your stops, then optimize the drive or build it from show dates."
            state={routeState}
            open={openSteps.has('route')}
            onToggle={() => toggleStep('route')}
            summary={routeSummary}
            meta={routeStops.length > 0 ? plural(routeStops.length, 'stop') : undefined}
            actions={
              routeStops.length > 0 ? (
                <button type="button" onClick={clearRoute} className={BTN_GHOST_CLS}>Clear</button>
              ) : undefined
            }
          >
            {routeStops.length === 0 ? (
              <RailNote>Press Add on a venue in step 4. Stops collect here in the order you add them.</RailNote>
            ) : (
              <>
                <div role="group" aria-label="Route mode" className="grid grid-cols-2 overflow-hidden rounded border border-white/10">
                  {(['optimize', 'calendar'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      aria-pressed={routeMode === m}
                      onClick={() => changeRouteMode(m)}
                      className={`px-2 py-1 text-[11px] font-semibold transition-colors ${
                        routeMode === m ? 'bg-lime-500/20 text-lime-100' : 'text-zinc-400 hover:text-zinc-200'
                      }`}
                    >
                      {m === 'optimize' ? 'Optimize order' : 'By show dates'}
                    </button>
                  ))}
                </div>
                <p className="mt-1 text-[10px] leading-snug text-zinc-600">
                  {routeMode === 'optimize'
                    ? 'Reorders the stops for the shortest drive.'
                    : 'Keeps your show dates in order and flags legs that do not fit. Undated stops keep list order.'}
                </p>
                <p aria-live="polite" className="sr-only">{announce}</p>

                {route ? (
                  <ol className="mt-2 max-h-52 overflow-y-auto" aria-label="Drive order">
                    {route.stops.map((s, i) => {
                      const feas = legFeasibility(i);
                      const leg = route.legs[i];
                      return (
                        <li key={s.id} className="flex items-center gap-1.5 py-1">
                          <span className="w-4 shrink-0 text-right text-[10px] font-bold text-lime-300/80">{i + 1}</span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[12px] text-zinc-100">{s.name}</span>
                            <span className="block truncate text-[10px] text-zinc-500">
                              {routeMode === 'calendar' && stopDates[s.id] ? `${fmtDate(stopDates[s.id])} · ` : ''}
                              {leg ? `${fmtDur(leg.duration_s)} · ${fmtMiles(leg.distance_m)}` : s.city ?? ''}
                            </span>
                          </span>
                          {feas === 'tight' && (
                            <span
                              title="This drive may not fit before the show date"
                              className="shrink-0 rounded bg-amber-500/15 px-1 text-[10px] font-bold text-amber-400"
                            >
                              tight
                            </span>
                          )}
                          <button
                            type="button"
                            aria-label={`Remove ${s.name} from route`}
                            onClick={() => removeRouteStop(s.id)}
                            className={ICON_BTN_CLS}
                          >
                            <X className="h-3 w-3" aria-hidden="true" />
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                ) : (
                  <ol className="mt-2 max-h-52 overflow-y-auto" aria-label="Stops">
                    {displayedStops.map((s, i) => {
                      const dated = routeMode === 'calendar' && !!stopDates[s.id];
                      return (
                        <li key={s.id} className="flex items-center gap-1.5 py-1">
                          <span className="w-4 shrink-0 text-right text-[10px] font-bold text-lime-300/80">{i + 1}</span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[12px] text-zinc-100">{s.name}</span>
                            <span className="block truncate text-[10px] text-zinc-500">
                              {s.city || s.address || s.category.replace(/_/g, ' ')}
                            </span>
                          </span>
                          {routeMode === 'calendar' && (
                            <>
                              <label htmlFor={`tour-stop-date-${s.id}`} className="sr-only">Show date for {s.name}</label>
                              <input
                                id={`tour-stop-date-${s.id}`}
                                name={`tour-stop-date-${s.id}`}
                                type="date"
                                value={stopDates[s.id] ?? ''}
                                min={dateStart || undefined}
                                max={dateEnd || undefined}
                                onChange={(e) => setStopDate(s.id, e.target.value)}
                                className="w-28 shrink-0 rounded border border-white/10 bg-white/5 px-1 py-0.5 text-[11px] text-zinc-100 scheme-dark focus:border-lime-500/50 focus:outline-none"
                              />
                            </>
                          )}
                          <span className="flex shrink-0 flex-col">
                            <button
                              type="button"
                              aria-label={`Move ${s.name} up`}
                              title={dated ? 'Dated stops follow their date' : 'Move up'}
                              disabled={i === 0 || dated}
                              onClick={() => moveStop(displayedStops, i, -1)}
                              className={ICON_BTN_CLS}
                            >
                              <ChevronUp className="h-3 w-3" aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              aria-label={`Move ${s.name} down`}
                              title={dated ? 'Dated stops follow their date' : 'Move down'}
                              disabled={i === displayedStops.length - 1 || dated}
                              onClick={() => moveStop(displayedStops, i, 1)}
                              className={ICON_BTN_CLS}
                            >
                              <ChevronDown className="h-3 w-3" aria-hidden="true" />
                            </button>
                          </span>
                          <button
                            type="button"
                            aria-label={`Remove ${s.name} from route`}
                            onClick={() => removeRouteStop(s.id)}
                            className={ICON_BTN_CLS}
                          >
                            <X className="h-3 w-3" aria-hidden="true" />
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                )}

                <div className="mt-2 flex items-center gap-2">
                  <input
                    id="tour-roundtrip"
                    name="tour-roundtrip"
                    type="checkbox"
                    checked={roundtrip}
                    onChange={(e) => setRoundtripMode(e.target.checked)}
                    className="h-3.5 w-3.5 accent-lime-400"
                  />
                  <label htmlFor="tour-roundtrip" className="text-[11px] text-zinc-300">Round trip</label>
                  <button
                    type="button"
                    disabled={routeBusy || routeOffline}
                    onClick={() => void runOptimize()}
                    className={`ml-auto ${BTN_PRIMARY_CLS}`}
                  >
                    <Route className="h-3 w-3" aria-hidden="true" />
                    {routeButtonLabel}
                  </button>
                </div>
                {routeOffline && (
                  <div className="mt-2">
                    <RailNote tone="warn">
                      Routing needs a free openrouteservice key — add it with the key button (top right).
                    </RailNote>
                  </div>
                )}
                {routeError && <div className="mt-2"><RailNote tone="error">{routeError}</RailNote></div>}

                {route && (
                  <div className="mt-2 space-y-1 border-t border-white/8 pt-2">
                    <p className="truncate text-[10px] text-zinc-500">Starts at {route.start.label}</p>
                    {route.roundtrip && route.legs.length > route.stops.length && (
                      <p className="flex justify-between text-[11px] text-zinc-400">
                        <span>Back to start</span>
                        <span>
                          {fmtDur(route.legs[route.legs.length - 1].duration_s)} · {fmtMiles(route.legs[route.legs.length - 1].distance_m)}
                        </span>
                      </p>
                    )}
                    <p className="flex justify-between text-[12px] font-bold text-zinc-100">
                      <span>Total drive</span>
                      <span>{fmtDur(route.total.duration_s)} · {fmtMiles(route.total.distance_m)}</span>
                    </p>
                    {route.unassigned.map((u) => (
                      <p key={u.id || u.name} className="flex items-center gap-1 text-[11px] leading-snug text-amber-400">
                        <span className="min-w-0 flex-1 truncate">Unreachable: {u.name}</span>
                        {u.id && (
                          <button
                            type="button"
                            aria-label={`Remove ${u.name} from route`}
                            onClick={() => removeRouteStop(u.id)}
                            className="shrink-0 text-amber-400/80 hover:text-red-400"
                          >
                            <X className="h-3 w-3" aria-hidden="true" />
                          </button>
                        )}
                      </p>
                    ))}
                    {energyMode === 'ev' && (
                      <p className="text-[11px] text-cyan-300" title={chargersMsg}>
                        {chargersMsg || `${plural(chargers.length, 'charging station')} along the route`}
                      </p>
                    )}
                  </div>
                )}
              </>
            )}
          </RailStep>
        </aside>

        <div className="relative flex-1 min-h-0">
          {/* Explicit h/w, NOT `absolute inset-0`: maplibre's stylesheet sets
              `.maplibregl-map { position: relative }` and, loading after
              Tailwind, wins the tie — which turns inset-0 into a no-op and
              collapses the container to 0 height (black tab). */}
          <div ref={containerRef} className="h-full w-full" />
          {!mapError && !guideDismissed && venues.length === 0 && !regionName && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-4">
              <section
                aria-labelledby="tour-guide-title"
                className="pointer-events-auto w-full max-w-md rounded-xl border border-lime-500/25 bg-[#0c0a14]/95 p-4 shadow-2xl backdrop-blur"
              >
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-lime-500/30 bg-lime-500/10 text-lime-200">
                    <Route className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h2 id="tour-guide-title" className="text-[13px] font-black uppercase tracking-widest text-lime-100">
                      Book the road
                    </h2>
                    <p className="mt-0.5 text-[11px] leading-snug text-zinc-400">
                      Find venues city by city, pick your stops, and TOUR works out the drive between them.
                      The numbered steps on the left walk you through it.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setGuideDismissed(true)}
                    aria-label="Dismiss guide"
                    className="shrink-0 rounded p-1 text-zinc-500 hover:bg-white/5 hover:text-zinc-200"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
                <ol className="mt-3 space-y-2 text-[11px] text-zinc-300">
                  <li className="flex items-center gap-2">
                    <span className="grid h-4.5 w-4.5 shrink-0 place-items-center rounded-full bg-lime-500/20 text-[9px] font-black text-lime-200">1</span>
                    <form
                      className="flex min-w-0 flex-1 items-center gap-1.5"
                      onSubmit={(e) => {
                        e.preventDefault();
                        setQuery(guideQuery);
                        void runSearch(guideQuery);
                      }}
                    >
                      <label htmlFor="tour-guide-region" className="sr-only">City or region to search</label>
                      <input
                        id="tour-guide-region"
                        name="tour-guide-region"
                        type="text"
                        autoComplete="off"
                        value={guideQuery}
                        onChange={(e) => setGuideQuery(e.target.value)}
                        placeholder="Search a city or region"
                        className="min-w-0 flex-1 rounded border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-zinc-200 placeholder:text-zinc-500 focus:border-lime-500/50 focus:outline-none"
                      />
                      <button
                        type="submit"
                        disabled={busy || !guideQuery.trim()}
                        className="flex shrink-0 items-center gap-1 rounded border border-lime-500/40 bg-lime-500/15 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-lime-200 disabled:opacity-40"
                      >
                        <Search className="h-3 w-3" aria-hidden="true" />
                        {busy ? 'Searching' : 'Search'}
                      </button>
                    </form>
                  </li>
                  <li className="flex items-center gap-2">
                    <span className="grid h-4.5 w-4.5 shrink-0 place-items-center rounded-full bg-lime-500/20 text-[9px] font-black text-lime-200">2</span>
                    <span>
                      Press{' '}
                      <span className="inline-flex items-center gap-0.5 rounded-full border border-white/15 px-1 text-zinc-200">
                        <Plus className="h-2.5 w-2.5" aria-hidden="true" />Add
                      </span>{' '}
                      on any venue in step 4 to make it a stop.
                    </span>
                  </li>
                  <li className="flex items-center gap-2">
                    <span className="grid h-4.5 w-4.5 shrink-0 place-items-center rounded-full bg-lime-500/20 text-[9px] font-black text-lime-200">3</span>
                    <span>In step 5, optimize the drive order or build it from your show dates.</span>
                  </li>
                </ol>
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  <span className="text-[9px] font-bold uppercase tracking-widest text-zinc-500">Try</span>
                  {GUIDE_EXAMPLES.map((ex) => (
                    <button
                      key={ex}
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setGuideQuery(ex);
                        setQuery(ex);
                        void runSearch(ex);
                      }}
                      className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] text-zinc-300 transition-colors hover:border-lime-500/40 hover:text-lime-200 disabled:opacity-40"
                    >
                      {ex}
                    </button>
                  ))}
                </div>
                {searchError && (
                  <p className="mt-2 text-[10px] leading-snug text-red-400">{searchError}</p>
                )}
                <p className="mt-2 text-[9px] leading-snug text-zinc-500">
                  Route optimization and EV stops need free service keys — add them with the key button (top right) when you get there.
                </p>
              </section>
            </div>
          )}
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
