## TOUR — Touring Planner

The TOUR workspace turns a map into a booking tool: find music venues in a region, filter them by genre and vibe, chain the good ones into an optimized drive, plan EV charging along the way, and pull each venue's booking contact — all on a keyless dark map. It is a self-contained backend module mounted at `/api/tour` with a React front end (`TourView.tsx`); every third-party call happens server-side, so no API key ever reaches the browser.

### The map
A **MapLibre GL** canvas renders **OpenFreeMap**'s dark vector style (`https://tiles.openfreemap.org/styles/dark`) — keyless, unlimited, commercial-OK, nothing to configure. The map is kept warm across tab switches and only resized when visible.

### Discover venues
- **Region search (Nominatim)** — type a city, region, or address and the map flies to it. An anchor (your first stop, start point, or the map center) biases the match by distance ring, so an ambiguous name resolves to the place nearest your tour rather than a far-away namesake.
- **Venue discovery (OSM Overpass)** — named, music-relevant places (bars, clubs, music/events venues, concert halls, theatres, arts and community centres, festival grounds) are pulled for the visible area, each tagged with matched **genres** (electronic, rock/metal, hip-hop, jazz/blues, country/folk, latin, indie/alt) and **vibes** (live room, dance club, dive bar, listening bar, festival, theater) from a curated vocabulary, plus every contact/social handle OSM carries.
- **Filter + list** — genre/vibe chips are persisted server-side and applied entirely client-side (flipping one never re-queries the provider). Results show in a virtualized list, sortable by relevance / A-Z / type.

### Plan the drive
- **Optimize mode** — add venues as stops and the **openrouteservice `/optimization`** endpoint (VROOM) reorders them into the shortest drive and returns the route geometry in one call; the app draws the line and lists per-leg times, totals, and any unreachable stops (capped at 40 stops).
- **Calendar mode** — assign a show date to each stop and the route holds that order (ORS Directions with ordered waypoints); legs whose drive can't fit between consecutive dates (at ~10 h/day) get a **tight** badge.
- **Trip setup** — set a home-base start point and a date window; while building, stops group by city (reverse-geocoded when OSM omits the city).

### EV chargers
Switch a route to **EV** and charging stations are sampled *along* the polyline via **OpenChargeMap** (walked at ~45 km spacing, deduped) so coverage spans the whole corridor instead of clustering in one metro. Requires an OpenChargeMap key (server-side).

### Booking-contact enrichment
Pick a venue and "Find booking info" returns a structured booking contact (email, form URL, phone, contact name, submission notes, confidence). If the venue has a website, TOUR fetches the homepage + up to two contact/booking subpages under a strict SSRF guard, strips them to text, and asks your chosen LLM provider's OpenAI-compatible chat endpoint to extract JSON. If no website is on record, it uses one **Gemini** `generateContent` call with the **google_search** grounding tool to search and extract together. It reuses the assistant's provider registry — Gemini (`gemini-flash-recent`), OpenAI (`gpt-4.1-mini`), Anthropic (`claude-sonnet-4-20250514`), Grok (`grok-3-mini-fast`), Groq (`llama-3.3-70b-versatile`), OpenRouter (`google/gemma-3-1b-it:free`) — and caches each result for a week.

### Keys and readiness
Capability pills (Map / Venues / Routes / EV / Enrich) show what's ready. Map, geocode, and venue discovery are keyless; route optimization and EV chargers need their keys, entered in a popover and stored server-side (env-first, then `data/tour_keys.json`). Enrichment lights up from any assistant LLM key.

### Runs light
Everything is cached to disk (`data/tour_cache`) with sensible TTLs; providers are throttled and retried gently; the Overpass query is index-friendly and its bbox grid-snapped for cache reuse; routes are one API call with in-process polyline decoding; the venue list is virtualized and markers capped. Note that TOUR needs internet for its core map/discovery/routing features — the enrichment website-scrape path can, however, target a local LLM (Ollama, LM Studio, llama.cpp, vLLM) instead of a cloud model.
