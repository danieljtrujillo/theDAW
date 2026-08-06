# theDAW Backlog

Last updated: 2026-08-06. Regenerate by re-running the full-repo audit sweep (ten parallel area
agents over notation, audio/DSP, integrations, backend core, views, components, state/lib,
build/tooling) and merging the results into this file by id. Never renumber on regeneration.

## How to use this doc

- Tick the checkbox to mark an item done. Leave the line in place for one release, then delete it.
- Change the P number to reprioritise. The section a line sits in is cosmetic; the P number is the truth.
- Delete a line to drop the item. Nothing regenerates a deleted id.
- Ids are permanent. `SCORE-004` means the same thing forever, is never reused, and is never renumbered.

## Summary

Counts are OPEN items (a ticked line stops counting the moment it is verified fixed). Ticked lines
stay in the doc for one release before deletion, so the tables no longer equal the number of lines
below them.

| Priority | Count | Meaning |
|---|---|---|
| P0 | 4 | Broken in the user's face, or blocking other work |
| P1 | 30 | Real defect a user will hit |
| P2 | 45 | Worth doing, not urgent |
| P3 | 21 | Cleanup |
| **Total** | **100** | |

| Area | Prefix | P0 | P1 | P2 | P3 | Total |
|---|---|---|---|---|---|---|
| Backend core and plumbing | BE | 1 | 2 | 3 | 5 | 11 |
| Exposure and file access | SEC | 1 | 1 | 2 | 0 | 4 |
| Library, analysis, storage | LIB | 0 | 3 | 3 | 1 | 7 |
| DSP and effect modules | FX | 1 | 2 | 4 | 1 | 8 |
| Notation and score | SCORE | 0 | 5 | 9 | 2 | 16 |
| Integrations and sidecars | INT | 0 | 3 | 4 | 0 | 7 |
| VST3 | VST | 0 | 1 | 2 | 0 | 3 |
| Frontend | FE | 0 | 10 | 13 | 10 | 33 |
| Packaging | PKG | 1 | 0 | 0 | 0 | 1 |
| Tests and CI | CI | 0 | 2 | 2 | 0 | 4 |
| Docs and RAG | DOC | 0 | 1 | 3 | 2 | 6 |

Verified fixed on 2026-08-06 (independently re-checked, not taken from the fixing agents' reports):
`BE-001`, `BE-002`, `SEC-002`, `FE-001`, `FE-002`, `CI-001`. Still open and NOT ticked: `BE-003`
(helper `backend/core/probe_cache.py` built and tested but never wired into the router, so the
endpoint still blocks exactly as before), `SEC-001` (browser vector closed and proven; a request
carrying no `Origin`/`Referer`/`Sec-Fetch-Site` is still forwarded with the server key, so any
non-browser LAN client still spends it in the default posture), `FX-001` (file untouched),
`PKG-001` (config is correct and resolves in a simulated packaged tree, but `frontend/scripts/`
and `unity/` are untracked in git, so a release CI checkout has neither source to stage).

## Top 10 right now

1. `BE-001` One model preload silently stops every background worker for the rest of the session.
2. `BE-003` Every CREATE press freezes the whole backend for about five seconds.
3. `CI-001` 311 pytest tests exist and no CI job runs any of them.
4. `PKG-001` The installed app has no PDF engraver and no Unity package; both work only on a dev clone.
5. `SEC-001` Any web page or LAN device can spend the user's Gemini key through the open proxy.
6. `FE-002` Returning to MIX overwrites a saved mastering chain with defaults.
7. `FX-001` Two of the three Character FX modes ignore every knob and render at defaults.
8. `FE-001` Every waveform is drawn at the wrong scale, so playheads do not mark the right spot.
9. `SEC-002` `/api/project/clip-audio` streams any audio file on the machine to anything on the LAN.
10. `BE-002` A failed generation leaks the same idle hold as BE-001, with the same consequence.

---

# P0

- [x] **BE-001** P0 S Model preload never releases its idle hold, killing all background work `backend/server.py:1188`
  - `bump_activity(tag="model-load")` has no matching `release("model-load")` anywhere in the repo.
  - Fixing it restores auto-analysis, auto-stems, auto-midi, auto-score and the notation backfill after the first preload.

- [x] **BE-002** P0 S `/api/generate-jobs` leaks the generate hold on every pre-task failure `backend/server.py:1789`
  - The tag is taken 100 lines before the task that releases it; a failed model load, a stale `local:` checkpoint, a bad upload or a LoRA write error returns an error and holds the gate forever.
  - Fixing it means one failed generation stops permanently disabling background work.

- [x] **BE-003** P0 S `/api/storage/model-status` blocks the event loop for about five seconds `backend/modules/storage/router.py:722`
  - FIXED 2026-08-06. The demucs and midi probes now run through `CachedProbe` off the loop, and all six
    providers resolve with `asyncio.gather`. Measured through the real endpoint: worst loop stall
    5.78s to 0.081s, warm call 2.34s, provider order unchanged.
  - The demucs probe shells out to the sidecar venv and imports torch (measured 4.8 s), inline in an async handler, with no cache; the generate action calls it on every CREATE press.
  - Fixing it stops library streaming, DJ polling, stems progress and the job queue from stalling on every generation and every Settings open.

- [ ] **SEC-001** P0 M genai-proxy spends the user's `GEMINI_API_KEY` for anyone who can reach port 8600 `backend/modules/genaiproxy/router.py:32`
  - Catch-all pass-through that injects the server-side key, with no auth, no path allowlist, `allow_origins=["*"]` and a `0.0.0.0` bind.
  - Fixing it stops any visited web page or LAN device from running arbitrary Google API calls on the user's account.

- [x] **SEC-002** P0 M `/api/project/clip-audio` reads any audio file on the host, unauthenticated `backend/modules/project/router.py:231`
  - Takes an absolute path, checks only the extension against a 10-format list, then streams the file; wildcard CORS plus the `0.0.0.0` bind makes it reachable from any browser tab and any LAN device.
  - Fixing it (resolve plus `is_relative_to` containment, and narrowing CORS) closes the exfiltration path that the companion-phone LAN story widens.

- [ ] **FX-001** P0 S Character FX Tube and Vinyl send knob names the backend does not have `frontend/public/edit-modules/character-fx.html:243`
  - The page sends drive/bias/warmth and crackle/rumble/filtering; `ghost_voice` and `radio_room` declare ghostiness/size and distance/muffle/room, and unknown keys are dropped silently, so both modes render at 0.5 defaults.
  - Fixing it makes 10 of the module's 15 knobs do something; the Web Audio preview already moves, so the render currently contradicts what the user hears.

- [x] **FE-001** P0 M Waveform canvases are sized in zoomed pixels, so every wave and playhead is mis-scaled `frontend/src/components/audio/DJSemanticWaveform.tsx:404`
  - `getBoundingClientRect().width` is written back as a CSS width inside the shell's `zoom` subtree, so the canvas renders at width x zoom squared; measured 289 px of wave in a 340 px lane at the 0.85 tier.
  - Fixing it puts the playhead, mask handles and scrub layer back on the audio they mark in DJ decks, MIX rows, EDIT clips and MAKE init waves.

- [x] **FE-002** P0 S MIX Quick Master overwrites a saved mastering chain with defaults `frontend/src/views/MixView.tsx:918`
  - The four knobs live in local `useState` seeded from `EFFECT_DEFAULTS`, MIX fully unmounts on tab leave, and `updateParams` replaces the param object wholesale.
  - Fixing it stops a tab round-trip plus one Sync Master click from destroying dialed-in mastering settings.

- [ ] **PKG-001** P0 M Packaged builds ship no PDF engraver and no Unity package `electron-ui/electron-builder.yml:36`
  - `extraResources` never stages `frontend/scripts`, the node modules those scripts need, or `unity/`, so in the installed app `capabilities()` drops "pdf", backend PDF export disappears, and every track bundle ships without the note-chart package the bundle README points at.
  - Fixing it means the SCORE tab and the bundle behave the same in the installed app as on a dev clone.

- [x] **CI-001** P0 S No CI job runs the pytest suite `.github/workflows/lint.yml:4`
  - The three workflows are ruff-only lint, installer release, and aubio wheels; 33 test files under `tests/` never execute in CI.
  - Fixing it means backend regressions fail a PR instead of shipping. Most other items in this doc sit in code with no automated coverage.

---

# P1

## Backend core

- [ ] **BE-004** P1 S Toggling a module in Settings permanently mojibakes its `module.json` `backend/server.py:958`
  - Both `/api/modules/all` and the enable PATCH call `read_text()` with no encoding (cp1252 on Windows) on UTF-8 files, then write the garbled text back with `json.dumps`.
  - Ten module.json files contain em-dashes and are one toggle away from corruption in the tracked repo. `backend/modules/loader.py:32` already fixed this and carries the comment explaining why.

- [ ] **BE-005** P1 M Backup import reports `done` after silently skipping every file it failed to write `backend/modules/backup/service.py:429`
  - Per-file `OSError` is logged and skipped, then state is set to `done` unconditionally; the likely real case is Windows holding `library.db` open, so the database is not restored.
  - Fixing it means a partial restore is reported as partial instead of looking like a successful one.

## Exposure

- [ ] **SEC-003** P1 S `.gan` extraction guards traversal with a string prefix check `backend/modules/plugin/gan_file.py:104`
  - `str(dest).startswith(str(out))` admits any sibling directory sharing the prefix, so an entry named `../<id>EVIL/payload` writes outside the runtime folder; the asset server at `backend/modules/plugin/router.py:272` repeats it.
  - `.gan` bundles are third-party files the app invites the user to open. `backend/server.py:952` already uses the correct `is_relative_to` form.

## Library and analysis

- [ ] **LIB-001** P1 S `upsert_entry` resets analysis/stems/midi status to `pending` on every write `backend/modules/library/db.py:362`
  - The three engine-owned columns are in the `ON CONFLICT DO UPDATE` list but never in `_sync_record_to_db`'s payload, so every reindex, PATCH and generate wipes the completion markers.
  - Live DB: 336 entries have a real analysis row and 142 have stem rows while their status says pending. Fixing it makes a "what still needs analysis" query possible, which LIB-002 needs.

- [ ] **LIB-002** P1 M No backfill path for analysis; 51 tracks can never get a BPM `backend/modules/library/store.py:946`
  - `reindex()` adopts entries that appeared outside the API but never enqueues analysis, unlike the import and generate hooks.
  - Fixing it means hand-dropped, synced and restored tracks get beat grids without the user finding the per-entry DJ path.

- [ ] **LIB-003** P1 S `loudness_lufs` is persisted, shipped and rendered but never computed `backend/modules/analysis/engine.py:143`
  - All 352 analysis rows have NULL; the comment blocking it says pyloudnorm is unavailable, but it is a declared dependency and `backend/lib/audio_analysis.measure_loudness` already does EBU-R128 for mastering.
  - The Details panel and Node inspector both draw an empty Loudness row on every track.

## DSP

- [ ] **FX-002** P1 S Three tools return HTTP 500 at legal low knob positions `backend/modules/enhance/router.py:56`
  - Un-Crush and Studio Enhance format `afftdn nr=0` (valid range starts at 0.01) and Neural Reverb formats `aecho decay=0.000` (range is exclusive of zero); all three are reachable from the knob's declared minimum.
  - Verified against the local ffmpeg. Fixing it means the bottom of three knob ranges processes instead of erroring.

- [ ] **FX-003** P1 M The EQ modules preview five bands and render three `frontend/public/edit-modules/parametric-eq.html:162`
  - Both EQ pages send bands 0, 2 and 4 and drop Low-Mid and High-Mid; the backend `_eq` is a fixed bass/bell/treble chain. The page carries a comment acknowledging the shortcut.
  - The user hears the cut in the preview and does not get it in the file.

## Notation and score

- [ ] **SCORE-001** P1 S Notation identity UI saves nothing and reports success `frontend/src/components/layout/DetailsView.tsx:156`
  - The GET endpoint it reads does not exist, and the PATCH sends two fields that are not in `USER_MUTABLE_FIELDS`, so they are dropped; the UI then logs "Notation artist/title saved."
  - Fixing it means a corrected artist actually reaches the engraved sheet instead of leaving the global name in place.

- [ ] **SCORE-002** P1 M `identity.py` is unwired; nothing outside its own tests imports it `backend/modules/notation/identity.py:214`
  - The artist/title splitter and its 30 tests exist, but every producer still calls `artist_name()` and titles with the whole raw filename, which is the exact defect the module was written to fix.
  - Fixing it means sheets, tabs, arrangements and note charts are credited correctly. Pairs with SCORE-001.

- [ ] **SCORE-003** P1 S SCORE export buttons are gated on MuseScore, hiding PDF and note chart `frontend/src/components/layout/ScoreView.tsx:136`
  - PDF is engraved headlessly by OSMD and `notechart` is a backend export format, but the button row still keys off `caps.musescore`, so a machine without MuseScore is offered only ABC.
  - The entire Unity note-chart export has no UI entry point today.

- [ ] **SCORE-004** P1 M Note charts never carry raw onsets `backend/modules/notation/exporters/notechart.py:1223`
  - Both production callers omit `raw_midi_path`, so `rawIsQuantized` is hardcoded true on every chart written.
  - The module's own docstring says judging against the 1/16 grid fails a player who is dead on the beat, which is what currently ships.

- [ ] **SCORE-005** P1 S Note chart audio block ships empty filename and mimeType `backend/modules/notation/exporters/notechart.py:1499`
  - The `audio` kwarg is never passed by either caller, so every chart carries `"filename": "", "mimeType": "", "durationSec": 0`.
  - The Unity loader resolves `AudioType.UNKNOWN`, which its own comment says fails on Android, so the headset fetches the track and cannot decode it.

## Integrations

- [ ] **INT-001** P1 M Lyria adopts any listener on 5188 and still reports "Mock" `backend/modules/lyria/sidecar.py:316`
  - `ensure_running()` returns for any open port without checking that process's cost mode, and `/url` reports mode from theDAW's own env, not the adopted child's.
  - An orphan or hand-started live-mode server bills $0.08 per generation behind a Mock badge.

- [ ] **INT-002** P1 L Lyria output never reaches the library `backend/modules/lyria/router.py:1`
  - The module is spawn-and-iframe only; generations stay in the sidecar's own library, invisible to the catalog, lineage, EDIT, stems and export. Suno does the opposite and registers finished tracks as first-class entries.
  - This is the work that unblocks the stems seam and the EDIT hand-off.

- [ ] **INT-003** P1 M Lyria holds its state lock across a 600 s npm install `backend/modules/lyria/sidecar.py:310`
  - `stop()` takes the same lock, and teardown calls it, so quitting during a first-run install waits behind the install. The panel's fetch has no client timeout, so its documented "40 s" retry budget is up to 30 minutes.
  - Fixing it means quit and restart stay responsive during Lyria's first run.

## VST3

- [ ] **VST-001** P1 M The just-rewritten host thread funnel and bundle dedup have no test `tests/test_vst_daw_tasmo.py:124`
  - 681 changed lines across `scanner.py` and `host.py`; the existing tests construct an empty dataclass and call `list_instances()` on an empty registry. No plugin is ever loaded.
  - Nothing covers `_resolve_bundle_binary`, the bundle dedup, the cache version gate, `_apply_raw_state`'s silent-rejection detection, or `on_host_thread`, which is where the shipped bug was.

## Frontend

- [ ] **FE-003** P1 M Every MIX knob move re-serializes all VST plugin state to localStorage `frontend/src/state/effectChainStore.ts:162`
  - `persist` writes on every `set()`, and the persisted chain includes each VST node's base64 `raw_state`, so a drag does a blocking `setItem` of megabytes per pointer event.
  - Past the ~5 MB origin quota the write throws and every other persisted store (layout, DJ cues, settings mirror) starts failing too.

- [ ] **FE-004** P1 S A quota failure while capturing VST state is swallowed and retried for 30 minutes `frontend/src/state/vstEditorStore.ts:194`
  - The sink writes through the persisted store; a `QuotaExceededError` lands in the poll's own catch, which just schedules another poll.
  - The user closes the plugin editor, sees "settings captured", and the dialed-in sound is gone. Pairs with FE-003.

- [ ] **FE-005** P1 S MAKE offers an init-audio Type that always fails with 501 `frontend/src/views/AdvancedGenPanel.tsx:605`
  - The RF-Inv option is not disabled and carries no warning; the backend rejects init audio combined with that type because the pipeline has no inversion path.
  - Fixing it means the user finds out before submitting a full generation.

- [ ] **FE-006** P1 S Cloud panels' model dropdown skips the RF steps/CFG presets `frontend/src/views/LyriaPanel.tsx:166`
  - The Lyria and Suno panels replace the whole MAKE surface, so their dropdown is the only route back to a local model, and it patches `model` only.
  - Picking Small-RF or Medium-RF from a cloud panel renders at steps=8 / cfg=1.0, the ARC operating point, with no signal. `SunoGenPanel.tsx:239` is identical.

- [ ] **FE-007** P1 M `clip.peaks` is decoded for every EDIT clip and read by nobody `frontend/src/components/audio/WaveformEditor.tsx:1270`
  - Nothing renders `clip.peaks`; the timeline decodes the same audio again through SemanticWave, and Chimera keeps a third cache. The effect also depends on the whole `clips` array, which is replaced on every mutation, so a clip drag cancels and restarts a full decode per frame.
  - Fixing it removes a per-frame decode during drags and one redundant decode per clip.

- [ ] **FE-008** P1 M `analyzeBuffer` runs about 610 ms of synchronous main-thread work per clip `frontend/src/components/audio/DJSemanticWaveform.tsx:103`
  - `getMonoSample` calls `getChannelData` once per sample per channel inside the innermost loop; hoisting it measured 224 ms. EDIT is not kept warm, so every tab switch back re-analyses every clip.
  - A 10-clip arrangement freezes the UI for seconds on each return to EDIT.

- [ ] **FE-009** P1 S Six large-media fetches still use `res.blob()` `frontend/src/state/studioStore.ts:147`
  - The repo documents this call as failing outright on large audio under disk pressure (verified live on a 66 MB WAV) and the fix as `arrayBuffer()` plus `new Blob`.
  - Remaining sites: `studioStore.ts:147`, `studioStore.ts:246`, `lib/onlineImport.ts:26`, `lib/projectImport.ts:211`, `lib/audimateRunner.ts:219`, `state/trainingStore.ts:347`.

- [ ] **FE-010** P1 S The MIDI ignore list is a UI control wired to nothing `frontend/src/state/midiIgnoreStore.ts:99`
  - DJView writes and persists ignore rules, but neither `isMidiSigIgnored` nor `isMidiMessageIgnored` is called anywhere.
  - One guard in `publishMidi` restores the whole feature, since every consumer already reads from that funnel.

- [ ] **FE-011** P1 S A failed waveform fetch or decode is invisible `frontend/src/components/audio/DJSemanticWaveform.tsx:391`
  - The catch sets an empty bin list with no log line and no error state; the component paints a flat 1 px line that looks exactly like silence.
  - This is the failure mode the StrictMode blob-URL bug produced, and nothing reached the LOG panel.

- [ ] **FE-012** P1 S Only the Perform tab has an error boundary `frontend/src/components/layout/DAWCenterPanel.tsx:83`
  - The other ten tabs are wrapped in Suspense alone, which catches neither render errors nor a rejected lazy import.
  - A stale chunk hash after an in-place update of a packaged build blanks the entire Shell instead of one tab.

## Tests

- [ ] **CI-002** P1 S The frontend has seven test files and no runner `frontend/package.json:9`
  - No `test` script, no vitest or jest in dependencies or `node_modules/.bin`; `lint` is `tsc --noEmit`.
  - The generate-job form contract test and the init-audio rule test encode real backend contracts and have never run.

- [ ] **CI-003** P1 M Nothing asserts that endpoints taking an idle hold release it `tests/test_idle_and_workers.py:31`
  - The suite covers IdleManager and BackgroundQueue in isolation and never imports a router. That is exactly the class of bug in BE-001 and BE-002, which shipped twice.
  - No loader tests either, for the disabled, raising or corrupt `module.json` cases the docstring promises are survivable.

## Docs

- [ ] **DOC-001** P1 S USER_GUIDE still tells users PDF requires MuseScore `docs/USER_GUIDE.md:2143`
  - PDF is engraved headlessly by OSMD; the guide also omits `notechart`, the `/reindex`, `/backfill` and `/pack` endpoints, and the SCORE follow-along cursor.
  - This doc is in the RAG index, so the in-app assistant answers from it. Doc edits are approval-based.

---

# P2

| ID | E | Item | Reference | What is wrong |
|---|---|---|---|---|
| BE-006 | S | Background job table never pruned, O(n^2) enqueue | `backend/core/background_workers.py:117` | Every enqueue scans all jobs ever created; names are per-entry unique so the scan never matches. A 500-track import makes ~2M comparisons and 2000 permanent records. |
| BE-007 | M | The whole `idle` settings section is dead config | `backend/modules/settings/store.py:68` | `min_idle_seconds` and `respect_vram_pressure` are persisted and typed and read by no backend code; a RAG-indexed doc says they govern the idle gate. |
| BE-008 | S | `/api/studio/process` reads the render synchronously on the loop | `backend/modules/effects/router.py:452` | `read_bytes()` in an async handler; `core/module_base.py:122` already does the `to_thread` form. |
| SEC-004 | S | `/api/storage/open` prefix guard is defeated by `..` | `backend/modules/storage/router.py:940` | Lowercased `startswith` against allowed roots with no `resolve()`, then `os.startfile`. |
| SEC-005 | S | sheetimport `/parse-path` reads any path with no allowlist | `backend/modules/sheetimport/router.py:68` | `SHEET_SUFFIXES` exists and is used only in the capability report, never as validation. |
| LIB-004 | S | Library list scans entries twice and pulls 1.8 MB of unused beat JSON | `backend/modules/library/router.py:206` | `_attach_play_counts` repeats the full scan; `get_all_analysis` does `SELECT *` and drags `beats_json` that `_analysis_payload` never reads. Hot path, also polled by the phone. |
| LIB-005 | S | Orphan `data/library.db` shadows the real database | `data/library.db` | 387-entry leftover from 4 July with zero analysis rows; no code path opens it. Reading it is what produced the false "analysis never ran" alarm. |
| LIB-006 | M | Three status columns are written by engines and read by nothing | `backend/modules/analysis/engine.py:204` | No API exposes them, no frontend file references them, no query filters on them. Either surface the chips or delete the writers. Depends on LIB-001. |
| FX-004 | M | Restoration ships six inert knobs; Stem Separation's 2-6 dropdown is a toggle | `backend/modules/restoration/dsp.py:22` | Denoise, Dereverb, Clicks and Prompt are never read; `stems` branches only on `== 2` and always writes one file. |
| FX-005 | M | creative_neural tool descriptions claim capabilities the code does not have | `backend/modules/creative_neural/router.py:282` | CrossFade Morph takes one input, TimbreForge is formant shifting, two Prompt fields are never read, SpectraMorph gets one scalar. The DSP is real; the manifest text is not. |
| FX-006 | M | Delivery: true-peak verify is a `print`, Batch Export is a single-file encode | `backend/modules/delivery/router.py:63` | An over-limit master returns success; `quality` and `parallelJobs` are declared and never read. |
| FX-007 | L | The analyzer module has no caller anywhere | `backend/modules/analyzer/router.py:28` | ~3,100 lines mounted and enabled by default, documented in the API reference as live, reached by nothing. Decide: build the smallest UI, or set `enabled: false`. |
| SCORE-006 | S | Unity loader expects a filename and format the backend does not produce | `unity/com.gantasmo.notechart/Runtime/NoteChartLoader.cs:35` | Default `notechart.unity.json` vs the written `.notechart.json`; the README names an export format `unity` and kind `unityscore` that do not exist. |
| SCORE-007 | S | `capabilities()` advertises three export formats `/export` rejects with 422 | `backend/modules/notation/engine.py:216` | `midi`, `json` and `alphatex` are listed; `json` has no producer at all. |
| SCORE-008 | S | `/pack` re-engraves the PDF on every download click | `backend/modules/notation/router.py:446` | No existence or mtime check before `convert_score`; a 68-page arrangement takes about 15 s each time. |
| SCORE-009 | S | Listing notation artifacts writes to the database on every GET | `backend/modules/notation/router.py:116` | `register_existing_midis` runs unconditionally on the SCORE tab's read path, rewriting mirrored rows and reverting later edits. |
| SCORE-010 | S | Backfill writes sheets under a different filename but the same artifact id | `backend/modules/notation/backfill.py:144` | Orphans the router-generated file, which the next reindex registers as a duplicate; the SCORE tab shows two identical sheets. |
| SCORE-011 | S | Backfill regenerates forever for any title with an XML-escaped character | `backend/modules/notation/backfill.py:72` | `_needs_fix` substring-matches plain text against escaped XML, so `&`, `<` and `>` titles never satisfy it. Runs as a background job. |
| SCORE-012 | S | Tab PDFs can never show an artist | `backend/modules/notation/pdf_render.py:188` | `--artist` is explicitly withheld for tabs, and the generated alphaTex carries no `\artist`, so the renderer's whole title-block branch is unreachable. |
| SCORE-013 | S | PDF export of a tab artifact fails despite a working tab renderer | `backend/modules/notation/engine.py:446` | `convert_score` stages non-MusicXML sources through music21, which cannot parse alphaTex; the bundle path uses `pdf_render` directly and succeeds. |
| SCORE-014 | M | Follow-along depends on OSMD private fields and has no test | `frontend/src/components/layout/scoreTimeMap.ts:396` | `cursorOptionsRendered` is not on the public Cursor surface; an OSMD bump silently reintroduces a per-frame canvas allocation and `toDataURL`. |
| INT-004 | S | Lyria reports "ready" before anything is listening | `backend/modules/storage/router.py:602` | Only `issues` folds into `ok`; the probe's `listening` flag is ignored, so Setup can report generation available with no server running. |
| INT-005 | S | Lyria is offered in the model dropdown on machines without the checkout | `frontend/src/lib/cloudModels.ts:30` | The sidecar project is not committed and not fetched by any setup step; selecting it swaps the whole MAKE surface for a spinner and an error. |
| INT-006 | L | The broadcast module has a relay and a viewer but no broadcaster | `backend/modules/broadcast/router.py:94` | Nothing in theDAW, the VJ app or Electron ever connects as broadcaster; a shared watch link waits forever. Routes are live and unauthenticated. |
| INT-007 | S | UnderfitView hardcodes port 8791 and ignores the env override | `frontend/src/views/UnderfitView.tsx:20` | The sidecar reports its real port and the view even displays it, but the ping and iframe use the constant, so an overridden port strands the tab on "Connecting". |
| VST-002 | S | The stateful VST3 instance API has zero callers | `backend/modules/vst/router.py:193` | `/load`, `/plugins`, `/process`, `/param`, `/unload`, `/builtin`, `/scan` are unreferenced; MIX uses only stateless `/process-file` plus the editor routes. |
| VST-003 | S | The scan cache misses plugins nested more than one level deep | `backend/modules/vst/scanner.py:454` | The signature samples only immediate children while the scan uses `rglob`, so a vendor suite install does not invalidate the cache. |
| FE-013 | S | HoverTip is not portalled, so tooltips land off their anchor under CSS zoom | `frontend/src/components/ui/Tooltip.tsx:45` | Viewport coordinates applied to a fixed element inside the zoomed subtree. ContextMenu already portals for exactly this reason. |
| FE-014 | S | SLIDE stack media persists a `blob:` URL to localStorage | `frontend/src/components/layout/SlidePanel.tsx:262` | Object URLs die with the document, so after a restart the Load button pushes a dead URL to the VJ; the `entryId` needed to re-mint it is stored right beside it. |
| FE-015 | M | The library filter, haystack build and sort rerun on every render | `frontend/src/state/libraryStore.ts:202` | `getFiltered()` is called bare in LibraryView's render body, with an undebounced search input, so unrelated re-renders rebuild a per-entry lowercase haystack over the whole library. |
| FE-016 | S | Warm-mounted tabs poll the backend forever after one visit | `frontend/src/views/VJView.tsx:345` | `/api/questcast/status` every 5 s and Underfit's probe every 3 s, with no visibility gate. VJView's own audio bridge already demonstrates the correct pattern. |
| FE-017 | M | STOP during generation only stops the client poll | `frontend/src/state/generateStore.ts:807` | No cancel route exists on the jobs API; the GPU keeps sampling and the take lands in the Library later, while the UI says "GENERATION STOPPED". |
| FE-018 | S | "Send to INIT" never navigates because `generate` is not a valid view id | `frontend/src/state/appUiStore.ts:84` | `setActiveView` returns early with no log for unknown ids; clips reach the Chimera stack and the user gets no feedback. |
| FE-019 | M | The library audio blob cache is unbounded and never evicted | `frontend/src/lib/backendLocalProvider.ts:177` | Every audition holds a full-length WAV in the renderer heap for the session; deleting an entry does not drop its blob. |
| FE-020 | S | questMidiClient hardcodes `ws://localhost:8600` for every non-https origin | `frontend/src/state/questMidiClient.ts:24` | Contradicts its own docblock; any LAN or Docker origin opens a socket to itself and reconnects every 2 s forever. `xrControlClient.ts:71` has the correct three-branch form. |
| FE-021 | S | `transparentBg` never reaches the canvas, so EDIT clip colours are covered | `frontend/src/components/audio/SemanticWave.tsx:104` | The child hardcodes a `#06070d` wrapper background and fills the canvas opaquely; per-clip track tint survives only in the 14 px header. |
| FE-022 | M | The MIX effects visualization is a fixed decorative curve | `frontend/src/views/EffectsVizPanel.tsx:40` | Constant SVG geometry that never reflects the effect or its params, on the default branch of the effect stage, presented as a scope. |
| FE-023 | S | Audimate can create edges but has no way to delete one | `frontend/src/views/AudimateView.tsx:264` | Edges are inside a `pointer-events-none` svg; the store's `removeEdge` has zero callers. |
| FE-024 | S | Form controls in DJ and MIX are missing ids, names and labels | `frontend/src/views/DJView.tsx:2161` | The DJ browser search and set-rename inputs have no accessible name at all; the MIX format select has a name and a span, not a label. Violates hard rule 3. |
| FE-025 | S | The ~110-profile controller table loads in the first-paint chunk | `frontend/src/App.tsx:39` | Static import for one detect helper; the table is only meaningful once a MIDI device is enumerated. |

---

# P3

| ID | E | Item | Reference |
|---|---|---|---|
| BE-009 | S | `backend/core/sidecar.py` is 127 lines nothing imports; no ToolSpec declares `mode="sidecar"` | `backend/core/sidecar.py:125` |
| BE-010 | S | `backend/core/model_registry.py` is an unreferenced second model cache | `backend/core/model_registry.py:10` |
| BE-011 | S | The spectrogram cache and its two GET endpoints have no callers | `backend/server.py:1270` |
| BE-012 | S | `core/jobs.py` subscribe/unsubscribe/list_jobs are dead; job table unbounded | `backend/core/jobs.py:41` |
| BE-013 | S | Stale comment claims importing `model_configs` costs ~4 s and pulls torch | `backend/server.py:124` |
| LIB-007 | S | `analysis/module.json` still says "Runs opt-in during idle" after the default flipped on | `backend/modules/analysis/module.json:7` |
| FX-008 | S | Dead statements in `creative_neural/dsp.py` and an unused `_stem_uuid` | `backend/modules/creative_neural/dsp.py:55` |
| SCORE-015 | S | `.notechart.json` cannot be recovered by reindex (suffix map has no entry) | `backend/modules/notation/engine.py:280` |
| SCORE-016 | S | Unused `PDF_RENDERABLE_SUFFIXES` and ScoreView's `musicXmlArtifacts` | `backend/modules/notation/pdf_render.py:47` |
| FE-026 | S | Three orphaned components; `WaveformPreview` is the only reason wavesurfer is a dependency | `frontend/src/components/audio/WaveformPreview.tsx:1` |
| FE-027 | S | `assistantBridgeStore.ts` is a dead parallel assistant pipeline with an unexposed approval mode | `frontend/src/state/assistantBridgeStore.ts:127` |
| FE-028 | S | `lastAudioBlob` pins a full WAV in the store and is read by nothing | `frontend/src/state/generateStore.ts:86` |
| FE-029 | S | Brand-key migration writes to two keys no store reads, dropping the data it copies | `frontend/src/lib/migrateBrandKeys.ts:16` |
| FE-030 | S | `SettingsModal` defines Row and Pill inside render, remounting the subtree each time | `frontend/src/components/layout/SettingsModal.tsx:1189` |
| FE-031 | M | EDIT timeline is unvirtualised and resolves each clip's track with `findIndex` | `frontend/src/components/audio/WaveformEditor.tsx:3273` |
| FE-032 | S | Dead exports: `storageQuotaStore` (empty file), `isCloudModel`, `fetchBytesWithRetry`, the vocalToMidi capture trio | `frontend/src/lib/cloudModels.ts:14` |
| FE-033 | M | `logDebug` is never called, so LOG VERBOSE only folds duplicates | `frontend/src/state/logStore.ts:49` |
| FE-034 | S | DJ browser's `soon` prop and its "coming soon" branch are unreachable | `frontend/src/views/DJView.tsx:2267` |
| FE-035 | S | Underfit orb: two styling controls with no UI, grounding links collected and never shown | `frontend/src/views/underfit/UnderfitAssistantOrb.tsx:553` |
| DOC-005 | S | Every `/api/vst` line-number citation is stale after the router rewrite | `docs/reference/api/03-studio-project-plugin-modules.md:104` |
| DOC-006 | S | DAWCenterPanel's comment cites wavesurfer as a heavy dep; nothing uses it | `frontend/src/components/layout/DAWCenterPanel.tsx:17` |

Remaining P2 docs: **DOC-002** S USER_GUIDE describes nine center tabs in a locked order while the code
ships eleven, and the Model table omits Lyria (`docs/USER_GUIDE.md:196`). **DOC-003** S Lyria shipped
with no user-facing doc and no RAG entry (`backend/rag.py:1`). **DOC-004** S The companion control
contract and the wiki pages are not registered in `DOC_PATHS`. Remaining P2 tests: **CI-004** M no tests
for the eight DSP modules, which is where FX-001 and FX-002 live (`tests/`). **CI-005** L no test covers
any of the thirteen top-level views (~12k lines).

---

# Verified healthy

Checked directly and found sound. Do not re-audit these without a reason.

- Analysis is not empty. The live database (`data/generations/library.db`) holds 403 entries and 352
  analysis rows, 343 with both BPM and a non-empty beat grid, all at the current `ANALYSIS_VERSION`.
  The "zero rows" reading came from the orphan file in LIB-005.
- The analysis engine's shared decode is real: one `librosa.load` threaded through tempo, RMS, key and
  pitch, collapsing four full-file decodes into one.
- Audio and stem streaming use `FileResponse`, so Range requests and scrubbing work with no in-memory copy.
- The stems pipeline is complete: abort signalling, duplicate-submit guard, per-phase progress the
  frontend polls, path-traversal normalisation of the sidecar's stem listing, and two test files.
- VST3 was exercised, not just read: 72 plugins scanned in 0.3 s with no duplicates, a plugin loaded on
  one thread and processed on another with no reload error, out-of-process metadata probing works, and
  warning propagation genuinely detects a plugin that silently ignored a restored state blob.
- Module auto-discovery is fault-tolerant. A module that raises at import is logged and skipped, and
  `module.json` is read with explicit utf-8 (the fix BE-004 still needs in `server.py`).
- Startup keeps torch off module scope and warms it on a daemon thread after the port binds.
- Teardown stops every registered sidecar behind per-target try/except, from both the lifespan shutdown
  and the admin exit paths.
- SettingsStore is versioned (v1 to v7), migrates forward cumulatively, writes atomically, and
  whitelists PATCH keys.
- Backup export and import run off the loop with a polled job table, a deadline on the manifest scan,
  and a correct zip-slip guard.
- Suno's proxy is hardened: the key never reaches the browser, atomic key writes, host allowlist on
  downloads, async MP3 fetch, and a lock preventing double-import.
- Mastering and convert are the honest families: every description matches its implementation, the
  two-pass EBU-R128 loudnorm is correct, and convert has a whitelisted catalog with real ffmpeg checks.
- No hardcoded machine-specific paths in any sidecar; every one anchors on `__file__` with an env override.
- Tailwind v4 compliance is clean across all thirteen views. `tsc --noEmit` passes across the frontend.
- Object-URL handling in `ClipWave` is now correct under StrictMode, and no other component repeats the
  old pattern. Event-listener balance across components is clean.
- All 53 `DOC_PATHS` entries resolve; RAG lazy init is thread-safe and degrades to empty context.
- `generateStore`'s re-entry discipline is correct: the claim is taken before the first await, and every
  pre-flight await is followed by a run-id check.
- `fetchRetry.ts` is good work: it documents the `res.blob()` failure with a reproduction and adds a
  structural MIDI completeness check that catches truncated 200 responses.

---

# Known unverified

These exist in the tree and have never been run, or never seen by a human. Treat as unproven.

- **SCORE follow-along.** `scoreTimeMap.ts` reads carefully and handles the rAF, StrictMode and
  stale-closure hazards, but it has never been executed and has no test of any kind. It also reaches
  into two OSMD private fields (SCORE-014).
- **The Unity note-chart package.** `unity/com.gantasmo.notechart` has never been imported into a Unity
  project or run on a headset. Its default filename does not match what the backend writes (SCORE-006),
  and the audio block it loads is empty (SCORE-005), so the first real run will fail.
- **The VST3 fixes against real plugins in the app.** The scanner and host changes were exercised from a
  script against one plugin (see Verified healthy) and were not driven through the MIX chain UI by a
  person. No test covers them (VST-001).
- **The packaged-build notation path.** PDF export and the Unity package have only been used on a dev
  clone. Per PKG-001 the staged layout does not contain them, so the installed-app behaviour is
  presumed broken and has not been observed.
- **Lyria live mode.** Everything to date has run under `LYRIA_MOCK`. Real-spend behaviour, the cost
  badge, and the adopted-listener case in INT-001 have not been observed.
- **The vendored stems sidecar on a fresh venv.** The in-repo `integration-package/backend` provisioning
  (torchcodec, FFmpeg DLLs, sitecustomize) has never been run from a clean environment.
- **The broadcast viewer.** The relay and viewer page have never had a broadcaster on the other end
  (INT-006), so nothing about the WebRTC path is proven.
- **The `.gan` install path.** Third-party bundle extraction has not been run against a bundle from
  outside this repo, and its traversal guard is wrong (SEC-003).
