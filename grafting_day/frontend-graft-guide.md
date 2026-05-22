# Frontend Graft Guide — StableDAW React UI

> **Purpose.** This is a handoff document. It is everything an engineer (human or agent) needs to take the React/Vite "StableDAW" frontend at `frontend/` in this repo and graft it onto another copy of the Stable Audio 3 app whose backend already works.
>
> **Scope.** Outline + procedure only. No code changes are performed by reading this. Pair this doc with [`frontend-graft-manifest.json`](./frontend-graft-manifest.json) for the machine-readable file list and contract.
>
> **Authoritative source paths in this repo:**
> - Frontend source: [`frontend/`](../../frontend/)
> - Prebuilt bundle: [`frontend/dist/`](../../frontend/dist/)
> - Reference backend (contract source): [`build/source-package/temp_extract/stable-audio-3-source-package-20260513-115113/backend/server.py`](../../build/source-package/temp_extract/stable-audio-3-source-package-20260513-115113/backend/server.py)

---

## 1. TL;DR — the one-paragraph version

The frontend is a self-contained React 19 + Vite 6 + Tailwind 4 + Zustand 5 app under [`frontend/`](../../frontend/). It speaks to the backend purely via same-origin `fetch('/api/...')` calls — there is no API base URL, no auth, no websocket. To graft it onto an older app that has the working FastAPI backend, you have two choices: **(A) ship the whole `frontend/` folder** and let the target run `npm install && npm run build`, or **(B) ship only `frontend/dist/`** and drop it into the backend's static-mount location. Either way, the receiving app must (1) expose the documented `/api/*` endpoints with matching payloads and (2) serve the built frontend on the same origin as the API, or proxy `/api` from a dev server to the API port. That is the whole job.

---

## 2. What the frontend is

### 2.1 Stack

| Concern        | Choice                          | Notes                                                                |
|----------------|---------------------------------|----------------------------------------------------------------------|
| Framework      | React 19.0.1                    | Functional components, hooks only. No class components.              |
| Bundler        | Vite 6.2.3                      | TypeScript, ESM, JSX runtime `react-jsx`.                            |
| Styling        | Tailwind 4 (via `@tailwindcss/vite`) | All styles inline via `className`. Single `src/index.css` for globals. |
| State          | Zustand 5.0.8                   | Four stores (see §3.3). No Redux, no Context providers.              |
| Icons          | lucide-react 0.546.0            | Tree-shaken. No icon font.                                           |
| Animation      | `motion` 12.23.24 (Framer Motion successor) | Used for view transitions.                                   |
| HTTP           | Native `fetch` only             | No axios. All paths are relative (`/api/...`).                       |
| Entry          | `src/main.tsx` → `<App />` → `<Shell />` + `<PlayerFooter />` | See [`src/App.tsx`](../../frontend/src/App.tsx). |

Vite alias: `@` → `frontend/` root. The frontend never references anything outside `frontend/`.

### 2.2 File tree (the entire surface)

```
frontend/
├── .env.example          # Only GEMINI_API_KEY / APP_URL — both optional, see §6
├── .gitignore
├── README.md             # AI Studio boilerplate, safe to overwrite
├── index.html            # Vite entry. Loads /src/main.tsx
├── metadata.json         # AI Studio metadata, ignored at runtime
├── package.json          # Pinned deps (see manifest)
├── package-lock.json     # 150 KB lockfile — ship it
├── tsconfig.json
├── vite.config.ts        # NO proxy block. See §4.2 for dev-mode caveat.
├── dist/                 # Prebuilt output (option B delivery)
│   ├── index.html
│   └── assets/
│       ├── index-DDIQ7YXH.css
│       └── index-DVbmFZ7Y.js
└── src/
    ├── main.tsx          # React root mount
    ├── App.tsx           # Shell + PlayerFooter
    ├── index.css         # Tailwind directives + globals
    ├── components/
    │   ├── audio/
    │   │   ├── AdvancedVisualizer.tsx
    │   │   ├── PlayerFooter.tsx        # Bottom transport bar
    │   │   ├── StepSequencer.tsx
    │   │   ├── Visualizer.tsx
    │   │   └── WaveformEditor.tsx
    │   ├── layout/
    │   │   ├── DAWCenterPanel.tsx
    │   │   ├── ModuleSidebar.tsx
    │   │   ├── ResizablePanel.tsx
    │   │   └── Shell.tsx               # Left panel + tabs + status bar
    │   └── ui/
    │       └── Section.tsx
    ├── state/
    │   ├── generateStore.ts            # /api/generate-jobs flow
    │   ├── statusBarStore.ts           # /api/health polling
    │   ├── studioStore.ts              # /api/studio/process flow
    │   └── trainingStore.ts            # /api/jobs, /api/autoencoder/* flows
    └── views/
        ├── GenerateView.tsx            # Tab: CREATE
        ├── LibraryView.tsx             # Tab: LIBRARY (local-only, no backend)
        ├── StudioView.tsx              # Tab: EDIT
        └── TrainingView.tsx            # Tab: TRAIN
```

Nothing outside `frontend/` is imported. Nothing inside `frontend/node_modules/` is hand-edited. Do **not** ship `node_modules/`.

### 2.3 Tabs and their backend dependencies

| Tab     | View                | Hits backend? | Endpoints used                                                                                   |
|---------|---------------------|---------------|--------------------------------------------------------------------------------------------------|
| CREATE  | `GenerateView`      | Yes           | `POST /api/generate-jobs`, `GET /api/jobs/{id}`                                                  |
| EDIT    | `StudioView`        | Yes           | `POST /api/studio/process`                                                                       |
| TRAIN   | `TrainingView`      | Yes           | `GET /api/model-info`, `GET /api/autoencoder/info`, `GET /api/jobs`, `POST /api/jobs/train-lora`, `POST /api/jobs/pre-encode`, `POST /api/autoencoder/encode`, `POST /api/autoencoder/decode`, `GET /api/jobs/{id}` |
| LIBRARY | `LibraryView`       | No            | Local React state only — currently hard-coded sample songs.                                      |
| (shell) | `Shell` status bar  | Yes           | `GET /api/health` (polled every 30s)                                                             |

---

## 3. The backend contract (what the target MUST expose)

The frontend assumes a FastAPI-style server. None of the requests have an explicit base URL — they all hit the **same origin** as the served HTML. See §4 for hosting/proxy requirements.

CORS is irrelevant when same-origin (option A or B in §5). It only matters in split dev mode (§4.2).

### 3.1 Endpoint summary

| Method | Path                          | Caller (frontend file)                                  | Body type        |
|--------|-------------------------------|---------------------------------------------------------|------------------|
| GET    | `/api/health`                 | `state/statusBarStore.ts:20`                            | —                |
| GET    | `/api/model-info`             | `state/trainingStore.ts:87`                             | —                |
| GET    | `/api/autoencoder/info`       | `state/trainingStore.ts:88`                             | —                |
| GET    | `/api/jobs`                   | `state/trainingStore.ts:110`                            | —                |
| GET    | `/api/jobs/{job_id}`          | `state/generateStore.ts:158`, `state/trainingStore.ts:152` | —             |
| POST   | `/api/generate-jobs`          | `state/generateStore.ts:124`                            | `multipart/form-data` |
| POST   | `/api/studio/process`         | `state/studioStore.ts:75`                               | `multipart/form-data` |
| POST   | `/api/jobs/train-lora`        | `state/trainingStore.ts:131`                            | `multipart/form-data` |
| POST   | `/api/jobs/pre-encode`        | `state/trainingStore.ts:197`                            | `multipart/form-data` |
| POST   | `/api/autoencoder/encode`     | `state/trainingStore.ts:217`                            | `multipart/form-data` |
| POST   | `/api/autoencoder/decode`     | `state/trainingStore.ts:260`                            | `multipart/form-data` |

The exact request fields and response shapes are encoded in [`frontend-graft-manifest.json`](./frontend-graft-manifest.json) under `backend.required_endpoints`. Below is a quick prose summary of the load-bearing ones.

### 3.2 Endpoint contracts (load-bearing detail)

**`GET /api/health`** — Response: `{ "status": "ok" | <anything-else>, "model_loaded": boolean }`. Frontend treats anything other than `status === "ok"` as unhealthy.

**`POST /api/generate-jobs`** (`multipart/form-data`)

Form fields the frontend sends (see [`generateStore.ts:106-121`](../../frontend/src/state/generateStore.ts#L106-L121)):
- `model_name`, `prompt`, `negative_prompt`, `duration`, `steps`, `cfg_scale`, `seed`, `batch_size`, `init_noise_level`, `init_audio_type`, `file_format` (always `"wav"`), `file_naming` (always `"verbose"`)
- Optional `init_audio` (binary file)

Response (200): `{ "job": { "id": string } }`. Frontend rejects with "Backend did not return a job id" if `job.id` is missing.

Then frontend polls `GET /api/jobs/{job_id}` every 1000 ms with this expected shape (see [`generateStore.ts:170-220`](../../frontend/src/state/generateStore.ts#L170-L220)):
```ts
{
  status: "queued" | "running" | "completed" | "failed",
  progress?: { step: number, steps: number },
  result?: {
    batch?: boolean,
    item?:  { audio_base64: string, mime_type?: string, filename?: string },
    items?: Array<{ audio_base64: string, mime_type?: string, filename?: string }>,
  },
  error?: string,
}
```

`audio_base64` must decode to a valid `mime_type`-compatible blob (defaults to `audio/wav`). The UI plays it via `URL.createObjectURL`.

**`POST /api/studio/process`** (`multipart/form-data`, see [`studioStore.ts:68-78`](../../frontend/src/state/studioStore.ts#L68-L78))

Form fields: `audio` (binary), `effect` (string), `params` (JSON-stringified object), `output_format` (e.g. `"wav"`).

Response (200): **binary audio body**, content-type per `output_format`. Frontend does `response.blob()` and wraps it in an object URL. On error, response body should be JSON `{ "detail": string }` or `{ "error": string }`.

**`POST /api/jobs/train-lora`** (`multipart/form-data`)

Form fields: `model_name`, `data_dir`, `output_dir`, `rank`, `lora_alpha`, `steps`. Response: `{ "job": { "id": string } }`. Polled like generate, but the poll consumes `logs: string[]` and `returncode: number` instead of audio payload.

**`POST /api/autoencoder/encode`** (`multipart/form-data`)

Form fields: `model_name`, `audio` (binary). Response: `{ "latents_base64": string }`.

**`POST /api/autoencoder/decode`** (`multipart/form-data`)

Form fields: `model_name`, `file_format`, `latents_base64`. Response: **binary audio body**.

**Error shape (any 4xx/5xx).** Frontend tries `response.json()` and reads either `.error` (string) or `.detail` (string). FastAPI's default `HTTPException` returns `{ "detail": "..." }`, which is fine.

### 3.3 State stores → endpoint map (mental model)

```
GenerateView ── useGenerateStore ── POST /api/generate-jobs ──┐
                                                              ├── poll: GET /api/jobs/{id}
TrainingView ── useTrainingStore ── POST /api/jobs/train-lora ┘
                                ├── GET  /api/model-info
                                ├── GET  /api/autoencoder/info
                                ├── GET  /api/jobs
                                ├── POST /api/jobs/pre-encode
                                ├── POST /api/autoencoder/encode
                                └── POST /api/autoencoder/decode
StudioView   ── useStudioStore   ── POST /api/studio/process
Shell footer ── useStatusBarStore ── GET  /api/health (30s)
LibraryView  ── (local React state, no fetch calls)
```

---

## 4. How requests flow (deployment topology)

### 4.1 Same-origin (production / packaged web mode) — the only "no surprises" path

```
┌──────────────────┐   GET /         ┌──────────────────────────────┐
│      Browser     │ ──────────────▶ │ FastAPI app (uvicorn)        │
│   localhost:8420 │                 │  - mounts frontend/dist at / │
│                  │ ──fetch /api/*▶ │  - exposes /api/*            │
└──────────────────┘                 └──────────────────────────────┘
```

This is what `server.py:1742-1757` already does in the reference bundle:

```python
frontend_dist_path = os.path.join(<parent>, "frontend", "dist")
app.mount("/", StaticFiles(directory=frontend_dist_path, html=True), name="frontend")
# Plus an SPA-fallback middleware that rewrites any 404 (not under /api) to index.html
```

If the target uses this same pattern, drop `frontend/dist/` next to `backend/` and you are done.

### 4.2 Split dev mode — Vite UI on one port, API on another

If the target wants to run `vite dev` (HMR) against a separately-running API, **you must add a proxy block** to `vite.config.ts`. The current file ([`vite.config.ts`](../../frontend/vite.config.ts)) has **none**, which means `/api/*` requests from the dev server land on the dev server itself and 404. This is the #1 expected pitfall.

The minimum patch:

```ts
server: {
  proxy: {
    '/api': {
      target: 'http://localhost:8600',   // whatever port the backend listens on
      changeOrigin: false,
    },
  },
  hmr: process.env.DISABLE_HMR !== 'true',
}
```

Alternative (no Vite edit): leave the frontend alone and only run **same-origin web mode** on the target — i.e., always build first and let the FastAPI server serve `dist/`.

### 4.3 What CORS preflights look like (only relevant in split dev mode)

`POST` with `multipart/form-data` is a **simple request** for CORS — no preflight. But `Content-Type: application/json` would trigger one. The reference `server.py` already configures `CORSMiddleware(allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])`, so cross-origin works out of the box if the target keeps that middleware.

---

## 5. Delivery modes — what goes in the handoff folder

You only need ONE of these. Pick A unless the target absolutely cannot run Node.

### 5.1 Mode A — Source bundle (recommended)

The receiving agent runs `npm install && npm run build` on the target. This produces a fresh `dist/` that matches the target's Node/Tailwind/etc. The frontend is buildable on Node 18+.

**Folder to hand over:** the entire `frontend/` directory **minus** `node_modules/` and `dist/`.

```
handoff/frontend/
├── .env.example
├── .gitignore
├── README.md
├── index.html
├── metadata.json
├── package.json
├── package-lock.json
├── tsconfig.json
├── vite.config.ts
└── src/
    └── ... (everything from §2.2)
```

Receiving agent's job on landing:
1. Place this folder at `<target_root>/frontend/`.
2. `cd <target_root>/frontend && npm ci` (or `npm install`).
3. `npm run build` → produces `<target_root>/frontend/dist/`.
4. Confirm the target's `server.py` mounts `frontend/dist` at `/` (it does, in the reference bundle — see §4.1).
5. Restart the API and visit `http://<host>:<api_port>/`.

### 5.2 Mode B — Prebuilt bundle only

If Node is unavailable on the target, ship just the built artifacts. **Risk:** the bundle assumes `/api/*` paths and was built against this repo's source. If the target's backend serves at a non-root path, the bundle will break (paths in `index.html` and `assets/*` are absolute: `/assets/...`).

**Folder to hand over:** `frontend/dist/` (3 files total).

```
handoff/dist/
├── index.html
└── assets/
    ├── index-DDIQ7YXH.css
    └── index-DVbmFZ7Y.js
```

Receiving agent's job:
1. Place at `<target_root>/frontend/dist/`.
2. Confirm `server.py` mounts it (no edits needed if the target uses the reference mount logic).
3. Restart and visit.

### 5.3 Recommended: zip the handoff

```
stabledaw-frontend-<YYYYMMDD>.zip
├── frontend/                      ← Mode A contents
├── frontend-graft-guide.md        ← this file
└── frontend-graft-manifest.json   ← machine-readable contract
```

The receiving agent reads `frontend-graft-manifest.json` to drive verification programmatically.

---

## 6. Environment and config

### 6.1 `.env` — what's needed

The `.env.example` lists `GEMINI_API_KEY` and `APP_URL`. **Neither is used at runtime by the components currently in this repo** (no import of `process.env.GEMINI_API_KEY` exists in `src/`). They are AI Studio scaffolding leftovers.

You can safely:
- Omit `.env` entirely on the target, OR
- Ship `.env.example` only (rename to `.env` locally if desired).

The frontend has **no required environment variables**.

### 6.2 No hardcoded URLs

All API calls use relative paths. The frontend will pick up whatever origin serves the HTML. This is intentional and is why same-origin hosting (§4.1) is the "just works" path.

### 6.3 Backend env (reference, for context only)

The reference `server.py` does not require env vars at startup beyond what the model pipeline needs. Model loading happens on `@app.on_event("startup")` with the hard-coded default `active_model_name = "medium"`. If the target has a different default model gating, that is a backend concern, not a frontend one.

---

## 7. Graft procedure — step by step

This is the procedure the receiving agent runs. Pre-flight assumes the target repo has a working `backend/server.py` exposing the endpoints in §3.

```
STEP 0  Pre-flight: smoke-test the target backend
  $ curl http://<target_host>:<api_port>/api/health
  # Expect: {"status":"ok","model_loaded": <bool>}
  If this fails, STOP. The graft does not fix backends.

STEP 1  Snapshot the target's existing frontend (rollback insurance)
  $ mv <target_root>/frontend <target_root>/frontend.bak-<timestamp>

STEP 2  Place the new frontend
  Mode A: copy handoff/frontend/ to <target_root>/frontend/
  Mode B: copy handoff/dist/      to <target_root>/frontend/dist/

STEP 3  (Mode A only) Install & build
  $ cd <target_root>/frontend
  $ npm ci                       # use package-lock.json exactly
  $ npm run build                # produces dist/

STEP 4  Verify the static mount path matches the target's server.py
  Look in the target's backend (FastAPI app) for one of these patterns:
    app.mount("/", StaticFiles(directory="<X>", html=True), ...)
    or a manual route that returns FileResponse("<X>/index.html")
  <X> must point to <target_root>/frontend/dist (or wherever you placed it).
  If the target uses a different convention (e.g. a `web/` folder), either
  move dist into that folder OR edit the mount path — pick one, do not both.

STEP 5  Restart the API
  $ pkill uvicorn || true
  $ <whatever launches the target's API>

STEP 6  Smoke-test in browser
  Visit http://<target_host>:<api_port>/
  Expected: StableDAW UI loads, footer shows "API HEALTHY // MODEL LOADED"
            (or "MODEL LOADING" if cold).

STEP 7  Functional checks (see §8)
```

### 7.1 Optional: weld script specification

If you'd rather automate steps 1–5, the receiving agent can implement a `weld.py` script with this spec. **This guide does not ship the script — it ships the spec.**

```python
# weld.py — graft handoff/frontend/ onto <target_root>
#
# Usage:  python weld.py --target <target_root> [--mode source|dist] [--skip-build]
#
# Behavior:
#   1. Validate target: <target_root>/backend/server.py exists and contains
#      either "StaticFiles" or "FileResponse" referencing a frontend dist path.
#   2. Backup: rename <target_root>/frontend to frontend.bak-YYYYMMDD-HHMMSS.
#   3. Copy: handoff/frontend/ -> <target_root>/frontend/  (mode=source)
#         or handoff/dist/     -> <target_root>/frontend/dist/  (mode=dist)
#   4. If mode=source and not --skip-build: run `npm ci && npm run build` in
#      <target_root>/frontend.
#   5. Read frontend-graft-manifest.json and grep the target's server.py for
#      each required endpoint pattern; warn (not fail) on misses.
#   6. Print final action list and a curl line for /api/health.
#
# Exit codes:
#   0 success, 1 validation failure, 2 npm failure, 3 manifest mismatch warning
```

---

## 8. Verification checklist

After graft. Run in order. Stop at the first failure and diagnose using §9.

| # | Check                                           | How                                                                       | Pass criterion                                                                  |
|---|-------------------------------------------------|---------------------------------------------------------------------------|---------------------------------------------------------------------------------|
| 1 | Index loads                                     | `curl -I http://<host>:<port>/`                                           | HTTP 200, `content-type: text/html`                                             |
| 2 | Asset hashes resolve                            | `curl -I http://<host>:<port>/assets/<jshash>.js`                         | HTTP 200, `content-type: application/javascript`                                |
| 3 | `/api/health` reachable                         | `curl http://<host>:<port>/api/health`                                    | JSON with `status: "ok"`                                                        |
| 4 | Status bar reflects health                      | Open `/` in browser, watch footer                                         | "SIGNAL ACTIVE" + "API HEALTHY //…"                                             |
| 5 | CREATE tab submits a job                        | Type any prompt, click Generate                                           | Status flips to QUEUED then SAMPLING n/m; completion plays audio                |
| 6 | TRAIN tab metadata loads                        | Switch to TRAIN tab                                                       | Active model + autoencoder list render without "TRAINING METADATA FAILED"      |
| 7 | EDIT tab process round-trips                    | Upload any short WAV, pick an effect, run                                 | Output audio blob URL plays                                                    |
| 8 | LIBRARY tab renders (no backend)                | Switch to LIBRARY                                                         | Hard-coded sample tracks display                                               |
| 9 | SPA fallback works                              | Refresh while on a non-root path                                          | App still renders (because middleware rewrites 404 to index.html)              |
| 10| Browser console clean of CSP/CORS errors        | DevTools → Console                                                        | No red CORS or CSP entries                                                     |

---

## 9. Pitfalls and fixes

| Symptom                                                  | Most likely cause                                                                                  | Fix                                                                                                       |
|----------------------------------------------------------|----------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------|
| White page, console: `Failed to load module script`      | `dist/` was placed but FastAPI mount path doesn't match.                                           | Re-check §7 step 4. Mount path must be the directory containing `index.html`.                             |
| Footer shows "API UNREACHABLE"                           | Same-origin assumption violated (Vite dev mode without proxy, or HTML served from a different host) | Either build and same-origin-serve (§4.1) OR add Vite proxy block (§4.2).                                 |
| Status bar shows "HEALTH FAIL (404)"                     | Backend missing `/api/health` route.                                                               | Add it. Frontend gives up gracefully but the rest will also fail.                                         |
| Generate stalls at "SUBMITTING JOB"                      | `/api/generate-jobs` returned no JSON or no `job.id`.                                              | Inspect response. Frontend hard-requires `{"job":{"id":...}}` shape.                                      |
| Generate finishes but no audio plays                     | Backend returned `result` but `audio_base64` is empty / wrong key.                                 | Frontend reads `result.item.audio_base64` OR `result.items[0].audio_base64` based on `result.batch`.      |
| Training metadata fails                                  | `/api/model-info` returned 503 (model still loading) or shape mismatch.                            | Either wait, or ensure response includes `active_model` + `available_models`.                             |
| Studio download returns JSON instead of audio            | Backend returned `application/json` from `/api/studio/process`.                                    | That endpoint must return binary audio with `content-type: audio/<format>`. Errors return JSON.           |
| 404 on `/assets/*` after build                           | Backend mounted on a non-root path (e.g. `/app`).                                                  | Mount `dist/` at `/`. The bundle's `index.html` uses absolute paths.                                      |
| `package-lock.json` "lockfile poisoning" warning         | Old npm version on target.                                                                         | Use Node 18+ / npm 9+. `npm ci` will fail loudly if lockfile is incompatible.                             |
| Build fails on `motion/react` import                     | Old Tailwind/Vite caching; `motion` 12.x renamed exports.                                          | `rm -rf node_modules .vite && npm install`. Pinned version in `package.json` is correct.                  |
| Old frontend leftovers (e.g. `frontend_old/`)            | Bundle drift from prior packaging step.                                                            | Safe to delete. The new build has no references into it.                                                  |

---

## 10. Rollback

```
$ rm -rf <target_root>/frontend
$ mv <target_root>/frontend.bak-<timestamp> <target_root>/frontend
$ <restart API>
```

No database/backend state was touched by the graft, so rollback is a single directory rename.

---

## 11. What is intentionally NOT in scope

- **Backend changes.** If the target's `/api/*` shapes don't match §3, do not change the frontend — fix the backend or supply a thin adapter at the API layer.
- **`LibraryView` persistence.** It is local-only and stubbed with sample data in this snapshot. If the target's old UI had a real library backed by IndexedDB or a server endpoint, that is a separate feature port and not part of this graft.
- **Theming / branding.** The build is the build. Re-skinning is out of scope.
- **Auth.** None exists. If the target requires auth, wrap the FastAPI app behind a reverse proxy that enforces it; the frontend will pass cookies via same-origin fetch by default.

---

## 12. Handoff prompt (paste into the receiving agent)

> You are receiving the `handoff/` folder which contains a self-contained React frontend (`handoff/frontend/`), this guide (`handoff/frontend-graft-guide.md`), and a machine-readable manifest (`handoff/frontend-graft-manifest.json`).
>
> The target repo is at `<TARGET_PATH>`. It already has a working FastAPI backend exposing the `/api/*` endpoints listed in the manifest under `backend.required_endpoints`.
>
> Read the guide §7 ("Graft procedure"), then execute it. Verify per §8. Report each verification row as PASS/FAIL. If any backend endpoint shape in §3.2 doesn't match what the target serves, STOP and report — do not modify the frontend to compensate.
>
> Do not delete the `frontend.bak-*` snapshot you create.
