/** REST client for the TOUR backend module (/api/tour): status + key config
 *  (Slice 1), geocode/venues/filters (Slice 2). All keys live server-side —
 *  this client never sees a value, only configured/not-configured booleans. */
import { getJson, postJson, putJson } from './apiJson';

export interface TourStatus {
  ok: boolean;
  map: { provider: string; keyless: boolean };
  keys: { ors: boolean; openchargemap: boolean; llm_env: boolean };
  capabilities: {
    geocode: boolean;
    venues: boolean;
    route: boolean;
    chargers: boolean;
    enrich: boolean;
  };
}

export interface TourKeyState {
  configured: boolean;
  from_env: boolean;
  stored: boolean;
}

export interface TourConfig {
  ok: boolean;
  keys: Record<string, TourKeyState>;
}

export const fetchTourStatus = (): Promise<TourStatus> => getJson('/api/tour/status');

export const fetchTourConfig = (): Promise<TourConfig> => getJson('/api/tour/config');

/** Save keys. Empty string clears a key; undefined leaves it unchanged. */
export const saveTourConfig = (keys: { ors?: string; openchargemap?: string }): Promise<TourConfig> =>
  postJson('/api/tour/config', keys);

// ── Slice 2: discovery + filters ────────────────────────────────────────────

export interface TourBbox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface TourGeocode {
  query: string;
  display_name: string;
  lat: number;
  lon: number;
  bbox: TourBbox;
}

export interface TourVenue {
  id: string;
  name: string;
  category: string;
  lat: number;
  lon: number;
  website: string;
  email: string;
  phone: string;
  instagram: string;
  facebook: string;
  twitter: string;
  youtube: string;
  tiktok: string;
  soundcloud: string;
  bandcamp: string;
  spotify: string;
  whatsapp: string;
  address: string;
  city: string;
  genres: string[];
  vibes: string[];
}

export interface TourReverse {
  city: string;
  county: string;
  state: string;
  display_name: string;
}

export interface TourFilters {
  ok: boolean;
  selected: { genres: string[]; vibes: string[] };
  available: { genres: string[]; vibes: string[] };
}

/** Geocode a place/address. `viewbox` [west,south,east,north] softly biases
 *  toward the current map view; `ref` [lat,lon] is the trip anchor (first stop /
 *  start / map center) so the NEAREST sensible match wins and an ambiguous name
 *  resolves to the place nearest the tour, not a far higher-importance namesake. */
export const geocodeRegion = (
  q: string,
  viewbox?: [number, number, number, number],
  ref?: [number, number],
): Promise<TourGeocode> => {
  let url = `/api/tour/geocode?q=${encodeURIComponent(q)}`;
  if (viewbox) {
    const [w, s, e, n] = viewbox;
    url += `&west=${w}&south=${s}&east=${e}&north=${n}`;
  }
  if (ref) {
    const [lat, lon] = ref;
    url += `&ref_lat=${lat}&ref_lon=${lon}`;
  }
  return getJson(url);
};

/** Coords -> place name, to fill a venue's city when OSM omits addr:city. */
export const reverseGeocode = (lat: number, lon: number): Promise<TourReverse> =>
  getJson(`/api/tour/reverse?lat=${lat}&lon=${lon}`);

export const fetchVenues = (bbox: TourBbox): Promise<{ ok: boolean; count: number; venues: TourVenue[] }> =>
  postJson('/api/tour/venues', bbox);

export interface TourCharger {
  id: string;
  name: string;
  town: string;
  lat: number;
  lon: number;
  connections: number;
  operator: string;
}

/** EV charging stations sampled along a route polyline ([lon,lat] pairs);
 *  key held server-side. */
export const fetchChargers = (geometry: [number, number][]): Promise<{ ok: boolean; count: number; chargers: TourCharger[] }> =>
  postJson('/api/tour/chargers', { geometry });

export const fetchTourFilters = (): Promise<TourFilters> => getJson('/api/tour/filters');

export const saveTourFilters = (genres: string[], vibes: string[]): Promise<unknown> =>
  putJson('/api/tour/filters', { genres, vibes });

// ── Slice 4: route optimization ─────────────────────────────────────────────

export interface TourRouteStop {
  id: string;
  name: string;
  lat: number;
  lon: number;
  city?: string;
}

/** Tour date window (ISO YYYY-MM-DD strings; empty = open-ended). */
export interface TourTimeframe {
  start: string;
  end: string;
}

export interface TourRouteLeg {
  from: string;
  to: string;
  distance_m: number;
  duration_s: number;
}

export interface TourRoute {
  ok: boolean;
  start: { lat: number; lon: number; label: string };
  roundtrip: boolean;
  stops: TourRouteStop[];
  legs: TourRouteLeg[];
  total: { distance_m: number; duration_s: number };
  /** Route LineString as [lon, lat] pairs, ready for a GeoJSON map source. */
  geometry: [number, number][];
  /** Stops the optimizer could not reach, carrying id so the client can
   *  correlate each back to a removable route stop. */
  unassigned: { id: string; name: string }[];
}

/** Optimize the stop order (default) or, with `ordered`, keep the given order
 *  (calendar mode) and route through the stops as-is. */
export const optimizeTourRoute = (
  start: { lat: number; lon: number; label: string },
  stops: TourRouteStop[],
  roundtrip: boolean,
  timeframe?: TourTimeframe,
  ordered?: boolean,
): Promise<TourRoute> =>
  postJson('/api/tour/route', { start, stops, roundtrip, timeframe, ordered });

// ── Slice 3: booking-contact enrichment ────────────────────────────────────

export interface TourEnrichment {
  ok: boolean;
  booking_email: string;
  booking_form_url: string;
  phone: string;
  contact_name: string;
  submission_notes: string;
  confidence: 'high' | 'medium' | 'low';
  source_url: string;
  provider: string;
  model: string;
  cached: boolean;
}

/** Same localStorage the assistant panel writes its per-provider keys to. */
const ASSISTANT_KEYS_STORAGE = 'thedaw_orb_api_keys';

/** Pick the enrichment provider + key from the assistant's stored keys:
 *  Gemini first (it also powers the no-website web-search path), then any
 *  other provider with a key. Empty result still works when the backend has
 *  an env key — the server resolves request > pool > env like chat does. */
export function pickEnrichProvider(): { provider: string; apiKey?: string } {
  try {
    const stored = JSON.parse(localStorage.getItem(ASSISTANT_KEYS_STORAGE) || '{}') as Record<string, string>;
    if (stored.gemini) return { provider: 'gemini', apiKey: stored.gemini };
    for (const [provider, key] of Object.entries(stored)) {
      if (key) return { provider, apiKey: key };
    }
  } catch {
    /* corrupt localStorage — fall through to env-side resolution */
  }
  return { provider: 'gemini' };
}

export const enrichVenue = (
  venue: TourVenue,
  opts: { provider: string; apiKey?: string; force?: boolean },
): Promise<TourEnrichment> =>
  postJson('/api/tour/enrich', {
    venue,
    provider: opts.provider,
    api_key: opts.apiKey,
    force: opts.force ?? false,
  });
