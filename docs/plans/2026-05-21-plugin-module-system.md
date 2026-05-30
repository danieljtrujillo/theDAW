# theDAW Plugin / Module System — Architecture Plan

**Date:** 2026-05-21
**Status:** Design only. No code changes performed.
**Context:** theDAW has accumulated several large, semi-independent feature areas (effects processing, LoRA training, dataset preparation, library management, MIDI, step sequencer). Each one touches both backend routes and frontend views. Adding more features without a clear module boundary risks breaking the whole app. This plan defines a lightweight, practical plugin system that keeps the core stable while letting new features be developed, installed, and disabled independently.

**Reference:**
- LoRA dataset research → [`docs/guides/lora-dataset-guide.md`](../guides/lora-dataset-guide.md)
- LoRA workflow reference → [`docs/workflows/lora.md`](../workflows/lora.md)
- Current backend entry point → `backend/server.py`
- Current frontend shell → `frontend/src/components/layout/Shell.tsx`

---

## 0. The problem this solves

Right now, adding a new feature means:
- Appending routes to `backend/server.py` (one file, growing unboundedly)
- Adding a new view under `frontend/src/views/` and wiring it into `Shell.tsx` and `ModuleSidebar.tsx` by hand
- Importing new Python dependencies that may conflict with existing ones
- No way to disable a broken feature without editing source

If the LoRA training workflow, the effects chain, the dataset prep UI, and the MIDI system all live in the same files with no isolation, one bad import or one misconfigured route crashes the entire backend or breaks the entire frontend build.

---

## 1. Design principles

1. **Core stays dumb.** The core app (`backend/server.py` base routes, `Shell.tsx`) only knows how to load and unload modules. It does not know what any module does.
2. **Each module is self-contained.** One folder = one module. Backend routes, frontend component, dependencies, and config all live together.
3. **Opt-in activation.** A module is enabled by presence of a config entry. Removing the entry disables the module with no code change.
4. **No module can break core.** Backend modules load in isolation via FastAPI `APIRouter`; if one fails to import, it is skipped with a logged warning and the rest of the app starts normally.
5. **Frontend modules are lazy-loaded.** Each module's UI is a lazy React component. A module that fails to render does not crash the shell.
6. **No new build tooling.** This is not a micro-frontend or a Webpack module federation system. It is a simple file convention enforced by the loader — readable, debuggable, and reversible.
7. **Heavy imports are always deferred.** No module may perform expensive imports (PyTorch, Lightning, torchaudio, ffmpeg bindings) at the top level of `router.py`. All heavy imports go inside route handlers or FastAPI lifespan context managers. Violating this rule breaks the loader's fault isolation — a failed import at module load time is indistinguishable from a broken module, and adds startup latency even when the module's features are never used.

---

## 2. What counts as a module

A module is any feature that:
- Has its own backend routes (or could in the future), AND/OR
- Has its own top-level view in the sidebar, AND/OR
- Has optional or heavy dependencies (torch training, ffmpeg, MIDI devices)

Candidates from the current codebase:

| Module name | Backend surface | Frontend view | Heavy deps |
|---|---|---|---|
| `generate` | `/api/generate`, `/api/generate/status` | `GenerateView` | PyTorch, T5Gemma, DiT |
| `library` | `/api/library/*` | `LibraryView` | IndexedDB (client-side) |
| `effects` | `/api/effects` | Effects panel in StudioView | ffmpeg |
| `lora_train` | `/api/lora/train`, `/api/lora/status`, `/api/lora/checkpoints` | `TrainingView` | PyTorch training loop, Lightning |
| `dataset_prep` | `/api/dataset/*` | Dataset prep tab in TrainingView | SAME autoencoder, torchaudio |
| `midi` | — | PianoRoll, StepSequencer | Web MIDI API |
| `autoencoder` | `/api/encode`, `/api/decode` | — (used by other modules) | SAME model |

The first three (`generate`, `library`, `effects`) are core-adjacent — they will always be on. The last four (`lora_train`, `dataset_prep`, `midi`, `autoencoder`) are the first candidates for the module system.

---

## 3. Backend module convention

### 3.1 Folder layout

```
backend/
  server.py              ← core app; only mounts routers, never imports module logic directly
  modules/
    __init__.py
    loader.py            ← discovers and mounts routers
    generate/
      __init__.py
      router.py          ← FastAPI APIRouter, all /api/generate/* routes
      module.json        ← {"name": "generate", "enabled": true, "sidebar": true, "icon": "Wand2"}
    effects/
      __init__.py
      router.py
      module.json
    lora_train/
      __init__.py
      router.py          ← /api/lora/* routes (train, status, cancel, checkpoints)
      module.json        ← {"name": "lora_train", "enabled": true, "label": "Train", ...}
    dataset_prep/
      __init__.py
      router.py          ← /api/dataset/* routes (import, caption, encode, validate)
      module.json
    autoencoder/
      __init__.py
      router.py
      module.json
```

### 3.2 `loader.py` — safe dynamic import

```python
# backend/modules/loader.py
import importlib
import json
import logging
from pathlib import Path
from fastapi import FastAPI

log = logging.getLogger(__name__)

def load_modules(app: FastAPI, modules_dir: Path) -> list[dict]:
    """
    Discover backend/modules/*/router.py files, import their APIRouter,
    and mount them on the app. Failures are logged and skipped — they
    never prevent the rest of the app from starting.
    """
    manifests = []
    for module_dir in sorted(modules_dir.iterdir()):
        if not module_dir.is_dir():
            continue
        config_path = module_dir / "module.json"
        router_path = module_dir / "router.py"
        if not config_path.exists() or not router_path.exists():
            continue

        config = json.loads(config_path.read_text())
        if not config.get("enabled", True):
            log.info(f"Module {module_dir.name} is disabled — skipping")
            continue

        try:
            mod = importlib.import_module(f"backend.modules.{module_dir.name}.router")
            router = getattr(mod, "router")
            prefix = config.get("api_prefix", f"/api/{module_dir.name}")
            app.include_router(router, prefix=prefix)
            manifests.append(config)
            log.info(f"Loaded module: {module_dir.name} → {prefix}")
        except Exception as e:
            log.warning(f"Module {module_dir.name} failed to load: {e} — continuing without it")

    return manifests
```

### 3.3 `server.py` core — what it becomes

```python
# backend/server.py  (core, after refactor)
from fastapi import FastAPI
from pathlib import Path
from backend.modules.loader import load_modules

app = FastAPI()

# Core routes only — auth, health, static file serving
@app.get("/api/health")
def health():
    return {"status": "ok"}

# Mount all modules
MODULES_DIR = Path(__file__).parent / "modules"
loaded_manifests = load_modules(app, MODULES_DIR)

# Expose manifest to frontend so it knows what's available
@app.get("/api/modules")
def get_modules():
    return loaded_manifests
```

### 3.4 `module.json` schema

```json
{
  "name": "lora_train",
  "label": "Train",
  "enabled": true,
  "icon": "Dna",
  "sidebar": true,
  "sidebar_order": 4,
  "api_prefix": "/api/lora",
  "description": "LoRA fine-tuning for Stable Audio 3",
  "requires": ["autoencoder"],
  "backend": true
}
```

`requires` is advisory — the loader logs a warning if a required module failed, but does not block loading.

`backend` defaults to `true`. Set to `false` for frontend-only modules (e.g., `midi`) that have no backend routes. The frontend `ModuleRegistry` includes frontend-only modules unconditionally, without waiting for them to appear in `/api/modules`. Example for a frontend-only module:

```json
{
  "name": "midi",
  "label": "MIDI",
  "enabled": true,
  "icon": "Piano",
  "sidebar": true,
  "sidebar_order": 5,
  "backend": false,
  "description": "Web MIDI API integration — piano roll and step sequencer"
}
```

### 3.5 Shared model registry — `backend/core/model_registry.py`

Modules must never load their own copy of a PyTorch model. On a 6GB VRAM card, two modules each loading the SAME autoencoder would OOM immediately. All model loading goes through a single registry that caches by model name and shares the cached instance across all modules that need it.

```python
# backend/core/model_registry.py
import threading
import logging
from typing import Any

log = logging.getLogger(__name__)
_lock = threading.Lock()
_cache: dict[str, Any] = {}


def get_model(name: str, loader_fn, *args, **kwargs) -> Any:
    """
    Return a cached model by name. If not yet loaded, call loader_fn(*args, **kwargs)
    to create it, cache it, and return it. Thread-safe.

    Usage inside a route handler (NOT at module top-level):
        from backend.core.model_registry import get_model
        from stable_audio_3 import AutoencoderModel

        ae = get_model("same-s", AutoencoderModel.from_pretrained, "same-s", device="cuda")
    """
    if name in _cache:
        return _cache[name]
    with _lock:
        if name not in _cache:
            log.info(f"Loading model '{name}' into registry")
            _cache[name] = loader_fn(*args, **kwargs)
            log.info(f"Model '{name}' loaded and cached")
    return _cache[name]


def release_model(name: str) -> None:
    """Evict a model from the registry (e.g., to free VRAM between jobs)."""
    with _lock:
        if name in _cache:
            del _cache[name]
            log.info(f"Model '{name}' released from registry")
```

The registry is stored on `app.state.model_registry` (a reference to `_cache`) so any module that receives the FastAPI `Request` object can reach it without importing the registry directly. Modules declare which models they need in `module.json` under `"models"` (informational only — the registry is the runtime authority):

```json
{
  "name": "dataset_prep",
  "models": ["same-s", "same-l"]
}
```

### 3.6 Unified background job system — `backend/core/jobs.py`

Any module that runs long async work (generation, encoding, training) registers its jobs here. The frontend polls or streams from a single consistent API regardless of which module owns the job.

```python
# backend/core/jobs.py
import uuid
import time
from dataclasses import dataclass, field
from typing import Literal, Optional
import asyncio

JobStatus = Literal["queued", "running", "done", "failed", "cancelled"]

@dataclass
class Job:
    id: str
    module: str                  # which module owns this job
    label: str                   # human-readable description
    status: JobStatus = "queued"
    progress: float = 0.0        # 0.0 – 1.0
    message: str = ""
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    result: Optional[dict] = None
    error: Optional[str] = None
    _subscribers: list = field(default_factory=list, repr=False)

    def update(self, status=None, progress=None, message=None):
        if status: self.status = status
        if progress is not None: self.progress = progress
        if message: self.message = message
        self.updated_at = time.time()
        for q in self._subscribers:
            q.put_nowait(dict(
                status=self.status, progress=self.progress, message=self.message
            ))

    def subscribe(self) -> asyncio.Queue:
        q = asyncio.Queue()
        self._subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue):
        try:
            self._subscribers.remove(q)
        except ValueError:
            pass


_jobs: dict[str, Job] = {}

def create_job(module: str, label: str) -> Job:
    job = Job(id=str(uuid.uuid4()), module=module, label=label)
    _jobs[job.id] = job
    return job

def get_job(job_id: str) -> Optional[Job]:
    return _jobs.get(job_id)

def list_jobs(module: str = None) -> list[Job]:
    jobs = list(_jobs.values())
    if module:
        jobs = [j for j in jobs if j.module == module]
    return jobs
```

Core exposes these routes (not owned by any module):

```
GET  /api/jobs               → list all active/recent jobs
GET  /api/jobs/{id}          → get one job's current state
GET  /api/jobs/{id}/stream   → SSE stream of status updates for one job
DELETE /api/jobs/{id}        → cancel a job
```

A module that starts a training run calls `create_job("lora_train", "LoRA training — my_dataset")`, updates it via `job.update(progress=0.42, message="step 4200/10000")`, and returns `{"job_id": job.id}` to the frontend. The frontend then subscribes to `/api/jobs/{id}/stream` — the same pattern regardless of whether the job is encoding, training, or generating.

---

## 4. Frontend module convention

### 4.1 Folder layout

```
frontend/src/
  modules/
    generate/
      index.tsx          ← default export: the view component
      module.ts          ← { name, label, icon, sidebarOrder }
    effects/
      index.tsx
      module.ts
    lora_train/
      index.tsx          ← wraps TrainingView + DatasetPrepView tabs
      module.ts
    dataset_prep/
      index.tsx
      module.ts
    midi/
      index.tsx
      module.ts
  core/
    ModuleRegistry.ts    ← discovers frontend modules, matches against backend manifest
    Shell.tsx            ← reads registry, renders sidebar nav and lazy-loads active view
```

### 4.2 `ModuleRegistry.ts` — frontend discovery

```typescript
// frontend/src/core/ModuleRegistry.ts

export interface ModuleManifest {
  name: string;
  label: string;
  icon: string;
  sidebarOrder: number;
  frontendOnly: boolean;           // true = no backend required; include unconditionally
  component: React.LazyExoticComponent<React.ComponentType>;
  contributions?: ModuleContributions; // optional UI contribution points (see §4.4)
}

// Contribution points a module may optionally fill (see §4.4)
export interface ModuleContributions {
  footerActions?: React.LazyExoticComponent<React.ComponentType>;
  libraryContextMenuItems?: React.LazyExoticComponent<React.ComponentType>;
  editorPanels?: React.LazyExoticComponent<React.ComponentType>;
  settingsSections?: React.LazyExoticComponent<React.ComponentType>;
}

// Static registration — each module imported here.
// Use React.lazy so a module's bundle is only fetched when navigated to.
import { lazy } from "react";

const REGISTERED_MODULES: ModuleManifest[] = [
  {
    name: "generate",
    label: "Generate",
    icon: "Wand2",
    sidebarOrder: 0,
    frontendOnly: false,
    component: lazy(() => import("../modules/generate")),
  },
  {
    name: "library",
    label: "Library",
    icon: "Library",
    sidebarOrder: 1,
    frontendOnly: false,
    component: lazy(() => import("../modules/library")),
  },
  {
    name: "lora_train",
    label: "Train",
    icon: "Dna",
    sidebarOrder: 3,
    frontendOnly: false,
    component: lazy(() => import("../modules/lora_train")),
  },
  {
    name: "midi",
    label: "MIDI",
    icon: "Piano",
    sidebarOrder: 5,
    frontendOnly: true,   // no backend routes; always included
    component: lazy(() => import("../modules/midi")),
  },
  // ... etc
];

// Filter to only modules the backend confirmed loaded successfully.
// Frontend-only modules (backend: false in their module.json) are included
// unconditionally — they have no backend counterpart to confirm.
export async function getActiveModules(): Promise<ModuleManifest[]> {
  try {
    const res = await fetch("/api/modules");
    const backendModules: { name: string }[] = await res.json();
    const backendNames = new Set(backendModules.map((m) => m.name));
    return REGISTERED_MODULES.filter(
      (m) => m.frontendOnly || backendNames.has(m.name)
    );
  } catch {
    // If /api/modules is unreachable, show all registered frontend modules
    return REGISTERED_MODULES;
  }
}
```

### 4.3 Contribution points — modules that don't own a full view

Not every module is a top-level sidebar view. Some inject UI into existing surfaces. Rather than letting modules reach into Shell or other components directly (which creates coupling), the shell exposes named **contribution points** — slots where registered module contributions are rendered lazily inside their own error boundaries.

Defined contribution points:

| Key | Location | Example use |
|---|---|---|
| `footerActions` | PlayerFooter — right side icon row | Waveform export button, BPM tap tempo |
| `libraryContextMenuItems` | Right-click menu on library entries | "Send to effects", "Stem split" |
| `editorPanels` | Collapsible panels below the waveform editor | Chord detection results, beat grid overlay |
| `settingsSections` | Settings modal | Per-module config UI |

A module declares contributions in its frontend `module.ts`:

```typescript
// frontend/src/modules/stem_splitter/module.ts
import { lazy } from "react";

export default {
  name: "stem_splitter",
  label: "Stem Splitter",
  icon: "Scissors",
  sidebarOrder: -1,          // -1 = no sidebar entry
  frontendOnly: false,
  contributions: {
    libraryContextMenuItems: lazy(() => import("./LibraryMenuItems")),
  },
};
```

Shell collects all registered `libraryContextMenuItems` contributions and renders them inside the context menu's error boundary. A contribution that throws does not break the menu or any other contribution.

```tsx
// Sketch — how Shell collects contributions
const footerContributions = activeModules
  .flatMap((m) => m.contributions?.footerActions ? [m] : []);

// In PlayerFooter:
{footerContributions.map((m) => (
  <ErrorBoundary key={m.name} fallback={null}>
    <Suspense fallback={null}>
      <m.contributions.footerActions />
    </Suspense>
  </ErrorBoundary>
))}
```

New contribution point types can be added to `ModuleContributions` without touching any existing module. A module that doesn't declare a contribution for a slot is simply absent from that slot's render — no stub, no placeholder.

### 4.4 `Shell.tsx` — becomes module-driven

Shell fetches active modules on mount, builds the sidebar from them, and renders the active module's component inside a `Suspense` boundary with an `ErrorBoundary`. A module that crashes during render shows an error card in its panel, not a blank or crashed app.

```tsx
// Sketch — not verbatim code
<ErrorBoundary fallback={<ModuleErrorCard name={activeModule.name} />}>
  <Suspense fallback={<LoadingSpinner />}>
    <ActiveModule.component />
  </Suspense>
</ErrorBoundary>
```

---

## 5. Security and safety constraints

These apply to every module without exception.

### Backend

- **No `shell=True` subprocess calls.** All subprocess invocations (ffmpeg, training scripts) use list-form args. This is already the case in `backend/server.py` and must stay that way.
- **All file paths are resolved and validated before use.** Modules that accept file paths from the frontend must resolve them against an allowed base directory and reject anything that escapes it (path traversal protection).
- **Training processes run as managed subprocesses, not threads.** Long-running jobs (pre-encoding, LoRA training) are spawned as child processes tracked by the module. On app shutdown, the module's lifespan handler terminates them. A crashed training job never orphans the backend.
- **Module routes are prefixed and cannot overlap.** `loader.py` mounts each router at its declared `api_prefix`. Two modules cannot share a prefix.
- **No module can read or write outside its declared data directory** without explicit user-provided paths validated server-side.

### Frontend

- **Each module view is wrapped in an `ErrorBoundary`.** One module's runtime error cannot crash the shell, the player, or other modules.
- **Module API calls go through a shared `apiClient` that enforces the module prefix.** No module makes raw `fetch` calls to arbitrary URLs.
- **Sidebar visibility is determined by the backend manifest, not hardcoded.** If a module's backend fails to load, its sidebar entry is hidden automatically.

---

## 6. Migration path — what to move first

The goal is to not break anything while extracting. The sequence:

### Phase 1 — Scaffold (no behavior change)
1. Create `backend/modules/loader.py` and `backend/modules/__init__.py`
2. Create `frontend/src/core/ModuleRegistry.ts` and `frontend/src/core/ErrorBoundary.tsx`
3. Add `GET /api/modules` to `server.py` (returns hardcoded list for now)
4. Wire `Shell.tsx` to read from `ModuleRegistry` — still renders the same views, just through the new path

### Phase 2 — Extract effects module
Effects is the safest first extraction: it has one backend endpoint (`/api/effects`), no heavy model loading, and its frontend is embedded in `StudioView` rather than being a top-level view.

1. Move `_build_filter()`, `_validate_param()`, and the `/api/effects` route from `server.py` → `backend/modules/effects/router.py`
2. Create `backend/modules/effects/module.json`
3. Verify effects still work end-to-end
4. Remove the extracted code from `server.py`

### Phase 3 — Extract lora_train module
LoRA training is the highest-value extraction because it pulls in the heaviest dependencies (PyTorch Lightning, training loop). Isolating it means the backend can start even if PyTorch Lightning fails to import.

1. Move all `/api/lora/*` routes → `backend/modules/lora_train/router.py`
2. Create `backend/modules/lora_train/module.json`
3. Move `TrainingView.tsx` → `frontend/src/modules/lora_train/index.tsx`
4. Verify training still works end-to-end
5. Remove from `server.py` and `frontend/src/views/`

### Phase 4 — New module: dataset_prep
This is the LoRA dataset preparation workflow described in [`docs/guides/lora-dataset-guide.md`](../guides/lora-dataset-guide.md). It is a net-new module, so it can be built directly into the module system from day one.

Backend routes:
- `POST /api/dataset/import` — accept audio files, detect format, write to session folder
- `POST /api/dataset/caption` — write/update a caption for a file
- `POST /api/dataset/caption/batch` — apply a template caption to multiple files
- `POST /api/dataset/validate` — check dataset health (missing captions, estimated epochs, one-shot count warnings)
- `POST /api/dataset/encode` — run `pre_encode_dataset.py` as a managed subprocess, stream progress via SSE
- `GET /api/dataset/sessions` — list saved dataset sessions

Frontend view:
- Drag-and-drop intake zone
- Per-file caption editor with auto-suggestion from filename
- Validation summary panel
- Encode button with progress stream
- Integrates into `lora_train` module as a tab

### Phase 5 — Extract generate, library, autoencoder modules
These are larger and have more surface area. Extract them last, after the system is proven by the smaller modules.

---

## 7. What NOT to do

- **Do not use Python `importlib.reload` or hot-reloading for modules.** Module state (loaded models, subprocess handles) is not safely reloadable. Disable/enable requires an app restart.
- **Do not store module config in the database.** `module.json` files are the source of truth. Editing a file and restarting is the enable/disable mechanism — simple, auditable, no admin UI needed.
- **Do not let modules import from each other directly.** Cross-module communication goes through the FastAPI request layer or through shared utilities in `stable_audio_3/` (the upstream library), or through the core `model_registry` and `jobs` services. Direct Python imports between modules create hidden coupling.
- **Do not load models inside module-level code.** All model loading goes through `backend/core/model_registry.py` inside route handlers or lifespan events — never at import time. One model instance shared across all modules that need it; never duplicated.
- **Do not invent per-module job status endpoints.** All async work goes through `backend/core/jobs.py`. The frontend subscribes to `/api/jobs/{id}/stream` for any job from any module.
- **Do not add a plugin marketplace or remote code loading.** All modules live in the repo. "Installing" a module means adding its folder and restarting. Security boundary: repo access = module access, nothing more.

---

## 8. File checklist for Phase 1 + 2

```
backend/
  core/
    __init__.py                         CREATE (empty)
    model_registry.py                   CREATE (§3.5)
    jobs.py                             CREATE (§3.6)
  modules/
    __init__.py                         CREATE (empty)
    loader.py                           CREATE
    effects/
      __init__.py                       CREATE (empty)
      router.py                         MOVE from server.py (effects routes + helpers)
      module.json                       CREATE
  server.py                             EDIT — remove effects routes, call load_modules(),
                                               add /api/jobs/* core routes

frontend/src/
  core/
    ModuleRegistry.ts                   CREATE (includes frontendOnly + contributions support)
    ErrorBoundary.tsx                   CREATE
  modules/
    effects/
      index.tsx                         CREATE (re-export existing effects UI)
      module.ts                         CREATE
  components/layout/Shell.tsx           EDIT — read from ModuleRegistry, render contribution points
  components/layout/ModuleSidebar.tsx   EDIT — accept modules array as prop
  components/audio/PlayerFooter.tsx     EDIT — render footerActions contribution slot
```


