# Noob-friendly Models, Downloads, and Settings Onboarding Plan

**Date:** 2026-06-12  
**Scope:** Settings modal, model/API readiness, local checkpoint onboarding, safe no-download defaults, path pickers, compact module tiles.  
**Primary user goal:** make the repo/app easy for beginners to download, launch, configure models, and understand what is installed without reading dense docs or typing paths by hand.

---

## 0. Source feature requests

The requested behavior came from the user during planning:

> in settings menu, I want there to be a models section where it has magenta, suno, stable, demucs, any other model or model API input area. Display what is hooked up, healthy, needs config file, w/e. Keep it compact and put it DIRECTLY below the restart and shutdown. Local only (never download) should be turned on by default. If a user tries to use the system with no models, it will warn them and take them to the area to select one (some or all, their choice)
>
> The Checkpoint thing shouldnt only be a text input, it should have a folder button where you can navigate to it via clicking, not typing.
>
> Where everything lives is a stupid label, change it to Location or similar. Make it so a hover over of the size will show what models are in the directory, where, and their size. It should also show what the currently downloaded options are for the user, and recommend which one to use if there are multiples.
>
> Models needs to explain how and where to get the config.JSON, or have a button to generate one if not found or something.
>
> Directly below models should be Layout Settings
>
> Below that should be all the Modules. Tiles, not a list. I want minimal scrolling, as much on every row as possible (but dont throw esthetic and 'clenliness' to the wayside, make good UI/UX design choices)
>
> Every place where there is a location that a user can/should input something should be a type location, and click to folder location type input.
>
> I know I suggested the dropdowns, but we should try to not have those, I want the user to instantly be able to see what they have installed, what is set active, where it is located, etc.

---

## 1. Current implementation snapshot

Relevant files inspected during planning:

- `frontend/src/components/layout/SettingsModal.tsx`
  - Current order: pinned **Admin** → `SunoKeySettings` → `LayoutSettingsSection` → Background features → VJ Recording → `StorageSettingsSection` → Backend Modules.
  - `StorageSettingsSection` already has:
    - Local-only toggle.
    - Stable model catalog chips (`local`, `cached`, `download`).
    - Registered local checkpoints.
    - Raw checkpoint path text input.
    - “Where everything lives” location rows.
    - Hugging Face cache breakdown.
  - Backend modules are currently grouped in collapsible list sections, not compact tiles.
- `frontend/src/lib/storageClient.ts`
  - Existing client wrappers:
    - `fetchCheckpoints()`
    - `addCheckpoint()`
    - `removeCheckpoint()`
    - `fetchLocations()`
    - `fetchHfCache()`
    - `setLocalOnly()`
    - `openLocation()`
- `backend/modules/storage/store.py`
  - `local_only` currently defaults to `False`.
  - Registry persists to `data/local_checkpoints.json`.
  - `SA3_LOCAL_ONLY` env is updated from registry state.
- `backend/modules/storage/router.py`
  - Existing endpoints:
    - `GET /api/storage/locations`
    - `GET /api/storage/hf-cache`
    - `GET /api/storage/checkpoints`
    - `POST /api/storage/checkpoints`
    - `DELETE /api/storage/checkpoints/{ck_id}`
    - `GET /api/storage/local-only`
    - `PUT /api/storage/local-only`
    - `POST /api/storage/open`
  - No native folder picker endpoint yet.
  - Location rows do not yet include model inventories or recommendations.
- Existing health/config endpoints to reuse:
  - Stable/local checkpoints: `/api/storage/checkpoints`, `/api/model-info`, `/api/model/load`
  - Magenta: `/api/magenta/probe`, `/api/magenta/engine/status`
  - Suno: `/api/suno/status`
  - Demucs/stems: `/api/stems/probe`, `/api/stems/status`
  - Modules: `/api/modules/all`

---

## 2. Deliverables

1. Durable Settings UI reshuffle:
   - Admin remains pinned.
   - Models section appears directly under Restart / Shutdown.
   - Layout Settings appears directly under Models.
   - Modules appear directly under Layout Settings as compact tiles.
2. Safe noob default:
   - Local-only / never-download defaults ON for fresh installs.
   - Explicit existing user choice is preserved.
3. Model/API readiness view:
   - Stable Audio, registered checkpoints, Magenta, Suno, Demucs/stems, MIDI where practical.
   - Shows connected/healthy/needs key/needs setup/missing config/download blocked.
   - Shows active/current/recommended model where practical.
4. Checkpoint onboarding improvements:
   - Path input supports typing and folder/file browsing.
   - Explains config JSON requirements.
   - Adds inspect-before-register feedback.
   - Optional safe config generation/copy for recognized known SA3 variants only.
5. Location clarity:
   - Rename “Where everything lives” to “Locations” or “Storage Locations.”
   - Size hover details show model/repo names, paths, and sizes.
   - Downloaded/current options are visible and recommendations are clear.
6. Missing-model warning flow:
   - If a user tries to generate with no usable model/API, warn and open Settings → Models.
7. Path picker pattern:
   - Any user-editable location path gets a typed location input plus click-to-folder/file picker where feasible.
8. Documentation + screenshot coverage updated after feature changes.

---

## 3. Success criteria

- Fresh install has local-only enabled by default.
- Existing `data/local_checkpoints.json` with `local_only: false` remains false.
- Settings opens with Models immediately visible below Admin controls.
- User can add a checkpoint without typing a path by using a folder/file picker.
- Checkpoint registration failure explains exactly what is missing.
- Users can identify available/active/recommended model options without opening a dropdown.
- “Where everything lives” label is gone/replaced.
- Modules are visible as tiles with minimal scrolling.
- Missing usable models routes users to Settings → Models.
- TypeScript passes.
- Ruff check/format passes.
- Focused backend tests pass.
- No unrelated features are removed.

---

## 4. Constraints and repo rules

- **Do not duplicate code.** Extract reusable path input and status helpers rather than copying UI blocks.
- **Windows shell:** do not use `&&` commands.
- Preserve existing behavior until replacement is validated.
- Do not delete features or modules.
- Follow `CLAUDE.md` hard rules:
  - Never downgrade external models/APIs/libraries.
  - Never allow ruff version drift.
  - Form controls need real labels and valid ARIA.
- Use Tailwind v4 class forms from `CLAUDE.md`.
- For model/API health, prefer non-spawning probes where possible.
- For config generation, never hallucinate unknown architecture configs. Only copy/generate for recognized built-in model variants.

---

## 5. Context-safe checkpoint strategy

To avoid context loss or broken intermediate state:

1. Implement one phase at a time.
2. After each phase:
   - run the focused validation for that phase,
   - fix failures,
   - commit/save if clean.
3. Never start a new phase with failing TypeScript/Python checks from the previous phase.
4. Keep backend API additions backward-compatible.
5. Avoid deleting old UI sections until the replacement is working.
6. If context gets tight, stop after a validated checkpoint and update this plan with the exact next task.

---

## 6. Detailed implementation phases

### Phase 0 — Guardrails and baseline snapshot

#### Task 0.1 — Confirm working tree

- Run:

```powershell
git status --short --branch
```

- Note any pre-existing changes before editing.
- Do not touch unrelated visible/open work unless the task requires it.

#### Task 0.2 — Establish validation commands

Run separately, never chained:

```powershell
uv run ruff check .
```

```powershell
uv run ruff format --check .
```

```powershell
cd frontend
```

```powershell
npx tsc -b
```

#### Save checkpoint

- No commit required if no files changed.
- If unexpected dirty files appear, stop and report.

---

### Phase 1 — Local-only default ON without breaking existing users

#### Task 1.1 — Backend default change

File: `backend/modules/storage/store.py`

Subtasks:

- Change `_DEFAULT.local_only` from `False` to `True`.
- Preserve explicit existing user choices:
  - missing file or missing key → true.
  - explicit `local_only: false` → false.
- Update docstring/comments to explain safe default.

#### Task 1.2 — Frontend copy clarity

File: `frontend/src/components/layout/SettingsModal.tsx`

Subtasks:

- Confirm `fetchCheckpoints()` displays backend value.
- Make local-only row read as a default safety mode.
- Add short copy: “Safe default: theDAW will not download models until you explicitly allow it.”

#### Task 1.3 — Regression tests

Likely file: `tests/test_backend_contract.py` or a new focused storage test.

Subtasks:

- Missing registry defaults local-only to true.
- Explicit false remains false.
- `SA3_LOCAL_ONLY` env mirrors the setting.

#### Validate

```powershell
uv run ruff check .
```

Focused storage/local-only test.

#### Save checkpoint

Suggested commit:

```text
settings: default model loading to local-only
```

---

### Phase 2 — Native folder/file picker API for local paths

Browser apps cannot normally read absolute folder paths from a standard HTML picker. Since this is a local Windows app with a local backend, use the backend to launch a native Windows picker.

#### Task 2.1 — Add backend picker endpoints

File: `backend/modules/storage/router.py`

Endpoint candidates:

- `POST /api/storage/pick-folder`
- `POST /api/storage/pick-file`

Subtasks:

- Implement Windows folder picker via PowerShell and `System.Windows.Forms.FolderBrowserDialog`.
- Implement file picker for `.json`, `.safetensors`, and future path fields if useful.
- Return `{ path, cancelled }`.
- Non-Windows returns 501 with clear message.
- Add timeout.
- Avoid user-input shell injection.

#### Task 2.2 — Add frontend storage client wrappers

File: `frontend/src/lib/storageClient.ts`

Subtasks:

- Add `pickFolder()`.
- Add `pickFile()` if useful.
- Keep errors user-readable.

#### Task 2.3 — Create reusable path input component

New file:

`frontend/src/components/ui/PathInput.tsx`

Props concept:

```ts
interface PathInputProps {
  id: string;
  name: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  kind: 'folder' | 'file';
  description?: string;
  disabled?: boolean;
}
```

Subtasks:

- Render text input plus compact folder/file button.
- Button calls picker endpoint and fills the input.
- Preserve accessibility labels:
  - native input has stable `id` and `name`.
  - visible `<label htmlFor={id}>`.
  - picker button has `aria-label`.
- Support Enter/blur commit via parent callbacks where needed.

#### Validate

```powershell
uv run ruff check .
```

```powershell
cd frontend
```

```powershell
npx tsc -b
```

#### Save checkpoint

Suggested commit:

```text
storage: add native folder picker for local paths
```

---

### Phase 3 — Move and redesign Models directly under Admin

#### Task 3.1 — Reorder Settings body

File: `frontend/src/components/layout/SettingsModal.tsx`

Target order:

1. Pinned Admin.
2. Models.
3. Layout Settings.
4. Modules tiles.
5. Optional advanced/background sections.

Subtasks:

- Move `StorageSettingsSection` immediately after Admin.
- Fold `SunoKeySettings` into Models, not as a standalone top section.
- Keep `LayoutSettingsSection` directly below Models.
- Move Background features and VJ Recording lower, or integrate later without deleting behavior.

#### Task 3.2 — Rename section language

File: `frontend/src/components/layout/SettingsModal.tsx`

Subtasks:

- Rename “Models & Storage” to **Models** or **Models / APIs**.
- Rename “Where everything lives” to **Locations** or **Storage Locations**.
- Replace “MAKE Model dropdown” references with “the model picker in MAKE.”

#### Task 3.3 — Compact model summary

File: `frontend/src/components/layout/SettingsModal.tsx`

Subtasks:

- Replace simple catalog chips with compact model rows/cards for:
  - Stable Audio catalog models.
  - Registered checkpoints.
  - Magenta RT2.
  - Suno API.
  - Demucs/stems.
  - MIDI engines if practical.
- Each card should show:
  - status: Ready / Local / Cached / Download blocked / Needs key / Needs setup / Missing config.
  - active/loaded state where available.
  - location when known.
  - action buttons: Pick folder, Add, Open, Setup, Configure key, Refresh.
- Avoid Settings dropdowns.

#### Validate

```powershell
cd frontend
```

```powershell
npx tsc -b
```

#### Save checkpoint

Suggested commit:

```text
settings: move compact models panel below admin controls
```

---

### Phase 4 — Model/API health aggregator

Rather than making the frontend coordinate many endpoints, add one backend status endpoint that Settings can render.

#### Task 4.1 — Add model readiness endpoint

Candidate file: `backend/modules/storage/router.py`

Endpoint:

`GET /api/storage/model-status`

Return shape concept:

```ts
interface ModelProviderStatus {
  id: 'stable' | 'magenta' | 'suno' | 'demucs' | 'midi';
  label: string;
  state:
    | 'ready'
    | 'active'
    | 'cached'
    | 'local'
    | 'needs_setup'
    | 'needs_key'
    | 'missing_config'
    | 'download_blocked'
    | 'unavailable';
  summary: string;
  active?: boolean;
  location?: string;
  actions?: string[];
  models?: Array<{
    id: string;
    label: string;
    source: 'local' | 'cached' | 'download' | 'registered' | 'api' | 'missing';
    bytes?: number;
    path?: string;
    recommended?: boolean;
    reason?: string;
  }>;
}
```

Subtasks:

- Stable Audio: use existing catalog/checkpoint resolution.
- Magenta: use `sidecar.setup_state()` and health without forcing start.
- Suno: read key configured status only; do not call paid/remote generation endpoints.
- Demucs: use non-spawning `stems.probe()` semantics.
- MIDI: use module availability if straightforward.
- Include recommendation logic:
  - If CUDA/VRAM suitable and Medium cached/local → recommend Medium.
  - Else recommend Small if available/cached/local.
  - If local-only and nothing local/cached → recommend adding a checkpoint or temporarily allowing download.

#### Task 4.2 — Frontend client wrapper

File: `frontend/src/lib/storageClient.ts`

Subtasks:

- Add model provider status types.
- Add `fetchModelStatus()`.

#### Task 4.3 — Render provider status cards

File: `frontend/src/components/layout/SettingsModal.tsx`

Subtasks:

- Render Stable / Magenta / Suno / Demucs / MIDI cards.
- Each card has visible status, no dropdown required.
- Show active/current model clearly.
- Show recommended model badge.
- Add Refresh button.

#### Validate

```powershell
uv run ruff check .
```

```powershell
cd frontend
```

```powershell
npx tsc -b
```

#### Save checkpoint

Suggested commit:

```text
settings: show model and API readiness cards
```

---

### Phase 5 — Checkpoint browse, inspect, and config guidance

#### Task 5.1 — Replace raw checkpoint path input with PathInput

File: `frontend/src/components/layout/SettingsModal.tsx`

Subtasks:

- Use `PathInput` for “Add a checkpoint you already have.”
- Keep manual typing as fallback.
- Add folder/file button to launch native picker.
- Allow picking either a folder or `.safetensors` file if backend picker supports it.

#### Task 5.2 — Add checkpoint inspection endpoint

File: `backend/modules/storage/router.py`

Endpoint:

`POST /api/storage/checkpoints/inspect`

Subtasks:

- Given a path, return:
  - found config JSON(s),
  - found safetensors file(s),
  - whether it resolves,
  - exact error if not,
  - recognized model family if possible.
- Do not register anything yet.
- Use this to give feedback before the user clicks Add.

#### Task 5.3 — Config JSON guidance

Files:

- `frontend/src/components/layout/SettingsModal.tsx`
- docs later as needed.

Subtasks:

- Explain that a valid local checkpoint needs a model config JSON plus `.safetensors`.
- Show where configs usually come from:
  - Hugging Face model repo for built-ins.
  - Exported/fine-tuned checkpoint artifacts.
  - Existing local registered checkpoint folders.
- Add “Open config help” link/button.
- Add “Generate config” only when safe:
  - If checkpoint is recognized as a known SA3 variant, copy/generate matching config template.
  - Otherwise disable button and explain arbitrary configs cannot be guessed safely.

#### Validate

```powershell
uv run ruff check .
```

Focused storage test.

```powershell
cd frontend
```

```powershell
npx tsc -b
```

#### Save checkpoint

Suggested commit:

```text
settings: guide local checkpoint setup with folder picker
```

---

### Phase 6 — Location inventory and size hover details

#### Task 6.1 — Enrich `/api/storage/locations`

File: `backend/modules/storage/router.py`

Subtasks:

- Add per-location `contents` or `models` array.
- For HF cache, list repos and sizes.
- For local model folders, scan checkpoint-like folders/files.
- For registered checkpoints, include config path and safetensors path.
- For Torch cache, show known model-ish directories when reasonable.
- Keep scans cached so Settings stays fast.

#### Task 6.2 — Better size hover tooltip

File: `frontend/src/components/layout/SettingsModal.tsx`

Subtasks:

- When hovering over size, show:
  - model/repo names,
  - file/folder location,
  - per-model size,
  - recommendation if multiple options exist.
- Keep row compact; show details in hover/title or a custom tooltip.
- Show empty/not-found cleanly.

#### Task 6.3 — Current downloaded options panel

File: `frontend/src/components/layout/SettingsModal.tsx`

Subtasks:

- Add compact “Downloaded / available now” row.
- Include Stable cached/local, registered local checkpoints, Magenta setup, Suno connected.
- Highlight recommended choice.

#### Validate

```powershell
uv run ruff check .
```

```powershell
cd frontend
```

```powershell
npx tsc -b
```

#### Save checkpoint

Suggested commit:

```text
settings: inventory model locations and recommendations
```

---

### Phase 7 — Warn and route users when no models/config are usable

#### Task 7.1 — Define “no usable models” rules

A usable generation path is one of:

- Stable model is local/cached.
- Registered checkpoint resolves.
- Magenta setup is ready or engine reachable.
- Suno key is configured.

Demucs/MIDI are tools, not primary music generation models, so they should not satisfy “can generate music” by themselves.

#### Task 7.2 — Add warning in MAKE generation flow

Likely file: `frontend/src/views/AdvancedGenPanel.tsx`

Subtasks:

- Before LOAD / CREATE, fetch model readiness.
- If selected model is `download` while local-only is on, block with a friendly warning.
- Dispatch `thedaw:open-settings` with a section target.
- Message:

```text
No usable model is configured yet. Pick a local checkpoint, connect Suno, set up Magenta, or allow a one-time Stable Audio download.
```

#### Task 7.3 — Settings focus target

File: `frontend/src/components/layout/SettingsModal.tsx`

Subtasks:

- Support custom event payload like `{ section: 'models' }`.
- Auto-scroll/focus the Models section when opened from the warning.
- Add a subtle pulse/highlight for first-time guidance.

#### Validate

```powershell
cd frontend
```

```powershell
npx tsc -b
```

Manual browser test via `theDAW.bat` when practical.

#### Save checkpoint

Suggested commit:

```text
make: route missing-model users to settings
```

---

### Phase 8 — Modules as tiles, not collapsible lists

#### Task 8.1 — Replace `ModuleTree` / `ModuleGroup` UI

File: `frontend/src/components/layout/SettingsModal.tsx`

Subtasks:

- Keep grouping by domain, but render a responsive tile grid.
- Use compact cards with:
  - label,
  - enabled toggle,
  - running badge,
  - API prefix,
  - one-line description,
  - restart-required indicator when dirty.
- Aim for 2–3 tiles per row in current modal width.
- Avoid hidden dropdown/collapse where possible.

#### Task 8.2 — Improve module status clarity

Subtasks:

- Show `ENABLED` vs `OFF`.
- Show `RUNNING` when `_loaded`.
- Show `restart required` on changed modules.
- Keep dirty banner near modules grid and/or Admin restart button.

#### Task 8.3 — Preserve module toggling behavior

Subtasks:

- Keep PATCH `/api/modules/{module}/enabled`.
- Do not change backend module loading behavior in this phase.
- Do not remove any module.

#### Validate

```powershell
cd frontend
```

```powershell
npx tsc -b
```

Manual: toggle one module, verify dirty banner and tile state.

#### Save checkpoint

Suggested commit:

```text
settings: render backend modules as compact tiles
```

---

### Phase 9 — Convert remaining path/location inputs

Known user-editable path inputs:

- `SettingsModal.tsx`: VJ export root.
- `SettingsModal.tsx`: checkpoint path.
- `TrainView.tsx`: dataset path.

#### Task 9.1 — VJ export root uses PathInput

File: `frontend/src/components/layout/SettingsModal.tsx`

Subtasks:

- Replace plain text input with `PathInput`.
- Preserve relative-path support.
- Folder picker returns absolute path.
- Blur/Enter still commits setting.

#### Task 9.2 — TRAIN dataset path uses PathInput

File: `frontend/src/views/TrainView.tsx`

Subtasks:

- Replace dataset text input with `PathInput`.
- Keep manual typing.
- Folder picker fills dataset path.
- Ensure valid ARIA labels.

#### Task 9.3 — Search for all other path-like fields

Search terms:

- `path`
- `folder`
- `directory`
- `root`
- `dataset`
- `checkpoint`
- Windows drive patterns in placeholders

Convert only user-editable location fields, not display-only labels.

#### Validate

```powershell
cd frontend
```

```powershell
npx tsc -b
```

Accessibility review for every touched input/button label.

#### Save checkpoint

Suggested commit:

```text
ui: add folder pickers to location inputs
```

---

### Phase 10 — Documentation and screenshot coverage

#### Task 10.1 — Update docs

Likely files:

- `README.md`
- `docs/USER_GUIDE.md`
- `docs/windows/setup-guide.md`
- `frontend/public/USER_GUIDE.md` if this repo expects a copied public guide.

Subtasks:

- Document local-only default ON.
- Explain Models section status cards.
- Explain folder picker behavior.
- Explain config JSON requirements and safe generate-config behavior.
- Explain no-model warning flow.

#### Task 10.2 — Update screenshot specs/mapping if needed

Likely files:

- `scripts/screenshots/specs.ts`
- `docs/screenshots/manifest.*`
- generated `docs/reports/feature-doc-coverage-report.md` if workflow expects regeneration.

Subtasks:

- Add/update Settings screenshot covering Models/Layout/Modules.
- Regenerate docs coverage if requested.
- Keep feature documentation coverage at 100%.

#### Validate

```powershell
cd frontend
```

```powershell
npm run docs:coverage
```

If screenshot capture is practical:

```powershell
npm run screenshots
```

#### Save checkpoint

Suggested commit:

```text
docs: document noob-friendly model setup
```

---

### Phase 11 — Final validation pass

#### Backend validation

```powershell
uv run ruff check .
```

```powershell
uv run ruff format --check .
```

Focused tests first:

```powershell
uv run pytest tests/test_backend_contract.py
```

Then any new storage/settings tests.

#### Frontend validation

```powershell
cd frontend
```

```powershell
npx tsc -b
```

#### Manual app validation

Launch:

```powershell
.\theDAW.bat
```

Manual checks:

1. Settings opens.
2. Admin buttons are pinned.
3. Models is directly below Admin.
4. Local-only defaults ON on fresh data.
5. Model cards show Stable, Magenta, Suno, Demucs, MIDI statuses.
6. Folder picker fills checkpoint path.
7. Missing checkpoint config gives helpful guidance.
8. Location size hover shows model details.
9. Layout Settings is directly below Models.
10. Modules are visible as tiles with minimal scrolling.
11. MAKE warns and routes to Models if no usable model exists.
12. Restart still works via `theDAW.bat` supervisor.

#### Final save checkpoint

Suggested commit:

```text
settings: finalize noob-friendly model onboarding
```

---

## 7. Recommended first implementation slice

Start with **Phases 1–3 only**:

1. Local-only default ON.
2. Folder picker infrastructure + reusable `PathInput`.
3. Reorder Settings so Models is directly below Admin and Layout is directly below Models.

This gives immediate noob-friendly improvement without taking on the full model-health aggregator and recommendation system in the same context window.

---

## 8. Resume notes for future sessions

If resuming this plan, read these files first:

1. `docs/plans/2026-06-12-noob-friendly-model-onboarding-plan.md`
2. `frontend/src/components/layout/SettingsModal.tsx`
3. `frontend/src/lib/storageClient.ts`
4. `backend/modules/storage/store.py`
5. `backend/modules/storage/router.py`
6. `frontend/src/views/AdvancedGenPanel.tsx`
7. `CLAUDE.md`

Do not start with Phase 4+ until Phases 1–3 are validated and saved.