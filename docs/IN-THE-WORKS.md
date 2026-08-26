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
