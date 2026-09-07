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
- **Session journals do not live here.** "Implemented, awaiting verification"
  notes go straight to CHANGELOG under an *Unverified* heading, and the queue
  item stays ticked-off-pending until it is observed. (The 2026-08-26 → 08-28
  journals grew to 75% of this file and hid the queue; see "Revision notes".)
- **Every item carries a `file:line`.** An item without evidence cannot be picked
  up cold, which defeats the point of the list.
- **Effort** is XS (<2h), S (half day), M (1–3 days), L (1–2 weeks), XL (multi-week).
- **Status tags**: none = still open as written · `[partial]` = some of the
  claim landed, the rest is described · `[verify]` = code changed since the
  audit and probably fixes it; one live check retires it.
- If an item already has a permanent BACKLOG id, reference the id rather than
  restating it here.

Sources: the EDIT-tab audit, the Ableton `.als` import audit, and the tab sweep
(2026-08-26), re-checked against `main` on 2026-09-06.

---

## Revision notes (2026-09-06)

Re-check of all 75 open boxes against the code as of `bb43620`.

| Outcome | Count |
| --- | --- |
| Done, merged — remove and log in CHANGELOG | 22 |
| Probably done — one live check retires it (`[verify]`) | 5 |
| Partly landed (`[partial]`) | 6 |
| Still open as written | 42 |

Of the 42 still open, 9 were confirmed by direct code evidence this pass; the
rest were left untouched by every commit since the audit. Evidence `file:line`s
were refreshed where they had drifted. Nine days of shipped work (2026-08-29 →
09-05) appear nowhere in this file or in CHANGELOG; they are listed at the end.

---

## NOW — LOOM, shards and the beat clock (started 2026-09-06)

Design: [design/loom.md](design/loom.md). The user's brief: tear tracks apart
with the analysis we have, reassemble them beatmatched / syncopated /
harmonized, store the parts so pairings can be found, use them as quantized
samples in every performance surface, make granular bleed a one-gesture move,
and start live-coding with a Jacquard variation.

### Phase 0 — coded 2026-09-06, tsc + ruff + tests green, NOT yet seen in the running app

Everything below passes `tsc --noEmit`, `ruff check` / `format --check`,
`pytest tests/test_shards.py` (8) and `npm run test:loom`. None of it has been
driven in the live app yet; items stay here until that happens.

- [ ] **Shard Index (backend).** `backend/modules/shards/` + DB migration v6
  (`shards`, `shard_pairings`). One-bar / 2-bar / 4-bar shards per stem (or the
  mix), 1-beat sub-shards for percussive roles, one STFT per source for rms /
  low_frac / centroid / chroma / mfcc / 16-slot onset mask / energy percentile,
  chord + lyric joins, Camelot code. Routes: `GET /api/shards/{entry}`,
  `POST /{entry}/run`, `POST /query` (ranked), `POST /pairings` (complements),
  `POST /keep`, `GET /{shard}/audio?bpm=&semitones=` (crop, conform, cache).
  `pipeline.ensure_shards` waits for stems in flight and runs analysis first
  when missing; stems landing re-cuts a sharded entry; `shards.auto_on_import`
  / `auto_on_generate` default ON. — verify: import a song, watch
  `/api/shards/{id}` fill; run stems, watch it re-cut per stem. —
  `backend/modules/shards/{extract,service,router}.py`,
  `backend/core/pipeline.py`, `backend/modules/library/db.py`
- [ ] **Beat Clock.** One bpm / beatsPerBar / anchor on the shared
  AudioContext; `nextGrid('16th'|'beat'|'bar'|…)`, phase-preserving `setBpm`.
  Nothing else has been re-pointed at it yet (PERFORM's `nextLaunchTime`, DJ
  SYNC, NodeF.I. Live Out are Phase 1). — `frontend/src/lib/beatClock.ts`
- [ ] **Shard Engine.** Lanes (`input → lowpass → pan → gain → [Signalsmith] →
  bus → master`), buffer LRU keyed by (shard, bpm, semitones), 24-voice pool
  with quietest-steal / quieter-is-dropped, `releaseLane` seams. Tempo conform
  and per-shard key transposition happen server-side in the audio route;
  the lane-level `transpose` lock uses the Signalsmith worklet. Granular
  (Metamorph) seams inside the engine are Phase 2 — today a `bleed` lock is an
  equal-power overlap. — `frontend/src/lib/shardEngine.ts`,
  `frontend/src/lib/stretchWorklet.ts`
- [ ] **LOOM tab.** Registered (`loom` in `CENTER_TABS`, tab bar, HOME card,
  centre panel, assistant navigate enum + aliases weave/shards/jacquard).
  The plane: lanes with per-lane step length and length, stacks (last row =
  rail), chance and cycle gates, absolute/relative locks with cross-lane
  scope, jumps into `@target` lanes that return home, master-lane wrap applies
  a queued score. Notation parser + serializer are two-way; CODE pane applies
  on Ctrl+Enter; TILE pane edits the selected cell; CRATE pane puts songs on
  deck, shows sharding status, browses one-bar shards with audition + pin.
  Lock params live today: gain, pan, transpose, bleed, cutoff, resonance, gate,
  attack, release, roll; stretch/drive/crush/delay/reverb parse but are
  flagged "not yet live". — `frontend/src/views/LoomView.tsx`,
  `frontend/src/state/loomStore.ts`, `frontend/src/lib/{loomEngine,loomScore,loomKey}.ts`,
  `frontend/src/state/shardIndexStore.ts`
- [ ] **EDIT: granular bleed from the clip menu.** With two clips selected,
  right-click → "Bleed into this clip" (other clip = donor, this = host) or
  "Bleed the seam" when they overlap (only the overlap is rendered, placed as
  a seam clip on a new track); "Bleed live…" arms the same pair in Metamorph
  and opens the panel. — verify: two overlapping clips → seam clip appears at
  the overlap. — `frontend/src/components/audio/WaveformEditor.tsx`
  (`bleedClips`, `bleedPartnerFor`)
- [ ] **Ableton device-FX mappings route into PERFORM's live chains.**
  `autoRoutePerformFromProject` now emits `fx` CcMods for `target_kind ==
  'device'` (DryWet / On / macros / cutoff …) using a DAW→rack parameter-name
  translation (`translateDawParam`: per-effect aliases, generic aliases, label
  match, macro → wet/dry) and flattened→chain index conversion; imported
  devices also instantiate with their SOURCE parameter values instead of rack
  defaults (`translateDawParams`, with the reverb ms→s conversion). Closes the
  "108 of 110 mappings do nothing" and "parameter names never translated"
  items in the stated form. — verify: load the DNB Sway set, turn a DryWet
  knob, hear the chain. — `frontend/src/lib/dawEffectMap.ts`,
  `frontend/src/state/performRouting.ts`
- [ ] **Theme picker** previews without a scrim; twelve duotone themes added
  (`Duotone`, `Light Duotone` groups). Last v3 Tailwind form (`z-[300]`)
  removed; a tree-wide sweep found no others. — verify on Porcelain + Navy &
  Gold. — `frontend/src/components/menu/ThemeModal.tsx`, `frontend/src/lib/editThemes.ts`

### 2026-09-06 evening — from the user's full-suite pass (coded, green, awaiting a live check)

- [ ] **Magenta engine OOM'd while loading (RESOURCE_EXHAUSTED at 96 MiB).**
  Root cause: the JAX load ran while a Demucs separation held the GPU. Both
  engine bring-up paths (`/engine/start` and the on-demand start inside
  `/generate`) now take the pipeline's single GPU lane, so the load waits for
  stems / whisper / MIDI to finish and holds the card until the engine is
  ready. `/engine/status` reports `starting` with "waiting for the GPU" while
  queued, and an `error` state now carries `error_kind` (`gpu_oom`,
  `checkpoint_missing`, …) plus a one-sentence `fix`, which the Restart card
  shows instead of the raw JAX traceback. — verify: start stems, then Magenta;
  the engine should wait, then load. — `backend/modules/magenta/router.py`,
  `frontend/src/lib/magentaEngineClient.ts`
- [ ] **Stems separation surfaced as an ASGI traceback (`httpx.ReadError`).**
  The sidecar's connection dropped mid-poll (GPU contention with the Magenta
  load). Status polls now retry six times with backoff and reconnect, and the
  route turns any remaining failure into a 503 with a sentence that names the
  likely cause. — `backend/modules/stems/sidecar.py`, `backend/modules/stems/router.py`
- [ ] **LOOM plane redesigned to Jacquard's uniform squares.** Every tile is
  the same `size-11` square across every lane; lane headers sit in a fixed
  left column so step columns align; a step ruler; glyph + sub-line per tile
  (`k`/`?`/`!`/`=`/`→`), held cells show the span; live column ring; lap
  counter and master badge per lane. — `frontend/src/views/LoomView.tsx`
- [ ] **LOOM contrast on light themes.** The audit (the user's
  `_audit_contrast.mjs`) found 58/94 text failures on Porcelain: the view used
  a hard-coded dark surface under theme-remapped ink. Rebuilt on theme tokens
  (`et-ink*`, remapped `bg-black/*`, `border-white/*`); tile fills get denser
  light-theme variants (`[[data-et-light]_&]:`). Re-audit: 0 text failures on
  Midnight/Navy & Gold, 3 on Porcelain/Cocoa & Sand (fixed after the run).
  Elsewhere the audit found MAKE/EDIT/MIX/Settings clean on all six themes
  tried; LEARN has 4 light-theme failures (labels over the dark graph canvas)
  and DJ has 2 (a 7 px "BPM" tag) — see below.
- [ ] **Four sample LOOM scores** in the CODE pane's *sample* picker
  (`frontend/src/data/loomTemplates.ts`): *Just Give Up — skeleton* and *Et Tu
  Machina — pulse* (one song each; the second is a 16-against-12 polyrhythm),
  *The Elements × Thank Jeb — weave* (two songs sharing 143.5 BPM / E minor;
  cycle gates trade leads, locks duck the bass, a chance-gated fill branch) and
  *Nature's Tomb → Glass Wings — arc* (an eight-lap energy arc with lyric-search
  vocal words pulled into C minor and a two-bar break lane). Loading a sample
  puts its songs in the crate and cuts them on first use. Every sample is
  parse-tested in `npm run test:loom`. Query literals now accept quoted values
  (`entry="glass wings normal"`), and song references match titles with any
  separator.
- [ ] **LEARN light-theme labels**: the "drag to pan · wheel to zoom" hint and
  the 0/1/2 depth labels are theme-ink over the always-dark graph canvas. — XS
- [ ] **DJ "BPM" 7 px tag** inherits an accent colour at 3.6:1. — XS

### Phase 1 — next

- [ ] DJ sampler pads: *shard mode* (pad = query, `launch(query, {at:'beat'})`
  on the master deck's clock) and pad actions in the MIDI map. — M
- [ ] PERFORM: `shard:` clip slots that re-resolve per launch;
  `nextLaunchTime` delegates to the Beat Clock (beat / half / 16th grids, phase
  that survives a stop). — M
- [ ] NodeF.I.: `shard` live node with a `roll` input; Live Out BPM binds to
  the Beat Clock; Live Out joins the master bus (it connects to
  `ctx.destination` today, `nodefiLive.ts:347`). — M
- [ ] Weave → EDIT: print a LOOM lap onto tracks as clips. — S
- [ ] Sway dims → LOOM lane locks through the `fx` CcMod path; pads punch
  momentary shard tiles. — M

### Phase 2

- [ ] Granular seam inside the Shard Engine (Metamorph worklet fed the running
  voice + the incoming shard) so the `bleed` lock is a real identity bleed. — M
- [ ] Pairing intelligence in the UI: a kept stack posts `/keep`; complements
  surface in the CRATE pane; server-side conform cache warm-up. — M
- [ ] Assistant `loom_set_score` / `loom_query` / `loom_keep` tools. — S
- [ ] `.loom` inside `.tasmo`. — S
- [ ] `backend/modules/analyzer` imports a package that does not exist
  (`edit_tools_backend`), so `/api/edit/analyzer/*` 500s. Not on LOOM's path;
  fix or retire. — S — `backend/modules/analyzer/descriptors.py:25`

---

## P0 — breaks the app's primary action

- [ ] **ABORT is client-side only.** No cancel route exists; the job finishes on the GPU, writes artifacts to the library, and holds `_generation_job_lock` so the next CREATE queues behind it. — M — `backend/server.py:105,1351`, `frontend/src/state/generateStore.ts:759`
- [ ] `[verify]` **Footer CREATE silently runs local SA3 when Suno/Lyria is selected**, then labels the result with the cloud model's name. The footer button moved into `PlayerFooter` and `generateStore` grew a model-resolution preflight ("No usable model is configured…"); whether a cloud selection now routes to the cloud path is unverified. — S — `frontend/src/state/generateStore.ts:463-511`, `frontend/src/components/audio/PlayerFooter.tsx`

## P1 — user-visible defects

### Feedback that never reaches the user

> The single most common failure in this codebase: a message is produced and never rendered.

- [ ] **DJ: 16 status messages are produced and never rendered.** The old status var became `flash`; there are 16 `setFlash(...)` writers and an effect that clears it, but no JSX reads it. Bad file drop, "create a set first", BPM out of range, sync/eject confirmations still read as buttons that do nothing. — XS — `frontend/src/views/DJView.tsx:562,709`
- [ ] **MIX: PROCESS CHAIN fails with zero visible feedback** — no toast, no log. No error path found in `MixView` this pass. — S — `frontend/src/views/MixView.tsx`
- [ ] **VJ: failure path is a 40-second silent retry then a bare message**; `MAX_LOAD_RETRIES = 20`, `detail` is set and never rendered. SwayView does this correctly. — XS — `frontend/src/views/VJView.tsx:60,285,329`

### Dead controls and dead state

- [ ] `[verify]` **DJ: MIDI "Ignore" buttons.** The store is now consumed by the MIDI-map panel; whether the live MIDI input handler actually filters ignored controls is unverified. — XS — `frontend/src/views/DJView.tsx:2398`
- [ ] **DJ: `DeckRack` (~180 lines) is defined and never rendered.** Downgraded to cleanup: a stem-separation Abort now exists outside it (`abortStems`), so the only user-facing consequence is gone. Delete the component. — XS — `frontend/src/views/DJView.tsx:1290,1471` (abort: `:1521,1624`)
- [ ] **DJ: automix never beatmatches** — the `setInterval` captures a stale `syncDeck` closure. The prepared-sets work (`#140`) touched the loader in this interval but not the closure. — S — `frontend/src/views/DJView.tsx:728,985,1012`
- [ ] **DJ: sampler per-pad gain / loop / choke are dead state** — `setPadOpts` has no caller. — S — `frontend/src/state/djSamplerStore.ts:23`
- [ ] **MAKE: the `DL` auto-download toggle has no consumer** — persisted, mirrored to the assistant, rendered twice, downloads nothing. — XS — `frontend/src/views/AdvancedGenPanel.tsx:1182,1203`, `frontend/src/state/generateParamsStore.ts:236`
- [ ] **`thedaw:set-left-panel` has three dispatchers and no listener.** This is also the root cause of LEARN's "Open lineage rooted here" / "Open in Library" no-ops (they dispatch this event), and the assistant reports success anyway. Fix once in `Shell`/library-rail state. — XS — `frontend/src/orb-kit/actionHandlers.ts:157,161`, `frontend/src/components/library/LineageModal.tsx:3320-3356`
- [ ] **Assistant quick-commands advertise features that do not exist** ("Trending", "Full Sync", "discovery radio"). Emojis were removed in the de-icon sweep; the labels stayed. — XS — `frontend/src/orb-kit/AssistantPanel.tsx:65-77`
- [ ] **TRAIN button + `trainingStore` front a hard 501.** `ProcessingLog` reads `isTraining` and calls `triggerTraining`, which POSTs to `train_lora_stub`; 6 of 9 store actions have no caller. Either hide TRAIN until LoRA training exists (see P2) or point it at the Underfit sidecar. — S — `frontend/src/state/trainingStore.ts:105`, `frontend/src/components/layout/ProcessingLog.tsx:362,428`, `backend/server.py:2273`

### Wrong output

- [ ] **MIX: the rack is applied twice to the processed output you audition.** Unverified since the audit. — S — `frontend/src/views/MixView.tsx`
- [ ] `[verify]` **MIX: "Send to Edit".** Now fetches the output blob, loads it into `playerStore`, and switches to EDIT; whether EDIT's mount picks that buffer up as a clip is unverified. — XS — `frontend/src/views/MixView.tsx:1357`, `frontend/src/components/audio/WaveformEditor.tsx:82`
- [ ] **Library: bulk "Download → MIDI" always 404s** — still builds `/api/midi/file/${entry.id}` from the library-entry id; the per-row path correctly uses the midi row id. — S — `frontend/src/views/LibraryView.tsx:1322` (correct form: `:1969`)
- [ ] **LEARN: the Track tab fetches a 4-hop lineage and renders 1 hop.** Unverified since the audit. — M — `frontend/src/components/library/LineageModal.tsx`
- [ ] **MAKE: the seed actually used is never captured** — `seed: int = Form(-1)`, filenames emit `seed_-1`, metadata records `-1`. — M — `backend/server.py:488,1581,2027`
- [ ] `[verify]` **DJ: transport pads live during decode.** A `pendingPlayRef` now defers PLAY until `hasBuffer && !decoding`; confirm the first press lands. — XS — `frontend/src/views/DJView.tsx:654`
- [ ] **MAKE: `RF-Inv` is an exposed option that guarantees a 501.** Downgraded: the 501 now carries a plain-language explanation. Decision needed — hide the option, or implement RF-Inversion. — S (hide) / L (implement) — `backend/server.py:418`, `frontend/src/components/ui/tooltips.ts:30`

### Sway / VJ

- [ ] **The Sway DAW-control mirror arbitrates nothing** — one pad fires theDAW's synth AND the cockpit; auto-enabled for exactly this hardware. Code moved since the audit; behaviour unverified. — S — `frontend/src/App.tsx:295,349`, `frontend/src/components/sway/SwayLinkPanel.tsx:343`
- [ ] **While VJ is popped out every inbound message is discarded** — `isFromVj` accepts only the in-tab iframe's `contentWindow`, never `poppedWindowRef`. Confirmed. — S — `frontend/src/views/VJView.tsx:224,215`
- [ ] `[verify]` **SWAY "Input device".** SwayView now tells the cockpit to open its own input device in that mode; confirm visuals follow the mic rather than the internal groove. — XS — `frontend/src/views/SwayView.tsx:231,339`

## P1 — Ableton import (remaining)

- [ ] `[partial]` **MIDI notes are not rebased onto the loop window, looped regions never expanded.** `LoopStart` is now read and applied as the source offset; region expansion (8 bars over a 1-bar loop) is still not done. — M — `backend/modules/dawimport/ableton.py:589-624`
- [ ] **`<Disabled>` clips are unread** — a deactivated clip will sound. No reference in the parser. — XS — `backend/modules/dawimport/ableton.py`
- [ ] **Group tracks are dropped with no warning**; only device-rack groups are handled. — S (warning) / M (support) — `backend/modules/dawimport/ableton.py:110-131`
- [ ] **Sends / returns**: `send_amounts` exists only on the model — zero producers, zero consumers. Every imported mix is dry. — L (needs a bus model) — `backend/modules/project/tasmo_project.py:104`
- [ ] `[partial]` **Nested device parameters.** Rack containers are now flattened into first-class chain entries; VST/AU params and the 12-param cap are unverified. — S — `backend/modules/dawimport/ableton.py:135,876,921,943`
- [ ] `[verify]` **Device parameter names are never translated** — `translateDawParams` now re-keys Ableton names onto rack keys (per-effect and generic aliases, ms→s for reverb decay, clamped to the descriptor). Verify an imported Compressor lands at its source Threshold/Ratio. — `frontend/src/lib/dawEffectMap.ts`
- [ ] **Live Library / Pack sample refs are unresolvable** — `RelativePathType`, `SearchHint`, CRC all unread. — M
- [ ] **`media_status` on `DawClip`** — not present; `resolve_audio` still returns one shape for hit and miss. — M — `backend/modules/dawimport/media.py`
- [ ] **Automation envelopes and tempo map** — zero grep hits. Tempo automation is the dangerous subset. — XL
- [ ] **No `.als` fixture in the test suite** — coverage is still `assert callable(parse_als)`. — M — `tests/test_vst_daw_tasmo.py:153-156`

## P1 — EDIT (remaining)

- [ ] **`.tasmo` still drops automation lanes, master FX and master VST chains** — `tasmoToSession` hardcodes `locators: []`; nothing writes automation on save. — M — `frontend/src/lib/tasmoToSession.ts:94`
- [ ] `[partial]` **Export is one hardcoded 16-bit WAV.** The delivery backend is now reachable as EDIT *tools* (codec matrix, smart export, SRC, dither, metadata, batch) but the Export button still calls `encodeWav`, and `renderRange()` is still inside `commitEdit` — the prerequisite for stem export and region-regenerate. — M — `frontend/src/components/audio/WaveformEditor.tsx:2099,2306`, `frontend/src/components/audio/effects/editToolStack.ts:64`
- [ ] **Live MIDI reverb/chorus still bypasses the track chain** — output 0 is a shared effects bus. — M
- [ ] **Automation lanes can only be born by riding a control with WRITE armed**; no curve shapes, no hold. — M
- [ ] `[partial]` **No per-track metering or master fader in EDIT.** LEVELS now has a full master meter bridge (dBFS, LUFS, true peak, correlation — 2026-09-02); per-track meters and an EDIT master fader are still absent. — M — `frontend/src/components/audio/levels/LevelsPanel.tsx`

## P2 — larger builds

- [ ] **Tempo map and time-signature model.** BPM + tap tempo shipped; no time-signature or tempo-map field on `editorStore`. — M–L — `frontend/src/state/editorStore.ts`
- [ ] **Buses**: sends, returns, groups, sidechain. `liveMixer` hard-codes every track's destination. — XL
- [ ] **Recording at the playhead**: `armed` exists on the track type; no punch, takes, or armed-target recording. — XL — `frontend/src/state/editorStore.ts:125,257`
- [ ] **Marquee / time-range selection and ripple edit.** — L
- [ ] **LoRA training endpoints are hard 501 stubs behind a live TRAIN button**; real training only exists in the vendored Underfit sidecar. Pairs with the TRAIN item above. — M — `backend/server.py:2273`
- [ ] **Underfit's upstream updater is fully implemented in the backend with zero frontend callers.** — S — `backend/modules/underfit/router.py:72,78`

## P2 — frontier (uniquely enabled by the resident model)

- [ ] **Generative extend / continue** — `CAUSAL_MASK` is a trained mask type and the server accepts `inpaint_audio` + bounds; no frontend caller. — M
- [ ] **Clip variation ladder (SDEdit re-roll with a strength dial)** — `init_noise_level` is sent by MAKE only; EDIT sends neither. — M — `frontend/src/state/generateStore.ts:337`
- [ ] **SAME latent workspace** — `/api/autoencoder/encode`, `/decode`, `/api/jobs/pre-encode` remain 501 stubs. — L — `backend/server.py:2280-2296`
- [ ] **Non-destructive generative lineage** — `Clip.generation_prompt` / `generation_seed` / `generation_params` are still never written. — M

## P1 — added 2026-08-26 (second session), still open

(The Perform device-FX routing and theme-picker scrim items moved to the NOW
section above — coded 2026-09-06, awaiting a live check.)

## P2 — added 2026-08-26 (second session), still open

- [ ] **Boot: sequence the emergence** — no commits to either file since 2026-08-27. — S — `frontend/src/components/layout/LiquidChromeTitle.tsx:200`, `frontend/src/components/layout/LoadingScreen.tsx:78`

## Deliberately not doing

Recorded so they are not re-proposed:

- Full plugin delay compensation — no lookahead processor exists in the rack; VST3 cannot run live.
- MIDI clock / Ableton Link / MTC — no hardware-sync workflow in the app; Link has no browser implementation.
- Take lanes / comping — needs non-uniform per-track heights, which `editorStore` documents as a deliberate deferral.
- Real-time multiplayer CRDT editing — gated on the asset layer, and EDIT unmounts on tab switch.
- Neural restoration marketed as such — SA3 is not a super-resolution model.
- A bespoke export/encode DSP layer — `/api/edit/delivery` and `/api/convert/file` already do this properly.
- **Sway `sway/visibility`** (retired 2026-09-06) — the staged bundle handles it and `SwayView` pushes it; the original claim was stale.

---

## Removed this revision — to be logged in CHANGELOG (approval needed)

All merged to `main` between 2026-08-31 and 2026-09-05 (`facb78a`, `57f7863`,
`10310f1`, `62990e8`, `3ada4c3`, `39ac5e6`).

P0: footer button keyed on the real tab (`activeView` cluster) · `navigate('train')` no longer bricks CREATE · assistant approval stack live (T2 tools park as `pendingAction`).
P1 feedback: MAKE empty-prompt error rendered (`AdvancedGenPanel.tsx:455`) · Magenta setup gate rebuilt, dict `detail` unwrapped (`drawEngine.ts:675`) · Underfit 503 detail rendered · Settings PATCH rolls back + notice.
P1 dead controls: "Send to DJ" `pendingStart` consumed (`DJView.tsx:933`) · assistant `navigateTo` reaches all 12 workspaces · Media bucket "Send to INIT" → `make`.
P1 wrong output: NodeF.I. Effect node 400 · NodeF.I. wires deletable · Underfit port from `diag.port`.
Ableton: `performRouting` hydrated on both load paths (ccMods included).
P2: OPFS autosave + crash recovery · stems-on-a-clip → tracks · agentic `editor_*` vocabulary (12 tools).
Second session: NodeF.I. cursor offset · NodeF.I. node-editor toolset · lower-panel toggles (superseded by the footer action button) · `.swayproj` import · Sway deck factory map (`DECK_FACTORY`).

## Session journals to relocate (approval needed)

Lines 153–619 of the old file — the twelve "implemented, awaiting verification"
/ "verified live" blocks from 2026-08-26 through 2026-08-28 — belong in
CHANGELOG under their dates. Everything in them has since been merged; the
CHANGELOG currently ends at 2026-08-27.

## Landed since 2026-08-28 and recorded nowhere

Neither this file nor CHANGELOG mentions any of it. Each line is a CHANGELOG entry.

- 2026-08-31 — DJ prepared performance sets: timeline automix + assistant control (`019f7e9`, PR #140).
- 2026-09-02 — One-screen Settings, six-state Magenta engine gate, Lyria install, one-click Magenta install, HF token field (`3ada4c3`, `97c5731`).
- 2026-09-02 — LEVELS meter bridge (`ef9c1d7`); a real control panel for every effect, rack entry and tool, BACKLOG FX-001 closed (`3a72507`); collapsible MIX viz rack (`d20d5a0`).
- 2026-09-02 — Onboarding: Chimera DNA splice fixed, one-screen HOME, guided TOUR (`7926228`); showcase capture attach mode (`a2e7a7a`).
- 2026-09-03 — GPU telemetry reports every device (`398ba59`).
- 2026-09-04 — Chimera v2 phrase engine + seam healing (`299fcf4`); SCORE play-along modes, percussion notation, drum transcription, chord track, Beat Saber export (`fae1180`); flash-attention capability gate for Turing GPUs (`f73dd17`); width/height-aware shell scale + Tour rewrite (`660f0bf`); v0.1.4 (`715dddd`).
- 2026-09-05 — SING tab with whisper alignment, stems-first vocals, language picker (`b9a2b94`, `00db96a`); SCORE NOW/INK/TRAIL prefs, kept-alive views (`cb9429b`, `eb14d8f`); one pipeline coordinator for stems/MIDI/lyrics (`7e5beb3`); README how-to rewrite (`ada5431`, `4e58894`); SING guide + DJ prepared sets docs (`bb43620`).
