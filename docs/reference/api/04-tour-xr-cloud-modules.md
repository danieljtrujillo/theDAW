## theDAW HTTP API — "tour-xr-misc" router group

All routers are auto-discovered by `backend/modules/loader.py`: it scans `backend/modules/*/`, and for each dir that has both `module.json` and `router.py` it imports the module's `router` (an `APIRouter`) and mounts it at `config.get("api_prefix", f"/api/{module_dir.name}")` (`backend/modules/loader.py:41-42`). So the prefix is **`/api/<module-folder>` by default, but `module.json` can override it**. Two modules in this group do override it:

- `xrcontrol` -> **`/api/xr/control`** (`backend/modules/xrcontrol/module.json`)
- `genaiproxy` -> **`/api/genai-proxy`** (`backend/modules/genaiproxy/module.json`)

The routers themselves declare no prefix; every path below is shown fully prefixed. A module whose `module.json` has `"enabled": false` is skipped at load (`loader.py:35-37`).

### TOUR — venue discovery + route/EV planning (`/api/tour`)
Third-party keys stay server-side: env-first, then `data/tour_keys.json` (settable via `POST /config`).

| Method | Path | Purpose | Key/auth |
|---|---|---|---|
| GET | `/api/tour/status` | Capability/keys readiness | reports ORS/OpenChargeMap/LLM key presence |
| GET | `/api/tour/config` | Masked stored-key view | — |
| POST | `/api/tour/config` | Store ORS/OpenChargeMap keys | writes `data/tour_keys.json` |
| GET | `/api/tour/geocode` | Text -> centroid+bbox (Nominatim) | keyless |
| GET | `/api/tour/reverse` | Coords -> city/state (Nominatim) | keyless |
| POST | `/api/tour/venues` | Venues in bbox (Overpass) | keyless |
| POST | `/api/tour/chargers` | EV chargers along route (OpenChargeMap) | `OPENCHARGEMAP_API_KEY` |
| GET | `/api/tour/filters` | Chip preset + vocabulary | — |
| PUT | `/api/tour/filters` | Persist chip preset | — |
| POST | `/api/tour/route` | Optimize stops + geometry (ORS) | `ORS_API_KEY` |
| POST | `/api/tour/enrich` | Booking-contact enrichment (LLM) | assistant provider key |

Evidence: `backend/modules/tour/router.py:83,116,131,156,196,215,240,270,291,340,382`.

### QUEST DEPLOY — push a prebuilt APK over adb (`/api/quest`)
Local adb only, no external key.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/quest/status` | adb + device list (Quest flagged) |
| POST | `/api/quest/deploy` | `adb install -r`, optional launch |
| GET | `/api/quest/latest-apk` | Newest APK on theDAW-XR release |
| POST | `/api/quest/fetch-apk` | Download release APK to `data/quest/` |
| GET | `/api/quest/pick-apk` | Native file picker for `.apk` |
| POST | `/api/quest/set-adb-path` | Persist a manual adb path |

Evidence: `backend/modules/quest/router.py:53,66,101,113,127,143`.

### QUEST CAST — headset video source via scrcpy sidecar (`/api/questcast`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/questcast/status` | Sidecar/relay state incl. `ws_port` |
| GET | `/api/questcast/devices` | adb device list |
| POST | `/api/questcast/start` | Spawn relay (`{serial?}`) |
| POST | `/api/questcast/stop` | Stop relay |

The browser reads `ws_port` and connects the VJ's WebCodecs decoder to `ws://localhost:<ws_port>` (sidecar-owned WS, not a FastAPI route). Evidence: `backend/modules/questcast/router.py:27,32,37,46`.

### QUEST STITCH — clean passthrough as a VJ source (`/api/queststitch`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/queststitch/status` | Listener/adb/frame state |
| POST | `/api/queststitch/start` | Start TCP listener + adb reverse |
| POST | `/api/queststitch/stop` | Stop listener |
| POST | `/api/queststitch/reattach` | Re-run adb reverse only |
| WS | `/api/queststitch/ws` | H.264 stitch stream (questcast wire format), one-way Quest->browser |

Evidence: `backend/modules/queststitch/router.py:27,32,39,45,52`.

### QUEST MIDI — Quest hand-MIDI bridge (`/api/questmidi`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/questmidi/status` | Listener/adb/connection state |
| POST | `/api/questmidi/start` | Start listener + adb reverse |
| POST | `/api/questmidi/stop` | Stop listener |
| POST | `/api/questmidi/reattach` | Re-run adb reverse only |
| WS | `/api/questmidi/ws` | Inbound `{type:'midi',data:[...]}`; browser sends `{data:[...]}` for return MIDI |

Evidence: `backend/modules/questmidi/router.py:28,33,40,46,53`.

### XR CONTROL BUS — companion/headset control relay (`/api/xr/control`)
Prefix overridden in `module.json`. Transport only (holds no control state).

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET | `/api/xr/control/status` | Connected-peer count `{clients}` | — |
| WS | `/api/xr/control/ws` | Host<->controller relay + pairing handshake | optional session code; `host-hello` accepted only from localhost unless `THEDAW_XR_ALLOW_REMOTE_HOST=1` |

Evidence: `backend/modules/xrcontrol/router.py:114,208`; host gate `router.py:91-102`.

### CONTROLLER VISION — infer a MIDI controller layout from a photo (`/api/controllervision`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/controllervision` (and `/`) | Capability probe (OpenCV / vision-LLM availability) |
| POST | `/api/controllervision/identify` | Identify from uploaded photo (vision LLM) |
| POST | `/api/controllervision/detect` | Detect controls in uploaded photo (OpenCV) |
| POST | `/api/controllervision/detect-by-name` | Fetch Wikimedia product image + detect |
| POST | `/api/controllervision/session` | Open phone-pairing session (QR) |
| GET | `/api/controllervision/session/{sid}` | Poll phone result |
| POST | `/api/controllervision/session/{sid}/upload` | Phone uploads photo, identify + stash |
| GET | `/api/controllervision/m/{sid}` | Self-contained mobile upload HTML page |

Uploads capped at 20 MB. AI identify uses the Assistant's vision-LLM keys; classical CV is the no-key fallback (503 if OpenCV missing). Evidence: `backend/modules/controllervision/router.py:40,56,87,110,170,178,187,281`.

### AKVJ BRIDGE — Unity/Kinect -> VJ relay (`/api/akvj`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/akvj/status` | Relay source/viewer/frame counters |
| GET | `/api/akvj/sidecar` | Native Kinect (pyk4a) sidecar state |
| POST | `/api/akvj/start` | Spawn Kinect sidecar (idempotent) |
| POST | `/api/akvj/stop` | Stop Kinect sidecar |
| WS | `/api/akvj/ws/source` | Sender: JPEG (MJPEG) or AKV1 depth frames |
| WS | `/api/akvj/ws/view` | Viewer: primed with XY table + latest frame, drop-to-latest |

Evidence: `backend/modules/akvj/router.py:155,169,177,212,219,266`.

### SUNO — public-API proxy (`/api/suno`)
Key stays server-side: `SUNO_API_KEY` env, else `data/suno_api_key.json`. Generation routes 503 without a key. Upstream base `https://api.suno.com`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/suno/status` | Key configured? + prefix |
| POST | `/api/suno/key` | Store key server-side |
| GET | `/api/suno/voices` | Three preset voices |
| POST | `/api/suno/simple` | Simple generation |
| POST | `/api/suno/custom` | Custom (style + lyrics) |
| POST | `/api/suno/cover` | Cover a clip (lineage parent) |
| POST | `/api/suno/mashup` | Mash up two clips |
| GET | `/api/suno/poll/{job_id}` | Poll; on complete -> library entry |
| GET | `/api/suno/jobs` | All tracked jobs |
| GET | `/api/suno/usage` | Account usage/credits |
| GET | `/api/suno/audio/{job_id}` | Stream finished MP3 (SSRF-guarded to suno.ai CDN) |

Evidence: `backend/modules/suno/router.py:387,394,416,422,433,448,462,478,508,514,520`.

### GENAI PROXY — Gemini REST pass-through (`/api/genai-proxy`)
Prefix overridden in `module.json`. Single catch-all.

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET/POST/OPTIONS | `/api/genai-proxy/{rest:path}` | Replays request verbatim to `https://generativelanguage.googleapis.com`, injecting `x-goog-api-key`; strips client `key`/`authorization` | server `GEMINI_API_KEY` (503 if unset) |

Evidence: `backend/modules/genaiproxy/router.py:29,32`.
