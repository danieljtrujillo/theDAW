# In The Works

The running list of what we are going to do. Read this before starting work.

Distinct from [BACKLOG.md](BACKLOG.md): the backlog is the long-lived,
id-stable inventory of everything known to be wrong. **This** file is the active
queue — the things we have decided to do next, in order, with enough evidence
attached to start immediately.

## How to use this doc

- **Items leave only when done.** "Done" means the user said so, or it was
  verified — build, tests, or observed behaviour. Editing a file is not done.
- **On removal, add a line to [CHANGELOG.md](CHANGELOG.md).** Nothing is deleted
  silently.
- **Every item carries a `file:line`.** An item without evidence cannot be picked
  up cold, which defeats the point of the list.
- **Effort** is XS (<2h), S (half day), M (1–3 days), L (1–2 weeks), XL (multi-week).
- New findings get appended to the right section as they are discovered.
- If an item already has a permanent BACKLOG id, reference the id rather than
  restating it here.

Sources: the EDIT-tab audit, the Ableton `.als` import audit, and the tab sweep
(2026-08-26). Findings were adversarially verified before landing here.

---

## P0 — breaks the app's primary action

- [ ] **Footer CREATE/PROCESS/TRAIN button is driven by `activeView`, which the tab bar never writes.** Every writer sets it to `'create'`, so on EDIT the footer button fires a text-to-audio generation instead of processing the arrangement. The same stale field means `inEditorMode` is never true (footer PLAY never triggers the editor render path) and the assistant is always told the user is on CREATE. — M — `frontend/src/components/layout/ProcessingLog.tsx:316`, `frontend/src/components/audio/PlayerFooter.tsx:84`, `frontend/src/orb-kit/appContext.ts:58`
- [ ] **One assistant `navigate("train")` permanently bricks CREATE.** Sets `activeView='train'`; nothing resets it, so the footer stays a red TRAIN button on every tab for the session — and TRAIN posts to a hard 501. — S — `frontend/src/components/layout/ProcessingLog.tsx:316`, `frontend/src/state/appUiStore.ts:39`
- [ ] **The assistant's entire confirmation/approval stack is dead code.** `pendingAction` is read and cleared but never assigned; `orb-kit/tool-tiers.ts` and `state/assistantBridgeStore.ts` have zero importers. Every tool call — including `generate` (spends GPU) and `abort` (kills a job) — executes ungated. — M — `frontend/src/orb-kit/AssistantPanel.tsx:1011`
- [ ] **ABORT is client-side only.** No cancel route exists; the job finishes on the GPU, writes artifacts to the library, and holds `_generation_job_lock` so the next CREATE queues behind it. — M — `frontend/src/state/generateStore.ts:807`
- [ ] **Footer CREATE silently runs local SA3 when Suno/Lyria is selected**, then labels the SA3 result with the cloud model's name. — S — `frontend/src/components/layout/ProcessingLog.tsx:370`

## P1 — user-visible defects

### Feedback that never reaches the user

> The single most common failure in this codebase: a message is produced and never rendered.

- [ ] **DJ: 15 distinct status/error messages are produced and never rendered** — bad file drop, "create a set first", BPM out of range, sync/eject confirmations. All read as buttons that do nothing. — XS — `frontend/src/views/DJView.tsx:561`
- [ ] **MIX: PROCESS CHAIN fails with zero visible feedback** — no toast, no log, nothing. — S
- [ ] **MAKE: empty-prompt CREATE is a silent no-op** — the `error` field is rendered by no component. — XS — `frontend/src/state/generateStore.ts:457`
- [ ] **MAKE: Magenta's actionable setup message is swallowed into "HTTP 412"** — `detail` is a dict, the unwrapper only handles strings. — XS — `backend/modules/magenta/router.py:265`
- [ ] **Underfit: "Start Underfit" discards the backend's precise 503 diagnosis**; the same panel returns forever. — XS — `frontend/src/views/UnderfitView.tsx:102`
- [ ] **VJ: failure path is a 40-second silent retry then a bare message**; the backend's reason is discarded and the `detail` state is never rendered. SwayView does this correctly. — XS — `frontend/src/views/VJView.tsx:296`
- [ ] **Settings: a failed PATCH is swallowed** — toggles appear saved and silently revert. — S — `frontend/src/state/featureToggleStore.ts:177`

### Dead controls and dead state

- [ ] **DJ: MIDI "Ignore" buttons persist to localStorage and are never consulted.** — XS — `frontend/src/state/midiIgnoreStore.ts:99`
- [ ] **DJ: `DeckRack` (~180 lines) is defined and never rendered** — including the only Abort button, so a running stem separation cannot be cancelled. — M — `frontend/src/views/DJView.tsx:1414`
- [ ] **DJ: "Send to DJ" automix handoff has no consumer**; `pendingStart` is write-only. — S — `frontend/src/state/djAutomixStore.ts:52`
- [ ] **DJ: automix never beatmatches** — the `setInterval` captures a stale `syncDeck` closure. — S — `frontend/src/views/DJView.tsx:987`
- [ ] **DJ: sampler per-pad gain / loop / choke are dead state** — `setPadOpts` has no caller. — S — `frontend/src/state/djSamplerStore.ts:23`
- [ ] **MAKE: the `DL` auto-download toggle has no consumer** — nothing is ever downloaded. — XS — `frontend/src/views/AdvancedGenPanel.tsx:1077`
- [ ] **Underfit: `trainingStore` is dead state** — no writer for the payload, no callers for 6 of 9 actions (~250 lines). — M — `frontend/src/state/trainingStore.ts:105`
- [ ] **`thedaw:set-left-panel` has three dispatchers and no listener**; the assistant reports success anyway. — XS — `frontend/src/orb-kit/actionHandlers.ts:108`
- [ ] **Assistant navigate reaches only 3 of 12 workspaces** — the backend tool enum still lists retired legacy view names; unknown tabs no-op while the handler returns "Navigated to X". — S — `backend/assistant_routes.py:1400`
- [ ] **Assistant quick-commands advertise features that do not exist** ("Trending", "Full Sync", "discovery radio") — leftovers from a different product. — XS — `frontend/src/orb-kit/AssistantPanel.tsx:65`
- [ ] **Media bucket "Send to INIT" navigates to a view that does not exist** (`'generate'`). — XS — `frontend/src/components/layout/MediaBucketView.tsx:111`

### Wrong output

- [ ] **MIX: the rack is applied twice to the processed output you audition.** — S
- [ ] **MIX: "Send to Edit" sends nothing.** — S
- [ ] **Library: bulk "Download → MIDI" always 404s** (wrong id space — the route wants a midis-row id). — S — `frontend/src/views/LibraryView.tsx:1322`
- [ ] **Audimate: the Effect node 400s on first run** — displayed params are never stored, and the default node cannot be fixed without switching effect away and back. — S — `frontend/src/lib/audimateTypes.ts:148`
- [ ] **Audimate: wires can never be deleted** — `removeEdge` has no caller and the edge layer is `pointer-events-none`. — S — `frontend/src/state/audimateStore.ts:133`
- [ ] **LEARN: node menu "Open lineage rooted here" / "Open in Library" silently no-op** whenever the library rail is closed (the default on a fresh install). — S — `frontend/src/components/library/LineageModal.tsx:3365`
- [ ] **LEARN: the Track tab fetches a 4-hop lineage and renders 1 hop.** — M — `frontend/src/components/library/LineageModal.tsx:762`
- [ ] **MAKE: the seed actually used is never captured** — default-seed takes are unreproducible, filenames emit `seed_-1`, metadata records `-1`. — M — `backend/server.py:1620`
- [ ] **DJ: transport pads are live during decode**, so the first PLAY press silently does nothing. — S — `frontend/src/views/DJView.tsx:343`
- [ ] **MAKE: `RF-Inv` is an exposed option that guarantees a 501.** — S — `backend/server.py:390`
- [ ] **Underfit: the port is hardcoded to `8791`** while the live port is fetched and displayed right above the Start button. — XS — `frontend/src/views/UnderfitView.tsx:20`

### Sway / VJ

- [ ] **The Sway DAW-control toggle arbitrates nothing** — one pad fires theDAW's synth AND the cockpit; auto-enabled by default for exactly this hardware. — S — `frontend/src/views/SwayView.tsx:195`
- [ ] **While VJ is popped out (the headline live mode) every inbound message is discarded** — the SET chip spins forever, export errors vanish. — S — `frontend/src/views/VJView.tsx:224`
- [ ] **The staged SwayCommand build ignores `sway/visibility`** — the host posts it, the child never reads it, so a hidden cockpit keeps rendering WebGL. — M — `frontend/src/views/SwayView.tsx:184`
- [ ] **SWAY "Input device" does not open an input device** — visuals react to the cockpit's internal 120 BPM groove. — M — `frontend/src/views/SwayView.tsx:204`

## P1 — Ableton import (remaining)

- [ ] **MIDI notes are not rebased onto the loop window**, and looped regions are never expanded — notes land outside the clip; an 8-bar region over a 1-bar loop yields 1 bar and 7 of silence. — M — `backend/modules/dawimport/ableton.py:552,670`
- [ ] **`<Disabled>` clips are unread** — a deactivated clip will sound. — XS
- [ ] **Group tracks are dropped with no warning**; children surface as unrelated top-level tracks. — S (warning) / M (support) — `backend/modules/dawimport/ableton.py:42`
- [ ] **Sends / returns**: return tracks import with nothing feeding them; every imported mix is dry. `send_amounts` has zero producers and zero consumers. — L (needs a bus model)
- [ ] **Nested device parameters are invisible** — direct children only, capped at 12, so an Eq8's whole curve is lost; VST/AU params hardcoded `{}`. — M — `backend/modules/dawimport/ableton.py:935`
- [ ] **Device parameter names are never translated** — Ableton emits `Threshold`, the rack expects `threshold`, so mapped effects instantiate at rack defaults. — M — `frontend/src/lib/dawEffectMap.ts:70`
- [ ] **Live Library / Pack sample refs are unresolvable** — `RelativePathType`, `SearchHint`, CRC all unread. — M
- [ ] **`media_status` on `DawClip`** — `resolve_audio` returns the same shape for a hit and a miss, so no caller can distinguish resolved / relinked / missing. — M — `backend/modules/dawimport/media.py:102`
- [ ] **`performRouting` leaks between projects** — globally persisted, keyed by bare track index, `hydrate` only called on the `.tasmo` path. — S — `frontend/src/state/performRouting.ts:96`
- [ ] **Automation envelopes and tempo map** — zero grep hits. Tempo automation is the dangerous subset: it makes every clip, locator and note progressively wrong down the timeline. — XL
- [ ] **No `.als` fixture in the test suite** — coverage is `assert callable(parse_als)`. Commit the synthetic-set builders used during the audit. — M — `tests/test_vst_daw_tasmo.py:152`

## P1 — EDIT (remaining)

- [ ] **`.tasmo` still drops automation lanes, master FX and master VST chains** — the backend model already validates automation and locators; nothing writes them. — M
- [ ] **Export is one hardcoded 16-bit WAV.** `/api/edit/delivery` is a complete loudness/dither/SRC/6-codec backend with zero frontend callers. Blocked on extracting `renderRange()` out of `commitEdit`, which is also the prerequisite for stem export and region-regenerate. — M
- [ ] **Live MIDI reverb/chorus still bypasses the track chain** — dry signal routes correctly; output 0 is a shared effects bus. — M
- [ ] **Automation lanes can only be born by riding a control with WRITE armed**; no curve shapes, no hold. — M
- [ ] **No per-track metering or master fader in EDIT.** — M

## P2 — larger builds

- [ ] **Autosave and crash recovery** via a content-addressed OPFS asset layer. Clip audio is in-memory Blobs; a refresh destroys the arrangement. The dirty flag + `beforeunload` + Ctrl+S guard is in place as interim insurance. — L
- [ ] **Tempo map and time-signature model.** BPM + tap tempo shipped; a bars/beats ruler is M, a real tempo map is L. — M–L
- [ ] **Buses**: sends, returns, groups, sidechain. `liveMixer` hard-codes every track's destination and there is no seam. — XL
- [ ] **Recording at the playhead**: armed-track targeting, punch, takes. Gated on the transport fix (already landed). — XL
- [ ] **Marquee / time-range selection and ripple edit.** — L
- [ ] **LoRA training endpoints are hard 501 stubs behind a live TRAIN button**; real training only exists in the vendored Underfit sidecar. — M — `backend/server.py:1945`
- [ ] **Underfit's upstream updater is fully implemented in the backend with zero frontend callers.** — S — `backend/modules/underfit/router.py:72`

## P2 — frontier (uniquely enabled by the resident model)

- [ ] **Generative extend / continue** — drag a clip's edge past its source and the model writes the continuation. Needs no backend change: `CAUSAL_MASK` is already a trained mask type and the server accepts `inpaint_audio` plus bounds. — M
- [ ] **Clip variation ladder (SDEdit re-roll with a strength dial)** — `init_audio` + `init_noise_level` are already on the wire; EDIT sends neither. — M
- [ ] **Stem separation on a timeline clip → explode to tracks** — the Demucs sidecar exists, keyed only on library entries. — M
- [ ] **SAME latent workspace** — `/api/autoencoder/encode`, `/decode` and `/api/jobs/pre-encode` are 501 stubs. — L
- [ ] **Non-destructive generative lineage** — record `{parent, prompt, mask, seed, model, LoRA, strength}` per clip. The schema already waits: `Clip.generation_prompt` / `generation_seed` / `generation_params` are unwritten. — M
- [ ] **Agentic assistant with a real `editor.*` tool vocabulary** — three of four layers exist; the model is architecturally blind because `buildtheDAWAppContext` never reports a track, clip, playhead or selection. Gated on the P0 approval-stack and navigate items. — L

## Deliberately not doing

Recorded so they are not re-proposed:

- Full plugin delay compensation — no lookahead processor exists in the rack; VST3 cannot run live.
- MIDI clock / Ableton Link / MTC — no hardware-sync workflow in the app; Link has no browser implementation.
- Take lanes / comping — needs non-uniform per-track heights, which `editorStore` documents as a deliberate deferral.
- Real-time multiplayer CRDT editing — gated on the asset layer, and EDIT unmounts on tab switch.
- Neural restoration marketed as such — SA3 is not a super-resolution model; it hallucinates rather than restores.
- A bespoke export/encode DSP layer — `/api/edit/delivery` and `/api/convert/file` already do this properly.

## Added 2026-08-26 (second session)

### P1

- [ ] **Perform: 108 of the DNB set's 110 Sway mappings do nothing in PERFORM.** Auto-routing only lifts mixer/volume-named mappings into the mix; the device-FX mappings (DryWet/On/macros) resolve to the editor, not the Perform grid's live chains. Route `target_kind==='device'` mappings onto the grid chains via CcMod `fx` (plumbing exists — the deck already creates fx CcMods by hand). — M — `frontend/src/state/performRouting.ts:243`, `frontend/src/components/session/DawSessionGrid.tsx:713`
- [ ] **Audimate canvas cursor offset — node ends don't match the pointer.** `screenToWorld` ignores the shell's CSS `zoom` (the same class of bug the EDIT audit fixed with `effectiveZoom`). — S — `frontend/src/views/AudimateView.tsx:234`
- [ ] **Theme picker: selection happens under the dark overlay, so theme colors can't be judged; several themes have unreadable popups.** Drop the scrim while the picker is open, then contrast-audit every theme's overlays/popups. — M — `frontend/src/components/menu/ThemeModal.tsx:1`, `frontend/src/lib/editThemes.ts:1`

### P2

- [ ] **Boot: sequence the emergence** — still sheet → vibration ramps in → ONE cymatic pattern forms → the wordmark plops forward; today the waves run continuously while it rises. Also verify the GANTASMO logo no longer clips at reveal, and kill the orb's window/mask look outside the corner. — S — `frontend/src/components/layout/LiquidChromeTitle.tsx:200`, `frontend/src/components/layout/LoadingScreen.tsx:78`
- [ ] **Audimate: standard node-editor/synth tools** (multi-select, box-select, duplicate, delete key, undo, zoom-to-fit, param inspector). — L — `frontend/src/views/AudimateView.tsx:1`
- [ ] **Lower-panel toggles should read as part of the footer, with the panel emerging from those buttons.** — M — `frontend/src/components/audio/PlayerFooter.tsx:217`
- [ ] **`.swayproj` import** (binary format, D:\sway examples; strings confirm the six dims + grid modes). — M — `backend/modules/library/router.py:1`
- [ ] **Sway deck buttons have no factory CC/note map** (SwayCommand doesn't define one) — learn-only today; capture a hardware monitor session and pin them. — XS — `frontend/src/components/session/swaydeck/deckState.ts:13`

## Status 2026-08-26 (third session) — implemented, awaiting verification

Everything below is CODED and passes `tsc --noEmit`, `ruff check`, `ruff format --check`
and a backend import smoke, but has NOT been verified by observed behaviour in the
running app. Items stay in their sections above until that verification happens.

- **P0 `activeView` cluster** — tab bar now syncs `activeView`; footer action button
  and PLAY are keyed on `centerTab` (EDIT→PROCESS, UNDERFIT→TRAIN, else CREATE);
  `navigate('train')` can no longer brick CREATE. New `appUiStore.navigateTo()`
  reaches all 12 workspaces + library, returns false (reported to the model) on
  unknown targets. — `frontend/src/state/appUiStore.ts`,
  `frontend/src/components/layout/ProcessingLog.tsx`,
  `frontend/src/components/audio/PlayerFooter.tsx`, `frontend/src/orb-kit/actionHandlers.ts`,
  `backend/assistant_routes.py` (navigate enum + prompt)
- **P0 approval stack** — wired live: T2 tools (generate/abort/destructive editor ops/
  unknown) park as `pendingAction` and render the existing confirmation card; inline
  `<action>` blocks are now allowlist-validated and tier-gated too (and executed
  outside the setMessages updater — StrictMode-safe). — `frontend/src/orb-kit/AssistantPanel.tsx`,
  `tool-tiers.ts` (real backend names + editor tiers), `assistantEvents.ts`
- **Agentic editor vocabulary** — 12 `editor_*` tools (get_state/add_track/remove_track/
  set_track/move_clip/remove_clip/split_clip/select_clip/set_playhead/set_bpm/set_loop/
  add_marker) defined backend-side, allowlisted, tiered, and implemented against
  editorStore with honest error strings; app context now reports the REAL tab plus a
  bounded arrangement summary (tracks/clips/playhead/selection/loop/bpm). —
  `backend/assistant_routes.py`, `frontend/src/orb-kit/{actionHandlers,appContext,assistantEvents,tool-tiers}.ts`
- **Media bucket "Send to INIT"** — navigates to `make` (was the nonexistent 'generate').
- **Autosave/crash recovery** — content-addressed OPFS asset layer
  (`assets/<sha256>.bin`, one write per unique Blob — split/duplicate clips share),
  debounced manifest of tracks/clips/FX/automation/markers/bpm/loop, recovery offer
  at startup (saving stays paused until answered), restore rebuilds blobs + peaks and
  lands on EDIT. — `frontend/src/lib/editorAutosave.ts`,
  `frontend/src/components/layout/AutosaveRecoveryNotice.tsx`, `Shell.tsx`
- **Audimate node-editor tools** — multi-select (ctrl-click), shift-drag marquee,
  multi-drag, Ctrl+D duplicate (edge-remapping), Delete, Ctrl+Z/Y undo-redo (history
  middleware), Ctrl+A, Esc, F/zoom-to-fit + toolbar buttons, clickable/selectable
  wires (fat hit paths; double-click or Del removes), node + wire context menus,
  key-scope arbitration. Also fixed here: the cursor-offset bug (`effectiveZoom` in
  screenToWorld/pan/wheel/spawn), wires-undeletable, and the Effect-node 400 (params
  seeded at addNode + persist migrate v2 + runner merges defaults). —
  `frontend/src/views/AudimateView.tsx`, `frontend/src/state/audimateStore.ts`,
  `frontend/src/lib/audimateRunner.ts`, `frontend/src/components/audimate/AudimateInspector.tsx`
- **Lower-panel toggles read as part of the footer** — strip restyled in the footer's
  language (tinted blur + hairline border), the anonymous flex-1 slab is now a
  labelled PANELS toggle showing the active tab, and both dock bodies emerge from
  their buttons (`dock-emerge` keyframes). — `frontend/src/components/layout/Shell.tsx`,
  `BottomMultiTabPanel.tsx`, `frontend/src/index.css`
- **`.swayproj` import** — binary parser (magic FF 02; presets 231+79·N bytes; zones
  with rect/CC-slots/notes; 6-slot CC array — the 7th byte is NOT a CC) verified
  against all four D:\sway projects (36 presets each; PULSE=35/SWAY=37 corroborate the
  factory swaymap). Wired end-to-end: detect + `POST /api/dawimport/sway`, file
  filters, PERFORM auto-seeding of dims via preset names, honest "0 tracks" status. —
  `backend/modules/dawimport/swayproj.py`, `router.py`,
  `frontend/src/lib/{dawImportClient,fileFilters}.ts`, `frontend/src/state/dawImportStore.ts`,
  `frontend/src/views/SessionView.tsx`
- **Stem separation on a timeline clip → explode to tracks** — clip context menu
  "Separate Stems → Tracks…" (StemsRunModal for count/device/quality), clip blob
  bridges to the entry-keyed Demucs API via `importEntry` (id written back to the
  clip so re-runs hit the cache), `ensureStems` progress banner with Abort, one new
  colour-coded track per stem placed exactly at the source clip's position/trim, and
  the source clip muted (reversible). — `frontend/src/components/audio/WaveformEditor.tsx`
- **XR BUS tester moved** (user request, this session) — no longer floats over the
  footer's Download/More buttons; it is a dev-only "XR Bus" tab in the bottom dock
  next to MIDI/SLIDE/SWAY, laid out as a multi-column panel; prod builds hide the tab
  and remap a persisted selection. — `frontend/src/components/dev/XrBusTester.tsx`,
  `BottomMultiTabPanel.tsx`, `frontend/src/state/bottomPanelStore.ts`, `App.tsx`
- **EDIT FX/ARES panels + plugin windows** (user request, this session) — Master
  FX/VST/Metamorph column, Ares popup and automation panel are portaled to
  document.body (one coordinate space with the track-FX popover; no more zoom
  clipping), Ares cascades above the VST popup instead of stacking on it; the `.gan`
  EXPAND now pops the plugin into its OWN window (DetachableWindow; ares bridge +
  level meter keep working via message forwarding and a frame accessor); the VST
  expanded overlay is body-portaled at z-100 so Collapse/Close can't be buried, and
  its native-window geometry now multiplies local px by `effectiveZoom` (MIX sizing
  was off by the zoom factor); the ARES "weird text scaling" root cause is fixed in
  the runtime generator — element iframes are zoomed by rendered/native canvas width
  (repackages automatically on next open). — `frontend/src/components/audio/
  {GanPluginStage,VstEmbedHost,WaveformEditor}.tsx`, `frontend/src/views/MixView.tsx`,
  `backend/modules/plugin/owl_import.py`

Still untouched from the P0 list: ABORT is client-side only; footer CREATE silently
runs local SA3 when Suno/Lyria is selected.

### Batch 2 (same day) — implemented, awaiting verification

- **Unified effect control windows (user mandate: effects/VST/.gan are ONE thing).**
  New `frontend/src/components/audio/EffectWindows.tsx`: one draggable floating
  window per chain entry (keyed by entry id — reopening focuses, never
  duplicates), hosting exactly what MIX renders (VstEmbedHost / GanPluginStage /
  the shared param tiles). `FxChainList` replaces EDIT's FxRack-popover + separate
  VST insert list + Master VST panel: ONE FX button per track and ONE master FX
  button open a compact chain list (FX/VST/GAN rows identical), click a row →
  its control window. The bespoke centered VST popup, the Ares popup, the
  aresPanel state and the MASTER FX / VST toolbar-button pair are deleted; the
  Ares bridge ownership moved into the window host; Live/Frozen moved into the
  unified master panel. — `WaveformEditor.tsx` (toolbar, master panel, track
  popover, helpers), `EffectWindows.tsx`
- **SWAY tab: track add / save / playback made real.**
  Root causes from the staged-bundle teardown: the cockpit booted onto the
  SYSTEM splash with no project loaded (`addTrack`/`play` are silent no-ops on a
  null timeline), and template audio 403'd from `/api/project/clip-audio`
  (absolute paths outside media roots; decode errors swallowed into an
  unrendered warnings array). Fixes: SwayView boots the iframe with
  `?autoplay=` — the most recent cockpit-saved project (`swayproject:/` recents
  from shared localStorage), else the `will-i-dream` template — which loads a
  project AND skips the splash; the sway backend registers every staged
  template's (and saved project's) media paths with media_access before handing
  out the iframe URL; `will-i-dream` is reordered FIRST in `templates/index.json`
  (fetch script re-applies on every restage). Saving is now durable: a new
  count-verified BUNDLE_PATCH mirrors the cockpit's `project.write` to the new
  `POST /api/sway/project-save` (writes `data/sway-projects/*.sway`, allowlists
  its media); `GET /api/sway/projects` lists them. Both patches applied to the
  currently staged bundle. — `frontend/src/views/SwayView.tsx`,
  `backend/modules/sway/router.py`, `electron-ui/scripts/fetch-sway-build.mjs`,
  staged `sway-dist/embed.bundle.js` + `templates/index.json`
- Note from the bundle teardown: the staged build DOES handle `sway/visibility`
  (the P1 item above claiming it is ignored appears stale — verify and retire).

### Batch 3 (same day) — implemented, awaiting verification

- **Sway performance template + the plumbing it exposed.** New
  `scripts/make_sway_template.py` authors
  `C:\Users\Cyboman\Documents\theDAW Projects\Sway Live Template - Madman x Machina.tasmo`
  (8 stem columns from Madman Returns + Et Tu Machina, 44 looping clips, 16
  scenes on the 16 pads incl. cross-song CLASH rows, knobs CC20-27 = column
  volumes, gestures pulse/strike/sway/press on drums/bass/vox/mute, XY pad =
  resonant low-pass sweep + dub-delay bloom on every column: X amount
  20 kHz→160 Hz, Y tone resonance→scream + feedback→self-oscillation; transport
  on notes 40-43 + CC19). Round-trip verified through TasmoFile.load. Three
  gaps fixed so it actually works: `perform_routing.ccMods` now persist +
  hydrate (`performRouting.ts`, with `ccModsHydrated` so SessionView's
  auto-router can't wipe a loaded set's routes), `.tasmo` tracks now hand their
  `effect_chain` to PERFORM as live devices (`tasmoToSession.ts` — fx routes
  finally have something to hit), and clip loop/trim fields survive the
  round-trip so launches SUSTAIN. Deck fx/knob assignments now save with the
  project too (they were session-only). Deck buttons still have no factory
  hardware map (existing XS item) — transport is authored on learnable codes.
- **Notation follow is note-by-note (karaoke) instead of page-by-page.** Sheet:
  the strip now GLIDES continuously with the OSMD cursor (zoom-aware
  centering; page snap retired to keyboard/footer nav) and the notehead(s)
  under the cursor are painted emerald via GNotesUnderCursor →
  getSVGGElement (`ScoreView.tsx`, `keepCursorVisible`/`applyNoteHighlight`).
  Tabs: alphaTab now runs in external-media player mode with beat cursor +
  element highlighting driven per-frame by the same latency-compensated clock,
  with its own Follow toggle (`TabPreview`); feature-detected so an older
  bundle degrades to a static tab. Backend: `guitar_tab.py` now emits RESTS
  for silence, clips overlapping durations to the next onset, and always
  writes `\tempo 120` — the tab tick timeline finally equals audio wall-clock
  (existing alphatex artifacts predate this; re-run tabs to regenerate).
- **EDIT toolbar decluttered.** MAGENTA + METAMORPH collapsed into one TOOLS ▾
  dropdown (shared ContextMenu anchored under the button); WRITE/AUTO/LOOP/MARK
  are now an icon-only group styled like the tool/undo clusters; FX and TOOLS
  are the only labeled buttons left (`WaveformEditor.tsx` toolbar).

### 2026-08-27 — per-song Sway Perform templates (user request)

- **Three per-song Sway Perform templates** authored to
  `C:\Users\Cyboman\Documents\theDAW Projects\Sway Perform - {Prologue,EACC,Just Give Up}.tasmo`
  by the new `scripts/make_sway_song_templates.py` (same rig as the Madman x
  Machina template, one song per file): 6 stem columns from each song's
  htdemucs_6s split, 45 looping clips, 16 scenes on the pads, knobs CC20-25 =
  column volumes + CC26/27 = delay time/tone across all columns, gestures
  pulse/strike/sway/press, XY pad = filter sweep + dub-delay bloom, transport
  on notes 40-43 + CC19. Real analyzed tempos baked in (134.75 / 129.49 /
  147.55 BPM) with the delay defaulting to a dotted eighth. All three
  round-trip verified through `TasmoFile.load`. "Prelude" turned out to be
  `01 - Prologue.wav` (library `8e02e54d…`), same album as `04 - eacc.wav`
  (`19e25941…`) and `14 - Just Give Up.wav` (`b59f7029…`).
- **Stems sidecar venv was dead on this machine** — its `pyvenv.cfg` pointed at
  a base Python under a stale user profile (`C:\Users\dtruj\…`), so every
  separation 503'd. Re-pointed `home` to the installed
  `cpython-3.10.21` (packages were intact); 6-stem separations for Prologue and
  Just Give Up then ran clean through `POST /api/stems/{id}/run?stems=6`. —
  `integration-package/backend/.sidecar_venv/pyvenv.cfg`

### 2026-08-27 (second pass) — pad punches, Kargyraa Sub, full-device templates (user request; coded, tsc+ruff clean, NOT yet verified in the running app)

- **PERFORM pads can now punch FX (notes were a dead routing path).** The grid's
  MIDI handler accepted only CC ccMods and dropped note-offs entirely; note-driven
  ccMods now fire — momentary (note-on -> max, note-off -> min) or `latch: true`
  (toggle on press), with latch state cleared when a mod disappears and a
  note-off guard so learn can't bind a phantom release. New optional `latch`
  field on `CcMod`. — `frontend/src/components/session/DawSessionGrid.tsx`,
  `frontend/src/state/performRouting.ts`
- **Chain param pushes no longer reset sibling params to catalog defaults.**
  `buildEffectChain` instances keep full sticky param state (seeded from the
  authored entry params); `updateParams` merges into it. Previously any
  single-key push (one XY axis, a pad punch) silently reverted every other
  param of that device to defaults — authored delay times, gater rates etc.
  All other callers push full param objects, so behavior is unchanged for
  them. — `frontend/src/lib/rackEffects.ts` (buildEffectChain)
- **New `kargyraa` builtin rack effect ("Kargyraa Sub", Low end group).**
  Subharmonic throat-growl bass modeled on the actual kargyraa mechanism:
  octave-divider worklet (Schmitt flip-flop -> f/2 + f/4, envelope-followed;
  new `frontend/public/subharmonic.worklet.js`), period-doubling AM growl gate
  (rate ≈ half the fundamental), morphing 3-band vowel formant bank with an
  LFO wobble, high-Q sygyt whistle band (0.8–2.4 kHz), drive, wet/dry.
  Degrades to graph-only (silent sub path) if the worklet module is absent.
  PERFORM now preloads chop/granular/subharmonic worklets on the engine ctx
  (Ares grains were silently passthrough in PERFORM before this). —
  `frontend/src/lib/rackEffects.ts`, `DawSessionGrid.tsx`
- **.tasmo VST nodes no longer mangle in PERFORM.** `tasmoToSession` hardcoded
  `plugin_path: null`, so a vst3 node fell into the builtin name-match ("…Verb"
  -> rack reverb at defaults). It now carries `vst_state.plugin_path`; vst3
  nodes classify as plugins and stay cleanly inert in the live grid, exactly
  like EDIT. — `frontend/src/lib/tasmoToSession.ts`
- **SwayDeck pads show punch labels** (scene name first, else the note-driven
  route's label). — `frontend/src/components/session/SwayDeck.tsx`
- **Per-song templates regenerated with the new layout** (pads 0-7 = 8 scenes,
  pads 8-15 = punches: KARGYRAA latch / THROAT VOX / GATER / CRUSH / ROBOT /
  THROW / FREEZE latch / SLAM; XY also morphs kargyraa vowel + growl + whistle
  on bass/vox). Every device kind rides along: builtins live in PERFORM, Ares
  (.gan surface in EDIT/MIX) on Vox, TAL-Vocoder-2 vst3 with full vst_state on
  Vox. 6 tracks · 26 clips · 29 devices · 8 scene pads · 29 punch routes · 47
  knob/XY routes per song; round-trip verified incl. latch flags + vst_state.
  — `scripts/make_sway_song_templates.py`, `C:\Users\Cyboman\Documents\theDAW
  Projects\Sway Perform - {Prologue,EACC,Just Give Up}.tasmo`
