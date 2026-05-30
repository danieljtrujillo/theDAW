# theDAW — Big-Picture Plan
**Date:** 2026-05-25
**Scope:** UI re-dock + sequencer integration + auto-analysis + auto-stems + MIDI conversion + embedded-tag extraction + SQLite lineage graph + library bundles
**Mode:** plan-only — no edits outside this file.

---

## Context

The app has grown into a real multi-feature DAW (Chimera mashups, multi-track editor, step sequencer, piano roll, library with backend storage). Three pain points are now blocking quality-of-life work:

1. **UI is cramped.** Library sits inside the same left tab as Create/Process/Train, so users tab-switch to find tracks while editing. The step sequencer is a full-screen workspace mode, which fights the editor instead of complementing it.
2. **Metadata is a desert.** Every track stores only what the generator wrote. No BPM/key/genre/pitch on anything imported, no stem links, no MIDI sidecars, no parent/child lineage. Chimera re-detects BPM every time. AI-generated MP3 imports throw away the prompt embedded in their ID3 tags.
3. **No automation infrastructure.** When a track lands on disk, nothing happens to it. The user wants opt-in "during downtime" enrichment: scan for metadata, separate stems, convert to MIDI, link the whole family into a lineage graph that doubles as a LoRA dataset / knowledge-graph foundation.

We have a clean module system, a working chimera/library backend, a healthy storage-provider abstraction, an external `integration-package` (FastAPI sidecar with Demucs + LARSNET) sitting at `D:\StableAudio\JoshOG\integration-package`, and zustand stores ready to be extended. Nothing here requires throwing things away — it's all additive.

---

## Resolved design decisions

| Question | Choice |
|---|---|
| Sequencer-as-editor-track sync | **MIDI-clip model** — track stores raw MIDI, playback via a built-in Web Audio synth. Best fit for MIDI controller hookup (controller → buffer, no re-bounce). |
| Stem separator wiring | **Sidecar process** — new `backend/modules/stems/` spawns the integration-package on a free port and proxies `/api/stems/*`. |
| MIDI conversion engine | **basic-pitch default + piano-transcription-inference on the piano stem.** Stem-aware routing. |
| Lineage / graph store | **SQLite + explicit edge tables in `data/library.db`.** Edge-table design = future-portable to kuzudb/oxigraph via one export script. |
| Toggle persistence | Backend-authoritative (`data/settings.json` via new `backend/modules/settings/`), mirrored to a zustand-`persist` store on the frontend. Both default OFF. |

---

## Phase 0 — Foundations (do first, low risk)

These are zero-controversy refactors everything else assumes.

### 0.1 New `backend/modules/settings/` module
- `router.py` exposes `GET /api/settings`, `PATCH /api/settings`. Persists to `data/settings.json`.
- Schema (versioned):
  ```json
  {
    "schema_version": 1,
    "analysis": { "auto_on_import": false, "auto_on_generate": false, "include_genre": false, "include_key": true },
    "stems": { "auto_on_import": false, "auto_on_generate": false, "default_count": 4 },
    "midi": { "auto_on_import": false, "auto_on_generate": false, "from_stems": true },
    "idle": { "min_idle_seconds": 30, "respect_vram_pressure": true }
  }
  ```
- Existing `backend/modules/loader.py` already auto-discovers this — just need `module.json` + `router.py`.
- Frontend: `frontend/src/state/featureToggleStore.ts` wraps `settings` API + `persist()` middleware for instant local reads.

### 0.2 SQLite library DB at `data/library.db`
- Tables (initial schema, all PKs are TEXT entry IDs):
  ```sql
  entries           (id PK, kind, title, prompt, mime, sample_rate, bit_depth,
                     duration_sec, file_size, audio_path, created_at, updated_at,
                     analysis_status, stems_status, midi_status, metadata_json)
  analysis          (entry_id PK, bpm, beats_json, key, key_confidence,
                     scale, pitch_mean_hz, pitch_std_hz, loudness_lufs,
                     rms_db, bars_estimated, genre, genre_confidence,
                     embedded_tags_json, ffprobe_json, analyzed_at, version)
  stems             (id PK, entry_id, stem_name, audio_path, file_size,
                     model, model_variant, separated_at, version)
  midis             (id PK, entry_id, source ('full'|'stem'), source_ref,
                     midi_path, engine, engine_version, notes_count,
                     converted_at, version)
  relations         (id PK, from_id, to_id, kind, weight,
                     metadata_json, created_at)
                    -- kind: 'chimera_source_of', 'init_for', 'inpaint_for',
                    --       'stem_of', 'midi_of', 'derived_from', 'used_in_lora'
  tag_index         (entry_id, tag)                       -- many-to-many
  prompt_corpus     (entry_id, prompt_text, prompt_kind)  -- 'positive'|'negative'|'embedded'|'user'
  schema_meta       (key, value)                          -- 'version': '1', 'created_at': ...
  ```
- Indexes on `entries.created_at`, `relations.from_id`, `relations.to_id`, `tag_index.tag`, `prompt_corpus.entry_id`.
- New file `backend/modules/library/db.py` — pure stdlib `sqlite3`, `JSON1` enabled, thin DAO. No ORM.
- `LibraryStore` (`backend/modules/library/store.py`) becomes a **read-through + write-through** wrapper: still writes the per-entry `metadata.json` for portability, but also upserts into SQLite. SQLite is the query authority; `metadata.json` is the durable backup.
- On first launch with existing entries on disk: one-shot `reindex()` walks `data/generations/` and populates SQLite from `metadata.json` files. Idempotent.
- Edge-table design = directly exportable to kuzudb/oxigraph later via a 30-line script (`scripts/export_graph.py` — not built in this plan, but the schema is ready).

### 0.3 Job + idle infrastructure
- Extend `backend/core/jobs.py` (already exists in-memory): add a `Queue` class with priority + worker pool.
- New `backend/core/idle.py`:
  ```python
  class IdleManager:
      def is_idle(self, min_idle_seconds: int = 30) -> bool: ...
      def bump_activity(self) -> None: ...
      def gpu_pressure(self) -> Literal['low','medium','high']: ...
  ```
  Tracks: any active generation, any active studio render, last user-driven HTTP request timestamp, `torch.cuda.memory_allocated()` against `device_total_memory`.
- Generate endpoint + studio endpoints call `idle_manager.bump_activity()` at entry.
- New `backend/core/background_workers.py` — one process-wide `asyncio` worker that pulls from the queue, gated on `IdleManager.is_idle()`. Pauses immediately when user activity resumes.

**Critical files to add:**
- [backend/modules/settings/module.json](backend/modules/settings/module.json)
- [backend/modules/settings/router.py](backend/modules/settings/router.py)
- [backend/modules/settings/store.py](backend/modules/settings/store.py)
- [backend/modules/library/db.py](backend/modules/library/db.py)
- [backend/core/idle.py](backend/core/idle.py)
- [backend/core/background_workers.py](backend/core/background_workers.py)
- [frontend/src/state/featureToggleStore.ts](frontend/src/state/featureToggleStore.ts)

---

## Phase 1 — UI re-dock

### 1.1 Move Library to a permanent right-side dock
- Remove `'library'` from the tabs array in [Shell.tsx:77-82](frontend/src/components/layout/Shell.tsx#L77-L82).
- Add a new `ResizablePanel position="right"` mounted permanently in Shell, wrapping `<LibraryView />`. Default `isOpen=false`, `defaultWidth=380`, `minWidth=280`, `maxWidth=640`.
- Extend [ResizablePanel.tsx](frontend/src/components/layout/ResizablePanel.tsx) to:
  - Support `position="right"` (mirror existing left logic; resize handle on the LEFT edge).
  - Accept an optional `persistKey` prop. When set, width + isOpen mirror to localStorage (the same `zustand/middleware/persist` pattern used in [bottomPanelStore.ts](frontend/src/state/bottomPanelStore.ts)).
- Add `isRightPanelOpen` + `rightPanelWidth` to [appUiStore.ts](frontend/src/state/appUiStore.ts), wrapped in `persist()` with name `'stabledaw-right-panel'` so collapsed state survives reload / crash / shutdown.
- Add a toggle button in the header (mirror the existing left-panel chevron at [Shell.tsx:97-105](frontend/src/components/layout/Shell.tsx#L97-L105)).
- Inside [LibraryView.tsx](frontend/src/views/LibraryView.tsx): remove the `onSwitchTab` callback (no longer in a tab system). The grid/list layout already adapts to narrow widths.

### 1.2 Move Step Sequencer to the lower panel
- Remove `'sequencer'` from `workspaceMode` in [DAWCenterPanel.tsx:25](frontend/src/components/layout/DAWCenterPanel.tsx#L25). Drop the Step Sequencer toolbar button (line 79-86).
- Add `'step-seq'` to `BottomPanelTab` in [bottomPanelStore.ts](frontend/src/state/bottomPanelStore.ts) and to `TAB_DEFS` in DAWCenterPanel.tsx, sitting next to `'piano-roll'`. Reuse the existing `Layers` icon (cyan).
- Bottom-panel tab content branch renders `<StepSequencer />` (the existing component) inside the same panel — no full-screen workspace mode any more.

---

## Phase 2 — Sequencer-as-editor-track (MIDI-clip model)

### 2.1 Extend the editor data model
- In [editorStore.ts](frontend/src/state/editorStore.ts) (line 16-48 region):
  - Add `'midi'` to `AudioClip.sourceKind` union: `'audio' | 'piano-roll' | 'step-seq' | 'midi'`.
  - When `sourceKind === 'midi'`, fields used:
    - `midiBuffer: MidiBuffer` (notes array — shared by reference with the lower-panel piano-roll / step-seq store when synced).
    - `synthPreset: string` (e.g., `'sine_env'`, `'square_pluck'`, `'piano_sf2'` later).
    - `audioBlob`/`peaks` become **optional** (rendered lazily for waveform preview only).
- Add `EditorTrack.kind: 'audio' | 'midi'`. MIDI tracks render a notes-strip in the timeline (mini piano-roll preview) instead of a waveform.

### 2.2 Track ↔ lower-panel sync
- New store: [frontend/src/state/midiSyncStore.ts](frontend/src/state/midiSyncStore.ts):
  ```ts
  interface MidiSyncState {
    boundTrackId: string | null;          // which timeline track the lower panel is bound to
    bindings: Record<trackId, 'on' | 'off'>;  // per-track sync flag
    bindNext(): void;                     // arrow ▶: cycle to next ON-synced track
    bindPrev(): void;                     // arrow ◀
    toggleBinding(trackId): void;
  }
  ```
- Lower-panel piano roll & step sequencer read `boundTrackId` and edit that track's `midiBuffer` directly (zustand subscribe).
- If only ONE track has `bindings[id] === 'on'`, the toggle UI shows a single ON/OFF switch.
- If TWO OR MORE, replace the switch with `◀ Track 1 ▶` arrow controls (cycles through `bindings.filter(on)`). Up/down arrows mapped as alternative keybinds when the lower panel has focus.
- "Editing one will edit the other IF synced" → because both views read/write the same `midiBuffer` object reference. Unsynced tracks keep their own buffer (independent edits).

### 2.3 Built-in MIDI playback synth
- New file [frontend/src/lib/midiSynth.ts](frontend/src/lib/midiSynth.ts):
  - Tiny Web Audio engine: `AudioContext` + `OscillatorNode` + ADSR `GainNode` per voice, polyphony cap 16, output to a per-track `GainNode → MasterGain`.
  - Presets: `sine_env`, `triangle_env`, `square_pluck`, `saw_pad`. (Enough for v1.)
  - API: `synth.scheduleNote(when, note, duration, velocity, preset)`, `synth.panic()`.
- Engine hooks in [PlayerFooter.tsx](frontend/src/components/audio/PlayerFooter.tsx) so transport play scrubs MIDI tracks alongside audio.
- **Hooks for upgrade:** synth instance lives behind an interface `IMidiSynth`. Drop-in replacements later: SoundFont (via `js-synthesizer`), wasm-based sf2 player, or an external VST host.

### 2.4 MIDI controller input (Web MIDI API)
- New [frontend/src/lib/midiInput.ts](frontend/src/lib/midiInput.ts):
  - `navigator.requestMIDIAccess()`, enumerate inputs, listen on `midimessage`.
  - When an input is selected AND a track is bound (sync ON), route note-on/off events into the bound `midiBuffer` AND into `midiSynth` for live audition.
- UI: small MIDI input dropdown in the lower panel's piano-roll tab header.
- This is the payoff for picking the MIDI-clip model: notes flow controller → buffer → both views update live → playback uses same buffer.

---

## Phase 3 — Embedded-tag extraction (small, feeds Phase 4)

Many AI MP3s embed the prompt in ID3 TXXX frames. Extract before we even run analysis.

- Add dep: `mutagen>=1.47` (pure-python, MIT, ~100 KB).
- New [backend/modules/library/tags.py](backend/modules/library/tags.py):
  ```python
  def extract_embedded_tags(path: Path) -> dict:
      """Returns flattened dict of all embedded tags. Handles:
       - ID3v2 (MP3): TIT2/TPE1/TBPM/TXXX:'prompt'/COMM
       - Vorbis (FLAC/OGG): all comments
       - MP4 (M4A): iTunes atoms, including '----:com.apple.iTunes:prompt'
       - WAV: INFO chunks via mutagen.wave"""
  ```
- Recognized AI-generation tag keys (looked up case-insensitively): `prompt`, `negative_prompt`, `model`, `seed`, `cfg`, `steps`, `generator`, `tool`, `udio_*`, `suno_*`, `riffusion_*`.
- `LibraryStore.import_blob()` calls `extract_embedded_tags()` immediately on import (synchronous, fast — ~1ms). Fills `prompt`, `model`, `seed` etc. if user didn't supply them. Raw dict goes into `analysis.embedded_tags_json`.

---

## Phase 4 — Auto-analysis pipeline (toggle, persisted)

### 4.1 Backend `backend/modules/analysis/`
- `module.json`, `router.py`, plus:
  - `engine.py` — orchestrates analysis steps.
  - `ffprobe.py` — wraps `ffprobe -of json -show_format -show_streams` to extract sample rate, bit depth, channels, codec, duration.
  - `tempo.py` — reuses [backend/modules/chimera/detect.py](backend/modules/chimera/detect.py) (`detect_tempo_and_beats`). No duplication.
  - `key.py` — librosa-based key detection: `librosa.feature.chroma_cqt` → Krumhansl-Schmuckler profile correlation → 24 keys (major/minor). ~50 lines, no extra deps (librosa is already in pyproject).
  - `pitch.py` — `librosa.pyin` for monophonic content; mean / std / contour histogram bins. Cheap.
  - `bars.py` — derives bar count from detected beats + time signature assumption (default 4/4). Bars = `len(beats) / 4`. Approximate, fine for first pass.
  - `genre.py` — optional, controlled by `settings.analysis.include_genre`. Uses `transformers` (already in pyproject) with a small audio-genre HF model (e.g., `mtg-jamendo-genre`). Lazy-loaded, cached. **VRAM-aware: skips on RTX 3060 6GB unless GPU is fully idle.**
- All write results into the `analysis` table AND back into `metadata.json` (for portability).

### 4.2 Trigger points
- **On import** — `LibraryStore.import_blob()` enqueues an analysis job if `settings.analysis.auto_on_import`.
- **On generate** — after `_save_generation_artifacts_sync` (server.py:1075-1099) enqueues if `settings.analysis.auto_on_generate`.
- Jobs run via `background_workers.py` from Phase 0.3 (gated on idle).
- Per-entry `analysis_status` cycle: `pending` → `running` → `complete` | `failed`. Surface in LibraryView entry chip.

### 4.3 Manual override
- Right-click → "Re-run analysis" (always runs, regardless of toggle / idle gate).
- Chimera detect.py becomes a thin wrapper: `if analysis_complete(entry_id): return cached; else: run_inline`.

---

## Phase 5 — Auto-stemming via integration-package sidecar

### 5.1 Sidecar lifecycle
- New module `backend/modules/stems/`.
- `module.json`: `enabled: false` by default (matches Settings modal toggle UX). `description: "Audio source separation via Demucs + LARSNET"`.
- `router.py` does NOT include the demucs code directly. Instead:
  - On `app.startup`: if module enabled, spawn `python <integration-package>/backend/run_backend.py` as a subprocess. The launcher writes its port to `backend_port.txt` — we read that.
  - `httpx.AsyncClient` proxy: `POST /api/stems/upload` → forwards multipart to sidecar, returns the sidecar's task_id with our prefix.
  - WebSocket `/ws/stems/{task_id}` proxies the sidecar's progress stream.
  - Health check loop every 30s. If sidecar dies, mark module degraded, surface in Settings modal.
- `LARSNET checkpoints` — required for 12-stem mode. Surface a one-time "Download LARSNET weights (35 MB)" button in Settings → Stems. Pulls from a HF repo URL (user-configurable). Until downloaded, only 2/4/6-stem modes are available.

### 5.2 Stems → library wiring
- After sidecar finishes, our proxy worker copies stems from the sidecar's `results/tasks/{task_id}/*.wav` into the entry's directory: `data/generations/{entry_id}/stems/{vocals,drums,bass,other,...}.wav`.
- Each stem becomes a row in the `stems` table (Phase 0.2 schema). The parent entry's `metadata.json` grows a `stems: [...]` array.
- A `relations` row is inserted: `(entry_id, stem_id, kind='stem_of')`.
- Stems are NOT separate library entries by default. They appear under their parent in the new "Stems" sub-tab (Phase 8). The "Track Bundle" download (Phase 8) zips them up.

### 5.3 Trigger points
- Same as analysis: `settings.stems.auto_on_import` / `auto_on_generate`. Gated on idle.
- Right-click → "Separate stems…" (manual trigger, opens stem-count picker 2/4/6/12).

### 5.4 VRAM/CPU safety on user's RTX 3060 6GB
- Stems sidecar accepts `?device=cpu` — when GPU is busy generating, send that flag.
- `IdleManager.gpu_pressure()` returns `high` → stems queue waits.
- Per-CLAUDE.md user-hardware memory: medium model OOMs; we never want stems competing with a generate job.

---

## Phase 6 — MIDI conversion (basic-pitch + piano-transcription-inference)

### 6.1 Engine wiring
- Add deps to pyproject:
  - `basic-pitch>=0.4` (Spotify, Apache-2.0, CPU-friendly ~25 MB model).
  - `piano-transcription-inference>=0.0.4` (Bytedance, MIT, ~100 MB checkpoint).
- New module `backend/modules/midi/`:
  - `engine.py` — `convert_to_midi(audio_path, output_path, hint: Literal['auto','piano','generic'])`.
    - `hint='piano'` → piano-transcription-inference.
    - `hint='generic'` or `'auto'` → basic-pitch.
  - `router.py` — `POST /api/midi/convert`, `GET /api/midi/{id}`.

### 6.2 Stem-aware routing
- When converting an entry's stems to MIDI (per `settings.midi.from_stems`):
  - `piano.wav` → piano-transcription-inference
  - `vocals.wav`, `bass.wav`, `drums.wav`, `other.wav` → basic-pitch
- Output: `data/generations/{entry_id}/midi/{full|vocals|piano|...}.mid`
- Each MIDI = a row in the `midis` table + a `relations` edge `(stem_id, midi_id, kind='midi_of')`.

### 6.3 Trigger
- `settings.midi.auto_on_import` / `auto_on_generate` / `from_stems`.
- Manual: right-click → "Convert to MIDI" (full track) or "Convert stem to MIDI" (per stem).

---

## Phase 7 — Library sub-tabs + bundle download

### 7.1 Sub-tabs inside LibraryView
- New row of tabs above the entry list: **Tracks** | **Stems** | **MIDI**.
- `tracks` (default) — exactly today's behavior, but reads from SQLite.
- `stems` — flat list of all stems across all parents. Group header per parent track. Click a stem to preview / send-to-editor.
- `midi` — flat list of all `.mid` files. Click → preview in lower-panel piano roll, drag → drops as a MIDI track on the timeline.

### 7.2 Right-click → Download Track Bundle
- New `POST /api/library/{id}/bundle` endpoint. Server-side zip stream:
  ```
  bundle-{title}-{id}.zip
  ├── track.wav                  (or .mp3 / original)
  ├── metadata.json              (full LibraryRecord)
  ├── analysis.json              (the analysis row dumped)
  ├── lineage.json               (relations table slice — parents/children/derivations)
  ├── prompts.txt                (positive + negative + embedded prompts)
  ├── stems/
  │   ├── vocals.wav
  │   ├── drums.wav
  │   ├── ...
  ├── midi/
  │   ├── full.mid
  │   ├── piano.mid
  │   └── ...
  └── README.txt                 (human-readable summary)
  ```
- Right-click menu already has a "Download" item ([LibraryView.tsx:138-147](frontend/src/views/LibraryView.tsx)) — add a "Download Bundle" item next to it.
- Surface a per-entry "Bundle Ready ✓ / Partial / —" indicator based on which artifacts exist.

---

## Phase 8 — Lineage / knowledge-graph / LoRA pre-labeling

### 8.1 Populate `relations` everywhere
- Generate from chimera sources → `(chimera_source_id, child_id, kind='chimera_source_of')`.
- Generate with init/inpaint → `(init_id, child_id, kind='init_for' | 'inpaint_for')`.
- Stems → `(parent_id, stem_id, kind='stem_of')`.
- MIDI → `(audio_id, midi_id, kind='midi_of')`.
- User manual link (right-click → "Mark as derived from…") → `kind='derived_from'`.
- LoRA training inclusion → `kind='used_in_lora'` (when training pipeline pulls dataset).

### 8.2 Lineage view
- New right-click action: "Show lineage" → opens a modal with a graphviz-style tree (parents above, children below). Pure SVG render in React, no dep. Click any node to navigate.
- Backend: `GET /api/library/{id}/lineage?depth=3` — BFS over `relations`, returns a `{nodes, edges}` payload.

### 8.3 LoRA dataset pre-labeling export
- `scripts/export_lora_dataset.py` — selects entries by filter (e.g., `WHERE analysis.genre = 'ambient' AND duration > 30`), writes:
  - `dataset/train/{id}.wav` (symlink to audio_path)
  - `dataset/train/{id}.txt` (caption = prompt + tags + key + bpm + genre, formatted per Stable Audio's caption convention)
  - `dataset/metadata.csv` (full row dump)
- Run-mode toggle in [TrainingView.tsx](frontend/src/views/TrainingView.tsx) lets the user select filters interactively and preview the dataset before export.

### 8.4 Knowledge-graph foundation (future-portable)
- Schema is already graph-shaped (edge table). Future migration path:
  ```
  scripts/export_graph.py  --to kuzudb    -> data/library.kuzu/
  scripts/export_graph.py  --to oxigraph  -> data/library.ttl
  ```
- Not built in this plan, but the SQLite schema is designed to make these scripts ~30 lines each.
- Documented in `docs/notes/2026-05-25-lineage-graph-design.md` (new doc to write during implementation).

---

## Critical files reference

**To create:**
- [backend/modules/settings/{module.json,router.py,store.py}](backend/modules/settings/)
- [backend/modules/analysis/{module.json,router.py,engine.py,ffprobe.py,key.py,pitch.py,bars.py,genre.py}](backend/modules/analysis/)
- [backend/modules/stems/{module.json,router.py,sidecar.py}](backend/modules/stems/)
- [backend/modules/midi/{module.json,router.py,engine.py}](backend/modules/midi/)
- [backend/modules/library/{db.py,tags.py,bundle.py}](backend/modules/library/)
- [backend/core/{idle.py,background_workers.py}](backend/core/)
- [frontend/src/state/{midiSyncStore.ts,featureToggleStore.ts}](frontend/src/state/)
- [frontend/src/lib/{midiSynth.ts,midiInput.ts}](frontend/src/lib/)
- [frontend/src/components/library/{LibrarySubTabs.tsx,LineageModal.tsx}](frontend/src/components/library/)

**To modify:**
- [frontend/src/components/layout/Shell.tsx](frontend/src/components/layout/Shell.tsx) — drop library tab, add right ResizablePanel, header toggle.
- [frontend/src/components/layout/ResizablePanel.tsx](frontend/src/components/layout/ResizablePanel.tsx) — `position="right"` + `persistKey`.
- [frontend/src/components/layout/DAWCenterPanel.tsx](frontend/src/components/layout/DAWCenterPanel.tsx) — remove sequencer workspace mode, add step-seq bottom tab.
- [frontend/src/state/appUiStore.ts](frontend/src/state/appUiStore.ts) — right panel state + persist.
- [frontend/src/state/bottomPanelStore.ts](frontend/src/state/bottomPanelStore.ts) — add `'step-seq'` tab.
- [frontend/src/state/editorStore.ts](frontend/src/state/editorStore.ts) — add `sourceKind: 'midi'`, `EditorTrack.kind`.
- [frontend/src/components/audio/PianoRoll.tsx](frontend/src/components/audio/PianoRoll.tsx) + [StepSequencer.tsx](frontend/src/components/audio/StepSequencer.tsx) — read/write via `midiSyncStore.boundTrackId` instead of local state.
- [frontend/src/views/LibraryView.tsx](frontend/src/views/LibraryView.tsx) — remove `onSwitchTab`, add sub-tabs, right-click "Download Bundle" / "Show lineage" / "Re-run analysis".
- [backend/modules/library/store.py](backend/modules/library/store.py) — read-through SQLite, embedded-tag extraction on import, enqueue analysis/stems/midi jobs per settings.
- [backend/server.py](backend/server.py) — call `idle_manager.bump_activity()` on hot endpoints; post-save hook in generation flow.
- [pyproject.toml](pyproject.toml) — add `mutagen`, `basic-pitch`, `piano-transcription-inference`. (demucs lives in the sidecar, not the main env.)

**Reuse, don't re-create:**
- `detect_tempo_and_beats` at [backend/modules/chimera/detect.py:33-86](backend/modules/chimera/detect.py#L33-L86) — the BPM/beats source of truth.
- `probe` at [backend/modules/chimera/config.py:102-122](backend/modules/chimera/config.py#L102-L122) — extend the same pattern for stems toolchain probing.
- `StorageProvider` at [frontend/src/lib/storageProvider.ts](frontend/src/lib/storageProvider.ts) — extend with `fetchStem(id, name)`, `fetchMidi(id, name)`, `fetchBundle(id)` rather than building a parallel system.
- Zustand `persist()` pattern from [bottomPanelStore.ts:14-27](frontend/src/state/bottomPanelStore.ts#L14-L27) for all new toggle stores.

---

## Suggested implementation order (least risk → biggest payoff)

1. **Phase 0.1 (settings module)** + **0.2 (SQLite DB + reindex)** + **0.3 (idle/workers)** — pure infra, no UX change. Lands first.
2. **Phase 1.1 (Library to right side)** + **1.2 (sequencer to lower panel)** — UX win, zero backend dependencies. Lands second.
3. **Phase 3 (embedded tags)** — ~150 lines, big retroactive value once toggled.
4. **Phase 4 (analysis)** — biggest LBSU (line-budget single user) lift in metadata richness. Validates the worker pool.
5. **Phase 5 (stems sidecar)** — heaviest infra. Don't start until 4 is humming.
6. **Phase 6 (MIDI)** — depends on stems for stem-MIDI, but full-track MIDI works without stems, so half can land independently.
7. **Phase 7 (sub-tabs + bundle)** — pure frontend / packaging work; reads from already-populated SQLite.
8. **Phase 2 (MIDI-clip editor track)** — heaviest frontend work. Land last so the rest is stable.
9. **Phase 8 (lineage views + LoRA export)** — capstone; reads everything that came before.

Each phase is independently shippable on its own branch. Phase 0 ships under a feature flag so subsequent phases can build against the new DB without affecting the running app.

---

## Verification

After each phase:

**Phase 0:**
- `uv run pytest tests/test_library_store.py` — existing tests pass against new SQLite read-through.
- New test: `tests/test_library_db.py` — schema migrations, reindex idempotency, edge upsert.
- `uv run python -c "from backend.core.idle import IdleManager; m = IdleManager(); print(m.is_idle())"` — sanity.

**Phase 1:**
- `npm run dev` (frontend). Manual: header chevron expands right panel; resize handle drags; reload; verify panel state restored. Step sequencer no longer appears in top toolbar; appears as bottom tab next to piano roll.

**Phase 2:**
- Manual: create a MIDI track from the lower-panel piano roll. Verify the track shows a notes-strip on the timeline. Edit a note in either view — both update. Add a second MIDI track. Verify `◀ ▶` arrows replace the single ON/OFF switch. Plug in a MIDI keyboard, verify notes flow in.

**Phase 3:**
- Import a Suno/Udio MP3 with embedded prompt. Verify `prompt` field populates without user typing it. Check `analysis.embedded_tags_json` in SQLite.

**Phase 4:**
- Toggle ON. Import a 30s WAV. Within ~30s of idle, verify `bpm`, `key`, `pitch_mean_hz`, `bars_estimated` populate in SQLite. Chimera re-detects in <50ms now (cache hit).

**Phase 5:**
- Settings → Stems → Enable + Download LARSNET. Verify sidecar starts (`backend_port.txt` appears). Toggle ON auto-stems. Import a 30s WAV. After idle, verify 4 stems in `data/generations/{id}/stems/`. Library "Stems" sub-tab lists them.

**Phase 6:**
- Toggle ON auto-midi-from-stems. Same WAV → verify `data/generations/{id}/midi/{vocals,drums,bass,other}.mid` exist. Drag a midi onto the timeline → plays via Phase 2 synth.

**Phase 7:**
- Right-click any entry → Download Bundle → unzip → README.txt + audio + analysis + lineage + stems + midi all present.

**Phase 8:**
- Right-click → Show lineage → modal shows correct parent/child tree for a Chimera-generated track. `scripts/export_lora_dataset.py --filter "genre=ambient"` produces a valid caption-paired training folder.

**Per-phase non-negotiables:**
- `uv run ruff check` and `uv run ruff format --check` clean.
- No new Pylance / IDE warnings (per [feedback_no_hidden_warnings.md](C:/Users/dtruj/.claude/projects/d--StableAudio-JoshOG-stable-audio-3/memory/feedback_no_hidden_warnings.md)).
- No regressions in existing Chimera, Studio effects, Generate flows (smoke-test manually each phase).
- No Tailwind v3 forms introduced (per [feedback_tailwind_v4_classes.md](C:/Users/dtruj/.claude/projects/d--StableAudio-JoshOG-stable-audio-3/memory/feedback_tailwind_v4_classes.md)).

---

## Known unknowns / things to confirm during execution

- LARSNET weights license — confirm distribution rights before adding the auto-download to Settings.
- HuggingFace genre model choice — there's no single great OSS genre classifier; spike 2-3 options on user's hardware and pick. May default to OFF.
- Web MIDI API works on Chrome/Edge/Opera but **not** Safari/Firefox without flags. Document fallback (UI hide the MIDI input dropdown on unsupported browsers).
- `piano-transcription-inference` model is ~100 MB — surface as a one-time download in Settings → MIDI, same pattern as LARSNET.
- `basic-pitch`'s default model is fine for first pass, but consider their `ICASSP 2022` checkpoint variant for noisier inputs.
- "Downtime" definition may need tuning — start with 30s of no user HTTP activity; if user feedback says "stop running stuff when I'm in the middle of something," lengthen the gate or add a global pause-all switch in the header.

