# theDAW Module Builder — Architecture Plan

**Date:** 2026-05-22
**Status:** Design only. No code changes performed.
**Context:** Once the plugin/module system from [`2026-05-21-plugin-module-system.md`](./2026-05-21-plugin-module-system.md) lands, modules become the unit of feature work. Hand-rolling a new module means remembering the manifest schema, the deferred-import rule, the model-registry pattern, the job-system pattern, the contribution-point conventions, and the frontend lazy-loading boundary. That is too much to remember, and any one omission silently breaks the safety guarantees of the system.

This plan defines a **completely separate** scaffolding tool that lives in its own folder, has its own dependency manifest, and produces correct-by-construction modules. The tool is opinionated, validates its own output against the system's rules, and provides a visual UI composer that lets module authors assemble their UI from templates derived from the existing DAW component library.

**References:**
- Module system spec → [`docs/plans/2026-05-21-plugin-module-system.md`](./2026-05-21-plugin-module-system.md)
- LoRA dataset guide (an example of the kind of doc a module author would write) → [`docs/guides/lora-dataset-guide.md`](../guides/lora-dataset-guide.md)

---

## 0. The problem this solves

Without a builder, every new module is a hand-copy of an existing one. Bugs propagate (someone forgets to defer a heavy import, or skips the `ErrorBoundary` wrapping, or reaches into another module's internals). The module system's safety properties are only as strong as the discipline of whoever writes the next module at midnight. A builder converts those properties from "things you must remember" into "things the tool refuses to generate without."

Additionally: the visual UI builder solves a separate problem. theDAW has an established design language — dense dark layout, purple accents, the `Section` primitive, the `ResizablePanel` shell, the bottom tab pattern. A module author should not have to reverse-engineer that style. They should pick from a palette of templates that already match.

---

## 1. Design principles

1. **Separate package, same monorepo.** Lives at `module_builder/` at the repo root. Has its own `pyproject.toml`, its own dependencies, its own README. Does not get installed into the main `stable-audio-3` environment.
2. **The scaffolder is the source of truth.** A Python library (`module_builder/builder/`) reads templates and writes files. The web UI is a thin wrapper that calls into the scaffolder. The CLI is also a thin wrapper. Both produce identical output for the same input spec.
3. **Module specs are JSON, not code.** A composed module is described by a `module-spec.json` document. Specs can be saved, shared, version-controlled, hand-edited, and replayed.
4. **Templates are Jinja2 files, not strings in code.** Adding a new template means dropping a file into `templates/`, not editing the scaffolder.
5. **The validator runs every time.** Both at scaffold time (refuses to generate invalid modules) and on demand against existing modules (`mb validate`).
6. **No magic in generated code.** Generated files are normal Python/TypeScript that a human can read, modify, and own. The builder is a starting point, not a runtime dependency.
7. **Templates mirror the DAW's actual UI primitives.** Every layout and section template corresponds to a pattern that already exists in `frontend/src/components/`. No invented styles.
8. **The builder cannot bypass module system rules.** It can only generate code that respects the rules. If a user wants to violate a rule, they edit the generated code by hand — and `mb validate` will flag the violation.

---

## 2. Top-level architecture

```
┌─────────────────────────────────────────────────────────────┐
│  module_builder/                                            │
│                                                             │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐   │
│  │  CLI         │   │  Web UI      │   │  Python lib  │   │
│  │  (click)     │──▶│  (React)     │──▶│  (scaffolder │   │
│  │              │   │              │   │  + validator)│   │
│  └──────────────┘   └──────────────┘   └──────┬───────┘   │
│                            │                   │           │
│                            ▼                   ▼           │
│                     ┌──────────────┐   ┌──────────────┐   │
│                     │ Bridge       │   │ Jinja2       │   │
│                     │ (FastAPI on  │   │ templates    │   │
│                     │ localhost)   │   │              │   │
│                     └──────────────┘   └──────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼ writes files into ────────────┐
                                                              │
┌─────────────────────────────────────────────────────────────▼
│  stable-audio-3/                                            │
│    backend/modules/<new_module>/                            │
│    frontend/src/modules/<new_module>/                       │
└──────────────────────────────────────────────────────────────┘
```

- **CLI** (`mb` command): for scripted/power use
- **Web UI**: visual wizard + drag-and-drop composer for non-CLI users
- **Bridge**: small FastAPI server (`localhost:8700` by default) the web UI calls; the bridge invokes the Python scaffolder library
- **Python lib**: the actual scaffolder and validator — both the CLI and the bridge depend on it
- **Templates**: Jinja2 files for backend routes, frontend components, manifests, and READMEs

---

## 3. Package structure

```
module_builder/
  README.md                          how to install and use the builder
  pyproject.toml                     separate package: name="stabledaw-module-builder"
                                     deps: click, jinja2, fastapi, uvicorn, pydantic,
                                           libcst (for AST-level validation)

  builder/                           Python library — the scaffolder + validator
    __init__.py
    cli.py                           click-based CLI entry point (`mb`)
    bridge.py                        FastAPI server bridging web UI ↔ library
    scaffold.py                      core: ModuleSpec → file tree
    validator.py                     runs rule checks on a module folder
    spec.py                          ModuleSpec pydantic model + JSON schema
    rules/                           individual rule check implementations
      __init__.py
      no_top_level_heavy_imports.py
      manifest_required_fields.py
      no_shell_true.py
      uses_apiclient.py
      uses_model_registry.py
      uses_jobs_service.py
      no_api_prefix_collision.py
      has_error_boundary.py
      registry_entry_exists.py
    templates/                       Jinja2 templates
      backend/
        module.json.j2
        __init__.py.j2
        router_base.py.j2            blank router
        router_simple_action.py.j2   POST endpoint, returns JSON
        router_job_action.py.j2      POST endpoint, creates job, returns job_id
        router_model_action.py.j2    POST endpoint, uses model_registry
        router_file_upload.py.j2     POST endpoint, file upload + validation
        router_sse_stream.py.j2      GET endpoint, SSE response
        router_subprocess.py.j2      spawns managed subprocess
        README.md.j2
      frontend/
        module.ts.j2                 ModuleManifest entry (TypeScript)
        index.tsx.j2                 default export (the view or contribution)
        layouts/
          full_view.tsx.j2
          form_plus_output.tsx.j2
          list_plus_detail.tsx.j2
          tabbed_form.tsx.j2
          editor_plus_panels.tsx.j2
          drop_zone_hero.tsx.j2
          contribution_only.tsx.j2
          modal_only.tsx.j2
        sections/
          param_row.tsx.j2
          param_group.tsx.j2          uses existing Section primitive
          action_button_row.tsx.j2
          file_drop_zone.tsx.j2
          file_list.tsx.j2
          audio_preview.tsx.j2
          job_progress_card.tsx.j2
          empty_state.tsx.j2
          log_stream.tsx.j2
          key_value_table.tsx.j2
          step_indicator.tsx.j2
        contributions/
          footer_action.tsx.j2
          context_menu_item.tsx.j2
          editor_panel.tsx.j2
          settings_section.tsx.j2

  ui/                                separate React app — the visual builder
    package.json                     deps: react, vite, dnd-kit, zustand, monaco-editor
    vite.config.ts
    index.html
    src/
      main.tsx
      App.tsx                        wizard shell
      steps/
        1-ChooseArchetype.tsx
        2-ModuleIdentity.tsx
        3-BackendRoutes.tsx
        4-LayoutCompose.tsx          drag-and-drop visual builder
        5-Contributions.tsx
        6-PreviewValidate.tsx
        7-Generate.tsx
      components/
        TemplateGallery.tsx          palette of layouts/sections
        LayoutCanvas.tsx             the dnd-kit drop target
        SectionInspector.tsx         right-pane prop editor for selected section
        LivePreviewIframe.tsx        renders the composed module with mock data
        ValidationReport.tsx         shows rule-check results
        FileTreePreview.tsx          shows what files will be written
        SpecEditor.tsx               monaco-based JSON editor for the spec
      state/
        specStore.ts                 zustand store holding the current ModuleSpec
      api/
        builderClient.ts             calls the bridge at localhost:8700

  examples/                          reference specs for hand-editing
    audio_processor.module-spec.json
    generator.module-spec.json
    analyzer.module-spec.json
    dataset_tool.module-spec.json
    library_extension.module-spec.json
    settings_panel.module-spec.json

  tests/
    test_scaffold.py
    test_validator.py
    fixtures/
      valid_module/
      invalid_top_level_import/
      invalid_missing_manifest/
      ...
```

---

## 4. The module spec — the central data model

Every module the builder generates is described by a single JSON document that conforms to a Pydantic schema. The spec is what the wizard produces, what the CLI accepts, what the validator reads back from existing modules to round-trip, and what gets saved into `examples/`.

### 4.1 Spec schema (annotated)

```json
{
  "$schema": "https://stabledaw.dev/schemas/module-spec/v1.json",
  "spec_version": 1,

  "identity": {
    "name": "stem_splitter",
    "label": "Stem Splitter",
    "description": "Separate a mixed track into drums, bass, vocals, other",
    "icon": "Scissors",
    "version": "0.1.0",
    "author": "user@example.com"
  },

  "placement": {
    "sidebar": true,
    "sidebar_order": 6,
    "frontend_only": false,
    "api_prefix": "/api/stems"
  },

  "backend": {
    "requires_models": ["demucs"],
    "requires_modules": ["library"],
    "routes": [
      {
        "id": "split",
        "method": "POST",
        "path": "/split",
        "template": "router_job_action",
        "spawns_job": true,
        "uses_model": "demucs",
        "input_schema": {
          "file_id": "string",
          "stems": "array<string>"
        }
      }
    ]
  },

  "frontend": {
    "layout": "form_plus_output",
    "sections": [
      {
        "id": "params",
        "template": "param_group",
        "props": {
          "title": "Stem Configuration",
          "fields": [
            { "key": "stems", "type": "multi_select", "label": "Stems to extract",
              "options": ["drums", "bass", "vocals", "other"], "default": ["drums", "bass"] }
          ]
        },
        "slot": "left"
      },
      {
        "id": "submit",
        "template": "action_button_row",
        "props": {
          "primary": { "label": "Split", "binds_to_route": "split" }
        },
        "slot": "left"
      },
      {
        "id": "progress",
        "template": "job_progress_card",
        "props": { "binds_to_route": "split" },
        "slot": "right"
      },
      {
        "id": "results",
        "template": "file_list",
        "props": { "title": "Output stems", "show_audio_preview": true },
        "slot": "right"
      }
    ],
    "contributions": []
  }
}
```

### 4.2 Contribution-only example (frontend-only LUFS meter)

```json
{
  "identity": { "name": "loudness_meter", "label": "Loudness Meter", "icon": "Activity" },
  "placement": { "sidebar": false, "frontend_only": true },
  "backend": null,
  "frontend": {
    "layout": "contribution_only",
    "sections": [],
    "contributions": [
      { "slot": "statusBarItem", "template": "status_item",
        "props": { "label": "LUFS", "binds_to": "playerStore.lufs", "format": "{value} dB" } },
      { "slot": "footerActions", "template": "footer_action",
        "props": { "icon": "Activity", "tooltip": "Open LUFS readout",
                   "opens_overlay_panel": "lufs_detail" } }
    ]
  }
}
```

### 4.3 Multi-slot example (visualizer mode + bottom panel tab)

A module that adds a new "Phase Correlation" visualizer mode (button in the vertical column + render in the spectral canvas) AND a new "Phase Map" tab in the bottom panel for detailed view:

```json
{
  "identity": { "name": "phase_correlation", "label": "Phase Correlation", "icon": "Waves" },
  "placement": { "sidebar": false, "frontend_only": true },
  "backend": null,
  "frontend": {
    "layout": "contribution_only",
    "sections": [],
    "contributions": [
      { "slot": "visualizerMode", "template": "visualizer_mode",
        "props": { "button_label": "P", "mode_title": "Phase Correlation",
                   "render_fn": "renderPhaseCorrelation" } },
      { "slot": "bottomPanelTab", "template": "bottom_tab",
        "props": { "label": "Phase Map", "icon": "Waves", "color": "border-rose-500 text-rose-300" } }
    ]
  }
}
```

---

## 5. The wizard — user flow through the web UI

A linear seven-step wizard, with the option to drop into freeform spec editing at any point.

### Step 1 — Choose archetype
A grid of cards, each a pre-composed spec the user can start from:

| Archetype | What it gives you |
|---|---|
| **Audio Processor** | Form + Output layout, file upload route, ffmpeg-style backend |
| **Generator** | Form + Output layout, job-spawning route, model registry usage |
| **Analyzer** | Drop Zone Hero + visualization, single backend action |
| **Dataset Tool** | Drop Zone Hero + file list, batch endpoint, SSE progress |
| **Library Extension** | Contribution-only, library context menu items |
| **Settings Panel** | Contribution-only, settings modal section, frontend-only |
| **Custom Editor** | Editor + Panels layout, no backend (pure visualization) |
| **Blank Module** | Empty spec, user composes everything manually |

Selecting an archetype loads its starter spec into the wizard's store; subsequent steps edit that spec.

### Step 2 — Module identity
Form for: `name` (validated kebab/snake case + uniqueness check against existing modules), `label`, `description`, `icon` (lucide-react picker with live preview), `version`, `author`.

### Step 3 — Backend routes
Skipped if `frontend_only: true`. Otherwise: list of routes the module exposes. For each route, the user picks a **route template** from a dropdown (each template explains what it produces and what it requires):

- `router_base` — empty stub
- `router_simple_action` — POST, validate input, return JSON
- `router_job_action` — POST, create job via `core/jobs.py`, return `job_id`
- `router_model_action` — POST, use `core/model_registry.py` to access a model
- `router_file_upload` — POST, accept multipart file, validate, write to module data dir
- `router_sse_stream` — GET, stream events
- `router_subprocess` — POST, spawn managed subprocess, track via jobs

The form also asks: required models (multi-select from known model names), required other modules (advisory), input schema (key-value editor).

### Step 4 — Layout composition (the visual UI builder)
A three-pane editor:

```
┌─────────────────┬──────────────────────────────┬───────────────────┐
│                 │                              │                   │
│  Template       │     Layout Canvas            │   Section         │
│  Gallery        │     (drag drop here)         │   Inspector       │
│                 │                              │                   │
│  ▸ Layouts      │   ┌─────────┬─────────┐     │   Selected:       │
│  ▸ Sections     │   │  left   │  right  │     │   ParamGroup      │
│  ▸ Forms        │   │ ┌─────┐ │ ┌─────┐ │     │                   │
│  ▸ Outputs      │   │ │ ... │ │ │ ... │ │     │   Props:          │
│  ▸ Actions      │   │ └─────┘ │ └─────┘ │     │   Title: ___      │
│                 │   │         │         │     │   Fields:         │
│  [drag from     │   │         │         │     │   [+ add field]   │
│   here →]       │   └─────────┴─────────┘     │                   │
│                 │                              │                   │
└─────────────────┴──────────────────────────────┴───────────────────┘
```

- **Left pane (Template Gallery):** scrollable palette of layout and section templates, organized by category. Each template card shows a thumbnail and short description. Dragging a card onto the canvas adds it to the spec.
- **Center pane (Layout Canvas):** renders the current layout's slots (e.g., `form_plus_output` has `left` and `right` slots). Sections in the spec are rendered as labeled rectangles inside their slot, with handles to reorder. Clicking a section selects it.
- **Right pane (Section Inspector):** form for editing the selected section's `props`. Schema-driven — each section template declares what props it accepts, and the inspector renders the appropriate input controls.

Changing the layout (top-of-canvas dropdown) preserves sections by remapping their slots where possible.

### Step 5 — Contributions
List of contribution points the module fills. For each: pick a slot (`footerActions`, `libraryContextMenuItems`, `editorPanels`, `settingsSections`), pick a template, configure props. Empty by default.

### Step 6 — Preview & validate
Three tabs:

- **File Tree:** shows every file that will be written, with full paths relative to the repo root
- **Code Preview:** click any file in the tree to see its rendered template content (read-only)
- **Validation Report:** runs all rule checks against the would-be output. Errors block the next step; warnings are surfaced but allow continuing.

A side panel shows a **live UI preview** in an iframe — the composed module rendered with mock data, so the user can see what their UI will look like before generating anything.

### Step 7 — Generate
Confirmation screen showing:
- Target paths (`backend/modules/stem_splitter/`, `frontend/src/modules/stem_splitter/`)
- Files to be created (count + total bytes)
- Files that would be modified in the main app (e.g., `frontend/src/core/ModuleRegistry.ts` needs the new module added)
- "Generate" button — atomic: either all files write successfully, or none do (uses a staging directory then moves on success)
- Post-generation: copy-pastable next steps (run `uv sync --group backend`, navigate to the module in the DAW, etc.)

---

## 6. Template catalog

This is the catalog the visual builder draws from. Each entry maps to a Jinja2 file under `module_builder/builder/templates/`.

### 6.1 Layout templates

| Template | Slots | Mirrors |
|---|---|---|
| `form_plus_output` | `left`, `right` | GenerateView |
| `list_plus_detail` | `list`, `detail` | LibraryView |
| `tabbed_form` | `tabs` (each tab has slots) | TrainingView |
| `editor_plus_panels` | `editor`, `bottom_tabs` | StudioView / DAWCenterPanel |
| `drop_zone_hero` | `dropzone`, `populated` (shown after files dropped) | Dataset prep concept |
| `single_form` | `body` | simplest possible — vertical scroll of sections |
| `modal_only` | `modal_body` | DocsModal |
| `contribution_only` | (none — no main view) | for modules that only contribute to other UI |

### 6.2 Section templates (composable)

| Template | Purpose | Maps to existing primitive |
|---|---|---|
| `param_row` | Single labeled control row (slider/input/dropdown/toggle/multi-select) | matches generate params styling |
| `param_group` | Collapsible group of param rows | uses `components/ui/Section.tsx` |
| `action_button_row` | Primary + secondary action buttons; primary can bind to a backend route id | matches GlobalGenerateBar styling |
| `file_drop_zone` | Drag-and-drop file area with preview | new — but matches dark/purple style |
| `file_list` | List of files with optional audio preview column and per-row actions | matches LibraryView styling |
| `audio_preview` | Embedded waveform + transport controls | wraps `WaveformPreview.tsx` |
| `job_progress_card` | Subscribed to a job ID, shows status/progress/message/cancel | bound to `/api/jobs/{id}/stream` |
| `empty_state` | Illustration + headline + body + optional CTA | uses lucide icon + DAW typography |
| `log_stream` | Scrolling log output | matches ProcessingLog styling |
| `key_value_table` | Display of structured metadata | matches DetailsView styling |
| `step_indicator` | Wizard step nav (1 of N) | matches the builder's own wizard styling |
| `status_badge` | Green/yellow/red pill | matches statusBarStore styling |
| `visualizer_canvas` | Audio visualization canvas | wraps `AdvancedVisualizer.tsx` |
| `step_sequencer_grid` | MIDI-style step grid | wraps `StepSequencer.tsx` |
| `piano_roll_grid` | Piano roll editor | wraps `PianoRoll.tsx` |
| `waveform_editor` | Full waveform editor with selections | wraps `WaveformEditor.tsx` |

### 6.3 Placement slots — every place a module can appear in the DAW

theDAW exposes a fixed catalog of named slots. A module's spec declares which slots it fills. Each slot has a defined template, prop schema, and matching preview backdrop (see §9.3).

| Slot ID | Where in the DAW | What it does | Renders inside |
|---|---|---|---|
| `mainSidebarTab` | Left panel top tab row (CREATE / EDIT / TRAIN / LIBRARY) | Full-view tab; module owns the entire left panel when active | `Shell.tsx` tabs |
| `leftPanelOverlay` | A floating panel slot inside the left panel | Always-visible mini-tool above the main view | `Shell.tsx` left rail |
| `rightPanel` | New right-side ResizablePanel (mirror of left) | Persistent right column (mixer, inspector) | New slot — added with this system |
| `centerToolbar` | DAWCenterPanel toolbar (next to Waveform Editor / Step Sequencer toggles) | Workspace mode button | `DAWCenterPanel.tsx:67-85` |
| `centerWorkspace` | Main canvas content (replaces WaveformEditor/StepSequencer) | New workspace mode (selectable from `centerToolbar`) | `DAWCenterPanel.tsx:88-90` |
| `bottomPanelTab` | DAWCenterPanel bottom tabs (Spectral / Details / Piano Roll / Bucket) | New tab in the bottom analysis panel | `DAWCenterPanel.tsx:132-145` |
| `visualizerMode` | Vertical button column inside the spectral visualizer (O / S / R) | Adds a new visualization mode button + render | `AdvancedVisualizer.tsx:154-169` |
| `footerActions` | PlayerFooter right side icon row | Icon button next to transport | `PlayerFooter.tsx` right group |
| `footerLeftActions` | PlayerFooter left side | Icon button next to play/stop | `PlayerFooter.tsx` left group |
| `trackHeader` | Per-track header in the WaveformEditor | Per-track action button or label | `WaveformEditor.tsx` track row |
| `trackContextMenu` | Right-click on an individual track | Per-track menu item | `WaveformEditor.tsx` track right-click |
| `editorOverlayPanel` | Floating collapsible panel anchored inside the editor canvas | Tool palette, chord overlay, etc. | `WaveformEditor.tsx` overlay layer |
| `libraryContextMenu` | Right-click on a library entry | Menu item ("Send to ...") | `LibraryView.tsx` row menu |
| `libraryRowAction` | Inline action button on each library row | One-click action without opening the menu | `LibraryView.tsx` row trailing icon |
| `generateBarAction` | The pinned GlobalGenerateBar on the CREATE tab | Action button next to the RUN button | `GlobalGenerateBar.tsx` |
| `processingLogAction` | Actions inside ProcessingLog header | Clear/export/filter buttons | `ProcessingLog.tsx` header |
| `settingsSection` | Section inside the Settings modal | Module config UI | (modal — created when first contribution exists) |
| `docsTab` | Tab inside DocsModal | Module-supplied documentation tab | `DocsModal.tsx` |
| `statusBarItem` | Status bar at the very bottom | Tiny readout (LUFS, CPU, etc.) | `statusBarStore` consumer |

A module can fill **zero or more** slots. A module with `mainSidebarTab` plus `footerActions` plus `visualizerMode` is valid — it has a full view AND adds a footer button AND adds a visualizer mode.

### 6.4 Contribution templates

| Template | Default slot | Generates |
|---|---|---|
| `main_view` | `mainSidebarTab` | Full-view module with one of the §6.1 layouts inside |
| `panel_view` | `leftPanelOverlay` / `rightPanel` | Always-visible panel content |
| `workspace_mode` | `centerWorkspace` (+ `centerToolbar` button) | New main-canvas mode |
| `bottom_tab` | `bottomPanelTab` | Tab content for the bottom panel |
| `visualizer_mode` | `visualizerMode` | Canvas render fn + button entry |
| `footer_action` | `footerActions` / `footerLeftActions` | Icon button + click handler |
| `track_action` | `trackHeader` | Per-track button bound to track context |
| `track_menu_item` | `trackContextMenu` | Per-track menu item |
| `editor_overlay` | `editorOverlayPanel` | Floating panel anchored to editor |
| `library_menu_item` | `libraryContextMenu` | Menu item with action |
| `library_row_action` | `libraryRowAction` | Inline icon button |
| `generate_action` | `generateBarAction` | Button alongside RUN |
| `processing_action` | `processingLogAction` | Header button |
| `settings_section_template` | `settingsSection` | Form section in settings modal |
| `docs_tab_template` | `docsTab` | Markdown doc tab |
| `status_item` | `statusBarItem` | Small readout |

Each contribution template knows its slot's render contract (what props it gets, what the surrounding element looks like) and produces frontend code that conforms.

### 6.5 Backend route templates

Each template generates a self-contained route handler that follows the module system rules. All heavy imports are deferred inside the handler.

| Template | Generates | Includes |
|---|---|---|
| `router_base` | Stub `APIRouter()` + one health endpoint | Empty start point |
| `router_simple_action` | POST with input validation, returns JSON | Pydantic input model, error handling |
| `router_job_action` | POST that creates a job via `core/jobs.py` and returns `{job_id}` | Background task, job lifecycle, deferred heavy imports |
| `router_model_action` | POST that fetches a model via `core/model_registry.py` | Registry lookup, model use, no module-level model load |
| `router_file_upload` | POST accepting multipart file with path validation | Size limits, MIME validation, written to module data dir |
| `router_sse_stream` | GET returning SSE response | Async generator, proper headers, cleanup on disconnect |
| `router_subprocess` | POST that spawns subprocess, tracks via jobs, captures output | List-form args, no `shell=True`, lifespan cleanup |

---

## 7. Validation engine

The validator is a separate component (`builder/validator.py`) that can run against:
- The spec, before scaffolding (catches issues before any file is written)
- A generated module folder (catches post-generation drift)
- A hand-written module folder (`mb validate path/to/module`)

Each rule lives in its own file under `builder/rules/` and implements a `check(module_path: Path) -> RuleResult` interface. New rules can be added without modifying the validator core.

### 7.1 Rules ported from the module system spec

| Rule | What it checks | Severity |
|---|---|---|
| `manifest_required_fields` | `module.json` has `name`, `label`, `enabled`, `icon` | error |
| `no_top_level_heavy_imports` | AST-parses `router.py`, flags top-level imports of `torch`, `torchaudio`, `pytorch_lightning`, `transformers`, etc. | error |
| `no_shell_true` | greps for `subprocess.*shell=True` | error |
| `no_api_prefix_collision` | reads all sibling `module.json` files, checks for prefix overlap | error |
| `uses_apiclient` (frontend) | flags raw `fetch(` calls outside `api/apiClient.ts` | warning |
| `uses_model_registry` | flags direct `AutoencoderModel.from_pretrained` or `pipeline.from_pretrained` calls outside the registry | error |
| `uses_jobs_service` | flags ad-hoc background tasks not registered with `core/jobs.py` | warning |
| `has_error_boundary` (frontend) | confirms the module's default export is either wrapped in ErrorBoundary or relies on Shell's boundary | info |
| `registry_entry_exists` (frontend) | confirms the module appears in `frontend/src/core/ModuleRegistry.ts` `REGISTERED_MODULES` | error |
| `data_dir_declared` | confirms module writes only into a declared data directory | warning |
| `manifest_backend_matches_router` | if `backend: true`, `router.py` must exist; if `backend: false`, must not | error |

### 7.2 Rule result format

```python
@dataclass
class RuleResult:
    rule_name: str
    severity: Literal["error", "warning", "info"]
    passed: bool
    message: str
    file: Optional[Path] = None
    line: Optional[int] = None
    suggestion: Optional[str] = None
```

The validator collects all results into a `ValidationReport` with a summary (errors blocking, warnings advisory) and per-rule details. The web UI renders this report inline; the CLI prints it to stdout with colored severity markers.

---

## 8. CLI surface

```
mb new                              # interactive prompt-based wizard (CLI version of the web wizard)
mb new --archetype generator --name my_synth --label "My Synth"
mb new --from-spec my-module.json
mb new --from-spec my-module.json --dry-run            # writes nothing, prints file tree
mb validate <module_path>                              # rule check
mb validate <module_path> --json                       # machine-readable output
mb preview <module_path>                               # serves a local preview of the module's UI at localhost:8701
mb list-templates                                      # show available archetypes, layouts, sections, routes
mb list-templates --category layouts
mb describe-template <template_name>                   # show the template's props schema and what it generates
mb extract-spec <module_path>                          # reverse: read an existing module and emit its module-spec.json
mb upgrade <module_path>                               # update generated boilerplate to the latest template version
mb ui                                                  # start the web UI + bridge (opens browser)
```

---

## 9. Web UI

A separate Vite-built React app, started by `mb ui`. Runs on `localhost:8700` (bridge API) + serves the UI at the same port. The UI is **dev-only** — not bundled with the main DAW, not exposed externally.

### 9.1 Bridge API (FastAPI on `localhost:8700`)

```
GET    /api/templates                     list all templates with metadata
GET    /api/templates/{id}                template details (props schema, source)
GET    /api/archetypes                    list pre-composed starter specs
GET    /api/existing-modules              list already-installed modules in the main DAW
POST   /api/validate-spec                 validate a spec, return ValidationReport
POST   /api/render-preview                given a spec, return rendered HTML for the iframe preview
POST   /api/scaffold                      atomic generate: takes spec, returns success + file list
POST   /api/scaffold/dry-run              return file tree + content without writing
GET    /api/icons                         lucide-react icon list for the picker
```

### 9.2 UI state model

A single Zustand store (`specStore.ts`) holds the current `ModuleSpec`, the current wizard step, the last validation report, and the last preview render. Every wizard step is a controlled view over this store. Going back through wizard steps does not lose state.

### 9.3 Live preview — the wireframe DAW

The preview iframe loads a **mock DAW shell** (`preview-harness.html`) that renders a stripped-down skeleton of the real theDAW with every placement slot present and labeled. The module under construction renders inside the slot(s) it declares in the spec. Slots the module does NOT fill are shown as dimmed labeled rectangles so the author always sees the module's placement in context.

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Header: theDAW                                  [Docs] [Settings]  │
├──────────┬───────────────────────────────────────────────────────────────┤
│  CREATE  │  ▶ Workspace toolbar ─────────────────────────────────       │
│  EDIT    │  [Waveform Editor] [Step Sequencer] [+ centerToolbar slot]   │
│  TRAIN   │  ┌──────────────────────────────────────────────────────┐  │
│  LIBRARY │  │ Main canvas — centerWorkspace slot                    │  │
│ +YOUR    │  │ (WaveformEditor mock with 4 track rows showing        │  │
│  TAB     │  │  trackHeader + trackContextMenu slots highlighted)    │  │
│ ◀────────│  │                                                       │  │
│          │  │     ┌─ editorOverlayPanel slot ─┐                    │  │
│   left   │  │     │                            │                    │  │
│  panel   │  │     └────────────────────────────┘                    │  │
│  body    │  └───────────────────────────────────────────────────────┘  │
│          │  ┌─ Bottom panel ──────────────────────────────────────┐  │
│  [left   │  │ [Spectral] [Details] [Piano Roll] [Bucket] [+ tab] │  │
│  Panel-  │  │  ╭──────────────────────────────────────────────╮  │  │
│  Overlay]│  │  │  O                                            │  │  │
│          │  │  │  S    ← visualizerMode slot (vertical col)    │  │  │
│          │  │  │  R                                            │  │  │
│          │  │  ╰──────────────────────────────────────────────╯  │  │
│          │  └──────────────────────────────────────────────────────┘  │
├──────────┴───────────────────────────────────────────────────────────────┤
│  [◀◀] [▶] [▶▶]   waveform mini   [vol]  [+ footerActions slot]  [user] │
│  status: ready   [+ statusBarItem slot]                                  │
└──────────────────────────────────────────────────────────────────────────┘
```

When the user's spec declares a slot, the corresponding slot rectangle becomes **active** (purple outline + the module's actual rendered contribution inside). All other slots remain visible but dimmed, so the author can:

1. See where their module will appear in the real DAW at all times
2. Catch placement mistakes (e.g., "I picked `bottomPanelTab` but I meant `visualizerMode`")
3. Pick a different slot by dragging the contribution from one slot to another (the canvas serves as a placement editor)

### 9.4 Preview-harness internals

The harness is a self-contained React app bundled with the builder:

```
module_builder/ui/preview-harness/
  index.html
  src/
    MockDawShell.tsx          ← wireframe DAW with all slots labeled
    slots/
      MainSidebarTabSlot.tsx
      LeftPanelOverlaySlot.tsx
      RightPanelSlot.tsx
      CenterToolbarSlot.tsx
      CenterWorkspaceSlot.tsx
      BottomPanelTabSlot.tsx
      VisualizerModeSlot.tsx
      FooterActionsSlot.tsx
      FooterLeftActionsSlot.tsx
      TrackHeaderSlot.tsx
      TrackContextMenuSlot.tsx
      EditorOverlayPanelSlot.tsx
      LibraryContextMenuSlot.tsx
      LibraryRowActionSlot.tsx
      GenerateBarActionSlot.tsx
      ProcessingLogActionSlot.tsx
      SettingsSectionSlot.tsx
      DocsTabSlot.tsx
      StatusBarItemSlot.tsx
    mocks/
      mockPlayerStore.ts       ← fake transport state
      mockLibraryStore.ts      ← 4 fake library entries
      mockTrackStore.ts        ← 4 fake tracks with waveform stubs
      mockJobsApi.ts           ← synthetic jobs that progress 0→100% in 5s
      mockModelRegistry.ts     ← no-op models accepting any input
      mockAudioFile.wav        ← bundled 5s test tone for audio_preview sections
```

The harness reads the current `ModuleSpec` from a `postMessage` channel out of the parent (the wizard) and re-renders on every spec change. There is no Vite dev server — the harness is pre-built once, and dynamic content (the user's composed sections) is rendered via a small interpreter that maps spec entries → React components from the template-runtime library.

This means: the preview is instant, has no compile step, and never executes user-written code (only the spec, which is data).

### 9.5 Slot-aware drag interaction

In wizard Step 4 (Layout Compose) and Step 5 (Contributions), the canvas IS the wireframe DAW. Dragging a contribution template from the palette onto a slot:

1. Highlights all compatible slots (e.g., a `footer_action` template highlights both `footerActions` and `footerLeftActions`)
2. On drop, adds the contribution to the spec with that slot
3. The contribution renders live inside the slot, with the rest of the wireframe DAW intact around it

The user can drag an existing contribution from one slot to another — the spec updates, the template-runtime re-renders.

---

## 10. How the builder integrates with the main DAW

The builder writes into two places in the main repo:

| What it writes | Where |
|---|---|
| Module folder (backend) | `backend/modules/<name>/` |
| Module folder (frontend) | `frontend/src/modules/<name>/` |
| Module registry entry | appends to `frontend/src/core/ModuleRegistry.ts` |
| (Optional) data directory | `data/modules/<name>/` (created on first use) |

It **does not** write into the main `pyproject.toml`. If a generated module needs new Python dependencies, the builder surfaces those as a post-generation report ("add these to a new optional dependency group in `pyproject.toml`") rather than auto-editing the project config. This keeps dependency management an explicit, reviewable step.

The append-to-`ModuleRegistry.ts` operation uses a comment-marker convention:
```typescript
const REGISTERED_MODULES: ModuleManifest[] = [
  // ... existing entries ...
  // BUILDER:MODULES_START
  // ... builder-managed entries ...
  // BUILDER:MODULES_END
];
```
The builder only edits between the markers. Hand-edited entries outside the markers are never touched.

---

## 11. Extension — adding new templates

Adding a new section template:

1. Drop a Jinja2 file at `module_builder/builder/templates/frontend/sections/my_thing.tsx.j2`
2. Add an entry to `module_builder/builder/templates/registry.json`:
   ```json
   {
     "id": "my_thing",
     "category": "sections",
     "label": "My Thing",
     "description": "Does the thing",
     "props_schema": { "type": "object", "properties": { ... } },
     "thumbnail": "thumbnails/my_thing.png"
   }
   ```
3. Restart the bridge — no code changes required

The same applies to layout, route, and contribution templates. The registry file is the single source of truth for what the web UI's gallery shows.

---

## 12. Security and safety

The builder runs locally and writes files into the repo. The security boundary is "the user has write access to the repo." Specific safeguards:

- **Paths are constrained.** The scaffolder refuses to write outside `backend/modules/`, `frontend/src/modules/`, and `data/modules/`. The validator rejects specs with `..` or absolute paths.
- **Atomic writes.** Scaffolding writes to a staging directory and moves on success. Failed scaffolding leaves no partial files.
- **No remote template loading.** Templates are local files only. There is no "install a template from a URL" command.
- **No code execution at scaffold time.** Templates are Jinja2 text — no `{% include %}` of arbitrary paths, no Python eval. The renderer is sandboxed.
- **The bridge binds to localhost only.** Hardcoded `host="127.0.0.1"` — never `0.0.0.0`.
- **Generated code goes through the validator.** A user who hand-edits a template to bypass a rule still gets caught at generation time.
- **No automatic dependency installation.** The builder never runs `uv add` or `pip install`. It reports required deps; the user reviews and installs.

---

## 13. What this builder does NOT do

- Does not host or distribute modules. There is no marketplace.
- Does not edit `pyproject.toml`. Dependency changes are a manual, reviewable step.
- Does not run modules. It only generates them; the main DAW runs them.
- Does not migrate or refactor existing modules. `mb upgrade` updates boilerplate to the latest template version but is a discrete, opt-in operation.
- Does not generate tests for modules. Test scaffolding is a future enhancement.
- Does not visually edit the templates themselves. Editing `.tsx.j2` files is a text-editor activity.
- Does not handle multi-module workflows in one spec. One spec = one module.

---

## 14. Phased rollout

### Phase A — Library + CLI (the minimum useful product)
1. Stand up `module_builder/` package with `pyproject.toml`
2. Build `spec.py` (Pydantic model) and `scaffold.py` (Jinja2 → files)
3. Write the seven backend route templates and the eight layout templates
4. Write the fifteen section templates
5. Implement `mb new`, `mb new --from-spec`, `mb validate`, `mb list-templates`
6. Port all rules from the module system spec into `builder/rules/`
7. Write the `examples/` reference specs and snapshot-test against them

At end of Phase A: a power user can scaffold a working module with one CLI command and a JSON spec.

### Phase B — Web wizard
1. Stand up `module_builder/ui/` Vite app
2. Build the bridge (`bridge.py`)
3. Implement steps 1–3 of the wizard (archetype, identity, backend routes)
4. Wire `mb ui` to start bridge + open browser

At end of Phase B: most users can use a guided flow without touching JSON.

### Phase C — Visual layout composer (step 4)
1. Add dnd-kit drag-and-drop canvas
2. Build the SectionInspector with prop-schema-driven inputs
3. Render slot-aware layout previews

### Phase D — Live preview + validation surface
1. Build the iframe preview harness
2. Wire validation reporting into the wizard's Step 6
3. Add the `mb preview <module>` standalone command

### Phase E — Polish
- `mb extract-spec` (round-trip from existing module)
- `mb upgrade` (boilerplate refresh)
- Test scaffolding templates
- Documentation site (rendered from template registry)

---

## 15. File checklist for Phase A

```
module_builder/
  pyproject.toml                                CREATE
  README.md                                     CREATE
  builder/
    __init__.py                                 CREATE (empty)
    cli.py                                      CREATE — click entry point with `new`, `validate`, `list-templates`
    scaffold.py                                 CREATE — ModuleSpec → file tree, atomic write
    validator.py                                CREATE — runs all rules, returns ValidationReport
    spec.py                                     CREATE — Pydantic models + JSON schema export
    rules/
      __init__.py                               CREATE
      manifest_required_fields.py               CREATE
      no_top_level_heavy_imports.py             CREATE (uses libcst)
      no_shell_true.py                          CREATE
      no_api_prefix_collision.py                CREATE
      uses_model_registry.py                    CREATE
      uses_jobs_service.py                      CREATE
      uses_apiclient.py                         CREATE
      has_error_boundary.py                     CREATE
      registry_entry_exists.py                  CREATE
      manifest_backend_matches_router.py        CREATE
      data_dir_declared.py                      CREATE
    templates/
      registry.json                             CREATE — single source of truth for template catalog
      backend/
        module.json.j2                          CREATE
        __init__.py.j2                          CREATE
        router_base.py.j2                       CREATE
        router_simple_action.py.j2              CREATE
        router_job_action.py.j2                 CREATE
        router_model_action.py.j2               CREATE
        router_file_upload.py.j2                CREATE
        router_sse_stream.py.j2                 CREATE
        router_subprocess.py.j2                 CREATE
        README.md.j2                            CREATE
      frontend/
        module.ts.j2                            CREATE
        index.tsx.j2                            CREATE
        layouts/
          full_view.tsx.j2                      CREATE
          form_plus_output.tsx.j2               CREATE
          list_plus_detail.tsx.j2               CREATE
          tabbed_form.tsx.j2                    CREATE
          editor_plus_panels.tsx.j2             CREATE
          drop_zone_hero.tsx.j2                 CREATE
          single_form.tsx.j2                    CREATE
          modal_only.tsx.j2                     CREATE
          contribution_only.tsx.j2              CREATE
        sections/
          param_row.tsx.j2                      CREATE
          param_group.tsx.j2                    CREATE
          action_button_row.tsx.j2              CREATE
          file_drop_zone.tsx.j2                 CREATE
          file_list.tsx.j2                      CREATE
          audio_preview.tsx.j2                  CREATE
          job_progress_card.tsx.j2              CREATE
          empty_state.tsx.j2                    CREATE
          log_stream.tsx.j2                     CREATE
          key_value_table.tsx.j2                CREATE
          step_indicator.tsx.j2                 CREATE
          status_badge.tsx.j2                   CREATE
          visualizer_canvas.tsx.j2              CREATE
          step_sequencer_grid.tsx.j2            CREATE
          piano_roll_grid.tsx.j2                CREATE
          waveform_editor.tsx.j2                CREATE
        contributions/
          footer_action.tsx.j2                  CREATE
          context_menu_item.tsx.j2              CREATE
          editor_panel.tsx.j2                   CREATE
          settings_section.tsx.j2               CREATE
  examples/
    audio_processor.module-spec.json            CREATE
    generator.module-spec.json                  CREATE
    analyzer.module-spec.json                   CREATE
    dataset_tool.module-spec.json               CREATE
    library_extension.module-spec.json          CREATE
    settings_panel.module-spec.json             CREATE
  tests/
    test_scaffold.py                            CREATE
    test_validator.py                           CREATE
    test_spec_roundtrip.py                      CREATE
    fixtures/                                   CREATE — valid + invalid module fixtures
```


